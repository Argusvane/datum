import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import "../src/builder.js";
import type { DatumFormElement, DatumFormSubmitDetail } from "../src/form.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { standardComponentDefinitions, standardComponentTypes } from "../src/standard-components.js";
import { BUILDER_DRAG_MIME_TYPE, type ComponentNode, type FormDefinition } from "@argusvane/datum-engine";

import { until } from "./helpers.js";

/**
 * The `button-group` component on both surfaces — the running form draws its
 * buttons in the group's row and they act as buttons do; the builder offers it in the Layout
 * group, takes buttons alone into it, and lays its drop zone on the group's own element.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function definition(): FormDefinition {
  const actions: ComponentNode = {
    id: "actions",
    type: "button-group",
    configuration: {},
    children: {
      content: [
        { id: "send", type: "button", configuration: { label: "Send", action: "submit" } },
        { id: "later", type: "button", configuration: { label: "Save a copy", action: "download", variant: "link" } }
      ]
    }
  };
  return {
    id: "grouped",
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "name", type: "text", configuration: { label: "Name", required: true } }, actions] }
    }
  };
}

function listen<T>(element: HTMLElement, type: string): T[] {
  const seen: T[] = [];
  element.addEventListener(type, (event) => seen.push((event as CustomEvent<T>).detail));
  return seen;
}

describe("the standard button-group definition", () => {
  it("is a container whose one slot takes buttons alone, with no settings but its classes, in the palette as Button group", () => {
    const group = standardComponentDefinitions().find((entry) => entry.type === "button-group")!;
    expect(group.children).toEqual({ slots: [{ id: "content", multiple: true, allowedTypes: ["button"], emptyHint: "Drop buttons here." }] });
    expect(group.createDefault()).toEqual({ id: "button-group", type: "button-group", configuration: {}, children: { content: [] } });
    expect(group.propertyEditor).toEqual({ mode: "replace", fields: [{ id: "cssClass", type: "text", propertyPath: "cssClass", label: "CSS classes" }] });
    const types = standardComponentTypes().map((entry) => entry.type);
    expect(standardComponentTypes()).toContainEqual({ type: "button-group", label: "Button group" });
    expect(types.indexOf("button-group")).toBe(types.indexOf("grid") + 1);
  });
});

describe("<datum-form> and a button group", () => {
  it("draws the group's buttons in its box, and a button in it still acts", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    element.definition = definition();
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("form"));
    const form = element.renderer!.shadowRoot!;
    const box = '[data-container-id="actions"][data-kind="button-group"]';
    const buttonOf = (id: string) => form.querySelector<HTMLButtonElement>(`${box} [data-component-id="${id}"] button`);
    const send = buttonOf("send");
    expect(send).not.toBeNull();
    // Both buttons share one parent: the group's row, with the group's own element around it.
    expect(buttonOf("later")!.closest("[data-component-id]")!.parentElement).toBe(send!.closest("[data-component-id]")!.parentElement);
    expect(buttonOf("later")!.getAttribute("data-button-action")).toBe("download");
    expect(form.querySelector(box)!.getAttribute("style")).toBeNull();

    const submits = listen<DatumFormSubmitDetail>(element, "datum-submit");
    send!.click();
    await until(() => submits.length === 1);
    expect(submits[0]!.accepted).toBe(false);
    expect(submits[0]!.errors.some((error) => error.componentId === "name" && error.code === "required")).toBe(true);
    const input = form.querySelector<HTMLInputElement>('[data-component-id="name"] input')!;
    input.value = "Ada";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await until(() => element.values.name === "Ada");
    buttonOf("send")!.click();
    await until(() => submits.length === 2);
    expect(submits[1]!.accepted).toBe(true);
  });
});

/** Every element under `root`, through open shadow roots. */
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

/** A drag's data as the canvas reads it: the builder's own type, a palette template's payload. */
function transferOf(payload: unknown): DataTransfer {
  const store = new Map<string, string>([[BUILDER_DRAG_MIME_TYPE, JSON.stringify(payload)]]);
  return {
    types: [...store.keys()],
    getData: (key: string) => store.get(key) ?? "",
    setData: (key: string, value: string) => void store.set(key, value),
    effectAllowed: "copy",
    dropEffect: "none"
  } as unknown as DataTransfer;
}

function dragEvent(type: "dragover" | "drop", transfer: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  return event;
}

