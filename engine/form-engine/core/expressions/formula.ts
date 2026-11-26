import type { Expression } from "./expression.js";
import type { FormulaFunctionSignature, FormulaParseResult, FormulaPathRef } from "./formula-types.js";

/**
 * The FEEL-subset formula parser. Text in, the engine's expression tree out. Kernel-shaped so
 * the sandbox and PDF programs splice it in beside the evaluator: top-level `kernel*` function
 * declarations only, no module constants, no clock, regex literals inline. Everything a call
 * needs lives on a parser state object created inside {@link kernelParseFormula} and handed
 * down; nothing outlives the call. {@link FORMULA_FUNCTIONS} lists every function here for
 * `PORTABLE_KERNEL_FUNCTIONS`.
 *
 * Grammar, loosest binding first: `if … then … else if … else …` (else optional), `or`, `and`,
 * comparison (`= == != < <= > >=`, `between a and b`, `in (a, b)`, the intervals `[a..b]`,
 * `(a..b]`, `[a..b)`, `]a..b[`), `+ -`, `* /`, unary minus, primary (number, `"text"` or
 * `'text'`, true/false/null, `@"YYYY-MM-DD"`, `name(args)`, dotted names with glued hyphens,
 * backticked names, `(…)`). `not(x)` is the canonical form; prefix `not` takes one whole
 * comparison. Chained comparisons are an error. Keywords are case-sensitive.
 *
 * Lowerings: `between` → `and(gte, lte)`; `in (…)` → a left-folded `or` of `eq`, one item → `eq`;
 * an interval → `and` of its two bounds; `-5` → the literal; `-x` → `subtract(0, x)`; `@"d"` →
 * `date("d")`; `else if` chains flatten into one `if` node's cases; no `else` → no `else` key.
 *
 * Errors carry a code (the builder words it from its catalog), the parameters the wording
 * needs (`token`, `name`, `char`, `expected`, `got`, `min`, `max`), a plain English message for
 * the kernel log, and an end-exclusive span. At the end of the input
 * `start === end === text.length`.
 */

type FormulaTokenType = "number" | "string" | "date" | "name" | "keyword" | "op" | "end";

type FormulaParseError = Extract<FormulaParseResult, { ok: false }>;

type FormulaParams = Record<string, string | number>;

interface FormulaToken {
  type: FormulaTokenType;
  /** The source spelling. */
  text: string;
  /** A string's or a backticked name's contents; otherwise the spelling. */
  value: string;
  /** A backticked name: never a keyword, never a function name. */
  quoted: boolean;
  start: number;
  end: number;
}

interface FormulaParserState {
  text: string;
  signatures: FormulaFunctionSignature[];
  tokens: FormulaToken[];
  pos: number;
  paths: FormulaPathRef[];
  error: FormulaParseError | undefined;
  /** How many nesting levels the parser is inside; see {@link kernelFormulaEnter}. */
  depth: number;
}

/**
 * Parse `text` against the declared function `signatures` (built from the function table plus
 * wired plugin functions). Blank text is a formula with no expression. Never throws, and never
 * recurses past {@link kernelFormulaMaxDepth} levels: deeper nesting is the `tooDeep` error,
 * counted before the descent, so a sandbox whose stack is smaller than the host's never
 * overflows inside the parser. The tokenizer is linear in the text.
 */
export function kernelParseFormula(text: string, signatures: FormulaFunctionSignature[]): FormulaParseResult {
  const source = typeof text === "string" ? text : "";
  if (source.trim() === "") {
    return { ok: true, expression: undefined, paths: [] };
  }
  const state: FormulaParserState = {
    text: source,
    signatures: Array.isArray(signatures) ? signatures : [],
    tokens: [],
    pos: 0,
    paths: [],
    error: undefined,
    depth: 0
  };
  try {
    kernelFormulaTokenize(state);
    if (state.error !== undefined) {
      return state.error;
    }
    const expression = kernelFormulaParseOr(state);
    if (state.error !== undefined || expression === undefined) {
      return state.error ?? kernelFormulaFail(state, "unexpected", {}, 0, source.length);
    }
    const rest = kernelFormulaPeek(state);
    if (rest.type !== "end") {
      if (kernelFormulaIsOp(rest, ")")) {
        return kernelFormulaFail(state, "unmatchedParen", { token: rest.text }, rest.start, rest.end);
      }
      return kernelFormulaFail(state, "expectedOperator", { token: rest.text }, rest.start, rest.end);
    }
    return { ok: true, expression, paths: state.paths };
  } catch {
    state.error = undefined;
    return kernelFormulaFail(state, "unexpected", {}, 0, source.length);
  }
}

