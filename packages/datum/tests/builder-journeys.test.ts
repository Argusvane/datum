import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type {
  DatumFormBuilderChangeDetail,
  DatumFormBuilderElement,
  DatumJourneyChangeDetail,
  DatumJourneySelectDetail
} from "../src/builder.js";
import { sourceHash, type FormDefinition, type Journey, type JourneyConfiguration } from "@argusvane/datum-engine";

import { presentationForm } from "@argusvane/datum-engine/tests/fixtures/presentation-form";
import { modesReady, sampleDefinition, until, pdfAlone } from "./helpers.js";
import { control, journeySubmit } from "./live-dom.js";

/*
 * The Journeys side of <datum-form-builder>: on by default, one document per
 * journey, its designer a chunk the mode loads when the side is first opened.
 */

/** The designer's chunk, as the engine's mode imports it — mocked by the first case alone. */
const DESIGNER_MODULE = "../../../engine/form-engine/builder/journey-designer/journey-designer.js";
/** The preview's chunk, as the designer imports it — mocked by the second case alone. */
const PREVIEW_MODULE = "../../../engine/form-engine/builder/journey-designer/journey-preview.js";

afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * Two journeys over the sample form, with keys no builder knows on the block and on a journey:
 * `intake` (the default) asks some of the questions and leaves the rest on no page, `quick`
 * asks them all on one page. Built from JSON, as a file would be read.
 */
function journeyBlock(): JourneyConfiguration {
  return JSON.parse(
    JSON.stringify({
      journeys: [
        {
          id: "intake",
          name: "Intake",
          pages: [
            { id: "about", title: "About you", components: ["fullName"] },
            { id: "contact", title: "Keeping in touch", components: ["subscribe"], routes: [{ when: { kind: "path", path: "subscribe" }, to: "$end" }] }
          ],
          "x-journey-note": "kept"
        },
        { id: "quick", name: "Quick", pages: [{ id: "all", components: ["fullName", "country", "subscribe", "email"] }] }
      ],
      defaultJourneyId: "intake",
      opensAs: "form",
      "x-block-note": { kept: true }
    })
  ) as JourneyConfiguration;
}

function withJourneys(journey: JourneyConfiguration = journeyBlock()): FormDefinition {
  return { ...sampleDefinition(), journey };
}

function mount(setup?: (element: DatumFormBuilderElement) => void): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  setup?.(element);
  document.body.append(element);
  return element;
}

/** Waits for the inner builder to have mounted its panels, and the modes that are on to have registered (chunks). */
async function ready(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  await modesReady(element);
}

function shell(element: DatumFormBuilderElement): ShadowRoot {
  return element.builder!.shadowRoot!;
}

/** The journeys as the side lists them (to the Journeys overview, the palette, the bar's label): `[id, name]`. */
function entries(element: DatumFormBuilderElement): Array<[string, string]> {
  return (element.journeyMode?.documents?.list() ?? []).map((document) => [document.id, document.label]);
}

/** One journey as the side lists it: its name, whether it is the default, and its badge (a journey shows none). */
function entry(element: DatumFormBuilderElement, journeyId: string): { label: string; isDefault?: boolean | undefined; badge?: string | undefined } {
  return element.journeyMode!.documents!.list().find((document) => document.id === journeyId)!;
}

/** The bar's label for the document on the page: its name, its kind (none for a side with no document yet), its badges. */
function barLabel(element: DatumFormBuilderElement): { name: string; kind: string | undefined; badges: string[] } {
  const label = shell(element).querySelector<HTMLElement>("[data-document-face]")!;
  return {
    name: label.querySelector("[data-document-picker-name]")!.textContent!,
    kind: label.querySelector("[data-document-kind]")?.textContent ?? undefined,
    badges: [...label.querySelectorAll(".document-face-badge")].map((badge) => badge.textContent!)
  };
}

/** Puts a journey on the page as the Journeys overview's Open does: through the unsaved-edits guard. */
function open(element: DatumFormBuilderElement, journeyId: string): void {
  element.builder!.selectDocument("journeys", journeyId);
}

/** The sheet the canvas draws a journey on: its faces are the designer's. */
function sheet(element: DatumFormBuilderElement): ShadowRoot | undefined {
  const canvas = shell(element).querySelector("datum-builder-canvas") as (HTMLElement & { previewRoot(): ShadowRoot | undefined }) | null;
  return canvas?.previewRoot();
}

/** Opens the Journeys side and waits for the journey on the page to be built: it opens on its map. */
async function openJourneys(element: DatumFormBuilderElement): Promise<void> {
  element.mode = "journeys";
  await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
}

/** The journey on the page drawn as the person sees a step: the Step view, on the step the journey was last at (the first). */
async function showStep(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.journeyMode?.ready);
  element.journeyMode!.view = "step";
  await until(() => sheet(element)?.querySelector("[data-journey-heading]"));
}

function properties(element: DatumFormBuilderElement): ShadowRoot {
  return shell(element).querySelector("datum-builder-properties")!.shadowRoot!;
}

/** The strip's Form panel, opened the way an author opens it (a hidden panel does not paint). */
function formPanel(element: DatumFormBuilderElement): ShadowRoot {
  const panel = shell(element).querySelector("datum-builder-form-panel") as HTMLElement;
  if (panel.hidden) {
    shell(element).querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
  }
  return panel.shadowRoot!;
}

/** Opens the menu of the document on the page (its label on the bar) and picks an action. */
function menuAction(element: DatumFormBuilderElement, action: string): void {
  shell(element).querySelector<HTMLElement>("[data-document-menu]")!.click();
  shell(element).querySelector<HTMLElement>(`[data-document-menu-popover] [data-document-action="${action}"]`)!.click();
}

function journeyChanges(element: DatumFormBuilderElement): DatumJourneyChangeDetail[] {
  const changes: DatumJourneyChangeDetail[] = [];
  element.addEventListener("datum-journey-change", (event) => changes.push((event as CustomEvent<DatumJourneyChangeDetail>).detail));
  return changes;
}

function builderChanges(element: DatumFormBuilderElement): DatumFormBuilderChangeDetail[] {
  const changes: DatumFormBuilderChangeDetail[] = [];
  element.addEventListener("datum-builder-change", (event) => changes.push((event as CustomEvent<DatumFormBuilderChangeDetail>).detail));
  return changes;
}

