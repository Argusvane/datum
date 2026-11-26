import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import type { FormDefinition } from "@argusvane/datum-engine";

import { until } from "./helpers.js";

/**
 * A data grid through `<datum-form>`: its Add, Remove, Move up and Move down
 * go through the runtime, the rows are drawn again, focus lands where the person expects it,
 * `datum-change` reports the settled rows, and a draft brings the rows back.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function gridForm(configuration: Record<string, unknown> = {}, rules?: Record<string, unknown>, before: FormDefinition["root"][] = []): FormDefinition {
  return {
    id: "grid-form",
    version: "1.0.0",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          ...before,
          {
            id: "items",
            type: "dataGrid",
            configuration: { label: "Items", canReorder: true, ...configuration },
            ...(rules ? { rules } : {}),
            collection: { collectionPath: "items" },
            children: {
              content: [
                { id: "sku", type: "text", configuration: { label: "SKU", required: true } },
                { id: "qty", type: "number", configuration: { label: "Quantity" } },
                { id: "total", type: "number", configuration: { label: "Total", readOnly: true }, rules: { value: "row.qty * 2" } }
              ]
            }
          }
        ]
      }
    }
  };
}

function mount(configure: (element: DatumFormElement) => void = (element) => (element.definition = gridForm())): DatumFormElement {
  const element = document.createElement("datum-form") as DatumFormElement;
  configure(element);
  document.body.append(element);
  return element;
}

async function painted(element: DatumFormElement): Promise<ShadowRoot> {
  await until(() => element.renderer?.shadowRoot?.querySelector('[data-container-id="items"][data-kind="dataGrid"]'));
  return element.renderer!.shadowRoot!;
}

const rows = (form: ShadowRoot) => [...form.querySelectorAll<HTMLElement>("[data-row-index]:not([data-row-action])")];
const action = (form: ShadowRoot, name: string, index?: number) =>
  (index === undefined ? form : rows(form)[index]!).querySelector<HTMLButtonElement>(`[data-row-action="${name}"]`)!;
/** A person's press: the button takes focus, then acts. */
const press = (button: HTMLButtonElement) => {
  button.focus();
  button.click();
};
const skuInputs = (form: ShadowRoot) => [...form.querySelectorAll<HTMLInputElement>('[data-component-id="sku"] input')];
const type = (input: HTMLInputElement, value: string) => {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
};

