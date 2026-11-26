// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { GenerateOptions } from "../form-engine/builder/data-model/index.js";
import type { BuilderTextCatalog } from "../form-engine/builder/logic/builder-texts.js";
import { bindableComponents } from "../form-engine/builder/pdf-designer/pdf-designer.js";
import { createAddPopover, createPreviewDialog, fillReportHtml, layoutLine } from "../form-engine/builder/pdf-designer/pdf-designer-panels.js";
import {
  pdfLayoutConditionFindings,
  pdfLayoutOrderInWords,
  pdfLayoutRuleDescriptors,
  pdfLayoutRulesNote,
  type PdfLayoutConditionContext
} from "../form-engine/builder/pdf-designer/layout-conditions.js";
import { planTemplateFormFields, templateFieldBoxesHtml } from "../form-engine/builder/pdf-designer/template-mode.js";
import { createTemplatePageViewer } from "../form-engine/builder/pdf-designer/template-pages.js";
import { PDF_DOCUMENT_COMPONENT_TYPE, type PdfConfiguration, type PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { PdfFillReport, PdfTemplateFieldInfo, PdfTemplateInfo } from "../form-engine/render/pdf/pdf-abi.js";
import type { RenderFormPdfResult } from "../form-engine/render/pdf/pdf-service.js";

/**
 * The PDF designer's words: each surface reads the builder's locale and the host's
 * `BuilderTextCatalog`, and one overridden key shows through it; English stays what it was.
 */

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Intake" },
  children: { content: [{ id: "province", type: "select", configuration: { label: "Province" } }] }
};

const FR: BuilderTextCatalog = {
  fr: {
    "pdf.rules.when": "Imprimer cette mise en page lorsque",
    "pdf.order.none": "Aucune condition : {name} imprime par défaut.",
    "pdf.finding.noDefault": "Aucun défaut : {name} imprime si aucune condition ne tient.",
    "pdf.rulesNote.tried": "Sa condition est essayée {ordinal} sur {count} ; {fallback} imprime.",
    "pdf.skip.button": "Un bouton ne contient aucune réponse.",
    "pdf.field.unresolved": "{name} ({kind}) : rempli depuis « {source} », absent du formulaire",
    "pdf.preview.label": "Aperçu PDF",
    "pdf.preview.close": "Fermer",
    "pdf.preview.sec.pages": "Pages (fr)",
    "pdf.add.label": "Ajouter une mise en page",
    "pdf.add.custom": "Mise en page personnalisée",
    "pdf.pages.blank": "Pages vierges",
    "pdf.page.drag": "Page {page} : glisser pour dessiner une zone"
  }
};

/** The builder options the helpers take: a locale and its catalog. */
const FR_OPTIONS = { locale: "fr", catalog: FR } as const;

function generated(id: string, name: string, when?: PdfGeneratedLayout["when"]): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name,
    root: {
      id: "document",
      type: PDF_DOCUMENT_COMPONENT_TYPE,
      configuration: {},
      children: { body: [{ id: "f", type: "pdf-field", configuration: { componentId: "province" } }], header: [], footer: [] }
    },
    ...(when !== undefined ? { when } : {})
  };
}

const QUEBEC = { kind: "binary", operator: "eq", left: { kind: "path", path: "province" }, right: { kind: "literal", value: "QC" } } as never;

describe("the PDF layout conditions' words follow the host's catalog", () => {
  const context = (extra: Partial<PdfLayoutConditionContext> = {}): PdfLayoutConditionContext => ({ formRoot: FORM, locale: "en", ...extra });

  it("reads the rule label, the order, the findings and the Rules tab's place from the catalog", () => {
    expect(pdfLayoutRuleDescriptors("pdf-document", FR_OPTIONS)[0]!.label).toBe("Imprimer cette mise en page lorsque");
    expect(pdfLayoutRuleDescriptors("pdf-document")[0]!.label).toBe("Print this layout when");

    const standard: PdfConfiguration = { layouts: [generated("standard", "Standard")], defaultLayoutId: "standard" };
    expect(pdfLayoutOrderInWords(context({ locale: "fr", textCatalog: FR }), standard)).toBe("Aucune condition : Standard imprime par défaut.");
    expect(pdfLayoutOrderInWords(context(), standard)).toBe("No layout has a condition: a download that names none prints Standard, the default.");

    const undeclared: PdfConfiguration = { layouts: [generated("quebec", "Quebec copy", QUEBEC), generated("standard", "Standard")] };
    expect(pdfLayoutConditionFindings(context({ locale: "fr", textCatalog: FR }), undeclared)).toEqual([
      expect.objectContaining({ code: "pdf-layout.no-default", message: "Aucun défaut : \"Quebec copy\" imprime si aucune condition ne tient." })
    ]);

    const placed: PdfConfiguration = { layouts: [generated("quebec", "Quebec copy", QUEBEC), generated("standard", "Standard")], defaultLayoutId: "standard" };
    expect(pdfLayoutRulesNote(context({ locale: "fr", textCatalog: FR }), placed, "quebec")).toContain("Sa condition est essayée 1st sur 1 ; Standard imprime.");
    expect(pdfLayoutRulesNote(context(), placed, "quebec")).toContain("Its condition is tried 1st of 1; when none holds, Standard prints.");
  });
});

