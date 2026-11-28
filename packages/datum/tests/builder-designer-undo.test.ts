import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { sourceHash, type BuilderController, type FormDefinition, type PdfGeneratedLayout, type PdfRenderProvider, type PdfTemplateLayout } from "@argusvane/datum-engine";

import { modesReady, sampleDefinition, until } from "./helpers.js";

/*
 * A journey or a PDF layout deleted from the document's menu, and a test removed in the Tests
 * panel, are steps of the form's history. With a designer on the page the bar's Undo steps the
 * document there, so the modes answer `history` with the form's steps made while they are on the
 * page: the notes that say "Undo brings it back" hold where the author lands. The sample form has
 * translations, none of them the journeys' or the layouts': no translation moves with them.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function generated(id: string, name: string): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name,
    root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: `${id}-field`, type: "pdf-field", configuration: { componentId: "fullName" } }], header: [], footer: [] } }
  };
}

/** `third`: a third layout and journey, both "Third". `translated`: each document's name has its French wording. */
function mount(options: { third?: boolean; translated?: boolean } = {}): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  const sample = sampleDefinition();
  const french = (text: string, source: string) => ({ text, source: sourceHash(source) });
  element.definition = {
    ...sample,
    ...(options.translated
      ? {
          translations: {
            "fr-CA": {
              ...sample.translations!["fr-CA"],
              journeys: { intake: { name: french("Accueil", "Intake") }, quick: { name: french("Rapide", "Quick") } },
              pdf: { letter: { name: french("Lettre", "Letter") }, a4: { name: french("Format A4", "A4") } }
            }
          }
        }
      : {}),
    pdf: { layouts: [generated("letter", "Letter"), generated("a4", "A4"), ...(options.third ? [generated("third", "Third")] : [])] },
    journey: {
      journeys: [
        { id: "intake", name: "Intake", pages: [{ id: "about", components: ["fullName"] }] },
        { id: "quick", name: "Quick", pages: [{ id: "all", components: ["fullName"] }] },
        ...(options.third ? [{ id: "third", name: "Third", pages: [{ id: "x", components: ["fullName"] }] }] : [])
      ]
    },
    tests: { scenarios: [{ id: "one", source: 'test "One"\n  expect fullName visible' }] }
  } as FormDefinition;
  document.body.append(element);
  return element;
}

const layoutIds = (element: DatumFormBuilderElement): string[] => element.pdfMode!.layouts.map((entry) => entry.id);
const journeyIds = (element: DatumFormBuilderElement): string[] => element.journeyMode!.journeys.map((entry) => entry.id);
/** The first page of a journey's tree (the node a page title is set on). */
const pageNode = (controller: { snapshot(): { children?: Record<string, Array<{ id: string }>> } }): string => Object.values(controller.snapshot().children ?? {}).flat()[0]!.id;

function shell(element: DatumFormBuilderElement): ShadowRoot {
  return element.builder!.shadowRoot!;
}

/** Delete… on the menu of the document on the page, then Delete in its note. */
function removeShown(element: DatumFormBuilderElement): void {
  shell(element).querySelector<HTMLElement>("[data-document-menu]")!.click();
  const popover = shell(element).querySelector<HTMLElement>("[data-document-menu-popover]")!;
  popover.querySelector<HTMLElement>('[data-document-action="remove"]')!.click();
  expect(popover.querySelector("[data-remove-note]")!.textContent).toContain("Undo brings it back.");
  popover.querySelector<HTMLElement>('[data-document-action="remove"][data-confirm]')!.click();
}

const barUndo = (element: DatumFormBuilderElement): HTMLButtonElement => shell(element).querySelector<HTMLButtonElement>("[data-undo]")!;

async function opened(element: DatumFormBuilderElement, mode: "journeys" | "pdf"): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  await modesReady(element);
  element.mode = mode;
  await until(() => element.builder!.mode === mode && (mode === "pdf" ? element.pdfMode?.ready : element.journeyMode?.ready));
}

/** Removes the test through the Tests panel: the entry, Remove, then Remove in its note. */
async function removeTest(element: DatumFormBuilderElement): Promise<void> {
  if (!shell(element).querySelector("datum-builder-tests-panel:not([hidden])")) {
    shell(element).querySelector<HTMLElement>('[data-strip] [data-panel="tests"]')!.click();
  }
  await until(() => shell(element).querySelector("datum-builder-tests-panel")?.shadowRoot?.querySelector('[data-tests-entry="one"]'));
  const panel = shell(element).querySelector("datum-builder-tests-panel")!.shadowRoot!;
  panel.querySelector<HTMLElement>('[data-tests-entry="one"]')!.click();
  panel.querySelector<HTMLElement>("[data-tests-remove]")!.click();
  expect(panel.querySelector(".note.confirm")!.textContent).toContain("Undo brings it back.");
  panel.querySelector<HTMLElement>("[data-tests-remove-confirm]")!.click();
  await until(() => element.controller!.tests() === undefined);
}

