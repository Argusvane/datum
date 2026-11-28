/**
 * The formula editor: the box an author writes a rule's formula in, on the Logic surface and in
 * the inspector's Logic tab.
 * CodeMirror underneath, in the same lazy chunk as the JSON viewer; hosts reach it through
 * `formula-editor-loader.ts` and show the plain textarea (`formula-textarea.ts`, the same
 * interface) until it lands. The types the two share, and the one computation of a text's
 * parse and problems ({@link formulaEditorState}), live with the textarea, so the marks in this
 * box and the lines under that one say the same thing.
 *
 * The field is a sentence, not code: no gutter or line numbers, wrapping on, a 44px minimum.
 * A field id in the text is drawn as a chip showing the field's label (a replace decoration
 * over the id, atomic so the caret steps over it and Backspace removes it whole); the id is
 * what the document holds and what `getText()` returns. Keywords, numbers, strings, operators
 * and function names carry classes (`.f-kw`, `.f-num`, `.f-str`, `.f-op`,
 * `.f-fn`), given by a `StreamLanguage` tokenizer that reads the text the way the parser does.
 * The look itself is the host-appended sheet in `formula-editor-styles.ts`.
 *
 * Every edit parses the text and checks each field read against the host's field list: parse
 * errors and unknown fields are marked in the box through `@codemirror/lint` (an unknown
 * field as a chip in the danger wash, its nearest match as the fix) and handed to the host in
 * `onChange` (which never paints: hosts refresh live text or write a draft) and `onCommit`
 * (blur with the text changed, Enter on a single-line box). `setText` is the host's, never an
 * edit of the author's: neither callback fires.
 *
 * Suggestions (`@codemirror/autocomplete`): fields first, then scoped paths, then functions
 * with their argument names, then keywords; after a choice field and `=` / `!=` / `in (`, its
 * options as quoted strings; Tab inserts. Under the box, one helper row: + Field, ƒ Function,
 * Helpers ▾ (the snippets menu) and the Formula reference link. A snippet or function inserts
 * at the caret with each blank selected in turn (Tab moves through them). In a multiline box
 * Enter after `then` or `else` starts the next case indented.
 *
 * Built on first mount, not at import, like the JSON viewer: the language, the highlight style
 * and the theme are created the first time an editor mounts, so the module's import has no
 * side effect a bundler keeps.
 */