/** Record the first error and return it; every parse helper returns `undefined` after calling this. */
export function kernelFormulaFail(
  state: FormulaParserState,
  code: FormulaParseError["code"],
  params: FormulaParams,
  start: number,
  end: number
): FormulaParseError {
  if (state.error === undefined) {
    state.error = { ok: false, code, params, message: kernelFormulaMessage(code, params), start, end };
  }
  return state.error;
}

/** Plain English for the kernel log; the builder words the same codes from its catalog. */
export function kernelFormulaMessage(code: string, params: FormulaParams): string {
  const token = typeof params.token === "string" ? params.token : "";
  const name = typeof params.name === "string" ? params.name : "";
  const quoted = token === "" ? "" : ' "' + token + '"';
  const tail = token === "" ? " before the end of the formula." : ' but found "' + token + '".';
  switch (code) {
    case "expectedValue":
    case "expectedValueHere":
      return "Expected a value" + tail;
    case "expectedOperator":
      return "Expected an operator" + tail;
    case "unclosedParen":
      return (token === "" ? "Missing " : "Expected ") + String(params.expected ?? '")"') + tail;
    case "unmatchedParen":
      return 'A ")" has no matching "(".';
    case "unterminatedString":
      return "A quoted text has no closing quote.";
    case "curlyQuote":
      return "A curly quote" + quoted + " is not a quote here; use straight quotes.";
    case "unterminatedName":
      return "A backticked name has no closing backtick.";
    case "emptyName":
      return "A backticked name is empty.";
    case "badChar":
      return 'The character "' + String(params.char ?? "") + '" is not part of a formula.';
    case "unknownFunction":
      return 'Unknown function "' + name + '".';
    case "arity": {
      const min = Number(params.min);
      const max = Number(params.max);
      const got = Number(params.got);
      if (min === max) {
        return name + " takes " + String(max) + (max === 1 ? " argument" : " arguments") + " but was given " + String(got) + ".";
      }
      return name + " takes between " + String(min) + " and " + String(max) + " arguments but was given " + String(got) + ".";
    }
    case "arityMin": {
      const min = Number(params.min);
      return name + " needs at least " + String(min) + (min === 1 ? " argument" : " arguments") + " but was given " + String(params.got) + ".";
    }
    case "betweenAnd":
      return 'Expected "and" after the lower bound of between' + tail;
    case "inList":
      return 'Expected a list in brackets after "in"' + tail;
    case "intervalDots":
      return 'Expected ".." between the bounds of a range' + tail;
    case "ifThen":
      return 'Expected "then" after the condition' + tail;
    case "chainedCompare":
      return "Comparisons cannot be chained; join them with and.";
    case "badUnit":
      return name + ' takes "days", "weeks", "months" or "years" as its unit, not "' + String(params.unit ?? "") + '".';
    case "numberTooLarge":
      return "The number" + quoted + " is too large to be a number.";
    case "tooDeep":
      return "The formula nests more than " + String(params.max ?? "") + " levels deep.";
    default:
      return token === "" ? "The formula could not be read." : "Unexpected" + quoted + ".";
  }
}

/** Whether a plain (unquoted) name is one of the grammar's words. */
export function kernelFormulaIsKeywordWord(word: string): boolean {
  return (
    word === "if" ||
    word === "then" ||
    word === "else" ||
    word === "and" ||
    word === "or" ||
    word === "not" ||
    word === "between" ||
    word === "in" ||
    word === "true" ||
    word === "false" ||
    word === "null"
  );
}

/**
 * Fill `state.tokens`, ending with an `end` token; a lexical error is recorded on the state.
 * Linear in the text: the number and name patterns are sticky (`y`) and read at `lastIndex`,
 * and nothing slices the remainder, so a long flat formula tokenizes in one pass. Every `(`
 * opens a level the parser counts ({@link kernelFormulaEnter}), so once more than the limit are
 * unclosed the tokens stop at that `(`: the parser then reports `tooDeep` there, or whatever
 * error comes first in the text, exactly as a full token stream would, without building one.
 */
