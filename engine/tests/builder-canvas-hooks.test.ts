// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { BUILDER_DRAG_MIME_TYPE } from "../form-engine/builder/drag-drop/html5-drag-drop.js";
import { DATUM_BUILDER_CANVAS_TAG, defineBuilderPanels, type DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import { buildCanvasHooks } from "../form-engine/builder/web-component/canvas-hooks.js";
import { dropZoneOnPath, markDropZones, zoneInsertion, zoneItems } from "../form-engine/builder/web-component/builder-shared.js";
import { buildNestedTreeView } from "../form-engine/builder/tree-editor/nested-tree-view.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { html, render } from "../form-engine/render/live/lit.js";
import type { DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";

/**
 * The builder canvas on the live renderer: template-typed canvas hooks decorate what
 * the binding draws, never inside its leaf markup. A field is a node (`.db-node`,
 * `data-component-id`) with its grip (`data-db-handle`) and its leaf under HTML `inert`; a
 * container is a node with its type chip and is never inert; an empty slot draws a drop zone;
 * a slot holding components is marked as a drop zone where the binding drew them
 * (`data-dropzone`, `data-parent-id`, `data-slot-id`). Previewing draws the form with no hooks.
 */

defineBuilderPanels();

afterEach(() => {
  document.body.innerHTML = "";
});

const tree = (): ComponentNode =>
  ({
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Full name" } },
        { id: "addr", type: "grid", configuration: { columns: 2 }, children: { column_1: [{ id: "city", type: "text", configuration: { label: "City" } }] } },
        { id: "flow", type: "panel", configuration: {}, children: { content: [{ id: "zip", type: "text", configuration: { label: "Zip" } }, { id: "zip2", type: "text", configuration: { label: "Zip 2" } }] } },
        { id: "group", type: "fieldset", configuration: { label: "Newsletter" }, children: { content: [] } },
        { id: "tabs", type: "tabs", configuration: { tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, children: { a: [{ id: "ta", type: "text", configuration: { label: "In A" } }], b: [] } },
        { id: "pick", type: "select", configuration: { label: "Pick" } }
      ]
    }
  }) as ComponentNode;

async function mount(root: ComponentNode = tree(), selected?: string): Promise<{ canvas: DatumBuilderCanvasElement; controller: BuilderController; renderer: DatumFormRendererElement; form: ShadowRoot }> {
  const controller = new BuilderController({ initialRoot: root });
  if (selected !== undefined) {
    controller.select(selected);
  }
  const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
  canvas.controller = controller;
  document.body.append(canvas);
  const renderer = canvas.shadowRoot!.querySelector("[data-preview]") as DatumFormRendererElement;
  await settled(renderer);
  return { canvas, controller, renderer, form: renderer.shadowRoot! };
}

/** The draw done, and the canvas's marking after it (a microtask, then a task). */
async function settled(renderer: DatumFormRendererElement): Promise<void> {
  await renderer.painted();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const node = (form: ShadowRoot, id: string): HTMLElement => form.querySelector<HTMLElement>(`.db-node[data-component-id="${id}"]`)!;
/** A child of `element` matching `selector` (jsdom reads nothing under `:scope` in a shadow tree). */
const child = (element: Element, selector: string): HTMLElement | undefined => [...element.children].find((el) => el.matches(selector)) as HTMLElement | undefined;
const zone = (form: ShadowRoot, parentId: string, slotId: string): HTMLElement | null => form.querySelector<HTMLElement>(`[data-dropzone][data-parent-id="${parentId}"][data-slot-id="${slotId}"]`);

describe("a field on the canvas", () => {
  it("is a node inside the renderer's wrapper, its grip beside the binding's leaf, which is inert", async () => {
    const { form } = await mount();
    const wrapper = form.querySelector<HTMLElement>('.datum-live-field[data-component-id="name"]')!;
    const box = node(form, "name");
    expect(box.parentElement).toBe(wrapper);
    expect(child(box, '[data-db-handle="name"]')).toBeDefined();
    const leaf = child(box, ".db-leaf")!;
    expect(leaf.hasAttribute("inert")).toBe(true);
    // The binding's own drawing, untouched, is inside the leaf: the accessible name holds.
    const input = leaf.querySelector<HTMLInputElement>("input")!;
    expect(form.getElementById(input.getAttribute("aria-labelledby")!)!.textContent).toBe("Full name");
    // Out of the Tab order too (jsdom has no inert): the canvas is one Tab stop.
    expect(input.getAttribute("tabindex")).toBe("-1");
    expect(input.hasAttribute("data-db-inert")).toBe(true);
  });

  // A designer's own face (journey "Ask differently here…") holds the builder's
  // buttons; under `inert` a real browser never delivers their click. jsdom ignores `inert`, so
  // the attribute is what is checked; the Tab order still leaves them out.
  it("leaves a designer's own type live (no inert), its buttons out of the Tab order", async () => {
    const face = { kind: "field" as const, template: () => html`<p>Question</p><button type="button" data-journey-fix="ask-differently">Ask differently here</button>` };
    const controller = new BuilderController({
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "q", type: "own-face", configuration: {} }, { id: "name", type: "text", configuration: { label: "Name" } }] } } as ComponentNode,
      canvasComponents: { "own-face": face }
    });
    const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
    canvas.controller = controller;
    document.body.append(canvas);
    const renderer = canvas.shadowRoot!.querySelector("[data-preview]") as DatumFormRendererElement;
    await settled(renderer);
    const form = renderer.shadowRoot!;
    const leaf = child(node(form, "q"), ".db-leaf")!;
    expect(leaf.hasAttribute("inert")).toBe(false);
    const button = leaf.querySelector<HTMLElement>("[data-journey-fix]")!;
    expect(button.closest("[inert]")).toBeNull();
    expect(button.getAttribute("tabindex")).toBe("-1");
    // A binding's field beside it keeps its inert leaf.
    expect(child(node(form, "name"), ".db-leaf")!.hasAttribute("inert")).toBe(true);
  });

  it("builds an inert leaf unless the type is a live one", () => {
    const model = (type: string) => ({ id: "x", type, visible: true, node: { id: "x", type, configuration: {} } }) as never;
    const hooks = buildCanvasHooks({ selectedId: undefined, declaredSlots: new Map(), liveTypes: new Set(["own"]) });
    const host = document.createElement("div");
    render(html`${hooks.decorateField!(model("own"), html`<b></b>`)}${hooks.decorateField!(model("text"), html`<i></i>`)}`, host);
    const leaves = [...host.querySelectorAll(".db-leaf")];
    expect(leaves.map((leaf) => leaf.hasAttribute("inert"))).toEqual([false, true]);
  });

  it("gets no type chip and no action buttons; a choice with no options gets its hint outside the leaf", async () => {
    const { form } = await mount();
    expect(node(form, "name").querySelector(".db-tag")).toBeNull();
    expect(form.querySelector("[data-db-action], .db-toolbar")).toBeNull();
    const hint = child(node(form, "pick"), '[data-no-options="pick"]')!;
    expect(hint.closest(".db-leaf")).toBeNull();
  });

  it("is the selected one alone", async () => {
    const { form, renderer } = await mount(tree(), "name");
    expect([...form.querySelectorAll<HTMLElement>(".db-selected")].map((el) => el.dataset.componentId)).toEqual(["name"]);
    expect(renderer.hasAttribute("data-db-root-selected")).toBe(false);
  });
});

