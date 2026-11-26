/**
 * Write a test for a rule ("Scaffold from a rule"): the Untested list's and
 * the Logic editor's button turn one Logic rule into the scenarios that pin it. The scaffold is a
 * starting point an author edits, so it is written for the shapes a person would write by hand
 * and says so when it cannot:
 *
 * - A condition that compares one path with a literal (`=`, `!=`, an ordering, `in (...)` and
 *   `between`, which the formula parser lowers to `or` / `and` of comparisons, a bare boolean
 *   path, `not(...)`, and `and` / `or` of those) is solved for both truths: the "holds" case sets
 *   the answers that make it true, the "does not hold" case the answers that make it false, and
 *   each case expects what the rule's kind promises (visible and hidden, required and optional,
 *   an error on the field and none...). Several comparisons of one field are solved together
 *   (`between 3 and 5` sets a value inside), choosing among the bounds, a step beside them, the
 *   field's own options and a few plain samples, so the literal is always one the condition
 *   accepts or refuses as the case says.
 * - Anything else (a path compared with another path, a function call, a row or ancestor scope)
 *   writes the `set` lines with an empty text and a trailing `# pick a value that makes "..."`
 *   comment, and the scaffold's `note` says so. The empty text is a literal the parser reads, so
 *   the source still parses; the author fills it in.
 *
 * Every source written here parses with `kernelParseFormTests` as exactly one scenario: a source
 * that did not (a formula the test language lexes differently from the rule language) is dropped
 * rather than offered, because a scaffold the panel would open as a problem is worse than none.
 * The words are the catalog's (`tests.scaffold.*`), the literals are `testsLiteral`'s.
 */
import type { Expression } from "../../core/expressions/expression.js";
import { kernelCompileDefinition } from "../../core/expressions/compile.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import { kernelFormTestIsIsoDay, kernelParseFormTests } from "../../core/form-tests/form-test-parse.js";
import { journeyOwnership, journeyPath } from "../../core/journey/journey-path.js";
import { dataGridSettingsOf, isDataGrid } from "../../core/schema/data-grid.js";
import { readInlineOptions } from "../../core/schema/inline-options.js";
import { readJourneys } from "../../core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import { buildDataPaths, holdsData } from "../../core/tree/data-scope.js";
import { evaluateExpression, kernelExprReadsClock } from "../../rules/evaluator/evaluator.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { COVERABLE_KINDS } from "../logic/coverage.js";
import { conditionSentence } from "../logic/logic-model.js";
import type { LogicRule, LogicRuleKind } from "../logic/logic-types.js";
import { testsLiteral, testsStringLiteral } from "./tests-accept.js";
import type { TestsNaming, TestsScaffold } from "./tests-model.js";
import { builderText } from "./tests-texts-en.js";

/** The rule kinds the scaffold writes a test for: the ones coverage can see (the language has no statement for the rest). */
export const scaffoldableKinds: readonly LogicRuleKind[] = COVERABLE_KINDS;

/**
 * The day a scaffold gives the clock when its condition reads it (`given today`), so a rule such
 * as `event_date >= today()` is solved against a day the test fixes and not the day it is run.
 */
const SCAFFOLD_DAY = "2026-01-01";

/** The longest name a scaffold gives a scenario; the condition is cut with an ellipsis past it. */
const NAME_LENGTH = 110;

/** At most this many `add row` lines for a row-limit scenario; a larger limit is left to the author. */
const MAX_ROW_LINES = 30;

type Operator = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
type Scalar = string | number | boolean;

/** One fact the condition asks of one answer: `key` is a component id, or `host.<name>` for the host's value. */
interface Constraint {
  key: string;
  op: Operator;
  value: Scalar;
}

const INVERSE: Record<Operator, Operator> = { eq: "neq", neq: "eq", lt: "gte", gte: "lt", gt: "lte", lte: "gt" };
const FLIPPED: Record<Operator, Operator> = { eq: "eq", neq: "neq", lt: "gt", gt: "lt", lte: "gte", gte: "lte" };

interface Context {
  root: ComponentNode;
  definition: FormDefinition;
  naming: TestsNaming;
  signatures: FormulaFunctionSignature[];
  text: BuilderTextOptions | undefined;
  nodes: Map<string, ComponentNode>;
  dataPaths: Map<string, string>;
  hasJourneys: boolean;
}