describe("Undo from a designer reaches the form's steps made there", () => {
  it("brings a journey deleted from the menu back from the journey the page lands on, and Redo deletes it again", async () => {
    const element = mount();
    await opened(element, "journeys");
    removeShown(element);
    await until(() => element.journeyMode!.journeys.length === 1 && element.journeyMode!.ready);
    expect(element.journeyMode!.journeyId).toBe("quick");
    await until(() => !barUndo(element).disabled);
    barUndo(element).click();
    await until(() => element.journeyMode!.journeys.length === 2);
    expect(element.definition.journey?.journeys?.map((journey) => journey.id)).toEqual(["intake", "quick"]);
    // Still on the journey it landed on; nothing more to take back from here, and Redo deletes it again.
    expect(element.journeyMode!.journeyId).toBe("quick");
    expect(element.builder!.canHistoryStep("undo")).toBe(false);
    element.builder!.redo();
    expect(element.journeyMode!.journeys.map((journey) => journey.id)).toEqual(["quick"]);
    element.builder!.undo();
    // The last one deleted puts the overview up, the form on the page: its Undo brings it back.
    removeShown(element);
    await until(() => element.journeyMode!.journeys.length === 1 && element.journeyMode!.ready);
    removeShown(element);
    await until(() => element.builder!.mode === "form" && element.journeyMode!.journeys.length === 0);
    expect(element.builder!.workspace).toBe("journeys");
    element.builder!.undo();
    expect(element.journeyMode!.journeys.map((journey) => journey.id)).toEqual(["intake"]);
  }, 20_000);

  it("brings a journey deleted from the menu back with the Step view up", async () => {
    const element = mount();
    await opened(element, "journeys");
    element.journeyMode!.view = "step";
    await until(() => element.journeyMode!.history?.() !== undefined);
    removeShown(element);
    await until(() => element.journeyMode!.journeys.length === 1 && element.journeyMode!.ready);
    await until(() => element.builder!.canHistoryStep("undo"));
    element.builder!.undo();
    expect(element.journeyMode!.journeys.map((journey) => journey.id)).toEqual(["intake", "quick"]);
  }, 20_000);

  it("brings a PDF layout deleted from the menu back from the layout the page lands on, after an edit made there since", async () => {
    const element = mount();
    await opened(element, "pdf");
    removeShown(element);
    await until(() => element.pdfMode!.layouts.length === 1 && element.pdfMode!.ready);
    expect(element.pdfMode!.layoutId).toBe("a4");
    await until(() => !barUndo(element).disabled);
    // An edit on the page since is newer: the first Undo takes it back, the next the deletion.
    const layout = element.pdfMode!.controller;
    layout.setProperty(layout.rootId(), "name", "A4 edited");
    element.builder!.undo();
    expect(element.pdfMode!.layouts.map((entry) => entry.id)).toEqual(["a4"]);
    expect(element.pdfMode!.layouts[0]!.name).toBe("A4");
    element.builder!.undo();
    expect(element.pdfMode!.layouts.map((entry) => entry.id)).toEqual(["letter", "a4"]);
    expect(element.pdfMode!.layoutId).toBe("a4");
    // Redo goes the same way: the deletion again, then the edit.
    element.builder!.redo();
    expect(element.pdfMode!.layouts.map((entry) => entry.id)).toEqual(["a4"]);
    element.builder!.redo();
    expect(element.pdfMode!.layouts[0]!.name).toBe("A4 edited");
  }, 20_000);

  it("brings a test removed in the Tests panel back from a PDF layout and from a journey's map", async () => {
    for (const mode of ["pdf", "journeys"] as const) {
      const element = mount();
      await opened(element, mode);
      await removeTest(element);
      await until(() => !barUndo(element).disabled);
      barUndo(element).click();
      expect(element.controller!.tests()?.scenarios.map((scenario) => scenario.id)).toEqual(["one"]);
      element.remove();
    }
  }, 20_000);

  it("brings back a journey and a layout whose names are translated, their French wording with them", async () => {
    for (const mode of ["journeys", "pdf"] as const) {
      const element = mount({ translated: true });
      await opened(element, mode);
      const [kind, id] = mode === "journeys" ? (["journeys", "intake"] as const) : (["pdf", "letter"] as const);
      const wording = (): unknown => (element.definition.translations?.["fr-CA"] as Record<string, Record<string, unknown>> | undefined)?.[kind]?.[id];
      expect(wording()).toBeDefined();
      removeShown(element);
      await until(() => (mode === "journeys" ? journeyIds(element).length === 1 && element.journeyMode!.ready : layoutIds(element).length === 1 && element.pdfMode!.ready));
      expect(wording()).toBeUndefined();
      await until(() => !barUndo(element).disabled);
      barUndo(element).click();
      expect(mode === "journeys" ? journeyIds(element) : layoutIds(element)).toEqual(mode === "journeys" ? ["intake", "quick"] : ["letter", "a4"]);
      expect(wording()).toBeDefined();
      // One step: nothing more to take back from here.
      expect(element.builder!.canHistoryStep("undo")).toBe(false);
      element.remove();
    }
  }, 20_000);

  it("brings back two documents deleted in a row, the newest first, the bar's Undo enabled for each", async () => {
    for (const mode of ["journeys", "pdf"] as const) {
      const element = mount({ third: true });
      await opened(element, mode);
      const listed = (): string[] => (mode === "journeys" ? journeyIds(element) : layoutIds(element));
      const ready = (): boolean => (mode === "journeys" ? element.journeyMode!.ready : element.pdfMode!.ready);
      removeShown(element);
      await until(() => listed().length === 2 && ready());
      removeShown(element);
      await until(() => listed().length === 1 && ready());
      await until(() => !barUndo(element).disabled);
      element.builder!.undo();
      expect(listed()).toHaveLength(2);
      await until(() => !barUndo(element).disabled);
      expect(element.builder!.canHistoryStep("undo")).toBe(true);
      barUndo(element).click();
      expect(listed()).toEqual(mode === "journeys" ? ["intake", "quick", "third"] : ["letter", "a4", "third"]);
      expect(element.controller!.canUndo()).toBe(false);
      element.remove();
    }
  }, 30_000);

  it("takes back a layout deletion from another layout first, ahead of that layout's older edit", async () => {
    const element = mount({ third: true });
    await opened(element, "pdf");
    await element.builder!.selectDocument("pdf", "third");
    await until(() => element.pdfMode!.layoutId === "third" && element.pdfMode!.ready);
    const third = element.pdfMode!.controller;
    third.setProperty(third.rootId(), "name", "Third edited");
    await element.builder!.selectDocument("pdf", "letter");
    await until(() => element.pdfMode!.layoutId === "letter" && element.pdfMode!.ready);
    removeShown(element);
    await until(() => layoutIds(element).length === 2 && element.pdfMode!.ready);
    await element.builder!.selectDocument("pdf", "third");
    await until(() => element.pdfMode!.layoutId === "third" && element.pdfMode!.ready);
    element.builder!.undo();
    expect(layoutIds(element)).toEqual(["letter", "a4", "third"]);
    expect(element.pdfMode!.layouts.find((entry) => entry.id === "third")!.name).toBe("Third edited");
    // Then the older edit on the page.
    element.builder!.undo();
    expect(element.pdfMode!.layouts.find((entry) => entry.id === "third")!.name).toBe("Third");
  }, 20_000);

  it("takes back a test removed in the Step view from the map, ahead of an older journey edit", async () => {
    const element = mount();
    await opened(element, "journeys");
    const journey = element.journeyMode!.controller;
    journey.setProperty(pageNode(journey), "title", "Older edit");
    element.journeyMode!.view = "step";
    await until(() => element.journeyMode!.history?.() !== undefined);
    await removeTest(element);
    element.journeyMode!.view = "map";
    await until(() => element.journeyMode!.view === "map");
    element.builder!.undo();
    expect(element.controller!.tests()?.scenarios.map((scenario) => scenario.id)).toEqual(["one"]);
    expect(element.journeyMode!.journeys[0]!.pages[0]!.title).toBe("Older edit");
  }, 20_000);

  it("takes back a layout copy the page was on, keeping the original's history and the copy's Redo", async () => {
    const element = mount();
    await opened(element, "pdf");
    const letter = element.pdfMode!.controller;
    letter.setProperty(letter.rootId(), "name", "Letter edited");
    element.pdfMode!.duplicateLayout("letter", { select: true });
    await until(() => layoutIds(element).length === 3 && element.pdfMode!.ready);
    element.builder!.undo();
    await until(() => element.pdfMode!.layoutId === "letter" && element.pdfMode!.ready);
    expect(layoutIds(element)).toEqual(["letter", "a4"]);
    expect(element.pdfMode!.controller).toBe(letter);
    expect(element.builder!.canHistoryStep("redo")).toBe(true);
    // The original's own edit is still there to take back.
    element.builder!.undo();
    expect(element.pdfMode!.layouts[0]!.name).toBe("Letter");
    // Redo: the edit, then the copy.
    element.builder!.redo();
    expect(element.pdfMode!.layouts[0]!.name).toBe("Letter edited");
    element.builder!.redo();
    expect(layoutIds(element)).toHaveLength(3);
  }, 20_000);

  it("takes back a journey copy the page was on, keeping the original's history (as the layouts do)", async () => {
    const element = mount();
    await opened(element, "journeys");
    const intake = element.journeyMode!.controller;
    intake.setProperty(pageNode(intake), "title", "Edited");
    element.journeyMode!.duplicateJourney("intake", { select: true });
    await until(() => journeyIds(element).length === 3 && element.journeyMode!.ready);
    element.builder!.undo();
    await until(() => element.journeyMode!.journeyId === "intake" && element.journeyMode!.ready);
    expect(journeyIds(element)).toEqual(["intake", "quick"]);
    element.builder!.undo();
    expect(element.journeyMode!.journeys[0]!.pages[0]!.title).toBeUndefined();
  }, 20_000);

  it("never brings back a Redo the page made invalid: an edit made since is what Redo makes again", async () => {
    const element = mount();
    await opened(element, "pdf");
    removeShown(element);
    await until(() => layoutIds(element).length === 1 && element.pdfMode!.ready);
    element.builder!.undo();
    expect(layoutIds(element)).toEqual(["letter", "a4"]);
    const a4 = element.pdfMode!.controller;
    a4.setProperty(a4.rootId(), "name", "A4 edited");
    element.builder!.undo();
    expect(element.pdfMode!.layouts[1]!.name).toBe("A4");
    element.builder!.redo();
    expect(element.pdfMode!.layouts[1]!.name).toBe("A4 edited");
    expect(layoutIds(element)).toEqual(["letter", "a4"]);
    expect(element.builder!.canHistoryStep("redo")).toBe(false);
  }, 20_000);
});

