import { afterEach, describe, expect, it } from "vitest";

import type { ComponentDefinition, ComponentNode } from "@argusvane/datum-engine";

import { until } from "./helpers.js";
import {
  builderDrag,
  canvasElOf,
  canvasPanelOf,
  formOf,
  idsOf,
  mountBuilder,
  previewOf,
  settle,
  shellOf,
  stackRects,
  templateText,
  textNode,
  toolbarOf
} from "./builder-ported-fixture.js";

/*
 * Canvas drags, drops and clicks, and what the builder element re-emits: ported from the retired
 * demo app's builder tests so the builder's own suites keep them.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const threeFields = (): ComponentNode[] => [textNode("one", "One"), textNode("two", "Two"), textNode("three", "Three")];

describe("a drag over the canvas", () => {
  it("shows an insertion marker in the hovered drop zone, and dragend clears the marker and the drag-over state", async () => {
    const element = await mountBuilder(formOf(threeFields()));
    const zone = previewOf(element)!.querySelector<HTMLElement>("[data-dropzone]")!;

    zone.dispatchEvent(builderDrag("dragover", { kind: "existing-component", componentId: "two" }, { position: 5 }));
    expect(zone.querySelector(".db-marker")).toBeTruthy();
    expect(zone.hasAttribute("data-db-drag-over")).toBe(true);

    zone.dispatchEvent(builderDrag("dragend", {}));
    expect(previewOf(element)!.querySelector(".db-marker")).toBeNull();
    expect(zone.hasAttribute("data-db-drag-over")).toBe(false);
  });

  it("carries a real drag through from the grip: dragstart writes the payload, a gap between fields is a target, the drop reorders", async () => {
    const element = await mountBuilder(formOf(threeFields()));
    const preview = previewOf(element)!;
    const before = idsOf(element);

    const store = new Map<string, string>();
    const dataTransfer = {
      setData: (key: string, value: string) => store.set(key, value),
      getData: (key: string) => store.get(key) ?? "",
      setDragImage: () => {},
      get types() {
        return [...store.keys()];
      },
      effectAllowed: "",
      dropEffect: ""
    };
    const drag = (type: string, target: Element, position = 1): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      Object.defineProperty(event, "clientY", { value: position });
      Object.defineProperty(event, "clientX", { value: position });
      Object.defineProperty(event, "relatedTarget", { value: null });
      target.dispatchEvent(event);
      return event;
    };

    // The grip on the last field starts the drag and writes the payload itself.
    const handles = preview.querySelectorAll<HTMLElement>("[data-db-handle]");
    expect(handles).toHaveLength(3);
    drag("dragstart", handles[2]!);
    expect(store.size).toBeGreaterThan(0);

    const zone = preview.querySelector<HTMLElement>("[data-dropzone]")!;
    stackRects([...zone.querySelectorAll<HTMLElement>("[data-component-id][data-kind]")]);
    const over = drag("dragover", zone, 1);
    // Without preventDefault the browser rejects the drop outright.
    expect(over.defaultPrevented).toBe(true);
    expect(zone.querySelector(".db-marker")).toBeTruthy();

    drag("drop", zone, 1);
    expect(idsOf(element)).toEqual([before[2], before[0], before[1]]);
  });

  it("keeps a palette drag alive over the canvas background, echoes copy, and drops it into the form", async () => {
    // The gaps between fields and the canvas padding are outside every drop zone. A dragover
    // there used to go unaccepted, which the browser answers by swapping the copy badge for the
    // no-entry cursor. The canvas falls back to the form's own zone, so the badge holds and the
    // drop appends.
    const element = await mountBuilder(formOf(threeFields()));
    const surface = canvasPanelOf(element).querySelector<HTMLElement>(".canvas-surface")!;

    const over = builderDrag("dragover", templateText(), { position: 999, effectAllowed: "copy" });
    surface.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    // Echoed back as "copy", which is what draws the green "+" rather than a move cursor.
    expect(over.dataTransfer!.dropEffect).toBe("copy");
    expect(previewOf(element)!.querySelector('[data-dropzone][data-parent-id="root"] .db-marker')).toBeTruthy();

    surface.dispatchEvent(builderDrag("drop", templateText(), { position: 999, effectAllowed: "copy" }));
    expect(idsOf(element)).toHaveLength(4);
    expect(idsOf(element).slice(0, 3)).toEqual(["one", "two", "three"]);
  });

  it("takes a drop on a group's legend into the group: the legend is part of its box", async () => {
    // A labelled container's legend sits outside its drop zone. A drag over it used to find no
    // zone and fall through to the form root, so the drop landed beside the group.
    const element = await mountBuilder(
      formOf([
        { id: "contact", type: "fieldset", configuration: { label: "Contact" }, children: { content: [textNode("name", "Name")] } },
        textNode("note", "Note")
      ])
    );
    const preview = previewOf(element)!;
    const legend = preview.querySelector<HTMLElement>('[data-container-id="contact"] legend, [data-container-id="contact"] h2, [data-container-id="contact"] h3, #contact__group-label');
    expect(legend).toBeTruthy();

    const over = builderDrag("dragover", templateText("email"), { position: 999, effectAllowed: "copy" });
    legend!.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    const zone = preview.querySelector<HTMLElement>('[data-dropzone][data-parent-id="contact"]')!;
    expect(zone.hasAttribute("data-db-drag-over")).toBe(true);
    expect(zone.querySelector(".db-marker")).toBeTruthy();
    expect(preview.querySelector('[data-dropzone][data-parent-id="root"] > .db-marker')).toBeNull();

    legend!.dispatchEvent(builderDrag("drop", templateText("email"), { position: 999, effectAllowed: "copy" }));
    const content = element.builder!.controller.snapshot().children!.content!;
    expect(content.map((node: ComponentNode) => node.id)).toEqual(["contact", "note"]);
    // The dropped template is given a fresh id; its label says which one it was.
    expect(content[0]!.children!.content!.map((node: ComponentNode) => (node.configuration as { label?: string }).label)).toEqual(["Name", "email"]);
  });

  it("leaves a drag that is not the builder's alone", async () => {
    const element = await mountBuilder(formOf(threeFields()));
    const zone = previewOf(element)!.querySelector<HTMLElement>("[data-dropzone]")!;

    const event = new Event("dragover", { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: ["Files"], getData: () => "", setData: () => {}, dropEffect: "", effectAllowed: "" }
    });
    Object.defineProperty(event, "relatedTarget", { value: null });
    zone.dispatchEvent(event);
    // Accepting a file drop would tell the person they can drop it here, and then eat it.
    expect(event.defaultPrevented).toBe(false);
    expect(zone.querySelector(".db-marker")).toBeNull();
  });
});

describe("what the canvas panel says and the element re-emits", () => {
  it("draws a slot-constraint rejection into the canvas's notice", async () => {
    // The form's one slot takes a single component, so a second add is refused.
    const single = {
      type: "form",
      version: "1.0.0",
      children: { slots: [{ id: "content", multiple: false, max: 1 }] }
    } as unknown as ComponentDefinition;
    const element = document.createElement("datum-form-builder");
    element.componentDefinitions = [single];
    element.definition = formOf([]);
    document.body.append(element);
    await until(() => toolbarOf(element).querySelector('[data-add-type="text"]'));

    const add = (): HTMLButtonElement => toolbarOf(element).querySelector<HTMLButtonElement>('[data-add-type="text"]')!;
    add().click();
    expect(idsOf(element)).toHaveLength(1);
    add().click();
    expect(idsOf(element)).toHaveLength(1);

    const notice = canvasPanelOf(element).querySelector<HTMLElement>("[data-drop-error] .drop-error");
    expect(notice).toBeTruthy();
    expect(notice!.getAttribute("role")).toBe("alert");
    expect(notice!.textContent).toMatch(/max|multiple/i);
  });

  it("re-emits builder-change and builder-mutation from the builder element", async () => {
    const element = await mountBuilder(formOf([]));
    const builder = element.builder!;
    const changes: string[] = [];
    const mutations: string[] = [];
    builder.addEventListener("builder-change", (event) => changes.push((event as CustomEvent<{ reason: string }>).detail.reason));
    builder.addEventListener("builder-mutation", (event) => mutations.push((event as CustomEvent<{ action: string }>).detail.action));

    builder.controller.add("text");
    expect(changes).toContain("add");
    expect(mutations).toContain("execute");
    expect(idsOf(element)).toHaveLength(1);

    builder.undo();
    expect(idsOf(element)).toHaveLength(0);
    expect(mutations.length).toBeGreaterThan(1);
  });

  it("clears the selection when a click lands on no component, the form's own background included", async () => {
    const element = await mountBuilder(formOf(threeFields()));
    const controller = element.builder!.controller;
    const click = (target: Element): void => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    };

    click(previewOf(element)!.querySelector('.db-node[data-component-id="two"]')!);
    expect(controller.selectedComponentId()).toBe("two");

    // The form's own background belongs to no component: clicking it puts the selection down.
    click(previewOf(element)!.querySelector("[data-db-root]")!);
    expect(controller.selectedComponentId()).toBeUndefined();
  });

  it("takes a rule-hidden component off the canvas when the View panel's show-hidden switch is turned off", async () => {
    const element = await mountBuilder(
      formOf([
        { id: "optIn", type: "checkbox", configuration: { label: "Subscribe" } },
        { id: "email", type: "text", configuration: { label: "Email" }, rules: { visibleWhen: "optIn" } }
      ])
    );
    const gated = (): HTMLElement | null => previewOf(element)!.querySelector<HTMLElement>('.db-node[data-component-id="email"]');

    // On by default: drawn, and marked as hidden by its rule.
    await until(() => gated());
    expect(gated()!.classList.contains("db-node--hidden")).toBe(true);
    expect(gated()!.querySelector(".db-tag--hidden")?.textContent).toBe("Hidden by a rule");
    expect(element.builder!.controller.showHiddenComponents()).toBe(true);

    const toggle = shellOf(element).querySelector<HTMLInputElement>("[data-view-panel] input[data-show-hidden]")!;
    expect(toggle.checked).toBe(true);
    toggle.click();
    await until(() => gated() === null);
    expect(element.builder!.controller.showHiddenComponents()).toBe(false);

    toggle.click();
    await until(() => gated());
    await settle();
    expect(canvasElOf(element).previewing).toBe(false);
  });
});
