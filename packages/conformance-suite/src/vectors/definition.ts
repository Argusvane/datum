import {
  badLocalization,
  badPdf,
  badRoot,
  badSections,
  containersSharingKey,
  dupDataKeys,
  dupIdAcrossJourneyIsFine,
  dupIdParentChild,
  dupIdSiblings,
  deepForm,
  deepOwnNode,
  definitionIdOfLength,
  fieldUnderFieldPath,
  hostileId,
  journeyChain,
  journeyDuplicatePageId,
  journeyLoops,
  journeyPagesNotAList,
  loneSurrogateId,
  manyDuplicateIds,
  manyJourneys,
  manyLocales,
  manyOptions,
  manyPages,
  manyRoutes,
  NOT_A_DEFINITION,
  protoKeys,
  prototypeNamesAsIds,
  scopeWordsAsIds,
  journeyReservedIds,
  rootOfType,
  secretInNonListSlot,
  secretObjectForm,
  secretRuleOnDuplicateId,
  secretRulesMatrix,
  DECOY_MARKER,
  SUITE_MARKER,
  typeMissing,
  typeOf,
  unknownBrowserFunction,
  unknownServerFunction,
  unparsableVisibleWhen,
  unparsableWithStructureProblem,
  versionOfLength,
  wideForm,
  riskyMatches,
  edited,
  textComponent
} from "../fixtures/definitions.js";
import type { Expectation } from "../predicates.js";
import { all, TESTS, vector } from "./helpers.js";
import type { Fixture, Gate, Variant, Vector, VectorInput } from "./schema.js";

/**
 * DEF: the definition a form author hands to a host. Program mode asks the program's `check` and
 * `public` ops about it; the builder profile (BLD) saves the same definitions through a host's
 * save route (`src/runners/endpoint/profiles/builder-specs.ts` holds the status/code table).
 */
/** The base definition's top-level components, for a variant that adds one. */
const contentOf = (def: Record<string, any>): unknown[] => def["root"]["children"]["content"] as unknown[];
const INSPECT = { path: TESTS.inspectEngine } as const;

const ENFORCED: Gate = { status: "enforced" };

/** `{abi, op, definition, types?}` as JSON text, the definition spliced in as text (see `Fixture.definitionText`). */
const request = (op: "check" | "public" | "inspect", extra = "", types = true): VectorInput => ({
  kind: "inspect",
  request: null,
  requestText: `{"abi":"$detected","op":"${op}","definition":$definition${types ? ',"types":$baseTypes' : ""}${extra}}`
});

const using = (definitionText: Fixture["definitionText"], extra: Partial<Fixture> = {}): Partial<Fixture> => ({ ...(definitionText !== undefined ? { definitionText } : {}), ...extra });
const textFixture = (definitionText: NonNullable<Fixture["definitionText"]>): Fixture => ({ definition: "base", definitionText });

const ok: Expectation = { op: "answerPath", path: "ok", equals: true };
const verdictIs = (verdict: "ok" | "warn" | "fail"): Expectation => ({ op: "answerPath", path: "verdict", equals: verdict });
const refusedWith = (code: string): Expectation => ({ op: "all", of: [{ op: "answerPath", path: "ok", equals: false }, { op: "answerPath", path: "error.code", equals: code }] });
const structure = (parts: Omit<Extract<Expectation, { op: "answerProblems" }>, "op" | "list">): Expectation => ({ op: "answerProblems", list: "structure", ...parts });
const warnings = (parts: Omit<Extract<Expectation, { op: "answerProblems" }>, "op" | "list">): Expectation => ({ op: "answerProblems", list: "structureWarnings", ...parts });
const problems = (parts: Omit<Extract<Expectation, { op: "answerProblems" }>, "op" | "list">): Expectation => ({ op: "answerProblems", list: "problems", ...parts });
const refusal = (code: string, where?: string): Expectation => all(ok, verdictIs("fail"), structure({ includes: [where === undefined ? code : `${code}@${where}`] }));
const size = (maxBytes: number): Expectation => ({ op: "answerSize", maxBytes });
const KIB_128 = 128 * 1024;

