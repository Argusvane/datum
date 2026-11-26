// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createJourneyMap, journeyMapEdgeId, journeyMapStylesInto, JOURNEY_MAP_STYLES, type JourneyMap, type JourneyMapContext, type JourneyMapSubject } from "../form-engine/builder/journey-map/journey-map.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { mapSource, mapWords } from "./flowmap-words.js";

/**
 * The flow map's surface as more than one instance: two maps on
 * one page keep apart, a read-only map selects nothing, `setState` marks the way taken with
 * classes alone, and the map measures and scrolls in the element it is given. jsdom lays nothing
 * out: sizes and rectangles are stood in where a case needs them.
 */

function eq(path: string, value: string): Expression {
  return { kind: "binary", operator: "eq", left: { kind: "path", path }, right: { kind: "literal", value } };
}

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "age", type: "number", configuration: { label: "Age" } },
      { id: "method", type: "radio", configuration: { label: "Contact method" } },
      { id: "name", type: "text", configuration: { label: "Full name" } },
      { id: "email", type: "text", configuration: { label: "Email" } },
      { id: "extra", type: "text", configuration: { label: "Extra" }, rules: { visibleWhen: eq("method", "post") } }
    ]
  }
};

/** Step 2 has a route; step 3 may show nothing. */
const DEMO: Journey = {
  id: "demo",
  pages: [
    { id: "about", title: "About you", components: ["name"] },
    { id: "contact", title: "Contact", components: ["method"], routes: [{ when: eq("method", "phone"), to: "details" }] },
    { id: "address", title: "Address", components: ["extra"] },
    { id: "updates", title: "Updates", components: ["email"] },
    { id: "details", title: "Details", components: ["age"] }
  ]
};

function subjectOf(journey: Journey, selected: () => string | undefined = () => undefined): { subject: JourneyMapSubject; steps: string[] } {
  const { view } = mapSource(FORM, journey);
  return {
    subject: { journeyId: journey.id, name: () => journey.id, view: () => view, selected },
    steps: view.index.pages.map((page) => page.nodeId)
  };
}

function mapOf(context: Partial<JourneyMapContext> = {}): JourneyMap {
  return createJourneyMap({ layout: { direction: "down" }, words: (name) => mapWords(FORM, name), ...context });
}

/** A map on the page, in a scroller of its own. */
function mounted(context: Partial<JourneyMapContext> = {}): { map: JourneyMap; scroller: HTMLElement } {
  const scroller = document.createElement("div");
  scroller.className = "scroller";
  document.body.append(scroller);
  const map = mapOf({ scroller, ...context });
  scroller.append(map.element);
  return { map, scroller };
}

function step(map: JourneyMap, nodeId: string): Element {
  return map.element.querySelector(`.jm-page[data-map-node="page:${nodeId}"]`)!;
}

function card(map: JourneyMap, nodeId: string): Element {
  return map.element.querySelector(`[data-map-item="${nodeId}"]`)!;
}

function marked(map: JourneyMap): string[] {
  return [...map.element.querySelectorAll(".is-current, .is-taken, [aria-current]")].map(
    (element) => `${element.getAttribute("data-map-node") ?? element.getAttribute("data-edge") ?? element.getAttribute("data-map-item")} ${[...element.classList].filter((name) => /^is-(current|taken|selected)$/.test(name)).join(" ")} ${element.getAttribute("aria-current") ?? ""}`.trim()
  );
}

function click(target: Element, type: "click" | "dblclick" = "click"): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true }));
}