export function kernelFormulaTokenize(state: FormulaParserState): void {
  const text = state.text;
  const numberPattern = /(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/y;
  const namePattern = /[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*/y;
  let open = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    const start = i;
    if (ch === '"' || ch === "'") {
      const end = kernelFormulaReadString(state, i);
      if (end < 0) {
        return;
      }
      state.tokens.push({ type: "string", text: text.slice(start, end), value: kernelFormulaStringValue(text, start, end), quoted: false, start, end });
      i = end;
      continue;
    }
    if (ch === "@") {
      const quote = text.charAt(i + 1);
      if (quote !== '"' && quote !== "'") {
        kernelFormulaFail(state, "badChar", { char: "@" }, start, start + 1);
        return;
      }
      const end = kernelFormulaReadString(state, i + 1);
      if (end < 0) {
        return;
      }
      state.tokens.push({ type: "date", text: text.slice(start, end), value: kernelFormulaStringValue(text, start + 1, end), quoted: false, start, end });
      i = end;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== "`") {
        j += 1;
      }
      if (j >= text.length) {
        kernelFormulaFail(state, "unterminatedName", {}, start, text.length);
        return;
      }
      const value = text.slice(i + 1, j).trim();
      if (value === "") {
        kernelFormulaFail(state, "emptyName", {}, start, j + 1);
        return;
      }
      state.tokens.push({ type: "name", text: text.slice(start, j + 1), value, quoted: true, start, end: j + 1 });
      i = j + 1;
      continue;
    }
    numberPattern.lastIndex = i;
    const number = numberPattern.exec(text);
    if (number !== null) {
      const spelling = number[0];
      state.tokens.push({ type: "number", text: spelling, value: spelling, quoted: false, start, end: start + spelling.length });
      i += spelling.length;
      continue;
    }
    namePattern.lastIndex = i;
    const name = namePattern.exec(text);
    if (name !== null) {
      const spelling = name[0];
      const keyword = kernelFormulaIsKeywordWord(spelling);
      state.tokens.push({ type: keyword ? "keyword" : "name", text: spelling, value: spelling, quoted: false, start, end: start + spelling.length });
      i += spelling.length;
      continue;
    }
    const two = ch + text.charAt(i + 1);
    if (two === ".." && text.charAt(i + 2) === ".") {
      kernelFormulaFail(state, "intervalDots", { token: "..." }, start, i + 3);
      return;
    }
    if (two === "<=" || two === ">=" || two === "!=" || two === "==" || two === "..") {
      state.tokens.push({ type: "op", text: two, value: two, quoted: false, start, end: start + 2 });
      i += 2;
      continue;
    }
    if ("=<>+-*/()[],".indexOf(ch) >= 0) {
      state.tokens.push({ type: "op", text: ch, value: ch, quoted: false, start, end: start + 1 });
      i += 1;
      if (ch === "(") {
        open += 1;
        if (open > kernelFormulaMaxDepth()) {
          break;
        }
      } else if (ch === ")" && open > 0) {
        open -= 1;
      }
      continue;
    }
    if (ch === "“" || ch === "”" || ch === "‘" || ch === "’") {
      kernelFormulaFail(state, "curlyQuote", { token: ch }, start, start + 1);
      return;
    }
    const code = text.codePointAt(i);
    const glyph = code === undefined ? ch : String.fromCodePoint(code);
    kernelFormulaFail(state, "badChar", { char: glyph }, start, start + glyph.length);
    return;
  }
  state.tokens.push({ type: "end", text: "", value: "", quoted: false, start: text.length, end: text.length });
}

/**
 * The end offset (exclusive) of the quoted string opening at `at`, or -1 with an
 * `unterminatedString` error recorded. A backslash escapes the next character.
 */
export function kernelFormulaReadString(state: FormulaParserState, at: number): number {
  const text = state.text;
  const quote = text.charAt(at);
  let i = at + 1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === quote) {
      return i + 1;
    }
    i += ch === "\\" ? 2 : 1;
  }
  kernelFormulaFail(state, "unterminatedString", {}, at, text.length);
  return -1;
}

/** The contents of the quoted string spanning `[start, end)` with its escapes resolved. */
export function kernelFormulaStringValue(text: string, start: number, end: number): string {
  let value = "";
  let i = start + 1;
  while (i < end - 1) {
    const ch = text.charAt(i);
    if (ch === "\\" && i + 1 < end - 1) {
      const next = text.charAt(i + 1);
      value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
      i += 2;
      continue;
    }
    value += ch;
    i += 1;
  }
  return value;
}

/** The current token; the `end` token once the input is spent. */
export function kernelFormulaPeek(state: FormulaParserState): FormulaToken {
  const token = state.tokens[state.pos];
  if (token !== undefined) {
    return token;
  }
  return state.tokens[state.tokens.length - 1] as FormulaToken;
}

/** The token after the current one. */
export function kernelFormulaPeekNext(state: FormulaParserState): FormulaToken {
  const token = state.tokens[state.pos + 1];
  if (token !== undefined) {
    return token;
  }
  return state.tokens[state.tokens.length - 1] as FormulaToken;
}

/** Consume and return the current token; the `end` token is never consumed. */
export function kernelFormulaNext(state: FormulaParserState): FormulaToken {
  const token = kernelFormulaPeek(state);
  if (token.type !== "end") {
    state.pos += 1;
  }
  return token;
}

export function kernelFormulaIsOp(token: FormulaToken, text: string): boolean {
  return token.type === "op" && token.text === text;
}