const variant = (id: string, definitionText: Fixture["definitionText"], expect: Expectation, options: { gate?: Gate; input?: VectorInput; fixture?: Partial<Fixture>; programOnly?: boolean } = {}): Variant => ({
  id,
  fixture: using(definitionText, options.fixture),
  expect,
  ...(options.input !== undefined ? { input: options.input } : {}),
  ...(options.gate !== undefined ? { gate: options.gate } : {}),
  ...(options.programOnly === true ? { programOnly: true } : {})
});

/** Applicability on the builder profile (the save rows are in `builder-specs.ts`, keyed by the same id). */
const ON_BUILDER = (note?: string, heavy = false): Vector["applies"] => ({
  program: {},
  endpoint: { profiles: ["builder"], needsWrites: true, ...(heavy ? { heavy: true } : {}), ...(note !== undefined ? { note } : {}) },
  parity: false
});
const PROGRAM_ONLY: Vector["applies"] = { program: {}, endpoint: false, parity: false };

const def = (
  options: Pick<Vector, "id" | "title" | "severity"> & { attacker?: Vector["attacker"]; gate?: Gate; tests?: Vector["provenance"]["tests"] } & Pick<Vector, "input" | "expect"> &
    Partial<Pick<Vector, "variants" | "limits" | "applies">> & { fixture?: Fixture }
): Vector =>
  vector({
    id: options.id,
    title: options.title,
    class: "definition",
    severity: options.severity,
    attacker: options.attacker ?? "author",
    provenance: { tests: options.tests ?? [INSPECT] },
    gate: options.gate ?? ENFORCED,
    fixture: options.fixture ?? { definition: "base" },
    input: options.input,
    expect: options.expect,
    ...(options.variants !== undefined ? { variants: options.variants } : {}),
    limits: options.limits ?? {},
    applies: options.applies ?? PROGRAM_ONLY
  });

const QUIET_SECRETS = { op: "textExcludes", markers: [SUITE_MARKER] } as const satisfies Expectation;

// A journey run for DEF-11's last step: the loops definition's journey, over the base form.
const loopsJourney = JSON.parse(journeyLoops()).journey.journeys[0] as never;