describe("a container on the canvas", () => {
  it("is a node with its grip and its type chip, around the binding's drawing, never inert", async () => {
    const { form } = await mount();
    for (const [id, type] of [["addr", "grid"], ["flow", "panel"], ["group", "fieldset"], ["tabs", "tabs"]] as const) {
      const box = node(form, id);
      expect(box.classList.contains("db-node--container")).toBe(true);
      expect(box.parentElement!.matches(`.datum-live-container[data-container-id="${id}"]`)).toBe(true);
      expect(child(box, ".db-tag")!.textContent).toBe(type);
      expect(child(box, `[data-db-handle="${id}"]`)).toBeDefined();
      expect(box.closest("[inert]")).toBeNull();
    }
  });

  it("hangs its type chip above the node, so it never covers a binding's legend at the node's top edge", async () => {
    const { form } = await mount();
    const tag = child(node(form, "group"), ".db-tag")!;
    const style = getComputedStyle(tag);
    // Anchored by its bottom edge to the node's top, past the outline: nothing of it is inside the node.
    expect(style.bottom).toContain("100%");
    expect(["", "auto"]).toContain(style.top);
    expect(style.insetInlineStart).toBe("0px");
    expect(style.pointerEvents).toBe("none");
  });

  // At the start, a nested container's chip would lie on its parent's legend.
  it("hangs a nested container's chip at its end corner, clear of the parent's legend", async () => {
    const root = tree();
    const group = root.children!["content"]!.find((entry) => entry.id === "group")!;
    group.children = { content: [{ id: "inner", type: "fieldset", configuration: { label: "Inner" }, children: { content: [] } } as ComponentNode] };
    const { form } = await mount(root);
    const inner = getComputedStyle(child(node(form, "inner"), ".db-tag")!);
    expect(inner.insetInlineEnd).toBe("0px");
    expect(["", "auto"]).toContain(inner.insetInlineStart);
    expect(inner.bottom).toContain("100%");
    expect(getComputedStyle(child(node(form, "group"), ".db-tag")!).insetInlineStart).toBe("0px");
  });

  // The hidden tag is always shown; the chip's placement must not carry it onto the component above.
  it("keeps the hidden tag on its own node's top edge, hoverable for its title, and lifts a hidden container's chip clear of it", async () => {
    const root = tree();
    root.children!["content"]!.push(
      { id: "gone", type: "text", configuration: { label: "Gone", hidden: true } } as ComponentNode,
      { id: "gonebox", type: "fieldset", configuration: { label: "Gone box", hidden: true }, children: { content: [] } } as ComponentNode
    );
    const { form } = await mount(root);
    for (const id of ["gone", "gonebox"]) {
      expect(node(form, id).classList.contains("db-node--hidden")).toBe(true);
      const hiddenTag = getComputedStyle(child(node(form, id), ".db-tag--hidden")!);
      expect(hiddenTag.display).toBe("block");
      expect(hiddenTag.top).toBe("-10px");
      expect(["", "auto"]).toContain(hiddenTag.bottom);
      expect(hiddenTag.pointerEvents).not.toBe("none");
    }
    const chip = getComputedStyle(child(node(form, "gonebox"), ".db-tag:not(.db-tag--hidden)")!);
    expect(chip.bottom).toBe("calc(100% + 12px)");
  });

  it("draws a layout grid with no children key as its configured columns, each a drop zone", async () => {
    const { form } = await mount({ id: "root", type: "form", configuration: {}, children: { content: [{ id: "g", type: "grid", configuration: { columns: 2 } }] } } as ComponentNode);
    expect(zone(form, "g", "column_1")!.textContent).toBe("Drop components here.");
    expect(zone(form, "g", "column_2")!.textContent).toBe("Drop components here.");
  });

  it("is drawn while empty, with a drop zone that says so", async () => {
    const { form } = await mount();
    const empty = zone(form, "group", "content")!;
    expect(node(form, "group").contains(empty)).toBe(true);
    expect(empty.textContent).toBe("Drop components here.");
  });

  it("marks each slot's zone where the binding drew its components: one per layout column, one per tab", async () => {
    const { form } = await mount();
    const column = zone(form, "addr", "column_1")!;
    expect(zoneItems(column).map((item) => item.dataset.componentId)).toEqual(["city"]);
    // The empty column is a target in its own right.
    expect(zone(form, "addr", "column_2")!.textContent).toBe("Drop components here.");
    // No zone on the grid's own node: a drop always lands in a column.
    expect(node(form, "addr").hasAttribute("data-dropzone")).toBe(false);
    expect(zoneItems(zone(form, "flow", "content")!).map((item) => item.dataset.componentId)).toEqual(["zip", "zip2"]);
    expect(zoneItems(zone(form, "tabs", "a")!).map((item) => item.dataset.componentId)).toEqual(["ta"]);
    expect(zone(form, "tabs", "b")).not.toBeNull();
  });

  it("keeps its tabs live: a tab shows its panel and selects nothing", async () => {
    const { form, controller, renderer } = await mount();
    const tab = [...form.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) => el.textContent?.trim() === "B")!;
    tab.click();
    await settled(renderer);
    expect(controller.selectedComponentId()).toBeUndefined();
    expect(zone(form, "tabs", "b")!.closest("[hidden]")).toBeNull();
  });

  // The tab list's roving tabindex is written again on each switch; the canvas stays one Tab stop.
  it("keeps every tab out of the Tab order after a tab switch and a selection", async () => {
    const { form, renderer, controller } = await mount();
    const stops = (): string[] => [...form.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.getAttribute("tabindex") ?? "");
    expect(stops()).toEqual(["-1", "-1"]);
    [...form.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent!.trim() === "B")!.click();
    await settled(renderer);
    expect(stops()).toEqual(["-1", "-1"]);
    controller.select("ta");
    await settled(renderer);
    expect(stops()).toEqual(["-1", "-1"]);
    // What the binding wrote last is what preview gives back.
    const selectedTab = [...form.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.getAttribute("aria-selected") === "true")!;
    expect(selectedTab.getAttribute("data-db-inert")).toBe("0");
  });
});