/** The element focus is on, through every shadow root on the way. */
function deepActive(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

function journeyOf(definition: FormDefinition, id: string): Journey | undefined {
  return definition.journey?.journeys?.find((journey) => journey.id === id);
}

/** What each page lists: component ids, and — for a page holding nodes of its own — those nodes. */
function pageComponents(journey: Journey | undefined): Array<NonNullable<Journey["pages"][number]["components"]>> {
  return (journey?.pages ?? []).map((page) => [...(page.components ?? [])]);
}

/**
 * A journey whose pages hold nodes of their own — an alias that fills `fullName`, a
 * page-only field, and an own layout of references, one of them naming nothing — beside a
 * journey of component ids alone. Built from JSON, as a file would be read.
 */
function ownNodesBlock(): JourneyConfiguration {
  return JSON.parse(
    JSON.stringify({
      journeys: [
        {
          id: "guarded",
          name: "Guarded",
          pages: [
            {
              id: "who",
              title: "Who",
              components: [
                { id: "legal_name", type: "text", configuration: { label: "Legal name", fills: "fullName", required: true } },
                { id: "nick", type: "text", configuration: { label: "Nickname" }, rules: { visibleWhen: { kind: "path", path: "subscribe" } } }
              ]
            },
            {
              id: "news",
              title: "News",
              components: [
                {
                  id: "box",
                  type: "fieldset",
                  configuration: { label: "News" },
                  children: {
                    content: [
                      { type: "journey-field", configuration: { componentId: "subscribe" } },
                      { type: "journey-field", configuration: { componentId: "email" } },
                      { type: "journey-field", configuration: { componentId: "ghost" } }
                    ]
                  }
                },
                "country"
              ]
            }
          ],
          "x-journey-note": "kept"
        },
        { id: "plain", name: "Plain", pages: [{ id: "one", title: "One", components: ["fullName", "country"] }, { id: "two", components: ["subscribe", "email"] }] }
      ],
      defaultJourneyId: "guarded",
      opensAs: "form",
      "x-block-note": { kept: true }
    })
  ) as JourneyConfiguration;
}

/**
 * A journey that branches over the sample form: Start asks the name and whether to subscribe,
 * and subscribing skips Plain for News.
 */
function branching(): JourneyConfiguration {
  return {
    journeys: [
      {
        id: "branch",
        name: "Branch",
        pages: [
          { id: "start", title: "Start", components: ["fullName", "subscribe"], routes: [{ when: { kind: "path", path: "subscribe" }, to: "news" }] },
          { id: "plain", title: "Plain", components: ["country"] },
          { id: "news", title: "News", components: ["email"] }
        ]
      }
    ]
  };
}

function canvasRoot(element: DatumFormBuilderElement): ShadowRoot {
  return shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
}

/** The Try journey card in the Try panel. */
function tryJourneyCard(element: DatumFormBuilderElement): HTMLElement | null {
  return canvasRoot(element).querySelector<HTMLElement>("[data-try-panel] .try-card[data-try-journey]");
}

/** The form the Try session runs, inside its renderer. */
function tryForm(element: DatumFormBuilderElement): HTMLElement | null {
  return canvasRoot(element).querySelector<HTMLElement>("datum-form-renderer");
}

/** The form renderer's shadow root, where the form is drawn. */
function tryFormRoot(element: DatumFormBuilderElement): ShadowRoot | undefined {
  return tryForm(element)?.shadowRoot ?? undefined;
}

function tryText(element: DatumFormBuilderElement, part: "path" | "note"): string {
  return tryJourneyCard(element)?.querySelector(`[data-try-journey-${part}]`)?.textContent ?? "";
}

function tryHeading(element: DatumFormBuilderElement): string {
  return tryFormRoot(element)?.querySelector("[data-journey-heading]")?.textContent ?? "";
}

function viewButton(element: DatumFormBuilderElement, view: "map" | "step"): HTMLElement {
  return shell(element).querySelector<HTMLElement>(`[data-mode-actions] [data-journey-views] [data-journey-view="${view}"]`)!;
}

/** Clicks Try it in the canvas and waits for the Journey card to appear. */
async function openTry(element: DatumFormBuilderElement): Promise<HTMLElement> {
  // The map's canvas has no Try it: a journey is tried from a step.
  if (element.builder?.mode === "journeys" && element.journeyMode?.view === "map") {
    await showStep(element);
  }
  canvasRoot(element).querySelector<HTMLElement>("[data-try-it]")!.click();
  await until(() => tryJourneyCard(element) !== null && tryHeading(element) !== "");
  return tryForm(element)!;
}

/**
 * The sample form with a note carrying an author's link ahead of its questions, and one
 * journey, `intake`, asking the note and the name on its first page and subscribing on its second.
 */
function withLinkNote(): FormDefinition {
  const definition = sampleDefinition();
  definition.root.children!.content!.unshift({
    id: "note",
    type: "html",
    configuration: { content: '<p>Read <a href="https://example.org/privacy">our notice</a>.</p>' }
  });
  return {
    ...definition,
    journey: {
      journeys: [
        {
          id: "intake",
          name: "Intake",
          pages: [
            { id: "about", title: "About you", components: ["note", "fullName"] },
            { id: "contact", title: "Keeping in touch", components: ["subscribe"] }
          ]
        }
      ]
    }
  };
}

describe("<datum-form-builder> journeys", () => {
  // First in the file on purpose: the designer has not loaded yet, so the mock is what the
  // mode's first load meets. The load is retried after a failure, so the cases below load it.
  it("lists the journeys before the designer loads, reports a designer that cannot load, and loads it on the next try", async () => {
    vi.doMock(DESIGNER_MODULE, () => {
      throw new Error("chunk missing");
    });
    const errors: string[] = [];
    let element: DatumFormBuilderElement;
    try {
      element = mount((el) => {
        el.setAttribute("pdf", "off");
        el.definition = withJourneys();
      });
      element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
      await ready(element);
      // The side named by its mode's label, the form on the page under its title.
      expect(element.modes).toEqual([
        { id: "form", label: "Form" },
        { id: "journeys", label: "Journeys" }
      ]);
      expect(barLabel(element)).toEqual({ name: "Sample", kind: "Form", badges: [] });
      // Listing needs no designer: each journey under its name alone. The seed stores
      // `opensAs: "form"`, so none is marked "Default": the mark follows what the form opens as.
      expect(entries(element)).toEqual([
        ["intake", "Intake"],
        ["quick", "Quick"]
      ]);
      expect(entry(element, "intake").isDefault).toBe(false);
      expect(entry(element, "quick").isDefault).toBe(false);

      element.mode = "journeys";
      await until(() => errors.length >= 2);
      expect(errors).toEqual(["The Journeys designer could not load", 'The "journeys" mode could not be opened']);
      // The page stays on the form, and nothing was edited.
      expect(element.builder!.mode).toBe("form");
      expect(element.definition.journey).toEqual(journeyBlock());
    } finally {
      vi.doUnmock(DESIGNER_MODULE);
    }

    // The failure was not remembered: the next try loads the designer and draws the journey.
    await openJourneys(element);
    expect(element.journeyMode!.journeyId).toBe("intake");
    expect(element.journeyMode!.journey?.pages).toHaveLength(2);
    expect(errors).toHaveLength(2);
  });

  // Second on purpose: the Try it chunk has not loaded yet, so the mock is what the designer's
  // first load of it meets. The load is retried after a failure, so the cases below load it.
  it("loads the Try it chunk on the first Try it; a failed load is reported and leaves the form visible, and loads on the next try", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    const errors: string[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    await ready(element);
    // Mocked before the Journeys side opens: once a journey is on the page the mode loads the
    // chunk ahead when the page is idle (a quiet failure there is left to the Try it that meets
    // it), and in a full-file run the designer is already in, so that load could beat the mock.
    vi.doMock(PREVIEW_MODULE, () => {
      throw new Error("chunk missing");
    });
    try {
      await openJourneys(element);
      // Nothing of the Try it surface is on the page yet: not its card.
      expect(tryJourneyCard(element)).toBeNull();
      canvasRoot(element).querySelector<HTMLElement>("[data-try-it]")!.click();
      // The form runs over the canvas's own preview while the chunk is coming; the load fails and
      // is said once, and Try it ends with the form still on the page, the Journey card never drawn.
      await until(() => errors.includes("The journey preview could not be loaded"), 3000);
      expect(errors.filter((message) => message === "The journey preview could not be loaded")).toHaveLength(1);
      await until(() => canvasRoot(element).querySelector("[data-try-it]")?.textContent === "Try it", 3000);
      expect(tryJourneyCard(element)).toBeNull();
      expect(tryForm(element)).not.toBeNull();
    } finally {
      // Only now, with the failure seen: vitest queues a mock and an unmock together and applies
      // them in whatever order their paths resolve, so an unmock queued before the import that
      // meets the mock could lose to it and leave every later Try it in this file failing.
      vi.doUnmock(PREVIEW_MODULE);
    }

    // Not remembered broken: the next Try it loads it and runs the journey.
    await openTry(element);
    expect(element.journeyMode!.previewRuntime).toBeDefined();
    expect(tryJourneyCard(element)).not.toBeNull();
    expect(tryHeading(element)).not.toBe("");
  });

  it("reads the definition back as it was given, byte for byte, while journeys are only opened; unknown keys stay through an edit", async () => {
    // As an embed has it by default: the PDF side on too, beside the journeys — over a layout
    // of the form's own, since for a form declaring none the PDF side writes one it derives.
    const seed: FormDefinition = {
      ...withJourneys(),
      pdf: {
        layouts: [
          {
            id: "letter",
            kind: "generated",
            root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "name-field", type: "pdf-field", configuration: { componentId: "fullName" } }] } }
          }
        ],
        defaultLayoutId: "letter"
      }
    };
    const given = JSON.stringify(seed);
    const element = mount((el) => {
      el.setAttribute("mode", "journeys");
      el.definition = seed;
    });
    const journeys = journeyChanges(element);
    const changes = builderChanges(element);
    await ready(element);
    // `mode="journeys"` opens on the side, on the default journey.
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    expect(element.journeyMode!.journeyId).toBe("intake");
    expect(element.definition.journey).toBe(seed.journey);
    expect(JSON.stringify(element.definition)).toBe(given);

    // Every journey opened: its designer built over it, nothing reported, nothing rewritten.
    const selected: Array<[string, string]> = [];
    element.addEventListener("datum-journey-select", (event) => {
      const detail = (event as CustomEvent<DatumJourneySelectDetail>).detail;
      selected.push([detail.journeyId, detail.journey.id]);
    });
    open(element, "quick");
    await until(() => element.journeyMode!.journeyId === "quick" && element.journeyMode!.ready);
    expect(selected).toEqual([["quick", "quick"]]);
    open(element, "intake");
    await until(() => element.journeyMode!.journeyId === "intake" && element.journeyMode!.ready);
    element.mode = "form";
    await until(() => element.builder!.mode === "form");
    expect(JSON.stringify(element.definition)).toBe(given);
    expect(element.journeyConfiguration).toBe(seed.journey);
    expect(journeys).toEqual([]);
    expect(changes.filter((change) => change.mode === "journeys")).toEqual([]);

    // An edit rewrites the journey it touches and keeps every key it does not know.
    element.journeyMode!.renameJourney("quick", "Quick path");
    const block = element.definition.journey as unknown as Record<string, unknown>;
    expect(block["x-block-note"]).toEqual({ kept: true });
    expect((journeyOf(element.definition, "intake") as unknown as Record<string, unknown>)["x-journey-note"]).toBe("kept");
    expect(journeyOf(element.definition, "quick")?.name).toBe("Quick path");
    expect(JSON.stringify(journeyOf(element.definition, "intake"))).toBe(JSON.stringify(journeyBlock().journeys![0]));
    expect(Object.keys(block)).toEqual(["journeys", "defaultJourneyId", "opensAs", "x-block-note"]);
  });

  it("makes the form's first journey from the form with New journey, the popover over the Journeys overview; the form opens as that journey", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    const journeys = journeyChanges(element);
    const changes = builderChanges(element);
    await ready(element);
    await until(() => element.modes.length === 3);
    // A form with no journeys still offers the side, under its label, with nothing listed.
    expect(element.modes.at(-1)).toEqual({ id: "journeys", label: "Journeys" });
    expect(entries(element)).toEqual([]);
    expect(element.definition.journey).toBeUndefined();

    const popover = (): HTMLElement => shell(element).querySelector<HTMLElement>("[data-journey-add-popover]")!;
    // New journey, as the palette starts it, from the form's page: the Journeys overview comes
    // up and the popover opens over it, the form still the page's mode.
    expect(element.builder!.newDocument("journeys", "journey")).toBe(true);
    await until(() => popover() && !popover().hidden);
    expect(element.builder!.mode).toBe("form");
    expect(element.builder!.workspace).toBe("journeys");
    // The dialog says what it makes, and offers the one start: an empty step, none of the form's shapes.
    expect(popover().getAttribute("aria-label")).toBe("New journey");
    expect(popover().querySelector('[data-journey-add="blank"]')).not.toBeNull();
    expect(popover().querySelector('[data-journey-add="questions-one-page"]')).toBeNull();
    expect(popover().querySelector('[data-journey-add="sections"]')).toBeNull();
    // What is at stake is said before a journey exists.
    expect(popover().querySelector("[data-journey-add-stakes]")!.textContent).toContain("accepted by the server as a way to submit");
    // No designer's empty page meanwhile: the overview stands where the canvas is.
    const canvasRoot = shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
    expect(canvasRoot.querySelector("[data-journey-empty]")).toBeNull();
    expect(shell(element).querySelector<HTMLElement>("[data-overview-host]")!.hidden).toBe(false);

    const name = popover().querySelector<HTMLInputElement>("[data-journey-add-name]")!;
    name.value = "Short path";
    popover().querySelector<HTMLElement>('[data-journey-add="blank"]')!.click();
    await until(() => element.journeyMode!.journeys.length === 1 && element.journeyMode!.ready);

    const made = element.journeyMode!.journeys[0]!;
    expect(made.id).toBe("short-path");
    expect(made.name).toBe("Short path");
    // One empty questions step, no field from the form: what the journey leaves out is its findings.
    expect(made.pages).toEqual([{ id: "step-1", title: "Step 1", components: [] }]);
    // The first journey sets what the form opens as (not "form").
    expect(element.definition.journey).toEqual({ journeys: [made], opensAs: "journey" });
    expect(journeys.map((change) => [change.reason, change.journey?.id])).toEqual([["journeys", "short-path"]]);
    expect(journeys[0]!.definition.journey).toEqual(element.definition.journey);
    expect(changes.at(-1)).toMatchObject({ mode: "journeys", reason: "journeys" });
    expect(entries(element)).toEqual([["short-path", "Short path"]]);
    // On the page, named on the label.
    expect(element.journeyMode!.documents!.selectedId()).toBe("short-path");
    await until(() => barLabel(element).name === "Short path");
    // The only one, so the default the side falls back to.
    expect(barLabel(element)).toEqual({ name: "Short path", kind: "Journey", badges: ["Default"] });
    // The empty state has given the sheet back to the journey, which opens on its map even with one step.
    await until(() => element.journeyMode!.view === "map" && canvasRoot.querySelector("[data-canvas-surface] [data-journey-map]"));
    expect(element.journeyMode!.view).toBe("map");
    expect(shell(element).querySelector<HTMLElement>('[data-journey-views] [data-journey-view="map"]')!.hidden).toBe(false);
    expect(canvasRoot.querySelector("[data-canvas-surface] [data-journey-empty]")).toBeNull();
  });

  it("puts focus from the New journey popover on the map it opens, and never on the Step view's sheet once the author has switched view: the ring with no keyboard", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    await until(() => element.journeyMode !== undefined);
    const popover = (): HTMLElement => shell(element).querySelector<HTMLElement>("[data-journey-add-popover]")!;
    expect(element.builder!.newDocument("journeys", "journey")).toBe(true);
    await until(() => popover() && !popover().hidden);
    popover().querySelector<HTMLElement>('[data-journey-add="blank"]')!.click();
    await until(() => element.journeyMode!.journeys.length === 1 && element.journeyMode!.ready);
    const canvasRoot = shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
    await until(() => element.journeyMode!.view === "map" && canvasRoot.querySelector("[data-canvas-surface] [data-journey-map]"));
    // The switch to Step comes while the popover's focus is still being followed: the map's item
    // goes with the map, and focus is left where the author's switch left it.
    element.journeyMode!.view = "step";
    await until(() => !canvasRoot.querySelector("[data-canvas-surface] [data-journey-map]") && canvasRoot.querySelector(".canvas-page"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(canvasRoot.activeElement?.classList.contains("canvas-page") ?? false).toBe(false);
  });

  it('keeps the PDF side ahead of the journeys when pdf="off" is set and lifted again', async () => {
    const element = mount((el) => {
      el.definition = withJourneys();
    });
    await ready(element);
    await until(() => element.modes.length === 3);
    element.setAttribute("pdf", "off");
    await until(() => element.modes.length === 2);
    element.removeAttribute("pdf");
    await until(() => element.modes.length === 3);

    // The shell lists its sides in the order they were added: the PDF side comes back in its
    // place, not after the journeys it was added behind.
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "pdf", "journeys"]);
    // Both sides can add again.
    expect(element.pdfMode?.documents?.add).toBeTypeOf("function");
    expect(element.journeyMode?.documents?.add).toBeTypeOf("function");
  });

  it("renames, copies, makes the default and deletes journeys from the document label's menu, down to none, and the page comes back to the form", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys({
        journeys: [
          { id: "intake", name: "Intake", pages: [{ id: "about", components: ["fullName"] }] },
          { id: "quick", name: "Quick", pages: [{ id: "all", components: ["fullName", "country"] }] }
        ],
        defaultJourneyId: "intake"
      });
    });
    const journeys = journeyChanges(element);
    await ready(element);
    await openJourneys(element);

    // Rename: the name only; the id, and the default pointing at it, stay.
    menuAction(element, "rename");
    const box = shell(element).querySelector<HTMLInputElement>("[data-document-rename]")!;
    expect(box.getAttribute("aria-label")).toBe("Journey name");
    box.value = "Intake form";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    await until(() => journeyOf(element.definition, "intake")?.name === "Intake form");
    expect(element.definition.journey?.defaultJourneyId).toBe("intake");
    expect(entries(element)).toEqual([
      ["intake", "Intake form"],
      ["quick", "Quick"]
    ]);
    await until(() => barLabel(element).name === "Intake form");
    expect(barLabel(element)).toEqual({ name: "Intake form", kind: "Journey", badges: ["Default"] });

    // Duplicate: the copy is put on the page.
    menuAction(element, "duplicate");
    await until(() => element.journeyMode!.journeyId === "intake-copy" && element.journeyMode!.ready);
    expect(journeyOf(element.definition, "intake-copy")?.name).toBe("Intake form (copy)");
    expect(pageComponents(journeyOf(element.definition, "intake-copy"))).toEqual([["fullName"]]);

    // Set as default: the pill moves onto the label, and the menu offers it no more for the default itself.
    menuAction(element, "default");
    await until(() => element.definition.journey?.defaultJourneyId === "intake-copy");
    expect(entry(element, "intake-copy").isDefault).toBe(true);
    expect(entry(element, "intake").isDefault).toBe(false);
    await until(() => barLabel(element).badges.includes("Default"));
    expect(barLabel(element).name).toBe("Intake form (copy)");
    shell(element).querySelector<HTMLElement>("[data-document-menu]")!.click();
    expect(shell(element).querySelector<HTMLButtonElement>('[data-document-action="default"]')!.disabled).toBe(true);
    shell(element).querySelector<HTMLElement>("[data-document-menu]")!.click();

    // Delete asks in place (the warning note), and says what goes in the mode's words.
    const remove = (): void => {
      menuAction(element, "remove");
      const note = shell(element).querySelector<HTMLElement>("[data-document-menu-popover] [data-remove-note]")!;
      expect(note.textContent).toContain("The journey goes, with its translations.");
      note.querySelector<HTMLElement>('[data-document-action="remove"][data-confirm]')!.click();
    };
    remove();
    await until(() => !journeyOf(element.definition, "intake-copy"));
    // The default went with it, and the page moved to a journey still there.
    expect(element.definition.journey?.defaultJourneyId).toBeUndefined();
    await until(() => element.journeyMode!.ready);
    remove();
    await until(() => element.journeyMode!.journeys.length === 1);
    await until(() => element.journeyMode!.ready);
    remove();

    // Down to none: the block says nothing and goes, and the page comes back to the form.
    await until(() => element.builder!.mode === "form");
    expect(element.mode).toBe("form");
    expect(element.definition.journey).toBeUndefined();
    expect(entries(element)).toEqual([]);
    expect(barLabel(element)).toEqual({ name: "Sample", kind: "Form", badges: [] });
    expect(journeys.every((change) => change.reason === "journeys")).toBe(true);
    expect(journeys.at(-1)!.configuration).toBeUndefined();
  });

  it("offers Opens as on the Form panel while the form has a journey, drafted with the form's settings and written on Save", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    const journeys = journeyChanges(element);
    await ready(element);
    const row = (): HTMLSelectElement | null => formPanel(element).querySelector<HTMLSelectElement>('[data-root-setting="journeys.opensAs"]');
    await until(() => row());
    expect(row()!.value).toBe("form");
    // The whole form, then each journey by name, one page or many.
    expect([...row()!.options].map((option) => [option.value, option.textContent])).toEqual([
      ["form", "The whole form"],
      ["intake", "Intake"],
      ["quick", "Quick"]
    ]);

    // Choosing the default journey drafts the choice until Save, like the rest of the form's settings.
    row()!.value = "intake";
    row()!.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    expect(element.definition.journey?.opensAs).toBe("form");
    expect(journeys).toEqual([]);
    formPanel(element).querySelector<HTMLElement>("[data-inspector-save]")!.click();
    // The seed never wrote "journey", so choosing the journey drops the key rather than writing it.
    await until(() => journeys.length === 1);
    expect(element.definition.journey && "opensAs" in element.definition.journey).toBe(false);
    expect(journeys[0]).toMatchObject({ reason: "journeys" });
    expect(element.journeyMode!.opensAs).toBe("journey");
    expect(row()!.value).toBe("intake");

    // Choosing the one-page journey makes it the default at once (the side's list follows), the choice itself still drafted.
    row()!.value = "quick";
    row()!.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await until(() => element.definition.journey?.defaultJourneyId === "quick");
    expect(entry(element, "quick")).toEqual({ id: "quick", label: "Quick", isDefault: true });
    expect(entry(element, "intake").isDefault).toBe(false);
    expect(journeys.at(-1)).toMatchObject({ reason: "journeys", journey: { id: "quick" } });
    formPanel(element).querySelector<HTMLElement>("[data-inspector-save]")!.click();
    await until(() => row()!.value === "quick" && !formPanel(element).querySelector("[data-inspector-save]:not([disabled])"));
    expect(element.journeyMode!.opensAs).toBe("journey");

    // With no journey left there is nothing to open as: the row goes.
    element.journeyConfiguration = undefined;
    await until(() => row() === null);
    expect(element.definition.journey).toBeUndefined();
  });

  it("keeps focus on Opens as, and the Form panel where it was scrolled, when a choice repaints the panel at once", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    const row = (): HTMLSelectElement | null => formPanel(element).querySelector<HTMLSelectElement>('[data-root-setting="journeys.opensAs"]');
    await until(() => row());
    const body = (): HTMLElement => formPanel(element).querySelector<HTMLElement>(".inspector-body")!;
    body().scrollTop = 480;
    const before = row()!;
    before.focus();
    // Choosing a journey makes it the default through the catalog, which draws the panel again.
    before.value = "quick";
    before.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await until(() => element.definition.journey?.defaultJourneyId === "quick");
    expect(row()).not.toBe(before);
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    expect(active).toBe(row());
    expect(row()!.value).toBe("quick");
    expect(body().scrollTop).toBe(480);
  });

  it("focuses the new journey's first page once it is made from the New journey popover", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = sampleDefinition();
    });
    await ready(element);
    await until(() => element.journeyMode !== undefined);
    // With none yet, New starts from the Journeys overview.
    element.builder!.setWorkspace("journeys");
    expect(element.builder!.newDocument("journeys", "journey")).toBe(true);
    const popover = (): HTMLElement => shell(element).querySelector<HTMLElement>("[data-journey-add-popover]")!;
    await until(() => popover() && !popover().hidden);
    // Focus starts in the Name box, which goes down with the popover.
    expect(deepActive()).toBe(popover().querySelector("[data-journey-add-name]"));
    popover().querySelector<HTMLElement>('[data-journey-add="blank"]')!.click();
    await until(() => element.journeyMode!.journeys.length === 1 && element.journeyMode!.ready);
    // A new journey opens on its map, even with one step: focus goes to the map's one tab stop.
    await until(() => element.journeyMode!.view === "map" && canvasRoot(element).querySelector("[data-journey-map] [data-map-item]"));
    const stop = (): HTMLElement | null => canvasRoot(element).querySelector<HTMLElement>('[data-journey-map] [data-map-item][tabindex="0"]');
    await until(() => stop() !== null && deepActive() === stop());
  });

  it("names a deleted node by its label alone, once the delete is confirmed it is gone", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    await openJourneys(element);
    const controller = element.journeyMode!.controller;
    const [first, second] = controller.snapshot().children!.pages!;
    controller.select(second!.id);
    await until(() => properties(element).querySelector("[data-inspector-delete]"));
    properties(element).querySelector<HTMLElement>("[data-inspector-delete]")!.click();
    const dialog = (): HTMLElement | null => properties(element).querySelector("[data-delete-prompt]");
    await until(() => dialog());
    // The step's own label, never the designer's id for it.
    expect(dialog()!.textContent).toContain("will be removed");
    expect(dialog()!.textContent).not.toContain(second!.id);
    dialog()!.querySelector<HTMLElement>("[data-confirm-delete]")!.click();
    await until(() => !controller.snapshot().children!.pages!.some((node) => node.id === second!.id));
    expect(controller.snapshot().children!.pages!.map((node) => node.id)).toEqual([first!.id]);
  });

  it("click-adds from the palette onto the selected page", async () => {
    {
      const element = mount((el) => {
        el.setAttribute("pdf", "off");
        el.definition = withJourneys();
      });
      await ready(element);
      await openJourneys(element);
      const controller = element.journeyMode!.controller;
      const [first, second] = controller.snapshot().children!.pages!.map((node) => node.id);
      controller.select(first);
      const palette = shell(element).querySelector("datum-builder-toolbar")!.shadowRoot!;
      await until(() => palette.querySelector('[data-add-type="journey-field"]'));
      palette.querySelector<HTMLElement>('[data-add-type="journey-field"]')!.click();
      const added = controller.selectedComponentId()!;
      const pages = controller.snapshot().children!.pages!;
      expect(pages.find((node) => node.id === first)!.children!.content!.map((node) => node.id)).toContain(added);
      expect(pages.find((node) => node.id === second)!.children!.content!.map((node) => node.id)).not.toContain(added);
    }
  });

  it("has no Add unassigned or Remove missing on the bar: the fields on no step are the Form fields panel's, one undo each", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    await openJourneys(element);
    expect(shell(element).querySelector("[data-journey-add-unassigned]")).toBeNull();
    expect(shell(element).querySelector("[data-journey-remove-missing]")).toBeNull();
    const before = pageComponents(journeyOf(element.definition, "intake"));
    expect(before).toEqual([["fullName"], ["subscribe"]]);
    // Country and Email are on no page; the Send button carries no answer.
    // The mode's own placing of them all is one undo step, as it was from the bar.
    expect(await element.journeyMode!.addUnassigned()).toBe(true);
    await until(() => pageComponents(journeyOf(element.definition, "intake")).flat().length === 4);
    element.undo();
    await until(() => JSON.stringify(pageComponents(journeyOf(element.definition, "intake"))) === JSON.stringify(before));
  });

  it("edits a route's condition in the Logic workspace, not on a Rules tab: the route's own when, never its rules, read back when the form is opened again", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    const journeys = journeyChanges(element);
    await ready(element);
    await openJourneys(element);
    const controller = element.journeyMode!.controller;
    // A page has no condition of its own, and the route's is edited in Logic (the Logic workspace): neither has a Rules tab.
    const routeId = (): string => controller.snapshot().children!.pages![1]!.children!.routes![0]!.id;
    controller.select(routeId());
    const rulesTab = (host: DatumFormBuilderElement): HTMLElement | null => properties(host).querySelector<HTMLElement>('[data-inspector-tab="rules"]');
    await until(() => properties(element).querySelector("[data-inspector-tab]"));
    expect(rulesTab(element)).toBeNull();
    const pageId = journeyOf(element.definition, "intake")!.pages[1]!.id;
    const ruleId = `journeys:intake:${pageId}:route:0`;
    const logicOf = (host: DatumFormBuilderElement): ShadowRoot | undefined => shell(host).querySelector("datum-builder-logic")?.shadowRoot ?? undefined;
    const openInLogic = async (host: DatumFormBuilderElement): Promise<void> => {
      host.builder!.setWorkspace("logic");
      await until(() => logicOf(host)?.querySelector(`[data-logic-rule="${ruleId}"]:not(.rule--readonly)`));
      // The plain box: the one jsdom can type into.
      (shell(host).querySelector("datum-builder-logic") as unknown as { formulaEditorLoader: () => Promise<unknown> }).formulaEditorLoader = () => Promise.reject(new Error("offline"));
      logicOf(host)!.querySelector<HTMLElement>(`[data-logic-rule="${ruleId}"]`)!.click();
    };
    await openInLogic(element);
    const box = logicOf(element)!.querySelector<HTMLTextAreaElement>(".formula-textarea")!;
    box.value = "not(subscribe)";
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    logicOf(element)!.querySelector<HTMLElement>("[data-logic-apply]")!.click();

    await until(() => journeyOf(element.definition, "intake")?.pages[1]?.routes?.[0]?.when === "not(subscribe)");
    // Stored as the formula string the author typed.
    expect(journeyOf(element.definition, "intake")!.pages[1]!.routes![0]!.when).toBe("not(subscribe)");
    // Configuration, not rules: nothing the canvas would hide the route's row for.
    expect(controller.snapshot().children!.pages![1]!.children!.routes![0]!.rules).toBeUndefined();
    expect(journeys.at(-1)!.journey?.id).toBe("intake");
    expect(journeys.at(-1)!.reason).not.toBe("journeys");

    // The definition as saved opens with the condition in the route's editor in Logic again.
    const saved = JSON.parse(JSON.stringify(element.definition)) as FormDefinition;
    document.body.innerHTML = "";
    const reopened = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = saved;
    });
    await ready(reopened);
    await openInLogic(reopened);
    expect(logicOf(reopened)!.querySelector<HTMLTextAreaElement>(".formula-textarea")!.value).toBe("not(subscribe)");
    expect(JSON.stringify(reopened.definition.journey)).toBe(JSON.stringify(saved.journey));
  });

  it("follows a form component's new id into every journey, and says so on both changes", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    const changes = builderChanges(element);
    await ready(element);
    await until(() => element.journeyMode);
    element.controller!.renameId("subscribe", "wantsNews");

    await until(() => changes.some((change) => change.mode === "journeys"));
    // The form's change says what moved, and whose rules followed (email reads subscribe); the
    // journeys follow in a change of their own.
    const form = changes.find((change) => change.mode === "form" && change.renamed);
    // The rename also carries the data path it moved (`dataPath`, a data key being a path of its own): not what this checks.
    expect(form?.renamed).toMatchObject({ from: "subscribe", to: "wantsNews", rules: ["email"] });
    expect(JSON.stringify(element.definition)).toContain('"visibleWhen":{"kind":"path","path":"wantsNews"}');
    expect(JSON.stringify(element.definition)).not.toContain('"path":"subscribe"');
    expect(changes.at(-1)).toMatchObject({ mode: "journeys", reason: "form-rename" });
    const intake = journeyOf(element.definition, "intake")!;
    expect(pageComponents(intake)).toEqual([["fullName"], ["wantsNews"]]);
    expect(intake.pages[1]!.routes![0]!.when).toEqual({ kind: "path", path: "wantsNews" });
    expect(pageComponents(journeyOf(element.definition, "quick"))).toEqual([["fullName", "country", "wantsNews", "email"]]);
  });

  it("does not forward a page rename to the builder: the mode tells the shell itself, and datum-journey-change keeps its reason", async () => {
    const tests = { scenarios: [{ id: "test-1", source: 'test "contact page"\n  given journey = intake\n  expect page = contact' }] };
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = { ...withJourneys(), tests };
    });
    const journeys = journeyChanges(element);
    await ready(element);
    await openJourneys(element);
    // The element forwards nothing (the shell hears the mode itself), so the rewrite lands once.
    const rewrite = vi.spyOn(element.builder!.controller, "setTests");
    const controller = element.journeyMode!.controller;
    controller.setProperty(controller.snapshot().children!.pages![1]!.id, "pageId", "touch");

    await until(() => journeys.some((change) => change.reason === "page-rename"));
    expect(journeys.find((change) => change.reason === "page-rename")).toMatchObject({ renamed: { journeyId: "intake", from: "contact", to: "touch" } });
    // The tests followed the page with no host code.
    await until(() => element.definition.tests?.scenarios[0]?.source.includes("expect page = touch"));
    expect(element.definition.tests!.scenarios[0]!.source).not.toContain("= contact");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it('leaves the journeys out for journeys="off", keeping what was edited, and brings them back', async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    await openJourneys(element);
    element.journeyMode!.renameJourney("intake", "Intake, edited");

    element.setAttribute("journeys", "off");
    await until(() => element.modes.length === 1);
    expect(element.builder!.mode).toBe("form");
    expect(element.journeyMode).toBeUndefined();
    expect(element.journeys).toBe("off");
    // The form alone on the bar, and nothing to add a journey to.
    expect(barLabel(element)).toEqual({ name: "Sample", kind: "Form", badges: [] });
    expect(element.builder!.newDocument("journeys")).toBe(false);
    // The edit is folded into the definition, which carries the journeys through as they are.
    expect(journeyOf(element.definition, "intake")?.name).toBe("Intake, edited");
    expect((element.definition.journey as unknown as Record<string, unknown>)["x-block-note"]).toEqual({ kept: true });
    // A new definition passes through untouched while the side is off.
    const other: JourneyConfiguration = { journeys: [{ id: "solo", pages: [{ id: "one", components: ["fullName"] }] }] };
    element.journeyConfiguration = other;
    expect(element.definition.journey).toBe(other);

    element.removeAttribute("journeys");
    await until(() => element.modes.length === 2);
    expect(element.journeyMode!.journeys.map((journey) => journey.id)).toEqual(["solo"]);
    expect(element.definition.journey).toBe(other);
  });

  it("gives the PDF layouts alone (workspaces=\"pdf\") no journeys, whatever the journeys attribute says, and passes the definition's through", async () => {
    const seed = withJourneys();
    const designer = pdfAlone();
    designer.setAttribute("journeys", "auto");
    designer.definition = seed;
    document.body.append(designer);
    await until(() => designer.builder?.shadowRoot?.querySelector("datum-builder-canvas") && designer.modes.length === 2);
    expect(designer.modes.map((mode) => mode.id)).toEqual(["form", "pdf"]);
    expect(designer.journeyMode).toBeUndefined();
    expect(designer.definition.journey).toBe(seed.journey);
    expect(designer.builder!.newDocument("journeys")).toBe(false);
  });

  it("runs the journey in the Try panel on the canvas, following a route as the answers are given; Submit stays inside", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys(branching());
    });
    await ready(element);
    await openJourneys(element);
    await openTry(element);
    // Tried from a step: the Step view is the one pressed on the bar.
    expect(viewButton(element, "step").getAttribute("aria-pressed")).toBe("true");
    expect(element.journeyMode!.previewRuntime).toBeDefined();
    expect(tryJourneyCard(element)).not.toBeNull();
    expect(tryHeading(element)).toContain("Start");
    // News asks only what subscribing shows; until then it is on the path all the same, after Plain.
    expect(tryText(element, "path")).toBe("1 Start · step 1 of 3");

    const runtime = element.journeyMode!.previewRuntime!;
    // The pages go by their nodes in the runtime.
    const [start, plain, news] = element.journeyMode!.controller.snapshot().children!.pages!.map((page) => page.id);
    expect(runtime.journeyView()!.path).toEqual([start, plain, news]);
    runtime.setValue("fullName", "Ada");
    runtime.setValue("subscribe", true);
    expect(runtime.journeyView()!.path).toEqual([start, news]);
    expect((await runtime.nextPage!()).ok).toBe(true);
    await until(() => tryHeading(element).includes("News"));
    expect(tryText(element, "path")).toBe("1 Start › 3 News · step 2 of 2");

    // The journey's Submit reaches neither the element nor the page: the try session answers it.
    const heard: string[] = [];
    const listen = (event: Event): void => {
      heard.push(event.type);
    };
    document.addEventListener("datum-form-action", listen);
    try {
      journeySubmit(tryFormRoot(element)!)!.click();
      await until(() => tryJourneyCard(element)?.textContent?.includes("would submit"));
      expect(heard).toEqual([]);
    } finally {
      document.removeEventListener("datum-form-action", listen);
    }

    // Restart: a new runtime, no answers, the first page.
    tryJourneyCard(element)!.querySelector<HTMLElement>("[data-try-journey-restart]")!.click();
    await until(() => element.journeyMode!.previewRuntime !== runtime && tryText(element, "path") === "1 Start · step 1 of 3");
    expect(element.journeyMode!.previewRuntime!.state().values.fullName).toBeUndefined();

    // Back to editing: the step's sheet is back.
    canvasRoot(element).querySelector<HTMLElement>("[data-try-it]")!.click();
    await until(() => !canvasRoot(element).querySelector("[data-shell='wrap']")?.getAttribute("data-trying"));
    expect(element.journeyMode!.previewRuntime).toBeUndefined();
    await until(() => sheet(element)?.querySelector("[data-journey-heading]"));
  });

  it("takes a Submit held back by an answer on an earlier step to that page", async () => {
    // The journey defers its checks to the end, so Continue leaves the required name unanswered.
    const deferred = branching();
    deferred.journeys![0] = { ...deferred.journeys![0]!, validation: { continue: "defer" } };
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys(deferred);
    });
    await ready(element);
    await openJourneys(element);
    await openTry(element);
    const runtime = element.journeyMode!.previewRuntime!;
    const [start, plain, news] = element.journeyMode!.controller.snapshot().children!.pages!.map((page) => page.id);
    expect((await runtime.nextPage!()).ok).toBe(true);
    await until(() => tryHeading(element).includes("Plain"));
    expect(runtime.journeyView()!.pageId).toBe(plain);
    // News is the last step, shown with nothing on it while subscribing is off.
    expect((await runtime.nextPage!()).ok).toBe(true);
    await until(() => tryHeading(element).includes("News"));
    expect(runtime.journeyView()!.pageId).toBe(news);

    journeySubmit(tryFormRoot(element)!)!.click();
    await until(() => tryJourneyCard(element)?.textContent?.includes("needs attention"));
    expect(runtime.journeyView()!.pageId).toBe(start);
    await until(() => tryHeading(element).includes("Start"));
  });

  it("follows an edit to the journey live, and keeps Cmd+Z typed in the form and a language switch to itself", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys(branching());
    });
    await ready(element);
    await openJourneys(element);
    await openTry(element);
    const controller = element.journeyMode!.controller;
    const start = controller.snapshot().children!.pages![0]!.id;
    const title = (): unknown => (controller.snapshot().children!.pages![0]!.configuration as Record<string, unknown>).title;

    // An edit on the journey shows in the try session as it lands.
    controller.setProperty(start, "title", "Begin");
    await until(() => tryHeading(element).includes("Begin"));

    // Cmd+Z in a box of the form is the box's own: the journey keeps its edit.
    const box = control(tryFormRoot(element)!, "fullName");
    const undoKey = (target: EventTarget): void => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, composed: true, cancelable: true }));
    };
    undoKey(box);
    expect(title()).toBe("Begin");
    // Anywhere else on the canvas, the Try panel included, it is the journey's undo, as ever.
    undoKey(tryJourneyCard(element)!.querySelector("[data-try-journey-restart]")!);
    expect(title()).toBe("Start");
    await until(() => tryHeading(element).includes("Start"));

    // A language switch in the tried form is the try session's, not the builder's.
    const heard: string[] = [];
    const listen = (event: Event): void => {
      heard.push(event.type);
    };
    element.addEventListener("datum-locale-applied", listen);
    try {
      tryForm(element)!
        .dispatchEvent(new CustomEvent("datum-locale-applied", { detail: { locale: "fr-CA" }, bubbles: true, composed: true }));
      expect(heard).toEqual([]);
      expect(element.builder!.controller.currentLocale()).toBe("en");
    } finally {
      element.removeEventListener("datum-locale-applied", listen);
    }
  });

  it("keeps the page the try session is on while its page id is typed and saved, and Open this step opens it", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys(branching());
    });
    await ready(element);
    await openJourneys(element);
    await openTry(element);
    const runtime = element.journeyMode!.previewRuntime!;
    runtime.setValue("fullName", "Ada");
    expect((await runtime.nextPage!()).ok).toBe(true);
    await until(() => tryHeading(element).includes("Plain"));
    const controller = element.journeyMode!.controller;
    const plain = controller.snapshot().children!.pages![1]!.id;
    expect(runtime.journeyView()!.pageId).toBe(plain);

    // The step's id typed in the inspector, a keystroke at a time, then saved.
    controller.select(plain);
    await until(() => properties(element).querySelector('[data-prop="pageId"]'));
    for (const typed of ["p", "plain-", "plain-2"]) {
      const box = properties(element).querySelector<HTMLInputElement>('[data-prop="pageId"]')!;
      box.value = typed;
      box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      expect(runtime.journeyView()!.pageId).toBe(plain);
    }
    properties(element).querySelector<HTMLElement>("[data-inspector-save]")!.click();
    await until(() => journeyOf(element.definition, "branch")?.pages[1]?.id === "plain-2");
    // The same runtime, the same page, the answers as they were.
    expect(element.journeyMode!.previewRuntime).toBe(runtime);
    expect(runtime.journeyView()!.pageId).toBe(plain);
    expect(runtime.state().values.fullName).toBe("Ada");
    expect(tryHeading(element)).toContain("Plain");
    expect(tryText(element, "path")).toBe("1 Start › 2 Plain · step 2 of 3");

    // Open this step: the Step view on the step the try session was on, selected, and Try it ends.
    controller.select(undefined);
    tryJourneyCard(element)!.querySelector<HTMLElement>("[data-try-journey-show]")!.click();
    await until(() => element.journeyMode!.view === "step" && controller.selectedComponentId() === plain);
    await until(() => sheet(element)?.querySelector("[data-journey-heading]"));
    // Try it ended: the button is back to "Try it" and the trying state is gone.
    expect(canvasRoot(element).querySelector<HTMLElement>("[data-try-it]")!.textContent).toBe("Try it");
    expect(canvasRoot(element).querySelector("[data-shell='wrap']")?.getAttribute("data-trying")).toBeUndefined();
    // Focus goes to the Step button.
    expect(shell(element).activeElement).toBe(viewButton(element, "step"));
  });

  it("switches between the form, a PDF layout and a journey without the canvas drawing one tree with another's renderers", async () => {
    const warn = vi.spyOn(console, "warn");
    try {
      const element = mount((el) => {
        el.definition = withJourneys();
      });
      await ready(element);
      await until(() => element.modes.length === 3 && element.pdfMode);
      // A layout to draw: the form declares none, and none is derived for it.
      element.pdfMode!.newLayout({ name: "Letter", from: "form", select: true });
      const formCard = (): Element | null | undefined => sheet(element)?.querySelector('[data-component-id="fullName"]');
      await until(() => formCard());
      // Each way round: the canvas takes the new tree, its renderers and its theme together.
      for (const mode of ["journeys", "form", "pdf", "journeys", "pdf", "form"] as const) {
        element.mode = mode;
        await until(() => element.builder!.mode === mode);
        if (mode === "journeys") {
          await showStep(element);
        } else if (mode === "form") {
          await until(() => formCard());
        } else {
          await until(() => sheet(element)?.querySelector(".datum-pdf-field") && !sheet(element)!.querySelector("[data-journey-heading]"));
        }
      }
      const unknown = warn.mock.calls.map((call) => String(call[0])).filter((message) => message.includes("Unknown component type"));
      expect(unknown).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  /** Where a row's text lives, as the Languages workspace keys it: kind, owner and the property path, never an index. */
  const where = (text: { address: { kind: string; owner?: string; path: readonly string[] } }): string =>
    [text.address.kind, ...(text.address.owner === undefined ? [] : [text.address.owner]), ...text.address.path].join("/");

  it("lists every journey's texts after the form's, addressed by journey and page id", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    await until(() => element.journeyMode !== undefined);
    // Before the Journeys side is ever opened: listing needs no designer.
    const texts = element.builder!.translatableTexts();
    const keys = texts.map(where);
    expect(keys).toEqual(
      expect.arrayContaining(["components/fullName/label", "journeys/intake/name", "journeys/intake/texts/back", "journeys/intake/pages/about/title", "journeys/quick/pages/all/title"])
    );
    expect(keys.indexOf("components/fullName/label")).toBeLessThan(keys.indexOf("journeys/intake/name"));
    const about = texts.find((text) => where(text) === "journeys/intake/pages/about/title");
    expect(about).toMatchObject({ componentId: "journey.intake.about", componentLabel: "Intake · Step 1 · About you", default: "About you" });
    expect(texts.filter((text) => text.componentId === "journey.intake").map((text) => text.label)).toEqual([
      "Journey name",
      "Back button",
      "Continue button",
      "Submit button (the last step)",
      "Step count caption",
      "While the server checks",
      "When the server cannot be reached"
    ]);

    // With the Journeys side off, the form's texts alone.
    element.setAttribute("journeys", "off");
    await until(() => element.journeyMode === undefined);
    expect(element.builder!.translatableTexts().some((text) => text.address.kind === "journeys")).toBe(false);
  });

  it("words the journey rows in the builder's catalog the shell hands the mode", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    await until(() => element.journeyMode !== undefined);
    const aboutTitle = (): { componentLabel: string } | undefined =>
      element.builder!.translatableTexts().find((text) => where(text) === "journeys/intake/pages/about/title");
    expect(aboutTitle()?.componentLabel).toBe("Intake · Step 1 · About you");
    element.builder!.textCatalog = { en: { "journey.designer.grid.page": "{name} / page {number} / {title}" } };
    expect(aboutTitle()?.componentLabel).toBe("Intake / page 1 / About you");
  });

  it("folds a page's Wording, shows the id a blank page id takes, and says the journey's findings under the boxes they are about", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys({
        journeys: [
          {
            id: "loop",
            name: "Loop",
            pages: [
              { id: "one", title: "One", components: ["fullName"] },
              { id: "two", title: "Two", components: ["subscribe", "ghost"], routes: [{ to: "one" }] }
            ]
          }
        ]
      });
    });
    await ready(element);
    await openJourneys(element);
    const controller = element.journeyMode!.controller;
    const two = controller.snapshot().children!.pages![1]!;
    controller.select(two.id);
    await until(() => properties(element).querySelector('[data-prop="pageId"]'));
    const section = (id: string): HTMLDetailsElement => properties(element).querySelector<HTMLDetailsElement>(`[data-inspector-section="${id}"]`)!;
    expect(section("page").open).toBe(true);
    expect(section("wording").open).toBe(false);
    expect(properties(element).querySelector<HTMLInputElement>('[data-prop="pageId"]')!.placeholder).toBe(two.id);
    // Opened once, it stays open from page to page, as a section the author closed stays closed.
    section("wording").open = true;
    await until(() => section("wording").open);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.select(controller.snapshot().children!.pages![0]!.id);
    await until(() => properties(element).querySelector<HTMLInputElement>('[data-prop="pageId"]')?.value === "one");
    expect(section("wording").open).toBe(true);
    section("wording").open = false;
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.select(two.id);
    await until(() => properties(element).querySelector<HTMLInputElement>('[data-prop="pageId"]')?.value === "two");
    expect(section("wording").open).toBe(false);

    // A question the form does not have: said under its form component, the box not marked invalid.
    const ghost = two.children!.content!.find((node) => (node.configuration as { componentId: string }).componentId === "ghost")!;
    controller.select(ghost.id);
    await until(() => properties(element).querySelector('[data-note="componentId"]'));
    expect(properties(element).querySelector('[data-note="componentId"]')!.textContent).toContain("ghost, which is not a component of the form");
    const picker = properties(element).querySelector<HTMLSelectElement>('[data-prop="componentId"]')!;
    expect(picker.getAttribute("aria-describedby")).toContain("note-componentId-0");
    expect(picker.hasAttribute("aria-invalid")).toBe(false);

    // A route back to the first page: said under where it goes, and a Save goes through all the same.
    const route = two.children!.routes![0]!;
    controller.select(route.id);
    await until(() => properties(element).querySelector('[data-note="to"]'));
    expect(properties(element).querySelector('[data-note="to"]')!.textContent).toContain("routes only go forward");
    const to = properties(element).querySelector<HTMLSelectElement>('[data-prop="to"]')!;
    to.value = "$end";
    to.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    properties(element).querySelector<HTMLElement>("[data-inspector-save]")!.click();
    await until(() => journeyOf(element.definition, "loop")?.pages[1]?.routes?.[0]?.to === "$end");
    await until(() => !properties(element).querySelector('[data-note="to"]'));
  });

  it("takes a question whose form component was deleted off the journey from its finding in the Journey panel, in one undo step", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    await openJourneys(element);
    const card = (): HTMLElement | null => formPanel(element).querySelector<HTMLElement>("[data-mode-findings]");
    const remove = (): HTMLElement | null => card()?.querySelector<HTMLElement>('[data-fix-id="remove"]') ?? null;
    expect(remove()).toBeNull();
    element.builder!.controller.remove("subscribe");
    await until(() => remove());
    // Selecting the finding selects its question, on the journey's own controller.
    const finding = remove()!.closest<HTMLElement>("[data-finding]")!;
    finding.querySelector<HTMLElement>("[data-finding-select]")!.click();
    const question = element.journeyMode!.controller.snapshot().children!.pages![1]!.children!.content![0]!.id;
    expect(element.journeyMode!.controller.selectedComponentId()).toBe(question);
    remove()!.click();
    await until(() => JSON.stringify(pageComponents(journeyOf(element.definition, "intake"))) === JSON.stringify([["fullName"], []]));
    await until(() => remove() === null);
    element.undo();
    await until(() => JSON.stringify(pageComponents(journeyOf(element.definition, "intake"))) === JSON.stringify([["fullName"], ["subscribe"]]));
    await until(() => remove());
  });

  it("makes a step Check answers in the element: its own boxes, its row wording among the texts, the map's count, and Move to the end for a step after it", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys({
        journeys: [
          {
            id: "intake",
            name: "Intake",
            pages: [
              { id: "about", title: "About you", components: ["fullName"] },
              { id: "check", title: "Check your answers", kind: "review", review: { labels: { fullName: "Who are you?" } }, components: [] },
              { id: "contact", title: "Keeping in touch", components: ["subscribe"] }
            ]
          }
        ]
      } as unknown as JourneyConfiguration);
    });
    await ready(element);
    await openJourneys(element);
    const mode = element.journeyMode!;
    const check = mode.controller.snapshot().children!.pages![1]!;

    // The step's row wording is a text of the Languages workspace, at its address in the definition's map.
    const wording = element.builder!.translatableTexts().find((text) => where(text) === "journeys/intake/pages/check/review/labels/fullName");
    expect(wording).toMatchObject({ default: "Who are you?", componentId: "journey.intake.check" });

    // Its inspector has the Answers listed section, and Kind says Check answers.
    mode.controller.select(check.id);
    await until(() => properties(element).querySelector('[data-prop="kind"]'));
    const root = properties(element);
    expect([...root.querySelectorAll<HTMLElement>("[data-inspector-section]")].map((section) => section.dataset.inspectorSection)).toEqual(["page", "review", "validation", "wording"]);
    expect(root.querySelector<HTMLSelectElement>('[data-prop="kind"]')!.value).toBe("review");
    expect(root.querySelector('[data-prop="review.change"]')).not.toBeNull();

    // A step is after it: the finding offers Move to the end, in one undo.
    const card = (): HTMLElement | null => formPanel(element).querySelector<HTMLElement>("[data-mode-findings]");
    const move = (): HTMLElement | undefined => [...(card()?.querySelectorAll<HTMLElement>("[data-finding-fix]") ?? [])].find((button) => button.textContent === "Move to the end");
    await until(() => move());
    move()!.click();
    await until(() => journeyOf(element.definition, "intake")?.pages.map((page) => page.id).join() === "about,contact,check");
    await until(() => move() === undefined);
    element.undo();
    await until(() => journeyOf(element.definition, "intake")?.pages.map((page) => page.id).join() === "about,check,contact");
    await until(() => move());
  });

  it("reads back a journey value that is not an object as given, and replaces it with a block once a journey is added", async () => {
    for (const value of [null, []]) {
      const seed = { ...sampleDefinition(), journey: value } as unknown as FormDefinition;
      const element = mount((el) => {
        el.setAttribute("pdf", "off");
        el.definition = seed;
      });
      await ready(element);
      await until(() => element.journeyMode !== undefined);
      expect(JSON.stringify(element.definition)).toBe(JSON.stringify(seed));
      // Through journeys="off" and back, still as given.
      element.setAttribute("journeys", "off");
      await until(() => element.journeyMode === undefined);
      expect(JSON.stringify(element.definition)).toBe(JSON.stringify(seed));
      element.removeAttribute("journeys");
      await until(() => element.journeyMode !== undefined);
      await element.journeyMode!.newJourney({ from: "one-page" });
      // A nameless one-page start is a journey like any other, its page heading hidden,
      // and the first one the form gets, so the form opens as it.
      expect(element.definition.journey).toMatchObject({ journeys: [{ id: "journey-1", heading: "hidden" }], opensAs: "journey" });
      element.remove();
    }
  });

  it("keeps an author's link in the try session from navigating, and says so", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withLinkNote();
    });
    await ready(element);
    await openJourneys(element);
    await openTry(element);
    await until(() => tryFormRoot(element)?.querySelector('a[href="https://example.org/privacy"]'));
    const link = tryFormRoot(element)!.querySelector<HTMLAnchorElement>('a[href="https://example.org/privacy"]')!;
    const click = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(tryJourneyCard(element)?.textContent).toContain("Links do not open in Try it");
    // Links never navigate inside the try session, even with target="_blank".
    link.target = "_blank";
    const newTab = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
    link.dispatchEvent(newTab);
    expect(newTab.defaultPrevented).toBe(true);
  });

  it("starts the try session over on a new definition, with no answers carried from before", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withLinkNote();
    });
    await ready(element);
    await openJourneys(element);
    await openTry(element);
    const before = element.journeyMode!.previewRuntime!;
    before.setValue("fullName", "Ada");
    element.definition = withLinkNote();
    await openJourneys(element);
    // Try it is off, open it again.
    await openTry(element);
    await until(() => element.journeyMode?.previewRuntime && element.journeyMode.previewRuntime !== before && tryHeading(element) !== "");
    expect(element.journeyMode!.previewRuntime!.state().values.fullName).toBeUndefined();
  });

  it("walks a journey's menu on the document label with the arrows, Home and End, and Escape puts focus back on the label", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    await openJourneys(element);
    // `quick`, not the default: every item of its menu is on.
    open(element, "quick");
    await until(() => element.journeyMode!.journeyId === "quick" && element.journeyMode!.ready && barLabel(element).name === "Quick");
    const label = shell(element).querySelector<HTMLElement>("[data-document-menu]")!;
    expect(label.title).toBe("Journey options");
    label.click();
    expect(label.getAttribute("aria-expanded")).toBe("true");
    const items = [...shell(element).querySelectorAll<HTMLElement>("[data-document-menu-popover] [role=menuitem]")];
    expect(items.map((item) => item.dataset.documentAction)).toEqual(["rename", "duplicate", "default", "remove"]);
    expect(shell(element).activeElement).toBe(items[0]);
    const press = (key: string): void => {
      (shell(element).activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
    };
    press("ArrowDown");
    expect(shell(element).activeElement).toBe(items[1]);
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown");
    expect(shell(element).activeElement).toBe(items[0]);
    press("ArrowUp");
    expect(shell(element).activeElement).toBe(items[3]);
    press("Home");
    expect(shell(element).activeElement).toBe(items[0]);
    press("End");
    expect(shell(element).activeElement).toBe(items[3]);
    press("Escape");
    expect(shell(element).querySelector<HTMLElement>("[data-document-menu-popover]")!.hidden).toBe(true);
    expect(shell(element).activeElement).toBe(label);
    expect(label.getAttribute("aria-expanded")).toBe("false");
  });

  it("makes a journey from the one popover as one empty step, worded as any journey, on its map even with one step; Enter in the Name box starts the same", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = sampleDefinition();
    });
    await ready(element);
    await until(() => element.journeyMode !== undefined);
    // The journeys side alone can add: the PDF side is off.
    expect(element.builder!.newDocument("pdf")).toBe(false);
    // With none yet, New starts from the Journeys overview.
    element.builder!.setWorkspace("journeys");
    expect(element.builder!.newDocument("journeys")).toBe(true);
    const popover = (): HTMLElement => shell(element).querySelector<HTMLElement>("[data-journey-add-popover]")!;
    await until(() => popover() && !popover().hidden);
    // One popover, one start, named "Journey" whatever the pointer rests on.
    expect(popover().getAttribute("aria-label")).toBe("New journey");
    const nameBox = (): HTMLInputElement => popover().querySelector<HTMLInputElement>("[data-journey-add-name]")!;
    expect(nameBox().placeholder).toBe("Journey");
    expect(popover().querySelector('[data-journey-add="blank"]')!.textContent).toBe("One empty step");
    expect(popover().textContent).not.toMatch(/variant/i);
    popover().querySelector<HTMLElement>('[data-journey-add="blank"]')!.click();
    await until(() => element.journeyMode!.journeys.length === 1 && element.journeyMode!.ready);
    const made = element.journeyMode!.journeys[0]!;
    expect(made).toMatchObject({ id: "journey-1", name: "Journey" });
    expect(made.heading).toBeUndefined();
    // One step titled Step 1, no field on it.
    expect(made.pages).toEqual([{ id: "step-1", title: "Step 1", components: [] }]);

    // The label, its menu and the rename box call it a journey; no badge.
    expect(entry(element, "journey-1").badge).toBeUndefined();
    await until(() => barLabel(element).name === "Journey");
    expect(barLabel(element)).toEqual({ name: "Journey", kind: "Journey", badges: ["Default"] });
    expect(shell(element).querySelector<HTMLElement>("[data-document-menu]")!.title).toBe("Journey options");

    // It opens on its map, with one step: the bar offers Map, and the map's counts say what is to put right.
    await until(() => element.journeyMode!.view === "map" && canvasRoot(element).querySelector("[data-canvas-surface] [data-journey-map]"));
    const mapButton = shell(element).querySelector<HTMLElement>('[data-journey-view="map"]')!;
    expect(mapButton.hidden).toBe(false);
    expect(mapButton.getAttribute("aria-pressed")).toBe("true");

    // A step added from the palette: two steps.
    element.journeyMode!.controller.add("journey-page", "journey", "pages");
    await until(() => element.journeyMode!.journey?.pages.length === 2);
    expect(barLabel(element).kind).toBe("Journey");

    // Enter in the Name box starts the same journey.
    element.builder!.newDocument("journeys");
    await until(() => popover() && !popover().hidden);
    const before = element.journeyMode!.journeys.length;
    nameBox().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => element.journeyMode!.journeys.length === before + 1 && element.journeyMode!.ready);
    expect(popover().hidden).toBe(true);
    expect(element.journeyMode!.journeys[before]).toMatchObject({ name: "Journey 2", pages: [{ id: "step-1", title: "Step 1" }] });
    expect(element.journeyMode!.view).toBe("map");
  });

  it("marks the input of a required calculation a one-page journey leaves out: Ask it here adds the input, Make it optional opens the calculated field", async () => {
    const definition = sampleDefinition();
    definition.root.children!.content!.splice(
      4,
      0,
      { id: "cost", type: "number", configuration: { label: "Cost" } },
      {
        id: "total",
        type: "number",
        configuration: { label: "Total", required: true },
        rules: { value: { kind: "arithmetic", operator: "multiply", left: { kind: "path", path: "cost" }, right: { kind: "literal", value: 2 } } }
      }
    );
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = {
        ...definition,
        // Every question but `cost`; the calculated `total` is on the page, and empty without it.
        journey: { journeys: [{ id: "public", name: "Public", pages: [{ id: "one", title: "Public", components: ["fullName", "country", "subscribe", "email", "total", "submit"] }] }] }
      };
    });
    await ready(element);
    await openJourneys(element);
    const card = (): HTMLElement | null => formPanel(element).querySelector<HTMLElement>("[data-mode-findings]");
    const item = (): HTMLElement | undefined =>
      [...(card()?.querySelectorAll<HTMLElement>("[data-finding]") ?? [])].find((entry) => entry.querySelector(".mode-finding-text")!.textContent!.includes("worked out from Cost"));
    await until(() => item());
    expect(item()!.dataset.severity).toBe("error");
    expect(item()!.querySelector(".mode-finding-text")!.textContent).toBe(
      "Total is required by the form and worked out from Cost, which this journey never asks: it comes out empty, so no submission through the journey can pass until Cost is asked."
    );
    // The fix-its: the input is what a step can ask, the calculated field what the form can make optional.
    const fixes = (): string[] => [...item()!.querySelectorAll("[data-finding-fix]")].map((button) => button.textContent!);
    expect(fixes()).toEqual(["Ask it here", "Make Total optional on the form"]);
    [...item()!.querySelectorAll<HTMLElement>("[data-finding-fix]")].find((button) => button.textContent === "Ask it here")!.click();
    await until(() => element.journeyMode!.journey?.pages[0]?.components?.includes("cost"));
    expect(pageComponents(element.journeyMode!.journey)).toEqual([["fullName", "country", "subscribe", "email", "total", "cost", "submit"]]);
    await until(() => item() === undefined);
    element.journeyMode!.controller.undo();
    await until(() => item());
    [...item()!.querySelectorAll<HTMLElement>("[data-finding-fix]")].find((button) => button.textContent === "Make Total optional on the form")!.click();
    await until(() => element.builder!.mode === "form");
    expect(element.controller!.selectedComponentId()).toBe("total");
  });

  it("offers a journey of one step its Map, as any journey has: a route added makes the way out the map draws, and Undo keeps the map", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = {
        ...sampleDefinition(),
        journey: { journeys: [{ id: "public", name: "Public", pages: [{ id: "one", title: "Public", components: ["fullName", "submit"] }] }] }
      };
    });
    await ready(element);
    await openJourneys(element);
    const mode = element.journeyMode!;
    const mapButton = viewButton(element, "map");
    const menu = (): string => shell(element).querySelector<HTMLElement>("[data-document-menu]")!.title;
    expect(entry(element, "public").badge).toBeUndefined();
    expect(barLabel(element).kind).toBe("Journey");
    expect(menu()).toBe("Journey options");
    // One step, and the Map is on the bar all the same.
    expect(mapButton.hidden).toBe(false);
    mapButton.click();
    await until(() => canvasRoot(element).querySelector("[data-canvas-surface] svg.jm-svg [data-map-item]"));
    expect(mode.view).toBe("map");

    // A route added to its step: not written until its target is chosen; the Map stays.
    const pageNode = mode.controller.snapshot().children!.pages![0]!.id;
    mode.controller.add("journey-route", pageNode, "routes");
    await until(() => mode.controller.snapshot().children!.pages![0]!.children!.routes!.length === 1);
    expect(mode.journey?.pages[0]?.routes).toBeUndefined();
    expect(mapButton.hidden).toBe(false);
    expect(barLabel(element)).toEqual({ name: "Public", kind: "Journey", badges: ["Default"] });

    // Undo takes the route away: one step again, and still the map.
    mode.controller.undo();
    await until(() => mode.controller.snapshot().children!.pages![0]!.children!.routes!.length === 0);
    expect(mode.view).toBe("map");
    expect(mapButton.hidden).toBe(false);
    expect(menu()).toBe("Journey options");
  });

  it("puts focus on the bar's Step when the control holding it goes: Open this step", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withLinkNote();
    });
    await ready(element);
    await openJourneys(element);
    // Open this step: the try session goes, the bar's Step takes focus.
    await openTry(element);
    const show = tryJourneyCard(element)!.querySelector<HTMLElement>("[data-try-journey-show]")!;
    show.focus();
    expect(canvasRoot(element).activeElement).toBe(show);
    show.click();
    await until(() => element.journeyMode!.view === "step");
    expect(shell(element).activeElement).toBe(viewButton(element, "step"));
  });

  it("describes the add dialog by its stakes and its hint", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withLinkNote();
    });
    await ready(element);
    await openJourneys(element);
    await element.journeyMode!.openAdd();
    const host = shell(element).querySelector<HTMLElement>("[data-journey-add-popover]")!;
    const ids = (host.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toEqual(["jd-add-stakes", "jd-add-hint"]);
    for (const id of ids) {
      expect(shell(element).getElementById(id)).not.toBeNull();
    }
    expect(shell(element).getElementById("jd-add-stakes")!.textContent).toContain("accepted by the server as a way to submit");
  });

  it("opens a folded Wording while the filter matches inside it, and folds it again after, without remembering it opened", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withLinkNote();
    });
    await ready(element);
    await openJourneys(element);
    const controller = element.journeyMode!.controller;
    const page = controller.snapshot().children!.pages![0]!;
    controller.select(page.id);
    await until(() => properties(element).querySelector('[data-prop="pageId"]'));
    const section = (id: string): HTMLDetailsElement => properties(element).querySelector<HTMLDetailsElement>(`[data-inspector-section="${id}"]`)!;
    expect(section("wording").open).toBe(false);
    const filter = properties(element).querySelector<HTMLInputElement>("[data-property-filter]")!;
    const type = (text: string): void => {
      filter.value = text;
      filter.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    };
    type("back");
    expect(section("wording").open).toBe(true);
    const backRow = [...section("wording").querySelectorAll<HTMLElement>(".property-row")].find((row) => row.textContent?.includes("Back button"));
    expect(backRow?.hidden).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    type("");
    expect(section("wording").open).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Not remembered as opened: another page's Wording is folded, and this one again.
    controller.select(controller.snapshot().children!.pages![1]!.id);
    await until(() => properties(element).querySelector<HTMLInputElement>('[data-prop="pageId"]')?.value === "contact");
    expect(section("wording").open).toBe(false);
    controller.select(page.id);
    await until(() => properties(element).querySelector<HTMLInputElement>('[data-prop="pageId"]')?.value === "about");
    expect(section("wording").open).toBe(false);
  });

  it("keeps Map | Step in the menu drawer at the phone tier, with no Add unassigned", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.setAttribute("mode", "journeys");
      el.definition = withJourneys();
    });
    await ready(element);
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    const wrapEl = shell(element).querySelector<HTMLElement>("[data-shell=wrap]")!;
    wrapEl.getBoundingClientRect = () => ({ width: 390, height: 844, x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 844, toJSON: () => ({}) }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    const host = shell(element).querySelector<HTMLElement>("[data-menu-host]")!;
    expect(shell(element).querySelector<HTMLElement>("[data-menu-host-section]")!.hidden).toBe(false);
    const views = host.querySelector<HTMLElement>("[data-journey-views]")!;
    expect(views).not.toBeNull();
    expect(views.hidden).toBe(false);
    expect(views.querySelector('[data-journey-view="map"]')).not.toBeNull();
    expect(host.querySelector<HTMLElement>("[data-journey-add-unassigned]")).toBeNull();
    // The views switch is navigation: the canvas's toolbar never takes it.
    expect(shell(element).querySelector("datum-builder-canvas")!.shadowRoot!.querySelector("[data-journey-views]")).toBeNull();
  });

  it("opens a journey with nodes of its own: they are nodes of its tree, and the definition is byte for byte until it is edited", async () => {
    const seed = withJourneys(ownNodesBlock());
    const given = JSON.stringify(seed);
    const own = JSON.stringify(seed.journey!.journeys![0]);
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.setAttribute("mode", "journeys");
      el.definition = seed;
    });
    const journeys = journeyChanges(element);
    const errors: string[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    await ready(element);
    // `mode="journeys"` opens on the default journey, and draws it on its map like any other's.
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    await until(() => canvasRoot(element).querySelector("[data-canvas-surface] [data-journey-map] [data-map-item]"));
    const mode = element.journeyMode!;
    expect(mode.journeyId).toBe("guarded");
    expect("notice" in mode).toBe(false);
    expect(canvasRoot(element).querySelector("[data-journey-guard]")).toBeNull();
    // Listed with no badge of its own: it is a journey like the other.
    expect(entries(element)).toEqual([
      ["guarded", "Guarded"],
      ["plain", "Plain"]
    ]);
    expect(entry(element, "guarded").badge).toBeUndefined();
    // The block stores `opensAs: "form"`, so the form does not open as it and no "Default" is shown.
    expect(barLabel(element)).toEqual({ name: "Guarded", kind: "Journey", badges: [] });
    // Its own nodes are nodes of the tree, under their own ids; its references are questions.
    const tree = mode.controller.snapshot();
    const [who, news] = tree.children!.pages!;
    expect(who!.children!.content!.map((node) => [node.id, node.type])).toEqual([
      ["legal_name", "text"],
      ["nick", "text"]
    ]);
    expect(who!.children!.content![1]!.rules).toEqual({ visibleWhen: { kind: "path", path: "subscribe" } });
    const [box, country] = news!.children!.content!;
    expect([box!.id, box!.type, country!.type]).toEqual(["box", "fieldset", "journey-field"]);
    expect(box!.children!.content!.map((node) => [node.type, (node.configuration as { componentId: string }).componentId])).toEqual([
      ["journey-field", "subscribe"],
      ["journey-field", "email"],
      ["journey-field", "ghost"]
    ]);
    // The outline lists them where they sit.
    const outline = JSON.stringify(mode.controller.treeView());
    for (const id of ["legal_name", "nick", "box"]) {
      expect(outline).toContain(`"${id}"`);
    }
    // The designer's controls are up.
    expect(shell(element).querySelector<HTMLElement>("[data-mode-actions] [data-journey-views]")!.hidden).toBe(false);
    // Opened, nothing is written: the very block, and the definition byte for byte.
    expect(element.definition.journey).toBe(seed.journey);
    expect(JSON.stringify(element.definition)).toBe(given);
    expect(journeys).toEqual([]);

    // An edit of it writes its own nodes back as written (the journey's own keys in the order
    // the designer writes them: a key it does not know before the pages).
    mode.controller.setProperty(who!.id, "title", "Who are you");
    await until(() => journeys.length === 1);
    const written = journeyOf(element.definition, "guarded")!;
    expect(JSON.stringify(written.pages)).toBe(JSON.stringify((JSON.parse(own) as Journey).pages).replace('"title":"Who"', '"title":"Who are you"'));
    expect((written as unknown as Record<string, unknown>)["x-journey-note"]).toBe("kept");
    expect(journeyOf(element.definition, "plain")).toBe(seed.journey!.journeys![1]);
    // Undone, it is the journey given again.
    mode.controller.undo();
    await until(() => journeys.length === 2);
    expect(journeyOf(element.definition, "guarded")).toEqual(JSON.parse(own));
    expect(JSON.stringify(journeyOf(element.definition, "guarded")!.pages)).toBe(JSON.stringify((JSON.parse(own) as Journey).pages));
    expect(errors).toEqual([]);
  });

  it("lets a journey with nodes of its own be chosen under Opens as, renamed, copied deep, made the default and removed, and follows a form rename into its open tree", async () => {
    const seed = withJourneys({ ...ownNodesBlock(), defaultJourneyId: "plain" });
    const pagesGiven = JSON.stringify(seed.journey!.journeys![0]!.pages);
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = seed;
    });
    const journeys = journeyChanges(element);
    await ready(element);

    // Opens as lists it beside the rest; choosing it makes it the default at once.
    const row = (): HTMLSelectElement | null => formPanel(element).querySelector<HTMLSelectElement>('[data-root-setting="journeys.opensAs"]');
    await until(() => row());
    expect([...row()!.options].map((option) => [option.value, option.textContent])).toEqual([
      ["form", "The whole form"],
      ["guarded", "Guarded"],
      ["plain", "Plain"]
    ]);
    row()!.value = "guarded";
    row()!.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await until(() => element.definition.journey?.defaultJourneyId === "guarded");
    expect(JSON.stringify(journeyOf(element.definition, "guarded")!.pages)).toBe(pagesGiven);
    formPanel(element).querySelector<HTMLElement>("[data-inspector-save]")!.click();
    await until(() => element.journeyMode!.opensAs === "journey" && !formPanel(element).querySelector("[data-inspector-save]:not([disabled])"));

    // On the page, opened; its menu acts on it. Rename: the name alone.
    open(element, "guarded");
    await until(() => element.builder!.mode === "journeys" && element.journeyMode!.journeyId === "guarded" && element.journeyMode!.ready);
    menuAction(element, "rename");
    const box = shell(element).querySelector<HTMLInputElement>("[data-document-rename]")!;
    expect(box.value).toBe("Guarded");
    box.value = "Guarded path";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    await until(() => journeyOf(element.definition, "guarded")?.name === "Guarded path");
    expect(JSON.stringify(journeyOf(element.definition, "guarded")!.pages)).toBe(pagesGiven);
    expect((journeyOf(element.definition, "guarded") as unknown as Record<string, unknown>)["x-journey-note"]).toBe("kept");

    // Duplicate: a deep copy, put on the page and opened.
    menuAction(element, "duplicate");
    await until(() => element.journeyMode!.journeyId === "guarded-copy" && element.journeyMode!.ready);
    const original = journeyOf(element.definition, "guarded")!;
    const copy = journeyOf(element.definition, "guarded-copy")!;
    expect(JSON.stringify(copy.pages)).toBe(pagesGiven);
    expect(copy.pages[0]!.components![0]).not.toBe(original.pages[0]!.components![0]);
    expect(element.journeyMode!.controller.snapshot().children!.pages![0]!.children!.content![0]!.id).toBe("legal_name");

    // Set as default, then delete (two clicks): the copy goes, the original is as written.
    menuAction(element, "default");
    await until(() => element.definition.journey?.defaultJourneyId === "guarded-copy");
    menuAction(element, "remove");
    shell(element).querySelector<HTMLElement>('[data-document-menu-popover] [data-document-action="remove"][data-confirm]')!.click();
    await until(() => !journeyOf(element.definition, "guarded-copy"));
    expect(JSON.stringify(journeyOf(element.definition, "guarded")!.pages)).toBe(pagesGiven);
    expect(journeys.every((change) => change.reason === "journeys")).toBe(true);

    // A form component renamed is followed into its own nodes — the alias, the reference, the own
    // rule — in the open tree as in the catalog, with no entry of the tree's: each rename of the
    // form's is the one undo step.
    open(element, "guarded");
    await until(() => element.journeyMode!.journeyId === "guarded" && element.journeyMode!.ready);
    const controller = element.journeyMode!.controller;
    const top = controller.undoMark();
    element.controller!.renameId("fullName", "legalName");
    element.controller!.renameId("subscribe", "wantsNews");
    await until(() => journeys.filter((change) => change.reason === "form-rename").length === 2);
    const renamed = pagesGiven
      .replace('"fills":"fullName"', '"fills":"legalName"')
      .replace('"path":"subscribe"', '"path":"wantsNews"')
      .replace('"componentId":"subscribe"', '"componentId":"wantsNews"');
    expect(JSON.stringify(journeyOf(element.definition, "guarded")!.pages)).toBe(renamed);
    expect(pageComponents(journeyOf(element.definition, "plain"))).toEqual([["legalName", "country"], ["wantsNews", "email"]]);
    expect(controller.undoMark()).toBe(top);
    // The second rename moved the own rule and the reference in one step.
    element.controller!.undo();
    await until(() => JSON.stringify(journeyOf(element.definition, "guarded")!.pages) === pagesGiven.replace('"fills":"fullName"', '"fills":"legalName"'));
    // The form claims the open tree's own ids: none may be taken by a form component.
    element.controller!.renameId("email", "nick");
    expect(element.controller!.idError).toBe('ID "nick" is already used by a page-only field of a journey.');
  }, 20_000);

  it("authors a journey's own nodes from the form's own types: the page-only palette, Fills form field first, and Ask differently here… as one undo", async () => {
    const seed = withJourneys(ownNodesBlock());
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.setAttribute("mode", "journeys");
      el.definition = seed;
    });
    const journeys = journeyChanges(element);
    const errors: string[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    await ready(element);
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    const mode = element.journeyMode!;
    const types = mode.controller.componentTypes();
    // The host lends the form's definitions: its own types, page-only, after the Journey group.
    expect(types.slice(0, 4).map((entry) => entry.label)).toEqual(["Step", "Form field", "Route", "Worked-out value"]);
    // In the form palette's own groups: that they are never sent is the placed field's "Not sent" tag.
    expect(types).toContainEqual(expect.objectContaining({ type: "text", group: "Fields" }));
    expect(types).toContainEqual(expect.objectContaining({ type: "select", group: "Choices" }));
    for (const left of ["file", "steps", "step", "container"]) {
      expect(types.some((entry) => entry.type === left)).toBe(false);
    }
    // Fills form field leads its inspector.
    expect(mode.controller.inspectorModel("legal_name")!.sections[0]!.title).toBe("Fills form field");

    // Ask differently here… on the reused Country: a page-only select that fills it, in its place, selected.
    const country = mode.controller.snapshot().children!.pages![1]!.children!.content![1]!;
    expect((country.configuration as { componentId?: string }).componentId).toBe("country");
    expect(await mode.askDifferently(country.id)).toBe(true);
    await until(() => journeys.length === 1);
    expect(pageComponents(journeyOf(element.definition, "guarded"))[1]?.[1]).toEqual({ id: "select_1", type: "select", configuration: { label: "Country", fills: "country" } });
    expect(mode.controller.selectedComponentId()).toBe("select_1");
    // One undo takes it back.
    mode.controller.undo();
    await until(() => journeys.length === 2);
    expect(pageComponents(journeyOf(element.definition, "guarded"))[1]?.[1]).toBe("country");
    expect(errors).toEqual([]);
  }, 20_000);
});


