import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runHostCheckCli } from "../../src/host-check/cli.js";
import { decide, selectCases, SelectionError, type CapabilitySummary } from "../../src/host-check/runner.js";
import type { HostCheckReport } from "../../src/host-check/report.js";
import { dryRunReport, GOLDEN_CTL01_VALUES, startMockHost, type MockHost, type MockHostOptions } from "./helpers/mock-host.js";

const hosts: MockHost[] = [];
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.close();
});

async function host(options: MockHostOptions = {}): Promise<MockHost> {
  const started = await startMockHost(options);
  hosts.push(started);
  return started;
}

async function check(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runHostCheckCli(argv, { stdout: (text) => void (out += text), stderr: (text) => void (err += text) });
  return { code, out, err };
}

const ALL_N1 = "submissions,submissions-test,forms,assets,flood";

describe("datum-host-check against a good host", () => {
  it("passes the 21 cases of the five capabilities, exit 0, and writes report.json and report.md", async () => {
    const good = await host();
    const out = mkdtempSync(join(tmpdir(), "datum-host-check-report-"));
    try {
      const result = await check(["--endpoint", good.url, "--capabilities", `flood,${ALL_N1}`, "--header", "Authorization=Bearer secret-value", "--out", out]);
      expect(result.code, result.out + result.err).toBe(0);
      expect(result.out).toContain("== PASS: 21 passed, 0 failed, 0 skipped");
      const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as HostCheckReport;
      expect(report.verdict).toBe("PASS");
      expect(report.summary).toMatchObject({ pass: 21, fail: 0, skip: 0 });
      // Flood last, whatever order --capabilities named it in; each group by @Order.
      expect(report.results.map((result) => result.id)).toEqual(["SUB-01", "SUB-02", "SUB-03", "SUB-04", "SUB-05", "SUB-06", "SUB-07", "DRY-01", "DRY-02", "DRY-03", "FRM-01", "FRM-02", "FRM-03", "FRM-04", "AST-01", "AST-02", "AST-03", "AST-04", "AST-05", "FLD-01", "FLD-02"]);
      expect(report.capabilities.map((summary) => summary.capability)).toEqual(["submissions", "submissions-test", "forms", "assets", "flood"]);
      expect(report.host.preflight.ok).toBe(true);
      expect(report.results[0]?.exchanges[0]).toMatchObject({ method: "POST", path: "/api/submissions", status: 200 });
      expect(JSON.stringify(report)).not.toContain("secret-value");
      expect(report.host.headerNames.all).toEqual(["Authorization"]);
      const markdown = readFileSync(join(out, "report.md"), "utf8");
      expect(markdown).toContain("# Datum host check: PASS");
      expect(markdown).toContain("| FLD-01 |");
      // The flood case stopped at the first 429.
      const flood = report.results.find((result) => result.id === "FLD-01")?.exchanges ?? [];
      expect(flood.at(-1)?.status).toBe(429);
      expect(flood.filter((exchange) => exchange.status === 429)).toHaveLength(1);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    // The dot-segment spellings left the kit as written.
    const targets = good.seen.map((entry) => entry.target);
    expect(targets).toContain("/datum/assets/b1d2c3/sub/../datum-builder.js");
    expect(targets).toContain("/datum/assets/b1d2c3/%2e%2e/manifest.json");
    expect(targets).toContain("/api/forms/datum-security-suite@1/definition");
  });

  it("skips FRM-04 when the builder is on, and fails it when a host with the builder off serves the author's copy", async () => {
    const builderHost = await host({ builderEnabled: true });
    const skipped = await check(["--endpoint", builderHost.url, "--capabilities", "forms", "--builder-enabled", "--only", "FRM-04"]);
    expect(skipped.out).toContain("SKIP FRM-04");
    const leaking = await host({
      fault: (request, response) => {
        if (request.method === "GET" && request.target.startsWith("/api/forms/datum-security-suite/definition?public=false")) {
          response.writeHead(200, { "Content-Type": "application/json", ETag: '"abc"' });
          response.end('{"id":"datum-security-suite"}');
          return true;
        }
        return false;
      }
    });
    const failed = await check(["--endpoint", leaking.url, "--capabilities", "forms", "--only", "FRM-04"]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("FAIL FRM-04");
  });

  it("fails FLD-02 on a host without the address limit: every unparseable body is 400 bad_document", async () => {
    const open = await host({ addressLimit: 0 });
    const result = await check(["--endpoint", open.url, "--capabilities", "flood", "--only", "FLD-02"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("FAIL FLD-02");
    expect(result.out).toMatch(/expected HTTP 429/);
    const bodies = open.seen.filter((entry) => entry.method === "POST" && entry.target === "/api/submissions" && entry.body.toString() === "{");
    expect(bodies).toHaveLength(400);
  });

  it("leaves the recommended address limit (200) a margin over every body POST before FLD-02, across every capability the mock serves", async () => {
    // The CI boot runs these capabilities against one host (flood last); hardening needs a host that stops the
    // hostile rule module's attacks, which the fault below stands in for: a run that gave no answer (503) for the
    // attacks that crash, a 422 for the two the kernel judges.
    const stopsAttacks: NonNullable<MockHostOptions["fault"]> = (request, response) => {
      if (request.method !== "POST" || (request.target !== "/api/submissions" && request.target !== "/api/submissions/validate")) return false;
      let name: unknown;
      try {
        name = (JSON.parse(request.body.toString("utf8")) as { document?: { submission?: { values?: { name?: unknown } } } }).document?.submission?.values?.name;
      } catch {
        return false;
      }
      if (typeof name !== "string" || !name.startsWith("datum-tck-")) return false;
      const judged = name === "datum-tck-memory" || name === "datum-tck-huge";
      response.writeHead(judged ? 422 : 503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ errors: [{ code: judged ? "validator.failed" : "wasm.execution_error" }] }));
      return true;
    };
    const good = await host({ hostContext: true, fault: stopsAttacks });
    const result = await check(["--endpoint", good.url, "--capabilities", `${ALL_N1},hardening,host-context`]);
    expect(result.code, result.out + result.err).toBe(0);
    const posts = good.seen.filter((entry) => entry.method === "POST" && entry.target.startsWith("/api/submissions"));
    // The flood case's bodies (FLD-02) are the lone "{" posts; everything else is what the address counted before it.
    const flood = posts.filter((entry) => entry.body.toString() === "{").length;
    expect(flood).toBeGreaterThan(0);
    const before = posts.length - flood;
    // The margin is 100: a run of every capability posts well under 200 - 100 bodies, so a new case or capability
    // has to add that many before the recommended limit stops letting a good host through.
    expect(before).toBeLessThan(200 - 100);
    // FLD-02 stops at the first 429, the 201st counted request, so it never posts more than 201 bodies.
    expect(flood).toBeLessThanOrEqual(201);
  });

  it("runs --only cases and asks for --builder-enabled when the host serves the builder", async () => {
    const builderHost = await host({ builderEnabled: true });
    const off = await check(["--endpoint", builderHost.url, "--capabilities", "assets", "--only", "AST-04"]);
    expect(off.code).toBe(1);
    expect(off.out).toMatch(/FAIL AST-04[\s\S]*expected HTTP 404, got GET \/datum\/assets\/b1d2c3\/datum-builder.js -> 200/);
    const on = await check(["--endpoint", builderHost.url, "--capabilities", "assets", "--builder-enabled", "--only", "ast-04"]);
    expect(on.code, on.out).toBe(0);
  });
});

/** The values of a dry-run request's document, or undefined when the body is not a delivery (a probe). */
function dryRunValues(request: { method: string; target: string; body: Buffer }): Record<string, unknown> | undefined {
  if (request.method !== "POST" || request.target !== "/api/submissions/test") return undefined;
  try {
    const parsed = JSON.parse(request.body.toString()) as { document?: { submission?: { values?: Record<string, unknown> } } };
    return parsed.document?.submission?.values;
  } catch {
    return undefined;
  }
}

/** A fault that answers CTL-01's dry run with the good report after `change`; CTL-02 and the probes get the mock's own answer. */
function dryRunFault(change: (report: Record<string, unknown>) => void): NonNullable<MockHostOptions["fault"]> {
  return (request, response) => {
    const values = dryRunValues(request);
    if (values === undefined || typeof values["name"] !== "string" || values["name"] === "") return false;
    const report = dryRunReport(values, [], { values: GOLDEN_CTL01_VALUES });
    change(report);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(report));
    return true;
  };
}

describe("datum-host-check against a broken host: one fault at a time fails the case that holds it", () => {
  const faults: { name: string; caseId: string; capabilities: string; fault: NonNullable<MockHostOptions["fault"]>; message: RegExp }[] = [
    {
      name: "a 500 on a submission",
      caseId: "SUB-02",
      capabilities: "submissions",
      fault: (request, response) => {
        if (request.method === "POST" && request.target === "/api/submissions" && request.body.toString().includes('"name":""')) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end('{"errors":[{"code":"internal"}]}');
          return true;
        }
        return false;
      },
      message: /never-5xx rule/
    },
    {
      name: "an HTML 400 on the API",
      caseId: "SUB-05",
      capabilities: "submissions",
      fault: (request, response) => {
        if (request.body.toString() === '{"document":') {
          response.writeHead(400, { "Content-Type": "text/html" });
          response.end("<html>Bad Request</html>");
          return true;
        }
        return false;
      },
      message: /the body is not JSON/
    },
    {
      name: "a redelivery that runs the handler again",
      caseId: "SUB-06",
      capabilities: "submissions",
      fault: (request, response) => {
        if (request.body.toString().includes("Grace Hopper")) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ status: "accepted", id: `r${Math.random()}`, reference: "x", digest: "d".repeat(64), handled: false }));
          return true;
        }
        return false;
      },
      message: /handled/
    },
    {
      name: "a known key whose new document is judged before the key is looked up",
      caseId: "SUB-06",
      capabilities: "submissions",
      fault: (request, response) => {
        const body = request.body.toString();
        if (request.method === "POST" && body.includes("Grace Hopper") && body.includes('"code":"abc"')) {
          response.writeHead(422, { "Content-Type": "application/json" });
          response.end('{"errors":[{"field":"code","code":"pattern"}]}');
          return true;
        }
        return false;
      },
      message: /fails a rule: expected HTTP 409/
    },
    {
      name: "a definition without an ETag",
      caseId: "FRM-02",
      capabilities: "forms",
      fault: (request, response) => {
        if (request.method === "GET" && request.target === "/api/forms/datum-security-suite/definition") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ id: "datum-security-suite", version: "1", root: { configuration: { securitySuiteFixture: "1" } } }));
          return true;
        }
        return false;
      },
      message: /no ETag header/
    },
    {
      name: "a public copy that carries the server-secret rule",
      caseId: "FRM-01",
      capabilities: "forms",
      fault: (request, response) => {
        if (request.target.startsWith("/api/forms/datum-security-suite%401/")) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ id: "datum-security-suite", rules: { run: "server-secret" } }));
          return true;
        }
        return false;
      },
      message: /contains "server-secret"/
    },
    {
      name: "a bundle that is not immutable",
      caseId: "AST-02",
      capabilities: "assets",
      fault: (request, response) => {
        if (request.target === "/datum/assets/b1d2c3/datum-form.js") {
          response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
          response.end("//");
          return true;
        }
        return false;
      },
      message: /Cache-Control/
    },
    {
      name: "a dot segment that reaches a file",
      caseId: "AST-05",
      capabilities: "assets",
      fault: (request, response) => {
        if (request.target.endsWith("/sub/../../manifest.json")) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end("{}");
          return true;
        }
        return false;
      },
      message: /\/sub\/\.\.\/\.\.\/manifest\.json: expected HTTP 400 or 404/
    },
    {
      name: "a flood answer without Retry-After",
      caseId: "FLD-01",
      capabilities: "flood",
      fault: (request, response) => {
        if (request.method === "POST" && request.target === "/api/submissions" && request.body.toString() !== "{") {
          response.writeHead(429, { "Content-Type": "application/json" });
          response.end('{"errors":[{"code":"flood"}]}');
          return true;
        }
        return false;
      },
      message: /no Retry-After header/
    },
    {
      // A Datum 404 means the route is on: the preflight leaves it to FRM-03, as HostTck does (FAIL, not "switch it on").
      name: "an unknown form answered 404 with another Datum code",
      caseId: "FRM-03",
      capabilities: "forms",
      fault: (request, response) => {
        if (request.method === "GET" && request.target === "/api/forms/datum-tck-no-such-form/definition") {
          response.writeHead(404, { "Content-Type": "application/json" });
          response.end('{"errors":[{"code":"not_found"}]}');
          return true;
        }
        return false;
      },
      message: /form\.notFound/
    },
    {
      // The route is on but its handler answers a text/plain body with a typed 404 (an Express or Nest handler mismatch): SUB-04's 415, not a missing switch.
      name: "a text/plain submission answered with a Datum 404",
      caseId: "SUB-04",
      capabilities: "submissions",
      fault: (request, response) => {
        if (request.method === "POST" && request.target === "/api/submissions" && request.headers["content-type"] === "text/plain") {
          response.writeHead(404, { "Content-Type": "application/json" });
          response.end('{"errors":[{"code":"not_found"}]}');
          return true;
        }
        return false;
      },
      message: /expected HTTP 415/
    },
    {
      // The golden values are all there, so DRY-01 passes; the extra member is what DRY-02 refuses.
      name: "a dry-run report with an extra accepted member",
      caseId: "DRY-02",
      capabilities: "submissions-test",
      fault: dryRunFault((report) => void (report["accepted"] = true)),
      message: /the report's members/
    },
    {
      name: "a dry-run report with a list missing",
      caseId: "DRY-02",
      capabilities: "submissions-test",
      fault: dryRunFault((report) => void delete report["serverRules"]),
      message: /the report's members/
    },
    {
      name: "a dry-run report nested under report",
      caseId: "DRY-02",
      capabilities: "submissions-test",
      fault: dryRunFault((report) => {
        const nested = { ...report };
        for (const key of Object.keys(report)) delete report[key];
        report["outcome"] = nested["outcome"];
        report["values"] = nested["values"];
        report["report"] = nested;
      }),
      message: /the report's members/
    },
    {
      name: "a dry-run finding that leaves a key out",
      caseId: "DRY-02",
      capabilities: "submissions-test",
      fault: dryRunFault((report) => void (report["errors"] = [{ field: "name", code: "required" }])),
      message: /the keys of/
    }
  ];

  for (const { name, caseId, capabilities, fault, message } of faults) {
    it(`${name}: ${caseId} FAILs, exit 1`, async () => {
      const broken = await host({ fault });
      const result = await check(["--endpoint", broken.url, "--capabilities", capabilities]);
      expect(result.code, result.out).toBe(1);
      expect(result.out).not.toMatch(/^preflight \S+: MISSING/m);
      const failed = [...result.out.matchAll(/^FAIL (\S+)/gm)].map((match) => match[1]);
      expect(failed).toEqual([caseId]);
      expect(result.out).toMatch(message);
    });
  }
});

