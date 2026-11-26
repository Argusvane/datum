// @vitest-environment jsdom
/**
 * The test editor's fallback: a textarea with a gutter, mounted
 * in jsdom, which lays nothing out, so the checks are about the document, the attributes and the
 * callbacks and not the geometry. The edit both editors share (`statementInsertion`) is checked
 * as pure text.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  lastFilledLine,
  lineEndOffset,
  mountTestsTextarea,
  statementInsertion,
  lineOfOffset,
  lineStartOffset,
  SHOWN_CLASS,
  TESTS_EDITOR_STYLES,
  TESTS_TEXTAREA_STYLES,
  type TestsInsertLineOptions
} from "../../form-engine/builder/form-tests/tests-textarea.js";
import type { TestsEditor, TestsEditorOptions } from "../../form-engine/builder/form-tests/tests-model.js";

const SOURCE = ['test "Name is required"', "  set applicant_name = \"Ana\"", "  expect applicant_name required", "  submit"].join("\n");

const COMPLETIONS: TestsEditorOptions["completions"] = { fields: () => [], pages: () => [], journeys: () => [], layouts: () => [], codes: () => [] };

describe("the fallback test editor", () => {
  const mounted: TestsEditor[] = [];
  let host: HTMLElement;

  const mount = (overrides: Partial<TestsEditorOptions> = {}): TestsEditor => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const editor = mountTestsTextarea(host, {
      text: SOURCE,
      completions: COMPLETIONS,
      words: undefined,
      ariaLabel: "Test source",
      onChange: () => undefined,
      ...overrides
    });
    mounted.push(editor);
    return editor;
  };
  const textareaOf = (editor: TestsEditor): HTMLTextAreaElement => editor.element.querySelector("textarea") as HTMLTextAreaElement;
  const cellsOf = (editor: TestsEditor): HTMLElement[] => [...editor.element.querySelectorAll<HTMLElement>(".tests-gutter .tests-cell")];

  afterEach(() => {
    for (const editor of mounted.splice(0)) {
      editor.destroy();
    }
    host.remove();
  });

  it("grows the gutter's foot by a horizontal scrollbar's height, so the last lines stay level", () => {
    const editor = mount();
    const textarea = textareaOf(editor);
    const gutter = editor.element.querySelector<HTMLElement>(".tests-gutter")!;
    expect(gutter.style.paddingBottom).toBe("8px");
    // jsdom lays nothing out: the scrollbar is the box's outer height less its inner one.
    Object.defineProperty(textarea, "offsetHeight", { configurable: true, value: 117 });
    Object.defineProperty(textarea, "clientHeight", { configurable: true, value: 100 });
    textarea.dispatchEvent(new Event("scroll"));
    expect(gutter.style.paddingBottom).toBe("25px");
  });

  it("mounts a monospace-ready, spell-check-free textarea with its accessible name and a hidden gutter", () => {
    const editor = mount();
    const textarea = textareaOf(editor);
    expect(host.contains(editor.element)).toBe(true);
    expect(editor.element.getAttribute("data-tests-editor")).toBe("textarea");
    expect(textarea.getAttribute("aria-label")).toBe("Test source");
    expect(textarea.getAttribute("spellcheck")).toBe("false");
    expect(textarea.getAttribute("wrap")).toBe("off");
    expect(textarea.value).toBe(SOURCE);
    const gutter = editor.element.querySelector(".tests-gutter") as HTMLElement;
    expect(gutter.getAttribute("aria-hidden")).toBe("true");
    expect(editor.getText()).toBe(SOURCE);
  });

  it("numbers every line with one cell each, and grows its rows between a floor and a ceiling", () => {
    const editor = mount();
    expect(cellsOf(editor).map((cell) => cell.textContent)).toEqual(["1", "2", "3", "4"]);
    expect(textareaOf(editor).rows).toBe(8);
    editor.setText(Array.from({ length: 40 }, (_, i) => `# ${String(i)}`).join("\n"));
    expect(cellsOf(editor)).toHaveLength(40);
    expect(textareaOf(editor).rows).toBe(24);
  });

  it("replaces the text without calling onChange, and keeps the caret on its line when asked", () => {
    const onChange = vi.fn();
    const editor = mount({ onChange });
    const textarea = textareaOf(editor);
    const caret = lineStartOffset(SOURCE, 3) + 4;
    textarea.setSelectionRange(caret, caret);
    expect(editor.caretLine()).toBe(3);
    const next = SOURCE.replace("submit", "submit\n  expect accepted");
    editor.setText(next, { keepCaret: true });
    expect(editor.getText()).toBe(next);
    expect(editor.caretLine()).toBe(3);
    expect(textarea.selectionStart).toBe(lineStartOffset(next, 3) + 4);
    editor.setText("short");
    expect(textarea.selectionStart).toBe(5);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clamps the kept caret to the shorter line", () => {
    const editor = mount();
    const textarea = textareaOf(editor);
    const caret = lineStartOffset(SOURCE, 2) + 20;
    textarea.setSelectionRange(caret, caret);
    editor.setText('test "x"\n  a\n  b', { keepCaret: true });
    expect(editor.caretLine()).toBe(2);
    expect(textarea.selectionStart).toBe(lineStartOffset('test "x"\n  a\n  b', 2) + 3);
  });

  it("calls onChange with the whole text on every input, and redraws the gutter when a line is added", () => {
    const onChange = vi.fn();
    const editor = mount({ onChange });
    const textarea = textareaOf(editor);
    textarea.value = SOURCE + "\n  expect accepted";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(SOURCE + "\n  expect accepted");
    expect(cellsOf(editor)).toHaveLength(5);
  });

  it("calls onSubmit on Ctrl+Enter and Cmd+Enter and not on a plain Enter", () => {
    const onSubmit = vi.fn();
    const editor = mount({ onSubmit });
    const textarea = textareaOf(editor);
    const press = (init: KeyboardEventInit): boolean => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
    expect(press({})).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(press({ ctrlKey: true })).toBe(false);
    expect(press({ metaKey: true })).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("does not throw on Ctrl+Enter without an onSubmit", () => {
    const editor = mount();
    expect(() => textareaOf(editor).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))).not.toThrow();
  });

  it("inserts a statement after the caret's line, indented like its neighbours, and moves the caret to it", () => {
    const onChange = vi.fn();
    const editor = mount({ onChange });
    const textarea = textareaOf(editor);
    const caret = lineStartOffset(SOURCE, 3) + 2;
    textarea.setSelectionRange(caret, caret);
    editor.insertLine("expect age visible");
    expect(editor.getText()).toBe(['test "Name is required"', '  set applicant_name = "Ana"', "  expect applicant_name required", "  expect age visible", "  submit"].join("\n"));
    expect(editor.caretLine()).toBe(4);
    expect(textarea.selectionStart).toBe(textarea.value.indexOf("\n  submit"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(cellsOf(editor)).toHaveLength(5);
  });

  it("puts a statement directly under the test header, indented like the first body line", () => {
    const editor = mount();
    textareaOf(editor).setSelectionRange(2, 2);
    editor.insertLine("given today = @\"2026-01-31\"");
    expect(editor.getText().split("\n").slice(0, 3)).toEqual(['test "Name is required"', '  given today = @"2026-01-31"', '  set applicant_name = "Ana"']);
  });

  it("inserts after a named line without taking the focus (Record)", () => {
    const onChange = vi.fn();
    const editor = mount({ onChange, text: `${SOURCE}\n  \n` });
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const insert = editor.insertLine as (text: string, options?: TestsInsertLineOptions) => void;
    insert("continue", { afterLine: lastFilledLine(editor.getText()), focus: false });
    insert("check", { afterLine: lastFilledLine(editor.getText()), focus: false });
    expect(editor.getText()).toBe(`${SOURCE}\n  continue\n  check\n  \n`);
    expect(document.activeElement).toBe(outside);
    expect(onChange).toHaveBeenCalledTimes(2);
    outside.remove();
  });

  it("finds the last filled line and a line's end", () => {
    expect(lastFilledLine("test \"a\"\n  set x = 1\n  \n\n")).toBe(2);
    expect(lastFilledLine("   \n")).toBe(1);
    expect(lineEndOffset("ab\r\ncd", 1)).toBe(2);
    expect(lineEndOffset("ab\ncd", 2)).toBe(5);
  });

  it("marks the line Show me is on, besides its status, as a look only (the panel names it)", () => {
    const editor = mount();
    editor.setMarks([
      { line: 2, status: "passed" },
      { line: 3, status: "failed", shown: true }
    ]);
    const cells = cellsOf(editor);
    expect(cells[2]?.classList.contains(SHOWN_CLASS)).toBe(true);
    expect(cells[2]?.getAttribute("data-status")).toBe("failed");
    expect(cells[2]?.hasAttribute("aria-label")).toBe(false);
    expect(cells[2]?.closest("[aria-hidden='true']")).not.toBeNull();
    expect(cells[1]?.classList.contains(SHOWN_CLASS)).toBe(false);
    editor.setMarks([{ line: 2, status: "passed" }, { line: 3, status: "failed" }]);
    expect(cellsOf(editor).some((cell) => cell.classList.contains(SHOWN_CLASS))).toBe(false);
    expect(TESTS_TEXTAREA_STYLES).toContain(`.tests-cell.${SHOWN_CLASS}`);
    expect(TESTS_EDITOR_STYLES).toContain(`.cm-line.${SHOWN_CLASS}`);
  });

  it("draws one cell per line with the step's status, a title and the pending mark", () => {
    const editor = mount();
    editor.setMarks([
      { line: 2, status: "passed" },
      { line: 3, status: "failed", message: "Expected Name to be optional; it is required." },
      { line: 4, status: "pending" },
      { line: 99, status: "failed" }
    ]);
    const cells = cellsOf(editor);
    expect(cells).toHaveLength(4);
    expect(cells[0]?.hasAttribute("data-status")).toBe(false);
    expect(cells[1]?.getAttribute("data-status")).toBe("passed");
    expect(cells[1]?.title).toBe("Passed");
    expect(cells[2]?.getAttribute("data-status")).toBe("failed");
    expect(cells[2]?.title).toBe("Expected Name to be optional; it is required.");
    expect(cells[3]?.getAttribute("data-status")).toBe("pending");
    editor.setMarks([]);
    expect(cellsOf(editor).some((cell) => cell.hasAttribute("data-status"))).toBe(false);
  });

  it("describes the problems for assistive technology and flags their lines, drawing no list itself", () => {
    const editor = mount();
    const textarea = textareaOf(editor);
    editor.setProblems([
      { line: 2, start: 10, end: 14, message: "Expected a value.", severity: "error" },
      { line: 3, start: 40, end: 44, message: "Unknown field.", severity: "warning" }
    ]);
    const describedBy = textarea.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const note = editor.element.querySelector(`#${describedBy as string}`) as HTMLElement;
    expect(note.textContent).toBe("Line 2: Expected a value. Line 3: Unknown field.");
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(cellsOf(editor)[1]?.getAttribute("data-problem")).toBe("error");
    expect(cellsOf(editor)[2]?.getAttribute("data-problem")).toBe("warning");
    editor.setProblems([]);
    expect(textarea.hasAttribute("aria-describedby")).toBe(false);
    expect(textarea.hasAttribute("aria-invalid")).toBe(false);
  });

  it("focuses with the caret at the start of the named line", () => {
    const editor = mount();
    const textarea = textareaOf(editor);
    editor.focus(3);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(lineStartOffset(SOURCE, 3));
    expect(editor.caretLine()).toBe(3);
    editor.focus();
    expect(document.activeElement).toBe(textarea);
  });

  it("removes itself on destroy", () => {
    const editor = mount();
    editor.destroy();
    expect(host.contains(editor.element)).toBe(false);
  });

  it("exports the sheets the panel appends, with no literal colour in either", () => {
    for (const sheet of [TESTS_TEXTAREA_STYLES, TESTS_EDITOR_STYLES]) {
      expect(sheet).toContain("--db-");
      expect(sheet).not.toContain("`");
      expect(sheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

describe("statementInsertion", () => {
  const insert = (text: string, caret: number, statement: string): string => {
    const edit = statementInsertion(text, caret, statement);
    return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  };

  it("indents under the header with two spaces when nothing else is there", () => {
    expect(insert('test "x"', 3, "submit")).toBe('test "x"\n  submit');
  });

  it("fills a blank line instead of leaving a gap", () => {
    const text = 'test "x"\n  set a = 1\n\n  submit';
    expect(insert(text, text.indexOf("\n\n") + 1, "expect a = 1")).toBe('test "x"\n  set a = 1\n  expect a = 1\n  submit');
  });

  it("matches the neighbours' indentation, whatever it is", () => {
    expect(insert('test "x"\n\tset a = 1', 12, "submit")).toBe('test "x"\n\tset a = 1\n\tsubmit');
  });

  it("never indents a statement that starts a test", () => {
    expect(insert('test "x"\n  submit', 14, 'test "y"')).toBe('test "x"\n  submit\ntest "y"');
  });

  it("stands alone in an empty text", () => {
    expect(insert("", 0, 'test "x"')).toBe('test "x"');
    expect(insert("\n\n", 1, 'test "x"')).toBe('test "x"');
  });

  it("keeps the text's own line ending and lands the caret at the end of the new statement", () => {
    const text = 'test "x"\r\n  set a = 1';
    const edit = statementInsertion(text, 3, "submit");
    expect(text.slice(0, edit.from) + edit.insert + text.slice(edit.to)).toBe('test "x"\r\n  submit\r\n  set a = 1');
    expect(edit.caret).toBe('test "x"\r\n  submit'.length);
  });

  it("counts lines the way the parser does", () => {
    expect(lineOfOffset("a\nb\nc", 0)).toBe(1);
    expect(lineOfOffset("a\nb\nc", 2)).toBe(2);
    expect(lineOfOffset("a\nb\nc", 99)).toBe(3);
    expect(lineStartOffset("a\nb\nc", 3)).toBe(4);
    expect(lineStartOffset("a\nb\nc", 9)).toBe(4);
  });
});
