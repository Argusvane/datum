import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { createPdfTemplateResolver, type PdfRenderProvider, type PdfTemplateLayout } from "@argusvane/datum-engine";

import { sampleDefinition, until, pdfAlone } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

const HOSTED = { storage: "url", name: "paper.pdf", type: "application/pdf", size: 3072, ref: "/templates/paper.pdf" };

/** A provider whose `inspect` reads a converted PDF form: a name the form has, a subform path with a tooltip, a radio group, a signature. */
function provider(): PdfRenderProvider {
  const bytes = (text: string) => new TextEncoder().encode(text);
  return {
    id: "fake",
    abiVersion: "4.0.0",
    render: async () => ({ bytes: bytes("%PDF-fake"), pageCount: 1, pages: [], warnings: [], providerId: "fake" }),
    inspect: async () => ({
      pageCount: 1,
      pages: [{ index: 1, width: 612, height: 792 }],
      fields: [
        { name: "Full Name", kind: "text", page: 1, rect: { x: 250, y: 660, width: 300, height: 22 }, readOnly: false, required: false },
        {
          name: "topmostSubform[0].Page1[0].Phone[0]",
          kind: "text",
          page: 1,
          rect: { x: 250, y: 620, width: 300, height: 22 },
          readOnly: false,
          required: true,
          tooltip: "Daytime phone number"
        },
        { name: "Contact", kind: "radio", page: 1, rect: { x: 250, y: 580, width: 14, height: 14 }, options: ["Phone", "Mail"], readOnly: false, required: false },
        { name: "Signature", kind: "signature", page: 1, rect: { x: 250, y: 100, width: 200, height: 40 }, readOnly: false, required: false }
      ],
      hasXfa: false,
      encrypted: false
    }),
    fill: async () => ({ bytes: bytes("%PDF-filled"), pageCount: 1, pages: [], warnings: [], providerId: "fake", fields: [] })
  } as unknown as PdfRenderProvider;
}

function shell(element: DatumFormBuilderElement): ShadowRoot {
  return element.builder!.shadowRoot!;
}

function status(element: DatumFormBuilderElement): string {
  const canvas = shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
  return canvas.querySelector("[data-canvas-surface] [data-template-status]")?.textContent ?? "";
}

describe("Create form fields on a populated form", () => {
  it("builds the form's fields from the PDF's, fills each PDF field from its own, and undoes each side in one step", async () => {
    const element = pdfAlone();
    element.definition = sampleDefinition();
    element.pdfSupport = { provider: provider() };
    element.pdfTemplates = createPdfTemplateResolver(
      { url: async () => new Uint8Array([1, 2, 3]) },
      { templates: [{ id: "paper-host", label: "Paper (host)", source: HOSTED }] }
    );
    document.body.append(element);
    // The form declares no layout, and none is derived: the PDF side opens on its empty state.
    await until(() => shell(element).querySelector("datum-builder-canvas")?.shadowRoot?.querySelector("[data-canvas-surface] [data-pdf-empty]"));

    expect(element.builder!.newDocument("pdf")).toBe(true);
    const popover = shell(element).querySelector<HTMLElement>("[data-add-popover]")!;
    await until(() => popover.querySelector('[data-add-host="paper-host"]'));
    popover.querySelector<HTMLButtonElement>('[data-add-host="paper-host"]')!.click();
    // Named before it is made: the host's label is accepted.
    popover.querySelector<HTMLButtonElement>("[data-add-confirm]")!.click();
    await until(() => status(element).includes("4 fields on 1 page"));

    const create = shell(element).querySelector("datum-builder-canvas")!.shadowRoot!.querySelector<HTMLButtonElement>("[data-create-form-fields]")!;
    expect(create.hidden).toBe(false);
    create.click();
    await until(() => status(element).startsWith("Added"));
    expect(status(element)).toBe(
      "Added 2 form fields and filled 3 PDF fields, 1 of them from fields the form had. Left out: Signature. Undo here takes the filling back; undo on the Form tab takes the fields back."
    );

    // On the form: the new fields in the PDF's reading order, before the closing button.
    const content = () => element.definition.root.children!.content!;
    expect(content().map((node) => node.id)).toEqual(["fullName", "country", "subscribe", "email", "Phone", "Contact", "submit"]);
    expect(content()[4]).toMatchObject({ type: "text", configuration: { label: "Daytime phone number", required: true } });
    expect(content()[5]).toMatchObject({ type: "radio", configuration: { label: "Contact" } });

    // On the layout: every answer-holding field filled, the matched one from the field the form had.
    const paper = () => element.pdfMode!.layouts.find((layout) => layout.id === "paper-host") as PdfTemplateLayout;
    expect(paper().fields).toEqual([
      { pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } },
      { pdfField: "topmostSubform[0].Page1[0].Phone[0]", source: { kind: "component", componentId: "Phone" } },
      { pdfField: "Contact", source: { kind: "component", componentId: "Contact" } }
    ]);

    // One undo on the layout takes every mapping back; one on the form takes both fields back.
    element.pdfMode!.controller.undo();
    expect(paper().fields).toEqual([]);
    element.builder!.controller!.undo();
    expect(content().map((node) => node.id)).toEqual(["fullName", "country", "subscribe", "email", "submit"]);
  });

  it("builds no field under an id a journey's page-only field holds, which the form claims", async () => {
    const element = pdfAlone();
    element.definition = sampleDefinition();
    element.pdfSupport = { provider: provider() };
    element.pdfTemplates = createPdfTemplateResolver(
      { url: async () => new Uint8Array([1, 2, 3]) },
      { templates: [{ id: "paper-host", label: "Paper (host)", source: HOSTED }] }
    );
    document.body.append(element);
    // The form declares no layout, and none is derived: the PDF side opens on its empty state.
    await until(() => shell(element).querySelector("datum-builder-canvas")?.shadowRoot?.querySelector("[data-canvas-surface] [data-pdf-empty]"));
    // What the Journeys mode claims for the form while a page-only field holds the id.
    element.builder!.controller.setOptions({ claimedIds: () => ["Phone"] }, { silent: true });

    expect(element.builder!.newDocument("pdf")).toBe(true);
    const popover = shell(element).querySelector<HTMLElement>("[data-add-popover]")!;
    await until(() => popover.querySelector('[data-add-host="paper-host"]'));
    popover.querySelector<HTMLButtonElement>('[data-add-host="paper-host"]')!.click();
    popover.querySelector<HTMLButtonElement>("[data-add-confirm]")!.click();
    await until(() => status(element).includes("4 fields on 1 page"));
    shell(element).querySelector("datum-builder-canvas")!.shadowRoot!.querySelector<HTMLButtonElement>("[data-create-form-fields]")!.click();
    await until(() => status(element).startsWith("Added"));
    const ids = element.definition.root.children!.content!.map((node) => node.id);
    expect(ids).not.toContain("Phone");
    expect(ids).toEqual(["fullName", "country", "subscribe", "email", "Phone_2", "Contact", "submit"]);
  });
});
