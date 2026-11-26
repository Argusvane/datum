import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The phone's sheets answer gestures, and say what they are. jsdom has no touch and no layout: the cases dispatch pointer and touch
 * events with a clock they hold, and read attributes, inline transforms and focus. How it looks
 * and feels under a real finger is the harness's (npm run builder:browser) and a device's.
 */

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.style.overflow = "";
  vi.restoreAllMocks();
  // @ts-expect-error put back what a case stubbed
  delete window.matchMedia;
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true, writable: true });
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const q = <T extends HTMLElement = HTMLElement>(element: DatumFormBuilderElement, selector: string): T => shell(element).querySelector<T>(selector)!;
const wrap = (element: DatumFormBuilderElement): HTMLElement => q(element, "[data-shell=wrap]");
const canvasEl = (element: DatumFormBuilderElement) => q(element, "datum-builder-canvas") as HTMLElement & { previewing: boolean };
const canvas = (element: DatumFormBuilderElement): ShadowRoot => canvasEl(element).shadowRoot!;
const form = (element: DatumFormBuilderElement): ShadowRoot => canvas(element).querySelector<HTMLElement>("datum-form-renderer[data-preview]")!.shadowRoot!;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const press = (target: HTMLElement, key: string): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
};

function resizeTo(element: DatumFormBuilderElement, width: number, height = 844): void {
  wrap(element).getBoundingClientRect = () => ({ width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect;
  window.dispatchEvent(new Event("resize"));
}

async function mount(setup?: (element: DatumFormBuilderElement) => void, size: [number, number] = [390, 844]): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  setup?.(element);
  document.body.append(element);
  await until(() => form(element)?.querySelector('[data-component-id="fullName"]'));
  await settle();
  resizeTo(element, size[0], size[1]);
  return element;
}

/** The clock the gestures read (performance.now), held by the case. */
function holdClock(): { t: number } {
  const clock = { t: 1000 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.t);
  return clock;
}

/** jsdom has no PointerEvent: a mouse event with the pointer fields the gestures read. */
function pointer(type: string, target: Element, x: number, y: number): void {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, composed: true, cancelable: true, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 3 }, isPrimary: { value: true }, pointerType: { value: "touch" } });
  target.dispatchEvent(event);
}

/** A finger down on `target` and dragged `dx`, `dy` over `ms` in four moves. */
function swipe(clock: { t: number }, target: Element, dx: number, dy: number, ms: number): void {
  pointer("pointerdown", target, 200, 500);
  for (let i = 1; i <= 4; i += 1) {
    clock.t += ms / 4;
    pointer("pointermove", target, 200 + (dx * i) / 4, 500 + (dy * i) / 4);
  }
  pointer("pointerup", target, 200 + dx, 500 + dy);
}

function touch(type: string, target: Element, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }] });
  target.dispatchEvent(event);
  return event;
}

