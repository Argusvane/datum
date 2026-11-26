import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The shell's switches between the designers, their overviews and the phone tier: the way back to an overview asks about
 * unsaved edits, a choice made while a designer is still opening wins, a PDF page's zoom stays
 * with the PDF, the overview follows the documents, focus lands somewhere drawn, and a phone's
 * sheets go with a workspace switch.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

type Canvas = HTMLElement & { previewing: boolean; zoom: number; zoomTo(value: number | "fit"): void };

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const q = <T extends HTMLElement = HTMLElement>(element: DatumFormBuilderElement, selector: string): T => shell(element).querySelector<T>(selector)!;
const wrap = (element: DatumFormBuilderElement): HTMLElement => q(element, "[data-shell=wrap]");
const canvasEl = (element: DatumFormBuilderElement): Canvas => q(element, "datum-builder-canvas") as Canvas;
const canvas = (element: DatumFormBuilderElement): ShadowRoot => canvasEl(element).shadowRoot!;
const properties = (element: DatumFormBuilderElement) => q(element, "datum-builder-properties") as HTMLElement & { collapsed: boolean };
const form = (element: DatumFormBuilderElement): ShadowRoot => canvas(element).querySelector<HTMLElement>("datum-form-renderer[data-preview]")!.shadowRoot!;
const overview = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-overview")!.shadowRoot!;
const cards = (element: DatumFormBuilderElement): string[] => [...overview(element).querySelectorAll(".out-card strong")].map((title) => title.textContent!);
const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const press = (target: HTMLElement, key: string): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
};

/** Whether `element` has `hidden` on it or above it, through shadow roots. */
function hiddenDeep(element: Element | null | undefined): boolean {
  let node: Element | null | undefined = element;
  while (node) {
    if (node.hasAttribute("hidden")) {
      return true;
    }
    node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host as Element | undefined);
  }
  return false;
}

function withJourneys(): FormDefinition {
  const definition = sampleDefinition();
  definition.journey = {
    journeys: [
      { id: "apply", name: "Apply online", pages: [{ id: "p1", components: ["fullName"] }, { id: "p2", components: ["country", "subscribe", "email", "submit"] }] },
      { id: "renew", name: "Renewal", pages: [{ id: "only", components: ["subscribe", "email"] }] }
    ]
  } as NonNullable<FormDefinition["journey"]>;
  return definition;
}

function withLayout(): FormDefinition {
  return {
    ...sampleDefinition(),
    pdf: {
      layouts: [{ id: "standard", kind: "generated", name: "Standard", root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } } }],
      defaultLayoutId: "standard"
    }
  } as unknown as FormDefinition;
}

function resizeTo(element: DatumFormBuilderElement, width: number): void {
  wrap(element).getBoundingClientRect = () => ({ width, height: 844, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 844, toJSON: () => ({}) }) as DOMRect;
  window.dispatchEvent(new Event("resize"));
}

async function mount(definition: FormDefinition = withJourneys(), width?: number): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  document.body.append(element);
  await until(() => form(element)?.querySelector('[data-component-id="fullName"]'));
  await settle();
  if (width !== undefined) {
    resizeTo(element, width);
  }
  return element;
}

async function onOverview(element: DatumFormBuilderElement, workspace: "journeys" | "pdf" = "journeys"): Promise<void> {
  element.builder!.setWorkspace(workspace);
  await until(() => shell(element).querySelector("datum-builder-overview")?.shadowRoot?.querySelector(`[data-overview-section="${workspace}"]`));
}

async function openRenewal(element: DatumFormBuilderElement): Promise<void> {
  await onOverview(element);
  overview(element).querySelector<HTMLButtonElement>('[data-overview-open="journeys"][data-document-id="renew"]')!.click();
  await until(() => element.builder!.mode === "journeys", 8000);
  await settle(10);
}

/** An unapplied inspector edit on the designer's first node. */
function draftOnDesigner(element: DatumFormBuilderElement): void {
  const controller = element.builder!.activeController;
  const tree = controller.snapshot();
  const id = Object.values(tree.children ?? {}).flat()[0]?.id ?? tree.id;
  controller.select(id);
  controller.setDraftProperty(id, "label", "Edited, not applied");
  expect(controller.hasPendingChanges(id)).toBe(true);
}