/**
 * The deepest nesting the parser follows: parentheses, calls, `if`, `in` lists and intervals,
 * unary minus and prefix `not` each count one level. Each level is a handful of frames, so 100
 * stays far inside the sandbox's stack where an uncounted descent overflowed it.
 */
export function kernelFormulaMaxDepth(): number {
  return 100;
}

/**
 * Enter one nesting level at `token` before descending into it. Past the limit the `tooDeep`
 * error is recorded on the opener and `false` returned; the caller then returns `undefined`
 * without descending. The matching `state.depth -= 1` follows the descent.
 */
export function kernelFormulaEnter(state: FormulaParserState, token: FormulaToken): boolean {
  state.depth += 1;
  if (state.depth > kernelFormulaMaxDepth()) {
    kernelFormulaFail(state, "tooDeep", { token: token.text, max: kernelFormulaMaxDepth() }, token.start, token.end);
    return false;
  }
  return true;
}

export function kernelFormulaIsKeyword(token: FormulaToken, word: string): boolean {
  return token.type === "keyword" && token.text === word;
}

/** A value was due at `token`: `expectedValue` at the end of the input, `expectedValueHere` at a token. */
export function kernelFormulaFailValue(state: FormulaParserState, token: FormulaToken): undefined {
  if (token.type === "end") {
    kernelFormulaFail(state, "expectedValue", {}, token.start, token.end);
  } else {
    kernelFormulaFail(state, "expectedValueHere", { token: token.text }, token.start, token.end);
  }
  return undefined;
}

/** The expression operator a comparison token lowers to, or "" for any other token. */
export function kernelFormulaComparisonOperator(token: FormulaToken): string {
  if (token.type !== "op") {
    return "";
  }
  switch (token.text) {
    case "=":
    case "==":
      return "eq";
    case "!=":
      return "neq";
    case "<":
      return "lt";
    case "<=":
      return "lte";
    case ">":
      return "gt";
    case ">=":
      return "gte";
    default:
      return "";
  }
}

/** A fresh copy of a node, so a lowering that names the same operand twice shares nothing. */
export function kernelFormulaClone(expression: Expression): Expression {
  return JSON.parse(JSON.stringify(expression)) as Expression;
}

export function kernelFormulaBinary(operator: string, left: Expression, right: Expression): Expression {
  return { kind: "binary", operator: operator as "eq" | "neq" | "gt" | "gte" | "lt" | "lte", left, right };
}

export function kernelFormulaLogical(operator: "and" | "or", left: Expression, right: Expression): Expression {
  return { kind: "logical", operator, left, right };
}

export function kernelFormulaArithmetic(operator: "add" | "subtract" | "multiply" | "divide", left: Expression, right: Expression): Expression {
  return { kind: "arithmetic", operator, left, right };
}

/** `or`: the loosest binary level. `if` enters through the primary, so `1 + if …` parses. */
export function kernelFormulaParseOr(state: FormulaParserState): Expression | undefined {
  let left = kernelFormulaParseAnd(state);
  while (left !== undefined && kernelFormulaIsKeyword(kernelFormulaPeek(state), "or")) {
    kernelFormulaNext(state);
    const right = kernelFormulaParseAnd(state);
    if (right === undefined) {
      return undefined;
    }
    left = kernelFormulaLogical("or", left, right);
  }
  return left;
}

export function kernelFormulaParseAnd(state: FormulaParserState): Expression | undefined {
  let left = kernelFormulaParseComparison(state);
  while (left !== undefined && kernelFormulaIsKeyword(kernelFormulaPeek(state), "and")) {
    kernelFormulaNext(state);
    const right = kernelFormulaParseComparison(state);
    if (right === undefined) {
      return undefined;
    }
    left = kernelFormulaLogical("and", left, right);
  }
  return left;
}

/**
 * One comparison, `between`, or `in`; a prefix `not` takes the whole of it. A second comparison
 * operator straight after is the chained-comparison error.
 */