/**
 * A form in three languages whose journey and PDF layout are worded in the form's own
 * `translations`: the journey's name and page title, the layout's name and a text node,
 * each under the id of the thing that holds the text.
 */
function threeLanguages(): FormDefinition {
  const t = (text: string, source: string): { text: string; source: string } => ({ text, source: sourceHash(source) });
  return {
    ...sampleDefinition(),
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr-CA", label: "Français" }, { code: "es" }] },
    translations: {
      "fr-CA": {
        journeys: { intake: { name: t("Accueil", "Intake"), pages: { about: { title: t("A propos", "About") } } } },
        pdf: { plain: { name: t("Simple", "Plain"), nodes: { intro: { text: t("Bonjour", "Hello") } } } }
      },
      es: {
        journeys: { intake: { name: t("Admision", "Intake"), pages: { about: { title: t("Acerca", "About") } } } },
        pdf: { plain: { name: t("Sencillo", "Plain") } }
      }
    },
    journey: {
      journeys: [{ id: "intake", name: "Intake", pages: [{ id: "about", title: "About", components: ["fullName"] }] }],
      defaultJourneyId: "intake"
    },
    pdf: {
      layouts: [
        {
          id: "plain",
          kind: "generated",
          name: "Plain",
          root: {
            id: "document",
            type: "pdf-document",
            configuration: {},
            children: { body: [{ id: "intro", type: "pdf-text", configuration: { text: "Hello" } }], header: [], footer: [] }
          }
        }
      ]
    }
  } as unknown as FormDefinition;
}

