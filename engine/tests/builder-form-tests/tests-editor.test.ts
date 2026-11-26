// @vitest-environment jsdom
/**
 * The CodeMirror test editor: mounted in jsdom, which lays
 * nothing out, so the checks are about the document, the decorations, the gutter and the
 * callbacks, not the geometry. Rects on a Range and `execCommand` are stubbed the way the formula
 * editor's tests stub them, since CodeMirror asks for both once it has a caret to place. The
 * suggestion source is called directly with a `CompletionContext`, as the formula editor's tests
 * do, so no popover is needed.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CompletionContext, type Completion, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { createTestsCompletions } from "../../form-engine/builder/form-tests/tests-completions.js";
import { mountTestsEditor, testsCompletionSource } from "../../form-engine/builder/form-tests/tests-editor.js";
import { loadTestsEditor } from "../../form-engine/builder/form-tests/tests-editor-loader.js";
import type { TestsEditor, TestsEditorOptions } from "../../form-engine/builder/form-tests/tests-model.js";
import { lineStartOffset, SHOWN_CLASS, type TestsInsertLineOptions } from "../../form-engine/builder/form-tests/tests-textarea.js";
import { FORM_TESTS_FIXTURE } from "../form-tests/fixtures/form-tests-fixture.js";

const SOURCE = ['test "Name is required"', '  set applicant_name = "Ana"  # a note', "  expect applicant_name required", "  submit"].join("\n");

const lists = createTestsCompletions(
  () => FORM_TESTS_FIXTURE.root,
  () => FORM_TESTS_FIXTURE,
  () => ["server.refused"]
);

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("the CodeMirror test editor", () => {
  const restore: Array<() => void> = [];
  const mounted: TestsEditor[] = [];
  let host: HTMLElement;

  beforeAll(() => {
    const range = Range.prototype as unknown as Record<string, unknown>;
    for (const name of ["getClientRects", "getBoundingClientRect"]) {
      if (typeof range[name] !== "function") {
        range[name] = name === "getClientRects" ? () => [] : () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
        restore.push(() => delete range[name]);
      }
    }
    const document_ = document as unknown as Record<string, unknown>;
    if (typeof document_.execCommand !== "function") {
      document_.execCommand = () => false;
      restore.push(() => delete document_.execCommand);
    }
    return () => {
      for (const undo of restore.splice(0)) {
        undo();
      }
    };
  });

  afterEach(() => {
    for (const editor of mounted.splice(0)) {
      editor.destroy();
    }
    host.remove();
  });

  const mount = (overrides: Partial<TestsEditorOptions> = {}): TestsEditor => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const editor = mountTestsEditor(host, {
      text: SOURCE,
      completions: lists,
      words: undefined,
      ariaLabel: "Test source",
      onChange: () => undefined,
      ...overrides
    });
    mounted.push(editor);
    return editor;
  };
  const contentOf = (editor: TestsEditor): HTMLElement => editor.element.querySelector(".cm-content") as HTMLElement;
  const viewOf = (editor: TestsEditor): EditorView => EditorView.findFromDOM(editor.element) as EditorView;

  /** The options the source offers for `doc` with the caret at its end, or null. */
  const suggest = (doc: string, explicit = false): CompletionResult | null => {
    const source = testsCompletionSource({ lists: () => lists, words: undefined });
    const state = EditorState.create({ doc });
    return source(new CompletionContext(state, doc.length, explicit)) as CompletionResult | null;
  };
  const labels = (result: CompletionResult | null): string[] => (result?.options ?? []).map((option) => option.label);
  const shown = (result: CompletionResult | null): string[] => (result?.options ?? []).map((option) => option.displayLabel ?? option.label);

  it("mounts over the text, named for assistive technology", () => {
    const editor = mount();
    expect(host.contains(editor.element)).toBe(true);
    expect(editor.element.getAttribute("data-tests-editor")).toBe("codemirror");
    expect(editor.getText()).toBe(SOURCE);
    const content = contentOf(editor);
    expect(content.getAttribute("aria-label")).toBe("Test source");
    expect(content.getAttribute("aria-multiline")).toBe("true");
    expect(content.getAttribute("spellcheck")).toBe("false");
    // The scroller's focusable content, said outright for axe's scrollable-region-focusable.
    expect(content.getAttribute("tabindex")).toBe("0");
    expect(editor.element.querySelectorAll(".cm-line")).toHaveLength(4);
  });

  it("colours the language's words", () => {
    const editor = mount();
    const lines = [...editor.element.querySelectorAll(".cm-line")];
    expect(lines[0]?.querySelector(".t-kw")?.textContent).toBe("test");
    expect(lines[0]?.querySelector(".t-str")?.textContent).toBe('"Name is required"');
    expect(lines[1]?.querySelector(".t-kw")?.textContent).toBe("set");
    expect(lines[1]?.querySelector(".t-path")?.textContent).toBe("applicant_name");
    expect(lines[1]?.querySelector(".t-cm")?.textContent).toBe("# a note");
    expect(lines[2]?.querySelectorAll(".t-kw")).toHaveLength(2);
    expect(lines[2]?.querySelector(".t-path")?.textContent).toBe("applicant_name");
    expect(lines[3]?.querySelector(".t-kw")?.textContent).toBe("submit");
  });

  it("reads a name after set as a path even when it spells a keyword, and a code after the colon", () => {
    const editor = mount({ text: "test \"x\"\n  set page = 3\n  expect error on page: required\n  expect age = 5\n  expect age in (1, 2) and TRUE" });
    const lines = [...editor.element.querySelectorAll(".cm-line")];
    expect(lines[1]?.querySelector(".t-path")?.textContent).toBe("page");
    expect(lines[1]?.querySelector(".t-num")?.textContent).toBe("3");
    expect(lines[2]?.querySelector(".t-code")?.textContent).toBe("required");
    expect(lines[3]?.querySelector(".t-num")?.textContent).toBe("5");
    expect(lines[4]?.querySelectorAll(".t-kw").length).toBeGreaterThanOrEqual(3);
  });

  it("reads a name after change as a path even when it spells a keyword", () => {
    const editor = mount({ text: "test \"x\"\n  change page\n  change errors" });
    const lines = [...editor.element.querySelectorAll(".cm-line")];
    expect(lines[1]?.querySelector(".t-kw")?.textContent).toBe("change");
    expect(lines[1]?.querySelector(".t-path")?.textContent).toBe("page");
    expect(lines[2]?.querySelector(".t-path")?.textContent).toBe("errors");
  });

  it("offers the statements at a line's start on a letter, and not on bare indentation", () => {
    expect(suggest("  ")).toBeNull();
    const typed = suggest("  s");
    expect(labels(typed)).toEqual(expect.arrayContaining(["set", "skip", "submit", "expect", "add row to", "go to"]));
    expect(typed?.from).toBe(2);
    expect(labels(suggest("  ", true))).toContain("set");
  });

  it("offers the fixture's fields by label after set, inserting the value path", () => {
    const result = suggest("set ");
    expect(shown(result)).toEqual(expect.arrayContaining(["Name", "Age", "Topics", "Quantity"]));
    const name = result?.options.find((option) => option.displayLabel === "Name") as Completion;
    expect(name.apply).toBe("applicant_name");
    expect(name.detail).toBe("applicant_name");
    expect(name.label).toContain("Name");
    const row = result?.options.find((option) => option.displayLabel === "Quantity") as Completion;
    expect(row.apply).toBe("items[0].qty");
    expect(row.info).toContain("items");
    expect(result?.from).toBe(4);
  });

  it("filters nothing itself but starts the list where the typed word starts", () => {
    const result = suggest("set app");
    expect(result?.from).toBe(4);
    expect(shown(result)).toContain("Name");
  });

  it("offers only the repeating sections after rows of, the row's keys after with", () => {
    expect(shown(suggest("expect rows of "))).toEqual(["Items"]);
    expect(labels(suggest("add row to items with "))).toEqual(["Quantity qty"]);
    expect((suggest("add row to items with ")?.options[0] as Completion).apply).toBe("qty");
  });

  it("offers pages, layouts, journeys and codes where the line asks for them", () => {
    expect(labels(suggest("go to "))).toEqual(expect.arrayContaining(["Name intro", "Not eligible stop"]));
    expect(labels(suggest("expect layout = "))).toEqual(expect.arrayContaining(["standard", "pets"]));
    expect(labels(suggest("given journey = "))).toEqual(expect.arrayContaining(["main", "none"]));
    const codes = labels(suggest("expect error on email: "));
    expect(codes).toEqual(expect.arrayContaining(["required", "rule", "rows.min", "option.notAllowed", "server.refused"]));
  });

  it("offers a page as a page-on-path lead right after expect", () => {
    const result = suggest("expect ");
    const page = result?.options.find((option) => option.displayLabel === "Not eligible") as Completion;
    expect(page.detail).toBe("on path");
    expect(labels(result)).toEqual(expect.arrayContaining(["error on", "no errors", "accepted", "rows of"]));
  });

  it("offers the states and the comparison after the first word of an expect", () => {
    const result = suggest("expect applicant_name ");
    expect(labels(result)).toEqual(expect.arrayContaining(["visible", "hidden", "required", "not empty", "=", "!=", "withheld"]));
    expect(labels(result)).not.toContain("on path");
    const pageSide = suggest("expect intro ");
    expect(labels(pageSide)).toEqual(expect.arrayContaining(["on path", "off path"]));
    expect(labels(pageSide)).not.toContain("withheld");
  });

  it("suggests a value by the field's type after an equals sign", () => {
    expect(labels(suggest("set has_pet = "))).toEqual(expect.arrayContaining(["true", "false"]));
    expect(labels(suggest("set age = "))).toEqual(expect.arrayContaining(["0", "null"]));
    expect(labels(suggest("set applicant_name = "))).toEqual(expect.arrayContaining(['""', "null"]));
    expect(labels(suggest("given today = "))).toEqual(expect.arrayContaining(['@""']));
    const choice = suggest("set contact_method = ");
    expect(labels(choice)).toEqual(expect.arrayContaining(['"email"', '"phone"', '""']));
    expect((choice?.options.find((option) => option.label === '"phone"') as Completion).detail).toBe("Phone");
    const flags = suggest("set topics = ");
    expect(labels(flags)).toEqual(expect.arrayContaining(['("news")', '("offers")', '("events")', '("")']));
    const inList = suggest('set topics = ("news", ');
    expect(labels(inList)).toEqual(expect.arrayContaining(['"offers"', '"events"']));
    expect(labels(inList)).not.toContain('("offers")');
    expect(labels(suggest("given options for province = "))).toEqual(['("")']);
  });

  it("offers a choice's options inside an open string, and nothing else in a string", () => {
    const inString = suggest('set contact_method = "e');
    expect(labels(inString)).toEqual(["email", "phone"]);
    expect(inString?.from).toBe('set contact_method = "'.length);
    expect(suggest('test "Some na')).toBeNull();
    expect(suggest('expect message on email = "The ')).toBeNull();
  });

  it("completes an option inside a string by adding the closing quote only when it is missing", () => {
    const result = suggest('set contact_method = "e');
    const option = result?.options.find((entry) => entry.label === "email") as Completion;
    const apply = option.apply as (view: EditorView, completion: Completion, from: number, to: number) => void;
    const view = new EditorView({ state: EditorState.create({ doc: 'set contact_method = "e' }), parent: document.body });
    apply(view, option, result?.from ?? 0, view.state.doc.length);
    expect(view.state.doc.toString()).toBe('set contact_method = "email"');
    view.destroy();
    const closed = new EditorView({ state: EditorState.create({ doc: 'set contact_method = "e"' }), parent: document.body });
    apply(closed, option, result?.from ?? 0, closed.state.doc.length - 1);
    expect(closed.state.doc.toString()).toBe('set contact_method = "email"');
    closed.destroy();
  });

  it("completes a statement word with its trailing space", () => {
    const result = suggest("  s");
    const option = result?.options.find((entry) => entry.label === "set") as Completion;
    const view = new EditorView({ state: EditorState.create({ doc: "  s" }), parent: document.body });
    (option.apply as (v: EditorView, c: Completion, from: number, to: number) => void)(view, option, result?.from ?? 0, 3);
    expect(view.state.doc.toString()).toBe("  set ");
    const done = result?.options.find((entry) => entry.label === "submit") as Completion;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "  s" } });
    (done.apply as (v: EditorView, c: Completion, from: number, to: number) => void)(view, done, 2, 3);
    expect(view.state.doc.toString()).toBe("  submit");
    view.destroy();
  });

  it("words the sections from the catalog, with a host's French over the English", () => {
    const source = testsCompletionSource({ lists: () => lists, words: { locale: "fr", catalog: { fr: { "tests.complete.section.fields": "Champs" } } } });
    const result = source(new CompletionContext(EditorState.create({ doc: "set " }), 4, false)) as CompletionResult;
    expect(result.options[0]?.section).toMatchObject({ name: "Champs" });
  });

  it("draws a mark and a line class for each setMarks entry", () => {
    const editor = mount();
    editor.setMarks([
      { line: 2, status: "passed" },
      { line: 3, status: "failed", message: "Expected Name to be optional; it is required." },
      { line: 4, status: "pending" }
    ]);
    const cells = [...editor.element.querySelectorAll<HTMLElement>(".tests-gutter .tests-cell")];
    expect(cells.map((cell) => cell.textContent)).toEqual(expect.arrayContaining(["1", "2", "3", "4"]));
    const byLine = (line: number): HTMLElement => cells.find((cell) => cell.getAttribute("data-line") === String(line)) as HTMLElement;
    expect(byLine(1).hasAttribute("data-status")).toBe(false);
    expect(byLine(2).getAttribute("data-status")).toBe("passed");
    expect(byLine(2).title).toBe("Passed");
    expect(byLine(3).getAttribute("data-status")).toBe("failed");
    expect(byLine(3).title).toBe("Expected Name to be optional; it is required.");
    expect(byLine(4).getAttribute("data-status")).toBe("pending");
    const lines = [...editor.element.querySelectorAll(".cm-line")];
    expect(lines[2]?.classList.contains("t-line-failed")).toBe(true);
    expect(lines[1]?.classList.contains("t-line-passed")).toBe(true);
    expect(lines[3]?.className).not.toContain("t-line-pending");
    editor.setMarks([]);
    expect(editor.element.querySelectorAll("[data-status]")).toHaveLength(0);
    expect([...editor.element.querySelectorAll(".cm-line")].some((line) => line.className.includes("t-line-"))).toBe(false);
  });

  it("draws the line Show me is on as a line decoration and a marked cell, whatever its status", () => {
    const editor = mount();
    editor.setMarks([
      { line: 2, status: "passed" },
      { line: 3, status: "failed", shown: true },
      { line: 4, status: "pending", shown: false }
    ]);
    const lines = [...editor.element.querySelectorAll(".cm-line")];
    expect(lines[2]?.classList.contains(SHOWN_CLASS)).toBe(true);
    expect(lines[2]?.classList.contains("t-line-failed")).toBe(true);
    expect(lines[1]?.classList.contains(SHOWN_CLASS)).toBe(false);
    const cell = editor.element.querySelector<HTMLElement>('.tests-gutter .tests-cell[data-line="3"]')!;
    expect(cell.classList.contains(SHOWN_CLASS)).toBe(true);
    // The gutter is hidden from assistive technology: the mark is a look, the panel's live region names the line.
    expect(cell.hasAttribute("aria-label")).toBe(false);
    expect(cell.closest("[aria-hidden='true']")).not.toBeNull();
    // A pending line can be the one shown too (an unrun step after a failure is not, but the mark does not care).
    editor.setMarks([{ line: 4, status: "pending", shown: true }]);
    expect([...editor.element.querySelectorAll(".cm-line")][3]?.classList.contains(SHOWN_CLASS)).toBe(true);
    editor.setMarks([]);
    expect(editor.element.querySelectorAll(`.${SHOWN_CLASS}`)).toHaveLength(0);
  });

  it("inserts after a named line without taking the focus (Record)", async () => {
    const onChange = vi.fn();
    const editor = mount({ onChange });
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const insert = editor.insertLine as (text: string, options?: TestsInsertLineOptions) => void;
    insert("continue", { afterLine: 2, focus: false });
    expect(editor.getText().split("\n")[2]).toBe("  continue");
    expect(document.activeElement).toBe(outside);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    outside.remove();
  });

  it("draws the parser's problems as diagnostics in the text, and flags their lines", async () => {
    const editor = mount();
    const start = lineStartOffset(SOURCE, 3) + 9;
    editor.setProblems([{ line: 3, start, end: start + 14, message: "Unknown field.", severity: "error" }, { line: 4, start: SOURCE.length - 6, end: SOURCE.length, message: "Careful.", severity: "warning" }]);
    await flush();
    expect(editor.element.querySelector(".cm-lintRange-error")?.textContent).toBe("applicant_name");
    expect(editor.element.querySelector(".cm-lintRange-warning")).not.toBeNull();
    const flagged = [...editor.element.querySelectorAll<HTMLElement>(".tests-cell[data-problem]")].map((cell) => `${cell.getAttribute("data-line")}:${cell.getAttribute("data-problem")}`);
    expect(flagged).toEqual(["3:error", "4:warning"]);
    expect(contentOf(editor).getAttribute("aria-invalid")).toBe("true");
    editor.setProblems([]);
    await flush();
    expect(editor.element.querySelector(".cm-lintRange-error")).toBeNull();
    expect(contentOf(editor).hasAttribute("aria-invalid")).toBe(false);
  });

  it("clamps a problem past the end of the text instead of throwing", () => {
    const editor = mount();
    expect(() => editor.setProblems([{ line: 9, start: 5000, end: 6000, message: "Gone.", severity: "error" }])).not.toThrow();
  });

  it("hands over the text after an edit and not after setText", async () => {
    const onChange = vi.fn();
    const editor = mount({ onChange });
    const view = viewOf(editor);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n  expect accepted" }, userEvent: "input.type" });
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(SOURCE + "\n  expect accepted");
    editor.setText("test \"other\"");
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe('test "other"');
  });

  it("keeps the caret on its line across setText when asked", () => {
    const editor = mount();
    const view = viewOf(editor);
    view.dispatch({ selection: { anchor: lineStartOffset(SOURCE, 3) + 4 } });
    expect(editor.caretLine()).toBe(3);
    const next = SOURCE.replace("submit", "submit\n  expect accepted");
    editor.setText(next, { keepCaret: true });
    expect(editor.caretLine()).toBe(3);
    expect(view.state.selection.main.head).toBe(lineStartOffset(next, 3) + 4);
    editor.setText("a\nb");
    expect(view.state.selection.main.head).toBe(3);
  });

  it("inserts a statement after the caret's line, indented like its neighbours, and puts the caret on it", async () => {
    const onChange = vi.fn();
    const editor = mount({ onChange });
    const view = viewOf(editor);
    view.dispatch({ selection: { anchor: lineStartOffset(SOURCE, 3) + 2 } });
    editor.insertLine("expect age visible");
    expect(editor.getText()).toBe(['test "Name is required"', '  set applicant_name = "Ana"  # a note', "  expect applicant_name required", "  expect age visible", "  submit"].join("\n"));
    expect(editor.caretLine()).toBe(4);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(4).to);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("focuses with the caret at the start of the named line", () => {
    const editor = mount();
    editor.focus(3);
    expect(editor.caretLine()).toBe(3);
    expect(viewOf(editor).state.selection.main.head).toBe(lineStartOffset(SOURCE, 3));
    editor.focus(99);
    expect(editor.caretLine()).toBe(4);
    editor.focus(0);
    expect(editor.caretLine()).toBe(1);
  });

  it("calls onSubmit on Ctrl+Enter and Cmd+Enter", () => {
    const onSubmit = vi.fn();
    const editor = mount({ onSubmit });
    const content = contentOf(editor);
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("starts the next line indented like this one, two spaces under the header", () => {
    const editor = mount({ text: 'test "x"' });
    const view = viewOf(editor);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    contentOf(editor).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(editor.getText()).toBe('test "x"\n  ');
    contentOf(editor).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(editor.getText()).toBe('test "x"\n  \n  ');
  });

  it("goes back with undo to the text before an edit", () => {
    const editor = mount();
    const view = viewOf(editor);
    view.dispatch({ changes: { from: 0, insert: "# hi\n" }, userEvent: "input.paste" });
    expect(editor.getText().startsWith("# hi")).toBe(true);
    contentOf(editor).dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    contentOf(editor).dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
    expect(editor.getText()).toBe(SOURCE);
  });

  it("removes itself on destroy", () => {
    const editor = mount();
    editor.destroy();
    expect(host.contains(editor.element)).toBe(false);
  });

  it("is loaded once by the loader, which hands back the mount", async () => {
    const first = await loadTestsEditor();
    const second = await loadTestsEditor();
    expect(first).toBe(second);
    expect(first.mountTestsEditor).toBe(mountTestsEditor);
  });
});