export function kernelFormulaParseComparison(state: FormulaParserState): Expression | undefined {
  const first = kernelFormulaPeek(state);
  if (kernelFormulaIsKeyword(first, "not") && !kernelFormulaIsOp(kernelFormulaPeekNext(state), "(")) {
    if (!kernelFormulaEnter(state, first)) {
      return undefined;
    }
    kernelFormulaNext(state);
    const operand = kernelFormulaParseComparison(state);
    state.depth -= 1;
    if (operand === undefined) {
      return undefined;
    }
    return { kind: "unary", operator: "not", operand };
  }
  const left = kernelFormulaParseAdditive(state);
  if (left === undefined) {
    return undefined;
  }
  const token = kernelFormulaPeek(state);
  const operator = kernelFormulaComparisonOperator(token);
  let result: Expression | undefined;
  if (operator !== "") {
    kernelFormulaNext(state);
    const right = kernelFormulaParseAdditive(state);
    if (right === undefined) {
      return undefined;
    }
    result = kernelFormulaBinary(operator, left, right);
  } else if (kernelFormulaIsKeyword(token, "between")) {
    kernelFormulaNext(state);
    const low = kernelFormulaParseAdditive(state);
    if (low === undefined) {
      return undefined;
    }
    const joiner = kernelFormulaPeek(state);
    if (!kernelFormulaIsKeyword(joiner, "and")) {
      kernelFormulaFail(state, "betweenAnd", joiner.type === "end" ? {} : { token: joiner.text }, joiner.start, joiner.end);
      return undefined;
    }
    kernelFormulaNext(state);
    const high = kernelFormulaParseAdditive(state);
    if (high === undefined) {
      return undefined;
    }
    result = kernelFormulaLogical("and", kernelFormulaBinary("gte", left, low), kernelFormulaBinary("lte", kernelFormulaClone(left), high));
  } else if (kernelFormulaIsKeyword(token, "in")) {
    kernelFormulaNext(state);
    if (!kernelFormulaEnter(state, kernelFormulaPeek(state))) {
      return undefined;
    }
    result = kernelFormulaParseInTests(state, left);
    state.depth -= 1;
    if (result === undefined) {
      return undefined;
    }
  } else {
    return left;
  }
  const after = kernelFormulaPeek(state);
  if (kernelFormulaComparisonOperator(after) !== "" || kernelFormulaIsKeyword(after, "between") || kernelFormulaIsKeyword(after, "in")) {
    kernelFormulaFail(state, "chainedCompare", { token: after.text }, after.start, after.end);
    return undefined;
  }
  return result;
}

/** After `x in`: a bracketed list of values, or one of the four interval forms. */
export function kernelFormulaParseInTests(state: FormulaParserState, left: Expression): Expression | undefined {
  const open = kernelFormulaPeek(state);
  if (!kernelFormulaIsOp(open, "(") && !kernelFormulaIsOp(open, "[") && !kernelFormulaIsOp(open, "]")) {
    kernelFormulaFail(state, "inList", open.type === "end" ? {} : { token: open.text }, open.start, open.end);
    return undefined;
  }
  kernelFormulaNext(state);
  const afterOpen = kernelFormulaPeek(state);
  if (open.text === "(" && kernelFormulaIsOp(afterOpen, ")")) {
    kernelFormulaFail(state, "inList", { token: ")" }, afterOpen.start, afterOpen.end);
    return undefined;
  }
  const first = kernelFormulaParseOr(state);
  if (first === undefined) {
    return undefined;
  }
  const separator = kernelFormulaPeek(state);
  if (kernelFormulaIsOp(separator, "..")) {
    kernelFormulaNext(state);
    const high = kernelFormulaParseOr(state);
    if (high === undefined) {
      return undefined;
    }
    const close = kernelFormulaPeek(state);
    if (!kernelFormulaIsOp(close, "]") && !kernelFormulaIsOp(close, ")") && !kernelFormulaIsOp(close, "[")) {
      kernelFormulaFailClose(state, close, '"]" or ")"');
      return undefined;
    }
    kernelFormulaNext(state);
    const lowOperator = open.text === "[" ? "gte" : "gt";
    const highOperator = close.text === "]" ? "lte" : "lt";
    return kernelFormulaLogical("and", kernelFormulaBinary(lowOperator, left, first), kernelFormulaBinary(highOperator, kernelFormulaClone(left), high));
  }
  if (open.text !== "(") {
    kernelFormulaFail(state, "intervalDots", separator.type === "end" ? {} : { token: separator.text }, separator.start, separator.end);
    return undefined;
  }
  let result = kernelFormulaBinary("eq", left, first);
  while (kernelFormulaIsOp(kernelFormulaPeek(state), ",")) {
    kernelFormulaNext(state);
    const item = kernelFormulaParseOr(state);
    if (item === undefined) {
      return undefined;
    }
    result = kernelFormulaLogical("or", result, kernelFormulaBinary("eq", kernelFormulaClone(left), item));
  }
  const close = kernelFormulaPeek(state);
  if (!kernelFormulaIsOp(close, ")")) {
    kernelFormulaFailClose(state, close, '"," or ")"');
    return undefined;
  }
  kernelFormulaNext(state);
  return result;
}

/** An `unclosedParen` at `token`, naming the closer that was due. */
export function kernelFormulaFailClose(state: FormulaParserState, token: FormulaToken, expected: string): undefined {
  const params: FormulaParams = { expected };
  if (token.type !== "end") {
    params.token = token.text;
  }
  kernelFormulaFail(state, "unclosedParen", params, token.start, token.end);
  return undefined;
}

