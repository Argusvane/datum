import { describe, expect, it } from "vitest";

import { Budget, BudgetExhausted, RateLimitedOut, parseRetryAfter } from "../src/runners/endpoint/budget.js";
import { AllowlistViolation, HttpClient, TransportError, routesFor, type EndpointTarget } from "../src/runners/endpoint/http.js";

const onBase = (overrides: Partial<EndpointTarget> = {}): EndpointTarget => ({ baseUrl: "https://site.example/base", profile: "submissions", formId: "fx", formVersion: "1", allowWrites: false, ...overrides });
const submissions = (overrides: Partial<EndpointTarget> = {}): EndpointTarget => ({ baseUrl: "https://host.example", profile: "submissions", formId: "fx", formVersion: "1", allowWrites: false, ...overrides });

function client(target: EndpointTarget, fetchImpl: typeof fetch, budget = new Budget({ maxRequests: 50, delayMs: 0, sleep: async () => undefined })): HttpClient {
  return new HttpClient({ target, budget, timeoutMs: 1000, headers: {}, fetchImpl });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("the request allowlist", () => {
  const never: typeof fetch = async () => {
    throw new Error("the network must not be reached");
  };

  it("allows the validate route, and nothing else, in read-only mode", () => {
    const http = client(onBase(), never);
    expect(() => http.assertAllowed("POST", "https://site.example/base/api/submissions/validate")).not.toThrow();
    expect(() => http.assertAllowed("GET", "https://site.example/base/api/submissions/validate")).not.toThrow();
    for (const [method, url] of [
      ["POST", "https://site.example/base/api/submissions"],
      ["POST", "https://site.example/base/api/submissions/validate?x=1"],
      ["POST", "https://site.example/base/api/submissions/validate#frag"],
      ["POST", "https://evil.example/base/api/submissions/validate"],
      ["POST", "http://site.example/base/api/submissions/validate"],
      ["POST", "https://site.example/api/submissions/validate"],
      ["GET", "https://site.example/base/admin"],
      ["PUT", "https://site.example/base/api/submissions/validate"],
      ["DELETE", "https://site.example/base/api/submissions/validate"],
      ["PATCH", "https://site.example/base/api/submissions/validate"],
      ["POST", "https://user:pw@site.example/base/api/submissions/validate"],
      ["POST", "not a url"]
    ] as const) {
      expect(() => http.assertAllowed(method, url), `${method} ${url}`).toThrow(AllowlistViolation);
    }
  });

  it("opens the receive route only when writes are on", () => {
    const http = client(onBase({ allowWrites: true }), never);
    expect(() => http.assertAllowed("POST", "https://site.example/base/api/submissions")).not.toThrow();
    expect(() => http.assertAllowed("DELETE", "https://site.example/base/api/submissions")).toThrow(AllowlistViolation);
  });

  it("holds the submissions profile to its two routes and the form's own two reads", () => {
    const http = client(submissions(), never);
    const key = encodeURIComponent("fx@1");
    for (const [method, url] of [
      ["POST", "https://host.example/api/submissions/validate"],
      ["GET", `https://host.example/api/forms/${key}/definition`],
      ["GET", `https://host.example/api/forms/${key}/submissions`]
    ] as const) {
      expect(() => http.assertAllowed(method, url), url).not.toThrow();
    }
    for (const [method, url] of [
      ["POST", "https://host.example/api/submissions"],
      ["DELETE", `https://host.example/api/forms/${key}`],
      ["POST", "https://host.example/api/forms"],
      ["GET", `https://host.example/api/forms/${encodeURIComponent("other@1")}/submissions`],
      ["GET", "https://host.example/api/forms"],
      ["POST", `https://host.example/api/forms/${key}/settings`],
      ["GET", "https://host.example/api/submissions/abc"]
    ] as const) {
      expect(() => http.assertAllowed(method, url), `${method} ${url}`).toThrow(AllowlistViolation);
    }
  });

  it("allows exactly the operator's public definition URL, on the host they named", () => {
    const http = client(onBase({ publicDefinitionUrl: "https://site.example/base/def.json" }), never);
    expect(() => http.assertAllowed("GET", "https://site.example/base/def.json")).not.toThrow();
    expect(() => http.assertAllowed("GET", "https://site.example/base/def.json?x=1")).toThrow(AllowlistViolation);
    expect(() => http.assertAllowed("POST", "https://site.example/base/def.json")).toThrow(AllowlistViolation);
  });

  it("refuses an endpoint URL with credentials in it", () => {
    expect(() => client(onBase({ baseUrl: "https://user:pw@site.example" }), never)).toThrow(AllowlistViolation);
  });

  it("throws before anything is sent: a refused request never reaches the network and costs nothing", async () => {
    const budget = new Budget({ maxRequests: 5, delayMs: 0 });
    const http = client(onBase(), never, budget);
    await expect(http.send({ method: "POST", url: "https://site.example/base/api/submissions", body: "{}" })).rejects.toBeInstanceOf(AllowlistViolation);
    expect(budget.sent).toBe(0);
    expect(http.exchanges).toHaveLength(0);
  });
});

describe("the request budget and the 429 rule", () => {
  const url = "https://site.example/base/api/submissions/validate";

  it("stops at the request cap", async () => {
    const budget = new Budget({ maxRequests: 2, delayMs: 0 });
    const http = client(onBase(), async () => json(200, { accepted: true, errors: [] }), budget);
    await http.send({ method: "POST", url, body: "{}" });
    await http.send({ method: "POST", url, body: "{}" });
    await expect(http.send({ method: "POST", url, body: "{}" })).rejects.toBeInstanceOf(BudgetExhausted);
    expect(budget.sent).toBe(2);
  });

  it("pauses between requests, not before the first", async () => {
    const sleeps: number[] = [];
    const budget = new Budget({ maxRequests: 10, delayMs: 250, sleep: async (ms) => void sleeps.push(ms) });
    const http = client(onBase(), async () => json(200, { accepted: true, errors: [] }), budget);
    for (let at = 0; at < 3; at += 1) {
      await http.send({ method: "POST", url, body: "{}" });
    }
    expect(sleeps).toEqual([250, 250]);
  });

  it("waits out a short Retry-After once and retries the same request", async () => {
    const sleeps: number[] = [];
    const budget = new Budget({ maxRequests: 10, delayMs: 0, sleep: async (ms) => void sleeps.push(ms) });
    let calls = 0;
    const http = client(
      onBase(),
      async () => {
        calls += 1;
        return calls === 1 ? json(429, { errors: [{ field: null, code: "flood" }] }, { "retry-after": "7" }) : json(200, { accepted: true, errors: [] });
      },
      budget
    );
    const response = await http.send({ method: "POST", url, body: "{}" });
    expect(response.status).toBe(200);
    expect(sleeps).toEqual([7000]);
    expect(budget.answers429).toBe(1);
    expect(budget.sent).toBe(2);
    // both answers are in the log, the 429 included (REC-14 reads it)
    expect(http.exchanges.map((exchange) => exchange.status)).toEqual([429, 200]);
  });

  it("stops, and never retries, for a Retry-After over a minute, none at all, or a second 429", async () => {
    for (const retryAfter of ["61", undefined]) {
      let calls = 0;
      const budget = new Budget({ maxRequests: 10, delayMs: 0, sleep: async () => undefined });
      const http = client(
        onBase(),
        async () => {
          calls += 1;
          return json(429, { errors: [{ field: null, code: "flood" }] }, retryAfter !== undefined ? { "retry-after": retryAfter } : {});
        },
        budget
      );
      await expect(http.send({ method: "POST", url, body: "{}" })).rejects.toBeInstanceOf(RateLimitedOut);
      expect(calls).toBe(1);
      expect(budget.rateLimited).toBe(true);
    }
    let calls = 0;
    const budget = new Budget({ maxRequests: 10, delayMs: 0, sleep: async () => undefined });
    const http = client(
      onBase(),
      async () => {
        calls += 1;
        return json(429, { errors: [{ field: null, code: "flood" }] }, { "retry-after": "1" });
      },
      budget
    );
    await expect(http.send({ method: "POST", url, body: "{}" })).rejects.toBeInstanceOf(RateLimitedOut);
    expect(calls).toBe(2);
  });

  it("reads Retry-After as seconds or as an HTTP date", () => {
    expect(parseRetryAfter("12")).toBe(12);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:30 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(30);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe("the transport", () => {
  const url = "https://site.example/base/api/submissions/validate";

  it("never follows a redirect: the answer is the 3xx", async () => {
    const seen: string[] = [];
    const http = client(onBase(), async (input, init) => {
      seen.push(`${String(input)} ${init?.redirect}`);
      return new Response("", { status: 302, headers: { location: "https://evil.example/" } });
    });
    const response = await http.send({ method: "POST", url, body: "{}" });
    expect(response.status).toBe(302);
    expect(seen).toEqual([`${url} manual`]);
  });

  it("reports a refused connection and a timeout as transport errors, the timeout flagged", async () => {
    await expect(client(onBase(), async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }).send({ method: "POST", url, body: "{}" })).rejects.toMatchObject({ name: "TransportError", timedOut: false, message: expect.stringContaining("ECONNREFUSED") });
    const slow = client(onBase(), async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
    await expect(slow.send({ method: "POST", url, body: "{}" })).rejects.toBeInstanceOf(TransportError);
    await expect(slow.send({ method: "POST", url, body: "{}" })).rejects.toMatchObject({ timedOut: true });
  });

  it("sends the operator's headers on every request, and reports none of their values", async () => {
    const seen: Record<string, string>[] = [];
    const http = new HttpClient({
      target: onBase(),
      budget: new Budget({ maxRequests: 5, delayMs: 0 }),
      timeoutMs: 1000,
      headers: { authorization: "Bearer SECRET-TOKEN" },
      fetchImpl: async (_input, init) => {
        seen.push(init?.headers as Record<string, string>);
        return json(200, { accepted: true, errors: [] });
      }
    });
    await http.send({ method: "POST", url, body: "{}", headers: { "content-type": "application/json" } });
    expect(seen[0]).toMatchObject({ authorization: "Bearer SECRET-TOKEN", "content-type": "application/json" });
    expect(JSON.stringify(http.exchanges)).not.toContain("SECRET-TOKEN");
  });
});