describe("steps on the canvas", () => {
  const stepsTree = (): ComponentNode =>
    ({
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "pages",
            type: "steps",
            configuration: {},
            children: {
              content: [
                { id: "about", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "first", type: "text", configuration: { label: "First" } }] } },
                { id: "contact", type: "step", configuration: { label: "Contact" }, children: { content: [] } }
              ]
            }
          }
        ]
      }
    }) as ComponentNode;

  it("draws each step as a node, the empty one with its drop zone, and the stepper follows the step drawn", async () => {
    const { canvas, form, renderer } = await mount(stepsTree());
    expect(node(form, "pages").classList.contains("db-node--container")).toBe(true);
    expect(node(form, "about").classList.contains("db-node--container")).toBe(true);
    expect(zoneItems(zone(form, "about", "content")!).map((item) => item.dataset.componentId)).toEqual(["first"]);
    const text = (): string => canvas.shadowRoot!.querySelector("[data-stepper-text]")!.textContent ?? "";
    expect(text()).toContain("About you");
    canvas.shadowRoot!.querySelector<HTMLButtonElement>('[data-stepper-go="1"]')!.click();
    await settled(renderer);
    expect(text()).toContain("Contact");
    expect(zone(form, "contact", "content")!.textContent).toBe("Drop components here.");
  });
});