describe("the way back to an overview asks about unsaved edits", () => {
  it("holds ‹ Journeys behind the prompt; Discard then goes back", async () => {
    const element = await mount();
    await openRenewal(element);
    const journey = element.builder!.activeController;
    draftOnDesigner(element);
    shell(element).querySelector<HTMLElement>("[data-overview-back]")!.click();
    await settle(10);
    expect(element.builder!.mode).toBe("journeys");
    expect(journey.unsavedChangesPrompt()).toMatchObject({ action: "leave" });
    expect(element.hasUnsavedChanges()).toBe(true);
    journey.answerUnsavedChangesPrompt("discard");
    await until(() => element.builder!.mode === "form");
    expect(element.builder!.workspace).toBe("journeys");
  }, 20000);

  it("holds a phone's back title and the drawer's All journeys the same way", async () => {
    const element = await mount(withJourneys(), 390);
    await openRenewal(element);
    const journey = element.builder!.activeController;
    draftOnDesigner(element);
    q(element, "[data-document-back]").click();
    await settle(10);
    expect(element.builder!.mode).toBe("journeys");
    expect(journey.unsavedChangesPrompt()).toBeTruthy();
    journey.answerUnsavedChangesPrompt("stay");
    q(element, "[data-menu-open]").click();
    q(element, '[data-menu-go="overview"]').click();
    await settle(10);
    expect(element.builder!.mode).toBe("journeys");
    expect(journey.unsavedChangesPrompt()).toBeTruthy();
  }, 20000);
});

describe("a choice made while a designer opens wins", () => {
  it("keeps the Form tab chosen while the journey's designer was still coming", async () => {
    const element = await mount();
    await onOverview(element);
    overview(element).querySelector<HTMLButtonElement>('[data-overview-open="journeys"][data-document-id="renew"]')!.click();
    expect(element.builder!.mode).toBe("form");
    q(element, '[data-workspace-tab="form"]').click();
    expect(element.builder!.workspace).toBe("form");
    // Long enough for the designer's chunk and its activation to land.
    await settle(2500);
    expect([element.builder!.mode, element.builder!.workspace]).toEqual(["form", "form"]);
    expect(q(element, "[data-document-face]").hasAttribute("aria-busy")).toBe(false);
    // Opened again, it opens.
    await openRenewal(element);
    expect(element.builder!.workspace).toBe("journeys");
  }, 20000);
});

describe("a PDF page's zoom stays with the PDF", () => {
  it("draws the form at its own size again after a layout was zoomed, on a phone too", async () => {
    const element = await mount(withLayout(), 390);
    element.builder!.selectDocument("pdf", "standard");
    await until(() => element.builder!.mode === "pdf", 8000);
    await settle(20);
    q(element, "[data-menu-open]").click();
    q(element, '[data-menu-go="zoom:out"]').click();
    expect(canvasEl(element).zoom).toBeLessThan(1);
    q(element, "[data-menu-open]").click();
    q(element, '[data-menu-go="workspace:form"]').click();
    await until(() => element.builder!.mode === "form");
    await settle(20);
    expect(canvasEl(element).zoom).toBe(1);
    expect(canvas(element).querySelector<HTMLElement>(".canvas-surface")!.style.zoom).toBe("");
  }, 20000);

  it("keeps a zoom chosen on the page itself", async () => {
    const element = await mount(withLayout());
    element.builder!.selectDocument("pdf", "standard");
    await until(() => element.builder!.mode === "pdf", 8000);
    await settle(20);
    canvasEl(element).zoomTo(0.5);
    element.builder!.activeController.select(element.builder!.activeController.rootId());
    await settle(10);
    expect(canvasEl(element).zoom).toBe(0.5);
  }, 20000);
});

describe("the overview follows its mode's documents", () => {
  it("drops the card of a journey removed elsewhere", async () => {
    const element = await mount();
    await onOverview(element);
    expect(cards(element)).toEqual(["Apply online", "Renewal"]);
    element.journeyMode!.documents!.remove!("renew");
    await until(() => cards(element).length === 1);
    expect(cards(element)).toEqual(["Apply online"]);
  }, 20000);
});

describe("focus across an overview and its designer", () => {
  it("lands on the designer's canvas after a card's Open, and on the card again after ‹ Journeys", async () => {
    const element = await mount();
    await onOverview(element);
    const open = overview(element).querySelector<HTMLButtonElement>('[data-overview-open="journeys"][data-document-id="renew"]')!;
    open.focus();
    open.click();
    await until(() => element.builder!.mode === "journeys", 8000);
    await settle(10);
    expect(shell(element).activeElement).toBe(canvasEl(element));
    expect(canvas(element).activeElement).toBe(canvas(element).querySelector(".canvas-page"));

    const back = shell(element).querySelector<HTMLElement>("[data-overview-back]")!;
    back.focus();
    back.click();
    await until(() => element.builder!.mode === "form");
    await settle(10);
    const active = overview(element).activeElement as HTMLElement | null;
    expect(active?.dataset.documentId).toBe("renew");
    expect(hiddenDeep(active)).toBe(false);
  }, 20000);

  it("lands on the card again after a phone's back title", async () => {
    const element = await mount(withJourneys(), 390);
    await openRenewal(element);
    const back = q(element, "[data-document-back]");
    back.focus();
    back.click();
    await until(() => element.builder!.mode === "form");
    await settle(10);
    expect((overview(element).activeElement as HTMLElement | null)?.dataset.documentId).toBe("renew");
  }, 20000);

  it("keeps focus on a card while the overview repaints", async () => {
    const element = await mount();
    await onOverview(element);
    overview(element).querySelector<HTMLButtonElement>('[data-overview-open="journeys"][data-document-id="apply"]')!.focus();
    (shell(element).querySelector("datum-builder-overview") as HTMLElement & { refresh(): void }).refresh();
    expect((overview(element).activeElement as HTMLElement | null)?.dataset.documentId).toBe("apply");
  }, 20000);
});