export const DEFINITION_VECTORS: Vector[] = [
  def({
    id: "DEF-01",
    title: "The base fixture definition is clean: check says ok with nothing to report",
    severity: "S3",
    attacker: "author",
    input: request("check"),
    expect: all(ok, verdictIs("ok"), problems({ exactly: [] })),
    variants: [variant("structure-lists-are-empty", undefined, all(structure({ exactly: [] }), warnings({ exactly: [] })))],
    applies: ON_BUILDER("the base fixture is the lifecycle's first save; its 200 is checked there")
  }),
  def({
    id: "DEF-02",
    title: "A definition that is not an object, or whose root is not a component, is refused as invalid_request; a root that is not a form is a structure problem",
    severity: "S3",
    input: request("check"),
    fixture: textFixture(NOT_A_DEFINITION.array),
    expect: refusedWith("invalid_request"),
    variants: [
      variant("string", NOT_A_DEFINITION.string, refusedWith("invalid_request")),
      variant("null", NOT_A_DEFINITION.null, refusedWith("invalid_request")),
      variant("number", NOT_A_DEFINITION.number, refusedWith("invalid_request")),
      variant("root-array", badRoot("[]"), refusedWith("invalid_request")),
      variant("root-string", badRoot('"x"'), refusedWith("invalid_request")),
      variant("root-null", badRoot("null"), refusedWith("invalid_request")),
      variant("root-missing", badRoot("missing"), refusedWith("invalid_request")),
      variant("root-type-is-group", rootOfType("group"), refusal("definition.root.type", "root"))
    ],
    applies: ON_BUILDER("a non-object is 422 from the host's own shape check; a root that is not a form is 422")
  }),
  def({
    id: "DEF-03",
    title: "Two components with one id are a structure problem: siblings and a parent with its child; an own journey node beside a form id is not",
    severity: "S3",
    input: request("check"),
    fixture: textFixture(dupIdSiblings),
    expect: refusal("component.id.duplicate", "root > content > dup"),
    variants: [
      variant("parent-and-child", dupIdParentChild, refusal("component.id.duplicate", "root > content > dup > default > dup")),
      variant("journey-own-node-is-not-a-duplicate", dupIdAcrossJourneyIsFine, all(ok, verdictIs("ok"), structure({ excludes: ["component.id.duplicate"] })), { gate: ENFORCED })
    ],
    applies: ON_BUILDER()
  }),
  def({
    id: "DEF-04",
    title: "Two fields on one data key, or a field under a field's path, are structure problems; two containers sharing a key are not",
    severity: "S1",
    input: request("check"),
    fixture: textFixture(dupDataKeys),
    expect: all(ok, verdictIs("fail"), structure({ includes: ["component.dataPath.duplicate"] })),
    variants: [
      variant("field-under-a-field-path", fieldUnderFieldPath, all(ok, verdictIs("fail"), structure({ includes: ["component.dataPath.conflict"] }))),
      variant("containers-sharing-a-key-are-fine", containersSharingKey, all(ok, verdictIs("ok"), structure({ excludes: ["component.dataPath.duplicate", "component.dataPath.conflict"] })), { gate: ENFORCED })
    ],
    applies: ON_BUILDER()
  }),
  def({
    id: "DEF-05",
    title: "Size caps: 10,001 components, 2,001 options, 50,001 options in all, 65 locales, 33 journeys, 1,001 pages, 65 routes are refused cheaply; the caps themselves are fine",
    severity: "S2",
    input: request("check"),
    fixture: textFixture(() => wideForm(10_001)),
    expect: all(ok, verdictIs("fail"), structure({ includes: ["definition.tooManyComponents"] }), problems({ exactly: [] }), size(KIB_128)),
    limits: { programBudgetMultiple: 2 },
    variants: [
      variant("options-2001", () => manyOptions(2001), all(ok, structure({ includes: ["option.tooMany"] }), size(KIB_128))),
      variant("options-2000", () => manyOptions(2000), all(ok, structure({ excludes: ["option.tooMany"] })), { programOnly: true }),
      variant("locales-64", () => manyLocales(64), all(ok, structure({ excludes: ["localization.tooMany", "localization.invalid"] })), { programOnly: true }),
      variant("locales-65", () => manyLocales(65), all(ok, structure({ includes: ["localization.tooMany"] }), size(KIB_128))),
      variant("journeys-32", () => manyJourneys(32), all(ok, structure({ excludes: ["journey.tooMany"] })), { programOnly: true }),
      variant("journeys-33", () => manyJourneys(33), all(ok, structure({ includes: ["journey.tooMany"] }), size(KIB_128))),
      variant("pages-1000", () => manyPages(1000), all(ok, structure({ excludes: ["journey.page.tooMany"] })), { programOnly: true }),
      variant("pages-1001", () => manyPages(1001), all(ok, structure({ includes: ["journey.page.tooMany"] }), size(KIB_128))),
      variant("routes-64", () => manyRoutes(64), all(ok, structure({ excludes: ["journey.route.tooMany"] })), { programOnly: true }),
      variant("routes-65", () => manyRoutes(65), all(ok, structure({ includes: ["journey.route.tooMany"] }), size(KIB_128)))
    ],
    applies: ON_BUILDER("one save of 10,001 components; the other caps are program-only rows")
  }),
  def({
    id: "DEF-06",
    title: "Nesting: 32 levels are read, 33 (form tree or a journey's own node) and 3,000 are refused as definition.tooDeep by every op, in budget, without a trap",
    severity: "S2",
    tests: [INSPECT],
    input: request("check"),
    fixture: textFixture(() => deepForm(33)),
    limits: { programBudgetMultiple: 4 },
    expect: refusedWith("definition.tooDeep"),
    variants: [
      variant("depth-32-is-read", () => deepForm(32), all(ok, verdictIs("ok"))),
      variant("own-node-depth-32-is-read", () => deepOwnNode(32), all(ok, verdictIs("ok"))),
      variant("own-node-depth-33", () => deepOwnNode(33), refusedWith("definition.tooDeep")),
      // The sandbox refuses a request nested past 320 JSON levels before it parses it (a typed too_deep); either way no trap.
      variant("depth-3000", () => deepForm(3000), { op: "any", of: [refusedWith("definition.tooDeep"), { op: "refusal", anyOf: ["too_deep"] }] }),
      variant("public-op-depth-33", () => deepForm(33), refusedWith("definition.tooDeep"), { input: request("public") }),
      variant("inspect-op-depth-33", () => deepForm(33), refusedWith("definition.tooDeep"), { input: request("inspect") }),
      variant("error-names-where-and-limit", () => deepForm(33), all(refusedWith("definition.tooDeep"), { op: "answerPath", path: "error.limit", equals: 32 }))
    ],
    applies: ON_BUILDER("33 levels: 422 with the tooDeep message")
  }),
  def({
    id: "DEF-07",
    title: "Own __proto__ keys (top level, slot, rules key, data key) are refused and pollute nothing; toString and hasOwnProperty as ids only warn, constructor is refused as a reserved id as the engine refuses it",
    severity: "S2",
    input: request("check"),
    fixture: textFixture(protoKeys),
    expect: all(ok, verdictIs("fail"), structure({ includes: ["definition.key.prototype", "component.dataKey.prototype"] }), { op: "custom", name: "no-prototype-pollution" }, size(KIB_128)),
    variants: [
      variant(
        "prototype-names-as-ids-only-warn",
        prototypeNamesAsIds,
        all(
          ok,
          verdictIs("fail"),
          warnings({ includes: ["component.id.prototypeName@root > content > toString"] }),
          structure({ includes: ["component.id.reserved@root > content > constructor"], excludes: ["component.id.prototypeName", "component.id.invalid"] }),
          { op: "custom", name: "no-prototype-pollution" }
        ),
        // `constructor` and `prototype` are reserved words like a rule's scope words, refused with the
        // message that names the word.
      ),
      variant("public-op-does-not-pollute", protoKeys, all(ok, { op: "custom", name: "no-prototype-pollution" }), { input: request("public"), gate: ENFORCED }),
      // `component`, `host`, `row` and `ancestor` name scopes in a rule: a component given one could never be read by it.
      variant(
        "scope-words-as-ids-are-reserved",
        scopeWordsAsIds,
        all(
          ok,
          verdictIs("fail"),
          structure({
            includes: [
              "component.id.reserved@root > content > component",
              "component.id.reserved@root > content > host",
              "component.id.reserved@root > content > row",
              "component.id.reserved@root > content > row > content > ancestor"
            ]
          })
        )
      )
    ],
    applies: ON_BUILDER()
  }),
  def({
    id: "DEF-08",
    title: "A component type that is not a usable string is a structure problem; an unknown type only warns, and only when the host sent its types",
    severity: "S3",
    input: request("check"),
    fixture: textFixture(() => typeOf(5)),
    expect: refusal("component.type.invalid"),
    variants: [
      variant("empty", () => typeOf(""), refusal("component.type.invalid")),
      variant("null", () => typeOf(null), refusal("component.type.invalid")),
      variant("missing", typeMissing, refusal("component.type.invalid")),
      variant("array", () => typeOf([]), refusal("component.type.invalid")),
      variant("object", () => typeOf({}), refusal("component.type.invalid")),
      variant("129-characters", () => typeOf("t".repeat(129)), refusal("component.type.invalid")),
      variant("unknown-type-with-types-sent", () => typeOf("no-such-type"), all(ok, verdictIs("ok"), warnings({ includes: ["component.type.unknown"] }))),
      variant("unknown-type-without-types-is-silent", () => typeOf("no-such-type"), all(ok, verdictIs("ok"), warnings({ excludes: ["component.type.unknown"] })), { input: request("check", "", false), gate: ENFORCED })
    ],
    applies: ON_BUILDER()
  }),
  def({
    id: "DEF-09",
    title: "The public definition holds no server-secret rule (six rule keys, deep, object form), keeps the decoys and the field itself",
    severity: "S3",
    input: request("public", "", false),
    fixture: textFixture(() => secretRulesMatrix(2)),
    expect: all(ok, QUIET_SECRETS, { op: "textIncludes", markers: [DECOY_MARKER, '"id":"sf"', '"id":"df"'] }),
    variants: [
      variant("secret-rule-at-depth-31", () => secretRulesMatrix(31), all(ok, QUIET_SECRETS, { op: "textIncludes", markers: [DECOY_MARKER, '"id":"sf"'] })),
      variant("object-form-with-extra-keys", secretObjectForm, all(ok, { op: "textExcludes", markers: [SUITE_MARKER, "server-secret"] }, { op: "textIncludes", markers: ['"id":"sf"'] })),
      variant("a-secret-rule-in-a-slot-that-is-not-a-list-is-a-structure-problem", secretInNonListSlot, refusal("component.children.invalid"), { input: request("check") })
    ],
    applies: ON_BUILDER("the saved copy is read back anonymously (BLD-08)")
  }),
  def({
    id: "DEF-10",
    title: "A check answer about secret rules that also have structure problems says where and which code, never the rule's text or a function name it calls",
    severity: "S3",
    input: request("check"),
    fixture: textFixture(() => secretRulesMatrix(2).replace(SUITE_MARKER, `${SUITE_MARKER}secretfn`)),
    expect: all(ok, { op: "textExcludes", markers: [SUITE_MARKER, "secretfn"] }),
    variants: [
      variant("redacted-formula-problem", () => edited((definition) => definition["root"]["children"]["content"].push({ id: "sf", type: "text", configuration: {}, rules: { requiredWhen: { run: "server-secret", formula: `${SUITE_MARKER}secretfn(name) = 1` } } })), all(ok, { op: "textExcludes", markers: [SUITE_MARKER, "secretfn"] }, { op: "textIncludes", markers: ["The details of this problem are withheld.", "rules:sf:requiredWhen"] })),
      variant("with-a-duplicate-id", secretRuleOnDuplicateId, all(ok, { op: "textExcludes", markers: [SUITE_MARKER, "secretfn"] }, structure({ includes: ["component.id.duplicate@root > content > sf"] }), size(KIB_128)))
    ],
    applies: ON_BUILDER()
  }),
  def({
    id: "DEF-11",
    title: "Journey loops, backward and unknown routes are warnings, a malformed journey is a structure problem, and a run over a looping journey ends in a typed outcome",
    severity: "S2",
    input: request("check"),
    fixture: textFixture(journeyLoops),
    limits: { programBudgetMultiple: 4 },
    expect: all(
      ok,
      verdictIs("ok"),
      warnings({ includes: ["journey.route.backward@journey:main:page:b:route:*", "journey.route.unknownTarget@journey:main:page:b:route:*", "journey.page.unknownComponent@journey:main:page:c"] }),
      size(KIB_128)
    ),
    variants: [
      variant("pages-not-a-list", journeyPagesNotAList, refusal("journey.invalid")),
      variant("duplicate-page-id", journeyDuplicatePageId, refusal("journey.page.duplicateId")),
      // A journey or a page whose id the translations map cannot key keeps texts no one can translate.
      variant("reserved-journey-and-page-ids", journeyReservedIds, all(refusal("journey.id.reserved", "journey:constructor"), refusal("journey.page.id.reserved"))),
      variant("a-1000-page-chain-checks-in-budget", () => journeyChain(1000), all(ok, verdictIs("ok"), size(KIB_128)), { gate: ENFORCED, programOnly: true }),
      {
        id: "a-run-over-a-looping-journey-ends-typed",
        gate: ENFORCED,
        fixture: using(journeyLoops),
        input: { kind: "values", values: { name: "Ada Lovelace", code: "AB1234", "addr.city": "Ottawa", "addr.pick": "ok" }, journey: loopsJourney },
        expect: { op: "custom", name: "typed-outcome" },
        programOnly: true
      }
    ],
    applies: ON_BUILDER("the loops definition is accepted; a malformed journey is refused")
  }),
  def({
    id: "DEF-12",
    title: "Formula problems: an unknown function or a risky pattern is reported by where and code, and the verdict follows the formulaErrors word (a server rule's unknown function fails under every word)",
    severity: "S3",
    input: request("check"),
    fixture: textFixture(unknownBrowserFunction),
    expect: all(ok, verdictIs("fail"), problems({ includes: ["unknownFunction@rules:fx:visibleWhen"] })),
    variants: [
      variant("unparsable-formula", unparsableVisibleWhen, all(ok, verdictIs("fail"))),
      variant("risky-pattern", riskyMatches, all(ok, verdictIs("fail"), problems({ includes: ["pattern.risky"] }))),
      variant("browser-function-under-warn", unknownBrowserFunction, all(ok, verdictIs("warn")), { input: request("check", ',"formulaErrors":"warn"') }),
      variant("server-function-under-warn-still-fails", unknownServerFunction, all(ok, verdictIs("fail")), { input: request("check", ',"formulaErrors":"warn"') }),
      // A rule written as a tree goes through the same guards as the formula.
      variant(
        "tree-calling-an-unknown-function",
        () => edited((def) => contentOf(def).push({ id: "tx", type: "text", configuration: {}, rules: { visibleWhen: { kind: "call", name: "noSuchFunction", args: [] } } })),
        all(ok, verdictIs("fail"), problems({ includes: ["unknownFunction@rules:tx:visibleWhen"] })),
        { gate: ENFORCED }
      ),
      variant(
        "tree-calling-an-unknown-function-under-warn-still-fails",
        () => edited((def) => contentOf(def).push({ id: "tx", type: "text", configuration: {}, rules: { visibleWhen: { expression: { kind: "call", name: "noSuchFunction", args: [] }, run: "server" } } })),
        all(ok, verdictIs("fail")),
        { input: request("check", ',"formulaErrors":"warn"'), gate: ENFORCED }
      ),
      variant(
        "malformed-tree",
        () => edited((def) => contentOf(def).push({ id: "tx", type: "text", configuration: {}, rules: { visibleWhen: { kind: "logical", operator: "and" } } })),
        all(ok, verdictIs("fail"), problems({ includes: ["invalidRule@rules:tx:visibleWhen"] })),
        { gate: ENFORCED }
      ),
      variant("structure-refusal-under-warn-fails", unparsableWithStructureProblem, all(ok, verdictIs("fail"), structure({ includes: ["component.id.duplicate"] })), { input: request("check", ',"formulaErrors":"warn"') })
    ],
    applies: ON_BUILDER("the save follows the form's own formulaErrors word (fail on the fixture)")
  }),
  def({
    id: "DEF-13",
    title: "9,000 duplicate ids give a bounded answer: at most 201 entries, the last one marks the cut, short paths, under 128 KiB",
    severity: "S2",
    input: request("check"),
    fixture: textFixture(() => manyDuplicateIds(9000)),
    limits: { programBudgetMultiple: 4, nodeBudgetMs: 2500 },
    expect: all(ok, structure({ max: 201, last: "definition.problemsTruncated" }), size(KIB_128), { op: "custom", name: "problem-lists-bounded" }),
    applies: ON_BUILDER("a 600 KB definition; the save is refused with at most 201 kernel entries", true)
  }),
  def({
    id: "DEF-14",
    title: "Hostile ids, types and versions are structure problems, and the answer stays valid JSON with short, printable paths",
    severity: "S3",
    input: request("check"),
    fixture: textFixture(() => hostileId("a:b")),
    expect: all(refusal("component.id.invalid"), { op: "custom", name: "problem-lists-bounded" }),
    variants: [
      variant("angle", () => hostileId("a>b"), all(refusal("component.id.invalid"), { op: "custom", name: "problem-lists-bounded" })),
      variant("quote", () => hostileId('a"b'), all(refusal("component.id.invalid"), { op: "custom", name: "problem-lists-bounded" })),
      variant("nul", () => hostileId("a\u0000b"), all(refusal("component.id.invalid"), { op: "custom", name: "problem-lists-bounded" })),
      variant("line-separator", () => hostileId("a b"), all(refusal("component.id.invalid"), { op: "custom", name: "problem-lists-bounded" })),
      variant("lone-surrogate", loneSurrogateId, all(refusal("component.id.invalid"), { op: "custom", name: "problem-lists-bounded" })),
      // A request this size may be cut off by the evaluation budget (a typed refusal); if it is answered, the answer is bounded.
      variant(
        "one-mebibyte-id",
        () => hostileId("i".repeat(1_048_576)),
        { op: "any", of: [all(refusal("component.id.invalid"), size(KIB_128), { op: "custom", name: "problem-lists-bounded" }), { op: "refusal", anyOf: ["budget", "too_large", "too_deep"] }] },
        { programOnly: true }
      ),
      variant("version-65-characters", () => versionOfLength(65), refusal("definition.version.tooLong")),
      variant("definition-id-129-characters", () => definitionIdOfLength(129), refusal("definition.id.invalid"))
    ],
    applies: ON_BUILDER()
  }),
  def({
    id: "DEF-15",
    title: "The same definition checked twice, or between two others, gets byte-identical answers",
    severity: "S3",
    attacker: "network",
    input: { kind: "series", compareSteps: true, steps: [request("check"), request("check")] },
    fixture: textFixture(dupIdSiblings),
    expect: { op: "custom", name: "series-repeats-identically" },
    variants: [
      variant("proto-keys", protoKeys, { op: "custom", name: "series-repeats-identically" }),
      variant("journey-loops", journeyLoops, { op: "custom", name: "series-repeats-identically" }),
      variant("secret-rules-public", () => secretRulesMatrix(2), { op: "custom", name: "series-repeats-identically" }, { input: { kind: "series", compareSteps: true, steps: [request("public"), request("public")] } })
    ]
  }),
  def({
    id: "DEF-16",
    title: "A localization, pdf or other section of the wrong shape is a structure problem",
    severity: "S3",
    input: request("check"),
    fixture: textFixture(() => badLocalization([])),
    expect: refusal("localization.invalid"),
    variants: [
      variant("supportedLocales-is-text", () => badLocalization({ supportedLocales: "en" }), refusal("localization.invalid")),
      variant("locale-entries-are-numbers", () => badLocalization({ supportedLocales: [5] }), refusal("localization.invalid")),
      variant("locale-code-with-a-space", () => badLocalization({ supportedLocales: [{ code: "x y" }] }), refusal("localization.invalid")),
      variant("locale-code-36-characters", () => badLocalization({ supportedLocales: [{ code: "a".repeat(36) }] }), refusal("localization.invalid")),
      variant("pdf-is-a-number", () => badPdf(5), { op: "any", of: [refusal("definition.section.invalid"), refusal("pdf.invalid")] }),
      variant("pdf-layouts-is-text", () => badPdf({ layouts: "x" }), refusal("pdf.invalid")),
      variant("pdf-layouts-without-a-kind", () => badPdf({ layouts: [{ id: "a" }] }), refusal("pdf.layout.invalid")),
      variant("pdf-duplicate-layout-ids", () => badPdf({ layouts: [{ id: "a", kind: "generated", root: { id: "r", type: "page" } }, { id: "a", kind: "generated", root: { id: "r", type: "page" } }] }), refusal("pdf.layout.duplicateId")),
      variant("pdf-layout-id-reserved", () => badPdf({ layouts: [{ id: "constructor", kind: "generated", root: { id: "r", type: "page" } }] }), refusal("pdf.layout.id.reserved", "pdf:constructor")),
      // Limits that contradict each other: the run ignores the pair, and the check says so without refusing.
      variant(
        "inverted-limits-only-warn",
        () => edited((def) => contentOf(def).push(textComponent("lim", { minLength: 5, maxLength: 2 }), { id: "num", type: "number", configuration: { min: 10, max: 1 } })),
        all(ok, verdictIs("ok"), warnings({ includes: ["component.limits.inverted@root > content > lim", "component.limits.inverted@root > content > num"] }))
      ),
      variant("pdf-layout-id-129-characters", () => badPdf({ layouts: [{ id: "a".repeat(129), kind: "generated", root: { id: "r", type: "page" } }] }), refusal("pdf.layout.idTooLong")),
      variant("sections-of-the-wrong-type", badSections, refusal("definition.section.invalid")),
      // A field pattern that does not compile: no answer can match it, so every run refuses each one.
      variant("pattern-that-does-not-compile", () => edited((def) => contentOf(def).push(textComponent("px", { pattern: "(?i)abc" }))), refusal("component.pattern.invalid", "root > content > px")),
      // Chrome part ids key their translations: required and unique across header, footer and groups.
      variant(
        "chrome-part-ids-missing-or-repeated",
        () =>
          edited((def) => {
            def["root"]["configuration"] = {
              ...(def["root"]["configuration"] ?? {}),
              chrome: { header: [{ id: "x", type: "text", text: "Welcome" }, { type: "text", text: "No id" }], footer: [{ id: "x", type: "text", text: "Privacy" }] }
            };
          }),
        all(refusal("chrome.part.id.duplicate", "chrome:header:0"), refusal("chrome.part.id.missing", "chrome:header:1"), refusal("chrome.part.id.duplicate", "chrome:footer:0"))
      ),
      // The form's own scenarios are a key the kernel reads.
      variant(
        "tests-block-is-a-known-key",
        () =>
          edited((def) => {
            def["tests"] = { scenarios: [{ id: "s", source: 'test "s"\n  submit\n' }] };
          }),
        all(ok, warnings({ excludes: ["definition.key.unknown"] })),
        { gate: ENFORCED }
      ),
      // The type → base map: a known key; a usable entry makes its type known;
      // a base that is not an engine type, or an entry for an engine type, is refused.
      variant(
        "kinds-map-is-a-known-key",
        () =>
          edited((def) => {
            def["kinds"] = { "gcds-date": "date" };
            contentOf(def).push({ id: "when", type: "gcds-date", configuration: { label: "When" } });
          }),
        all(ok, warnings({ excludes: ["definition.key.unknown", "component.type.unknown@root > content > when"] })),
        { programOnly: true }
      ),
      variant("kinds-base-not-an-engine-type", () => edited((def) => { def["kinds"] = { "gcds-date": "calendar" }; }), refusal("kinds.base.invalid", "definition.kinds"), { programOnly: true }),
      variant("kinds-entry-for-an-engine-type", () => edited((def) => { def["kinds"] = { date: "text" }; }), refusal("kinds.type.engine", "definition.kinds"), { programOnly: true }),
      variant("kinds-is-a-list", () => edited((def) => { def["kinds"] = ["date"]; }), refusal("kinds.invalid", "definition.kinds"), { programOnly: true }),
      // root.configuration.validateOn: an unknown word reads as the default and draws a warning, never a refusal.
      variant("validate-on-unknown-word-warns", () => edited((def) => { def["root"]["configuration"] = { ...(def["root"]["configuration"] ?? {}), validateOn: "blur" }; }), all(ok, verdictIs("ok"), warnings({ includes: ["validateOn.invalid@root.configuration.validateOn"] })), { programOnly: true }),
      variant("validate-on-submit-is-silent", () => edited((def) => { def["root"]["configuration"] = { ...(def["root"]["configuration"] ?? {}), validateOn: "submit" }; }), all(ok, warnings({ excludes: ["validateOn.invalid"] })), { programOnly: true })
    ],
    applies: ON_BUILDER()
  })
];
