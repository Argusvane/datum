import { describe, expect, it } from "vitest";

import { layoutTextChanges, pdfLayoutTexts, pdfOutsideTexts, setPdfLayoutDefaults } from "../form-engine/builder/pdf-designer/pdf-layout-texts.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import type { PdfConfiguration, PdfGeneratedLayout, PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The PDF layouts' texts as the Languages workspace lists and writes them: every
 * text a string in the default language, listed with the address its translations live at; the
 * layouts hold the defaults and the definition's map holds the translations.
 */

const PDF: PdfConfiguration = {
  layouts: [
    {
      id: "copy",
      kind: "generated",
      name: "Applicant copy",
      accessibility: { title: "Permit" },
      conformance: { pdfa: "3b", attachment: { name: "data.json", description: "Submission data" } },
      signature: { reason: "I approve" },
      root: {
        id: "document",
        type: "pdf-document",
        configuration: {},
        children: {
          body: [
            { id: "intro", type: "pdf-text", configuration: { text: "Hello {{name}}", variant: "body" } },
            { id: "sec", type: "pdf-section", configuration: { label: "Applicant" }, children: { content: [{ id: "inner", type: "pdf-text", configuration: { text: "Inside" } }] } },
            { id: "rule", type: "pdf-rule", configuration: {} }
          ],
          header: [{ id: "head", type: "pdf-text", configuration: { text: "Header" } }]
        }
      }
    },
    {
      id: "paper",
      kind: "template",
      name: "Paper form",
      template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 1, data: "AA==" },
      fields: [{ pdfField: "Name", source: { kind: "component", componentId: "name" } }, { pdfField: "topmostSubform[0].Greeting[0]", source: { kind: "template", text: "Dear {{name}}" } }],
      areas: [{ id: "a1", page: 0, rect: { x: 1, y: 1, width: 10, height: 10 }, kind: "text", source: { kind: "template", text: "Area text" } } as never]
    }
  ]
};

describe("the PDF layouts' texts", () => {
  const texts = pdfLayoutTexts(PDF, "en", {});
  const at = (group: string, path: string) => texts.find((text) => text.componentId === group && text.propertyPath === path);

  it("lists the name, title, attachment description and signature reason of every layout, written or not, each at its address", () => {
    expect(at("pdf.copy", "name")).toMatchObject({ label: "Layout name", componentLabel: "PDF layout · Applicant copy", default: "Applicant copy", address: { kind: "pdf", owner: "copy", path: ["name"] } });
    expect(at("pdf.copy", "accessibility.title")).toMatchObject({ label: "Document title", default: "Permit", address: { kind: "pdf", owner: "copy", path: ["accessibility", "title"] } });
    expect(at("pdf.copy", "conformance.attachment.description")).toMatchObject({ default: "Submission data", address: { path: ["conformance", "attachment", "description"] } });
    expect(at("pdf.copy", "signature.reason")).toMatchObject({ default: "I approve", address: { path: ["signature", "reason"] } });
    // A text the paper form's author has not written is still a row.
    expect(at("pdf.paper", "accessibility.title")).toMatchObject({ default: "" });
    expect(at("pdf.paper", "name")).toMatchObject({ default: "Paper form" });
  });

  it("lists the headings and static text of a generated layout's body, header and footer by node id, and a template's fill texts by field name and area id", () => {
    expect(at("pdf.copy.intro", "text")).toMatchObject({ label: "Text", default: "Hello {{name}}", address: { kind: "pdf", owner: "copy", path: ["nodes", "intro", "text"] } });
    expect(at("pdf.copy.sec", "label")).toMatchObject({ label: "Heading", default: "Applicant", address: { path: ["nodes", "sec", "label"] } });
    expect(at("pdf.copy.inner", "text")).toBeDefined();
    expect(at("pdf.copy.head", "text")).toBeDefined();
    expect(texts.some((text) => text.componentId === "pdf.copy.rule")).toBe(false);
    // A field is keyed by its AcroForm name as one segment (dots and brackets included), never by its place in the list.
    expect(at("pdf.paper.fields", "topmostSubform[0].Greeting[0].source.text")).toMatchObject({
      label: "Text filled into topmostSubform[0].Greeting[0]",
      default: "Dear {{name}}",
      address: { kind: "pdf", owner: "paper", path: ["fields", "topmostSubform[0].Greeting[0]", "text"] }
    });
    expect(at("pdf.paper.areas", "a1.source.text")).toMatchObject({ default: "Area text", address: { path: ["areas", "a1", "text"] } });
    expect(at("pdf.paper.fields", "Name.source.text")).toBeUndefined();
  });

  it("words a layout's name in the group heading from the map, and the host's catalog wins", () => {
    const translations = { fr: { pdf: { copy: { name: { text: "Copie du demandeur", source: sourceHash("Applicant copy") } } } } };
    const french = pdfLayoutTexts(PDF, "fr-CA", { translations });
    expect(french.find((text) => text.componentId === "pdf.copy" && text.propertyPath === "name")!.componentLabel).toBe("PDF layout · Copie du demandeur");
    const hosted = pdfLayoutTexts(PDF, "fr", { translations, catalog: { fr: { pdf: { copy: { name: "Copie" } } } } });
    expect(hosted.find((text) => text.componentId === "pdf.copy" && text.propertyPath === "name")!.componentLabel).toBe("PDF layout · Copie");
  });

  it("lists the same texts with their defaults for the controller's Make default and Apply", () => {
    const outside = pdfOutsideTexts(PDF);
    expect(outside).toHaveLength(texts.length);
    expect(outside).toContainEqual({ address: { kind: "pdf", owner: "copy", path: ["nodes", "sec", "label"] }, default: "Applicant" });
    expect(pdfOutsideTexts(undefined)).toEqual([]);
  });

  it("leaves an id the map cannot hold out of the list", () => {
    const unsafe: PdfConfiguration = {
      layouts: [{ ...(PDF.layouts![0] as PdfGeneratedLayout), root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "__proto__", type: "pdf-text", configuration: { text: "x" } }] } } }]
    };
    expect(pdfLayoutTexts(unsafe, "en", {}).some((text) => text.componentId.endsWith("__proto__"))).toBe(false);
  });

  it("writes a default back at the place it was listed, on a copy", () => {
    const next = setPdfLayoutDefaults(PDF, [
      { address: { kind: "pdf", owner: "copy", path: ["name"] }, default: "Copie" },
      { address: { kind: "pdf", owner: "copy", path: ["conformance", "attachment", "description"] }, default: "Données" },
      { address: { kind: "pdf", owner: "copy", path: ["nodes", "sec", "label"] }, default: "Demandeur" },
      { address: { kind: "pdf", owner: "paper", path: ["fields", "topmostSubform[0].Greeting[0]", "text"] }, default: "Cher {{name}}" },
      { address: { kind: "pdf", owner: "paper", path: ["areas", "a1", "text"] }, default: "Texte" },
      { address: { kind: "pdf", owner: "paper", path: ["accessibility", "title"] }, default: "Form" }
    ]);
    const layouts = next.layouts as unknown as [Record<string, any>, Record<string, any>];
    expect(layouts[0].name).toBe("Copie");
    expect(layouts[0].conformance).toEqual({ pdfa: "3b", attachment: { name: "data.json", description: "Données" } });
    expect(layouts[0].root.children.body[1].configuration.label).toBe("Demandeur");
    expect(layouts[1].fields[1].source.text).toBe("Cher {{name}}");
    expect(layouts[1].areas[0].source.text).toBe("Texte");
    expect(layouts[1].accessibility).toEqual({ title: "Form" });
    // The input is untouched; an address whose layout, node or mapping is gone lands nowhere and the input comes back.
    expect((PDF.layouts as unknown as [Record<string, any>])[0].name).toBe("Applicant copy");
    expect(
      setPdfLayoutDefaults(PDF, [
        { address: { kind: "pdf", owner: "gone", path: ["name"] }, default: "x" },
        { address: { kind: "pdf", owner: "copy", path: ["nodes", "gone", "text"] }, default: "x" },
        { address: { kind: "pdf", owner: "copy", path: ["nodes", "rule", "text"] }, default: "x" },
        { address: { kind: "pdf", owner: "paper", path: ["fields", "Name", "text"] }, default: "x" },
        { address: { kind: "components", owner: "copy", path: ["label"] }, default: "x" }
      ])
    ).toBe(PDF);
  });
});