describe("removing a language prunes the journeys and PDF layouts", () => {
  it("journey names, page titles and PDF layout names lose the removed language, the rest stay", async () => {
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.definition = threeLanguages();
    document.body.append(element);
    await ready(element);
    await until(() => element.journeyMode !== undefined && element.pdfMode !== undefined);
    const controller = element.controller!;
    expect(controller.localizationActions.removeLocale("es")).toBe(true);
    await until(() => !JSON.stringify(element.definition.translations).includes('"es"'));
    // The journeys' and the layout's words are in the form's own map, so they go with it.
    const translations = JSON.stringify(element.definition.translations);
    expect(translations).toContain("Accueil");
    expect(translations).toContain("A propos");
    expect(translations).toContain("Simple");
    expect(translations).not.toContain("Admision");
    expect(translations).not.toContain("Sencillo");
    // The default strings are the journeys' and layouts' own, untouched.
    expect(element.definition.journey?.journeys?.[0]?.name).toBe("Intake");
    expect(element.definition.pdf?.layouts?.[0]?.name).toBe("Plain");
  }, 30_000);
});

describe("the language lifecycle reaches the journeys and PDF layouts", () => {
  async function localized(): Promise<DatumFormBuilderElement> {
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.definition = threeLanguages();
    document.body.append(element);
    await ready(element);
    await until(() => element.journeyMode !== undefined && element.pdfMode !== undefined);
    return element;
  }
  const translationsOf = (element: DatumFormBuilderElement): string => JSON.stringify(element.definition.translations);

  it("one Undo after a removal brings back the journeys' and layouts' translations with the form's (the known bug)", async () => {
    const element = await localized();
    const controller = element.controller!;
    const before = translationsOf(element);
    expect(controller.localizationActions.removeLocale("es")).toBe(true);
    await until(() => !translationsOf(element).includes('"es"'));
    controller.undo();
    await until(() => translationsOf(element) === before);
    expect(controller.localization()!.supportedLocales!.map((entry) => (typeof entry === "string" ? entry : entry.code))).toEqual(["en", "fr-CA", "es"]);
    controller.redo();
    await until(() => !translationsOf(element).includes('"es"'));
    expect(translationsOf(element)).toContain("Accueil");
  }, 30_000);

  it("a renamed code moves the journeys' and layouts' translations and is counted for the host's Save; one Undo undoes all of it", async () => {
    const element = await localized();
    const controller = element.controller!;
    const before = translationsOf(element);
    expect(controller.renameLocale("es", "es-MX")).toBe(true);
    await until(() => translationsOf(element).includes('"es-MX"'));
    expect(translationsOf(element)).not.toContain('"es"');
    expect(translationsOf(element)).toContain("Sencillo");
    expect(element.localeChangesSinceSave()).toEqual({ removed: [], renamed: [{ from: "es", to: "es-MX" }] });
    controller.undo();
    await until(() => translationsOf(element) === before);
    expect(controller.localization()!.supportedLocales!.map((entry) => (typeof entry === "string" ? entry : entry.code))).toEqual(["en", "fr-CA", "es"]);
    expect(element.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
  }, 30_000);

  it("Languages lists the journeys' and layouts' texts as editable rows, and typed cells are written together by one Apply", async () => {
    const element = await localized();
    const controller = element.controller!;
    element.builder!.setWorkspace("languages");
    await until(() => shell(element).querySelector("datum-builder-languages")?.shadowRoot?.querySelector("[data-languages-row]"));
    const root = shell(element).querySelector("datum-builder-languages")!.shadowRoot!;
    const ids = [...root.querySelectorAll<HTMLElement>("[data-languages-row]")].map((row) => row.dataset.languagesRow!);
    expect(ids).toContain("journeys/intake/name");
    expect(ids).toContain("journeys/intake/pages/about/title");
    expect(ids).toContain("pdf/plain/name");
    expect(ids).toContain("pdf/plain/nodes/intro/text");
    const cell = (row: string, locale: string): HTMLInputElement => root.querySelector<HTMLInputElement>(`[data-languages-cell="${row}"][data-languages-locale="${locale}"]`)!;
    expect(cell("pdf/plain/name", "es").readOnly).toBe(false);
    const type = (row: string, locale: string, text: string): void => {
      const input = cell(row, locale);
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    };
    const before = translationsOf(element);
    type("journeys/intake/pages/about/title", "fr-CA", "À propos de vous");
    type("pdf/plain/nodes/intro/text", "es", "Hola");
    type("pdf/plain/name", "fr-CA", "Ordinaire");
    // Typing writes nothing: the three wait in the bar until they are applied.
    expect(translationsOf(element)).toBe(before);
    expect(root.querySelector("[data-languages-pending-count]")!.textContent).toBe("3 changes");
    root.querySelector<HTMLButtonElement>("[data-languages-apply]")!.click();
    await until(() => translationsOf(element).includes("À propos de vous") && translationsOf(element).includes("Hola"));
    expect(translationsOf(element)).toContain("Ordinaire");
    expect(cell("pdf/plain/nodes/intro/text", "es").value).toBe("Hola");
    // Three cells, one Apply, one step.
    controller.undo();
    await until(() => translationsOf(element) === before);
  }, 30_000);
});

describe("panels on a journey", () => {
  const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  async function openJourney(): Promise<DatumFormBuilderElement> {
    const element = document.createElement("datum-form-builder");
    element.definition = withJourneys();
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    element.mode = "journeys";
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    element.builder!.selectDocument("journeys", "intake");
    await until(() => element.journeyMode!.journeyId === "intake");
    await tick(60);
    return element;
  }
  const strip = (element: DatumFormBuilderElement, id: string): HTMLElement =>
    element.builder!.shadowRoot!.querySelector<HTMLElement>(`[data-strip] [data-panel="${id}"]`)!;

  it("typing the journey's name in the Form panel writes a live draft: no repaint, the box and its focus stay, one plain change on blur", async () => {
    const element = await openJourney();
    strip(element, "form").click();
    await tick(150);
    const form = element.builder!.shadowRoot!.querySelector<HTMLElement>(".form-settings")!;
    const outline = element.builder!.shadowRoot!.querySelector<HTMLElement>(".outline")!;
    const box = form.shadowRoot!.querySelector<HTMLInputElement>("#prop-name")!;
    expect(box).toBeTruthy();
    const protos = [form, outline].map((el) => Object.getPrototypeOf(el) as { render(): void });
    const originals = protos.map((proto) => proto.render);
    const counts = [0, 0];
    protos.forEach((proto, index) => {
      const original = proto.render;
      proto.render = function (this: unknown) {
        counts[index]!++;
        return original.call(this);
      };
    });
    try {
      box.focus();
      for (const text of ["A", "Ab", "Abc", "Abcd"]) {
        box.value = text;
        box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }
      await tick(100);
      expect(counts).toEqual([0, 0]);
      expect(form.shadowRoot!.querySelector("#prop-name")).toBe(box);
      expect(form.shadowRoot!.activeElement).toBe(box);
      expect(box.value).toBe("Abcd");
      expect(form.shadowRoot!.querySelector("[data-not-applied]")).toBeTruthy();
      expect(form.shadowRoot!.querySelector("[data-inspector-save]")!.hasAttribute("disabled")).toBe(false);
    } finally {
      protos.forEach((proto, index) => {
        proto.render = originals[index]!;
      });
    }
    box.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    await tick(60);
    expect(form.shadowRoot!.querySelector<HTMLInputElement>("#prop-name")!.value).toBe("Abcd");
  }, 30_000);

  it("the Form, Components and Outline panels carry a real heading", async () => {
    const element = await openJourney();
    const sel: Record<string, string> = { form: ".form-settings", components: ".toolbar", outline: ".outline" };
    for (const id of ["form", "components", "outline"]) {
      strip(element, id).click();
      await tick();
      const root = element.builder!.shadowRoot!.querySelector<HTMLElement>(sel[id]!)!.shadowRoot!;
      expect(root.querySelector("h2"), id).toBeTruthy();
    }
  }, 30_000);

  it("the Outline words its note for the journey and does not say the type and the id twice", async () => {
    const element = await openJourney();
    strip(element, "outline").click();
    await tick(100);
    const root = element.builder!.shadowRoot!.querySelector<HTMLElement>(".outline")!.shadowRoot!;
    expect(root.querySelector(".tree-note")!.textContent).toContain("journey");
    expect(root.querySelector(".tree-note")!.textContent).not.toContain("canvas");
    const metas = [...root.querySelectorAll(".tree-meta")].map((el) => el.textContent ?? "");
    expect(metas.length).toBeGreaterThan(0);
    for (const meta of metas) {
      const [type, id] = meta.split(" · ");
      expect(id === undefined || !id.startsWith(type!), meta).toBe(true);
    }
    // Clipped text can be read: a title on the label and on the meta.
    expect(root.querySelector(".tree-meta")!.getAttribute("title")).toBeTruthy();
    expect(root.querySelector(".tree-label")!.getAttribute("title")).toBeTruthy();
  }, 30_000);
});

/*
 * The Step view's inspector: the inspector routed to the FORM controller for a form field
 * placed on a step, "Take it off this step", and the unsaved-edits guard across the two
 * controllers. The Step view is put up from the bar's Step button, as an author does.
 */
describe("the Step view's inspector (forms and steps)", () => {
  const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  interface StepRig {
    element: DatumFormBuilderElement;
    form: StepController;
    journey: () => StepController;
    /** The page node on the canvas. */
    page: { id: string | undefined };
    pageNode(pageId: string): { id: string; children?: Record<string, Array<{ id: string; type: string; configuration?: Record<string, unknown> }>> };
    placement(pageId: string, componentId: string): string;
    notify(): void;
  }

  type StepController = import("../../../engine/form-engine/builder/controller/builder-controller.js").BuilderController;

  async function stepRig(pageId = "about"): Promise<StepRig> {
    const element = mount((el) => {
      el.definition = withJourneys();
    });
    await ready(element);
    const mode = element.journeyMode!;
    const form = element.builder!.controller as StepController;
    const journey = (): StepController => mode.controller as StepController;
    await openJourneys(element);
    const pageNode = (id: string) =>
      (journey().snapshot().children?.pages ?? []).find((node) => (node.configuration as { pageId?: string }).pageId === id)! as ReturnType<StepRig["pageNode"]>;
    // The real Step view, from the bar, on the step asked for.
    viewButton(element, "step").click();
    await until(() => mode.view === "step");
    if (pageId !== "about") {
      journey().select(pageNode(pageId).id);
    }
    // The step on the canvas: the root the journey's controller is drawn as.
    const page = {
      get id(): string | undefined {
        return journey().canvasRootId();
      }
    };
    const placement = (onPage: string, componentId: string): string =>
      (pageNode(onPage).children?.content ?? []).find((node) => node.type === "journey-field" && node.configuration?.componentId === componentId)!.id;
    await until(() => sheet(element)?.querySelector(`.db-node[data-component-id="${placement(pageId, "fullName")}"]`));
    return { element, form, journey, page, pageNode, placement, notify: () => undefined };
  }

  const canvasEl = (element: DatumFormBuilderElement) =>
    shell(element).querySelector("datum-builder-canvas") as HTMLElement & { previewRoot(): ShadowRoot | undefined };
  const renderer = (element: DatumFormBuilderElement) =>
    canvasEl(element).shadowRoot!.querySelector("[data-preview]") as HTMLElement & { painted(): Promise<void>; live?: { draws(): number } };
  const propsEl = (element: DatumFormBuilderElement) =>
    shell(element).querySelector("datum-builder-properties") as HTMLElement & { controller: unknown };

  async function settled(element: DatumFormBuilderElement): Promise<void> {
    const host = renderer(element);
    await host.painted();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await host.painted();
  }

  /** The renderer's draws and the inspector's markup writes while `act` runs, settled. */
  async function costOf(element: DatumFormBuilderElement, act: () => void): Promise<{ draws: number; writes: number }> {
    await settled(element);
    const host = renderer(element);
    const before = host.live!;
    const from = before.draws();
    const observer = new MutationObserver(() => undefined);
    observer.observe(propsEl(element).shadowRoot!, { childList: true });
    act();
    const writes = observer.takeRecords().filter((record) => record.addedNodes.length > 0).length;
    observer.disconnect();
    await settled(element);
    const after = host.live!;
    return { draws: after === before ? after.draws() - from : before.draws() - from + after.draws(), writes };
  }

  const boxOf = (element: DatumFormBuilderElement, id: string): HTMLElement => sheet(element)!.querySelector<HTMLElement>(`.db-node[data-component-id="${id}"]`)!;
  const labelBox = (element: DatumFormBuilderElement): HTMLInputElement => properties(element).querySelector<HTMLInputElement>('input[data-prop="label"]')!;
  const takeOffButton = (element: DatumFormBuilderElement) => properties(element).querySelector<HTMLButtonElement>('[data-inspector-mode-action="take-off"]');
  const prompt = (element: DatumFormBuilderElement) => properties(element).querySelector<HTMLElement>("[data-unsaved-prompt]");
  const type = (input: HTMLInputElement, text: string): void => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  };

  async function selectPlacement(rig: StepRig, componentId = "fullName", pageId = "about"): Promise<string> {
    const id = rig.placement(pageId, componentId);
    boxOf(rig.element, id).click();
    await until(() => rig.form.selectedComponentId() === componentId && labelBox(rig.element));
    return id;
  }

  it("a placement selected on the step opens the form field's inspector, on the form's controller, with Take it off this step", async () => {
    const rig = await stepRig();
    const placementId = rig.placement("about", "fullName");
    const cost = await costOf(rig.element, () => boxOf(rig.element, placementId).click());
    // One paint: the inspector written once, the canvas drawn once.
    expect(cost).toEqual({ draws: 1, writes: 1 });
    expect(rig.journey().selectedComponentId()).toBe(placementId);
    expect(rig.form.selectedComponentId()).toBe("fullName");
    expect(propsEl(rig.element).controller).toBe(rig.form);
    // The form field's usual inspector: its label, its Saves to line, the Logic tab.
    expect(labelBox(rig.element).value).toBe("Full name");
    expect(properties(rig.element).querySelector("[data-saved-as]")).toBeTruthy();
    expect(properties(rig.element).querySelector('[data-inspector-tab="rules"]')).toBeTruthy();
    // Take it off this step, in the about card; the form's Delete is not offered beside it.
    expect(takeOffButton(rig.element)?.textContent).toBe("Take it off this step");
    expect(takeOffButton(rig.element)?.closest("[data-inspector-about]")).toBeTruthy();
    expect(properties(rig.element).querySelector("[data-inspector-delete]")).toBeNull();
    // The bar's Delete says what it does for a placement.
    const barDelete = canvasEl(rig.element).shadowRoot!.querySelector<HTMLElement>('[data-selection-action="delete"]')!;
    expect(barDelete.getAttribute("aria-label")).toBe("Take off this step");

    // The step itself is the journey's, inspected there as before, in one paint too.
    const back = await costOf(rig.element, () => sheet(rig.element)!.querySelector<HTMLElement>("[data-db-region-owner]")!.click());
    expect(rig.journey().selectedComponentId()).toBe(rig.page.id);
    expect(propsEl(rig.element).controller).toBe(rig.journey());
    expect(back.writes).toBe(1);
    expect(takeOffButton(rig.element)).toBeNull();
  }, 30_000);

  it("a label edit lands in the form's definition, is drawn on the step in one paint, and leaves the journey's history alone", async () => {
    const rig = await stepRig();
    const placementId = await selectPlacement(rig);
    const journeyUndo = rig.journey().canUndo();
    const box = labelBox(rig.element);
    box.focus();
    const cost = await costOf(rig.element, () => type(box, "Your full name"));
    expect(cost.draws).toBe(1);
    expect(boxOf(rig.element, placementId).textContent).toContain("Your full name");
    properties(rig.element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    const field = rig.form.snapshot().children!.content!.find((node) => node.id === "fullName")!;
    expect((field.configuration as { label?: unknown } | undefined)?.label).toBe("Your full name");
    expect((rig.element.definition!.root.children!.content!.find((node) => node.id === "fullName")!.configuration as { label?: unknown } | undefined)?.label).toBe("Your full name");
    expect(rig.journey().canUndo()).toBe(journeyUndo);
    await settled(rig.element);
    expect(boxOf(rig.element, placementId).textContent).toContain("Your full name");
  }, 30_000);

  it("Take it off this step is one undo step on the journey; the bar's Delete does the same, with no confirmation", async () => {
    const rig = await stepRig();
    const placementId = await selectPlacement(rig);
    const content = (): string[] => (rig.pageNode("about").children?.content ?? []).map((node) => node.id);
    expect(content()).toContain(placementId);
    takeOffButton(rig.element)!.click();
    expect(content()).not.toContain(placementId);
    // The form field stays, and its other steps.
    expect(rig.form.snapshot().children!.content!.some((node) => node.id === "fullName")).toBe(true);
    rig.journey().undo();
    expect(content()).toContain(placementId);
    expect(rig.journey().canUndo()).toBe(false);

    // From the canvas's bar.
    await settled(rig.element);
    await selectPlacement(rig);
    canvasEl(rig.element).shadowRoot!.querySelector<HTMLElement>('[data-selection-action="delete"]')!.click();
    expect(content()).not.toContain(placementId);
    expect(canvasEl(rig.element).shadowRoot!.querySelector("[data-delete-prompt]")).toBeNull();
    rig.journey().undo();
    expect(content()).toContain(placementId);
  }, 30_000);

  /** A placement selected with a label typed and not applied: the draft the guard is about. */
  async function drafted(): Promise<StepRig & { placementId: string }> {
    const rig = await stepRig();
    const placementId = await selectPlacement(rig);
    const box = labelBox(rig.element);
    box.focus();
    type(box, "Your full name");
    box.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    expect(rig.form.hasPendingChanges("fullName")).toBe(true);
    return { ...rig, placementId };
  }

  const answer = (element: DatumFormBuilderElement, choice: "save" | "discard" | "stay"): void => {
    properties(element).querySelector<HTMLButtonElement>(`[data-unsaved-${choice}]`)!.click();
  };

  it("guards a click on another node: the prompt is the inspector's, the step stays selected until it is answered", async () => {
    const rig = await drafted();
    sheet(rig.element)!.querySelector<HTMLElement>("[data-db-region-owner]")!.click();
    expect(prompt(rig.element)).toBeTruthy();
    expect(rig.journey().selectedComponentId()).toBe(rig.placementId);
    expect(propsEl(rig.element).controller).toBe(rig.form);
    // Keep editing: nothing moved, the draft is there.
    answer(rig.element, "stay");
    expect(prompt(rig.element)).toBeNull();
    expect(rig.journey().selectedComponentId()).toBe(rig.placementId);
    expect(rig.form.hasPendingChanges("fullName")).toBe(true);
    expect(labelBox(rig.element).value).toBe("Your full name");
    // Again, and Apply: the label lands on the form, then the step is selected and inspected.
    sheet(rig.element)!.querySelector<HTMLElement>("[data-db-region-owner]")!.click();
    answer(rig.element, "save");
    expect((rig.form.snapshot().children!.content!.find((node) => node.id === "fullName")!.configuration as { label?: unknown } | undefined)?.label).toBe("Your full name");
    expect(rig.journey().selectedComponentId()).toBe(rig.page.id);
    expect(propsEl(rig.element).controller).toBe(rig.journey());
    expect(prompt(rig.element)).toBeNull();
  }, 30_000);

  it("guards the keyboard walk and Escape the same way, and Discard lets the move through", async () => {
    const rig = await drafted();
    const page = canvasEl(rig.element).shadowRoot!.querySelector<HTMLElement>(".canvas-page")!;
    page.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(prompt(rig.element)).toBeTruthy();
    expect(rig.journey().selectedComponentId()).toBe(rig.placementId);
    answer(rig.element, "discard");
    expect(rig.journey().selectedComponentId()).toBeUndefined();
    expect(rig.form.hasPendingChanges("fullName")).toBe(false);
    expect((rig.form.snapshot().children!.content!.find((node) => node.id === "fullName")!.configuration as { label?: unknown } | undefined)?.label).toBe("Full name");
  }, 30_000);

  it("guards Take it off and the bar's Delete: Keep editing keeps the placement and the draft, Apply applies and takes it off", async () => {
    const rig = await drafted();
    const content = (): string[] => (rig.pageNode("about").children?.content ?? []).map((node) => node.id);
    takeOffButton(rig.element)!.click();
    expect(prompt(rig.element)).toBeTruthy();
    expect(content()).toContain(rig.placementId);
    answer(rig.element, "stay");
    expect(content()).toContain(rig.placementId);
    expect(rig.form.hasPendingChanges("fullName")).toBe(true);
    canvasEl(rig.element).shadowRoot!.querySelector<HTMLElement>('[data-selection-action="delete"]')!.click();
    expect(prompt(rig.element)).toBeTruthy();
    expect(content()).toContain(rig.placementId);
    answer(rig.element, "save");
    expect(content()).not.toContain(rig.placementId);
    expect((rig.form.snapshot().children!.content!.find((node) => node.id === "fullName")!.configuration as { label?: unknown } | undefined)?.label).toBe("Your full name");
    // One step on the journey's history for the take-off, the label on the form's.
    rig.journey().undo();
    expect(content()).toContain(rig.placementId);
    expect(rig.journey().canUndo()).toBe(false);
  }, 30_000);

  it("guards Move to… and a mode's own move (the step picker, Move to another step) through holdForInspector", async () => {
    const rig = await drafted();
    canvasEl(rig.element).shadowRoot!.querySelector<HTMLElement>('[data-selection-action="move"]')!.click();
    expect(prompt(rig.element)).toBeTruthy();
    answer(rig.element, "stay");
    await tick(50);
    expect(canvasEl(rig.element).shadowRoot!.querySelector("[data-move-prompt]")).toBeNull();
    // The mode's own: what the step picker calls before it shows another step.
    const context = (rig.element.journeyMode as unknown as { context: { holdForInspector(run: () => void): boolean } }).context;
    let shown = 0;
    expect(context.holdForInspector(() => (shown += 1))).toBe(false);
    expect(prompt(rig.element)).toBeTruthy();
    expect(shown).toBe(0);
    answer(rig.element, "save");
    expect(shown).toBe(1);
    // Nothing held: at once.
    expect(context.holdForInspector(() => (shown += 1))).toBe(true);
    expect(shown).toBe(2);
  }, 30_000);

  it("guards leaving the workspace: the inspector asks, Keep editing stays, Apply goes to Form with the label applied", async () => {
    const rig = await drafted();
    expect(rig.element.builder!.setWorkspace("form")).toBe(false);
    expect(prompt(rig.element)).toBeTruthy();
    expect(rig.element.builder!.workspace).toBe("journeys");
    answer(rig.element, "stay");
    expect(rig.element.builder!.workspace).toBe("journeys");
    expect(rig.form.hasPendingChanges("fullName")).toBe(true);
    expect(rig.element.builder!.setWorkspace("form")).toBe(false);
    answer(rig.element, "save");
    await until(() => rig.element.builder!.workspace === "form");
    expect((rig.form.snapshot().children!.content!.find((node) => node.id === "fullName")!.configuration as { label?: unknown } | undefined)?.label).toBe("Your full name");
    expect(propsEl(rig.element).controller).toBe(rig.form);
    expect(takeOffButton(rig.element)).toBeNull();
  }, 30_000);

  it("keeps a draft in sight when the journey's selection moves by a path that did not ask (the outline, an agent)", async () => {
    const rig = await drafted();
    // As the outline's row does: the journey's own guard knows nothing of the form's draft.
    rig.journey().requestSelect(rig.page.id);
    expect(propsEl(rig.element).controller).toBe(rig.form);
    expect(prompt(rig.element)).toBeTruthy();
    expect(labelBox(rig.element)?.value ?? rig.form.draftProperty("fullName", "label")).toBe("Your full name");
    // Keep editing puts the journey's selection back on the placement.
    answer(rig.element, "stay");
    expect(rig.journey().selectedComponentId()).toBe(rig.placementId);
    expect(rig.form.hasPendingChanges("fullName")).toBe(true);
    // Again, and Discard: the move goes through.
    rig.journey().requestSelect(rig.page.id);
    answer(rig.element, "discard");
    expect(rig.journey().selectedComponentId()).toBe(rig.page.id);
    expect(propsEl(rig.element).controller).toBe(rig.journey());
  }, 30_000);

  it("a press on the picker's next draws the next step with its selection, not the selection on the old step first", async () => {
    const rig = await stepRig();
    const canvas = canvasEl(rig.element).shadowRoot!;
    const contact = rig.pageNode("contact");
    const cost = await costOf(rig.element, () => canvas.querySelector<HTMLElement>('[data-stepper-go="1"]')!.click());
    expect(rig.journey().canvasRootId()).toBe(contact.id);
    expect(rig.journey().selectedComponentId()).toBe(contact.id);
    // The new step's tree, then its hooks over it (each a draw of the renderer's), the selection not drawn on the old step first.
    expect(cost.draws).toBeLessThanOrEqual(2);
  }, 30_000);

  it("Take it off this step leaves focus on the step, not nowhere; a keyboard Delete keeps it on the sheet", async () => {
    const rig = await stepRig();
    const deep = (): Element | null => {
      let active: Element | null = document.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    };
    const content = (): string[] => (rig.pageNode("about").children?.content ?? []).map((node) => node.id);
    // The inspector's button goes with the inspector it sat in: focus falls, and is put on the step's sheet (the step held only that field).
    const placementId = await selectPlacement(rig);
    await until(() => takeOffButton(rig.element));
    const button = takeOffButton(rig.element)!;
    button.focus();
    button.click();
    expect(content()).not.toContain(placementId);
    await until(() => deep()?.classList.contains("canvas-page") === true);
    // The keyboard's Delete is pressed on the sheet, and focus stays there.
    rig.journey().undo();
    await until(() => content().includes(placementId) && sheet(rig.element)?.querySelector(`.db-node[data-component-id="${placementId}"]`));
    await selectPlacement(rig);
    const page = canvasEl(rig.element).shadowRoot!.querySelector<HTMLElement>(".canvas-page")!;
    page.focus();
    page.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, composed: true }));
    expect(content()).not.toContain(placementId);
    await tick(100);
    expect(deep()).toBe(page);
  }, 30_000);

  it("guards Map on the bar: asked before the map comes, Keep editing keeps the step and asks nothing again, Apply goes to the map", async () => {
    const rig = await drafted();
    const mode = rig.element.journeyMode!;
    viewButton(rig.element, "map").click();
    expect(prompt(rig.element)).toBeTruthy();
    expect(mode.view).toBe("step");
    expect(propsEl(rig.element).controller).toBe(rig.form);
    answer(rig.element, "stay");
    expect(prompt(rig.element)).toBeNull();
    expect(mode.view).toBe("step");
    expect(rig.form.hasPendingChanges("fullName")).toBe(true);
    // An edit on the journey afterwards puts no prompt up again.
    rig.journey().setProperty(rig.journey().rootId(), "name", "Intake 2");
    await tick(50);
    expect(prompt(rig.element)).toBeNull();
    viewButton(rig.element, "map").click();
    answer(rig.element, "save");
    await until(() => mode.view === "map");
    expect((rig.form.snapshot().children!.content!.find((node) => node.id === "fullName")!.configuration as { label?: unknown } | undefined)?.label).toBe("Your full name");
    expect(prompt(rig.element)).toBeNull();
  }, 30_000);

  it("keeps a draft in view, asked once, when the Step view goes away by a path that did not ask", async () => {
    const rig = await drafted();
    // The Step view put away under the inspector, the journey's selection left where it was.
    const entries = (rig.element.journeyMode as unknown as { entries: Map<string, { step?: { leave(): void } }> }).entries;
    entries.get("intake")!.step!.leave();
    expect(prompt(rig.element)).toBeTruthy();
    answer(rig.element, "stay");
    expect(prompt(rig.element)).toBeNull();
    expect(rig.form.hasPendingChanges("fullName")).toBe(true);
    // Not asked again on every later change of the journey's.
    rig.journey().setProperty(rig.journey().rootId(), "name", "Intake 2");
    await tick(50);
    expect(prompt(rig.element)).toBeNull();
    expect(propsEl(rig.element).controller).toBe(rig.form);
  }, 30_000);

  it("a press on the step's actions opens Wording by the canvas's own region mark, and only once the inspector's guard lets it through", async () => {
    const rig = await drafted();
    const wording = (): HTMLDetailsElement | null => properties(rig.element).querySelector<HTMLDetailsElement>('[data-inspector-section="wording"]');
    const actions = (): HTMLElement => sheet(rig.element)!.querySelector<HTMLElement>('[data-db-region="page-actions"]')!;
    // Held by the form field's draft: Keep editing opens nothing and selects nothing.
    actions().click();
    expect(prompt(rig.element)).toBeTruthy();
    answer(rig.element, "stay");
    expect(rig.journey().selectedComponentId()).toBe(rig.placementId);
    expect(wording()).toBeNull();
    rig.form.discardDraft("fullName");
    // A binding that marks none of its buttons: the region is the canvas's, and says it is the actions.
    rig.journey().select(rig.placementId);
    await settled(rig.element);
    const region = actions();
    for (const marked of region.querySelectorAll("[data-journey-continue], [data-journey-back]")) {
      marked.removeAttribute("data-journey-continue");
      marked.removeAttribute("data-journey-back");
    }
    region.click();
    await until(() => wording()?.open === true);
    expect(rig.journey().selectedComponentId()).toBe(rig.page.id);
  }, 30_000);
});