import { acceptCompletion, autocompletion, completionStatus, snippet, type Completion, type CompletionContext, type CompletionResult, type CompletionSection, type CompletionSource } from "@codemirror/autocomplete";
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { Annotation, type AnnotationType, EditorSelection, EditorState, type Extension, type Range, RangeSetBuilder, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, type PluginValue, ViewPlugin, type ViewUpdate, WidgetType, keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";

import { kernelConditionKind, kernelRegexRisky } from "../../core/expressions/compile.js";
import type { Expression } from "../../core/expressions/expression.js";
import { kernelFormulaStringValue } from "../../core/expressions/formula.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { builderText } from "./formula-texts-en.js";
import { FORMULA_SNIPPET_GROUPS, feelName, snippetLabel, type FormulaFunctionRow, type FormulaSnippet } from "./feel-functions.js";
import { isKnownFormulaPath, type FormulaField } from "./formula-fields.js";
import { formulaEditorState, type FormulaEditor, type FormulaEditorProblem, type FormulaEditorOptions, type FormulaEditorState } from "./formula-textarea.js";

export type { FormulaField } from "./formula-fields.js";
export type { FormulaEditor, FormulaEditorOptions, FormulaEditorProblem, FormulaEditorState } from "./formula-textarea.js";

/** The CodeMirror editor's options: the shared ones, and where the reference link goes. */
export interface CodeMirrorFormulaEditorOptions extends FormulaEditorOptions {
  /** Where the "Formula reference" link goes; absent, the editor draws no link (the builder has no page of its own to name). */
  referenceHref?: string;
  /**
   * The formula is a condition (`visibleWhen`, `requiredWhen`, `enabledWhen`, `readonlyWhen`,
   * `navigationGating`, a journey or PDF `when`), which holds only for a yes-or-no `true`: the
   * editor then warns when its result is provably something else. Absent: a value formula.
   */
  condition?: boolean;
  /**
   * `"allow"` when the host lets a `matches` pattern of a catastrophic shape run
   * (`riskyPatterns`); the editor then does not warn about one. Absent or `"refuse"`: it does.
   */
  riskyPatterns?: "refuse" | "allow";
}

/** The CodeMirror editor: the shared interface, the parse state on demand, and a caret to place. */
export interface CodeMirrorFormulaEditor extends FormulaEditor {
  /** The parse and the problems for the text as it stands (what the next callback would carry). */
  getState(): FormulaEditorState;
  /** Focuses the box, the caret where it was or at `offset`. */
  focus(offset?: number): void;
}

/** What the suggestion source needs, apart from the text: the host's lists and words. */
export interface FormulaCompletionEnv {
  fieldsOf(): readonly FormulaField[];
  scopes: readonly string[];
  functions: readonly FormulaFunctionRow[];
  words: BuilderTextOptions;
}

/*
 * Tokens as the parser reads them (`core/expressions/formula.ts`): the same name and number
 * patterns, so a chip covers exactly the id the parser will read. Regex literals are plain
 * data; the CodeMirror pieces below are built on first mount.
 */
type TokenKind = "num" | "str" | "date" | "name" | "kw" | "lit" | "fn" | "op" | "bad";

export interface FormulaToken {
  kind: TokenKind;
  from: number;
  to: number;
  /** A name's id (ticks and padding trimmed); a number's or word's spelling. */
  value: string;
}

const NAME_PATTERN = /[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*/y;
const NUMBER_PATTERN = /(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/y;
const CALL_PATTERN = /\s*\(/y;
const KEYWORDS = new Set(["if", "then", "else", "and", "or", "not", "between", "in"]);
const LITERALS = new Set(["true", "false", "null"]);
const KEYWORD_SUGGESTIONS = ["if", "then", "else", "and", "or", "not", "between", "in", "true", "false", "null"];
const ALL_SCOPES = ["row.", "ancestor.", "host.", "component"];

/** The end (exclusive) of the quoted string opening at `at`; the text's end when unterminated. */
function stringEnd(text: string, at: number): number {
  const quote = text.charAt(at);
  let i = at + 1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/** A literal bound as the lint reads it: its kind and a comparable value. */
interface LintBound {
  kind: "number" | "text" | "date";
  value: number | string;
  from: number;
  to: number;
  /** The index of the token after the bound. */
  next: number;
}

function lintBoundAt(text: string, tokens: readonly FormulaToken[], at: number): LintBound | undefined {
  let sign = 1;
  let k = at;
  const first = tokens[k];
  if (first !== undefined && first.kind === "op" && first.value === "-" && tokens[k + 1]?.kind === "num") {
    sign = -1;
    k += 1;
  }
  const token = tokens[k];
  if (token === undefined) {
    return undefined;
  }
  const from = (first as FormulaToken).from;
  if (token.kind === "num") {
    return { kind: "number", value: sign * Number(token.value), from, to: token.to, next: k + 1 };
  }
  if (sign === 1 && token.kind === "str") {
    return { kind: "text", value: text.slice(token.from + 1, token.to - 1), from, to: token.to, next: k + 1 };
  }
  if (sign === 1 && token.kind === "date") {
    return { kind: "date", value: text.slice(token.from + 2, token.to - 1), from, to: token.to, next: k + 1 };
  }
  return undefined;
}

/** Whether a tree has an `=` or `!=` comparing a calculation with a decimal literal; fills `into` with those literals. */
function decimalComparisons(root: unknown, into: Set<number>): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") {
      continue;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        stack.push(item);
      }
      continue;
    }
    const record = node as Record<string, unknown>;
    if (record.kind === "binary" && (record.operator === "eq" || record.operator === "neq")) {
      for (const [calc, literal] of [[record.left, record.right], [record.right, record.left]] as const) {
        const side = literal as { kind?: string; value?: unknown } | null;
        if (
          (calc as { kind?: string } | null)?.kind === "arithmetic" &&
          side?.kind === "literal" &&
          typeof side.value === "number" &&
          Number.isFinite(side.value) &&
          !Number.isInteger(side.value)
        ) {
          into.add(side.value);
        }
      }
    }
    for (const key of Object.keys(record)) {
      stack.push(record[key]);
    }
  }
}

/**
 * The literal pattern of the `matches(...)` call whose name is `tokens[at]`, when it is of a
 * catastrophic shape (`kernelRegexRisky`): the second argument, a lone quoted text, with its span.
 */
function riskyPatternToken(text: string, tokens: readonly FormulaToken[], at: number): { pattern: string; from: number; to: number } | undefined {
  const open = tokens[at + 1];
  if (open === undefined || open.kind !== "op" || open.value !== "(") {
    return undefined;
  }
  let depth = 1;
  let commas = 0;
  for (let j = at + 2; j < tokens.length; j += 1) {
    const token = tokens[j] as FormulaToken;
    if (token.kind === "op" && (token.value === "(" || token.value === "[")) {
      depth += 1;
    } else if (token.kind === "op" && (token.value === ")" || token.value === "]")) {
      depth -= 1;
      if (depth === 0) {
        return undefined;
      }
    } else if (token.kind === "op" && token.value === "," && depth === 1) {
      commas += 1;
      const pattern = tokens[j + 1];
      const after = tokens[j + 2];
      if (commas === 1 && pattern !== undefined && pattern.kind === "str" && after !== undefined && after.kind === "op" && after.value === ")") {
        const decoded = kernelFormulaStringValue(text, pattern.from, pattern.to);
        return kernelRegexRisky(decoded) ? { pattern: decoded, from: pattern.from, to: pattern.to } : undefined;
      }
      return undefined;
    }
  }
  return undefined;
}

/**
 * Warnings for formulas that parse and run but are almost surely not what was meant: a range
 * with literal bounds that can never hold (low above high, or bounds of different kinds), a
 * backslash before a letter that is not an escape (`\u0041`), and `=` between a calculation
 * and a decimal literal (binary floating point: `0.1 + 0.2 = 0.3` is false). Spans cover the
 * range, the two characters or the literal. Nothing is reported for a formula that did not parse.
 * With `condition` set, a formula whose result is provably not a yes-or-no (`kernelConditionKind`:
 * a number, text or `null`, arithmetic, a function returning one) is reported over its whole text:
 * a condition holds only for `true`, and this one never does.
 */
export function lintFormula(
  text: string,
  tokens: readonly FormulaToken[],
  parsed: FormulaEditorState["parsed"],
  words: BuilderTextOptions,
  condition?: boolean,
  riskyPatterns?: "refuse" | "allow"
): FormulaEditorProblem[] {
  const problems: FormulaEditorProblem[] = [];
  if (!parsed.ok) {
    return problems;
  }
  if (condition === true && parsed.expression !== undefined && kernelConditionKind(parsed.expression) === "other") {
    problems.push({ kind: "lint", message: builderText("formula.lint.notBoolean", undefined, words), start: 0, end: text.length });
  }
  const range = (low: LintBound | undefined, high: LintBound | undefined, from: number, to: number): void => {
    if (low === undefined || high === undefined) {
      return;
    }
    if (low.kind !== high.kind) {
      problems.push({ kind: "lint", message: builderText("formula.lint.mixedRange", { low: low.kind, high: high.kind }, words), start: from, end: to });
    } else if (low.value > high.value) {
      problems.push({ kind: "lint", message: builderText("formula.lint.reversedRange", undefined, words), start: from, end: to });
    }
  };
  const decimals = new Set<number>();
  decimalComparisons(parsed.expression, decimals);
  // Whether the token scan below has flagged a risky pattern: it sees only a lone quoted text
  // closing the call, so one the parser reads through brackets or an `if` is left to the tree.
  const riskyReported = new Map<string, number>();
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] as FormulaToken;
    if (token.kind === "kw" && token.value === "in") {
      const open = tokens[at + 1];
      if (open !== undefined && open.kind === "op" && (open.value === "[" || open.value === "(")) {
        const low = lintBoundAt(text, tokens, at + 2);
        const dots = low === undefined ? undefined : tokens[low.next];
        if (low !== undefined && dots !== undefined && dots.kind === "op" && dots.value === "..") {
          const high = lintBoundAt(text, tokens, low.next + 1);
          range(low, high, open.from, high === undefined ? dots.to : (tokens[high.next] ?? tokens[high.next - 1] ?? dots).to);
        }
      }
    } else if (token.kind === "kw" && token.value === "between") {
      const low = lintBoundAt(text, tokens, at + 1);
      const and = low === undefined ? undefined : tokens[low.next];
      if (low !== undefined && and !== undefined && and.kind === "kw" && and.value === "and") {
        const high = lintBoundAt(text, tokens, low.next + 1);
        range(low, high, token.from, high === undefined ? and.to : high.to);
      }
    } else if (token.kind === "fn" && token.value === "matches" && riskyPatterns !== "allow") {
      const risky = riskyPatternToken(text, tokens, at);
      if (risky !== undefined) {
        riskyReported.set(risky.pattern, (riskyReported.get(risky.pattern) ?? 0) + 1);
        problems.push({ kind: "lint", message: builderText("formula.err.pattern.risky", { pattern: risky.pattern }, words), start: risky.from, end: risky.to });
      }
    } else if (token.kind === "str" || token.kind === "date") {
      for (let i = token.from; i < token.to - 1; i += 1) {
        if (text.charAt(i) !== "\\") {
          continue;
        }
        const letter = text.charAt(i + 1);
        if (/[A-Za-z]/.test(letter) && letter !== "n" && letter !== "t" && letter !== "r") {
          problems.push({ kind: "lint", message: builderText("formula.lint.backslash", { letter }, words), start: i, end: i + 2 });
        }
        i += 1;
      }
    } else if (token.kind === "num" && decimals.size > 0) {
      const before = tokens[at - 1];
      const signed = before !== undefined && before.kind === "op" && before.value === "-";
      const value = (signed ? -1 : 1) * Number(token.value);
      const edge = signed ? tokens[at - 2] : before;
      const after = tokens[at + 1];
      const isEquality = (candidate: FormulaToken | undefined): boolean =>
        candidate !== undefined && candidate.kind === "op" && (candidate.value === "=" || candidate.value === "==" || candidate.value === "!=");
      if (decimals.has(value) && (isEquality(edge) || isEquality(after))) {
        problems.push({
          kind: "lint",
          message: builderText("formula.lint.decimalEquals", { value: String(value) }, words),
          start: signed ? (before as FormulaToken).from : token.from,
          end: token.to
        });
      }
    }
  }
  // What the compile refuses is read from the parsed expression, as the compile reads it: the
  // pattern the tokens did not show (`("(a+)+$")`, one chosen by an `if`) is flagged too, over its
  // own text when that is found, else over the whole formula.
  // Every literal pattern the compile would refuse, in document order: the ones the token scan
  // already flagged are skipped (by count, so a pattern written twice is said twice), the rest are
  // put over their own string token, else once over the whole formula.
  if (riskyPatterns !== "allow" && parsed.expression !== undefined) {
    const taken = new Set<number>();
    let wholeSaid = false;
    for (const pattern of riskyLiteralsIn(parsed.expression)) {
      const reported = riskyReported.get(pattern) ?? 0;
      if (reported > 0) {
        riskyReported.set(pattern, reported - 1);
        continue;
      }
      const literal = tokens.find((token) => token.kind === "str" && !taken.has(token.from) && kernelFormulaStringValue(text, token.from, token.to) === pattern);
      if (literal === undefined && wholeSaid) {
        continue;
      }
      if (literal !== undefined) {
        taken.add(literal.from);
      } else {
        wholeSaid = true;
      }
      problems.push({
        kind: "lint",
        message: builderText("formula.err.pattern.risky", { pattern }, words),
        start: literal?.from ?? 0,
        end: literal?.to ?? text.length
      });
    }
  }
  return problems;
}

