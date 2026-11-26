import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { createPdfTemplateResolver, type PdfRenderProvider, type PdfTemplateLayout } from "@argusvane/datum-engine";

import { sampleDefinition, until, pdfAlone } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

const HOSTED = { storage: "url", name: "paper.pdf", type: "application/pdf", size: 3072, ref: "/templates/paper.pdf" };
const PHONE = "topmostSubform[0].Page1[0].Phone[0]";

/** A provider whose `inspect` reads a converted PDF form: a name the form has, a subform path, a radio group. */
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
        { name: PHONE, kind: "text", page: 1, rect: { x: 250, y: 620, width: 300, height: 22 }, readOnly: false, required: true },
        { name: "Contact", kind: "radio", page: 1, rect: { x: 250, y: 580, width: 14, height: 14 }, options: ["Phone", "Mail"], readOnly: false, required: false }
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

/** The designer over the sample form, with no layout yet: its empty state is up. */
async function mountDesigner(): Promise<DatumFormBuilderElement> {
  const element = pdfAlone();
  element.definition = sampleDefinition();
  element.pdfSupport = { provider: provider() };
  element.pdfTemplates = createPdfTemplateResolver(
    { url: async () => new Uint8Array([1, 2, 3]) },
    { templates: [{ id: "paper-host", label: "Paper (host)", source: HOSTED }] }
  );
  document.body.append(element);
  await until(() => shell(element).querySelector("datum-builder-canvas")?.shadowRoot?.querySelector("[data-canvas-surface] [data-pdf-empty]"));
  return element;
}

async function openTemplate(): Promise<DatumFormBuilderElement> {
  const element = await mountDesigner();
  expect(element.builder!.newDocument("pdf")).toBe(true);
  const popover = shell(element).querySelector<HTMLElement>("[data-add-popover]")!;
  await until(() => popover.querySelector('[data-add-host="paper-host"]'));
  popover.querySelector<HTMLButtonElement>('[data-add-host="paper-host"]')!.click();
  // Named before it is made: the host's label is accepted.
  popover.querySelector<HTMLButtonElement>("[data-add-confirm]")!.click();
  await until(() => status(element).includes("3 fields on 1 page"));
  return element;
}

const paper = (element: DatumFormBuilderElement) => element.pdfMode!.layouts.find((layout) => layout.id === "paper-host") as PdfTemplateLayout;

async function createFields(element: DatumFormBuilderElement): Promise<string> {
  const before = status(element);
  shell(element).querySelector("datum-builder-canvas")!.shadowRoot!.querySelector<HTMLButtonElement>("[data-create-form-fields]")!.click();
  await until(() => status(element) !== before);
  return status(element);
}