describe("the inspector and side sheets' handle", () => {
  it("is a real button with a name from the catalog, and the Close button is the keyboard path", async () => {
    const element = await mount();
    q(element, '[data-strip] [data-panel="outline"]').click();
    const grab = q(element, "[data-sheet-grab]");
    expect(grab.tagName).toBe("BUTTON");
    expect(grab.getAttribute("aria-label")).toBe("Drag to close or tap to expand");
    expect(q(element, "[data-sheet-close]").getAttribute("aria-label")).toBe("Close Outline");
    element.textCatalog = { fr: { "shell.sheet.grab": "Glisser pour fermer ou toucher pour agrandir" } };
    element.textLocale = "fr";
    expect(grab.getAttribute("aria-label")).toBe("Glisser pour fermer ou toucher pour agrandir");
  });

  it("follows a drag down, snaps back under the threshold and dismisses over it", async () => {
    const element = await mount();
    const clock = holdClock();
    q(element, '[data-strip] [data-panel="outline"]').click();
    const head = q(element, "[data-sheet-head]");
    const side = q(element, "[data-side]");

    pointer("pointerdown", head, 200, 500);
    clock.t += 200;
    pointer("pointermove", head, 200, 540);
    expect(side.style.transform).toBe("translateY(40px)");
    expect(head.style.transform).toBe("translateY(40px)");
    pointer("pointerup", head, 200, 540);
    expect(side.style.transform).toBe("");
    expect(element.builder!.panel).toBe("outline");

    swipe(clock, head, 0, 200, 800);
    expect(element.builder!.panel).toBeUndefined();
    expect(wrap(element).dataset.sheet).toBeUndefined();
    expect(side.style.transform).toBe("");
    expect(head.style.transform).toBe("");
  });

  it("dismisses on a fling, and expands on a drag up", async () => {
    const element = await mount();
    const clock = holdClock();
    q(element, '[data-strip] [data-panel="outline"]').click();
    const head = q(element, "[data-sheet-head]");
    swipe(clock, head, 0, -60, 400);
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(true);
    expect(q(element, "[data-sheet-grab]").getAttribute("aria-expanded")).toBe("true");
    swipe(clock, head, 0, 60, 40);
    expect(element.builder!.panel).toBeUndefined();
  });

  it("toggles tall on a tap of the handle and takes no second toggle from the click that follows", async () => {
    const element = await mount();
    holdClock();
    q(element, '[data-strip] [data-panel="outline"]').click();
    const grab = q(element, "[data-sheet-grab]");
    pointer("pointerdown", grab, 200, 500);
    pointer("pointerup", grab, 200, 500);
    grab.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(true);
    // The keyboard's click is the handle's own.
    grab.click();
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(false);
  });

  it("closes on a swipe down on the body while it is scrolled to the top, and not otherwise", async () => {
    const element = await mount();
    const clock = holdClock();
    q(element, '[data-strip] [data-panel="outline"]').click();
    const side = q(element, "[data-side]");
    side.scrollTop = 30;
    touch("touchstart", side, 200, 500);
    clock.t += 50;
    expect(touch("touchmove", side, 200, 700).defaultPrevented).toBe(false);
    touch("touchend", side, 200, 700);
    expect(element.builder!.panel).toBe("outline");
    side.scrollTop = 0;
    touch("touchstart", side, 200, 500);
    clock.t += 50;
    expect(touch("touchmove", side, 200, 700).defaultPrevented).toBe(true);
    touch("touchend", side, 200, 700);
    expect(element.builder!.panel).toBeUndefined();
  });

  it("asks about unapplied edits as its Close button does: a refused dismissal snaps back", async () => {
    const element = await mount();
    const clock = holdClock();
    const controller = element.builder!.activeController;
    controller.select("fullName");
    await settle();
    canvas(element).querySelector<HTMLButtonElement>("[data-selection-edit]")!.click();
    expect(wrap(element).dataset.sheet).toBe("props");
    controller.setProperty("fullName", "label", "Drafted but not applied");
    const leave = vi.spyOn(controller, "requestLeave").mockImplementation(() => false);
    swipe(clock, q(element, "[data-sheet-head]"), 0, 250, 900);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(wrap(element).dataset.sheet).toBe("props");
    const props = q(element, "datum-builder-properties");
    expect(props.style.transform).toBe("");
  });

  it("takes the gestures off with the sheet and the touch-action with them", async () => {
    const element = await mount();
    const clock = holdClock();
    q(element, '[data-strip] [data-panel="outline"]').click();
    q(element, "[data-sheet-close]").click();
    // No sheet up: a drag on the (hidden) handle row does nothing.
    const head = q(element, "[data-sheet-head]");
    swipe(clock, head, 0, 300, 100);
    expect(element.builder!.panel).toBeUndefined();
    expect(q(element, "[data-side]").style.transform).toBe("");
  });
});

