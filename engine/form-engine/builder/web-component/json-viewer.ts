/**
 * A CodeMirror editor for JSON: the properties panel's JSON view, and any host page that wants
 * the same box (the web host's renderer rails do). An editor gives the text what a `<pre>`
 * cannot — syntax colour, line numbers, folding for nested blocks, and wrapping that suits a
 * narrow rail.
 *
 * Read-only by default: the state is read-only and the content is not editable, so nothing
 * typed reaches anything (the Header & footer panel's and the Data workspace's JSON views, a host's
 * rails). `editable: true` makes it a box the author types in (the inspector's JSON):
 * every edit is handed to `onChange`, and the panel decides what reaches the draft. The command model is
 * not bypassed, since Apply is what writes the tree. The
 * editable box keeps its own undo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y), indents a new line
 * like the one above it, and leaves Tab alone so a keyboard user can always move on.
 *
 * Colours come from the builder's `--db-*` tokens (see `builderTokens`), so a builder theme
 * that restyles the panels restyles this too; a page mounting it outside the panels defines
 * those tokens on an ancestor. CodeMirror injects its stylesheet into the root the editor is
 * mounted in — a shadow root or the document — as an adopted sheet, which survives a panel
 * replacing its markup. It reads the studio names first and the older ones as their fallback:
 * the web host's renderer rails map only the older names onto their own colours.
 */
import { json } from "@codemirror/lang-json";
import { HighlightStyle, bracketMatching, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { Annotation, type AnnotationType, type EditorSelection, EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** A mounted viewer; see {@link mountJsonViewer}. */
export interface JsonViewer {
  /** The editor's outer element (`.cm-editor`), a child of the parent it was mounted in. */
  readonly dom: HTMLElement;
  /** The element that takes focus and the caret (`.cm-content`): where a panel points `aria-describedby`. */
  readonly contentDom: HTMLElement;
  /** Whether the reader can type in it (see {@link JsonViewerOptions.editable}). */
  readonly editable: boolean;
  /** Scroll offset of the editor's own scroller — what the builder panel carries across a repaint. */
  scrollTop: number;
  /** Whether the editor has focus. */
  readonly hasFocus: boolean;
  /** The text as it stands. */
  getText(): string;
  /**
   * Shows different text, in place: the scroll offset and the reader's folds survive where
   * they can. Not an edit of the reader's: `onChange` is not called, and an editable box's
   * undo starts again from here.
   */
  setText(text: string): void;
  /** Focuses the editor — the caret where it was, or at `offset` in the text. */
  focus(offset?: number): void;
  /** Takes the editor out of the DOM and releases what it holds. */
  destroy(): void;
}

export interface JsonViewerOptions {
  /** What the editor is, for assistive technology; the default says only that it is read-only JSON. */
  label?: string | undefined;
  /** Whether the reader may type in it. Default: read-only. */
  editable?: boolean | undefined;
  /** An editable box's text after each edit the reader makes (never after {@link JsonViewer.setText}). */
  onChange?: ((text: string) => void) | undefined;
}

/*
 * Built on first mount, not at import: the engine's root module re-exports the builder, so
 * this file is reachable from the renderer bundle too, and a theme created at module level
 * is a side effect Rollup keeps — dragging the editor into `datum-form.js`, which never
 * shows JSON (the slim renderer; check-bundles guards it). Built once per mode, and
 * the look once for both, because each `EditorView.theme` adds its own rules to the root's
 * stylesheet, and the panel mounts a fresh editor after every paint.
 */
let viewerExtensions: Extension | undefined;
let editorExtensions: Extension | undefined;
let sharedLook: Extension | undefined;
/** Marks the editor's own undo and redo, and a host's `setText`, so neither is recorded as an edit. */
let historyMark: AnnotationType<"undo" | "set"> | undefined;

const viewerTheme = (): Extension => EditorView.theme({
  "&": {
    backgroundColor: "var(--db-surface-sunken)",
    color: "var(--db-ink)",
    fontSize: "var(--db-text-sm, 12px)",
    height: "100%"
  },
  ".cm-scroller": {
    fontFamily: "var(--db-font-mono, ui-monospace, Menlo, monospace)",
    lineHeight: "1.5",
    overflow: "auto"
  },
  ".cm-content": { padding: "6px 0", caretColor: "var(--db-ink)" },
  ".cm-line": { padding: "0 8px" },
  /* Keyboard focus is the studio ring, drawn inside: the editor sits edge to edge in a scroller that would clip it outside. */
  "&.cm-focused": { outline: "2px solid var(--db-focus, var(--db-accent))", outlineOffset: "-2px" },
  /* Compact gutters: the rail is narrow, and the numbers are a guide, not the content. */
  ".cm-gutters": {
    backgroundColor: "var(--db-surface)",
    color: "var(--db-ink-muted)",
    border: "none",
    borderInlineEnd: "var(--db-border-w) solid var(--db-line-divider)"
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 6px", minWidth: "0" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 3px" },
  /* An editable box: the caret in ink, a matched bracket pair tinted with the accent. */
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--db-ink)" },
  /* CodeMirror's own light theme is an adopted sheet the shadow root applies after the host's <style>, so its pale tooltip and black caret are overridden here, in a theme that loads after it. */
  ".cm-tooltip": {
    backgroundColor: "var(--db-surface)",
    color: "var(--db-ink)",
    border: "var(--db-border-w, 1px) solid var(--db-line-card, var(--db-line-input))"
  },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--db-accent-soft)", color: "inherit", outline: "none" },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "var(--db-danger-soft, transparent)", color: "inherit" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--db-accent-soft)",
    border: "none",
    color: "var(--db-accent-text, var(--db-accent))",
    borderRadius: "var(--db-radius-xs, 6px)",
    margin: "0 2px",
    padding: "0 4px"
  }
});