/** The lines of one scenario, in the order the language wants them: givens, rows, sets, then the steps. */
interface Lines {
  givens: string[];
  rows: string[];
  sets: string[];
  steps: string[];
  /** A value could not be chosen: the lines carry a comment for the author. */
  picks: boolean;
  /** What the sets and givens chose, by component id and by host key: the answers a journey's path is predicted from. */
  values: Record<string, unknown>;
  host: Record<string, unknown>;
}

function emptyLines(): Lines {
  return { givens: [], rows: [], sets: [], steps: [], picks: false, values: {}, host: {} };
}

function nodeIndex(root: ComponentNode): Map<string, ComponentNode> {
  const nodes = new Map<string, ComponentNode>();
  const walk = (node: ComponentNode): void => {
    nodes.set(node.id, node);
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child);
      }
    }
  };
  walk(root);
  return nodes;
}

// --- paths ---------------------------------------------------------------------------------------

/**
 * Where a component's answer is named in a test: its data path, with the first row of every
 * repeating section (`items[0].qty`) and the `add row` lines that make those rows exist.
 */
function pathOf(ctx: Context, id: string): { path: string; rows: string[] } {
  const stored = ctx.dataPaths.get(id) ?? id;
  const rows: string[] = [];
  let path = "";
  let rest = stored;
  let shape = "";
  for (let at = rest.indexOf("[]"); at >= 0; at = rest.indexOf("[]")) {
    path += `${rest.slice(0, at)}`;
    shape += `${rest.slice(0, at)}`;
    // A data grid opens with rows, so its first row is already there; any other
    // repeating section opens empty and the test adds the row it answers in.
    if (initialRowsOf(ctx, shape) < 1) {
      rows.push(`add row to ${path}`);
    }
    path += "[0]";
    shape += "[]";
    rest = rest.slice(at + 2);
  }
  return { path: path + rest, rows };
}

/** How many rows the collection at `dataPath` (`items`, `items[].sub`) opens with: a data grid's `initialRows`, else none. */
function initialRowsOf(ctx: Context, dataPath: string): number {
  for (const [id, path] of ctx.dataPaths) {
    const node = ctx.nodes.get(id);
    if (path === dataPath && node !== undefined && node.collection !== undefined) {
      return isDataGrid(node) ? dataGridSettingsOf(node).initialRows : 0;
    }
  }
  return 0;
}

function addRows(lines: Lines, rows: readonly string[]): void {
  for (const row of rows) {
    if (!lines.rows.includes(row)) {
      lines.rows.push(row);
    }
  }
}

// --- reading a condition -------------------------------------------------------------------------

/** The value an operand stands for: a literal, or `today()` as the scaffold's fixed day. Anything else is not a value. */
function valueOf(expression: Expression): Scalar | undefined {
  if (expression.kind === "literal") {
    return expression.value === null ? undefined : expression.value;
  }
  if (expression.kind === "call" && expression.name === "today" && expression.args.length === 0) {
    return SCAFFOLD_DAY;
  }
  return undefined;
}

/**
 * A path the scaffold can set or give: a component id, `row.<id>` (a sibling in the same row, set
 * in the row the target is checked in), or `host.<key>`. Ancestor and component scopes are not.
 */
function settableKey(path: string): boolean {
  if (path === "component" || path.startsWith("component.") || path.startsWith("ancestor.")) {
    return false;
  }
  return path !== "" && path !== "host." && path !== "row.";
}

/** The component id a settable key stands for. */
function idOfKey(key: string): string {
  return key.startsWith("row.") ? key.slice(4) : key;
}

/** Collects the constraints that make `expression` evaluate to `want`; false when its shape is not one the scaffold reads. */
function collect(expression: Expression, want: boolean, out: Constraint[]): boolean {
  switch (expression.kind) {
    case "path":
      if (!settableKey(expression.path)) {
        return false;
      }
      out.push({ key: expression.path, op: "eq", value: want });
      return true;
    case "unary":
      return collect(expression.operand, !want, out);
    case "binary": {
      let path: string | undefined;
      let value: Scalar | undefined;
      let op: Operator = expression.operator;
      if (expression.left.kind === "path" && (value = valueOf(expression.right)) !== undefined) {
        path = expression.left.path;
      } else if (expression.right.kind === "path" && (value = valueOf(expression.left)) !== undefined) {
        path = expression.right.path;
        op = FLIPPED[op];
      }
      if (path === undefined || value === undefined || !settableKey(path)) {
        return false;
      }
      out.push({ key: path, op: want ? op : INVERSE[op], value });
      return true;
    }
    case "logical": {
      // One failing side is enough to fail an `and`, one holding side to hold an `or`; the other two
      // truths need both sides. Where the preferred side is not readable, the other may be.
      const both = expression.operator === "and" ? want : !want;
      if (both) {
        return collect(expression.left, want, out) && collect(expression.right, want, out);
      }
      for (const side of [expression.left, expression.right]) {
        const attempt: Constraint[] = [];
        if (collect(side, want, attempt)) {
          out.push(...attempt);
          return true;
        }
      }
      return false;
    }
    default:
      return false;
  }
}

