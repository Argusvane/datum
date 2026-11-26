// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GridAdapter, GridState } from "../form-engine/render/live/contract.js";
import { createDataGridFeature, gridAddId } from "../form-engine/render/live/data-grid.js";
import { lit } from "../form-engine/render/live/lit.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createBinding, definitionOf, mounted, quiet, runtimeOf, settled, type, unmountAll } from "./live-chrome-harness.js";

/*
 * The data grid and the repeating section (render/live/data-grid.ts): rows
 * keyed by the runtime's entry keys, the row buttons through the runtime and their bounds, focus
 * after each button, the table layout's hidden labels, and the state an adapter is handed.
 */

afterEach(unmountAll);

const gridForm = (configuration: Record<string, unknown> = {}, extra: { collection?: boolean } = {}) =>
  definitionOf([
    {
      id: "items",
      type: "dataGrid",
      configuration: { label: "Items", initialRows: 0, canReorder: true, layout: "table", ...configuration },
      collection: { collectionPath: "items" },
      children: {
        content: [
          { id: "sku", type: "text", configuration: { label: "SKU", required: true } },
          { id: "qty", type: "text", configuration: { label: "Quantity" } }
        ]
      }
    }
  ]);

function withRows(configuration: Record<string, unknown>, skus: string[]): FormRuntime {
  const runtime = runtimeOf(gridForm(configuration));
  runtime.addRows(
    "items",
    skus.map((sku) => ({ sku }))
  );
  return runtime;
}

const rowsOf = (root: ShadowRoot): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>("[data-row-index]"));
const skuInputs = (root: ShadowRoot): HTMLInputElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>('.datum-live-field[data-kind="text"]'))
    .filter((w) => w.querySelector("label")?.textContent === "SKU")
    .map((w) => w.querySelector("input") as HTMLInputElement);
const button = (root: ShadowRoot, row: number | "add", action?: string): HTMLButtonElement =>
  (row === "add" ? root.querySelector(`[data-row-action="add"]`) : rowsOf(root)[row]?.querySelector(`[data-row-action="${action}"]`)) as HTMLButtonElement;

describe("data grid: the rows", () => {
  it("draws a row per entry, keyed by the entry, so a removal leaves the other rows' nodes, answers and focus with them", async () => {
    quiet();
    const runtime = withRows({}, ["A", "B", "C"]);
    const m = await mounted(gridForm(), { runtime, features: [createDataGridFeature()] });
    expect(rowsOf(m.root)).toHaveLength(3);
    expect(skuInputs(m.root).map((i) => i.value)).toEqual(["A", "B", "C"]);
    const [, second, third] = skuInputs(m.root) as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    type(second, "Bee");
    await settled(m.form);
    second.focus();

    button(m.root, 0, "remove").click();
    await settled(m.form);
    expect(skuInputs(m.root).map((i) => i.value)).toEqual(["Bee", "C"]);
    // The same nodes, one row up.
    expect(skuInputs(m.root)[0]).toBe(second);
    expect(skuInputs(m.root)[1]).toBe(third);
    expect(runtime.rows("items").map((r) => r.sku)).toEqual(["Bee", "C"]);
    expect(m.root.querySelector('[data-container-id="items"]')?.getAttribute("data-kind")).toBe("dataGrid");
    expect(m.form.adapterOf("items")).toMatchObject({ from: "renderer", name: "datum-grid" });
  });

  it("gives every cell field the DOM contract with the row's own value path", async () => {
    quiet();
    const m = await mounted(gridForm(), { runtime: withRows({}, ["A", "B"]), features: [createDataGridFeature()] });
    const paths = Array.from(m.root.querySelectorAll(".datum-live-field")).map((w) => w.getAttribute("data-value-path"));
    expect(paths).toHaveLength(4);
    expect(new Set(paths).size).toBe(4);
    expect(paths.every((p) => p?.startsWith("items"))).toBe(true);
    const state = m.live().fields().find((f) => f.state.row?.index === 1);
    expect(state?.state.row).toMatchObject({ index: 1, label: "Row 2", ownerId: "items", collectionPath: "items" });
    expect(state?.state.row?.rowKey).toBeTruthy();
  });
});

