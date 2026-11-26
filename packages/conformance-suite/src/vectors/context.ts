import { addComponents, compose, configure, flatValid, textNode } from "../fixtures/inputs.js";
import type { Json } from "../observation.js";
import type { Expectation } from "../predicates.js";
import { accepted, all, any, RUNS, vector } from "./helpers.js";
import type { DefinitionBuilder, Fixture, Variant, Vector, VectorInput } from "./schema.js";

/**
 * CTX: what the host hands the program beside the answers: the locale, today's date, the
 * formula-error policy and the host context. A hostile or sloppy value must be read as absent (with
 * a warning), never crash the run or reach the wall clock.
 */
const QUICKJS_KERNEL_TESTS = "packages/quickjs-wasm-host/tests/quickjs-kernel-limits.test.ts";
const KERNEL_LIMIT_TESTS = "engine/tests/kernel-limits-and-secrecy.test.ts";
const everywhere = { program: RUNS, endpoint: RUNS, parity: RUNS } as const;

type ValuesInput = Extract<VectorInput, { kind: "values" }>;
const run = (values: Record<string, Json>, extra: Partial<ValuesInput> = {}): VectorInput => ({ kind: "values", values, ...extra });

/** The fixture's `code` field fails its pattern; the verdict is exactly that one error. */
const patternOnly: Expectation = all(accepted(false), { op: "codes", exactly: ["pattern@code"] });
const badCode = (extra: Partial<ValuesInput>): VectorInput => run(flatValid({ code: "abc" }), { logLevel: "warn", ...extra });

/** Gives the fixture's `code` field a pattern message in the default language. */
const localizedCode: DefinitionBuilder = (root) => {
  const code = ((root["children"] as { content: Record<string, unknown>[] }).content).find((node) => node["id"] === "code") as { configuration: Record<string, unknown> };
  code.configuration["patternMessage"] = "D";
  return root;
};

/**
 * The French and English wording of that message: the definition's `translations` map,
 * which a run context carries beside the form because a run has no definition. `1hkaexf` is the
 * source hash of "D", the default text each entry was written against.
 */
const CODE_MESSAGE_TRANSLATIONS: Json = {
  en: { components: { code: { patternMessage: { text: "E", source: "1hkaexf" } } } },
  fr: { components: { code: { patternMessage: { text: "F", source: "1hkaexf" } } } }
};

/**
 * The same message as the host's catalog carries it:
 * string leaves, no `source`. One catalog words it for `fr-CA` exactly, the other for `fr` only; a
 * run reads a catalog before the map under the same tag, the exact tag before the primary subtag.
 */
const CODE_MESSAGE_CATALOG: Json = { "fr-CA": { components: { code: { patternMessage: "C" } } } };
const CODE_MESSAGE_CATALOG_PRIMARY: Json = { fr: { components: { code: { patternMessage: "P" } } } };
/** The exact-tag catalog under another spelling: tags compare case-insensitively with `_` read as `-`. */
const CODE_MESSAGE_CATALOG_SPELLED: Json = { FR_ca: { components: { code: { patternMessage: "C" } } } };
/** A blank leaf is no text: the exact-tag catalog says nothing, so the next rung answers. */
const CODE_MESSAGE_CATALOG_BLANK: Json = { "fr-CA": { components: { code: { patternMessage: "" } } } };
/** A map that words the message for `fr-CA` exactly (the default one holds `fr` and `en` only). */
const CODE_MESSAGE_TRANSLATIONS_EXACT: Json = {
  "fr-CA": { components: { code: { patternMessage: { text: "F", source: "1hkaexf" } } } }
};

const unparsable = (word: "fail" | "warn"): Fixture => ({ definition: "base+patch", patch: compose(configure({ formulaErrors: word }), addComponents(textNode("v", {}, { validWhen: "(((" }))) });
const refusedByRule: Expectation = all(accepted(false), { op: "codes", exactly: ["rule@v"] });

const messageIs = (message: string): Expectation => all(accepted(false), { op: "rawAt", path: "errors.0.parameters.message", equals: message });

/** A rule that reads the clock: required once today() is after 2020-01-01. */
const clockRule = (): DefinitionBuilder => addComponents(textNode("late", {}, { requiredWhen: { run: "server", formula: 'dateDiff("2020-01-01", today(), "days") > 0' } }));