function key(target: Element, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("two maps on one page", () => {
  it("keep apart: a read-only map with the way taken marked, beside a map that selects", () => {
    const selectedA: string[] = [];
    const selectedB: string[] = [];
    let selection: string | undefined;
    const a = mounted({ onSelect: (id) => selectedA.push(id), onOpen: () => undefined });
    const b = mounted({ readOnly: true, onSelect: (id) => selectedB.push(id), onOpen: (id) => selectedB.push(`open:${id}`) });
    const { subject, steps } = subjectOf(DEMO, () => selection);
    a.map.show(subject);
    b.map.show(subject);
    expect([a.map.readOnly, b.map.readOnly]).toEqual([false, true]);

    // B shows the way taken: steps 1, 2 and 3 shown, step 4 current.
    b.map.setState({ currentNodeId: steps[3], takenEdges: ["start", `next:${steps[0]}`, `next:${steps[1]}`, `next:${steps[2]}`] });
    expect(b.map.element.classList.contains("has-path")).toBe(true);
    expect(step(b.map, steps[3]!).classList.contains("is-current")).toBe(true);
    expect(card(b.map, steps[3]!).getAttribute("aria-current")).toBe("step");
    expect([step(b.map, steps[0]!), step(b.map, steps[1]!), step(b.map, steps[2]!)].map((group) => group.classList.contains("is-taken"))).toEqual([true, true, true]);
    expect(b.map.element.querySelector('[data-map-node="$start"]')!.classList.contains("is-taken")).toBe(true);
    // A marks nothing of it.
    expect(marked(a.map)).toEqual([]);
    expect(a.map.element.classList.contains("has-path")).toBe(false);
    expect(a.map.state).toBeUndefined();

    // A click selects on A; on B, nothing is selected and nothing is marked.
    click(card(a.map, steps[1]!).querySelector(".jm-node__box")!);
    click(card(b.map, steps[1]!).querySelector(".jm-node__box")!);
    click(card(b.map, steps[1]!), "dblclick");
    key(card(b.map, steps[1]!), "Enter");
    key(card(b.map, steps[1]!), " ");
    key(card(b.map, steps[1]!), "Enter", { shiftKey: true });
    expect(selectedA).toEqual([steps[1]]);
    expect(selectedB).toEqual([]);
    selection = steps[1];
    a.map.select(subject);
    b.map.select(subject);
    expect(card(a.map, steps[1]!).classList.contains("is-selected")).toBe(true);
    expect(b.map.element.querySelectorAll(".is-selected")).toHaveLength(0);
    // B's current step keeps its own aria-current; A's selection says "true", only on A.
    expect(card(a.map, steps[1]!).getAttribute("aria-current")).toBe("true");
    expect(b.map.element.querySelectorAll('[aria-current="true"]')).toHaveLength(0);

    // The layout, the zoom and the highlight are each map's own.
    a.map.setLayout({ direction: "right" });
    a.map.zoom(2);
    expect([a.map.layout.direction, b.map.layout.direction]).toEqual(["right", "down"]);
    expect([a.map.zoomLevel, b.map.zoomLevel]).toEqual([2, "fit"]);
    expect(b.map.element.querySelector("svg")!.getAttribute("data-direction")).toBe("down");
    card(a.map, steps[0]!).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(a.map.element.classList.contains("is-lighting")).toBe(true);
    expect(b.map.element.classList.contains("is-lighting")).toBe(false);

    // A drawn again (another direction) keeps nothing of B's; B, still marked.
    expect(marked(a.map).filter((entry) => !entry.includes("is-selected"))).toEqual([]);
    expect(step(b.map, steps[3]!).classList.contains("is-current")).toBe(true);

    // One gone, the other goes on.
    a.map.dispose();
    expect(a.map.element.isConnected).toBe(false);
    b.map.setState();
    expect(marked(b.map)).toEqual([]);
    expect(b.map.element.classList.contains("has-path")).toBe(false);
    b.map.setState({ currentNodeId: steps[0] });
    expect(card(b.map, steps[0]!).getAttribute("aria-current")).toBe("step");
    b.map.dispose();
  });
});

describe("setState", () => {
  it("marks with classes alone, never drawing the picture again, and keeps the marks across a redraw", () => {
    const { map } = mounted();
    const { subject, steps } = subjectOf(DEMO);
    map.show(subject);
    const svg = map.element.querySelector("svg")!;
    const markup = svg.outerHTML;
    map.setState({ currentNodeId: steps[1], takenEdges: [journeyMapEdgeId({ kind: "start" }), journeyMapEdgeId({ kind: "next", from: steps[0]! })] });
    // The same picture, its classes added.
    expect(map.element.querySelector("svg")).toBe(svg);
    expect(map.element.querySelectorAll(`[data-edge="next:${steps[0]}"].is-taken`).length).toBeGreaterThan(0);
    expect(map.state).toEqual({ currentNodeId: steps[1], takenEdges: ["start", `next:${steps[0]}`] });
    // The state is a copy: changing what was handed in, or what was handed out, moves nothing.
    const out = map.state!;
    (out.takenEdges as string[]).push("x");
    expect(map.state!.takenEdges).toEqual(["start", `next:${steps[0]}`]);
    // Taken off, the markup is what it was.
    map.setState({});
    expect(map.element.querySelector("svg")!.outerHTML).toBe(markup);
    expect(map.state).toBeUndefined();

    // A redraw (another direction) lays the marks on again.
    map.setState({ currentNodeId: steps[1], takenEdges: ["start", `next:${steps[0]}`] });
    map.setLayout({ direction: "right" });
    expect(map.element.querySelector("svg")).not.toBe(svg);
    expect(step(map, steps[1]!).classList.contains("is-current")).toBe(true);
    expect(card(map, steps[1]!).getAttribute("aria-current")).toBe("step");
    expect(step(map, steps[0]!).classList.contains("is-taken")).toBe(true);

    // Ids the map does not draw mark nothing; nothing at all clears.
    map.setState({ currentNodeId: "no-such-step", takenEdges: ["route:no-such-step:0"] });
    expect(marked(map)).toEqual([]);
    expect(map.element.classList.contains("has-path")).toBe(false);
    map.setState({ currentNodeId: steps[4] });
    map.setState(undefined);
    expect(marked(map)).toEqual([]);
    map.dispose();
  });

  it("marks a step whose question may hide as shown, by its own line; an old pass-by id marks nothing", () => {
    const { map } = mounted();
    const { subject, steps } = subjectOf(DEMO);
    map.show(subject);
    expect(map.element.querySelector('[data-edge^="pass:"]')).toBeNull();
    map.setState({ currentNodeId: steps[3], takenEdges: ["start", `next:${steps[0]}`, `next:${steps[1]}`, `next:${steps[2]}`] });
    expect(map.element.querySelectorAll(`[data-edge="next:${steps[2]}"].is-taken`).length).toBeGreaterThan(0);
    expect(step(map, steps[2]!).classList.contains("is-taken")).toBe(true);
    // A way the map does not draw marks nothing: step 3 is then neither shown nor its line taken.
    map.setState({ currentNodeId: steps[3], takenEdges: ["start", `next:${steps[0]}`, `next:${steps[1]}`, `pass:${steps[2]}`] });
    expect(map.element.querySelectorAll(`[data-edge="next:${steps[2]}"].is-taken`)).toHaveLength(0);
    expect(step(map, steps[2]!).classList.contains("is-taken")).toBe(true);
    map.dispose();
  });

  it("writes nothing when the state set is the state shown, nor when the map is drawn again unchanged", async () => {
    const { map } = mounted();
    const { subject, steps } = subjectOf(DEMO);
    map.show(subject);
    map.setState({ currentNodeId: steps[2], takenEdges: ["start", `next:${steps[0]}`, `next:${steps[1]}`] });
    const writes: MutationRecord[] = [];
    const watcher = new MutationObserver((records) => writes.push(...records));
    watcher.observe(map.element, { subtree: true, attributes: true, childList: true });
    map.setState({ currentNodeId: steps[2], takenEdges: [`next:${steps[1]}`, "start", `next:${steps[0]}`] });
    map.refresh(subject);
    await new Promise((resolve) => setTimeout(resolve, 0));
    writes.push(...watcher.takeRecords());
    watcher.disconnect();
    expect(writes).toEqual([]);
    map.dispose();
  });

  it("brings the current step into view inside the scroller alone, never the page around it", () => {
    const proto = Element.prototype as unknown as { scrollIntoView?: (this: Element) => void };
    const pageScrolls: Element[] = [];
    proto.scrollIntoView = function (this: Element) {
      pageScrolls.push(this);
    };
    try {
      const { map, scroller } = mounted();
      const { subject, steps } = subjectOf(DEMO);
      // Shown with no current step, it brings Start into view within the scroller too.
      map.show(subject);
      expect(pageScrolls).toEqual([]);
      // The scroller shows 0-300 down, 0-400 across; step 5 lies at 900-952 down.
      const rect = (top: number, left: number, height: number, width: number): DOMRect => ({ top, left, bottom: top + height, right: left + width, height, width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
      scroller.getBoundingClientRect = () => rect(0, 0, 300, 400);
      const target = step(map, steps[4]!) as Element;
      target.getBoundingClientRect = () => rect(900, 20, 52, 208);
      map.setState({ currentNodeId: steps[4] });
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(pageScrolls).toEqual([]);
      // The same current step again: no scroll.
      scroller.scrollTop = 0;
      map.setState({ currentNodeId: steps[4], takenEdges: ["start"] });
      expect(scroller.scrollTop).toBe(0);
      map.dispose();
    } finally {
      delete proto.scrollIntoView;
    }
  });

  it("set before the map is drawn, is laid on when it is", () => {
    const map = mapOf();
    const { subject, steps } = subjectOf(DEMO);
    map.setState({ currentNodeId: steps[0], takenEdges: ["start"] });
    document.body.append(map.element);
    map.show(subject);
    expect(step(map, steps[0]!).classList.contains("is-current")).toBe(true);
    expect(map.element.querySelector('[data-edge="start"]')!.classList.contains("is-taken")).toBe(true);
    map.dispose();
  });
});

describe("a read-only map", () => {
  it("opens no step and marks no selection, while the keys still walk it and its direction and zoom still work", () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const { map } = mounted({ readOnly: true, onSelect, onOpen });
    const { subject, steps } = subjectOf(DEMO, () => steps[1]);
    map.show(subject);
    expect(map.element.hasAttribute("data-read-only")).toBe(true);
    expect(map.element.querySelector("[data-map-show]")).toBeNull();
    expect(map.element.querySelectorAll(".is-selected, .is-within, [aria-current]")).toHaveLength(0);
    // The keys walk it: Home, then down to step 1.
    const start = map.element.querySelector('[data-map-item="$start"]')!;
    key(start, "Home");
    expect(key(start, "ArrowDown").defaultPrevented).toBe(true);
    expect(map.element.querySelector('[data-map-item][tabindex="0"]')!.getAttribute("data-map-item")).toBe(steps[0]);
    // Enter selects nothing, and is left to the page.
    expect(key(card(map, steps[0]!), "Enter").defaultPrevented).toBe(false);
    // The bar: direction and zoom.
    map.element.querySelector<HTMLButtonElement>('[data-map-direction="right"]')!.click();
    expect(map.layout.direction).toBe("right");
    key(card(map, steps[0]!), "+");
    expect(map.zoomLevel).not.toBe("fit");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    map.dispose();
  });

  it("needs neither onSelect nor onOpen", () => {
    const map = mapOf({ readOnly: true });
    const { subject, steps } = subjectOf(DEMO);
    document.body.append(map.element);
    map.show(subject);
    click(card(map, steps[0]!));
    expect(map.element.querySelectorAll(".is-selected")).toHaveLength(0);
    map.dispose();
  });
});

describe("the map's room", () => {
  it("is measured in, and watched on, the element it is given rather than the canvas page", () => {
    const watched: Element[] = [];
    const global = globalThis as unknown as { ResizeObserver?: unknown };
    global.ResizeObserver = class {
      public observe(target: Element): void {
        watched.push(target);
      }
      public unobserve(): void {}
      public disconnect(): void {}
    };
    try {
      // A canvas page around it, which the map would find by default.
      const page = document.createElement("div");
      page.className = "canvas-page";
      const card = document.createElement("div");
      page.append(card);
      document.body.append(page);
      const map = mapOf({ scroller: () => card });
      card.append(map.element);
      const { subject } = subjectOf(DEMO);
      map.show(subject);
      expect(watched).toEqual([card]);
      // As wide as the picture: fitted at its own size.
      const [, , width] = map.element.querySelector("svg")!.getAttribute("viewBox")!.split(" ").map(Number);
      Object.defineProperty(card, "clientWidth", { configurable: true, value: width });
      map.zoom("fit");
      expect(Number(map.element.querySelector("svg")!.getAttribute("width"))).toBeCloseTo(width!, 0);
      map.dispose();

      // With no scroller given, the canvas page, as before, and the side drawer's cover over it
      // (which a map in a card of its own never has, so never watches).
      watched.length = 0;
      const plain = mapOf();
      card.append(plain.element);
      plain.show(subject);
      expect(watched).toEqual([page, plain.element.querySelector("[data-map-cover]")]);
      plain.dispose();
    } finally {
      delete global.ResizeObserver;
    }
  });
});

describe("a flow map in a host page", () => {
  /** Element.scrollIntoView stood in (jsdom has none), recording what asked to be brought into view. */
  function watchPageScrolls(): { pageScrolls: string[]; restore(): void } {
    const proto = Element.prototype as unknown as { scrollIntoView?: (this: Element) => void };
    const pageScrolls: string[] = [];
    proto.scrollIntoView = function (this: Element) {
      pageScrolls.push(this.getAttribute("data-map-item") ?? this.getAttribute("data-map-node") ?? this.tagName);
    };
    return { pageScrolls, restore: () => delete proto.scrollIntoView };
  }

  it("keeps no room for the side drawer on a map scrolled anywhere but the canvas page", () => {
    // Given a scroller of its own (Try it's card): the cover pinned to nothing on its element.
    const { map } = mounted({ readOnly: true });
    const { subject } = subjectOf(DEMO);
    map.show(subject);
    expect(map.element.style.getPropertyValue("--jm-cover")).toBe("0px");
    map.dispose();

    // Found, not given: a parent that is not the canvas page, the same.
    const box = document.createElement("div");
    document.body.append(box);
    const loose = mapOf();
    box.append(loose.element);
    loose.show(subject);
    expect(loose.element.style.getPropertyValue("--jm-cover")).toBe("0px");
    loose.dispose();

    // The canvas's map, in the canvas page: nothing written, the drawer's width read as before.
    const page = document.createElement("div");
    page.className = "canvas-page";
    document.body.append(page);
    const canvas = mapOf();
    page.append(canvas.element);
    canvas.show(subject);
    expect(canvas.element.style.getPropertyValue("--jm-cover")).toBe("");
    expect(canvas.element.getAttribute("style") ?? "").not.toContain("--jm-cover");
    canvas.dispose();
  });

  it("never scrolls the page around a read-only map or one given a scroller: shown, zoomed or fitted", () => {
    const { pageScrolls, restore } = watchPageScrolls();
    try {
      // Read-only with no scroller given, and shown with no current step: Start within its parent.
      const box = document.createElement("div");
      document.body.append(box);
      const looking = mapOf({ readOnly: true });
      box.append(looking.element);
      const { subject, steps } = subjectOf(DEMO);
      looking.show(subject);
      // A zoom with an item focused keeps it in view, within the box too.
      key(looking.element.querySelector('[data-map-item="$start"]')!, "Home");
      key(card(looking, steps[1]!), "+");
      key(card(looking, steps[1]!), "0");
      expect(pageScrolls).toEqual([]);
      looking.dispose();

      // Given a scroller, a map that selects keeps to it as well: a selection made elsewhere.
      let selection: string | undefined;
      const { map } = mounted();
      const other = subjectOf(DEMO, () => selection).subject;
      map.show(other);
      selection = steps[2];
      map.select(other);
      expect(pageScrolls).toEqual([]);
      map.dispose();

      // The canvas's map scrolls as it always has, every scroller round it.
      const page = document.createElement("div");
      page.className = "canvas-page";
      document.body.append(page);
      const canvas = mapOf();
      page.append(canvas.element);
      canvas.show(subject);
      expect(pageScrolls).toEqual(["$start"]);
      canvas.dispose();
    } finally {
      restore();
    }
  });

  it("tells a screen reader a read-only map offers nothing to press: images, a label with no Enter, Space kept", () => {
    const { map } = mounted({ readOnly: true });
    const { subject, steps } = subjectOf(DEMO);
    map.show(subject);
    const items = [...map.element.querySelectorAll("[data-map-item]")];
    expect(items.length).toBeGreaterThan(5);
    expect(items.every((item) => item.getAttribute("role") === "img" && (item.getAttribute("aria-label") ?? "") !== "")).toBe(true);
    const label = map.element.querySelector("svg")!.getAttribute("aria-label")!;
    expect(label).toBe("Journey map of “demo”: 5 steps. Tab to a step; arrow keys move between steps and their ways out.");
    // Space neither selects nor scrolls the card; Enter is left to the page.
    expect(key(card(map, steps[0]!), " ").defaultPrevented).toBe(true);
    expect(key(card(map, steps[0]!), "Enter").defaultPrevented).toBe(false);
    map.dispose();

    // The map that selects: buttons, and the label that says Enter selects.
    const editing = mounted();
    editing.map.show(subject);
    expect(card(editing.map, steps[0]!).getAttribute("role")).toBe("button");
    expect(editing.map.element.querySelector("svg")!.getAttribute("aria-label")).toContain("Enter selects");
    editing.map.dispose();
  });

  it("says the way taken in words too: each step shown, each route taken", () => {
    const { map } = mounted({ readOnly: true });
    const { subject, steps } = subjectOf(DEMO);
    map.show(subject);
    const svg = map.element.querySelector("svg")!;
    const route = map.element.querySelector(`[data-edge="route:${steps[1]}:0"][data-map-item]`)!;
    expect(route).not.toBeNull();
    // Steps 1 and 2 shown, step 2's route taken to step 5, the current step; then the walk is
    // replayed another way, through step 3.
    map.setState({ currentNodeId: steps[4], takenEdges: ["start", `next:${steps[0]}`, `route:${steps[1]}:0`] });
    const described = (): string[] =>
      [...map.element.querySelectorAll("[aria-description]")].map((element) => `${element.getAttribute("data-map-item")} ${element.getAttribute("aria-description")}`);
    expect(described()).toEqual([`${steps[0]} Shown`, `${steps[1]} Shown`, `${route.getAttribute("data-map-item")} Taken`]);
    expect(card(map, steps[4]!).getAttribute("aria-current")).toBe("step");
    expect(card(map, steps[4]!).hasAttribute("aria-description")).toBe(false);
    map.setState({ currentNodeId: steps[3], takenEdges: ["start", `next:${steps[0]}`, `next:${steps[1]}`, `next:${steps[2]}`] });
    expect(described()).toEqual([`${steps[0]} Shown`, `${steps[1]} Shown`, `${steps[2]} Shown`]);
    // Kept across a redraw, the picture's markup carrying none of it; cleared with the state.
    map.setLayout({ direction: "right" });
    expect(map.element.querySelector("svg")).not.toBe(svg);
    expect(described()).toEqual([`${steps[0]} Shown`, `${steps[1]} Shown`, `${steps[2]} Shown`]);
    map.setState();
    expect(described()).toEqual([]);
    map.dispose();
  });
});

describe("journeyMapStylesInto", () => {
  it("puts the map's stylesheet into a shadow root or a document's head once", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const first = journeyMapStylesInto(root);
    expect(journeyMapStylesInto(root)).toBe(first);
    expect(root.querySelectorAll("style[data-journey-map-styles]")).toHaveLength(1);
    expect(first.textContent).toBe(JOURNEY_MAP_STYLES);
    const inDocument = journeyMapStylesInto(document);
    expect(inDocument.parentElement).toBe(document.head);
    expect(journeyMapStylesInto(document)).toBe(inDocument);
    expect(document.querySelectorAll("style[data-journey-map-styles]")).toHaveLength(1);
    inDocument.remove();
  });
});
