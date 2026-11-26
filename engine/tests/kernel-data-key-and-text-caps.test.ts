import { describe, expect, it } from "vitest";

import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { kernelTextCall } from "../form-engine/rules/evaluator/functions-text.js";
import { kernelExprDispatch } from "../form-engine/rules/evaluator/evaluator.js";
import { collectFieldConstraints, createFieldConstraintsStage, validationCodesRaisedBy } from "../form-engine/validation/core/field-constraints.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { DATA_GRID_ROWS_CAP, normalizeDataGrids } from "../form-engine/core/schema/data-grid.js";

// Regression tests for the shared data key, data-grid column constraints, plugin answer shape and text cap.
// A data grid is a container whose children are the fields of one row: a cell's error
// names the field inside the row at the cell's path, and a choice in a row is reported as a
// section's field is (one error per question, index-free path, every refused key listed).

const formOf = (...kids: unknown[]) => ({ id: "root", type: "form", children: { default: kids } }) as unknown as ComponentNode;
const run = (form: ComponentNode, values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  runKernel({ formId: "f", values, locale: "en", form, ...extra } as never, []);
const codes = (outcome: { errors: Array<{ code: string }> }) => outcome.errors.map((error) => error.code);

describe("a choice sharing its data key with another component", () => {
  const select = { id: "s", type: "select", configuration: { dataKey: "x", data: { sourceId: "restricted" } } };
  const snapshot = { restricted: [{ value: "ok", label: "Ok" }] };
  const at = (other: unknown, value: unknown) => run(formOf(other, select), { x: value }, { optionSnapshot: snapshot });

  it("keeps the check when the other component is anything but a plain text input", () => {
    for (const type of ["number", "date", "file", "checkbox", "checkboxes", "container"]) {
      const other = { id: "o", type, configuration: { dataKey: "x" } };
      expect(codes(at(other, "secret-term")), type).toContain("option.notAllowed");
    }
  });

  it("lets a text or textarea sharing the key stand in for the choice (the 'other, please specify' pattern)", () => {
    for (const type of ["text", "textarea"]) {
      expect(codes(at({ id: "o", type, configuration: { dataKey: "x" } }, "secret-term")), type).toEqual([]);
    }
  });
});

describe("an author's answersFree flag stays honoured by the engine", () => {
  // The engine reads the flag as written; hosts own it (a host strips an author's flag and sets it from its own config).
  const form = (free: boolean) =>
    formOf({ id: "s", type: "select", configuration: { data: { sourceId: "restricted", ...(free ? { answersFree: true } : {}) } } });
  const snapshot = { restricted: [] };
  it("refuses a value outside the snapshot unless the definition says the answers are free", () => {
    expect(codes(run(form(false), { s: "secret-term" }, { optionSnapshot: snapshot }))).toEqual(["option.notAllowed"]);
    expect(run(form(true), { s: "secret-term" }, { optionSnapshot: snapshot }).errors).toEqual([]);
  });
});

describe("a plugin type's answer must have the shape of a choice", () => {
  const form = formOf({ id: "r", type: "rating", configuration: { data: { sourceId: "s" } } });
  const snapshot = { s: [{ value: "1" }, { value: "2" }] };
  const go = (answer: unknown, extra: Record<string, unknown> = {}) => run(form, { r: answer }, { optionSnapshot: snapshot, ...extra });

  it("refuses a nested object, a list holding one, a null item and a record entry that is not a boolean", () => {
    for (const answer of [["1", { evil: { deeper: [1, 2, 3] } }], { a: { x: 1 } }, ["1", null], { "1": true, junk: "yes" }]) {
      const outcome = go(answer, { unknownFields: "keep" });
      expect(codes(outcome), JSON.stringify(answer)).toEqual(["option.notAllowed"]);
    }
  });

  it("still accepts a text, a number, a boolean-free list and a record of booleans that pick options", () => {
    for (const answer of ["1", 2, ["1", 2], { "1": true, "2": false }]) {
      expect(go(answer).errors, JSON.stringify(answer)).toEqual([]);
    }
  });
});

describe("a data grid's column constraints are enforced per cell", () => {
  const grid = {
    id: "g",
    type: "dataGrid",
    configuration: {},
    collection: { collectionPath: "orders" },
    children: {
      content: [
        { id: "c1", type: "text", configuration: { required: true, maxLength: 3, pattern: "[a-z]+", dataKey: "name" } },
        { id: "c2", type: "number", configuration: { min: 1, max: 5, dataKey: "qty" } },
        { id: "c3", type: "file", configuration: { maxFileSizeMb: 1, accept: ".pdf", dataKey: "doc" } }
      ]
    }
  };
  const form = formOf(grid);
  const file = (name: string, size: number) => ({ storage: "s", name, type: "application/pdf", size });

  it("raises the codes a standalone field would, against the field inside the row, at the cell's path", () => {
    const outcome = run(form, {
      "orders[0].name": "far-too-long",
      "orders[0].qty": 9,
      "orders[1].name": "ab",
      "orders[1].qty": "x",
      "orders[1].doc": file("a.exe", 100),
      "orders[2].doc": file("big.pdf", 999999999)
    });
    expect(outcome.errors.map((error) => [error.code, error.componentId, (error as { path?: string }).path])).toEqual([
      ["maxLength", "c1", "orders[0].name"],
      ["required", "c1", "orders[2].name"],
      ["number.max", "c2", "orders[0].qty"],
      ["number", "c2", "orders[1].qty"],
      ["fileType", "c3", "orders[1].doc"],
      ["maxFileSize", "c3", "orders[2].doc"]
    ]);
  });

  it("enforces a pattern, and holds a clean row", () => {
    expect(codes(run(form, { "orders[0].name": "AB" }))).toEqual(["pattern"]);
    expect(run(form, { "orders[0].name": "ab", "orders[0].qty": 3, "orders[0].doc": file("a.pdf", 10) }).errors).toEqual([]);
  });

  it("is read the same way by the browser's stage and reported by validationCodesRaisedBy", () => {
    // The browser reads the definition as compiled: grids normalized.
    const compiled = normalizeDataGrids(form);
    const constraints = collectFieldConstraints(compiled);
    expect(constraints.map((constraint) => [constraint.componentId, constraint.path, constraint.row])).toEqual([
      // The grid itself, for its row count alone (held to the row cap with no maximum of its own).
      ["g", "orders", undefined],
      ["c1", "name", { collection: "orders", suffix: ".name" }],
      ["c2", "qty", { collection: "orders", suffix: ".qty" }],
      ["c3", "doc", { collection: "orders", suffix: ".doc" }]
    ]);
    expect(validationCodesRaisedBy(compiled)).toEqual(expect.arrayContaining(["required", "maxLength", "pattern", "number.max", "fileType", "maxFileSize"]));
    const stage = createFieldConstraintsStage(compiled);
    const result = stage.validate({
      formId: "f",
      locale: "en",
      values: { "orders[0].name": "far-too-long", "orders[0].qty": 9, "orders[1].doc": file("a.exe", 100), "orders[2].name": "AB" }
    } as never) as { errors: Array<{ code: string; componentId: string; path?: string }> };
    expect(result.errors.map((error) => [error.code, error.path])).toEqual([
      ["maxLength", "orders[0].name"],
      ["required", "orders[1].name"],
      ["pattern", "orders[2].name"],
      ["number.max", "orders[0].qty"],
      ["fileType", "orders[1].doc"]
    ]);
    expect(result.errors.map((error) => error.componentId)).toEqual(["c1", "c1", "c1", "c2", "c3"]);
  });
});

// Empty rows are rows, select-cell errors name the cell, the error list is capped.
describe("data grid empty rows, select cells and the error cap", () => {
  const grid = {
    id: "g",
    type: "dataGrid",
    configuration: {},
    collection: { collectionPath: "orders" },
    children: {
      content: [
        { id: "c1", type: "text", configuration: { required: true, dataKey: "name" } },
        { id: "c2", type: "select", configuration: { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], dataKey: "pick" } }
      ]
    }
  };
  const form = formOf(grid);
  const where = (outcome: { errors: Array<{ code: string }> }) => outcome.errors.map((error) => [error.code, (error as { path?: string }).path]);

  it("counts a row posted as {} as a present row: its required cells apply", () => {
    expect(where(run(form, { orders: [{ name: "x" }, {}, { name: "y" }] }))).toEqual([["required", "orders[1].name"]]);
    expect(where(run(form, { orders: [{}] }))).toEqual([["required", "orders[0].name"]]);
    expect(where(run(form, { orders: [] }))).toEqual([]);
    expect(where(run(form, { orders: [{ name: "x" }] }, { unknownFields: "keep" }))).toEqual([]);
    expect(where(run(form, { orders: [{}] }, { unknownFields: "keep" }))).toEqual([["required", "orders[0].name"]]);
  });

  it("counts an empty entry of a repeating section too", () => {
    const section = formOf({ id: "items", type: "repeatingSection", configuration: {}, collection: { collectionPath: "items" }, children: { default: [{ id: "sku", type: "text", configuration: { required: true } }] } });
    expect(where(run(section, { items: [{}, { sku: "a" }] }))).toEqual([["required", "items[0].sku"]]);
  });

  it("names every refused cell of a select in a row, in one error for the field as a section's", () => {
    const outcome = run(form, { orders: [{ name: "x", pick: "zzz" }, { name: "y", pick: "a" }, { name: "z", pick: "nope" }] });
    expect(outcome.errors.filter((error) => error.code === "option.notAllowed").map((error) => [(error as { path?: string }).path, (error as { parameters?: unknown }).parameters, (error as { componentId?: string }).componentId])).toEqual([
      ["orders.pick", { keys: ["orders[0].pick", "orders[2].pick"] }, "c2"]
    ]);
  });

  it("keeps a standalone select's option error index-free", () => {
    const standalone = formOf({ id: "s", type: "select", configuration: { options: [{ value: "a", label: "A" }] } });
    expect(where(run(standalone, { s: "zzz" }))).toEqual([["option.notAllowed", "s"]]);
  });

  it("cuts the error list at 10,000 with a final errors.truncated entry that blocks as the cut errors did", () => {
    // Rows past the cap are refused as a whole, so the 10,000 come from a wide grid at the cap.
    const wide = formOf({
      ...grid,
      children: { content: Array.from({ length: 25 }, (_, at) => ({ id: `c${at}`, type: "text", configuration: { required: true, dataKey: `name${at}` } })) }
    });
    const rows = Array.from({ length: DATA_GRID_ROWS_CAP }, () => ({}));
    const outcome = run(wide, { orders: rows });
    expect(outcome.errors).toHaveLength(10001);
    expect(outcome.errors[9999]).toMatchObject({ code: "required" });
    expect(outcome.errors[10000]).toMatchObject({ code: "errors.truncated", stage: "validation", source: "wasm", parameters: { reported: expect.any(Number), shown: 10000 } });
    expect((outcome as { values?: unknown }).values).toBeUndefined();
    expect(run(form, { orders: Array.from({ length: 50 }, () => ({ name: "x" })) }).errors).toEqual([]);
  });
});

