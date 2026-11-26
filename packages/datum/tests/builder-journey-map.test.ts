import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { ComponentNode, Expression, FormDefinition, JourneyConfiguration } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

/*
 * The Journeys mode's Map view: the journey as a flow map on the canvas, its own lazy
 * chunk the designer loads on the first Map, read and select only. Kept apart from
 * builder-journeys.test.ts. jsdom lays nothing out and may not focus SVG, so these check the
 * classes, attributes and the controller; the real-Chrome pass checks the rest.
 */

/** The map's chunk, as the designer imports it — mocked by the first case alone. */
const MAP_MODULE = "../../../engine/form-engine/builder/journey-map/journey-map.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

/**
 * A ResizeObserver, which jsdom has none of: `flush()` reports the targets whose size moved since
 * they were last seen, as the browser does at its next frame. A border box is read as its client
 * size, any other box as the width and height jsdom computes from the shadow root's styles (the
 * map's cover gauge, as wide as the side drawer lies over the page). A target only observed, with
 * no size moved, reports nothing, so the shell's own observers stay as they were.
 */
function watchSizes(): { flush(): void } {
  interface Watch {
    target: Element;
    box: string;
    seen: string;
    observer: FakeResizeObserver;
  }
  const watches: Watch[] = [];
  const measure = (target: Element, box: string): string => {
    if (box === "border-box") {
      return `${(target as HTMLElement).clientWidth}x${(target as HTMLElement).clientHeight}`;
    }
    const style = window.getComputedStyle(target);
    return `${style.width}x${style.height}`;
  };
  class FakeResizeObserver {
    public constructor(public readonly callback: ResizeObserverCallback) {}
    public observe(target: Element, options?: ResizeObserverOptions): void {
      const box = options?.box ?? "content-box";
      watches.push({ target, box, seen: measure(target, box), observer: this });
    }
    public unobserve(target: Element): void {
      watches.splice(0, watches.length, ...watches.filter((watch) => watch.observer !== this || watch.target !== target));
    }
    public disconnect(): void {
      watches.splice(0, watches.length, ...watches.filter((watch) => watch.observer !== this));
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return {
    flush(): void {
      const moved = new Map<FakeResizeObserver, ResizeObserverEntry[]>();
      for (const watch of watches) {
        const now = measure(watch.target, watch.box);
        if (now !== watch.seen) {
          watch.seen = now;
          moved.set(watch.observer, [...(moved.get(watch.observer) ?? []), { target: watch.target } as ResizeObserverEntry]);
        }
      }
      for (const [observer, entries] of moved) {
        observer.callback(entries, observer as unknown as ResizeObserver);
      }
    }
  };
}

/** The shell's own side drawer: open (`data-side-collapsed` off) or shut. */
function drawerOpen(element: DatumFormBuilderElement): boolean {
  return !shell(element).querySelector(".wrap")!.hasAttribute("data-side-collapsed");
}

const subscribed: Expression = { kind: "path", path: "subscribe" };

/**
 * Over the sample form: Start asks the name and whether to subscribe, and goes to News when
 * subscribing (route 1), else on to Plain (route 2, always), so Plain is reached only when not
 * subscribing; News asks only what subscribing shows, and is shown even when none of it does
 * (no step is passed over).
 */
function mapJourney(): JourneyConfiguration {
  return {
    journeys: [
      {
        id: "map",
        name: "Map",
        pages: [
          { id: "start", title: "Start", components: ["fullName", "subscribe"], routes: [{ when: subscribed, to: "news" }, { to: "plain" }] },
          { id: "plain", title: "Plain", components: ["country"] },
          { id: "news", title: "News", components: ["email"] }
        ]
      }
    ]
  };
}

function withMapJourney(): FormDefinition {
  return { ...sampleDefinition(), journey: mapJourney() };
}

function mount(setup?: (element: DatumFormBuilderElement) => void): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("pdf", "off");
  element.definition = withMapJourney();
  setup?.(element);
  document.body.append(element);
  return element;
}

function shell(element: DatumFormBuilderElement): ShadowRoot {
  return element.builder!.shadowRoot!;
}

function canvasRoot(element: DatumFormBuilderElement): ShadowRoot {
  return shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
}

function sheet(element: DatumFormBuilderElement): ShadowRoot | undefined {
  const canvas = shell(element).querySelector("datum-builder-canvas") as (HTMLElement & { previewRoot(): ShadowRoot | undefined }) | null;
  return canvas?.previewRoot();
}

/** The journeys side, on the journey's map: a journey opens on it, whatever its number of steps. */
async function openJourneys(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  element.mode = "journeys";
  await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
}

function viewButton(element: DatumFormBuilderElement, view: "map" | "step"): HTMLElement {
  return shell(element).querySelector<HTMLElement>(`[data-mode-actions] [data-journey-views] [data-journey-view="${view}"]`)!;
}

/** The map's surface, where the canvas shows it in the sheet's place. */
function surface(element: DatumFormBuilderElement): HTMLElement | null {
  return canvasRoot(element).querySelector<HTMLElement>("[data-canvas-surface] [data-journey-map]");
}

function svg(element: DatumFormBuilderElement): SVGSVGElement {
  return surface(element)!.querySelector<SVGSVGElement>("svg.jm-svg")!;
}

function item(element: DatumFormBuilderElement, key: string): SVGElement | null {
  return surface(element)?.querySelector<SVGElement>(`[data-map-item="${key}"]`) ?? null;
}

function barButton(element: DatumFormBuilderElement, selector: string): HTMLButtonElement {
  return surface(element)!.querySelector<HTMLButtonElement>(`[data-map-bar] ${selector}`)!;
}

async function openMap(element: DatumFormBuilderElement): Promise<void> {
  viewButton(element, "map").click();
  await until(() => surface(element)?.querySelector("svg.jm-svg [data-map-item]"));
}

/** SVG has no `.click()` under jsdom: a click as the pointer gives one. */
function click(target: Element, type: "click" | "dblclick" = "click"): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true }));
}