describe("a page edit whose wording leaves the form, over a document deleted from the menu", () => {
  it("PDF: the bar's Undo takes back the node's deletion, then the layout's, and Redo makes them again in that order", async () => {
    const element = document.createElement("datum-form-builder");
    const sample = sampleDefinition();
    const noted = (id: string, name: string): PdfGeneratedLayout => {
      const made = generated(id, name);
      made.root.children!.body!.push({ id: `${id}-note`, type: "pdf-text", configuration: { text: `Note ${id}` } });
      return made;
    };
    element.definition = {
      ...sample,
      translations: { "fr-CA": { ...sample.translations!["fr-CA"], pdf: { a4: { nodes: { "a4-note": { text: { text: "Note FR", source: sourceHash("Note a4") } } } } } } },
      pdf: { layouts: [noted("letter", "Letter"), noted("a4", "A4")] }
    } as FormDefinition;
    document.body.append(element);
    await opened(element, "pdf");
    const wording = (): unknown => (element.controller!.translations()?.["fr-CA"] as { pdf?: Record<string, unknown> } | undefined)?.pdf?.a4;
    const notes = (): string[] => (element.pdfMode!.controller.snapshot().children?.body ?? []).map((node) => node.id).filter((id) => id.endsWith("-note"));
    removeShown(element);
    await until(() => layoutIds(element).length === 1 && element.pdfMode!.ready);
    expect(element.pdfMode!.layoutId).toBe("a4");
    const a4 = element.pdfMode!.controller;
    a4.remove("a4-note");
    expect(wording()).toBeUndefined();
    // The node's deletion is newest: the bar takes it back first, its wording with it.
    element.builder!.undo();
    expect(notes()).toEqual(["a4-note"]);
    expect(wording()).toBeDefined();
    // Then the layout's deletion, from the same page.
    await until(() => element.builder!.canHistoryStep("undo"));
    element.builder!.undo();
    expect(layoutIds(element)).toEqual(["letter", "a4"]);
    expect(element.pdfMode!.controller).toBe(a4);
    expect(element.controller!.canUndo()).toBe(false);
    // Redo: the layout's deletion, then the node's.
    element.builder!.redo();
    expect(layoutIds(element)).toEqual(["a4"]);
    element.builder!.redo();
    expect(notes()).toEqual([]);
    expect(wording()).toBeUndefined();
    expect(element.builder!.canHistoryStep("redo")).toBe(false);
  }, 20_000);

  it("Journeys: the bar's Undo takes back a translated page's deletion, then the journey's, and Redo makes them again in that order", async () => {
    const element = document.createElement("datum-form-builder");
    const sample = sampleDefinition();
    element.definition = {
      ...sample,
      translations: { "fr-CA": { ...sample.translations!["fr-CA"], journeys: { quick: { pages: { more: { title: { text: "Plus", source: sourceHash("More") } } } } } } },
      journey: {
        journeys: [
          { id: "intake", name: "Intake", pages: [{ id: "about", components: ["fullName"] }] },
          { id: "quick", name: "Quick", pages: [{ id: "all", components: ["fullName"] }, { id: "more", title: "More", components: [] }] }
        ]
      }
    } as FormDefinition;
    document.body.append(element);
    await opened(element, "journeys");
    const wording = (): unknown => (element.controller!.translations()?.["fr-CA"] as { journeys?: Record<string, unknown> } | undefined)?.journeys?.quick;
    removeShown(element);
    await until(() => journeyIds(element).length === 1 && element.journeyMode!.ready);
    expect(element.journeyMode!.journeyId).toBe("quick");
    const quick = element.journeyMode!.controller;
    const pageIds = (): string[] => (quick.snapshot().children?.pages ?? []).map((node) => (node.configuration as { pageId: string }).pageId);
    const more = (quick.snapshot().children?.pages ?? []).find((node) => (node.configuration as { pageId: string }).pageId === "more")!;
    quick.remove(more.id);
    expect(pageIds()).toEqual(["all"]);
    expect(wording()).toBeUndefined();
    element.builder!.undo();
    expect(pageIds()).toEqual(["all", "more"]);
    expect(wording()).toBeDefined();
    await until(() => element.builder!.canHistoryStep("undo"));
    element.builder!.undo();
    expect(journeyIds(element)).toEqual(["intake", "quick"]);
    expect(element.controller!.canUndo()).toBe(false);
    element.builder!.redo();
    expect(journeyIds(element)).toEqual(["quick"]);
    element.builder!.redo();
    expect(pageIds()).toEqual(["all"]);
    expect(wording()).toBeUndefined();
    expect(element.builder!.canHistoryStep("redo")).toBe(false);
  }, 20_000);
});