describe("the Step view's one Undo (shared history)", () => {
  type StepController = import("../../../engine/form-engine/builder/controller/builder-controller.js").BuilderController;
  type StepHistory = import("../../../engine/form-engine/builder/journey-designer/step-history.js").StepHistory;

  interface HistoryRig {
    element: DatumFormBuilderElement;
    form: StepController;
    journey: () => StepController;
    history: () => StepHistory | undefined;
    /** Takes the history down, as leaving the Step view does. */
    down(): void;
    page: { id: string | undefined };
    label(id: string): unknown;
    placed(componentId: string): boolean;
    place(componentId: string): void;
    relabel(id: string, label: string): void;
  }

  /** The Step view from the bar, with the mode's own history. */
  async function historyRig(pageId = "about"): Promise<HistoryRig> {
    const element = mount((el) => {
      el.definition = withJourneys();
    });
    await ready(element);
    const mode = element.journeyMode!;
    const form = element.builder!.controller as StepController;
    const journey = (): StepController => mode.controller as StepController;
    await openJourneys(element);
    const pageNode = (id: string) =>
      (journey().snapshot().children?.pages ?? []).find((node) => (node.configuration as { pageId?: string }).pageId === id)! as {
        id: string;
        children?: Record<string, Array<{ id: string; type: string; configuration?: Record<string, unknown> }>>;
      };
    viewButton(element, "step").click();
    await until(() => mode.view === "step");
    if (pageId !== "about") {
      journey().select(pageNode(pageId).id);
    }
    const page = {
      get id(): string | undefined {
        return journey().canvasRootId();
      }
    };
    const content = () => pageNode(pageId).children?.content ?? [];
    const placementOf = (componentId: string) => content().find((node) => node.type === "journey-field" && node.configuration?.componentId === componentId);
    await until(() => sheet(element)?.querySelector(`.db-node[data-component-id="${placementOf("fullName")!.id}"]`));
    return {
      element,
      form,
      journey,
      history: () => mode.history?.() as StepHistory | undefined,
      // Leaving the Step view takes the history down.
      down: () => {
        mode.view = "map";
      },
      page,
      label: (id) => (form.snapshot().children!.content!.find((node) => node.id === id)!.configuration as { label?: unknown } | undefined)?.label,
      placed: (componentId) => placementOf(componentId) !== undefined,
      place: (componentId) => {
        journey().add("journey-field", page.id!, "content", { configuration: { componentId } });
        expect(journey().dropError).toBeUndefined();
      },
      relabel: (id, label) => {
        form.setDraftProperty(id, "label", label);
        expect(form.commitDraft(id)).toBe(true);
      }
    };
  }

  const bar = (element: DatumFormBuilderElement, which: "undo" | "redo") => shell(element).querySelector<HTMLButtonElement>(`[data-${which}]`)!;
  const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const zKey = (target: EventTarget, shift = false): void => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: shift, bubbles: true, composed: true, cancelable: true }));
  };

  it("the bar's Undo and Redo take back and make again a form field's edit made from the Step view, and follow it although the bar is bound to the journey", async () => {
    const rig = await historyRig();
    const before = rig.label("fullName");
    expect(rig.journey().canUndo()).toBe(false);
    expect(bar(rig.element, "undo").disabled).toBe(true);
    rig.relabel("fullName", "Your full name");
    await turn();
    // Only the history can undo it: the journey's own history is empty.
    expect(rig.journey().canUndo()).toBe(false);
    expect(bar(rig.element, "undo").disabled).toBe(false);
    expect(bar(rig.element, "redo").disabled).toBe(true);
    bar(rig.element, "undo").click();
    expect(rig.label("fullName")).toBe(before);
    expect(bar(rig.element, "undo").disabled).toBe(true);
    expect(bar(rig.element, "redo").disabled).toBe(false);
    bar(rig.element, "redo").click();
    expect(rig.label("fullName")).toBe("Your full name");
    expect(bar(rig.element, "undo").disabled).toBe(false);
    expect(bar(rig.element, "redo").disabled).toBe(true);
  }, 30_000);

  it("the canvas's and the outline's keys, the command palette and the element's undo() and redo() all go through it, in the order the author worked", async () => {
    const rig = await historyRig();
    const before = rig.label("fullName");
    rig.place("country");
    await turn();
    rig.relabel("fullName", "Your full name");
    await turn();
    expect(rig.history()!.entries()).toEqual([[rig.journey()], [rig.form]]);
    // The canvas's Cmd+Z: the label (the form's), not the drop (the journey's, its own top).
    const canvas = shell(rig.element).querySelector("datum-builder-canvas")!;
    zKey(canvas.shadowRoot!);
    expect(rig.label("fullName")).toBe(before);
    expect(rig.placed("country")).toBe(true);
    // The outline's Cmd+Shift+Z makes it again (opened from the strip: a hidden panel is not drawn, nor bound).
    shell(rig.element).querySelector<HTMLElement>('[data-strip] [data-panel="outline"]')!.click();
    const outline = shell(rig.element).querySelector<HTMLElement>(".outline")!;
    await until(() => outline.shadowRoot!.querySelector("[data-tree-select]"));
    zKey(outline.shadowRoot!, true);
    expect(rig.label("fullName")).toBe("Your full name");
    // The palette's Undo, its enabled() first.
    const commands = (rig.element.builder as unknown as { paletteCommands(): Array<{ id: string; enabled?: () => boolean; run(): void }> }).paletteCommands();
    const command = (id: string) => commands.find((entry) => entry.id === id)!;
    expect(command("edit:undo").enabled!()).toBe(true);
    command("edit:undo").run();
    expect(rig.label("fullName")).toBe(before);
    command("edit:undo").run();
    expect(rig.placed("country")).toBe(false);
    expect(command("edit:undo").enabled!()).toBe(false);
    expect(command("edit:redo").enabled!()).toBe(true);
    // The element's public redo(), twice: the drop, then the label.
    rig.element.redo();
    expect(rig.placed("country")).toBe(true);
    expect(rig.label("fullName")).toBe(before);
    rig.element.redo();
    expect(rig.label("fullName")).toBe("Your full name");
    expect(command("edit:redo").enabled!()).toBe(false);
    rig.element.undo();
    expect(rig.label("fullName")).toBe(before);
  }, 30_000);

  it("an agent's own step (historyStep with own) is the form's top step taken through the history, the person's newer journey step left", async () => {
    const rig = await historyRig();
    const before = rig.label("fullName");
    rig.relabel("fullName", "Your full name");
    await turn();
    rig.place("country");
    await turn();
    rig.element.builder!.historyStep("undo", rig.form, { own: true });
    expect(rig.label("fullName")).toBe(before);
    expect(rig.placed("country")).toBe(true);
    // Taken through the history, so it stays the history's: its Redo is there, beside the drop's Undo.
    expect(rig.history()!.canRedo()).toBe(true);
    expect(rig.history()!.entries()).toEqual([[rig.journey()]]);
    bar(rig.element, "undo").click();
    expect(rig.placed("country")).toBe(false);
    expect(rig.label("fullName")).toBe(before);
    rig.element.builder!.historyStep("redo", rig.form, { own: true });
    expect(rig.label("fullName")).toBe("Your full name");
    expect(rig.placed("country")).toBe(false);
  }, 30_000);

  it("with the history down (outside the Step view) the bar still undoes the newest first: the form's label made in the Step view, then the journey's drop", async () => {
    const rig = await historyRig();
    rig.place("country");
    await turn();
    rig.relabel("fullName", "Your full name");
    await turn();
    const before = rig.form.snapshot();
    rig.down();
    expect(bar(rig.element, "undo").disabled).toBe(false);
    bar(rig.element, "undo").click();
    // The form's label, the newest thing done in the designer, goes first; the journey's drop stays.
    expect(rig.label("fullName")).not.toBe("Your full name");
    expect(rig.placed("country")).toBe(true);
    bar(rig.element, "undo").click();
    expect(rig.placed("country")).toBe(false);
    expect(bar(rig.element, "undo").disabled).toBe(true);
    // Redo the same way back: the drop, then the label.
    bar(rig.element, "redo").click();
    expect(rig.placed("country")).toBe(true);
    bar(rig.element, "redo").click();
    expect(rig.form.snapshot()).toEqual(before);
  }, 30_000);
});