export function kernelFormulaParseAdditive(state: FormulaParserState): Expression | undefined {
  let left = kernelFormulaParseMultiplicative(state);
  while (left !== undefined) {
    const token = kernelFormulaPeek(state);
    if (!kernelFormulaIsOp(token, "+") && !kernelFormulaIsOp(token, "-")) {
      break;
    }
    kernelFormulaNext(state);
    const right = kernelFormulaParseMultiplicative(state);
    if (right === undefined) {
      return undefined;
    }
    left = kernelFormulaArithmetic(token.text === "+" ? "add" : "subtract", left, right);
  }
  return left;
}

export function kernelFormulaParseMultiplicative(state: FormulaParserState): Expression | undefined {
  let left = kernelFormulaParseUnary(state);
  while (left !== undefined) {
    const token = kernelFormulaPeek(state);
    if (!kernelFormulaIsOp(token, "*") && !kernelFormulaIsOp(token, "/")) {
      break;
    }
    kernelFormulaNext(state);
    const right = kernelFormulaParseUnary(state);
    if (right === undefined) {
      return undefined;
    }
    left = kernelFormulaArithmetic(token.text === "*" ? "multiply" : "divide", left, right);
  }
  return left;
}

/** Unary minus: a number becomes a negative literal; anything else `subtract(0, x)`. */
export function kernelFormulaParseUnary(state: FormulaParserState): Expression | undefined {
  const token = kernelFormulaPeek(state);
  if (!kernelFormulaIsOp(token, "-")) {
    return kernelFormulaParsePrimary(state);
  }
  kernelFormulaNext(state);
  const next = kernelFormulaPeek(state);
  if (next.type === "number") {
    kernelFormulaNext(state);
    if (!isFinite(Number(next.text))) {
      kernelFormulaFail(state, "numberTooLarge", { token: next.text }, token.start, next.end);
      return undefined;
    }
    // `0 - n`, not `-n`: minus zero would be the literal's value (`-0`), and `0 - 0` is a plain zero.
    return { kind: "literal", value: 0 - Number(next.text) };
  }
  if (!kernelFormulaEnter(state, token)) {
    return undefined;
  }
  const operand = kernelFormulaParseUnary(state);
  state.depth -= 1;
  if (operand === undefined) {
    return undefined;
  }
  return kernelFormulaArithmetic("subtract", { kind: "literal", value: 0 }, operand);
}

export function kernelFormulaParsePrimary(state: FormulaParserState): Expression | undefined {
  const token = kernelFormulaPeek(state);
  switch (token.type) {
    case "number":
      kernelFormulaNext(state);
      if (!isFinite(Number(token.text))) {
        kernelFormulaFail(state, "numberTooLarge", { token: token.text }, token.start, token.end);
        return undefined;
      }
      return { kind: "literal", value: Number(token.text) };
    case "string":
      kernelFormulaNext(state);
      return { kind: "literal", value: token.value };
    case "date":
      kernelFormulaNext(state);
      return { kind: "call", name: "date", args: [{ kind: "literal", value: token.value }] };
    case "keyword":
      if (token.text === "true" || token.text === "false") {
        kernelFormulaNext(state);
        return { kind: "literal", value: token.text === "true" };
      }
      if (token.text === "null") {
        kernelFormulaNext(state);
        return { kind: "literal", value: null };
      }
      if (token.text === "if") {
        if (!kernelFormulaEnter(state, token)) {
          return undefined;
        }
        const chain = kernelFormulaParseIf(state);
        state.depth -= 1;
        return chain;
      }
      if (token.text === "not" && kernelFormulaIsOp(kernelFormulaPeekNext(state), "(")) {
        if (!kernelFormulaEnter(state, token)) {
          return undefined;
        }
        const negated = kernelFormulaParseNotCall(state);
        state.depth -= 1;
        return negated;
      }
      return kernelFormulaFailValue(state, token);
    case "name":
      if (!token.quoted && kernelFormulaIsOp(kernelFormulaPeekNext(state), "(")) {
        if (!kernelFormulaEnter(state, token)) {
          return undefined;
        }
        const called = kernelFormulaParseCall(state);
        state.depth -= 1;
        return called;
      }
      kernelFormulaNext(state);
      state.paths.push({ path: token.value, start: token.start, end: token.end });
      return { kind: "path", path: token.value };
    case "op":
      if (token.text === "(") {
        if (!kernelFormulaEnter(state, token)) {
          return undefined;
        }
        kernelFormulaNext(state);
        const inner = kernelFormulaParseOr(state);
        state.depth -= 1;
        if (inner === undefined) {
          return undefined;
        }
        const close = kernelFormulaPeek(state);
        if (!kernelFormulaIsOp(close, ")")) {
          return kernelFormulaFailClose(state, close, '")"');
        }
        kernelFormulaNext(state);
        return inner;
      }
      return kernelFormulaFailValue(state, token);
    default:
      return kernelFormulaFailValue(state, token);
  }
}