/** JSON's five kinds of token, in the panel's palette. */
const viewerHighlight = (): HighlightStyle =>
  HighlightStyle.define([
    { tag: tags.propertyName, color: "var(--db-accent-text, var(--db-accent))" },
    { tag: tags.string, color: "var(--db-code-string)" },
    { tag: [tags.number, tags.bool, tags.null], color: "var(--db-code-literal)" },
    { tag: [tags.separator, tags.brace, tags.squareBracket], color: "var(--db-ink-muted)" }
  ]);

function look(): Extension {
  sharedLook ??= [lineNumbers(), foldGutter(), json(), syntaxHighlighting(viewerHighlight()), viewerTheme()];
  return sharedLook;
}

function readOnlyExtensions(): Extension {
  viewerExtensions ??= [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping, look()];
  return viewerExtensions;
}

function marks(): AnnotationType<"undo" | "set"> {
  historyMark ??= Annotation.define<"undo" | "set">();
  return historyMark;
}

/**
 * Enter: a new line indented like the one it leaves, one step deeper after an opening brace
 * or bracket — and, between a pair, the closing one on a line of its own. Enough for JSON
 * without the commands package's full indentation service.
 */
function newlineAndIndent(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  const base = /^\s*/.exec(line.text)?.[0] ?? "";
  const before = state.sliceDoc(line.from, range.from).trimEnd().slice(-1);
  const after = state.sliceDoc(range.to, line.to).trimStart().charAt(0);
  const opens = before === "{" || before === "[";
  const inner = opens ? `${base}  ` : base;
  const between = (before === "{" && after === "}") || (before === "[" && after === "]");
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `\n${inner}${between ? `\n${base}` : ""}` },
    selection: { anchor: range.from + 1 + inner.length },
    scrollIntoView: true,
    userEvent: "input"
  });
  return true;
}

function editableExtensions(): Extension {
  editorExtensions ??= [EditorView.lineWrapping, bracketMatching(), indentOnInput(), EditorState.tabSize.of(2), look()];
  return editorExtensions;
}