function satisfies(value: Scalar, constraint: Constraint): boolean {
  const bound = constraint.value;
  switch (constraint.op) {
    case "eq":
      return value === bound;
    case "neq":
      return value !== bound;
    default:
      break;
  }
  if (typeof value === "number" && typeof bound === "number") {
    return constraint.op === "lt" ? value < bound : constraint.op === "lte" ? value <= bound : constraint.op === "gt" ? value > bound : value >= bound;
  }
  if (typeof value === "string" && typeof bound === "string" && kernelFormTestIsIsoDay(value) && kernelFormTestIsIsoDay(bound)) {
    return constraint.op === "lt" ? value < bound : constraint.op === "lte" ? value <= bound : constraint.op === "gt" ? value > bound : value >= bound;
  }
  return false;
}

/** The day beside a `YYYY-MM-DD` day, `step` days on. */
function dayBeside(day: string, step: number): string {
  const at = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + step));
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1, 2)}-${pad(at.getUTCDate(), 2)}`;
}

/** The values worth trying for one answer, in the order a person would reach for them. */
function candidatesFor(constraints: readonly Constraint[], node: ComponentNode | undefined): Scalar[] {
  const out: Scalar[] = [];
  const add = (value: Scalar): void => {
    if (!out.includes(value)) {
      out.push(value);
    }
  };
  for (const constraint of constraints) {
    add(constraint.value);
  }
  // A choice's own options before a step beside the bound: `kind = 2` does not hold for another
  // option of the field, never for a 3 the field cannot hold.
  if (node !== undefined) {
    for (const option of readInlineOptions(node.configuration)) {
      add(option.value);
    }
  }
  for (const constraint of constraints) {
    if (typeof constraint.value === "number") {
      add(constraint.value + 1);
      add(constraint.value - 1);
    } else if (typeof constraint.value === "string" && kernelFormTestIsIsoDay(constraint.value)) {
      add(dayBeside(constraint.value, 1));
      add(dayBeside(constraint.value, -1));
    }
  }
  const first = constraints[0]?.value;
  if (typeof first === "boolean") {
    add(true);
    add(false);
  } else if (typeof first === "number") {
    add(0);
    add(1);
  } else {
    add("x");
    add("y");
    add("");
  }
  return out;
}

/**
 * An answer a field can hold, for a field the condition does not decide: its first option, else
 * one plain value of its type. `undefined` for an answer no literal spells as one value (a list,
 * a collection, a container).
 */
function sampleAnswer(node: ComponentNode): Scalar | undefined {
  if (!holdsData(node) || node.collection !== undefined || node.type === "checkboxes") {
    return undefined;
  }
  const first = readInlineOptions(node.configuration)[0]?.value;
  if (typeof first === "string" || typeof first === "number" || typeof first === "boolean") {
    return first;
  }
  const value: Scalar = node.type === "number" ? 1 : node.type === "checkbox" ? true : node.type === "date" ? SCAFFOLD_DAY : "x";
  return testsLiteral(value) !== undefined ? value : undefined;
}

/** One value per key that satisfies every constraint on it, in the order the keys first appear; `undefined` when a key has none. */
function solve(constraints: readonly Constraint[], ctx: Context): Array<{ key: string; value: Scalar }> | undefined {
  const order: string[] = [];
  const byKey = new Map<string, Constraint[]>();
  for (const constraint of constraints) {
    const list = byKey.get(constraint.key);
    if (list === undefined) {
      order.push(constraint.key);
      byKey.set(constraint.key, [constraint]);
    } else {
      list.push(constraint);
    }
  }
  const solved: Array<{ key: string; value: Scalar }> = [];
  for (const key of order) {
    const list = byKey.get(key) as Constraint[];
    const node = key.startsWith("host.") ? undefined : ctx.nodes.get(idOfKey(key));
    if (!key.startsWith("host.") && (node === undefined || !holdsData(node) || node.collection !== undefined || node.type === "checkboxes")) {
      return undefined;
    }
    const value = candidatesFor(list, node).find((candidate) => list.every((constraint) => satisfies(candidate, constraint)));
    if (value === undefined || testsLiteral(value) === undefined) {
      return undefined;
    }
    solved.push({ key, value });
  }
  return solved;
}

// --- one scenario's lines ------------------------------------------------------------------------

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cut(text: string): string {
  const line = oneLine(text);
  return line.length > NAME_LENGTH ? `${line.slice(0, NAME_LENGTH - 1)}…` : line;
}

/** The expression a rule is about: a rule that stores no tree is read from its formula text. */
function expressionOf(rule: LogicRule, ctx: Context): Expression | undefined {
  if (rule.expression !== undefined) {
    return rule.expression;
  }
  const parsed = kernelParseFormula(rule.formula, ctx.signatures);
  return parsed.ok ? parsed.expression : undefined;
}

/**
 * The givens and sets that make `condition` true or false. When the condition cannot be solved, the
 * sets are the answers it reads with an empty text, the first marked with the pick-a-value comment.
 */
function conditionLines(rule: LogicRule, condition: Expression | undefined, want: boolean, ctx: Context): Lines {
  const lines = emptyLines();
  if (condition !== undefined && kernelExprReadsClock(condition)) {
    lines.givens.push(`given today = ${testsLiteral(SCAFFOLD_DAY) as string}`);
  }
  const constraints: Constraint[] = [];
  const solved = condition !== undefined && collect(condition, want, constraints) ? solve(constraints, ctx) : undefined;
  if (solved !== undefined) {
    for (const { key, value } of solved) {
      const literal = testsLiteral(value) as string;
      if (key.startsWith("host.")) {
        lines.givens.push(`given ${key} = ${literal}`);
        lines.host[key.slice(5)] = value;
        continue;
      }
      lines.values[idOfKey(key)] = value;
      const placed = pathOf(ctx, idOfKey(key));
      addRows(lines, placed.rows);
      lines.sets.push(`set ${placed.path} = ${literal}`);
    }
    return lines;
  }
  lines.picks = true;
  const comment = `# ${builderText(want ? "tests.scaffold.pick.true" : "tests.scaffold.pick.false", { formula: oneLine(rule.formula).replace(/"/g, "'") }, ctx.text)}`;
  const reads = rule.reads.filter((path) => {
    const node = ctx.nodes.get(path);
    return node !== undefined && holdsData(node) && node.collection === undefined;
  });
  if (reads.length === 0) {
    // Nothing to set (a rule that reads only the host or the clock): the comment stands alone.
    lines.sets.push(comment);
    return lines;
  }
  reads.forEach((id, index) => {
    const placed = pathOf(ctx, id);
    addRows(lines, placed.rows);
    lines.sets.push(`set ${placed.path} = ""${index === 0 ? `  ${comment}` : ""}`);
  });
  return lines;
}

