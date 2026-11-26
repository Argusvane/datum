import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import { BUILDER_DRAG_MIME_TYPE, serializeDragPayload, type FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/** The canvas's edit and preview, its keys, the selection bar and the canvas bar. */

afterEach(() => {
  document.body.innerHTML = "";
});

function withGroup(): FormDefinition {
  const definition = sampleDefinition();
  definition.root.children!.content!.splice(1, 0, {
    id: "address",
    type: "fieldset",
    configuration: { label: "Address" },
    children: { content: [{ id: "street", type: "text", configuration: { label: "Street" } }] }
  });
  return definition;
}

function withGrid(): FormDefinition {
  const definition = sampleDefinition();
  definition.root.children!.content!.splice(1, 0, {
    id: "dependants",
    type: "dataGrid",
    configuration: { label: "Dependants" },
    collection: { collectionPath: "dependants" },
    children: {
      content: [
        { id: "depName", type: "text", configuration: { label: "Name" } },
        { id: "depAge", type: "number", configuration: { label: "Age" } }
      ]
    }
  });
  return definition;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const canvasEl = (element: DatumFormBuilderElement) => shell(element).querySelector("datum-builder-canvas")! as HTMLElement & { previewing: boolean };
const canvas = (element: DatumFormBuilderElement): ShadowRoot => canvasEl(element).shadowRoot!;
const pane = (element: DatumFormBuilderElement): HTMLElement => canvas(element).querySelector<HTMLElement>(".canvas-page")!;
const renderer = (element: DatumFormBuilderElement): HTMLElement => canvas(element).querySelector<HTMLElement>("datum-form-renderer[data-preview]")!;
const form = (element: DatumFormBuilderElement): ShadowRoot => renderer(element).shadowRoot!;
const zone = (element: DatumFormBuilderElement): HTMLElement => canvas(element).querySelector<HTMLElement>("[data-selection-zone]")!;
const action = (element: DatumFormBuilderElement, id: string): HTMLButtonElement =>
  canvas(element).querySelector<HTMLButtonElement>(`[data-selection-action="${id}"]`)!;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;
const ids = (element: DatumFormBuilderElement): string[] => (element.builder!.controller.treeView().slots[0]?.children ?? []).map((child) => child.id);
const press = (target: HTMLElement, key: string, init: KeyboardEventInit = {}): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init }));
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(definition: FormDefinition = sampleDefinition()): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  document.body.append(element);
  await until(() => form(element)?.querySelector('[data-component-id="fullName"]'));
  await settle();
  return element;
}

