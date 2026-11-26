import { describe, expect, it } from "vitest";

import type { Exchange } from "../src/runners/endpoint/http.js";
import { LEAK_MARKERS, observe, violatesNever500, wireProblems } from "../src/runners/endpoint/wire.js";

const answer = (status: number, body: unknown | undefined, text?: string) => {
  const raw = text ?? (body === undefined ? "" : JSON.stringify(body));
  let json: unknown;
  let jsonOk = false;
  try {
    json = JSON.parse(raw);
    jsonOk = true;
  } catch {
    jsonOk = false;
  }
  return { status, text: raw, json, jsonOk };
};

describe("the status and code table", () => {
  it("reads a 200 verdict, a 200 receipt and a 422 as verdicts", () => {
    expect(observe(answer(200, { accepted: true, errors: [] }))).toEqual({ kind: "verdict", accepted: true, errors: [] });
    expect(observe(answer(200, { accepted: false, errors: [{ field: "name", code: "required", severity: "error" }] }))).toEqual({
      kind: "verdict",
      accepted: false,
      errors: [{ code: "required", field: "name", severity: "error" }]
    });
    expect(observe(answer(200, { id: "r1", reference: "R-1", status: "accepted", digest: "ab12", receipt: {} }))).toEqual({ kind: "verdict", accepted: true, errors: [], digest: "ab12" });
    expect(observe(answer(422, { errors: [{ field: null, code: "journey.unknown", message: "words" }] }))).toEqual({ kind: "verdict", accepted: false, errors: [{ code: "journey.unknown", field: null }] });
  });

  it("types the refusals", () => {
    const kind = (status: number, body: unknown, text?: string) => {
      const seen = observe(answer(status, body, text));
      return seen.kind === "refusal" ? `${seen.refusal}${seen.code !== undefined ? `/${seen.code}` : ""}` : seen.kind;
    };
    expect(kind(400, { errors: [{ field: null, code: "bad_document" }] })).toBe("bad_document/bad_document");
    expect(kind(400, { errors: [{ field: null, code: "bad_source" }] })).toBe("other/bad_source");
    expect(kind(413, { errors: [{ field: null, code: "bad_document" }] })).toBe("too_large/bad_document");
    expect(kind(413, undefined, "<html>too big</html>")).toBe("too_large/bad_document");
    expect(kind(409, { errors: [{ field: null, code: "form.outdated" }] })).toBe("outdated/form.outdated");
    expect(kind(409, { errors: [{ field: null, code: "version_superseded" }] })).toBe("outdated/version_superseded");
    expect(kind(422, { errors: [{ field: null, code: "definition.tooDeep" }] })).toBe("definition_too_deep/definition.tooDeep");
    expect(kind(404, undefined, "<html>not found</html>")).toBe("not_found");
    expect(kind(405, undefined, "<html>no</html>")).toBe("method");
    expect(kind(429, { errors: [{ field: null, code: "flood" }] })).toBe("rate_limited/flood");
    expect(kind(503, { errors: [{ field: null, code: "server.unavailable" }] })).toBe("unavailable/server.unavailable");
    // A run that failed gave no verdict: a 503 with the run's own code, typed apart from "unavailable".
    expect(kind(503, { errors: [{ code: "wasm.execution_error" }] })).toBe("other/wasm.execution_error");
    expect(kind(503, { errors: [{ code: "outcome_too_large" }] })).toBe("other/outcome_too_large");
    // The registered form too deep: the refusal the 422 of a builder save is typed as too.
    expect(kind(503, { errors: [{ code: "definition.tooDeep" }] })).toBe("definition_too_deep/definition.tooDeep");
    expect(kind(403, { errors: [{ field: null, code: "form.closed" }] })).toBe("other/form.closed");
    expect(kind(200, { accepted: false, errors: [{ field: null, code: "wasm.execution_error" }] })).toBe("other/wasm.execution_error");
    expect(kind(302, undefined, "")).toBe("other/redirect");
  });

  it("calls a 5xx, an HTML 200 and a body of the wrong shape what they are, and they break the never-500 rule", () => {
    for (const seen of [observe(answer(500, { errors: [{ field: null, code: "server.error" }] })), observe(answer(502, undefined, "<html>bad gateway</html>")), observe(answer(200, undefined, "<html>ok</html>")), observe(answer(200, { hello: "world" })), observe(answer(422, { oops: true })), observe(answer(400, undefined, "plain text"))]) {
      expect(violatesNever500(seen), JSON.stringify(seen)).toBe(true);
    }
    expect(violatesNever500(observe(answer(503, { errors: [{ field: null, code: "validator_unavailable" }] })))).toBe(false);
    for (const code of ["wasm.execution_error", "outcome_too_large", "definition.tooDeep"]) {
      expect(violatesNever500(observe(answer(503, { errors: [{ code }] }))), code).toBe(false);
    }
    expect(violatesNever500(observe(answer(400, { errors: [{ field: null, code: "bad_document" }] })))).toBe(false);
  });
});

const exchange = (overrides: Partial<Exchange>): Exchange => ({
  label: "x",
  method: "POST",
  path: "/api/submissions/validate",
  requestBytes: 10,
  status: 200,
  contentType: "application/json",
  text: '{"accepted":true,"errors":[]}',
  truncated: false,
  json: { accepted: true, errors: [] },
  jsonOk: true,
  elapsedMs: 1,
  firstByteMs: 1,
  connectMs: null,
  ...overrides
});