/** `not(x)`: the canonical spelling of the unary node; exactly one argument. */
export function kernelFormulaParseNotCall(state: FormulaParserState): Expression | undefined {
  const name = kernelFormulaNext(state);
  kernelFormulaNext(state);
  const operand = kernelFormulaParseOr(state);
  if (operand === undefined) {
    return undefined;
  }
  const close = kernelFormulaPeek(state);
  if (kernelFormulaIsOp(close, ",")) {
    let got = 1;
    let token = close;
    while (kernelFormulaIsOp(token, ",")) {
      kernelFormulaNext(state);
      const extra = kernelFormulaParseOr(state);
      if (extra === undefined) {
        return undefined;
      }
      got += 1;
      token = kernelFormulaPeek(state);
    }
    const end = kernelFormulaIsOp(token, ")") ? token.end : token.start;
    kernelFormulaFail(state, "arity", { name: "not", expected: 1, min: 1, max: 1, got }, name.start, end);
    return undefined;
  }
  if (!kernelFormulaIsOp(close, ")")) {
    return kernelFormulaFailClose(state, close, '")"');
  }
  kernelFormulaNext(state);
  return { kind: "unary", operator: "not", operand };
}

/** The declared arity of a signature as `[min, max]`; a missing or non-numeric `max` is unbounded. */
export function kernelFormulaArityOf(signature: FormulaFunctionSignature): number[] {
  const row = signature as unknown as Record<string, unknown>;
  const min = typeof row.min === "number" && row.min >= 0 ? row.min : 0;
  const max = typeof row.max === "number" && row.max >= min ? row.max : Number.POSITIVE_INFINITY;
  return [min, max];
}

/** `name(args)`: the name must be declared; the argument count must fit its arity. */
export function kernelFormulaParseCall(state: FormulaParserState): Expression | undefined {
  const name = kernelFormulaNext(state);
  let signature: FormulaFunctionSignature | undefined;
  for (const candidate of state.signatures) {
    if (candidate !== null && typeof candidate === "object" && (candidate as unknown as Record<string, unknown>).name === name.text) {
      signature = candidate;
      break;
    }
  }
  if (signature === undefined) {
    kernelFormulaFail(state, "unknownFunction", { name: name.text }, name.start, name.end);
    return undefined;
  }
  kernelFormulaNext(state);
  const args: Expression[] = [];
  if (!kernelFormulaIsOp(kernelFormulaPeek(state), ")")) {
    for (;;) {
      const argument = kernelFormulaParseOr(state);
      if (argument === undefined) {
        return undefined;
      }
      args.push(argument);
      const token = kernelFormulaPeek(state);
      if (kernelFormulaIsOp(token, ",")) {
        kernelFormulaNext(state);
        continue;
      }
      if (kernelFormulaIsOp(token, ")")) {
        break;
      }
      return kernelFormulaFailClose(state, token, '"," or ")"');
    }
  }
  const close = kernelFormulaNext(state);
  const arity = kernelFormulaArityOf(signature);
  const min = arity[0] as number;
  const max = arity[1] as number;
  if (args.length < min) {
    if (max === Number.POSITIVE_INFINITY) {
      kernelFormulaFail(state, "arityMin", { name: name.text, min, got: args.length }, name.start, close.end);
    } else {
      kernelFormulaFail(state, "arity", kernelFormulaArityParams(name.text, min, max, args.length), name.start, close.end);
    }
    return undefined;
  }
  if (args.length > max) {
    kernelFormulaFail(state, "arity", kernelFormulaArityParams(name.text, min, max, args.length), name.start, close.end);
    return undefined;
  }
  if ((name.text === "dateAdd" || name.text === "dateDiff") && args.length === 3) {
    const unit = args[2] as Expression;
    if (
      unit.kind === "literal" &&
      typeof unit.value === "string" &&
      unit.value !== "days" &&
      unit.value !== "weeks" &&
      unit.value !== "months" &&
      unit.value !== "years"
    ) {
      kernelFormulaFail(state, "badUnit", { name: name.text, unit: unit.value }, name.start, close.end);
      return undefined;
    }
  }
  return { kind: "call", name: name.text, args };
}

/** The `arity` params: `expected` is the count, or "min to max" when a range; `min` and `max` always. */
export function kernelFormulaArityParams(name: string, min: number, max: number, got: number): FormulaParams {
  return { name, expected: min === max ? max : String(min) + " to " + String(max), min, max, got };
}

