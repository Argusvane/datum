/**
 * Accept new behaviour: a failed expectation rewritten to what the form
 * does now, taken from the step's `actual`. The rewrite is one line of the scenario's source:
 * the statement's text is replaced, the indentation before it and the blanks and `# comment`
 * after it stay, and every other line is untouched, so the author's layout survives and the
 * panel can show the one changed line.
 *
 * The result is only ever a line the parser reads back as the statement the author would have
 * written by hand, and the case is closed by running it: the rewritten step judges `passed`
 * against the same snapshot. What cannot be said in the language is refused with a reason
 * (`formula`, `noActual`, `notExpectation`, `action`) so the panel can say why no button is
 * offered, rather than guessing a value.
 */
import { kernelFormTestContentEnd, kernelFormTestIsId, kernelFormTestIsIsoDay, kernelFormTestIsPath, kernelFormTestIsSpace } from "../../core/form-tests/form-test-parse.js";
import type { FormTestExpectation, FormTestScenario, FormTestState, FormTestStatement, FormTestStepResult } from "../../core/form-tests/form-test-types.js";
import type { TestsAcceptOutcome } from "./tests-model.js";

/** A string as the language writes it: straight quotes, the escapes the parser resolves, one line. */
export function testsStringLiteral(value: string): string {
  let out = '"';
  for (const ch of value) {
    out += ch === "\\" ? "\\\\" : ch === '"' ? '\\"' : ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : ch;
  }
  return `${out}"`;
}

/** Whether a value is a record of booleans with at least one key: a checkbox group's answer. */
export function testsFlagKeys(value: unknown): string[] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.some((key) => typeof record[key] !== "boolean")) {
    return undefined;
  }
  return keys.filter((key) => record[key] === true);
}

/**
 * A value as the test language spells a literal, or `undefined` when the language cannot say it
 * (a record that is not a checkbox group's flags, a number that is not finite). A string that is
 * a calendar day is a date literal `@"…"`; a list is `("a", "b")`; a checkbox group's flags are
 * the list of the options ticked, which is how a test names them. `nothing` is spelt `null`.
 */
export function testsLiteral(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return kernelFormTestIsIsoDay(value) ? `@${testsStringLiteral(value)}` : testsStringLiteral(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value === 0 ? 0 : value) : undefined;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  const flags = testsFlagKeys(value);
  const items: unknown[] | undefined = Array.isArray(value) ? value : flags;
  if (items === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of items) {
    const part = testsLiteral(item);
    if (part === undefined) {
      return undefined;
    }
    parts.push(part);
  }
  return `(${parts.join(", ")})`;
}

interface SourceLine {
  /** The line's text without its terminator. */
  text: string;
  /** The terminator that followed it (`\n`, `\r\n`, `\r`, or none for the last line). */
  end: string;
}

/** The lines of a source with their terminators, so the rewrite hands back every other byte as it was. */
function linesOf(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const pattern = /\r\n|\r|\n/g;
  let from = 0;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    lines.push({ text: source.slice(from, match.index), end: match[0] });
    from = match.index + match[0].length;
  }
  lines.push({ text: source.slice(from), end: "" });
  return lines;
}

const FLIPPED_STATE: Record<FormTestState, string> = {
  visible: "hidden",
  hidden: "visible",
  required: "optional",
  optional: "required",
  enabled: "disabled",
  disabled: "enabled",
  readonly: "editable",
  editable: "readonly",
  empty: "not empty",
  notEmpty: "empty"
};

type Rewrite = { text: string } | { refused: "formula" | "noActual" | "notExpectation" | "action" };

function noActual(): Rewrite {
  return { refused: "noActual" };
}

/** `expect <rest>` for an expectation, or the refusal when the literal cannot be written. */
function said(rest: string | undefined): Rewrite {
  return rest === undefined ? noActual() : { text: rest };
}

function literalOr(value: unknown): string | undefined {
  return testsLiteral(value);
}