describe("the form root on the canvas", () => {
  it("is a drop zone with no node, grip or chip, outlined while selected", async () => {
    const { form, renderer, controller } = await mount();
    const root = form.querySelector<HTMLElement>("[data-db-root]")!;
    expect(root.getAttribute("data-parent-id")).toBe("root");
    expect(root.getAttribute("data-slot-id")).toBe("content");
    expect(form.querySelector('[data-db-handle="root"]')).toBeNull();
    expect(zoneItems(root).map((item) => item.dataset.componentId ?? item.dataset.containerId)).toEqual(["name", "addr", "flow", "group", "tabs", "pick"]);
    controller.select("root");
    await settled(renderer);
    expect(renderer.hasAttribute("data-db-root-selected")).toBe(true);
  });

  it("says where the first component goes in a wholly empty form, and takes a drop there", async () => {
    const { canvas, form } = await mount({ id: "root", type: "form", configuration: {}, children: { content: [] } } as ComponentNode);
    const prompt = canvas.shadowRoot!.querySelector<HTMLElement>("[data-canvas-empty-root]")!;
    expect(prompt.hidden).toBe(false);
    expect(prompt.textContent).toBe("Drop components here to build the form.");
    expect(form.querySelector("form")!.getAttribute("data-parent-id")).toBe("root");
  });

  it("keeps that invitation while the form holds only the Submit button a new form starts with, and not once anything else is placed", async () => {
    const submit = { id: "submit", type: "button", configuration: { label: "Submit", action: "submit" } };
    const starting = await mount({ id: "root", type: "form", configuration: {}, children: { content: [submit] } } as ComponentNode);
    const prompt = starting.canvas.shadowRoot!.querySelector<HTMLElement>("[data-canvas-empty-root]")!;
    expect(prompt.hidden).toBe(false);
    expect(prompt.textContent).toBe("Drop components here to build the form.");

    // A button the author changed is a component of theirs, and so is a second one.
    const renamed = await mount({ id: "root", type: "form", configuration: {}, children: { content: [{ ...submit, configuration: { label: "Send", action: "submit" } }] } } as ComponentNode);
    expect(renamed.canvas.shadowRoot!.querySelector<HTMLElement>("[data-canvas-empty-root]")!.hidden).toBe(true);
    const two = await mount({ id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }, submit] } } as ComponentNode);
    expect(two.canvas.shadowRoot!.querySelector<HTMLElement>("[data-canvas-empty-root]")!.hidden).toBe(true);
  });
});