describe("More, the menu drawer and the results sheet", () => {
  it("dismisses More from its head, and from its list when that is scrolled to the top", async () => {
    const element = await mount();
    const clock = holdClock();
    q(element, "[data-bottom-more]").click();
    expect(wrap(element).dataset.sheet).toBe("more");
    const sheet = q(element, "[data-more-sheet]");
    const head = sheet.querySelector<HTMLElement>(".more-head")!;
    swipe(clock, head, 0, 40, 400);
    expect(wrap(element).dataset.sheet).toBe("more");
    expect(sheet.style.transform).toBe("");
    swipe(clock, head, 0, 220, 900);
    expect(wrap(element).dataset.sheet).toBeUndefined();
    expect(sheet.hidden).toBe(true);

    q(element, "[data-bottom-more]").click();
    const row = shell(element).querySelector<HTMLElement>("[data-more-go]")!;
    touch("touchstart", row, 200, 500);
    clock.t += 50;
    touch("touchmove", row, 200, 740);
    touch("touchend", row, 200, 740);
    expect(wrap(element).dataset.sheet).toBeUndefined();
  });

  it("dismisses the menu drawer on a swipe toward its edge, and returns focus to the Menu button", async () => {
    const element = await mount();
    const clock = holdClock();
    const menu = q(element, "[data-menu-open]");
    menu.focus();
    menu.click();
    const drawer = q(element, "[data-menu-drawer]");
    pointer("pointerdown", drawer, 250, 400);
    clock.t += 400;
    pointer("pointermove", drawer, 190, 402);
    expect(drawer.style.transform).toBe("translateX(-60px)");
    pointer("pointerup", drawer, 190, 402);
    expect(drawer.hidden).toBe(false);
    expect(drawer.style.transform).toBe("");
    swipe(clock, drawer, -200, 4, 800);
    expect(drawer.hidden).toBe(true);
    expect(shell(element).activeElement).toBe(menu);
  });

  it("takes the menu drawer's horizontal pans from every part of it: pan-y on the drawer and its body", async () => {
    const element = await mount();
    const clock = holdClock();
    q(element, "[data-menu-open]").click();
    const drawer = q(element, "[data-menu-drawer]");
    const css = [...shell(element).querySelectorAll("style")].map((style) => style.textContent).join("\n");
    expect(css).toMatch(/\.menu-drawer, [^{]*\.menu-drawer \* \{ touch-action: pan-y/);
    // A swipe toward the edge that starts on a menu row closes the drawer, and the row hears no click.
    const row = drawer.querySelector<HTMLElement>(".menu-row")!;
    const clicked = vi.fn();
    row.addEventListener("click", clicked);
    swipe(clock, row, -200, 6, 800);
    expect(drawer.hidden).toBe(true);
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
    expect(clicked).not.toHaveBeenCalled();
  });

  it("lets a mostly vertical move on the menu body scroll it instead of closing the drawer", async () => {
    const element = await mount();
    const clock = holdClock();
    q(element, "[data-menu-open]").click();
    const drawer = q(element, "[data-menu-drawer]");
    const row = drawer.querySelector<HTMLElement>(".menu-row")!;
    swipe(clock, row, -40, 120, 400);
    expect(drawer.hidden).toBe(false);
    expect(drawer.style.transform).toBe("");
  });

  it("draws the results grabber as a real button with the catalog label, and a tap toggles tall without closing", async () => {
    const element = await mount();
    holdClock();
    q(element, "[data-bottom-try]").click();
    q(element, "[data-bottom-results]").click();
    const panel = canvas(element).querySelector<HTMLElement>("[data-try-panel]")!;
    const grab = panel.querySelector<HTMLButtonElement>("button[data-try-grab]")!;
    expect(grab).not.toBeNull();
    expect(grab.type).toBe("button");
    expect(grab.getAttribute("aria-label")).toBe("Drag to close or tap to expand");
    expect(grab.getAttribute("aria-expanded")).toBe("false");
    pointer("pointerdown", grab, 200, 500);
    pointer("pointerup", grab, 200, 500);
    expect(canvasEl(element).hasAttribute("data-results-tall")).toBe(true);
    expect(grab.getAttribute("aria-expanded")).toBe("true");
    expect(grab.getAttribute("aria-label")).toBe("Drag to close or tap to shrink");
    expect(wrap(element).dataset.sheet).toBe("results");
    // The keyboard's click shrinks it again.
    grab.click();
    expect(canvasEl(element).hasAttribute("data-results-tall")).toBe(false);
    expect(grab.getAttribute("aria-expanded")).toBe("false");
    expect(wrap(element).dataset.sheet).toBe("results");
  });

  it("dismisses the results sheet on a swipe down from the grabber", async () => {
    const element = await mount();
    const clock = holdClock();
    q(element, "[data-bottom-try]").click();
    q(element, "[data-bottom-results]").click();
    const grab = canvas(element).querySelector<HTMLElement>("[data-try-grab]")!;
    swipe(clock, grab, 0, 300, 300);
    expect(wrap(element).dataset.sheet).toBeUndefined();
  });

  it("makes the results sheet a dialog, moves focus in, and gives it back on Escape", async () => {
    const element = await mount();
    q(element, "[data-bottom-try]").click();
    const results = q(element, "[data-bottom-results]");
    results.focus();
    results.click();
    expect(wrap(element).dataset.sheet).toBe("results");
    const panel = canvas(element).querySelector<HTMLElement>("[data-try-panel]")!;
    const title = panel.querySelector<HTMLElement>("[data-try-sheet-title]")!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-labelledby")).toBe(title.id);
    expect(title.id).not.toBe("");
    expect(canvas(element).activeElement).toBe(title);
    expect(q(element, "[data-shell=bar]").hasAttribute("inert")).toBe(true);

    press(title, "Escape");
    expect(wrap(element).dataset.sheet).toBeUndefined();
    expect(canvasEl(element).hasAttribute("data-results-open")).toBe(false);
    expect(panel.hasAttribute("role")).toBe(false);
    expect(shell(element).activeElement).toBe(results);
  });

  it("names the Try panel Preview, not Try it, once Try it is left out and the sheet has closed", async () => {
    const element = await mount();
    q(element, "[data-bottom-try]").click();
    q(element, "[data-bottom-results]").click();
    const panel = canvas(element).querySelector<HTMLElement>("[data-try-panel]")!;
    expect(panel.getAttribute("aria-label")).toBe("Try it results");
    element.builder!.setAttribute("features", "logic");
    press(panel.querySelector<HTMLElement>("[data-try-sheet-title]")!, "Escape");
    expect(panel.hasAttribute("role")).toBe(false);
    expect(panel.getAttribute("aria-label")).toBe("Preview");
  });

  it("closes the results sheet on a tap of its scrim, but not on a tap inside the sheet", async () => {
    const element = await mount();
    q(element, "[data-bottom-try]").click();
    q(element, "[data-bottom-results]").click();
    const panel = canvas(element).querySelector<HTMLElement>("[data-try-panel]")!;
    panel.querySelector<HTMLElement>("[data-try-sheet-title]")!.click();
    expect(wrap(element).dataset.sheet).toBe("results");
    canvas(element).querySelector<HTMLElement>(".panel--canvas")!.click();
    expect(wrap(element).dataset.sheet).toBeUndefined();
  });

  it("dismisses the results sheet on a swipe down from its head or its top, and keeps its scroll below that", async () => {
    const element = await mount();
    const clock = holdClock();
    q(element, "[data-bottom-try]").click();
    q(element, "[data-bottom-results]").click();
    const panel = canvas(element).querySelector<HTMLElement>("[data-try-panel]")!;
    const title = panel.querySelector<HTMLElement>("[data-try-sheet-title]")!;
    panel.scrollTop = 60;
    touch("touchstart", title, 200, 400);
    clock.t += 100;
    expect(touch("touchmove", title, 200, 440).defaultPrevented).toBe(true);
    expect(panel.style.transform).toBe("translateY(40px)");
    touch("touchend", title, 200, 440);
    expect(wrap(element).dataset.sheet).toBe("results");
    expect(panel.style.transform).toBe("");

    touch("touchstart", panel, 200, 400);
    expect(touch("touchmove", panel, 200, 700).defaultPrevented).toBe(false);
    touch("touchend", panel, 200, 700);
    expect(wrap(element).dataset.sheet).toBe("results");

    panel.scrollTop = 0;
    touch("touchstart", panel, 200, 400);
    clock.t += 50;
    touch("touchmove", panel, 200, 700);
    touch("touchend", panel, 200, 700);
    expect(wrap(element).dataset.sheet).toBeUndefined();
  });
});

describe("the small phone, the landscape phone and the tier change", () => {
  it("opens the inspector's sheets tall at 320x568, and lets the handle shrink them", async () => {
    const element = await mount(undefined, [320, 568]);
    q(element, '[data-strip] [data-panel="outline"]').click();
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(true);
    const grab = q(element, "[data-sheet-grab]");
    expect(grab.getAttribute("aria-label")).toBe("Drag to close or tap to shrink");
    grab.click();
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(false);
    q(element, "[data-sheet-close]").click();
    // Remembered for the page, as the author's choice.
    q(element, '[data-strip] [data-panel="outline"]').click();
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(false);
  });

  it("keeps the 70% default at 390x844 and at 360x640", async () => {
    const element = await mount();
    q(element, '[data-strip] [data-panel="outline"]').click();
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(false);
    resizeTo(element, 360, 640);
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(false);
    resizeTo(element, 320, 568);
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(true);
    resizeTo(element, 390, 844);
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(false);
  });

  it("keeps the phone layout for a short viewport with a coarse pointer, at a width over 768", async () => {
    const element = await mount();
    Object.defineProperty(window, "innerHeight", { value: 390, configurable: true, writable: true });
    window.matchMedia = ((query: string) => ({ matches: query === "(pointer: coarse)" })) as unknown as typeof window.matchMedia;
    resizeTo(element, 844, 390);
    expect(element.builder!.phoneLayout).toBe(true);
    expect(element.builder!.narrowLayout).toBe(true);
    expect(wrap(element).hasAttribute("data-phone")).toBe(true);
    // The sheet is tall by default there: the screen is short.
    q(element, '[data-strip] [data-panel="outline"]').click();
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(true);

    // The same size with a mouse is a small desktop window, not a phone.
    window.matchMedia = ((query: string) => ({ matches: query !== "(pointer: coarse)" })) as unknown as typeof window.matchMedia;
    resizeTo(element, 845, 390);
    expect(element.builder!.phoneLayout).toBe(false);
    // A tall window with a coarse pointer (a tablet) is not a phone either.
    window.matchMedia = ((query: string) => ({ matches: query === "(pointer: coarse)" })) as unknown as typeof window.matchMedia;
    Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true, writable: true });
    resizeTo(element, 845, 1000);
    expect(element.builder!.phoneLayout).toBe(false);
  });

  it("puts a sheet away with the tier and returns focus to something the shell still draws", async () => {
    const element = await mount();
    const more = q(element, "[data-bottom-more]");
    more.focus();
    more.click();
    expect(wrap(element).dataset.sheet).toBe("more");
    resizeTo(element, 1000);
    expect(wrap(element).dataset.sheet).toBeUndefined();
    expect(shell(element).querySelectorAll("[inert]").length).toBe(0);
    // More is gone with the phone: focus is not left on it, nor on the page.
    const active = shell(element).activeElement;
    expect(active).not.toBeNull();
    expect(active).not.toBe(more);
    expect(shell(element).contains(active)).toBe(true);
  });

  it("returns focus to the Menu button when the drawer closes with the tier and the button is still drawn", async () => {
    const element = await mount();
    const menu = q(element, "[data-menu-open]");
    menu.focus();
    menu.click();
    expect(q(element, "[data-menu-drawer]").hidden).toBe(false);
    resizeTo(element, 700, 844);
    expect(q(element, "[data-menu-drawer]").hidden).toBe(false);
    resizeTo(element, 1000);
    expect(q(element, "[data-menu-drawer]").hidden).toBe(true);
    expect(shell(element).activeElement).not.toBeNull();
  });
});

