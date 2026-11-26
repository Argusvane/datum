import { BASE_DEFINITION, baseRoot } from "../fixtures/base-form.js";
import { flatValid } from "../fixtures/inputs.js";
import type { Json } from "../observation.js";
import type { Expectation } from "../predicates.js";
import { JOURNEY_ENDPOINT_SPECS } from "../runners/endpoint/specs-journeys.js";
import { vector } from "./helpers.js";
import type { Attacker, Gate, Severity, Variant, Vector, VectorInput } from "./schema.js";

/**
 * JRN: journeys. A journey is how a form routes answers through pages; the server
 * re-works the path from the values, so every rule below is a promise a host must keep when the
 * client lies about the path.
 *
 * Program mode asks the sandbox program (`context.journey` is the journey the answers were given
 * through; the HOST names it, the program never looks one up by id). Endpoint mode asks a live
 * receiver (`specs-journeys.ts` holds the requests; the rows listed here as placeholder variants
 * are the same rows by id). The fixture form's journey `main` routes the name "STOPZZ" to an exit
 * page; a fixture installed without that route fails JRN-01 on its control
 * row (reinstall it: `datum-security-check fixture`).
 *
 * Gates. JRN-05 is enforced: calculations are worked over the settled view. JRN-07 applies to
 * `@argusvane/datum-submissions` (see the vector).
 */
const TESTS = {
  service: "packages/submissions/tests/service-journey.test.ts",
  kernel: "engine/tests/journey-kernel.test.ts"
} as const;

const accepted = (value: boolean): Expectation => ({ op: "accepted", value });
const all = (...of: Expectation[]): Expectation => ({ op: "all", of });
const any = (...of: Expectation[]): Expectation => ({ op: "any", of });
const codes = (...includes: string[]): Expectation => ({ op: "codes", includes });
const refusedByJourney: Expectation = all(accepted(false), codes("journey.exit"));
const unknownOrInvalid: Expectation = all(accepted(false), any(codes("journey.unknown"), codes("journey.invalid")));
const typed: Expectation = { op: "custom", name: "typed-outcome" };

const eq = (path: string, value: string): Json => ({ kind: "binary", operator: "eq", left: { kind: "path", path }, right: { kind: "literal", value } });

/** The fixture form's journey: `main`, whose first page routes the name STOPZZ to an exit page. */
const MAIN = (BASE_DEFINITION.journey as { journeys: Json[] }).journeys[0] as { id: string; pages: Json[] };

const withId = (id: Json): Json => ({ ...(MAIN as unknown as Record<string, Json>), id }) as Json;

/** Answers that reach the exit page of `main`. */
const EXIT_VALUES = (): Record<string, Json> => flatValid({ name: "STOPZZ" });

const valuesIn = (journey: Json | undefined, values: Record<string, Json>): VectorInput => ({ kind: "values", values, ...(journey !== undefined ? { journey } : {}) });

/** A journey with an exit page two hops in, and one whose only route to the exit has no condition. */
const TWO_HOPS: Json = {
  id: "main",
  pages: [
    { id: "a", components: ["name"], routes: [{ to: "b" }] },
    { id: "b", components: ["code"], routes: [{ when: eq("name", "STOPZZ"), to: "stop" }, { to: "$end" }] },
    { id: "stop", kind: "exit", components: [] }
  ]
};
const ALWAYS_EXIT: Json = {
  id: "main",
  pages: [
    { id: "a", components: ["name", "code"], routes: [{ to: "stop" }] },
    { id: "stop", kind: "exit", components: [] }
  ]
};

/** Pages that skip: `who` goes to `where` when the name is "short", else through `extra` (tags and rows). */
const SKIPPING: Json = {
  id: "main",
  pages: [
    { id: "who", components: ["name", "code"], routes: [{ when: eq("name", "short"), to: "where" }, { to: "extra" }] },
    { id: "extra", components: ["tags", "rows"], routes: [{ to: "where" }] },
    { id: "where", components: ["addr"], routes: [{ to: "$end" }] }
  ]
};

const row = (id: string, input: VectorInput, expect: Expectation, rest: Partial<Variant> = {}): Variant => ({ id, input, expect, ...rest });