describe("the wire hygiene rule (SEC-05)", () => {
  it("passes a clean contract answer, a typed 503, a routing 404 and a 413", () => {
    expect(wireProblems(exchange({}), "submissions")).toEqual([]);
    expect(wireProblems(exchange({ status: 503, text: '{"errors":[{"field":null,"code":"validator_unavailable"}]}', json: { errors: [{ field: null, code: "validator_unavailable" }] } }), "submissions")).toEqual([]);
    // A failed run, a refused registered form and an unreachable data source are typed 503s as well.
    for (const code of ["wasm.execution_error", "outcome_too_large", "definition.tooDeep", "data_source.unavailable"]) {
      const text = JSON.stringify({ errors: [{ code }] });
      expect(wireProblems(exchange({ status: 503, text, json: JSON.parse(text) }), "submissions"), code).toEqual([]);
    }
    // The verdict's notes ride beside errors, in the shape of an errors entry.
    const withNotes = '{"accepted":true,"errors":[],"notes":[{"code":"w","severity":"warning"}]}';
    expect(wireProblems(exchange({ text: withNotes, json: JSON.parse(withNotes) }), "submissions")).toEqual([]);
    expect(wireProblems(exchange({ status: 404, text: "<html>Page not found</html>", jsonOk: false, json: undefined }), "submissions")).toEqual([]);
    expect(wireProblems(exchange({ status: 413, text: "Request Entity Too Large", jsonOk: false, json: undefined }), "submissions")).toEqual([]);
  });

  it("flags a 500, an untyped 503, a body that is not JSON, and extra members", () => {
    expect(wireProblems(exchange({ status: 500, text: "{}", json: {} }), "submissions").join()).toMatch(/server error/);
    expect(wireProblems(exchange({ status: 503, text: "{}", json: {} }), "submissions").join()).toMatch(/server error/);
    expect(wireProblems(exchange({ text: "<html>", jsonOk: false, json: undefined }), "submissions").join()).toMatch(/not JSON/);
    expect(wireProblems(exchange({ text: '{"accepted":true,"errors":[],"trace":1}', json: { accepted: true, errors: [], trace: 1 } }), "submissions").join()).toMatch(/"trace"/);
    expect(wireProblems(exchange({ status: 422, text: '{"errors":[{"field":"a","code":"x","parameters":{}}]}', json: { errors: [{ field: "a", code: "x", parameters: {} }] } }), "submissions").join()).toMatch(/"parameters"/);
  });

  it("flags a failed run answered as a verdict: 200 or 422 on a judging route, never on a builder save", () => {
    const run = '{"accepted":false,"errors":[{"field":null,"code":"wasm.execution_error"}]}';
    expect(wireProblems(exchange({ text: run, json: JSON.parse(run) }), "submissions").join()).toMatch(/a failed run is a 503/);
    const refused = '{"errors":[{"code":"outcome_too_large"}]}';
    expect(wireProblems(exchange({ path: "/api/submissions", status: 422, text: refused, json: JSON.parse(refused) }), "submissions").join()).toMatch(/outcome_too_large/);
    const deep = '{"errors":[{"code":"definition.tooDeep"}]}';
    expect(wireProblems(exchange({ path: "/api/submissions/test", status: 422, text: deep, json: JSON.parse(deep) }), "submissions").join()).toMatch(/definition.tooDeep/);
    // A save of a definition nested too deep stays a 422 of the builder, and a validator that failed is a verdict.
    expect(wireProblems(exchange({ path: "/api/forms", status: 422, text: deep, json: JSON.parse(deep) }), "submissions")).toEqual([]);
    const failed = '{"errors":[{"code":"validator.failed"}]}';
    expect(wireProblems(exchange({ path: "/api/submissions", status: 422, text: failed, json: JSON.parse(failed) }), "submissions")).toEqual([]);
  });

  it("flags every leak marker", () => {
    expect(LEAK_MARKERS.length).toBeGreaterThanOrEqual(10);
    for (const marker of LEAK_MARKERS) {
      const text = JSON.stringify({ errors: [{ field: null, code: "x", message: `oops ${marker}` }] });
      expect(wireProblems(exchange({ status: 422, text, json: JSON.parse(text) }), "submissions").join(), marker).toContain(JSON.stringify(marker));
    }
  });

  it("does not read a public asset URL in a themed HTML page as a host-path leak (deploy 5 SEC-05)", () => {
    const page = '<html><script src="/core/assets/vendor/jquery/jquery.min.js"></script><script src="/core/assets/vendor/node_modules.js"></script></html>';
    for (const status of [404, 405]) {
      expect(wireProblems(exchange({ status, text: page, jsonOk: false, json: undefined }), "submissions")).toEqual([]);
    }
    // Nor in a JSON body that merely links one.
    const linked = JSON.stringify({ errors: [{ field: null, code: "x", message: "see /core/assets/vendor/jquery/jquery.min.js" }] });
    expect(wireProblems(exchange({ status: 422, text: linked, json: JSON.parse(linked) }), "submissions")).toEqual([]);
  });

  it("still flags filesystem paths in a JSON body", () => {
    for (const leak of ["/var/www/html/web/index.php", "/home/app/src/x.js", "/opt/app/vendor/autoload.php", "C:\\inetpub\\app\\x", "Foo.php:42", "#0 /srv/app(12): run()"]) {
      const text = JSON.stringify({ errors: [{ field: null, code: "x", message: `oops ${leak}` }] });
      expect(wireProblems(exchange({ status: 422, text, json: JSON.parse(text) }), "submissions").length, leak).toBeGreaterThan(0);
    }
  });
});
