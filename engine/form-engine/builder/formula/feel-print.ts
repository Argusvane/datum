/**
 * The formula printer: an expression tree back as FEEL-subset text, the way the parser
 * (`core/expressions/formula.ts`) reads it. Lossless by structure: for every tree `e`,
 * `kernelParseFormula(printFormula(e), signatures).expression` deep-equals `e` (the seeded
 * random-tree test in `tests/feel-print.test.ts` pins it). The builder uses it to write a rule
 * it works out as text (a generated default, a placeholder value) and, with labels, for the
 * "Reads as" line.
 *
 * Canonical spelling: double-quoted strings; `not(…)` always; `x between a and b` for an
 * `and` of `gte` and `lte` over one left operand, `x in [a..b)` and the other interval forms
 * for the other pairs, `x in (a, b, c)` for a left-folded `or` of `eq` over one left operand;
 * flat chains (`a or b or c`), parentheses where the parser would read the tree differently
 * and around an `and` inside an `or`; `-x` for `subtract(0, x)`; `@"2026-01-01"` for a date
 * literal; `else if` ladders as one `if`. With `multiline`, a top-level `if` puts each case on
 * its own lines, the `then` indented.
 *
 * {@link printFormulaTokens} is the same walk as tokens (a field, a value, a keyword, an
 * operator, a function name, plain text), so a host can draw chips and pills; with `labelOf`
 * and `optionLabelOf` the text reads with labels and is no longer meant to be parsed.
 */
import type { Expression, IfExpression } from "../../core/expressions/expression.js";
import { feelName, isBareFormulaName } from "./feel-functions.js";

export interface PrintFormulaOptions {
  /** A field's name in place of its id; `undefined` keeps the id (backticked when the grammar needs it). */
  labelOf?: ((path: string) => string | undefined) | undefined;
  /** An option's name for a string compared with a field (`province = "QC"` reads "Quebec"); `undefined` keeps the quoted value. */
  optionLabelOf?: ((path: string, value: string) => string | undefined) | undefined;
  /** A top-level `if` with each case on its own lines. */
  multiline?: boolean | undefined;
}

/** One piece of a printed formula; `text` is what the formula reads, `path` the id a field token stands for. */
export interface PrintedFormulaToken {
  kind: "field" | "value" | "keyword" | "operator" | "function" | "text";
  text: string;
  path?: string;
  /** A value token's display text without its quotes (the option's label when one was found). */
  value?: string;
}

/** The formula as text; see the module note for its spelling. */
export function printFormula(expression: Expression, options: PrintFormulaOptions = {}): string {
  return printFormulaTokens(expression, options)
    .map((token) => token.text)
    .join("");
}

/** The formula as tokens, in reading order, spaces included as `text` tokens. */
export function printFormulaTokens(expression: Expression, options: PrintFormulaOptions = {}): PrintedFormulaToken[] {
  const printer = new Printer(options);
  try {
    printer.top(expression);
  } catch (error) {
    // A tree nested past what the stack holds (the controller refuses such a form where it is
    // loaded, a direct caller may not): shown as an ellipsis, never a crash of the panel.
    if (error instanceof RangeError) {
      return [{ kind: "text", text: "…" }];
    }
    throw error;
  }
  return printer.tokens;
}

// --- recoveries ----------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality of two trees (key order ignored, so a hand-written clone matches a parsed one). */
export function sameExpression(a: unknown, b: unknown): boolean {
  // An explicit stack of pairs: the operand of a comparison can itself be a 20,000-term chain,
  // whose left spine must cost no call-stack depth.
  const pending: Array<[unknown, unknown]> = [[a, b]];
  for (let top = pending.pop(); top !== undefined; top = pending.pop()) {
    const [x, y] = top;
    if (x === y) {
      continue;
    }
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) {
        return false;
      }
      for (let at = 0; at < x.length; at += 1) {
        pending.push([x[at], y[at]]);
      }
      continue;
    }
    if (!isRecord(x) || !isRecord(y)) {
      return false;
    }
    const keysX = Object.keys(x).filter((key) => x[key] !== undefined);
    const keysY = Object.keys(y).filter((key) => y[key] !== undefined);
    if (keysX.length !== keysY.length) {
      return false;
    }
    for (const key of keysX) {
      if (!Object.prototype.hasOwnProperty.call(y, key)) {
        return false;
      }
      pending.push([x[key], y[key]]);
    }
  }
  return true;
}

interface RangeShape {
  left: Expression;
  low: Expression;
  high: Expression;
  lowOperator: "gte" | "gt";
  highOperator: "lte" | "lt";
}

