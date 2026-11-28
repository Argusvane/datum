/**
 * The test editor: the box an author writes and reads one test in, on
 * CodeMirror, in a lazy chunk of its own (`tests-editor-loader.ts`) so the Tests panel's chunk
 * never carries it. The panel mounts the plain textarea (`tests-textarea.ts`, the same
 * interface) first and swaps this in when the chunk lands, keeping the text and the caret's
 * line, or keeps the textarea when the chunk fails.
 *
 * What it adds over the textarea:
 *
 * - the language's words coloured (`.t-kw`, `.t-path`, `.t-str`, `.t-num`, `.t-cm`, `.t-code`),
 *   by a `StreamLanguage` that reads a line the way the parser does: keywords are English in
 *   every locale and case-insensitive, a name after `set`, `on`, `of`, `to`, `for` is a path
 *   even when it spells a keyword, `#` starts a comment, `@"2026-01-31"` is a date;
 * - suggestions (`@codemirror/autocomplete`) by position: statements at a line's start, then the
 *   fields, pages, journeys, layouts, error codes and values the line asks for, from
 *   `tests-completions.ts` (the grammar is there, this file only draws it);
 * - a gutter with the line number and, per `setMarks` entry, a mark carrying the step's status
 *   and its message, and a class on the line itself (`.t-line-failed`), so a failed line reads
 *   as one in the code and not only in the list;
 * - the parser's problems drawn in the text by `@codemirror/lint`'s diagnostics.
 *
 * Offsets in `setProblems` are the parser's, into the text as the panel holds it. CodeMirror
 * normalises line breaks to a line feed, so a source with carriage returns would be off by one
 * per line; the panel writes line feeds (the textarea and this box both do), which is the case
 * that matters.
 *
 * Built on first mount, not at import, like the formula editor: the language, the highlight style
 * and the effects are created the first time an editor mounts, so the module's import has no
 * side effect a bundler keeps.
 */