describe("a drop on the canvas", () => {
  it("lands in the slot under the pointer, at the place the tree counts", async () => {
    const { canvas, controller, form } = await mount();
    const target = node(form, "zip2");
    const transfer = {
      types: [BUILDER_DRAG_MIME_TYPE],
      effectAllowed: "copy",
      dropEffect: "none",
      getData: (type: string) => (type === BUILDER_DRAG_MIME_TYPE ? JSON.stringify({ kind: "template-component", component: { id: "added", type: "text", configuration: { label: "Added" } } }) : ""),
      setData: () => undefined
    };
    const event = (type: string): Event => Object.assign(new Event(type, { bubbles: true, composed: true, cancelable: true }), { dataTransfer: transfer, clientX: 0, clientY: 0 });
    target.dispatchEvent(event("dragover"));
    const marker = form.querySelector<HTMLElement>(".db-marker")!;
    // jsdom lays nothing out: the pointer is past every component, so the marker follows the last.
    expect(marker.previousElementSibling!.getAttribute("data-component-id")).toBe("zip2");
    expect(zone(form, "flow", "content")!.hasAttribute("data-db-drag-over")).toBe(true);
    target.dispatchEvent(event("drop"));
    expect(form.querySelector(".db-marker")).toBeNull();
    const flow = controller.treeView().slots[0]!.children.find((child) => child.id === "flow")!;
    expect(flow.slots[0]!.children.map((child) => child.type)).toEqual(["text", "text", "text"]);
    expect(canvas.isConnected).toBe(true);
  });
});

describe("the canvas and the live form", () => {
  it("draw the same leaf: the canvas adds its chrome around the binding's markup, never inside it", async () => {
    const { form, canvas } = await mount();
    const live = document.createElement("datum-form-renderer") as DatumFormRendererElement;
    live.runtime = canvas.previewRuntime()!;
    document.body.append(live);
    await settled(live);
    // The canvas takes the leaf's controls out of the Tab order; what the binding drew is otherwise the same.
    const clean = (markup: string): string => markup.replace(/ data-db-inert="[^"]*"/g, "").replace(/ tabindex="-1"/g, "").replace(/<!--[^>]*-->/g, "");
    for (const id of ["name", "city", "pick", "ta"]) {
      const leaf = child(node(form, id), ".db-leaf")!;
      const wrapper = live.shadowRoot!.querySelector<HTMLElement>(`.datum-live-field[data-component-id="${id}"]`)!;
      expect(clean(leaf.innerHTML), id).toBe(clean(wrapper.innerHTML));
    }
  });
});

// 5-close-perf: the bar's readouts were written again on every commit, which put the bar up for
// layout, and the inspector's scroll read in the same commit then laid out the whole builder.
describe("the canvas's bar across a commit", () => {
  it("keeps the text it already shows, and still follows a new name", async () => {
    const { canvas, controller, renderer } = await mount(tree(), "name");
    const shell = canvas.shadowRoot!;
    const texts = (): (Node | null)[] => ["[data-canvas-zoom-level]", "[data-selection-name]", "[data-try-it]"].map((selector) => shell.querySelector(selector)!.firstChild);
    const before = texts();
    expect(before.every((text) => text?.nodeType === Node.TEXT_NODE)).toBe(true);
    controller.setDraftProperty("name", "hint", "As on your passport");
    controller.commitDraft("name");
    await settled(renderer);
    texts().forEach((text, index) => expect(text, `readout ${index}`).toBe(before[index]));
    controller.setDraftProperty("name", "label", "Your name");
    controller.commitDraft("name");
    await settled(renderer);
    expect(shell.querySelector("[data-selection-name]")!.textContent).toBe("Your name");
  });
});

