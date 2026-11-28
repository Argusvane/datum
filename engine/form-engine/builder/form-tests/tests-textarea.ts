/**
 * The test editor's fallback: the same interface as the CodeMirror editor (`tests-editor.ts`, a
 * lazy chunk of its own) over a plain `<textarea>`, with a gutter that numbers the lines and
 * marks what the last run made of them. It is the whole editor until the
 * CodeMirror chunk lands, and again if that chunk fails to load; the panel mounts it first and
 * swaps the editor in with `getText()` and the caret's line, as the formula editor's hosts do.
 * It has no suggestions (they need a popover), and draws no problems itself: the panel lists
 * them under the box, and here they are only the box's `aria-describedby` text and a flag on the
 * gutter's line, so a screen reader hears what is wrong without the box repeating the list.
 *
 * Geometry is the one thing the gutter cannot get wrong: one cell per line of text, each exactly
 * as tall as a line of the textarea (`LINE_PX`, set on both through one custom property), and the
 * gutter scrolls with the textarea. The box does not wrap (`wrap="off"`) so a line is one row.
 *
 * Paint contract, as the formula textarea's: `onChange` fires on every edit and never repaints;
 * `setText`, `setMarks` and `setProblems` are the host's, not edits, and fire nothing.
 *
 * This module also owns both editors' style strings ({@link TESTS_TEXTAREA_STYLES},
 * {@link TESTS_EDITOR_STYLES}) and the pure edit {@link statementInsertion}: the panel's chunk
 * imports them from here, so it never pulls CodeMirror in with them.
 */
import type { MountTestsEditor, TestsEditorMark, TestsEditorProblem } from "./tests-model.js";
import { builderText } from "./tests-editor-texts-en.js";

/** The height of one line in either editor, in px; the gutter's cells and the textarea's lines share it. */
export const TESTS_LINE_PX = 20;
/** The textarea grows with its text between these many rows, then scrolls. */
const MIN_ROWS = 8;
const MAX_ROWS = 24;

// --- styles ----------------------------------------------------------------------------------

/**
 * The fallback's look and the marks both editors share (the gutter's cells and their status). A
 * host sheet appends it to the panel's: colours are the builder's `--db-*` tokens, so a builder
 * theme restyles the box with the rest. No backticks inside this literal.
 */
export const TESTS_TEXTAREA_STYLES = `
.tests-box{--tests-line-h:${String(TESTS_LINE_PX)}px;position:relative;display:grid;grid-template-columns:auto minmax(0,1fr);border:var(--db-border-w, 1px) solid var(--db-line-input);border-radius:var(--db-radius-md, 10px);background:var(--db-surface);color:var(--db-ink);font-family:var(--db-font-mono, ui-monospace, Menlo, monospace);font-size:var(--db-text-md, 13px);line-height:var(--tests-line-h);overflow:hidden}
.tests-box:focus-within{outline:2px solid var(--db-focus);outline-offset:1px}
.tests-box[data-invalid]{border-color:var(--db-danger-line)}
.tests-textarea{box-sizing:border-box;min-width:0;width:100%;margin:0;padding:8px 10px;border:0;outline:0;resize:none;background:transparent;color:inherit;font:inherit;line-height:var(--tests-line-h);white-space:pre;overflow:auto;tab-size:2}
.tests-gutter{box-sizing:border-box;min-width:34px;padding:8px 0;overflow:hidden;background:var(--db-surface-sunken);color:var(--db-ink-subtle);user-select:none;font-variant-numeric:tabular-nums}
.tests-problems{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.tests-cell{box-sizing:border-box;display:flex;align-items:center;justify-content:flex-end;gap:4px;height:var(--tests-line-h);padding:0 8px 0 6px;box-shadow:inset 3px 0 0 transparent}
.tests-cell[data-status="passed"]{box-shadow:inset 3px 0 0 var(--db-ok-line)}
.tests-cell[data-status="ran"]{box-shadow:inset 3px 0 0 var(--db-ok-line);color:var(--db-ink-muted)}
.tests-cell[data-status="failed"]{box-shadow:inset 3px 0 0 var(--db-danger);background:var(--db-danger-soft);color:var(--db-danger)}
.tests-cell[data-status="error"]{box-shadow:inset 3px 0 0 var(--db-warn);background:var(--db-warn-soft);color:var(--db-warn)}
.tests-cell[data-status="skipped"]{box-shadow:inset 3px 0 0 var(--db-warn-line)}
.tests-cell[data-status="pending"]{color:var(--db-ink-subtle)}
.tests-cell[data-problem="error"] .tests-ln{color:var(--db-danger);font-weight:600}
.tests-cell[data-problem="warning"] .tests-ln{color:var(--db-warn);font-weight:600}
.tests-cell.tests-line--shown{background:var(--db-accent-soft);color:var(--db-accent-text)}
.tests-cell.tests-line--shown .tests-ln{font-weight:600}
`;

