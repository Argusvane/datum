import { afterEach, describe, expect, it } from "vitest";

import { runHostCheckCli } from "../../src/host-check/cli.js";
import { startMockHost, type MockHost, type MockHostOptions, type SeenRequest } from "./helpers/mock-host.js";

/**
 * HRD-01..05 and RDN-01..02 against the mock host, which stands in for a deployment that registered the
 * hostile rule module (`fault` answers the four attack names) or one whose runtime is down. One fault at a
 * time proves each case fails for the right reason. A run that failed (wasm.execution_error, outcome_too_large)
 * is a 503 without Retry-After; a verdict the kernel reached (validator.failed) is a 422.
 */
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

function attackName(request: SeenRequest): string | undefined {
  if (request.method !== "POST" || (request.target !== "/api/submissions" && request.target !== "/api/submissions/validate")) return undefined;
  try {
    const body = JSON.parse(request.body.toString("utf8")) as { document?: { submission?: { values?: { name?: string } } } };
    const name = body.document?.submission?.values?.name;
    return typeof name === "string" && name.startsWith("datum-tck-") ? name : undefined;
  } catch {
    return undefined;
  }
}

type Responder = (name: string) => { status: number; code: string; extra?: string; headers?: Record<string, string>; body?: Record<string, unknown> } | undefined;

type Fault = NonNullable<MockHostOptions["fault"]>;

function hardened(respond: Responder): Fault {
  return (request, response) => {
    const name = attackName(request);
    const answer = name === undefined ? undefined : respond(name);
    if (answer === undefined) return false;
    response.writeHead(answer.status, { "Content-Type": "application/json", ...(answer.headers ?? {}) });
    response.end(JSON.stringify({ ...(answer.body ?? {}), errors: [{ code: answer.code, message: answer.extra ?? answer.code }] }));
    return true;
  };
}

/** A run that failed: the server's 503 with the run's code and no Retry-After. */
const FAILED = { status: 503, code: "wasm.execution_error" } as const;

const GOOD: Responder = (name) => (name === "datum-tck-memory" || name === "datum-tck-huge" ? { status: 422, code: "validator.failed" } : FAILED);

