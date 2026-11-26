import { CONTROL_VALUES } from "../fixtures/controls.js";
import { addComponents, compose, configure, flatValid, flatWithout, nestedArray, nestedObject, selectNode, textNode } from "../fixtures/inputs.js";
import type { Json } from "../observation.js";
import type { Expectation } from "../predicates.js";
import { accepted, all, any, RUNS, TESTS, vector } from "./helpers.js";
import type { DefinitionBuilder, Fixture, PluginSource, Variant, Vector, VectorInput } from "./schema.js";

/**
 * RES: resource budgets. A hostile submission, definition or plugin must end inside the budget
 * the host set (a hang or a crash is a FAIL), with a typed refusal or a verdict. Time bounds are
 * a multiple of the budget profile's nominal budget (250 ms for node and browser), plus the
 * runner's absolute ceiling.
 */
const QUICKJS_KERNEL_TESTS = "packages/quickjs-wasm-host/tests/quickjs-kernel-limits.test.ts";
const KERNEL_LIMIT_TESTS = TESTS.kernelLimits;
const everywhere = { program: RUNS, endpoint: RUNS, parity: RUNS } as const;
const both = { program: RUNS, endpoint: RUNS, parity: false } as const;

const MIB = 1024 * 1024;
const validRun = (): VectorInput => ({ kind: "values", values: CONTROL_VALUES["CTL-01"]() });
const run = (values: Json | Record<string, Json>, extra: Partial<Extract<VectorInput, { kind: "values" }>> = {}): VectorInput => ({ kind: "values", values, ...extra });

const pluginModule = (id: string, body: string): PluginSource => ({ id, version: "1.0.0", source: `({ validators: [ function (c) { ${body} } ] })` });
const budgetRefusal: Expectation = { op: "refusal", anyOf: ["budget"] };

/** A valid submission whose name is a trigger word the plugins below look for. */
const triggered = (word: string): VectorInput => run(flatValid({ name: word }));

/** `levels` components deep: form > g1 > ... > leaf (the root is level 1). */
const nest = (levels: number): DefinitionBuilder => () => {
  let inner: Record<string, unknown> = { id: "leaf", type: "text", configuration: { required: true } };
  for (let level = levels - 1; level >= 1; level -= 1) {
    inner = { id: `g${level}`, type: "group", configuration: {}, children: { content: [inner] } };
  }
  return { id: "form", type: "form", configuration: { formulaErrors: "fail" }, children: { content: [inner] } };
};

/** The fixture's `code` field with another pattern (to check that ordinary patterns are not refused as risky). */
const withCodePattern =
  (pattern: string): DefinitionBuilder =>
  (root) => {
    const code = ((root["children"] as { content: Record<string, unknown>[] }).content).find((node) => node["id"] === "code") as { configuration: Record<string, unknown> };
    code.configuration["pattern"] = pattern;
    return root;
  };

const tooDeep: Expectation = all(accepted(false), { op: "codes", includes: ["definition.tooDeep"] });

/** A form with `n` extra text fields (about 90 bytes each). */
const manyFields = (n: number, prefix = "f"): DefinitionBuilder =>
  addComponents(...Array.from({ length: n }, (_, at) => textNode(`${prefix}${at}`, { label: `Field number ${at}`, maxLength: 100 })));

const rowsOf = (n: number, row: Json): Json => ({ $gen: "rows", n, row } as unknown as Json);
const rowsValues = (n: number): Json => ({ $gen: "merge", of: [flatWithout(["rows[0].sku", "rows[0].n"]), { rows: rowsOf(n, { sku: "" }) }] } as unknown as Json);