/**
 * The CodeMirror editor's look: the box, its tokens (`.t-*`, the formula editor's palette under
 * this editor's own names), the failed line, the suggestions popover and the diagnostics. Kept
 * here, in the light module, so the panel can append it to its sheet without importing the
 * editor; CodeMirror injects its own base rules as an adopted sheet the root applies after the
 * host's, so every rule that overrides one names the editor's root as well. No backticks inside.
 */
export const TESTS_EDITOR_STYLES = `
.tests-cm{--tests-line-h:${String(TESTS_LINE_PX)}px;position:relative;min-width:0;font-family:var(--db-font-mono, ui-monospace, Menlo, monospace)}
.tests-cm .cm-editor{border:var(--db-border-w, 1px) solid var(--db-line-input);border-radius:var(--db-radius-md, 10px);background:var(--db-surface);color:var(--db-ink);font-size:var(--db-text-md, 13px);line-height:var(--tests-line-h);overflow:hidden}
.tests-cm .cm-editor.cm-focused{outline:2px solid var(--db-focus);outline-offset:1px}
.tests-cm .cm-scroller{font-family:inherit;line-height:var(--tests-line-h);max-height:calc(var(--tests-line-h) * ${String(MAX_ROWS)} + 16px);min-height:calc(var(--tests-line-h) * ${String(MIN_ROWS)} + 16px)}
.tests-cm .cm-content{padding:8px 0;caret-color:var(--db-ink)}
.tests-cm .cm-line{padding:0 10px}
.tests-cm .cm-cursor{border-left-color:var(--db-ink)}
.tests-cm .cm-selectionBackground,.tests-cm .cm-focused .cm-selectionBackground{background:var(--db-accent-soft)}
.tests-cm .cm-gutters{background:var(--db-surface-sunken);color:var(--db-ink-subtle);border:0;padding:8px 0;font-variant-numeric:tabular-nums}
.tests-cm .cm-gutter.tests-gutter{min-width:34px;padding:0}
.tests-cm .cm-gutter.tests-gutter .cm-gutterElement{padding:0}
.tests-cm .cm-gutter.tests-gutter .tests-cell{height:100%}
.tests-cm .t-line-failed{background:var(--db-danger-soft)}
.tests-cm .t-line-error{background:var(--db-warn-soft)}
.tests-cm .cm-line.tests-line--shown{background:var(--db-accent-soft);box-shadow:inset 3px 0 0 var(--db-accent)}
.tests-cm .t-kw{color:var(--db-accent-text);font-weight:500}
.tests-cm .t-path{background:var(--db-accent-soft);border-radius:4px;padding:0 3px;color:var(--db-ink)}
.tests-cm .t-str{color:var(--db-code-string)}
.tests-cm .t-num{color:var(--db-code-literal)}
.tests-cm .t-code{color:var(--db-code-literal)}
.tests-cm .t-fn{color:var(--db-ink);font-weight:500}
.tests-cm .t-op{color:var(--db-ink-muted)}
.tests-cm .t-cm{color:var(--db-ink-subtle)}
.tests-cm .t-bad{color:var(--db-danger);text-decoration:underline wavy var(--db-danger);text-underline-offset:4px}
.tests-cm .cm-lintRange{background-image:none;background-repeat:no-repeat;padding-bottom:0}
.tests-cm .cm-lintRange-error{text-decoration:underline wavy var(--db-danger);text-underline-offset:4px}
.tests-cm .cm-lintRange-warning{text-decoration:underline wavy var(--db-warn-line);text-underline-offset:4px}
.tests-cm .cm-tooltip{background:var(--db-surface);color:var(--db-ink);border:1px solid var(--db-line-card);border-radius:var(--db-radius-lg);box-shadow:var(--db-shadow-overlay, 0 24px 48px -20px rgba(0,0,0,.45));font-family:var(--db-font, inherit);font-size:var(--db-text-sm, 12px);z-index:var(--db-z-popover, 30)}
.tests-cm .cm-tooltip.cm-tooltip-autocomplete{padding:6px}
.tests-cm .cm-tooltip.cm-tooltip-autocomplete > ul{font-family:inherit;min-width:280px;max-width:440px;max-height:300px}
.tests-cm .cm-tooltip.cm-tooltip-autocomplete > ul > li{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:var(--db-radius-sm);line-height:1.3}
.tests-cm .cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]{background:var(--db-surface-hover);color:inherit}
.tests-cm .cm-tooltip.cm-tooltip-autocomplete > ul > li .cm-completionDetail{margin-inline-start:auto;font-style:normal;color:var(--db-ink-muted);font-size:var(--db-text-xs, 11px)}
.tests-cm .cm-tooltip.cm-tooltip-autocomplete > ul > li.t-opt-statement .cm-completionLabel,.tests-cm .cm-tooltip.cm-tooltip-autocomplete > ul > li.t-opt-word .cm-completionLabel{color:var(--db-accent-text);font-weight:500;font-family:var(--db-font-mono, ui-monospace, Menlo, monospace)}
.tests-cm .cm-tooltip.cm-tooltip-autocomplete > ul > li.t-opt-field .cm-completionLabel{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:var(--db-radius-xs);background:var(--db-accent-soft);color:var(--db-accent-text);font-weight:500;font-family:var(--db-font, inherit)}
.tests-cm .cm-tooltip.cm-tooltip-autocomplete > ul > li.t-opt-value .cm-completionLabel{font-family:var(--db-font-mono, ui-monospace, Menlo, monospace);color:var(--db-code-string)}
.tests-cm .cm-tooltip.cm-tooltip-autocomplete > ul > .cm-completionSection{font-size:var(--db-text-sm);font-weight:600;letter-spacing:.02em;color:var(--db-ink-muted);padding:8px 10px 2px}
.tests-cm .cm-tooltip.cm-tooltip-autocomplete .t-suggest-footer{padding:6px 10px 4px;font-size:var(--db-text-xs, 11px);color:var(--db-ink-subtle);border-block-start:1px solid var(--db-line-divider);margin-block-start:4px}
.tests-cm .cm-tooltip.cm-completionInfo{padding:8px 10px;max-width:280px;color:var(--db-ink-muted);font-size:var(--db-text-xs, 11px)}
.tests-cm .cm-tooltip.cm-tooltip-lint{padding:6px 10px;font-size:var(--db-text-xs, 11px)}
@media (pointer:coarse){.tests-cm .cm-tooltip.cm-tooltip-autocomplete > ul > li{min-height:44px;box-sizing:border-box}}
`;