describe("canvas edit and preview", () => {
  it("edits by default: one Tab stop, the fields out of the Tab order, a click on a control selects its field", async () => {
    const element = await mount();
    expect(canvasEl(element).previewing).toBe(false);
    expect(pane(element).tabIndex).toBe(0);
    expect(pane(element).getAttribute("aria-label")).toBe("Form canvas");
    const input = form(element).querySelector<HTMLElement>('[data-component-id="fullName"] input')!;
    expect(input.getAttribute("tabindex")).toBe("-1");
    expect(input.hasAttribute("data-db-inert")).toBe(true);
    input.click();
    expect(element.builder!.controller.selectedComponentId()).toBe("fullName");
  });

  it("previews on Try it: the fields back in the Tab order, chrome away, clicks not selecting; and back", async () => {
    const element = await mount();
    const heard: boolean[] = [];
    element.builder!.addEventListener("canvas-preview-change", (event) => heard.push((event as CustomEvent<{ previewing: boolean }>).detail.previewing));
    element.builder!.controller.select("fullName");
    await until(() => !zone(element).hidden);

    const tryIt = canvas(element).querySelector<HTMLButtonElement>("[data-try-it]")!;
    tryIt.click();
    await settle();
    expect(canvasEl(element).previewing).toBe(true);
    expect(tryIt.getAttribute("aria-pressed")).toBe("true");
    expect(tryIt.textContent).toBe("Back to editing");
    expect(canvas(element).querySelector<HTMLElement>("[data-previewing-note]")!.hidden).toBe(false);
    expect(renderer(element).hasAttribute("data-previewing")).toBe(true);
    expect(zone(element).hidden).toBe(true);
    // A text input: jsdom loops on a click given to a select inside its label.
    const input = form(element).querySelector<HTMLElement>('[data-component-id="fullName"] input')!;
    expect(input.hasAttribute("data-db-inert")).toBe(false);
    expect(input.getAttribute("tabindex")).toBeNull();
    element.builder!.controller.select("country");
    input.click();
    expect(element.builder!.controller.selectedComponentId()).toBe("country");

    tryIt.click();
    await settle();
    expect(canvasEl(element).previewing).toBe(false);
    expect(renderer(element).hasAttribute("data-previewing")).toBe(false);
    expect(form(element).querySelector('[data-component-id="fullName"] input')!.getAttribute("tabindex")).toBe("-1");
    expect(heard).toEqual([true, false]);
  });

  it("sets the preview width from the device buttons, a second press letting it go", async () => {
    const element = await mount();
    const phone = canvas(element).querySelector<HTMLButtonElement>('[data-device-width="390"]')!;
    phone.click();
    expect(element.builder!.controller.previewWidth()).toBe(390);
    await until(() => phone.getAttribute("aria-pressed") === "true");
    phone.click();
    expect(element.builder!.controller.previewWidth()).toBeUndefined();
  });
});

describe("a data grid on the canvas", () => {
  it("draws the row template while editing and the real rows while previewing, asking the renderer for each", async () => {
    const element = await mount(withGrid());
    const rendererEl = renderer(element) as HTMLElement & { dataGridRows?: string };
    expect(rendererEl.dataGridRows).toBe("template");
    canvas(element).querySelector<HTMLButtonElement>("[data-try-it]")!.click();
    await settle();
    expect(canvasEl(element).previewing).toBe(true);
    expect(rendererEl.dataGridRows).toBe("entries");
    canvas(element).querySelector<HTMLButtonElement>("[data-try-it]")!.click();
    await settle();
    expect(rendererEl.dataGridRows).toBe("template");
  });

  it("selects the grid's fields by their own ids, and takes the grid from the tree", async () => {
    const element = await mount(withGrid());
    await until(() => form(element).querySelector('[data-component-id="depName"]'));
    form(element).querySelector<HTMLElement>('[data-component-id="depName"] input')!.click();
    expect(element.builder!.controller.selectedComponentId()).toBe("depName");
    element.builder!.controller.select("dependants");
    await until(() => form(element).querySelector('.db-selected[data-component-id="dependants"]'));
    // Its one slot is a drop target, so a field can be dropped into the row: asserted on the
    // canvas the author sees (a drop zone for the grid's slot inside the template row's cell),
    // not on the tree view alone, which would pass with no zone drawn.
    const slot = form(element).querySelector<HTMLElement>('[data-dropzone][data-parent-id="dependants"]');
    expect(slot).not.toBeNull();
    expect(slot!.closest('[data-container-id="dependants"]')).not.toBeNull();
    expect(slot!.querySelector('[data-component-id="depName"]')).not.toBeNull();
    expect(element.builder!.controller.treeView().slots[0]?.children.find((child) => child.id === "dependants")?.slots.map((slot) => slot.slotId)).toEqual(["content"]);
  });
});