/** A scenario's source: the header, then the lines in the language's order, each indented. */
function sourceOf(name: string, lines: Lines, ctx: Context, withNone: boolean): string {
  const head = withNone && ctx.hasJourneys ? ["given journey = none", ...lines.givens] : lines.givens;
  const body = [...head, ...lines.rows, ...lines.sets, ...lines.steps];
  return [`test ${testsStringLiteral(name)}`, ...body.map((line) => `  ${line}`)].join("\n");
}

function wordedCondition(condition: Expression | undefined, ctx: Context): string {
  if (condition === undefined) {
    return "";
  }
  const tokens = conditionSentence(condition, {
    root: ctx.root,
    locale: ctx.text?.locale,
    catalog: ctx.text?.catalog,
    labelOf: (id) => ctx.naming.labelOf(id)
  });
  return cut(tokens.map((token) => token.text).join(""));
}

function targetName(rule: LogicRule, ctx: Context): string {
  if (rule.target.type === "journey-page") {
    return ctx.naming.pageLabelOf(rule.target.id) ?? rule.target.label;
  }
  if (rule.target.type === "pdf-layout") {
    return ctx.naming.layoutLabelOf(rule.target.id) ?? rule.target.label;
  }
  return ctx.naming.labelOf(rule.target.id) ?? rule.target.label;
}