describe("every catalog action is one step of the form's history", () => {
  const declared = (element: DatumFormBuilderElement, kind: "pdf" | "journey"): string => JSON.stringify(element.definition[kind] ?? null);

  it("takes back a new layout the page was on, landing as a delete would and keeping the other layout's history; Redo makes it again as it was", async () => {
    const element = mount();
    await opened(element, "pdf");
    const letter = element.pdfMode!.controller;
    letter.setProperty(letter.rootId(), "name", "Letter edited");
    const reasons: string[] = [];
    element.controller!.on("change", (event) => reasons.push(event.reason));
    const made = element.pdfMode!.newLayout({ name: "Fresh", from: "blank" });
    await until(() => element.pdfMode!.layoutId === made.id && element.pdfMode!.ready);
    element.pdfMode!.setDefaultLayout(made.id);
    expect(reasons).toEqual(["edit", "edit"]);
    const fresh = JSON.stringify(element.pdfMode!.layouts.find((entry) => entry.id === made.id));
    // The default first, then the layout: the page lands on the first layout, its designer and history kept.
    element.builder!.undo();
    expect(element.definition.pdf?.defaultLayoutId).toBeUndefined();
    element.builder!.undo();
    await until(() => element.pdfMode!.layoutId === "letter" && element.pdfMode!.ready);
    expect(layoutIds(element)).toEqual(["letter", "a4"]);
    expect(element.pdfMode!.controller).toBe(letter);
    element.builder!.undo();
    expect(element.pdfMode!.layouts[0]!.name).toBe("Letter");
    expect(element.builder!.canHistoryStep("undo")).toBe(false);
    expect(element.controller!.canUndo()).toBe(false);
    // Redo: the edit, the layout (the page stays where it landed), its default.
    element.builder!.redo();
    expect(element.pdfMode!.layouts[0]!.name).toBe("Letter edited");
    element.builder!.redo();
    expect(layoutIds(element)).toEqual(["letter", "a4", made.id]);
    expect(element.pdfMode!.layoutId).toBe("letter");
    element.builder!.redo();
    expect(JSON.stringify(element.pdfMode!.layouts.find((entry) => entry.id === made.id))).toBe(fresh);
    expect(element.definition.pdf?.defaultLayoutId).toBe(made.id);
    expect(element.builder!.canHistoryStep("redo")).toBe(false);
  }, 20_000);

  it("takes back the default layout and the order one step each, from the designer and from the Form workspace, translated or not", async () => {
    for (const translated of [false, true]) {
      const element = mount({ translated });
      await opened(element, "pdf");
      const before = declared(element, "pdf");
      const wording = JSON.stringify(element.definition.translations);
      element.pdfMode!.setDefaultLayout("a4");
      element.pdfMode!.moveLayout("a4", 0);
      const after = declared(element, "pdf");
      expect(layoutIds(element)).toEqual(["a4", "letter"]);
      element.builder!.undo();
      expect(layoutIds(element)).toEqual(["letter", "a4"]);
      expect(element.definition.pdf?.defaultLayoutId).toBe("a4");
      element.builder!.undo();
      // No explicit default again, as before.
      expect(declared(element, "pdf")).toBe(before);
      expect(element.definition.pdf?.defaultLayoutId).toBeUndefined();
      expect(element.builder!.canHistoryStep("undo")).toBe(false);
      expect(element.controller!.canUndo()).toBe(false);
      element.mode = "form";
      await until(() => element.builder!.mode === "form");
      element.builder!.redo();
      element.builder!.redo();
      expect(declared(element, "pdf")).toBe(after);
      expect(element.controller!.canRedo()).toBe(false);
      barUndo(element).click();
      barUndo(element).click();
      expect(declared(element, "pdf")).toBe(before);
      expect(JSON.stringify(element.definition.translations)).toBe(wording);
      expect(element.controller!.canUndo()).toBe(false);
      element.remove();
    }
  }, 30_000);

  it("takes back a rename of a layout whose designer was never built, once, from the form's history", async () => {
    const element = mount();
    await opened(element, "pdf");
    const letter = element.pdfMode!.controller;
    element.pdfMode!.renameLayout("a4", "A4 renamed");
    expect(element.pdfMode!.layouts[1]!.name).toBe("A4 renamed");
    expect(letter.canUndo()).toBe(false);
    element.builder!.undo();
    expect(element.pdfMode!.layouts[1]!.name).toBe("A4");
    expect(element.controller!.canUndo()).toBe(false);
    expect(element.builder!.canHistoryStep("undo")).toBe(false);
    // The rename of the layout on the page is the form's step as well: its tree takes the name with no entry.
    element.pdfMode!.renameLayout("letter", "Letter renamed");
    expect((letter.snapshot().configuration as { name?: unknown }).name).toBe("Letter renamed");
    expect(letter.canUndo()).toBe(false);
    expect(element.controller!.canUndo()).toBe(true);
    element.builder!.undo();
    expect(element.pdfMode!.layouts[0]!.name).toBe("Letter");
    expect((letter.snapshot().configuration as { name?: unknown }).name).toBe("Letter");
    expect(element.builder!.canHistoryStep("undo")).toBe(false);
  }, 20_000);

  it("takes back a rename of the layout on the page from the Form workspace, newest first, ahead of an older deletion", async () => {
    const element = mount({ third: true });
    await opened(element, "pdf");
    element.pdfMode!.removeLayout("third");
    await until(() => layoutIds(element).length === 2 && element.pdfMode!.ready);
    element.pdfMode!.renameLayout("letter", "Renamed");
    element.mode = "form";
    await until(() => element.builder!.mode === "form");
    element.builder!.undo();
    expect(element.definition.pdf?.layouts?.map((entry) => entry.name)).toEqual(["Letter", "A4"]);
    element.builder!.undo();
    expect(layoutIds(element)).toEqual(["letter", "a4", "third"]);
    expect(element.controller!.canUndo()).toBe(false);
  }, 20_000);

  it("takes back a rename made before the layout's designer was built from that designer, writing no step on its tree", async () => {
    const element = mount();
    await opened(element, "pdf");
    element.pdfMode!.renameLayout("a4", "A4 renamed");
    await element.builder!.selectDocument("pdf", "a4");
    await until(() => element.pdfMode!.layoutId === "a4" && element.pdfMode!.ready);
    const a4 = element.pdfMode!.controller;
    const rootName = (): unknown => (a4.snapshot().configuration as { name?: unknown }).name;
    expect(rootName()).toBe("A4 renamed");
    element.builder!.undo();
    expect(element.pdfMode!.layouts[1]!.name).toBe("A4");
    expect(rootName()).toBe("A4");
    expect(a4.canUndo()).toBe(false);
    expect(element.builder!.canHistoryStep("undo")).toBe(false);
    element.builder!.redo();
    expect(element.pdfMode!.layouts[1]!.name).toBe("A4 renamed");
    expect(rootName()).toBe("A4 renamed");
    expect(a4.canUndo()).toBe(false);
    expect(element.builder!.canHistoryStep("redo")).toBe(false);
  }, 20_000);

  it("takes back the default journey and what the form opens as one step each, the Form panel's Save as one, from the designer and the Form workspace", async () => {
    for (const translated of [false, true]) {
      const element = mount({ translated });
      await opened(element, "journeys");
      const mode = element.journeyMode!;
      const before = declared(element, "journey");
      mode.setDefaultJourney("quick");
      mode.chooseOpensAs("form");
      // The Form panel's row: the default and what the form opens as from one Save.
      mode.formSettings!.rows()[0]!.set("intake");
      const after = declared(element, "journey");
      expect(element.definition.journey?.opensAs).not.toBe("form");
      element.builder!.undo();
      expect(element.definition.journey?.opensAs).toBe("form");
      expect(element.definition.journey?.defaultJourneyId).toBe("quick");
      element.builder!.undo();
      expect(element.definition.journey?.opensAs).toBeUndefined();
      element.builder!.undo();
      expect(declared(element, "journey")).toBe(before);
      expect(element.builder!.canHistoryStep("undo")).toBe(false);
      expect(element.controller!.canUndo()).toBe(false);
      element.mode = "form";
      await until(() => element.builder!.mode === "form");
      for (let step = 0; step < 3; step += 1) {
        element.builder!.redo();
      }
      expect(declared(element, "journey")).toBe(after);
      expect(element.controller!.canRedo()).toBe(false);
      for (let step = 0; step < 3; step += 1) {
        barUndo(element).click();
      }
      expect(declared(element, "journey")).toBe(before);
      expect(element.controller!.canUndo()).toBe(false);
      element.remove();
    }
  }, 30_000);
});

