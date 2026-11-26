import type { Expression } from "./expression.js";

/**
 * The types the formula parser (`core/expressions/formula.ts`) and the definition compiler
 * (`core/expressions/compile.ts`) share with their callers: the runtimes that compile a
 * definition, the hosts that report problems and the builder that words them. Types only;
 * the kernel-shaped parser and compiler import nothing from here at run time.
 *
 * Offsets are 0-based UTF-16 code unit offsets into the formula text, `end` exclusive, so a
 * builder can underline the span in its editor.
 */

/** A field path a formula reads, with the span of the text that named it. */
export interface FormulaPathRef {
  /** The dotted path as the evaluator reads it, scope prefix included (`row.amount`). */
  path: string;
  start: number;
  end: number;
}

/**
 * Why a formula failed to parse. Codes, never sentences: the builder words each from its
 * catalog (`formula.err.<code>`), the kernel's log uses the plain English `message`.
 *
 * - `unexpected`: a token where none fits (`params.token`).
 * - `expectedValue`: the formula ended where a value was due.
 * - `expectedValueHere`: a value was due at `params.token`.
 * - `expectedOperator`: two values with nothing between them.
 * - `unclosedParen`: an opening parenthesis without its closing one.
 * - `unmatchedParen`: a closing parenthesis without its opening one.
 * - `unterminatedString`: a quote without its closing quote.
 * - `curlyQuote`: a typographic quote where a straight one was meant.
 * - `unterminatedName`: a backtick without its closing backtick.
 * - `emptyName`: a backticked name with nothing inside.
 * - `badChar`: a character the grammar has no use for (`params.char`).
 * - `unknownFunction`: a call to a name the signatures lack (`params.name`).
 * - `arity`: a call with the wrong argument count (`params.name`, `params.expected`, `params.got`).
 * - `arityMin`: a variadic call with too few arguments (`params.name`, `params.min`, `params.got`).
 * - `betweenAnd`: `between` without its `and`.
 * - `inList`: `in` without a parenthesised list.
 * - `intervalDots`: an interval without its `..`, or one written with three dots (`[1...2]`).
 * - `ifThen`: `if` without `then`.
 * - `chainedCompare`: `a < b < c`, which the grammar refuses.
 * - `numberTooLarge`: a number literal beyond the double range (`1e999`), `params.token` its text.
 * - `badUnit`: `dateAdd` or `dateDiff` with a literal unit other than days, weeks, months or years
 *   (`params.name`, `params.unit`).
 * - `tooDeep`: parentheses, calls, `if`, intervals and prefix operators nested deeper than the
 *   parser allows (`params.max`, the limit; `params.token`, the opener that went past it). The
 *   limit is counted before the parser descends, so a sandbox with a small stack never overflows.
 */
export type FormulaErrorCode =
  | "unexpected"
  | "expectedValue"
  | "expectedValueHere"
  | "expectedOperator"
  | "unclosedParen"
  | "unmatchedParen"
  | "unterminatedString"
  | "curlyQuote"
  | "unterminatedName"
  | "emptyName"
  | "badChar"
  | "unknownFunction"
  | "arity"
  | "arityMin"
  | "betweenAnd"
  | "inList"
  | "intervalDots"
  | "ifThen"
  | "chainedCompare"
  | "numberTooLarge"
  | "badUnit"
  | "tooDeep"
  | "pattern.risky";

/**
 * What parsing a formula yields: its tree and every path it reads, or the first problem with
 * its span. A blank formula parses to `expression: undefined` (a rule that is absent).
 */
export type FormulaParseResult =
  | { ok: true; expression: Expression | undefined; paths: FormulaPathRef[] }
  | {
      ok: false;
      code: FormulaErrorCode;
      /** The code's placeholders (a token, a name, a count), for the builder's catalog. */
      params: Record<string, string | number>;
      /** Plain English from the code, for logs. */
      message: string;
      start: number;
      end: number;
    };

/** A function the parser accepts: its name and the argument count it takes (`max` may be `Infinity`). */
export interface FormulaFunctionSignature {
  name: string;
  min: number;
  max: number;
}

/**
 * One problem the definition compiler found in a rule: where it sits
 * (`rules:<componentId>:<key>`, `journey:<journeyId>:page:<pageId>`, `pdf:<layoutId>`, and the
 * like), what went wrong and, for a formula, the span in its text.
 */
export interface FormulaProblem {
  where: string;
  /**
   * A parse code; `runScope` for a `run` the site may not take (`params.key`, `params.run`), the
   * rule then running on both sides; `invalidRule` for a value that is neither a formula string,
   * a tree nor the object form (`params.got`, its JSON type), the key then dropped;
   * `condition.notBoolean` for a condition whose result is provably not a yes-or-no
   * (`params.key`) and `rule.unsupportedScope` for a `validWhen` on a field inside a repeating
   * section, which neither side runs (`params.key`); both only ever appear among the
   * {@link CompiledDefinition.warnings}.
   */
  code: FormulaErrorCode | "runScope" | "invalidRule" | "condition.notBoolean" | "rule.unsupportedScope";
  /** `"warning"` for a finding that never refuses a run; absent for a mistake the `formulaErrors` policy acts on. */
  severity?: "warning";
  message: string;
  params?: Record<string, string | number>;
  start?: number;
  end?: number;
  /** The formula text, when the rule was one. */
  text?: string;
}

/** Which side evaluates a rule; a rule's `run` scope decides whether that side applies it. */
export type EvaluationSide = "browser" | "server";

/**
 * A definition with every string rule replaced by its tree, as a copy of the author's object
 * (the original is never mutated: hosts hash it), with the problems found on the way.
 */
export interface CompiledDefinition<T> {
  definition: T;
  problems: FormulaProblem[];
  /**
   * Findings that are not mistakes: a condition whose result is provably not a yes-or-no
   * (`condition.notBoolean`, severity `warning`). Never part of `problems`, so the
   * `formulaErrors` policy does not act on them.
   */
  warnings?: FormulaProblem[];
}