describe("data grid: the buttons", () => {
  it("adds a row through the runtime and puts focus on its first control once it is drawn", async () => {
    quiet();
    const runtime = withRows({}, ["A"]);
    const m = await mounted(gridForm(), { runtime, features: [createDataGridFeature()] });
    button(m.root, "add").focus();
    button(m.root, "add").click();
    await settled(m.form);
    expect(runtime.rows("items")).toHaveLength(2);
    expect(rowsOf(m.root)).toHaveLength(2);
    expect(m.root.activeElement).toBe(skuInputs(m.root)[1]);
  });

  it("stops Add at the maximum and Remove at the minimum, drawing the button disabled, and offers only what the grid has", async () => {
    quiet();
    // Two rows open at the minimum, which is also the maximum.
    const full = await mounted(gridForm({ maxRows: 2, minRows: 2 }), { runtime: runtimeOf(gridForm({ maxRows: 2, minRows: 2 })), features: [createDataGridFeature()] });
    expect(button(full.root, "add").disabled).toBe(true);
    expect(button(full.root, 0, "remove").disabled).toBe(true);
    expect(button(full.root, 0, "up").disabled).toBe(true);
    expect(button(full.root, 1, "down").disabled).toBe(true);
    expect(button(full.root, 0, "down").disabled).toBe(false);

    const bare = await mounted(gridForm({ canAdd: false, canRemove: false, canReorder: false, initialRows: 1 }), { runtime: runtimeOf(gridForm({ canAdd: false, canRemove: false, canReorder: false, initialRows: 1 })), features: [createDataGridFeature()] });
    expect(bare.root.querySelectorAll("[data-row-action]")).toHaveLength(0);
  });

  it("puts focus after a removal on the row now in its place, the previous row after the last, the Add button after the only one", async () => {
    quiet();
    const m = await mounted(gridForm(), { runtime: withRows({}, ["A", "B", "C"]), features: [createDataGridFeature()] });
    button(m.root, 1, "remove").click();
    await settled(m.form);
    expect(skuInputs(m.root).map((i) => i.value)).toEqual(["A", "C"]);
    expect(m.root.activeElement).toBe(skuInputs(m.root)[1]);

    button(m.root, 1, "remove").click();
    await settled(m.form);
    expect(m.root.activeElement).toBe(skuInputs(m.root)[0]);

    button(m.root, 0, "remove").click();
    await settled(m.form);
    expect(rowsOf(m.root)).toHaveLength(0);
    expect(m.root.activeElement).toBe(button(m.root, "add"));
    expect(m.root.activeElement?.id).toBe(gridAddId("items"));
  });

  it("moves a row and keeps focus on the button pressed, or on the row's first control where that button is now disabled", async () => {
    quiet();
    const runtime = withRows({}, ["A", "B", "C"]);
    const m = await mounted(gridForm(), { runtime, features: [createDataGridFeature()] });
    const pressed = button(m.root, 0, "down");
    pressed.focus();
    pressed.click();
    await settled(m.form);
    expect(runtime.rows("items").map((r) => r.sku)).toEqual(["B", "A", "C"]);
    expect(m.root.activeElement).toBe(pressed);
    expect(pressed.isConnected).toBe(true);

    // Moved to the end: its Move down is disabled, the first control takes it.
    const last = button(m.root, 1, "down");
    last.focus();
    last.click();
    await settled(m.form);
    expect(runtime.rows("items").map((r) => r.sku)).toEqual(["B", "C", "A"]);
    expect(button(m.root, 2, "down").disabled).toBe(true);
    expect(m.root.activeElement).toBe(skuInputs(m.root)[2]);
  });

  it("reports a refusal from the runtime and keeps no focus move queued for it", async () => {
    quiet();
    const runtime = withRows({}, ["A"]);
    const m = await mounted(gridForm(), { runtime, features: [createDataGridFeature()] });
    vi.spyOn(runtime, "addRow").mockImplementation(() => {
      throw new Error("the grid is full");
    });
    button(m.root, "add").click();
    await settled(m.form);
    expect(m.errors).toEqual([{ hook: "grid", id: "items", message: "the grid is full" }]);
    expect(rowsOf(m.root)).toHaveLength(1);
    expect(m.root.activeElement).not.toBe(skuInputs(m.root)[0]);
  });

  it("offers no press in a review or a disabled form, and a lock drops the writes", async () => {
    quiet();
    const review = await mounted(gridForm(), { runtime: withRows({}, ["A", "B"]), mode: "readonly", features: [createDataGridFeature()] });
    expect(review.root.querySelectorAll("[data-row-action]")).toHaveLength(0);
    expect(skuInputs(review.root).every((i) => i.readOnly)).toBe(true);

    const runtime = withRows({}, ["A", "B"]);
    const off = await mounted(gridForm(), { runtime, mode: "disabled", features: [createDataGridFeature()] });
    const buttons = Array.from(off.root.querySelectorAll<HTMLButtonElement>("[data-row-action]"));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    buttons[0]?.click();
    await settled(off.form);
    expect(runtime.rows("items")).toHaveLength(2);
  });
});

