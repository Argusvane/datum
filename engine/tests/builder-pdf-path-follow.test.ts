import { describe, expect, it } from "vitest";
import { BuilderController, dependentsOf } from "../form-engine/builder/controller/builder-controller.js";
import { followRenameInLayoutTree, renamePdfLayoutConditions } from "../form-engine/builder/pdf-designer/layout-conditions.js";
import { createPdfTemplateDesigner, followRenameInTemplateTree } from "../form-engine/builder/pdf-designer/pdf-template-designer.js";
import { PDF_DOCUMENT_COMPONENT_TYPE, PDF_REPEAT_COMPONENT_TYPE, type PdfConfiguration, type PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { PdfTemplateInfo } from "../form-engine/render/pdf/pdf-abi.js";

const move = { from: "applicant.email", to: "applicant.mail" };
const templateConfiguration = (): PdfConfiguration =>
  ({
    layouts: [
      {
        id: "t",
        kind: "template",
        template: { storage: "base64", name: "x.pdf", data: "" },
        fields: [
          { pdfField: "q", source: { kind: "path", path: "applicant.email" } },
          { pdfField: "sku0", source: { kind: "path", path: "items[0].sku" } },
          { pdfField: "other", source: { kind: "path", path: "other.email" } }
        ]
      }
    ]
  }) as unknown as PdfConfiguration;
const sources = (configuration: PdfConfiguration): unknown[] => (configuration.layouts![0] as PdfTemplateLayout).fields.map((field) => (field.source as { path?: string }).path);

describe("a PDF path source follows the move of the data", () => {
  it("a field renamed inside a container: the source follows by data path, other data stays", () => {
    const followed = renamePdfLayoutConditions(templateConfiguration(), "email", "mail", move);
    expect(sources(followed.configuration)).toEqual(["applicant.mail", "items[0].sku", "other.email"]);
    expect(followed.renamed).toEqual(["t"]);
  });
  it("a field renamed inside a repeating section keeps the entry index", () => {
    const followed = renamePdfLayoutConditions(templateConfiguration(), "sku", "code", { from: "items[].sku", to: "items[].code" });
    expect(sources(followed.configuration)).toEqual(["applicant.email", "items[0].code", "other.email"]);
  });
  it("a section renamed by its id (no data path to follow) leads the indexed path", () => {
    const followed = renamePdfLayoutConditions(templateConfiguration(), "items", "lines");
    expect(sources(followed.configuration)).toEqual(["applicant.email", "lines[0].sku", "other.email"]);
  });
  it("a generated repeat's collection path follows; a component binding follows by id", () => {
    const configuration = {
      layouts: [
        {
          id: "g",
          kind: "generated",
          name: "G",
          root: {
            id: "document",
            type: PDF_DOCUMENT_COMPONENT_TYPE,
            configuration: {},
            children: { body: [{ id: "rep", type: PDF_REPEAT_COMPONENT_TYPE, configuration: { collectionPath: "applicant.rows" } }, { id: "f", type: "pdf-field", configuration: { componentId: "rows" } }] }
          }
        }
      ]
    } as unknown as PdfConfiguration;
    const followed = renamePdfLayoutConditions(configuration, "rows", "lines", { from: "applicant.rows", to: "applicant.lines" });
    const body = (followed.configuration.layouts![0] as unknown as { root: ComponentNode }).root.children!.body!;
    expect(body.map((node) => node.configuration)).toEqual([{ collectionPath: "applicant.lines" }, { componentId: "lines" }]);
  });
  it("an open template tree follows the same way, and undo restores it", () => {
    const INSPECTION: PdfTemplateInfo = {
      pageCount: 1,
      pages: [{ index: 1, width: 612, height: 792 }],
      fields: [{ name: "Email", kind: "text", page: 1, rect: { x: 1, y: 1, width: 100, height: 20 }, readOnly: false, required: false }],
      hasXfa: false,
      encrypted: false
    };
    const form: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [] } };
    const designer = createPdfTemplateDesigner({
      layout: { id: "paper", kind: "template", name: "P", template: { storage: "url", name: "p.pdf", type: "application/pdf", size: 1, ref: "/p.pdf" }, fields: [{ pdfField: "Email", source: { kind: "path", path: "applicant.email" } }] } as PdfTemplateLayout,
      inspection: INSPECTION,
      formRoot: form
    });
    const controller = new BuilderController();
    controller.setOptions(designer.builderOptions);
    const before = JSON.stringify(controller.snapshot());
    expect(followRenameInTemplateTree(controller, "email", "mail", move).changed).toBe(true);
    expect(JSON.stringify(controller.snapshot())).toContain('"path":"applicant.mail"');
    controller.undo();
    expect(JSON.stringify(controller.snapshot())).toBe(before);
  });
  it("an open generated tree follows a collection path by the move", () => {
    const controller = new BuilderController({
      initialRoot: {
        id: "document",
        type: PDF_DOCUMENT_COMPONENT_TYPE,
        configuration: {},
        children: { body: [{ id: "rep", type: PDF_REPEAT_COMPONENT_TYPE, configuration: { collectionPath: "applicant.rows" } }] }
      }
    });
    expect(followRenameInLayoutTree(controller, "rows", "lines", { from: "applicant.rows", to: "applicant.lines" })).toBe(true);
    expect(controller.getProperty("rep", "collectionPath")).toBe("applicant.lines");
  });
});

describe("the delete listing reads an indexed path source", () => {
  const form: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: { content: [{ id: "items", type: "repeating-section", configuration: {}, collection: { collectionPath: "items" }, children: { content: [{ id: "sku", type: "text", configuration: {} }] } }] }
  };
  it("lists a layout that reads items[0].sku when the field or its section goes", () => {
    const pdf = templateConfiguration();
    expect(dependentsOf({ root: form, pdf }, "sku").map((entry) => entry.kind)).toEqual(["pdf"]);
    expect(dependentsOf({ root: form, pdf }, "items").map((entry) => entry.kind)).toEqual(["pdf"]);
    expect(dependentsOf({ root: form, pdf }, "nothing")).toEqual([]);
  });
});
