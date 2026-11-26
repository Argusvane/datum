import type { ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { runHostCheckCli } from "../../src/host-check/cli.js";
import { startMockHost, type MockHost, type MockHostOptions, type SeenRequest } from "./helpers/mock-host.js";

/**
 * SUB-03 (the verdict's one wire shape) and SUB-07 (a strict request) against the mock host, which is strict as the
 * Spring and FastAPI hosts are. One fault at a time: a check that answers a bare document, a host that ignores a
 * scope, and verdicts that carry a severity in errors, a null field, an empty notes list or a member of their own.
 */
type Fault = NonNullable<MockHostOptions["fault"]>;

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

const only = (url: string, id: string) => check(["--endpoint", url, "--capabilities", "submissions", "--only", id]);

const isCheck = (request: SeenRequest): boolean => request.method === "POST" && request.target === "/api/submissions/validate" && request.headers["content-type"] === "application/json";
const bodyOf = (request: SeenRequest): Record<string, unknown> => JSON.parse(request.body.toString("utf8")) as Record<string, unknown>;

function answer(response: ServerResponse, status: number, body: unknown): true {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
  return true;
}

describe("a check is strict about its request (SUB-07)", () => {
  it("passes against a strict host, sending each wrong shape in turn", async () => {
    const strict = await host();
    const result = await only(strict.url, "SUB-07");
    expect(result.code, result.out + result.err).toBe(0);
    const sent = strict.seen.filter(isCheck).map(bodyOf);
    // Past the probe's: a bare document, no scope, another scope, a page beside journey, a page with no page.
    expect(sent.slice(-5).map((body) => [body["document"] === undefined, body["scope"], body["pageId"]])).toEqual([
      [true, undefined, undefined],
      [false, undefined, undefined],
      [false, "all", undefined],
      [false, "journey", "p1"],
      [false, "page", undefined]
    ]);
  });

  it("names the shape a lax host lets through", async () => {
    const lax = (accept: (body: Record<string, unknown>) => boolean): Fault => (request, response) => (isCheck(request) && accept(bodyOf(request)) ? answer(response, 200, { accepted: true, errors: [] }) : false);
    for (const [name, accept, expected] of [
      ["a bare document", (body: Record<string, unknown>) => body["document"] === undefined, /a bare document: expected HTTP 400/],
      ["no scope", (body: Record<string, unknown>) => body["document"] !== undefined && body["scope"] === undefined, /no scope: expected HTTP 400/],
      ["another scope", (body: Record<string, unknown>) => body["scope"] === "all", /another scope: expected HTTP 400/],
      ["a page beside journey", (body: Record<string, unknown>) => body["scope"] === "journey" && body["pageId"] !== undefined, /pageId with scope journey: expected HTTP 400/],
      ["a page check with no page", (body: Record<string, unknown>) => body["scope"] === "page" && body["pageId"] === undefined, /scope page with no pageId: expected HTTP 400/]
    ] as const) {
      const bad = await host({ fault: lax(accept) });
      const result = await only(bad.url, "SUB-07");
      expect(result.code, name).toBe(1);
      expect(result.out, name).toMatch(expected);
    }
  });
});

describe("the verdict has one wire shape (SUB-03)", () => {
  /** The strict mock's answer with a change, for the journey checks of SUB-03 only (the probe sends no control values). */
  const verdictAs = (shape: (verdict: { accepted: boolean; errors: Record<string, unknown>[] }) => unknown): Fault => (request, response) => {
    if (!isCheck(request)) return false;
    const document = bodyOf(request)["document"] as { submission?: { values?: { name?: string } } };
    if (document.submission?.values?.name !== "") {
      return answer(response, 200, shape({ accepted: true, errors: [] }));
    }
    return answer(response, 200, shape({ accepted: false, errors: [{ field: "name", code: "required" }] }));
  };

  it("passes the golden verdicts of a strict host, and accepts notes of warning and info", async () => {
    const good = await host();
    const result = await only(good.url, "SUB-03");
    expect(result.code, result.out + result.err).toBe(0);
    const noted = await host({ fault: verdictAs((verdict) => ({ ...verdict, notes: [{ code: "w", severity: "warning" }, { field: "name", code: "i", severity: "info", message: "m" }] })) });
    const withNotes = await only(noted.url, "SUB-03");
    expect(withNotes.code, withNotes.out).toBe(0);
  });

  it("fails a severity in errors, a null field, an empty notes list, a note with no severity, and a member of its own", async () => {
    for (const [what, shape, expected] of [
      ["severity in errors", (verdict: { accepted: boolean; errors: Record<string, unknown>[] }) => ({ ...verdict, errors: verdict.errors.map((error) => ({ ...error, severity: "error" })) }), /an errors entry holds "severity"/],
      ["a null field", (verdict: { accepted: boolean; errors: Record<string, unknown>[] }) => ({ ...verdict, errors: [...verdict.errors, { code: "x", field: null }] }), /field is left out, not null/],
      ["an empty notes list", (verdict: { accepted: boolean; errors: Record<string, unknown>[] }) => ({ ...verdict, notes: [] }), /notes is left out when empty/],
      ["a note with no severity", (verdict: { accepted: boolean; errors: Record<string, unknown>[] }) => ({ ...verdict, notes: [{ code: "w" }] }), /a note's severity is warning or info/],
      ["a member of its own", (verdict: { accepted: boolean; errors: Record<string, unknown>[] }) => ({ ...verdict, journey: { pages: [], end: "end" } }), /the verdict holds "journey" beside accepted, errors, notes/],
      ["a warning among the blocking errors", (verdict: { accepted: boolean; errors: Record<string, unknown>[] }) => ({ accepted: true, errors: [{ code: "w", severity: "warning" }, ...verdict.errors] }), /an errors entry holds "severity"/]
    ] as const) {
      const bad = await host({ fault: verdictAs(shape) });
      const result = await only(bad.url, "SUB-03");
      expect(result.code, what).toBe(1);
      expect(result.out, what).toMatch(expected);
    }
  });
});