// --- the edit both editors share ---------------------------------------------------------------

const HEADER = /^test\b/i;

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/** A line a statement can be indented like: not blank, not the `test` header (whose own indent is none). */
function isBodyLine(line: string): boolean {
  return line.trim() !== "" && !HEADER.test(line.trim());
}

/**
 * Where a statement goes when it is added "after the caret's line", and with what indentation.
 * The new line is indented like its neighbours: the caret's own line
 * when that is a statement, else the nearest statement below it, else the nearest above, else two
 * spaces under a `test` header, else none. A caret on a blank line fills that line rather than
 * leaving a gap, and on the `test` header the statement goes first under it. A statement that
 * starts a test (`test "name"`) is never indented. The result is a replacement of
 * `[from, to)` by `insert`, and where the caret lands after it (the end of the new statement).
 */
export function statementInsertion(text: string, caret: number, statement: string): { from: number; to: number; insert: string; caret: number } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const at = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  let lineEnd = text.indexOf("\n", at);
  lineEnd = lineEnd < 0 ? text.length : lineEnd;
  if (lineEnd > lineStart && text.charAt(lineEnd - 1) === "\r") {
    lineEnd -= 1;
  }
  if (text.trim() === "") {
    // Nothing to be indented like: the statement stands alone, at the end of whatever blanks there are.
    return { from: 0, to: text.length, insert: statement, caret: statement.length };
  }
  const lines = text.split(/\r\n|\n|\r/);
  const index = text.slice(0, lineStart).split("\n").length - 1;
  let indent = "";
  if (!HEADER.test(statement.trim())) {
    const own = lines[index] ?? "";
    if (isBodyLine(own)) {
      indent = indentOf(own);
    } else {
      let found: string | undefined;
      for (let i = index + 1; i < lines.length && found === undefined; i += 1) {
        if (isBodyLine(lines[i] ?? "")) {
          found = indentOf(lines[i] ?? "");
        }
      }
      for (let i = index - 1; i >= 0 && found === undefined; i -= 1) {
        if (isBodyLine(lines[i] ?? "")) {
          found = indentOf(lines[i] ?? "");
        }
      }
      indent = found ?? (lines.some((line) => HEADER.test(line.trim())) ? "  " : "");
    }
  }
  const line = text.slice(lineStart, lineEnd);
  if (line.trim() === "") {
    const insert = indent + statement;
    return { from: lineStart, to: lineEnd, insert, caret: lineStart + insert.length };
  }
  const insert = eol + indent + statement;
  return { from: lineEnd, to: lineEnd, insert, caret: lineEnd + insert.length };
}

