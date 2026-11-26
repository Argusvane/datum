import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * Moving the form on the canvas, the canvas bar's
 * folded width and zoom buttons, full window, and focus (and scroll) back on the button that
 * opened an inspector dialog.
 */

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.style.overflow = "";
});

type Canvas = HTMLElement & { pan: { x: number; y: number }; panTo(x: number, y: number): void; zoomTo(value: number | "fit"): void };

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const canvasEl = (element: DatumFormBuilderElement): Canvas => shell(element).querySelector<Canvas>("datum-builder-canvas")!;
const canvas = (element: DatumFormBuilderElement): ShadowRoot => canvasEl(element).shadowRoot!;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;

async function mount(attributes: Record<string, string> = {}): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => shell(element)?.querySelector("[data-full-window]") && canvas(element)?.querySelector(".canvas-page"));
  return element;
}

/** jsdom has no PointerEvent: a mouse event of the pointer's type, carrying its id. */
function pointer(type: string, init: MouseEventInit & { pointerId: number }): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, composed: true, ...init });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  return event;
}

function key(target: HTMLElement, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true, ...init }));
}

describe("moving the form on the canvas", () => {
  it("moves the sheet by an offset the zoom does not scale, and Fit centres it again", async () => {
    const element = await mount();
    const surface = canvas(element).querySelector<HTMLElement>(".canvas-surface")!;
    expect(canvasEl(element).pan).toEqual({ x: 0, y: 0 });
    canvasEl(element).panTo(-120, 40);
    expect(canvasEl(element).pan).toEqual({ x: -120, y: 40 });
    expect(surface.style.translate).toBe("-120px 40px");
    // At 200% the translate is in the sheet's own pixels: half, so the screen offset stays put.
    canvasEl(element).zoomTo(2);
    expect(surface.style.translate).toBe("-60px 20px");
    canvasEl(element).zoomTo("fit");
    expect(canvasEl(element).pan).toEqual({ x: 0, y: 0 });
    expect(surface.style.translate).toBe("");
  });

  it("moves with Shift and an arrow key on the canvas, and says so in the canvas's key help", async () => {
    const element = await mount();
    const page = canvas(element).querySelector<HTMLElement>(".canvas-page")!;
    key(page, { key: "ArrowLeft", shiftKey: true });
    key(page, { key: "ArrowDown", shiftKey: true });
    expect(canvasEl(element).pan).toEqual({ x: -48, y: 48 });
    expect(canvas(element).querySelector("#canvas-keys")!.textContent).toContain("Shift with an arrow moves the form");
    key(page, { key: "0" });
    expect(canvasEl(element).pan).toEqual({ x: 0, y: 0 });
  });

  it("pans with a drag on empty canvas, and the click that ends it keeps the selection", async () => {
    const element = await mount();
    element.builder!.controller.select("fullName");
    const page = canvas(element).querySelector<HTMLElement>(".canvas-page")!;
    page.dispatchEvent(pointer("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 }));
    window.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 160, clientY: 90 }));
    expect(page.hasAttribute("data-panning")).toBe(true);
    window.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 160, clientY: 90 }));
    expect(page.hasAttribute("data-panning")).toBe(false);
    expect(canvasEl(element).pan).toEqual({ x: 60, y: -10 });
    page.click();
    expect(element.builder!.controller.selectedComponentId()).toBe("fullName");
    // A press that does not move is a click on the canvas, as before.
    page.dispatchEvent(pointer("pointerdown", { button: 0, pointerId: 2, clientX: 10, clientY: 10 }));
    window.dispatchEvent(pointer("pointerup", { pointerId: 2, clientX: 11, clientY: 10 }));
    page.click();
    expect(element.builder!.controller.selectedComponentId()).toBeUndefined();
  });
});

