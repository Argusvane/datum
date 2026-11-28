import type { FORMULA_FUNCTION_TABLE } from "./function-table.js";

/**
 * Deterministic expression AST used by rule attachments on {@link ComponentNode} and by the
 * rules evaluator. Every node is a plain data structure so it can be persisted, hashed, and
 * executed identically across runtimes. A rule may be written as this tree, as a FEEL-subset
 * formula string the parser (`core/expressions/formula.ts`) turns into one, or as a
 * {@link RuleObject} that also says where the rule runs; see {@link RuleSource}.
 *
 * `if` picks the first case whose `when` is truthy; with none and no `else` it yields
 * `undefined` (no answer, no default, a condition that does not hold). Nothing here reads a
 * clock: `today()` and `age()` take the day from the evaluation context the host supplies
 * (`RuleEvaluationContext.today`).
 */
export type Expression =
  | LiteralExpression
  | PathExpression
  | UnaryExpression
  | BinaryExpression
  | LogicalExpression
  | ArithmeticExpression
  | FunctionCallExpression
  | IfExpression;

export interface LiteralExpression {
  kind: "literal";
  value: string | number | boolean | null;
}

export interface PathExpression {
  kind: "path";
  /**
   * Dotted path. Optional scope prefix: `row.`, `host.`, `ancestor.`, or `component`
   * (bare `component`, or `component.<field>`). No prefix reads form-scoped values.
   */
  path: string;
}

export interface UnaryExpression {
  kind: "unary";
  operator: "not";
  operand: Expression;
}

export interface BinaryExpression {
  kind: "binary";
  /** `gt`, `gte`, `lt` and `lte` order two `YYYY-MM-DD` strings by code unit, anything else numerically. */
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  left: Expression;
  right: Expression;
}

export interface LogicalExpression {
  kind: "logical";
  operator: "and" | "or";
  left: Expression;
  right: Expression;
}

export interface ArithmeticExpression {
  kind: "arithmetic";
  operator: "add" | "subtract" | "multiply" | "divide";
  left: Expression;
  right: Expression;
}

/**
 * The built-in functions a `call` may name, derived from the rows of the function table
 * (`core/expressions/function-table.ts`). Pure: no I/O, no locale-sensitive behaviour, and
 * no clock beyond the day the evaluation context supplies.
 */
export type ExpressionFunctionName = (typeof FORMULA_FUNCTION_TABLE)[number]["name"];

export interface FunctionCallExpression {
  kind: "call";
  /**
   * A built-in name, or the name of a function a plugin declared (`FormPlugin.formulaFunctions`),
   * which the parser accepts from the signatures it is handed. `string & {}` keeps the built-in
   * union as completions while letting a plugin name through without a cast.
   */
  name: ExpressionFunctionName | (string & {});
  args: Expression[];
}

/**
 * A cases chain: the `then` of the first case whose `when` is truthy, else `else`, else
 * `undefined`. The parser writes `if a then b else if c then d else e` as one node with two
 * cases.
 */
export interface IfExpression {
  kind: "if";
  cases: Array<{ when: Expression; then: Expression }>;
  else?: Expression;
}

/**
 * Where a rule runs. `both` (the default) is today's behaviour; `browser` is applied by the
 * browser and skipped by the kernel as a `host.` read is; `server` is ignored by the browser
 * and applied by the kernel; `server-secret` is `server` and the rule is stripped from the
 * definition a host serves to a browser.
 */
export type RunScope = "both" | "browser" | "server" | "server-secret";

/**
 * What a runtime does with a formula problem (a rule that does not parse, a function it lacks,
 * a rule that throws): `fail` (the default, on every side) refuses the definition or the
 * submission, naming the problem; `warn` is the explicit opt-in for preview and staging: the
 * rule is dropped and the run log says so. Any other value is no policy word: the next place
 * that names one decides, else the default.
 */
export type FormulaErrorPolicy = "warn" | "fail";

/** A rule with its run scope: a formula, or none (an absent rule). */
export interface RuleObject {
  formula?: string;
  run?: RunScope;
}

/** A rule as a definition may write it: a FEEL-subset formula, or a {@link RuleObject}. */
export type RuleSource = string | RuleObject;
