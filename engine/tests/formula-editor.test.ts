// @vitest-environment jsdom
/**
 * The CodeMirror formula editor mounted in jsdom, which lays
 * nothing out, so the checks are about the document, the decorations and the callbacks, not
 * the geometry. Rects on a Range and `execCommand` are stubbed the way the inspector's JSON
 * editor tests stub them, since CodeMirror asks for both once it has a caret to place.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";

import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { FORMULA_FUNCTION_ROWS, FORMULA_SNIPPETS, type FormulaSnippet } from "../form-engine/builder/formula/feel-functions.js";
import {
  formulaCompletionSource,
  lintFormula,
  mountFormulaEditor,
  scanFormula,
  type CodeMirrorFormulaEditor,
  type CodeMirrorFormulaEditorOptions,
  type FormulaField
} from "../form-engine/builder/formula/formula-editor.js";
import { loadFormulaEditor } from "../form-engine/builder/formula/formula-editor-loader.js";
import { FORMULA_EDITOR_STYLES } from "../form-engine/builder/formula/formula-editor-styles.js";

const FIELDS: FormulaField[] = [
  { path: "province", label: "Province", componentId: "province", kind: "choice", options: [{ value: "QC", label: "Québec" }, { value: "ON", label: "Ontario" }] },
  { path: "inc_province", label: "Province of incorporation", componentId: "inc_province", kind: "choice", options: [{ value: "QC", label: "Québec" }] },
  { path: "employees", label: "Number of employees", componentId: "employees", kind: "number", options: [] },
  { path: "score", label: "Score", componentId: "score", kind: "number", options: [] },
  { path: "email", label: "Email", componentId: "email", kind: "text", options: [] }
];

const SNIPPET_ANY_OF = FORMULA_SNIPPETS.find((entry) => entry.id === "anyOf") as FormulaSnippet;

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const key = (target: HTMLElement, name: string, init: KeyboardEventInit = {}): boolean =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));

describe("the formula editor", () => {
  const restore: Array<() => void> = [];
  const mounted: CodeMirrorFormulaEditor[] = [];
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

  const mount = (overrides: Partial<CodeMirrorFormulaEditorOptions> = {}): CodeMirrorFormulaEditor => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const editor = mountFormulaEditor(host, {
      text: "",
      label: "Show Registered agent when",
      fields: FIELDS,
      functions: [...FORMULA_FUNCTION_ROWS],
      signatures: formulaFunctionSignatures(),
      snippets: [...FORMULA_SNIPPETS],
      onChange: () => undefined,
      onCommit: () => undefined,
      ...overrides
    });
    mounted.push(editor);
    return editor;
  };

  it("mounts the box with its helper row, label and placeholder, and the styles name its classes", () => {
    const editor = mount();
    expect(editor.dom.parentElement).toBe(host);
    expect(editor.dom.className).toBe("formula-editor");
    expect(editor.dom.querySelector(".cm-editor")!.classList.contains("formula")).toBe(true);
    expect(editor.contentDom.getAttribute("aria-label")).toBe("Show Registered agent when");
    expect(editor.contentDom.getAttribute("aria-multiline")).toBe("false");
    expect(editor.contentDom.getAttribute("aria-invalid")).toBeNull();
    expect(editor.dom.querySelector(".cm-placeholder")!.textContent).toBe("Type a field name, or pick one with + Field");
    expect(editor.dom.querySelector(".cm-gutters")).toBeNull();
    const helpers = [...editor.dom.querySelectorAll(".f-help .help")].map((button) => button.textContent);
    expect(helpers).toEqual(["+Field", "ƒFunction", "Helpers"]);
    // No page named, no link: not an empty anchor, not a spacer left over for it.
    expect(editor.dom.querySelector(".f-reference")).toBeNull();
    expect(editor.dom.querySelector(".f-help .f-spacer")).toBeNull();
    for (const className of [".f-field", ".f-field.unknown", ".f-kw", ".f-num", ".f-str", ".f-op", ".f-fn", ".f-suggest-footer", ".f-help .help", ".f-menu"]) {
      expect(FORMULA_EDITOR_STYLES).toContain(className);
    }
    expect(FORMULA_EDITOR_STYLES).not.toContain("`");
    expect(editor.getState().parsed.ok).toBe(true);
    expect(editor.getState().problems).toEqual([]);
  });

  it("draws the Formula reference link when the host names a page", () => {
    const editor = mount({ referenceHref: "https://example.test/formulas" });
    const link = editor.dom.querySelector<HTMLAnchorElement>(".f-help .f-reference")!;
    expect(link.textContent).toBe("Formula reference");
    expect(link.getAttribute("href")).toBe("https://example.test/formulas");
    expect(editor.dom.querySelector(".f-help .f-spacer")).not.toBeNull();
  });

  it("draws a known field as a chip showing the label while the document keeps the id", () => {
    const editor = mount({ text: 'province = "QC" and employees > 10' });
    const chips = [...editor.contentDom.querySelectorAll(".f-field")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["Province", "Number of employees"]);
    expect(chips.map((chip) => chip.getAttribute("data-path"))).toEqual(["province", "employees"]);
    expect(editor.contentDom.querySelector(".f-field.unknown")).toBeNull();
    expect(editor.getText()).toBe('province = "QC" and employees > 10');
    expect(editor.contentDom.textContent).not.toContain("province");
    expect(editor.contentDom.querySelector(".f-kw")!.textContent).toBe("and");
    expect(editor.contentDom.querySelector(".f-str")!.textContent).toBe('"QC"');
    expect(editor.contentDom.querySelector(".f-num")!.textContent).toBe("10");
    expect([...editor.contentDom.querySelectorAll(".f-op")].map((op) => op.textContent)).toEqual(["=", ">"]);
  });

  it("styles a call as a function name and a scoped path as a path, no chip", () => {
    const editor = mount({ text: 'coalesce(host.businessNumber, "")' });
    expect(editor.contentDom.querySelector(".f-fn")!.textContent).toBe("coalesce");
    expect(editor.contentDom.querySelector(".f-path")!.textContent).toBe("host.businessNumber");
    expect(editor.contentDom.querySelector(".f-field")).toBeNull();
    expect(editor.getState().problems).toEqual([]);
  });

  it("reports an unknown field with the nearest label as the fix, drawn as a chip in the danger wash", async () => {
    const editor = mount({ text: 'provnce = "QC"' });
    const state = editor.getState();
    expect(state.parsed.ok).toBe(true);
    expect(state.problems).toEqual([
      { kind: "unknownField", message: "No field is called provnce. Did you mean Province?", start: 0, end: 7, suggestion: "province" }
    ]);
    const unknown = editor.contentDom.querySelector(".f-field.unknown");
    expect(unknown).not.toBeNull();
    expect(unknown!.textContent).toBe("provnce");
    expect(editor.contentDom.getAttribute("aria-invalid")).toBeNull();
    await flush();
    expect(editor.contentDom.querySelector(".cm-lintRange-warning")).not.toBeNull();
    expect(editor.contentDom.querySelector(".cm-lintRange-error")).toBeNull();
  });

  it("offers the spaced subtraction when a hyphenated name splits into two fields", () => {
    const editor = mount({ text: "employees-score > 0" });
    expect(editor.getState().problems).toEqual([
      { kind: "unknownField", message: "Write employees - score with spaces to subtract.", start: 0, end: 15, suggestion: "employees - score" }
    ]);
  });

  it("marks a parse error on its span, worded from the catalog, and flags the box", async () => {
    const editor = mount({ text: "employees > )" });
    const [problem] = editor.getState().problems;
    expect(problem).toEqual({ kind: "parse", message: "A value is missing before ).", start: 12, end: 13 });
    expect(editor.contentDom.getAttribute("aria-invalid")).toBe("true");
    expect(editor.dom.querySelector(".cm-editor")!.classList.contains("bad")).toBe(true);
    await flush();
    const marked = editor.contentDom.querySelector(".cm-lintRange-error");
    expect(marked).not.toBeNull();
    expect(marked!.textContent).toBe(")");
    // At the end of the text the parser points past the last character; the mark is a point there.
    editor.setText("employees >");
    expect(editor.getState().problems).toEqual([{ kind: "parse", message: "A value is missing at the end of the formula.", start: 11, end: 11 }]);
    await flush();
    expect(editor.contentDom.querySelector(".cm-lintPoint-error")).not.toBeNull();
    expect(editor.contentDom.querySelector(".cm-lintRange-error")).toBeNull();
  });

  it("follows a new field list: chips and the unknown-field check are redone", async () => {
    const editor = mount({ text: "region = 1" });
    expect(editor.getState().problems.map((problem) => problem.kind)).toEqual(["unknownField"]);
    editor.setFields([...FIELDS, { path: "region", label: "Region", kind: "text", options: [] }]);
    expect(editor.getState().problems).toEqual([]);
    expect(editor.contentDom.querySelector(".f-field")!.textContent).toBe("Region");
    await flush();
    expect(editor.contentDom.querySelector(".cm-lintRange-warning")).toBeNull();
  });

  describe("suggestions", () => {
    const source = formulaCompletionSource({
      fieldsOf: () => FIELDS,
      scopes: ["row.", "host."],
      functions: FORMULA_FUNCTION_ROWS,
      words: {}
    });
    const complete = (text: string, explicit = false): { from: number; labels: string[]; sections: string[]; options: Array<Record<string, unknown>> } => {
      const state = EditorState.create({ doc: text });
      const result = source(new CompletionContext(state, text.length, explicit));
      if (result === null || result instanceof Promise) {
        throw new Error("no completions");
      }
      const options = result.options as unknown as Array<Record<string, unknown>>;
      return {
        from: result.from,
        labels: options.map((option) => String(option.displayLabel ?? option.label)),
        sections: [...new Set(options.map((option) => (option.section as { name: string }).name))],
        options
      };
    };

    it('lists fields (label shown, id as detail), scopes, functions with argument names and keywords for "prov"', () => {
      const result = complete("employees > 0 and prov");
      expect(result.from).toBe("employees > 0 and ".length);
      expect(result.sections).toEqual(["Fields", "Functions", "Keywords"]);
      expect(result.labels.slice(0, 5)).toEqual(["Province", "Province of incorporation", "Number of employees", "Score", "Email"]);
      const province = result.options[0]!;
      expect(province.detail).toBe("province");
      expect(province.apply).toBe("province");
      expect(province.type).toBe("field");
      expect(result.labels).toContain("row.");
      expect(result.labels).toContain("host.");
      const power = result.options.find((option) => option.label === "power")!;
      expect(power.detail).toBe("(base, exponent)");
      expect(power.type).toBe("function");
      expect(typeof power.apply).toBe("function");
      expect(result.labels).toContain("between");
      // The list is filtered by CodeMirror's matcher as the author types; the raw source holds every item.
    });

    it("offers a choice field's options as quoted strings after = and inside in (…)", () => {
      const equals = complete('province = "Q');
      expect(equals.sections).toEqual(["Options"]);
      expect(equals.labels).toEqual(["Québec", "Ontario"]);
      expect(equals.options[0]!.apply).toBe('"QC"');
      expect(equals.from).toBe("province = ".length);
      const list = complete('province in ("QC", ');
      expect(list.labels).toEqual(["Québec", "Ontario"]);
      expect(list.from).toBe('province in ("QC", '.length);
      // A number is nothing to suggest: the source stays quiet.
      expect(source(new CompletionContext(EditorState.create({ doc: "employees = 1" }), "employees = 1".length, false))).toBeNull();
    });

    it("stays quiet with nothing typed unless asked", () => {
      const state = EditorState.create({ doc: "employees > " });
      expect(source(new CompletionContext(state, state.doc.length, false))).toBeNull();
      expect(complete("employees > ", true).labels).toContain("Province");
    });

    it("closes once a field id is typed out in full (the chip has formed), unless asked", () => {
      const done = EditorState.create({ doc: "double(employees" });
      expect(source(new CompletionContext(done, done.doc.length, false))).toBeNull();
      // Still typing towards a longer name: the list stays.
      expect(complete("double(employee").labels).toContain("Number of employees");
      // Asked for (Ctrl+Space), the list opens over a complete id too.
      expect(complete("double(employees", true).labels).toContain("Number of employees");
    });

    it("inserts a backticked id for a field the grammar cannot take bare", () => {
      const odd = formulaCompletionSource({ fieldsOf: () => [{ path: "first name", label: "First name", kind: "text", options: [] }], scopes: [], functions: [], words: {} });
      const state = EditorState.create({ doc: "fir" });
      const result = odd(new CompletionContext(state, 3, false)) as unknown as { options: Array<{ apply: unknown }> };
      expect(result.options[0]!.apply).toBe("`first name`");
    });
  });

  it("inserts a snippet at the caret with its blanks selected in turn, Tab moving to the next", async () => {
    const editor = mount();
    editor.focus();
    editor.insertSnippet(SNIPPET_ANY_OF);
    expect(editor.getText()).toBe(" in (, )");
    // The first blank is selected: typing lands there.
    editor.insertText("province");
    expect(editor.getText()).toBe("province in (, )");
    expect(key(editor.contentDom, "Tab")).toBe(false);
    editor.insertText('"QC"');
    expect(editor.getText()).toBe('province in ("QC", )');
    key(editor.contentDom, "Tab");
    editor.insertText('"ON"');
    expect(editor.getText()).toBe('province in ("QC", "ON")');
    await flush();
    expect(editor.getState().problems).toEqual([]);
  });

  it("pads an insertion that would glue onto the text before the caret", () => {
    const editor = mount({ text: "employees > 0 and" });
    editor.focus(editor.getText().length);
    editor.insertSnippet(SNIPPET_ANY_OF);
    expect(editor.getText()).toBe("employees > 0 and  in (, )");
  });

  it("starts the next case on Enter after then in a multiline box, and commits on Enter in a single-line one", () => {
    const commits: string[] = [];
    const multi = mount({ multiline: true, text: "if employees > 10 then", onCommit: (text) => commits.push(text) });
    expect(multi.contentDom.getAttribute("aria-multiline")).toBe("true");
    multi.focus(multi.getText().length);
    key(multi.contentDom, "Enter");
    expect(multi.getText()).toBe("if employees > 10 then\n  ");
    multi.insertText("250");
    key(multi.contentDom, "Enter");
    expect(multi.getText()).toBe("if employees > 10 then\n  250\n");
    multi.insertText("else 120");
    expect(commits).toEqual([]);
    multi.destroy();
    mounted.splice(mounted.indexOf(multi), 1);
    host.remove();

    const single = mount({ text: "employees > 10", onCommit: (text) => commits.push(text) });
    single.focus(single.getText().length);
    key(single.contentDom, "Enter");
    expect(single.getText()).toBe("employees > 10");
    expect(commits).toEqual([]);
    single.insertText(" and true");
    key(single.contentDom, "Enter");
    expect(commits).toEqual(["employees > 10 and true"]);
    key(single.contentDom, "Enter");
    expect(commits).toEqual(["employees > 10 and true"]);
  });

  it("hands every edit to onChange with the state, never a setText", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const editor = mount({ onChange, onCommit });
    editor.setText("employees > 10");
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("employees > 10");
    editor.insertText(" and");
    editor.insertText(" provnce");
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    const [text, state] = onChange.mock.calls[0] as [string, { problems: Array<{ kind: string }> }];
    expect(text).toBe("employees > 10 and provnce");
    expect(state.problems.map((problem) => problem.kind)).toEqual(["unknownField"]);
    expect(onCommit).not.toHaveBeenCalled();
    // Blur with the text changed since the last commit or setText: the commit.
    editor.contentDom.blur();
    await flush();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toBe("employees > 10 and provnce");
    editor.focus();
    editor.contentDom.blur();
    await flush();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("removes a chip whole on Backspace and steps the caret over it", () => {
    const editor = mount({ text: "employees > 10" });
    editor.focus("employees".length);
    key(editor.contentDom, "Backspace");
    expect(editor.getText()).toBe(" > 10");
    editor.setText("employees > 10");
    editor.focus(0);
    key(editor.contentDom, "Delete");
    expect(editor.getText()).toBe(" > 10");
  });

  it("edits an unknown field one letter at a time while a chip still goes whole", () => {
    const editor = mount({ text: "employees > 10 and " });
    editor.focus(editor.getText().length);
    editor.insertText("provinc");
    expect(editor.contentDom.querySelector(".f-field.unknown")!.textContent).toBe("provinc");
    editor.focus(editor.getText().length);
    key(editor.contentDom, "Backspace");
    expect(editor.getText()).toBe("employees > 10 and provin");
    // The arrows step one letter too: ArrowLeft then Delete takes the last letter alone.
    key(editor.contentDom, "ArrowLeft");
    key(editor.contentDom, "Delete");
    expect(editor.getText()).toBe("employees > 10 and provi");
    editor.focus("employees > 10 and ".length);
    key(editor.contentDom, "Delete");
    expect(editor.getText()).toBe("employees > 10 and rovi");
    // The chip before it still goes as one.
    editor.focus("employees".length);
    key(editor.contentDom, "Backspace");
    expect(editor.getText()).toBe(" > 10 and rovi");
  });

  it("opens the Field menu from the helper row and inserts the chosen id", () => {
    const editor = mount({ text: "" });
    editor.focus();
    const button = editor.dom.querySelector<HTMLButtonElement>('.help[data-action="field"]')!;
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const menu = editor.dom.querySelector<HTMLElement>(".f-menu")!;
    expect(menu.hidden).toBe(false);
    const items = [...menu.querySelectorAll(".f-mi")];
    expect(items.map((item) => item.querySelector(".f-field")!.textContent)).toEqual(FIELDS.map((field) => field.label));
    (items[2] as HTMLButtonElement).click();
    expect(editor.getText()).toBe("employees");
    expect(menu.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const functions = editor.dom.querySelector<HTMLButtonElement>('.help[data-action="function"]')!;
    functions.click();
    expect([...menu.querySelectorAll(".f-mh")].map((head) => head.textContent)).toContain("Text");
    expect(menu.querySelector(".f-mi .f-fn")!.textContent).toBe("coalesce");
    functions.click();
    const helpers = editor.dom.querySelector<HTMLButtonElement>('.help[data-action="helpers"]')!;
    helpers.click();
    expect([...menu.querySelectorAll(".f-mh")].map((head) => head.textContent)).toEqual(["Answers", "Choices", "Dates", "Cases"]);
    expect(menu.querySelector(".f-mi .f-sub")!.textContent).toBe("not(empty(…))");
  });

  it("carries lint warnings among the mounted box's problems, in text order", () => {
    const editor = mount({ text: "employees in [9..1] and 0.3 = score + 1" });
    const kinds = editor.getState().problems.map((problem) => problem.kind);
    expect(kinds).toEqual(["lint", "lint"]);
  });

  it("warns about a condition that is no yes-or-no only when the box is told it is a condition", () => {
    expect(mount({ text: "len(email)" }).getState().problems).toEqual([]);
    const conditional = mount({ text: "len(email)", condition: true }).getState().problems;
    expect(conditional.map((problem) => problem.kind)).toEqual(["lint"]);
    expect(conditional[0]).toMatchObject({ start: 0, end: 10 });
    expect(mount({ text: "len(email) > 0", condition: true }).getState().problems).toEqual([]);
  });
  it("scans the text as the parser reads it", () => {
    expect(scanFormula('first-name = "a" and `odd id` > 1.5e3').map((token) => `${token.kind}:${token.value || "-"}`)).toEqual([
      "name:first-name",
      "op:=",
      "str:-",
      "kw:and",
      "name:odd id",
      "op:>",
      "num:1.5e3"
    ]);
    expect(scanFormula("not(empty(x))").map((token) => token.kind)).toEqual(["kw", "op", "fn", "op", "name", "op", "op"]);
  });

  it("destroys cleanly, and the loader memoises the chunk", async () => {
    const editor = mount({ text: "employees > 1" });
    const dom = editor.dom;
    editor.destroy();
    mounted.splice(0);
    expect(dom.isConnected).toBe(false);
    expect(host.childElementCount).toBe(0);
    const first = loadFormulaEditor();
    expect(loadFormulaEditor()).toBe(first);
    expect(typeof (await first).mountFormulaEditor).toBe("function");
  });
});

describe("lintFormula", () => {
  const signatures = formulaFunctionSignatures();
  const lint = (text: string): string[] => {
    const parsed = kernelParseFormula(text, signatures);
    return lintFormula(text, scanFormula(text), parsed, {}).map((problem) => `${problem.start}-${problem.end}:${problem.message}`);
  };

  it.each([
    ["x in [10..1]", 5, 12, "never true"],
    ["x in (5..2]", 5, 11, "never true"],
    ["x between 10 and 1", 2, 18, "never true"],
    ["x in [-1..-5]", 5, 13, "never true"],
    ['x in ["z".."a"]', 5, 15, "never true"],
    ['x in [@"2026-12-31"..@"2026-01-01"]', 5, 35, "never true"],
    ['x in [1.."z"]', 5, 13, "number and text"],
    ["x between 1 and @\"2026-01-01\"", 2, 29, "number and date"]
  ])("%s warns about the range", (text, start, end, words) => {
    const found = lint(text);
    expect(found, text).toHaveLength(1);
    expect(found[0]).toContain(`${start}-${end}:`);
    expect(found[0]).toContain(words);
  });

  it.each(["x in [1..10]", "x in [1..1]", "x between 1 and 10", 'x in ["a".."z"]', "x in [a..b]", "x in [1..b]", "x in (1, 2)"])("%s is left alone", (text) => {
    expect(lint(text)).toEqual([]);
  });

  it("warns about a backslash before a letter that is not an escape, at those two characters", () => {
    const found = lint('x = "\\u0041\\n\\q"');
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("5-7:");
    expect(found[0]).toContain("letter u");
    expect(found[1]).toContain("letter q");
    expect(lint('x = "a\\\\u"')).toEqual([]);
    expect(lint('x = "say \\"hi\\" \\n \\t \\r"')).toEqual([]);
  });

  it("warns about = between a calculation and a decimal literal, either way round, and not about the safe forms", () => {
    expect(lint("a + b = 0.3")).toHaveLength(1);
    expect(lint("0.3 = a + b")).toHaveLength(1);
    expect(lint("price * 1.13 != -0.5")).toHaveLength(1);
    expect(lint("a + b = 3")).toEqual([]);
    expect(lint("a = 0.3")).toEqual([]);
    expect(lint("a + b < 0.3")).toEqual([]);
    expect(lint("roundTo(a + b, 2) = 0.3")).toEqual([]);
  });

  it("says nothing for a formula that does not parse", () => {
    expect(lint("x in [10..1")).toEqual([]);
  });

  // A literal matches pattern that repeats a repeat is refused at compile; the editor says so over the pattern.
  describe("a risky matches pattern", () => {
    it("underlines the quoted pattern of a risky matches call, and says nothing for a safe one, a field pattern or another function", () => {
      const text = 'matches(code, "(a+)+$") and len(code) > 1';
      const found = lint(text);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain(`${text.indexOf('"(a+)+$"')}-${text.indexOf('"(a+)+$"') + 8}:`);
      expect(found[0]).toContain("(a+)+$");
      expect(lint('matches(code, "[A-Z]+")')).toEqual([]);
      expect(lint("matches(code, pattern)")).toEqual([]);
      expect(lint('contains(code, "(a+)+$")')).toEqual([]);
      expect(lint('matches(code, "(a+)+$" )')).toHaveLength(1);
    });

    it("reads the escapes of the pattern as the parser does, and is silent once the host allows risky patterns", () => {
      const text = 'matches(code, "(\\\\w+\\\\s?)+")';
      expect(lint(text)).toHaveLength(1);
      const parsed = kernelParseFormula(text, signatures);
      expect(lintFormula(text, scanFormula(text), parsed, {}, undefined, "allow")).toEqual([]);
      expect(lintFormula(text, scanFormula(text), parsed, {}, undefined, "refuse")).toHaveLength(1);
    });
  });

  // A condition holds only for true, so the editor
  // warns, over the whole text, when a condition provably comes to something else.
  describe("a condition that is no yes-or-no", () => {
    const lintCondition = (text: string): string[] => {
      const parsed = kernelParseFormula(text, signatures);
      return lintFormula(text, scanFormula(text), parsed, {}, true).map((problem) => `${problem.start}-${problem.end}:${problem.message}`);
    };

    it.each(["len(name)", "1", '"yes"', "null", "a + 1", "upper(name)", "if a then 1 else 2", "today()"])("%s is warned about as a condition, over the whole text", (text) => {
      const found = lintCondition(text);
      expect(found, text).toHaveLength(1);
      expect(found[0]).toContain(`0-${text.length}:`);
      expect(found[0]).toContain("never holds");
      // A value formula is not a condition: nothing to say.
      expect(lint(text), text).toEqual([]);
    });

    it.each(["name = \"x\"", "a > 1 and b < 2", "not(empty(name))", "empty(name)", "true", "consent", "coalesce(consent, false)", "if a then b > 1", "age(dob) >= 18", "x in [1..5]", "somePlugin(name)"])("%s is left alone as a condition", (text) => {
      expect(lintCondition(text), text).toEqual([]);
    });

    it("says nothing for a condition that does not parse, and blank text", () => {
      expect(lintCondition("len(")).toEqual([]);
      expect(lintCondition("")).toEqual([]);
    });
  });

});

describe("the formula editor at phone width", () => {
  it("rides the helper row above the box so the suggestions never cover it", () => {
    expect(FORMULA_EDITOR_STYLES).toContain(":host([data-phone]) .formula-editor .f-help{order:-1}");
  });

  it("makes the suggestion rows and helper buttons 44px on touch", () => {
    expect(FORMULA_EDITOR_STYLES).toContain(":host([data-phone]) .formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li{min-height:44px");
    expect(FORMULA_EDITOR_STYLES).toContain("@media (pointer:coarse){.formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li{min-height:44px");
    expect(FORMULA_EDITOR_STYLES).toContain(":host([data-phone]) .formula-editor .f-help .help{min-height:44px");
  });

  it("hides the keyboard hint line when the shell says the pointer is coarse", () => {
    expect(FORMULA_EDITOR_STYLES).toContain("display:var(--db-hint-display, block)");
  });
});