/** An error entry as the judge reports it: a path (or a component id when the error has no path) and a code. */
function errorEntry(entry: unknown): { path?: string; code: string } | undefined {
  if (entry === null || typeof entry !== "object") {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  const code = record["code"];
  if (typeof code !== "string") {
    return undefined;
  }
  const where = typeof record["path"] === "string" ? record["path"] : typeof record["componentId"] === "string" ? record["componentId"] : undefined;
  return where === undefined ? { code } : { path: where, code };
}

function errorLine(path: string, code: string | undefined): string {
  return code !== undefined && /^[A-Za-z0-9._-]+$/.test(code) ? `error on ${path}: ${code}` : `error on ${path}`;
}

/** The statement's new text after the leading keyword, from the failing step's data. */
function rewriteExpectation(statement: FormTestExpectation, step: FormTestStepResult): Rewrite {
  const code = step.code ?? "";
  const actual = step.actual;
  switch (statement.kind) {
    case "expectFormula":
      return { refused: "formula" };
    case "expectState":
      return code === "expect." + statement.state ? { text: `${statement.path} ${FLIPPED_STATE[statement.state]}` } : noActual();
    case "expectValue": {
      if (code !== "expect.value") {
        return noActual();
      }
      const literal = literalOr(actual);
      // A failed `!=` found the value it said the answer was not: accepting is saying it is.
      return said(literal === undefined ? undefined : `${statement.path} = ${literal}`);
    }
    case "expectError": {
      if (code !== "expect.error") {
        return noActual();
      }
      const codes = Array.isArray(actual) ? actual.filter((entry): entry is string => typeof entry === "string") : [];
      // No error at all: the field is clean now. Errors of other codes: the form raises those.
      return { text: codes.length === 0 ? `no error on ${statement.path}` : errorLine(statement.path, codes[0]) };
    }
    case "expectMessage": {
      if (code !== "expect.message") {
        return noActual();
      }
      const first = Array.isArray(actual) ? actual.find((entry): entry is string => typeof entry === "string") : undefined;
      return first === undefined ? noActual() : { text: `message on ${statement.path} = ${testsStringLiteral(first)}` };
    }
    case "expectNoError": {
      if (code !== "expect.noError" || !Array.isArray(actual)) {
        return noActual();
      }
      const first = errorEntry(actual[0]);
      if (first === undefined) {
        return noActual();
      }
      const path = statement.path ?? first.path;
      return path === undefined || !kernelFormTestIsPath(path) ? noActual() : { text: errorLine(path, first.code) };
    }
    case "expectVerdict":
      return code === "expect.verdict" ? { text: statement.verdict === "accepted" ? "refused" : "accepted" } : noActual();
    case "expectPage":
      return code === "expect.page" && typeof actual === "string" && kernelFormTestIsId(actual) ? { text: `page = ${actual}` } : noActual();
    case "expectPath": {
      if (code !== "expect.path" || !Array.isArray(actual) || !actual.every((page) => typeof page === "string" && kernelFormTestIsId(page))) {
        return noActual();
      }
      return { text: `path = (${actual.join(", ")})` };
    }
    case "expectPathEnd": {
      if (code !== "expect.pathEnd" || actual === null || typeof actual !== "object") {
        return noActual();
      }
      const end = actual as Record<string, unknown>;
      if (end["end"] === "end") {
        return { text: "path ends" };
      }
      return end["end"] === "exit" && typeof end["last"] === "string" && kernelFormTestIsId(end["last"]) ? { text: `path ends at ${end["last"]}` } : noActual();
    }
    case "expectOnPath":
      return code === "expect.onPath" ? { text: `${statement.page} ${statement.on ? "off" : "on"} path` } : noActual();
    case "expectSubmitted": {
      if (code !== "expect.submitted") {
        return noActual();
      }
      const literal = literalOr(actual);
      return said(literal === undefined ? undefined : `submitted ${statement.path} = ${literal}`);
    }
    case "expectWithheld": {
      // The judge reports `false` here (it was not withheld) and the value that went out in
      // `params.sent`, when the side can say it; without it there is no value to write.
      const params = step.params;
      if (code !== "expect.withheld" || params === undefined || !Object.prototype.hasOwnProperty.call(params, "sent")) {
        return noActual();
      }
      const literal = literalOr(params["sent"]);
      return said(literal === undefined ? undefined : `submitted ${statement.path} = ${literal}`);
    }
    case "expectRows":
      return code === "expect.rows" && typeof actual === "number" && Number.isInteger(actual) && actual >= 0 ? { text: `rows of ${statement.path} = ${actual}` } : noActual();
    case "expectLayout":
      return code === "expect.layout" && typeof actual === "string" && kernelFormTestIsId(actual) ? { text: `layout = ${actual}` } : noActual();
    default:
      return noActual();
  }
}

/** The statement a step reports on: the one whose line it carries. */
function statementAt(scenario: FormTestScenario, line: number): FormTestStatement | undefined {
  return scenario.steps.find((statement) => statement.line === line);
}

/**
 * The failing step's line rewritten to what the form does now. `source` is the entry's whole
 * source as the panel holds it, `scenario` its parse, `step` the failed step of its last run.
 */
export function acceptNewBehaviour(source: string, scenario: FormTestScenario, step: FormTestStepResult): TestsAcceptOutcome {
  if (step.code === "action.failed" || step.code === "action.refused") {
    return { refused: "action" };
  }
  const statement = statementAt(scenario, step.line);
  if (statement === undefined || statement.kind.indexOf("expect") !== 0) {
    return { refused: "notExpectation" };
  }
  if (step.status !== "failed") {
    return { refused: "noActual" };
  }
  const rewrite = rewriteExpectation(statement as FormTestExpectation, step);
  if ("refused" in rewrite) {
    return { refused: rewrite.refused };
  }
  const lines = linesOf(source);
  const original = lines[step.line - 1];
  if (original === undefined) {
    return { refused: "notExpectation" };
  }
  // The statement's own text: from its first word to where the content ends (a comment and the
  // blanks before it are not part of it), as the parser cuts a line.
  const text = original.text;
  let start = 0;
  while (start < text.length && (kernelFormTestIsSpace(text.charAt(start)) || text.charCodeAt(start) === 0xfeff)) {
    start += 1;
  }
  let end = kernelFormTestContentEnd(text, 0, text.length);
  while (end > start && kernelFormTestIsSpace(text.charAt(end - 1))) {
    end -= 1;
  }
  const keyword = /^\S+/.exec(text.slice(start, end))?.[0] ?? "expect";
  const rewritten = `${text.slice(0, start)}${keyword} ${rewrite.text}${text.slice(end)}`;
  lines[step.line - 1] = { text: rewritten, end: original.end };
  return { source: lines.map((line) => line.text + line.end).join(""), line: step.line, text: rewritten };
}
