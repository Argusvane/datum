import { BASE_DEFINITION } from "../fixtures/base-form.js";
import { addComponents } from "../fixtures/inputs.js";
import type { Json } from "../observation.js";
import type { Expectation } from "../predicates.js";
import { all, vector } from "./helpers.js";
import type { Applic, Fixture, Variant, Vector, VectorInput } from "./schema.js";

/**
 * TST: the `test` op of `__datum_inspect`. A host asks
 * the program to run a form's scenarios on the kernel's own reading of a submission and gets a
 * report back; the program runs the author's text, so what a hostile or merely large test file
 * can make it do is a promise the program keeps: the report has the same shape on every host, a
 * request over a cap is refused as `invalid_request` before anything runs (never thrown, never
 * truncated), and the ABI check comes first.
 *
 * Program mode only: an endpoint has no such route.
 *
 * The caps are `kernelFormTestOpMaxBytes` (256 KiB of test text), `kernelFormTestOpMaxScenarios`
 * (200) and `kernelFormTestOpMaxSteps` (1,000 statements in one scenario) in the kernel; the
 * inputs that cross them are built when the run needs them (`{ "$gen": "repeat" }`), never held
 * in the catalogue.
 */
const PROGRAM_ONLY: Applic = {};
const provenance = {
  tests: [{ path: "engine/tests/form-tests/kernel-test-op.test.ts" }, { path: "packages/quickjs-wasm-host/tests/sandbox-test-op.test.ts" }]
};

const answerIs = (path: string, equals: Json): Expectation => ({ op: "answerPath", path, equals });
const ok = answerIs("ok", true);
const summary = (counts: { total: number; passed: number; failed: number; skipped: number; error: number }): Expectation =>
  all(...(Object.entries(counts) as [string, number][]).map(([key, value]) => answerIs(`report.summary.${key}`, value)));
const refused = (code: string, where?: string, limit?: number): Expectation =>
  all(answerIs("ok", false), answerIs("error.code", code), ...(where !== undefined ? [answerIs("error.where", where)] : []), ...(limit !== undefined ? [answerIs("error.limit", limit)] : []));

/** The fixture form accepts this answer (a name, a city, a code of two letters and four digits). */
const VALID = '  given journey = none\n  set name = "Ada"\n  set addr.city = "Ottawa"\n  set code = "AB1234"\n  submit\n';

/** One scenario that passes and one that fails (its `expect accepted` meets a refused code), lines 1 to 7 and 9 to 15. */
const SIDECAR = `test "a valid answer is accepted"\n${VALID}  expect accepted\n\ntest "a code that does not fit its pattern is accepted"\n${VALID.replace("AB1234", "nope")}  expect accepted\n`;

/** `{abi, op: "test", definition, tests?}` as JSON text, the definition spliced in as text. */
const testRequest = (tests?: string): VectorInput => ({
  kind: "inspect",
  request: null,
  requestText: `{"abi":"$detected","op":"test","definition":$definition${tests !== undefined ? `,"tests":${JSON.stringify(tests)}` : ""}}`
});

/** A request as an object, so a `$gen` can stand in `tests` (the definition is the fixture form's). */
const generated = (tests: unknown, abi: string = "$detected"): VectorInput => ({ kind: "inspect", request: { abi, op: "test", definition: BASE_DEFINITION, tests } });

/** The fixture form with a `tests` block of its own: entries `{ id, source }`. */
const withEntries = (entries: { id: string; source: string }[]): NonNullable<Fixture["definitionText"]> => (base) => JSON.stringify({ ...base, tests: { scenarios: entries } });

const variant = (id: string, input: VectorInput, expect: Expectation, fixture?: Partial<Fixture>): Variant => ({ id, input, expect, ...(fixture !== undefined ? { fixture } : {}) });

const test = (options: Pick<Vector, "id" | "title" | "severity" | "input" | "expect"> & Partial<Pick<Vector, "attacker" | "variants" | "fixture" | "applies">>): Vector =>
  vector({
    class: "test",
    attacker: "author",
    provenance,
    applies: { program: PROGRAM_ONLY, endpoint: false, parity: false },
    ...options
  });