/** The request text of a raw program run: the base form and answers with `more` added at the top level. */
function rawRequest(values: Record<string, Json>, journey: Json | undefined, more: Record<string, Json> = {}): string {
  return JSON.stringify({ formId: BASE_DEFINITION.id, values, locale: "en", form: baseRoot(), ...(journey !== undefined ? { journey } : {}), ...more });
}
const rawRow = (id: string, body: string, expect: Expectation): Variant => row(id, { kind: "raw", route: "validate", body }, expect, { programOnly: true });

/** The endpoint rows of a vector by id, as placeholder variants for `explain` and the report (the requests are in the spec). */
function endpointVariants(id: string): Variant[] {
  return (JOURNEY_ENDPOINT_SPECS[id]?.rows ?? []).map((entry) => ({ id: `wire:${entry.id}`, input: { kind: "raw", route: "validate", body: "" } as VectorInput, expect: entry.expect, programOnly: true }));
}

function jrn(options: {
  n: number;
  title: string;
  severity: Severity;
  attacker?: Attacker;
  gate?: Gate;
  tests: { path: string; name?: string }[];
  input?: VectorInput;
  expect?: Expectation;
  variants?: Variant[];
  program?: boolean;
  endpoint?: false | { profiles?: ("submissions" | "builder")[]; note?: string };
  fixture?: Vector["fixture"];
  limits?: Vector["limits"];
}): Vector {
  const id = `JRN-${String(options.n).padStart(2, "0")}`;
  // Placeholder wire rows only where no program row exists: a program run would try to run them.
  const wire = options.program === false && options.endpoint !== undefined && options.endpoint !== false ? endpointVariants(id) : [];
  const rows = [...(options.variants ?? []), ...wire];
  return vector({
    id,
    title: options.title,
    class: "journey",
    severity: options.severity,
    attacker: options.attacker ?? "filler",
    provenance: { tests: options.tests },
    ...(options.gate !== undefined ? { gate: options.gate } : {}),
    ...(options.fixture !== undefined ? { fixture: options.fixture } : {}),
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    input: options.input ?? { kind: "raw", route: "validate", body: "" },
    expect: options.expect ?? { op: "custom", name: "no-server-failure" },
    ...(rows.length > 0 ? { variants: rows } : {}),
    applies: {
      program: options.program === false ? false : {},
      endpoint: options.endpoint === undefined || options.endpoint === false ? false : { ...(options.endpoint.profiles !== undefined ? { profiles: options.endpoint.profiles } : {}), ...(options.endpoint.note !== undefined ? { note: options.endpoint.note } : {}) },
      parity: false
    }
  });
}

