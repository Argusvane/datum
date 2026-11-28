/**
 * The words of the Tests panel: the engine reports codes and data,
 * never sentences, so every sentence an author reads in the panel is made here from the
 * builder's catalog, with the form's own names for fields, pages and layouts ("Registered
 * agent", not `registered_agent`). One table per code, as the CLI's `report/words.ts` has, but
 * worded for the person editing the form: the failure card says what was expected and what the
 * form does, the list says one line per scenario.
 *
 * The catalog is `tests-texts-en.ts`; a host's catalog (`text: { locale, catalog }`) overrides
 * any key, and a code this version does not know still reads (its code, or the parser's own
 * English for a problem), so a code without words degrades to something an author can search
 * for.
 */
import { kernelFormTestMessage } from "../../core/form-tests/form-test-parse.js";
import { FORM_TEST_MAX_STEPS } from "../../core/form-tests/form-test-types.js";
import type { FormTestProblem, FormTestScenario, FormTestScenarioResult, FormTestStepResult } from "../../core/form-tests/form-test-types.js";
import type { FormTestLint } from "../../core/form-tests/form-test-lint.js";
import { readJourneys } from "../../core/schema/journey.js";
import type { LocalizedText } from "../../core/schema/contracts.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import { buildDataPaths, buildValuePaths } from "../../core/tree/data-scope.js";
import { formulaErrorText, type BuilderTextKey } from "../logic/builder-texts.js";
import type { TestsEntryModel, TestsEntryStatus, TestsNaming, TestsWords, TestsWordsOptions } from "./tests-model.js";
import { testsLiteral, testsStringLiteral } from "./tests-accept.js";
import { builderPlural, builderText, formatListText } from "./tests-texts-en.js";

type Params = Record<string, string | number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** The text of a localized value in its default language, or `undefined` when it has none. */
function plainText(value: LocalizedText | unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value;
  }
  if (isRecord(value) && typeof value["default"] === "string" && value["default"].trim() !== "") {
    return value["default"];
  }
  return undefined;
}

// --- the form's names ---------------------------------------------------------------------------

/**
 * The form's names for what a test names. A field is found by its value path (what the language
 * reads, a row's index dropped: `items[1].qty` is the `qty` field) and by its id; its name is the
 * `label` configuration, else the id. A page is named by its title, a layout by its name; a
 * thing the form does not have is `undefined` and the sentence shows what the test wrote.
 */
export function createTestsNaming(root: ComponentNode, definition?: FormDefinition): TestsNaming {
  const byId = new Map<string, ComponentNode>();
  const walk = (node: ComponentNode): void => {
    byId.set(node.id, node);
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child);
      }
    }
  };
  walk(root);
  const idByPath = new Map<string, string>();
  for (const [id, path] of buildValuePaths(root)) {
    if (id !== root.id && !idByPath.has(path)) {
      idByPath.set(path, id);
    }
  }
  // A row's field is found by where its entries live (`items[].qty`); the value path of a field in
  // a repeating section carries no row, so `items[1].qty` would match nothing else.
  const idByDataPath = new Map<string, string>();
  for (const [id, path] of buildDataPaths(root)) {
    if (id !== root.id && !idByDataPath.has(path)) {
      idByDataPath.set(path, id);
    }
  }
  const nameOf = (node: ComponentNode): string => {
    const configuration = node.configuration;
    return (isRecord(configuration) ? plainText(configuration["label"]) : undefined) ?? node.id;
  };
  const journeys = definition === undefined ? [] : readJourneys(definition);
  const layouts = definition?.pdf?.layouts ?? [];
  return {
    labelOf(path) {
      const id = idByPath.get(path.replace(/\[\d+\]/g, "")) ?? idByDataPath.get(path.replace(/\[\d+\]/g, "[]"));
      const node = byId.get(id ?? path);
      return node === undefined ? undefined : nameOf(node);
    },
    pageLabelOf(pageId) {
      for (const journey of journeys) {
        const page = journey.pages.find((entry) => entry.id === pageId);
        if (page !== undefined) {
          return plainText(page.title);
        }
      }
      return undefined;
    },
    layoutLabelOf(layoutId) {
      const layout = layouts.find((entry) => entry.id === layoutId);
      return layout === undefined ? undefined : plainText(layout.name);
    }
  };
}

