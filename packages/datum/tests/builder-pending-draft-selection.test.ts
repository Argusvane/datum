import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * Selecting another component while the inspector holds unapplied edits asks first —
 * Apply, Discard, Keep editing — whichever way the selection is asked for. In a browser the
 * press on the other component takes focus from the typed box, and the box's change must not
 * repaint the canvas (and the outline) under the press: the browser would then send no click, and
 * the selection would do nothing at all. These tests press the way a browser does — pointerdown, the box
 * blurs, time passes, pointerup, and a click only when the pressed element is still there.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

async function mount(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  await until(() => sheet(element).querySelector("[data-db-handle=fullName]"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;
const canvas = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
/** The previewed form inside the canvas, where the components and their grips are drawn. */
const sheet = (element: DatumFormBuilderElement): ShadowRoot => canvas(element).querySelector("datum-form-renderer")!.shadowRoot!;
const handle = (element: DatumFormBuilderElement, id: string): HTMLElement => sheet(element).querySelector<HTMLElement>(`[data-db-handle="${id}"]`)!;
const labelBox = (element: DatumFormBuilderElement): HTMLInputElement =>
  inspector(element).querySelector<HTMLInputElement>('[data-prop="label"]')!;
const prompt = (element: DatumFormBuilderElement): HTMLDialogElement | null => inspector(element).querySelector<HTMLDialogElement>("dialog[data-unsaved-prompt]");
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

function pointer(target: HTMLElement, type: string): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, button: 0 }));
}

/**
 * A mouse click as a browser makes it: the press takes focus from `box`; the click is sent
 * only if what was pressed is still on the page when the button comes up. Answers whether
 * the click was sent.
 */
async function browserClick(find: () => HTMLElement, box?: HTMLElement): Promise<boolean> {
  const pressed = find();
  pointer(pressed, "pointerdown");
  pointer(pressed, "mousedown");
  box?.blur();
  await settle();
  const released = find();
  pointer(released, "pointerup");
  pointer(released, "mouseup");
  const clicked = pressed.isConnected;
  if (clicked) {
    pressed.click();
  }
  await settle();
  return clicked;
}

/** Selects `id` and types `text` into its Label, leaving the draft unapplied. */
async function typeLabel(element: DatumFormBuilderElement, id: string, text: string): Promise<HTMLInputElement> {
  element.builder!.controller.select(id);
  await until(() => inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === id);
  const box = labelBox(element);
  box.focus();
  box.value = text;
  box.setSelectionRange(3, 3);
  box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  expect(element.builder!.controller.hasPendingChanges(id)).toBe(true);
  return box;
}