/** Ids the formula language reads bare; any other id is backticked. */
function formulaId(id: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(id) ? id : `\`${id}\``;
}

// --- the kinds -----------------------------------------------------------------------------------

interface Entry {
  name: string;
  source: string;
  picks: boolean;
}

/** What the four state-like kinds expect on the target when their condition holds and when it does not. */
const STATES: Record<string, { key: string; holds: string; fails: string }> = {
  show: { key: "show", holds: "visible", fails: "hidden" },
  "show-step": { key: "show", holds: "visible", fails: "hidden" },
  hide: { key: "hide", holds: "hidden", fails: "visible" },
  "hide-step": { key: "hide", holds: "hidden", fails: "visible" },
  require: { key: "require", holds: "required", fails: "optional" },
  enable: { key: "enable", holds: "enabled", fails: "disabled" },
  readonly: { key: "readonly", holds: "readonly", fails: "editable" }
};

function stateEntries(rule: LogicRule, expression: Expression | undefined, ctx: Context): Entry[] {
  const state = STATES[rule.kind] as { key: string; holds: string; fails: string };
  // A Hide rule is stored as visibleWhen over `not(...)`; its sentence and its cases speak of the inner condition.
  const condition = (rule.kind === "hide" || rule.kind === "hide-step") && expression?.kind === "unary" ? expression.operand : expression;
  const target = targetName(rule, ctx);
  const sentence = wordedCondition(condition, ctx);
  const placed = pathOf(ctx, rule.target.id);
  const entries: Entry[] = [];
  for (const holds of [true, false]) {
    const lines = conditionLines(rule, condition, holds, ctx);
    addRows(lines, placed.rows);
    lines.steps.push(`expect ${placed.path} ${holds ? state.holds : state.fails}`);
    const name = builderText(`tests.scaffold.name.${state.key}.${holds ? "holds" : "fails"}` as "tests.scaffold.name.show.holds", { target, condition: sentence }, ctx.text);
    entries.push({ name, source: sourceOf(name, lines, ctx, true), picks: lines.picks });
  }
  return entries;
}

function validateEntries(rule: LogicRule, expression: Expression | undefined, ctx: Context): Entry[] {
  const target = targetName(rule, ctx);
  const sentence = wordedCondition(expression, ctx);
  const placed = pathOf(ctx, rule.target.id);
  const entries: Entry[] = [];
  const node = ctx.nodes.get(rule.target.id);
  for (const holds of [true, false]) {
    const lines = conditionLines(rule, expression, holds, ctx);
    addRows(lines, placed.rows);
    // A `validWhen` is not run on an empty answer: a condition that reads another field leaves the
    // target to answer, or the refused case could never fail.
    const sample = node !== undefined && !lines.sets.some((line) => line.startsWith(`set ${placed.path} =`)) ? sampleAnswer(node) : undefined;
    if (sample !== undefined) {
      lines.values[rule.target.id] = sample;
      lines.sets.push(`set ${placed.path} = ${testsLiteral(sample) as string}`);
    }
    lines.steps.push("check", holds ? `expect no error on ${placed.path}` : `expect error on ${placed.path}: rule`);
    const name = builderText(holds ? "tests.scaffold.name.validate.holds" : "tests.scaffold.name.validate.fails", { target, condition: sentence }, ctx.text);
    entries.push({ name, source: sourceOf(name, lines, ctx, true), picks: lines.picks });
  }
  return entries;
}

/** The component ids an expression reads through `row.` or `ancestor.` (`row.qty` reads `qty`), in the order they appear. */
function scopedReads(expression: Expression | undefined): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    const node = value as { kind?: unknown; path?: unknown };
    if (node.kind === "path" && typeof node.path === "string") {
      const scoped = /^(?:row|ancestor)\.([^.[]+)/.exec(node.path);
      if (scoped !== null && !out.includes(scoped[1] as string)) {
        out.push(scoped[1] as string);
      }
      return;
    }
    Object.values(value).forEach(walk);
  };
  walk(expression);
  return out;
}

