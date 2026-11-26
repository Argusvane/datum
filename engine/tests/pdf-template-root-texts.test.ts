import { describe, expect, it } from "vitest";

import type { BuilderTextCatalog } from "../form-engine/builder/logic/builder-texts.js";
import { createPdfTemplateDesigner } from "../form-engine/builder/pdf-designer/pdf-template-designer.js";
import {
  PDF_TEMPLATE_TEXT_EN,
  pdfTemplateComponentDefinitions,
  PDF_TEMPLATE_COMPONENT_TYPE as TYPE_FROM_DESIGNER_MODULE,
  type PdfTemplateText
} from "../form-engine/render/pdf/pdf-template-components.js";
import { PDF_AREA_COMPONENT_TYPE, PDF_TEMPLATE_AREAS_SLOT, PDF_TEMPLATE_COMPONENT_TYPE, PDF_WIDGET_COMPONENT_TYPE } from "../form-engine/render/pdf/pdf-template-constants.js";
import { PDF_TEMPLATE_ROOT_TYPE } from "../form-engine/builder/pdf-designer/layout-conditions.js";
import type { PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The populated-form root's labels read the words they are given, English when none are.
 * The constants live in a leaf module the conditions and the shell read without the designer's table.
 */

const FR: PdfTemplateText = (key, params) => {
  const french: Partial<Record<string, string>> = {
    "pdfTemplate.name": "Nom de la mise en page",
    "pdfTemplate.section.fill": "Options de remplissage",
    "pdfTemplate.source.kind": "Rempli depuis",
    "pdfTemplate.pdfa.3b": "PDF/A-3b (pièces jointes permises)",
    "pdfTemplate.profile.builtIn": "Intégré"
  };
  const text = french[key] ?? PDF_TEMPLATE_TEXT_EN[key];
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (params && name in params ? String(params[name]) : whole));
};

const rootOf = (texts?: PdfTemplateText) => pdfTemplateComponentDefinitions({ signatureFields: [], ...(texts ? { texts } : {}) }).find((definition) => definition.type === PDF_TEMPLATE_COMPONENT_TYPE);
const widgetOf = (texts?: PdfTemplateText) => pdfTemplateComponentDefinitions({ ...(texts ? { texts } : {}) }).find((definition) => definition.type === PDF_WIDGET_COMPONENT_TYPE);
const fieldOf = (root: ReturnType<typeof rootOf>, id: string) => root?.propertyEditor?.fields?.find((field) => field.id === id);
const sectionOf = (root: ReturnType<typeof rootOf>, id: string) => root?.propertyEditor?.sections?.find((section) => section.id === id);

describe("the populated-form root's labels", () => {
  it("keeps the constants in the leaf module, re-exported from the designer's table", () => {
    expect(TYPE_FROM_DESIGNER_MODULE).toBe(PDF_TEMPLATE_COMPONENT_TYPE);
    expect(PDF_TEMPLATE_ROOT_TYPE).toBe(PDF_TEMPLATE_COMPONENT_TYPE);
    expect(PDF_TEMPLATE_AREAS_SLOT).toBe("areas");
  });

  it("reads English when no words are given", () => {
    const root = rootOf();
    expect(fieldOf(root, "name")?.label).toBe("Layout name");
    expect(fieldOf(root, "attachment-name")?.description).toBe("Empty uses submission.json.");
    expect(sectionOf(root, "fill")?.title).toBe("Fill options");
  });

  it("reads the labels, section titles and descriptions from the words it is given", () => {
    const root = rootOf(FR);
    expect(fieldOf(root, "name")?.label).toBe("Nom de la mise en page");
    expect(sectionOf(root, "fill")?.title).toBe("Options de remplissage");
    // Not in the words it was given: the English.
    expect(fieldOf(root, "flatten")?.label).toBe("Flatten");
  });

  it("words the PDF/A levels from the words it is given, keeping the standards' ids", () => {
    const levels = (texts?: PdfTemplateText) => fieldOf(rootOf(texts), "pdfa")?.choices;
    expect(levels(FR)?.find((choice) => choice.value === "3b")?.label).toBe("PDF/A-3b (pièces jointes permises)");
    expect(levels(FR)?.map((choice) => choice.value)).toEqual(["", "2b", "2u", "2a", "3b", "3u", "3a"]);
    expect(levels(FR)?.find((choice) => choice.value === "2b")?.label).toBe("PDF/A-2b");
    expect(levels()?.find((choice) => choice.value === "3b")?.label).toBe("PDF/A-3b (attachments allowed)");
  });

  it("names the ICC picker's built-in group from the words it is given, and keeps the host's", () => {
    const profiles = (texts?: PdfTemplateText) => fieldOf(rootOf(texts), "output-intent-profile")?.assetChoices ?? [];
    const builtIn = (texts?: PdfTemplateText) => profiles(texts).filter((choice) => choice.id.startsWith("builtin:"));
    expect(builtIn(FR).length).toBeGreaterThan(0);
    expect(builtIn(FR).every((choice) => choice.group === "Intégré")).toBe(true);
    expect(builtIn().every((choice) => choice.group === "Built in")).toBe(true);
  });

  it("reads a widget's and an area's labels from the words it is given", () => {
    expect(fieldOf(widgetOf(FR), "source-kind")?.label).toBe("Rempli depuis");
    expect(sectionOf(widgetOf(FR), "mapping")?.title).toBe("Mapping");
    expect(fieldOf(widgetOf(FR), "source-value")?.label).toBe("Fixed value");
    expect(fieldOf(widgetOf(), "source-kind")?.label).toBe("Filled from");
    const area = pdfTemplateComponentDefinitions({ texts: FR }).find((definition) => definition.type === PDF_AREA_COMPONENT_TYPE);
    expect(fieldOf(area, "rect-x")?.label).toBe("X (pt)");
    expect(fieldOf(area, "label")?.label).toBe("Name");
  });
});

describe("the template designer passes the host's catalog to the root", () => {
  const layout: PdfTemplateLayout = {
    id: "paper",
    kind: "template",
    name: "Paper form",
    template: { storage: "url", name: "paper.pdf", type: "application/pdf", size: 3072, ref: "/templates/paper.pdf" },
    fields: []
  };
  const formRoot: ComponentNode = {
    id: "root",
    type: "form",
    configuration: { title: "Sample" },
    children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
  };
  const host: BuilderTextCatalog = { fr: { "pdfTemplate.name": "Nom de la mise en page (hôte)", "pdfTemplate.pdfa.3b": "PDF/A-3b (hôte)" } };

  it("reads the root's labels from the designer's locale and catalog, English without them", () => {
    const rootIn = (options: { locale?: string; textCatalog?: BuilderTextCatalog }) =>
      createPdfTemplateDesigner({ layout, formRoot, ...options }).builderOptions.componentDefinitions?.find((definition) => definition.type === PDF_TEMPLATE_COMPONENT_TYPE);

    const french = rootIn({ locale: "fr", textCatalog: host });
    expect(fieldOf(french, "name")?.label).toBe("Nom de la mise en page (hôte)");
    expect(fieldOf(french, "pdfa")?.choices?.find((choice) => choice.value === "3b")?.label).toBe("PDF/A-3b (hôte)");
    expect(fieldOf(french, "flatten")?.label).toBe("Flatten");

    const english = rootIn({ textCatalog: host });
    expect(fieldOf(english, "name")?.label).toBe("Layout name");
    expect(fieldOf(english, "pdfa")?.choices?.find((choice) => choice.value === "3b")?.label).toBe("PDF/A-3b (attachments allowed)");
  });
});
