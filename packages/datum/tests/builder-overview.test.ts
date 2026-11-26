import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { FormDefinition, PdfGeneratedLayout } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { modesReady, sampleDefinition, until } from "./helpers.js";

/** The Journeys and PDF overviews: each workspace's own documents, with Open and New. */

afterEach(() => {
  document.body.innerHTML = "";
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const overview = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-overview")!.shadowRoot!;

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

function layout(id: string, name: string, when?: unknown): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name,
    ...(when !== undefined ? { when } : {}),
    root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } }
  } as unknown as PdfGeneratedLayout;
}

async function mountOn(workspace: "journeys" | "pdf", definition: FormDefinition = withJourneys()): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  // The modes are chunks: the inner builder offers Journeys and PDF once they register.
  await modesReady(element);
  element.builder!.setWorkspace(workspace);
  await until(() => shell(element).querySelector("datum-builder-overview")?.shadowRoot?.querySelector(`[data-overview-section="${workspace}"]`));
  return element;
}

const cards = (element: DatumFormBuilderElement): string[][] =>
  [...overview(element).querySelectorAll(".out-card")].map((card) => [card.querySelector("strong")!.textContent!, card.querySelector(".muted")!.textContent!]);

describe("the Journeys overview", () => {
  it("lists the journeys with what each asks, its status, and New; nothing of the PDF, the form or the old map", async () => {
    const element = await mountOn("journeys");
    expect(overview(element).querySelector("h2")!.textContent).toBe("Journeys");
    expect(cards(element)).toEqual([
      ["Apply online", "2 pages · asks 4 of 4 fields · the form opens as this"],
      ["Renewal", "1 page · asks 2 of 4 fields"]
    ]);
    expect(overview(element).querySelector('[data-overview-add="journeys"]')!.textContent).toBe("+ New journey");
    for (const gone of ['[data-overview-open="pdf"]', '[data-overview-open="form"]', "[data-outputs-snippet]", '[aria-labelledby="out-changes"]', '[aria-labelledby="out-print"]']) {
      expect(overview(element).querySelector(gone), gone).toBeNull();
    }
    // The journeys' problems come from the diagnostics chunk; until then, "Not checked yet".
    await until(() => !overview(element).querySelector(".status--pending"));
  });

  it("says there are none yet, and still offers New", async () => {
    const element = await mountOn("journeys", sampleDefinition());
    expect(cards(element)).toEqual([]);
    expect(overview(element).querySelector("[data-overview-journeys-none]")!.textContent).toContain("No journeys yet");
    expect(overview(element).querySelector('[data-overview-add="journeys"]')).not.toBeNull();
  });

  it("says the form opens as the default journey only while opensAs is not form", async () => {
    const definition = withJourneys();
    definition.journey = { ...definition.journey!, opensAs: "form" } as NonNullable<FormDefinition["journey"]>;
    const element = await mountOn("journeys", definition);
    expect(cards(element).map((card) => card[1])).toEqual(["2 pages · asks 4 of 4 fields", "1 page · asks 2 of 4 fields"]);
  });

  it("opens a journey's designer from its card, the workspace kept", async () => {
    const element = await mountOn("journeys");
    overview(element).querySelector<HTMLButtonElement>('[data-overview-open="journeys"][data-document-id="renew"]')!.click();
    await until(() => element.builder!.mode === "journeys");
    expect(element.builder!.workspace).toBe("journeys");
    await until(() => shell(element).querySelector("[data-document-face]")?.textContent?.includes("Renewal"));
  });
});

