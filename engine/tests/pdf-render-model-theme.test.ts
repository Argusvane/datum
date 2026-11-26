import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { walkPdfBlocks, runsText, type PdfBlock, type PdfDocument } from "../form-engine/render/pdf/pdf-document.js";
import { DEFAULT_PDF_THEME, PLAIN_PDF_THEME, type PdfThemeDefinition } from "../form-engine/render/pdf/pdf-theme.js";
import { FIXTURE_FORM } from "../form-engine/testing/fixture-form.js";

/**
 * What the render model says about a document under a theme: the field decor, the
 * frame, the markers, the section numbers and bands, the step tag, the lists, the faces — and
 * that a theme asking for none of it produces the blocks it always did.
 */
function state(values: Record<string, unknown>, locale = "en"): FormState {
  return {
    values,
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale
  };
}

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

const VALUES = {
  fullName: "Ada",
  amount: 1250,
  bio: "Two\nlines",
  province: "BC",
  contactMethod: "email",
  interests: { news: true, events: false },
  agree: true,
  employer: "Analytical Engines Ltd.",
  resident: true,
  notes: "Reviewed"
};

function blocksOf(document: PdfDocument | undefined): PdfBlock[] {
  const out: PdfBlock[] = [];
  walkPdfBlocks(document?.blocks ?? [], (block) => out.push(block));
  return out;
}

function byComponent<K extends PdfBlock["kind"]>(document: PdfDocument | undefined, componentId: string, kind: K): Extract<PdfBlock, { kind: K }> {
  const found = blocksOf(document).find((block): block is Extract<PdfBlock, { kind: K }> => block.kind === kind && block.componentId === componentId);
  if (!found) {
    throw new Error(`No ${kind} block for ${componentId}`);
  }
  return found;
}

const GCDS_LIKE: PdfThemeDefinition = {
  id: "gc",
  version: "1.0.0",
  target: "pdf",
  assets: { fonts: [{ family: "Noto Sans", weight: 400, file: "gc-fonts/pdf/noto-sans-400.ttf" }] },
  pdf: {
    typography: { body: { family: "Noto Sans" } },
    controls: { valueFrame: "box", textareaRows: 5 },
    fields: { hints: "shown" },
    headings: { numbered: false, band: "none", titleRule: false },
    texts: { required: { default: "(required)", locales: { fr: "(obligatoire)" } }, stepOf: { default: "Step {{n}} of {{total}}", locales: { fr: "Étape {{n}} sur {{total}}" } } },
    components: { radio: { rendition: "checklist" }, panel: { rendition: "panel" }, date: { style: { width: 180 } } }
  }
};

