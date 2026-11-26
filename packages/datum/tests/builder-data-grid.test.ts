import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { ComponentNode, FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { standardComponentDefinitions, standardComponentTypes } from "../src/standard-components.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The `dataGrid` container in the builder. The standard definition declares its one
 * slot and its Rows settings; the palette offers it in Layout; a grid dropped in is bound as a
 * collection at its own id; the inspector's Rows section edits what is the grid's own into
 * `configuration`; and a row bound the form would not use as typed is said under its box.
 * The canvas draws the grid through the renderer (its markup is the renderer's own tests'), so
 * what is asserted here is the builder's side: definition, palette, tree, inspector, JSON.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const gridDefinition = () => standardComponentDefinitions().find((definition) => definition.type === "dataGrid")!;

describe("the standard data grid definition", () => {
  it("declares one content slot that takes any type, directly or nested (a row is refused nothing but the form itself, as every slot is)", () => {
    const slots = gridDefinition().children!.slots;
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ id: "content", multiple: true, emptyHint: "Drop the fields of one row here" });
    expect(slots[0]!.allowedTypes).toBeUndefined();
  });

  it("starts as a labelled, empty grid that files its rows at its own id", () => {
    expect(gridDefinition().createDefault()).toEqual({
      id: "dataGrid",
      type: "dataGrid",
      configuration: { label: "Data grid" },
      collection: { collectionPath: "dataGrid" },
      children: { content: [] }
    });
  });

  it("edits the label, the nine row settings, the empty text and the container's own switches, and offers no Required", () => {
    const fields = gridDefinition().propertyEditor!.fields!;
    const paths = fields.map((field) => field.propertyPath);
    expect(paths).toEqual(
      expect.arrayContaining(["label", "hideLabel", "layout", "showHeader", "showRowNumbers", "rowLabel", "canAdd", "addLabel", "canRemove", "removeLabel", "canReorder", "minRows", "maxRows", "initialRows", "emptyText", "disabled", "cssClass"])
    );
    expect(paths).not.toContain("required");
    expect(fields.find((field) => field.propertyPath === "layout")!.choices!.map((choice) => choice.value)).toEqual(["auto", "table", "stacked"]);
    for (const path of ["addLabel", "removeLabel", "emptyText"]) {
      expect(fields.find((field) => field.propertyPath === path)!.type, path).toBe("localized-text");
    }
    for (const path of ["minRows", "maxRows", "initialRows"]) {
      expect(fields.find((field) => field.propertyPath === path)!.type, path).toBe("number");
    }
  });

  it("is in the palette in Layout order, right after the button group", () => {
    const types = standardComponentTypes().map((entry) => entry.type);
    expect(standardComponentTypes()).toContainEqual({ type: "dataGrid", label: "Data grid" });
    expect(types.indexOf("dataGrid")).toBe(types.indexOf("button-group") + 1);
  });
});

function withGrid(): FormDefinition {
  const definition = sampleDefinition();
  definition.root.children!.content!.splice(1, 0, {
    id: "dependants",
    type: "dataGrid",
    configuration: { label: "Dependants", minRows: 1 },
    collection: { collectionPath: "dependants" },
    children: { content: [{ id: "depName", type: "text", configuration: { label: "Name" } }] }
  });
  return definition;
}

async function mount(definition: FormDefinition = withGrid()): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"), 15000);
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;
const controller = (element: DatumFormBuilderElement) => element.builder!.controller;
const nodeOf = (element: DatumFormBuilderElement, id: string): ComponentNode | undefined => {
  const find = (node: ComponentNode): ComponentNode | undefined =>
    node.id === id ? node : Object.values(node.children ?? {}).flat().map(find).find(Boolean);
  return find(controller(element).snapshot());
};

async function select(element: DatumFormBuilderElement, id: string): Promise<void> {
  controller(element).select(id);
  await until(() => inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === id, 10_000);
}

function type(input: HTMLInputElement, value: string): void {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

/** Walks a shadow tree for the first match, since the palette sits inside the builder's panels. */
function deepQuery(root: ParentNode, selector: string): Element | null {
  const found = root.querySelector(selector);
  if (found) {
    return found;
  }
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot) {
      const inner = deepQuery(element.shadowRoot, selector);
      if (inner) {
        return inner;
      }
    }
  }
  return null;
}

