import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CaseFailure } from "../../src/host-check/expect.js";
import { CookieJar, HostHttp, splitUrl, TransportError, TYPED_503_CODES } from "../../src/host-check/http.js";
import { targetFrom, type HostTarget } from "../../src/host-check/target.js";
import { REPO_ROOT } from "../helpers/paths.js";

type Handler = (request: IncomingMessage, body: Buffer, response: ServerResponse) => void;
const closers: (() => Promise<void>)[] = [];

async function serve(handler: Handler): Promise<{ url: string; seen: { method: string; target: string; headers: IncomingMessage["headers"] }[] }> {
  const seen: { method: string; target: string; headers: IncomingMessage["headers"] }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method ?? "", target: request.url ?? "", headers: request.headers });
      handler(request, Buffer.concat(chunks), response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function target(url: string, extra: Record<string, string> = {}): HostTarget {
  return targetFrom(new Map(Object.entries({ "datum.tck.base-url": url, "datum.tck.capabilities": "assets", ...extra })));
}

const reply = (status: number, type: string, body: string, headers: Record<string, string> = {}): Handler => (_request, _body, response) => {
  response.writeHead(status, { "Content-Type": type, ...headers });
  response.end(body);
};

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

describe("HostHttp (the Java kit's HostHttp and Reply)", () => {
  it("sends a path exactly as written: dot segments and %2e%2e are not normalised", async () => {
    const host = await serve(reply(404, "application/json", '{"errors":[{"code":"not_found"}]}'));
    const http = new HostHttp(target(host.url));
    try {
      for (const path of ["/datum/assets/b/sub/../datum-builder.js", "/datum/assets/b/%2e%2e/manifest.json", "/datum/assets/b/../manifest.json", "/api/forms/a@1/definition", "/api/forms/a%401/definition"]) {
        await http.get(path);
      }
    } finally {
      http.close();
    }
    expect(host.seen.map((entry) => entry.target)).toEqual(["/datum/assets/b/sub/../datum-builder.js", "/datum/assets/b/%2e%2e/manifest.json", "/datum/assets/b/../manifest.json", "/api/forms/a@1/definition", "/api/forms/a%401/definition"]);
  });

  it("never follows a redirect and reads the reply as the Java Reply does", async () => {
    const host = await serve(reply(302, "text/plain; charset=UTF-8", "moved", { Location: "/elsewhere", "Set-Cookie": "a=1" }));
    const http = new HostHttp(target(host.url));
    try {
      const answer = await http.get("/datum/assets/x");
      expect(answer.status).toBe(302);
      expect(answer.header("location")).toBe("/elsewhere");
      expect(answer.mediaType()).toBe("text/plain");
      expect(answer.text()).toBe("moved");
      expect(() => answer.json()).toThrow(/Not JSON \(302\)/);
      expect(host.seen).toHaveLength(1);
    } finally {
      http.close();
    }
  });

  it("applies the never-5xx rule to every reply: a 500 fails, a typed 503 does not, an untyped 503 does", async () => {
    let next: Handler = reply(500, "application/json", '{"errors":[{"code":"internal"}]}');
    const host = await serve((request, body, response) => next(request, body, response));
    const http = new HostHttp(target(host.url));
    try {
      await expect(http.get("/datum/assets/x")).rejects.toThrow(/never-5xx rule: GET \/datum\/assets\/x -> 500: a server error that is not a typed 503/);
      next = reply(503, "application/json", '{"errors":[{"code":"server.unavailable"}]}', { "Retry-After": "5" });
      expect((await http.postJson("/api/submissions", "{}")).code()).toBe("server.unavailable");
      next = reply(503, "text/html", "<html>Service Unavailable</html>");
      await expect(http.get("/datum/assets/x")).rejects.toThrow(CaseFailure);
      next = reply(502, "text/html", "<html>Bad Gateway</html>");
      await expect(http.get("/datum/assets/x")).rejects.toThrow(/not a typed 503/);
      // A code is not enough: it must be one a host answers 503 with, not an exception's name.
      next = reply(503, "application/json", '{"errors":[{"code":"java.lang.IllegalStateException"}]}');
      await expect(http.postJson("/api/submissions", "{}")).rejects.toThrow(/POST \/api\/submissions -> 503: a server error that is not a typed 503/);
      next = reply(503, "application/json", '{"errors":[{"code":""}]}');
      await expect(http.postJson("/api/submissions", "{}")).rejects.toThrow(/not a typed 503/);
      for (const code of TYPED_503_CODES) {
        next = reply(503, "application/json", JSON.stringify({ errors: [{ code }] }));
        expect((await http.postJson("/api/submissions", "{}")).code()).toBe(code);
      }
    } finally {
      http.close();
    }
  });

  const CATALOG = join(REPO_ROOT, "integrations/shared/endpoint-catalog.json");
  it.skipIf(!existsSync(CATALOG))("types every 503 code the shared endpoint catalog lists", () => {
    const catalog = JSON.parse(readFileSync(CATALOG, "utf8")) as { endpoints: { statuses: { status: number; codes: string[] }[] }[]; responses: { status: number; codes: string[] }[] };
    const listed = new Set<string>();
    for (const entry of [...catalog.endpoints.flatMap((endpoint) => endpoint.statuses), ...catalog.responses]) {
      if (entry.status === 503) for (const code of entry.codes) listed.add(code);
    }
    expect(listed.size).toBeGreaterThan(0);
    expect([...listed].filter((code) => !TYPED_503_CODES.has(code))).toEqual([]);
  });

  const JVM_LIBS = join(REPO_ROOT, "integrations/jvm/libs");
  it.skipIf(!existsSync(JVM_LIBS))("types every code the JVM libraries answer 503 with, and no other", () => {
    // The Spring host's 503s: `"<code>", 503` literals, `CODE = "<code>"` beside `super(CODE, 503`, and the kernel verdicts VerdictMapper sends to 503.
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (name === "test" || name === "target" || name === "assets") continue;
        if (statSync(file).isDirectory()) walk(file);
        else if (name.endsWith(".java")) {
          const source = readFileSync(file, "utf8");
          for (const match of source.matchAll(/"([a-z_]+(?:\.[a-z_]+)*)",\s*503\b/g)) found.add(match[1] as string);
          const constant = /\bCODE\s*=\s*"([^"]+)"/.exec(source);
          if (constant !== null && /super\(CODE,\s*503\b/.test(source)) found.add(constant[1] as string);
          for (const verdicts of source.matchAll(/case\s+((?:"[^"]+",?\s*)+)->\s*503\b/g)) {
            for (const code of (verdicts[1] as string).matchAll(/"([^"]+)"/g)) found.add(code[1] as string);
          }
        }
      }
    };
    walk(JVM_LIBS);
    expect([...found].sort()).toEqual([...TYPED_503_CODES].sort());
  });

  it("wants JSON on a JSON route, but not an empty 304 nor a router's own 404/405/413; a case may waive it", async () => {
    let next: Handler = reply(200, "text/html", "<html>ok</html>");
    const host = await serve((request, body, response) => next(request, body, response));
    const http = new HostHttp(target(host.url, { "datum.tck.api-path": "/v1" }));
    try {
      await expect(http.get("/v1/forms/x/definition")).rejects.toThrow(/the body is not JSON/);
      // Off the API path the same answer is a case's business.
      expect((await http.get("/datum/assets/host.json")).status).toBe(200);
      // A PDF on an API route: the case says so.
      next = reply(200, "application/pdf", "%PDF-1.7");
      expect((await http.send("POST", "/v1/pdf/x", { contentType: "application/json", body: "{}", jsonRoute: false })).status).toBe(200);
      next = (_request, _body, response) => {
        response.writeHead(304, { ETag: '"x"' });
        response.end();
      };
      expect((await http.get("/v1/forms/x/definition")).status).toBe(304);
      for (const status of [404, 405, 413]) {
        next = reply(status, "text/html", "<html>no</html>");
        expect((await http.get("/v1/anything")).status).toBe(status);
      }
      // The application's own security refuses in its framework's format.
      next = reply(403, "text/plain", "Forbidden");
      expect((await http.send("PUT", "/v1/builder/forms/x", { contentType: "application/json", body: "{}", who: "other-person" })).status).toBe(403);
      next = reply(401, "text/plain", "");
      expect((await http.get("/v1/forms/x/definition")).status).toBe(401);
      next = (_request, _body, response) => {
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' });
        response.end();
      };
      expect((await http.get("/v1/forms/x/definition")).status).toBe(401);
      next = reply(400, "text/html", "<html>Bad Request</html>");
      await expect(http.get("/v1/anything")).rejects.toThrow(/the body is not JSON/);
      // The WebAuthn path is a JSON route too, wherever it is.
      const webauthn = new HostHttp(target(host.url, { "datum.tck.webauthn-path": "/passkeys" }));
      try {
        await expect(webauthn.get("/passkeys/register")).rejects.toThrow(/the body is not JSON/);
      } finally {
        webauthn.close();
      }
    } finally {
      http.close();
    }
  });

  it("fails a request that gets no answer within --timeout, and one that cannot connect", async () => {
    const host = await serve(() => undefined);
    const http = new HostHttp(target(host.url, { "datum.tck.timeout": "300" }));
    try {
      const error = await http.get("/datum/assets/x").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).timedOut).toBe(true);
      expect((error as Error).message).toMatch(/no answer within 300 ms/);
    } finally {
      http.close();
    }
    const nowhere = new HostHttp(target("http://127.0.0.1:9"));
    try {
      await expect(nowhere.get("/")).rejects.toThrow(/ECONNREFUSED/);
    } finally {
      nowhere.close();
    }
  });

  it("sends the target's headers to everyone and each person's headers only for that person (the RequestDecorator)", async () => {
    const host = await serve(reply(200, "application/json", "{}"));
    const http = new HostHttp(
      target(host.url, {
        "datum.tck.header.X-Tenant": "a",
        "datum.tck.person.header.Authorization": "Basic cA==",
        "datum.tck.other-person.header.Authorization": "Basic bw==",
        "datum.tck.other-person.header.Cookie": "SESSION=o"
      })
    );
    try {
      await http.get("/api/x");
      await http.get("/api/x", "person", { "If-None-Match": '"e"' });
      await http.get("/api/x", "other-person", { Cookie: "extra=1" });
    } finally {
      http.close();
    }
    const [visitor, person, other] = host.seen;
    expect(visitor?.headers["x-tenant"]).toBe("a");
    expect(visitor?.headers["authorization"]).toBeUndefined();
    expect(visitor?.headers["cookie"]).toBeUndefined();
    expect(person?.headers["authorization"]).toBe("Basic cA==");
    expect(person?.headers["if-none-match"]).toBe('"e"');
    expect(other?.headers["authorization"]).toBe("Basic bw==");
    expect(other?.headers["cookie"]).toBe("extra=1; SESSION=o");
  });

  it("with --csrf: fetches the token with GET / once per person, keeps a jar per person, echoes the header on writes only and sends only the token cookie", async () => {
    let issued = 0;
    const host = await serve((request, _body, response) => {
      if (request.url === "/") {
        issued += 1;
        response.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": [`XSRF-TOKEN=t${issued}; Path=/`, "JSESSIONID=s; HttpOnly"] });
        response.end("<html></html>");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
    const http = new HostHttp(target(host.url, { "datum.tck.csrf": "cookie:XSRF-TOKEN:X-XSRF-TOKEN", "datum.tck.person.header.Authorization": "Basic cA==" }));
    try {
      await http.get("/api/forms/x/definition");
      await http.postJson("/api/submissions", "{}");
      await http.postJson("/api/submissions", "{}");
      await http.send("PUT", "/api/builder/forms/x", { contentType: "application/json", body: "{}", who: "person" });
      await http.get("/api/forms/x/definition", "person");
      expect(http.jar("visitor").get("XSRF-TOKEN")).toBe("t1");
      expect(http.jar("person").get("XSRF-TOKEN")).toBe("t2");
    } finally {
      http.close();
    }
    expect(host.seen.map((entry) => `${entry.method} ${entry.target}`)).toEqual([
      "GET /api/forms/x/definition",
      "GET /",
      "POST /api/submissions",
      "POST /api/submissions",
      "GET /",
      "PUT /api/builder/forms/x",
      "GET /api/forms/x/definition"
    ]);
    const [read, , write1, write2, personBootstrap, personWrite, personRead] = host.seen;
    expect(read?.headers["x-xsrf-token"]).toBeUndefined();
    expect(read?.headers["cookie"]).toBeUndefined();
    expect(write1?.headers["x-xsrf-token"]).toBe("t1");
    // The JSESSIONID the page set stays in the jar but never goes out: the Java decorators send exactly "XSRF-TOKEN=<token>".
    expect(write1?.headers["cookie"]).toBe("XSRF-TOKEN=t1");
    expect(http.jar("visitor").get("JSESSIONID")).toBe("s");
    expect(write2?.headers["x-xsrf-token"]).toBe("t1");
    expect(personBootstrap?.headers["authorization"]).toBe("Basic cA==");
    expect(personWrite?.headers["x-xsrf-token"]).toBe("t2");
    expect(personRead?.headers["x-xsrf-token"]).toBeUndefined();
    expect(personRead?.headers["cookie"]).toBe("XSRF-TOKEN=t2");
  });

  it("with --csrf and no token cookie on GET /, a write fails naming the cookie", async () => {
    const host = await serve(reply(200, "text/html", "<html></html>"));
    const http = new HostHttp(target(host.url, { "datum.tck.csrf": "cookie:XSRF-TOKEN:X-XSRF-TOKEN" }));
    try {
      await expect(http.postJson("/api/submissions", "{}")).rejects.toThrow(/no XSRF-TOKEN cookie on GET/);
    } finally {
      http.close();
    }
  });

  it("reads the answer of a server that refuses a large body before reading it (413)", async () => {
    const host = await serve(reply(413, "application/json", '{"errors":[{"code":"bad_document"}]}'));
    const http = new HostHttp(target(host.url));
    try {
      const answer = await http.postJson("/api/submissions", `{"document":{"pad":"${"x".repeat(1024 * 1024 + 16)}"}}`);
      expect(answer.status).toBe(413);
      expect(answer.code()).toBe("bad_document");
    } finally {
      http.close();
    }
  });

  it("keeps cookies like a browser jar and splits URLs without normalising them", () => {
    const jar = new CookieJar();
    jar.take("A=1; Path=/; HttpOnly");
    jar.take("B=2");
    jar.take("A=; Max-Age=0");
    jar.take("C=3; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(jar.header()).toBe("B=2");
    expect(splitUrl("http://[::1]:8080/a/../b?q=%2e")).toEqual({ protocol: "http:", authority: "[::1]:8080", hostname: "::1", port: 8080, requestTarget: "/a/../b?q=%2e" });
    expect(splitUrl("https://forms.example").requestTarget).toBe("/");
  });
});