describe("the render model under a theme", () => {
  it("decorates fields as the theme asks: hints, the required marker, the frame, affixes, widths and markers", async () => {
    const model = await buildPdfRenderModel(FIXTURE_FORM.root, state(VALUES), resolver, { locale: "en" }, { theme: GCDS_LIKE });
    const document = model.document!;
    expect(byComponent(document, "fullName", "labelValue")).toMatchObject({ hint: "First and last name", labelSuffix: " (required)", frame: true, control: "text" });
    expect(byComponent(document, "amount", "labelValue")).toMatchObject({ prefix: "$", suffix: "CAD", frame: true });
    expect(byComponent(document, "bio", "labelValue")).toMatchObject({ frame: true, control: "textarea" });
    expect(byComponent(document, "province", "labelValue")).toMatchObject({ frame: true, control: "select" });
    expect(byComponent(document, "birthDate", "labelValue")).toMatchObject({ control: "date", width: 180, hint: "For example, 27 3 2007" });
    expect(byComponent(document, "contactMethod", "checklist")).toMatchObject({ marker: "radio", items: [{ label: "Email", checked: true, description: "We reply within two days" }, { label: "Phone", checked: false }] });
    expect(byComponent(document, "interests", "checklist").marker).toBe("check");
    expect(byComponent(document, "agree", "checkmark")).toMatchObject({ checked: true });
    // The theme's faces travel with the model, for the host's font provider.
    expect(model.fontFaces).toEqual([{ family: "Noto Sans", weight: 400, file: "gc-fonts/pdf/noto-sans-400.ttf" }]);
    expect(document.controls).toMatchObject({ valueFrame: "box", textareaRows: 5 });
    expect(document.fields?.hints).toBe("shown");
  });

  it("words the marker and the step line in the document's language", async () => {
    const model = await buildPdfRenderModel(FIXTURE_FORM.root, state(VALUES, "fr-CA"), resolver, { locale: "fr-CA", translations: FIXTURE_FORM.translations }, { theme: GCDS_LIKE });
    const document = model.document!;
    expect(byComponent(document, "fullName", "labelValue").labelSuffix).toBe(" (obligatoire)");
    const steps = blocksOf(document).filter((block): block is Extract<PdfBlock, { kind: "heading" }> => block.kind === "heading" && block.tag !== undefined);
    expect(steps.map((block) => [block.tag, runsText(block.runs)])).toEqual([
      ["Étape 1 sur 2", "Admissibilité"],
      ["Étape 2 sur 2", "Révision"]
    ]);
  });

  it("draws a panel as a titled box when the theme says so, and prints a boolean as a check mark", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: { title: "T" },
      children: {
        content: [
          { id: "panel", type: "panel", configuration: { label: "Employment" }, children: { content: [{ id: "employer", type: "text", configuration: { label: "Employer" } }] } },
          { id: "flag", type: "boolean", configuration: { label: "Resident" } },
          { id: "words", type: "localized-text", configuration: { label: "Motto" } }
        ]
      }
    };
    const values = { employer: "ACME", flag: true, words: { default: "Hello", locales: { fr: "Bonjour" } } };
    const model = await buildPdfRenderModel(root, state(values, "fr"), resolver, { locale: "fr" }, { theme: GCDS_LIKE });
    const document = model.document!;
    const panel = byComponent(document, "panel", "box");
    expect(panel.header?.blocks[0]).toMatchObject({ kind: "heading", runs: [{ text: "Employment" }] });
    expect(panel.blocks.some((block) => block.componentId === "employer")).toBe(true);
    expect(byComponent(document, "flag", "checkmark")).toMatchObject({ label: "Resident", checked: true });
    expect(runsText(byComponent(document, "words", "labelValue").value)).toBe("Bonjour");
  });

  it("numbers and bands the sections in reading order, rules the title, under the form look", async () => {
    const model = await buildPdfRenderModel(FIXTURE_FORM.root, state(VALUES), resolver, { locale: "en" }, { theme: DEFAULT_PDF_THEME });
    const document = model.document!;
    const headings = blocksOf(document).filter((block): block is Extract<PdfBlock, { kind: "heading" }> => block.kind === "heading");
    expect(headings[0]).toMatchObject({ level: 1, rule: true });
    expect(headings[0]!.number).toBeUndefined();
    const sections = headings.filter((block) => block.number !== undefined);
    expect(sections.map((block) => [block.number, runsText(block.runs), block.band])).toEqual([
      ["1", "Address", true],
      ["2", "Contact", true],
      ["3", "Employment", true],
      ["4", "Personal", true],
      ["5", "Work", true],
      ["6", "Eligibility", true],
      ["7", "Review", true],
      ["8", "Consent", true]
    ]);
    // Authored content's own headings are not sections.
    expect(headings.find((block) => runsText(block.runs) === "About this form")?.number).toBeUndefined();
    // The step line under the engine's own wording; the required marker as the HTML engine words it.
    expect(headings.find((block) => runsText(block.runs) === "Eligibility")?.tag).toBe("Step 1 of 2");
    expect(byComponent(document, "fullName", "labelValue").labelSuffix).toBe(" *");
    expect(document.headings).toMatchObject({ numbered: true, band: "surface" });
  });

  it("turns authored html into runs and lists: emphasis, links, breaks, nesting", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "intro",
            type: "html",
            configuration: {
              tag: "div",
              content: '<p>Read the <strong>terms</strong> and <a href="#terms">the notice</a>.<br>Then sign.</p><ul><li>One</li><li>Two<ol><li>Two-a</li></ol></li></ul><h2>Next</h2>'
            }
          }
        ]
      }
    };
    const model = await buildPdfRenderModel(root, state({}), resolver, { locale: "en" }, { theme: PLAIN_PDF_THEME });
    const blocks = model.document!.blocks;
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "list", "heading"]);
    const paragraph = blocks[0] as Extract<PdfBlock, { kind: "paragraph" }>;
    expect(paragraph.runs).toEqual([
      { text: "Read the " },
      { text: "terms", bold: true },
      { text: " and " },
      { text: "the notice", link: "#terms" },
      { text: ".\nThen sign." }
    ]);
    const list = blocks[1] as Extract<PdfBlock, { kind: "list" }>;
    expect(list.ordered).toBe(false);
    expect(list.items[0]).toEqual({ runs: [{ text: "One" }] });
    expect(list.items[1]?.runs).toEqual([{ text: "Two" }]);
    expect(list.items[1]?.blocks?.[0]).toMatchObject({ kind: "list", ordered: true, items: [{ runs: [{ text: "Two-a" }] }] });
  });

  it("produces the blocks it always did under the plain theme", async () => {
    const model = await buildPdfRenderModel(FIXTURE_FORM.root, state(VALUES), resolver, { locale: "en" }, { theme: PLAIN_PDF_THEME });
    const document = model.document!;
    for (const block of blocksOf(document)) {
      // An image's own width is its size, not a control's.
      const keys = ["hint", "labelSuffix", "frame", "control", "tag", "number", "band", "rule", ...(block.kind === "image" ? [] : ["width"])];
      for (const key of keys) {
        expect((block as unknown as Record<string, unknown>)[key], `${block.id}.${key}`).toBeUndefined();
      }
    }
    // A prefix or suffix is part of the answer under every theme.
    expect(byComponent(document, "amount", "labelValue")).toMatchObject({ prefix: "$", suffix: "CAD" });
    expect(byComponent(document, "contactMethod", "labelValue").arrangement).toBe("stacked");
    // A checklist always says which mark it wants; a square is what every document drew before.
    expect(byComponent(document, "interests", "checklist").marker).toBe("check");
    expect(model.fontFaces).toEqual([]);
    expect(document.controls?.valueFrame).toBe("none");
  });
});