export const JOURNEY_VECTORS: Vector[] = [
  jrn({
    n: 1,
    title: "A path that ends at an exit page is refused (journey.exit) whenever the journey is named, however many pages it takes to get there",
    severity: "S1",
    tests: [{ path: TESTS.service }, { path: TESTS.kernel }],
    input: valuesIn(MAIN as unknown as Json, EXIT_VALUES()),
    expect: refusedByJourney,
    variants: [
      row("two-hops-to-the-exit", valuesIn(TWO_HOPS, EXIT_VALUES()), refusedByJourney),
      row("an-unconditional-route-to-the-exit", valuesIn(ALWAYS_EXIT, flatValid()), refusedByJourney),
      row("control-an-honest-path-is-accepted", valuesIn(MAIN as unknown as Json, flatValid()), all(accepted(true), { op: "codes", excludes: ["journey.exit"] }), { gate: { status: "enforced" } })
    ],
    endpoint: {},
    limits: { programBudgetMultiple: 4 }
  }),
  jrn({
    n: 2,
    title: "The answers of a page the path skipped are dropped from the judged values, and a required field on that page is not asked",
    severity: "S2",
    tests: [{ path: TESTS.service }, { path: TESTS.kernel }],
    input: valuesIn(SKIPPING, flatValid({ name: "short", tags: { x: true, y: false }, "rows[0].sku": "SKIPPEDZZ" })),
    expect: all(accepted(true), { op: "valuesExcludeText", text: ["SKIPPEDZZ"] }, { op: "rawAt", path: "values.tags", absent: true }),
    variants: [
      row("a-required-field-on-a-skipped-page-is-not-asked", valuesIn(SKIPPING, flatValid({ name: "short", "rows[0].sku": "" })), accepted(true)),
      row(
        "control-the-page-on-the-path-keeps-its-values",
        valuesIn(SKIPPING, flatValid({ name: "long", tags: { x: true, y: false }, "rows[0].sku": "KEPTZZ" })),
        all(accepted(true), { op: "rawAt", path: "values.tags", equals: { x: true, y: false } }),
        { gate: { status: "enforced" } }
      )
    ]
  }),
  jrn({
    n: 3,
    title: "A journey id that is wrong-typed or named like an object member is refused (journey.unknown, or journey.invalid in the program) and never read as an inherited member",
    severity: "S3",
    tests: [{ path: TESTS.service }],
    input: valuesIn(withId(7), flatValid()),
    expect: unknownOrInvalid,
    variants: [
      row("an-array-id", valuesIn(withId(["main"]), flatValid()), unknownOrInvalid),
      row("an-object-id", valuesIn(withId({ id: "main" }), flatValid()), unknownOrInvalid),
      row("a-bare-string-for-the-journey", valuesIn("main", flatValid()), unknownOrInvalid),
      row("an-id-without-pages", valuesIn({ id: "__proto__" }, flatValid()), unknownOrInvalid),
      row("a-proto-named-journey-is-only-a-label", valuesIn(withId("__proto__"), flatValid()), all(accepted(true), { op: "textExcludes", markers: ["polluted"] })),
      row("a-constructor-named-journey-is-only-a-label", valuesIn(withId("constructor"), flatValid()), all(accepted(true), { op: "textExcludes", markers: ["polluted"] }))
    ],
    endpoint: {}
  }),
  jrn({
    n: 4,
    title: "A scope, pageId or other journey member smuggled into the request changes nothing: the exit page still refuses, a hostile page name is a typed no-op",
    severity: "S3",
    tests: [{ path: TESTS.service }],
    input: { kind: "raw", route: "validate", body: rawRequest(EXIT_VALUES(), MAIN as unknown as Json, { scope: "page", pageId: "stop" }) },
    expect: refusedByJourney,
    variants: [
      rawRow("members-that-name-no-exit-or-skip", rawRequest(EXIT_VALUES(), MAIN as unknown as Json, { exit: false, skipExit: true, journeyId: "other", scope: "everything" }), refusedByJourney),
      rawRow("a-page-named-like-an-object-member", rawRequest(flatValid(), MAIN as unknown as Json, { page: "__proto__" }), all(accepted(true), { op: "rawAt", path: "pageComponentIds", equals: [] })),
      rawRow("a-page-that-is-a-number", rawRequest(flatValid(), MAIN as unknown as Json, { page: 7 }), typed)
    ],
    program: true
  }),
  jrn({
    n: 5,
    title: "A calculation reads the settled view: an answer from a page the path skipped cannot derive a stored result or steer a later page",
    severity: "S3",
    tests: [{ path: TESTS.kernel }],
    gate: { status: "enforced" },
    fixture: {
      definition: () => ({
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "resident", type: "text", configuration: { required: true } },
            { id: "income", type: "number", configuration: {} },
            { id: "eligible", type: "checkbox", configuration: {}, rules: { value: { kind: "binary", operator: "lt", left: { kind: "path", path: "income" }, right: { kind: "literal", value: 30000 } } } },
            { id: "bonus", type: "text", configuration: { required: true } }
          ]
        }
      })
    },
    input: valuesIn(
      {
        id: "calc",
        pages: [
          { id: "who", components: ["resident"], routes: [{ when: eq("resident", "yes"), to: "money" }, { to: "result" }] },
          { id: "money", components: ["income"], routes: [{ to: "result" }] },
          { id: "result", components: ["eligible"], routes: [{ when: { kind: "binary", operator: "eq", left: { kind: "path", path: "eligible" }, right: { kind: "literal", value: true } }, to: "extra" }, { to: "$end" }] },
          { id: "extra", components: ["bonus"], routes: [{ to: "$end" }] }
        ]
      },
      { resident: "no", income: 0, bonus: "FORGEDZZ" }
    ),
    expect: all(accepted(true), { op: "valuesExcludeText", text: ["FORGEDZZ"] }, { op: "rawAt", path: "values.bonus", absent: true }),
    limits: {}
  }),
  jrn({
    n: 7,
    title: "The submissions service sent no journey judges by the form's only or default journey, else refuses (journey.required): leaving the journey out never leaves its exit page out",
    severity: "S1",
    tests: [{ path: TESTS.service }],
    program: false,
    endpoint: {
      profiles: ["submissions"],
      note: "the service judges by the only journey, else the declared default, else journey.required; a form with `journey.opensAs: form` is still judged whole by design"
    }
  })
];
