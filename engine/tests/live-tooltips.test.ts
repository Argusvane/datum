// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { lit } from "../form-engine/render/live/lit.js";
import { createTooltipsFeature } from "../form-engine/render/live/tooltips.js";
import { bindingOf, cleanUp, definitionOf, input, mounted, settled, textAdapter, textState, wrapper } from "./live-extras-kit.js";

/*
 * Field help in the live renderer (render/live/tooltips.ts): the capability
 * decides where the text goes (a bubble, the hint, nowhere), and a drawn bubble can be
 * dismissed (Escape, the mark's keys) and comes back once pointer and focus have left.
 */

afterEach(cleanUp);

const definition = () =>
  definitionOf([{ id: "name", type: "text", configuration: { label: "Name", description: "As written", tooltip: "Your legal name" } }]);

const withTooltip = (support: "drawn" | "degraded" | "none") => bindingOf(lit, textAdapter(lit, { capabilities: { tooltip: support } }));

const bubble = (root: ShadowRoot): HTMLElement | null => root.querySelector<HTMLElement>("[data-tooltip]");
const mark = (root: ShadowRoot): HTMLElement => root.querySelector<HTMLElement>("[data-tooltip-mark]") as HTMLElement;

function key(target: EventTarget, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("live tooltips: what the capability decides", () => {
  it("draws the bubble and describes the control by it, after the description", async () => {
    const { root } = await mounted(definition(), { binding: withTooltip("drawn"), features: [textState, createTooltipsFeature()] });
    const text = root.getElementById("name__tooltip");
    expect(text?.textContent).toBe("Your legal name");
    expect(mark(root).getAttribute("aria-label")).toBe("Help");
    expect(mark(root).getAttribute("aria-describedby")).toBe("name__tooltip");
    const described = (input(root, "name").getAttribute("aria-describedby") ?? "").split(" ");
    expect(described).toEqual([wrapper(root, "name").querySelector(".hint")?.id, "name__tooltip"]);
  });

  it("folds the text into the hint once when the binding draws no bubble, and describes the control by the hint alone", async () => {
    const { root, form } = await mounted(definition(), { binding: withTooltip("degraded"), features: [textState, createTooltipsFeature()] });
    expect(bubble(root)).toBeNull();
    expect(wrapper(root, "name").querySelector(".hint")?.textContent).toBe("As written Your legal name");
    expect(input(root, "name").getAttribute("aria-describedby")).toBe(wrapper(root, "name").querySelector(".hint")?.id);
    expect(form.unsupported()).toEqual([]);
  });

  it("draws nothing for a binding that answers none, and records it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { root, form } = await mounted(definition(), { binding: withTooltip("none"), features: [textState, createTooltipsFeature()] });
    expect(bubble(root)).toBeNull();
    expect(root.textContent).not.toContain("Your legal name");
    expect(form.unsupported()).toEqual(["name: tooltip"]);
  });
});

describe("live tooltips: dismissing the bubble", () => {
  it("closes the bubble that holds focus on Escape, once, and keeps the event only when one closed", async () => {
    const { root } = await mounted(definition(), { binding: withTooltip("drawn"), features: [textState, createTooltipsFeature()] });
    const outside = key(document.body, "Escape");
    expect(outside.defaultPrevented).toBe(false);
    mark(root).focus();
    const escaped = key(document.body, "Escape");
    expect(bubble(root)?.hasAttribute("data-dismissed")).toBe(true);
    expect(escaped.defaultPrevented).toBe(true);
    // Nothing left to close: the next Escape belongs to whatever surrounds the form.
    expect(key(document.body, "Escape").defaultPrevented).toBe(false);
  });

  it("ignores Escape with a modifier", async () => {
    const { root } = await mounted(definition(), { binding: withTooltip("drawn"), features: [textState, createTooltipsFeature()] });
    mark(root).focus();
    key(document.body, "Escape", { shiftKey: true });
    expect(bubble(root)?.hasAttribute("data-dismissed")).toBe(false);
  });

  it("toggles on Enter or Space from the mark, without scrolling the page", async () => {
    const { root } = await mounted(definition(), { binding: withTooltip("drawn"), features: [textState, createTooltipsFeature()] });
    const space = key(mark(root), " ");
    expect(space.defaultPrevented).toBe(true);
    expect(bubble(root)?.hasAttribute("data-dismissed")).toBe(true);
    key(mark(root), "Enter");
    expect(bubble(root)?.hasAttribute("data-dismissed")).toBe(false);
    key(mark(root), "a");
    key(mark(root), "Enter", { ctrlKey: true });
    expect(bubble(root)?.hasAttribute("data-dismissed")).toBe(false);
  });

  it("opens again once pointer and focus have left it, and not while focus is still inside", async () => {
    const { root } = await mounted(definition(), { binding: withTooltip("drawn"), features: [textState, createTooltipsFeature()] });
    mark(root).focus();
    key(mark(root), "Enter");
    expect(bubble(root)?.hasAttribute("data-dismissed")).toBe(true);
    // The pointer leaves while focus is inside: still closed.
    mark(root).dispatchEvent(new MouseEvent("mouseout", { bubbles: true, composed: true, relatedTarget: document.body }));
    expect(bubble(root)?.hasAttribute("data-dismissed")).toBe(true);
    // Focus moves within the bubble: still closed.
    mark(root).dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: bubble(root)?.querySelector("[data-tooltip-text]") as Element }));
    expect(bubble(root)?.hasAttribute("data-dismissed")).toBe(true);
    // Focus leaves the form: open again.
    mark(root).blur();
    mark(root).dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: null }));
    expect(bubble(root)?.hasAttribute("data-dismissed")).toBe(false);
  });

  it("cancels a click on the help, so the label does not forward it to the control", async () => {
    const { root } = await mounted(definition(), { binding: withTooltip("drawn"), features: [textState, createTooltipsFeature()] });
    const click = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
    mark(root).dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    const elsewhere = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
    input(root, "name").dispatchEvent(elsewhere);
    expect(elsewhere.defaultPrevented).toBe(false);
  });

  it("keeps the bubble through a draw: the node, and its dismissal, are the same", async () => {
    const { root, runtime, form } = await mounted(definition(), { binding: withTooltip("drawn"), features: [textState, createTooltipsFeature()] });
    const before = bubble(root);
    key(mark(root), "Enter");
    runtime.setValue("name", "Ann");
    await settled(form);
    expect(bubble(root)).toBe(before);
    expect(bubble(root)?.hasAttribute("data-dismissed")).toBe(true);
  });

  it("removes its listeners on unmount", async () => {
    const removed: string[] = [];
    const remove = document.removeEventListener.bind(document);
    vi.spyOn(document, "removeEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      removed.push(type);
      remove(type, listener, options);
    });
    const { form } = await mounted(definition(), { binding: withTooltip("drawn"), features: [textState, createTooltipsFeature()] });
    form.unmount();
    expect(removed).toContain("keydown");
  });
});