describe("<datum-form-builder> and a data grid", () => {
  it("offers it in the palette's Layout group with the table glyph", async () => {
    const element = await mount();
    const item = deepQuery(shell(element), '[data-palette-type="dataGrid"]');
    expect(item?.closest("[data-palette-group]")?.getAttribute("data-palette-group")).toBe("Layout");
    expect(item?.querySelector(".palette-icon")).not.toBeNull();
    expect(item?.textContent).toContain("Data grid");
  });

  it("adds one that files its rows under its own id and takes any component into its row", async () => {
    const element = await mount(sampleDefinition());
    const ctrl = controller(element);
    ctrl.add("dataGrid");
    const added = ctrl.selectedComponentId()!;
    expect(added).toMatch(/^dataGrid/);
    expect(nodeOf(element, added)).toMatchObject({
      type: "dataGrid",
      configuration: { label: "Data grid" },
      collection: { collectionPath: added },
      children: { content: [] }
    });
    // It asks for the fields of one row where it is empty.
    const view = ctrl.treeView().slots[0]!.children.find((child) => child.id === added)!;
    expect(view.slots.map((slot) => [slot.slotId, slot.definition?.emptyHint])).toEqual([["content", "Drop the fields of one row here"]]);

    // A second grid files its rows under its own id, not the first one's.
    ctrl.add("dataGrid");
    const second = ctrl.selectedComponentId()!;
    expect(second).not.toBe(added);
    expect(nodeOf(element, second)!.collection).toEqual({ collectionPath: second });

    ctrl.add("text", added, "content");
    ctrl.add("number", added, "content");
    expect(ctrl.dropError).toBeUndefined();
    expect(nodeOf(element, added)!.children!.content!.map((child) => child.type)).toEqual(["text", "number"]);
    expect(ctrl.dataPathOf(nodeOf(element, added)!.children!.content![0]!.id)).toBe(`${added}[].${nodeOf(element, added)!.children!.content![0]!.id}`);

    // Any type sits in a row: a button, a file, another grid, tabs, steps, a button group.
    const offered = standardComponentTypes().map((entry) => entry.type);
    const more = ["button", "file", "dataGrid", "tabs", "steps", "button-group", "repeatingSection", "signature"].filter((type) => offered.includes(type));
    expect(more.length).toBeGreaterThanOrEqual(6);
    for (const type of more) {
      ctrl.add(type, added, "content");
      expect(ctrl.dropError, type).toBeUndefined();
    }
    expect(nodeOf(element, added)!.children!.content!.map((child) => child.type)).toEqual(["text", "number", ...more]);
    // One undo per component.
    ctrl.undo();
    expect(nodeOf(element, added)!.children!.content).toHaveLength(1 + more.length);
  });

  it("shows the Rows section with its eleven boxes in the order the definition lists them, and the grid's Required nowhere", async () => {
    const element = await mount();
    await select(element, "dependants");
    const rows = inspector(element).querySelector<HTMLDetailsElement>('details[data-inspector-section="rows"]')!;
    expect(rows).not.toBeNull();
    expect(rows.querySelector("summary")!.textContent).toContain("Rows");
    expect([...rows.querySelectorAll<HTMLElement>("[data-prop]")].map((box) => box.dataset.prop)).toEqual([
      "layout", "showHeader", "showRowNumbers", "rowLabel", "canAdd", "addLabel", "canRemove", "removeLabel", "canReorder", "minRows", "maxRows", "initialRows", "emptyText"
    ]);
    // Column headings are on unless the grid says otherwise.
    expect(rows.querySelector<HTMLInputElement>('[data-prop="showHeader"]')!.checked).toBe(true);
    // What is stored shows as stored; what is not shows the default the grid runs with.
    expect(rows.querySelector<HTMLSelectElement>('[data-prop="layout"]')!.value).toBe("auto");
    expect(rows.querySelector<HTMLInputElement>('[data-prop="canAdd"]')!.checked).toBe(true);
    expect(rows.querySelector<HTMLInputElement>('[data-prop="canReorder"]')!.checked).toBe(false);
    expect(rows.querySelector<HTMLInputElement>('[data-prop="minRows"]')!.value).toBe("1");
    expect(inspector(element).querySelector('[data-prop="required"]')).toBeNull();
    expect(inspector(element).querySelector('details[data-inspector-section="validation"]')).toBeNull();
  });

  it("writes the Rows boxes into the grid's configuration on Save, and the JSON view shows them", async () => {
    const element = await mount();
    await select(element, "dependants");
    const root = inspector(element);
    const box = <T extends HTMLElement>(path: string): T => root.querySelector<T>(`[data-prop="${path}"]`)!;
    const layout = box<HTMLSelectElement>("layout");
    layout.value = "stacked";
    layout.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    const reorder = box<HTMLInputElement>("canReorder");
    reorder.checked = true;
    // A switch edits on `input`, a select on `change`.
    reorder.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    const headings = box<HTMLInputElement>("showHeader");
    headings.checked = false;
    headings.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    type(box<HTMLInputElement>("maxRows"), "6");
    type(box<HTMLInputElement>("initialRows"), "2");
    type(box<HTMLInputElement>("addLabel"), "Add a dependant");
    type(box<HTMLInputElement>("emptyText"), "No dependants yet.");
    await until(() => controller(element).hasPendingChanges("dependants"));
    expect(root.querySelector("[data-inspector-problems]")).toBeNull();

    root.querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    await until(() => !controller(element).hasPendingChanges("dependants"));
    const grid = nodeOf(element, "dependants")!;
    expect(grid.configuration).toMatchObject({
      label: "Dependants",
      minRows: 1,
      maxRows: 6,
      initialRows: 2,
      layout: "stacked",
      canReorder: true,
      showHeader: false,
      addLabel: "Add a dependant",
      emptyText: "No dependants yet."
    });
    // The rows keep their binding, and no operations are authored on it for a grid.
    expect(grid.collection).toEqual({ collectionPath: "dependants" });
    expect(grid.collection).not.toHaveProperty("operations");
    expect(grid.collection).not.toHaveProperty("itemFields");

    root.querySelector<HTMLButtonElement>("[data-inspector-more]")!.click();
    root.querySelector<HTMLButtonElement>('[data-inspector-menu] [data-inspector-tab="json"]')!.click();
    await until(() => root.querySelector("textarea[data-json-edit]"));
    const json = JSON.parse(root.querySelector<HTMLTextAreaElement>("textarea[data-json-edit]")!.value) as ComponentNode;
    expect(json.type).toBe("dataGrid");
    // The JSON view is the component's id, type, configuration and rules; the binding is the "Saved as" line's.
    expect(json.id).toBe("dependants");
    expect(json.configuration).toMatchObject({ maxRows: 6, layout: "stacked", canReorder: true });
    root.querySelector<HTMLButtonElement>('[data-inspector-tab="properties"]')!.click();
    await until(() => root.querySelector<HTMLInputElement>("[data-saved-as] input"));
    expect(root.querySelector<HTMLInputElement>("[data-saved-as] input")!.value).toBe("dependants");
  });

  it("offers the row-bound formulas on the grid's Rules tab, nowhere else, and saves them as rules", async () => {
    const element = await mount();
    await select(element, "dependants");
    const root = inspector(element);
    root.querySelector<HTMLButtonElement>('[data-inspector-tab="rules"]')!.click();
    await until(() => root.querySelector('[data-rule-section="minRows"]'), 10_000);
    const offered = [...root.querySelectorAll<HTMLElement>("[data-rule-section]")].map((section) => section.dataset.ruleSection);
    expect(offered).toContain("minRows");
    expect(offered).toContain("maxRows");
    expect(offered).not.toContain("requiredWhen");
    expect(root.querySelector('[data-rule-section="minRows"]')!.textContent).toContain("Minimum rows formula");
    expect(root.querySelector('[data-rule-section="maxRows"]')!.textContent).toContain("Maximum rows formula");
    expect(root.querySelector('[data-rule-section="minRows"]')!.textContent).toContain("never row.");

    root.querySelector<HTMLButtonElement>('[data-rule="minRows"][data-rule-mode="formula"]')!.click();
    await until(() => root.querySelector('[data-rule="minRows"][data-rule-formula]'));
    const box = root.querySelector<HTMLTextAreaElement>('[data-rule="minRows"][data-rule-formula]')!;
    box.value = "2";
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await until(() => controller(element).hasPendingChanges("dependants"));
    root.querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    await until(() => !controller(element).hasPendingChanges("dependants"));
    expect(nodeOf(element, "dependants")!.rules).toMatchObject({ minRows: expect.anything() });

    // A field in a row, or any other component, is not offered them.
    await select(element, "depName");
    root.querySelector<HTMLButtonElement>('[data-inspector-tab="rules"]')!.click();
    await until(() => root.querySelector("[data-rule-section]"), 10_000);
    expect([...root.querySelectorAll<HTMLElement>("[data-rule-section]")].map((section) => section.dataset.ruleSection)).not.toContain("minRows");
  });

  it("names the container chip on the canvas Data grid, not the type's stored name", async () => {
    const element = await mount();
    const canvas = shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
    await until(() => deepQuery(canvas, '[data-component-id="dependants"] .db-tag, .db-node[data-component-id="dependants"] > .db-tag'), 10_000);
    const tags = [...(deepQuery(canvas, '[data-component-id="dependants"]')?.querySelectorAll(".db-tag") ?? [])].map((tag) => tag.textContent);
    expect(tags).toContain("Data grid");
    expect(tags).not.toContain("dataGrid");
  });

  it("says a maximum below the minimum under the maximum, and Save leads there instead of writing it", async () => {
    const element = await mount();
    await select(element, "dependants");
    const root = inspector(element);
    type(root.querySelector<HTMLInputElement>('[data-prop="minRows"]')!, "5");
    type(root.querySelector<HTMLInputElement>('[data-prop="maxRows"]')!, "3");
    await until(() => root.querySelector("#problem-maxRows"));
    const message = root.querySelector<HTMLElement>("#problem-maxRows")!;
    expect(message.textContent).toContain("Maximum rows is below the minimum");
    const maxBox = root.querySelector<HTMLInputElement>('[data-prop="maxRows"]')!;
    expect(message.closest(".property-row")).toBe(maxBox.closest(".property-row"));
    expect(maxBox.getAttribute("aria-invalid")).toBe("true");
    const save = root.querySelector<HTMLButtonElement>("[data-inspector-save]")!;
    expect(save.disabled).toBe(false);

    save.click();
    expect(controller(element).hasPendingChanges("dependants")).toBe(true);
    expect((nodeOf(element, "dependants")!.configuration as Record<string, unknown>).maxRows).toBeUndefined();
    expect(root.querySelector("[data-inspector-status]")!.textContent).toContain("Not saved: 1 problem");

    type(root.querySelector<HTMLInputElement>('[data-prop="maxRows"]')!, "8");
    await until(() => !root.querySelector("#problem-maxRows"));
    root.querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    await until(() => !controller(element).hasPendingChanges("dependants"));
    expect(nodeOf(element, "dependants")!.configuration).toMatchObject({ minRows: 5, maxRows: 8 });
  });

  it("says a bound past 500 under its own box", async () => {
    const element = await mount();
    await select(element, "dependants");
    const root = inspector(element);
    type(root.querySelector<HTMLInputElement>('[data-prop="initialRows"]')!, "900");
    await until(() => root.querySelector("#problem-initialRows"));
    expect(root.querySelector("#problem-initialRows")!.textContent).toBe("At most 500.");
    type(root.querySelector<HTMLInputElement>('[data-prop="initialRows"]')!, "500");
    await until(() => !root.querySelector("#problem-initialRows"));
  });

  it("offers a field in its row Required when and a calculation as in any repeating section, but the grid no Required", async () => {
    const element = await mount();
    expect(controller(element).typeOffersRequired("dataGrid")).toBe(false);
    await select(element, "depName");
    // Its place is in the entry: `dependants[].depName`.
    expect(controller(element).dataPathOf("depName")).toBe("dependants[].depName");
    expect(inspector(element).querySelector('[data-prop="required"]')).not.toBeNull();
  });

  it("follows the id the author gives it with its collection path, so the rows stay where the id says", async () => {
    const element = await mount(sampleDefinition());
    const ctrl = controller(element);
    ctrl.add("dataGrid");
    const added = ctrl.selectedComponentId()!;
    ctrl.renameId(added, "children");
    expect(nodeOf(element, "children")!.collection).toEqual({ collectionPath: "children" });
    expect(ctrl.dataPathOf("children")).toBe("children");
  });
});