/** An `and` of a lower bound and an upper bound on one left operand: `between` or an interval. */
function rangeOf(node: Expression): RangeShape | undefined {
  if (node.kind !== "logical" || node.operator !== "and") {
    return undefined;
  }
  const { left, right } = node;
  if (left.kind !== "binary" || right.kind !== "binary") {
    return undefined;
  }
  if ((left.operator !== "gte" && left.operator !== "gt") || (right.operator !== "lte" && right.operator !== "lt")) {
    return undefined;
  }
  if (!sameExpression(left.left, right.left)) {
    return undefined;
  }
  return { left: left.left, low: left.right, high: right.right, lowOperator: left.operator, highOperator: right.operator };
}

interface InShape {
  left: Expression;
  items: Expression[];
}

/**
 * Per `or` node, the left operand its whole left spine is `eq` on, or `null` when some leaf is
 * not an `eq` on it. Filled bottom-up in one pass, so a chain of n terms costs n however often
 * the printer asks about its nodes.
 */
const RUN_LEFTS = new WeakMap<object, Expression | null>();

/** A left-folded `or` whose every leaf is `eq` on one left operand, two leaves or more: `in (…)`. */
function inRunOf(node: Expression): InShape | undefined {
  if (node.kind !== "logical" || node.operator !== "or") {
    return undefined;
  }
  const spine: Array<Extract<Expression, { kind: "logical" }>> = [];
  let current: Expression = node;
  while (current.kind === "logical" && current.operator === "or" && !RUN_LEFTS.has(current)) {
    spine.push(current);
    current = current.left;
  }
  // `current` is the first node already known, or the bottom leaf.
  let left: Expression | null;
  if (current.kind === "logical" && current.operator === "or") {
    left = RUN_LEFTS.get(current) ?? null;
  } else {
    left = current.kind === "binary" && current.operator === "eq" ? current.left : null;
  }
  for (let at = spine.length - 1; at >= 0; at -= 1) {
    const entry = spine[at] as Extract<Expression, { kind: "logical" }>;
    const leaf = entry.right;
    if (left !== null && !(leaf.kind === "binary" && leaf.operator === "eq" && sameExpression(leaf.left, left))) {
      left = null;
    }
    RUN_LEFTS.set(entry, left);
  }
  const run = RUN_LEFTS.get(node);
  if (run === null || run === undefined) {
    return undefined;
  }
  const items: Expression[] = [];
  current = node;
  while (current.kind === "logical" && current.operator === "or") {
    items.push((current.right as Extract<Expression, { kind: "binary" }>).right);
    current = current.left;
  }
  items.push((current as Extract<Expression, { kind: "binary" }>).right);
  items.reverse();
  return { left: run, items };
}

/** `subtract(0, x)` with `x` not a number literal (a number would fold into a negative literal). */
function negatedOf(node: Expression): Expression | undefined {
  if (node.kind !== "arithmetic" || node.operator !== "subtract") {
    return undefined;
  }
  const { left, right } = node;
  if (left.kind !== "literal" || left.value !== 0 || Object.is(left.value, -0)) {
    return undefined;
  }
  if (right.kind === "literal" && typeof right.value === "number") {
    return undefined;
  }
  return right;
}

