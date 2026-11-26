import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The Components palette's keyboard: the component list is one Tab stop with a roving
 * tabindex, the group headings are reached by the arrows rather than Tab, a "Skip to canvas"
 * button leads, and the filter box stays a stop before the list. jsdom applies no Tab order, so
 * the stops are counted from the tabindex attributes the panel sets.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;

async function mount(): Promise<{ element: DatumFormBuilderElement; palette: ShadowRoot }> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  // The palette starts shut over a form with components and is stale until opened.
  element.builder!.panel = "components";
  const palette = shell(element).querySelector("datum-builder-toolbar")!.shadowRoot!;
  await until(() => palette.querySelector("[data-palette-type]"));
  return { element, palette };
}

/** The controls a Tab key would stop on: natively focusable ones whose tabindex is not -1. */
const tabStops = (palette: ShadowRoot): HTMLElement[] =>
  [...palette.querySelectorAll<HTMLElement>("button, input, summary, a[href], [tabindex]")].filter((control) => control.getAttribute("tabindex") !== "-1");

const items = (palette: ShadowRoot): HTMLElement[] => [...palette.querySelectorAll<HTMLElement>("[data-palette-type]")];
const stopsInList = (palette: ShadowRoot): HTMLElement[] => [...palette.querySelectorAll<HTMLElement>(".palette-list [data-palette-type], .palette-list summary")];
const key = (target: Element, name: string): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, composed: true, cancelable: true }));
};

describe("the Components palette keyboard", () => {
  it("is search + skip + one list stop in the Tab order", async () => {
    const { palette } = await mount();
    expect(items(palette).length).toBeGreaterThan(10);
    const stops = tabStops(palette);
    expect(stops).toHaveLength(3);
    expect(stops[0]!.hasAttribute("data-palette-skip")).toBe(true);
    expect(stops[1]!.hasAttribute("data-palette-filter")).toBe(true);
    // The one list stop is a component button, the first; no group heading is a stop.
    expect(stops[2]).toBe(items(palette)[0]);
    expect([...palette.querySelectorAll("summary")].every((heading) => heading.getAttribute("tabindex") === "-1")).toBe(true);
  });

  it("moves with the arrows, Home and End, wrapping at the ends, and rests where it landed", async () => {
    const { palette } = await mount();
    const order = stopsInList(palette);
    const first = items(palette)[0]!;
    first.focus();
    const at = order.indexOf(first);
    key(first, "ArrowDown");
    expect(palette.activeElement).toBe(order[at + 1]);
    // The roving stop follows: exactly one list control is in the Tab order, and it is the focused one.
    const rest = tabStops(palette).filter((control) => order.includes(control));
    expect(rest).toEqual([order[at + 1]]);
    key(palette.activeElement!, "End");
    expect(palette.activeElement).toBe(order[order.length - 1]);
    key(palette.activeElement!, "ArrowDown");
    expect(palette.activeElement).toBe(order[0]);
    key(palette.activeElement!, "ArrowUp");
    expect(palette.activeElement).toBe(order[order.length - 1]);
    key(palette.activeElement!, "Home");
    expect(palette.activeElement).toBe(order[0]);
    // Always three stops, wherever the list rests (the heading it landed on is the list's one).
    expect(tabStops(palette)).toHaveLength(3);
  });

  it("reaches a group heading by the arrows, which is how a closed group is opened again", async () => {
    const { palette } = await mount();
    const heading = palette.querySelector<HTMLElement>("summary")!;
    const firstItem = items(palette)[0]!;
    expect(stopsInList(palette)[0]).toBe(heading);
    firstItem.focus();
    key(firstItem, "ArrowUp");
    expect(palette.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("0");
    expect(firstItem.getAttribute("tabindex")).toBe("-1");
  });

  it("keeps the focused item and the roving stop through a repaint of the whole panel", async () => {
    const { element, palette } = await mount();
    const target = items(palette)[3]!;
    const type = target.dataset.paletteType!;
    target.focus();
    expect(target.getAttribute("tabindex")).toBe("0");
    // A new placeholder changes the panel's markup, so every control is rewritten.
    element.textCatalog = { fr: { "components.filter.placeholder": "Filtrer les composants…" } };
    element.textLocale = "fr";
    await until(() => palette.querySelector<HTMLInputElement>("[data-palette-filter]")!.placeholder === "Filtrer les composants…");
    expect(target.isConnected).toBe(false);
    const again = palette.querySelector<HTMLElement>(`[data-palette-type="${type}"]`)!;
    expect(palette.activeElement).toBe(again);
    expect(again.getAttribute("tabindex")).toBe("0");
    expect(tabStops(palette)).toHaveLength(3);
  });

  it("keeps one list stop through the filter, and goes back to the stop it left when the box clears", async () => {
    const { palette } = await mount();
    const rested = items(palette)[4]!;
    const type = rested.dataset.paletteType!;
    rested.focus();
    const total = items(palette).length;
    const filter = palette.querySelector<HTMLInputElement>("[data-palette-filter]")!;
    filter.value = "date";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    const narrowed = items(palette);
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.length).toBeLessThan(total);
    expect(tabStops(palette)).toHaveLength(3);
    // Its rested stop is no longer listed, so a match takes the Tab stop.
    expect(narrowed).toContain(tabStops(palette)[2]);
    filter.value = "";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    const back = palette.querySelector<HTMLElement>(`[data-palette-type="${type}"]`)!;
    expect(back.getAttribute("tabindex")).toBe("0");
    expect(tabStops(palette)).toHaveLength(3);
  });

  it("Skip to canvas puts focus on the canvas", async () => {
    const { element, palette } = await mount();
    const canvas = shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
    await until(() => canvas.querySelector(".canvas-page"));
    palette.querySelector<HTMLElement>("[data-palette-skip]")!.click();
    expect(canvas.activeElement).toBe(canvas.querySelector(".canvas-page"));
  });

  it("still adds a component on a click of the focused item", async () => {
    const { element, palette } = await mount();
    const before = JSON.stringify(element.builder!.controller.snapshot());
    const date = palette.querySelector<HTMLElement>('[data-add-type="date"]')!;
    date.focus();
    date.click();
    expect(JSON.stringify(element.builder!.controller.snapshot())).not.toBe(before);
  });
});