describe("selecting another component with unapplied edits", () => {
  it("asks on a press on another component's grip instead of doing nothing", async () => {
    const element = await mount();
    const box = await typeLabel(element, "fullName", "Changed name");
    expect(await browserClick(() => handle(element, "subscribe"), box)).toBe(true);
    await until(() => prompt(element));
    expect(element.builder!.controller.unsavedChangesPrompt()).toEqual({ componentId: "fullName", action: "select" });
    expect(element.builder!.controller.selectedComponentId()).toBe("fullName");
    // The prompt is the existing one: Keep editing (Stay), Discard, Apply; Apply has the focus.
    const buttons = [...prompt(element)!.querySelectorAll("button")].map((button) => Object.keys(button.dataset)[0]);
    expect(buttons).toEqual(["unsavedStay", "unsavedDiscard", "unsavedSave"]);
    expect(inspector(element).activeElement).toBe(prompt(element)!.querySelector("[data-unsaved-save]"));
    expect(prompt(element)!.textContent).toContain("moving on");
    // The canvas has caught up with the text once the press was over.
    await until(() => sheet(element).textContent?.includes("Changed name"));
  });

  it("Apply commits the edit, then selects what was pressed", async () => {
    const element = await mount();
    const box = await typeLabel(element, "fullName", "Changed name");
    await browserClick(() => handle(element, "subscribe"), box);
    await until(() => prompt(element));
    prompt(element)!.querySelector<HTMLButtonElement>("[data-unsaved-save]")!.click();
    const controller = element.builder!.controller;
    await until(() => controller.selectedComponentId() === "subscribe");
    expect(controller.getProperty("fullName", "label")).toBe("Changed name");
    expect(controller.hasPendingChanges("fullName")).toBe(false);
    await until(() => inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === "subscribe");
    expect(prompt(element)).toBeNull();
  });

  it("Discard drops the edit, then selects what was pressed", async () => {
    const element = await mount();
    const box = await typeLabel(element, "fullName", "Changed name");
    await browserClick(() => handle(element, "subscribe"), box);
    await until(() => prompt(element));
    prompt(element)!.querySelector<HTMLButtonElement>("[data-unsaved-discard]")!.click();
    const controller = element.builder!.controller;
    await until(() => controller.selectedComponentId() === "subscribe");
    expect(controller.getProperty("fullName", "label")).toBe("Full name");
    expect(controller.hasPendingChanges()).toBe(false);
    await until(() => !sheet(element).textContent?.includes("Changed name"));
  });

  it("Keep editing stays on the component and puts the author back in the box, caret where it was", async () => {
    const element = await mount();
    const box = await typeLabel(element, "fullName", "Changed name");
    await browserClick(() => handle(element, "subscribe"), box);
    await until(() => prompt(element));
    prompt(element)!.querySelector<HTMLButtonElement>("[data-unsaved-stay]")!.click();
    const controller = element.builder!.controller;
    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    expect(controller.selectedComponentId()).toBe("fullName");
    expect(controller.hasPendingChanges("fullName")).toBe(true);
    await until(() => !prompt(element));
    const active = inspector(element).activeElement as HTMLInputElement | null;
    expect(active).toBe(labelBox(element));
    expect(active!.value).toBe("Changed name");
    expect(active!.selectionStart).toBe(3);
    // Nothing is held: pressing the other grip asks again.
    await browserClick(() => handle(element, "subscribe"), labelBox(element));
    await until(() => prompt(element));
  });

  it("Escape on the prompt is Keep editing, back in the box", async () => {
    const element = await mount();
    const box = await typeLabel(element, "fullName", "Changed name");
    await browserClick(() => handle(element, "subscribe"), box);
    await until(() => prompt(element));
    prompt(element)!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await until(() => !prompt(element));
    expect(element.builder!.controller.selectedComponentId()).toBe("fullName");
    expect(inspector(element).activeElement).toBe(labelBox(element));
  });

  it("asks the same way from the outline", async () => {
    const element = await mount();
    element.builder!.panel = "outline";
    const outline = (): ShadowRoot => shell(element).querySelector("datum-builder-outline")!.shadowRoot!;
    await until(() => outline().querySelector('[data-tree-select="subscribe"]'));
    const box = await typeLabel(element, "fullName", "Changed name");
    expect(await browserClick(() => outline().querySelector<HTMLElement>('[data-tree-select="subscribe"]')!, box)).toBe(true);
    await until(() => prompt(element));
    expect(element.builder!.controller.unsavedChangesPrompt()).toEqual({ componentId: "fullName", action: "select" });
  });

  it("asks the same way from the keyboard on the canvas", async () => {
    const element = await mount();
    await typeLabel(element, "fullName", "Changed name");
    const page = canvas(element).querySelector<HTMLElement>(".canvas-page")!;
    page.focus();
    page.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, composed: true, cancelable: true }));
    await until(() => prompt(element));
    expect(element.builder!.controller.unsavedChangesPrompt()).toEqual({ componentId: "fullName", action: "select" });
    expect(element.builder!.controller.selectedComponentId()).toBe("fullName");
    prompt(element)!.querySelector<HTMLButtonElement>("[data-unsaved-stay]")!.click();
    await until(() => !prompt(element));
    // Keep editing goes back to the box the author left, though the question came from the canvas.
    expect(inspector(element).activeElement).toBe(labelBox(element));
  });

  it("asks nothing on a press on the component being edited", async () => {
    const element = await mount();
    const box = await typeLabel(element, "fullName", "Changed name");
    expect(await browserClick(() => handle(element, "fullName"), box)).toBe(true);
    expect(prompt(element)).toBeNull();
    expect(element.builder!.controller.selectedComponentId()).toBe("fullName");
    expect(element.builder!.controller.hasPendingChanges("fullName")).toBe(true);
  });

  it("asks nothing once Escape in the box has reverted the edit", async () => {
    const element = await mount();
    const box = await typeLabel(element, "fullName", "Changed name");
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
    await until(() => !element.builder!.controller.hasPendingChanges("fullName"));
    await browserClick(() => handle(element, "subscribe"), labelBox(element));
    await until(() => element.builder!.controller.selectedComponentId() === "subscribe");
    expect(prompt(element)).toBeNull();
  });

  it("without a draft, selects at once and paints no more than a selection made directly", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    const panels = [...shell(element).querySelectorAll("*")].filter((node) => node.tagName.toLowerCase().startsWith("datum-builder-"));
    const protos = [...new Set(panels.map((panel) => Object.getPrototypeOf(panel) as { render?: () => void }))];
    let paints = 0;
    const restore = protos.map((proto) => {
      const own = Object.prototype.hasOwnProperty.call(proto, "render");
      const original = proto.render!;
      proto.render = function (this: unknown) {
        paints += 1;
        return original.call(this);
      };
      return () => (own ? (proto.render = original) : delete proto.render);
    });
    const reasons: string[] = [];
    const off = controller.on("change", (event) => reasons.push(event.reason));
    /** From fullName, with its Label box focused and untouched, to subscribe; the paints it took. */
    const measure = async (selectSubscribe: () => Promise<void>): Promise<number> => {
      controller.select("fullName");
      await until(() => inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === "fullName");
      await settle();
      labelBox(element).focus();
      paints = 0;
      reasons.length = 0;
      await selectSubscribe();
      await settle();
      expect(controller.selectedComponentId()).toBe("subscribe");
      return paints;
    };
    try {
      const direct = await measure(async () => {
        labelBox(element).blur();
        controller.select("subscribe");
      });
      const pressed = await measure(async () => {
        expect(await browserClick(() => handle(element, "subscribe"), labelBox(element))).toBe(true);
      });
      expect(prompt(element)).toBeNull();
      // One change, the selection: no edit is sent for a box with nothing in it to send.
      expect(reasons).toEqual(["select"]);
      expect(pressed).toBe(direct);
    } finally {
      off();
      for (const undo of restore) {
        undo();
      }
    }
  });

  it("deletes the selected component from the canvas without asking about its own draft", async () => {
    const element = await mount();
    await typeLabel(element, "fullName", "Changed name");
    const page = canvas(element).querySelector<HTMLElement>(".canvas-page")!;
    page.focus();
    page.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, composed: true, cancelable: true }));
    await until(() => canvas(element).querySelector("[data-confirm-delete]"));
    canvas(element).querySelector<HTMLButtonElement>("[data-confirm-delete]")!.click();
    const controller = element.builder!.controller;
    await until(() => !controller.snapshot().children!.content!.some((node) => node.id === "fullName"));
    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    expect(prompt(element)).toBeNull();
    expect(controller.selectedComponentId()).toBeUndefined();
    expect(controller.hasPendingChanges()).toBe(false);
  });

  it("an Undo of an applied step keeps the open draft's typed Label and its prompt", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    controller.select("fullName");
    controller.setDraftProperty("fullName", "required", false);
    controller.commitDraft("fullName");
    // The canvas redraws the applied edit before the author goes on.
    await settle();
    await typeLabel(element, "fullName", "Changed name");
    await browserClick(() => handle(element, "subscribe"), labelBox(element));
    await until(() => prompt(element));
    controller.undo();
    await settle();
    // The step is undone, but the typed Label is a pending edit the step never touched: it stays,
    // so the question about it stays too.
    expect(controller.hasPendingChanges("fullName")).toBe(true);
    expect(controller.unsavedChangesPrompt()).toEqual({ componentId: "fullName", action: "select" });
    expect(prompt(element)).not.toBeNull();
    expect(controller.selectedComponentId()).toBe("fullName");
    expect(controller.getProperty("fullName", "required")).not.toBe(false);
    // Discard is what takes the draft and its prompt away; the press then goes through.
    prompt(element)!.querySelector<HTMLButtonElement>("[data-unsaved-discard]")!.click();
    await until(() => controller.selectedComponentId() === "subscribe");
    expect(controller.hasPendingChanges()).toBe(false);
    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    expect(prompt(element)).toBeNull();
  });

  it("an Undo that leaves nothing pending takes the draft's prompt down too", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    controller.select("fullName");
    controller.setDraftProperty("fullName", "required", false);
    controller.commitDraft("fullName");
    await settle();
    // The draft holds only the edit the Undo is about to put back, so nothing is left pending.
    controller.setDraftProperty("fullName", "required", true);
    expect(controller.hasPendingChanges("fullName")).toBe(true);
    expect(controller.requestSelect("subscribe")).toBe(false);
    await until(() => prompt(element));
    controller.undo();
    await until(() => !prompt(element));
    expect(controller.hasPendingChanges()).toBe(false);
    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    expect(controller.selectedComponentId()).toBe("fullName");
  });
});