/*
 * The Step view on the bar and its palette, through the controls
 * an author uses: the Map | Step switch, the picker on the canvas bar, the palette's entries.
 */
describe("the Step view on the bar and its palette", () => {
  async function onMap(): Promise<DatumFormBuilderElement> {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    element.mode = "journeys";
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    return element;
  }

  const toolbar = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-toolbar")!.shadowRoot!;
  const listed = (element: DatumFormBuilderElement): string[] => [...toolbar(element).querySelectorAll<HTMLElement>("[data-add-type]")].map((entry) => entry.dataset.addType!);
  const groups = (element: DatumFormBuilderElement): string[] => [...toolbar(element).querySelectorAll<HTMLElement>(".palette-list summary")].map((entry) => entry.textContent!.replace(/\s+/g, " ").trim());

  it("opens on the map with Map | Step on the bar, and nothing else; Step draws the step as the person sees it with a picker, the back link and no Edit | Preview switch", async () => {
    const element = await onMap();
    const mode = element.journeyMode!;
    expect(mode.view).toBe("map");
    const buttons = [...shell(element).querySelectorAll<HTMLElement>("[data-journey-views] [data-journey-view]")];
    expect(buttons.map((button) => [button.dataset.journeyView, button.hidden, button.getAttribute("aria-pressed")])).toEqual([
      ["map", false, "true"],
      ["step", false, "false"]
    ]);
    expect(buttons[1]!.textContent).toBe("Step");

    viewButton(element, "step").click();
    await until(() => mode.view === "step" && sheet(element)?.querySelector("[data-journey-continue]"));
    // The step's own chrome on the form's sheet: its heading, its buttons, each one box that selects the step.
    expect(sheet(element)!.querySelectorAll("[data-db-region]")).toHaveLength(2);
    // The picker: Step 1 of 2 and its name, previous off, next on.
    const canvas = canvasRoot(element);
    const picker = canvas.querySelector<HTMLElement>("[data-canvas-stepper]")!;
    expect(picker.hidden).toBe(false);
    expect(canvas.querySelector("[data-stepper-text]")!.textContent).toBe("Step 1 of 2 · About you");
    expect(canvas.querySelector<HTMLButtonElement>('[data-stepper-go="-1"]')!.disabled).toBe(true);
    expect(canvas.querySelector<HTMLButtonElement>('[data-stepper-go="1"]')!.disabled).toBe(false);
    // The way back to the journeys list is the bar's, as in the other designers; no Edit | Preview switch beside Try it.
    expect(shell(element).querySelector<HTMLElement>("[data-overview-back]")!.textContent).toBe("‹ Journeys");
    expect(canvas.querySelector("[data-canvas-bar] [data-segmented]")).toBeNull();
    expect(canvas.querySelector("[data-try-it]")).not.toBeNull();

    // The next step: its name, the sheet drawn on it, the step selected for the inspector.
    canvas.querySelector<HTMLElement>('[data-stepper-go="1"]')!.click();
    await until(() => canvas.querySelector("[data-stepper-text]")!.textContent === "Step 2 of 2 · Keeping in touch");
    const controller = mode.controller;
    const [, second] = controller.snapshot().children!.pages!;
    expect(controller.selectedComponentId()).toBe(second!.id);
    await until(() => sheet(element)?.querySelector(`.db-node[data-component-id="${second!.children!.content![0]!.id}"]`));
    expect(sheet(element)!.querySelector("[data-journey-continue]")!.textContent).toMatch(/Submit|Send/);

    // Leaving it: the map, no picker, nothing of the step left on the controller.
    viewButton(element, "map").click();
    await until(() => canvasRoot(element).querySelector("[data-canvas-surface] [data-journey-map]") && canvas.querySelector<HTMLElement>("[data-canvas-stepper]")!.hidden);
    expect(controller.canvasStepper()).toBeUndefined();
    expect(controller.canvasRootId()).toBe(controller.rootId());
  }, 30_000);

  const canvasEl = (element: DatumFormBuilderElement): HTMLElement => shell(element).querySelector("datum-builder-canvas") as HTMLElement;

  it("draws the step in a dark builder's dark scheme, as the Form canvas draws the form", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.setAttribute("scheme", "dark");
      el.definition = withJourneys();
    });
    await ready(element);
    element.mode = "journeys";
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    viewButton(element, "step").click();
    await until(() => element.journeyMode!.view === "step" && sheet(element)?.querySelector("[data-journey-continue]"));
    const renderer = canvasEl(element).shadowRoot!.querySelector<HTMLElement & { colorScheme?: string }>("[data-preview]")!;
    expect(element.builder!.controller.canvasColorScheme()).toBe("dark");
    await until(() => renderer.colorScheme === "dark");
  }, 30_000);

  it("words Map and Step on the bar from the builder's text tables, as a translated builder words them", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    element.builder!.textCatalog = {
      en: {
        "journey.mode.view.group": "Ce que montre le canevas",
        "journey.mode.view.map": "Carte",
        "journey.mode.view.mapTitle": "Tous les chemins",
        "journey.mode.view.step": "Étape"
      }
    };
    element.mode = "journeys";
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    const group = shell(element).querySelector<HTMLElement>("[data-journey-views]")!;
    await until(() => viewButton(element, "map").textContent === "Carte");
    expect(group.getAttribute("aria-label")).toBe("Ce que montre le canevas");
    expect([...group.querySelectorAll<HTMLElement>("[data-journey-view]")].map((button) => [button.textContent, button.title])).toEqual([
      ["Carte", "Tous les chemins"],
      ["Étape", "Edit one step as the person sees it: its fields, heading and buttons"]
    ]);
  }, 30_000);

  it("opens the step's Wording section when its buttons are pressed on the canvas, not its heading", async () => {
    const element = await onMap();
    viewButton(element, "step").click();
    await until(() => element.journeyMode!.view === "step" && sheet(element)?.querySelector("[data-db-region]"));
    const wording = (): HTMLDetailsElement | null => properties(element).querySelector<HTMLDetailsElement>('[data-inspector-section="wording"]');
    const region = (name: string): HTMLElement => sheet(element)!.querySelector<HTMLElement>(`[data-db-region="${name}"]`)!;
    const regions = [...sheet(element)!.querySelectorAll<HTMLElement>("[data-db-region]")];
    const buttons = regions.find((box) => box.querySelector("[data-journey-continue], [data-journey-back]"))!;
    const heading = regions.find((box) => !box.querySelector("[data-journey-continue], [data-journey-back]"))!;
    expect(region).toBeDefined();

    heading.click();
    await until(() => wording() !== null);
    expect(element.journeyMode!.controller.selectedComponentId()).toBe(element.journeyMode!.controller.canvasRootId());
    expect(wording()!.open).toBe(false);

    buttons.click();
    await until(() => wording()?.open === true);
    // Another selection folds it again.
    const controller = element.journeyMode!.controller;
    controller.select(controller.snapshot().children!.pages![0]!.children!.content![0]!.id);
    controller.select(controller.canvasRootId());
    await until(() => wording()?.open === false);
  }, 30_000);

  it("lists the journey-only fields in the Form workspace's groups and the worked-out value, hides Step, Form field and Route, and gives them back on the map", async () => {
    const element = await onMap();
    await until(() => listed(element).length > 0);
    // On the map the palette is whole.
    expect(listed(element)).toEqual(expect.arrayContaining(["journey-page", "journey-field", "journey-route", "journey-value", "text"]));

    viewButton(element, "step").click();
    await until(() => element.journeyMode!.view === "step" && !listed(element).includes("journey-page"));
    expect(listed(element)).not.toContain("journey-field");
    expect(listed(element)).not.toContain("journey-route");
    expect(listed(element)).toEqual(expect.arrayContaining(["journey-value", "text", "select"]));
    // What a journey-only field may not be is not listed (data-scoping, files, repeating sections).
    for (const type of ["file", "repeatingSection", "dataGrid", "signature", "container", "steps"]) {
      expect(listed(element)).not.toContain(type);
    }
    // Fields, Choices, Layout… as the Form workspace names them and in its order, no
    // Journey-only prefix; the worked-out value keeps a group of its own, after them.
    expect(groups(element)).toEqual(["Fields4", "Choices4", "Layout5", "Content2", "Actions1", "Journey1"]);
    expect(groups(element).join("|")).not.toContain("Journey-only");
    expect(groups(element).join("|")).not.toContain("Page-only");

    // One click on a journey-only entry puts it on the shown step: one undo, tagged Not sent on the sheet.
    const controller = element.journeyMode!.controller;
    const first = controller.snapshot().children!.pages![0]!;
    const before = first.children!.content!.length;
    toolbar(element).querySelector<HTMLElement>('[data-add-type="text"]')!.click();
    const added = controller.selectedComponentId()!;
    expect(controller.snapshot().children!.pages![0]!.children!.content!.map((node) => node.id)).toContain(added);
    expect(controller.snapshot().children!.pages![0]!.children!.content).toHaveLength(before + 1);
    await until(() => sheet(element)?.querySelector(`.db-node[data-component-id="${added}"] .db-tag--note`)?.textContent === "Not sent");
    controller.undo();
    expect(controller.snapshot().children!.pages![0]!.children!.content).toHaveLength(before);

    viewButton(element, "map").click();
    await until(() => listed(element).includes("journey-page"));
    expect(listed(element)).toEqual(expect.arrayContaining(["journey-field", "journey-route"]));
  }, 30_000);
});