describe("the PDF theme's own wording follows the document's language", () => {
  const worded: PdfThemeDefinition = {
    ...GCDS_LIKE,
    pdf: {
      ...GCDS_LIKE.pdf,
      texts: {
        pageOf: { default: "Page {{page}} of {{pages}}", locales: { fr: "Page {{page}} sur {{pages}}" } },
        attachmentDescription: { default: "Submission data", locales: { fr: "Données soumises" } },
        signatureAlt: { default: "Signature", locales: { fr: "Signature manuscrite" } }
      },
      components: { signature: { rendition: "image" } }
    }
  };
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: { title: "T" },
    children: { content: [{ id: "sign", type: "signature", configuration: { hideLabel: true } }] }
  };
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  it("describes the attached submission from the theme when the layout words none", async () => {
    const layout = { id: "l", kind: "generated" as const, root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [] } }, conformance: { pdfa: "3b" as const, attachData: true } };
    const fr = await buildPdfRenderModel(root, state({}, "fr"), resolver, { locale: "fr" }, { theme: worded, layout });
    expect(fr.document!.conformance!.attachments![0]!.description).toBe("Données soumises");
    const en = await buildPdfRenderModel(root, state({}, "en"), resolver, { locale: "en" }, { theme: worded, layout });
    expect(en.document!.conformance!.attachments![0]!.description).toBe("Submission data");
  });

  it("gives an unlabelled signature image the theme's alt text", async () => {
    const model = await buildPdfRenderModel(root, state({ sign: PNG }, "fr"), resolver, { locale: "fr" }, { theme: worded });
    expect(byComponent(model.document, "sign", "image").alt).toBe("Signature manuscrite");
  });

  it("words the derived footer's page count from the theme's pageOf", async () => {
    const model = await buildPdfRenderModel(root, state({}, "fr"), resolver, { locale: "fr" }, { theme: worded });
    expect(JSON.stringify(model.document)).toContain('{"text":" sur "}');
  });
});