const todayVariant = (id: string, today: unknown): Variant => ({
  id,
  fixture: { definition: "base+patch", patch: clockRule() },
  input: run(flatValid(), { today: today as Json, logLevel: "warn" }),
  expect: all(accepted(true), { op: "codes", exactly: [] }),
  programOnly: true
});

/** A field shown to admins only, and required: what a host's own `hostContext` decides. */
const adminOnly = (): DefinitionBuilder => addComponents(textNode("admin_note", { required: true }, { visibleWhen: 'host.role = "admin"' }));
const hostRun = (hostContext?: unknown, extra: Partial<ValuesInput> = {}): VectorInput => run(flatValid(), { ...(hostContext !== undefined ? { hostContext } : {}), ...extra });
const adminRequired: Expectation = all(accepted(false), { op: "codes", exactly: ["required@admin_note"] });
const notAsked: Expectation = all(accepted(true), { op: "codes", exactly: [] }, { op: "rawAt", path: "visibilitySkipped", absent: true });

export const CONTEXT_VECTORS: Vector[] = [
  vector({
    id: "CTX-01",
    title: "A locale that is not a short text (number, object, list, 36 characters, null) is read as absent, not a TypeError; the pattern error still comes",
    class: "context",
    severity: "S3",
    attacker: "filler",
    provenance: { tests: [{ path: QUICKJS_KERNEL_TESTS, name: "a locale that is not a text is read as absent" }, { path: KERNEL_LIMIT_TESTS, name: "a locale that is not a short text is read as absent" }] },
    input: badCode({ locale: 5 }),
    expect: all(patternOnly, { op: "logsSome", pattern: "context\\.locale is not a text of at most 35 characters" }),
    variants: [
      { id: "object", input: badCode({ locale: {} }), expect: patternOnly },
      { id: "list", input: badCode({ locale: ["en"] }), expect: patternOnly },
      { id: "36-characters", input: badCode({ locale: "x".repeat(36) }), expect: patternOnly },
      { id: "null", input: badCode({ locale: null }), expect: patternOnly }
    ],
    applies: { program: RUNS, endpoint: { expect: any(patternOnly, { op: "refusal", anyOf: ["bad_document"] }), note: "the receiver may refuse the locale outright (400 bad_document); a 5xx is never acceptable" }, parity: RUNS }
  }),
  vector({
    id: "CTX-02",
    title: "Real locale tags (fr-CA, a 35-character tag) are kept and the localized pattern message is used",
    class: "context",
    severity: "S4",
    attacker: "filler",
    provenance: { tests: [{ path: KERNEL_LIMIT_TESTS, name: "keeps a real locale, a long tag included" }] },
    fixture: { definition: "base+patch", patch: localizedCode },
    input: run(flatValid({ code: "abc" }), { locale: "fr-CA", translations: CODE_MESSAGE_TRANSLATIONS }),
    expect: messageIs("F"),
    variants: [
      { id: "english", input: run(flatValid({ code: "abc" }), { locale: "en", translations: CODE_MESSAGE_TRANSLATIONS }), expect: messageIs("E") },
      { id: "35-character-tag-is-kept", input: run(flatValid({ code: "abc" }), { locale: "x".repeat(35), translations: CODE_MESSAGE_TRANSLATIONS }), expect: patternOnly },
      // The catalog's exact tag beats the map's primary subtag (the map holds fr "F", the catalog fr-CA "C").
      { id: "catalog-exact-wins", input: run(flatValid({ code: "abc" }), { locale: "fr-CA", translations: CODE_MESSAGE_TRANSLATIONS, catalog: CODE_MESSAGE_CATALOG }), expect: messageIs("C") },
      // Neither holds fr-CA: the catalog's primary subtag is read before the map's.
      { id: "catalog-subtag-before-map-subtag", input: run(flatValid({ code: "abc" }), { locale: "fr-CA", translations: CODE_MESSAGE_TRANSLATIONS, catalog: CODE_MESSAGE_CATALOG_PRIMARY }), expect: messageIs("P") },
      // The map's exact tag is read before the catalog's primary subtag.
      { id: "map-exact-before-catalog-subtag", input: run(flatValid({ code: "abc" }), { locale: "fr-CA", translations: CODE_MESSAGE_TRANSLATIONS_EXACT, catalog: CODE_MESSAGE_CATALOG_PRIMARY }), expect: messageIs("F") },
      // A catalog that is not a record is no text: the map answers, the run does not throw.
      { id: "catalog-not-a-record-ignored", input: run(flatValid({ code: "abc" }), { locale: "fr-CA", translations: CODE_MESSAGE_TRANSLATIONS, catalog: "nope" }), expect: messageIs("F") },
      // The catalog is keyed FR_ca, the run speaks fr-CA: the same tag, so the catalog's text wins over the map's fr.
      { id: "catalog-tag-spelling", input: run(flatValid({ code: "abc" }), { locale: "fr-CA", translations: CODE_MESSAGE_TRANSLATIONS, catalog: CODE_MESSAGE_CATALOG_SPELLED }), expect: messageIs("C") },
      // A blank catalog leaf falls through to the map's exact tag, never to a blank message.
      { id: "catalog-blank-leaf-falls-through", input: run(flatValid({ code: "abc" }), { locale: "fr-CA", translations: CODE_MESSAGE_TRANSLATIONS_EXACT, catalog: CODE_MESSAGE_CATALOG_BLANK }), expect: messageIs("F") }
    ]
  }),
  vector({
    id: "CTX-03",
    title: "A today that is not a real date (2026-02-30, garbage, a number, null) leaves clock rules unevaluated; the run completes and never reads the wall clock",
    class: "context",
    severity: "S4",
    attacker: "host-config",
    provenance: { tests: [{ path: "packages/quickjs-wasm-host/tests/quickjs-number-date-validity.test.ts" }] },
    fixture: { definition: "base+patch", patch: clockRule() },
    input: run(flatValid(), { today: "2026-02-30", logLevel: "warn" }),
    expect: all(accepted(true), { op: "codes", exactly: [] }),
    variants: [
      todayVariant("garbage", "garbage"),
      todayVariant("number", 5),
      todayVariant("null", null),
      {
        id: "a-real-day-evaluates-the-rule",
        fixture: { definition: "base+patch", patch: clockRule() },
        input: run(flatValid(), { today: "2026-10-14" }),
        expect: all(accepted(false), { op: "codes", exactly: ["required@late"] }),
        programOnly: true
      }
    ]
  }),
  vector({
    id: "CTX-04",
    title: "A rule that reads today() with no today sent lists its component as clock-dependent instead of crashing",
    class: "context",
    severity: "S3",
    attacker: "host-config",
    provenance: { tests: [] },
    fixture: { definition: "base+patch", patch: addComponents(textNode("d", {}, { validWhen: "d <= today()" })) },
    input: run(flatValid({ d: "2020-01-01" }), { logLevel: "warn" }),
    expect: all(accepted(true), { op: "rawAt", path: "clockDependent", contains: "d" })
  }),
  vector({
    id: "CTX-05",
    title: "The host's formulaErrors word relaxes only to warn; anything else keeps the form's word; fail reports formula.invalid, warn refuses a non-empty answer",
    class: "context",
    severity: "S3",
    attacker: "host-config",
    provenance: { tests: [{ path: "engine/tests/validate-rule.test.ts" }] },
    fixture: unparsable("fail"),
    input: run(flatValid({ v: "x" })),
    expect: all(accepted(false), { op: "codes", includes: ["formula.invalid"] }),
    variants: [
      { id: "host-warn-relaxes-fail", fixture: { ...unparsable("fail"), policy: { formulaErrors: "warn" } }, expect: refusedByRule, programOnly: true },
      { id: "host-uppercase-word-falls-through", fixture: { ...unparsable("fail"), policy: { formulaErrors: "WARN" } }, programOnly: true },
      { id: "host-object-falls-through", fixture: { ...unparsable("fail"), policy: { formulaErrors: {} as unknown as string } }, programOnly: true },
      { id: "form-warn-refuses-a-non-empty-answer", fixture: unparsable("warn"), expect: refusedByRule, programOnly: true },
      { id: "host-fail-beats-form-warn", fixture: { ...unparsable("warn"), policy: { formulaErrors: "fail" } }, programOnly: true }
    ]
  }),
  vector({
    id: "CTX-06",
    title: "A validWhen on a field inside a repeating section is skipped with a compile warning, not an error",
    class: "context",
    severity: "S4",
    attacker: "author",
    provenance: { tests: [{ path: QUICKJS_KERNEL_TESTS, name: "a validWhen on a field inside a repeating section is warned about at compile" }, { path: KERNEL_LIMIT_TESTS, name: "a validWhen on a field inside a repeating section" }] },
    fixture: {
      definition: "base+patch",
      patch: addComponents({
        id: "items",
        type: "repeatingSection",
        configuration: {},
        collection: { itemFields: ["qty"] },
        children: { content: [{ id: "qty", type: "number", configuration: {}, rules: { validWhen: "component > 0" } }] }
      })
    },
    input: run(flatValid({ "items[0].qty": -5 }), { logLevel: "warn" }),
    expect: all(accepted(true), { op: "logsSome", pattern: "^formula warning: rules:qty:validWhen" })
  }),
  vector({
    id: "CTX-07",
    title: "A type the run context's kinds map gives a base is validated as that base: a mapped date below its min is refused with date.min, an impossible one with date",
    class: "context",
    severity: "S3",
    attacker: "author",
    provenance: { tests: [{ path: "packages/quickjs-wasm-host/tests/quickjs-component-kinds.test.ts" }, { path: "engine/tests/component-kinds.test.ts" }] },
    fixture: { definition: "base+patch", patch: addComponents({ id: "born", type: "gcds-date", configuration: { label: "Born", min: "1900-01-01" } }) },
    input: run(flatValid({ born: "1800-01-01" }), { kinds: { "gcds-date": "date" } }),
    expect: all(accepted(false), { op: "codes", exactly: ["date.min@born"] }),
    variants: [
      { id: "an-impossible-date", input: run(flatValid({ born: "2026-13-45" }), { kinds: { "gcds-date": "date" } }), expect: all(accepted(false), { op: "codes", exactly: ["date@born"] }) },
      { id: "a-date-inside-the-bounds", input: run(flatValid({ born: "1990-05-01" }), { kinds: { "gcds-date": "date" } }), expect: accepted(true) }
    ],
    applies: { program: RUNS, endpoint: false, parity: false }
  }),
  vector({
    id: "CTX-08",
    title: "A host context the host supplies decides host. rules: an admin-only required field is enforced for an admin, not asked of a user, and with no context left unjudged as before",
    class: "context",
    severity: "S2",
    attacker: "host-config",
    provenance: {
      tests: [
        { path: "engine/tests/host-context-kernel.test.ts" },
        { path: "packages/quickjs-wasm-host/tests/quickjs-host-context.test.ts" },
        { path: "packages/submissions/tests/service-host-context.test.ts" }
      ]
    },
    fixture: { definition: "base+patch", patch: adminOnly() },
    // No context: today's lenient reading, the field treated as hidden for requiredness and named.
    input: hostRun(),
    expect: all(accepted(true), { op: "codes", exactly: [] }, { op: "rawAt", path: "visibilitySkipped", contains: "admin_note" }),
    variants: [
      { id: "admin-must-answer", input: hostRun({ role: "admin" }), expect: adminRequired },
      { id: "admin-answered", input: hostRun({ role: "admin" }, { values: flatValid({ admin_note: "seen" }) }), expect: all(accepted(true), { op: "rawAt", path: "values.admin_note", equals: "seen" }) },
      { id: "user-not-asked", input: hostRun({ role: "user" }), expect: notAsked },
      // An answer a user's browser could never have shown is left out of the values, as any hidden answer is.
      { id: "user-answer-left-out", input: hostRun({ role: "user" }, { values: flatValid({ admin_note: "forged" }) }), expect: all(notAsked, { op: "rawAt", path: "values.admin_note", absent: true }) },
      // A key the context lacks reads as no answer: decided (hidden), never undecided.
      { id: "missing-key-is-no-answer", input: hostRun({}), expect: notAsked },
      // A context that is no object is read as absent, with a warning: today's lenient reading.
      {
        id: "not-an-object-is-absent",
        input: hostRun("admin", { logLevel: "warn" }),
        expect: all(accepted(true), { op: "rawAt", path: "visibilitySkipped", contains: "admin_note" }, { op: "logsSome", pattern: "context\\.hostContext is not an object" })
      }
    ],
    applies: { program: RUNS, endpoint: false, parity: RUNS }
  })
];