/**
 * Every literal pattern of a `matches(text, "pattern")` call in `expression` that the compile
 * refuses as risky, in document order ({@link kernelRiskyMatchesIn} stops at the first). A pattern
 * read from a field is not a literal and is not looked at. Explicit stack, so a long chain is no
 * recursion.
 */
function riskyLiteralsIn(expression: Expression): string[] {
  const found: string[] = [];
  const stack: Expression[] = [expression];
  while (stack.length > 0) {
    const node = stack.pop() as Expression;
    switch (node.kind) {
      case "unary":
        stack.push(node.operand);
        break;
      case "binary":
      case "logical":
      case "arithmetic":
        stack.push(node.right, node.left);
        break;
      case "call": {
        if (node.name === "matches" && node.args.length === 2) {
          const pattern = node.args[1] as Expression;
          if (pattern.kind === "literal" && typeof pattern.value === "string" && kernelRegexRisky(pattern.value)) {
            found.push(pattern.value);
          }
        }
        for (let a = node.args.length - 1; a >= 0; a -= 1) {
          stack.push(node.args[a] as Expression);
        }
        break;
      }
      case "if":
        if (node.else !== undefined) {
          stack.push(node.else);
        }
        for (let c = node.cases.length - 1; c >= 0; c -= 1) {
          const entry = node.cases[c] as { when: Expression; then: Expression };
          stack.push(entry.then, entry.when);
        }
        break;
      default:
        break;
    }
  }
  return found;
}