describe("<datum-form> data grid rows", () => {
  it("adds a row through the runtime and puts focus on the new row's first control", async () => {
    const element = mount();
    const form = await painted(element);
    expect(rows(form)).toHaveLength(1);
    action(form, "add").click();
    await until(() => rows(form).length === 2);
    await until(() => form.activeElement === skuInputs(form)[1]);
    expect(skuInputs(form).map((input) => input.closest("[data-value-path]")!.getAttribute("data-value-path"))).toEqual(["items[0].sku", "items[1].sku"]);
  });

  it("removes a row and puts focus on the first control at that row position, else on Add", async () => {
    const element = mount();
    const form = await painted(element);
    action(form, "add").click();
    await until(() => rows(form).length === 2);
    type(skuInputs(form)[1]!, "B");
    await until(() => element.values["items[1].sku"] === "B");
    action(form, "remove", 0).click();
    await until(() => rows(form).length === 1);
    expect(skuInputs(form)[0]?.value).toBe("B");
    await until(() => form.activeElement === skuInputs(form)[0]);
    // Removing the last row leaves no row at that position: Add takes focus.
    action(form, "remove", 0).click();
    await until(() => rows(form).length === 0);
    expect(form.querySelector('[data-container-id="items"]')?.textContent).toContain("No rows yet.");
    await until(() => form.activeElement === action(form, "add"));
  });

  it("moves a row and keeps focus on the button pressed where it is still enabled, else on the moved row's first control", async () => {
    const element = mount((el) => (el.definition = gridForm({ initialRows: 3 })));
    const form = await painted(element);
    await until(() => rows(form).length === 3);
    for (const [index, value] of ["A", "B", "C"].entries()) {
      type(skuInputs(form)[index]!, value);
    }
    await until(() => element.values["items[2].sku"] === "C");
    // Down from the first row: the moved row is in the middle, so its Move down is still enabled and keeps focus.
    press(action(form, "down", 0));
    await until(() => skuInputs(form).map((input) => input.value).join("") === "BAC");
    await until(() => form.activeElement === action(form, "down", 1));
    // Down again: the moved row is now last, its Move down is disabled, so its first control takes focus.
    press(action(form, "down", 1));
    await until(() => skuInputs(form).map((input) => input.value).join("") === "BCA");
    await until(() => form.activeElement === skuInputs(form)[2]);
    // Up from the last row: the moved row is in the middle and its Move up keeps focus.
    press(action(form, "up", 2));
    await until(() => skuInputs(form).map((input) => input.value).join("") === "BAC");
    await until(() => form.activeElement === action(form, "up", 1));
  });

  it("keeps typing in the row it is typed into across the repaint each keystroke brings", async () => {
    const element = mount();
    const form = await painted(element);
    action(form, "add").click();
    await until(() => rows(form).length === 2);
    const second = skuInputs(form)[1]!;
    type(second, "x");
    await until(() => element.values["items[1].sku"] === "x");
    await until(() => (form.activeElement as HTMLElement | null)?.closest("[data-value-path]")?.getAttribute("data-value-path") === "items[1].sku");
    expect(element.values["items[0].sku"]).toBeUndefined();
  });

  it("reports each row action as one settled datum-change, the rows' calculations worked out", async () => {
    const element = mount();
    const form = await painted(element);
    const changes: Array<{ path: string | undefined; value: unknown; values: Record<string, unknown> }> = [];
    element.addEventListener("datum-change", (event) => {
      const detail = (event as CustomEvent<{ path: string | undefined; value: unknown; values: Record<string, unknown> }>).detail;
      changes.push({ path: detail.path, value: detail.value, values: detail.values });
    });
    type(form.querySelector<HTMLInputElement>('[data-value-path="items[0].qty"] input')!, "3");
    form.querySelector<HTMLInputElement>('[data-value-path="items[0].qty"] input')!.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    await until(() => changes.some((change) => change.path === "items[0].qty"));
    changes.length = 0;
    action(form, "add").click();
    await until(() => changes.some((change) => change.path === "items"));
    const added = changes.find((change) => change.path === "items")!;
    expect(added.values["items[0].total"]).toBe(6);
    // The change's own value is the rows as the answers hold them, each row's calculation in it.
    const rowsValue = added.value as Array<Record<string, unknown>>;
    expect(rowsValue).toHaveLength(2);
    expect(rowsValue[0]).toMatchObject({ qty: 3, total: 6 });
    expect(Object.keys(added.values).filter((key) => key.startsWith("items[1]")).sort()).toEqual(["items[1].qty", "items[1].sku", "items[1].total"]);
    expect(changes.filter((change) => change.path === "items")).toHaveLength(1);
  });

  it("names a row's error in the summary and goes to that row's control", async () => {
    const element = mount();
    const form = await painted(element);
    action(form, "add").click();
    await until(() => rows(form).length === 2);
    type(skuInputs(form)[0]!, "A");
    await until(() => element.values["items[0].sku"] === "A");
    await element.validate();
    const entry = await (async () => {
      await until(() => form.querySelector('[role="alert"] a'));
      return [...form.querySelectorAll<HTMLAnchorElement>('[role="alert"] a')].find((link) => link.textContent!.startsWith("Row 2"))!;
    })();
    expect(entry.textContent).toBe("Row 2: SKU: This field is required");
    entry.click();
    await until(() => form.activeElement === skuInputs(form)[1]);
  });

  it("brings a draft's rows back", async () => {
    const element = mount((el) => {
      el.setAttribute("draft", "grid-draft");
      el.definition = gridForm();
    });
    const form = await painted(element);
    action(form, "add").click();
    await until(() => rows(form).length === 2);
    type(skuInputs(form)[1]!, "second");
    await until(() => element.values["items[1].sku"] === "second");
    let stored = false;
    for (let attempt = 0; attempt < 40 && !stored; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      stored = await element.hasDraft();
    }
    expect(stored).toBe(true);
    element.remove();

    const again = mount((el) => {
      el.setAttribute("draft", "grid-draft");
      el.definition = gridForm();
    });
    const restored = await painted(again);
    expect(rows(restored)).toHaveLength(1);
    await again.restoreDraft();
    await until(() => rows(restored).length === 2);
    expect(skuInputs(restored)[1]?.value).toBe("second");
    await again.clearDraft();
  });

  it("draws the template while the canvas edits it", async () => {
    const element = mount();
    const form = await painted(element);
    element.renderer!.dataGridRows = "template";
    await until(() => form.querySelectorAll("[data-row-action]").length === 0);
    expect(skuInputs(form)).toHaveLength(1);
    expect(skuInputs(form)[0]!.closest("[data-value-path]")?.getAttribute("data-value-path")).toBe("sku");
    element.renderer!.dataGridRows = "entries";
    await until(() => form.querySelectorAll("[data-row-action]").length > 0);
  });

  it("draws rows a host hands over whole before the first paint, and keeps no answer at the bare path", async () => {
    const element = mount((el) => {
      el.definition = gridForm();
      el.values = { items: [{ sku: "A" }, { sku: "B", qty: 2 }] };
    });
    const form = await painted(element);
    await until(() => rows(form).length === 2);
    expect(skuInputs(form).map((input) => input.value)).toEqual(["A", "B"]);
    await until(() => element.values["items[1].total"] === 4);
    expect("items" in element.values).toBe(false);
  });

  it("disables Add at the maximum the grid's formula gives, and enables it again when the answer changes", async () => {
    const people = { id: "people", type: "number", configuration: { label: "People" } };
    const element = mount((el) => {
      el.definition = gridForm({ initialRows: 1 }, { maxRows: "people" }, [people]);
      el.values = { people: 1 };
    });
    const form = await painted(element);
    await until(() => action(form, "add").disabled);
    element.runtime!.setValue("people", 2);
    await until(() => !action(form, "add").disabled);
    action(form, "add").click();
    await until(() => rows(form).length === 2);
    await until(() => action(form, "add").disabled);
  });

  it("sends focus for a cell error no row owns to the grid's Add button", async () => {
    const element = mount();
    const form = await painted(element);
    element.runtime!.setErrors([{ code: "option.notAllowed", componentId: "sku", path: "items.sku", parameters: { keys: ["items[0].sku"] } }]);
    await until(() => form.querySelector('[data-container-id="items"] > fieldset > [role="alert"]'));
    element.renderer!.focusFirstError();
    // Focus goes to the error summary first (errorFocus "summary"); its entry then goes to the Add button.
    await until(() => form.activeElement === form.querySelector('[role="alert"][tabindex="-1"]'));
    // And so does its summary entry.
    (form.activeElement as HTMLElement).blur();
    const entry = form.querySelector<HTMLAnchorElement>('[role="alert"] a[href="#items"]');
    expect(entry?.getAttribute("href")).toBe("#items");
    entry!.click();
    await until(() => form.activeElement === action(form, "add"));
  });
});
