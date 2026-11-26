import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { PdfGeneratedLayout, PdfTemplateLayout } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { modesReady, sampleDefinition, until } from "./helpers.js";
import { builderDrag, propsOf, shellOf } from "./builder-ported-fixture.js";

/*
 * The PDF side on the builder: drops on a band's label and on blank paper, and the unsaved-edits
 * guard on a move between documents. Ported from the retired demo app's PDF tests.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function layout(id: string, text: string): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name: id,
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: {
        header: [{ id: `${id}-head`, type: "pdf-text", configuration: { text: "Header text" } }],
        body: [{ id: `${id}-name`, type: "pdf-field", configuration: { componentId: "fullName" } }, { id: `${id}-text`, type: "pdf-text", configuration: { text } }],
        footer: [{ id: `${id}-foot`, type: "pdf-text", configuration: { text: "Footer text" } }]
      }
    }
  };
}

const templateLayout = (): PdfTemplateLayout => ({
  id: "paper",
  kind: "template",
  name: "Paper form",
  template: { storage: "url", name: "paper.pdf", type: "application/pdf", size: 3072, ref: "/templates/paper.pdf" },
  fields: [{ pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } }]
});

async function mountWithLayouts(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = { ...sampleDefinition(), pdf: { layouts: [layout("letter", "Original"), templateLayout()], defaultLayoutId: "letter" } };
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  await modesReady(element);
  return element;
}

/** Puts a document on the page through the unsaved-edits guard: the form, or a PDF layout by id. */
const openDocument = (element: DatumFormBuilderElement, id: string): boolean =>
  id === "form" ? element.builder!.setMode("form") : element.builder!.selectDocument("pdf", id);

const previewRoot = (element: DatumFormBuilderElement): ShadowRoot =>
  (shellOf(element).querySelector("datum-builder-canvas") as unknown as { previewRoot(): ShadowRoot }).previewRoot();

const face = (element: DatumFormBuilderElement): string =>
  shellOf(element).querySelector("[data-document-face] [data-document-picker-name]")!.textContent!.trim();

async function openLayout(element: DatumFormBuilderElement, id: string): Promise<void> {
  expect(openDocument(element, id)).toBe(true);
  await until(() => element.builder!.mode === "pdf" && element.builder!.activeController.snapshot().type === "pdf-document" && previewRoot(element)?.querySelector(".datum-pdf-sheet"));
}

describe("a drop on the PDF sheet", () => {
  it("takes a drop on a band's own label into that band, and one on blank paper into the body, never the header for being drawn first", async () => {
    const element = await mountWithLayouts();
    await openLayout(element, "letter");
    await until(() => previewRoot(element).querySelector(".datum-pdf-page__band--footer"));
    const sheet = previewRoot(element);
    const zoneOf = (slot: string): HTMLElement =>
      sheet.querySelector<HTMLElement>(`[data-dropzone][data-parent-id="document"][data-slot-id="${slot}"]`)!;
    const payload = { kind: "template-component", component: { id: "note", type: "pdf-text", configuration: { text: "Reviewed" } } };
    const drag = (type: string): DragEvent => builderDrag(type, payload, { position: 999, effectAllowed: "copy" });

    // The footer band's label is outside the band's zone. A drag over it used to fall through to
    // the root's first zone in document order, the header band, so the footer could take a drop
    // only over a component already inside it.
    const footerLabel = sheet.querySelector<HTMLElement>(".datum-pdf-page__band--footer > .datum-pdf-page__band-label")!;
    expect(footerLabel).toBeTruthy();
    const overLabel = drag("dragover");
    footerLabel.dispatchEvent(overLabel);
    expect(overLabel.defaultPrevented).toBe(true);
    expect(zoneOf("footer").hasAttribute("data-db-drag-over")).toBe(true);
    expect(zoneOf("footer").querySelector(".db-marker")).toBeTruthy();
    expect(zoneOf("header").hasAttribute("data-db-drag-over")).toBe(false);

    // Blank paper (the page's margins, the space under the last block) is the document's body.
    sheet.querySelector<HTMLElement>(".datum-pdf-page")!.dispatchEvent(drag("dragover"));
    expect(zoneOf("body").querySelector(".db-marker")).toBeTruthy();
    expect(zoneOf("header").querySelector(".db-marker")).toBeNull();
    expect(zoneOf("footer").hasAttribute("data-db-drag-over")).toBe(false);

    // The drop goes where the marker was: the label puts the text in the footer.
    footerLabel.dispatchEvent(drag("dragover"));
    footerLabel.dispatchEvent(drag("drop"));
    const root = element.builder!.activeController.snapshot();
    expect(root.children?.footer?.map((node) => node.type)).toEqual(["pdf-text", "pdf-text"]);
    expect(root.children?.footer?.at(-1)?.configuration).toMatchObject({ text: "Reviewed" });
    expect(root.children?.header).toHaveLength(1);
  });
});

describe("moving between documents with an unsaved edit", () => {
  it("holds a move to another layout by the leaving prompt, and Save lands the draft in the layout it was typed in", async () => {
    const element = await mountWithLayouts();
    await openLayout(element, "letter");
    const controller = element.builder!.activeController;
    const added = controller.snapshot().children!.body!.find((node) => node.id === "letter-text")!;
    controller.select(added.id);
    controller.setDraftProperty(added.id, "text", "Reviewed by nobody");

    // Another layout is held by the same prompt leaving the page puts up; the page stays where it was.
    expect(openDocument(element, "paper")).toBe(false);
    await until(() => propsOf(element).querySelector("dialog[data-unsaved-prompt]"));
    expect(propsOf(element).querySelector("dialog[data-unsaved-prompt]")!.textContent).toContain("leaving the builder");
    expect(face(element)).toBe("letter");

    propsOf(element).querySelector<HTMLButtonElement>("[data-unsaved-save]")!.click();
    await until(() => face(element) === "Paper form");
    expect(element.builder!.mode).toBe("pdf");

    // The draft was saved into the layout it belonged to, and the definition carries it.
    const letter = (element.definition.pdf!.layouts![0] as PdfGeneratedLayout).root.children!.body!.find((node) => node.id === "letter-text")!;
    expect(letter.configuration).toMatchObject({ text: "Reviewed by nobody" });
    await openLayout(element, "letter");
    await until(() => previewRoot(element).textContent!.includes("Reviewed by nobody"));
  });

  it("holds a form draft's move to a layout, and Discard lets the move go through", async () => {
    const element = await mountWithLayouts();
    expect(element.builder!.mode).toBe("form");
    const controller = element.builder!.controller;
    controller.select("fullName");
    controller.setDraftProperty("fullName", "label", "Full name, edited");

    expect(openDocument(element, "letter")).toBe(false);
    expect(element.builder!.mode).toBe("form");
    await until(() => propsOf(element).querySelector("dialog[data-unsaved-prompt]"));

    propsOf(element).querySelector<HTMLButtonElement>("[data-unsaved-discard]")!.click();
    await until(() => element.builder!.mode === "pdf");
    // Discarded, not saved: the form's label is as it was.
    const node = element.definition.root.children!.content!.find((child) => child.id === "fullName")!;
    expect((node.configuration as { label?: string }).label).toBe("Full name");
  });
});