function key(target: Element, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** The journey's page nodes and the first page's route nodes, by the designer's node ids. */
function nodes(element: DatumFormBuilderElement): { pages: ComponentNode[]; routes: ComponentNode[] } {
  const pages = element.journeyMode!.controller.snapshot().children!.pages!;
  return { pages, routes: pages[0]!.children!.routes! };
}

/** The one item Tab lands on. */
function tabStop(element: DatumFormBuilderElement): string[] {
  return [...surface(element)!.querySelectorAll('[data-map-item][tabindex="0"]')].map((entry) => entry.getAttribute("data-map-item")!);
}

/** The drawn size over the picture's own: the zoom. */
function zoomOf(element: DatumFormBuilderElement): number {
  const [, , width] = svg(element).getAttribute("viewBox")!.split(" ").map(Number);
  return Number(svg(element).getAttribute("width")) / width!;
}

describe("<datum-form-builder> journeys: the Map view", () => {
  // First in the file on purpose: the map's chunk has not loaded yet, so the mock is what the
  // designer's first load meets. The load is retried after a failure, so the cases below load it.
  it("loads the map's chunk when a journey first opens on its map; a failed load is reported, leaves the view the author moved to, and loads on the next try", async () => {
    const element = mount();
    const errors: string[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    const failed = (): number => errors.filter((message) => message === "The journey map could not be loaded").length;
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));

    vi.doMock(MAP_MODULE, () => {
      throw new Error("chunk missing");
    });
    try {
      // A journey opens on its map, whose chunk is not in: said once, and the author is left on the Step view.
      element.mode = "journeys";
      await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
      await until(() => failed() === 1 && element.journeyMode!.view === "step");
      expect(surface(element)).toBeNull();
      expect(viewButton(element, "step").getAttribute("aria-pressed")).toBe("true");

      // Map again: busy while it loads (the ARIA state written as "true"), a note in the sheet's place.
      viewButton(element, "map").click();
      expect(viewButton(element, "map").parentElement!.getAttribute("aria-busy")).toBe("true");
      expect(canvasRoot(element).querySelector("[data-canvas-surface] [data-journey-map-note]")?.textContent).toBe("Drawing the map…");
      // The author moves to the Step view before the load fails: the Step view stays shown.
      viewButton(element, "step").click();
      await until(() => failed() === 2);
      expect(element.journeyMode!.view).toBe("step");
      expect(viewButton(element, "map").parentElement!.hasAttribute("aria-busy")).toBe(false);

      // Failing again while still on Map: on to the Step view — said once, though the canvas was
      // shown again while the chunk was coming (the same journey put on the page again).
      viewButton(element, "map").click();
      await element.journeyMode!.selectJourney("map");
      await until(() => failed() === 3);
      await until(() => element.journeyMode!.view === "step");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(failed()).toBe(3);
      expect(viewButton(element, "step").getAttribute("aria-pressed")).toBe("true");
      expect(surface(element)).toBeNull();
    } finally {
      vi.doUnmock(MAP_MODULE);
    }

    // Not remembered broken: the next Map loads it and draws the journey, its stylesheet beside it.
    await openMap(element);
    expect(element.journeyMode!.view).toBe("map");
    expect(canvasRoot(element).querySelector("[data-canvas-surface] style[data-surface-styles]")!.textContent).toContain(".datum-journey-map");
    expect(canvasRoot(element).querySelector(".canvas-page")!.hasAttribute("data-surface")).toBe(true);
  });

  it("is the first of Map | Step on the bar, and draws a card per step, no diamond, one line where a step the walk may pass over goes on, and routes numbered as written", async () => {
    const element = mount();
    await openJourneys(element);
    expect(shell(element).querySelector("[data-mode-actions] [data-journey-views]")?.hasAttribute("data-segmented")).toBe(true);
    const views = [...shell(element).querySelectorAll<HTMLElement>("[data-journey-views] [data-journey-view]")];
    // The map is the default; no third view stands on the bar (the pages as cards are gone).
    expect(views.map((button) => [button.textContent, button.getAttribute("aria-pressed"), button.hidden])).toEqual([
      ["Map", "true", false],
      ["Step", "false", false]
    ]);
    await openMap(element);
    expect(views.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);

    const { pages, routes } = nodes(element);
    const map = surface(element)!;
    expect(map.querySelectorAll("[data-map-stage] .jm-page")).toHaveLength(3);
    expect([...map.querySelectorAll(".jm-node[data-map-item]")].map((card) => card.getAttribute("data-map-item"))).toEqual(pages.map((page) => page.id));
    expect(item(element, "$start")).not.toBeNull();
    expect(item(element, "$end")?.textContent).toContain("End · submits");
    // No diamond: every way leaves a step's card, and no step is passed over: News goes on
    // to the end by its one line, with no pass-by beside it.
    expect(map.querySelector(".jm-gate, [data-map-node^='gate:'], [data-map-node^='fork:']")).toBeNull();
    expect(map.querySelector('[data-edge^="pass:"], .jm-edge--pass, .is-empty')).toBeNull();
    const fall = map.querySelector(`.jm-edge[data-edge="next:${pages[2]!.id}"]`)!;
    expect([fall.getAttribute("data-from"), fall.getAttribute("data-to")]).toEqual([`page:${pages[2]!.id}`, "$end"]);
    // Start's routes leave Start's card.
    expect(map.querySelector(`.jm-edge[data-edge="route:${pages[0]!.id}:0"]`)!.getAttribute("data-from")).toBe(`page:${pages[0]!.id}`);
    // Start's two routes, each a chip selecting its route, numbered as the findings number them.
    const first = item(element, routes[0]!.id)!;
    const second = item(element, routes[1]!.id)!;
    expect(first.getAttribute("data-select")).toBe(routes[0]!.id);
    expect(first.querySelector("title")!.textContent).toMatch(/^1 · If Subscribe/);
    expect(second.querySelector("title")!.textContent).toBe("2 · Otherwise");
    expect(first.getAttribute("aria-label")).toMatch(/^1 · If .*\. Route 1 of Step 1 · Start: if .*, goes to Step 3 · News\./);
    // A page's label says it all, after the words its card draws (Label in Name); the status line counts.
    expect(item(element, pages[0]!.id)!.getAttribute("aria-label")).toMatch(/^1 Start start · 2 questions\. Step 1 of 3, Start, id start, 2 questions\./);
    // The bar says plain counts; the announcement says the longer line. No list of the journey in words stands
    // under the map: the items' names (each step's whole sentence) are its text alternative.
    expect(map.querySelector("[data-map-status]")!.textContent).toBe("3 steps");
    await until(() => /3 steps · \d+ branch points?/.test(map.querySelector("[data-map-announce]")!.textContent ?? ""));
    expect(map.querySelector("[data-map-words], [data-map-list], .jm-alt, .jm-foot")).toBeNull();
    // Route 2 always matches, so nothing falls through the first step: no way of the next order leaves it.
    expect(map.querySelector(`[data-edge="next:${pages[0]!.id}"]`)).toBeNull();
  });

  it("selects what is clicked through the journey's controller, and marks what is selected elsewhere", async () => {
    const element = mount();
    await openJourneys(element);
    await openMap(element);
    const controller = element.journeyMode!.controller;
    const { pages, routes } = nodes(element);

    click(item(element, pages[1]!.id)!.querySelector(".jm-node__box")!);
    expect(controller.selectedComponentId()).toBe(pages[1]!.id);
    await until(() => item(element, pages[1]!.id)!.classList.contains("is-selected"));
    expect(item(element, pages[1]!.id)!.getAttribute("aria-current")).toBe("true");

    // A route selected elsewhere (a click on its chip opens it in Logic, which is held below): its chip is marked, its page as holding the selection.
    controller.select(routes[0]!.id);
    expect(controller.selectedComponentId()).toBe(routes[0]!.id);
    expect(item(element, routes[0]!.id)!.classList.contains("is-selected")).toBe(true);
    expect(surface(element)!.querySelector(`.jm-page[data-map-node="page:${pages[0]!.id}"]`)!.classList.contains("is-within")).toBe(true);
    expect(surface(element)!.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    // A line selects the step it leaves.
    click(surface(element)!.querySelector(`.jm-edge[data-edge="next:${pages[2]!.id}"] path`)!);
    expect(controller.selectedComponentId()).toBe(pages[2]!.id);

    // Selected in the outline: the map follows, and the inspector still hears it (the map's listener comes first).
    shell(element).querySelector<HTMLElement>('[data-strip] [data-panel="outline"]')!.click();
    const outline = shell(element).querySelector<HTMLElement>("datum-builder-outline")!;
    await until(() => outline.shadowRoot!.querySelector(`[data-tree-select="${pages[0]!.id}"]`));
    outline.shadowRoot!.querySelector<HTMLElement>(`[data-tree-select="${pages[0]!.id}"]`)!.click();
    expect(controller.selectedComponentId()).toBe(pages[0]!.id);
    expect(item(element, pages[0]!.id)!.classList.contains("is-selected")).toBe(true);
    expect(item(element, pages[2]!.id)!.classList.contains("is-selected")).toBe(false);
    expect(outline.shadowRoot!.querySelector(".tree-select.active")?.getAttribute("data-tree-select")).toBe(pages[0]!.id);
    // A question lights the page it is on.
    const question = pages[1]!.children!.content![0]!;
    controller.select(question.id);
    expect(surface(element)!.querySelector(`.jm-page[data-map-node="page:${pages[1]!.id}"]`)!.classList.contains("is-within")).toBe(true);
    // The root: Start alone is current, though End selects it too.
    click(item(element, "$end")!);
    expect(controller.selectedComponentId()).toBe(controller.rootId());
    expect(item(element, "$start")!.getAttribute("aria-current")).toBe("true");
    expect(item(element, "$end")!.hasAttribute("aria-current")).toBe(false);

    // A click held by the unsaved-edits prompt leaves the mark where it was.
    controller.select(pages[0]!.id);
    controller.setDraftProperty(pages[0]!.id, "title", "Start, drafted");
    click(item(element, pages[2]!.id)!);
    expect(controller.selectedComponentId()).toBe(pages[0]!.id);
    expect(item(element, pages[0]!.id)!.classList.contains("is-selected")).toBe(true);
    expect(item(element, pages[2]!.id)!.classList.contains("is-selected")).toBe(false);
    controller.discardDraft(pages[0]!.id);
  });

  it("walks its items with the arrows, follows a way with Alt, selects with Enter, and nests no button in another", async () => {
    const element = mount();
    await openJourneys(element);
    await openMap(element);
    const controller = element.journeyMode!.controller;
    const { pages, routes } = nodes(element);
    const map = surface(element)!;

    controller.select(undefined);
    // One tab stop for the picture, one for the bar.
    const [first] = tabStop(element);
    expect(tabStop(element)).toHaveLength(1);
    key(item(element, first!)!, "Home");
    expect(tabStop(element)).toEqual(["$start"]);
    expect([...map.querySelectorAll('[data-map-bar] button[tabindex="0"]')]).toHaveLength(1);
    // No button inside another (a page's stubs sit beside its card, never in it).
    for (const button of map.querySelectorAll("[role=button]")) {
      expect(button.parentElement!.closest("[role=button]")).toBeNull();
    }
    expect(map.querySelector("[data-map-bar]")!.getAttribute("role")).toBe("toolbar");

    expect(key(item(element, "$start")!, "ArrowDown").defaultPrevented).toBe(true);
    expect(tabStop(element)).toEqual([pages[0]!.id]);
    key(item(element, pages[0]!.id)!, "ArrowRight");
    expect(tabStop(element)).toEqual([routes[0]!.id]);
    key(item(element, routes[0]!.id)!, "ArrowUp");
    expect(tabStop(element)).toEqual([pages[0]!.id]);
    // Alt follows: a page to its first way out, a way out to where it goes, and back again.
    key(item(element, pages[0]!.id)!, "ArrowDown", { altKey: true });
    expect(tabStop(element)).toEqual([routes[0]!.id]);
    key(item(element, routes[0]!.id)!, "ArrowDown", { altKey: true });
    expect(tabStop(element)).toEqual([pages[2]!.id]);
    key(item(element, pages[2]!.id)!, "ArrowUp", { altKey: true });
    expect(tabStop(element)).toEqual([routes[0]!.id]);
    key(item(element, routes[0]!.id)!, "ArrowLeft", { altKey: true });
    expect(tabStop(element)).toEqual([pages[0]!.id]);
    key(item(element, pages[0]!.id)!, "End");
    expect(tabStop(element)).toEqual(["$end"]);
    key(item(element, "$end")!, "Home");
    expect(tabStop(element)).toEqual(["$start"]);
    // Moving is not selecting: Space is, and Enter on anything but a step (Enter on a step opens it, below).
    expect(controller.selectedComponentId()).not.toBe(pages[0]!.id);
    key(item(element, "$start")!, "ArrowDown");
    key(item(element, pages[0]!.id)!, " ");
    expect(controller.selectedComponentId()).toBe(pages[0]!.id);
    key(item(element, pages[0]!.id)!, "ArrowDown");
    key(item(element, routes[0]!.id)!, "Enter");
    expect(controller.selectedComponentId()).toBe(routes[0]!.id);
    expect(element.journeyMode!.view).toBe("map");
    // Cmd or Ctrl keys stay the canvas's and the browser's.
    expect(key(item(element, routes[0]!.id)!, "0", { metaKey: true }).defaultPrevented).toBe(false);
    // Focus or hover lights a node's lines, and only lines.
    key(item(element, routes[0]!.id)!, "ArrowUp");
    expect(map.classList.contains("is-lighting")).toBe(true);
    expect(map.querySelectorAll(".jm-edge.is-lit").length).toBeGreaterThan(0);
    key(item(element, pages[0]!.id)!, "Escape");
    expect(map.classList.contains("is-lighting")).toBe(false);

    // The bar is a toolbar: the arrows walk its buttons.
    const buttons = [...map.querySelectorAll<HTMLButtonElement>("[data-map-bar] button")];
    key(buttons[0]!, "ArrowRight");
    expect(buttons[1]!.tabIndex).toBe(0);
    expect(buttons[0]!.tabIndex).toBe(-1);
    key(buttons[1]!, "End");
    expect(buttons.at(-1)!.tabIndex).toBe(0);
    key(buttons.at(-1)!, "ArrowRight");
    expect(buttons[0]!.tabIndex).toBe(0);
  });

  it("draws down or right, and remembers the choice per viewer under persist-panels; offers no list order and no key", async () => {
    const element = mount((el) => el.setAttribute("persist-panels", "map-layout-1"));
    await openJourneys(element);
    await openMap(element);
    const map = surface(element)!;
    expect(map.getAttribute("data-direction")).toBe("down");
    const downBox = svg(element).getAttribute("viewBox");
    barButton(element, '[data-map-direction="right"]').click();
    expect(map.getAttribute("data-direction")).toBe("right");
    expect(svg(element).getAttribute("data-direction")).toBe("right");
    expect(svg(element).getAttribute("viewBox")).not.toBe(downBox);
    expect(barButton(element, '[data-map-direction="right"]').getAttribute("aria-pressed")).toBe("true");
    expect(barButton(element, '[data-map-direction="down"]').getAttribute("aria-pressed")).toBe("false");
    // Branches | List order and the Key are gone, and so is the journey in words under the picture.
    expect(map.querySelector("[data-map-arrange], [data-map-key]")).toBeNull();
    expect(map.hasAttribute("data-arrange")).toBe(false);
    expect(svg(element).hasAttribute("data-arrange")).toBe(false);
    expect(map.querySelector("[data-map-words]")).toBeNull();
    expect(element.journeyMode!.mapLayout).toEqual({ direction: "right" });
    // Never the definition's.
    expect(JSON.stringify(element.definition.journey)).toBe(JSON.stringify(mapJourney()));

    // The host sets it too.
    element.journeyMode!.mapLayout = { direction: "down" };
    expect(map.getAttribute("data-direction")).toBe("down");
    element.journeyMode!.mapLayout = { direction: "right" };

    // Another builder with the same key: the same layout; with another key, the default.
    document.body.innerHTML = "";
    const again = mount((el) => el.setAttribute("persist-panels", "map-layout-1"));
    await openJourneys(again);
    expect(again.journeyMode!.mapLayout).toEqual({ direction: "right" });
    await openMap(again);
    expect(surface(again)!.getAttribute("data-direction")).toBe("right");
    expect(barButton(again, '[data-map-direction="right"]').getAttribute("aria-pressed")).toBe("true");
    document.body.innerHTML = "";
    const other = mount((el) => el.setAttribute("persist-panels", "map-layout-2"));
    await openJourneys(other);
    expect(other.journeyMode!.mapLayout).toEqual({ direction: "down" });
    // Three builders in one case: a busy machine takes longer than the default 5 s over them.
  }, 20000);

  it("keeps its view state across a repaint, and keeps the zoom through a form edit", async () => {
    const sizes = watchSizes();
    const element = mount();
    await openJourneys(element);
    await openMap(element);
    const controller = element.journeyMode!.controller;
    const { pages } = nodes(element);

    // Zoom: in, the own size, fit. The press on the canvas shuts the side drawer the shell opened,
    // and the fit follows the room that leaves it, as the drawer's cover moves.
    barButton(element, '[data-map-zoom="fit"]').click();
    sizes.flush();
    const fitted = zoomOf(element);
    expect(fitted).toBeGreaterThanOrEqual(0.6);
    expect(fitted).toBeLessThanOrEqual(1);
    barButton(element, '[data-map-zoom="in"]').click();
    expect(zoomOf(element)).toBeCloseTo(Math.min(2, fitted * 1.25), 2);
    barButton(element, '[data-map-zoom="actual"]').click();
    expect(zoomOf(element)).toBeCloseTo(1, 2);
    barButton(element, '[data-map-zoom="fit"]').click();
    expect(zoomOf(element)).toBeCloseTo(fitted, 2);
    key(item(element, "$start")!, "+");
    const zoomed = zoomOf(element);
    expect(zoomed).toBeCloseTo(Math.min(2, fitted * 1.25), 2);

    click(item(element, pages[1]!.id)!);
    key(item(element, pages[1]!.id)!, "ArrowDown");
    const stop = tabStop(element);

    // A title typed on the page: drawn again, the selection, the tab stop and the zoom kept.
    controller.setProperty(pages[1]!.id, "title", "Plain, renamed");
    await until(() => svg(element).textContent!.includes("Plain, renamed"));
    expect(item(element, pages[1]!.id)!.classList.contains("is-selected")).toBe(true);
    expect(tabStop(element)).toEqual(stop);
    expect(zoomOf(element)).toBeCloseTo(zoomed, 2);

    // A form edit shows the map again (the mode's every-change pass): nothing is reset.
    element.controller!.setProperty("fullName", "label", "Your name");
    await until(() => (item(element, pages[0]!.id)!.getAttribute("aria-label") ?? "") !== "");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(zoomOf(element)).toBeCloseTo(zoomed, 2);
    expect(item(element, pages[1]!.id)!.classList.contains("is-selected")).toBe(true);

    // Undo on the journey's controller (Cmd+Z on the canvas) takes the title back, and the map follows.
    controller.undo();
    await until(() => !svg(element).textContent!.includes("Plain, renamed"));
  });

  it("shows a route with no target yet as a row on its card, and a tree that cannot be written as the last map that could", async () => {
    const element = mount();
    const errors: string[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    await openJourneys(element);
    await openMap(element);
    const controller = element.journeyMode!.controller;
    const { pages } = nodes(element);

    controller.add("journey-route", pages[2]!.id, "routes");
    await until(() => surface(element)!.querySelector('.jm-stub[data-stub="no-target"]'));
    const stub = surface(element)!.querySelector<SVGElement>('.jm-stub[data-stub="no-target"]')!;
    expect(stub.textContent).toContain("no target yet");
    const routeId = stub.getAttribute("data-map-item")!;
    click(stub);
    expect(controller.selectedComponentId()).toBe(routeId);

    controller.setProperty(pages[1]!.id, "when", 7);
    await until(() => svg(element).classList.contains("is-stale"));
    const problem = surface(element)!.querySelector<HTMLElement>("[data-map-problem]")!;
    expect(problem.hidden).toBe(false);
    expect(problem.textContent).toContain("cannot be saved as it stands");
    expect(errors.some((message) => message.includes("cannot be saved as it stands"))).toBe(true);
    controller.undo();
    await until(() => !svg(element).classList.contains("is-stale"));
    expect(problem.hidden).toBe(true);
  });

  it("opens the Step view on the step from a double click or Shift+Enter, selected; keeps the try session's runtime across a Map visit", async () => {
    const element = mount();
    await openJourneys(element);
    const controller = element.journeyMode!.controller;
    const { pages } = nodes(element);

    // Open Try it, set an answer, note the runtime.
    canvasRoot(element).querySelector<HTMLElement>("[data-try-it]")!.click();
    await until(() => element.journeyMode!.previewRuntime && canvasRoot(element).querySelector("[data-try-panel] .try-card[data-try-journey]"));
    const runtime = element.journeyMode!.previewRuntime;
    expect(runtime).toBeDefined();
    if (!runtime) throw new Error("previewRuntime is undefined");
    runtime.setValue("fullName", "Ada");
    // Exit Try it to go to Map.
    canvasRoot(element).querySelector<HTMLElement>("[data-try-it]")!.click();
    await until(() => !element.journeyMode!.previewRuntime);

    await openMap(element);
    // Try it again: a runtime is there, and the answers typed before are not (leaving Try it clears them).
    canvasRoot(element).querySelector<HTMLElement>("[data-try-it]")!.click();
    await until(() => element.journeyMode!.previewRuntime && canvasRoot(element).querySelector("[data-try-panel] .try-card[data-try-journey]"));
    expect(element.journeyMode!.previewRuntime).toBeDefined();
    expect(element.journeyMode!.previewRuntime!.state().values.fullName).toBeUndefined();
    canvasRoot(element).querySelector<HTMLElement>("[data-try-it]")!.click();
    await until(() => !element.journeyMode!.previewRuntime);
    await openMap(element);

    // No button of the map's bar sends the author to another view: Open on the selection bar is the way in.
    expect(barButton(element, "[data-map-show]")).toBeNull();
    click(item(element, pages[2]!.id)!);
    surface(element)!.querySelector<HTMLButtonElement>('[data-map-sel="open"]')!.click();
    expect(element.journeyMode!.view).toBe("step");
    expect(controller.selectedComponentId()).toBe(pages[2]!.id);

    await openMap(element);
    click(item(element, pages[1]!.id)!, "dblclick");
    expect(element.journeyMode!.view).toBe("step");
    expect(controller.selectedComponentId()).toBe(pages[1]!.id);

    await openMap(element);
    key(item(element, pages[0]!.id)!, "Enter", { shiftKey: true });
    expect(element.journeyMode!.view).toBe("step");
    expect(controller.selectedComponentId()).toBe(pages[0]!.id);
  });

  it("keeps a palette drag over the map from the sheet it hides", async () => {
    const element = mount();
    await openJourneys(element);
    await openMap(element);
    const reached = vi.fn();
    canvasRoot(element).addEventListener("dragover", reached);
    surface(element)!.querySelector(".jm-svg")!.dispatchEvent(new Event("dragover", { bubbles: true, composed: true }));
    expect(reached).not.toHaveBeenCalled();
    // The picture's items say the journey: a sentence per step, in reading order.
    expect(surface(element)!.querySelectorAll('.jm-svg [data-map-item][role="button"]').length).toBeGreaterThanOrEqual(5);
    expect(item(element, nodes(element).pages[1]!.id)!.getAttribute("aria-label")).toContain("Step 2 of 3, Plain");
  });

  it("catches up on a form edit made on another tab when Journeys is back", async () => {
    const element = mount();
    await openJourneys(element);
    await openMap(element);
    const { routes } = nodes(element);
    expect(item(element, routes[0]!.id)!.querySelector("title")!.textContent).toMatch(/^1 · If Subscribe/);

    element.mode = "form";
    await until(() => element.builder!.mode === "form");
    element.controller!.setProperty("subscribe", "label", "Opt in");
    element.mode = "journeys";
    await until(() => element.builder!.mode === "journeys" && surface(element)?.querySelector("svg.jm-svg"));
    // The route's condition in words names the question as the form now labels it.
    await until(() => /^1 · If Opt in/.test(item(element, routes[0]!.id)?.querySelector("title")?.textContent ?? ""));
    expect(item(element, routes[0]!.id)!.getAttribute("aria-label")).toContain("Opt in");
  });

  it("writes nothing on the map for a change that leaves it as it was", async () => {
    const element = mount();
    await openJourneys(element);
    await openMap(element);
    const controller = element.journeyMode!.controller;
    const { pages } = nodes(element);
    click(item(element, pages[1]!.id)!);
    await until(() => item(element, pages[1]!.id)!.classList.contains("is-selected"));

    const writes: MutationRecord[] = [];
    const watcher = new MutationObserver((records) => writes.push(...records));
    watcher.observe(surface(element)!, { subtree: true, attributes: true, childList: true, characterData: true });
    // The journey's canvas repainting, as it does for a keystroke: the map is drawn again, and
    // finds nothing to write — not even the selection's marks, taken off and put back.
    controller.repaintPreview();
    await new Promise((resolve) => setTimeout(resolve, 20));
    writes.push(...watcher.takeRecords());
    watcher.disconnect();
    expect(writes.map((record) => `${record.type} ${record.attributeName ?? ""} ${(record.target as Element).getAttribute?.("data-map-item") ?? ""}`)).toEqual([]);
    expect(item(element, pages[1]!.id)!.classList.contains("is-selected")).toBe(true);
  });

  it("brings the selection into view below its head: when shown afresh, when an add selects what it adds, and round the focused item on a zoom", async () => {
    // jsdom has no scrollIntoView: a stand-in records what is scrolled to.
    const proto = Element.prototype as unknown as { scrollIntoView?: (this: Element) => void };
    const scrolled: Element[] = [];
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const element = mount();
      await openJourneys(element);
      await openMap(element);
      const controller = element.journeyMode!.controller;
      const { pages } = nodes(element);
      // What the items' scroll-margin reads: the head's room, measured (jsdom lays out nothing, so the gap alone).
      expect(surface(element)!.style.getPropertyValue("--jm-head-room")).toMatch(/^\d+px$/);

      // Back from the Step view with Step 3 selected there: brought into view.
      viewButton(element, "step").click();
      controller.select(pages[2]!.id);
      scrolled.length = 0;
      viewButton(element, "map").click();
      await until(() => scrolled.includes(item(element, pages[2]!.id)!));

      // An add selects what it adds (no selection event): once drawn, brought into view.
      scrolled.length = 0;
      controller.add("journey-route", pages[2]!.id, "routes");
      await until(() => surface(element)!.querySelector('.jm-stub[data-stub="no-target"]'));
      const stub = surface(element)!.querySelector('.jm-stub[data-stub="no-target"]')!;
      expect(controller.selectedComponentId()).toBe(stub.getAttribute("data-map-item"));
      await until(() => scrolled.includes(stub));
      // Selected elsewhere (the outline) before the redraw that puts it on the map: brought into view by that redraw.
      scrolled.length = 0;
      controller.add("journey-route", pages[1]!.id, "routes");
      const added = controller.selectedComponentId()!;
      controller.select(added);
      await until(() => item(element, added));
      await until(() => scrolled.includes(item(element, added)!));

      // A zoom keeps the focused item in view.
      const focused = item(element, pages[1]!.id)!;
      click(focused);
      (focused as SVGElement).focus();
      scrolled.length = 0;
      key(focused, "+");
      expect(scrolled).toContain(focused);
    } finally {
      delete proto.scrollIntoView;
    }
  });

  it("says the scale once a zoom rests, disables a zoom at its end, and names buttons as they read", async () => {
    const element = mount();
    await openJourneys(element);
    await openMap(element);
    const announce = surface(element)!.querySelector<HTMLElement>("[data-map-announce]")!;
    const zoomIn = barButton(element, '[data-map-zoom="in"]');
    const zoomOut = barButton(element, '[data-map-zoom="out"]');
    barButton(element, '[data-map-zoom="actual"]').click();
    zoomIn.click();
    await until(() => announce.textContent === "Zoom 125%");
    // 1.25, 1.5625, 1.95, then 2 at most.
    zoomIn.click();
    zoomIn.click();
    zoomIn.click();
    expect(zoomOf(element)).toBeCloseTo(2, 2);
    expect(zoomIn.getAttribute("aria-disabled")).toBe("true");
    zoomIn.click();
    expect(zoomOf(element)).toBeCloseTo(2, 2);
    await until(() => announce.textContent === "Zoom 200%, as large as it goes");
    expect(zoomOut.getAttribute("aria-disabled")).toBe("false");
    for (let step = 0; step < 20 && zoomOut.getAttribute("aria-disabled") !== "true"; step += 1) {
      zoomOut.click();
    }
    expect(zoomOf(element)).toBeCloseTo(0.25, 2);
    expect(zoomOut.getAttribute("aria-disabled")).toBe("true");
    expect(zoomIn.getAttribute("aria-disabled")).toBe("false");

    // What a voice user says is in the name: "100%"; the direction arrows are not read.
    expect(barButton(element, '[data-map-zoom="actual"]').getAttribute("aria-label")).toMatch(/^100%/);
    for (const direction of ["down", "right"]) {
      const button = barButton(element, `[data-map-direction="${direction}"]`);
      const arrow = button.querySelector("[aria-hidden='true']");
      expect(arrow?.textContent).toMatch(/^[↓→]$/);
      expect(button.textContent!.replace(arrow!.textContent!, "").trim()).toMatch(/^(Top down|Left to right)$/);
    }
  });

  it("starts the picture clear of the side drawer and fits it beside the drawer; Fit says what it fits each way", async () => {
    const sizes = watchSizes();
    const element = mount();
    await openJourneys(element);
    await openMap(element);
    const map = surface(element)!;
    const stage = map.querySelector<HTMLElement>("[data-map-stage]")!;
    const fit = barButton(element, '[data-map-zoom="fit"]');
    expect(fit.title).toBe("Fit the map to the page's width (0)");
    // The scroller as wide as the picture and its own padding (the map fits into the content box).
    const [, , width] = svg(element).getAttribute("viewBox")!.split(" ").map(Number);
    const scroller = map.closest(".canvas-page")!;
    const scrollerStyle = window.getComputedStyle(scroller);
    const padding = (Number.parseFloat(scrollerStyle.paddingLeft) || 0) + (Number.parseFloat(scrollerStyle.paddingRight) || 0);
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: width! + padding });
    // The press on the canvas shuts the side drawer the shell opened, and the fit follows the
    // room that leaves it: fitted at its own size while nothing covers it.
    fit.click();
    sizes.flush();
    expect(drawerOpen(element)).toBe(false);
    expect(zoomOf(element)).toBeCloseTo(1, 2);
    // The stage starts the picture past the drawer (the drawer is shut here: read as the browser would with it open).
    const computed = window.getComputedStyle;
    window.getComputedStyle = ((target: Element, pseudo?: string | null) =>
      target === stage ? ({ paddingLeft: "100px" } as CSSStyleDeclaration) : computed(target, pseudo)) as typeof window.getComputedStyle;
    try {
      fit.click();
      expect(zoomOf(element)).toBeCloseTo(Math.max(0.6, (width! - 100) / width!), 2);
    } finally {
      window.getComputedStyle = computed;
    }
    barButton(element, '[data-map-direction="right"]').click();
    expect(fit.title).toBe("Fit the map to the page's height (0)");
  });

  it("fits again for the room left when the side drawer opens or shuts over a fitted map, and keeps a zoom of its own", async () => {
    const sizes = watchSizes();
    const element = mount();
    await openJourneys(element);
    await openMap(element);
    const map = surface(element)!;
    const stage = map.querySelector<HTMLElement>("[data-map-stage]")!;
    const paintsBefore = svg(element);
    // The scroller as wide as the picture and its own padding: fitted at its own size while nothing covers it.
    const [, , width] = svg(element).getAttribute("viewBox")!.split(" ").map(Number);
    const scroller = map.closest(".canvas-page")!;
    const scrollerStyle = window.getComputedStyle(scroller);
    const padding = (Number.parseFloat(scrollerStyle.paddingLeft) || 0) + (Number.parseFloat(scrollerStyle.paddingRight) || 0);
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: width! + padding });
    const cover = (): number => Number.parseFloat(window.getComputedStyle(stage).paddingLeft) || 0;
    const beside = (covered: number): number => Math.min(1, Math.max(0.6, (width! - covered) / width!));
    const strip = (): HTMLElement => shell(element).querySelector<HTMLElement>('[data-strip] [role=tab][data-panel="components"]')!;

    // The shell's palette is open over the page: the scroller's new size refits beside it.
    expect(drawerOpen(element)).toBe(true);
    sizes.flush();
    const open = cover();
    expect(open).toBeGreaterThan(0);
    expect(map.style.getPropertyValue("--jm-view-w")).toBe(`${Math.round(width!)}px`);
    const fittedOpen = zoomOf(element);
    expect(fittedOpen).toBeCloseTo(beside(open), 2);
    expect(fittedOpen).toBeLessThan(1);

    // Shut over a fitted map: the page keeps its size, the cover goes, and the map fits the whole width.
    strip().click();
    expect(drawerOpen(element)).toBe(false);
    expect(cover()).toBe(0);
    sizes.flush();
    expect(zoomOf(element)).toBeCloseTo(1, 2);

    // Opened again over the full-width fit: fitted beside the drawer once more, not left overflowing under it.
    strip().click();
    expect(drawerOpen(element)).toBe(true);
    expect(cover()).toBe(open);
    sizes.flush();
    expect(zoomOf(element)).toBeCloseTo(fittedOpen, 2);

    // A size moving with the cover as it was fitted beside: nothing to do.
    const before = svg(element).getAttribute("width");
    sizes.flush();
    expect(svg(element).getAttribute("width")).toBe(before);

    // A zoom of its own stays as it is whichever way the drawer goes.
    barButton(element, '[data-map-zoom="actual"]').click();
    expect(drawerOpen(element)).toBe(true);
    expect(zoomOf(element)).toBeCloseTo(1, 2);
    strip().click();
    sizes.flush();
    expect(zoomOf(element)).toBeCloseTo(1, 2);
    strip().click();
    sizes.flush();
    expect(zoomOf(element)).toBeCloseTo(1, 2);
    // Back to Fit with the drawer open: beside it.
    barButton(element, '[data-map-zoom="fit"]').click();
    expect(zoomOf(element)).toBeCloseTo(fittedOpen, 2);

    // Refitting only resizes the picture: the same drawing throughout.
    expect(svg(element)).toBe(paintsBefore);
  });

  it("watches its scroller's border box, which the scroller's own scrollbar never moves", async () => {
    const watched: Array<{ target: Element; options?: ResizeObserverOptions }> = [];
    const global = globalThis as unknown as { ResizeObserver?: unknown };
    global.ResizeObserver = class {
      public observe(target: Element, options?: ResizeObserverOptions): void {
        watched.push({ target, ...(options ? { options } : {}) });
      }
      public unobserve(): void {}
      public disconnect(): void {}
    };
    try {
      const element = mount();
      await openJourneys(element);
      await openMap(element);
      await until(() => watched.some((entry) => entry.target.classList.contains("canvas-page")));
      const scroller = watched.find((entry) => entry.target.classList.contains("canvas-page"))!;
      expect(scroller.options?.box).toBe("border-box");
    } finally {
      delete global.ResizeObserver;
    }
  });

  it("draws a journey with nodes of its own: its own fields among the questions, and what each page fills and works out", async () => {
    const read = (path: string): Expression => ({ kind: "path", path });
    const own: JourneyConfiguration = {
      journeys: [
        {
          id: "own",
          name: "Own",
          pages: [
            { id: "contact", title: "Contact", components: [{ id: "work_email", type: "text", configuration: { label: "Work email", fills: "email" } }] },
            {
              id: "names",
              title: "Names",
              components: [
                { id: "first", type: "text", configuration: { label: "First name" } },
                { id: "last", type: "text", configuration: { label: "Last name" } },
                { id: "whole", type: "journey-value", configuration: { to: "fullName", value: { kind: "call", name: "concat", args: [read("first"), { kind: "literal", value: " " }, read("last")] } } }
              ]
            },
            {
              id: "rest",
              title: "Rest",
              components: [
                {
                  id: "both",
                  type: "grid",
                  configuration: { columns: 2 },
                  children: { content: [{ type: "journey-field", configuration: { componentId: "country" } }, { type: "journey-field", configuration: { componentId: "subscribe" } }] }
                }
              ]
            }
          ]
        }
      ]
    } as unknown as JourneyConfiguration;
    const errors: unknown[] = [];
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), journey: own };
      el.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail));
    });
    await openJourneys(element);
    await openMap(element);
    const map = surface(element)!;
    const cards = [...map.querySelectorAll<SVGElement>("[data-map-stage] .jm-node[data-map-item]")];
    expect(cards).toHaveLength(3);
    // The labels are the designer's to lend (JourneyMapWords.field); without them the map says the ids.
    // Email is shown only when subscribing; the page asking it differently is shown either way.
    expect(cards[0]!.getAttribute("aria-label")).toMatch(/^1 Contact contact · 1 question Fills (Email|email)\. Step 1 of 3, Contact, id contact, 1 question\. It fills (Email|email)\. Then to Step 2 · Names\./);
    expect(cards[0]!.querySelector(".jm-node__note")?.textContent).toMatch(/^Fills (Email|email)$/);
    expect(cards[1]!.getAttribute("aria-label")).toMatch(/^2 Names names · 2 questions Works out (Full name|fullName)\. Step 2 of 3, Names, id names, 2 questions\. It works out (Full name|fullName)\. /);
    expect(cards[1]!.querySelector(".jm-node__note")?.textContent).toMatch(/^Works out (Full name|fullName)$/);
    expect(cards[2]!.getAttribute("aria-label")).toMatch(/^3 Rest rest · 2 questions\. Step 3 of 3, Rest, id rest, 2 questions\. Then to the end, which submits\./);
    expect(cards[2]!.querySelector(".jm-node__note")).toBeNull();
    expect(map.querySelector<HTMLElement>("[data-map-problem]")!.hidden).toBe(true);
    expect(errors).toEqual([]);
  });
  it("draws a route condition box's typing once it rests, never once per keystroke", async () => {
    const element = mount();
    await openJourneys(element);
    await openMap(element);
    const stage = surface(element)!.querySelector<HTMLElement>("[data-map-stage]")!;
    let rebuilds = 0;
    const observer = new MutationObserver((records) => {
      rebuilds += records.filter((record) => [...record.addedNodes].some((node) => node.nodeName.toLowerCase() === "svg")).length;
    });
    observer.observe(stage, { childList: true });
    const controller = element.journeyMode!.controller;
    const route = nodes(element).routes[1]!.id;
    controller.select(route);
    rebuilds = 0;
    const typed = "subscribe = true";
    for (let length = 1; length <= typed.length; length += 1) {
      controller.setDraftProperty(route, "when", typed.slice(0, length), { live: true });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const during = rebuilds;
    await new Promise((resolve) => setTimeout(resolve, 300));
    observer.disconnect();
    expect(during).toBe(0);
    expect(rebuilds).toBeLessThanOrEqual(1);
    // A committed edit still draws at once.
    const before = svg(element).outerHTML;
    controller.add("journey-page", "journey", "pages");
    await until(() => svg(element).outerHTML !== before);
  });
});