/** The text's tokens with their spans, read as the parser reads them. */
export function scanFormula(text: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    const from = i;
    if (ch === '"' || ch === "'") {
      i = stringEnd(text, i);
      tokens.push({ kind: "str", from, to: i, value: "" });
      continue;
    }
    if (ch === "@" && (text.charAt(i + 1) === '"' || text.charAt(i + 1) === "'")) {
      i = stringEnd(text, i + 1);
      tokens.push({ kind: "date", from, to: i, value: "" });
      continue;
    }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      const to = close < 0 ? text.length : close + 1;
      tokens.push({ kind: "name", from, to, value: text.slice(i + 1, close < 0 ? text.length : close).trim() });
      i = to;
      continue;
    }
    NUMBER_PATTERN.lastIndex = i;
    const number = NUMBER_PATTERN.exec(text);
    if (number !== null) {
      i += number[0].length;
      tokens.push({ kind: "num", from, to: i, value: number[0] });
      continue;
    }
    NAME_PATTERN.lastIndex = i;
    const name = NAME_PATTERN.exec(text);
    if (name !== null) {
      const word = name[0];
      i += word.length;
      let kind: TokenKind = "name";
      if (KEYWORDS.has(word)) {
        kind = "kw";
      } else if (LITERALS.has(word)) {
        kind = "lit";
      } else {
        CALL_PATTERN.lastIndex = i;
        if (CALL_PATTERN.test(text)) {
          kind = "fn";
        }
      }
      tokens.push({ kind, from, to: i, value: word });
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "!=" || two === "==" || two === "..") {
      i += 2;
      tokens.push({ kind: "op", from, to: i, value: two });
      continue;
    }
    if ("=<>+-*/()[],".includes(ch)) {
      i += 1;
      tokens.push({ kind: "op", from, to: i, value: ch });
      continue;
    }
    const code = text.codePointAt(i);
    const width = code !== undefined && code > 0xffff ? 2 : 1;
    i += width;
    tokens.push({ kind: "bad", from, to: i, value: text.slice(from, i) });
  }
  return tokens;
}

/** A problem's span clamped to the text. */
function clamp(at: number, length: number): number {
  return Math.max(0, Math.min(at, length));
}

/** A function's parameters as the suggestion list shows them beside the name: `(text, start, length?)`. */
function paramsText(row: FormulaFunctionRow): string {
  return row.signature.startsWith(row.name) ? row.signature.slice(row.name.length) : `(${row.params.join(", ")})`;
}

/** The label a chip shows for `path`: the field's label, a value under it with the rest (`Address.city`). */
function chipLabel(path: string, fields: readonly FormulaField[]): string | undefined {
  for (const field of fields) {
    for (const own of field.componentId === undefined ? [field.path] : [field.path, field.componentId]) {
      if (path === own) {
        return field.label;
      }
      if (path.startsWith(own + ".")) {
        return `${field.label}${path.slice(own.length)}`;
      }
    }
  }
  return undefined;
}

/*
 * The shared CodeMirror pieces, built once at first mount (see the header).
 */
let language: Extension | undefined;
let look: Extension | undefined;
let editMark: AnnotationType<"undo" | "set"> | undefined;

function skipString(stream: { next(): string | void; eol(): boolean }, quote: string): void {
  stream.next();
  while (!stream.eol()) {
    const ch = stream.next();
    if (ch === "\\") {
      stream.next();
    } else if (ch === quote) {
      return;
    }
  }
}

/** The FEEL subset's tokens for the highlighter; strings and names stay within a line here. */
function feelStreamParser(): StreamParser<unknown> {
  return {
    name: "feel",
    token(stream) {
      if (stream.eatSpace()) {
        return null;
      }
      const ch = stream.peek();
      if (ch === '"' || ch === "'") {
        skipString(stream, ch);
        return "string";
      }
      if (ch === "@") {
        stream.next();
        const quote = stream.peek();
        if (quote === '"' || quote === "'") {
          skipString(stream, quote);
          return "string";
        }
        return "invalid";
      }
      if (ch === "`") {
        stream.next();
        while (!stream.eol()) {
          if (stream.next() === "`") {
            break;
          }
        }
        return "variableName";
      }
      if (stream.match(/^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/)) {
        return "number";
      }
      const word = stream.match(/^[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*/);
      if (word !== null && word !== false) {
        const spelling = typeof word === "boolean" ? "" : (word[0] ?? "");
        if (KEYWORDS.has(spelling)) {
          return "keyword";
        }
        if (LITERALS.has(spelling)) {
          return "atom";
        }
        if (stream.match(/^\s*\(/, false)) {
          return "fn";
        }
        return "variableName";
      }
      if (stream.match(/^(<=|>=|!=|==|\.\.)/) || stream.match(/^[=<>+\-*/()[\],]/)) {
        return "operator";
      }
      stream.next();
      return "invalid";
    },
    tokenTable: { fn: tags.function(tags.variableName) }
  };
}

function feelLanguage(): Extension {
  language ??= [
    StreamLanguage.define(feelStreamParser()),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: tags.keyword, class: "f-kw" },
        { tag: [tags.number, tags.atom], class: "f-num" },
        { tag: tags.string, class: "f-str" },
        { tag: tags.operator, class: "f-op" },
        { tag: tags.function(tags.variableName), class: "f-fn" },
        { tag: tags.variableName, class: "f-path" },
        { tag: tags.invalid, class: "f-bad" }
      ])
    )
  ];
  return language;
}

/** The little the editor needs before the host's sheet: the sentence look, no code box. */
function baseLook(): Extension {
  look ??= EditorView.theme({
    "&": { backgroundColor: "var(--db-surface)", color: "var(--db-ink)", fontSize: "var(--db-text-md)" },
    ".cm-scroller": { fontFamily: "inherit", lineHeight: "28px" },
    ".cm-content": { padding: "8px 10px", minHeight: "44px", caretColor: "var(--db-ink)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--db-ink)" },
    /* CodeMirror's own light theme (a #f5f5f5 tooltip, a black caret) is an adopted sheet the shadow root applies after the host's <style>, so these live in the editor's theme, which loads after it. */
    ".cm-tooltip": {
      backgroundColor: "var(--db-surface)",
      color: "var(--db-ink)",
      border: "var(--db-border-w, 1px) solid var(--db-line-card)"
    },
    "&.cm-focused": { outline: "2px solid var(--db-focus)", outlineOffset: "1px" }
  });
  return look;
}

function marks(): AnnotationType<"undo" | "set"> {
  editMark ??= Annotation.define<"undo" | "set">();
  return editMark;
}

/** A field chip: the label shown over the id the document holds. */
class FieldChip extends WidgetType {
  constructor(
    readonly label: string,
    readonly path: string
  ) {
    super();
  }

  override eq(other: FieldChip): boolean {
    return other.label === this.label && other.path === this.path;
  }

