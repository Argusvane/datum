import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition, JourneyConfiguration } from "@argusvane/datum-engine";

import { modesReady, sampleDefinition, until } from "./helpers.js";

/*
 * Try it with the map: the Journey card holds the journey's real
 * map, read-only and kept across the panel's redraws, marked with the step the person is on and
 * the ways taken; it loads only when Try it opens on a journey, scrolls inside its own window,
 * and the Journeys workspace gives the column 400px. jsdom lays nothing out, so the geometry a
 * case reads is stood in where it needs to be; attributes and classes are asserted, never styles.
 */

/** The flow map's chunk, as the designer imports it: counted, passed through (the first describe below reads the count). */
const loads = vi.hoisted(() => ({ map: 0 }));
vi.mock("../../../engine/form-engine/builder/journey-map/journey-map.js", async (importOriginal) => {
  loads.map += 1;
  return await importOriginal();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** Three steps over the sample form: the name, then whether to subscribe (a route past Country when so), the country, the email. */
function threeSteps(): JourneyConfiguration {
  return {
    journeys: [
      {
        id: "intake",
        name: "Intake",
        pages: [
          { id: "about", title: "About you", components: ["fullName"] },
          { id: "touch", title: "Keeping in touch", components: ["subscribe"], routes: [{ when: { kind: "path", path: "subscribe" }, to: "mail" }] },
          { id: "where", title: "Where", components: ["country"] },
          { id: "mail", title: "Mail", components: ["email"] }
        ]
      }
    ],
    defaultJourneyId: "intake"
  };
}

/** The sample form plus `count` text questions, and one journey asking one per step. */
function longJourney(count: number): FormDefinition {
  const base = sampleDefinition();
  const questions = Array.from({ length: count }, (_, at) => ({ id: `q${at + 1}`, type: "text", configuration: { label: `Question ${at + 1}` } }));
  return {
    ...base,
    root: { ...base.root, children: { ...base.root.children, content: [...(base.root.children!.content ?? []), ...questions] } },
    journey: {
      journeys: [{ id: "long", name: "Long", pages: questions.map((question, at) => ({ id: `s${at + 1}`, title: `Step ${at + 1}`, components: [question.id] })) }],
      defaultJourneyId: "long"
    }
  };
}

function mount(definition: FormDefinition): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("pdf", "off");
  element.definition = definition;
  document.body.append(element);
  return element;
}

async function ready(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  await modesReady(element);
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

/** The Journey card in the Try panel. */
function card(element: DatumFormBuilderElement): HTMLElement | null {
  return canvasRoot(element).querySelector<HTMLElement>("[data-try-panel] .try-card[data-try-journey]");
}

/** The card's kept slot, and the map in it. */
function slot(element: DatumFormBuilderElement): HTMLElement | null {
  return card(element)?.querySelector<HTMLElement>("[data-try-journey-map]") ?? null;
}

function mapOf(element: DatumFormBuilderElement): HTMLElement | null {
  return slot(element)?.querySelector<HTMLElement>("[data-journey-map]") ?? null;
}

/** The card's window: the map's stage, which scrolls below the counts line: the line stays above the steps, never over them. */
function windowOf(element: DatumFormBuilderElement): HTMLElement | null {
  return mapOf(element)?.querySelector<HTMLElement>("[data-map-stage]") ?? null;
}

/** Opens the Journeys workspace on the Step view (never the Map view, which loads the map chunk itself) and Try it. */
async function tryIt(element: DatumFormBuilderElement): Promise<void> {
  await ready(element);
  element.journeyMode!.view = "step";
  element.mode = "journeys";
  await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
  await until(() => sheet(element)?.querySelector("[data-journey-heading]"));
  canvasRoot(element).querySelector<HTMLElement>("[data-try-it]")!.click();
  await until(() => card(element) !== null && mapOf(element) !== null);
}

/** What the map marks: the current step, the steps taken, and the lines taken. */
function marks(element: DatumFormBuilderElement): { current: string[]; taken: string[]; lines: string[] } {
  const map = mapOf(element)!;
  const names = (selector: string): string[] => [...map.querySelectorAll(selector)].map((group) => group.getAttribute("data-map-node")!.replace("page:", ""));
  return {
    current: names(".jm-page.is-current"),
    taken: names(".jm-page.is-taken"),
    lines: [...new Set([...map.querySelectorAll(".jm-edge.is-taken")].map((line) => line.getAttribute("data-edge")!))]
  };
}

function nodes(element: DatumFormBuilderElement): string[] {
  return element.journeyMode!.controller.snapshot().children!.pages!.map((page) => page.id);
}

describe("loading the map and the column's width", () => {
  it("loads the map chunk only when Try it opens on a journey", async () => {
    // The first case of the file: the module registry has not met the map yet.
    expect(loads.map).toBe(0);
    const before = loads.map;
    const element = mount({ ...sampleDefinition(), journey: threeSteps() });
    await ready(element);
    // Try it on the form (the Form workspace): no journey, no card, no map chunk.
    canvasRoot(element).querySelector<HTMLElement>("[data-try-it]")!.click();
    await until(() => canvasRoot(element).querySelector("[data-try-panel] [data-try-mode]"));
    expect(card(element)).toBeNull();
    expect(loads.map).toBe(before);
    expect(canvasRoot(element).querySelector(".panel--canvas")!.hasAttribute("data-try-journeys")).toBe(false);
    canvasRoot(element).querySelector<HTMLElement>("[data-try-it]")!.click();

    // Journeys, opened on a step (the Map view loads the map chunk itself): Try it brings it in.
    await tryIt(element);
    expect(loads.map).toBeGreaterThan(before);
    expect(mapOf(element)).not.toBeNull();
  });

  it("gives the Journeys workspace's Try it column its own width, and the Form workspace's the usual one", async () => {
    const element = mount({ ...sampleDefinition(), journey: threeSteps() });
    await tryIt(element);
    const pane = canvasRoot(element).querySelector(".panel--canvas")!;
    expect(pane.hasAttribute("data-try-shown")).toBe(true);
    expect(pane.hasAttribute("data-try-journeys")).toBe(true);
    // Back to editing: the column goes, and its width with it.
    canvasRoot(element).querySelector<HTMLElement>("[data-try-it]")!.click();
    await until(() => !pane.hasAttribute("data-try-shown"));
    expect(pane.hasAttribute("data-try-journeys")).toBe(false);
  });
});

describe("Try it's Journey card holds the journey's map", () => {
  it("draws the real map, read-only, in a kept slot of the card, marked with the step the person is on", async () => {
    const element = mount({ ...sampleDefinition(), journey: threeSteps() });
    await tryIt(element);
    const map = mapOf(element)!;
    expect(map.hasAttribute("data-read-only")).toBe(true);
    // The map's styles are in the root it sits in, once, and the card's slot is the one place it stands.
    expect(canvasRoot(element).querySelectorAll("style[data-journey-map-styles]")).toHaveLength(1);
    expect(card(element)!.querySelectorAll("[data-journey-map]")).toHaveLength(1);
    // The path line and Restart stay; Show in Pages became Open this step.
    expect(card(element)!.querySelector("[data-try-journey-path]")!.textContent).toBe("1 About you · step 1 of 4");
    expect(card(element)!.querySelector("[data-try-journey-restart]")).not.toBeNull();
    expect(card(element)!.querySelector("[data-try-journey-show]")!.textContent).toBe("Open this step");
    // The first step is the current one, and Start is taken.
    const [about] = nodes(element);
    await until(() => marks(element).current.length === 1);
    expect(marks(element)).toMatchObject({ current: [about], lines: ["start"] });
    expect(map.querySelector(`[data-map-item="${about}"]`)!.getAttribute("aria-current")).toBe("step");
    // The map has its own Step buttons nowhere: a read-only map offers nothing to press.
    expect(map.querySelector("[data-map-add], [data-map-rule], [data-map-selzone]")).toBeNull();
  });

  it("shows the picture and its counts line, with no direction or zoom bar eating the card's window", async () => {
    const element = mount({ ...sampleDefinition(), journey: threeSteps() });
    await tryIt(element);
    const map = mapOf(element)!;
    const bar = map.querySelector<HTMLElement>("[data-map-bar]")!;
    expect(bar.hidden).toBe(true);
    // The counts line stays in the head, and the picture is drawn.
    await until(() => (map.querySelector("[data-map-status]")?.textContent ?? "") !== "");
    expect(map.querySelector("[data-map-status]")!.textContent).toMatch(/^4 steps/);
    expect(map.querySelector("svg.jm-svg")).not.toBeNull();
    // The map's own keys still zoom it: the bar is put away, not the zoom.
    const zoomed = map.querySelector("svg.jm-svg")!.getAttribute("width");
    const item = map.querySelector<HTMLElement>("[data-map-item]")!;
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true, composed: true }));
    await until(() => map.querySelector("svg.jm-svg")!.getAttribute("width") !== zoomed);
  });

  it("follows Continue and Back, and the route an answer takes", async () => {
    const element = mount({ ...sampleDefinition(), journey: threeSteps() });
    await tryIt(element);
    const [about, touch, where, mail] = nodes(element);
    const runtime = element.journeyMode!.previewRuntime!;

    runtime.setValue("fullName", "Ada");
    expect((await runtime.nextPage!()).ok).toBe(true);
    await until(() => marks(element).current[0] === touch);
    expect(marks(element)).toMatchObject({ current: [touch], taken: [about], lines: expect.arrayContaining(["start", `next:${about}`]) });

    // Subscribing routes past Where to Mail: that route's line is taken, Where is not marked.
    runtime.setValue("subscribe", true);
    expect((await runtime.nextPage!()).ok).toBe(true);
    await until(() => marks(element).current[0] === mail);
    expect(marks(element).current).toEqual([mail]);
    expect(marks(element).lines).toEqual(expect.arrayContaining([`route:${touch}:0`]));
    expect([...marks(element).taken].sort()).toEqual([about, touch].sort());
    expect(marks(element).taken).not.toContain(where);

    // Back unmarks what it leaves, and the path line says where the person is.
    expect((await runtime.previousPage!()).ok).toBe(true);
    await until(() => marks(element).current[0] === touch);
    expect(marks(element)).toMatchObject({ current: [touch], taken: [about] });
    expect(marks(element).lines).not.toContain(`route:${touch}:0`);
    expect(card(element)!.querySelector("[data-try-journey-path]")!.textContent).toContain("2 Keeping in touch");
  });

  it("keeps the map node across the panel's redraws, the same node with the same marks, and its scroll", async () => {
    const element = mount({ ...sampleDefinition(), journey: threeSteps() });
    await tryIt(element);
    const before = mapOf(element)!;
    const window = windowOf(element)!;
    const runtime = element.journeyMode!.previewRuntime!;
    runtime.setValue("fullName", "Ada");
    expect((await runtime.nextPage!()).ok).toBe(true);
    const [, touch] = nodes(element);
    await until(() => marks(element).current[0] === touch);
    // The card's words changed (the path line), so the panel drew again: the map and its slot are the same nodes.
    expect(card(element)!.querySelector("[data-try-journey-path]")!.textContent).toContain("2 Keeping in touch");
    expect(mapOf(element)).toBe(before);
    expect(windowOf(element)).toBe(window);
    // A panel drawn for no change of the map's: its window keeps where it was scrolled.
    window.scrollTop = 120;
    (shell(element).querySelector("datum-builder-canvas") as HTMLElement & { tryRefresh(): void }).tryRefresh();
    expect(windowOf(element)).toBe(window);
    expect(window.scrollTop).toBe(120);
    // Restarting is a new runtime: the node stays, the marks start over.
    card(element)!.querySelector<HTMLElement>("[data-try-journey-restart]")!.click();
    await until(() => marks(element).current[0] === nodes(element)[0]);
    expect(mapOf(element)).toBe(before);
    expect(marks(element).lines).toEqual(["start"]);
  });

  it("draws the map again as the journey is edited, and marks the path the edit makes", async () => {
    const element = mount({ ...sampleDefinition(), journey: threeSteps() });
    await tryIt(element);
    const controller = element.journeyMode!.controller;
    const [about] = nodes(element);
    const map = mapOf(element)!;
    controller.setProperty(about!, "title", "Who you are");
    await until(() => map.textContent?.includes("Who you are"));
    expect(mapOf(element)).toBe(map);
    expect(marks(element).current).toEqual([about]);
  });

  it("puts a step the person changes an answer on beside the check step it returns to", async () => {
    const journey: JourneyConfiguration = {
      journeys: [
        {
          id: "intake",
          name: "Intake",
          pages: [
            { id: "about", title: "About you", components: ["fullName"] },
            { id: "touch", title: "Keeping in touch", components: ["subscribe"] },
            { id: "check", title: "Check your answers", kind: "review" }
          ]
        }
      ],
      defaultJourneyId: "intake"
    };
    const element = mount({ ...sampleDefinition(), journey });
    await tryIt(element);
    const [about, , check] = nodes(element);
    const runtime = element.journeyMode!.previewRuntime!;
    runtime.setValue("fullName", "Ada");
    expect((await runtime.nextPage!()).ok).toBe(true);
    expect((await runtime.nextPage!()).ok).toBe(true);
    await until(() => marks(element).current[0] === check);
    expect(card(element)!.querySelector("[data-try-journey-returning]")).toBeNull();

    expect((await runtime.goToPage!(about!, { direction: "change" })).ok).toBe(true);
    await until(() => card(element)!.querySelector("[data-try-journey-returning]"));
    expect(card(element)!.querySelector("[data-try-journey-returning]")!.textContent).toBe("1 About you · changing an answer. Continue returns to 3 Check your answers.");
    expect(marks(element).current).toEqual([about]);
    // Open this step still opens the step the person is on.
    card(element)!.querySelector<HTMLElement>("[data-try-journey-show]")!.click();
    await until(() => element.journeyMode!.view === "step" && element.journeyMode!.controller.selectedComponentId() === about);
  });
});