describe("a form step made while a designer is on the page, whatever wrote it", () => {
  it("takes back a form rename the open journeys followed in one Undo from the map, every journey with it", async () => {
    const element = mount({ third: true });
    await opened(element, "journeys");
    const named = (): string[] => element.journeyMode!.journeys.map((journey) => `${journey.id}=${journey.pages.flatMap((page) => page.components ?? []).join("+")}`);
    element.controller!.renameId("fullName", "fullName2");
    expect(named()).toEqual(["intake=fullName2", "quick=fullName2", "third=fullName2"]);
    // The follow-up is no entry of the journey's tree: the form's rename is the one step.
    expect(element.journeyMode!.controller.canUndo()).toBe(false);
    element.builder!.undo();
    expect(named()).toEqual(["intake=fullName", "quick=fullName", "third=fullName"]);
    expect(JSON.stringify(element.controller!.snapshot())).toContain('"fullName"');
    expect(element.builder!.canHistoryStep("undo")).toBe(false);
    element.builder!.redo();
    expect(named()).toEqual(["intake=fullName2", "quick=fullName2", "third=fullName2"]);
  }, 20_000);

  it("takes back a journey the host removed while a PDF layout is on the page, ahead of that layout's older edit", async () => {
    const element = mount({ third: true });
    await opened(element, "pdf");
    const letter = element.pdfMode!.controller;
    letter.setProperty(letter.rootId(), "name", "Letter edited");
    element.journeyMode!.removeJourney("quick");
    await until(() => !barUndo(element).disabled);
    element.builder!.undo();
    expect(journeyIds(element)).toEqual(["intake", "quick", "third"]);
    expect(element.pdfMode!.layouts[0]!.name).toBe("Letter edited");
    element.builder!.undo();
    expect(element.pdfMode!.layouts[0]!.name).toBe("Letter");
  }, 20_000);
});