/** The offset of the start of the 1-based `line` in `text`, clamped to the last line. */
export function lineStartOffset(text: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf("\n", offset);
    if (next < 0) {
      return offset;
    }
    offset = next + 1;
  }
  return offset;
}

/** The offset of the end of the 1-based `line` in `text` (before its terminator), clamped to the last line. */
export function lineEndOffset(text: string, line: number): number {
  const start = lineStartOffset(text, line);
  const next = text.indexOf("\n", start);
  const end = next < 0 ? text.length : next;
  return end > start && text.charAt(end - 1) === "\r" ? end - 1 : end;
}

/**
 * The 1-based line of the last non-blank line of `text`: where Record and Assert this add their
 * lines, after the steps and before the blanks a seeded test ends with. 1 for
 * a text of blanks.
 */
export function lastFilledLine(text: string): number {
  const lines = text.split(/\r\n|\n|\r/);
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    if ((lines[at] ?? "").trim() !== "") {
      return at + 1;
    }
  }
  return 1;
}

/**
 * `insertLine`'s optional second argument, which both editors take (an addition to the
 * contract's `TestsEditor.insertLine`): `afterLine` places the
 * statement after that line rather than the caret's, and `focus: false` leaves the focus where it
 * is (Record writes while the author works in Try it).
 */
export interface TestsInsertLineOptions {
  afterLine?: number;
  focus?: boolean;
}

/** The 1-based line holding `offset`. */
export function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

// --- the fallback --------------------------------------------------------------------------------

let nextId = 0;