describe("a data grid's row template takes drops along x", () => {
  /** A grid of three columns, so a drop can land between two of them. */
  function withWideGrid(): FormDefinition {
    const definition = withGrid();
    const grid = definition.root.children!.content!.find((node) => node.id === "dependants")!;
    grid.children!.content!.push({ id: "depCity", type: "text", configuration: { label: "City" } });
    return definition;
  }

  /** A drag carrying a component already on the canvas, as the browser hands one to the canvas. */
  function dragEvent(type: string, componentId: string, clientX = 0): Event {
    const payload = serializeDragPayload({ kind: "existing-component", componentId });
    const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
    const dataTransfer = {
      types: [BUILDER_DRAG_MIME_TYPE],
      effectAllowed: "move",
      dropEffect: "none",
      getData: (mime: string) => (mime === BUILDER_DRAG_MIME_TYPE ? payload : ""),
      setData: () => undefined
    };
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    Object.defineProperty(event, "clientX", { value: clientX });
    return event;
  }

  const slotZone = (element: DatumFormBuilderElement): HTMLElement =>
    form(element).querySelector<HTMLElement>('[data-dropzone][data-parent-id="dependants"]')!;

  it("draws the slot's zone horizontal, and every other shell slot vertical", async () => {
    const element = await mount(withWideGrid());
    const grid = slotZone(element);
    expect(grid.dataset.axis).toBe("horizontal");
    // The form's own stack keeps its axis.
    const root = form(element).querySelector<HTMLElement>('[data-dropzone][data-parent-id="root"]')!;
    expect(root.dataset.axis).toBe("vertical");
  });

  it("lands a drop between two columns by the pointer's x, not only before the first or after the last", async () => {
    const element = await mount(withWideGrid());
    const zoneEl = slotZone(element);
    // jsdom lays nothing out: three 100px columns side by side, 0-100, 100-200, 200-300.
    const columns = [...zoneEl.querySelectorAll<HTMLElement>("[data-component-id].datum-live-field")];
    expect(columns.map((column) => column.dataset.componentId)).toEqual(["depName", "depAge", "depCity"]);
    columns.forEach((column, i) => {
      column.getBoundingClientRect = () => ({ left: i * 100, top: 0, width: 100, height: 40, right: i * 100 + 100, bottom: 40, x: i * 100, y: 0, toJSON: () => ({}) });
    });

    // x = 160 is past the middle of the second column (150) and before the third's (250): between them.
    zoneEl.dispatchEvent(dragEvent("dragover", "fullName", 160));
    const marker = zoneEl.querySelector(".db-marker");
    expect(marker).not.toBeNull();
    expect(marker!.nextElementSibling?.getAttribute("data-component-id")).toBe("depCity");

    // The drop lands where the marker stood: the third place of four.
    zoneEl.dispatchEvent(dragEvent("drop", "fullName", 160));
    const grid = element.builder!.controller.treeView().slots[0]?.children.find((child) => child.id === "dependants");
    expect(grid?.slots[0]?.children.map((child) => child.id)).toEqual(["depName", "depAge", "fullName", "depCity"]);
  });
});