  override toDOM(view: EditorView): HTMLElement {
    const chip = view.dom.ownerDocument.createElement("span");
    chip.className = "f-field ref-chip";
    chip.textContent = this.label;
    chip.title = this.path;
    chip.setAttribute("data-path", this.path);
    return chip;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** One state of the text an undo can go back to; whole snapshots, as the JSON viewer keeps them. */
interface Snapshot {
  doc: Text;
  selection: EditorSelection;
}

/**
 * Undo and redo without the commands package: the text before each burst of edits of one kind
 * less than half a second apart. A host's `setText` starts the history over.
 */
function snapshotHistory(mark: AnnotationType<"undo" | "set">): { extension: Extension; reset(): void } {
  const undone: Snapshot[] = [];
  const redone: Snapshot[] = [];
  let last = { kind: "", time: 0 };
  const kindOf = (update: ViewUpdate): string => {
    for (const kind of ["input.type", "delete", "input.paste", "input.drop", "input"]) {
      if (update.transactions.some((tr) => tr.isUserEvent(kind))) {
        return kind;
      }
    }
    return "other";
  };
  const step = (view: EditorView, from: Snapshot[], to: Snapshot[]): boolean => {
    const entry = from.pop();
    if (!entry) {
      return true;
    }
    to.push({ doc: view.state.doc, selection: view.state.selection });
    last = { kind: "", time: 0 };
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: entry.doc },
      selection: entry.selection,
      scrollIntoView: true,
      annotations: mark.of("undo")
    });
    return true;
  };
  return {
    extension: [
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.some((tr) => tr.annotation(mark) !== undefined)) {
          return;
        }
        const kind = kindOf(update);
        const now = Date.now();
        if (kind !== last.kind || kind === "input.paste" || kind === "other" || now - last.time > 500) {
          undone.push({ doc: update.startState.doc, selection: update.startState.selection });
          if (undone.length > 200) {
            undone.shift();
          }
        }
        last = { kind, time: now };
        redone.length = 0;
      }),
      keymap.of([
        { key: "Mod-z", run: (view) => step(view, undone, redone), preventDefault: true },
        { key: "Mod-Shift-z", run: (view) => step(view, redone, undone), preventDefault: true },
        { key: "Mod-y", run: (view) => step(view, redone, undone), preventDefault: true }
      ])
    ],
    reset(): void {
      undone.length = 0;
      redone.length = 0;
      last = { kind: "", time: 0 };
    }
  };
}

/** Which field with options the text names just before `=`, `!=` or inside `in (…)`, with where the partial value starts. */
function optionContext(before: string, fields: readonly FormulaField[]): { field: FormulaField; from: number } | undefined {
  const match = /(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*)\s*(?:=|==|!=|in\s*\((?:\s*(?:"[^"]*"|'[^']*')\s*,)*)\s*(["']?)([^"'()\s,]*)$/.exec(before);
  if (match === null) {
    return undefined;
  }
  const spelling = match[1] ?? "";
  const path = spelling.startsWith("`") ? spelling.slice(1, -1).trim() : spelling;
  const field = fields.find((entry) => entry.path === path || entry.componentId === path);
  if (field === undefined || field.options.length === 0) {
    return undefined;
  }
  const partial = (match[2] ?? "").length + (match[3] ?? "").length;
  return { field, from: before.length - partial };
}

/**
 * The suggestions for the text before the caret: fields (label shown, id inserted), scoped
 * paths, functions with their argument names, keywords; a choice field's options after `=`
 * or `in (`. Exported so the list can be checked without the popover.
 */
export function formulaCompletionSource(env: FormulaCompletionEnv): CompletionSource {
  const sections = {
    options: { name: builderText("editor.suggest.options", undefined, env.words), rank: 0 } satisfies CompletionSection,
    fields: { name: builderText("editor.suggest.fields", undefined, env.words), rank: 1 } satisfies CompletionSection,
    functions: { name: builderText("editor.suggest.functions", undefined, env.words), rank: 2 } satisfies CompletionSection,
    keywords: { name: builderText("editor.suggest.keywords", undefined, env.words), rank: 3 } satisfies CompletionSection
  };
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.state.sliceDoc(0, context.pos);
    const fields = env.fieldsOf();
    const choice = optionContext(before, fields);
    if (choice !== undefined) {
      return {
        from: choice.from,
        options: choice.field.options.map((option) => ({
          label: option.value === option.label ? option.value : `${option.label} ${option.value}`,
          displayLabel: option.label,
          detail: option.value,
          apply: JSON.stringify(option.value),
          type: "option",
          section: sections.options
        })),
        validFor: /^["']?[^"'()\s,]*$/
      };
    }
    const word = context.matchBefore(/`[^`]*|[A-Za-z_][A-Za-z0-9_.-]*/);
    if ((word === null || word.text === "") && !context.explicit) {
      return null;
    }
    // A field id typed out in full has just become a chip: the list closes as it would after
    // Tab took the suggestion, rather than staying open over the lines under the box.
    if (word !== null && !context.explicit && fields.some((field) => field.path === word.text)) {
      return null;
    }
    const options: Completion[] = [];
    for (const field of fields) {
      options.push({
        label: field.label === field.path ? field.path : `${field.label} ${field.path}`,
        displayLabel: field.label,
        detail: field.path,
        apply: feelName(field.path),
        type: "field",
        boost: 1,
        section: sections.fields
      });
    }
    for (const scope of env.scopes) {
      options.push({ label: scope, type: "scope", boost: -1, section: sections.fields });
    }
    for (const row of env.functions) {
      options.push({
        label: row.name,
        detail: paramsText(row),
        info: row.summary,
        apply: snippet(row.snippet),
        type: "function",
        section: sections.functions
      });
    }
    for (const keyword of KEYWORD_SUGGESTIONS) {
      options.push({ label: keyword, type: "keyword", section: sections.keywords });
    }
    return { from: word?.from ?? context.pos, options, validFor: /^(`[^`]*|[A-Za-z_][A-Za-z0-9_.-]*)$/ };
  };
}

/** The field decorations of a text: every one to draw, and the chips alone for `atomicRanges`. */
interface FieldDecorations {
  decorations: DecorationSet;
  atomic: DecorationSet;
}

interface ChipPluginValue extends PluginValue, FieldDecorations {
  update(update: ViewUpdate): void;
}

