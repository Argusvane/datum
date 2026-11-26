import { addComponents, compose, configure, flatValid, secretRule, textNode } from "../fixtures/inputs.js";
import type { Json } from "../observation.js";
import { accepted, all, RUNS, vector } from "./helpers.js";
import type { Expectation } from "../predicates.js";
import type { Fixture, PluginSource, Variant, Vector, VectorInput } from "./schema.js";

/**
 * SEC: secrecy. A rule marked `server-secret` is the author's private check: its text, the names
 * of the functions it calls and what a plugin threw inside it must never reach an answer the
 * filler (or the public definition) can read.
 */
const QUICKJS_KERNEL_TESTS = "packages/quickjs-wasm-host/tests/quickjs-kernel-limits.test.ts";
const KERNEL_LIMIT_TESTS = "engine/tests/kernel-limits-and-secrecy.test.ts";
const MARKER = "ZZSECRETZZ";

const run = (values: Record<string, Json>, logLevel?: string): VectorInput => ({ kind: "values", values, ...(logLevel !== undefined ? { logLevel } : {}) });

const boomPlugin: PluginSource = { id: "boomer", version: "1", source: `({ functions: { boom: (a) => { throw new Error("msg " + a[0]); } } })` };

/** `t` and a secret-ruled `x`, as the cases below build them. */
const secretFixture = (formula: string, formulaErrors: "fail" | "warn", plugins: PluginSource[] = []): Fixture => ({
  definition: "base+patch",
  patch: compose(configure({ formulaErrors }), addComponents(textNode("t"), textNode("x", {}, { requiredWhen: secretRule(formula) }))),
  ...(plugins.length > 0 ? { plugins } : {})
});

const leakCase = (id: string, formula: string, formulaErrors: "fail" | "warn", plugins: PluginSource[] = []): Variant => ({
  id,
  fixture: secretFixture(formula, formulaErrors, plugins),
  input: run(flatValid({ t: "hello", x: "v" }), "debug"),
  expect: all({ op: "textExcludes", markers: [MARKER] }, { op: "textIncludes", markers: ["rules:x:requiredWhen"] }),
  programOnly: true
});

/** A form whose component `x` carries four secret rules, each naming the marker in its text or its function names. */
const secretRules = (): Record<string, unknown> => ({
  requiredWhen: secretRule(`matches(t, "^(a+)+$${MARKER}")`),
  visibleWhen: secretRule(`${MARKER}(t) = 1`),
  validWhen: secretRule(`boom("${MARKER}") = 1`),
  value: secretRule(`concat(t, "${MARKER}"`)
});
const secretDefinition = (extra: Record<string, unknown> = {}, slot?: Record<string, unknown>): Json =>
  ({
    id: "secret-suite",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "t", type: "text", configuration: {} }, { id: "x", type: "text", configuration: {}, rules: secretRules() }], ...(slot ?? {}) }
    },
    ...extra
  }) as unknown as Json;

const inspect = (op: string, definition: Json): VectorInput => ({ kind: "inspect", request: { abi: "$detected", op, definition } });
const quiet: Expectation = { op: "textExcludes", markers: [MARKER, "server-secret"] };

export const SECRECY_VECTORS: Vector[] = [
  vector({
    id: "SEC-01",
    title: "A server-secret rule's text, a function name it calls and what a plugin threw stay out of the errors and logs, but the rule still runs",
    class: "secrecy",
    severity: "S3",
    attacker: "author",
    provenance: { tests: [{ path: QUICKJS_KERNEL_TESTS, name: "a server-secret rule's text, function name and thrown message stay out of the outcome" }, { path: KERNEL_LIMIT_TESTS, name: "a server-secret rule's text stays out of the outcome" }] },
    input: run(flatValid({ name: MARKER }), "debug"),
    expect: all(accepted(false), { op: "codes", includes: ["required@secret"] }, { op: "textExcludes", markers: ["server-secret", 'name = "'] }),
    variants: [
      leakCase("risky-literal", `matches(t, "^(a+)+$${MARKER}")`, "fail"),
      leakCase("unknown-function", `${MARKER}(t) = 1`, "fail"),
      leakCase("throwing-plugin-fail", `boom("${MARKER}") = 1`, "fail", [boomPlugin]),
      leakCase("throwing-plugin-warn", `boom("${MARKER}") = 1`, "warn", [boomPlugin])
    ],
    applies: { program: RUNS, endpoint: RUNS, parity: false }
  }),
  vector({
    id: "SEC-02",
    title: "The public definition holds no server-secret rule",
    class: "secrecy",
    severity: "S3",
    attacker: "author",
    provenance: { tests: [{ path: "engine/tests/inspect.test.ts", name: "inspect: public" }] },
    input: inspect("public", secretDefinition()),
    expect: all({ op: "answerPath", path: "ok", equals: true }, quiet)
  }),
  vector({
    id: "SEC-03",
    title: "The check answer over secret rules names where and which code, never the rule's text",
    class: "secrecy",
    severity: "S3",
    attacker: "author",
    provenance: { tests: [{ path: "engine/tests/inspect.test.ts", name: "inspect: check" }] },
    input: inspect("check", secretDefinition()),
    expect: all({ op: "answerPath", path: "ok", equals: true }, { op: "textExcludes", markers: [MARKER] }, { op: "textIncludes", markers: ["The details of this problem are withheld.", "rules:x:requiredWhen"] })
  }),
  vector({
    id: "SEC-04",
    title: "The inspect answer over a secret rule redacts what it reads and the functions it calls",
    class: "secrecy",
    severity: "S4",
    attacker: "author",
    provenance: { tests: [] },
    gate: { status: "advisory" },
    input: inspect("inspect", secretDefinition()),
    expect: all({ op: "answerPath", path: "ok", equals: true }, { op: "textExcludes", markers: [MARKER] })
  }),
  vector({
    id: "SEC-06",
    title: "A server-secret rule written where no server scope is allowed (journey route or PDF when, a children slot that is not a list) is not echoed in the public definition or the check answer",
    class: "secrecy",
    severity: "S4",
    attacker: "author",
    provenance: { tests: [{ path: "engine/tests/inspect.test.ts", name: "inspect: public" }] },
    gate: { status: "enforced" },
    input: inspect("public", secretDefinition({ journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["t"], routes: [{ to: "$end", when: secretRule(`t = "${MARKER}"`) }] }] }] } })),
    expect: all({ op: "answerPath", path: "ok", equals: true }, quiet),
    variants: [
      { id: "pdf-layout-when", input: inspect("public", secretDefinition({ pdf: { layouts: [{ id: "l", when: secretRule(`t = "${MARKER}"`) }] } })) },
      { id: "children-slot-is-not-a-list", input: inspect("public", secretDefinition({}, { weird: { id: "w", type: "text", configuration: {}, rules: { requiredWhen: secretRule(`t = "${MARKER}"`) } } })) },
      { id: "check-answer-for-a-journey-when", input: inspect("check", secretDefinition({ journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["t"], routes: [{ to: "$end", when: secretRule(`t = "${MARKER}"`) }] }] }] } })), expect: all({ op: "answerPath", path: "ok", equals: true }, { op: "textExcludes", markers: [MARKER] }) }
    ]
  })
];