describe("the canvas bar on a narrow canvas", () => {
  it("folds the width and zoom buttons behind one, which a click elsewhere and Escape put away", async () => {
    const element = await mount();
    const root = canvas(element);
    const more = root.querySelector<HTMLButtonElement>("[data-canvas-more]")!;
    const pop = root.querySelector<HTMLElement>("[data-canvas-more-pop]")!;
    // The fold button is drawn only when a container query finds the canvas narrow, which jsdom does not
    // evaluate; since 30 it does apply the rest of the stylesheet (display none here), and a button that is
    // not drawn takes no focus. So the test draws it, as that query would.
    more.style.display = "inline-flex";
    // One copy of each button: the fold is CSS (a container query), the wrapper lays out nothing wide.
    expect(pop.querySelector("[data-canvas-devices]")).not.toBeNull();
    expect(pop.querySelector("[data-canvas-zoom]")).not.toBeNull();
    expect(more.getAttribute("aria-controls")).toBe(pop.id);
    more.click();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector("[data-canvas-bar]")!.hasAttribute("data-more-open")).toBe(true);
    // A click inside (a zoom step) keeps it open; one outside puts it away.
    root.querySelector<HTMLButtonElement>('[data-canvas-zoom-go="in"]')!.click();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    root.querySelector<HTMLElement>(".canvas-page")!.click();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    more.click();
    key(root.querySelector<HTMLElement>('[data-canvas-zoom-go="out"]')!, { key: "Escape" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(root.activeElement).toBe(more);
  });

  it("gives the bar its Tab stop back when a click outside puts the card away, focus in it", async () => {
    const element = await mount();
    const root = canvas(element);
    const more = root.querySelector<HTMLButtonElement>("[data-canvas-more]")!;
    const bar = root.querySelector<HTMLElement>("[data-canvas-bar]")!;
    more.style.display = "inline-flex";
    // The card's tools are drawn only while it is open, as the narrow canvas's container query has it.
    const proto = HTMLElement.prototype as { checkVisibility?: () => boolean };
    const had = proto.checkVisibility;
    proto.checkVisibility = function (this: HTMLElement) {
      return !this.closest("[data-canvas-more-pop]") || this.closest("[data-more-open]") !== null;
    };
    try {
      more.click();
      const first = root.activeElement as HTMLElement;
      expect(first.closest("[data-canvas-more-pop]")).not.toBeNull();
      expect(first.getAttribute("tabindex")).toBe("0");
      root.querySelector<HTMLElement>(".canvas-page")!.click();
      expect(more.getAttribute("aria-expanded")).toBe("false");
      const stops = [...bar.querySelectorAll<HTMLElement>('button[tabindex="0"]')];
      expect(stops).toHaveLength(1);
      expect(stops[0]!.closest("[data-canvas-more-pop]")).toBeNull();
    } finally {
      if (had) {
        proto.checkVisibility = had;
      } else {
        delete proto.checkVisibility;
      }
    }
  });
});

describe("full window", () => {
  it("covers the window from the bar's button, holds the page's scroll, and gives it back", async () => {
    const element = await mount();
    const button = shell(element).querySelector<HTMLButtonElement>("[data-full-window]")!;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Full window");
    const changes: boolean[] = [];
    element.addEventListener("datum-builder-full-window-change", (event) => changes.push((event as CustomEvent<{ fullWindow: boolean }>).detail.fullWindow));
    button.click();
    expect(element.builder!.hasAttribute("full-window")).toBe(true);
    expect(element.fullWindow).toBe(true);
    expect(element.hasAttribute("full-window")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Leave full window");
    expect(document.documentElement.style.overflow).toBe("hidden");
    button.click();
    expect(element.fullWindow).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
    expect(changes).toEqual([true, false]);
  });

  it("opens in full window from the attribute, gives the scroll back when taken off the page, and hides its button under no-full-window", async () => {
    const element = await mount({ "full-window": "" });
    expect(element.builder!.fullWindow).toBe(true);
    expect(document.documentElement.style.overflow).toBe("hidden");
    element.remove();
    expect(document.documentElement.style.overflow).toBe("");

    const plain = await mount({ "no-full-window": "" });
    expect(shell(plain).querySelector<HTMLButtonElement>("[data-full-window]")!.hidden).toBe(true);
    // The host can still set it; the button then shows, to leave by.
    plain.fullWindow = true;
    expect(shell(plain).querySelector<HTMLButtonElement>("[data-full-window]")!.hidden).toBe(false);
  });
});

describe("an inspector dialog's opener", () => {
  it("takes focus back to the very button that opened the messages editor, without scrolling the panel", async () => {
    const element = document.createElement("datum-form-builder");
    element.definition = sampleDefinition();
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-properties"));
    element.builder!.controller.select("fullName");
    await until(() => inspector(element).querySelector("[data-messages-edit]"));
    const body = inspector(element).querySelector<HTMLElement>(".inspector-body")!;
    // The translation pointer line sits above it: focus must not land on a control up there, which would scroll the panel to the top.
    expect(inspector(element).querySelector("[data-translation-pointer]")).not.toBeNull();
    const focused: Array<{ target: string; preventScroll: boolean | undefined }> = [];
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
      focused.push({ target: Object.keys(this.dataset).join(","), preventScroll: options?.preventScroll });
      original.call(this, options);
    };
    try {
      body.scrollTop = 200;
      inspector(element).querySelector<HTMLButtonElement>("[data-messages-edit]")!.click();
      await until(() => inspector(element).querySelector("[data-options-cancel]"));
      focused.length = 0;
      inspector(element).querySelector<HTMLButtonElement>("[data-options-cancel]")!.click();
      expect(focused.at(-1)).toEqual({ target: "messagesEdit", preventScroll: true });
      expect(inspector(element).activeElement?.hasAttribute("data-messages-edit")).toBe(true);
    } finally {
      HTMLElement.prototype.focus = original;
    }
  });
});

describe("Try it and the inspector", () => {
  it("puts the inspector drawer away while Try it shows its panel, and brings it back with the selection", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    controller.select("fullName");
    const wrap = shell(element).querySelector<HTMLElement>(".wrap")!;
    const tryIt = canvas(element).querySelector<HTMLButtonElement>("[data-try-it]")!;
    tryIt.click();
    await until(() => wrap.hasAttribute("data-trying"));
    expect(canvasEl(element)).toHaveProperty("previewing", true);
    tryIt.click();
    await until(() => !wrap.hasAttribute("data-trying"));
    expect(controller.selectedComponentId()).toBe("fullName");
  });

  it("puts the side panel away while trying the form, and opens it again on Back to editing", async () => {
    const element = await mount();
    const builder = element.builder! as unknown as { panel: string | undefined };
    builder.panel = "outline";
    expect(builder.panel).toBe("outline");
    const tryIt = canvas(element).querySelector<HTMLButtonElement>("[data-try-it]")!;
    tryIt.click();
    await until(() => builder.panel === undefined);
    tryIt.click();
    await until(() => builder.panel === "outline");
  });

  it("asks about edits not applied before Try it, which waits for the answer", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    controller.select("fullName");
    controller.setDraftProperty("fullName", "label", "Name");
    const wrap = shell(element).querySelector<HTMLElement>(".wrap")!;
    canvas(element).querySelector<HTMLButtonElement>("[data-try-it]")!.click();
    expect(controller.unsavedChangesPrompt()).toBeDefined();
    expect(wrap.hasAttribute("data-trying")).toBe(false);
    controller.answerUnsavedChangesPrompt("stay");
    expect(wrap.hasAttribute("data-trying")).toBe(false);
    canvas(element).querySelector<HTMLButtonElement>("[data-try-it]")!.click();
    controller.answerUnsavedChangesPrompt("save");
    await until(() => wrap.hasAttribute("data-trying"));
    expect((controller.snapshot().children!.content![0]!.configuration as { label: unknown }).label).toBe("Name");
  });
});