describe("<datum-form-builder> and a button group", () => {
  async function mount(): Promise<{ builder: DatumFormBuilderElement; preview: () => ShadowRoot }> {
    const builder = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    builder.definition = definition();
    document.body.append(builder);
    const canvas = () => builder.builder?.shadowRoot?.querySelector("datum-builder-canvas") as (HTMLElement & { previewRoot?: () => ShadowRoot | undefined }) | null;
    // The builder's first boot in a run loads its panels; give it room.
    await until(() => canvas()?.previewRoot?.()?.querySelector('[data-container-id="actions"]'), 15000);
    return { builder, preview: () => canvas()!.previewRoot!()! };
  }

  it("offers it in the palette's Layout group, and takes buttons alone into it, one undoable edit each", async () => {
    const { builder, preview } = await mount();
    const controller = builder.controller!;
    const item = deepQuery(builder.builder!.shadowRoot!, '[data-palette-type="button-group"]');
    expect(item?.closest("[data-palette-group]")?.getAttribute("data-palette-group")).toBe("Layout");
    expect(item?.querySelector(".palette-icon")).not.toBeNull();

    // A new group from the palette: empty, asking for buttons, a drop target along the row.
    controller.add("button-group");
    const added = controller.selectedComponentId()!;
    expect(added).toMatch(/^button-group/);
    await until(() => preview().querySelector(`[data-dropzone="true"][data-parent-id="${added}"]`));
    const zone = preview().querySelector<HTMLElement>(`[data-dropzone="true"][data-parent-id="${added}"]`)!;
    expect(zone.closest(`[data-container-id="${added}"]`)).not.toBeNull();
    expect(zone.querySelector(".db-empty")?.textContent).toBe("Drop buttons here.");

    // A button goes in; a text field is refused, and says why.
    controller.add("button", added, "content");
    expect(controller.dropError).toBeUndefined();
    const group = () => controller.snapshot().children!.content!.find((node) => node.id === added)!;
    expect(group().children!.content!.map((node) => node.type)).toEqual(["button"]);
    controller.add("text", added, "content");
    expect(controller.dropError).toMatch(/not allowed/);
    expect(group().children!.content!).toHaveLength(1);

    // Moving a button of the form's group into the new one, then undoing it.
    controller.applyDrop(
      { getData: (key: string) => (key === BUILDER_DRAG_MIME_TYPE ? JSON.stringify({ kind: "existing-component", componentId: "later" }) : ""), setData: () => undefined },
      added,
      "content",
      0
    );
    expect(group().children!.content!.map((node) => node.id)[0]).toBe("later");
    controller.undo();
    expect(group().children!.content!.map((node) => node.id)).not.toContain("later");
    controller.undo();
    expect(group().children!.content!).toHaveLength(0);
    // Deleting the group takes its buttons with it; undo brings both back.
    controller.remove("actions");
    expect(controller.snapshot().children!.content!.some((node) => node.id === "actions")).toBe(false);
    controller.undo();
    expect(controller.snapshot().children!.content!.find((node) => node.id === "actions")?.children?.content?.map((node) => node.id)).toEqual(["send", "later"]);
  });

  it("draws the group's buttons as nodes in its zone, and a drag over them lands after the last button", async () => {
    const { builder, preview } = await mount();
    const controller = builder.controller!;
    await until(() => preview().querySelector('[data-container-id="actions"] [data-dropzone="true"][data-parent-id="actions"]'));
    const zone = preview().querySelector<HTMLElement>('[data-container-id="actions"] [data-dropzone="true"][data-parent-id="actions"]')!;
    const items = [...zone.querySelectorAll<HTMLElement>(".db-node")];
    expect(items.map((node) => node.getAttribute("data-component-id"))).toEqual(["send", "later"]);

    // jsdom lays nothing out, so every rect is empty and the pointer falls past each button: the
    // marker goes after the last one, which it can only do when it counts the group's buttons.
    const transfer = transferOf(controller.dragPayloadForType("button"));
    items[0]!.dispatchEvent(dragEvent("dragover", transfer));
    const marker = zone.querySelector(".db-marker");
    expect(marker).not.toBeNull();
    expect(marker!.previousElementSibling?.querySelector('[data-component-id="later"]')).not.toBeNull();
    items[0]!.dispatchEvent(dragEvent("drop", transfer));
    await until(() => controller.snapshot().children!.content!.find((node) => node.id === "actions")!.children!.content!.length === 3);
    const ids = controller.snapshot().children!.content!.find((node) => node.id === "actions")!.children!.content!.map((node) => node.id);
    expect(ids.slice(0, 2)).toEqual(["send", "later"]);
  });
});