/** `if … then … [else if … then …]* [else …]`: one node, cases in order, `else` only when written. */
export function kernelFormulaParseIf(state: FormulaParserState): Expression | undefined {
  kernelFormulaNext(state);
  const cases: Array<{ when: Expression; then: Expression }> = [];
  for (;;) {
    const when = kernelFormulaParseOr(state);
    if (when === undefined) {
      return undefined;
    }
    const thenToken = kernelFormulaPeek(state);
    if (!kernelFormulaIsKeyword(thenToken, "then")) {
      kernelFormulaFail(state, "ifThen", thenToken.type === "end" ? {} : { token: thenToken.text }, thenToken.start, thenToken.end);
      return undefined;
    }
    kernelFormulaNext(state);
    const then = kernelFormulaParseOr(state);
    if (then === undefined) {
      return undefined;
    }
    cases.push({ when, then });
    if (!kernelFormulaIsKeyword(kernelFormulaPeek(state), "else")) {
      return { kind: "if", cases };
    }
    kernelFormulaNext(state);
    if (kernelFormulaIsKeyword(kernelFormulaPeek(state), "if")) {
      kernelFormulaNext(state);
      continue;
    }
    const otherwise = kernelFormulaParseOr(state);
    if (otherwise === undefined) {
      return undefined;
    }
    return { kind: "if", cases, else: otherwise };
  }
}

/**
 * The built-in functions' names and argument counts, as fresh plain data: what a kernel run or
 * inspect parses against when its caller hands it no signatures (a direct call; every host
 * passes its own list, which starts from these and adds its plugins'). The function table is
 * data the sandbox program is not spliced with, so the names travel here as one text of
 * `name:min:max` words (an empty `max` is no upper bound); a test holds it equal to
 * `formulaFunctionSignatures()`.
 */
export function kernelBuiltInFunctionSignatures(): FormulaFunctionSignature[] {
  const words = (
    "coalesce:1: empty:1:1 isNumber:1:1 isDate:1:1 concat:0: len:1:1 upper:1:1 lower:1:1 " +
    "titleCase:1:1 trim:1:1 startsWith:2:2 endsWith:2:2 contains:2:2 substring:2:3 " +
    "indexOf:2:2 replace:3:3 split:2:2 join:2:2 matches:2:2 text:1:1 padStart:3:3 sum:0: " +
    "min:1: max:1: avg:1: count:1:1 abs:1:1 round:1:1 roundTo:2:2 roundUp:1:2 roundDown:1:2 " +
    "floor:1:1 ceil:1:1 modulo:2:2 power:2:2 sqrt:1:1 clamp:3:3 number:1:1 selected:1:1 " +
    "first:1:1 last:1:1 distinct:1:1 sort:1:1 reverse:1:1 append:2:2 pluck:2:2 any:1:1 " +
    "all:1:1 today:0:0 date:1:1 dateAdd:3:3 dateDiff:3:3 year:1:1 month:1:1 day:1:1 " +
    "dayOfWeek:1:1 startOfMonth:1:1 endOfMonth:1:1 isWeekend:1:1 age:1:1 rowIndex:0:0 " +
    "rowCount:0:0"
  ).split(" ");
  const out: FormulaFunctionSignature[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const parts = (words[i] as string).split(":");
    out.push({ name: parts[0] as string, min: Number(parts[1]), max: parts[2] === "" ? Number.POSITIVE_INFINITY : Number(parts[2]) });
  }
  return out;
}

/** This module's functions, for the kernel's `PORTABLE_KERNEL_FUNCTIONS`. */
export const FORMULA_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelParseFormula,
  kernelBuiltInFunctionSignatures,
  kernelFormulaFail,
  kernelFormulaMessage,
  kernelFormulaIsKeywordWord,
  kernelFormulaTokenize,
  kernelFormulaReadString,
  kernelFormulaStringValue,
  kernelFormulaPeek,
  kernelFormulaPeekNext,
  kernelFormulaNext,
  kernelFormulaIsOp,
  kernelFormulaMaxDepth,
  kernelFormulaEnter,
  kernelFormulaIsKeyword,
  kernelFormulaFailValue,
  kernelFormulaComparisonOperator,
  kernelFormulaClone,
  kernelFormulaBinary,
  kernelFormulaLogical,
  kernelFormulaArithmetic,
  kernelFormulaParseOr,
  kernelFormulaParseAnd,
  kernelFormulaParseComparison,
  kernelFormulaParseInTests,
  kernelFormulaFailClose,
  kernelFormulaParseAdditive,
  kernelFormulaParseMultiplicative,
  kernelFormulaParseUnary,
  kernelFormulaParsePrimary,
  kernelFormulaParseNotCall,
  kernelFormulaArityOf,
  kernelFormulaParseCall,
  kernelFormulaArityParams,
  kernelFormulaParseIf
];