// --- literals as a sentence says them ------------------------------------------------------------

const LITERAL_LIMIT = 80;

function cut(text: string): string {
  return text.length > LITERAL_LIMIT ? `${text.slice(0, LITERAL_LIMIT - 1)}…` : text;
}

/** A pair of keys for one failed expectation: the `what` that was expected and what was `found`. */
interface Pieces {
  what: string;
  found: string;
}

/** The sentence parts of a step, or a sentence that stands alone. */
type Worded = Pieces | { sentence: string };

const STATE_OF_CODE: Record<string, { wanted: BuilderTextKey; found: BuilderTextKey }> = {
  "expect.visible": { wanted: "tests.word.state.visible", found: "tests.word.state.hidden" },
  "expect.hidden": { wanted: "tests.word.state.hidden", found: "tests.word.state.visible" },
  "expect.required": { wanted: "tests.word.state.required", found: "tests.word.state.optional" },
  "expect.optional": { wanted: "tests.word.state.optional", found: "tests.word.state.required" },
  "expect.enabled": { wanted: "tests.word.state.enabled", found: "tests.word.state.disabled" },
  "expect.disabled": { wanted: "tests.word.state.disabled", found: "tests.word.state.enabled" },
  "expect.readonly": { wanted: "tests.word.state.readonly", found: "tests.word.state.editable" },
  "expect.editable": { wanted: "tests.word.state.editable", found: "tests.word.state.readonly" }
};

const REFUSAL_OF: Record<string, BuilderTextKey> = {
  "rows.max": "tests.reason.refused.rows.max",
  "rows.min": "tests.reason.refused.rows.min",
  "operations.add": "tests.reason.refused.operations.add",
  "operations.remove": "tests.reason.refused.operations.remove",
  rowOutOfRange: "tests.reason.refused.rowOutOfRange",
  unknownCollection: "tests.reason.refused.unknownCollection",
  "change.notReview": "tests.reason.refused.change.notReview",
  "change.off": "tests.reason.refused.change.off",
  "change.notListed": "tests.reason.refused.change.notListed",
  "change.unreachable": "tests.reason.refused.change.unreachable"
};

const SKIP_REASON_OF: Record<string, BuilderTextKey> = {
  "unreplayable.host": "tests.reason.unreplayable.host",
  "unreplayable.server": "tests.reason.unreplayable.server",
  "unreplayable.secret": "tests.reason.unreplayable.secret",
  "unreplayable.clock": "tests.reason.unreplayable.clock",
  "unreplayable.browser": "tests.reason.unreplayable.browser",
  "unreplayable.clientDerived": "tests.reason.unreplayable.clientDerived"
};

/** The scenario-level codes: a step may carry one (the runner's too-many-steps) as well as a result. */
const SCENARIO_CODES = new Set(["scenario.clockUnset", "scenario.unknownJourney", "scenario.badGiven", "scenario.formulaInvalid", "scenario.driverFailed", "scenario.tooManySteps", "action.failed", "action.refused", "snapshot.failed"]);

function capitalize(text: string, locale: string | undefined): string {
  const first = text.charAt(0);
  if (first === "") {
    return text;
  }
  let upper = first.toUpperCase();
  try {
    upper = first.toLocaleUpperCase(locale === undefined || locale === "" ? "en" : locale);
  } catch {
    /* a locale tag the platform rejects: the plain upper case stands */
  }
  return upper + text.slice(1);
}

