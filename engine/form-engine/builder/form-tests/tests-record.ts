/**
 * Record and Assert this: the pure halves. What the author does
 * in Try it while the panel records arrives as a {@link TestsRecordEvent}; `recordStep` turns it
 * into one line of the test language, and `assertLines` turns a pick from the Assert this popover
 * into expectations about what the tried form shows. The panel holds the state (recording on or
 * off, the last two snapshots) and puts the lines into the box; nothing here reads the DOM, the
 * clock or the canvas.
 *
 * Every line written here is one the parser reads back as the statement it says (the tests run
 * each through `kernelParseFormTests`): a path that the language cannot name, a value it cannot
 * spell or a page with no id is refused with a reason instead of being written half right.
 */
import { kernelFormTestIsId, kernelFormTestIsPath } from "../../core/form-tests/form-test-parse.js";
import type { TestsAssertField, TestsAssertSnapshot, TestsNaming, TestsRecordEvent } from "./tests-model.js";
import { testsFlagKeys, testsLiteral } from "./tests-accept.js";

/**
 * Why an event wrote no line: a row removal the event cannot place (`removeRow`: the canvas
 * reports the count, not which row went), an answer the language cannot spell (`value`), a path
 * it cannot name (`path`: not the engine's value-path syntax, or not a field of this form), a
 * move to a page with no id (`page`).
 */
export type TestsRecordRefusal = "removeRow" | "value" | "path" | "page";

export type TestsRecordStep = { line: string } | { refused: TestsRecordRefusal };

/** Whether the form names the path: a naming that knows no label for it is a path the parser would call unknown. */
function named(path: string, naming: TestsNaming | undefined): boolean {
  return kernelFormTestIsPath(path) && (naming === undefined || naming.labelOf(path) !== undefined);
}

/** An answer emptied (nothing, or a checkbox group with nothing ticked) is a `clear`, which is how a test says it. */
function emptied(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  const flags = testsFlagKeys(value);
  return flags !== undefined && flags.length === 0;
}

/**
 * One recorded event as one line (no indentation: the box indents it like its neighbours), or
 * why none is written. Values go through `testsLiteral`, so a choice is written by its stored
 * value and a calendar day as `@"…"`. A row removal is written only when the event says which
 * row (an `index` the contract's event does not carry yet).
 */
export function recordStep(event: TestsRecordEvent, naming?: TestsNaming): TestsRecordStep {
  switch (event.kind) {
    case "set": {
      if (!named(event.path, naming)) {
        return { refused: "path" };
      }
      if (emptied(event.value)) {
        return { line: `clear ${event.path}` };
      }
      const literal = testsLiteral(event.value);
      return literal === undefined ? { refused: "value" } : { line: `set ${event.path} = ${literal}` };
    }
    case "clear":
      return named(event.path, naming) ? { line: `clear ${event.path}` } : { refused: "path" };
    case "addRow":
      return named(event.collection, naming) ? { line: `add row to ${event.collection}` } : { refused: "path" };
    case "removeRow": {
      const index = (event as { index?: unknown }).index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        return { refused: "removeRow" };
      }
      return named(event.collection, naming) ? { line: `remove row ${String(index)} of ${event.collection}` } : { refused: "path" };
    }
    case "continue":
      return { line: "continue" };
    case "back":
      return { line: "back" };
    case "goTo":
      return kernelFormTestIsId(event.page) ? { line: `go to ${event.page}` } : { refused: "page" };
    case "change":
      return named(event.path, naming) ? { line: `change ${event.path}` } : { refused: "path" };
    case "check":
      return { line: "check" };
    case "submit":
      return { line: "submit" };
    default:
      return { refused: "value" };
  }
}

/** {@link recordStep}'s line, or `undefined` when the event writes none. */
export function recordLine(event: TestsRecordEvent, naming?: TestsNaming): string | undefined {
  const step = recordStep(event, naming);
  return "line" in step ? step.line : undefined;
}

// --- Assert this --------------------------------------------------------------------------------

/**
 * What the author ticked in the Assert this popover: fields by value path (a row's field is one
 * pick per row, `items[1].qty` apart from `items[0].qty`), and the three extras.
 */
export interface TestsAssertPicks {
  fields: readonly string[];
  /** `expect page = <id>` for the page on show. */
  page?: boolean;
  /** An `expect error on` line for every error on show, or `expect no errors` when there is none. */
  errors?: boolean;
  /** `expect accepted|refused` from the last Submit. */
  verdict?: boolean;
}