describe("a catalog action from the host in the Form workspace", () => {
  it("is one form change, so the bar's Undo and a host following the form's changes see it", async () => {
    const element = mount();
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    await modesReady(element);
    await until(() => element.journeyMode?.journeys.length === 2 && element.pdfMode !== undefined);
    expect(barUndo(element).disabled).toBe(true);
    const reasons: string[] = [];
    element.controller!.on("change", (event) => reasons.push(event.reason));
    element.journeyMode!.removeJourney("quick");
    expect(reasons).toEqual(["edit"]);
    await until(() => !barUndo(element).disabled);
    element.pdfMode!.removeLayout("a4");
    expect(reasons).toEqual(["edit", "edit"]);
    barUndo(element).click();
    expect(layoutIds(element)).toEqual(["letter", "a4"]);
    barUndo(element).click();
    expect(journeyIds(element)).toEqual(["intake", "quick"]);
    expect(element.controller!.canUndo()).toBe(false);
  }, 20_000);
});

/*
 * A form rename the built PDF layouts follow is one step of the form's history, as the journeys'
 * follow-up is: each open tree, a custom layout's and a populated form's, takes the new id with
 * no entry of its own, one Undo takes back the id and every layout's follow-up, and Redo makes
 * them all again. The fake executor reads a one-page PDF with one text field.
 */