describe("what an edit of a layout does to the addresses of its texts", () => {
  const copy = PDF.layouts![0] as PdfGeneratedLayout;
  const paper = PDF.layouts![1] as PdfTemplateLayout;
  const withBody = (layout: PdfGeneratedLayout, children: Record<string, ComponentNode[]>): PdfGeneratedLayout => ({
    ...layout,
    root: { ...layout.root, children: { ...layout.root.children, ...children } }
  });

  it("prunes a node that is gone, with the nodes inside it", () => {
    const after = withBody(copy, { body: [{ id: "intro", type: "pdf-text", configuration: { text: "Hello {{name}}" } }] });
    const { prune, move } = layoutTextChanges(copy, after);
    expect(move).toEqual([]);
    expect(prune.map((prefix) => prefix.path)).toEqual([["nodes", "sec"], ["nodes", "inner"], ["nodes", "rule"]]);
    expect(prune.every((prefix) => prefix.kind === "pdf" && prefix.owner === "copy")).toBe(true);
  });

  it("moves a node whose id changed and nothing else did", () => {
    const body = copy.root.children!.body!.map((node) => (node.id === "intro" ? { ...node, id: "greeting" } : node));
    const { prune, move } = layoutTextChanges(copy, withBody(copy, { body }));
    expect(prune).toEqual([]);
    expect(move).toEqual([{ from: { kind: "pdf", owner: "copy", path: ["nodes", "intro"] }, to: { kind: "pdf", owner: "copy", path: ["nodes", "greeting"] } }]);
  });

  it("treats a node deleted while another is added as a deletion, not a rename of the first", () => {
    const body = [...copy.root.children!.body!.filter((node) => node.id !== "intro"), { id: "extra", type: "pdf-text", configuration: { text: "New" } }];
    const { prune, move } = layoutTextChanges(copy, withBody(copy, { body }));
    expect(move).toEqual([]);
    expect(prune).toEqual([{ kind: "pdf", owner: "copy", path: ["nodes", "intro"] }]);
  });

  it("prunes a mapping or an area that is gone, and a fill text whose source stopped being a text", () => {
    const fewer: PdfTemplateLayout = { ...paper, fields: [paper.fields[0]!], areas: [] };
    expect(layoutTextChanges(paper, fewer).prune).toEqual([
      { kind: "pdf", owner: "paper", path: ["fields", "topmostSubform[0].Greeting[0]"] },
      { kind: "pdf", owner: "paper", path: ["areas", "a1"] }
    ]);
    const rewired: PdfTemplateLayout = { ...paper, fields: [paper.fields[0]!, { pdfField: "topmostSubform[0].Greeting[0]", source: { kind: "component", componentId: "name" } }], areas: paper.areas! };
    expect(layoutTextChanges(paper, rewired).prune).toEqual([{ kind: "pdf", owner: "paper", path: ["fields", "topmostSubform[0].Greeting[0]"] }]);
    expect(layoutTextChanges(paper, paper)).toEqual({ prune: [], move: [] });
  });
});