export const RESOURCE_VECTORS: Vector[] = [
  vector({
    id: "RES-01",
    title: "A plugin that never returns is interrupted at the budget and the host stays usable",
    class: "resource",
    severity: "S2",
    attacker: "plugin-author",
    provenance: { tests: [{ path: TESTS.isolation, name: "interrupts runaway evaluation at the deadline" }] },
    fixture: { definition: "base", plugins: [pluginModule("res-01", "while (true) {}")] },
    input: validRun(),
    expect: { op: "refusal", anyOf: ["budget"], codes: ["interrupted"] },
    limits: { programBudgetMultiple: 3 }
  }),
  vector({
    id: "RES-02",
    title: "A formula text function over a very long answer (1 million characters, 30 rules) gives no result at once: a verdict in well under a second, not a run left to the deadline",
    class: "resource",
    severity: "S2",
    attacker: "filler",
    provenance: {
      tests: [{ path: "packages/quickjs-wasm-host/tests/quickjs-kernel-data-key-and-text-caps.test.ts", name: "a long answer through text functions" }, { path: "engine/tests/kernel-data-key-and-text-caps.test.ts" }]
    },
    fixture: {
      definition: "base+patch",
      patch: compose(
        configure({ formulaErrors: "warn" }),
        addComponents(textNode("longtext", {}), ...Array.from({ length: 30 }, (_, at) => textNode(`cut${at}`, {}, { value: "substring(longtext, 1, 5)" })))
      ),
      hostOptions: { maxEvalMs: 20000 }
    },
    input: run(flatValid({ longtext: { $gen: "text", length: 1_000_000, char: "\u{1F600}" } as unknown as Json })),
    // The sandbox refuses a whole-text function past 10,000 characters (undefined plus a warning): a verdict in about 300 ms, where
    // each rule once ran a native Array.from over the text (5.5 s for the same run, measured when the cap is switched off).
    expect: accepted(true),
    variants: [
      {
        id: "3.5-million-characters-ends-typed",
        input: run(flatValid({ longtext: { $gen: "text", length: 3_500_000, char: "\u{1F600}" } as unknown as Json })),
        expect: { op: "custom", name: "typed-outcome" }
      }
    ],
    limits: { programMs: 3000 }
  }),
  vector({
    id: "RES-03",
    title: "An allocation bomb stops at the memory limit and the sandbox answers the next run",
    class: "resource",
    severity: "S2",
    attacker: "plugin-author",
    provenance: { tests: [{ path: TESTS.isolation, name: "stops an allocation bomb at the memory limit" }] },
    fixture: {
      definition: "base",
      plugins: [pluginModule("res-03", "if (c.values && c.values.name === 'BOMB') { var hog = []; for (var i = 0; i < 1e9; i += 1) { hog.push({ a: i, b: [i] }); } } return { errors: [] };")],
      hostOptions: { memoryLimitBytes: 4 * MIB, maxEvalMs: 3000 }
    },
    input: triggered("BOMB"),
    expect: any({ op: "refusal", anyOf: ["budget"] }, all(accepted(false), { op: "codes", includes: ["validator.failed"] })),
    variants: [
      {
        id: "the-next-run-is-judged",
        input: { kind: "series", steps: [triggered("BOMB"), validRun()] },
        expect: all(accepted(true), { op: "golden", key: "CTL-01" })
      }
    ],
    limits: { programMs: 4000 }
  }),
  vector({
    id: "RES-04",
    title: "A module heap grown past the recycle threshold is replaced by a fresh module, and the same host answers the next run",
    class: "resource",
    severity: "S2",
    attacker: "plugin-author",
    provenance: { tests: [{ path: "packages/quickjs-wasm-host/tests/heap-recycle.test.ts" }] },
    fixture: {
      definition: "base",
      plugins: [pluginModule("res-04", "if (c.values && c.values.name === 'HOG') { var a = []; for (var i = 0; i < 40; i++) { a.push('x'.repeat(3e6) + i); } } return { errors: [] };")],
      hostOptions: { memoryLimitBytes: 4 * MIB, maxEvalMs: 30000, recycleHeapBytes: 64 * MIB }
    },
    input: { kind: "series", steps: [triggered("HOG"), validRun()] },
    expect: all(accepted(true), { op: "custom", name: "module-recycled" }),
    limits: { programMs: 60000 }
  }),
  vector({
    id: "RES-05",
    title: "A request longer than the host's limit is refused before the program is entered",
    class: "resource",
    severity: "S3",
    attacker: "filler",
    provenance: { tests: [{ path: "packages/quickjs-wasm-host/tests/program-host.test.ts", name: "the request bound" }] },
    fixture: { definition: "base", hostOptions: { memoryLimitBytes: 32 * MIB } },
    input: { kind: "raw", route: "validate", body: { $gen: "text", length: 32 * MIB + 1 } },
    expect: { op: "refusal", anyOf: ["too_large"], codes: ["request_refused"] },
    // The endpoint half (a body one byte over the operator's limit) is REC-03.
    limits: { programMs: 5000 }
  }),
  vector({
    id: "RES-06",
    title: "A request nested past 320 levels is refused before the program is entered",
    class: "resource",
    severity: "S3",
    attacker: "filler",
    provenance: { tests: [{ path: "packages/quickjs-wasm-host/tests/program-host.test.ts", name: "refuses a request nested past maxRequestDepth" }] },
    input: run(flatValid({ name: nestedArray(400) })),
    expect: { op: "refusal", anyOf: ["too_deep"], codes: ["request_refused"] },
    variants: [{ id: "within-the-bound", input: run(flatValid({ deep: nestedArray(200) })), expect: all(accepted(true), { op: "codes", exactly: [] }) }],
    // The endpoint half (values nested past the host's depth) is REC-04.
    limits: { programMs: 5000 }
  }),
  vector({
    id: "RES-07",
    title: "A definition nested past 32 component levels is refused with a typed error, never a trap",
    class: "resource",
    severity: "S3",
    attacker: "author",
    provenance: { tests: [{ path: KERNEL_LIMIT_TESTS, name: "components nested past 32 levels" }, { path: QUICKJS_KERNEL_TESTS, name: "40 and 100 levels of components are refused" }] },
    fixture: { definition: nest(40) },
    input: run({ leaf: "x" }),
    expect: tooDeep,
    // The endpoint halves are not rows of their own: a builder save of such a form is a 422 (the DEF-05 and DEF-06 rows,
    // the save's own refusal), while a form that is already registered and too deep gave no verdict, so a check, a
    // delivery and a dry run answer it 503 definition.tooDeep with no Retry-After (never a 422 verdict). The suite
    // cannot register one, so wire.ts only types that 503 (definition_too_deep) and keeps it clear of SEC-05.
    variants: [
      { id: "100-levels", fixture: { definition: nest(100) }, programOnly: true },
      { id: "31-levels-run", fixture: { definition: nest(31) }, input: run({}), expect: all(accepted(false), { op: "codes", exactly: ["required@leaf"] }), programOnly: true }
    ],
    limits: { programMs: 5000 }
  }),
  vector({
    id: "RES-08",
    title: "Legitimate big input still passes: values 60 levels deep, and a 4000-field form (about 400 KB) cold at the default budget",
    class: "resource",
    severity: "S3",
    attacker: "filler",
    provenance: { tests: [{ path: "packages/quickjs-wasm-host/tests/quickjs-wasm-adapter.test.ts", name: "scales the default with the reads" }] },
    input: run(flatValid({ deep: nestedObject(60, 1) })),
    expect: all(accepted(true), { op: "codes", exactly: [] }),
    variants: [
      // A fixed 3 s budget: the scaled default leaves a 400 KB form well under a second, too tight to assert on a loaded CI machine.
      { id: "4000-field-form", fixture: { definition: "base+patch", patch: manyFields(4000), hostOptions: { maxEvalMs: 3000 } }, input: validRun(), programOnly: true }
    ],
    applies: both,
    limits: { programBudgetMultiple: 20 }
  }),
  vector({
    id: "RES-09",
    title: "A plugin that logs 300 one-megabyte lines gets a bounded, parseable outcome: each log message is cut at 8 KiB",
    class: "resource",
    severity: "S3",
    attacker: "plugin-author",
    provenance: { tests: [{ path: QUICKJS_KERNEL_TESTS, name: "a plugin's megabyte log lines do not make the outcome unreadable" }, { path: KERNEL_LIMIT_TESTS, name: "each run-log entry is capped" }] },
    fixture: {
      definition: "base",
      plugins: [pluginModule("res-09", "var big = 'x'.repeat(1 << 20); for (var i = 0; i < 300; i++) { c.log.error(big); } return { errors: [] };")],
      hostOptions: { maxEvalMs: 5000 }
    },
    input: validRun(),
    expect: all(accepted(true), { op: "logsSome", pattern: "^x+" }, { op: "logsMaxMessage", max: 8192 + 30 }),
    limits: { programMs: 10000 }
  }),
  vector({
    id: "RES-10",
    title: "400 distinct 200-field definitions on one sandbox all run (the prepared-definition cache is bounded, not broken)",
    class: "resource",
    severity: "S4",
    attacker: "author",
    provenance: { tests: [{ path: "packages/quickjs-wasm-host/tests/quickjs-prepared-cache.test.ts" }] },
    input: {
      kind: "series",
      steps: Array.from({ length: 400 }, (_, at): VectorInput => ({ kind: "values", values: CONTROL_VALUES["CTL-01"](), formPatch: manyFields(200, `d${at}_`) }))
    },
    expect: all(accepted(true), { op: "codes", exactly: [] }),
    limits: { programMs: 120000 },
    applies: { program: { heavy: true }, endpoint: false, parity: false }
  }),
  vector({
    id: "RES-11",
    title: "A catastrophic field pattern ((a|a?)+ over 40 a and a bang) is refused as risky, not run to the interrupt",
    class: "resource",
    severity: "S3",
    attacker: "author",
    provenance: { tests: [{ path: QUICKJS_KERNEL_TESTS, name: "a catastrophic field pattern is refused as risky" }, { path: KERNEL_LIMIT_TESTS, name: "held to the risky-pattern check" }] },
    input: run(flatValid({ risky: `${"a".repeat(40)}!` })),
    expect: all(accepted(false), { op: "codes", exactly: ["pattern@risky"] }, { op: "rawAt", path: "errors.0.parameters.risky", equals: true }),
    variants: [
      ...[
        ["legit-hostname-pattern-is-not-risky", "^([a-z0-9-]+\\.){1,10}[a-z]{2,}$", "example.com"],
        ["legit-words-pattern-is-not-risky", "^(\\w+ ){0,9}\\w+$", "one two three"],
        ["legit-alternation-is-not-risky", "^(a|b)+$", "abab"]
      ].map(([id, pattern, answer]): Variant => ({
        id: id as string,
        fixture: { definition: "base+patch", patch: withCodePattern(pattern as string) },
        input: run(flatValid({ code: answer as string })),
        expect: all(accepted(true), { op: "codes", exactly: [] }),
        programOnly: true
      }))
    ],
    applies: everywhere,
    limits: { programBudgetMultiple: 3, endpointMs: 10000 }
  }),
  vector({
    id: "RES-12",
    title: "A composed catastrophic pattern (matches(t, concat(\"^(a+)\", \"+$\"))) is refused at the call; the host policy can allow it",
    class: "resource",
    severity: "S3",
    attacker: "author",
    provenance: { tests: [{ path: QUICKJS_KERNEL_TESTS, name: "a composed catastrophic pattern is refused at the call" }, { path: KERNEL_LIMIT_TESTS, name: "a pattern built at run time" }] },
    fixture: {
      definition: "base+patch",
      patch: addComponents(textNode("t"), textNode("x", {}, { requiredWhen: 'matches(t, concat("^(a+)", "+$"))' }))
    },
    input: run(flatValid({ t: `${"a".repeat(40)}!` }), { logLevel: "warn" }),
    expect: { op: "logsSome", pattern: "matches: the pattern repeats a repeat" },
    variants: [
      {
        id: "host-allows-risky-patterns",
        fixture: { definition: "base+patch", patch: addComponents(textNode("t"), textNode("x", {}, { requiredWhen: 'matches(t, concat("^(a+)", "+$"))' })), policy: { riskyPatterns: "allow" } },
        input: run(flatValid({ t: "aaa" }), { logLevel: "warn" }),
        expect: { op: "not", of: { op: "logsSome", pattern: "repeats a repeat" } },
        programOnly: true
      }
    ],
    limits: { programBudgetMultiple: 3 }
  }),
  vector({
    id: "RES-13",
    title: "A regex the risky check cannot see ((a|aa)+$ over 5000 a) still ends within the budget with a typed result",
    class: "resource",
    severity: "S3",
    attacker: "author",
    provenance: { tests: [{ path: QUICKJS_KERNEL_TESTS, name: "a catastrophic field pattern is refused as risky" }] },
    fixture: {
      definition: "base+patch",
      patch: addComponents(textNode("t"), textNode("x", {}, { requiredWhen: 'matches(t, "(a|aa)+$")' }))
    },
    input: run(flatValid({ t: `${"a".repeat(5000)}!` }), { logLevel: "warn" }),
    expect: { op: "custom", name: "typed-outcome" },
    limits: { programBudgetMultiple: 4 }
  }),
  vector({
    id: "RES-14",
    title: "A replace that would pass the 10,000-character cap is refused before it is built, with the cap's own warning",
    class: "resource",
    severity: "S4",
    attacker: "author",
    provenance: { tests: [{ path: QUICKJS_KERNEL_TESTS, name: "a replace that would pass the cap is refused before it is built" }, { path: KERNEL_LIMIT_TESTS, name: "replace checks its result before building it" }] },
    fixture: {
      definition: "base+patch",
      patch: compose(configure({ formulaErrors: "warn" }), addComponents(textNode("t"), textNode("x", {}, { validWhen: 'len(replace(t, "a", padStart("", 10000, "x"))) > 0' })))
    },
    input: run(flatValid({ t: "a".repeat(10000), x: "v" }), { logLevel: "warn" }),
    expect: all({ op: "logsSome", pattern: "replace: the text is over the 10,000 character cap" }, { op: "not", of: { op: "logsSome", pattern: "out of memory" } }),
    limits: { programBudgetMultiple: 8 }
  }),
  vector({
    id: "RES-15",
    title: "A 30-link append(prev, prev) chain and a 30-link concat(prev, prev) chain settle with the cap's warning instead of exhausting memory",
    class: "resource",
    severity: "S2",
    attacker: "author",
    provenance: { tests: [{ path: QUICKJS_KERNEL_TESTS, name: "a shared-structure list chain settles with a warning" }, { path: KERNEL_LIMIT_TESTS, name: "a chain of lists that share structure is bounded" }] },
    fixture: chainFixture((i) => (i === 0 ? 'split("a,b", ",")' : `append(l${i - 1}, l${i - 1})`)),
    input: run(flatValid(), { logLevel: "warn" }),
    expect: { op: "logsSome", pattern: "append: the result is over the 10000 item cap" },
    variants: [
      {
        id: "concat-chain",
        fixture: chainFixture((i) => (i === 0 ? '"ab"' : `concat(l${i - 1}, l${i - 1})`)),
        expect: { op: "logsSome", pattern: "concat: the text is over the 10,000 character cap" },
        programOnly: true
      }
    ],
    limits: { programMs: 40000 }
  }),
  vector({
    id: "RES-16",
    title: "20,000 blank required rows are judged in linear time (under 2.5 s); the error list is cut at 10,000 and ends with one blocking errors.truncated marker",
    class: "resource",
    severity: "S3",
    attacker: "filler",
    provenance: { tests: [{ path: QUICKJS_KERNEL_TESTS, name: "20,000 rows are judged in linear time" }, { path: KERNEL_LIMIT_TESTS, name: "the kernel's dictionaries are records of their own" }] },
    fixture: { definition: "base", hostOptions: { maxEvalMs: 60000, memoryLimitBytes: 512 * MIB } },
    input: run(rowsValues(20000)),
    expect: all(
      accepted(false),
      { op: "codes", includes: ["required", "errors.truncated"] },
      { op: "rawAt", path: "errors.9999.code", equals: "required" },
      { op: "rawAt", path: "errors.10000.code", equals: "errors.truncated" },
      { op: "rawAt", path: "errors.10001", absent: true },
      { op: "rawAt", path: "errors.10000.parameters.shown", equals: 10000 }
    ),
    applies: { program: { heavy: true }, endpoint: { heavy: true, note: "the endpoint runner sends the same rows and allows 10 s", expect: all(accepted(false), { op: "codes", includes: ["required", "errors.truncated"] }) }, parity: false },
    limits: { programMs: 2500, endpointMs: 10000 }
  }),
  vector({
    id: "RES-17",
    title: "More than 65,535 errors (70,000 blank rows) come back as a verdict capped at 10,000 errors plus the errors.truncated marker, not a RangeError",
    class: "resource",
    severity: "S3",
    attacker: "filler",
    provenance: { tests: [{ path: QUICKJS_KERNEL_TESTS, name: "more than 65,535 errors come back" }, { path: KERNEL_LIMIT_TESTS, name: "a run with more than 65,535 errors" }] },
    fixture: { definition: "base", hostOptions: { maxEvalMs: 120000, memoryLimitBytes: 768 * MIB } },
    input: run(rowsValues(70000)),
    expect: any(
      all(accepted(false), { op: "rawAt", path: "errors.10000.code", equals: "errors.truncated" }, { op: "rawAt", path: "errors.10000.parameters.shown", equals: 10000 }),
      { op: "refusal", anyOf: ["budget", "too_large"] }
    ),
    applies: { program: { heavy: true }, endpoint: { heavy: true, note: "the endpoint runner sends the same rows", expect: any(all(accepted(false), { op: "codes", includes: ["errors.truncated"] }), { op: "refusal", anyOf: ["budget", "too_large"] }) }, parity: false },
    limits: { programMs: 120000, endpointMs: 60000 }
  }),
  vector({
    id: "RES-18",
    title: "Host data that is too big or too deep (a million nodes, 65 levels) is refused with the path and the limit; a 200,000-item snapshot ends typed",
    class: "resource",
    severity: "S3",
    attacker: "source-operator",
    provenance: { tests: [{ path: "engine/tests/wasm-validation-host.test.ts" }] },
    input: run(flatValid(), { externalData: { items: { $gen: "rows", n: 1_000_001, row: 0 } } as unknown as Json }),
    expect: all({ op: "refusal", anyOf: ["too_large"], codes: ["serialize"] }, { op: "custom", name: "refusal-names-limit" }),
    variants: [
      {
        id: "65-levels-deep",
        input: run(flatValid(), { externalData: { chain: nestedArray(66) } }),
        expect: { op: "refusal", anyOf: ["too_deep"], codes: ["serialize"] }
      },
      {
        id: "200k-item-snapshot",
        fixture: snapshotFixture(),
        input: run(flatValid({ town: "ZZ" })),
        expect: { op: "custom", name: "typed-outcome" },
        programOnly: true
      }
    ],
    limits: { programMs: 20000 }
  }),
  vector({
    id: "RES-19",
    title: "Native-heavy loops (150 splits of a 1 MB string) are stopped by the worker host's own clock and the next run is judged on a fresh worker",
    class: "resource",
    severity: "S2",
    attacker: "plugin-author",
    provenance: {
      tests: [{ path: "packages/quickjs-wasm-host/tests/worker-host.test.ts", name: "kills a runaway native call near its budget" }]
    },
    // The synchronous adapter's interrupt handler is polled between VM operations, so a native call that runs long is not stopped
    // (the plugin below takes 9 s there). The Node worker host terminates the thread past the budget plus its slack.
    fixture: {
      definition: "base",
      host: "worker",
      plugins: [pluginModule("res-19", "if (c.values && c.values.name === 'SPLITBOMB') { var s = 'x'.repeat(1e6); var n = 0; for (var i = 0; i < 150; i++) { n += s.split('').length; } } return { errors: [] };")]
    },
    input: triggered("SPLITBOMB"),
    expect: budgetRefusal,
    variants: [
      {
        id: "the-next-run-is-judged",
        input: { kind: "series", steps: [triggered("SPLITBOMB"), validRun()] },
        expect: all(accepted(true), { op: "golden", key: "CTL-01" })
      }
    ],
    limits: { programMs: 12000 },
    applies: { program: RUNS, endpoint: false, parity: false }
  }),
  vector({
    id: "RES-20",
    title: "A run whose outcome passes 8 MiB is refused (outcome_too_large) and the host answers the next run",
    class: "resource",
    severity: "S2",
    attacker: "plugin-author",
    provenance: {
      tests: [{ path: "packages/quickjs-wasm-host/tests/quickjs-wasm-adapter.test.ts", name: "refuses a run whose outcome passes 8 MiB (outcome_too_large), and the host answers the next run" }]
    },
    fixture: {
      definition: "base",
      plugins: [
        pluginModule(
          "res-20",
          "var big = 'x'.repeat(8 << 20); return { errors: c.values && c.values.name === 'HUGEOUT' ? [0, 1].map(function () { return { code: 'c', stage: 'plugin', source: 'custom', severity: 'error', message: big }; }) : [] };"
        )
      ],
      hostOptions: { maxEvalMs: 8000 }
    },
    input: triggered("HUGEOUT"),
    expect: { op: "refusal", anyOf: ["too_large"], codes: ["outcome_too_large"] },
    variants: [
      {
        id: "the-next-run-is-judged",
        input: { kind: "series", steps: [triggered("HUGEOUT"), validRun()] },
        expect: all(accepted(true), { op: "golden", key: "CTL-01" })
      }
    ],
    limits: { programMs: 15000 }
  })
];

function snapshotFixture(): Fixture {
  return {
    definition: "base+patch",
    patch: addComponents(selectNode("town", [], { data: { sourceId: "towns" } })),
    snapshot: { towns: { $gen: "rows", n: 200_000, row: { value: "v", label: "Value" } } as unknown as Record<string, unknown> }
  };
}

/** Thirty fields whose `value` rules chain on the one before (resolved one a pass, last link first). */
function chainFixture(formula: (index: number) => string): Fixture {
  const links = Array.from({ length: 30 }, (_, k) => 29 - k).map((i) => textNode(`l${i}`, {}, { value: formula(i) }));
  return {
    definition: "base+patch",
    patch: compose(configure({ formulaErrors: "warn" }), addComponents(...links)),
    hostOptions: { maxEvalMs: 20000 }
  };
}

