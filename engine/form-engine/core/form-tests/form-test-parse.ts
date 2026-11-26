import type { FormulaFunctionSignature } from "../expressions/formula-types.js";
import { kernelFormulaMessage, kernelParseFormula } from "../expressions/formula.js";
import type {
  FormTestAction,
  FormTestExpectation,
  FormTestGiven,
  FormTestParseResult,
  FormTestProblem,
  FormTestProblemCode,
  FormTestRef,
  FormTestScenario,
  FormTestState,
  FormTestStatement,
  FormTestValue
} from "./form-test-types.js";

/**
 * The form-test parser the text of one or more `test "name"` blocks
 * in, scenarios out. Kernel-shaped like the formula parser it leans on
 * (`core/expressions/formula.ts`), so the validation kernel and the CLI run the very parser the
 * builder does: top-level `kernel*` function declarations only, no module constants, no clock,
 * no classes, no thrown errors (a problem is a code, never a sentence, and the result lists
 * it), records built without a prototype because paths, page ids and host keys come from an
 * author and may spell `constructor` or `__proto__`. {@link FORM_TEST_PARSE_FUNCTIONS} lists
 * every function here for the kernel's function list; `kernelParseFormula` and
 * `kernelFormulaMessage` are the names used from outside, listed with the formula module's own
 * functions.
 *
 * The language is line-based: one statement per line, `#` starts a comment (outside a string),
 * blank lines and indentation mean nothing, keywords are case-insensitive English in every
 * locale. Values are literals lexed here, a superset of the formula language's: the formula has
 * no list literal (`("a", "b")` is a list here and a parse error there, `("a")` a bracketed
 * string there and a one-item list here) and its names are ids, never row paths (`items[0].qty`
 * is a path only in a statement of this language). A single literal never goes through the
 * formula parser, so `expect total = 5` is a value check and not a formula;
 * `expect <formula>` hands the rest of its line to `kernelParseFormula`. A line that fails
 * records one problem and adds no statement; the lines after it still parse, so the builder can
 * show every problem at once and the statements that did parse.
 *
 * Nothing recurses past a fixed depth: a list nests at most 32 levels (deeper is the
 * `unclosedList` problem with `params.tooDeep`), and the formula parser bounds its own descent,
 * so a sandbox with a smaller stack than the host's never overflows here. A source over
 * 200,000 UTF-16 units is one `tooLong` problem and no scenarios.
 */

type FormTestParams = Record<string, string | number>;

interface FormTestToken {
  text: string;
  start: number;
  end: number;
}

interface FormTestParserState {
  text: string;
  signatures: FormulaFunctionSignature[];
  problems: FormTestProblem[];
  scenarios: FormTestScenario[];
  current: FormTestScenario | undefined;
  /** The given keys of the current block, to refuse a second one. No prototype. */
  givenKeys: Record<string, boolean>;
  /** The names of the blocks read so far, so a repeat is found in one lookup and not one scan per header. No prototype. */
  names: Record<string, boolean>;
  /** The cursor within the current line's content. */
  pos: number;
  /** The end (exclusive) of the current line's content, comment and trailing blanks cut. */
  end: number;
  line: number;
}

type FormTestLiteral =
  | { ok: true; value: FormTestValue; end: number }
  | {
      ok: false;
      code: FormTestProblemCode;
      start: number;
      end: number;
      params: FormTestParams;
      /** A string problem: the line is wrong whatever else is tried, so no fallback to a formula. */
      lexical: boolean;
    };

/**
 * Parse `text`, the source of the form's tests (a definition's scenario sources joined, or a
 * `.datum-test` file), against the declared formula function `signatures`. Never throws.
 */
export function kernelParseFormTests(text: string, signatures: readonly FormulaFunctionSignature[]): FormTestParseResult {
  const source = typeof text === "string" ? text : "";
  const state: FormTestParserState = {
    text: source,
    signatures: Array.isArray(signatures) ? signatures.slice() : [],
    problems: [],
    scenarios: [],
    current: undefined,
    givenKeys: Object.create(null) as Record<string, boolean>,
    names: Object.create(null) as Record<string, boolean>,
    pos: 0,
    end: 0,
    line: 1
  };
  if (source.length > 200000) {
    kernelFormTestFail(state, "tooLong", 0, source.length, { max: 200000 });
    return { ok: false, scenarios: [], problems: state.problems };
  }
  try {
    // A line ends at a line feed, a carriage return and line feed, or a carriage return alone
    // (an old Mac editor's); a byte-order mark leads a file a Windows editor saved (a
    // `.datum-test` sidecar) and is skipped before the first word of any line. Spans stay offsets
    // into the source as it was handed in.
    let offset = 0;
    let line = 1;
    while (offset <= source.length) {
      let lineEnd = offset;
      while (lineEnd < source.length && source.charCodeAt(lineEnd) !== 10 && source.charCodeAt(lineEnd) !== 13) {
        lineEnd += 1;
      }
      kernelFormTestParseLine(state, offset, lineEnd, line);
      if (lineEnd >= source.length) {
        break;
      }
      offset = source.charCodeAt(lineEnd) === 13 && source.charCodeAt(lineEnd + 1) === 10 ? lineEnd + 2 : lineEnd + 1;
      line += 1;
    }
  } catch {
    // Not reachable by design; a parser that is never allowed to fail still answers.
    kernelFormTestFail(state, "unknownStatement", state.pos, state.pos, { unexpected: 1 });
  }
  return { ok: state.problems.length === 0, scenarios: state.scenarios, problems: state.problems };
}