function calculateEntries(rule: LogicRule, expression: Expression | undefined, ctx: Context): Entry[] {
  const target = targetName(rule, ctx);
  const formula = cut(rule.formula);
  const placed = pathOf(ctx, rule.target.id);
  const lines = emptyLines();
  addRows(lines, placed.rows);
  if (expression !== undefined && kernelExprReadsClock(expression)) {
    lines.givens.push(`given today = ${testsLiteral(SCAFFOLD_DAY) as string}`);
  }
  // Give the numbers the formula reads a value, so the check compares a sum and not two empty answers.
  // The Logic model's reads are form-scoped only: a row's or an ancestor's read is taken from the formula.
  const given: Record<string, unknown> = {};
  const reads = [...rule.reads];
  for (const path of scopedReads(expression)) {
    if (!reads.includes(path)) {
      reads.push(path);
    }
  }
  for (const path of reads) {
    const node = ctx.nodes.get(path);
    if (node !== undefined && node.type === "number" && holdsData(node) && node.collection === undefined) {
      const read = pathOf(ctx, path);
      addRows(lines, read.rows);
      given[path] = 2 + lines.sets.length;
      lines.sets.push(`set ${read.path} = ${given[path] as number}`);
    }
  }
  // The judge reads no row scope (`row.`, `ancestor.`): a row's calculation, or one inside a
  // collection, is checked against the value the lines' answers give, at the row's path.
  const inRow = placed.path.includes("[") || /(^|[^A-Za-z0-9_.])(row|ancestor)\./.test(rule.formula);
  let picks = false;
  if (expression !== undefined && expression.kind === "literal" && expression.value !== null) {
    lines.steps.push(`expect ${placed.path} = ${testsLiteral(expression.value) as string}`);
  } else if (inRow) {
    let worked: unknown;
    try {
      worked = expression !== undefined ? evaluateExpression(expression, { values: given, rowValues: given, ancestorValues: given, today: SCAFFOLD_DAY }) : undefined;
    } catch {
      worked = undefined;
    }
    const literal = worked !== null && worked !== undefined && !(typeof worked === "number" && !Number.isFinite(worked)) ? testsLiteral(worked) : undefined;
    if (literal !== undefined) {
      lines.steps.push(`expect ${placed.path} = ${literal}`);
    } else {
      picks = true;
      lines.steps.push(`expect ${placed.path} = ""  # ${builderText("tests.scaffold.pick.true", { formula: oneLine(rule.formula).replace(/"/g, "'") }, ctx.text)}`);
    }
  } else {
    // `=` binds tighter than the logical operators and looser than arithmetic: only a formula that
    // is not arithmetic, a name or a call needs its brackets (a bracket round a literal is a list).
    const bare = expression !== undefined && (expression.kind === "arithmetic" || expression.kind === "path" || expression.kind === "call");
    const text = oneLine(rule.formula);
    lines.steps.push(`expect ${formulaId(rule.target.id)} = ${bare ? text : `(${text})`}`);
  }
  const name = builderText("tests.scaffold.name.calculate", { target, formula }, ctx.text);
  return [{ name, source: sourceOf(name, lines, ctx, true), picks }];
}

/**
 * The row-limit scenarios. A grid opens with its `initialRows`, so each case first brings the row
 * count to the one it is about (adding, or removing the first row) and says so with `expect rows
 * of`, which also fails readably when the form opens with a different number. A form refuses an
 * add past its maximum, so the over-the-limit case of `max-rows` cannot be written (a test has no
 * statement for a refused add): only the case at the limit is, and the note says why.
 */