/** One state of the text an undo can go back to. */
interface HistoryEntry {
  doc: Text;
  selection: EditorSelection;
}

/**
 * The editable box's undo: the text before each burst of typing, kept per editor. A burst is
 * the edits of one kind (typing, deleting, a paste) less than half a second apart, as an
 * editor's undo usually groups them. Whole-text snapshots, which the document's shared tree
 * makes cheap, rather than inverted changes: the box holds one component's JSON.
 */
function snapshotHistory(): { extension: Extension; reset(): void } {
  const undone: HistoryEntry[] = [];
  const redone: HistoryEntry[] = [];
  let last = { kind: "", time: 0 };
  const mark = marks();
  const kindOf = (update: { transactions: readonly { isUserEvent(event: string): boolean }[] }): string => {
    for (const kind of ["input.type", "delete", "input.paste", "input.drop", "move", "input"]) {
      if (update.transactions.some((tr) => tr.isUserEvent(kind))) {
        return kind;
      }
    }
    return "other";
  };
  const step = (view: EditorView, from: HistoryEntry[], to: HistoryEntry[]): boolean => {
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
        { key: "Mod-y", run: (view) => step(view, redone, undone), preventDefault: true },
        { key: "Enter", run: newlineAndIndent }
      ])
    ],
    reset(): void {
      undone.length = 0;
      redone.length = 0;
      last = { kind: "", time: 0 };
    }
  };
}

/**
 * Mounts an editor showing `text` as the last child of `parent`, which must already be in the
 * document (the editor finds the root to style from it). Read-only unless `options.editable`.
 */
export function mountJsonViewer(parent: HTMLElement, text: string, options: JsonViewerOptions = {}): JsonViewer {
  const editable = options.editable === true;
  const history = editable ? snapshotHistory() : undefined;
  const mark = marks();
  const onChange = options.onChange;
  // The edit is handed over once CodeMirror's update is done, not from inside it: a host that
  // repaints around the box in answer (the inspector does) may move it, focus it or set its
  // text, none of which an update in progress allows. A burst within one task is handed over once.
  let handOver = false;
  let destroyed = false;
  const changed = (): void => {
    if (handOver) {
      return;
    }
    handOver = true;
    queueMicrotask(() => {
      handOver = false;
      if (!destroyed) {
        onChange?.(view.state.doc.toString());
      }
    });
  };
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        editable ? editableExtensions() : readOnlyExtensions(),
        history?.extension ?? [],
        editable && onChange
          ? EditorView.updateListener.of((update) => {
              if (update.docChanged && !update.transactions.some((tr) => tr.annotation(mark) === "set")) {
                changed();
              }
            })
          : [],
        EditorView.contentAttributes.of({
          "aria-label": options.label ?? (editable ? "JSON" : "JSON (read only)"),
          ...(editable ? { "aria-multiline": "true", spellcheck: "false" } : {})
        })
      ]
    })
  });
  return {
    dom: view.dom,
    contentDom: view.contentDOM,
    editable,
    get scrollTop(): number {
      return view.scrollDOM.scrollTop;
    },
    set scrollTop(value: number) {
      view.scrollDOM.scrollTop = value;
    },
    get hasFocus(): boolean {
      return view.hasFocus;
    },
    getText: () => view.state.doc.toString(),
    setText(next: string): void {
      // One replacing change rather than a new state: the read-only facet stops the reader
      // editing, not the host, and a change keeps the scroll position where a rebuild would not.
      const current = view.state.doc;
      if (current.toString() === next) {
        return;
      }
      view.dispatch({ changes: { from: 0, to: current.length, insert: next }, annotations: mark.of("set") });
      history?.reset();
    },
    focus(offset?: number): void {
      if (offset !== undefined) {
        const at = Math.max(0, Math.min(offset, view.state.doc.length));
        view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      }
      view.focus();
    },
    destroy(): void {
      destroyed = true;
      view.destroy();
    }
  };
}