describe("focus after a rename", () => {
  it("goes back to the document's label after Enter and after Escape", async () => {
    const element = await mount();
    await openRenewal(element);
    const rename = async (): Promise<HTMLInputElement> => {
      q(element, "[data-document-menu]").click();
      q(element, '[data-document-action="rename"]').click();
      return q<HTMLInputElement>(element, "[data-document-rename]");
    };
    let box = await rename();
    box.value = "Renewal 2";
    press(box, "Enter");
    expect(element.journeyMode!.journeys.find((journey) => journey.id === "renew")!.name).toBe("Renewal 2");
    expect(shell(element).activeElement).toBe(q(element, "[data-document-face]"));
    box = await rename();
    press(box, "Escape");
    expect(shell(element).activeElement).toBe(q(element, "[data-document-face]"));
  }, 20000);

  it("goes to the back title on a phone, renamed from the drawer", async () => {
    const element = await mount(withJourneys(), 390);
    await openRenewal(element);
    q(element, "[data-menu-open]").click();
    q(element, '[data-menu-go="docaction:rename"]').click();
    const box = q<HTMLInputElement>(element, "[data-document-rename]");
    expect(shell(element).activeElement).toBe(box);
    box.value = "Renewal 3";
    press(box, "Enter");
    expect(shell(element).activeElement).toBe(q(element, "[data-document-back]"));
    expect(q(element, "[data-document-back-name]").textContent).toBe("Renewal 3");
  }, 20000);
});

describe("a phone's sheets go with a workspace switch", () => {
  it("folds an open inspector, so selecting in a designer opens no sheet", async () => {
    const element = await mount(withJourneys(), 390);
    element.builder!.activeController.select("fullName");
    await settle();
    canvas(element).querySelector<HTMLButtonElement>("[data-selection-edit]")!.click();
    expect(wrap(element).dataset.sheet).toBe("props");
    // Ctrl+K's palette, or a host, switches with the sheet up.
    await onOverview(element);
    expect(properties(element).collapsed).toBe(true);
    overview(element).querySelector<HTMLButtonElement>('[data-overview-open="journeys"][data-document-id="renew"]')!.click();
    await until(() => element.builder!.mode === "journeys", 8000);
    const controller = element.builder!.activeController;
    controller.select(Object.values(controller.snapshot().children ?? {}).flat()[0]!.id);
    await settle(10);
    expect(wrap(element).dataset.sheet).toBeUndefined();
    expect(canvasEl(element).hasAttribute("inert")).toBe(false);
  }, 20000);

  it("ends Try it and its results, leaving nothing inert over an overview", async () => {
    const element = await mount(withJourneys(), 390);
    q(element, "[data-bottom-try]").click();
    await until(() => canvasEl(element).previewing === true);
    q(element, "[data-bottom-results]").click();
    expect(wrap(element).dataset.sheet).toBe("results");
    await onOverview(element);
    expect(canvasEl(element).previewing).toBe(false);
    expect(wrap(element).dataset.sheet).toBeUndefined();
    expect(q(element, "[data-shell=bar]").hasAttribute("inert")).toBe(false);
  }, 20000);
});

describe("the bar's + asks about unsaved edits first", () => {
  it("holds a new layout behind the prompt of the layout on the page", async () => {
    const element = await mount(withLayout());
    element.builder!.selectDocument("pdf", "standard");
    await until(() => element.builder!.mode === "pdf", 8000);
    await settle(20);
    const controller = element.builder!.activeController;
    const root = controller.rootId();
    controller.select(root);
    controller.setDraftProperty(root, "title", "Edited, not applied");
    expect(controller.hasPendingChanges(root)).toBe(true);
    expect(element.builder!.newDocument("pdf")).toBe(true);
    await settle(10);
    expect(controller.unsavedChangesPrompt()).toMatchObject({ action: "leave" });
    expect(shell(element).querySelector<HTMLElement>("[data-add-popover]")?.hidden ?? true).toBe(true);
    controller.answerUnsavedChangesPrompt("discard");
    await until(() => shell(element).querySelector<HTMLElement>("[data-add-popover]")?.hidden === false);
  }, 20000);
});