describe("hardening (HRD-01..05)", () => {
  it("passes against a host that stops each attack and answers the next run", async () => {
    const good = await host({ fault: hardened(GOOD) });
    const result = await check(["--endpoint", good.url, "--capabilities", "hardening"]);
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.out).toContain("5 passed, 0 failed");
    for (const id of ["HRD-01", "HRD-02", "HRD-03", "HRD-04", "HRD-05"]) expect(result.out).toContain(id);
  });

  it("passes a host whose memory and 40 MiB refusals are a failed run (503) as well as one whose guest threw (422)", async () => {
    const stopped = await host({ fault: hardened((name) => (name === "datum-tck-memory" ? FAILED : name === "datum-tck-huge" ? { status: 503, code: "outcome_too_large" } : GOOD(name))) });
    const result = await check(["--endpoint", stopped.url, "--capabilities", "hardening", "--only", "HRD-02,HRD-03"]);
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.out).toContain("2 passed, 0 failed");
  });

  it("fails a failed run answered as a 422 or a 200 verdict, or a 503 that carries Retry-After (the old contract)", async () => {
    const asVerdict = await host({ fault: hardened((name) => (name === "datum-tck-loop" ? { status: 422, code: "wasm.execution_error" } : GOOD(name))) });
    const loop = await check(["--endpoint", asVerdict.url, "--capabilities", "hardening", "--only", "HRD-01"]);
    expect(loop.code).toBe(1);
    expect(loop.out).toMatch(/a run that failed is the server's 503[\s\S]*expected HTTP 503, got POST \/api\/submissions -> 422/);

    const retry = await host({ fault: hardened((name) => (name === "datum-tck-loop" ? { ...FAILED, headers: { "Retry-After": "5" } } : GOOD(name))) });
    const busy = await check(["--endpoint", retry.url, "--capabilities", "hardening", "--only", "HRD-01"]);
    expect(busy.code).toBe(1);
    expect(busy.out).toMatch(/only server.busy carries Retry-After/);

    const hugeAs422 = await host({ fault: hardened((name) => (name === "datum-tck-huge" ? { status: 422, code: "outcome_too_large" } : GOOD(name))) });
    const huge = await check(["--endpoint", hugeAs422.url, "--capabilities", "hardening", "--only", "HRD-03"]);
    expect(huge.code).toBe(1);
    expect(huge.out).toMatch(/expected HTTP 503, got POST \/api\/submissions -> 422/);

    // Never a 500: the kit's never-5xx rule names it too.
    const broken = await host({ fault: hardened((name) => (name === "datum-tck-loop" ? { status: 500, code: "server.error" } : GOOD(name))) });
    const crashed = await check(["--endpoint", broken.url, "--capabilities", "hardening", "--only", "HRD-01"]);
    expect(crashed.code).toBe(1);
  });

  it("fails HRD-05 when the journey check answers a 200 verdict or a 422, or a 503 that still has an accepted member", async () => {
    const asked = (answer: ReturnType<Responder>): Responder => (name) => (name === "datum-tck-loop" ? answer : GOOD(name));
    const onValidate = (respond: Responder): NonNullable<MockHostOptions["fault"]> => {
      const inner = hardened(respond);
      return (request, response) => (request.target === "/api/submissions/validate" ? inner(request, response) : false);
    };
    for (const [answer, expected] of [
      [{ status: 200, code: "wasm.execution_error", body: { accepted: false } }, /expected HTTP 503, got POST \/api\/submissions\/validate -> 200/],
      [{ status: 422, code: "wasm.execution_error" }, /expected HTTP 503, got POST \/api\/submissions\/validate -> 422/],
      [{ status: 503, code: "wasm.execution_error", body: { accepted: false } }, /an accepted member/]
    ] as const) {
      const bad = await host({ fault: onValidate(asked(answer)) });
      const result = await check(["--endpoint", bad.url, "--capabilities", "hardening", "--only", "HRD-05"]);
      expect(result.code, JSON.stringify(answer)).toBe(1);
      expect(result.out).toMatch(expected);
    }
  });

  it("fails HRD-05 against a host that never registered the module: the loop is judged, not stopped", async () => {
    const plain = await host();
    const result = await check(["--endpoint", plain.url, "--capabilities", "hardening", "--only", "HRD-05"]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/FAIL HRD-05[\s\S]*hostile rule module/);
  });

  it("fails HRD-01 when the loop is accepted (the module is not registered), naming the hint", async () => {
    const plain = await host();
    const result = await check(["--endpoint", plain.url, "--capabilities", "hardening", "--only", "HRD-01"]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/FAIL HRD-01[\s\S]*hostile rule module[\s\S]*expected HTTP 422/);
  });

  it("fails HRD-01 on the wrong code, HRD-04 on an echoed forgery, HRD-03 on an unexpected code", async () => {
    const wrongLoop = await host({ fault: hardened((name) => (name === "datum-tck-loop" ? { status: 422, code: "validator.failed" } : GOOD(name))) });
    const loop = await check(["--endpoint", wrongLoop.url, "--capabilities", "hardening", "--only", "HRD-01"]);
    expect(loop.code).toBe(1);
    expect(loop.out).toMatch(/expected code wasm.execution_error/);

    const forged = await host({ fault: hardened((name) => (name === "datum-tck-stray" ? { ...FAILED, extra: "forged outcome" } : GOOD(name))) });
    const stray = await check(["--endpoint", forged.url, "--capabilities", "hardening", "--only", "HRD-04"]);
    expect(stray.code).toBe(1);
    expect(stray.out).toContain('contains "forged"');

    const odd = await host({ fault: hardened((name) => (name === "datum-tck-huge" ? { status: 422, code: "something.else" } : GOOD(name))) });
    const huge = await check(["--endpoint", odd.url, "--capabilities", "hardening", "--only", "HRD-03"]);
    expect(huge.code).toBe(1);
    expect(huge.out).toMatch(/expected code outcome_too_large or wasm.execution_error or validator.failed/);
  });

  it("fails HRD-02 when the refusal carries a body over 64 KiB", async () => {
    const big = await host({ fault: hardened((name) => (name === "datum-tck-memory" ? { status: 422, code: "validator.failed", extra: "x".repeat(100 * 1024) } : GOOD(name))) });
    const result = await check(["--endpoint", big.url, "--capabilities", "hardening", "--only", "HRD-02"]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/never carries the guest's answer/);
  });

  it("fails when the run after an attack is no longer answered", async () => {
    let attacked = false;
    const broken = await host({
      fault: (request, response) => {
        const name = attackName(request);
        if (name !== undefined) {
          attacked = true;
          return hardened(GOOD)(request, response);
        }
        if (attacked && request.method === "POST" && request.target === "/api/submissions") {
          response.writeHead(503, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ errors: [{ code: "server.unavailable", message: "x" }] }));
          return true;
        }
        return false;
      }
    });
    const result = await check(["--endpoint", broken.url, "--capabilities", "hardening", "--only", "HRD-02"]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/the run after an attack: expected HTTP 200/);
  });
});