/** Plain English for the kernel log and the CLI; the builder words the same codes from its catalog. */
export function kernelFormTestMessage(code: string, params: FormTestParams | undefined): string {
  const p = params === undefined ? Object.create(null) as FormTestParams : params;
  const token = typeof p.token === "string" && p.token !== "" ? ' "' + p.token + '"' : "";
  switch (code) {
    case "unknownStatement":
      return typeof p.word === "string" && p.word !== "" ? 'Unknown statement "' + p.word + '".' : "This line is not a statement.";
    case "expectedName":
      return 'A test needs a name in quotes: test "name".';
    case "duplicateName":
      return 'Another test is already called "' + String(p.name ?? "") + '"; give each test its own name.';
    case "expectedPath":
      return "Expected a field path" + token + " (for example total or items[0].qty).";
    case "expectedValue":
      return p.expected === "list" ? "Expected a list in brackets, like (1, 2)." : "Expected a value" + token + " (text in quotes, a number, true, false, null or a date).";
    case "expectedPage":
      return "Expected a page id" + token + ".";
    case "expectedNumber":
      return "Expected a whole number" + token + ".";
    case "expectedEquals":
      return 'Expected "=" here.';
    case "expectedKeyword":
      return 'Expected the word "' + String(p.expected ?? "") + '"' + (token === "" ? "." : " but found" + token + ".");
    case "badState":
      return 'Unknown state "' + String(p.word ?? "") + '"; use visible, hidden, required, optional, enabled, disabled, readonly, editable, empty or not empty.';
    case "badCode":
      return "An error code is letters, digits, dots, underscores and hyphens" + (typeof p.code === "string" && p.code !== "" ? ', not "' + p.code + '"' : "") + ".";
    case "badGiven":
      return "A given sets today, locale, journey, host.<name> or options for <field>" + (typeof p.key === "string" && p.key !== "" ? "; the value for " + p.key + " is not usable" : "") + ".";
    case "givenAfterStep":
      return "A given belongs at the top of the test, before any action or expectation.";
    case "duplicateGiven":
      return "This test already sets " + String(p.key ?? "that") + ".";
    case "skipAfterStep":
      return "skip belongs directly under the test name, before any given or step.";
    case "stepOutsideTest":
      return 'This statement is outside a test; start with test "name".';
    case "unterminatedString":
      return p.curly === 1 ? "A curly quote is not a quote here; use straight quotes." : "A quoted text has no closing quote.";
    case "unclosedList":
      return p.tooDeep === 1 ? "The list nests too deeply." : 'A list is not closed with ")".';
    case "badFormula": {
      const inner = typeof p.formulaCode === "string" ? kernelFormTestFormulaWording(p.formulaCode, p) : "";
      return "This is not a formula the language reads" + (inner === "" ? "." : ": " + inner);
    }
    case "trailingText":
      return "There is text after the end of this statement" + token + ".";
    case "tooLong":
      return "The tests are longer than " + String(p.max ?? 200000) + " characters.";
    case "tests.set.unknownPath":
      return "No field stores an answer at " + String(p.path ?? "") + ", so the form keeps nothing there; the step still runs.";
    case "tests.change.unknownPath":
      return "No field stores an answer at " + String(p.path ?? "") + ", so no Check answers step lists it; the step is refused.";
    default:
      return "This line could not be read.";
  }
}

/** The formula parser's own sentence for its code (`kernelFormulaMessage`), for {@link kernelFormTestMessage}: every code it has is worded. */
export function kernelFormTestFormulaWording(code: string, params: FormTestParams): string {
  return kernelFormulaMessage(code, params);
}

/** Record a problem on the current line. */
export function kernelFormTestFail(
  state: FormTestParserState,
  code: FormTestProblemCode,
  start: number,
  end: number,
  params?: FormTestParams
): void {
  const problem: FormTestProblem = { code, line: state.line, start, end };
  if (params !== undefined) {
    problem.params = params;
  }
  state.problems.push(problem);
}

/**
 * Cut one line to its content (comment and trailing blanks off), set the cursor on it and read
 * its statement. The cursor works on whole-source offsets so every span is one.
 */
export function kernelFormTestParseLine(state: FormTestParserState, from: number, to: number, line: number): void {
  const text = state.text;
  let end = kernelFormTestContentEnd(text, from, to);
  while (end > from && kernelFormTestIsSpace(text.charAt(end - 1))) {
    end -= 1;
  }
  let start = from;
  while (start < end && (kernelFormTestIsSpace(text.charAt(start)) || text.charCodeAt(start) === 0xfeff)) {
    start += 1;
  }
  if (start >= end) {
    return;
  }
  state.line = line;
  state.pos = start;
  state.end = end;
  const keyword = kernelFormTestTokenAt(state, start);
  const word = kernelFormTestLower(keyword.text);
  // A header closes the block before it; every other line, a stray one included, belongs to the block it sits in.
  if (state.current !== undefined && word !== "test") {
    state.current.span.end = end;
  }
  if (word === "test") {
    kernelFormTestParseHeader(state, keyword);
    return;
  }
  if (!kernelFormTestIsStatementWord(word)) {
    kernelFormTestFail(state, "unknownStatement", keyword.start, kernelFormTestSpanEnd(state, keyword), { word: keyword.text });
    return;
  }
  if (state.current === undefined) {
    kernelFormTestFail(state, "stepOutsideTest", keyword.start, end);
    return;
  }
  state.pos = keyword.end;
  if (word === "skip") {
    kernelFormTestParseSkip(state, keyword);
    return;
  }
  if (word === "given") {
    kernelFormTestParseGiven(state, keyword);
    return;
  }
  const statement = word === "expect" ? kernelFormTestParseExpect(state) : kernelFormTestParseAction(state, word);
  if (statement !== undefined) {
    state.current.steps.push(statement);
  }
}

/** Where a line's content ends: at the first `#` outside a quoted string, else the line's end. */
export function kernelFormTestContentEnd(text: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    const ch = text.charAt(i);
    if (ch === "#") {
      return i;
    }
    // A backticked name is one token, whatever it holds (a `#` among them): no escapes inside.
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close < 0 || close >= to) {
        return to;
      }
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < to && text.charAt(j) !== ch) {
        j += text.charAt(j) === "\\" ? 2 : 1;
      }
      if (j >= to) {
        return to;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return to;
}

/** A blank: a space, a tab, a carriage return, and the no-break space pasted text carries. */
export function kernelFormTestIsSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === " ";
}

/**
 * A formula's text for the formula parser: the no-break space pasted text carries is a blank to
 * this language but a bad character to the formula parser, so it is made a plain space; and a
 * bare `TRUE`, `False` or `Null` is written in lower case, because this language reads those
 * words in any case (as it does its keywords) and the formula parser reads them as a field
 * named `TRUE`. A word inside a string, a backticked name or a longer name (`x.TRUE`,
 * `TRUE-1`) is left alone. Every character keeps its place, so the parser's offsets are still
 * offsets into the source.
 */