describe("the template planner and the schematic read the host's catalog", () => {
  it("words a skipped field's reason and an unresolved field box's title from the catalog", () => {
    const controller = new BuilderController({ initialRoot: FORM });
    const options: GenerateOptions = { hasType: (type) => controller.hasComponentType(type), template: (type) => controller.componentTemplate(type) };
    const button: PdfTemplateFieldInfo = { name: "Send", kind: "button", readOnly: false, required: false };
    const english = planTemplateFormFields([button], FORM, bindableComponents(FORM, "en"), options);
    expect(english.skipped).toEqual([{ pdfField: "Send", reason: "A button holds no answer." }]);
    const french = planTemplateFormFields([button], FORM, bindableComponents(FORM, "fr"), options, FR_OPTIONS);
    expect(french.skipped).toEqual([{ pdfField: "Send", reason: "Un bouton ne contient aucune réponse." }]);

    const inspection = {
      pages: [{ index: 1, width: 612, height: 792 }],
      fields: [{ name: "Name", kind: "text", readOnly: false, required: false, page: 1, rect: { x: 10, y: 10, width: 100, height: 20 } }]
    } as unknown as PdfTemplateInfo;
    const html = templateFieldBoxesHtml(inspection, 1, {
      unresolved: new Map([["Name", "Old name"]]),
      escape: (value: string) => value,
      text: FR_OPTIONS
    });
    expect(html).toContain("<title>Name (text) : rempli depuis « Old name », absent du formulaire</title>");
  });
});

describe("the preview dialog, the add popover, the page viewer and the report read the host's catalog", () => {
  it("shows the overridden words on each surface, English unchanged without a catalog", () => {
    expect(layoutLine({ layoutChoice: "open" } as never, { layoutName: "Standard" }, FR_OPTIONS)).toBe("Standard, the open layout");
    expect(fillReportHtml([{ pdfField: "Name", status: "missing" } as PdfFillReport], undefined)).toContain("Name: missing");

    const dialog = document.createElement("dialog");
    const preview = createPreviewDialog(dialog, { locale: () => "fr", textCatalog: () => FR });
    expect(dialog.getAttribute("aria-label")).toBe("Aperçu PDF");
    const result = {
      bytes: new Uint8Array([37, 80, 68, 70]),
      pageCount: 1,
      fileName: "a.pdf",
      layoutChoice: "open",
      layoutKind: "generated",
      warnings: [],
      fields: [],
      areas: []
    } as unknown as RenderFormPdfResult;
    preview.show(result, { layoutName: "Standard", answers: 0 });
    expect(dialog.querySelector("[data-action='close']")?.getAttribute("aria-label")).toBe("Fermer");
    expect(dialog.querySelector("[data-preview-side] h3")?.textContent).toBe("Pages (fr)");
    preview.close();

    const host = document.createElement("div");
    document.body.append(host);
    const popover = createAddPopover(host, {
      locale: () => "fr",
      templates: async () => [],
      canPopulate: () => true,
      textCatalog: () => FR,
      onCustom: () => undefined,
      onTemplate: () => undefined
    });
    expect(host.getAttribute("aria-label")).toBe("Ajouter une mise en page");
    popover.open(undefined);
    expect(host.querySelector("h3")?.textContent).toBe("Mise en page personnalisée");
    popover.close();

    const viewer = createTemplatePageViewer({
      escape: (value: string) => value,
      onSelect: () => undefined,
      onAreaCreate: () => undefined,
      onAreaChange: () => undefined,
      onAreaRemove: () => undefined,
      onFieldClick: () => undefined,
      locale: () => "fr",
      textCatalog: () => FR
    });
    viewer.setDocument({ pages: [{ index: 1, width: 612, height: 792 }], fields: [] } as unknown as PdfTemplateInfo, undefined);
    expect(viewer.element.querySelector("[data-pages-status]")?.textContent).toBe("Pages vierges");
    expect(viewer.element.querySelector("svg.dpd-page__overlay")?.getAttribute("aria-label")).toBe("Page 1 : glisser pour dessiner une zone");
  });
});