describe("a form rename the open PDF layouts followed", () => {
  const paperLayout = (): PdfTemplateLayout => ({
    id: "paper",
    kind: "template",
    name: "Paper",
    template: { storage: "base64", name: "paper.pdf", type: "application/pdf", size: 8, data: "JVBERi0xLjQK" },
    fields: [{ pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } }],
    areas: [{ id: "a1", page: 1, rect: { x: 40, y: 40, width: 120, height: 20 }, source: { kind: "expression", expression: "fullName" } }],
    when: "fullName"
  });

  function provider(): PdfRenderProvider {
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    return {
      id: "fake",
      abiVersion: "1.0.0",
      render: async () => ({ bytes: bytes("%PDF-fake"), pageCount: 1, pages: [], warnings: [], providerId: "fake" }),
      inspect: async () => ({
        pageCount: 1,
        pages: [{ index: 1, width: 612, height: 792 }],
        fields: [{ name: "Full Name", kind: "text", page: 1, rect: { x: 250, y: 660, width: 300, height: 22 }, readOnly: false, required: false }],
        hasXfa: false,
        encrypted: false
      })
    } as unknown as PdfRenderProvider;
  }

  /** The sample form with a custom layout (`letter`, printing and conditioned on fullName) and a populated form (`paper`). */
  function mountLayouts(): DatumFormBuilderElement {
    const element = document.createElement("datum-form-builder");
    const letter = generated("letter", "Letter");
    element.definition = { ...sampleDefinition(), pdf: { layouts: [{ ...letter, when: "fullName" }, paperLayout()] } } as FormDefinition;
    element.pdfSupport = { provider: provider() };
    document.body.append(element);
    return element;
  }

  /** Opens `id` on the PDF side and gives back its tree once built (a populated form's with its widgets). */
  async function built(element: DatumFormBuilderElement, id: "letter" | "paper"): Promise<BuilderController> {
    await element.builder!.selectDocument("pdf", id);
    await until(() => element.pdfMode!.layoutId === id && element.pdfMode!.ready && (id === "letter" || element.pdfMode!.templateDesigner?.widgetIdFor("Full Name") !== undefined));
    return element.pdfMode!.controller;
  }

  /** What names the field, as the definition has it: the form's id, then the custom layout's condition and binding, then the populated form's condition, mapping and area. */
  const declared = (element: DatumFormBuilderElement): string => {
    const [letter, paper] = element.definition.pdf!.layouts! as [PdfGeneratedLayout, PdfTemplateLayout];
    const field = element.definition.root.children!.content![0]!.id;
    const bound = (letter.root.children!.body![0]!.configuration as { componentId: string }).componentId;
    const mapped = (paper.fields[0]!.source as { componentId: string }).componentId;
    const area = (paper.areas![0]!.source as { expression: string }).expression;
    return [field, letter.when as string, bound, paper.when as string, mapped, area].join(" ");
  };
  /** The same as the open trees have them: the custom layout's condition and binding, the populated form's condition and mapping. */
  const inTrees = (letter: BuilderController, paper: BuilderController, widget: string): string => {
    const letterRoot = letter.snapshot();
    const paperRoot = paper.snapshot();
    return [
      (letterRoot.configuration as { when?: string }).when ?? "-",
      (letterRoot.children!.body![0]!.configuration as { componentId: string }).componentId,
      (paperRoot.configuration as { when?: string }).when ?? "-",
      (paper.getProperty(widget, "source") as { componentId: string }).componentId
    ].join(" ");
  };

  it("takes back the id and both open layouts' follow-up in one Undo from the Form workspace, Redo making them all again, with no entry on either tree", async () => {
    const element = mountLayouts();
    await opened(element, "pdf");
    const letter = await built(element, "letter");
    const paper = await built(element, "paper");
    const widget = element.pdfMode!.templateDesigner!.widgetIdFor("Full Name")!;
    element.mode = "form";
    await until(() => element.builder!.mode === "form");
    const changes: string[] = [];
    element.controller!.on("change", (event) => changes.push(event.reason));
    element.controller!.renameId("fullName", "legalName");
    expect(declared(element)).toBe("legalName legalName legalName legalName legalName legalName");
    expect(inTrees(letter, paper, widget)).toBe("legalName legalName legalName legalName");
    expect(changes).toEqual(["edit"]);
    expect([letter.canUndo(), paper.canUndo()]).toEqual([false, false]);
    element.builder!.undo();
    expect(declared(element)).toBe("fullName fullName fullName fullName fullName fullName");
    expect(inTrees(letter, paper, widget)).toBe("fullName fullName fullName fullName");
    expect([letter.canUndo(), paper.canUndo(), letter.canRedo(), paper.canRedo()]).toEqual([false, false, false, false]);
    expect(element.controller!.canUndo()).toBe(false);
    element.builder!.redo();
    expect(declared(element)).toBe("legalName legalName legalName legalName legalName legalName");
    expect(inTrees(letter, paper, widget)).toBe("legalName legalName legalName legalName");
    expect([letter.canUndo(), paper.canUndo()]).toEqual([false, false]);
    expect(element.controller!.canRedo()).toBe(false);
  }, 30_000);

  it("takes back an edit made in the layout on the page since first, then the rename, from the designer, each layout's kind alike", async () => {
    for (const id of ["letter", "paper"] as const) {
      const element = mountLayouts();
      await opened(element, "pdf");
      const tree = await built(element, id);
      const name = (): unknown => element.pdfMode!.layouts.find((entry) => entry.id === id)!.name;
      const named = (): string => (tree.snapshot().configuration as { when?: string }).when ?? "-";
      element.controller!.renameId("fullName", "legalName");
      expect(named()).toBe("legalName");
      expect(tree.canUndo()).toBe(false);
      tree.setProperty(tree.rootId(), "name", "Edited");
      element.builder!.undo();
      expect(name()).not.toBe("Edited");
      expect(named()).toBe("legalName");
      // No "follow the rename" step on the tree: the next Undo is the form's rename.
      expect(tree.canUndo()).toBe(false);
      element.builder!.undo();
      expect(element.definition.root.children!.content![0]!.id).toBe("fullName");
      expect(named()).toBe("fullName");
      expect(element.builder!.canHistoryStep("undo")).toBe(false);
      element.builder!.redo();
      expect(named()).toBe("legalName");
      element.builder!.redo();
      expect(name()).toBe("Edited");
      expect(named()).toBe("legalName");
      expect(element.builder!.canHistoryStep("redo")).toBe(false);
      element.remove();
    }
  }, 30_000);
});
