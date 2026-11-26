/**
 * The words of the reports: the engine reports codes and data, never
 * sentences, so every sentence a person reads in the console, the Markdown or the JUnit file is
 * made here, from one table. A code the table does not know still prints (its code and its
 * params as JSON) rather than disappearing, so a newer engine with an older tool degrades to
 * something a reader can search for.
 *
 * Plain Node code, not kernel-shaped (the package has no sandbox rule): module constants and
 * closures are fine here.
 */
import { FORM_TEST_MAX_STEPS, kernelFormTestMessage } from "@argusvane/datum-engine/form-tests";
import type { FormTestProblem, FormTestScenarioResult, FormTestStepResult } from "@argusvane/datum-engine/form-tests";

import type { RunnerId, ScenarioReport, ScenarioStatus, SourceRef, StepCell } from "./model.js";

/** What a word is made from: the pieces a step or a scenario result carries. */
interface Subject {
  expected: unknown;
  actual: unknown;
  params: Record<string, unknown>;
}

type Word = (subject: Subject) => string;

const LIMIT = 160;

/**
 * Text on one line. The parser accepts `\n`, `\r` and `\t` escapes in a test's name, and a name
 * reaches table rows, headings and console lines, where a line break would start a new row, a new
 * heading or a new log line. CR counts as a break: CommonMark ends a line on it.
 */
export function oneLine(text: string): string {
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");
}