export function createTestsWords(options: TestsWordsOptions): TestsWords {
  const { naming } = options;
  const text = (key: BuilderTextKey, params?: Params): string => builderText(key, params, options.text);
  const plural = (base: "tests.word.rows" | "tests.reason.formulaInvalid", count: number, params?: Params): string => builderPlural(base, count, params, options.text);
  const list = (items: string[]): string => formatListText(items, { ...(options.text ?? {}), type: "conjunction" });

  // --- names ---------------------------------------------------------------------------------------

  /** A field as the sentence names it: its label, with the row when the path names one (`Quantity (row 2)`). */
  const field = (path: string | undefined): string => {
    if (path === undefined) {
      return text("tests.word.nothing");
    }
    const label = naming.labelOf(path) ?? path;
    const rows = [...path.matchAll(/\[(\d+)\]/g)];
    const last = rows[rows.length - 1];
    return last === undefined ? label : text("tests.word.inRow", { label, row: Number(last[1]) + 1 });
  };
  const page = (id: unknown): string => (typeof id === "string" ? (naming.pageLabelOf(id) ?? id) : text("tests.word.nothing"));
  const layout = (id: unknown): string => (typeof id === "string" ? (naming.layoutLabelOf(id) ?? id) : text("tests.word.layout.none"));
  const pages = (ids: unknown): string => (Array.isArray(ids) && ids.length > 0 ? ids.map(page).join(", ") : text("tests.word.noPages"));
  const param = (step: { params?: Record<string, unknown> | undefined }, key: string): string | undefined => {
    const value = step.params?.[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  };

  /** A value as a sentence says it: strings quoted, dates `@"…"`, lists in parentheses, `nothing` for no answer. */
  const literal = (value: unknown): string => {
    if (value === null || value === undefined) {
      return text("tests.word.nothing");
    }
    const written = testsLiteral(value);
    if (written !== undefined) {
      return cut(written);
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      json = undefined;
    }
    return cut(json ?? String(value));
  };
  const isEmpty = (value: unknown): boolean => value === null || value === undefined;

  const errorsWord = (entries: unknown): string => {
    const items: string[] = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (typeof entry === "string") {
        items.push(entry);
      } else if (isRecord(entry) && typeof entry["code"] === "string") {
        const where = typeof entry["path"] === "string" ? entry["path"] : typeof entry["componentId"] === "string" ? entry["componentId"] : undefined;
        items.push(where === undefined ? entry["code"] : text("tests.word.errorItem", { field: field(where), code: entry["code"] }));
      }
    }
    return list(items);
  };
  const codesWord = (codes: unknown): string => list(Array.isArray(codes) ? codes.filter((code): code is string => typeof code === "string") : []);

  const how = (end: unknown): string => {
    if (!isRecord(end)) {
      return text("tests.word.how.none");
    }
    if (end["end"] === "exit") {
      return typeof end["last"] === "string" ? text("tests.word.how.exit", { page: page(end["last"]) }) : text("tests.word.how.exitAny");
    }
    return end["end"] === "end" ? text("tests.word.how.end") : text("tests.word.how.none");
  };

  // --- why --------------------------------------------------------------------------------------------

  /** Why a scenario was skipped or could not run, from its code and the data the driver gave. */
  const reasonOfCode = (code: string, params: Record<string, unknown> | undefined): string | undefined => {
    const subject = { params };
    switch (code) {
      case "scenario.clockUnset":
        return text("tests.reason.clockUnset");
      case "scenario.unknownJourney":
        return text("tests.reason.unknownJourney", { journey: param(subject, "journey") ?? "" });
      case "scenario.badGiven": {
        const given = param(subject, "given");
        if (given === "locale") {
          return text("tests.reason.badGiven.locale", { locale: param(subject, "locale") ?? "" });
        }
        if (given === "options") {
          const path = param(subject, "path") ?? "";
          return param(subject, "reason") === "noSource"
            ? text("tests.reason.badGiven.options.noSource", { field: field(path) })
            : text("tests.reason.badGiven.options.unknownField", { path });
        }
        if (given === undefined) {
          return text("tests.reason.badGiven.plain");
        }
        const path = param(subject, "path") ?? param(subject, "name");
        return path === undefined ? text("tests.reason.badGiven.named", { given }) : text("tests.reason.badGiven.path", { given, path });
      }
      case "scenario.formulaInvalid": {
        const problems = params?.["problems"];
        return plural("tests.reason.formulaInvalid", Array.isArray(problems) && problems.length > 0 ? problems.length : 1);
      }
      case "scenario.driverFailed":
        return text("tests.reason.driverFailed");
      case "scenario.tooManySteps":
        return text("tests.reason.tooManySteps", { max: FORM_TEST_MAX_STEPS });
      case "action.failed":
        return text("tests.reason.startFailed");
      default:
        return undefined;
    }
  };

  /** A skip reason of the engine, worded for the end of "Not judged here: …". */
  const skipReason = (code: string): string => (has(SKIP_REASON_OF, code) ? text(SKIP_REASON_OF[code] as BuilderTextKey) : code);

  /** A step that could not run (a thrown action, a refused row action, a snapshot that failed). */
  const cannotRun = (step: FormTestStepResult): string => {
    const message = param(step, "message");
    let reason: string;
    switch (step.code) {
      case "action.refused": {
        const why = param(step, "reason");
        reason =
          why === undefined
            ? text("tests.reason.refused.plain")
            : has(REFUSAL_OF, why)
              ? text(REFUSAL_OF[why] as BuilderTextKey)
              : text("tests.reason.refused.other", { reason: why });
        break;
      }
      case "snapshot.failed":
        reason = message === undefined ? text("tests.reason.snapshotFailed.plain") : text("tests.reason.snapshotFailed", { message });
        break;
      case "action.failed":
        reason = message === undefined ? text("tests.reason.actionFailed.plain") : text("tests.reason.actionFailed", { message });
        break;
      default:
        reason = reasonOfCode(step.code ?? "", step.params) ?? (step.code === undefined ? "" : step.code);
    }
    // The template ends the sentence; a reason that is a sentence of its own loses its full stop.
    return reason === "" ? text("tests.word.cannotRun.plain") : text("tests.word.cannotRun", { reason: reason.replace(/\.$/, "") });
  };

  // --- one step ---------------------------------------------------------------------------------------------

  /** The two halves of a failed expectation, or a sentence that stands alone. */
  const wordStep = (step: FormTestStepResult): Worded => {
    const code = step.code ?? "";
    const named = param(step, "path");
    const who = field(named);
    const state = has(STATE_OF_CODE, code) ? (STATE_OF_CODE[code] as { wanted: BuilderTextKey; found: BuilderTextKey }) : undefined;
    if (state !== undefined) {
      return { what: text("tests.word.state.toBe", { field: who, state: text(state.wanted) }), found: text("tests.word.state.itIs", { state: text(state.found) }) };
    }
    switch (code) {
      case "expect.empty":
        return { what: text("tests.word.state.empty.what", { field: who }), found: text("tests.word.state.empty.found") };
      case "expect.notEmpty":
        return { what: text("tests.word.state.notEmpty.what", { field: who }), found: text("tests.word.state.notEmpty.found") };
      case "expect.unknownField": {
        const reason = param(step, "reason");
        const path = named ?? "";
        if (reason === "rowOutOfRange") {
          return { sentence: text("tests.word.unknownField.row", { path }) };
        }
        if (reason === "noRowScope") {
          return { sentence: text("tests.word.unknownField.noRowScope", { path }) };
        }
        const id = param(step, "id");
        return { sentence: id === undefined ? text("tests.word.unknownField", { path }) : text("tests.word.unknownField.id", { path, id }) };
      }
      case "expect.badState":
        return { sentence: text("tests.word.badState", { field: who }) };
      case "expect.badStatement":
        return { sentence: text("tests.word.badStatement") };
      case "expect.noJourney":
        return { sentence: text("tests.word.noJourney") };
      case "expect.unknownPage":
        return { sentence: text("tests.word.unknownPage", { page: param(step, "page") ?? "" }) };
      case "expect.notSubmitted":
        return { sentence: text("tests.word.notSubmitted") };
      case "expect.value": {
        if (param(step, "op") === "ne") {
          return isEmpty(step.expected)
            ? { what: text("tests.word.state.notEmpty.what", { field: who }), found: text("tests.word.state.notEmpty.found") }
            : { what: text("tests.word.value.not.what", { field: who, value: literal(step.expected) }), found: text("tests.word.value.not.found") };
        }
        if (isEmpty(step.expected)) {
          return { what: text("tests.word.value.none.what", { field: who }), found: text("tests.word.value.found", { value: literal(step.actual) }) };
        }
        return {
          what: text("tests.word.value.what", { field: who, value: literal(step.expected) }),
          found: isEmpty(step.actual) ? text("tests.word.value.foundNone") : text("tests.word.value.found", { value: literal(step.actual) })
        };
      }
      case "expect.formula": {
        const formula = param(step, "formula") ?? "";
        if (param(step, "evaluated") === "false" || step.params?.["evaluated"] === false) {
          return { sentence: text("tests.word.formula.failed", { formula }) };
        }
        return { what: text("tests.word.formula.what", { formula }), found: text("tests.word.formula.found", { value: literal(step.actual) }) };
      }
      case "expect.error": {
        const wanted = typeof step.expected === "string" ? step.expected : undefined;
        const codes = Array.isArray(step.actual) ? step.actual : [];
        return {
          what: wanted === undefined ? text("tests.word.error.whatAny", { field: who }) : text("tests.word.error.what", { field: who, code: wanted }),
          found: codes.length === 0 ? text("tests.word.error.none") : text("tests.word.error.has", { errors: codesWord(codes) })
        };
      }
      case "expect.message": {
        const messages = Array.isArray(step.actual) ? step.actual.filter((message): message is string => typeof message === "string") : [];
        return {
          what: text("tests.word.message.what", { field: who, message: testsStringLiteral(typeof step.expected === "string" ? step.expected : "") }),
          found: messages.length === 0 ? text("tests.word.message.none") : text("tests.word.message.found", { messages: list(messages.map(testsStringLiteral)) })
        };
      }
      case "expect.noError":
        return named === undefined
          ? { what: text("tests.word.noError.any.what"), found: text("tests.word.noError.any.found", { errors: errorsWord(step.actual) }) }
          : { what: text("tests.word.noError.on.what", { field: who }), found: text("tests.word.noError.on.found", { errors: errorsWord(step.actual) }) };
      case "expect.verdict":
        return {
          what: text("tests.word.verdict.what", { verdict: verdictWord(step.expected) }),
          found: text("tests.word.verdict.found", { actual: verdictWord(step.actual) })
        };
      case "expect.noVerdict":
        return { what: text("tests.word.verdict.what", { verdict: verdictWord(step.expected) }), found: text("tests.word.noVerdict.found") };
      case "expect.page":
        return { what: text("tests.word.page.what", { page: page(step.expected) }), found: text("tests.word.page.found", { actual: page(step.actual) }) };
      case "expect.path":
        return { what: text("tests.word.path.what", { pages: pages(step.expected) }), found: text("tests.word.path.found", { pages: pages(step.actual) }) };
      case "expect.pathEnd":
        return { what: text("tests.word.pathEnd.what", { how: how(step.expected) }), found: text("tests.word.pathEnd.found", { how: how(step.actual) }) };
      case "expect.onPath": {
        const name = page(param(step, "page"));
        return step.expected === true
          ? { what: text("tests.word.onPath.on.what", { page: name }), found: text("tests.word.onPath.on.found") }
          : { what: text("tests.word.onPath.off.what", { page: name }), found: text("tests.word.onPath.off.found") };
      }
      case "expect.submitted":
        return {
          what: text("tests.word.submitted.what", { field: who, value: literal(step.expected) }),
          found: isEmpty(step.actual) ? text("tests.word.submitted.foundNone") : text("tests.word.submitted.found", { value: literal(step.actual) })
        };
      case "expect.withheld":
        return {
          what: text("tests.word.withheld.what", { field: who }),
          found: has(step.params ?? {}, "sent") ? text("tests.word.withheld.foundValue", { value: literal(step.params?.["sent"]) }) : text("tests.word.withheld.found")
        };
      case "expect.rows":
        return {
          what: text("tests.word.rows.what", { field: who, rows: rowsWord(step.expected) }),
          found: text("tests.word.rows.found", { rows: rowsWord(step.actual) })
        };
      case "expect.layout":
        return {
          what: text("tests.word.layout.what", { layout: layout(step.expected) }),
          found: text("tests.word.layout.found", { actual: isEmpty(step.actual) ? text("tests.word.layout.none") : layout(step.actual) })
        };
      default:
        return { sentence: text("tests.word.unknownCode", { code: code === "" ? step.status : code }) };
    }
  };

  const verdictWord = (verdict: unknown): string =>
    verdict === "accepted" ? text("tests.word.verdict.accepted") : verdict === "refused" ? text("tests.word.verdict.refused") : literal(verdict);
  const rowsWord = (count: unknown): string => (typeof count === "number" ? plural("tests.word.rows", count) : literal(count));

  /** The step's full sentence and its short form (without the "Expected" frame), or `""` for a step that went well. */
  const sentences = (step: FormTestStepResult): { full: string; short: string } => {
    if (step.status === "passed" || step.status === "ran") {
      return { full: "", short: "" };
    }
    const code = step.code ?? "";
    if (step.status === "skipped") {
      const sentence = code === "" ? text("tests.word.notJudged.plain") : text("tests.word.notJudged", { reason: skipReason(code) });
      return { full: sentence, short: sentence };
    }
    if (step.status === "error" || SCENARIO_CODES.has(code)) {
      const sentence = cannotRun(step);
      return { full: sentence, short: sentence };
    }
    const worded = wordStep(step);
    if ("sentence" in worded) {
      return { full: worded.sentence, short: worded.sentence };
    }
    return {
      full: text("tests.word.expected", { what: worded.what, found: worded.found }),
      short: capitalize(text("tests.word.expectedShort", { what: worded.what, found: worded.found }), options.text?.locale)
    };
  };

  // --- the two sides of a failure -----------------------------------------------------------------------------

  const stepSides = (step: FormTestStepResult): { expected: string; actual: string } | undefined => {
    const code = step.code ?? "";
    const state = has(STATE_OF_CODE, code) ? (STATE_OF_CODE[code] as { wanted: BuilderTextKey; found: BuilderTextKey }) : undefined;
    if (state !== undefined) {
      return { expected: text(state.wanted), actual: text(state.found) };
    }
    switch (code) {
      case "expect.empty":
        return { expected: text("tests.word.side.empty"), actual: text("tests.word.side.hasAnswer") };
      case "expect.notEmpty":
        return { expected: text("tests.word.side.hasAnswer"), actual: text("tests.word.side.empty") };
      case "expect.value":
        return param(step, "op") === "ne"
          ? { expected: text("tests.word.value.not.side", { value: literal(step.expected) }), actual: literal(step.actual) }
          : { expected: literal(step.expected), actual: literal(step.actual) };
      case "expect.formula":
        return { expected: text("tests.word.formula.side"), actual: literal(step.actual) };
      case "expect.error": {
        const wanted = typeof step.expected === "string" ? step.expected : undefined;
        const codes = Array.isArray(step.actual) ? step.actual : [];
        return {
          expected: wanted === undefined ? text("tests.word.error.sideAny") : text("tests.word.error.side", { code: wanted }),
          actual: codes.length === 0 ? text("tests.word.error.sideNone") : codesWord(codes)
        };
      }
      case "expect.message":
        return { expected: literal(step.expected), actual: Array.isArray(step.actual) && step.actual.length > 0 ? list(step.actual.map((message) => literal(message))) : text("tests.word.nothing") };
      case "expect.noError":
        return { expected: text("tests.word.noError.side"), actual: errorsWord(step.actual) };
      case "expect.verdict":
      case "expect.noVerdict":
        return { expected: verdictWord(step.expected), actual: step.actual === undefined ? text("tests.word.nothing") : verdictWord(step.actual) };
      case "expect.page":
        return { expected: page(step.expected), actual: page(step.actual) };
      case "expect.path":
        return { expected: pages(step.expected), actual: pages(step.actual) };
      case "expect.pathEnd":
        return { expected: how(step.expected), actual: how(step.actual) };
      case "expect.onPath":
        return {
          expected: text(step.expected === true ? "tests.word.onPath.side.on" : "tests.word.onPath.side.off"),
          actual: text(step.actual === true ? "tests.word.onPath.side.on" : "tests.word.onPath.side.off")
        };
      case "expect.submitted":
        return {
          expected: text("tests.word.submitted.side", { value: literal(step.expected) }),
          actual: isEmpty(step.actual) ? text("tests.word.submitted.sideNone") : text("tests.word.submitted.side", { value: literal(step.actual) })
        };
      case "expect.withheld":
        return {
          expected: text("tests.word.withheld.side"),
          actual: has(step.params ?? {}, "sent") ? text("tests.word.withheld.sideValue", { value: literal(step.params?.["sent"]) }) : text("tests.word.withheld.sideSent")
        };
      case "expect.rows":
        return { expected: rowsWord(step.expected), actual: rowsWord(step.actual) };
      case "expect.layout":
        return { expected: layout(step.expected), actual: isEmpty(step.actual) ? text("tests.word.layout.none") : layout(step.actual) };
      default:
        return undefined;
    }
  };

  // --- a problem ------------------------------------------------------------------------------------------------

  /** ` "token"` when the parser named the text it stopped at, else nothing. */
  const tokenOf = (params: Record<string, string | number> | undefined): string => {
    const token = params?.["token"];
    return typeof token === "string" && token !== "" ? ` "${token}"` : "";
  };

  const sentenceOfProblem = (problem: FormTestProblem): string => {
    const params = problem.params;
    const str = (key: string): string => String(params?.[key] ?? "");
    const given = (key: string): boolean => typeof params?.[key] === "string" && params[key] !== "";
    switch (problem.code) {
      case "unknownStatement":
        return given("word") ? text("tests.problem.unknownStatement", { word: str("word") }) : text("tests.problem.unknownStatement.plain");
      case "expectedName":
        return text("tests.problem.expectedName");
      case "duplicateName":
        return text("tests.problem.duplicateName", { name: str("name") });
      case "expectedPath":
        return text("tests.problem.expectedPath", { token: tokenOf(params) });
      case "expectedValue":
        return params?.["expected"] === "list" ? text("tests.problem.expectedValue.list") : text("tests.problem.expectedValue", { token: tokenOf(params) });
      case "expectedPage":
        return text("tests.problem.expectedPage", { token: tokenOf(params) });
      case "expectedNumber":
        return text("tests.problem.expectedNumber", { token: tokenOf(params) });
      case "expectedEquals":
        return text("tests.problem.expectedEquals");
      case "expectedKeyword":
        return given("token")
          ? text("tests.problem.expectedKeyword.found", { expected: str("expected"), token: str("token") })
          : text("tests.problem.expectedKeyword", { expected: str("expected") });
      case "badState":
        return text("tests.problem.badState", { word: str("word") });
      case "badCode":
        return given("code") ? text("tests.problem.badCode.found", { code: str("code") }) : text("tests.problem.badCode");
      case "badGiven":
        return given("key") ? text("tests.problem.badGiven.key", { key: str("key") }) : text("tests.problem.badGiven");
      case "givenAfterStep":
        return text("tests.problem.givenAfterStep");
      case "duplicateGiven":
        return text("tests.problem.duplicateGiven", { key: str("key") === "" ? "that" : str("key") });
      case "skipAfterStep":
        return text("tests.problem.skipAfterStep");
      case "stepOutsideTest":
        return text("tests.problem.stepOutsideTest");
      case "unterminatedString":
        return params?.["curly"] === 1 ? text("tests.problem.unterminatedString.curly") : text("tests.problem.unterminatedString");
      case "unclosedList":
        return params?.["tooDeep"] === 1 ? text("tests.problem.unclosedList.tooDeep") : text("tests.problem.unclosedList");
      case "badFormula": {
        const code = params?.["formulaCode"];
        if (typeof code !== "string") {
          return text("tests.problem.badFormula");
        }
        const rest: Params = {};
        for (const key of Object.keys(params ?? {})) {
          if (key !== "formulaCode") {
            rest[key] = (params as Params)[key] as string | number;
          }
        }
        return text("tests.problem.badFormula.why", { why: formulaErrorText(code, rest, options.text) });
      }
      case "trailingText":
        return text("tests.problem.trailingText", { token: tokenOf(params) });
      case "tooLong":
        return text("tests.problem.tooLong", { max: typeof params?.["max"] === "number" ? params["max"] : 200000 });
      default:
        // A code a newer parser added: the parser's own English, so the line still says something.
        return kernelFormTestMessage(problem.code, params);
    }
  };

  const problem = (found: FormTestProblem): string => text("tests.problem.line", { line: found.line, sentence: sentenceOfProblem(found) });

  /** A lint names a path no field has, so the path is said as written: there is no label to say instead. */
  const lint = (found: FormTestLint): string =>
    text("tests.problem.line", { line: found.line, sentence: text(found.code === "tests.change.unknownPath" ? "tests.lint.changeUnknownPath" : "tests.lint.unknownPath", { path: found.params.path }) });

  // --- a scenario ----------------------------------------------------------------------------------------------------

  /** The first step that failed, else the first that errored. */
  const worstStep = (result: FormTestScenarioResult | undefined): FormTestStepResult | undefined =>
    result?.steps.find((step) => step.status === "failed") ?? result?.steps.find((step) => step.status === "error");

  const reason = (result: FormTestScenarioResult): string => {
    const code = result.reason;
    if (code !== undefined) {
      if (has(SKIP_REASON_OF, code)) {
        return text("tests.word.notJudged", { reason: skipReason(code) });
      }
      const worded = reasonOfCode(code, result.params);
      if (worded !== undefined) {
        return worded;
      }
      // `skip "…"` is the author's sentence, shown as written.
      return result.status === "skipped" ? text("tests.reason.skipped.author", { reason: code }) : text("tests.word.unknownCode", { code });
    }
    if (result.status === "skipped") {
      // Every expectation skipped without one reason to give: the first step's own.
      const first = result.steps.find((step) => step.status === "skipped");
      return first === undefined ? text("tests.reason.skipped") : sentences(first).full;
    }
    if (result.status === "error") {
      const step = worstStep(result);
      return step === undefined ? text("tests.reason.errored") : sentences(step).full;
    }
    return "";
  };

  const summary = (entry: TestsEntryModel): string => {
    switch (entry.status) {
      case "invalid": {
        const first = entry.problems[0];
        return first === undefined ? text("tests.summary.invalid") : problem(first);
      }
      case "unrun":
        return text("tests.summary.unrun");
      case "running":
        return text("tests.summary.running");
      case "passed":
        return text("tests.summary.passed");
      case "stale":
        return text("tests.summary.stale");
      case "failed": {
        const step = worstStep(entry.result);
        return step === undefined ? text("tests.summary.failed") : text("tests.summary.line", { line: step.line, text: sentences(step).short });
      }
      case "error": {
        if (entry.result === undefined) {
          return text("tests.summary.error");
        }
        const step = entry.result.reason === undefined ? worstStep(entry.result) : undefined;
        const said = reason(entry.result);
        return step === undefined ? said : text("tests.summary.line", { line: step.line, text: said });
      }
      case "skipped":
        return entry.result === undefined ? text("tests.summary.skipped") : reason(entry.result);
    }
  };

  const status = (value: TestsEntryStatus): string => text(`tests.status.${value}` as BuilderTextKey);

  return {
    problem,
    lint,
    step: (step, _scenario: FormTestScenario | undefined) => sentences(step).full,
    stepSides: (step, _scenario: FormTestScenario | undefined) => stepSides(step),
    reason,
    summary,
    status
  };
}

/** The sentence for a reason Accept new behaviour offers no rewrite, from the outcome's `refused`. */
export function acceptRefusalText(refused: "formula" | "noActual" | "notExpectation" | "action", options?: TestsWordsOptions["text"]): string {
  return builderText(`tests.accept.refused.${refused}` as BuilderTextKey, undefined, options);
}
