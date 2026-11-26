/**
 * Coverage of the form's rules by its scenarios. The list of rules is the
 * Logic workspace's own (`buildLogicModel`, journeys and PDF layouts included), so a rule the
 * builder shows is a rule the report counts. A rule is exercised when a scenario that ran
 * (passed, failed or parity; a skipped or errored one proved nothing) holds an expectation that
 * reads what the rule decides. That is a statement of reach, not of correctness: a failing
 * scenario still reached the rule, which is the point of listing it as covered.
 *
 * Kinds `default`, `filter` and `gate` are left out: the language has no expectation that reads
 * a start value, an option filter or a step's gating, so listing them would make every form
 * look partly untested for something no scenario can say. They join when the language does.
 */
import type { FormTestExpectation, FormTestScenario } from "../../core/form-tests/form-test-types.js";
import { findJourney, readJourneys } from "../../core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import { buildComponentIdsByPath, buildRowKeys } from "../../core/tree/data-scope.js";
import type { BuilderTextOptions } from "./builder-texts.js";
import { buildLogicModel } from "./logic-model.js";
import type { LogicRule, LogicRuleKind, LogicToken } from "./logic-types.js";

/**
 * The status a scenario came to, as the report names it (the form-test package's `ScenarioStatus`
 * has the same five words). The engine owns the type, so the builder's Tests panel and the
 * command line read one module.
 */
export type CoverageScenarioStatus = "passed" | "failed" | "skipped" | "error" | "parity";

/** A scenario with the status it came to, as coverage reads it. */
export interface CoveredScenario {
  scenario: FormTestScenario;
  status: CoverageScenarioStatus;
}

export interface CoverageRule {
  /** The Logic model's stable rule id (`<source>:<owner id>:<rule key>[:<index>]`). */
  id: string;
  /** The Logic model's kind (`show`, `require`, `validate`, `calculate`, `route`, `pdf-layout`, ...). */
  kind: string;
  ruleKey: string;
  target: { id: string; label: string; type: string };
  formula: string;
  /** The rule as one sentence (the Logic model's `sentence`, flattened to text). */
  sentence: string;
  /** The names of the scenarios that reached it, in the order given. */
  scenarios: string[];
}

export interface CoverageReport {
  rules: CoverageRule[];
  tested: number;
  untested: number;
}

/**
 * Which scenarios count as having reached a rule. `ran` is the command line's reading (a scenario
 * that passed, failed or differed between the sides; a skipped or errored one proved nothing).
 * `written` counts every parsed scenario whatever its status: the Tests panel shows pins before
 * the first run, and a scenario that has not run yet still says what the author meant to pin.
 */
export type CoverageReach = "ran" | "written";

export interface CoverageOptions {
  reach?: CoverageReach;
  /**
   * The language and catalog the rules' sentences are worded in, as the Logic workspace words
   * them: the builder's Tests panel passes its own, so its rules view reads in the builder's
   * language. Absent: English with no catalog, the command line's report.
   */
  text?: Pick<BuilderTextOptions, "locale" | "catalog">;
}

/** The rule kinds a scenario can exercise today; the rest are not listed (see the header). */
export const COVERABLE_KINDS: readonly LogicRuleKind[] = [
  "show",
  "hide",
  "require",
  "enable",
  "readonly",
  "validate",
  "calculate",
  "min-rows",
  "max-rows",
  "show-step",
  "hide-step",
  "route",
  "pdf-layout"
];

/** The statuses that count as having reached a rule. */
const RAN: ReadonlySet<CoverageScenarioStatus> = new Set<CoverageScenarioStatus>(["passed", "failed", "parity"]);

/** Names the component ids an expectation's path may be about. */
export type PathReader = (path: string) => ReadonlySet<string>;

/** A path with its row indices removed, split into segments: `items[0].qty` is `items`, `qty`. */
function segmentsOf(path: string): string[] {
  return path.replace(/\[[^\]]*\]/g, "").split(".").filter((segment) => segment !== "");
}

/**
 * Without a definition to read, a path is about the component its first segment names (the
 * field, the section) or its last (a field of a row). With one, `pathReaderOf` also follows
 * data keys and containers, where the stored segment is not the component's id.
 */