describe("previewing", () => {
  it("draws the form with no hooks: no node, no zone, the controls the person's", async () => {
    const { canvas, form, renderer } = await mount();
    canvas.previewing = true;
    await settled(renderer);
    expect(renderer.canvasHooks).toBeUndefined();
    expect(form.querySelector(".db-node, [data-dropzone], [inert]")).toBeNull();
    expect(form.querySelector('[data-value-path="name"] input')!.hasAttribute("tabindex")).toBe(false);
    canvas.previewing = false;
    await settled(renderer);
    expect(node(form, "name")).not.toBeNull();
    expect(form.querySelector("[data-db-root]")).not.toBeNull();
  });
});

describe("the hooks and the zone helpers on their own", () => {
  it("escape an empty slot's own hint", () => {
    const hooks = buildCanvasHooks({ selectedId: undefined, rootId: "root", declaredSlots: new Map([["group", ["content", "extra"]]]), emptyHints: new Map([["group", new Map([["extra", "Only <notes> go here."]])]]) });
    const host = document.createElement("div");
    render(html`${hooks.emptySlot!({ containerId: "group", slotId: "extra" })}${hooks.emptySlot!({ containerId: "group", slotId: "content" })}${hooks.emptySlot!({ containerId: "root", slotId: "content" })}`, host);
    expect([...host.querySelectorAll(".db-empty")].map((p) => p.textContent)).toEqual(["Only <notes> go here.", "Drop components here.", "Drop components here to build the form."]);
    expect(host.querySelector('[data-parent-id="group"][data-slot-id="extra"]')).not.toBeNull();
  });

  it("leave a slot whose components share their element with another slot's unmarked", () => {
    const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ id: "g", type: "fieldset", configuration: {}, children: { one: [{ id: "a", type: "text" }], two: [{ id: "b", type: "text" }] } }] } } as unknown as ComponentNode;
    const host = document.createElement("div");
    host.innerHTML = `<form><div class="datum-live-container" data-container-id="g"><div class="db-node"><div class="shared"><div class="datum-live-field" data-component-id="a"></div><div class="datum-live-field" data-component-id="b"></div></div></div></div></form>`;
    markDropZones(host, buildNestedTreeView(root));
    expect(host.querySelector(".shared")!.hasAttribute("data-dropzone")).toBe(false);
    expect(host.querySelector("form")!.getAttribute("data-parent-id")).toBe("root");
    // Marked again from nothing: last time's marks go first.
    host.querySelector(".shared")!.setAttribute("data-db-zone", "");
    host.querySelector(".shared")!.setAttribute("data-dropzone", "true");
    markDropZones(host, buildNestedTreeView(root));
    expect(host.querySelector(".shared")!.hasAttribute("data-dropzone")).toBe(false);
  });

  // 5-close-perf: taking the form's marks off and putting them back sent a style invalidation to
  // every component under it, on every commit, for marks that had not moved.
  it("write nothing when marked again with nothing moved, and still move a mark that did", async () => {
    const { form } = await mount();
    const marked = (): string[] =>
      [...form.querySelectorAll<HTMLElement>("[data-db-zone]")].map((el) => ["data-dropzone", "data-parent-id", "data-slot-id", "data-axis", "data-db-root"].map((name) => `${name}=${el.getAttribute(name)}`).join(" "));
    const before = marked();
    expect(before.length).toBeGreaterThan(0);
    const writes = new MutationObserver(() => undefined);
    writes.observe(form, { subtree: true, attributes: true });
    markDropZones(form, buildNestedTreeView(tree()));
    expect(writes.takeRecords()).toEqual([]);
    expect(marked()).toEqual(before);
    // A slot emptied in the tree: the mark leaves the element its components shared for the row's own node.
    const shared = zone(form, "flow", "content")!;
    expect(shared).not.toBe(node(form, "flow"));
    const moved = tree();
    (moved.children!.content![2] as ComponentNode).children = { content: [] };
    markDropZones(form, buildNestedTreeView(moved));
    expect(writes.takeRecords().length).toBeGreaterThan(0);
    writes.disconnect();
    expect(shared.hasAttribute("data-dropzone")).toBe(false);
    expect(shared.hasAttribute("data-db-zone")).toBe(false);
    expect(zone(form, "flow", "content")).toBe(node(form, "flow"));
  });

  it("count a drop among the slot's components as the tree does, the ones not drawn included", () => {
    const zoneEl = document.createElement("div");
    zoneEl.innerHTML = `<ul><li><div class="datum-live-field" data-component-id="b"></div></li><li><div class="datum-live-container" data-container-id="d"></div></li></ul>`;
    // `a` and `c` are not drawn (a rule hides them): `b` is second in the slot, `d` fourth.
    const places = new Map([["a", 0], ["b", 1], ["c", 2], ["d", 3]]);
    const after = zoneInsertion(zoneEl, { x: 0, y: 0 }, (id) => places.get(id));
    expect(after.index).toBe(4);
    expect(after.after?.dataset.containerId).toBe("d");
  });

  // The journeys Step view: tags, the region owner and parts of another's box. Absent, the
  // hooks are what every canvas but the step's draws with, part for part.
  it("draw no step decoration unless asked: no region hook, and a box's markup the same, lit parts and all, whatever tags others carry", () => {
    const model = (id: string, visible = true) => ({ id, type: "text", visible, node: { id, type: "text", configuration: {} } }) as never;
    const plain = buildCanvasHooks({ selectedId: undefined, declaredSlots: new Map() });
    const tagged = buildCanvasHooks({ selectedId: undefined, declaredSlots: new Map(), tags: new Map([["other", "Not sent"]]) });
    expect(plain.decorateRegion).toBeUndefined();
    expect(tagged.decorateRegion).toBeUndefined();
    for (const visible of [true, false]) {
      const a = document.createElement("div");
      const b = document.createElement("div");
      render(plain.decorateField!(model("x", visible), html`<i></i>`), a);
      render(tagged.decorateField!(model("x", visible), html`<i></i>`), b);
      expect(b.innerHTML).toBe(a.innerHTML);
    }
  });

  it("put a box's tag beside its hidden tag, in the caller's words", () => {
    const model = (id: string, visible: boolean) => ({ id, type: "text", visible, node: { id, type: "text", configuration: {} } }) as never;
    const hooks = buildCanvasHooks({ selectedId: undefined, declaredSlots: new Map(), tags: new Map([["own", "Not sent"], ["gone", "Not sent"]]) });
    const host = document.createElement("div");
    render(html`${hooks.decorateField!(model("own", true), html`<b></b>`)}${hooks.decorateField!(model("gone", false), html`<b></b>`)}`, host);
    const own = host.querySelector<HTMLElement>('.db-node[data-component-id="own"]')!;
    expect(own.querySelector(":scope > .db-tag--note[data-db-tag]")!.textContent).toBe("Not sent");
    expect(own.querySelector(".db-leaf .db-tag--note")).toBeNull();
    const gone = host.querySelector<HTMLElement>('.db-node[data-component-id="gone"]')!;
    expect([...gone.querySelectorAll(":scope > .db-tag")].map((tag) => tag.className)).toEqual(["db-tag db-tag--hidden", "db-tag db-tag--note"]);
  });

  it("draw a part of another's box with no node, grip or tag, inert; an empty slot the view does not list draws no zone", () => {
    const model = (id: string, parentId?: string) => ({ id, type: "fieldset", visible: true, parentId, node: { id, type: "fieldset", configuration: {} } }) as never;
    const hooks = buildCanvasHooks({
      selectedId: undefined,
      rootId: "root",
      declaredSlots: new Map([["root", ["content"]], ["own", ["content"]]]),
      partOf: new Map([["street", "placed"], ["inner", "placed"]]),
      tags: new Map([["street", "Not sent"]])
    });
    const host = document.createElement("div");
    render(
      html`${hooks.decorateField!(model("street"), html`<input />`)}${hooks.renderContainer!({ model: model("inner", "placed"), kind: "group", label: undefined, slots: new Map() }, html`<fieldset></fieldset>`)}${hooks.renderContainer!({ model: model("placed", "root"), kind: "group", label: undefined, slots: new Map() }, html`<fieldset></fieldset>`)}`,
      host
    );
    const parts = [...host.querySelectorAll<HTMLElement>("[data-db-part-of]")];
    expect(parts.map((part) => [part.className, part.hasAttribute("inert"), part.dataset.dbPartOf])).toEqual([
      ["db-leaf", true, "placed"],
      ["db-leaf", true, "placed"]
    ]);
    expect(host.querySelectorAll(".db-node").length).toBe(1);
    expect(host.querySelector('[data-db-handle="street"], [data-db-handle="inner"], .db-tag--note')).toBeNull();
    // Zones: the placement's slot and a part's are not the step's; the root's and an own container's are.
    const zones = document.createElement("div");
    render(
      html`${hooks.emptySlot!({ containerId: "placed", slotId: "content" })}${hooks.emptySlot!({ containerId: "inner", slotId: "content" })}${hooks.emptySlot!({ containerId: "own", slotId: "content" })}${hooks.emptySlot!({ containerId: "root", slotId: "content" })}`,
      zones
    );
    expect([...zones.querySelectorAll<HTMLElement>("[data-dropzone]")].map((zone) => zone.dataset.parentId)).toEqual(["own", "root"]);
  });

  it("wrap a page's own regions, whatever drew them, in one box each for their owner: named, inert, selected with it; other regions as they are", () => {
    const owner = { id: "page_1", label: "Step 2 · How to reach you" };
    const draw = (selectedId: string | undefined): HTMLElement => {
      const hooks = buildCanvasHooks({ selectedId, declaredSlots: new Map(), regionOwner: { id: owner.id, label: () => owner.label } });
      const host = document.createElement("div");
      expect(hooks.decorateRegion!("summary-top", html`<p>top</p>`)).toBeUndefined();
      expect(hooks.decorateRegion!("footer", html`<p>footer</p>`)).toBeUndefined();
      render(html`${hooks.decorateRegion!("page-header", html`<header class="acme"><h2>How to reach you</h2></header>`)}${hooks.decorateRegion!("page-actions", html`<div class="acme-row"><button type="button">Next</button></div>`)}`, host);
      return host;
    };
    const host = draw(undefined);
    const boxes = [...host.querySelectorAll<HTMLElement>("[data-db-region-owner]")];
    expect(boxes.map((box) => [box.dataset.dbRegion, box.dataset.dbRegionOwner, box.getAttribute("role"), box.getAttribute("aria-label"), box.className])).toEqual([
      ["page-header", "page_1", "group", owner.label, "db-region"],
      ["page-actions", "page_1", "group", owner.label, "db-region"]
    ]);
    for (const box of boxes) {
      expect(box.querySelector(":scope > .db-leaf")!.hasAttribute("inert")).toBe(true);
      expect(box.hasAttribute("data-component-id")).toBe(false);
    }
    expect(host.querySelector("button")!.closest("[inert]")).not.toBeNull();
    expect([...draw("page_1").querySelectorAll(".db-region")].every((box) => box.classList.contains("db-selected"))).toBe(true);
  });

  it("find no zone through a container's own grip: the thing dragged is not where it goes", () => {
    const outer = document.createElement("div");
    outer.setAttribute("data-dropzone", "true");
    const box = document.createElement("div");
    box.className = "db-node";
    box.setAttribute("data-dropzone", "true");
    const grip = document.createElement("span");
    grip.className = "db-handle";
    box.append(grip);
    outer.append(box);
    expect(dropZoneOnPath([grip, box, outer])).toBe(outer);
    expect(dropZoneOnPath([box, outer])).toBe(box);
  });
});
