// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { FORMULA_FUNCTION_ROWS, FORMULA_SNIPPETS, type FormulaSnippet } from "../form-engine/builder/formula/feel-functions.js";
import type { FormulaField } from "../form-engine/builder/formula/formula-fields.js";
import { SLOW_FACTOR } from "./slow-machine.js";
import {
  formulaEditorState,
  mountFormulaTextarea,
  snippetInsertion,
  type FormulaEditor,
  type FormulaEditorOptions,
  type FormulaEditorState
} from "../form-engine/builder/formula/formula-textarea.js";

const fields: FormulaField[] = [
  { path: "province", label: "Province", componentId: "province", kind: "choice", options: [{ value: "QC", label: "Quebec" }] },
  { path: "employees", label: "Number of employees", componentId: "employees", kind: "number", options: [] },
  { path: "total", label: "Total", componentId: "total", kind: "number", options: [] },
  { path: "tax", label: "Tax", componentId: "tax", kind: "number", options: [] }
];

const signatures = formulaFunctionSignatures();

describe("formulaEditorState", () => {
  const state = (text: string, scopes?: string[]): FormulaEditorState => formulaEditorState(text, { fields, signatures, scopes });

  it("words a parse error from the catalog with its span", () => {
    const result = state("employees > ");
    expect(result.parsed.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: "parse", message: "A value is missing at the end of the formula.", start: 12, end: 12 }]);
    expect(state("sum(1").problems[0]?.message).toBe('Missing "," or ")" at the end of the formula.');
    expect(state("foo(1)").problems[0]?.message).toBe("No function is called foo.");
    expect(state("abs(1, 2)").problems[0]?.message).toBe("abs takes 1 argument, not 2.");
    expect(state("substring(1)").problems[0]?.message).toBe("substring takes 2 to 3 arguments, not 1.");
  });

  it("flags unknown fields with the nearest label, in text order", () => {
    const result = state('provnce = "QC" and employes > 1');
    expect(result.parsed.ok).toBe(true);
    expect(result.problems).toEqual([
      { kind: "unknownField", message: "No field is called provnce. Did you mean Province?", start: 0, end: 7, suggestion: "province" },
      { kind: "unknownField", message: "No field is called employes. Did you mean Number of employees?", start: 19, end: 27, suggestion: "employees" }
    ]);
    expect(state("zebra > 1").problems[0]).toEqual({ kind: "unknownField", message: "No field is called zebra.", start: 0, end: 5 });
  });

  it("hints at spaces when a hyphenated name splits into two fields", () => {
    expect(state("total-tax > 0").problems).toEqual([
      { kind: "unknownField", message: "Write total - tax with spaces to subtract.", start: 0, end: 9, suggestion: "total - tax" }
    ]);
    expect(state("total - tax > 0").problems).toEqual([]);
  });

  it("accepts scoped paths, only the listed scopes when given", () => {
    expect(state("row.amount > host.limit and component and ancestor.x").problems).toEqual([]);
    expect(state("row.amount > host.limit", ["row."]).problems.map((problem) => problem.message)).toEqual(["No field is called host.limit."]);
    expect(state("component.value = 1", ["component"]).problems).toEqual([]);
  });

  it("accepts a value under a field and the field's exact id", () => {
    expect(state("province.label = 1 and `province` = 2").problems).toEqual([]);
  });

  it("parses blank text as no expression", () => {
    const result = state("   ");
    expect(result.parsed).toEqual({ ok: true, expression: undefined, paths: [] });
    expect(result.problems).toEqual([]);
  });
});

describe("snippetInsertion", () => {
  it("fills the blanks with their names and selects the first", () => {
    const anyOf = FORMULA_SNIPPETS.find((entry) => entry.id === "anyOf") as FormulaSnippet;
    expect(snippetInsertion(anyOf)).toEqual({ text: "field in (a, b)", selectStart: 0, selectEnd: 5 });
    const weekend = FORMULA_SNIPPETS.find((entry) => entry.id === "weekend") as FormulaSnippet;
    expect(snippetInsertion(weekend)).toEqual({ text: "isWeekend(date)", selectStart: 10, selectEnd: 14 });
    expect(snippetInsertion({ id: "x", group: "plugin", labelKey: "snippet.group.plugin", insert: "today()", blanks: [], preview: "today()" })).toEqual({
      text: "today()",
      selectStart: 7,
      selectEnd: 7
    });
  });
});