describe("the Journey panel's findings card, the blank start and the settings", () => {
  /** The sample form with no journey, then one made blank: one empty step, the form's required field its first error. */
  async function blankJourney(): Promise<DatumFormBuilderElement> {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = sampleDefinition();
    });
    await ready(element);
    await until(() => element.journeyMode !== undefined);
    await element.journeyMode!.newJourney({ name: "Quick", from: "blank" });
    element.mode = "journeys";
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    return element;
  }

  const card = (element: DatumFormBuilderElement): HTMLElement | null => formPanel(element).querySelector<HTMLElement>("[data-mode-findings]");
  const findings = (element: DatumFormBuilderElement): Array<{ severity: string; text: string; fixes: string[] }> =>
    [...(card(element)?.querySelectorAll<HTMLElement>("[data-finding]") ?? [])].map((item) => ({
      severity: item.dataset.severity!,
      text: item.querySelector(".mode-finding-text")!.textContent!.trim(),
      fixes: [...item.querySelectorAll("[data-finding-fix]")].map((button) => button.textContent!)
    }));

  it("lists the errors then the warnings at the top of the Journey panel from the start of a blank journey, each error with its fixes", async () => {
    const element = await blankJourney();
    await until(() => card(element));
    const listed = findings(element);
    const severities = listed.map((entry) => entry.severity);
    expect(severities).toEqual([...severities].sort((a, b) => (a === b ? 0 : a === "error" ? -1 : 1)));
    expect(listed[0]).toEqual({
      severity: "error",
      text: "Full name is required and is not asked in this journey. A submission is refused.",
      fixes: ["Ask it here", "Make it optional on the form"]
    });
    // A field that is not required is a warning with no button.
    const country = listed.find((entry) => entry.text === "Country is not asked in this journey.")!;
    expect(country).toMatchObject({ severity: "warning", fixes: [] });
    // At the top: the card is the first thing in the panel's body, over the settings.
    const body = formPanel(element).querySelector<HTMLElement>(".inspector-body")!;
    expect(body.firstElementChild!.matches("[data-mode-findings]")).toBe(true);
    expect(body.querySelector("[data-mode-findings]")!.compareDocumentPosition(body.querySelector("[data-inspector-section]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The map says it too: one step, its errors from the start.
    await until(() => canvasRoot(element).querySelector("[data-canvas-surface] [data-journey-map]"));
    expect(element.journeyMode!.view).toBe("map");
    expect(canvasRoot(element).querySelector("[data-journey-map]")!.textContent).toMatch(/1 step/);
    expect(canvasRoot(element).querySelector("[data-journey-map]")!.textContent).toMatch(/error/);
  });

  it("asks the field from its finding in one undo, and the finding goes; Make it optional on the form opens the field on the Form tab", async () => {
    const element = await blankJourney();
    await until(() => card(element));
    const fix = (label: string): HTMLElement => [...card(element)!.querySelectorAll<HTMLElement>("[data-finding-fix]")].find((button) => button.textContent === label)!;
    fix("Ask it here").click();
    await until(() => pageComponents(journeyOf(element.definition, "quick")).flat().includes("fullName"));
    await until(() => !findings(element).some((entry) => entry.text.startsWith("Full name is required")));
    element.undo();
    await until(() => !pageComponents(journeyOf(element.definition, "quick")).flat().includes("fullName"));
    await until(() => findings(element).some((entry) => entry.text.startsWith("Full name is required")));

    fix("Make it optional on the form").click();
    await until(() => element.builder!.mode === "form");
    expect(element.builder!.controller.selectedComponentId()).toBe("fullName");
    // Nothing was edited for the author.
    expect(element.builder!.controller.getProperty("fullName", "required")).toBe(true);
  });

  it("moves focus after each fix to the finding now in its place, else to the panel, never to the page (WCAG 2.4.3)", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    await openJourneys(element);
    // Two questions whose form fields are gone: two findings with Remove.
    element.builder!.controller.remove("subscribe");
    element.builder!.controller.remove("fullName");
    await until(() => (card(element)?.querySelectorAll('[data-fix-id="remove"]').length ?? 0) === 2);
    const deepActive = (): Element | null => {
      let active: Element | null = document.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    };
    const removes = (): HTMLElement[] => [...(card(element)?.querySelectorAll<HTMLElement>('[data-fix-id="remove"]') ?? [])];
    const first = removes()[0]!;
    const pressed = first.closest<HTMLElement>("[data-finding]")!;
    const nextId = removes()[1]!.closest<HTMLElement>("[data-finding]")!.dataset.finding;
    expect(pressed.dataset.finding).not.toBe(nextId);
    first.focus();
    first.click();
    await until(() => removes().length === 1);
    // The finding now in the pressed one's place: its text button, which selects its question.
    await until(() => formPanel(element).activeElement?.closest("[data-finding]") != null);
    expect(first.isConnected).toBe(false);
    expect((formPanel(element).activeElement as HTMLElement).closest<HTMLElement>("[data-finding]")!.dataset.finding).toBe(nextId);
    expect(deepActive()).not.toBe(document.body);
    // The last fix: no finding with a button is left, so focus goes to the panel itself.
    const last = removes()[0]!;
    last.focus();
    last.click();
    await until(() => removes().length === 0);
    await until(() => formPanel(element).activeElement != null);
    expect(last.isConnected).toBe(false);
    expect(formPanel(element).activeElement!.isConnected).toBe(true);
    expect(deepActive()).not.toBe(document.body);
  });

  it("sets what the form opens as from the Journey panel at once, the whole form or a journey by name, and keeps the select focused", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    await openJourneys(element);
    const select = (): HTMLSelectElement | null => formPanel(element).querySelector<HTMLSelectElement>('select[data-mode-choice="journeys.opensAs"]');
    await until(() => select());
    const label = formPanel(element).querySelector<HTMLLabelElement>(`label[for="${select()!.id}"]`)!;
    expect(label.textContent).toBe("The form opens as");
    expect([...select()!.options].map((option) => [option.value, option.textContent])).toEqual([
      ["form", "The whole form"],
      ["intake", "Intake"],
      ["quick", "Quick"]
    ]);
    // The block says it opens whole.
    expect(select()!.value).toBe("form");
    select()!.focus();
    select()!.value = "quick";
    select()!.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    // Committed at once: no Apply.
    await until(() => (element.definition.journey as JourneyConfiguration | undefined)?.defaultJourneyId === "quick");
    expect((element.definition.journey as JourneyConfiguration).opensAs).toBe("journey");
    await until(() => select()?.value === "quick");
    expect(formPanel(element).activeElement).toBe(select());
    select()!.value = "form";
    select()!.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await until(() => (element.definition.journey as JourneyConfiguration | undefined)?.opensAs === "form");
    expect(entry(element, "quick").isDefault).toBe(false);
  });

  it("selects a finding's node when the finding is pressed, and says nothing again under a keystroke typed elsewhere", async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = withJourneys();
    });
    await ready(element);
    await openJourneys(element);
    const mode = element.journeyMode!;
    // A step with a question whose component is gone: its finding names the question's node.
    element.builder!.controller.remove("subscribe");
    await until(() => findings(element).some((entry) => entry.fixes.includes("Remove")));
    const pressed = [...card(element)!.querySelectorAll<HTMLElement>("[data-finding]")].find((item) => item.querySelector('[data-fix-id="remove"]'))!;
    pressed.querySelector<HTMLElement>("[data-finding-select]")!.click();
    const question = mode.controller.snapshot().children!.pages![1]!.children!.content![0]!.id;
    expect(mode.controller.selectedComponentId()).toBe(question);

    // A draft typed into another box repaints nothing in the panel: the card is not drawn per keystroke.
    const root = formPanel(element);
    const watcher = new MutationObserver(() => undefined);
    watcher.observe(root, { childList: true, subtree: true, characterData: true });
    const first = mode.controller.snapshot().children!.pages![0]!.id;
    mode.controller.setDraftProperty(first, "title", "About you, again");
    mode.controller.setDraftProperty(first, "title", "About you, once more");
    await Promise.resolve();
    expect(watcher.takeRecords().filter((record) => (record.target as Element).closest?.("[data-mode-findings]"))).toHaveLength(0);
    watcher.disconnect();
  });

  it("words the Journey panel: Journey, Validation with Move on, check at the end and Check each step on Continue, the progress setting, Wording", async () => {
    const element = await blankJourney();
    const panel = formPanel(element);
    await until(() => panel.querySelector('[data-inspector-section="validation"]'));
    const sectionTitles = [...panel.querySelectorAll<HTMLElement>("[data-inspector-section]")].map((section) => section.dataset.inspectorSection);
    expect(sectionTitles).toEqual(["journey", "validation", "wording"]);
    const text = panel.querySelector(".inspector-body")!.textContent!;
    expect(text).toContain("Progress");
    expect(text).toContain("Answers off the path");
    expect(text).toContain("On Continue");
    expect(text).toContain("Ask the host's server");
    const continueSelect = panel.querySelector<HTMLSelectElement>('[data-prop="validation.continue"]')!;
    expect([...continueSelect.options].map((option) => option.textContent)).toEqual(["Move on, check at the end", "Check each step on Continue"]);
    const progress = panel.querySelector<HTMLSelectElement>('[data-prop="progress"]')!;
    // The counter is the default: the blank choice counts the steps, None turns it off.
    expect([...progress.options].map((option) => [option.value, option.textContent])).toEqual([
      ["", "Count the steps: Step 2 of 5"],
      ["none", "None"]
    ]);
    expect(progress.value).toBe("");
    expect(panel.querySelector(".inspector-body")!.textContent).toContain("Each questions step is captioned with where it sits on the path, unless this is None.");
  });

  it("leaves a step's inspector at Step, Validation and Wording, with nothing about a condition of the step's own", async () => {
    const element = await blankJourney();
    const mode = element.journeyMode!;
    const step = mode.controller.snapshot().children!.pages![0]!;
    mode.controller.select(step.id);
    await until(() => properties(element).querySelector('[data-prop="pageId"]'));
    const root = properties(element);
    expect([...root.querySelectorAll<HTMLElement>("[data-inspector-section]")].map((section) => section.dataset.inspectorSection)).toEqual(["page", "validation", "wording"]);
    expect(root.querySelector<HTMLInputElement>('[data-prop="title"]')!.value).toBe("Step 1");
    expect(root.querySelector<HTMLInputElement>('[data-prop="pageId"]')!.value).toBe("step-1");
    const kind = root.querySelector<HTMLSelectElement>('[data-prop="kind"]')!;
    expect(kind.options[0]!.textContent).toBe("Questions");
    expect(root.querySelector('[data-prop="when"]')).toBeNull();
    expect(root.querySelector(".inspector-body")!.textContent).not.toMatch(/condition|shown when|skipped/i);
    // Its Go to rules are on its Logic tab, not in the Step tab.
    expect([...root.querySelectorAll<HTMLElement>('[role="tab"][data-inspector-tab]')].map((tab) => tab.textContent!.trim())).toEqual(["Step", "Logic"]);
  });
});
