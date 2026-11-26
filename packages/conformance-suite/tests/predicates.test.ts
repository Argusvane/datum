import { describe as suite, expect, it } from "vitest";

import { describe, evaluate, type CustomPredicate, type Expectation, type PredicateEnv } from "../src/predicates.js";
import type { Observation } from "../src/observation.js";

const verdict = (errors: { code: string; field?: string; severity?: string }[], extra: Partial<Extract<Observation, { kind: "verdict" }>> = {}): Observation => ({
  kind: "verdict",
  accepted: errors.every((error) => error.severity === "info" || error.severity === "warning"),
  errors,
  ...extra
});

const passes = (expectation: Expectation, observation: Observation, env: PredicateEnv = {}) => evaluate(expectation, observation, env).pass;

suite("accepted", () => {
  it("compares the verdict and refuses a non-verdict", () => {
    expect(passes({ op: "accepted", value: true }, verdict([]))).toBe(true);
    expect(passes({ op: "accepted", value: false }, verdict([]))).toBe(false);
    expect(passes({ op: "accepted", value: true }, { kind: "refusal", refusal: "budget", detail: "x" })).toBe(false);
  });
});

suite("codes", () => {
  const observed = verdict([{ code: "required", field: "name" }, { code: "pattern", field: "code" }]);

  it("exactly: the same multiset, a bare code matching any field", () => {
    expect(passes({ op: "codes", exactly: ["required@name", "pattern@code"] }, observed)).toBe(true);
    expect(passes({ op: "codes", exactly: ["pattern", "required"] }, observed)).toBe(true);
    expect(passes({ op: "codes", exactly: ["required@name"] }, observed)).toBe(false);
    expect(passes({ op: "codes", exactly: ["required@name", "pattern@code", "extra"] }, observed)).toBe(false);
    expect(passes({ op: "codes", exactly: ["required@other", "pattern@code"] }, observed)).toBe(false);
  });

  it("exactly treats duplicates as a multiset", () => {
    const twice = verdict([{ code: "x", field: "a" }, { code: "x", field: "a" }]);
    expect(passes({ op: "codes", exactly: ["x@a"] }, twice)).toBe(false);
    expect(passes({ op: "codes", exactly: ["x@a", "x@a"] }, twice)).toBe(true);
    expect(passes({ op: "codes", exactly: [] }, verdict([]))).toBe(true);
  });

  it("includes and excludes", () => {
    expect(passes({ op: "codes", includes: ["required"] }, observed)).toBe(true);
    expect(passes({ op: "codes", includes: ["maxLength"] }, observed)).toBe(false);
    expect(passes({ op: "codes", excludes: ["maxLength"] }, observed)).toBe(true);
    expect(passes({ op: "codes", excludes: ["pattern@code"] }, observed)).toBe(false);
  });

  it("names what it saw when it fails", () => {
    const result = evaluate({ op: "codes", exactly: ["maxLength@name"] }, observed);
    expect(result.reason).toContain("maxLength@name");
    expect(result.reason).toContain("required@name");
  });
});

suite("text predicates", () => {
  it("valuesExcludeText reads the sanitized values only", () => {
    const observation = verdict([], { values: { name: "Ada", nested: { note: "SECRET" } } });
    expect(passes({ op: "valuesExcludeText", text: ["SECRET"] }, observation)).toBe(false);
    expect(passes({ op: "valuesExcludeText", text: ["OTHER"] }, observation)).toBe(true);
  });

  it("textExcludes reads the whole observation", () => {
    const observation = verdict([{ code: "boom ZZMARKERZZ" }]);
    expect(passes({ op: "textExcludes", markers: ["ZZMARKERZZ"] }, observation)).toBe(false);
    expect(passes({ op: "textExcludes", markers: ["nothing"] }, observation)).toBe(true);
  });

  it("logsSome and logsMaxMessage", () => {
    const observation = verdict([], { logs: [{ level: "warn", message: "pattern is risky: risky" }] });
    expect(passes({ op: "logsSome", pattern: "is risky" }, observation)).toBe(true);
    expect(passes({ op: "logsSome", pattern: "^nope" }, observation)).toBe(false);
    expect(passes({ op: "logsMaxMessage", max: 100 }, observation)).toBe(true);
    expect(passes({ op: "logsMaxMessage", max: 5 }, observation)).toBe(false);
  });
});

suite("refusal", () => {
  const refusal: Observation = { kind: "refusal", refusal: "other", code: "not_a_module", detail: "bad plugin" };

  it("checks the kind and, when given, the typed code", () => {
    expect(passes({ op: "refusal", anyOf: ["other"] }, refusal)).toBe(true);
    expect(passes({ op: "refusal", anyOf: ["budget", "too_large"] }, refusal)).toBe(false);
    expect(passes({ op: "refusal", anyOf: ["other"], codes: ["not_a_module", "compile_error"] }, refusal)).toBe(true);
    expect(passes({ op: "refusal", anyOf: ["other"], codes: ["runtime_error"] }, refusal)).toBe(false);
    expect(passes({ op: "refusal", anyOf: ["other"] }, verdict([]))).toBe(false);
  });
});