describe("New from an overview", () => {
  const popover = (element: DatumFormBuilderElement, selector: string): HTMLElement | null => shell(element).querySelector<HTMLElement>(selector);

  it("opens the journey popover over the Journeys overview, the form still on the page, and Escape leaves it as it was", async () => {
    const element = await mountOn("journeys", sampleDefinition());
    const builder = element.builder!;
    overview(element).querySelector<HTMLButtonElement>('[data-overview-add="journeys"]')!.click();
    await until(() => popover(element, "[data-journey-add-popover]")?.hidden === false);
    // No designer and no empty page of its own: the overview stays, and nothing on it to copy.
    expect(builder.mode).toBe("form");
    expect(builder.workspace).toBe("journeys");
    expect(shell(element).querySelector<HTMLElement>("[data-overview-host]")!.hidden).toBe(false);
    expect(popover(element, '[data-journey-add="copy"]')).toBeNull();
    popover(element, "[data-journey-add-name]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => !popover(element, "[data-journey-add-popover]"));
    expect(builder.mode).toBe("form");
    expect(shell(element).querySelector('style[data-mode-style="journeys-add"]')).toBeNull();
    expect(shell(element).querySelector<HTMLElement>("[data-overview-host]")!.hidden).toBe(false);
  });

  it("opens the new journey's designer once one is chosen", async () => {
    const element = await mountOn("journeys", sampleDefinition());
    const builder = element.builder!;
    overview(element).querySelector<HTMLButtonElement>('[data-overview-add="journeys"]')!.click();
    await until(() => popover(element, "[data-journey-add-popover]")?.hidden === false);
    popover(element, '[data-journey-add="blank"]')!.click();
    await until(() => builder.mode === "journeys");
    expect(builder.workspace).toBe("journeys");
    expect(element.journeyMode!.journeys.length).toBe(1);
    expect(shell(element).querySelector<HTMLElement>("[data-overview-host]")!.hidden).toBe(true);
    expect(shell(element).querySelector("datum-builder-canvas")!.shadowRoot!.querySelector("[data-journey-empty]")).toBeNull();
  });

  it("opens the layout popover over the PDF overview, and the new layout's designer once one is chosen", async () => {
    const element = await mountOn("pdf", sampleDefinition());
    const builder = element.builder!;
    overview(element).querySelector<HTMLButtonElement>('[data-overview-add="pdf"]')!.click();
    // The layout popover is the PDF designer chunk's: it opens once the chunk is in.
    await until(() => popover(element, "[data-add-popover]")?.hidden === false && popover(element, '[data-add-custom="form"]'));
    expect(builder.mode).toBe("form");
    expect(popover(element, '[data-add-custom="copy"]')).toBeNull();
    popover(element, '[data-add-custom="form"]')!.click();
    // Named before it is made.
    popover(element, "[data-add-confirm]")!.click();
    await until(() => builder.mode === "pdf");
    expect(builder.workspace).toBe("pdf");
    expect(element.pdfMode!.layouts).toHaveLength(1);
    expect(element.pdfMode!.documents!.selectedId()).toBe(element.pdfMode!.layouts[0]!.id);
  });

  it("comes back to the overview when the designer's last journey is deleted, and setMode with none opens the overview", async () => {
    const definition = withJourneys();
    definition.journey = { journeys: [withJourneys().journey!.journeys![0]!] };
    const element = await mountOn("journeys", definition);
    const builder = element.builder!;
    overview(element).querySelector<HTMLButtonElement>('[data-overview-open="journeys"]')!.click();
    await until(() => builder.mode === "journeys");
    element.journeyMode!.documents!.remove!("apply");
    await until(() => builder.mode === "form");
    expect(builder.workspace).toBe("journeys");
    expect(shell(element).querySelector<HTMLElement>("[data-overview-host]")!.hidden).toBe(false);
    builder.setWorkspace("form");
    expect(builder.setMode("journeys")).toBe(true);
    expect(builder.mode).toBe("form");
    expect(builder.workspace).toBe("journeys");
  });
});

describe("the PDF overview", () => {
  it("lists the layouts in the order they are tried, the default, each rule, and New", async () => {
    const definition: FormDefinition = {
      ...sampleDefinition(),
      pdf: {
        layouts: [
          layout("standard", "Standard"),
          layout("canada", "Canada copy", { kind: "binary", operator: "eq", left: { kind: "path", path: "country" }, right: { kind: "literal", value: "CA" } })
        ],
        defaultLayoutId: "standard"
      }
    };
    const element = await mountOn("pdf", definition);
    expect(overview(element).querySelector("h2")!.textContent).toBe("PDF layouts");
    expect(overview(element).textContent).toContain("Tried in order");
    const listed = cards(element);
    expect(listed.map((card) => card[0])).toEqual(["Standard", "Canada copy"]);
    expect(listed[0]![1]).toBe("Generated · default");
    expect(listed[1]![1]).toMatch(/^Generated · when /);
    expect([...overview(element).querySelectorAll(".out-index")].map((index) => index.textContent)).toEqual(["1", "2"]);
    expect(overview(element).querySelector('[data-overview-add="pdf"]')!.textContent).toBe("+ New layout");
    expect(overview(element).querySelector('[data-overview-open="journeys"]')).toBeNull();
  });

  it("says what prints with no layouts, and offers New", async () => {
    const element = await mountOn("pdf", sampleDefinition());
    expect(cards(element)).toEqual([]);
    expect(overview(element).querySelector("[data-overview-pdf-none]")!.textContent).toContain("prints from the form");
    expect(overview(element).querySelector('[data-overview-add="pdf"]')).not.toBeNull();
  });
});