function rowEntries(rule: LogicRule, expression: Expression | undefined, ctx: Context): { entries: Entry[]; notes: string[] } {
  const isMin = rule.kind === "min-rows";
  const target = targetName(rule, ctx);
  const placed = pathOf(ctx, rule.target.id);
  const opens = initialRowsOf(ctx, ctx.dataPaths.get(rule.target.id) ?? rule.target.id);
  const rows = cut(rule.formula);
  const base = isMin ? "tests.scaffold.name.minRows" : "tests.scaffold.name.maxRows";
  const code = isMin ? "rows.min" : "rows.max";
  const setup = emptyLines();
  let limit =
    expression !== undefined && expression.kind === "literal" && typeof expression.value === "number" && Number.isInteger(expression.value) && expression.value >= 0
      ? expression.value
      : undefined;
  let pick = false;
  if (limit === undefined && expression !== undefined && expression.kind === "path") {
    // A limit that is one number answer: give it a value, and the limit is that value.
    const node = ctx.nodes.get(expression.path);
    if (node !== undefined && node.type === "number" && holdsData(node) && node.collection === undefined) {
      const read = pathOf(ctx, expression.path);
      addRows(setup, read.rows);
      setup.sets.push(`set ${read.path} = 1`);
      limit = 1;
    }
  }
  const make = (count: number, fails: boolean): Entry => {
    const lines: Lines = { ...emptyLines(), rows: [...setup.rows, ...placed.rows.filter((row) => !setup.rows.includes(row))], sets: [...setup.sets] };
    if (pick) {
      lines.sets.push(`# ${builderText("tests.scaffold.pick.rows", { formula: oneLine(rule.formula).replace(/"/g, "'") }, ctx.text)}`);
      lines.picks = true;
    }
    for (let at = opens; at < count; at += 1) {
      lines.steps.push(`add row to ${placed.path}`);
    }
    for (let at = count; at < opens; at += 1) {
      lines.steps.push(`remove row 0 of ${placed.path}`);
    }
    lines.steps.push(`expect rows of ${placed.path} = ${count}`, "check", fails ? `expect error on ${placed.path}: ${code}` : `expect no error on ${placed.path}`);
    const name = builderText(`${base}.${fails ? "fails" : "holds"}` as "tests.scaffold.name.minRows.fails", { target, rows }, ctx.text);
    return { name, source: sourceOf(name, lines, ctx, true), picks: lines.picks };
  };
  const entries: Entry[] = [];
  const notes: string[] = [];
  if (limit === undefined) {
    // A limit worked out from the answers: for a minimum, the case with no rows is still the one to write.
    if (isMin) {
      pick = true;
      entries.push(make(0, true));
    }
    return { entries, notes };
  }
  if (limit <= MAX_ROW_LINES) {
    entries.push(make(limit, false));
  } else {
    notes.push(builderText("tests.scaffold.note.rows", undefined, ctx.text));
  }
  if (isMin) {
    if (limit > 0) {
      entries.push(make(0, true));
    }
  } else {
    notes.push(builderText("tests.scaffold.note.maxRows", undefined, ctx.text));
  }
  return { entries, notes };
}

/** The pages of a journey from its first to `pageId`, in the order the journey declares them. */
function pagesThrough(journeyId: string, pageId: string, ctx: Context): string[] {
  const journey = readJourneys(ctx.definition).find((entry) => entry.id === journeyId);
  const pages = journey?.pages.map((page) => page.id) ?? [pageId];
  const at = pages.indexOf(pageId);
  return at < 0 ? [pageId] : pages.slice(0, at + 1);
}

/**
 * The pages the journey takes for the answers a scenario sets: the real forward walk
 * (`journeyPath`) over those answers, every component counted visible. Used to write the exact
 * `expect path` a route's scenario can stand on; `undefined` when the walk cannot be made.
 */
function predictedPath(journeyId: string, lines: Lines, ctx: Context): string[] | undefined {
  try {
    // The walk reads trees, not formula text: compile the definition's journeys the way every runtime does first.
    const compiled = kernelCompileDefinition(ctx.root, ctx.definition.journey, undefined, kernelParseFormula, ctx.signatures);
    const journey = readJourneys({ journey: compiled.definition.journey }).find((entry) => entry.id === journeyId);
    if (journey === undefined) {
      return undefined;
    }
    const trace = journeyPath(journey, {
      values: { ...lines.values },
      ownership: journeyOwnership(ctx.root, journey),
      evaluate: (expression, values) => evaluateExpression(expression, { values, hostContext: { ...lines.host }, today: SCAFFOLD_DAY })
    });
    return trace.pages;
  } catch {
    return undefined;
  }
}