describe("mountFormulaTextarea", () => {
  let editor: FormulaEditor | undefined;
  afterEach(() => {
    editor?.destroy();
    editor = undefined;
    document.body.replaceChildren();
  });

  const mount = (overrides: Partial<FormulaEditorOptions> = {}): { editor: FormulaEditor; onChange: ReturnType<typeof vi.fn>; onCommit: ReturnType<typeof vi.fn> } => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = mountFormulaTextarea(parent, {
      text: "",
      label: "Formula",
      fields,
      functions: [...FORMULA_FUNCTION_ROWS],
      signatures,
      onChange,
      onCommit,
      ...overrides
    });
    return { editor, onChange, onCommit };
  };

  const textarea = (current: FormulaEditor): HTMLTextAreaElement => current.contentDom as HTMLTextAreaElement;

  const type = (current: FormulaEditor, text: string): void => {
    const box = textarea(current);
    box.value = text;
    box.setSelectionRange(text.length, text.length);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("mounts a labelled textarea under the parent with the placeholder and no problems", () => {
    const { editor: current } = mount();
    expect(current.dom.parentElement?.tagName).toBe("DIV");
    const box = textarea(current);
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.getAttribute("aria-label")).toBe("Formula");
    expect(box.getAttribute("placeholder")).toBe("Type a field name, or pick one with + Field");
    expect(box.getAttribute("aria-multiline")).toBeNull();
    expect(box.rows).toBe(1);
    expect(current.dom.querySelector(".formula-problems")?.hasAttribute("hidden")).toBe(true);
    expect(box.getAttribute("aria-describedby")).toBe(current.dom.querySelector(".formula-problems")?.id);
    expect(current.getText()).toBe("");
  });

  it("shows the initial text's problems at mount", () => {
    const { editor: current } = mount({ text: "provnce = 1" });
    const lines = [...current.dom.querySelectorAll(".problem")].map((line) => line.textContent);
    expect(lines).toEqual(["No field is called provnce. Did you mean Province?"]);
    expect(textarea(current).getAttribute("aria-invalid")).toBeNull();
  });

  it("reports every edit through onChange with the state, problems under the box", () => {
    const { editor: current, onChange, onCommit } = mount();
    type(current, "employees >");
    expect(onChange).toHaveBeenCalledTimes(1);
    const [text, state] = onChange.mock.calls[0] as [string, FormulaEditorState];
    expect(text).toBe("employees >");
    expect(state.parsed.ok).toBe(false);
    expect(state.problems[0]?.kind).toBe("parse");
    expect(textarea(current).getAttribute("aria-invalid")).toBe("true");
    expect(current.dom.querySelector(".problem")?.textContent).toBe("A value is missing at the end of the formula.");
    expect(current.dom.querySelector(".problem")?.getAttribute("data-kind")).toBe("parse");
    expect(onCommit).not.toHaveBeenCalled();
    type(current, "employees > 1");
    expect(textarea(current).getAttribute("aria-invalid")).toBeNull();
    expect(current.dom.querySelector(".formula-problems")?.hasAttribute("hidden")).toBe(true);
  });

  it("commits on blur and on Enter in a single-line box", () => {
    const { editor: current, onCommit } = mount({ text: "employees > 1" });
    const box = textarea(current);
    box.dispatchEvent(new Event("blur"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toBe("employees > 1");
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    box.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(2);
    const other = new KeyboardEvent("keydown", { key: "a", cancelable: true });
    box.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("lets Enter through in a multiline box and commits on Ctrl+Enter", () => {
    const { editor: current, onCommit } = mount({ multiline: true, text: "if a then 1" });
    const box = textarea(current);
    expect(box.getAttribute("aria-multiline")).toBe("true");
    expect(box.rows).toBe(3);
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    box.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    const commit = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, cancelable: true });
    box.dispatchEvent(commit);
    expect(commit.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("setText is not an edit: no callback, problems refreshed", () => {
    const { editor: current, onChange, onCommit } = mount();
    current.setText("zebra > 1");
    expect(current.getText()).toBe("zebra > 1");
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(current.dom.querySelector(".problem")?.textContent).toBe("No field is called zebra.");
  });

  it("setFields re-reads the unknown fields without a callback", () => {
    const { editor: current, onChange } = mount({ text: "zebra > 1" });
    expect(current.dom.querySelectorAll(".problem")).toHaveLength(1);
    current.setFields([...fields, { path: "zebra", label: "Zebra", kind: "text", options: [] }]);
    expect(current.dom.querySelectorAll(".problem")).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("inserts a snippet at the caret with its first blank selected, as an edit", () => {
    const { editor: current, onChange } = mount({ text: "employees > 1 and " });
    const box = textarea(current);
    box.setSelectionRange(box.value.length, box.value.length);
    const isEmpty = FORMULA_SNIPPETS.find((entry) => entry.id === "isEmpty") as FormulaSnippet;
    current.insertSnippet(isEmpty);
    expect(current.getText()).toBe("employees > 1 and empty(field)");
    expect(box.selectionStart).toBe("employees > 1 and empty(".length);
    expect(box.selectionEnd).toBe("employees > 1 and empty(field".length);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("inserts text over the selection and leaves the caret after it", () => {
    const { editor: current, onChange } = mount({ text: "x > 1" });
    const box = textarea(current);
    box.setSelectionRange(0, 1);
    current.insertText("`my field`");
    expect(current.getText()).toBe("`my field` > 1");
    expect(box.selectionStart).toBe(10);
    expect(box.selectionEnd).toBe(10);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(current.dom.querySelector(".problem")?.textContent).toBe("No field is called my field.");
  });

  it("focuses the box and reports hasFocus", () => {
    const { editor: current } = mount();
    expect(current.hasFocus).toBe(false);
    current.focus();
    expect(current.hasFocus).toBe(true);
    expect(document.activeElement).toBe(current.contentDom);
  });

  it("destroy removes the box and its listeners", () => {
    const { editor: current, onChange } = mount();
    const parent = current.dom.parentElement as HTMLElement;
    const box = textarea(current);
    current.destroy();
    expect(parent.childElementCount).toBe(0);
    box.value = "a";
    box.dispatchEvent(new Event("input"));
    expect(onChange).not.toHaveBeenCalled();
    editor = undefined;
  });

  it("words problems in the host's locale from its catalog", () => {
    const { editor: current } = mount({
      text: "zebra > 1",
      locale: "fr",
      catalog: { fr: { "formula.unknownField": "Aucun champ ne s'appelle {name}." } }
    });
    expect(current.dom.querySelector(".problem")?.textContent).toBe("Aucun champ ne s'appelle zebra.");
  });
});

describe("formulaEditorState: a formula full of unknown names", () => {
  const many: FormulaField[] = Array.from({ length: 300 }, (_, index) => ({
    path: `field_number_${String(index)}`,
    label: `Field number ${String(index)}`,
    componentId: `field_number_${String(index)}`,
    kind: "text",
    options: []
  }));

  it("lints 850 unknown terms against 300 fields in a bounded time (200 ms on a fast machine), suggesting for the first 20 only", () => {
    const text = Array.from({ length: 850 }, (_, index) => `fieldnumbr${String(index)} = 1`).join(" or ");
    const started = Date.now();
    const result = formulaEditorState(text, { fields: many, signatures });
    // The bound is the fast-machine one scaled by how slow this machine is right now; the work it
    // guards (one suggestion search per term, not 850) is orders of magnitude over it.
    expect(Date.now() - started).toBeLessThan(200 * SLOW_FACTOR);
    expect(result.parsed.ok).toBe(true);
    expect(result.problems).toHaveLength(850);
    expect(result.problems.filter((problem) => problem.suggestion !== undefined).length).toBeLessThanOrEqual(20);
    expect(result.problems.every((problem) => problem.kind === "unknownField")).toBe(true);
  });

  it("still suggests for a misspelt name among the first problems", () => {
    const result = formulaEditorState("field_numbr_7 = 1", { fields: many, signatures });
    expect(result.problems[0]?.suggestion).toBe("field_number_7");
  });
});