/*
 * Editing a journey on the map: Add step and New rule on the bar, the bar
 * on the selected step (Open, Move up, Move down, Duplicate, Delete), plain counts, and the keys.
 * Each change is one undo step on the journey's controller; the map itself writes nothing.
 */
describe("<datum-form-builder> journeys: editing on the map", () => {
  const order = (element: DatumFormBuilderElement): string[] => nodes(element).pages.map((page) => page.id);
  const selbar = (element: DatumFormBuilderElement): HTMLElement => surface(element)!.querySelector<HTMLElement>("[data-map-selbar]")!;
  const sel = (element: DatumFormBuilderElement, action: string): HTMLButtonElement => selbar(element).querySelector<HTMLButtonElement>(`[data-map-sel="${action}"]`)!;
  const cards = (element: DatumFormBuilderElement): number => surface(element)!.querySelectorAll("[data-map-stage] .jm-page").length;
  const addStep = (element: DatumFormBuilderElement): HTMLButtonElement => barButton(element, "[data-map-add]");
  const newRule = (element: DatumFormBuilderElement): HTMLButtonElement => barButton(element, "[data-map-rule]");

  async function mapped(journey: JourneyConfiguration = mapJourney()): Promise<DatumFormBuilderElement> {
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), journey };
    });
    await openJourneys(element);
    await openMap(element);
    return element;
  }

  it("builds a journey up to four steps from the map alone, each Add step one undo, after the selected step else at the end", async () => {
    const element = await mapped();
    const controller = element.journeyMode!.controller;
    const [first, second, third] = order(element) as [string, string, string];
    expect(addStep(element).tagName).toBe("BUTTON");
    expect(addStep(element).textContent).toBe("Add step");
    // Nothing selected: at the end.
    controller.select(undefined);
    await until(() => addStep(element).title === "Add an empty step at the end");
    addStep(element).click();
    const added = controller.selectedComponentId()!;
    expect(order(element)).toEqual([first, second, third, added]);
    await until(() => cards(element) === 4);
    expect(item(element, added)!.classList.contains("is-selected")).toBe(true);
    // One undo takes it back, one redo puts it again.
    controller.undo();
    expect(order(element)).toEqual([first, second, third]);
    controller.redo();
    expect(order(element)).toEqual([first, second, third, added]);
    await until(() => cards(element) === 4);

    // With a step selected: right after it, and the new step is the selection.
    click(item(element, first)!);
    await until(() => addStep(element).title === "Add an empty step after the selected one");
    addStep(element).click();
    const inserted = controller.selectedComponentId()!;
    expect(order(element)).toEqual([first, inserted, second, third, added]);
    await until(() => cards(element) === 5);
    controller.undo();
    expect(order(element)).toEqual([first, second, third, added]);
    // A step of the journey's own kind: empty questions, no page id typed.
    controller.redo();
    const node = nodes(element).pages[1]!;
    expect(node.type).toBe("journey-page");
    expect(node.children?.content ?? []).toEqual([]);
  });

  it("names each icon-only button of the selection bar (an accessible name and a drawn tip from the text table), and says why Delete is off on the only step", async () => {
    const element = await mapped();
    click(item(element, order(element)[1]!)!);
    await until(() => !selbar(element).parentElement!.hidden);
    const named: Array<[string, string, string]> = [
      ["up", "Move up", "Move this step one place earlier"],
      ["down", "Move down", "Move this step one place later"],
      ["duplicate", "Duplicate", "Copy this step, with its questions, right after it"],
      ["delete", "Delete", "Delete this step"]
    ];
    for (const [action, label, title] of named) {
      const button = sel(element, action);
      expect(button.querySelector("svg")!.getAttribute("aria-hidden"), action).toBe("true");
      expect(button.textContent!.trim(), action).toBe("");
      expect(button.getAttribute("aria-label"), action).toBe(label);
      expect(button.getAttribute("data-tip"), action).toBe(title);
      expect(button.hasAttribute("title"), action).toBe(false);
    }
    // Open has its own words and a title.
    expect(sel(element, "open").textContent!.trim()).toBe("Open");
    expect(sel(element, "open").getAttribute("title")).toBe("Open this step");
  });

  it("reorders by mouse, one undo each, and turns Move up off on the first step and Move down on the last", async () => {
    const element = await mapped();
    const controller = element.journeyMode!.controller;
    const [first, second, third] = order(element) as [string, string, string];
    // No step selected: no bar.
    controller.select(undefined);
    await until(() => selbar(element).parentElement!.hidden);

    click(item(element, second)!);
    await until(() => !selbar(element).parentElement!.hidden);
    expect(selbar(element).getAttribute("aria-label")).toBe("Selected step: Plain");
    expect(selbar(element).querySelector("[data-map-selname]")!.textContent).toBe("Plain");
    // The map's bar stands alone: the canvas's own selection bar is left off while the map shows
    // (and its keys and actions never find this one), and comes back with the Step view's sheet.
    expect(canvasRoot(element).querySelector<HTMLElement>("[data-selection-zone]")!.hidden).toBe(true);
    expect(surface(element)!.querySelector("[data-selection-bar], [data-selection-action]")).toBeNull();
    viewButton(element, "step").click();
    await until(() => !canvasRoot(element).querySelector<HTMLElement>("[data-selection-zone]")!.hidden);
    await openMap(element);
    await until(() => canvasRoot(element).querySelector<HTMLElement>("[data-selection-zone]")!.hidden);
    expect(sel(element, "up").disabled).toBe(false);
    expect(sel(element, "down").disabled).toBe(false);

    sel(element, "up").click();
    expect(order(element)).toEqual([second, first, third]);
    // Still selected, now first: Move up is off (focus, if it was there, goes to the step's card).
    await until(() => sel(element, "up").disabled);
    expect(controller.selectedComponentId()).toBe(second);
    expect(sel(element, "down").disabled).toBe(false);
    expect(tabStop(element)).toEqual([second]);
    controller.undo();
    expect(order(element)).toEqual([first, second, third]);
    controller.redo();

    sel(element, "down").click();
    sel(element, "down").click();
    expect(order(element)).toEqual([first, third, second]);
    await until(() => sel(element, "down").disabled);
    // Each press was its own undo step.
    controller.undo();
    expect(order(element)).toEqual([first, second, third]);
    controller.undo();
    expect(order(element)).toEqual([second, first, third]);
    controller.undo();
    expect(order(element)).toEqual([first, second, third]);
    // Every control has a name; the icons are hidden from it.
    for (const button of selbar(element).querySelectorAll("button")) {
      expect(button.getAttribute("aria-label") || button.textContent).toBeTruthy();
    }
    expect(["Open", "Move up", "Move down", "Duplicate", "Delete"]).toEqual(
      [...selbar(element).querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent)
    );
    expect(selbar(element).getAttribute("role")).toBe("toolbar");
  });

  it("reorders by keyboard: a step's card, Space, the bar's arrows, one undo each; Enter on a step opens it", async () => {
    const element = await mapped();
    const controller = element.journeyMode!.controller;
    const [first, second, third] = order(element) as [string, string, string];
    controller.select(undefined);
    // Walk to the third step and select it.
    key(item(element, "$start")!, "ArrowDown");
    expect(tabStop(element)).toEqual([first]);
    key(item(element, first)!, "ArrowDown", { altKey: true });
    key(item(element, "$start")!, "Home");
    key(item(element, "$start")!, "ArrowDown");
    // Select the third by walking to it: its card is where Alt+Down from the route leads.
    click(item(element, third)!);
    expect(controller.selectedComponentId()).toBe(third);
    await until(() => !selbar(element).parentElement!.hidden);
    // The bar is one tab stop; the arrows walk its buttons that are on (Move down is off on the last step).
    const stop = (): string[] => [...selbar(element).querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.tabIndex === 0).map((button) => button.dataset.mapSel!);
    expect(stop()).toHaveLength(1);
    key(sel(element, "open"), "ArrowRight");
    expect(stop()).toEqual(["up"]);
    key(sel(element, "up"), "ArrowRight");
    expect(stop()).toEqual(["duplicate"]);
    key(sel(element, "duplicate"), "ArrowLeft");
    expect(stop()).toEqual(["up"]);
    // Enter or Space on a button is its click: Move up.
    sel(element, "up").click();
    expect(order(element)).toEqual([first, third, second]);
    sel(element, "up").click();
    expect(order(element)).toEqual([third, first, second]);
    await until(() => sel(element, "up").disabled);
    // The stop moved off the button that went off.
    expect(sel(element, "up").tabIndex).toBe(-1);
    expect(stop()).toHaveLength(1);
    controller.undo();
    controller.undo();
    expect(order(element)).toEqual([first, second, third]);
    // Escape puts the author back on the step.
    key(sel(element, "down"), "Escape");
    expect(tabStop(element)).toEqual([third]);

    // Enter on a step selects it and opens the Step view on it.
    key(item(element, first)!, "Enter");
    expect(controller.selectedComponentId()).toBe(first);
    expect(element.journeyMode!.view).toBe("step");
    expect(controller.canvasRootId()).toBe(first);
  });

  it("Open and Enter on a step open the Step view on that step, the bar's picker reading it: Step 2 of 3 and its name", async () => {
    const element = mount();
    await openJourneys(element);
    await openMap(element);
    const controller = element.journeyMode!.controller;
    const { pages } = nodes(element);
    const stepper = (): string => canvasRoot(element).querySelector<HTMLElement>("[data-stepper-text]")!.textContent!;
    expect(canvasRoot(element).querySelector<HTMLElement>("[data-canvas-stepper]")!.hidden).toBe(true);

    // The selection bar's Open on the second step.
    click(item(element, pages[1]!.id)!.querySelector(".jm-node__box")!);
    sel(element, "open").focus();
    click(sel(element, "open"));
    expect(element.journeyMode!.view).toBe("step");
    expect(controller.selectedComponentId()).toBe(pages[1]!.id);
    expect(controller.canvasRootId()).toBe(pages[1]!.id);
    await until(() => canvasRoot(element).querySelector<HTMLElement>("[data-canvas-stepper]")!.hidden === false && stepper().startsWith("Step 2 of 3 · "));
    expect(surface(element)).toBeNull();
    // The bar says Step is the view, with the focus on it.
    expect(viewButton(element, "step").getAttribute("aria-pressed")).toBe("true");
    expect(shell(element).activeElement).toBe(viewButton(element, "step"));

    // Next and previous walk the steps; each selects the step it shows.
    canvasRoot(element).querySelector<HTMLElement>('[data-stepper-go="1"]')!.click();
    await until(() => controller.canvasRootId() === pages[2]!.id && stepper().startsWith("Step 3 of 3 · "));
    expect(controller.selectedComponentId()).toBe(pages[2]!.id);
    expect(canvasRoot(element).querySelector<HTMLButtonElement>('[data-stepper-go="1"]')!.disabled).toBe(true);
    canvasRoot(element).querySelector<HTMLElement>('[data-stepper-go="-1"]')!.click();
    canvasRoot(element).querySelector<HTMLElement>('[data-stepper-go="-1"]')!.click();
    await until(() => controller.canvasRootId() === pages[0]!.id && stepper().startsWith("Step 1 of 3 · "));
    expect(canvasRoot(element).querySelector<HTMLButtonElement>('[data-stepper-go="-1"]')!.disabled).toBe(true);

    // Back on the map the picker goes, and Enter on a card opens the third step.
    await openMap(element);
    expect(canvasRoot(element).querySelector<HTMLElement>("[data-canvas-stepper]")!.hidden).toBe(true);
    key(item(element, pages[2]!.id)!, "Enter");
    expect(element.journeyMode!.view).toBe("step");
    expect(controller.canvasRootId()).toBe(pages[2]!.id);
    await until(() => stepper().startsWith("Step 3 of 3 · "));
  }, 30_000);

  const logicRoot = (element: DatumFormBuilderElement): ShadowRoot | undefined => shell(element).querySelector("datum-builder-logic")?.shadowRoot ?? undefined;
  const logicEditor = (element: DatumFormBuilderElement): Element | null | undefined => logicRoot(element)?.querySelector("[data-logic-editor]");
  const offline = (): Promise<never> => Promise.reject(new Error("offline"));

  /** Waits for the Logic surface and its Go to rules to be editable, and for the editor to be open. */
  async function inLogicEditor(element: DatumFormBuilderElement): Promise<void> {
    await until(() => element.builder!.workspace === "logic" && logicEditor(element));
    (shell(element).querySelector("datum-builder-logic") as unknown as { formulaEditorLoader: () => Promise<unknown> }).formulaEditorLoader = offline;
  }

  it("opens a new rule in the Logic editor from the selected step to the next one, written when applied, and is off on the last step and with none selected", async () => {
    const element = await mapped();
    const controller = element.journeyMode!.controller;
    const [first, second, third] = order(element) as [string, string, string];
    controller.select(undefined);
    await until(() => newRule(element).getAttribute("aria-disabled") === "true");
    expect(newRule(element).title).toBe("Select a step that is not the last to add a rule from it");
    newRule(element).click();
    expect(nodes(element).routes).toHaveLength(2);
    expect(element.builder!.workspace).toBe("journeys");

    click(item(element, third)!);
    await until(() => newRule(element).getAttribute("aria-disabled") === "true");
    newRule(element).click();
    expect(nodes(element).routes).toHaveLength(2);
    expect(element.builder!.workspace).toBe("journeys");

    click(item(element, second)!);
    await until(() => newRule(element).getAttribute("aria-disabled") === "false");
    expect(newRule(element).title).toBe("Add a rule from the selected step to the next one");
    newRule(element).click();
    // Nothing is written yet: the Logic editor is open on a new rule from Plain to News, and Apply writes it.
    await inLogicEditor(element);
    expect(nodes(element).pages[1]!.children!.routes ?? []).toEqual([]);
    const root = logicRoot(element)!;
    expect(root.querySelector<HTMLSelectElement>("[data-logic-from]")!.value).toBe("map/plain");
    expect(root.querySelector<HTMLSelectElement>("[data-logic-to]")!.value).toBe("news");
    expect(root.querySelector<HTMLButtonElement>("[data-logic-apply]")!.disabled).toBe(false);
    root.querySelector<HTMLButtonElement>("[data-logic-apply]")!.click();
    const route = nodes(element).pages[1]!.children!.routes![0]!;
    expect(route.type).toBe("journey-route");
    expect((route.configuration as { to?: string }).to).toBe(third);
    // The route is the journey's selection, so the map marks the rule being edited.
    expect(controller.selectedComponentId()).toBe(route.id);
    // Start's routes (two) are still where they were.
    expect(nodes(element).pages[0]!.children!.routes).toHaveLength(2);
    expect(first).toBe(nodes(element).pages[0]!.id);
    // One undo.
    controller.undo();
    expect(nodes(element).pages[1]!.children!.routes ?? []).toEqual([]);
    controller.redo();
    expect(nodes(element).pages[1]!.children!.routes).toHaveLength(1);
  });

  it("opens a rule in the Logic editor from a click on its label, selecting it, and not from a click on a step", async () => {
    const element = await mapped();
    const controller = element.journeyMode!.controller;
    const [routeNode] = nodes(element).routes;
    click(item(element, nodes(element).pages[0]!.id)!);
    expect(element.builder!.workspace).toBe("journeys");
    click(item(element, routeNode!.id)!);
    await inLogicEditor(element);
    const root = logicRoot(element)!;
    expect(root.querySelector("[data-logic-editor]")!.getAttribute("data-logic-kind")).toBe("route");
    expect(root.querySelector("[data-logic-from-fixed]")!.textContent!.trim()).toBe("Start");
    expect(root.querySelector<HTMLSelectElement>("[data-logic-to]")!.value).toBe("news");
    expect([...root.querySelector("[data-logic-reads]")!.children].map((token) => token.textContent).join(" ")).toBe("Go to News when Subscribe is ticked");
    // The journey's selection is the rule's route, so the map marks the label being edited when it is shown again.
    expect(controller.selectedComponentId()).toBe(routeNode!.id);
  });

  it("gives a selected step Step | Logic tabs: its Go to rules in order, Otherwise last, each opening in the Logic editor, and New rule", async () => {
    const element = await mapped();
    const controller = element.journeyMode!.controller;
    const [first, second, third] = order(element) as [string, string, string];
    const inspector = (): ShadowRoot => shell(element).querySelector(".body > datum-builder-properties")!.shadowRoot!;
    const tabs = (): string[] => [...inspector().querySelectorAll<HTMLElement>('[role="tab"][data-inspector-tab]')].map((tab) => tab.textContent!.replace(/\s+/g, " ").trim());
    const rows = (): string[][] =>
      [...inspector().querySelectorAll<HTMLElement>('.inspector-body details.rule[data-rule-section^="way:"]')].map((row) => [
        row.querySelector("summary")!.textContent!.trim(),
        row.querySelector(".rule-reads > span:last-child")?.textContent ?? "",
        row.querySelector("[data-rule-way]")?.textContent ?? ""
      ]);
    // "Reads as" heads each row, as on a form field's Logic tab.
    const showLogic = async (step: string): Promise<void> => {
      // Back from Logic, as the author would go: the Journeys workspace.
      await openJourneys(element);
      controller.select(step);
      await until(() => inspector().querySelector('[data-inspector-tab="rules"]'));
      inspector().querySelector<HTMLElement>('[data-inspector-tab="rules"]')!.click();
      await until(() => inspector().querySelector('[data-rule-section^="way:"]'));
    };

    // Start: two rules, the second always holds, so nothing falls through. The tab counts the rules.
    await showLogic(first);
    expect(tabs()).toEqual(["Step", "Logic 2"]);
    expect(inspector().querySelector(".rules-note")!.textContent).toBe("Tried in order: the first rule that holds is taken. Each opens in the Logic editor.");
    expect(rows()).toEqual([
      ["1 · Go to News", "Go to News when Subscribe is checked / true", "Open in Logic"],
      ["2 · Go to Plain", "Go to Plain always", "Open in Logic"]
    ]);
    // The form's rule rows' own markup: no box, no Off | Formula, nothing to type.
    expect(inspector().querySelector(".inspector-body [data-rule-mode], .inspector-body textarea")).toBeNull();
    inspector().querySelector<HTMLElement>('[data-rule-way="1"]')!.click();
    await inLogicEditor(element);
    expect(logicRoot(element)!.querySelector("[data-logic-editor]")!.getAttribute("data-logic-kind")).toBe("route");
    expect(logicRoot(element)!.querySelector("[data-logic-order]")!.textContent).toContain("Tried 2nd of 2 from this step");
    expect(logicRoot(element)!.querySelector<HTMLSelectElement>("[data-logic-to]")!.value).toBe("plain");

    // Plain: no rule of its own, so Otherwise alone; New rule goes to the next step, written when applied.
    await showLogic(second);
    expect(tabs()).toEqual(["Step", "Logic"]);
    expect(rows()).toEqual([["Otherwise · Go to News", "", ""]]);
    const add = inspector().querySelector<HTMLElement>('[data-rule-way="new"]')!;
    expect(add.textContent).toBe("New rule");
    add.click();
    await inLogicEditor(element);
    expect(logicRoot(element)!.querySelector<HTMLSelectElement>("[data-logic-from]")!.value).toBe("map/plain");
    expect(logicRoot(element)!.querySelector<HTMLSelectElement>("[data-logic-to]")!.value).toBe("news");
    logicRoot(element)!.querySelector<HTMLButtonElement>("[data-logic-apply]")!.click();
    expect(nodes(element).pages[1]!.children!.routes).toHaveLength(1);

    // Now Plain has a rule that always holds; News, the last step, goes to the end and offers no New rule.
    await showLogic(second);
    expect(rows()).toEqual([["1 · Go to News", "Go to News always", "Open in Logic"]]);
    await showLogic(third);
    expect(rows()).toEqual([["Otherwise · Go to the end", "", ""]]);
    expect(inspector().querySelector('[data-rule-way="new"]')).toBeNull();
    // A route has no Logic tab of its own: it is edited in the Logic editor.
    controller.select(nodes(element).routes[0]!.id);
    await until(() => !inspector().querySelector('[data-rule-section^="way:"]'));
    expect(inspector().querySelector('[data-inspector-tab="rules"]')).toBeNull();
  }, 30_000);

  it("opens the rule on Enter on its label too, and a stub opens the rule the step never tries", async () => {
    const element = await mapped({
      journeys: [
        {
          id: "map",
          name: "Map",
          pages: [
            { id: "start", title: "Start", components: ["fullName"], routes: [{ to: "$end" }, { to: "plain" }] },
            { id: "plain", title: "Plain", components: ["country"] }
          ]
        }
      ]
    });
    const [always, shadowed] = nodes(element).routes;
    const stub = surface(element)!.querySelector<SVGElement>(`[data-map-item="${shadowed!.id}"]`)!;
    expect(stub.hasAttribute("data-stub")).toBe(true);
    key(stub, "Enter");
    await inLogicEditor(element);
    // The second rule: tried 2nd of 2.
    expect(logicRoot(element)!.querySelector("[data-logic-order]")!.textContent).toContain("Tried 2nd of 2 from this step");
    expect(always!.id).not.toBe(shadowed!.id);
  });

  it("duplicates a step right after it, as one undo, and deletes through the canvas's confirmation; the only step cannot be deleted", async () => {
    const element = await mapped();
    const controller = element.journeyMode!.controller;
    const [first, second, third] = order(element) as [string, string, string];

    click(item(element, second)!);
    await until(() => !selbar(element).parentElement!.hidden);
    sel(element, "duplicate").click();
    const copy = controller.selectedComponentId()!;
    expect(order(element)).toEqual([first, second, copy, third]);
    controller.undo();
    expect(order(element)).toEqual([first, second, third]);
    controller.redo();
    await until(() => cards(element) === 4);

    // Delete asks first, as the Pages view's bar does; Cancel changes nothing.
    click(item(element, copy)!);
    await until(() => sel(element, "delete").getAttribute("data-tip") === "Delete this step");
    sel(element, "delete").click();
    const dialog = canvasRoot(element).querySelector<HTMLDialogElement>("[data-canvas-prompt] dialog");
    expect(dialog).not.toBeNull();
    dialog!.querySelector<HTMLElement>("[data-confirm-cancel]")!.click();
    expect(order(element)).toEqual([first, second, copy, third]);
    // Confirm: one undo, and the tab stop goes to the step that took its place.
    sel(element, "delete").click();
    canvasRoot(element).querySelector<HTMLElement>("[data-canvas-prompt] [data-confirm-delete]")!.click();
    expect(order(element)).toEqual([first, second, third]);
    await until(() => cards(element) === 3);
    await until(() => tabStop(element).join() === third);
    controller.undo();
    expect(order(element)).toEqual([first, second, copy, third]);
    controller.undo();
    controller.undo();
    expect(order(element)).toEqual([first, second, third]);
  });

  it("deletes with Delete or Backspace on a step, not on the only step, and not on a route", async () => {
    const element = await mapped();
    const controller = element.journeyMode!.controller;
    const { pages, routes } = nodes(element);
    const confirm = (): HTMLElement | null => canvasRoot(element).querySelector<HTMLElement>("[data-canvas-prompt] [data-confirm-delete]");
    // A route's chip is not a step: Delete there does nothing.
    key(item(element, routes[0]!.id)!, "Delete");
    expect(canvasRoot(element).querySelector("[data-canvas-prompt] dialog")).toBeNull();
    expect(key(item(element, routes[0]!.id)!, "Backspace").defaultPrevented).toBe(false);

    const event = key(item(element, pages[1]!.id)!, "Delete");
    expect(event.defaultPrevented).toBe(true);
    expect(controller.selectedComponentId()).toBe(pages[1]!.id);
    await until(() => confirm());
    confirm()!.click();
    expect(order(element)).toEqual([pages[0]!.id, pages[2]!.id]);
    controller.undo();
    await until(() => cards(element) === 3);
    key(item(element, pages[2]!.id)!, "Backspace");
    await until(() => confirm());
    confirm()!.click();
    expect(order(element)).toEqual([pages[0]!.id, pages[1]!.id]);

    // The only step: Delete is off in the bar and does nothing on the key.
    const only: JourneyConfiguration = { journeys: [{ id: "map", name: "Map", pages: [{ id: "solo", title: "Solo", components: ["fullName"], routes: [{ to: "$end" }] }] }] };
    document.body.innerHTML = "";
    const alone = await mapped(only);
    const [solo] = order(alone) as [string];
    click(item(alone, solo)!);
    await until(() => !selbar(alone).parentElement!.hidden);
    expect(sel(alone, "delete").disabled).toBe(true);
    expect(sel(alone, "delete").getAttribute("data-tip")).toBe("A journey keeps at least one step");
    expect(sel(alone, "up").disabled).toBe(true);
    expect(sel(alone, "down").disabled).toBe(true);
    key(item(alone, solo)!, "Delete");
    expect(canvasRoot(alone).querySelector("[data-canvas-prompt] dialog")).toBeNull();
    expect(order(alone)).toEqual([solo]);
    // New rule needs a step after the selected one.
    expect(newRule(alone).getAttribute("aria-disabled")).toBe("true");
    expect(surface(alone)!.querySelector("[data-status], [data-map-status]")!.textContent).toMatch(/^1 step( · \d+ warnings?)?$/);
  });

  it("counts steps, errors and warnings plainly, with the right singular and none at zero", async () => {
    // A question the form no longer has is an error; a step no path reaches, a warning.
    const bad: JourneyConfiguration = {
      journeys: [
        {
          id: "map",
          name: "Map",
          pages: [
            { id: "start", title: "Start", components: ["fullName", "ghost"], routes: [{ to: "$end" }] },
            { id: "lost", title: "Lost", components: ["country"] }
          ]
        }
      ]
    };
    const element = await mapped(bad);
    const status = (): string => surface(element)!.querySelector("[data-map-status]")!.textContent!;
    expect(status()).toMatch(/^2 steps · 1 error( · \d+ warnings?)?$/);
    // Fixed, the error is gone from the count.
    const controller = element.journeyMode!.controller;
    const ghost = nodes(element).pages[0]!.children!.content!.find((node) => (node.configuration as { componentId?: string }).componentId === "ghost")!;
    controller.requestRemoveComponents([ghost.id]);
    await until(() => !/error/.test(status()));
    expect(status()).toMatch(/^2 steps( · \d+ warnings?)?$/);
    // The journey as a whole says it too (the words list keeps its longer line).
    expect(surface(element)!.querySelector("[data-map-announce]")).not.toBeNull();
  });
});