describe("runtime-down (RDN-01..02)", () => {
  const down =
    (code: string, routes: readonly string[] = ["/api/submissions", "/api/submissions/validate"], extra: Record<string, unknown> = {}): Fault =>
    (request, response) => {
      if (request.method !== "POST" || !routes.includes(request.target) || request.headers["content-type"] === "text/plain") return false;
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ...extra, errors: [{ code, message: code }] }));
      return true;
    };

  it("passes when every submission and every check is answered 503 server.unavailable or validator_unavailable", async () => {
    for (const code of ["server.unavailable", "validator_unavailable"]) {
      const downHost = await host({ fault: down(code) });
      const result = await check(["--endpoint", downHost.url, "--capabilities", "runtime-down"]);
      expect(result.code, result.out + result.err).toBe(0);
      expect(result.out).toContain("2 passed, 0 failed");
    }
  });

  it("fails RDN-02 when the check answers a verdict, or a 503 with an accepted member", async () => {
    const delivery = await host({ fault: down("server.unavailable", ["/api/submissions"]) });
    const verdict = await check(["--endpoint", delivery.url, "--capabilities", "runtime-down"]);
    expect(verdict.code).toBe(1);
    expect(verdict.out).toMatch(/PASS RDN-01[\s\S]*FAIL RDN-02[\s\S]*expected HTTP 503/);

    const member = await host({ fault: down("server.unavailable", undefined, { accepted: false }) });
    const accepted = await check(["--endpoint", member.url, "--capabilities", "runtime-down", "--only", "RDN-02"]);
    expect(accepted.code).toBe(1);
    expect(accepted.out).toMatch(/an accepted member/);
  });

  it("fails when the host accepts the submission unchecked, and on a 503 without the typed code", async () => {
    const up = await host();
    const accepted = await check(["--endpoint", up.url, "--capabilities", "runtime-down"]);
    expect(accepted.code).toBe(1);
    expect(accepted.out).toMatch(/FAIL RDN-01[\s\S]*expected HTTP 503/);

    const other = await host({ fault: down("something.else") });
    const result = await check(["--endpoint", other.url, "--capabilities", "runtime-down"]);
    expect(result.code).toBe(1);
  });

  it("is listed and explained", async () => {
    const list = await check(["list"]);
    expect(list.out).toMatch(/HRD-01[\s\S]*HRD-05[\s\S]*RDN-01[\s\S]*RDN-02/);
    const explain = await check(["explain", "RDN-01"]);
    expect(explain.code).toBe(0);
    expect(explain.out).toContain("RuntimeDownContract#aRuntimeThatCannotProveItsProgramAnswers503ToEverySubmission");
  });
});