export interface TestsAssertOptions {
  /**
   * Whether a `requiredWhen` decides the field's required state: only then is `required` or
   * `optional` worth a line (a field that is always required says nothing about a rule).
   */
  decidesRequired?(componentId: string): boolean;
}

/** An error code as the language takes it after `error on <path>:`; anything else asserts an error of any code. */
const CODE = /^[A-Za-z0-9._-]+$/;

function errorLine(path: string, code: string): string {
  return CODE.test(code) ? `expect error on ${path}: ${code}` : `expect error on ${path}`;
}

function sameErrors(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((code, at) => code === b[at]);
}

/**
 * The value paths of the fields whose state moved between two snapshots: shown or hidden,
 * required or optional, or the errors on show. A field absent from `previous` moved only if it is
 * shown now. No previous snapshot, nothing moved (the popover then preselects nothing). Fields are
 * matched by path, not component id: the rows of one repeating field are fields of their own.
 */
export function changedFields(snapshot: TestsAssertSnapshot, previous: TestsAssertSnapshot | undefined): string[] {
  if (previous === undefined) {
    return [];
  }
  const before = new Map(previous.fields.map((field) => [field.path, field]));
  const out: string[] = [];
  for (const field of snapshot.fields) {
    const was = before.get(field.path);
    if (was === undefined ? field.visible : was.visible !== field.visible || was.required !== field.required || !sameErrors(was.errors, field.errors)) {
      out.push(field.path);
    }
  }
  return out;
}

/**
 * The lines one picked field asserts. A field the last event moved asserts what moved (its
 * visibility, its required state when a rule decides it, its errors); one the author picked by
 * hand asserts all three. A hidden field says only that: it shows no errors to speak of.
 */
function fieldLines(field: TestsAssertField, was: TestsAssertField | undefined, options: TestsAssertOptions): string[] {
  const all = was === undefined;
  const lines: string[] = [];
  if (all || was.visible !== field.visible) {
    lines.push(`expect ${field.path} ${field.visible ? "visible" : "hidden"}`);
  }
  if (!field.visible) {
    return lines;
  }
  if ((all || was.required !== field.required) && options.decidesRequired?.(field.componentId) === true) {
    lines.push(`expect ${field.path} ${field.required ? "required" : "optional"}`);
  }
  if (all || !sameErrors(was.errors, field.errors) || !was.visible) {
    if (field.errors.length === 0) {
      lines.push(`expect no error on ${field.path}`);
    } else {
      for (const code of field.errors) {
        lines.push(errorLine(field.path, code));
      }
    }
  }
  return lines;
}

/**
 * The expectations a pick writes, in the popover's order (the fields as the snapshot lists them,
 * then the page, the errors on show, the verdict), each once. `previous` is the snapshot before
 * the last recorded event: a field it moved asserts only what moved (see {@link fieldLines}).
 */
export function assertLines(snapshot: TestsAssertSnapshot, previous: TestsAssertSnapshot | undefined, picks: TestsAssertPicks, options: TestsAssertOptions = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (line: string): void => {
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  };
  const picked = new Set(picks.fields);
  const moved = new Set(changedFields(snapshot, previous));
  const before = new Map((previous?.fields ?? []).map((field) => [field.path, field]));
  for (const field of snapshot.fields) {
    if (!picked.has(field.path) || !kernelFormTestIsPath(field.path)) {
      continue;
    }
    for (const line of fieldLines(field, moved.has(field.path) ? before.get(field.path) : undefined, options)) {
      add(line);
    }
  }
  if (picks.page === true && snapshot.page !== undefined && kernelFormTestIsId(snapshot.page)) {
    add(`expect page = ${snapshot.page}`);
  }
  if (picks.errors === true) {
    const shown = snapshot.fields.filter((field) => field.visible && field.errors.length > 0 && kernelFormTestIsPath(field.path));
    if (shown.length === 0) {
      add("expect no errors");
    }
    for (const field of shown) {
      for (const code of field.errors) {
        add(errorLine(field.path, code));
      }
    }
  }
  if (picks.verdict === true && snapshot.lastSubmit !== undefined) {
    add(`expect ${snapshot.lastSubmit}`);
  }
  return out;
}