describe("a template layout's history, drafts and pickers across form changes", () => {
  it("keeps the layout's earlier edits undoable after Create form fields", async () => {
    const element = await openTemplate();
    const layout = element.pdfMode!.controller;
    const fullName = element.pdfMode!.templateDesigner!.widgetIdFor("Full Name")!;
    layout.setProperty(fullName, "source", { kind: "literal", value: "HAND" });
    expect(await createFields(element)).toMatch(/^Added 2 form fields/);
    layout.undo();
    expect(paper(element).fields).toEqual([{ pdfField: "Full Name", source: { kind: "literal", value: "HAND" } }]);
    expect(layout.canUndo()).toBe(true);
    layout.undo();
    expect(paper(element).fields).toEqual([]);
  });

  it("refuses Create form fields while the layout holds an unsaved edit, and keeps that edit", async () => {
    const element = await openTemplate();
    const layout = element.pdfMode!.controller;
    const phone = element.pdfMode!.templateDesigner!.widgetIdFor(PHONE)!;
    layout.select(phone);
    layout.setDraftProperty(phone, "source", { kind: "component", componentId: "email" });
    expect(await createFields(element)).toBe(`This layout has unsaved edits to ${phone}: save or discard them, then create the fields.`);
    expect(layout.hasPendingChanges(phone)).toBe(true);
    expect(layout.draftProperty(phone, "source")).toEqual({ kind: "component", componentId: "email" });
    expect(element.definition.root.children!.content!.map((node) => node.id)).toEqual(["fullName", "country", "subscribe", "email", "submit"]);
  });

  it("keeps the layout's history, drafts and selection through an edit on the Form tab", async () => {
    const element = await openTemplate();
    const layout = element.pdfMode!.controller;
    const designer = element.pdfMode!.templateDesigner!;
    layout.setProperty(designer.widgetIdFor("Full Name")!, "source", { kind: "literal", value: "HAND" });
    const phone = designer.widgetIdFor(PHONE)!;
    layout.select(phone);
    layout.setDraftProperty(phone, "source", { kind: "literal", value: "draft" });
    element.builder!.controller.setProperty("email", "label", "E-mail");
    await element.pdfMode!.selectLayout("paper-host");
    expect(element.pdfMode!.controller).toBe(layout);
    expect(layout.canUndo()).toBe(true);
    expect(layout.selectedComponentId()).toBe(phone);
    expect(layout.hasPendingChanges(phone)).toBe(true);
    // The pickers follow the form all the same.
    expect(element.pdfMode!.templateDesigner!.components.find((component) => component.id === "email")?.label).toBe("E-mail");
  });

  it("suggests a mapping from a form field added after the layout opened", async () => {
    const element = await openTemplate();
    const result = element.builder!.controller.insertComponents(
      [{ node: { id: "phone", type: "text", configuration: { label: "Phone" } }, parentId: "root", slotId: "content", index: 0 }],
      { select: "none" }
    );
    expect(result.ok).toBe(true);
    await element.pdfMode!.selectLayout("paper-host");
    element.pdfMode!.suggestMappings();
    expect(paper(element).fields).toContainEqual({ pdfField: PHONE, source: { kind: "component", componentId: "phone" } });
  });

  it("builds again for fields whose components an undo on the Form tab took away", async () => {
    const element = await openTemplate();
    expect(await createFields(element)).toMatch(/^Added 2 form fields/);
    element.builder!.controller.undo();
    expect(element.definition.root.children!.content!.map((node) => node.id)).toEqual(["fullName", "country", "subscribe", "email", "submit"]);
    const phone = element.pdfMode!.templateDesigner!.widgetIdFor(PHONE)!;
    await element.pdfMode!.selectLayout("paper-host");
    expect(element.pdfMode!.controller.notesOf(phone)).toEqual([expect.objectContaining({ target: "source.componentId", message: expect.stringContaining('"Phone", which the form no longer has') })]);
    expect(await createFields(element)).toMatch(/^Added 2 form fields/);
    const ids = element.definition.root.children!.content!.map((node) => node.id);
    const dangling = paper(element).fields.filter((mapping) => mapping.source.kind === "component" && !ids.includes(mapping.source.componentId));
    expect(dangling).toEqual([]);
  });
});

describe("a template layout added is one step of the form's history", () => {
  it("takes back the layout added from the Add popover, and Redo makes it again over the same PDF", async () => {
    const element = await openTemplate();
    const form = element.builder!.controller;
    const added = JSON.stringify(paper(element));
    element.builder!.undo();
    await until(() => element.pdfMode!.layouts.length === 0);
    expect(form.canUndo()).toBe(false);
    element.builder!.redo();
    expect(JSON.stringify(paper(element))).toBe(added);
    // The designer reads the PDF again: its pages and fields are back.
    await until(() => status(element).includes("3 fields on 1 page"));
    expect(element.pdfMode!.templateDesigner!.widgetIdFor("Full Name")).toBeDefined();
    expect(form.canRedo()).toBe(false);
  });

  it("brings a host's template layout back on Redo with its mappings and areas, its designer over them", async () => {
    const element = await mountDesigner();
    const form = element.builder!.controller;
    const layout: PdfTemplateLayout = {
      id: "hosted",
      kind: "template",
      name: "Hosted",
      template: HOSTED as PdfTemplateLayout["template"],
      fields: [{ pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } }],
      areas: [{ id: "a1", page: 1, rect: { x: 40, y: 40, width: 120, height: 20 }, source: { kind: "literal", value: "Stamp" } }]
    };
    element.pdfMode!.addLayout(layout, { select: true });
    await until(() => status(element).includes("3 fields on 1 page"));
    element.builder!.undo();
    await until(() => element.pdfMode!.layouts.length === 0);
    expect(form.canUndo()).toBe(false);
    element.builder!.redo();
    expect(element.pdfMode!.layouts).toEqual([layout]);
    await until(() => element.pdfMode!.ready && status(element).includes("3 fields on 1 page"));
    // The tree the designer built holds the mapping and the area again: the layout it gives back is the one added.
    expect(element.pdfMode!.pdfLayout).toMatchObject({ fields: layout.fields, areas: layout.areas });
    expect(form.canRedo()).toBe(false);
  });
});