/** A value as compact JSON for a sentence, cut at a readable length (the JSON report holds it whole). */
export function compactJson(value: unknown, limit: number = LIMIT): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (text === undefined) {
    // No JSON for it: nothing was there to report, or it is not data (a function, a cycle).
    text = value === undefined ? "nothing" : String(value);
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function has(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** A param as text, or `fallback` when it is absent or not a scalar. */
function param(subject: Subject, key: string, fallback: string): string {
  if (!has(subject.params, key)) {
    return fallback;
  }
  const value = subject.params[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}

/** A value in running text: a string as it is, anything else as compact JSON. */
function plain(value: unknown): string {
  return typeof value === "string" ? value : compactJson(value);
}

function quoted(text: string): string {
  return `"${text}"`;
}

function pathOf(subject: Subject): string {
  return quoted(param(subject, "path", "the field"));
}

function list(value: unknown): string {
  if (!Array.isArray(value)) {
    return value === undefined ? "nothing" : compactJson(value);
  }
  return value.length === 0 ? "(none)" : value.map((item) => String(item)).join(" > ");
}

function rowsWord(count: unknown): string {
  return count === 1 ? "1 row" : `${compactJson(count)} rows`;
}

/** `expect <field> <state>`: the sentence names the state wanted and the state found. */
function stateWord(wanted: string, found: string): Word {
  return (subject) => `Expected ${pathOf(subject)} to be ${wanted}, but it is ${found}.`;
}

function endWord(end: unknown): string {
  if (end === null || typeof end !== "object") {
    return "does not end";
  }
  const record = end as Record<string, unknown>;
  if (record["end"] === "exit") {
    return typeof record["last"] === "string" ? `stops at the exit page ${quoted(record["last"])}` : "stops at an exit page";
  }
  return record["end"] === "end" ? "runs off the end" : "does not end";
}

/** Why a row action was refused (the runner's `action.refused` `reason`). */
const REFUSAL: Record<string, string> = {
  "rows.max": "the collection already holds the most rows it may (maxRows)",
  "rows.min": "the collection would fall below the fewest rows it may hold (minRows)",
  "operations.add": "the collection does not allow adding rows",
  "operations.remove": "the collection does not allow removing rows",
  rowOutOfRange: "that row is not there",
  unknownCollection: "the form has no such collection",
  "change.notReview": "the scenario is not on a Check answers step",
  "change.off": "the Check answers step has its Change links off",
  "change.notListed": "the Check answers step does not list that answer",
  "change.unreachable": "the step that asks it cannot be opened yet"
};

function formulaProblemsWord(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }
  const items = value.slice(0, 5).map((entry) => {
    if (entry === null || typeof entry !== "object") {
      return String(entry);
    }
    const record = entry as Record<string, unknown>;
    const code = typeof record["code"] === "string" ? record["code"] : "problem";
    return typeof record["where"] === "string" ? `${code} at ${record["where"]}` : code;
  });
  return ` (${items.join("; ")}${value.length > 5 ? "; …" : ""})`;
}

function skipped(why: string): Word {
  return () => `Skipped: ${why}.`;
}

/**
 * One row per code the engine emits: every `expect.*` code the judge returns, the runner's
 * `action.*`, `snapshot.*` and `scenario.*` codes, the drivers' start errors and the skip
 * reasons. `tests/report.test.ts` greps the engine for the literals and fails on a code with no
 * row, so a code added there cannot reach a report unworded.
 */
const WORDS: Record<string, Word> = {
  "expect.unknownField": (subject) => {
    if (param(subject, "reason", "") === "rowOutOfRange") {
      return `${pathOf(subject)} names a row the form does not have.`;
    }
    if (param(subject, "reason", "") === "noRowScope") {
      return `The formula reads ${pathOf(subject)}, but a test has no row in scope to read it from.`;
    }
    if (has(subject.params, "id")) {
      return `The formula reads ${pathOf(subject)}, which is no component id; the field's id is ${quoted(param(subject, "id", ""))}.`;
    }
    return `The form has no field ${pathOf(subject)}.`;
  },
  "expect.badState": (subject) => `${pathOf(subject)} cannot be judged in that state.`,
  "expect.badStatement": () => "The test has an expectation the judge does not know.",
  "expect.visible": stateWord("visible", "hidden"),
  "expect.hidden": stateWord("hidden", "visible"),
  "expect.required": stateWord("required", "optional"),
  "expect.optional": stateWord("optional", "required"),
  "expect.enabled": stateWord("enabled", "disabled"),
  "expect.disabled": stateWord("disabled", "enabled"),
  "expect.readonly": stateWord("read-only", "editable"),
  "expect.editable": stateWord("editable", "read-only"),
  "expect.empty": (subject) => `Expected ${pathOf(subject)} to be empty, but it has an answer.`,
  "expect.notEmpty": (subject) => `Expected ${pathOf(subject)} to have an answer, but it is empty.`,
  "expect.noJourney": () => "The form is not running a journey, so there is no page or path to check; add a given journey.",
  "expect.page": (subject) => `Expected the form to be on page ${compactJson(subject.expected)}, but it is on ${compactJson(subject.actual)}.`,
  "expect.path": (subject) => `Expected the path ${list(subject.expected)}, but it is ${list(subject.actual)}.`,
  "expect.pathEnd": (subject) => `Expected the path to end where it ${endWord(subject.expected)}, but it ${endWord(subject.actual)}.`,
  "expect.unknownPage": (subject) => `The journey has no page ${quoted(param(subject, "page", "that"))}.`,
  "expect.onPath": (subject) => {
    const page = quoted(param(subject, "page", "that page"));
    return subject.expected === true ? `Expected page ${page} to be on the path, but it is off it.` : `Expected page ${page} to be off the path, but it is on it.`;
  },
  "expect.value": (subject) =>
    param(subject, "op", "eq") === "ne"
      ? `Expected ${pathOf(subject)} not to be ${compactJson(subject.expected)}, but it is.`
      : `Expected ${pathOf(subject)} to be ${compactJson(subject.expected)}, but it is ${compactJson(subject.actual)}.`,
  "expect.formula": (subject) =>
    param(subject, "evaluated", "true") === "false"
      ? `The formula ${quoted(param(subject, "formula", ""))} could not be evaluated.`
      : `The formula ${quoted(param(subject, "formula", ""))} is not true; it came to ${compactJson(subject.actual)}.`,
  "expect.error": (subject) => {
    const found = Array.isArray(subject.actual) && subject.actual.length > 0 ? `its errors are ${compactJson(subject.actual)}` : "it has no error";
    return subject.expected === null || subject.expected === undefined
      ? `Expected an error on ${pathOf(subject)}, but ${found}.`
      : `Expected the error ${compactJson(subject.expected)} on ${pathOf(subject)}, but ${found}.`;
  },
  "expect.message": (subject) =>
    `Expected the message ${compactJson(subject.expected)} on ${pathOf(subject)}, but its messages are ${compactJson(subject.actual)}.`,
  "expect.noError": (subject) =>
    `Expected no errors${has(subject.params, "path") ? ` on ${pathOf(subject)}` : ""}, but found ${compactJson(subject.actual)}.`,
  "expect.noVerdict": (subject) =>
    `Expected the form to be ${plain(subject.expected)}, but nothing was submitted or checked yet; put a submit or check before this line.`,
  "expect.verdict": (subject) => `Expected the form to be ${plain(subject.expected)}, but it was ${plain(subject.actual)}.`,
  "expect.notSubmitted": () => "Nothing was submitted or checked before this line, so there are no submitted answers to judge.",
  "expect.submitted": (subject) =>
    `Expected ${pathOf(subject)} to be submitted as ${compactJson(subject.expected)}, but it was ${compactJson(subject.actual)}.`,
  "expect.withheld": (subject) => `Expected ${pathOf(subject)} to be withheld from the submission, but it was sent.`,
  "expect.rows": (subject) => `Expected ${pathOf(subject)} to have ${rowsWord(subject.expected)}, but it has ${rowsWord(subject.actual)}.`,
  "expect.layout": (subject) =>
    `Expected the PDF layout ${compactJson(subject.expected)}, but the answers choose ${subject.actual === null || subject.actual === undefined ? "none" : compactJson(subject.actual)}.`,
  "action.failed": (subject) =>
    has(subject.params, "message") ? `An action failed: ${param(subject, "message", "")}.` : "An action failed before the scenario could run.",
  "action.refused": (subject) => {
    const reason = param(subject, "reason", "");
    const why = has(REFUSAL, reason) ? (REFUSAL[reason] as string) : reason === "" ? "the form turned it down" : `the form turned it down (${reason})`;
    const where = has(subject.params, "path") ? ` on ${pathOf(subject)}` : "";
    return `The form refused the ${param(subject, "action", "row")} action${where}: ${why}.`;
  },
  "snapshot.failed": (subject) =>
    `The form's state could not be read after the last action${has(subject.params, "message") ? `: ${param(subject, "message", "")}` : ""}.`,
  "scenario.tooManySteps": () => `The scenario has more than ${FORM_TEST_MAX_STEPS} statements.`,
  "scenario.driverFailed": () => "This side could not be set up for the form.",
  "scenario.clockUnset": () => "The form reads the current date, so the scenario must say which day it is: add a given today.",
  "scenario.unknownJourney": (subject) => `The form has no journey ${quoted(param(subject, "journey", "that"))} (given journey).`,
  "scenario.badGiven": (subject) => {
    const given = param(subject, "given", "");
    if (given === "locale") {
      return `The form does not offer the locale ${quoted(param(subject, "locale", ""))} (given locale).`;
    }
    if (given === "options") {
      const field = quoted(param(subject, "path", "that field"));
      return param(subject, "reason", "") === "noSource"
        ? `The choices of ${field} do not come from a data source, so given options cannot set them.`
        : `Given options names ${field}, which the form does not have.`;
    }
    return given === "" ? "A given could not be applied." : `The given ${given} could not be applied.`;
  },
  "scenario.formulaInvalid": (subject) => `The form's formulas do not compile${formulaProblemsWord(subject.params["problems"])}, so there is no form to test.`,
  "unreplayable.host": skipped("a rule reads the host context and the scenario gives no host value"),
  "unreplayable.server": skipped("a rule runs only on the server"),
  "unreplayable.secret": skipped("a rule uses a server secret"),
  "unreplayable.clock": skipped("a rule reads today's date and the scenario gives none"),
  "unreplayable.browser": skipped("a rule runs only in the browser"),
  "unreplayable.clientDerived": skipped("a calculation reads an answer the server was not sent, so it keeps the value as sent")
};

/** Whether the words table has a row for a code (the test over the engine's literals asks). */
export function hasWord(code: string): boolean {
  return has(WORDS, code);
}

/** Every code the table words, sorted: the report test compares it with what the engine emits. */
export function wordedCodes(): string[] {
  return Object.keys(WORDS).sort();
}

function fallback(code: string, params: Record<string, unknown> | undefined): string {
  return params === undefined || Object.keys(params).length === 0 ? code : `${code} ${compactJson(params)}`;
}

function wordFor(code: string, subject: Subject): string | undefined {
  return has(WORDS, code) ? (WORDS[code] as Word)(subject) : undefined;
}

/** A parse problem as one sentence (`kernelFormTestMessage`, the engine's own wording). */
export function problemMessage(problem: FormTestProblem): string {
  return kernelFormTestMessage(problem.code, problem.params);
}

/** What one step came to, as one sentence. A step with no code says only its status. */
export function stepMessage(step: FormTestStepResult): string {
  if (step.code === undefined) {
    switch (step.status) {
      case "passed":
        return "Passed.";
      case "ran":
        return "Ran.";
      case "skipped":
        return "Skipped.";
      case "failed":
        return "Failed.";
      default:
        return "Errored.";
    }
  }
  const subject: Subject = { expected: step.expected, actual: step.actual, params: step.params ?? {} };
  return wordFor(step.code, subject) ?? fallback(step.code, step.params);
}

/**
 * Why a scenario was skipped or ended as an error, as one sentence: a start error
 * (`scenario.*`, with its params), a skip reason of the engine (`unreplayable.*`), or the text
 * of the author's own `skip "…"`. A result with neither says only what its status says.
 */
export function scenarioReasonMessage(result: FormTestScenarioResult): string {
  const reason = result.reason;
  if (reason === undefined) {
    if (result.status === "skipped") {
      return "Skipped.";
    }
    return result.status === "error" ? "The scenario ended in an error." : "";
  }
  const subject: Subject = { expected: undefined, actual: undefined, params: result.params ?? {} };
  const worded = wordFor(reason, subject);
  if (worded !== undefined) {
    return worded;
  }
  // `skip "reason"` is the author's sentence, shown as written.
  return result.status === "skipped" ? `Skipped: ${reason}` : fallback(reason, result.params);
}

export function statusWord(status: ScenarioStatus): "PASS" | "FAIL" | "SKIP" | "ERROR" | "PARITY" {
  switch (status) {
    case "passed":
      return "PASS";
    case "failed":
      return "FAIL";
    case "skipped":
      return "SKIP";
    case "error":
      return "ERROR";
    default:
      return "PARITY";
  }
}

/** Where a scenario came from, for a heading or a test-case name. */
export function sourceLabel(source: SourceRef): string {
  return source.kind === "file" ? source.path : `definition test ${source.id}`;
}

/** One thing a scenario came to, on the sides it came to it on: a failing step, an error, a skip. */
export interface Finding {
  /** The sides that found it (both, when the two agree on the line and the words). */
  sides: RunnerId[];
  /** The line in the source; absent for what ended the scenario before any line ran. */
  line?: number;
  message: string;
  code?: string;
  expected?: unknown;
  actual?: unknown;
}

const SIDE_ORDER: RunnerId[] = ["runtime", "kernel"];

/**
 * The failing steps (`failed`), the errors (`error`: the start error, then any step that errored)
 * or the skips (`skipped`) of a scenario, side by side. The same line with the same words on both
 * sides is one finding, so a form that fails alike on both reads once.
 */
export function findingsOf(scenario: ScenarioReport, kind: "failed" | "error" | "skipped"): Finding[] {
  const found: Finding[] = [];
  const add = (side: RunnerId, finding: Omit<Finding, "sides">): void => {
    for (const entry of found) {
      if (entry.line === finding.line && entry.message === finding.message) {
        if (!entry.sides.includes(side)) {
          entry.sides.push(side);
        }
        return;
      }
    }
    found.push({ sides: [side], ...finding });
  };
  for (const side of SIDE_ORDER) {
    const result = scenario.sides[side];
    if (result === undefined) {
      continue;
    }
    if ((kind === "error" || kind === "skipped") && result.status === kind) {
      add(side, { message: scenarioReasonMessage(result), ...(result.reason === undefined ? {} : { code: result.reason }) });
    }
    if (kind === "skipped") {
      continue;
    }
    for (const step of result.steps) {
      if (step.status !== kind) {
        continue;
      }
      add(side, {
        line: step.line,
        message: stepMessage(step),
        ...(step.code === undefined ? {} : { code: step.code }),
        ...(step.expected === undefined ? {} : { expected: step.expected }),
        ...(step.actual === undefined ? {} : { actual: step.actual })
      });
    }
  }
  return found;
}

/** `[kernel] ` when only some of the sides that ran found it, else nothing. */
export function sidePrefix(scenario: ScenarioReport, finding: Finding): string {
  const ran = SIDE_ORDER.filter((side) => scenario.sides[side] !== undefined).length;
  return finding.sides.length < ran ? `[${finding.sides.join(", ")}] ` : "";
}

/** What one side did on a line of the parity table: its status, the code, and what it saw. */
export function stepCellWord(cell: StepCell): string {
  if (cell === null) {
    return "no step";
  }
  const code = cell.code === undefined ? "" : ` ${cell.code}`;
  const actual = cell.actual === undefined ? "" : ` (got ${compactJson(cell.actual, 80)})`;
  return `${cell.status}${code}${actual}`;
}
