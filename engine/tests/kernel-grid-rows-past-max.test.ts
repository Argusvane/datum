import { describe, expect, it } from "vitest";

import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { DATA_GRID_ROWS_CAP } from "../form-engine/core/schema/data-grid.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";

/**
 * Rows past a data grid's maximum are refused as a whole (`rows.max`); their cells are not
 * checked one by one. A hostile body of a thousand empty rows costs one error instead of a
 * thousand `required`s, and the run spends nothing on cells it refuses anyway.
 */

function form(maxRows: number | undefined, hidden = false): ComponentNode {
  return {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "items",
          type: "dataGrid",
          collection: {},
          configuration: { ...(maxRows !== undefined ? { maxRows } : {}), ...(hidden ? { hidden: true, hiddenValueBehavior: "keep" } : {}) },
          children: { content: [{ id: "sku", type: "text", configuration: { required: true, pattern: "[A-Z]+" } }] }
        }
      ]
    }
  } as unknown as ComponentNode;
}

const rows = (count: number, sku: string | undefined): Array<Record<string, unknown>> => Array.from({ length: count }, () => (sku === undefined ? {} : { sku }));
const run = (root: ComponentNode, items: Array<Record<string, unknown>>) =>
  runKernel({ formId: "f", values: { items }, locale: "en", form: root }, [], undefined, formulaFunctionSignatures());

describe("cells of rows past a grid's maximum", () => {
  it("are not checked: rows.max alone, and the cells within the bound as before", () => {
    const outcome = run(form(3), [{ sku: "ok" }, { sku: "OK" }, {}, ...rows(1000, undefined)]);
    expect(outcome.errors.map((error) => `${error.code}@${error.path}`)).toEqual(["rows.max@items", "pattern@items[0].sku", "required@items[2].sku"]);
    expect(outcome.errors[0]?.parameters).toEqual({ max: 3, count: 1003 });
  });

  it("within the bound every cell is checked", () => {
    const outcome = run(form(5), rows(5, "x"));
    expect(outcome.errors.map((error) => error.code)).toEqual(["pattern", "pattern", "pattern", "pattern", "pattern"]);
  });

  it("a grid with no maximum is held to DATA_GRID_ROWS_CAP rows: rows.max past it, the cells of the rows within it checked", () => {
    expect(run(form(undefined), rows(DATA_GRID_ROWS_CAP, "OK")).errors).toEqual([]);
    const outcome = run(form(undefined), [{}, ...rows(DATA_GRID_ROWS_CAP, undefined)]);
    expect(outcome.errors.filter((error) => error.code !== "required").map((error) => [error.code, error.path, error.parameters])).toEqual([
      ["rows.max", "items", { max: DATA_GRID_ROWS_CAP, count: DATA_GRID_ROWS_CAP + 1 }]
    ]);
    expect(outcome.errors.filter((error) => error.code === "required").length).toBe(DATA_GRID_ROWS_CAP);
    // A formula that comes to nothing usable leaves the cap in force too.
    const ruled = { ...form(undefined) } as ComponentNode;
    const grid = (ruled.children!.content as ComponentNode[])[0]!;
    (ruled.children!.content as ComponentNode[])[0] = { ...grid, rules: { maxRows: "\"many\"" } } as unknown as ComponentNode;
    expect(run(ruled, rows(DATA_GRID_ROWS_CAP + 1, "OK")).errors.map((error) => error.code)).toEqual(["rows.max"]);
  });

  it("a hidden grid whose answer is still submitted is held to DATA_GRID_ROWS_CAP rows too: no person could add more, so only a forged post has them", () => {
    // The grid retains explicitly (the hidden default leaves its rows out); `null` leaves the behaviour unset.
    const hidden = (maxRows: number | undefined, behavior: string | null = "retain"): ComponentNode => {
      const root = form(maxRows);
      const grid = (root.children!.content as ComponentNode[])[0]!;
      (root.children!.content as ComponentNode[])[0] = {
        ...grid,
        configuration: { ...(grid.configuration as Record<string, unknown>), ...(behavior !== null ? { hiddenValueBehavior: behavior } : {}) },
        rules: { visibleWhen: "false" }
      } as unknown as ComponentNode;
      return root;
    };
    // A retaining hidden grid keeps its rows in the submission: held to the cap, rows.max past it.
    const past = run(hidden(undefined), rows(2000, "OK"));
    expect(past.errors.map((error) => [error.code, error.path, error.parameters])).toEqual([["rows.max", "items", { max: DATA_GRID_ROWS_CAP, count: 2000 }]]);
    // At the cap a hidden grid passes: it is held to the shape of what it submits, not checked.
    expect(run(hidden(undefined), rows(DATA_GRID_ROWS_CAP, "OK")).errors).toEqual([]);
    // Held to the cap alone, not the author's bounds: a hidden grid's own maximum is not checked.
    expect(run(hidden(3), rows(10, "OK")).errors).toEqual([]);
    expect(run(hidden(3), rows(DATA_GRID_ROWS_CAP + 1, "OK")).errors.map((error) => [error.code, error.parameters])).toEqual([["rows.max", { max: DATA_GRID_ROWS_CAP, count: DATA_GRID_ROWS_CAP + 1 }]]);
    // The cells of the rows past the cap are not walked for their shape either: one error, not a thousand.
    const shaped = run(hidden(undefined), [...rows(DATA_GRID_ROWS_CAP, "OK"), ...rows(1000, undefined).map(() => ({ sku: ["not", "text"] }))]);
    expect(shaped.errors.map((error) => error.code)).toEqual(["rows.max"]);
    // A grid left out of the submission submits no rows: nothing to hold.
    expect(run(hidden(undefined, "exclude-from-submission"), rows(2000, "OK")).errors).toEqual([]);
    // So is one that sets nothing: the default leaves a hidden grid's rows out.
    expect(run(hidden(undefined, null), rows(2000, "OK")).errors).toEqual([]);
  });

  it("a grid with no maximum has every row's cells checked", () => {
    const outcome = run(form(undefined), rows(4, undefined));
    expect(outcome.errors.map((error) => error.code)).toEqual(["required", "required", "required", "required"]);
  });
});