import { acceptCompletion, autocompletion, completionStatus, snippet, startCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSection, type CompletionSource } from "@codemirror/autocomplete";
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { Annotation, type AnnotationType, EditorSelection, EditorState, type Extension, RangeSetBuilder, StateEffect, type StateEffectType, StateField, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, type ViewUpdate, gutter, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";

import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { builderText } from "./tests-editor-texts-en.js";
import type { TESTS_EDITOR_EN } from "./tests-editor-texts-en.js";
import { TESTS_STATE_WORDS, liftCompletions, testsSlotAt, type TestsCompletionLists, type TestsSlot, type TestsSlotWord } from "./tests-completions.js";
import type { MountTestsEditor, TestsCompletions, TestsEditorMark, TestsEditorProblem } from "./tests-model.js";
import { MARK_KEYS, SHOWN_CLASS, TESTS_LINE_PX, lineEndOffset, lineStartOffset, statementInsertion, type TestsInsertLineOptions } from "./tests-textarea.js";

type EditorTextKey = keyof typeof TESTS_EDITOR_EN;

/** What a suggestion inserts: a string, or a function that edits the document itself. */
type CompletionApply = NonNullable<Completion["apply"]>;

// --- the language ----------------------------------------------------------------------------

/** The words the language reads as keywords; matched whatever their case. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "test", "skip", "given", "today", "locale", "journey", "options", "for", "set", "clear", "add", "row", "to", "with", "remove", "of",
  "continue", "back", "go", "change", "check", "submit", "expect", "error", "on", "off", "no", "errors", "message", "accepted", "refused", "page",
  "path", "ends", "at", "submitted", "withheld", "rows", "layout", "visible", "hidden", "required", "optional", "enabled", "disabled",
  "readonly", "editable", "empty", "not"
]);

/** Words that stay keywords on an `expect` line that reads a formula (`expect total > 5 and x in (1, 2)`). */
const FORMULA_WORDS: ReadonlySet<string> = new Set(["and", "or", "in", "between", "if", "then", "else"]);

/** After these a name follows (so a field called `page` is still drawn as a field). */
const PATH_AFTER: ReadonlySet<string> = new Set(["set", "clear", "change", "of", "to", "for", "submitted", "at"]);

const LITERALS: ReadonlySet<string> = new Set(["true", "false", "null"]);

interface LineState {
  /** Words read so far on this line. */
  n: number;
  /** The line's first and second words, lower-cased. */
  w0: string;
  w1: string;
  /** The previous word, lower-cased. */
  prev: string;
  /** The next word is a path, a page or an id, whatever it spells. */
  expectPath: boolean;
  /** The next word is an error code (after the `:` of `expect error on x:`). */
  expectCode: boolean;
  /** Inside the page list of `expect path = (a, b)`. */
  pageList: boolean;
}

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

function startOfLine(state: LineState): void {
  state.n = 0;
  state.w0 = "";
  state.w1 = "";
  state.prev = "";
  state.expectPath = false;
  state.expectCode = false;
  state.pageList = false;
}

/** The test language's tokens for the highlighter; a line is read on its own. */
function testStreamParser(): StreamParser<LineState> {
  return {
    name: "datum-test",
    startState: () => ({ n: 0, w0: "", w1: "", prev: "", expectPath: false, expectCode: false, pageList: false }),
    token(stream, state) {
      if (stream.sol()) {
        startOfLine(state);
      }
      if (stream.eatSpace()) {
        return null;
      }
      const ch = stream.peek() ?? "";
      if (ch === "#") {
        stream.skipToEnd();
        return "comment";
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        skipString(stream, ch);
        state.expectPath = false;
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
      if (stream.match(/^!=|^<=|^>=|^==|^\.\./)) {
        return "operator";
      }
      if (/^[-]\d/.test(stream.string.slice(stream.pos, stream.pos + 2)) && stream.match(/^-(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/)) {
        return "number";
      }
      const found = stream.match(/^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\[\d+\])?(?:\.[A-Za-z0-9_-]+(?:\[\d+\])?)*/);
      if (found !== null && found !== false) {
        const text = typeof found === "boolean" ? "" : (found[0] ?? "");
        const lc = text.toLowerCase();
        const called = Boolean(stream.match(/^\(/, false));
        let result: string;
        if (state.expectCode) {
          state.expectCode = false;
          result = "code";
        } else if (/^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
          result = "number";
        } else if (LITERALS.has(lc)) {
          result = "atom";
        } else if (state.expectPath || (state.pageList && state.prev !== "")) {
          result = "variableName";
        } else if (called && state.w0 === "expect" && !KEYWORDS.has(lc)) {
          result = "fn";
        } else if (KEYWORDS.has(lc) || (state.w0 === "expect" && state.n > 0 && FORMULA_WORDS.has(lc))) {
          result = "keyword";
        } else {
          result = "variableName";
        }
        if (state.n === 0) {
          state.w0 = lc;
        } else if (state.n === 1) {
          state.w1 = lc;
        }
        state.n += 1;
        const keyword = result === "keyword";
        state.expectPath =
          keyword &&
          (PATH_AFTER.has(lc) || ((lc === "on" || lc === "off") && (state.prev === "error" || state.prev === "message")));
        state.prev = lc;
        return result;
      }
      stream.next();
      state.expectPath = false;
      if (ch === ":") {
        state.expectCode = state.w0 === "expect" && state.w1 === "error";
        return "operator";
      }
      if (ch === "=") {
        // A page, a layout or a journey is named after its `=`; so is every page of a path list.
        state.expectPath = state.prev === "page" || state.prev === "layout" || state.prev === "journey";
        return "operator";
      }
      if (ch === "(") {
        if (state.w0 === "expect" && state.w1 === "path") {
          state.pageList = true;
          state.expectPath = true;
        }
        return "operator";
      }
      if (ch === ",") {
        state.expectPath = state.pageList;
        return "operator";
      }
      if (ch === ")") {
        state.pageList = false;
        return "operator";
      }
      if ("<>+*/[]-".includes(ch)) {
        return "operator";
      }
      return "invalid";
    },
    blankLine(state) {
      startOfLine(state);
    },
    tokenTable: { fn: tags.function(tags.variableName), code: tags.labelName }
  };
}

// --- what is built once --------------------------------------------------------------------------

interface MarkState {
  marks: Map<number, TestsEditorMark>;
  problems: Map<number, "error" | "warning">;
  decorations: DecorationSet;
}

interface Pieces {
  language: Extension;
  look: Extension;
  edit: AnnotationType<"undo" | "set">;
  setMarks: StateEffectType<readonly TestsEditorMark[]>;
  setProblemLines: StateEffectType<ReadonlyMap<number, "error" | "warning">>;
  markField: StateField<MarkState>;
}

let built: Pieces | undefined;

function decorationsOf(doc: Text, marks: ReadonlyMap<number, TestsEditorMark>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const lines = [...marks.keys()].filter((line) => line >= 1 && line <= doc.lines).sort((a, b) => a - b);
  for (const number of lines) {
    const mark = marks.get(number) as TestsEditorMark;
    // The step Show me has on the canvas is drawn whatever its status.
    const shown = mark.shown === true ? ` ${SHOWN_CLASS}` : "";
    if (mark.status === "pending" && shown === "") {
      continue;
    }
    const line = doc.line(number);
    builder.add(line.from, line.from, Decoration.line({ class: `${mark.status === "pending" ? "" : `t-line-${mark.status}`}${shown}`.trim() }));
  }
  return builder.finish();
}

function pieces(): Pieces {
  if (built !== undefined) {
    return built;
  }
  const setMarks = StateEffect.define<readonly TestsEditorMark[]>();
  const setProblemLines = StateEffect.define<ReadonlyMap<number, "error" | "warning">>();
  const markField = StateField.define<MarkState>({
    create: (state) => ({ marks: new Map(), problems: new Map(), decorations: decorationsOf(state.doc, new Map()) }),
    update(value, tr) {
      let marks = value.marks;
      let problems = value.problems;
      let changed = tr.docChanged;
      for (const effect of tr.effects) {
        if (effect.is(setMarks)) {
          marks = new Map(effect.value.map((mark) => [mark.line, mark]));
          changed = true;
        } else if (effect.is(setProblemLines)) {
          problems = new Map(effect.value);
        }
      }
      return { marks, problems, decorations: changed ? decorationsOf(tr.newDoc, marks) : value.decorations };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
  });
  built = {
    language: [
      StreamLanguage.define(testStreamParser()),
      syntaxHighlighting(
        HighlightStyle.define([
          { tag: tags.keyword, class: "t-kw" },
          { tag: [tags.number, tags.atom], class: "t-num" },
          { tag: tags.string, class: "t-str" },
          { tag: tags.operator, class: "t-op" },
          { tag: tags.comment, class: "t-cm" },
          { tag: tags.function(tags.variableName), class: "t-fn" },
          { tag: tags.variableName, class: "t-path" },
          { tag: tags.labelName, class: "t-code" },
          { tag: tags.invalid, class: "t-bad" }
        ])
      )
    ],
    // The little the editor needs before the host's sheet: the code face and its line height.
    look: EditorView.theme({
      "&": { backgroundColor: "var(--db-surface)", color: "var(--db-ink)", fontSize: "var(--db-text-md, 13px)" },
      ".cm-scroller": { fontFamily: "var(--db-font-mono, ui-monospace, Menlo, monospace)", lineHeight: `${String(TESTS_LINE_PX)}px` },
      // CodeMirror's own light theme (a black caret, a pale gutter and tooltip) is an adopted sheet the shadow root applies after the host's <style>, so the colours that must follow the builder's scheme live here, in a theme that loads after it.
      ".cm-content": { caretColor: "var(--db-ink)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--db-ink)" },
      ".cm-gutters": { backgroundColor: "var(--db-surface-sunken)", color: "var(--db-ink-subtle)", border: "0" },
      ".cm-tooltip": {
        backgroundColor: "var(--db-surface)",
        color: "var(--db-ink)",
        border: "var(--db-border-w, 1px) solid var(--db-line-card, var(--db-line-input))"
      }
    }),
    edit: Annotation.define<"undo" | "set">(),
    setMarks,
    setProblemLines,
    markField
  };
  return built;
}

/** A gutter cell: the line's number, with the step's status and the worst problem on the line. */
class LineMarker extends GutterMarker {
  constructor(
    readonly line: number,
    readonly status: TestsEditorMark["status"] | undefined,
    readonly title: string,
    readonly problem: "error" | "warning" | undefined,
    /** Whether Show me is on this line: a look only, since the gutter is hidden from assistive technology (the panel's live region names the line). */
    readonly shown = false
  ) {
    super();
  }

  override eq(other: LineMarker): boolean {
    return other.line === this.line && other.status === this.status && other.title === this.title && other.problem === this.problem && other.shown === this.shown;
  }

  override toDOM(view: EditorView): HTMLElement {
    const cell = view.dom.ownerDocument.createElement("div");
    cell.className = "tests-cell";
    cell.setAttribute("data-line", String(this.line));
    if (this.status !== undefined) {
      cell.setAttribute("data-status", this.status);
      cell.title = this.title;
    }
    if (this.problem !== undefined) {
      cell.setAttribute("data-problem", this.problem);
    }
    if (this.shown) {
      cell.classList.add(SHOWN_CLASS);
    }
    const number = view.dom.ownerDocument.createElement("span");
    number.className = "tests-ln";
    number.textContent = String(this.line);
    cell.appendChild(number);
    return cell;
  }
}

// --- the suggestions ---------------------------------------------------------------------------

/** What the suggestion source needs besides the text: the form's lists and the builder's words. */
export interface TestsCompletionEnv {
  lists(): TestsCompletionLists;
  words: BuilderTextOptions | undefined;
}

const STATEMENT_TEXT: Readonly<Record<string, EditorTextKey>> = {
  "stmt.test": "tests.complete.stmt.test",
  "stmt.skip": "tests.complete.stmt.skip",
  "stmt.given": "tests.complete.stmt.given",
  "stmt.set": "tests.complete.stmt.set",
  "stmt.clear": "tests.complete.stmt.clear",
  "stmt.addRow": "tests.complete.stmt.addRow",
  "stmt.removeRow": "tests.complete.stmt.removeRow",
  "stmt.continue": "tests.complete.stmt.continue",
  "stmt.back": "tests.complete.stmt.back",
  "stmt.goTo": "tests.complete.stmt.goTo",
  "stmt.change": "tests.complete.stmt.change",
  "stmt.check": "tests.complete.stmt.check",
  "stmt.submit": "tests.complete.stmt.submit",
  "stmt.expect": "tests.complete.stmt.expect",
  "expect.errorOn": "tests.complete.expect.errorOn",
  "expect.noErrorOn": "tests.complete.expect.noErrorOn",
  "expect.noErrors": "tests.complete.expect.noErrors",
  "expect.messageOn": "tests.complete.expect.messageOn",
  "expect.accepted": "tests.complete.expect.accepted",
  "expect.refused": "tests.complete.expect.refused",
  "expect.page": "tests.complete.expect.page",
  "expect.path": "tests.complete.expect.path",
  "expect.submitted": "tests.complete.expect.submitted",
  "expect.rowsOf": "tests.complete.expect.rowsOf",
  "expect.layout": "tests.complete.expect.layout",
  "expect.onPath": "tests.complete.expect.onPath",
  "expect.offPath": "tests.complete.expect.offPath",
  "expect.withheld": "tests.complete.expect.withheld",
  "expect.equals": "tests.complete.expect.equals",
  "expect.differs": "tests.complete.expect.differs",
  "expect.pathEnds": "tests.complete.expect.pathEnds",
  "expect.pathEndsAt": "tests.complete.expect.pathEndsAt",
  "given.today": "tests.complete.given.today",
  "given.locale": "tests.complete.given.locale",
  "given.journey": "tests.complete.given.journey",
  "given.host": "tests.complete.given.host",
  "given.options": "tests.complete.given.options",
  "given.none": "tests.complete.given.none"
};

/** A word's inserted text: the word, and the space the statement needs after it unless it ends there. */
function wordInsertion(entry: TestsSlotWord): string {
  if (entry.final === true || entry.text === "(" || entry.text === ")" || entry.text === "host.") {
    return entry.text;
  }
  return `${entry.text} `;
}

/** `value` as the text inside a string that `close` opened: the escapes the parser resolves, one line. */
function stringBody(value: string, close: string): string {
  let out = "";
  for (const ch of value) {
    out += ch === "\\" || ch === close ? `\\${ch}` : ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : ch;
  }
  return out;
}

/** Inserts `text` over the range and asks for the next list, so a statement can be built by choosing. */
function insertThenSuggest(text: string, chain: boolean): CompletionApply {
  return (view, _completion, from, to) => {
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.complete" });
    if (chain) {
      startCompletion(view);
    }
  };
}

/**
 * The suggestions for the line before the caret: whatever {@link testsSlotAt} says may stand
 * there, as the popover's options (a field shows its label and inserts its path), in sections
 * named from the catalog. Exported so the list can be checked without the popover.
 */
export function testsCompletionSource(env: TestsCompletionEnv): CompletionSource {
  const text = (key: EditorTextKey, params?: Record<string, string | number>): string => builderText(key, params, env.words);
  const sections = {
    statements: { name: text("tests.complete.section.statements"), rank: 0 } satisfies CompletionSection,
    fields: { name: text("tests.complete.section.fields"), rank: 1 } satisfies CompletionSection,
    collections: { name: text("tests.complete.section.collections"), rank: 1 } satisfies CompletionSection,
    rowKeys: { name: text("tests.complete.section.rowKeys"), rank: 1 } satisfies CompletionSection,
    values: { name: text("tests.complete.section.values"), rank: 0 } satisfies CompletionSection,
    states: { name: text("tests.complete.section.states"), rank: 0 } satisfies CompletionSection,
    codes: { name: text("tests.complete.section.codes"), rank: 0 } satisfies CompletionSection,
    pages: { name: text("tests.complete.section.pages"), rank: 1 } satisfies CompletionSection,
    journeys: { name: text("tests.complete.section.journeys"), rank: 1 } satisfies CompletionSection,
    layouts: { name: text("tests.complete.section.layouts"), rank: 1 } satisfies CompletionSection,
    words: { name: text("tests.complete.section.words"), rank: 0 } satisfies CompletionSection,
    givens: { name: text("tests.complete.section.givens"), rank: 0 } satisfies CompletionSection
  };

  const wordOption = (entry: TestsSlotWord, section: CompletionSection, type: string, boost = 0): Completion => {
    const key = STATEMENT_TEXT[entry.id];
    return {
      label: entry.text,
      ...(key !== undefined ? { detail: text(key) } : {}),
      apply: insertThenSuggest(wordInsertion(entry), entry.final !== true && entry.text !== ")"),
      type,
      boost,
      section
    };
  };

  const valueOptions = (slot: TestsSlot, lists: TestsCompletionLists): Completion[] => {
    const kind = slot.given === "today" ? "date" : slot.given === "locale" ? "text" : slot.given === "options" ? "list" : slot.field === undefined ? "other" : (lists.kindOf(slot.field) ?? "other");
    const choices = slot.field === undefined ? [] : lists.optionsOf(slot.field);
    const section = sections.values;
    const out: Completion[] = [];
    const literal = (label: string, detail: EditorTextKey, apply: CompletionApply = label, boost = 0): void => {
      out.push({ label, detail: text(detail), apply, type: "value", boost, section });
    };
    // Inside an open string only an option of the field makes sense; the closing quote is added
    // unless it is there. The option is escaped for that quote, so a quote or a backslash in it
    // does not end the string early.
    if (slot.quote !== undefined) {
      for (const option of choices) {
        const close = slot.quote.endsWith('"') ? '"' : "'";
        const body = stringBody(option.value, close);
        out.push({
          label: option.value,
          detail: option.label === option.value ? text("tests.complete.value.option") : option.label,
          apply: (view, _completion, from, to) => {
            const after = view.state.sliceDoc(to, to + 1);
            const insert = after === close ? body : body + close;
            view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + body.length + 1 }, userEvent: "input.complete" });
          },
          type: "value",
          section
        });
      }
      return out;
    }
    const quoted = (value: string): string => JSON.stringify(value);
    const optionLiterals = (wrap: boolean): void => {
      for (const option of choices) {
        out.push({
          label: wrap ? `(${quoted(option.value)})` : quoted(option.value),
          displayLabel: wrap ? `(${quoted(option.value)})` : quoted(option.value),
          detail: option.label,
          apply: wrap ? `(${quoted(option.value)})` : quoted(option.value),
          type: "value",
          boost: 2,
          section
        });
      }
    };
    switch (kind) {
      case "boolean":
        literal("true", "tests.complete.value.true", "true", 2);
        literal("false", "tests.complete.value.false", "false", 1);
        break;
      case "number":
        literal("0", "tests.complete.value.number");
        literal("null", "tests.complete.value.null");
        break;
      case "date":
        literal('@""', "tests.complete.value.date", snippet('@"${}"'), 2);
        literal("null", "tests.complete.value.null");
        break;
      case "choice":
        optionLiterals(false);
        literal('""', "tests.complete.value.text", snippet('"${}"'));
        break;
      case "flags":
      case "list":
        if (slot.list === true) {
          optionLiterals(false);
          literal('""', "tests.complete.value.text", snippet('"${}"'));
        } else {
          optionLiterals(true);
          if (slot.given === "options" && choices.length > 0) {
            out.push({
              label: `(${choices.map((option) => quoted(option.value)).join(", ")})`,
              detail: text("tests.complete.value.options"),
              apply: `(${choices.map((option) => quoted(option.value)).join(", ")})`,
              type: "value",
              boost: 3,
              section
            });
          }
          literal('("")', "tests.complete.value.list", snippet('("${}")'));
        }
        break;
      case "text":
        literal('""', "tests.complete.value.text", snippet('"${}"'), 2);
        literal("null", "tests.complete.value.null");
        break;
      default:
        literal('""', "tests.complete.value.text", snippet('"${}"'), 1);
        literal("true", "tests.complete.value.true");
        literal("false", "tests.complete.value.false");
        literal("null", "tests.complete.value.null");
    }
    return out;
  };

  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(line.from, context.pos);
    const slot = testsSlotAt(before);
    if (slot.wants.length === 0 && slot.words.length === 0) {
      return null;
    }
    // A bare line start is where indentation is typed: the statements wait for a letter or Ctrl-Space.
    if (!context.explicit && slot.partial === "" && slot.wants.includes("statement")) {
      return null;
    }
    const lists = env.lists();
    const options: Completion[] = [];
    const pages = slot.wants.includes("page") || slot.wants.includes("state") ? lists.pages() : [];
    for (const want of slot.wants) {
      switch (want) {
        case "statement":
          for (const entry of slot.words) {
            options.push(wordOption(entry, sections.statements, "statement"));
          }
          break;
        case "given":
          for (const entry of slot.words) {
            options.push(wordOption(entry, sections.givens, "statement"));
          }
          break;
        case "field":
        case "collection": {
          const collectionsOnly = want === "collection";
          for (const field of lists.fields()) {
            if (collectionsOnly && !lists.isCollection(field.path)) {
              continue;
            }
            options.push({
              label: field.label === field.path ? field.path : `${field.label} ${field.path}`,
              displayLabel: field.label,
              detail: field.path,
              ...(field.collection !== undefined ? { info: text("tests.complete.rowField", { collection: field.collection }) } : {}),
              apply: field.path,
              type: "field",
              boost: 1,
              section: collectionsOnly ? sections.collections : sections.fields
            });
          }
          break;
        }
        case "rowKey": {
          const prefix = `${slot.collection ?? ""}[0].`;
          for (const field of lists.fields()) {
            if (field.collection !== slot.collection || !field.path.startsWith(prefix)) {
              continue;
            }
            const key = field.path.slice(prefix.length);
            options.push({
              label: field.label === key ? key : `${field.label} ${key}`,
              displayLabel: field.label,
              detail: key,
              apply: key,
              type: "field",
              boost: 1,
              section: sections.rowKeys
            });
          }
          break;
        }
        case "page": {
          const leading = slot.subject === "" && slot.words.length > 0;
          for (const page of lists.pages()) {
            options.push({
              label: page.label === page.id ? page.id : `${page.label} ${page.id}`,
              displayLabel: page.label,
              detail: leading ? "on path" : page.id,
              info: text("tests.complete.pageOf", { journey: page.journey }),
              apply: leading ? insertThenSuggest(`${page.id} on path`, false) : page.id,
              type: "field",
              section: sections.pages
            });
          }
          break;
        }
        case "journey":
          for (const journey of lists.journeys()) {
            options.push({
              label: journey.label === journey.id ? journey.id : `${journey.label} ${journey.id}`,
              displayLabel: journey.label,
              detail: journey.id,
              apply: journey.id,
              type: "field",
              section: sections.journeys
            });
          }
          break;
        case "layout":
          for (const layout of lists.layouts()) {
            options.push({
              label: layout.label === layout.id ? layout.id : `${layout.label} ${layout.id}`,
              displayLabel: layout.label,
              detail: layout.id,
              apply: layout.id,
              type: "field",
              section: sections.layouts
            });
          }
          break;
        case "code":
          for (const code of lists.codes()) {
            options.push({ label: code.code, ...(code.label !== undefined ? { detail: code.label } : {}), apply: code.code, type: "value", section: sections.codes });
          }
          break;
        case "state": {
          for (const state of TESTS_STATE_WORDS) {
            options.push({ label: state, apply: insertThenSuggest(state, false), type: "word", boost: 1, section: sections.states });
          }
          break;
        }
        case "value":
          options.push(...valueOptions(slot, lists));
          break;
      }
    }
    if (slot.wants.every((want) => want !== "statement" && want !== "given")) {
      const subjectIsPage = slot.subject !== undefined && pages.some((page) => page.id === slot.subject);
      for (const entry of slot.words) {
        if (entry.after === "page" && !subjectIsPage) {
          continue;
        }
        if (entry.after === "field" && subjectIsPage) {
          continue;
        }
        options.push(wordOption(entry, sections.words, "word"));
      }
    }
    if (options.length === 0) {
      return null;
    }
    return { from: context.pos - slot.partial.length, options, validFor: /^[^\s=!,():"'#]*$/ };
  };
}

// --- the history -------------------------------------------------------------------------------

interface Snapshot {
  doc: Text;
  selection: EditorSelection;
}

/**
 * Undo and redo without the commands package (the formula editor's reasoning): the text before
 * each burst of edits of one kind less than half a second apart. The host's `setText` starts
 * the history over.
 */
function snapshotHistory(mark: AnnotationType<"undo" | "set">): { extension: Extension; reset(): void } {
  const undone: Snapshot[] = [];
  const redone: Snapshot[] = [];
  let last = { kind: "", time: 0 };
  const kindOf = (update: ViewUpdate): string => {
    for (const kind of ["input.type", "delete", "input.paste", "input.drop", "input.complete", "input"]) {
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
        if (kind !== last.kind || kind === "input.paste" || kind === "input.complete" || kind === "other" || now - last.time > 500) {
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

// --- the editor ----------------------------------------------------------------------------------

/**
 * Mounts the CodeMirror test editor as the last child of `parent`, which must already be in the
 * document (CodeMirror finds the root to style from it).
 */
export const mountTestsEditor: MountTestsEditor = (parent, options) => {
  const doc = parent.ownerDocument;
  const words = options.words;
  const text = (key: EditorTextKey, params?: Record<string, string | number>): string => builderText(key, params, words);
  const { language, look, edit, setMarks, setProblemLines, markField } = pieces();
  const history = snapshotHistory(edit);
  const completions: TestsCompletions = options.completions;
  let destroyed = false;
  let problems: readonly TestsEditorProblem[] = [];

  const env: TestsCompletionEnv = { lists: () => liftCompletions(completions), words };

  const root = doc.createElement("div");
  root.className = "tests-cm";
  root.setAttribute("data-tests-editor", "codemirror");
  root.style.setProperty("--tests-line-h", `${String(TESTS_LINE_PX)}px`);
  parent.appendChild(root);

  // The edit is handed over once CodeMirror's update is done, not from inside it; a burst
  // within one task is handed over once (the formula editor's rule).
  let handOver = false;
  const changed = (): void => {
    if (handOver) {
      return;
    }
    handOver = true;
    queueMicrotask(() => {
      handOver = false;
      if (!destroyed) {
        options.onChange(view.state.doc.toString());
      }
    });
  };

  /** The suggestions popover's footer line, once the popover is in the DOM. */
  const addFooter = (): void => {
    if (destroyed) {
      return;
    }
    const tooltip = view.dom.querySelector(".cm-tooltip-autocomplete");
    if (tooltip === null || tooltip.querySelector(".t-suggest-footer") !== null) {
      return;
    }
    const footer = doc.createElement("div");
    footer.className = "t-suggest-footer";
    footer.textContent = text("tests.complete.footer");
    tooltip.appendChild(footer);
  };

  /** Enter: a new line indented like this one, and two spaces under the `test` header. */
  const enter = (target: EditorView): boolean => {
    const range = target.state.selection.main;
    const line = target.state.doc.lineAt(range.from);
    const before = target.state.sliceDoc(line.from, range.from);
    let indent = /^[ \t]*/.exec(before)?.[0] ?? "";
    if (indent === "" && /^test\b/i.test(before.trim())) {
      indent = "  ";
    }
    target.dispatch({
      changes: { from: range.from, to: range.to, insert: `\n${indent}` },
      selection: { anchor: range.from + 1 + indent.length },
      scrollIntoView: true,
      userEvent: "input"
    });
    return true;
  };

  const submit = (): boolean => {
    if (options.onSubmit === undefined) {
      return false;
    }
    options.onSubmit();
    return true;
  };

  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        markField,
        language,
        look,
        // A recorded line is longer than a 240 px drawer: it wraps under itself instead of scrolling the box sideways
        // to the caret. The gutter's mark stays on the line's first row; the box fallback keeps one row a line.
        EditorView.lineWrapping,
        gutter({
          class: "tests-gutter",
          lineMarker(target, line) {
            const number = target.state.doc.lineAt(line.from).number;
            const state = target.state.field(markField);
            const mark = state.marks.get(number);
            const title = mark === undefined ? "" : mark.message !== undefined && mark.message !== "" ? mark.message : text(MARK_KEYS[mark.status]);
            return new LineMarker(number, mark?.status, title, state.problems.get(number), mark?.shown === true);
          },
          lineMarkerChange: (update) => update.docChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setMarks) || effect.is(setProblemLines))),
          initialSpacer: () => new LineMarker(999, undefined, "", undefined)
        }),
        autocompletion({
          override: [testsCompletionSource(env)],
          icons: false,
          optionClass: (completion) => (completion.type === undefined ? "" : `t-opt-${completion.type}`)
        }),
        history.extension,
        keymap.of([
          // Both modifiers, whatever the platform: the textarea answers to either, and "Mod" would hear only one.
          { key: "Ctrl-Enter", run: submit, preventDefault: true },
          { key: "Meta-Enter", run: submit, preventDefault: true },
          { key: "Enter", run: enter },
          { key: "Tab", run: acceptCompletion }
        ]),
        EditorState.tabSize.of(2),
        EditorView.contentAttributes.of({
          "aria-label": options.ariaLabel,
          "aria-multiline": "true",
          spellcheck: "false",
          autocorrect: "off",
          autocapitalize: "off",
          // The editable content is a tab stop already; said outright so a checker sees the scroller has focusable content
          // (axe's scrollable-region-focusable). No second stop: it is the same element.
          tabindex: "0"
        }),
        EditorView.contentAttributes.of(() => (problems.some((problem) => problem.severity === "error") ? { "aria-invalid": "true" } : null)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(edit) === "set")) {
            changed();
          }
          if (completionStatus(update.state) === "active") {
            queueMicrotask(addFooter);
          }
        })
      ]
    })
  });

  const lineOf = (target: EditorView): number => target.state.doc.lineAt(target.state.selection.main.head).number;

  return {
    element: root,
    getText: () => view.state.doc.toString(),
    setText(next, setOptions) {
      const keep = setOptions?.keepCaret === true;
      const line = lineOf(view);
      const column = view.state.selection.main.head - view.state.doc.line(line).from;
      const current = view.state.doc;
      if (current.toString() === next) {
        return;
      }
      let anchor = next.length;
      if (keep) {
        const start = lineStartOffset(next, line);
        const end = next.indexOf("\n", start);
        anchor = start + Math.min(column, (end < 0 ? next.length : end) - start);
      }
      view.dispatch({ changes: { from: 0, to: current.length, insert: next }, selection: { anchor }, annotations: edit.of("set") });
      history.reset();
    },
    insertLine(statement: string, insertOptions?: TestsInsertLineOptions) {
      const source = view.state.doc.toString();
      const at = insertOptions?.afterLine !== undefined ? lineEndOffset(source, insertOptions.afterLine) : view.state.selection.main.head;
      const edited = statementInsertion(source, at, statement);
      view.dispatch({
        changes: { from: edited.from, to: edited.to, insert: edited.insert },
        selection: { anchor: edited.caret },
        scrollIntoView: true,
        userEvent: "input"
      });
      // A recorded line lands while the author works in Try it: the focus stays on the canvas.
      if (insertOptions?.focus !== false) {
        view.focus();
      }
    },
    setMarks(marks) {
      view.dispatch({ effects: setMarks.of(marks) });
    },
    setProblems(next) {
      problems = next;
      const length = view.state.doc.length;
      const lines = new Map<number, "error" | "warning">();
      const diagnostics: Diagnostic[] = next.map((problem) => {
        const from = Math.max(0, Math.min(problem.start, length));
        const to = Math.max(from, Math.min(problem.end, length));
        if (lines.get(problem.line) !== "error") {
          lines.set(problem.line, problem.severity);
        }
        return { from, to, severity: problem.severity, message: problem.message };
      });
      view.dispatch(setDiagnostics(view.state, diagnostics), { effects: setProblemLines.of(lines) });
    },
    focus(line) {
      if (line !== undefined) {
        const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
        view.dispatch({ selection: EditorSelection.cursor(target.from), scrollIntoView: true });
      }
      view.focus();
    },
    caretLine: () => lineOf(view),
    destroy() {
      destroyed = true;
      view.destroy();
      root.remove();
    }
  };
};