const LITERAL_PATH_READER: PathReader = (path) => {
  const segments = segmentsOf(path);
  const names = new Set<string>();
  if (segments[0] !== undefined) {
    names.add(segments[0]);
  }
  if (segments.length > 0) {
    names.add(segments[segments.length - 1] as string);
  }
  return names;
};

export function pathReaderOf(root: ComponentNode): PathReader {
  const byPath = buildComponentIdsByPath(root);
  const idsByRowKey = new Map<string, string[]>();
  for (const [id, key] of buildRowKeys(root)) {
    const ids = idsByRowKey.get(key);
    if (ids) {
      ids.push(id);
    } else {
      idsByRowKey.set(key, [id]);
    }
  }
  return (path) => {
    const names = new Set(LITERAL_PATH_READER(path));
    const segments = segmentsOf(path);
    for (let end = 1; end <= segments.length; end += 1) {
      for (const id of byPath.get(segments.slice(0, end).join(".")) ?? []) {
        names.add(id);
      }
    }
    // A field of a row is keyed inside the entry (`address.city`), not by the path's own tail.
    const close = path.indexOf("]");
    if (close >= 0) {
      const inRow = segmentsOf(path.slice(close + 1)).join(".");
      for (const id of idsByRowKey.get(inRow) ?? []) {
        names.add(id);
      }
    }
    return names;
  };
}

function names(expectation: { path: string }, read: PathReader, target: string): boolean {
  return read(expectation.path).has(target);
}

/** Whether the scenario's `expect <formula>` on `line` names the target among the paths it reads. */
function formulaReads(scenario: FormTestScenario, line: number, read: PathReader, target: string): boolean {
  return scenario.refs.some((ref) => ref.kind === "path" && ref.span.line === line && read(ref.text).has(target));
}

function exercises(rule: LogicRule, expectation: FormTestExpectation, scenario: FormTestScenario, read: PathReader): boolean {
  const target = rule.target.id;
  switch (rule.kind) {
    case "show":
    case "hide":
    case "show-step":
    case "hide-step":
      return expectation.kind === "expectState" && (expectation.state === "visible" || expectation.state === "hidden") && names(expectation, read, target);
    case "require":
      return expectation.kind === "expectState" && (expectation.state === "required" || expectation.state === "optional") && names(expectation, read, target);
    case "enable":
      return expectation.kind === "expectState" && (expectation.state === "enabled" || expectation.state === "disabled") && names(expectation, read, target);
    case "readonly":
      return expectation.kind === "expectState" && (expectation.state === "editable" || expectation.state === "readonly") && names(expectation, read, target);
    case "validate":
      if (expectation.kind === "expectError") {
        return expectation.code === "rule" && names(expectation, read, target);
      }
      // `expect no errors` says nothing about one field, but it is a verdict on all of them.
      return expectation.kind === "expectNoError" && (expectation.path === undefined || names({ path: expectation.path }, read, target));
    case "calculate":
      if (expectation.kind === "expectValue") {
        return names(expectation, read, target);
      }
      return expectation.kind === "expectFormula" && formulaReads(scenario, expectation.line, read, target);
    case "min-rows":
    case "max-rows": {
      // The codes the grid's row-count errors carry on both sides (field-constraints.ts and the
      // kernel's fold), not the rule keys `minRows` / `maxRows` they come from.
      const code = rule.kind === "min-rows" ? "rows.min" : "rows.max";
      if (expectation.kind === "expectError") {
        return expectation.code === code && names(expectation, read, target);
      }
      return expectation.kind === "expectRows" && names(expectation, read, target);
    }
    case "route": {
      if (expectation.kind !== "expectPath" || rule.source.mode !== "journeys") {
        return false;
      }
      const from = rule.source.pageId;
      const pages = expectation.pages;
      return pages.some((page, at) => page === from && pages[at + 1] === target);
    }
    case "pdf-layout":
      return expectation.kind === "expectLayout" && expectation.layout === target;
    default:
      return false;
  }
}