suite("golden, digest and canonical", () => {
  const env: PredicateEnv = {
    golden: {
      controls: { "CTL-02": { accepted: false, errors: ["required@name"] }, "CTL-01": { accepted: true, errors: [], values: { b: 1, a: { d: 1, c: 2 } } } },
      documents: [{ name: "plain", canonical: '{"a":1}', digest: "abc" }]
    }
  };

  it("golden compares accepted, error tokens and (when pinned) the values, key order aside", () => {
    expect(passes({ op: "golden", key: "CTL-02" }, verdict([{ code: "required", field: "name" }]), env)).toBe(true);
    expect(passes({ op: "golden", key: "CTL-02" }, verdict([{ code: "required", field: "code" }]), env)).toBe(false);
    expect(passes({ op: "golden", key: "CTL-01" }, verdict([], { values: { a: { c: 2, d: 1 }, b: 1 } }), env)).toBe(true);
    expect(passes({ op: "golden", key: "CTL-01" }, verdict([], { values: { a: 1 } }), env)).toBe(false);
    expect(passes({ op: "golden", key: "CTL-99" }, verdict([]), env)).toBe(false);
  });

  it("digestEquals and canonicalEquals read the named golden document", () => {
    expect(passes({ op: "digestEquals", golden: "plain" }, verdict([], { digest: "abc" }), env)).toBe(true);
    expect(passes({ op: "digestEquals", golden: "plain" }, verdict([], { digest: "abd" }), env)).toBe(false);
    expect(passes({ op: "digestEquals", golden: "plain" }, verdict([]), env)).toBe(false);
    expect(passes({ op: "canonicalEquals", golden: "plain" }, verdict([], { canonical: '{"a":1}' }), env)).toBe(true);
    expect(passes({ op: "canonicalEquals", golden: "missing" }, verdict([], { canonical: "x" }), env)).toBe(false);
  });
});

suite("answers, time and combinators", () => {
  const answer: Observation = { kind: "answer", json: { ok: false, error: { code: "abi_mismatch" } } };

  it("answerPath follows a dotted path", () => {
    expect(passes({ op: "answerPath", path: "ok", equals: false }, answer)).toBe(true);
    expect(passes({ op: "answerPath", path: "error.code", equals: "abi_mismatch" }, answer)).toBe(true);
    expect(passes({ op: "answerPath", path: "error.code", equals: "invalid_request" }, answer)).toBe(false);
    expect(passes({ op: "answerPath", path: "error.nope.deeper", equals: 1 }, answer)).toBe(false);
    expect(passes({ op: "answerPath", path: "ok", equals: false }, verdict([]))).toBe(false);
  });

  it("elapsedMax needs a measurement", () => {
    expect(passes({ op: "elapsedMax", ms: 100 }, answer, { elapsedMs: 40 })).toBe(true);
    expect(passes({ op: "elapsedMax", ms: 100 }, answer, { elapsedMs: 400 })).toBe(false);
    expect(passes({ op: "elapsedMax", ms: 100 }, answer)).toBe(false);
  });

  it("all, any and not", () => {
    const yes: Expectation = { op: "accepted", value: true };
    const no: Expectation = { op: "accepted", value: false };
    expect(passes({ op: "all", of: [yes, { op: "codes", exactly: [] }] }, verdict([]))).toBe(true);
    expect(passes({ op: "all", of: [yes, no] }, verdict([]))).toBe(false);
    expect(passes({ op: "any", of: [no, yes] }, verdict([]))).toBe(true);
    expect(passes({ op: "any", of: [no, no] }, verdict([]))).toBe(false);
    expect(passes({ op: "not", of: no }, verdict([]))).toBe(true);
    expect(passes({ op: "not", of: yes }, verdict([]))).toBe(false);
  });

  it("custom predicates must be registered, and can warn", () => {
    const custom: CustomPredicate = { describe: () => "always warns", check: () => ({ pass: true, warn: true, reason: "careful" }) };
    expect(passes({ op: "custom", name: "missing" }, answer)).toBe(false);
    const result = evaluate({ op: "custom", name: "w" }, answer, { customs: { w: custom } });
    expect(result).toEqual({ pass: true, warn: true, reason: "careful" });
  });
});

suite("describe", () => {
  it("reads every operator in English, and a custom one by its own words", () => {
    expect(describe({ op: "codes", exactly: ["required@name"] })).toBe("errors exactly [required@name]");
    expect(describe({ op: "all", of: [{ op: "accepted", value: false }, { op: "refusal", anyOf: ["budget", "too_large"] }] })).toBe("rejected; refusal budget or too_large");
    expect(describe({ op: "not", of: { op: "accepted", value: true } })).toBe("not (accepted)");
    expect(describe({ op: "custom", name: "c" }, { c: { describe: () => "my words", check: () => ({ pass: true, reason: "" }) } })).toBe("my words");
    expect(describe({ op: "custom", name: "unregistered" })).toBe("custom unregistered");
  });
});