describe("canvas keys", () => {
  it("walks the components in reading order, into and out of a container, and to either end", async () => {
    const element = await mount(withGroup());
    const controller = element.builder!.controller;
    const target = pane(element);
    press(target, "ArrowDown");
    expect(controller.selectedComponentId()).toBe("fullName");
    press(target, "ArrowDown");
    expect(controller.selectedComponentId()).toBe("address");
    press(target, "ArrowRight");
    expect(controller.selectedComponentId()).toBe("street");
    expect(canvas(element).querySelector("[data-canvas-announce]")!.textContent).toContain("Street");
    press(target, "ArrowLeft");
    expect(controller.selectedComponentId()).toBe("address");
    press(target, "End");
    expect(controller.selectedComponentId()).toBe("submit");
    press(target, "Home");
    expect(controller.selectedComponentId()).toBe("fullName");
    press(target, "Escape");
    expect(controller.selectedComponentId()).toBeUndefined();
  });

  it("moves the selection with Alt and an arrow, one undo step each", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    controller.select("fullName");
    press(pane(element), "ArrowDown", { altKey: true });
    expect(ids(element).slice(0, 2)).toEqual(["country", "fullName"]);
    controller.undo();
    expect(ids(element).slice(0, 2)).toEqual(["fullName", "country"]);
  });

  it("asks before Delete removes, and Cancel keeps it", async () => {
    const element = await mount();
    element.builder!.controller.select("country");
    press(pane(element), "Delete");
    const prompt = canvas(element).querySelector<HTMLElement>("[data-delete-prompt]")!;
    expect(prompt.textContent).toContain("Country");
    canvas(element).querySelector<HTMLButtonElement>("[data-confirm-cancel]")!.click();
    expect(canvas(element).querySelector("[data-delete-prompt]")).toBeNull();
    expect(ids(element)).toContain("country");
    press(pane(element), "Backspace");
    canvas(element).querySelector<HTMLButtonElement>("[data-confirm-delete]")!.click();
    expect(ids(element)).not.toContain("country");
  });

  it("opens the inspector on Enter", async () => {
    const element = await mount();
    let asked = 0;
    element.builder!.addEventListener("canvas-edit-selection", () => asked++);
    element.builder!.controller.select("fullName");
    press(pane(element), "Enter");
    expect(asked).toBe(1);
    expect(shell(element).querySelector(".wrap")!.hasAttribute("data-props-collapsed")).toBe(false);
  });

  it("leaves the keys to the form while previewing", async () => {
    const element = await mount();
    canvasEl(element).previewing = true;
    press(pane(element), "ArrowDown");
    expect(element.builder!.controller.selectedComponentId()).toBeUndefined();
  });
});

describe("selection bar", () => {
  it("shows only with a selection, names it, and disables what cannot happen there", async () => {
    const element = await mount();
    expect(zone(element).hidden).toBe(true);
    element.builder!.controller.select("fullName");
    await until(() => !zone(element).hidden);
    const bar = canvas(element).querySelector<HTMLElement>("[data-selection-bar]")!;
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(bar.getAttribute("aria-label")).toBe("Selected: Full name");
    expect(action(element, "up").disabled).toBe(true);
    expect(action(element, "down").disabled).toBe(false);
    // One Tab stop on the first enabled button (Move to... is the third).
    expect([...bar.querySelectorAll<HTMLElement>("[data-selection-action]")].map((button) => button.getAttribute("tabindex"))).toEqual(["-1", "0", "-1", "-1", "-1", "-1"]);
    element.builder!.controller.select("submit");
    await until(() => action(element, "down").disabled);
    expect(action(element, "up").disabled).toBe(false);
    element.builder!.controller.select("root");
    await until(() => zone(element).hidden);
  });

  it("moves, duplicates and deletes through its buttons", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    controller.select("country");
    await until(() => !zone(element).hidden);
    action(element, "up").click();
    expect(ids(element).slice(0, 2)).toEqual(["country", "fullName"]);
    action(element, "duplicate").click();
    expect(ids(element).length).toBe(6);
    expect(ids(element)[1]).not.toBe("country");
    expect(controller.selectedComponentId()).toBe(ids(element)[1]);
    action(element, "delete").click();
    canvas(element).querySelector<HTMLButtonElement>("[data-confirm-delete]")!.click();
    expect(ids(element).length).toBe(5);
  });

  it("roves its buttons with the arrow keys", async () => {
    const element = await mount();
    element.builder!.controller.select("country");
    await until(() => !zone(element).hidden);
    const first = action(element, "up");
    first.focus();
    press(first, "ArrowRight");
    expect(canvas(element).activeElement).toBe(action(element, "down"));
    press(action(element, "down"), "End");
    expect(canvas(element).activeElement).toBe(action(element, "delete"));
    expect(action(element, "delete").getAttribute("tabindex")).toBe("0");
  });

  it("opens the inspector on the Rules tab from Add logic", async () => {
    const element = await mount();
    element.builder!.controller.select("email");
    await until(() => !zone(element).hidden);
    action(element, "logic").click();
    await until(() => inspector(element).querySelector('[data-inspector-tab="rules"].active'));
  });
});