describe("--csrf (the cookie-token recipe of the Java example ITs)", () => {
  it("passes the five capabilities against a host that checks the token, sending only the token cookie", async () => {
    const guarded = await host({ csrf: true });
    const result = await check(["--endpoint", guarded.url, "--capabilities", ALL_N1, "--csrf", "cookie:XSRF-TOKEN:X-XSRF-TOKEN"]);
    expect(result.code, result.out).toBe(0);
    const writes = guarded.seen.filter((entry) => entry.method === "POST");
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) expect(write.headers["cookie"]).toMatch(/^XSRF-TOKEN=[^;]+$/);
  });

  it("3, naming --csrf and the cookie, when the host hands out no such cookie; nothing is posted", async () => {
    const plain = await host();
    const result = await check(["--endpoint", plain.url, "--capabilities", "submissions", "--csrf", "cookie:XSRF-TOKEN:X-XSRF-TOKEN"]);
    expect(result.code, result.out).toBe(3);
    expect(result.out).toMatch(/preflight csrf-token: MISSING --csrf names the cookie XSRF-TOKEN/);
    expect(plain.seen.filter((entry) => entry.method !== "GET")).toEqual([]);
  });
});

describe("the exit codes", () => {
  it("3 when the host cannot be reached, with a readable message and no stack", async () => {
    const result = await check(["--endpoint", "http://127.0.0.1:9", "--capabilities", ALL_N1]);
    expect(result.code).toBe(3);
    expect(result.out).toMatch(/cannot reach http:\/\/127\.0\.0\.1:9/);
    expect(result.out + result.err).not.toMatch(/\n\s+at /);
  });

  it("3 when the fixture form is missing or at another version, saying how to install it", async () => {
    const missing = await host({ fixture: false });
    const result = await check(["--endpoint", missing.url, "--capabilities", "forms"]);
    expect(result.code).toBe(3);
    expect(result.out).toMatch(/fixture form datum-security-suite is not installed[\s\S]*datum-host-check fixtures --out/);
    expect(missing.seen.filter((entry) => entry.method === "POST")).toEqual([]);
    const other = await host({ fixtureVersion: "7" });
    const second = await check(["--endpoint", other.url, "--capabilities", "submissions"]);
    expect(second.code).toBe(3);
    expect(second.out).toMatch(/at version "7"/);
  });

  it("3 when a route the capability needs is off, naming its switch; the probes send nothing the throttle counts", async () => {
    for (const [route, capability, property] of [
      ["submissions", "submissions", "datum.web.api.endpoints.submissions=true"],
      ["validate", "submissions", "datum.web.api.endpoints.validate=true"],
      ["submissions", "flood", "datum.web.api.endpoints.submissions=true"],
      ["definition", "forms", "datum.web.api.endpoints.definition=true"],
      ["assets", "assets", "datum.web.assets.enabled=true"]
    ] as const) {
      const routeOff = await host({ off: [route] });
      const result = await check(["--endpoint", routeOff.url, "--capabilities", capability]);
      expect(result.code, `${route} ${capability}: ${result.out}`).toBe(3);
      expect(result.out).toContain(property);
      expect(routeOff.seen.filter((entry) => entry.method === "POST" && entry.headers["content-type"] === "application/json")).toEqual([]);
    }
  });

  it("finds the fixture form through the validate route when the definition route is off", async () => {
    const noDefinition = await host({ off: ["definition"] });
    const passed = await check(["--endpoint", noDefinition.url, "--capabilities", "submissions"]);
    expect(passed.code, passed.out).toBe(0);
    const noForm = await host({ off: ["definition"], fixture: false });
    const missing = await check(["--endpoint", noForm.url, "--capabilities", "submissions"]);
    expect(missing.code).toBe(3);
    expect(missing.out).toMatch(/POST \/api\/submissions\/validate -> 404 form.notFound/);
  });

  it("3 when the dry-run switch is off, naming the switch; the probe sends nothing the throttle counts", async () => {
    const off = await host({ off: ["test"] });
    const result = await check(["--endpoint", off.url, "--capabilities", "submissions-test"]);
    expect(result.code).toBe(3);
    expect(result.out).toContain("datum.web.api.endpoints.test=true");
    const on = await host();
    const passed = await check(["--endpoint", on.url, "--capabilities", "submissions-test"]);
    expect(passed.code, passed.out).toBe(0);
    expect(on.seen.filter((entry) => entry.target === "/api/submissions/test").map((entry) => entry.headers["content-type"])).toEqual(["text/plain", "application/json", "application/json", "application/json"]);
  });

  it("2 when a named capability asserted nothing (every case skipped by its assumption), and nothing is sent for it", async () => {
    const good = await host();
    // builder without --build-form: the module's assumption skips every case before any request.
    const result = await check(["--endpoint", good.url, "--capabilities", "builder"]);
    expect(result.code).toBe(2);
    expect(result.out).toContain("builder asserted nothing");
    expect(good.seen).toEqual([]);
    const mixed = await check(["--endpoint", good.url, "--capabilities", "forms,builder"]);
    expect(mixed.code).toBe(2);
  });

  it("2 for usage errors: no capabilities, an unknown option, an id outside the named capabilities", async () => {
    expect((await check(["--endpoint", "http://127.0.0.1:9"])).code).toBe(2);
    expect((await check(["--endpoint", "http://127.0.0.1:9", "--capabilities", "forms", "--bogus"])).code).toBe(2);
    const outside = await check(["--endpoint", "http://127.0.0.1:9", "--capabilities", "forms", "--only", "SUB-01"]);
    expect(outside.code).toBe(2);
    expect(outside.err).toContain("SUB-01 belongs to submissions");
    expect((await check(["--endpoint", "http://127.0.0.1:9", "--capabilities", "forms", "--only", "XYZ-01"])).code).toBe(2);
    // An empty API or WebAuthn path would switch off the JSON half of the never-5xx rule unseen.
    const emptyApi = await check(["--endpoint", "http://127.0.0.1:9", "--capabilities", "forms", "--api-path", ""]);
    expect(emptyApi.code).toBe(2);
    expect(emptyApi.err).toContain("datum.tck.api-path must not be empty");
    expect((await check(["--endpoint", "http://127.0.0.1:9", "--capabilities", "forms", "datum.tck.webauthn-path="])).code).toBe(2);
    expect(() => selectCases(["forms", "assets"], ["FRM-01"], [])).toThrow(SelectionError);
    expect(selectCases(["forms"], [], ["frm-02"]).cases.get("forms")?.map((entry) => entry.id)).toEqual(["FRM-01", "FRM-03", "FRM-04"]);
  });

  it("follows HostTck.Outcome: 1 beats 2, 2 when every case of a capability was skipped, 0 only when each one passed something (KitTest)", () => {
    const summary = (capability: CapabilitySummary["capability"], pass: number, fail: number, skip: number): CapabilitySummary => ({ capability, pass, fail, skip, exercised: pass > 0 });
    const ok = { ok: true, probes: [] };
    expect(decide(ok, [{ id: "BLD-01", status: "SKIP" }], [summary("builder", 0, 0, 1)]).exitCode).toBe(2);
    expect(decide(ok, [{ id: "FRM-01", status: "PASS" }], [summary("forms", 1, 0, 0)]).exitCode).toBe(0);
    expect(decide(ok, [], []).exitCode).toBe(2);
    expect(decide(ok, [{ id: "FRM-01", status: "FAIL" }, { id: "BLD-01", status: "SKIP" }], [summary("forms", 0, 1, 0), summary("builder", 0, 0, 1)]).exitCode).toBe(1);
    expect(decide({ ok: false, probes: [{ id: "reachable", status: "missing", message: "x" }] }, [], []).exitCode).toBe(3);
  });

  it("answers list, explain, --help and --version", async () => {
    const list = await check(["list", "--json"]);
    expect(list.code).toBe(0);
    expect((JSON.parse(list.out) as { cases: unknown[] }).cases).toHaveLength(50);
    const explain = await check(["explain", "sub-06"]);
    expect(explain.code).toBe(0);
    expect(explain.out).toContain("SubmissionsContract#aSubmitAttemptIsOneRecordByItsKey");
    expect((await check(["explain", "NOPE-1"])).code).toBe(2);
    expect((await check(["--help"])).out).toContain("--csrf cookie:");
    expect((await check(["--version"])).out).toMatch(/^datum-host-check \d+\.\d+\.\d+/);
  });

  it("keeps the run's exit code when the report cannot be written; only a passing run then ends 4", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "datum-host-check-unwritable-"));
    try {
      const file = join(scratch, "a-file");
      writeFileSync(file, "");
      const inconclusive = await check(["--endpoint", "http://127.0.0.1:9", "--capabilities", "forms", "--out", join(file, "report")]);
      expect(inconclusive.code).toBe(3);
      expect(inconclusive.err).toMatch(/could not write the report under .*a-file/);
      expect(inconclusive.out + inconclusive.err).not.toMatch(/\n\s+at /);
      const good = await host();
      const passed = await check(["--endpoint", good.url, "--capabilities", "forms", "--out", join(file, "report")]);
      expect(passed.out).toContain("== PASS: 4 passed");
      expect(passed.code).toBe(4);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("never leaves the report folder empty on an inconclusive run", async () => {
    const out = mkdtempSync(join(tmpdir(), "datum-host-check-inconclusive-"));
    try {
      const result = await check(["--endpoint", "http://127.0.0.1:9", "--capabilities", "forms", "--out", out]);
      expect(result.code).toBe(3);
      const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as HostCheckReport;
      expect(report.verdict).toBe("INCONCLUSIVE");
      expect(report.exitCode).toBe(3);
      expect(readFileSync(join(out, "report.md"), "utf8")).toContain("# Datum host check: INCONCLUSIVE");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