describe("data grid: the layout and the state", () => {
  it("hides the labels of the cells' fields in the table layout and keeps them in the stacked one and the auto one", async () => {
    quiet();
    const labels = (root: ShadowRoot): Array<string | null> => Array.from(root.querySelectorAll("label")).map((l) => l.getAttribute("data-hidden"));
    const table = await mounted(gridForm({ layout: "table" }), { runtime: withRows({ layout: "table" }, ["A"]), features: [createDataGridFeature()] });
    expect(labels(table.root)).toEqual(["true", "true"]);
    expect(table.root.querySelector("table")).not.toBeNull();

    const auto = await mounted(gridForm({ layout: "auto" }), { runtime: withRows({ layout: "auto" }, ["A"]), features: [createDataGridFeature()] });
    // Left to the form, the binding's stylesheet hides them while the grid is wide: they are kept for the stacked view.
    expect(labels(auto.root)).toEqual([null, null]);

    const stacked = await mounted(gridForm({ layout: "stacked" }), { runtime: withRows({ layout: "stacked" }, ["A"]), features: [createDataGridFeature()] });
    expect(labels(stacked.root)).toEqual([null, null]);
    // One DOM serves both layouts; the stylesheet restyles it by `data-layout`.
    expect(stacked.root.querySelector('fieldset[data-layout="stacked"]')).not.toBeNull();
    expect(table.root.querySelector('fieldset[data-layout="table"]')).not.toBeNull();
    expect(auto.root.querySelector('fieldset[data-layout="auto"]')).not.toBeNull();
  });

  it("hands an adapter the grid's state: columns with sanitized widths, captions, the Add id, the offers and the row buttons", async () => {
    quiet();
    let state: GridState | undefined;
    const adapter: GridAdapter = {
      kind: "grid",
      name: "ds-grid",
      capabilities: { rowNumbers: "none" },
      template: (s) => {
        state = s;
        return lit.html`<div class="ds-grid">${s.eachRow((row) => lit.html`<div class="ds-row" data-key=${row.key}>${row.cells.map((c) => c.content)}</div>`)}<button type="button" id=${s.addId} ?disabled=${s.add === undefined}>${s.captions.add}</button></div>`;
      }
    };
    const definition = definitionOf([
      {
        id: "items",
        type: "dataGrid",
        configuration: { label: "Items", hint: "x", description: "Things", initialRows: 0, canReorder: true, addLabel: "Add item", maxRows: 3 },
        collection: { collectionPath: "items" },
        children: {
          content: [
            { id: "sku", type: "text", configuration: { label: "SKU", width: "12rem" } },
            { id: "qty", type: "text", configuration: { label: "Quantity", width: "10px; background: red" } }
          ]
        }
      }
    ]);
    const runtime = runtimeOf(definition);
    runtime.addRows("items", [{ sku: "A" }, { sku: "B" }]);
    const m = await mounted(definition, { runtime, binding: createBinding(lit, { components: { ...createBinding(lit).components, dataGrid: adapter } }), features: [createDataGridFeature()] });
    expect(state?.layout).toBe("table");
    expect(state?.columns).toEqual([
      { id: "sku", label: "SKU", required: false, width: "12rem" },
      { id: "qty", label: "Quantity", required: false }
    ]);
    expect(state?.showHeader).toBe(true);
    expect(state?.showRowNumbers).toBe(true);
    expect(state?.captions).toMatchObject({ add: "Add item", remove: "Remove", empty: expect.any(String) });
    expect(state?.addId).toBe("items__add");
    expect(state?.offers).toEqual({ add: true, remove: true, reorder: true });
    expect(state?.hint).toBe("Things");
    expect(state?.rows.map((r) => [r.index, r.label, typeof r.remove, typeof r.moveUp, typeof r.moveDown])).toEqual([
      [0, "Row 1", "function", "undefined", "function"],
      [1, "Row 2", "function", "function", "undefined"]
    ]);
    expect(state?.add).toBeTypeOf("function");
    // The binding draws no row numbers, and the grid has them on: said once.
    expect(m.form.unsupported()).toEqual(["items: rowNumbers"]);
    expect(m.form.adapterOf("items")).toMatchObject({ from: "binding", name: "ds-grid" });

    // Three rows is the maximum: no add.
    runtime.addRow("items", { sku: "C" });
    await settled(m.form);
    expect(state?.add).toBeUndefined();
  });

  it("shows the grid's own errors under the form's error presentation", async () => {
    quiet();
    let state: GridState | undefined;
    const adapter: GridAdapter = { kind: "grid", template: (s) => ((state = s), lit.html`<div>${s.eachRow(() => lit.html``)}</div>`) };
    const binding = createBinding(lit, { components: { ...createBinding(lit).components, dataGrid: adapter } });
    const m = await mounted(gridForm({ minRows: 1 }), { binding, features: [createDataGridFeature()] });
    m.runtime.setValues({ items: [] });
    await m.runtime.validate();
    await settled(m.form);
    expect(state?.errors.length).toBeGreaterThan(0);
    expect(state?.errorId).toBe("items__error");

    const hidden = await mounted(gridForm({ minRows: 1 }), { binding, features: [createDataGridFeature()], errorPresentation: { showComponentErrors: false, showErrorSummary: true } });
    hidden.runtime.setValues({ items: [] });
    await hidden.runtime.validate();
    await settled(hidden.form);
    expect(state?.errors).toEqual([]);
    expect(state?.errorId).toBeUndefined();
  });

  it("falls back to Datum's grid when the binding's template throws", async () => {
    quiet();
    const broken: GridAdapter = {
      kind: "grid",
      template: () => {
        throw new Error("no grid");
      }
    };
    const m = await mounted(gridForm(), { runtime: withRows({}, ["A"]), binding: createBinding(lit, { components: { ...createBinding(lit).components, dataGrid: broken } }), features: [createDataGridFeature()] });
    expect(m.errors.map((e) => e.hook)).toEqual(["template"]);
    expect(rowsOf(m.root)).toHaveLength(1);
    expect(m.form.adapterOf("items")?.from).toBe("renderer");
  });
});