export const TEST_VECTORS: Vector[] = [
  test({
    id: "TST-01",
    title: "A sidecar of two scenarios is run and reported in order: one passed, one failed with the verdict it met, the summary counting both",
    severity: "S3",
    input: testRequest(SIDECAR),
    expect: all(
      ok,
      answerIs("op", "test"),
      answerIs("report.problems", []),
      summary({ total: 2, passed: 1, failed: 1, skipped: 0, error: 0 }),
      answerIs("report.scenarios.0.name", "a valid answer is accepted"),
      answerIs("report.scenarios.0.line", 1),
      answerIs("report.scenarios.0.status", "passed"),
      answerIs("report.scenarios.1.name", "a code that does not fit its pattern is accepted"),
      answerIs("report.scenarios.1.line", 9),
      answerIs("report.scenarios.1.status", "failed"),
      answerIs("report.scenarios.1.steps.4.line", 15),
      answerIs("report.scenarios.1.steps.4.status", "failed"),
      answerIs("report.scenarios.1.steps.4.code", "expect.verdict"),
      answerIs("report.scenarios.1.steps.4.expected", "accepted"),
      answerIs("report.scenarios.1.steps.4.actual", "refused")
    ),
    variants: [
      variant("empty-sidecar", testRequest(""), all(ok, answerIs("report.problems", []), summary({ total: 0, passed: 0, failed: 0, skipped: 0, error: 0 }))),
      variant(
        "parse-problem-is-listed",
        testRequest('test "a"\n  set name = "Ada"\n  flurb\n  expect name visible\n'),
        all(ok, answerIs("report.problems.0.code", "unknownStatement"), answerIs("report.problems.0.line", 3), summary({ total: 0, passed: 0, failed: 0, skipped: 0, error: 0 }))
      ),
      // A list set on a field that holds one value is refused as the browser's write refuses it.
      variant(
        "list-set-on-a-text-field-is-refused",
        testRequest('test "a"\n  given journey = none\n  set name = ("Ada", "Grace")\n  submit\n'),
        all(
          ok,
          answerIs("report.scenarios.0.status", "error"),
          answerIs("report.scenarios.0.steps.0.code", "action.refused"),
          answerIs("report.scenarios.0.steps.0.params.action", "set"),
          answerIs("report.scenarios.0.steps.0.params.reason", "value.notScalar"),
          answerIs("report.scenarios.0.steps.0.params.path", "name")
        )
      ),
      // So is a list in a cell of a row an `add row` makes, before the row is made, naming the cell.
      variant(
        "list-in-an-added-row-cell-is-refused",
        testRequest('test "a"\n  given journey = none\n  add row to lines with item = ("a", "b")\n  submit\n'),
        all(
          ok,
          answerIs("report.scenarios.0.status", "error"),
          answerIs("report.scenarios.0.steps.0.code", "action.refused"),
          answerIs("report.scenarios.0.steps.0.params.action", "addRow"),
          answerIs("report.scenarios.0.steps.0.params.reason", "value.notScalar"),
          answerIs("report.scenarios.0.steps.0.params.path", "lines[0].item")
        ),
        {
          definition: "base",
          definitionText: (base) =>
            JSON.stringify({
              ...base,
              root: addComponents({
                id: "orders",
                type: "dataGrid",
                configuration: { initialRows: 0 },
                collection: { collectionPath: "lines" },
                children: { content: [{ id: "item", type: "text", configuration: {} }] }
              })(structuredClone(base["root"]) as Record<string, unknown>)
            })
        }
      ),
      // A list in a checkbox group cell is stored as the group's record, as a `set` of the cell stores it: the row is accepted.
      variant(
        "list-in-an-added-checkbox-cell-is-stored-as-the-group",
        testRequest(`test "a"\n${VALID.replace("  submit\n", "")}  add row to lines with tags = ("a")\n  submit\n  expect accepted\n`),
        all(ok, answerIs("report.scenarios.0.status", "passed"), answerIs("report.scenarios.0.steps.3.status", "ran"), answerIs("report.scenarios.0.steps.5.status", "passed")),
        {
          definition: "base",
          definitionText: (base) =>
            JSON.stringify({
              ...base,
              root: addComponents({
                id: "orders",
                type: "dataGrid",
                configuration: { initialRows: 0 },
                collection: { collectionPath: "lines" },
                children: {
                  content: [{ id: "tags", type: "checkboxes", configuration: { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } }]
                }
              })(structuredClone(base["root"]) as Record<string, unknown>)
            })
        }
      ),
      variant(
        "scenario-that-cannot-start-is-an-error",
        testRequest('test "a"\n  given journey = nothere\n  expect name visible\n'),
        all(ok, answerIs("report.scenarios.0.status", "error"), answerIs("report.scenarios.0.reason", "scenario.unknownJourney"), summary({ total: 1, passed: 0, failed: 0, skipped: 0, error: 1 }))
      )
    ]
  }),
  test({
    id: "TST-02",
    title: "Without a sidecar the definition's own tests run, one entry each and reported under its id; a sidecar replaces them",
    severity: "S3",
    fixture: {
      definition: "base",
      definitionText: withEntries([
        { id: "accepts", source: `test "accepts"\n${VALID}  expect accepted\n` },
        { id: "wrongly-hidden", source: 'test "name is hidden"\n  expect name hidden\n' }
      ])
    },
    input: { kind: "inspect", request: null, requestText: '{"abi":"$detected","op":"test","definition":$definition}' },
    expect: all(
      ok,
      answerIs("report.scenarios.0.id", "accepts"),
      answerIs("report.scenarios.0.status", "passed"),
      answerIs("report.scenarios.1.id", "wrongly-hidden"),
      answerIs("report.scenarios.1.status", "failed"),
      answerIs("report.scenarios.1.steps.0.code", "expect.hidden"),
      summary({ total: 2, passed: 1, failed: 1, skipped: 0, error: 0 })
    ),
    variants: [
      variant(
        "sidecar-replaces-entries",
        { kind: "inspect", request: null, requestText: `{"abi":"$detected","op":"test","definition":$definition,"tests":${JSON.stringify('test "only"\n  expect name visible\n')}}` },
        all(ok, answerIs("report.scenarios.0.name", "only"), summary({ total: 1, passed: 1, failed: 0, skipped: 0, error: 0 }))
      ),
      variant("no-tests-block-is-an-empty-report", { kind: "inspect", request: null, requestText: '{"abi":"$detected","op":"test","definition":$definition}' }, all(ok, summary({ total: 0, passed: 0, failed: 0, skipped: 0, error: 0 })), {
        definition: "base",
        definitionText: (base) => JSON.stringify(base)
      })
    ]
  }),
  test({
    id: "TST-03",
    title: "A request over a cap is refused as invalid_request naming where: more than 256 KiB of test text, more than 200 scenarios, more than 1,000 statements in one scenario, or a definition past a structure size cap",
    severity: "S3",
    attacker: "network",
    // 257 comment lines of 1,025 bytes: over 256 KiB (262,144) and nothing else wrong with them.
    input: generated({ $gen: "repeat", n: 257, text: `# ${"x".repeat(1022)}\n` }),
    expect: refused("invalid_request", "tests", 262144),
    variants: [
      variant("201-scenarios", generated({ $gen: "repeat", n: 201, text: 'test "t$n"\n  expect name visible\n' }), refused("invalid_request", "scenarios", 200)),
      variant("1001-statements", generated({ $gen: "repeat", n: 1001, head: 'test "long"\n', text: "  expect name visible\n" }), refused("invalid_request", "steps", 1000)),
      variant(
        "entries-together-over-256-KiB",
        { kind: "inspect", request: null, requestText: '{"abi":"$detected","op":"test","definition":$definition}' },
        refused("invalid_request", "definition.tests", 262144),
        {
          definition: "base",
          definitionText: withEntries(
            ["a", "b"].map((id) => ({ id, source: `test "${id}"\n  expect name visible\n${`# ${"x".repeat(1022)}\n`.repeat(130)}` }))
          )
        }
      ),
      // The structure gate `check` runs first: a definition past a size cap is refused before any scenario is read.
      variant(
        "definition-over-a-size-cap",
        { kind: "inspect", request: null, requestText: '{"abi":"$detected","op":"test","definition":$definition}' },
        refused("invalid_request", "definition", 2000),
        {
          definition: "base",
          definitionText: (base) => {
            const root = base["root"] as { children: { content: unknown[] } };
            root.children.content.push({ id: "wide", type: "select", configuration: { options: Array.from({ length: 2001 }, (_, at) => ({ value: `o${at}`, label: `Option ${at}` })) } });
            return JSON.stringify(base);
          }
        }
      )
    ]
  }),
  test({
    id: "TST-04",
    title: "The ABI check comes first and the tests must be text: a newer minor or another major is abi_mismatch, tests that are not text are invalid_request",
    severity: "S4",
    attacker: "network",
    input: generated('test "a"\n  expect name visible\n', "$nextMinor"),
    expect: refused("abi_mismatch"),
    variants: [
      variant("major-next", generated('test "a"\n  expect name visible\n', "$nextMajor"), refused("abi_mismatch")),
      variant("no-abi", { kind: "inspect", request: { op: "test", definition: BASE_DEFINITION, tests: 'test "a"\n  expect name visible\n' } }, refused("abi_mismatch")),
      variant("tests-is-a-number", generated(42), refused("invalid_request")),
      variant("tests-is-a-list", generated(['test "a"']), refused("invalid_request"))
    ]
  }),
  test({
    id: "TST-05",
    title: "The same request answers the same bytes twice on one sandbox: the report carries no clock, no order of hash keys, nothing from the first run",
    severity: "S3",
    input: { kind: "series", compareSteps: true, steps: [testRequest(SIDECAR), testRequest(SIDECAR)] },
    expect: { op: "custom", name: "series-repeats-identically" }
  }),
  test({
    id: "TST-06",
    title: "A request exactly at a cap is run, not refused: 200 scenarios, and a scenario of 1,000 statements",
    severity: "S4",
    // About 13 ms a scenario in QuickJS: seconds in all, so the row is heavy (run with --heavy or --gate full).
    applies: { program: { heavy: true }, endpoint: false, parity: false },
    input: generated({ $gen: "repeat", n: 200, text: 'test "t$n"\n  expect name visible\n' }),
    expect: all(ok, summary({ total: 200, passed: 200, failed: 0, skipped: 0, error: 0 })),
    variants: [variant("1000-statements", generated({ $gen: "repeat", n: 1000, head: 'test "long"\n', text: "  expect name visible\n" }), all(ok, summary({ total: 1, passed: 1, failed: 0, skipped: 0, error: 0 })))]
  })
];