describe("the map stays in its window", () => {
  /** Stands geometry in: the window is 360px tall, each step 80px below the one before, and a scrolled window moves them up. */
  function stubGeometry(element: DatumFormBuilderElement): { pageScrolls: Element[] } {
    const pageScrolls: Element[] = [];
    (Element.prototype as unknown as { scrollIntoView: (this: Element) => void }).scrollIntoView = function (this: Element) {
      pageScrolls.push(this);
    };
    const rect = (top: number, height: number): DOMRect => ({ top, bottom: top + height, left: 0, right: 300, height, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const window = windowOf(element)!;
    window.getBoundingClientRect = () => rect(0, 360);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this === window) {
        return rect(0, 360);
      }
      const node = this.getAttribute("data-map-node");
      if (node?.startsWith("page:")) {
        const at = [...window.querySelectorAll(".jm-page")].indexOf(this);
        return rect(60 + at * 80 - window.scrollTop, 52);
      }
      return rect(0, 0);
    });
    return { pageScrolls };
  }

  it("keeps the current step in view in a journey of twelve steps, scrolling the window alone", async () => {
    const element = mount(longJourney(12));
    await tryIt(element);
    const { pageScrolls } = stubGeometry(element);
    const runtime = element.journeyMode!.previewRuntime!;
    const all = nodes(element);
    expect(all).toHaveLength(12);
    const window = windowOf(element)!;

    for (let at = 1; at < 11; at += 1) {
      runtime.setValue(`q${at}`, "x");
      expect((await runtime.nextPage!()).ok).toBe(true);
    }
    await until(() => marks(element).current[0] === all[10]);
    // Step 11 lies at 60 + 10 * 80 = 860, below the 360px window: the window scrolled to bring it in.
    expect(window.scrollTop).toBeGreaterThan(0);
    const step = [...window.querySelectorAll(".jm-page")].find((group) => group.getAttribute("data-map-node") === `page:${all[10]}`)!;
    const top = step.getBoundingClientRect().top;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + 52).toBeLessThanOrEqual(360);
    // The page and the panel around the window were never scrolled.
    expect(pageScrolls).toEqual([]);
    // The counts line heads the window, outside it: the steps scroll below it, never under it.
    const head = mapOf(element)!.querySelector<HTMLElement>("[data-map-head]")!;
    expect(head.querySelector("[data-map-status]")!.textContent).toMatch(/^12 steps/);
    expect(window.contains(head)).toBe(false);
    expect(head.nextElementSibling).toBe(window);
    const css = [...canvasRoot(element).querySelectorAll("style")].map((style) => style.textContent).join("\n");
    expect(css).toMatch(/\.try-journey-map \.jm-head \{ position: static;/);
    expect(css).toMatch(/\.try-journey-map \.jm-stage \{[^}]*overflow: auto;/);
    // Back to the first step brings it back.
    for (let at = 0; at < 10; at += 1) {
      expect((await runtime.previousPage!()).ok).toBe(true);
    }
    await until(() => marks(element).current[0] === all[0]);
    // The first step lies at 60 in the window's own terms: scrolled back until it is in view, clear of the top edge.
    const first = [...window.querySelectorAll(".jm-page")].find((group) => group.getAttribute("data-map-node") === `page:${all[0]}`)!;
    expect(first.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(window.scrollTop).toBeLessThan(60);
    expect(pageScrolls).toEqual([]);
  });
});