/** `date("YYYY-MM-DD")` with a literal day: the `@"YYYY-MM-DD"` spelling. */
function dateLiteralOf(node: Expression): string | undefined {
  if (node.kind !== "call" || node.name !== "date" || node.args.length !== 1) {
    return undefined;
  }
  const argument = node.args[0];
  if (argument === undefined || argument.kind !== "literal" || typeof argument.value !== "string") {
    return undefined;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(argument.value) ? argument.value : undefined;
}

// --- spelling -------------------------------------------------------------------------------------

/** A number as the grammar reads it back: `String()`'s spelling, a sign in front of a negative one. */
export function spellFormulaNumber(value: number): string {
  if (!Number.isFinite(value)) {
    // The grammar has no spelling for these; `null` is the nearest value a formula can say.
    return "null";
  }
  if (value < 0 || Object.is(value, -0)) {
    return "-" + String(-value);
  }
  return String(value);
}

/** A string in double quotes with the escapes the parser resolves. */
export function spellFormulaString(value: string): string {
  return (
    '"' +
    value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r") +
    '"'
  );
}

/**
 * How tightly a node's spelling binds, loosest first: 0 `if` (its `else` runs to the end), 1
 * `or`, 2 `and`, 3 a comparison (`=`, `between`, `in`), 4 `+ -`, 5 `* /`, 6 unary minus, 7 a
 * primary (a value, a field, a call, `not(…)`).
 */
function levelOf(node: Expression): number {
  switch (node.kind) {
    case "if":
      return 0;
    case "logical":
      if (node.operator === "or") {
        return inRunOf(node) ? 3 : 1;
      }
      return rangeOf(node) ? 3 : 2;
    case "binary":
      return 3;
    case "arithmetic":
      if (node.operator === "add" || node.operator === "subtract") {
        return negatedOf(node) ? 6 : 4;
      }
      return 5;
    default:
      return 7;
  }
}

/** A plain `and` (not a range): the one shape that takes parentheses inside an `or` for the reader's sake. */
function isPlainAnd(node: Expression): boolean {
  return node.kind === "logical" && node.operator === "and" && rangeOf(node) === undefined;
}

class Printer {
  public readonly tokens: PrintedFormulaToken[] = [];

  public constructor(private readonly options: PrintFormulaOptions) {}

  public top(node: Expression): void {
    if (node.kind === "if" && this.options.multiline === true) {
      this.printIf(node, true);
      return;
    }
    this.print(node);
  }

  private push(kind: PrintedFormulaToken["kind"], text: string, extra?: Partial<PrintedFormulaToken>): void {
    this.tokens.push({ kind, text, ...(extra ?? {}) });
  }

  private space(): void {
    this.push("text", " ");
  }

  private keyword(word: string): void {
    this.push("keyword", word);
  }

  private operator(text: string): void {
    this.push("operator", text);
  }

  /** `node` where a spelling of at least `min` binding is due: in parentheses when it binds looser. */
  private at(node: Expression, min: number): void {
    if (levelOf(node) < min) {
      this.operator("(");
      this.print(node);
      this.operator(")");
      return;
    }
    this.print(node);
  }

  private print(node: Expression): void {
    switch (node.kind) {
      case "literal":
        this.printLiteral(node.value, undefined);
        return;
      case "path":
        this.printPath(node.path);
        return;
      case "unary":
        this.push("function", "not");
        this.operator("(");
        this.at(node.operand, 0);
        this.operator(")");
        return;
      case "binary":
        this.printBinary(node.operator, node.left, node.right);
        return;
      case "logical":
        this.printLogical(node);
        return;
      case "arithmetic":
        this.printArithmetic(node);
        return;
      case "call":
        this.printCall(node.name, node.args);
        return;
      case "if":
        this.printIf(node, false);
        return;
      default:
        this.push("text", "?");
    }
  }

  private printLiteral(value: string | number | boolean | null, path: string | undefined): void {
    if (typeof value === "string") {
      const label = path !== undefined ? this.options.optionLabelOf?.(path, value) : undefined;
      const shown = label ?? value;
      this.push("value", spellFormulaString(shown), { value: shown });
      return;
    }
    if (typeof value === "number") {
      const text = spellFormulaNumber(value);
      this.push("value", text, { value: text });
      return;
    }
    if (value === null) {
      this.push("keyword", "null", { value: "null" });
      return;
    }
    this.push("keyword", value ? "true" : "false", { value: value ? "true" : "false" });
  }

  private printPath(path: string): void {
    const label = this.options.labelOf?.(path);
    this.push("field", label ?? feelName(path), { path });
  }

  /** A right operand next to a field: a string literal reads as the option's label when one is known. */
  private printOperand(node: Expression, min: number, besidePath: Expression): void {
    if (node.kind === "literal" && typeof node.value === "string" && besidePath.kind === "path") {
      this.printLiteral(node.value, besidePath.path);
      return;
    }
    this.at(node, min);
  }

  private printBinary(operator: string, left: Expression, right: Expression): void {
    const symbol = operator === "eq" ? "=" : operator === "neq" ? "!=" : operator === "gt" ? ">" : operator === "gte" ? ">=" : operator === "lt" ? "<" : "<=";
    this.at(left, 4);
    this.space();
    this.operator(symbol);
    this.space();
    this.printOperand(right, 4, left);
  }

  private printLogical(node: Extract<Expression, { kind: "logical" }>): void {
    if (node.operator === "or") {
      const run = inRunOf(node);
      if (run) {
        this.printInRun(run);
        return;
      }
      this.printChain(
        node,
        (entry) => entry.kind === "logical" && entry.operator === "or" && inRunOf(entry) === undefined,
        (entry) => this.printOrOperand(entry, 1),
        () => this.keyword("or"),
        (entry) => this.printOrOperand(entry, 2)
      );
      return;
    }
    const range = rangeOf(node);
    if (range) {
      this.printRange(range);
      return;
    }
    this.printChain(
      node,
      (entry) => entry.kind === "logical" && entry.operator === "and" && rangeOf(entry) === undefined,
      (entry) => this.at(entry, 2),
      () => this.keyword("and"),
      (entry) => this.at(entry, 3)
    );
  }

  /**
   * A left-leaning chain of one operator (`a or b or c`, `a + b + c`) written left to right in a
   * loop, so a chain of any length prints without the call stack growing with it. `isLink` says
   * whether a left child continues the chain; `first` writes the leftmost operand, `operator`
   * the operator of a link (given the link), `rest` its right operand.
   */
  private printChain(
    top: Expression,
    isLink: (node: Expression) => boolean,
    first: (node: Expression) => void,
    operator: (node: Expression) => void,
    rest: (node: Expression) => void
  ): void {
    const links: Array<Extract<Expression, { kind: "logical" } | { kind: "arithmetic" }>> = [];
    let current: Expression = top;
    while ((current.kind === "logical" || current.kind === "arithmetic") && isLink(current)) {
      links.push(current);
      current = current.left;
    }
    first(current);
    for (let at = links.length - 1; at >= 0; at -= 1) {
      const link = links[at] as (typeof links)[number];
      this.space();
      operator(link);
      this.space();
      rest(link.right);
    }
  }

  private printOrOperand(node: Expression, min: number): void {
    if (isPlainAnd(node)) {
      this.operator("(");
      this.print(node);
      this.operator(")");
      return;
    }
    this.at(node, min);
  }

  private printInRun(run: InShape): void {
    this.at(run.left, 4);
    this.space();
    this.keyword("in");
    this.space();
    this.operator("(");
    run.items.forEach((item, index) => {
      if (index > 0) {
        this.operator(",");
        this.space();
      }
      this.printOperand(item, 1, run.left);
    });
    this.operator(")");
  }

  private printRange(range: RangeShape): void {
    this.at(range.left, 4);
    this.space();
    if (range.lowOperator === "gte" && range.highOperator === "lte") {
      this.keyword("between");
      this.space();
      this.printOperand(range.low, 4, range.left);
      this.space();
      this.keyword("and");
      this.space();
      this.printOperand(range.high, 4, range.left);
      return;
    }
    this.keyword("in");
    this.space();
    this.operator(range.lowOperator === "gte" ? "[" : "(");
    this.printOperand(range.low, 1, range.left);
    this.operator("..");
    this.printOperand(range.high, 1, range.left);
    this.operator(range.highOperator === "lte" ? "]" : ")");
  }

  private printArithmetic(node: Extract<Expression, { kind: "arithmetic" }>): void {
    const negated = negatedOf(node);
    if (negated !== undefined) {
      this.operator("-");
      this.at(negated, 6);
      return;
    }
    const additive = node.operator === "add" || node.operator === "subtract";
    const symbol = node.operator === "add" ? "+" : node.operator === "subtract" ? "-" : node.operator === "multiply" ? "*" : "/";
    this.printChain(
      node,
      (entry) => entry.kind === "arithmetic" && (entry.operator === "add" || entry.operator === "subtract") === additive && negatedOf(entry) === undefined,
      (entry) => this.at(entry, additive ? 4 : 5),
      (entry) => this.operator((entry as Extract<Expression, { kind: "arithmetic" }>).operator === "add" ? "+" : (entry as Extract<Expression, { kind: "arithmetic" }>).operator === "subtract" ? "-" : (entry as Extract<Expression, { kind: "arithmetic" }>).operator === "multiply" ? "*" : "/"),
      (entry) => this.at(entry, additive ? 5 : 6)
    );
  }

  private printCall(name: string, args: Expression[]): void {
    const day = dateLiteralOf({ kind: "call", name, args });
    if (day !== undefined) {
      this.push("value", '@"' + day + '"', { value: day });
      return;
    }
    this.push("function", isBareFormulaName(name) ? name : feelName(name));
    this.operator("(");
    args.forEach((argument, index) => {
      if (index > 0) {
        this.operator(",");
        this.space();
      }
      this.at(argument, 0);
    });
    this.operator(")");
  }

  private printIf(node: IfExpression, multiline: boolean): void {
    const thenBreak = (): void => {
      if (multiline) {
        this.push("text", "\n  ");
      } else {
        this.space();
      }
    };
    const caseBreak = (): void => {
      if (multiline) {
        this.push("text", "\n");
      } else {
        this.space();
      }
    };
    node.cases.forEach((entry, index) => {
      if (index > 0) {
        caseBreak();
        this.keyword("else");
        this.space();
      }
      this.keyword("if");
      this.space();
      this.at(entry.when, 1);
      thenBreak();
      this.keyword("then");
      this.space();
      this.at(entry.then, 1);
    });
    if (node.else !== undefined) {
      if (node.cases.length > 0) {
        caseBreak();
      }
      this.keyword("else");
      this.space();
      this.at(node.else, 1);
    }
  }
}