export function kernelFormTestFormulaText(text: string): string {
  const plain = text.split("\u00a0").join(" ");
  let out = "";
  let i = 0;
  while (i < plain.length) {
    const ch = plain.charAt(i);
    if (ch === '"' || ch === "'") {
      // A string, to its closing quote; a backslash escapes the next character.
      let j = i + 1;
      while (j < plain.length && plain.charAt(j) !== ch) {
        j += plain.charAt(j) === "\\" ? 2 : 1;
      }
      j = j < plain.length ? j + 1 : plain.length;
      out += plain.slice(i, j);
      i = j;
    } else if (ch === "`") {
      const close = plain.indexOf("`", i + 1);
      const j = close < 0 ? plain.length : close + 1;
      out += plain.slice(i, j);
      i = j;
    } else if (/[A-Za-z_]/.test(ch)) {
      // One name as the formula lexer reads it: word characters, then `-` or `.` segments.
      let j = i + 1;
      while (j < plain.length) {
        if (/[A-Za-z0-9_]/.test(plain.charAt(j))) {
          j += 1;
        } else if ((plain.charAt(j) === "-" || plain.charAt(j) === ".") && /[A-Za-z0-9_]/.test(plain.charAt(j + 1))) {
          j += 2;
        } else {
          break;
        }
      }
      const word = plain.slice(i, j);
      const lower = kernelFormTestLower(word);
      out += lower === "true" || lower === "false" || lower === "null" ? lower : word;
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Whether a character ends a bare word: a blank or one of the characters the language punctuates with. */
export function kernelFormTestIsDelimiter(ch: string): boolean {
  return (
    kernelFormTestIsSpace(ch) ||
    ch === "=" ||
    ch === "!" ||
    ch === "<" ||
    ch === ">" ||
    ch === "(" ||
    ch === ")" ||
    ch === "," ||
    ch === ":" ||
    ch === '"' ||
    ch === "'" ||
    ch === "#" ||
    kernelFormTestIsCurly(ch)
  );
}

export function kernelFormTestIsCurly(ch: string): boolean {
  return ch === "“" || ch === "”" || ch === "‘" || ch === "’";
}

/** ASCII-only lower-casing, so a Kelvin sign or a dotted capital I never spells a keyword. */
export function kernelFormTestLower(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text.charAt(i);
  }
  return out;
}

/** The index of the first non-blank at or after `from`, bounded by the line's end. */
export function kernelFormTestNextIndex(state: FormTestParserState, from: number): number {
  let i = from;
  while (i < state.end && kernelFormTestIsSpace(state.text.charAt(i))) {
    i += 1;
  }
  return i;
}

/** The bare word at or after `from` (empty when the next character is a delimiter or the line is spent). */
export function kernelFormTestTokenAt(state: FormTestParserState, from: number): FormTestToken {
  const start = kernelFormTestNextIndex(state, from);
  let i = start;
  while (i < state.end && !kernelFormTestIsDelimiter(state.text.charAt(i))) {
    i += 1;
  }
  return { text: state.text.slice(start, i), start, end: i };
}

/** The end of a span to underline for a token: the token, else the one character in the way, else nothing. */
export function kernelFormTestSpanEnd(state: FormTestParserState, token: FormTestToken): number {
  if (token.end > token.start) {
    return token.end;
  }
  return token.start < state.end ? token.start + 1 : token.start;
}

/** The index of a single `=` (not `==`) after blanks from `from`, else -1. */
export function kernelFormTestAtEquals(state: FormTestParserState, from: number): number {
  const at = kernelFormTestNextIndex(state, from);
  if (at < state.end && state.text.charAt(at) === "=" && state.text.charAt(at + 1) !== "=") {
    return at;
  }
  return -1;
}

export function kernelFormTestIsStatementWord(word: string): boolean {
  return (
    word === "test" ||
    word === "skip" ||
    word === "given" ||
    word === "set" ||
    word === "clear" ||
    word === "add" ||
    word === "remove" ||
    word === "continue" ||
    word === "back" ||
    word === "go" ||
    word === "change" ||
    word === "check" ||
    word === "submit" ||
    word === "expect"
  );
}

/** The state a lower-cased word names, or an empty string. `not empty` is two words and handled by the caller. */
export function kernelFormTestStateOf(word: string): FormTestState | "" {
  switch (word) {
    case "visible":
    case "hidden":
    case "required":
    case "optional":
    case "enabled":
    case "disabled":
    case "readonly":
    case "editable":
    case "empty":
      return word;
    default:
      return "";
  }
}

/** Words that, after a path, open a formula (`x in (1, 2)`, `x and y`), never a state. */
export function kernelFormTestIsFormulaWord(word: string): boolean {
  return word === "and" || word === "or" || word === "in" || word === "between" || word === "if" || word === "then" || word === "else";
}

/** The component-id grammar: letters, digits, underscore, hyphen and dot. */
export function kernelFormTestIsId(text: string): boolean {
  return text !== "" && /^[A-Za-z0-9_.-]+$/.test(text);
}

/** One path segment: a key of letters, digits, underscore and hyphen with an optional `[n]`; the first may open with `@`. */
export function kernelFormTestIsPathSegment(segment: string, first: boolean): boolean {
  return (first ? /^@?[A-Za-z0-9_-]+(\[\d+\])?$/ : /^[A-Za-z0-9_-]+(\[\d+\])?$/).test(segment);
}

/** The engine's value-path syntax (`parseComponentPath` in `core/tree/component-path.ts`): dotted segments, each with an optional index. */
export function kernelFormTestIsPath(text: string): boolean {
  if (text === "") {
    return false;
  }
  const parts = text.split(".");
  for (let i = 0; i < parts.length; i += 1) {
    if (!kernelFormTestIsPathSegment(parts[i] ?? "", i === 0)) {
      return false;
    }
  }
  return true;
}

/**
 * `YYYY-MM-DD` naming a real calendar day: a month of 1 to 12 and a day within that month's
 * length, February 29 only in a leap year (divisible by 4, but a century only when by 400).
 * Worked out by hand: this is kernel-shaped code, which has no `Date`.
 */
export function kernelFormTestIsIsoDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  let length = 31;
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    length = 30;
  } else if (month === 2) {
    length = leap ? 29 : 28;
  }
  return day <= length;
}

/** The end (exclusive) of the quoted string opening at `at` within the line, or -1 when it never closes. A backslash escapes the next character. */
export function kernelFormTestReadString(state: FormTestParserState, at: number): number {
  const quote = state.text.charAt(at);
  let i = at + 1;
  while (i < state.end) {
    const ch = state.text.charAt(i);
    if (ch === quote) {
      return i + 1;
    }
    i += ch === "\\" ? 2 : 1;
  }
  return -1;
}