describe("a second map on the page", () => {
  it("is independent: two builders' Try it maps mark their own steps", async () => {
    const a = mount({ ...sampleDefinition(), journey: threeSteps() });
    const b = mount({ ...sampleDefinition(), journey: threeSteps() });
    await tryIt(a);
    await tryIt(b);
    const [aboutA, touchA] = nodes(a);
    const [aboutB] = nodes(b);
    const mapA = mapOf(a)!;
    const mapB = mapOf(b)!;
    expect(mapA).not.toBe(mapB);

    const runtime = a.journeyMode!.previewRuntime!;
    runtime.setValue("fullName", "Ada");
    expect((await runtime.nextPage!()).ok).toBe(true);
    await until(() => marks(a).current[0] === touchA);
    expect(marks(a)).toMatchObject({ current: [touchA], taken: [aboutA] });
    // The other map still marks its own first step, and nothing is taken there.
    expect(marks(b)).toEqual({ current: [aboutB], taken: [], lines: ["start"] });

    // A disposed Try it takes its map away; the other goes on.
    canvasRoot(a).querySelector<HTMLElement>("[data-try-it]")!.click();
    await until(() => mapOf(a) === null);
    expect(mapOf(b)).toBe(mapB);
    expect(marks(b).current).toEqual([aboutB]);
  });
});
