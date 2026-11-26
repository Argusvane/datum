import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UsageError, parseArgs } from "../src/args.js";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/exit-codes.js";
import type { Report } from "../src/report/model.js";
import { endpointConfigFrom } from "../src/runners/endpoint/config.js";
import { startReferenceServer, type ReferenceServer } from "./helpers/reference-submissions-server.js";

function capture() {
  let out = "";
  let err = "";
  return { io: { stdout: (text: string) => void (out += text), stderr: (text: string) => void (err += text) }, out: () => out, err: () => err };
}

describe("endpoint flags", () => {
  it("parses the run's knobs and keeps secrets out of the report's argv", () => {
    const options = parseArgs(["--endpoint", "https://x.example", "--form", "f", "--auth-header", "Authorization: Bearer t", "--header", "X-A: b", "--cookie", "SESS=1", "--allow-writes", "--i-installed-the-suite-fixture", "--body-limit", "2000", "--max-requests", "50", "--delay-ms", "0", "--timeout-ms", "900", "--public-definition-url", "https://x.example/d"]);
    expect(options).toMatchObject({ endpoint: "https://x.example", form: "f", headers: ["Authorization: Bearer t", "X-A: b"], cookie: "SESS=1", allowWrites: true, fixtureAcknowledged: true, bodyLimit: 2000, maxRequests: 50, delayMs: 0, timeoutMs: 900 });
    expect(endpointConfigFrom(options, {}).headers).toEqual({ authorization: "Bearer t", "x-a": "b", cookie: "SESS=1" });
    expect(endpointConfigFrom(options, { DATUM_SC_AUTH: "Authorization: Bearer from-env" }).headers["authorization"]).toBe("Bearer from-env");
  });

  it("refuses what cannot work", () => {
    for (const argv of [["--auth-header", "no colon here"], ["--max-requests", "0"], ["--delay-ms", "-1"], ["--timeout-ms", "x"], ["--body-limit", "1.5"]]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(UsageError);
    }
    expect(() => endpointConfigFrom(parseArgs(["--allow-writes"]), {})).toThrow(/needs --endpoint/);
    expect(() => endpointConfigFrom(parseArgs(["--endpoint", "https://x.example"]), {})).toThrow(/--form/);
    expect(() => endpointConfigFrom(parseArgs(["--endpoint", "https://x.example", "--form", "f", "--public-definition-url", "https://evil.example/d"]), {})).toThrow(/same host/);
  });
});

