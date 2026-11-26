import { afterEach, describe, expect, it } from "vitest";

import { runHostCheckCli } from "../../src/host-check/cli.js";
import { startMockHost, type MockHost, type MockHostOptions, type SeenRequest } from "./helpers/mock-host.js";

/**
 * HCX-01..04 (the host-context capability) against the mock host, which plays a deployment that serves the kit's host
 * context fixture and wires the TEST-ONLY provider reading X-Datum-Test-Role. One fault at a time proves each case
 * fails for the right reason: a host that ignores the header, that reads the context a client writes, that treats no
 * context as a role, or that does not serve the fixture at all.
 */
const hosts: MockHost[] = [];
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.close();
});

async function host(options: MockHostOptions = {}): Promise<MockHost> {
  const started = await startMockHost({ hostContext: true, ...options });
  hosts.push(started);
  return started;
}

async function check(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runHostCheckCli(argv, { stdout: (text) => void (out += text), stderr: (text) => void (err += text) });
  return { code, out, err };
}

const run = (url: string, ...more: string[]) => check(["--endpoint", url, "--capabilities", "host-context", ...more]);

function bodyOf(request: SeenRequest): Record<string, unknown> {
  return JSON.parse(request.body.toString("utf8")) as Record<string, unknown>;
}

describe("host-context (HCX-01..04)", () => {
  it("passes against a host that reads the role from the header and nothing the client writes", async () => {
    const good = await host();
    const result = await run(good.url);
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.out).toContain("4 passed, 0 failed");
    // The role rides only the test header, on the check, the delivery and the dry run alike.
    const roles = good.seen.filter((entry) => entry.method === "POST" && entry.headers["content-type"] === "application/json").map((entry) => `${entry.target} ${String(entry.headers["x-datum-test-role"])}`);
    expect(roles).toContain("/api/submissions/validate admin");
    expect(roles).toContain("/api/submissions admin");
    expect(roles).toContain("/api/submissions/test undefined");
    expect(roles).toContain("/api/submissions/test user");
    // The page check names the fixture's page.
    const pageChecks = good.seen.filter((entry) => entry.target === "/api/submissions/validate" && entry.headers["content-type"] === "application/json").map(bodyOf).filter((body) => body["scope"] === "page");
    expect(pageChecks).toEqual([expect.objectContaining({ pageId: "p1" })]);
  });

  it("is capability-gated: a run that does not name host-context never posts the fixture", async () => {
    const good = await host();
    const result = await check(["--endpoint", good.url, "--capabilities", "submissions-test"]);
    expect(result.code, result.out).toBe(0);
    expect(good.seen.some((entry) => entry.target.includes("datum-host-context") || String(entry.headers["x-datum-test-role"] ?? "") !== "")).toBe(false);
  });

  it("fails HCX-01 against a host that ignores the role header (no context for everyone)", async () => {
    const ignoring = await host({
      fault: (request) => {
        delete request.headers["x-datum-test-role"];
        return false;
      }
    });
    const result = await run(ignoring.url);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/FAIL HCX-01[\s\S]*an admin context refuses a document with no admin_note/);
  });

  it("fails HCX-04 against a host that reads the context out of the document", async () => {
    // The role is whatever the document says: the forged hostContext wins over the header's `user`.
    const trusting = await host({
      fault: (request) => {
        if (request.method !== "POST" || request.headers["content-type"] !== "application/json") return false;
        const document = bodyOf(request)["document"] as { hostContext?: { role?: string } } | undefined;
        if (document?.hostContext?.role !== undefined) request.headers["x-datum-test-role"] = document.hostContext.role;
        return false;
      }
    });
    const result = await run(trusting.url, "--only", "HCX-04");
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/FAIL HCX-04[\s\S]*accepted/);
  });

  it("fails HCX-03 against a host that reads no context as a role", async () => {
    const lenient = await host({
      fault: (request) => {
        if (request.method === "POST" && request.headers["content-type"] === "application/json" && request.headers["x-datum-test-role"] === undefined) request.headers["x-datum-test-role"] = "admin";
        return false;
      }
    });
    const result = await run(lenient.url, "--only", "HCX-03");
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/FAIL HCX-03/);
  });

  it("is inconclusive (exit 3) when the fixture form is not installed, naming the file and the switch", async () => {
    const plain = await host({ hostContext: false });
    const result = await run(plain.url);
    expect(result.code).toBe(3);
    expect(result.out).toContain("fixture-host-context-form.json");
  });

  it("is listed and explained, with the fixtures it needs", async () => {
    const list = await check(["list"]);
    expect(list.out).toMatch(/HCX-01[\s\S]*HCX-04[\s\S]*FLD-01/);
    const explain = await check(["explain", "HCX-03"]);
    expect(explain.code).toBe(0);
    expect(explain.out).toContain("HostContextContract#hcx03NoContextIsTheLenientReading");
    expect(explain.out).toContain("fixture-host-context-form.json");
    expect(explain.out).toContain("visibilitySkipped");
  });
});