/**
 * Whether the scenario ran the journey a page or route rule belongs to. Two journeys may hold a
 * page of one id, each with its own condition, so the page id alone would credit one journey's
 * scenario to the other's rule. The journey a scenario runs is its
 * `given journey`, else the definition's default (`findJourney`); `none` runs no journey. When
 * the default is unknown (a caller with no definition), a scenario with no `given journey` is
 * not held against the rule.
 */
function ranJourney(rule: LogicRule, scenario: FormTestScenario, defaultJourneyId: string | undefined): boolean {
  if (rule.source.mode !== "journeys") {
    return true;
  }
  const given = scenario.givens.find((entry) => entry.kind === "given" && entry.key === "journey");
  const used = given !== undefined && given.kind === "given" && given.key === "journey" ? given.value : defaultJourneyId;
  return used === undefined || used === rule.source.journeyId;
}

/**
 * Whether any expectation of the scenario reads what the rule decides, by the rule's kind. The
 * scenario's own status is not looked at here (`coverageOf` does that). `read` says which
 * components a path is about; the default knows only the path's first and last segment.
 * `defaultJourneyId` is the journey a scenario with no `given journey` runs.
 */
export function coversRule(rule: LogicRule, scenario: FormTestScenario, read: PathReader = LITERAL_PATH_READER, defaultJourneyId?: string): boolean {
  if (!COVERABLE_KINDS.includes(rule.kind)) {
    return false;
  }
  if (!ranJourney(rule, scenario, defaultJourneyId)) {
    return false;
  }
  if (rule.kind === "route" && rule.target.type === "journey-end" && rule.source.mode === "journeys") {
    // No expectation lists the end of a journey as a page, so a route to it is reached by two
    // statements together: the path stops at the route's page and then runs off the end (an
    // `expect path ends` with no exit page).
    const from = rule.source.pageId;
    return (
      scenario.steps.some((step) => step.kind === "expectPath" && step.pages[step.pages.length - 1] === from) &&
      scenario.steps.some((step) => step.kind === "expectPathEnd" && step.exit === undefined)
    );
  }
  return scenario.steps.some((step) => {
    const kind = step.kind;
    if (!kind.startsWith("expect")) {
      return false;
    }
    return exercises(rule, step as FormTestExpectation, scenario, read);
  });
}

function sentenceText(tokens: readonly LogicToken[]): string {
  return tokens.map((token) => token.text).join("");
}

/**
 * Coverage of one form: the Logic model's coverable rules in the model's order, each with the
 * names of the scenarios that reached it, and the counts. The model is built the way the Logic
 * workspace builds it (the definition supplies journeys and PDF layouts), English with no label
 * catalog unless `options.text` names a language: the report words rules from the form's own
 * labels. `options.reach` picks which scenarios count (see {@link CoverageReach}); the default is
 * the command line's, `ran`.
 */
export function coverageOf(definition: FormDefinition, scenarios: readonly CoveredScenario[], options: CoverageOptions = {}): CoverageReport {
  const text = options.text;
  const model = buildLogicModel(definition.root, {
    definition,
    ...(text?.locale !== undefined ? { locale: text.locale } : {}),
    ...(text?.catalog !== undefined ? { catalog: text.catalog } : {})
  });
  const read = pathReaderOf(definition.root);
  const counted = options.reach === "written" ? scenarios : scenarios.filter((entry) => RAN.has(entry.status));
  // A default the definition names but does not have falls to the first journey, as the kernel's selection does.
  const defaultJourneyId = (findJourney(definition) ?? readJourneys(definition)[0])?.id;
  const rules: CoverageRule[] = [];
  let tested = 0;
  for (const rule of model.rules) {
    if (!COVERABLE_KINDS.includes(rule.kind)) {
      continue;
    }
    const reached = counted.filter((entry) => coversRule(rule, entry.scenario, read, defaultJourneyId)).map((entry) => entry.scenario.name);
    if (reached.length > 0) {
      tested += 1;
    }
    rules.push({
      id: rule.id,
      kind: rule.kind,
      ruleKey: rule.ruleKey,
      target: { id: rule.target.id, label: rule.target.label, type: rule.target.type },
      formula: rule.formula,
      sentence: sentenceText(rule.sentence),
      scenarios: reached
    });
  }
  return { rules, tested, untested: rules.length - tested };
}