describe("<datum-form-builder>'s WebAssembly validator in Try it (the wasm attribute)", () => {
  const wasmPart = async (element: DatumFormBuilderElement): Promise<HTMLElement> => {
    (canvasEl(element) as unknown as { previewing: boolean }).previewing = true;
    const panel = canvas(element).querySelector<HTMLElement>("[data-try-panel]")!;
    await until(() => !panel.hidden && panel.querySelector("[data-try-wasm-status]"));
    return panel;
  };
  const status = (panel: HTMLElement): string => panel.querySelector("[data-try-wasm-status]")!.textContent!;

  it("lends the sandbox beside the bundle by default, fetched only when turned on, and says so when the file is not there", async () => {
    const element = await mount();
    const panel = await wasmPart(element);
    const toggle = panel.querySelector<HTMLInputElement>("[data-try-server]")!;
    expect(toggle.disabled).toBe(false);
    expect(toggle.checked).toBe(false);
    toggle.click();
    // No datum-wasm.js beside the source under test: unavailable, said plainly.
    await until(() => status(panel).startsWith("Not available:"), 10000);
    expect(status(panel)).toContain("datum-wasm.js was not found beside the builder");
    expect(panel.querySelector<HTMLInputElement>("[data-try-server]")!.checked).toBe(false);
    expect(panel.querySelector("[data-try-wasm-retry]")).not.toBeNull();
  });

  it("offers none for wasm=\"off\", and a page's own checks win over the attribute", async () => {
    const element = await mount({ wasm: "off" });
    const panel = await wasmPart(element);
    expect(status(panel)).toBe("Not available: the page provides no WebAssembly validator.");
    expect(panel.querySelector<HTMLInputElement>("[data-try-server]")!.disabled).toBe(true);
    element.serverChecks = { label: "The page's sandbox", run: async () => ({ errors: [] }) };
    await until(() => !panel.querySelector<HTMLInputElement>("[data-try-server]")!.disabled);
    element.serverChecks = undefined;
    element.wasm = "auto";
    await until(() => !panel.querySelector<HTMLInputElement>("[data-try-server]")!.disabled);
  });
});
