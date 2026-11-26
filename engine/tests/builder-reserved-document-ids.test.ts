import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { addPdfLayout, duplicatePdfLayout, pdfLayoutIdFromName, replacePdfLayout, uniquePdfLayoutId } from "../form-engine/builder/pdf-designer/layout-catalog.js";
import { PDF_DOCUMENT_COMPONENT_TYPE, type PdfConfiguration, type PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A PDF layout's and a journey page's texts are translated under their ids
 * (`translations.pdf.<layout>`, `translations.journeys.<journey>.pages.<page>`), and a map
 * cannot key `__proto__`, `constructor` or `prototype`. No builder write gives a
 * layout or a page one of those ids: one made from a name steps past it, one typed is refused.
 */

function generated(id: string, name?: string): PdfGeneratedLayout {
  return { id, kind: "generated", ...(name !== undefined ? { name } : {}), root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: {}, children: { body: [], header: [], footer: [] } } };
}

describe("PDF layout ids", () => {
  it("made from a name step past a prototype name", () => {
    expect(pdfLayoutIdFromName("Constructor")).toBe("constructor");
    expect(uniquePdfLayoutId("constructor", [])).toBe("constructor-2");
    expect(uniquePdfLayoutId("prototype", ["prototype-2"])).toBe("prototype-3");
    expect(uniquePdfLayoutId("client-copy", [])).toBe("client-copy");
  });

  it("typed as one are refused on add, rename and duplicate", () => {
    const configuration: PdfConfiguration = { layouts: [generated("client")] };
    for (const id of ["__proto__", "constructor", "prototype"]) {
      expect(() => addPdfLayout(configuration, generated(id)), id).toThrow(`"${id}" cannot be a PDF layout id: it is a reserved name, and texts kept under it could not be translated (__proto__, constructor and prototype are).`);
      expect(() => replacePdfLayout(configuration, "client", generated(id)), id).toThrow(`"${id}" cannot be a PDF layout id`);
      expect(() => duplicatePdfLayout(configuration, "client", { id }), id).toThrow(`"${id}" cannot be a PDF layout id`);
    }
  });
});

const definitions: ComponentDefinition[] = [
  { type: "journey", version: "1.0.0", createDefault: () => ({ id: "journey", type: "journey", configuration: {} }), capabilities: [], children: { slots: [{ id: "pages", multiple: true }] } },
  { type: "journey-page", version: "1.0.0", createDefault: () => ({ id: "page", type: "journey-page", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } }
];

function journey(): BuilderController {
  const root: ComponentNode = { id: "root", type: "journey", configuration: {}, children: { pages: [{ id: "p1", type: "journey-page", configuration: { pageId: "start" } }] } };
  return new BuilderController({ initialRoot: root, componentDefinitions: definitions });
}

describe("journey page ids", () => {
  it("are refused as a prototype name under the box, and the draft is not saved", () => {
    const ctrl = journey();
    ctrl.select("p1");
    ctrl.setDraftProperty("p1", "pageId", "constructor");
    expect(ctrl.problemsOf("p1")).toContainEqual({ target: "pageId", message: '"constructor" cannot be a page id: it is a reserved name, and texts kept under it could not be translated (__proto__, constructor and prototype are).' });
    expect(ctrl.commitDraft("p1")).toBe(false);
    expect(ctrl.getProperty("p1", "pageId")).toBe("start");
  });

  it("are refused on a direct write and when a page is added", () => {
    const ctrl = journey();
    expect(() => ctrl.setProperty("p1", "pageId", "prototype")).toThrow('"prototype" cannot be a page id');
    expect(() => ctrl.setPropertyUnrecorded("p1", "pageId", "__proto__")).toThrow('"__proto__" cannot be a page id');
    expect(() => ctrl.setProperties([{ componentId: "p1", propertyPath: "pageId", value: "constructor" }])).toThrow('"constructor" cannot be a page id');
    expect(ctrl.getProperty("p1", "pageId")).toBe("start");
    const added = ctrl.insertComponents([{ node: { id: "p2", type: "journey-page", configuration: { pageId: "constructor" } }, parentId: "root", slotId: "pages" }]);
    expect(added).toMatchObject({ ok: false, error: '"constructor" cannot be a page id: it is a reserved name, and texts kept under it could not be translated (__proto__, constructor and prototype are).' });
    // An ordinary page id is still written.
    ctrl.setProperty("p1", "pageId", "details");
    expect(ctrl.getProperty("p1", "pageId")).toBe("details");
  });
});