describe("the command line against live test servers", () => {
  let reference: ReferenceServer;
  const headersSeen: Record<string, string | string[] | undefined>[] = [];
  beforeAll(async () => {
    reference = await startReferenceServer({ fault: (request) => { headersSeen.push(request.headers); return undefined; } });
  });
  afterAll(async () => {
    await reference.close();
  });

  it("runs an endpoint on its own: exit 0, a JSON report with the endpoint section, no program needed", async () => {
    const run = capture();
    const code = await runCli(["--endpoint", reference.url, "--form", "datum-security-suite", "--delay-ms", "0", "--format", "json", "--out", "-", "--skip", "ISO,ABI,PAR"], run.io);
    expect(run.err()).toBe("");
    expect(code).toBe(EXIT.pass);
    const report = JSON.parse(run.out()) as Report;
    expect(report.run.modes).toEqual(["endpoint"]);
    expect(report.program).toBeUndefined();
    expect(report.endpoint).toMatchObject({ profile: "submissions", formId: "datum-security-suite", preflight: { ok: true }, writes: false });
    expect(report.results.every((result) => result.runner === "endpoint")).toBe(true);
    expect(report.verdict).toBe("PASS");
  });

  it("sends the operator's credentials to the server and nowhere into the report", async () => {
    const run = capture();
    const code = await runCli(["--endpoint", reference.url, "--form", "datum-security-suite", "--delay-ms", "0", "--format", "json", "--out", "-", "--only", "CTL", "--auth-header", "Authorization: Bearer TOKEN-ABC-123", "--cookie", "SESS=COOKIE-XYZ"], run.io);
    expect(code).toBe(EXIT.pass);
    expect(headersSeen.some((headers) => headers["authorization"] === "Bearer TOKEN-ABC-123" && headers["cookie"] === "SESS=COOKIE-XYZ")).toBe(true);
    expect(run.out()).not.toContain("TOKEN-ABC-123");
    expect(run.out()).not.toContain("COOKIE-XYZ");
    const report = JSON.parse(run.out()) as Report;
    expect(report.endpoint?.authHeaderName).toBe("authorization");
  });

  it("exits 3 (INCONCLUSIVE) when writes are asked for and the fixture cannot be verified, and 0 once the operator vouches for it", async () => {
    // A server whose public definition cannot be read: the fixture marker cannot be verified.
    const unverified = await startReferenceServer({ fault: (request) => (request.method === "GET" && request.path.endsWith("/definition") ? { status: 404, contentType: "application/json", body: "{}" } : undefined) });
    const before = unverified.seen.length;
    const refused = capture();
    expect(await runCli(["--endpoint", unverified.url, "--form", "datum-security-suite", "--allow-writes", "--only", "REC-08", "--delay-ms", "0", "--out", "-", "--format", "json"], refused.io)).toBe(EXIT.inconclusive);
    expect(unverified.seen.slice(before).filter((request) => request.method === "POST" && request.path === "/api/submissions")).toEqual([]);
    const vouched = capture();
    expect(await runCli(["--endpoint", unverified.url, "--form", "datum-security-suite", "--allow-writes", "--i-installed-the-suite-fixture", "--only", "REC-08", "--delay-ms", "0", "--out", "-", "--format", "json"], vouched.io)).toBe(EXIT.pass);
    expect(unverified.seen.some((request) => request.method === "POST" && request.path === "/api/submissions")).toBe(true);
    await unverified.close();
  });

  it("exits 3 when the preflight finds the fixture misconfigured, naming the setting", async () => {
    const closed = await startReferenceServer({ fault: (request) => (request.path === "/api/submissions/validate" ? { status: 403, contentType: "application/json", body: JSON.stringify({ errors: [{ field: null, code: "form.closed", message: "This form is closed." }] }) } : undefined) });
    try {
      const run = capture();
      expect(await runCli(["--endpoint", closed.url, "--form", "datum-security-suite", "--delay-ms", "0"], run.io)).toBe(EXIT.inconclusive);
      expect(run.out()).toMatch(/fixture form refuses submissions/);
    } finally {
      await closed.close();
    }
  });

  it("exits 1 when an enforced endpoint vector fails", async () => {
    const broken = await startReferenceServer({ fault: (request) => (!request.jsonOk ? { status: 500, body: "<pre>boom</pre>" } : undefined) });
    try {
      const run = capture();
      expect(await runCli(["--endpoint", broken.url, "--form", "datum-security-suite", "--delay-ms", "0", "--only", "REC-01"], run.io)).toBe(EXIT.fail);
    } finally {
      await broken.close();
    }
  });

  it("lists which vectors run against an endpoint, and explains their rows", async () => {
    const list = capture();
    expect(await runCli(["list", "--json"], list.io)).toBe(EXIT.pass);
    const vectors = (JSON.parse(list.out()) as { vectors: { id: string; applies: { endpoint: boolean } }[] }).vectors;
    for (const id of ["CTL-01", "REC-01", "REC-14", "SEC-05"]) {
      expect(vectors.find((vector) => vector.id === id)?.applies.endpoint, id).toBe(true);
    }
    expect(vectors.find((vector) => vector.id === "ABI-01")?.applies.endpoint).toBe(false);
    const explain = capture();
    expect(await runCli(["explain", "REC-06"], explain.io)).toBe(EXIT.pass);
    expect(explain.out()).toMatch(/runs on: endpoint/);
    expect(explain.out()).toMatch(/endpoint row other-version: refusal outdated/);
    expect(explain.out()).toMatch(/on submissions: refusal outdated or refusal not_found/);
  });
});