/** The fallback editor, mounted as the last child of `parent`; see the module note. */
export const mountTestsTextarea: MountTestsEditor = (parent, options) => {
  const doc = parent.ownerDocument;
  nextId += 1;
  const problemsId = `datum-tests-problems-${String(nextId)}`;
  const words = options.words;

  const box = doc.createElement("div");
  box.className = "tests-box";
  box.setAttribute("data-tests-editor", "textarea");
  // The geometry is also set inline so the box is right before a host sheet adopts the styles above.
  box.style.setProperty("--tests-line-h", `${String(TESTS_LINE_PX)}px`);

  const gutter = doc.createElement("div");
  gutter.className = "tests-gutter";
  gutter.setAttribute("aria-hidden", "true");
  gutter.style.lineHeight = `${String(TESTS_LINE_PX)}px`;

  const textarea = doc.createElement("textarea");
  textarea.className = "tests-textarea";
  textarea.setAttribute("aria-label", options.ariaLabel);
  textarea.setAttribute("aria-multiline", "true");
  textarea.setAttribute("spellcheck", "false");
  textarea.setAttribute("autocapitalize", "off");
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("wrap", "off");
  textarea.style.fontFamily = "var(--db-font-mono, ui-monospace, Menlo, monospace)";
  textarea.style.lineHeight = `${String(TESTS_LINE_PX)}px`;
  textarea.value = options.text;

  const problemsNote = doc.createElement("span");
  problemsNote.id = problemsId;
  problemsNote.className = "tests-problems";

  box.append(gutter, textarea, problemsNote);
  parent.appendChild(box);

  let marks = new Map<number, TestsEditorMark>();
  let problems: readonly TestsEditorProblem[] = [];
  let drawn = -1;

  const lineCount = (): number => lineOfOffset(textarea.value, textarea.value.length);

  const grow = (): void => {
    textarea.rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, lineCount() + 1));
    fitGutter();
  };

  /**
   * A long line gives the box a horizontal scrollbar (where scrollbars take room), which lets it
   * scroll that much further than the gutter: the gutter's foot grows by the bar's height, so the
   * last numbers and marks stay on their lines at the bottom.
   */
  let gutterFoot = -1;
  const fitGutter = (): void => {
    const bar = Math.max(0, textarea.offsetHeight - textarea.clientHeight);
    if (bar !== gutterFoot) {
      gutterFoot = bar;
      gutter.style.paddingBottom = `${String(8 + bar)}px`;
    }
  };

  /** One cell per line, each with the line's number, its status and its worst problem. */
  const drawGutter = (): void => {
    const count = lineCount();
    const worst = new Map<number, "error" | "warning">();
    for (const problem of problems) {
      if (worst.get(problem.line) !== "error") {
        worst.set(problem.line, problem.severity);
      }
    }
    const cells: HTMLElement[] = [];
    for (let line = 1; line <= count; line += 1) {
      const cell = doc.createElement("div");
      cell.className = "tests-cell";
      cell.setAttribute("data-line", String(line));
      const mark = marks.get(line);
      if (mark !== undefined) {
        cell.setAttribute("data-status", mark.status);
        cell.title = mark.message !== undefined && mark.message !== "" ? mark.message : builderText(MARK_KEYS[mark.status], undefined, words);
        if (mark.shown === true) {
          // The step Show me has on the canvas, drawn besides its status. The
          // gutter is hidden from assistive technology: the panel's live region names the line.
          cell.classList.add(SHOWN_CLASS);
        }
      }
      const problem = worst.get(line);
      if (problem !== undefined) {
        cell.setAttribute("data-problem", problem);
      }
      const number = doc.createElement("span");
      number.className = "tests-ln";
      number.textContent = String(line);
      cell.appendChild(number);
      cells.push(cell);
    }
    gutter.replaceChildren(...cells);
    drawn = count;
    gutter.scrollTop = textarea.scrollTop;
  };

  const describe = (): void => {
    problemsNote.textContent = problems.map((problem) => builderText("tests.box.problem", { line: problem.line, message: problem.message }, words)).join(" ");
    if (problems.length > 0) {
      textarea.setAttribute("aria-describedby", problemsId);
    } else {
      textarea.removeAttribute("aria-describedby");
    }
    if (problems.some((problem) => problem.severity === "error")) {
      textarea.setAttribute("aria-invalid", "true");
      box.setAttribute("data-invalid", "");
    } else {
      textarea.removeAttribute("aria-invalid");
      box.removeAttribute("data-invalid");
    }
  };

  const edited = (): void => {
    grow();
    if (lineCount() !== drawn) {
      drawGutter();
    }
    options.onChange(textarea.value);
  };

  const onInput = (): void => edited();
  const onScroll = (): void => {
    fitGutter();
    gutter.scrollTop = textarea.scrollTop;
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      options.onSubmit?.();
    }
  };
  textarea.addEventListener("input", onInput);
  textarea.addEventListener("scroll", onScroll);
  textarea.addEventListener("keydown", onKeydown);

  grow();
  drawGutter();

  return {
    element: box,
    getText: () => textarea.value,
    setText(text, setOptions) {
      const keep = setOptions?.keepCaret === true;
      const line = lineOfOffset(textarea.value, textarea.selectionStart);
      const column = textarea.selectionStart - lineStartOffset(textarea.value, line);
      textarea.value = text;
      if (keep) {
        const start = lineStartOffset(text, line);
        const next = text.indexOf("\n", start);
        const length = (next < 0 ? text.length : next) - start;
        const caret = start + Math.min(column, length);
        textarea.setSelectionRange(caret, caret);
      } else {
        textarea.setSelectionRange(text.length, text.length);
      }
      grow();
      drawGutter();
    },
    insertLine(statement: string, insertOptions?: TestsInsertLineOptions) {
      const at = insertOptions?.afterLine !== undefined ? lineEndOffset(textarea.value, insertOptions.afterLine) : textarea.selectionStart;
      const edit = statementInsertion(textarea.value, at, statement);
      textarea.setRangeText(edit.insert, edit.from, edit.to, "end");
      textarea.setSelectionRange(edit.caret, edit.caret);
      // A recorded line lands while the author works in Try it: the box must not take the focus from the canvas.
      if (insertOptions?.focus !== false) {
        textarea.focus();
      }
      edited();
      const line = lineOfOffset(textarea.value, edit.caret);
      textarea.scrollTop = Math.max(textarea.scrollTop, (line + 1) * TESTS_LINE_PX - textarea.clientHeight);
    },
    setMarks(next) {
      marks = new Map(next.map((mark) => [mark.line, mark]));
      drawGutter();
    },
    setProblems(next) {
      problems = next;
      describe();
      drawGutter();
    },
    focus(line) {
      if (line !== undefined) {
        const offset = lineStartOffset(textarea.value, line);
        textarea.setSelectionRange(offset, offset);
        const top = (line - 1) * TESTS_LINE_PX;
        if (top < textarea.scrollTop || top > textarea.scrollTop + textarea.clientHeight - 2 * TESTS_LINE_PX) {
          textarea.scrollTop = Math.max(0, top - 2 * TESTS_LINE_PX);
        }
      }
      textarea.focus();
    },
    caretLine: () => lineOfOffset(textarea.value, textarea.selectionStart),
    destroy() {
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("scroll", onScroll);
      textarea.removeEventListener("keydown", onKeydown);
      box.remove();
    }
  };
};

/** The class both editors give the line Show me is on: the gutter's cell here, the cell and the line in CodeMirror. */
export const SHOWN_CLASS = "tests-line--shown";

/** The words for a mark's status, by key, so the title says "Passed" rather than a code. */
export const MARK_KEYS = {
  passed: "tests.box.mark.passed",
  failed: "tests.box.mark.failed",
  skipped: "tests.box.mark.skipped",
  error: "tests.box.mark.error",
  ran: "tests.box.mark.ran",
  pending: "tests.box.mark.pending"
} as const satisfies Record<TestsEditorMark["status"], string>;