/** A decoration set's ranges as an array (`RangeSet.update` takes them that way). */
function rangesOf(set: DecorationSet): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  const cursor = set.iter();
  while (cursor.value !== null) {
    out.push(cursor.value.range(cursor.from, cursor.to));
    cursor.next();
  }
  return out;
}

/** The editor's state for a text, with the tokens the chips are drawn from. */
interface Analysis extends FormulaEditorState {
  tokens: FormulaToken[];
}

/**
 * Mounts a formula editor as the last child of `parent`, which must already be in the document
 * (CodeMirror finds the root to style from it).
 */
export function mountFormulaEditor(parent: HTMLElement, options: CodeMirrorFormulaEditorOptions): CodeMirrorFormulaEditor {
  const doc = parent.ownerDocument;
  const words: BuilderTextOptions = { locale: options.locale, catalog: options.catalog };
  const text = (key: Parameters<typeof builderText>[0], params?: Record<string, string | number>): string => builderText(key, params, words);
  const multiline = options.multiline === true;
  const mark = marks();
  const history = snapshotHistory(mark);
  const refresh = StateEffect.define<null>();
  let fields: readonly FormulaField[] = options.fields;
  let destroyed = false;

  const analyse = (source: string): Analysis => {
    const state = formulaEditorState(source, { fields, signatures: options.signatures, scopes: options.scopes, locale: options.locale, catalog: options.catalog });
    const tokens = scanFormula(source);
    const lints = lintFormula(source, tokens, state.parsed, words, options.condition, options.riskyPatterns);
    if (lints.length > 0) {
      state.problems.push(...lints);
      state.problems.sort((a, b) => a.start - b.start);
    }
    return { ...state, tokens };
  };

  const analysisField = StateField.define<Analysis>({
    create: (state) => analyse(state.doc.toString()),
    update: (value, tr) => (tr.docChanged || tr.effects.some((effect) => effect.is(refresh)) ? analyse(tr.newDoc.toString()) : value)
  });

  /**
   * The field decorations: a chip (a replace decoration) over each known field id, and a mark
   * in the danger wash over an unknown one. Only the chips are atomic (Backspace, Delete and
   * the arrows treat one as a single character); the mark over a typo stays ordinary text, so
   * it is fixed one letter at a time.
   */
  const fieldDecorationsOf = (state: EditorState): FieldDecorations => {
    const analysis = state.field(analysisField);
    const chips = new RangeSetBuilder<Decoration>();
    const marks = new RangeSetBuilder<Decoration>();
    for (const token of analysis.tokens) {
      if (token.kind !== "name") {
        continue;
      }
      const label = isKnownFormulaPath(token.value, fields) ? chipLabel(token.value, fields) : undefined;
      if (label !== undefined) {
        chips.add(token.from, token.to, Decoration.replace({ widget: new FieldChip(label, token.value), inclusive: false }));
      } else if (analysis.problems.some((problem) => problem.kind === "unknownField" && problem.start === token.from)) {
        marks.add(token.from, token.to, Decoration.mark({ class: "f-field ref-chip unknown", attributes: { title: token.value } }));
      }
    }
    const atomic = chips.finish();
    const unknown = marks.finish();
    return { atomic, decorations: unknown.size === 0 ? atomic : atomic.update({ add: rangesOf(unknown), sort: true }) };
  };

  const chipPlugin = ViewPlugin.define(
    (view): ChipPluginValue => ({
      ...fieldDecorationsOf(view.state),
      update(update: ViewUpdate): void {
        if (update.docChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refresh)))) {
          const next = fieldDecorationsOf(update.state);
          this.decorations = next.decorations;
          this.atomic = next.atomic;
        }
      }
    }),
    { decorations: (plugin) => plugin.decorations }
  );

  const diagnosticsOf = (state: EditorState): Diagnostic[] => {
    const length = state.doc.length;
    return state.field(analysisField).problems.map((problem) => {
      const from = clamp(problem.start, length);
      const to = Math.max(from, clamp(problem.end, length));
      const suggestion = problem.suggestion;
      return {
        from,
        to,
        severity: problem.kind === "parse" ? "error" : "warning",
        message: problem.message,
        ...(suggestion === undefined
          ? {}
          : {
              actions: [
                {
                  name: suggestion,
                  apply(target: EditorView, start: number, end: number): void {
                    target.dispatch({ changes: { from: start, to: end, insert: suggestion }, userEvent: "input" });
                  }
                }
              ]
            })
      } satisfies Diagnostic;
    });
  };

  // Problems reach the box's marks a microtask after the edit: the state already holds them
  // (the field above), and a dispatch inside an update is not allowed.
  let marking = false;
  const markProblems = (): void => {
    if (marking) {
      return;
    }
    marking = true;
    queueMicrotask(() => {
      marking = false;
      if (!destroyed) {
        view.dispatch(setDiagnostics(view.state, diagnosticsOf(view.state)));
      }
    });
  };

  const stateOf = (): FormulaEditorState => {
    const analysis = view.state.field(analysisField);
    return { parsed: analysis.parsed, problems: analysis.problems };
  };

  // The edit is handed over once CodeMirror's update is done, not from inside it; a burst
  // within one task is handed over once (the JSON viewer's rule).
  let handOver = false;
  const changed = (): void => {
    if (handOver) {
      return;
    }
    handOver = true;
    queueMicrotask(() => {
      handOver = false;
      if (!destroyed) {
        options.onChange(view.state.doc.toString(), stateOf());
      }
    });
  };

  let committed = options.text;
  const commit = (): void => {
    const current = view.state.doc.toString();
    if (current === committed) {
      return;
    }
    committed = current;
    options.onCommit(current, stateOf());
  };

  /** Backspace and Delete over the chips: an atomic range goes as one. */
  const deleteBy = (view: EditorView, forward: boolean): boolean => {
    const { state } = view;
    if (!state.selection.main.empty) {
      view.dispatch(state.replaceSelection(""), { scrollIntoView: true, userEvent: "delete.selection" });
      return true;
    }
    const changes = state.changeByRange((range) => {
      const target = view.moveByChar(range, forward).head;
      if (target === range.head) {
        return { range };
      }
      const from = Math.min(target, range.head);
      const to = Math.max(target, range.head);
      return { changes: { from, to }, range: EditorSelection.cursor(from) };
    });
    view.dispatch(changes, { scrollIntoView: true, userEvent: forward ? "delete.forward" : "delete.backward" });
    return true;
  };

  const moveBy = (view: EditorView, forward: boolean): boolean => {
    const { selection } = view.state;
    const ranges = selection.ranges.map((range) => (range.empty ? view.moveByChar(range, forward) : EditorSelection.cursor(forward ? range.to : range.from)));
    view.dispatch({ selection: EditorSelection.create(ranges, selection.mainIndex), scrollIntoView: true, userEvent: "select" });
    return true;
  };

  /*
   * Enter: on a single-line box, the commit. On a multiline box the next case: after `then`
   * or `else` a new indented line; after a condition line (`if …`, `else if …`) an indented
   * line for its `then`; after an indented line (a `then` or a value) the next case flush.
   */
  const enter = (view: EditorView): boolean => {
    if (!multiline) {
      commit();
      return true;
    }
    const { state } = view;
    const range = state.selection.main;
    const line = state.doc.lineAt(range.from);
    const before = state.sliceDoc(line.from, range.from);
    const base = /^\s*/.exec(before)?.[0] ?? "";
    const trimmed = before.trim();
    const lastWord = /([A-Za-z]+)\s*$/.exec(before)?.[1];
    let indent = base;
    if (lastWord === "then" || lastWord === "else") {
      indent = `${base}  `;
    } else if (/^(if|else\s+if)\b/.test(trimmed) && !/\bthen\b/.test(trimmed)) {
      indent = "  ";
    } else if (base !== "" || /^then\b/.test(trimmed)) {
      indent = "";
    }
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: `\n${indent}` },
      selection: { anchor: range.from + 1 + indent.length },
      scrollIntoView: true,
      userEvent: "input"
    });
    return true;
  };

  const env: FormulaCompletionEnv = {
    fieldsOf: () => fields,
    scopes: options.scopes ?? ALL_SCOPES,
    functions: options.functions,
    words
  };

  const root = doc.createElement("div");
  root.className = "formula-editor";
  parent.appendChild(root);

  const hasParseProblem = (state: EditorState): boolean => state.field(analysisField).problems.some((problem) => problem.kind === "parse");

  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        analysisField,
        chipPlugin,
        EditorView.atomicRanges.of((target) => target.plugin(chipPlugin)?.atomic ?? Decoration.none),
        EditorView.lineWrapping,
        feelLanguage(),
        baseLook(),
        placeholder(text("editor.placeholder")),
        autocompletion({
          override: [formulaCompletionSource(env)],
          icons: false,
          optionClass: (completion) => (completion.type === undefined ? "" : `f-opt-${completion.type}`)
        }),
        history.extension,
        keymap.of([
          { key: "Enter", run: enter },
          { key: "Tab", run: acceptCompletion },
          { key: "Backspace", run: (target) => deleteBy(target, false) },
          { key: "Delete", run: (target) => deleteBy(target, true) },
          { key: "ArrowLeft", run: (target) => moveBy(target, false) },
          { key: "ArrowRight", run: (target) => moveBy(target, true) }
        ]),
        EditorState.tabSize.of(2),
        EditorView.editorAttributes.of((target) => ({ class: hasParseProblem(target.state) ? "formula bad" : "formula" })),
        EditorView.contentAttributes.of({
          "aria-label": options.label,
          "aria-multiline": multiline ? "true" : "false",
          spellcheck: "false",
          autocorrect: "off",
          autocapitalize: "off"
        }),
        EditorView.contentAttributes.of((target) => (hasParseProblem(target.state) ? { "aria-invalid": "true" } : null)),
        EditorView.updateListener.of((update) => {
          const refreshed = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refresh)));
          if (update.docChanged || refreshed) {
            markProblems();
          }
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(mark) === "set")) {
            changed();
          }
          if (completionStatus(update.state) === "active") {
            queueMicrotask(addFooter);
          }
        }),
        EditorView.domEventHandlers({
          blur: () => {
            // After the focus has settled: a press on the helper row keeps the box's focus, and
            // a move into one of its menus is no leave.
            queueMicrotask(() => {
              if (destroyed) {
                return;
              }
              const active = (root.getRootNode() as Document | ShadowRoot).activeElement;
              if (active !== null && root.contains(active)) {
                return;
              }
              commit();
            });
            return false;
          }
        })
      ]
    })
  });
  markProblems();

  /** The suggestions popover's footer line, once the popover is in the DOM. */
  function addFooter(): void {
    if (destroyed) {
      return;
    }
    const tooltip = view.dom.querySelector(".cm-tooltip-autocomplete");
    if (tooltip === null || tooltip.querySelector(".f-suggest-footer") !== null) {
      return;
    }
    const footer = doc.createElement("div");
    footer.className = "f-suggest-footer";
    footer.textContent = text("editor.suggest.footer");
    tooltip.appendChild(footer);
  }

  /*
   * The helper row: + Field, ƒ Function, Helpers ▾ and the reference link, with one menu
   * element the three buttons fill. A mouse press on a helper keeps the box's focus, so
   * choosing an entry inserts at the caret the author had.
   */
  const help = doc.createElement("div");
  help.className = "f-help";
  const menu = doc.createElement("div");
  menu.className = "f-menu menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  let openButton: HTMLButtonElement | undefined;

  const onOutsidePress = (event: Event): void => {
    if (!(event.target instanceof Node) || !help.contains(event.target)) {
      closeMenu();
    }
  };
  const closeMenu = (): void => {
    if (openButton === undefined) {
      return;
    }
    openButton.setAttribute("aria-expanded", "false");
    openButton = undefined;
    menu.hidden = true;
    menu.className = "f-menu menu";
    menu.replaceChildren();
    root.getRootNode().removeEventListener("pointerdown", onOutsidePress, true);
  };

  /** A space before an insertion that would otherwise glue onto a name, a number, a quote or a closing bracket. */
  const padBefore = (): string => {
    const range = view.state.selection.main;
    const before = view.state.sliceDoc(Math.max(0, range.from - 1), range.from);
    return /[A-Za-z0-9_"'`)\]]/.test(before) ? " " : "";
  };

  const insertPlain = (insert: string): void => {
    const range = view.state.selection.main;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: range.from + insert.length },
      scrollIntoView: true,
      userEvent: "input"
    });
    view.focus();
  };

  const insertTemplate = (template: string): void => {
    const range = view.state.selection.main;
    snippet(`${padBefore()}${template}`)(view, null, range.from, range.to);
    view.focus();
  };

  const menuItem = (fill: (item: HTMLButtonElement) => void, choose: () => void): HTMLButtonElement => {
    const item = doc.createElement("button");
    item.type = "button";
    item.className = "f-mi menu-item";
    item.setAttribute("role", "menuitem");
    fill(item);
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => {
      closeMenu();
      choose();
    });
    return item;
  };
  const heading = (label: string): HTMLElement => {
    const head = doc.createElement("div");
    head.className = "f-mh";
    head.textContent = label;
    return head;
  };
  const sub = (label: string): HTMLElement => {
    const span = doc.createElement("span");
    span.className = "f-sub";
    span.textContent = label;
    return span;
  };

  const fillFieldMenu = (): void => {
    if (fields.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "f-menu-empty";
      empty.textContent = text("editor.placeholder");
      menu.appendChild(empty);
      return;
    }
    for (const field of fields) {
      menu.appendChild(
        menuItem(
          (item) => {
            const chip = doc.createElement("span");
            chip.className = "f-field ref-chip";
            chip.textContent = field.label;
            item.append(chip, sub(field.path));
          },
          () => insertPlain(`${padBefore()}${feelName(field.path)}`)
        )
      );
    }
  };

  const fillFunctionMenu = (): void => {
    let lastGroup: string | undefined;
    for (const row of options.functions) {
      if (row.groupKey !== lastGroup) {
        menu.appendChild(heading(text(row.groupKey)));
        lastGroup = row.groupKey;
      }
      menu.appendChild(
        menuItem(
          (item) => {
            const name = doc.createElement("span");
            name.className = "f-fn";
            name.textContent = row.name;
            const args = doc.createElement("span");
            args.className = "f-args";
            args.textContent = paramsText(row);
            item.append(name, args);
            item.title = row.summary;
          },
          () => insertTemplate(row.snippet)
        )
      );
    }
  };

  const fillHelpersMenu = (): void => {
    menu.classList.add("f-menu-wide");
    let lastGroup: string | undefined;
    for (const entry of options.snippets ?? []) {
      if (entry.group !== lastGroup) {
        const group = FORMULA_SNIPPET_GROUPS.find((candidate) => candidate.id === entry.group);
        menu.appendChild(heading(group === undefined ? entry.group : text(group.labelKey)));
        lastGroup = entry.group;
      }
      menu.appendChild(
        menuItem(
          (item) => {
            const label = doc.createElement("span");
            label.textContent = snippetLabel(entry, words);
            item.append(label, sub(entry.preview));
          },
          () => insertTemplate(entry.insert)
        )
      );
    }
  };

  const helper = (fill: (button: HTMLButtonElement) => void, action: string, open: () => void): HTMLButtonElement => {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "help";
    button.setAttribute("data-action", action);
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    fill(button);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      if (openButton === button) {
        closeMenu();
        return;
      }
      closeMenu();
      openButton = button;
      button.setAttribute("aria-expanded", "true");
      open();
      menu.hidden = false;
      root.getRootNode().addEventListener("pointerdown", onOutsidePress, true);
    });
    return button;
  };

  const glyph = (symbol: string): HTMLElement => {
    const span = doc.createElement("span");
    span.className = "f-glyph";
    span.textContent = symbol;
    span.setAttribute("aria-hidden", "true");
    return span;
  };
  const chevron = (): SVGElement => {
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M6 9l6 6 6-6");
    svg.appendChild(path);
    return svg;
  };

  help.appendChild(helper((button) => button.append(glyph("+"), text("editor.field")), "field", fillFieldMenu));
  help.appendChild(helper((button) => button.append(glyph("ƒ"), text("editor.function")), "function", fillFunctionMenu));
  if (options.snippets !== undefined && options.snippets.length > 0) {
    help.appendChild(helper((button) => button.append(text("editor.helpers"), chevron()), "helpers", fillHelpersMenu));
  }
  // The link and the spacer that pushes it to the end of the row are drawn only for a host that
  // names a page: a default address would be a dead link in any application that embeds the builder.
  if (options.referenceHref !== undefined) {
    const spacer = doc.createElement("span");
    spacer.className = "f-spacer";
    help.appendChild(spacer);
    const reference = doc.createElement("a");
    reference.className = "f-reference";
    reference.href = options.referenceHref;
    reference.target = "_blank";
    reference.rel = "noreferrer";
    reference.textContent = text("editor.reference");
    help.appendChild(reference);
  }
  help.appendChild(menu);
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      const button = openButton;
      closeMenu();
      button?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const items = [...menu.querySelectorAll<HTMLButtonElement>(".f-mi")];
      const active = (root.getRootNode() as Document | ShadowRoot).activeElement;
      const at = items.findIndex((item) => item === active);
      const next = items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % Math.max(1, items.length)];
      if (next !== undefined) {
        event.preventDefault();
        next.focus();
      }
    }
  });
  root.appendChild(help);

  return {
    dom: root,
    contentDom: view.contentDOM,
    get hasFocus(): boolean {
      return view.hasFocus;
    },
    getText: () => view.state.doc.toString(),
    setText(next: string): void {
      committed = next;
      const current = view.state.doc;
      if (current.toString() === next) {
        return;
      }
      view.dispatch({ changes: { from: 0, to: current.length, insert: next }, selection: { anchor: next.length }, annotations: mark.of("set") });
      history.reset();
    },
    focus(offset?: number): void {
      if (offset !== undefined) {
        const at = clamp(offset, view.state.doc.length);
        view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      }
      view.focus();
    },
    getState: stateOf,
    setFields(next: FormulaField[]): void {
      fields = next;
      view.dispatch({ effects: refresh.of(null) });
    },
    insertSnippet(entry: FormulaSnippet): void {
      insertTemplate(entry.insert);
    },
    insertText(insert: string): void {
      insertPlain(insert);
    },
    destroy(): void {
      destroyed = true;
      closeMenu();
      view.destroy();
      root.remove();
    }
  };
}