/** The contents of the quoted string spanning `[start, end)` with the formula language's escapes resolved. */
export function kernelFormTestStringValue(text: string, start: number, end: number): string {
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

/**
 * The literal starting at or after `from`: a string, a number, `true`, `false`, `null`, a date
 * `@"YYYY-MM-DD"` (lowered to its string) or a list. Pure: the cursor is the caller's to move.
 * A problem comes back as data so the `expect` form can fall back to a formula on a miss.
 */
export function kernelFormTestReadLiteral(state: FormTestParserState, from: number, depth: number): FormTestLiteral {
  const text = state.text;
  const at = kernelFormTestNextIndex(state, from);
  if (at >= state.end) {
    return { ok: false, code: "expectedValue", start: at, end: at, params: {}, lexical: false };
  }
  const ch = text.charAt(at);
  if (ch === '"' || ch === "'") {
    const close = kernelFormTestReadString(state, at);
    if (close < 0) {
      return { ok: false, code: "unterminatedString", start: at, end: state.end, params: {}, lexical: true };
    }
    return { ok: true, value: kernelFormTestStringValue(text, at, close), end: close };
  }
  if (kernelFormTestIsCurly(ch)) {
    return { ok: false, code: "unterminatedString", start: at, end: at + 1, params: { curly: 1 }, lexical: true };
  }
  if (ch === "@") {
    const quote = text.charAt(at + 1);
    if (at + 1 < state.end && (quote === '"' || quote === "'")) {
      const close = kernelFormTestReadString(state, at + 1);
      if (close < 0) {
        return { ok: false, code: "unterminatedString", start: at, end: state.end, params: {}, lexical: true };
      }
      return { ok: true, value: kernelFormTestStringValue(text, at + 1, close), end: close };
    }
    return { ok: false, code: "expectedValue", start: at, end: at + 1, params: { token: "@" }, lexical: false };
  }
  if (ch === "(") {
    return kernelFormTestReadList(state, at, depth);
  }
  let i = at;
  while (i < state.end && !kernelFormTestIsDelimiter(text.charAt(i))) {
    i += 1;
  }
  if (i === at) {
    return { ok: false, code: "expectedValue", start: at, end: at + 1, params: { token: ch }, lexical: false };
  }
  const token = text.slice(at, i);
  // The words are read as the keywords are, whatever their case (`TRUE`, `Null`): left to the
  // formula reading, `expect w = TRUE` would name a field `TRUE` that no form has.
  const word = kernelFormTestLower(token);
  if (word === "true") {
    return { ok: true, value: true, end: i };
  }
  if (word === "false") {
    return { ok: true, value: false, end: i };
  }
  if (word === "null") {
    return { ok: true, value: null, end: i };
  }
  if (/^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(token)) {
    const number = Number(token);
    if (Number.isFinite(number)) {
      // A minus zero would compare unequal to zero in a deep equality; the answer is zero.
      return { ok: true, value: number === 0 ? 0 : number, end: i };
    }
  }
  return { ok: false, code: "expectedValue", start: at, end: i, params: { token }, lexical: false };
}

/** A list `(<literal>, ...)`, possibly empty, opening at `at`; nesting stops at 32 levels. */
export function kernelFormTestReadList(state: FormTestParserState, at: number, depth: number): FormTestLiteral {
  if (depth >= 32) {
    return { ok: false, code: "unclosedList", start: at, end: at + 1, params: { tooDeep: 1 }, lexical: false };
  }
  const items: FormTestValue[] = [];
  let i = kernelFormTestNextIndex(state, at + 1);
  if (i < state.end && state.text.charAt(i) === ")") {
    return { ok: true, value: items, end: i + 1 };
  }
  while (true) {
    const item = kernelFormTestReadLiteral(state, i, depth + 1);
    if (!item.ok) {
      if (item.code === "expectedValue" && item.start >= state.end) {
        return { ok: false, code: "unclosedList", start: at, end: state.end, params: {}, lexical: false };
      }
      return item;
    }
    items.push(item.value);
    i = kernelFormTestNextIndex(state, item.end);
    if (i >= state.end) {
      return { ok: false, code: "unclosedList", start: at, end: state.end, params: {}, lexical: false };
    }
    const ch = state.text.charAt(i);
    if (ch === ",") {
      i = kernelFormTestNextIndex(state, i + 1);
      continue;
    }
    if (ch === ")") {
      return { ok: true, value: items, end: i + 1 };
    }
    return { ok: false, code: "unclosedList", start: i, end: i + 1, params: { token: ch }, lexical: false };
  }
}

/** Record the problem a failed literal carries. */
export function kernelFormTestFailLiteral(state: FormTestParserState, literal: FormTestLiteral): void {
  if (!literal.ok) {
    kernelFormTestFail(state, literal.code, literal.start, literal.end, literal.params);
  }
}

/** Read one literal at the cursor and move past it; a problem is recorded and `undefined` returned. */
export function kernelFormTestReadValue(state: FormTestParserState): { value: FormTestValue } | undefined {
  const literal = kernelFormTestReadLiteral(state, state.pos, 0);
  if (!literal.ok) {
    kernelFormTestFailLiteral(state, literal);
    return undefined;
  }
  state.pos = literal.end;
  return { value: literal.value };
}

/** Read a quoted text at the cursor; `missing` is the code for anything else. Records its problem. */
export function kernelFormTestReadQuoted(state: FormTestParserState, missing: "expectedName" | "expectedValue"): string | undefined {
  const at = kernelFormTestNextIndex(state, state.pos);
  const ch = state.text.charAt(at);
  if (at >= state.end || (ch !== '"' && ch !== "'")) {
    if (at < state.end && kernelFormTestIsCurly(ch)) {
      kernelFormTestFail(state, "unterminatedString", at, at + 1, { curly: 1 });
    } else {
      kernelFormTestFail(state, missing, at, at < state.end ? at + 1 : at);
    }
    return undefined;
  }
  const close = kernelFormTestReadString(state, at);
  if (close < 0) {
    kernelFormTestFail(state, "unterminatedString", at, state.end);
    return undefined;
  }
  state.pos = close;
  return kernelFormTestStringValue(state.text, at, close);
}

/** Note something the scenario names. */
export function kernelFormTestAddRef(
  state: FormTestParserState,
  kind: FormTestRef["kind"],
  text: string,
  start: number,
  end: number,
  collection?: string
): void {
  if (state.current !== undefined) {
    const ref: FormTestRef = { kind, text, span: { line: state.line, start, end } };
    if (collection !== undefined) {
      ref.collection = collection;
    }
    state.current.refs.push(ref);
  }
}

/** Read a value path (or, as `kind` `collection`, a collection path) at the cursor and note it; a problem is recorded. */
export function kernelFormTestReadPathRef(state: FormTestParserState, kind: "path" | "collection"): string | undefined {
  const token = kernelFormTestTokenAt(state, state.pos);
  if (token.text === "" || !kernelFormTestIsPath(token.text)) {
    kernelFormTestFail(state, "expectedPath", token.start, kernelFormTestSpanEnd(state, token), token.text === "" ? undefined : { token: token.text });
    return undefined;
  }
  state.pos = token.end;
  kernelFormTestAddRef(state, kind, token.text, token.start, token.end);
  return token.text;
}

/** Read an id (a page, a layout, a journey) at the cursor and note it; `missing` is the problem's code. */
export function kernelFormTestReadIdRef(
  state: FormTestParserState,
  kind: "page" | "layout" | "journey",
  missing: "expectedPage" | "expectedValue"
): string | undefined {
  const token = kernelFormTestTokenAt(state, state.pos);
  if (token.text === "" || !kernelFormTestIsId(token.text)) {
    kernelFormTestFail(state, missing, token.start, kernelFormTestSpanEnd(state, token), token.text === "" ? undefined : { token: token.text });
    return undefined;
  }
  state.pos = token.end;
  kernelFormTestAddRef(state, kind, token.text, token.start, token.end);
  return token.text;
}

/** Consume the `=` at the cursor, or record `expectedEquals`. */
export function kernelFormTestExpectEquals(state: FormTestParserState): boolean {
  const at = kernelFormTestAtEquals(state, state.pos);
  if (at < 0) {
    const here = kernelFormTestNextIndex(state, state.pos);
    kernelFormTestFail(state, "expectedEquals", here, here < state.end ? here + 1 : here);
    return false;
  }
  state.pos = at + 1;
  return true;
}

/** Consume the keyword `word` (any case) at the cursor, or record `expectedKeyword`. */
export function kernelFormTestExpectKeyword(state: FormTestParserState, word: string): boolean {
  const token = kernelFormTestTokenAt(state, state.pos);
  if (kernelFormTestLower(token.text) === word) {
    state.pos = token.end;
    return true;
  }
  kernelFormTestFail(
    state,
    "expectedKeyword",
    token.start,
    kernelFormTestSpanEnd(state, token),
    token.text === "" ? { expected: word } : { expected: word, token: token.text }
  );
  return false;
}

/** True when the statement is complete; otherwise records `trailingText`. */
export function kernelFormTestFinish(state: FormTestParserState): boolean {
  const at = kernelFormTestNextIndex(state, state.pos);
  if (at < state.end) {
    kernelFormTestFail(state, "trailingText", at, state.end, { token: state.text.slice(at, Math.min(state.end, at + 40)) });
    return false;
  }
  return true;
}

/** `test "name"`: open a block. A header with a problem still opens one (nameless) so its statements are not all strays. */
export function kernelFormTestParseHeader(state: FormTestParserState, keyword: FormTestToken): void {
  const scenario: FormTestScenario = {
    name: "",
    nameSpan: { line: state.line, start: keyword.end, end: keyword.end },
    givens: [],
    steps: [],
    refs: [],
    line: state.line,
    span: { line: state.line, start: keyword.start, end: state.end }
  };
  state.scenarios.push(scenario);
  state.current = scenario;
  state.givenKeys = Object.create(null) as Record<string, boolean>;
  state.pos = keyword.end;
  const at = kernelFormTestNextIndex(state, state.pos);
  const name = kernelFormTestReadQuoted(state, "expectedName");
  if (name === undefined) {
    return;
  }
  scenario.name = name;
  scenario.nameSpan = { line: state.line, start: at, end: state.pos };
  // Results are keyed by name, so a report could not tell two tests apart that share one, and a
  // test with no name has nothing to be reported under.
  if (name === "") {
    kernelFormTestFail(state, "expectedName", at, state.pos);
  } else if (state.names[name] === true) {
    kernelFormTestFail(state, "duplicateName", at, state.pos, { name });
  } else {
    state.names[name] = true;
  }
  kernelFormTestFinish(state);
}

/** `skip "reason"`: only directly under the header. */
export function kernelFormTestParseSkip(state: FormTestParserState, keyword: FormTestToken): void {
  const scenario = state.current;
  if (scenario === undefined) {
    return;
  }
  if (scenario.skip !== undefined || scenario.givens.length > 0 || scenario.steps.length > 0) {
    kernelFormTestFail(state, "skipAfterStep", keyword.start, state.end);
    return;
  }
  const reason = kernelFormTestReadQuoted(state, "expectedValue");
  if (reason === undefined || !kernelFormTestFinish(state)) {
    return;
  }
  scenario.skip = reason;
}

/** `given ...`: today, locale, journey, host.<name>, options for <path>; at most once each and only before the first step. */
export function kernelFormTestParseGiven(state: FormTestParserState, keyword: FormTestToken): void {
  const scenario = state.current;
  if (scenario === undefined) {
    return;
  }
  if (scenario.steps.length > 0) {
    kernelFormTestFail(state, "givenAfterStep", keyword.start, state.end);
    return;
  }
  const target = kernelFormTestTokenAt(state, state.pos);
  const word = kernelFormTestLower(target.text);
  const line = state.line;
  let given: FormTestGiven | undefined;
  let key = "";
  if (word === "today" || word === "locale") {
    state.pos = target.end;
    if (!kernelFormTestExpectEquals(state)) {
      return;
    }
    const at = kernelFormTestNextIndex(state, state.pos);
    const read = kernelFormTestReadValue(state);
    if (read === undefined) {
      return;
    }
    const value = read.value;
    const usable = typeof value === "string" && (word === "today" ? kernelFormTestIsIsoDay(value) : value !== "");
    if (typeof value !== "string" || !usable) {
      kernelFormTestFail(state, "badGiven", at, state.pos, { key: word });
      return;
    }
    key = word;
    given = word === "today" ? { kind: "given", key: "today", value, line } : { kind: "given", key: "locale", value, line };
  } else if (word === "journey") {
    state.pos = target.end;
    if (!kernelFormTestExpectEquals(state)) {
      return;
    }
    const idToken = kernelFormTestTokenAt(state, state.pos);
    if (idToken.text === "" || !kernelFormTestIsId(idToken.text)) {
      kernelFormTestFail(state, "expectedValue", idToken.start, kernelFormTestSpanEnd(state, idToken), idToken.text === "" ? undefined : { token: idToken.text });
      return;
    }
    state.pos = idToken.end;
    // `none` is a keyword like the rest, in any case; any other id keeps its own.
    const whole = kernelFormTestLower(idToken.text) === "none";
    if (!whole) {
      kernelFormTestAddRef(state, "journey", idToken.text, idToken.start, idToken.end);
    }
    key = "journey";
    given = { kind: "given", key: "journey", value: whole ? "none" : idToken.text, line };
  } else if (word.length > 5 && word.slice(0, 5) === "host.") {
    const name = target.text.slice(5);
    if (!kernelFormTestIsId(name)) {
      kernelFormTestFail(state, "badGiven", target.start, target.end, { key: "host" });
      return;
    }
    state.pos = target.end;
    kernelFormTestAddRef(state, "host", name, target.start + 5, target.end);
    if (!kernelFormTestExpectEquals(state)) {
      return;
    }
    const read = kernelFormTestReadValue(state);
    if (read === undefined) {
      return;
    }
    key = "host." + name;
    given = { kind: "given", key: "host", name, value: read.value, line };
  } else if (word === "options") {
    state.pos = target.end;
    if (!kernelFormTestExpectKeyword(state, "for")) {
      return;
    }
    const path = kernelFormTestReadPathRef(state, "path");
    if (path === undefined || !kernelFormTestExpectEquals(state)) {
      return;
    }
    const open = kernelFormTestNextIndex(state, state.pos);
    if (open >= state.end || state.text.charAt(open) !== "(") {
      kernelFormTestFail(state, "expectedValue", open, open < state.end ? open + 1 : open, { expected: "list" });
      return;
    }
    const read = kernelFormTestReadValue(state);
    if (read === undefined) {
      return;
    }
    const values = Array.isArray(read.value) ? read.value : [];
    key = "options for " + path;
    given = { kind: "given", key: "options", path, values, line };
  } else {
    kernelFormTestFail(state, "badGiven", target.start, target.end > target.start ? target.end : state.end, target.text === "" ? undefined : { word: target.text });
    return;
  }
  if (!kernelFormTestFinish(state)) {
    return;
  }
  if (state.givenKeys[key] === true) {
    kernelFormTestFail(state, "duplicateGiven", keyword.start, state.end, { key });
    return;
  }
  state.givenKeys[key] = true;
  scenario.givens.push(given);
}

/** The actions: set, clear, add row, remove row, continue, back, go to, change, check, submit. */
export function kernelFormTestParseAction(state: FormTestParserState, word: string): FormTestAction | undefined {
  const line = state.line;
  switch (word) {
    case "set": {
      const path = kernelFormTestReadPathRef(state, "path");
      if (path === undefined || !kernelFormTestExpectEquals(state)) {
        return undefined;
      }
      const read = kernelFormTestReadValue(state);
      if (read === undefined || !kernelFormTestFinish(state)) {
        return undefined;
      }
      return { kind: "set", path, value: read.value, line };
    }
    case "clear": {
      const path = kernelFormTestReadPathRef(state, "path");
      if (path === undefined || !kernelFormTestFinish(state)) {
        return undefined;
      }
      return { kind: "clear", path, line };
    }
    case "add":
      return kernelFormTestParseAddRow(state);
    case "remove":
      return kernelFormTestParseRemoveRow(state);
    case "go": {
      if (!kernelFormTestExpectKeyword(state, "to")) {
        return undefined;
      }
      const page = kernelFormTestReadIdRef(state, "page", "expectedPage");
      if (page === undefined || !kernelFormTestFinish(state)) {
        return undefined;
      }
      return { kind: "goTo", page, line };
    }
    case "change": {
      const path = kernelFormTestReadPathRef(state, "path");
      if (path === undefined || !kernelFormTestFinish(state)) {
        return undefined;
      }
      return { kind: "change", path, line };
    }
    case "continue":
      return kernelFormTestFinish(state) ? { kind: "continue", line } : undefined;
    case "back":
      return kernelFormTestFinish(state) ? { kind: "back", line } : undefined;
    case "check":
      return kernelFormTestFinish(state) ? { kind: "check", line } : undefined;
    case "submit":
      return kernelFormTestFinish(state) ? { kind: "submit", line } : undefined;
    default:
      return undefined;
  }
}

/** `add row to <collectionPath> [with <key> = <literal>, ...]`; the keys are relative to the new row. */
export function kernelFormTestParseAddRow(state: FormTestParserState): FormTestAction | undefined {
  const line = state.line;
  if (!kernelFormTestExpectKeyword(state, "row") || !kernelFormTestExpectKeyword(state, "to")) {
    return undefined;
  }
  const path = kernelFormTestReadPathRef(state, "collection");
  if (path === undefined) {
    return undefined;
  }
  const more = kernelFormTestTokenAt(state, state.pos);
  if (kernelFormTestLower(more.text) !== "with") {
    return kernelFormTestFinish(state) ? { kind: "addRow", path, line } : undefined;
  }
  state.pos = more.end;
  const values: Record<string, FormTestValue> = Object.create(null) as Record<string, FormTestValue>;
  while (true) {
    const key = kernelFormTestTokenAt(state, state.pos);
    if (key.text === "" || !kernelFormTestIsPath(key.text)) {
      kernelFormTestFail(state, "expectedPath", key.start, kernelFormTestSpanEnd(state, key), key.text === "" ? undefined : { token: key.text });
      return undefined;
    }
    state.pos = key.end;
    // The key is the field's, relative to the new row: noted against its collection, so the
    // builder's rename seam reaches it (a `path` ref would read as an unknown top-level field).
    kernelFormTestAddRef(state, "rowKey", key.text, key.start, key.end, path);
    if (!kernelFormTestExpectEquals(state)) {
      return undefined;
    }
    const read = kernelFormTestReadValue(state);
    if (read === undefined) {
      return undefined;
    }
    if (Object.prototype.hasOwnProperty.call(values, key.text)) {
      kernelFormTestFail(state, "duplicateGiven", key.start, key.end, { key: key.text });
      return undefined;
    }
    values[key.text] = read.value;
    const next = kernelFormTestNextIndex(state, state.pos);
    if (next < state.end && state.text.charAt(next) === ",") {
      state.pos = next + 1;
      continue;
    }
    break;
  }
  return kernelFormTestFinish(state) ? { kind: "addRow", path, values, line } : undefined;
}

/** `remove row <n> of <collectionPath>`: `n` is the engine's 0-based index. */
export function kernelFormTestParseRemoveRow(state: FormTestParserState): FormTestAction | undefined {
  const line = state.line;
  if (!kernelFormTestExpectKeyword(state, "row")) {
    return undefined;
  }
  const number = kernelFormTestTokenAt(state, state.pos);
  if (!/^\d{1,9}$/.test(number.text)) {
    kernelFormTestFail(state, "expectedNumber", number.start, kernelFormTestSpanEnd(state, number), number.text === "" ? undefined : { token: number.text });
    return undefined;
  }
  state.pos = number.end;
  if (!kernelFormTestExpectKeyword(state, "of")) {
    return undefined;
  }
  const path = kernelFormTestReadPathRef(state, "collection");
  if (path === undefined || !kernelFormTestFinish(state)) {
    return undefined;
  }
  return { kind: "removeRow", path, index: Number(number.text), line };
}

/**
 * `expect ...`, the forms tried in a fixed order. A keyword-led form commits once its
 * lead words match (`error on`, `message on`, `rows of`, ...), so its mistakes are reported as
 * its own; the shapes a field could also spell (`accepted`, `page = x`) commit only when the
 * words after them say so, and anything else falls to the path forms and the formula.
 */
export function kernelFormTestParseExpect(state: FormTestParserState): FormTestExpectation | undefined {
  const line = state.line;
  const first = kernelFormTestTokenAt(state, state.pos);
  if (first.start >= state.end) {
    kernelFormTestFail(state, "expectedValue", first.start, first.start);
    return undefined;
  }
  const second = kernelFormTestTokenAt(state, first.end);
  const w1 = kernelFormTestLower(first.text);
  const w2 = kernelFormTestLower(second.text);

  // 1. The verdict.
  if ((w1 === "accepted" || w1 === "refused") && kernelFormTestNextIndex(state, first.end) >= state.end) {
    return { kind: "expectVerdict", verdict: w1 === "accepted" ? "accepted" : "refused", line };
  }
  // 2. No errors, no error on a path.
  if (w1 === "no" && (w2 === "errors" || w2 === "error")) {
    state.pos = second.end;
    if (w2 === "errors") {
      return kernelFormTestFinish(state) ? { kind: "expectNoError", line } : undefined;
    }
    if (!kernelFormTestExpectKeyword(state, "on")) {
      return undefined;
    }
    const path = kernelFormTestReadPathRef(state, "path");
    return path !== undefined && kernelFormTestFinish(state) ? { kind: "expectNoError", path, line } : undefined;
  }
  // 3. An error on a path, with or without its code.
  if (w1 === "error" && w2 === "on") {
    state.pos = second.end;
    return kernelFormTestParseExpectError(state);
  }
  // 4. A worded message.
  if (w1 === "message" && w2 === "on") {
    state.pos = second.end;
    const path = kernelFormTestReadPathRef(state, "path");
    if (path === undefined || !kernelFormTestExpectEquals(state)) {
      return undefined;
    }
    const message = kernelFormTestReadQuoted(state, "expectedValue");
    return message !== undefined && kernelFormTestFinish(state) ? { kind: "expectMessage", path, message, line } : undefined;
  }
  // 5. The page.
  if (w1 === "page" && kernelFormTestAtEquals(state, first.end) >= 0) {
    state.pos = kernelFormTestAtEquals(state, first.end) + 1;
    const page = kernelFormTestReadIdRef(state, "page", "expectedPage");
    return page !== undefined && kernelFormTestFinish(state) ? { kind: "expectPage", page, line } : undefined;
  }
  // 6. The path: a list of pages, or where it ends.
  if (w1 === "path" && (kernelFormTestAtEquals(state, first.end) >= 0 || w2 === "ends")) {
    return kernelFormTestParseExpectPathForm(state, first, second);
  }
  // 7. A page on or off the path.
  if (kernelFormTestIsId(first.text) && (w2 === "on" || w2 === "off")) {
    const third = kernelFormTestTokenAt(state, second.end);
    if (kernelFormTestLower(third.text) === "path") {
      kernelFormTestAddRef(state, "page", first.text, first.start, first.end);
      state.pos = third.end;
      return kernelFormTestFinish(state) ? { kind: "expectOnPath", page: first.text, on: w2 === "on", line } : undefined;
    }
  }
  // 8. What went out: `submitted <path> = <literal>`.
  if (w1 === "submitted" && second.text !== "" && kernelFormTestIsPath(second.text)) {
    const next = kernelFormTestNextIndex(state, second.end);
    const nextChar = next < state.end ? state.text.charAt(next) : "";
    const stateLike = kernelFormTestStateOf(w2) !== "" || w2 === "not" || w2 === "withheld";
    if (nextChar === "=" || nextChar === "!" || (nextChar === "" && !stateLike)) {
      state.pos = second.end;
      kernelFormTestAddRef(state, "path", second.text, second.start, second.end);
      if (!kernelFormTestExpectEquals(state)) {
        return undefined;
      }
      const read = kernelFormTestReadValue(state);
      return read !== undefined && kernelFormTestFinish(state)
        ? { kind: "expectSubmitted", path: second.text, value: read.value, line }
        : undefined;
    }
  }
  // 9. A path withheld.
  if (w2 === "withheld" && kernelFormTestIsPath(first.text)) {
    kernelFormTestAddRef(state, "path", first.text, first.start, first.end);
    state.pos = second.end;
    return kernelFormTestFinish(state) ? { kind: "expectWithheld", path: first.text, line } : undefined;
  }
  // 10. Row counts.
  if (w1 === "rows" && w2 === "of") {
    state.pos = second.end;
    const path = kernelFormTestReadPathRef(state, "collection");
    if (path === undefined || !kernelFormTestExpectEquals(state)) {
      return undefined;
    }
    const count = kernelFormTestTokenAt(state, state.pos);
    if (!/^\d{1,9}$/.test(count.text)) {
      kernelFormTestFail(state, "expectedNumber", count.start, kernelFormTestSpanEnd(state, count), count.text === "" ? undefined : { token: count.text });
      return undefined;
    }
    state.pos = count.end;
    return kernelFormTestFinish(state) ? { kind: "expectRows", path, count: Number(count.text), line } : undefined;
  }
  // 11. The PDF layout.
  if (w1 === "layout" && kernelFormTestAtEquals(state, first.end) >= 0) {
    state.pos = kernelFormTestAtEquals(state, first.end) + 1;
    const layout = kernelFormTestReadIdRef(state, "layout", "expectedValue");
    return layout !== undefined && kernelFormTestFinish(state) ? { kind: "expectLayout", layout, line } : undefined;
  }
  // 12 to 14. A state, a value, otherwise a formula.
  return kernelFormTestParseExpectField(state, first, second);
}

/** `error on <path>` and `error on <path>: <code>`, the cursor after `on`. */
export function kernelFormTestParseExpectError(state: FormTestParserState): FormTestExpectation | undefined {
  const line = state.line;
  const path = kernelFormTestReadPathRef(state, "path");
  if (path === undefined) {
    return undefined;
  }
  const colon = kernelFormTestNextIndex(state, state.pos);
  if (colon < state.end && state.text.charAt(colon) === ":") {
    const from = kernelFormTestNextIndex(state, colon + 1);
    let to = from;
    while (to < state.end && !kernelFormTestIsSpace(state.text.charAt(to))) {
      to += 1;
    }
    const code = state.text.slice(from, to);
    // Letters, digits, dots, and the underscore and hyphen a host's own codes use (`server_code`, `cross-field.x`).
    if (!/^[A-Za-z0-9._-]+$/.test(code)) {
      kernelFormTestFail(state, "badCode", from, to > from ? to : from, code === "" ? undefined : { code });
      return undefined;
    }
    state.pos = to;
    kernelFormTestAddRef(state, "code", code, from, to);
    return kernelFormTestFinish(state) ? { kind: "expectError", path, code, line } : undefined;
  }
  return kernelFormTestFinish(state) ? { kind: "expectError", path, line } : undefined;
}

/** `path = (a, b)`, `path ends` and `path ends at <exit>`, committed on the lead word `path`. */
export function kernelFormTestParseExpectPathForm(
  state: FormTestParserState,
  first: FormTestToken,
  second: FormTestToken
): FormTestExpectation | undefined {
  const line = state.line;
  const equals = kernelFormTestAtEquals(state, first.end);
  if (equals >= 0) {
    state.pos = equals + 1;
    const open = kernelFormTestNextIndex(state, state.pos);
    if (open >= state.end || state.text.charAt(open) !== "(") {
      kernelFormTestFail(state, "expectedValue", open, open < state.end ? open + 1 : open, { expected: "list" });
      return undefined;
    }
    const pages = kernelFormTestReadPageList(state, open);
    return pages !== undefined && kernelFormTestFinish(state) ? { kind: "expectPath", pages, line } : undefined;
  }
  state.pos = second.end;
  const at = kernelFormTestTokenAt(state, state.pos);
  if (kernelFormTestLower(at.text) === "at") {
    state.pos = at.end;
    const exit = kernelFormTestReadIdRef(state, "page", "expectedPage");
    return exit !== undefined && kernelFormTestFinish(state) ? { kind: "expectPathEnd", exit, line } : undefined;
  }
  return kernelFormTestFinish(state) ? { kind: "expectPathEnd", line } : undefined;
}

/** The page ids of a list opening at `open`: `(home, about)`, possibly empty. Moves the cursor past `)`. */
export function kernelFormTestReadPageList(state: FormTestParserState, open: number): string[] | undefined {
  const pages: string[] = [];
  let i = kernelFormTestNextIndex(state, open + 1);
  if (i < state.end && state.text.charAt(i) === ")") {
    state.pos = i + 1;
    return pages;
  }
  while (true) {
    state.pos = i;
    if (i >= state.end) {
      kernelFormTestFail(state, "unclosedList", open, state.end);
      return undefined;
    }
    const page = kernelFormTestReadIdRef(state, "page", "expectedPage");
    if (page === undefined) {
      return undefined;
    }
    pages.push(page);
    i = kernelFormTestNextIndex(state, state.pos);
    if (i >= state.end) {
      kernelFormTestFail(state, "unclosedList", open, state.end);
      return undefined;
    }
    const ch = state.text.charAt(i);
    if (ch === ",") {
      i = kernelFormTestNextIndex(state, i + 1);
      continue;
    }
    if (ch === ")") {
      state.pos = i + 1;
      return pages;
    }
    kernelFormTestFail(state, "unclosedList", i, i + 1, { token: ch });
    return undefined;
  }
}

/**
 * Whether a leading token reads a formula scope, not a field: `host.role`, `row.qty`,
 * `ancestor.total`. Such a name is no answer's path (the scope words belong to the rule
 * language), so `expect host.role = "admin"` is a formula and not a value check on a field
 * that can never be found.
 */
export function kernelFormTestIsScopeRead(text: string): boolean {
  return text.indexOf("host.") === 0 || text.indexOf("row.") === 0 || text.indexOf("ancestor.") === 0;
}

/**
 * Items 12 to 14: `<path> <state>`, `<path> = <literal>` / `!= <literal>`, else a formula. A
 * word that is no state after a path is `badState` only when the whole rest is no formula
 * either, so `expect total > 5` and `expect x in (1, 2)` stay formulas.
 */
export function kernelFormTestParseExpectField(
  state: FormTestParserState,
  first: FormTestToken,
  second: FormTestToken
): FormTestExpectation | undefined {
  const line = state.line;
  if (first.text !== "" && kernelFormTestIsPath(first.text) && !kernelFormTestIsScopeRead(first.text)) {
    const w2 = kernelFormTestLower(second.text);
    const named = kernelFormTestStateOf(w2);
    if (named !== "") {
      kernelFormTestAddRef(state, "path", first.text, first.start, first.end);
      state.pos = second.end;
      return kernelFormTestFinish(state) ? { kind: "expectState", path: first.text, state: named, line } : undefined;
    }
    if (w2 === "not") {
      const third = kernelFormTestTokenAt(state, second.end);
      if (kernelFormTestLower(third.text) !== "empty") {
        kernelFormTestFail(state, "badState", second.start, third.end > third.start ? third.end : second.end, {
          word: third.text === "" ? "not" : "not " + third.text
        });
        return undefined;
      }
      kernelFormTestAddRef(state, "path", first.text, first.start, first.end);
      state.pos = third.end;
      return kernelFormTestFinish(state) ? { kind: "expectState", path: first.text, state: "notEmpty", line } : undefined;
    }
    const next = kernelFormTestNextIndex(state, first.end);
    const equals = kernelFormTestAtEquals(state, first.end);
    const notEquals = next + 1 < state.end && state.text.charAt(next) === "!" && state.text.charAt(next + 1) === "=" ? next : -1;
    if (equals >= 0 || notEquals >= 0) {
      const literal = kernelFormTestReadLiteral(state, (equals >= 0 ? equals : notEquals) + (equals >= 0 ? 1 : 2), 0);
      if (literal.ok) {
        if (kernelFormTestNextIndex(state, literal.end) >= state.end) {
          kernelFormTestAddRef(state, "path", first.text, first.start, first.end);
          state.pos = literal.end;
          return { kind: "expectValue", path: first.text, op: equals >= 0 ? "eq" : "ne", value: literal.value, line };
        }
      } else if (literal.lexical) {
        kernelFormTestFailLiteral(state, literal);
        return undefined;
      }
    } else if (/^[A-Za-z]+$/.test(second.text) && !kernelFormTestIsFormulaWord(w2)) {
      const probe = kernelParseFormula(kernelFormTestFormulaText(state.text.slice(first.start, state.end)), state.signatures);
      if (!probe.ok) {
        kernelFormTestFail(state, "badState", second.start, second.end, { word: second.text });
        return undefined;
      }
    }
  }
  return kernelFormTestParseExpectFormula(state, first.start);
}

/** `expect <formula>`: the rest of the line from `from` goes to the formula parser; its paths become path refs. */
export function kernelFormTestParseExpectFormula(state: FormTestParserState, from: number): FormTestExpectation | undefined {
  const formula = state.text.slice(from, state.end);
  const result = kernelParseFormula(kernelFormTestFormulaText(formula), state.signatures);
  if (!result.ok) {
    const params: FormTestParams = Object.create(null) as FormTestParams;
    const inner = result.params;
    for (const name of Object.keys(inner)) {
      params[name] = inner[name] as string | number;
    }
    params.formulaCode = result.code;
    kernelFormTestFail(state, "badFormula", from + result.start, from + result.end, params);
    return undefined;
  }
  if (result.expression === undefined) {
    kernelFormTestFail(state, "expectedValue", state.end, state.end);
    return undefined;
  }
  // Oldest first, so the refs stay in source order whatever order the parser met the names in.
  const paths = result.paths.slice();
  for (let i = 1; i < paths.length; i += 1) {
    const item = paths[i];
    if (item === undefined) {
      continue;
    }
    let j = i - 1;
    while (j >= 0 && (paths[j]?.start ?? 0) > item.start) {
      paths[j + 1] = paths[j] as typeof item;
      j -= 1;
    }
    paths[j + 1] = item;
  }
  for (const item of paths) {
    let start = from + item.start;
    let end = from + item.end;
    if (item.path.indexOf("host.") === 0) {
      // A host read is the host's key (the ref a `given host.x` notes), not a field.
      kernelFormTestAddRef(state, "host", item.path.slice(5), start + 5, end);
      continue;
    }
    if (item.path.indexOf("row.") === 0 || item.path.indexOf("ancestor.") === 0) {
      // A scope read names the row or the section around it, no field of the form to look up.
      continue;
    }
    // The span is the name, not the backticks round it, so a rename rewrites what it covers.
    if (end - start >= 2 && state.text.charAt(start) === "`" && state.text.charAt(end - 1) === "`") {
      start += 1;
      end -= 1;
    }
    kernelFormTestAddRef(state, "path", item.path, start, end);
  }
  return { kind: "expectFormula", formula, expression: result.expression, line: state.line };
}

/** This module's functions, for the kernel's function list (as `FORMULA_FUNCTIONS` lists the formula parser's). */
export const FORM_TEST_PARSE_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelParseFormTests,
  kernelFormTestMessage,
  kernelFormTestFormulaWording,
  kernelFormTestFail,
  kernelFormTestParseLine,
  kernelFormTestContentEnd,
  kernelFormTestIsSpace,
  kernelFormTestFormulaText,
  kernelFormTestIsDelimiter,
  kernelFormTestIsCurly,
  kernelFormTestLower,
  kernelFormTestNextIndex,
  kernelFormTestTokenAt,
  kernelFormTestSpanEnd,
  kernelFormTestAtEquals,
  kernelFormTestIsStatementWord,
  kernelFormTestStateOf,
  kernelFormTestIsFormulaWord,
  kernelFormTestIsId,
  kernelFormTestIsPathSegment,
  kernelFormTestIsPath,
  kernelFormTestIsIsoDay,
  kernelFormTestReadString,
  kernelFormTestStringValue,
  kernelFormTestReadLiteral,
  kernelFormTestReadList,
  kernelFormTestFailLiteral,
  kernelFormTestReadValue,
  kernelFormTestReadQuoted,
  kernelFormTestAddRef,
  kernelFormTestReadPathRef,
  kernelFormTestReadIdRef,
  kernelFormTestExpectEquals,
  kernelFormTestExpectKeyword,
  kernelFormTestFinish,
  kernelFormTestParseHeader,
  kernelFormTestParseSkip,
  kernelFormTestParseGiven,
  kernelFormTestParseAction,
  kernelFormTestParseAddRow,
  kernelFormTestParseRemoveRow,
  kernelFormTestParseExpect,
  kernelFormTestParseExpectError,
  kernelFormTestParseExpectPathForm,
  kernelFormTestReadPageList,
  kernelFormTestIsScopeRead,
  kernelFormTestParseExpectField,
  kernelFormTestParseExpectFormula
];