describe("the page does not scroll under a sheet", () => {
  it("locks the window's scroll under a phone sheet in the contained layout, and gives it back", async () => {
    const element = await mount((el) => {
      el.layout = "contained";
    });
    document.documentElement.style.overflow = "auto";
    q(element, '[data-strip] [data-panel="outline"]').click();
    expect(document.documentElement.style.overflow).toBe("hidden");
    q(element, "[data-sheet-close]").click();
    expect(document.documentElement.style.overflow).toBe("auto");
    q(element, "[data-menu-open]").click();
    expect(document.documentElement.style.overflow).toBe("hidden");
    resizeTo(element, 1000);
    expect(document.documentElement.style.overflow).toBe("auto");
  });

  it("leaves the window alone in the page layout, and lets go when the builder leaves the page", async () => {
    const page = await mount();
    q(page, '[data-strip] [data-panel="outline"]').click();
    expect(document.documentElement.style.overflow).toBe("");
    page.remove();

    const element = await mount((el) => {
      el.layout = "contained";
    });
    q(element, '[data-strip] [data-panel="outline"]').click();
    expect(document.documentElement.style.overflow).toBe("hidden");
    element.remove();
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("keeps full window's own lock when a sheet comes and goes", async () => {
    const element = await mount((el) => {
      el.layout = "contained";
    });
    element.builder!.fullWindow = true;
    expect(document.documentElement.style.overflow).toBe("hidden");
    q(element, '[data-strip] [data-panel="outline"]').click();
    q(element, "[data-sheet-close]").click();
    expect(document.documentElement.style.overflow).toBe("hidden");
    element.builder!.fullWindow = false;
    expect(document.documentElement.style.overflow).toBe("");
  });
});