function routeEntries(rule: LogicRule, expression: Expression | undefined, ctx: Context): Entry[] {
  if (rule.source.mode !== "journeys") {
    return [];
  }
  const { journeyId, pageId } = rule.source;
  const lines = conditionLines(rule, expression, true, ctx);
  lines.givens.unshift(`given journey = ${journeyId}`);
  const through = pagesThrough(journeyId, pageId, ctx);
  const predicted = lines.picks ? undefined : predictedPath(journeyId, lines, ctx);
  const ends = rule.target.type === "journey-end";
  if (ends) {
    // The end of a journey is no page: the path runs through the route's page and off the end.
    const taken = predicted !== undefined && predicted[predicted.length - 1] === pageId ? predicted : through;
    lines.steps.push(`expect path = (${taken.join(", ")})`, "expect path ends");
  } else {
    if (through.length > 1) {
      lines.steps.push(`go to ${pageId}`);
    }
    lines.steps.push("continue", `expect page = ${rule.target.id}`);
    // The whole path, when the walk over the chosen answers goes from this page to the target:
    // it is the statement a route is pinned by, and it reads the same answers the route does.
    const at = predicted?.indexOf(pageId) ?? -1;
    if (predicted !== undefined && at >= 0 && predicted[at + 1] === rule.target.id) {
      lines.steps.push(`expect path = (${predicted.join(", ")})`);
    }
  }
  const name = builderText(
    "tests.scaffold.name.route",
    { from: ctx.naming.pageLabelOf(pageId) ?? pageId, target: targetName(rule, ctx), condition: wordedCondition(expression, ctx) },
    ctx.text
  );
  return [{ name, source: sourceOf(name, lines, ctx, false), picks: lines.picks }];
}

function layoutEntries(rule: LogicRule, expression: Expression | undefined, ctx: Context): Entry[] {
  const lines = conditionLines(rule, expression, true, ctx);
  lines.steps.push(`expect layout = ${rule.target.id}`);
  const name = builderText("tests.scaffold.name.pdfLayout", { target: targetName(rule, ctx), condition: wordedCondition(expression, ctx) }, ctx.text);
  return [{ name, source: sourceOf(name, lines, ctx, true), picks: lines.picks }];
}

// --- the entry point -----------------------------------------------------------------------------

/**
 * The scenarios that pin `rule`, as whole `test "..."` blocks the panel appends to the form's
 * tests in one step. `entries` is empty (with a `note`) for a kind the language cannot read.
 * `text` is the builder's catalog options, so the names follow the builder's locale.
 */
export function scaffoldTestsForRule(
  rule: LogicRule,
  root: ComponentNode,
  definition: FormDefinition,
  naming: TestsNaming,
  signatures: readonly FormulaFunctionSignature[],
  text?: BuilderTextOptions
): TestsScaffold {
  if (!scaffoldableKinds.includes(rule.kind)) {
    return { entries: [], note: builderText("tests.scaffold.note.unsupported", undefined, text) };
  }
  const ctx: Context = {
    root,
    definition,
    naming,
    signatures: signatures.slice(),
    text,
    nodes: nodeIndex(root),
    dataPaths: buildDataPaths(root),
    hasJourneys: readJourneys(definition).length > 0
  };
  const expression = expressionOf(rule, ctx);
  let made: Entry[];
  const notes: string[] = [];
  switch (rule.kind) {
    case "show":
    case "hide":
    case "show-step":
    case "hide-step":
    case "require":
    case "enable":
    case "readonly":
      made = stateEntries(rule, expression, ctx);
      break;
    case "validate":
      made = validateEntries(rule, expression, ctx);
      break;
    case "calculate":
      made = calculateEntries(rule, expression, ctx);
      break;
    case "min-rows":
    case "max-rows": {
      const rows = rowEntries(rule, expression, ctx);
      made = rows.entries;
      notes.push(...rows.notes);
      break;
    }
    case "route":
      made = routeEntries(rule, expression, ctx);
      break;
    case "pdf-layout":
      made = layoutEntries(rule, expression, ctx);
      break;
    default:
      made = [];
  }
  // A source that does not parse as exactly one scenario is not offered (see the header).
  const parsable = made.filter((entry) => {
    const parsed = kernelParseFormTests(entry.source, ctx.signatures);
    return parsed.problems.length === 0 && parsed.scenarios.length === 1;
  });
  if (parsable.some((entry) => entry.picks)) {
    notes.push(builderText("tests.scaffold.note.pick", undefined, text));
  }
  if (rule.kind === "route" && parsable.length > 0) {
    // Continue leaves a page only when its answers are valid, which a scaffold cannot know.
    notes.push(builderText("tests.scaffold.note.route", undefined, text));
  }
  if (parsable.length === 0) {
    notes.push(builderText("tests.scaffold.note.unsupported", undefined, text));
  }
  return {
    entries: parsable.map((entry) => ({ name: entry.name, source: entry.source })),
    ...(notes.length > 0 ? { note: notes.join(" ") } : {})
  };
}
