/**
 * The formula editor's fallback: the same interface as the CodeMirror editor
 * (`formula-editor.ts`, a lazy chunk) over a plain `<textarea>`. Eager and tiny, so a host
 * mounts it first and swaps the editor in when the chunk lands (keeping text and focus), or
 * keeps it when the chunk fails. It parses on every edit and shows the problems under the box:
 * the parse error worded from the catalog, and the fields the form lacks with the nearest
 * name as a suggestion (the problem names its span; nothing is disabled).
 *
 * {@link formulaEditorState} is the one computation both editors share, so the lint markers
 * in the CodeMirror box and the lines under this one say the same thing.
 *
 * Paint contract: `onChange` fires on every edit and never repaints (the host writes a draft
 * or refreshes live); `onCommit` fires on blur, on Enter in a single-line box and on
 * Ctrl/Cmd+Enter in a multiline one. `setText` is not an edit: neither callback fires.
 */
import { isScopedExpressionPath } from "../../core/expressions/condition-shape.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import type { FormulaFunctionSignature, FormulaParseResult } from "../../core/expressions/formula-types.js";
import { builderText, formulaErrorText, type BuilderTextCatalog, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";
import type { FormulaFunctionRow, FormulaSnippet } from "./feel-functions.js";
import { feelName } from "./feel-functions.js";
import { isKnownFormulaPath, suggestFormulaField, type FormulaField } from "./formula-fields.js";

export type { FormulaField } from "./formula-fields.js";

export interface FormulaEditorProblem {
  kind: "parse" | "unknownField" | "lint";
  message: string;
  /** 0-based UTF-16 offsets into the text, `end` exclusive. */
  start: number;
  end: number;
  /** For an unknown field: the id to write instead, as the formula spells it. */
  suggestion?: string;
}

export interface FormulaEditorState {
  parsed: FormulaParseResult;
  problems: FormulaEditorProblem[];
}

export interface FormulaEditorOptions {
  text: string;
  /** The box's accessible name. */
  label: string;
  fields: FormulaField[];
  /** The scope prefixes a formula may read besides fields (`row.`, `ancestor.`, `host.`, `component`); absent: all of them. */
  scopes?: string[];
  /** The merged function table (built-ins + plugins). */
  functions: FormulaFunctionRow[];
  signatures: FormulaFunctionSignature[];
  /** Value rules: cases one per line. */
  multiline?: boolean;
  locale?: string;
  catalog?: BuilderTextCatalog;
  /** Every edit; the host refreshes live or writes a draft, never paints. */
  onChange(text: string, state: FormulaEditorState): void;
  /** Blur, Enter in a single-line box, Apply/Save. */
  onCommit(text: string, state: FormulaEditorState): void;
  snippets?: FormulaSnippet[];
}

export interface FormulaEditor {
  dom: HTMLElement;
  contentDom: HTMLElement;
  getText(): string;
  setText(text: string): void;
  focus(): void;
  readonly hasFocus: boolean;
  setFields(fields: FormulaField[]): void;
  insertSnippet(snippet: FormulaSnippet): void;
  insertText(text: string): void;
  destroy(): void;
}

export interface FormulaStateOptions {
  fields: readonly FormulaField[];
  signatures: readonly FormulaFunctionSignature[];
  scopes?: readonly string[] | undefined;
  locale?: string | undefined;
  catalog?: BuilderTextCatalog | undefined;
}

/** Whether `path` reads a scope the editor accepts without a field: `row.`, `ancestor.`, `host.`, `component`. */
function isAcceptedScope(path: string, scopes: readonly string[] | undefined): boolean {
  if (!isScopedExpressionPath(path)) {
    return false;
  }
  if (scopes === undefined) {
    return true;
  }
  return scopes.some((scope) => {
    const prefix = scope.endsWith(".") ? scope : scope + ".";
    return path === scope || path === scope.replace(/\.$/, "") || path.startsWith(prefix);
  });
}

/** How many unknown names get a nearest-field suggestion in one formula. */
const MAX_SUGGESTED_PROBLEMS = 20;

/** The two known ids a hyphenated unknown path splits into (`total-tax` for `total - tax`), if any. */
function hyphenSplit(path: string, fields: readonly FormulaField[]): { left: string; right: string } | undefined {
  let at = path.indexOf("-");
  while (at > 0) {
    const left = path.slice(0, at);
    const right = path.slice(at + 1);
    if (right !== "" && isKnownFormulaPath(left, fields) && isKnownFormulaPath(right, fields)) {
      return { left, right };
    }
    at = path.indexOf("-", at + 1);
  }
  return undefined;
}

/**
 * The parse result and the problems of `text`: the parse error (one at most, first in the
 * text), then every path that names no field and no accepted scope, each with the nearest
 * field as a suggestion, or the "write with spaces" hint when a hyphenated name splits into
 * two fields. Problems come in text order.
 */
export function formulaEditorState(text: string, options: FormulaStateOptions): FormulaEditorState {
  const words: BuilderTextOptions = { locale: options.locale, catalog: options.catalog };
  const parsed = kernelParseFormula(text, [...options.signatures]);
  const problems: FormulaEditorProblem[] = [];
  if (!parsed.ok) {
    problems.push({ kind: "parse", message: formulaErrorText(parsed.code, parsed.params, words), start: parsed.start, end: parsed.end });
    return { parsed, problems };
  }
  const reported = new Set<string>();
  let suggested = 0;
  for (const ref of parsed.paths) {
    if (isAcceptedScope(ref.path, options.scopes) || isKnownFormulaPath(ref.path, options.fields)) {
      continue;
    }
    const key = `${String(ref.start)}:${String(ref.end)}`;
    if (reported.has(key)) {
      continue;
    }
    reported.add(key);
    const split = hyphenSplit(ref.path, options.fields);
    if (split) {
      problems.push({
        kind: "unknownField",
        message: builderText("formula.hyphenHint", { left: feelName(split.left), right: feelName(split.right) }, words),
        start: ref.start,
        end: ref.end,
        suggestion: `${feelName(split.left)} - ${feelName(split.right)}`
      });
      continue;
    }
    // A nearest-field search costs a pass over every field: the first problems get one, the rest are only reported.
    suggested += 1;
    const nearest = suggested <= MAX_SUGGESTED_PROBLEMS ? suggestFormulaField(ref.path, options.fields) : undefined;
    let message = builderText("formula.unknownField", { name: ref.path }, words);
    const problem: FormulaEditorProblem = { kind: "unknownField", message, start: ref.start, end: ref.end };
    if (nearest !== undefined) {
      message += " " + builderText("formula.unknownField.hint", { suggestion: nearest.label }, words);
      problem.message = message;
      problem.suggestion = feelName(nearest.path);
    }
    problems.push(problem);
  }
  problems.sort((a, b) => a.start - b.start);
  return { parsed, problems };
}

const BLANK = /\$\{(\d+)\}/g;

/** The built-in blanks' names in the builder's words; a host's snippet names pass through as they are. */
const BLANK_KEYS: Readonly<Record<string, BuilderTextKey>> = {
  field: "snippet.blank.field",
  box: "snippet.blank.box",
  group: "snippet.blank.group",
  date: "snippet.blank.date",
  "date of birth": "snippet.blank.dateOfBirth",
  condition: "snippet.blank.condition",
  value: "snippet.blank.value",
  N: "snippet.blank.number",
  a: "snippet.blank.a",
  b: "snippet.blank.b"
};

/**
 * `snippet.insert` with its blanks filled by their names, and the span of the first blank, so
 * the caret can select it. A blank with no name reads as `…`.
 */
export function snippetInsertion(snippet: FormulaSnippet, words?: BuilderTextOptions): { text: string; selectStart: number; selectEnd: number } {
  let selectStart = -1;
  let selectEnd = -1;
  let text = "";
  let last = 0;
  for (const match of snippet.insert.matchAll(BLANK)) {
    const at = match.index ?? 0;
    text += snippet.insert.slice(last, at);
    const index = Number(match[1]) - 1;
    const blank = snippet.blanks[index];
    const key = blank !== undefined ? BLANK_KEYS[blank] : undefined;
    const name = key !== undefined ? builderText(key, undefined, words) : (blank ?? "…");
    if (selectStart < 0) {
      selectStart = text.length;
      selectEnd = selectStart + name.length;
    }
    text += name;
    last = at + match[0].length;
  }
  text += snippet.insert.slice(last);
  if (selectStart < 0) {
    selectStart = text.length;
    selectEnd = text.length;
  }
  return { text, selectStart, selectEnd };
}

let nextId = 0;

/** The fallback editor, mounted as the last child of `parent`; see the module note. */
export function mountFormulaTextarea(parent: HTMLElement, options: FormulaEditorOptions): FormulaEditor {
  const document = parent.ownerDocument;
  nextId += 1;
  const problemsId = `datum-formula-problems-${String(nextId)}`;
  let fields = options.fields;
  const words = { locale: options.locale, catalog: options.catalog };

  const dom = document.createElement("div");
  dom.className = "formula-fallback";
  dom.setAttribute("data-formula-fallback", "");
  dom.style.display = "flex";
  dom.style.flexDirection = "column";
  dom.style.gap = "6px";

  const textarea = document.createElement("textarea");
  textarea.className = "formula-textarea";
  textarea.setAttribute("aria-label", options.label);
  textarea.setAttribute("placeholder", builderText("editor.placeholder", undefined, words));
  textarea.setAttribute("spellcheck", "false");
  textarea.setAttribute("autocapitalize", "off");
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("aria-describedby", problemsId);
  textarea.rows = options.multiline === true ? 3 : 1;
  if (options.multiline === true) {
    textarea.setAttribute("aria-multiline", "true");
  }
  textarea.value = options.text;
  textarea.style.minHeight = "44px";
  textarea.style.width = "100%";
  textarea.style.boxSizing = "border-box";
  textarea.style.padding = "8px 10px";
  textarea.style.border = "1px solid var(--db-line-input)";
  textarea.style.borderRadius = "10px";
  textarea.style.background = "var(--db-surface)";
  textarea.style.color = "var(--db-ink)";
  textarea.style.font = "inherit";
  textarea.style.fontSize = "14px";
  textarea.style.lineHeight = "1.5";
  textarea.style.resize = "vertical";

  const problems = document.createElement("div");
  problems.id = problemsId;
  problems.className = "formula-problems";
  problems.setAttribute("aria-live", "polite");
  problems.hidden = true;

  dom.append(textarea, problems);
  parent.appendChild(dom);

  const state = (): FormulaEditorState =>
    formulaEditorState(textarea.value, {
      fields,
      signatures: options.signatures,
      scopes: options.scopes,
      locale: options.locale,
      catalog: options.catalog
    });

  const show = (current: FormulaEditorState): void => {
    problems.replaceChildren();
    for (const problem of current.problems) {
      const line = document.createElement("p");
      line.className = "problem";
      line.setAttribute("data-kind", problem.kind);
      line.style.margin = "0";
      line.style.fontSize = "13px";
      line.style.color = problem.kind === "parse" ? "var(--db-danger)" : "var(--db-warn)";
      line.textContent = problem.message;
      problems.appendChild(line);
    }
    problems.hidden = current.problems.length === 0;
    const invalid = current.problems.some((problem) => problem.kind === "parse");
    if (invalid) {
      textarea.setAttribute("aria-invalid", "true");
      textarea.style.borderColor = "var(--db-danger-line, var(--db-danger))";
    } else {
      textarea.removeAttribute("aria-invalid");
      textarea.style.borderColor = "";
    }
  };

  const changed = (): void => {
    const current = state();
    show(current);
    options.onChange(textarea.value, current);
  };
  const committed = (): void => {
    const current = state();
    show(current);
    options.onCommit(textarea.value, current);
  };

  const onInput = (): void => changed();
  const onBlur = (): void => committed();
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter") {
      return;
    }
    if (options.multiline === true && !(event.ctrlKey || event.metaKey)) {
      return;
    }
    event.preventDefault();
    committed();
  };
  textarea.addEventListener("input", onInput);
  textarea.addEventListener("blur", onBlur);
  textarea.addEventListener("keydown", onKeydown);

  /** Replace the selection with `text`; the caret lands after it unless a span is given, as an edit. */
  const replaceSelection = (text: string, select?: { start: number; end: number }): void => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = before + text + after;
    const caret = select === undefined ? start + text.length : start + select.start;
    textarea.setSelectionRange(caret, select === undefined ? caret : start + select.end);
    changed();
  };

  show(state());

  return {
    dom,
    contentDom: textarea,
    getText: () => textarea.value,
    setText: (text) => {
      textarea.value = text;
      show(state());
    },
    focus: () => textarea.focus(),
    get hasFocus() {
      return document.activeElement === textarea;
    },
    setFields: (next) => {
      fields = next;
      show(state());
    },
    insertSnippet: (snippet) => {
      const insertion = snippetInsertion(snippet, { locale: options.locale, catalog: options.catalog });
      replaceSelection(insertion.text, { start: insertion.selectStart, end: insertion.selectEnd });
    },
    insertText: (text) => replaceSelection(text),
    destroy: () => {
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("blur", onBlur);
      textarea.removeEventListener("keydown", onKeydown);
      dom.remove();
    }
  };
}