describe("every whole-text formula function reads a text over 10,000 characters by its first 10,000", () => {
  const long = "a".repeat(10001);
  const ok = "a".repeat(10000);
  const cut = ": the text is over the 10,000 character cap; its first 10,000 characters were used (text.truncated)";
  const context = (warnings: string[]) => ({ values: {}, warn: (message: string) => warnings.push(message) }) as never;

  it("works on the head, with one text.truncated warning, for the text group", () => {
    const cases: Array<[string, unknown[], unknown]> = [
      ["titleCase", [long], "A" + "a".repeat(9999)],
      ["trim", [long], ok],
      ["substring", [long, 1, 5], "aaaaa"],
      ["indexOf", [long + "b", "b"], 0],
      ["replace", [long, "a", "b"], "b".repeat(10000)],
      ["split", [long, ","], [ok]],
      ["startsWith", [long, "aa"], true],
      ["endsWith", [long + "b", "b"], false],
      ["padStart", [long, 5, "-"], ok],
      ["text", [long], ok]
    ];
    for (const [name, args, expected] of cases) {
      const warnings: string[] = [];
      expect(kernelTextCall(name, args, (message) => warnings.push(message)), name).toEqual(expected);
      expect(warnings, name).toEqual([name + cut]);
    }
    expect(kernelTextCall("trim", [ok])).toBe(ok);
    expect(kernelTextCall("substring", [ok, 1, 2])).toBe("aa");
  });

  it("works on the head for upper, lower, contains and concat in the evaluator, and leaves len alone", () => {
    for (const name of ["upper", "lower"]) {
      const warnings: string[] = [];
      expect(kernelExprDispatch(name, [long], context(warnings)), name).toBe(name === "upper" ? ok.toUpperCase() : ok);
      expect(warnings, name).toEqual([name + cut]);
      expect(kernelExprDispatch(name, [ok], context([]))).toBe(name === "upper" ? ok.toUpperCase() : ok);
    }
    const warnings: string[] = [];
    expect(kernelExprDispatch("contains", [long + "b", "b"], context(warnings))).toBe(false);
    expect(kernelExprDispatch("contains", [long, "a"], context(warnings))).toBe(true);
    expect(warnings).toEqual(["contains" + cut, "contains" + cut]);
    expect(kernelExprDispatch("contains", [ok, "a"], context([]))).toBe(true);
    expect(kernelExprDispatch("len", [long], context([]))).toBe(10001);
    const joined: string[] = [];
    expect(kernelExprDispatch("concat", [long, "tail"], context(joined))).toBe(ok);
    expect(joined).toEqual(["concat: the text is over the 10,000 character cap; its first 10,000 characters were used (text.truncated)"]);
  });
});
