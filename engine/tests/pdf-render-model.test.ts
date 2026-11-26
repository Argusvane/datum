import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import { DEFAULT_PDF_AREA_DRAW, type PdfGeneratedLayout, type PdfTemplateLayout,
  builtinProfileSource
} from "../form-engine/core/schema/pdf-layout.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { walkPdfBlocks, runsText, type PdfBlock, type PdfDocument } from "../form-engine/render/pdf/pdf-document.js";
import type { PdfThemeDefinition } from "../form-engine/render/pdf/pdf-theme.js";
import { createPdfRenditionResolver } from "../form-engine/render/pdf/pdf-renditions.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";
import { PdfRenditionRegistry } from "../form-engine/registry/pdf/pdf-rendition-registry.js";

/** A translation entry for a default string, with the fingerprint the builder would write. */
function entry(text: string, defaultText: string): { text: string; source: string } {
  return { text, source: sourceHash(defaultText) };
}

function state(values: Record<string, unknown> = {}): FormState {
  return {
    values: {
      firstName: "Ada",
      lastName: "Lovelace",
      country: "CA",
      agree: true,
      prefs: { email: true, phone: false },
      notes: "Line one\nLine two",
      "items[0].sku": "A-1",
      "items[0].qty": 2,
      "items[1].sku": "B-2",
      "items[1].qty": 5,
      ...values
    },
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale: "en-CA"
  };
}

function root(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Customer Intake" },
    children: {
      content: [
        {
          id: "who",
          type: "tabs",
          configuration: {
            label: "About you",
            tabs: [
              { id: "name", label: "Name" },
              { id: "contact", label: "Contact" }
            ]
          },
          children: {
            name: [
              {
                id: "grid",
                type: "grid",
                configuration: { columns: 2 },
                children: {
                  column_1: [{ id: "firstName", type: "text", configuration: { label: "First name", required: true } }],
                  column_2: [{ id: "lastName", type: "text", configuration: { label: "Last name" } }]
                }
              }
            ],
            contact: [
              { id: "country", type: "select", configuration: { label: "Country", data: { sourceId: "countries" } } },
              {
                id: "prefs",
                type: "checkboxes",
                configuration: {
                  label: "Contact me by",
                  options: [
                    { value: "email", label: "Email", description: "We reply within a day" },
                    { value: "phone", label: "Phone" }
                  ]
                }
              },
              { id: "agree", type: "checkbox", configuration: { label: "I agree" } },
              { id: "secret", type: "text", configuration: { label: "Hidden", hidden: true } }
            ]
          }
        },
        {
          id: "items",
          type: "panel",
          configuration: { label: "Items" },
          collection: { collectionPath: "items", itemFields: ["sku", "qty"] },
          children: {
            content: [
              { id: "sku", type: "text", configuration: { label: "SKU" } },
              { id: "qty", type: "number", configuration: { label: "Qty" } }
            ]
          }
        },
        { id: "notes", type: "textarea", configuration: { label: "Notes" } },
        { id: "send", type: "button", configuration: { label: "Send", action: "submit" } }
      ]
    }
  };
}

const resolver: DataSourceResolver = {
  resolveDataSource: async ({ componentId }) =>
    componentId === "country"
      ? { items: [{ value: "CA", label: "Canada" }, { value: "FR", label: "France" }] }
      : undefined
};

function blocksOf(document: PdfDocument | undefined): PdfBlock[] {
  const out: PdfBlock[] = [];
  walkPdfBlocks(document?.blocks ?? [], (block) => out.push(block));
  return out;
}

function byKind<K extends PdfBlock["kind"]>(document: PdfDocument | undefined, kind: K): Array<Extract<PdfBlock, { kind: K }>> {
  return blocksOf(document).filter((block): block is Extract<PdfBlock, { kind: K }> => block.kind === kind);
}

/** The text of a block that carries runs (a heading or paragraph); empty for anything else. */
function textOf(block: PdfBlock | undefined): string {
  return block && "runs" in block ? runsText(block.runs) : "";
}

function childBlocks(block: PdfBlock | undefined): PdfBlock[] {
  return block && (block.kind === "group" || block.kind === "box") ? block.blocks : [];
}

describe("buildPdfRenderModel — derived layout", () => {
  it("words the layout it derives with the form's own translations: the title, a tab, a section", async () => {
    const translations: FormTranslations = {
      fr: {
        form: { title: entry("Admission des clients", "Customer Intake") },
        components: {
          who: { label: entry("À propos de vous", "About you"), tabs: { contact: { label: entry("Coordonnées", "Contact") } } },
          items: { label: entry("Articles", "Items") }
        }
      }
    };
    const model = await buildPdfRenderModel(root(), { ...state(), locale: "fr" }, resolver, { translations });
    expect(model.layoutKind).toBe("derived");
    const headings = byKind(model.document, "heading").map(textOf);
    expect(headings).toContain("Admission des clients");
    expect(headings).toContain("Coordonnées");
    expect(headings).toContain("À propos de vous");
    expect(model.document!.metadata.title).toBe("Admission des clients");
    // A tab the map does not word keeps its string.
    expect(headings).toContain("Name");
    // Another language: as authored.
    const english = await buildPdfRenderModel(root(), state(), resolver, { translations });
    expect(byKind(english.document, "heading").map(textOf)).toContain("Customer Intake");
  });

  it("reinterprets the form tree for paper: title, tabs as sections, grid as a table, collection as rows, buttons gone", async () => {
    const model = await buildPdfRenderModel(root(), state(), resolver);
    expect(model.mode).toBe("pdf");
    expect(model.layoutKind).toBe("derived");
    expect(model.layoutId).toBe("default");
    const document = model.document!;

    expect(document.metadata).toEqual({ title: "Customer Intake", lang: "en-CA", textDirection: "ltr" });
    expect(document.accessibility).toEqual({ tagged: true, displayDocTitle: true });
    expect(document.page.size).toBe("Letter");
    // The band is sized to the theme's small type in a table row: one line plus the cell padding.
    expect(document.page.footer?.height).toBeGreaterThanOrEqual(20);

    const headings = byKind(document, "heading").map((block) => [block.level, runsText(block.runs)]);
    expect(headings).toEqual([
      [1, "Customer Intake"],
      [2, "About you"],
      [3, "Name"],
      [3, "Contact"],
      [2, "Items"]
    ]);

    const tables = byKind(document, "table");
    expect(tables.map((table) => [table.borders, table.repeatHeader, table.rows.length])).toEqual([
      ["none", false, 1],
      ["all", true, 2]
    ]);
    const grid = tables[0]!;
    expect(grid.rows[0]!.cells.map((cell) => cell.blocks.map((block) => block.componentId))).toEqual([["firstName"], ["lastName"]]);
    const items = tables[1]!;
    expect(items.header?.cells.map((cell) => textOf(cell.blocks[0]))).toEqual(["SKU", "Qty"]);
    expect(items.rows.map((row) => row.cells.map((cell) => textOf(cell.blocks[0])))).toEqual([
      ["A-1", "2"],
      ["B-2", "5"]
    ]);

    const labelValues = byKind(document, "labelValue").map((block) => [block.label, runsText(block.value), block.arrangement]);
    expect(labelValues).toEqual([
      ["First name", "Ada", "stacked"],
      ["Last name", "Lovelace", "stacked"],
      ["Country", "Canada", "stacked"],
      ["Notes", "Line one\nLine two", "stacked"]
    ]);
    // An option's hint travels as the item's second line; an option without one gets no key.
    expect(byKind(document, "checklist")[0]).toMatchObject({
      label: "Contact me by",
      items: [
        { label: "Email", checked: true, description: "We reply within a day" },
        { label: "Phone", checked: false }
      ]
    });
    expect(byKind(document, "checklist")[0]?.items[1]).not.toHaveProperty("description");
    expect(byKind(document, "checkmark")[0]).toMatchObject({ label: "I agree", checked: true });

    const componentIds = blocksOf(document).map((block) => block.componentId).filter(Boolean);
    expect(componentIds).not.toContain("secret");
    expect(componentIds).not.toContain("send");

    // The running footer: the title at the start, the page count at the end, one borderless row.
    const footer = document.footer!;
    expect(footer).toHaveLength(1);
    const footerTable = footer[0] as Extract<PdfBlock, { kind: "table" }>;
    expect(footerTable.kind).toBe("table");
    expect(footerTable.borders).toBe("none");
    expect(footerTable.rows[0]!.cells).toHaveLength(2);
    expect(footerTable.rows[0]!.cells[0]!.blocks[0]).toMatchObject({ kind: "paragraph", runs: [{ text: "Customer Intake" }] });
    expect(footerTable.rows[0]!.cells[1]!.blocks[0]).toMatchObject({ kind: "paragraph", runs: [{ text: "Page " }, { token: "pageNumber" }, { text: " of " }, { token: "pageCount" }], style: { align: "end" } });
    expect(model.warnings).toEqual([]);
  });

  it("is deterministic: the same inputs give the same document", async () => {
    const first = await buildPdfRenderModel(root(), state(), resolver);
    const second = await buildPdfRenderModel(root(), state(), resolver);
    expect(JSON.stringify(second.document)).toBe(JSON.stringify(first.document));
  });

  it("makes a blank fillable form from the same tree with renditionDefaults", async () => {
    const layout: PdfGeneratedLayout = {
      id: "blank",
      kind: "generated",
      renditionDefaults: { "*": "ruled", checkbox: "field" },
      root: {
        id: "document",
        type: "pdf-document",
        configuration: {},
        children: {
          body: [
            { id: "f1", type: "pdf-field", configuration: { componentId: "firstName" } },
            { id: "f2", type: "pdf-field", configuration: { componentId: "notes" } },
            { id: "f3", type: "pdf-field", configuration: { componentId: "agree" } }
          ]
        }
      }
    };
    const model = await buildPdfRenderModel(root(), state(), resolver, {}, { layout });
    expect(model.layoutKind).toBe("generated");
    const blocks = model.document!.blocks;
    expect(blocks.map((block) => block.kind)).toEqual(["labelValue", "labelValue", "widget"]);
    expect(blocks[0]).toMatchObject({ arrangement: "ruled", lines: 1, label: "First name" });
    expect(blocks[1]).toMatchObject({ arrangement: "ruled", lines: 3 });
    expect(blocks[2]).toMatchObject({ field: { name: "agree", kind: "checkbox", value: true }, labelPosition: "after" });
  });

  it("makes a fillable form: widgets named by value path, options carried, one field per bound component", async () => {
    const model = await buildPdfRenderModel(root(), state(), resolver, {}, {
      layout: {
        id: "fill",
        kind: "generated",
        renditionDefaults: { "*": "field" },
        root: {
          id: "document",
          type: "pdf-document",
          configuration: {},
          children: {
            body: [
              { id: "a", type: "pdf-field", configuration: { componentId: "country" } },
              { id: "b", type: "pdf-field", configuration: { componentId: "prefs" } },
              { id: "c", type: "pdf-field", configuration: { componentId: "firstName", widgetName: "applicant.first" } },
              { id: "d", type: "pdf-field", configuration: { componentId: "who" } }
            ]
          }
        }
      }
    });
    const widgets = byKind(model.document, "widget");
    expect(widgets.map((widget) => [widget.field.name, widget.field.kind, widget.field.value])).toEqual([
      ["country", "dropdown", "CA"],
      ["prefs.email", "checkbox", true],
      ["prefs.phone", "checkbox", false],
      ["applicant.first", "text", "Ada"],
      // The tabs container has no "field" rendition: the wildcard is skipped quietly and its
      // fields inside are fillable widgets.
      ["firstName", "text", "Ada"],
      ["lastName", "text", "Lovelace"],
      ["country", "dropdown", "CA"],
      ["prefs.email", "checkbox", true],
      ["prefs.phone", "checkbox", false],
      ["agree", "checkbox", true]
    ]);
    expect(widgets[0]!.field.options).toEqual([
      { value: "CA", label: "Canada" },
      { value: "FR", label: "France" }
    ]);
    expect(widgets[3]!.field.required).toBe(true);
    expect(model.warnings).toEqual([]);
  });
});

describe("buildPdfRenderModel — authored layout", () => {
  const authored: PdfGeneratedLayout = {
    id: "letter",
    kind: "generated",
    name: "Confirmation letter",
    page: { size: "A4", orientation: "landscape", margins: { top: 40, right: 40, bottom: 40, left: 40 }, header: { height: 30 } },
    accessibility: { tagged: false, lang: "fr-CA", title: "Letter" },
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: {
        header: [{ id: "h", type: "pdf-text", configuration: { text: "{{firstName}} — page {{page}}/{{pages}}", variant: "muted" } }],
        body: [
          { id: "t", type: "pdf-text", configuration: { text: "Dear {{firstName}} {{lastName}} from {{country}},", variant: "h2" } },
          {
            id: "s",
            type: "pdf-section",
            configuration: { label: "Order", keepTogether: true },
            children: {
              content: [
                {
                  id: "rep",
                  type: "pdf-repeat",
                  configuration: { collectionPath: "items", keepRowTogether: true },
                  children: {
                    row: [
                      { id: "rt", type: "pdf-text", configuration: { text: "{{rowNumber}}. {{row.sku}} × {{row.qty}}" } },
                      { id: "rf", type: "pdf-field", configuration: { componentId: "qty", label: "Quantity", rendition: "field" } }
                    ]
                  }
                },
                {
                  id: "tbl",
                  type: "pdf-table",
                  configuration: { rows: 2, columns: 2, header: true, collectionPath: "items", borders: "horizontal" },
                  children: {
                    r1c1: [{ id: "th1", type: "pdf-text", configuration: { text: "SKU", variant: "label" } }],
                    r1c2: [{ id: "th2", type: "pdf-text", configuration: { text: "Qty", variant: "label" } }],
                    r2c1: [{ id: "td1", type: "pdf-text", configuration: { text: "{{row.sku}}" } }],
                    r2c2: [{ id: "td2", type: "pdf-field", configuration: { componentId: "qty", hideLabel: true } }]
                  }
                }
              ]
            }
          },
          { id: "rule", type: "pdf-rule", configuration: { thickness: 2 } },
          { id: "sp", type: "pdf-spacer", configuration: { height: 20 } },
          { id: "img", type: "pdf-image", configuration: { src: "data:image/png;base64,iVBORw0KGgo=", alt: "Logo", width: 100 } },
          { id: "brk", type: "pdf-page-break", configuration: { changePage: true, page: { size: "A4", orientation: "portrait" } } },
          {
            id: "box",
            type: "pdf-box",
            configuration: { fill: "#eeeeee", anchor: { page: "first", x: 400, y: 20, width: 150, height: 60 } },
            children: { content: [{ id: "bx", type: "pdf-text", configuration: { text: "Ref {{host.reference}}" } }] }
          },
          { id: "missing", type: "pdf-field", configuration: { componentId: "nope" } },
          { id: "expr", type: "pdf-text", configuration: { expression: { kind: "call", name: "concat", args: [{ kind: "path", path: "firstName" }, { kind: "literal", value: "!" }] } } }
        ]
      }
    }
  };

  // The layout's texts are strings in the default language; their translations are the form's map,
  // under `pdf › <layout id>` by the layout's own ids and property names.
  const translations: FormTranslations = {
    fr: {
      pdf: {
        letter: {
          name: entry("Lettre de confirmation", "Confirmation letter"),
          accessibility: { title: entry("Lettre", "Letter") },
          nodes: {
            t: { text: entry("Cher {{firstName}},", "Dear {{firstName}} {{lastName}} from {{country}},") },
            s: { label: entry("Commande", "Order") },
            img: { alt: entry("Logo de l'entreprise", "Logo") }
          }
        }
      }
    }
  };

  it("renders templates, sections, repeats, bound tables, decorations, anchored boxes and expressions", async () => {
    const model = await buildPdfRenderModel(root(), state(), resolver, {}, {
      layout: authored,
      hostContext: { reference: "R-42" }
    });
    const document = model.document!;
    expect(document.page).toMatchObject({ size: "A4", orientation: "landscape", header: { height: 30 } });
    expect(document.metadata).toEqual({ title: "Letter", lang: "fr-CA", textDirection: "ltr" });
    expect(document.accessibility.tagged).toBe(false);

    expect(document.header![0]).toMatchObject({
      kind: "paragraph",
      runs: [{ text: "Ada — page " }, { token: "pageNumber" }, { text: "/" }, { token: "pageCount" }]
    });

    const [greeting, sectionHeading, section] = document.blocks;
    expect(greeting).toMatchObject({ kind: "heading", level: 2, runs: [{ text: "Dear Ada Lovelace from Canada," }] });
    expect(sectionHeading).toMatchObject({ kind: "heading", level: 2, runs: [{ text: "Order" }], keepWithNext: true });
    expect(section).toMatchObject({ kind: "group", keepTogether: true });
    const sectionBlocks = childBlocks(section);

    const rows = sectionBlocks.filter((block) => block.kind === "group");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => textOf(childBlocks(row)[0]))).toEqual(["1. A-1 × 2", "2. B-2 × 5"]);
    const rowWidgets = rows.map((row) => childBlocks(row)[1]);
    expect(rowWidgets).toMatchObject([
      { kind: "widget", label: "Quantity", field: { name: "items[0].qty", value: "2" } },
      { kind: "widget", label: "Quantity", field: { name: "items[1].qty", value: "5" } }
    ]);

    const table = sectionBlocks.find((block) => block.kind === "table")!;
    expect(table).toMatchObject({ borders: "horizontal", repeatHeader: true });
    expect(table.kind === "table" && table.header!.cells.every((cell) => cell.header)).toBe(true);
    expect(table.kind === "table" && table.rows.map((row) => row.cells.map((cell) => cell.blocks[0]))).toMatchObject([
      [{ kind: "paragraph", runs: [{ text: "A-1" }] }, { kind: "labelValue", label: "", value: [{ text: "2" }] }],
      [{ kind: "paragraph", runs: [{ text: "B-2" }] }, { kind: "labelValue", label: "", value: [{ text: "5" }] }]
    ]);

    const kinds = document.blocks.map((block) => block.kind);
    expect(kinds).toEqual(["heading", "heading", "group", "rule", "spacer", "image", "pageBreak", "paragraph"]);
    expect(document.blocks[3]).toMatchObject({ thickness: 2, artifact: true });
    expect(document.blocks[5]).toMatchObject({ alt: "Logo", width: 100 });
    expect(Object.values(document.resources.images)).toEqual([{ type: "image/png", data: "iVBORw0KGgo=" }]);
    expect(document.blocks[6]).toMatchObject({ kind: "pageBreak", page: { size: "A4", orientation: "portrait" } });
    expect(document.blocks[7]).toMatchObject({ kind: "paragraph", runs: [{ text: "Ada!" }] });

    expect(document.anchored).toHaveLength(1);
    expect(document.anchored[0]).toMatchObject({
      anchor: { page: "first", x: 400, y: 20, width: 150, height: 60 },
      box: { fill: "#eeeeee", blocks: [{ kind: "paragraph", runs: [{ text: "Ref R-42" }] }] }
    });

    expect(model.warnings).toEqual([
      { code: "binding.unresolved", message: 'Layout node "missing" binds "nope", which the form does not have.' }
    ]);
  });

  it("resolves a layout's texts for the locale from the form's map: a heading, a text, an alt, the document title", async () => {
    // The map's `fr` serves a form in `fr-CA`, as it does for the form's own texts.
    const model = await buildPdfRenderModel(root(), state(), resolver, { locale: "fr-CA", translations }, { layout: authored });
    expect(model.document!.blocks[0]).toMatchObject({ runs: [{ text: "Cher Ada," }] });
    expect(model.document!.blocks[1]).toMatchObject({ kind: "heading", runs: [{ text: "Commande" }] });
    expect(byKind(model.document, "image").map((image) => image.alt)).toEqual(["Logo de l'entreprise"]);
    expect(model.document!.metadata.title).toBe("Lettre");
    // A language the map lacks, and a render with no map at all, keep the strings as authored.
    const english = await buildPdfRenderModel(root(), state(), resolver, { locale: "en", translations }, { layout: authored });
    expect(english.document!.blocks[0]).toMatchObject({ runs: [{ text: "Dear Ada Lovelace from Canada," }] });
    expect(english.document!.metadata.title).toBe("Letter");
    const bare = await buildPdfRenderModel(root(), state(), resolver, { locale: "fr" }, { layout: authored });
    expect(bare.document!.metadata.title).toBe("Letter");
  });

  it("falls back to the layout's name for the document title, and the host's catalog wins over the map", async () => {
    const named: PdfGeneratedLayout = { ...authored, accessibility: { tagged: false } };
    const fromMap = await buildPdfRenderModel(root(), state(), resolver, { locale: "fr-CA", translations }, { layout: named });
    expect(fromMap.document!.metadata.title).toBe("Lettre de confirmation");
    const translationCatalog = { fr: { pdf: { letter: { name: "Courrier" } } } };
    // The host's entry for the exact language wins over the map's `fr`.
    const hosted = await buildPdfRenderModel(root(), state(), resolver, { locale: "fr-CA", translations, translationCatalog: { "fr-CA": translationCatalog.fr } }, { layout: named });
    expect(hosted.document!.metadata.title).toBe("Courrier");
    const overridden = await buildPdfRenderModel(root(), state(), resolver, { locale: "fr", translations, translationCatalog }, { layout: named });
    expect(overridden.document!.metadata.title).toBe("Courrier");
  });

  it("does not mix a layout's own texts with a node that happens to be called name", async () => {
    const odd: PdfGeneratedLayout = {
      ...authored,
      accessibility: { tagged: false },
      root: { ...authored.root, children: { ...authored.root.children, body: [{ id: "name", type: "pdf-text", configuration: { text: "Hello" } }] } }
    };
    const map: FormTranslations = { fr: { pdf: { letter: { name: entry("Lettre", "Confirmation letter"), nodes: { name: { text: entry("Bonjour", "Hello") } } } } } };
    const model = await buildPdfRenderModel(root(), state(), resolver, { locale: "fr", translations: map }, { layout: odd });
    expect(model.document!.blocks[0]).toMatchObject({ runs: [{ text: "Bonjour" }] });
    expect(model.document!.metadata.title).toBe("Lettre");
  });

  it("resolves component labels and tab captions in the state's locale when the context names none", async () => {
    const form: ComponentNode = {
      id: "root",
      type: "form",
      configuration: { title: "T" },
      children: {
        content: [
          {
            id: "who",
            type: "tabs",
            configuration: { tabs: [{ id: "contact", label: "Contact" }] },
            children: { contact: [{ id: "email", type: "text", configuration: { label: "Email" } }] }
          }
        ]
      }
    };
    // The form's own words: a tab by its id under its container, a field under its own id.
    const translations: FormTranslations = {
      fr: {
        components: {
          who: { tabs: { contact: { label: entry("Coordonnées", "Contact") } } },
          email: { label: entry("Courriel", "Email") }
        }
      }
    };
    const model = await buildPdfRenderModel(form, { ...state(), locale: "fr" }, resolver, { translations });
    expect(byKind(model.document, "heading").map(textOf)).toContain("Coordonnées");
    expect(byKind(model.document, "labelValue").map((block) => block.label)).toEqual(["Courriel"]);
  });

  it("resolves a tab's caption through the host's catalog, as the HTML tabs shell does", async () => {
    const form: ComponentNode = {
      id: "root",
      type: "form",
      configuration: { title: "T" },
      children: {
        content: [
          {
            id: "who",
            type: "tabs",
            configuration: { tabs: [{ id: "contact", label: "Contact" }] },
            children: { contact: [{ id: "email", type: "text", configuration: { label: "Email" } }] }
          }
        ]
      }
    };
    const translationCatalog = { fr: { components: { who: { tabs: { contact: { label: "Coordonnées" } } } } } };
    const french = await buildPdfRenderModel(form, state(), resolver, { locale: "fr", translationCatalog });
    expect(byKind(french.document, "heading").map(textOf)).toContain("Coordonnées");
    const english = await buildPdfRenderModel(form, state(), resolver, { locale: "en", translationCatalog });
    expect(byKind(english.document, "heading").map(textOf)).toContain("Contact");
  });

  it("finds a layout by id on the definition's pdf block, and warns when the id is unknown", async () => {
    const pdf = { layouts: [authored], defaultLayoutId: "letter" };
    const byDefault = await buildPdfRenderModel(root(), state(), resolver, {}, { pdf });
    expect(byDefault).toMatchObject({ layoutId: "letter", layoutChoice: "default" });
    expect(await buildPdfRenderModel(root(), state(), resolver, {}, { pdf, layoutId: "letter" })).toMatchObject({ layoutKind: "generated", layoutChoice: "asked" });
    const missing = await buildPdfRenderModel(root(), state(), resolver, {}, { pdf, layoutId: "zzz" });
    expect(missing).toMatchObject({ layoutKind: "derived", layoutChoice: "derived" });
    // What was used is the derived layout, not the default.
    expect(missing.warnings[0]).toEqual({ code: "layout.notFound", message: 'The form has no usable PDF layout "zzz"; a layout derived from the form was used.' });
    // A layout the form has but cannot render reads the same: an explicit id never guesses.
    const broken = await buildPdfRenderModel(root(), state(), resolver, {}, { pdf: { layouts: [authored, { id: "broken", kind: "generated" } as unknown as PdfGeneratedLayout] }, layoutId: "broken" });
    expect(broken).toMatchObject({ layoutKind: "derived", layoutChoice: "derived" });
    expect(broken.warnings[0]?.code).toBe("layout.notFound");
  });
});

describe("buildPdfRenderModel — rendition ladder", () => {
  const layoutWith = (renditionDefaults?: Record<string, string>, binding?: Record<string, unknown>): PdfGeneratedLayout => ({
    id: "l",
    kind: "generated",
    ...(renditionDefaults ? { renditionDefaults } : {}),
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: { body: [{ id: "f", type: "pdf-field", configuration: { componentId: "firstName", ...(binding ?? {}) } }] }
    }
  });

  it("orders binding > instance > layout defaults > theme > definition default", async () => {
    const themed: PdfThemeDefinition = { id: "corp", version: "1.0.0", target: "pdf", pdf: { components: { text: { rendition: "ruled" } } } };
    const instanceRoot = root();
    // The first name asks for a widget on its own configuration.
    const form = JSON.parse(JSON.stringify(instanceRoot)) as ComponentNode;
    const firstName = form.children!.content![0]!.children!.name![0]!.children!.column_1![0]!;
    firstName.configuration = { ...(firstName.configuration as object), pdf: { rendition: "field" } };

    const themeOnly = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: layoutWith(), theme: themed });
    expect(themeOnly.document!.blocks[0]).toMatchObject({ kind: "labelValue", arrangement: "ruled" });

    const layoutOverTheme = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: layoutWith({ text: "text" }), theme: themed });
    expect(layoutOverTheme.document!.blocks[0]).toMatchObject({ kind: "labelValue", arrangement: "stacked" });

    const instanceOverLayout = await buildPdfRenderModel(form, state(), resolver, {}, { layout: layoutWith({ text: "text" }), theme: themed });
    expect(instanceOverLayout.document!.blocks[0]).toMatchObject({ kind: "widget" });

    const bindingOverAll = await buildPdfRenderModel(form, state(), resolver, {}, { layout: layoutWith({ text: "text" }, { rendition: "ruled" }), theme: themed });
    expect(bindingOverAll.document!.blocks[0]).toMatchObject({ kind: "labelValue", arrangement: "ruled" });
  });

  it("renders under the theme a generated layout names, found through resolveTheme", async () => {
    const themed: PdfThemeDefinition = { id: "corp", version: "1.0.0", target: "pdf", pdf: { components: { text: { rendition: "ruled" } } } };
    const resolveTheme = (id: string) => (id === "corp" ? themed : undefined);
    const layout: PdfGeneratedLayout = { ...layoutWith(), theme: "corp" };

    const byLayout = await buildPdfRenderModel(root(), state(), resolver, {}, { layout, resolveTheme });
    expect(byLayout.themeId).toBe("corp");
    expect(byLayout.document!.blocks[0]).toMatchObject({ kind: "labelValue", arrangement: "ruled" });
    expect(byLayout.warnings).toEqual([]);

    // The root's configuration.theme is where the designer writes it; it counts the same.
    const onRoot: PdfGeneratedLayout = layoutWith();
    onRoot.root.configuration = { theme: "corp" };
    expect((await buildPdfRenderModel(root(), state(), resolver, {}, { layout: onRoot, resolveTheme })).themeId).toBe("corp");
  });

  it("lets the call's themeId win over the layout's theme, and warns about an unknown id", async () => {
    const corp: PdfThemeDefinition = { id: "corp", version: "1.0.0", target: "pdf", pdf: { components: { text: { rendition: "ruled" } } } };
    const plain: PdfThemeDefinition = { id: "plain", version: "1.0.0", target: "pdf" };
    const resolveTheme = (id: string) => [corp, plain].find((theme) => theme.id === id);
    const layout: PdfGeneratedLayout = { ...layoutWith(), theme: "corp" };

    const overridden = await buildPdfRenderModel(root(), state(), resolver, {}, { layout, themeId: "plain", resolveTheme });
    expect(overridden.themeId).toBe("plain");
    expect(overridden.document!.blocks[0]).toMatchObject({ kind: "labelValue", arrangement: "stacked" });

    const unknown = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: { ...layoutWith(), theme: "zzz" }, theme: plain, resolveTheme });
    expect(unknown.themeId).toBe("plain");
    expect(unknown.warnings[0]).toMatchObject({ code: "theme.notFound", message: expect.stringContaining('"zzz"') });

    const noLookup = await buildPdfRenderModel(root(), state(), resolver, {}, { layout });
    expect(noLookup.themeId).toBe("datum-pdf");
    expect(noLookup.warnings[0]).toMatchObject({ code: "theme.notFound" });
  });

  it("falls to the PDF theme the form's binding suggests when nothing names a PDF theme, and never derives one from a form look", async () => {
    const shipped: PdfThemeDefinition = { id: "acme", version: "1.0.0", target: "pdf", pdf: { colors: { accent: "#abcdef" } } };

    // The suggestion as the theme object itself.
    const byObject = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: layoutWith(), binding: { id: "acme", pdfTheme: shipped } });
    expect(byObject.themeId).toBe("acme");
    expect(byObject.document!.colors.accent).toBe("#abcdef");
    expect(byObject.warnings).toEqual([]);

    // The suggestion as an id the host's registry holds.
    const byRegistry = await buildPdfRenderModel(root(), state(), resolver, {}, {
      layout: layoutWith(),
      binding: { id: "acme", pdfTheme: "acme" },
      resolveTheme: (id: string) => (id === "acme" ? shipped : undefined)
    });
    expect(byRegistry.document!.colors.accent).toBe("#abcdef");

    // A binding that suggests none leaves the engine's own PDF theme.
    const none = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: layoutWith(), binding: { id: "datum" } });
    expect(none.themeId).toBe("datum-pdf");

    // The host's own PDF theme still outranks the suggestion.
    const host: PdfThemeDefinition = { id: "host", version: "1.0.0", target: "pdf", pdf: { colors: { accent: "#000000" } } };
    const byHost = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: layoutWith(), theme: host, binding: { id: "acme", pdfTheme: shipped } });
    expect(byHost.themeId).toBe("host");
  });

  it("warns about a rendition the type does not offer and falls through", async () => {
    const model = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: layoutWith(undefined, { rendition: "hologram" }) });
    expect(model.document!.blocks[0]).toMatchObject({ kind: "labelValue", arrangement: "stacked" });
    expect(model.warnings).toEqual([
      expect.objectContaining({ code: "rendition.unknown", componentId: "firstName" })
    ]);
  });

  it("uses a plugin's rendition for a type it does not own, and a definition's own renditions first", async () => {
    const plugins = new PdfRenditionRegistry();
    plugins.register({
      componentType: "text",
      rendition: { id: "shout", render: (_node, context) => [{ id: (context as { nextId(): string }).nextId(), kind: "paragraph", runs: [{ text: "SHOUT" }] }] }
    });
    const components = new ComponentRegistry();
    components.register({
      type: "text",
      version: "9.0.0",
      createDefault: () => ({ id: "t", type: "text", configuration: {} }),
      capabilities: [],
      pdf: {
        defaultRendition: "whisper",
        renditions: [{ id: "whisper", render: (_node, context) => [{ id: (context as { nextId(): string }).nextId(), kind: "paragraph", runs: [{ text: "whisper" }] }] }]
      }
    });
    const renditions = createPdfRenditionResolver({ components, renditions: plugins });

    const shout = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: layoutWith(undefined, { rendition: "shout" }), renditions });
    expect(shout.document!.blocks[0]).toMatchObject({ runs: [{ text: "SHOUT" }] });
    const whisper = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: layoutWith(), renditions });
    expect(whisper.document!.blocks[0]).toMatchObject({ runs: [{ text: "whisper" }] });
    expect(renditions.catalog("text").map((r) => r.id)).toEqual(["whisper", "shout", "text", "field", "ruled"]);
  });

  it("honours a binding's label override, hidden label and the instance's exclusion", async () => {
    const labelled = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: layoutWith(undefined, { label: "Given name" }) });
    expect(labelled.document!.blocks[0]).toMatchObject({ label: "Given name" });
    const hidden = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: layoutWith(undefined, { hideLabel: true }) });
    expect(hidden.document!.blocks[0]).toMatchObject({ label: "" });

    const form = root();
    const firstName = form.children!.content![0]!.children!.name![0]!.children!.column_1![0]!;
    firstName.configuration = { ...(firstName.configuration as object), pdf: { exclude: true } };
    const excluded = await buildPdfRenderModel(form, state(), resolver, {}, { layout: layoutWith() });
    expect(excluded.document!.blocks).toEqual([]);
  });

  it("drops a component a rule hides, following the effective state", async () => {
    const effectiveStates = new Map([
      ["firstName", { visible: false, disabled: false, readonly: false, runValidation: false, requiredApplies: false, submitValue: false, clearValue: false }]
    ]);
    const model = await buildPdfRenderModel(root(), state(), resolver, { effectiveStates }, { layout: layoutWith() });
    expect(model.document!.blocks).toEqual([]);
  });
});

describe("buildPdfRenderModel — unknown components", () => {
  const HIDDEN = { visible: false, disabled: false, readonly: false, runValidation: false, requiredApplies: false, submitValue: false, clearValue: false };
  const form = (): ComponentNode => ({
    id: "root",
    type: "form",
    configuration: { title: "Survey" },
    children: {
      content: [
        { id: "stars", type: "rating", configuration: { label: "Stars" } },
        {
          id: "card",
          type: "wizard-card",
          configuration: { label: "Card" },
          children: { content: [{ id: "note", type: "text", configuration: { label: "Note" } }] }
        },
        {
          id: "items",
          type: "panel",
          configuration: { label: "Items" },
          collection: { collectionPath: "items", itemFields: ["sku", "qty"] },
          children: {
            content: [
              { id: "sku", type: "sku-picker", configuration: { label: "SKU" } },
              { id: "qty", type: "number", configuration: { label: "Qty" } }
            ]
          }
        },
        { id: "gone", type: "rating", configuration: { label: "Gone", pdf: { exclude: true } } },
        { id: "ghost", type: "rating", configuration: { label: "Ghost" } }
      ]
    }
  });
  const values = { stars: 4, note: "n", "items[0].sku": "A-1", "items[0].qty": 1, gone: 1, ghost: 2 };
  const layout = (...ids: string[]): PdfGeneratedLayout => ({
    id: "l",
    kind: "generated",
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: { body: ids.map((id) => ({ id: `f-${id}`, type: "pdf-field", configuration: { componentId: id } })) }
    }
  });
  const unknownOf = (warnings: Array<{ code: string; componentId?: string }>) =>
    warnings.filter((warning) => warning.code === "component.unknown").map((warning) => warning.componentId);

  it("warns once per component whose type offers nothing, hidden ones included, and still draws it generically", async () => {
    const model = await buildPdfRenderModel(
      form(),
      state(values),
      resolver,
      { effectiveStates: new Map([["ghost", HIDDEN]]) },
      { layout: layout("stars", "card", "items", "gone", "ghost", "stars") }
    );
    // The excluded one is the author's call; the panel and its number are known; the row field is not.
    expect(unknownOf(model.warnings)).toEqual(["stars", "card", "sku", "ghost"]);
    expect(model.warnings.find((warning) => warning.componentId === "stars")).toMatchObject({
      code: "component.unknown",
      message: 'Component "stars" has type "rating", which offers no PDF rendition here; the generic "text" rendition was used.'
    });
    expect(model.warnings.find((warning) => warning.componentId === "card")?.message).toContain('the generic "group" rendition');
    expect(byKind(model.document, "labelValue").map((block) => block.componentId)).toEqual(["stars", "note", "stars"]);
    expect(byKind(model.document, "group").map((block) => block.componentId)).toEqual(["card"]);
    expect(blocksOf(model.document).some((block) => block.componentId === "ghost")).toBe(false);
  });

  it("says nothing under ignore", async () => {
    const model = await buildPdfRenderModel(form(), state(values), resolver, {}, { layout: layout("stars", "card", "items"), unknownComponents: "ignore" });
    expect(unknownOf(model.warnings)).toEqual([]);
    expect(byKind(model.document, "labelValue").map((block) => block.componentId)).toEqual(["stars", "note"]);
  });

  it("refuses under fail — a hidden component too, an excluded one not", async () => {
    await expect(
      buildPdfRenderModel(form(), state(values), resolver, { effectiveStates: new Map([["ghost", HIDDEN]]) }, { layout: layout("note", "ghost"), unknownComponents: "fail" })
    ).rejects.toMatchObject({
      name: "PdfKernelError",
      code: "unknown_component",
      message: 'Component "ghost" has type "rating", which offers no PDF rendition here; register one for the type or set unknownComponents to "warn" or "ignore".'
    });
    await expect(buildPdfRenderModel(form(), state(values), resolver, {}, { layout: layout("items"), unknownComponents: "fail" })).rejects.toMatchObject({ code: "unknown_component", message: expect.stringContaining('"sku"') });
    const excluded = await buildPdfRenderModel(form(), state(values), resolver, {}, { layout: layout("note", "gone"), unknownComponents: "fail" });
    expect(excluded.warnings).toEqual([]);
  });

  it("counts a type as known once a plugin or a definition offers it a rendition", async () => {
    const plugins = new PdfRenditionRegistry();
    plugins.register({
      componentType: "rating",
      rendition: { id: "stars", render: (_node, context) => [{ id: (context as { nextId(): string }).nextId(), kind: "paragraph", runs: [{ text: "****" }] }] }
    });
    const components = new ComponentRegistry();
    components.register({
      type: "wizard-card",
      version: "1.0.0",
      createDefault: () => ({ id: "c", type: "wizard-card", configuration: {} }),
      capabilities: [],
      pdf: { defaultRendition: "group", renditions: [{ id: "group", render: (_node, context) => (context as { children(): PdfBlock[] }).children() }] }
    });
    const pluginOnly = await buildPdfRenderModel(form(), state(values), resolver, {}, { layout: layout("stars", "card"), renditions: createPdfRenditionResolver({ renditions: plugins }) });
    expect(unknownOf(pluginOnly.warnings)).toEqual(["card"]);
    expect(byKind(pluginOnly.document, "paragraph").map((block) => runsText(block.runs))).toEqual(["****"]);
    const both = await buildPdfRenderModel(form(), state(values), resolver, {}, { layout: layout("stars", "card"), renditions: createPdfRenditionResolver({ components, renditions: plugins }), unknownComponents: "fail" });
    expect(unknownOf(both.warnings)).toEqual([]);
  });

  it("never asks under a template layout, where no rendition is involved", async () => {
    const template: PdfTemplateLayout = {
      id: "gov",
      kind: "template",
      template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
      fields: [{ pdfField: "Stars", source: { kind: "component", componentId: "stars" } }],
      options: {}
    };
    const model = await buildPdfRenderModel(form(), state(values), resolver, {}, { layout: template, unknownComponents: "fail" });
    expect(model.fill!.values).toEqual({ Stars: "4" });
    expect(model.warnings).toEqual([]);
  });
});

describe("buildPdfRenderModel — skipWhenEmpty", () => {
  const hidden = (...ids: string[]) =>
    new Map(
      ids.map((id) => [
        id,
        { visible: false, disabled: false, readonly: false, runValidation: false, requiredApplies: false, submitValue: false, clearValue: false }
      ])
    );
  const field = (id: string, componentId: string): ComponentNode => ({ id, type: "pdf-field", configuration: { componentId } });
  const text = (id: string, value: string): ComponentNode => ({ id, type: "pdf-text", configuration: { text: value } });
  const spacer = (id: string): ComponentNode => ({ id, type: "pdf-spacer", configuration: { height: 8 } });
  const layout = (...body: ComponentNode[]): PdfGeneratedLayout => ({
    id: "l",
    kind: "generated",
    root: { id: "document", type: "pdf-document", configuration: {}, children: { body } }
  });
  const section = (id: string, label: string, skipWhenEmpty: boolean, content: ComponentNode[]): ComponentNode => ({
    id,
    type: "pdf-section",
    configuration: { label, ...(skipWhenEmpty ? { skipWhenEmpty } : {}) },
    children: { content }
  });

  it("leaves out a section whose every field a rule hides, heading included; keeps one with content, or one not marked", async () => {
    const doc = layout(
      section("gone", "Gone", true, [field("f1", "firstName"), { id: "hr", type: "pdf-rule", configuration: {} }, spacer("gap")]),
      section("kept", "Kept", true, [field("f2", "lastName")]),
      section("unmarked", "Not marked", false, [field("f3", "firstName")])
    );
    const model = await buildPdfRenderModel(root(), state(), resolver, { effectiveStates: hidden("firstName") }, { layout: doc });
    const top = model.document!.blocks;
    expect(top.map((block) => block.kind)).toEqual(["heading", "group", "heading", "group"]);
    expect(byKind(model.document, "heading").map((block) => runsText(block.runs))).toEqual(["Kept", "Not marked"]);
    expect(childBlocks(top[3])).toEqual([]);
    expect(model.warnings).toEqual([]);
  });

  it("looks through containers: a grid whose columns are all hidden is empty, one with a field is not", async () => {
    // The grid's own heading is content of its own; hidden, only its cells are left to count.
    const grid: ComponentNode = { id: "g", type: "pdf-field", configuration: { componentId: "grid", hideLabel: true } };
    const doc = layout(section("s", "Name", true, [grid]));
    const empty = await buildPdfRenderModel(root(), state(), resolver, { effectiveStates: hidden("firstName", "lastName") }, { layout: doc });
    expect(empty.document!.blocks).toEqual([]);
    const filled = await buildPdfRenderModel(root(), state(), resolver, { effectiveStates: hidden("firstName") }, { layout: doc });
    expect(byKind(filled.document, "heading").map((block) => runsText(block.runs))).toEqual(["Name"]);
    expect(byKind(filled.document, "table").length).toBe(1);
  });

  it("drops a box with nothing in it, an anchored one included, and keeps a filled one", async () => {
    const box = (id: string, content: ComponentNode[], extra: Record<string, unknown> = {}): ComponentNode => ({
      id,
      type: "pdf-box",
      configuration: { skipWhenEmpty: true, ...extra },
      children: { content }
    });
    const doc = layout(
      box("empty", [spacer("gap")]),
      box("pinned", [field("f", "firstName")], { anchor: { page: "first", x: 10, y: 10, width: 100, height: 40 } }),
      box("filled", [text("t", "Office use only")])
    );
    const model = await buildPdfRenderModel(root(), state(), resolver, { effectiveStates: hidden("firstName") }, { layout: doc });
    expect(model.document!.blocks.map((block) => block.kind)).toEqual(["box"]);
    expect(textOf(childBlocks(model.document!.blocks[0])[0])).toBe("Office use only");
    expect(model.document!.anchored).toEqual([]);
  });

  it("drops a table with no collection rows, or a grid whose body cells are all empty; captions never keep it, an unmarked one stays", async () => {
    const table = (id: string, config: Record<string, unknown>, cells: Record<string, ComponentNode[]>): ComponentNode => ({
      id,
      type: "pdf-table",
      configuration: { rows: 2, columns: 1, header: true, ...config },
      children: cells
    });
    const doc = layout(
      table("rows", { collectionPath: "nothing", skipWhenEmpty: true }, { r1c1: [text("c1", "Caption")], r2c1: [text("cell", "{{row.sku}}")] }),
      table("fixed", { skipWhenEmpty: true }, { r1c1: [text("c2", "Caption")], r2c1: [field("f", "firstName"), spacer("gap")] }),
      table("filled", { skipWhenEmpty: true }, { r1c1: [text("c3", "Caption")], r2c1: [text("note", "Present")] }),
      table("unmarked", {}, { r1c1: [text("c4", "Caption")], r2c1: [field("f2", "firstName")] })
    );
    const model = await buildPdfRenderModel(root(), state(), resolver, { effectiveStates: hidden("firstName") }, { layout: doc });
    expect(model.document!.blocks.map((block) => block.kind)).toEqual(["table", "table"]);
    expect(byKind(model.document, "table").map((block) => [block.header !== undefined, block.rows.length])).toEqual([
      [true, 1],
      [true, 1]
    ]);
  });

  it("leaves out a derived section whose fields a rule hides, rather than an orphan heading", async () => {
    const model = await buildPdfRenderModel(root(), state(), resolver, { effectiveStates: hidden("firstName", "lastName") });
    expect(byKind(model.document, "heading").map((block) => [block.level, runsText(block.runs)])).toEqual([
      [1, "Customer Intake"],
      [2, "About you"],
      [3, "Contact"],
      [2, "Items"]
    ]);
  });
});

describe("buildPdfRenderModel — template layout", () => {
  const template: PdfTemplateLayout = {
    id: "gov",
    kind: "template",
    template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
    fields: [
      { pdfField: "Name", source: { kind: "template", text: "{{firstName}} {{lastName}}" } },
      { pdfField: "Country", source: { kind: "component", componentId: "country" } },
      { pdfField: "Agree", source: { kind: "component", componentId: "agree" } },
      { pdfField: "Prefs", source: { kind: "component", componentId: "prefs" } },
      { pdfField: "IsCanada", source: { kind: "component", componentId: "country" }, checkedValue: "CA" },
      { pdfField: "IsFrance", source: { kind: "component", componentId: "country" }, checkedValue: "FR" },
      { pdfField: "AgreeOption", source: { kind: "component", componentId: "agree" }, checkedValue: "Yes" },
      { pdfField: "Notes", source: { kind: "path", path: "notes" } },
      { pdfField: "Total", source: { kind: "expression", expression: { kind: "arithmetic", operator: "add", left: { kind: "path", path: "items[0].qty" }, right: { kind: "path", path: "items[1].qty" } } }, format: { kind: "number", pattern: "2" } },
      { pdfField: "Const", source: { kind: "literal", value: 7 } },
      { pdfField: "Hidden", source: { kind: "component", componentId: "secret" } },
      { pdfField: "Missing", source: { kind: "component", componentId: "ghost" } },
      { pdfField: "AgreeText", source: { kind: "component", componentId: "agree" }, format: { kind: "boolean", pattern: "Oui|Non" } }
    ],
    options: { flatten: true }
  };

  it("resolves every mapping to a plain value and reports the ones it cannot", async () => {
    const model = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: template });
    expect(model.layoutKind).toBe("template");
    expect(model.document).toBeUndefined();
    expect(model.fill).toMatchObject({
      layoutId: "gov",
      template: { storage: "base64", name: "gov.pdf" },
      options: { flatten: true, readOnly: false, appearances: "regenerate" }
    });
    expect(model.fill!.values).toEqual({
      Name: "Ada Lovelace",
      Country: "CA",
      Agree: true,
      Prefs: ["email"],
      // A checked value: on, the field takes the value itself (a box ticked by it, a radio
      // group's option of that name selected); off is `false`, which unticks or clears.
      IsCanada: "CA",
      IsFrance: false,
      AgreeOption: "Yes",
      Notes: "Line one\nLine two",
      Total: "7.00",
      Const: "7",
      Hidden: null,
      Missing: null,
      AgreeText: "Oui"
    });
    expect(model.warnings).toEqual([expect.objectContaining({ code: "mapping.unresolved", componentId: "ghost" })]);
    expect(model.fill!.areas).toEqual([]);
  });

  it("words a fill text per language by the PDF field's name and the area's id, never by position", async () => {
    const greeting: PdfTemplateLayout = {
      ...template,
      fields: [
        { pdfField: "topmostSubform[0].Page1[0].Name[0]", source: { kind: "template", text: "Dear {{firstName}}" } },
        { pdfField: "Other", source: { kind: "template", text: "Hello {{lastName}}" } }
      ],
      areas: [{ id: "note", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, source: { kind: "template", text: "Signed {{firstName}}" } }]
    };
    const translations: FormTranslations = {
      fr: {
        pdf: {
          gov: {
            // The field's name keeps its dots and brackets as one key; the second field has no entry.
            fields: { "topmostSubform[0].Page1[0].Name[0]": { text: entry("Chère {{firstName}}", "Dear {{firstName}}") } },
            areas: { note: { text: entry("Signé {{firstName}}", "Signed {{firstName}}") } }
          }
        }
      }
    };
    const model = await buildPdfRenderModel(root(), state(), resolver, { locale: "fr-CA", translations }, { layout: greeting });
    expect(model.fill!.values).toEqual({ "topmostSubform[0].Page1[0].Name[0]": "Chère Ada", Other: "Hello Lovelace" });
    expect(model.fill!.areas[0]!.value).toBe("Signé Ada");
    const english = await buildPdfRenderModel(root(), state(), resolver, { locale: "en", translations }, { layout: greeting });
    expect(english.fill!.values).toMatchObject({ "topmostSubform[0].Page1[0].Name[0]": "Dear Ada" });
  });

  it("resolves areas through the same sources, with their drawing defaults filled in", async () => {
    const withAreas: PdfTemplateLayout = {
      ...template,
      fields: [],
      areas: [
        { id: "name", label: "Full name", page: 1, rect: { x: 60, y: 40, width: 200, height: 14 }, source: { kind: "template", text: "{{firstName}} {{lastName}}" } },
        { id: "isCanada", page: 1, rect: { x: 60, y: 60, width: 12, height: 12 }, source: { kind: "component", componentId: "country" }, checkedValue: "CA", draw: { kind: "check" } },
        { id: "total", page: 2, rect: { x: 60, y: 80, width: 80, height: 14 }, source: { kind: "expression", expression: { kind: "arithmetic", operator: "add", left: { kind: "path", path: "items[0].qty" }, right: { kind: "path", path: "items[1].qty" } } }, format: { kind: "number", pattern: "1" }, draw: { align: "end", fontSize: 12, bold: true } },
        { id: "hidden", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, source: { kind: "component", componentId: "secret" } },
        { id: "ghost", label: "Nobody", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, source: { kind: "component", componentId: "ghost" } },
        { id: "fixed", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, source: { kind: "literal", value: "RECEIVED" }, draw: { valign: "middle", padding: 0, wrap: false, color: "#ff0000" } },
        { id: "fillable", label: "Applicant", page: 1, rect: { x: 0, y: 20, width: 10, height: 10 }, source: { kind: "component", componentId: "country" }, field: { required: true } }
      ]
    };
    const model = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: withAreas });
    expect(model.fill!.values).toEqual({});
    expect(model.fill!.areas).toEqual([
      { id: "name", label: "Full name", page: 1, rect: { x: 60, y: 40, width: 200, height: 14 }, value: "Ada Lovelace", draw: DEFAULT_PDF_AREA_DRAW },
      { id: "isCanada", page: 1, rect: { x: 60, y: 60, width: 12, height: 12 }, value: "CA", draw: { ...DEFAULT_PDF_AREA_DRAW, kind: "check" } },
      { id: "total", page: 2, rect: { x: 60, y: 80, width: 80, height: 14 }, value: "7.0", draw: { ...DEFAULT_PDF_AREA_DRAW, align: "end", fontSize: 12, bold: true } },
      { id: "hidden", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, value: null, draw: DEFAULT_PDF_AREA_DRAW },
      { id: "ghost", label: "Nobody", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, value: null, draw: DEFAULT_PDF_AREA_DRAW },
      { id: "fixed", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, value: "RECEIVED", draw: { ...DEFAULT_PDF_AREA_DRAW, valign: "middle", padding: 0, wrap: false, color: "#ff0000" } },
      { id: "fillable", label: "Applicant", page: 1, rect: { x: 0, y: 20, width: 10, height: 10 }, value: "CA", draw: DEFAULT_PDF_AREA_DRAW, field: { name: "Applicant", required: true, readOnly: false, tooltip: "Applicant" } }
    ]);
    expect(model.warnings).toEqual([expect.objectContaining({ code: "mapping.unresolved", componentId: "ghost", message: expect.stringContaining('Area "Nobody"') })]);
  });
});

describe("buildPdfRenderModel — conformance", () => {
  const layoutWith = (): PdfGeneratedLayout => ({
    id: "archive",
    kind: "generated",
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: { body: [{ id: "f", type: "pdf-field", configuration: { componentId: "firstName" } }] }
    }
  });
  const profile = { storage: "base64", name: "org-rgb.icc", type: "application/vnd.iccprofile", size: 4, data: "AAAA" };
  const hosted = { storage: "asset", name: "org.icc", type: "application/vnd.iccprofile", size: 4, ref: "icc-1" };
  const stored = (json: string) => JSON.parse(Buffer.from(json, "base64").toString("utf8")) as Record<string, unknown>;

  it("carries the level the layout asks for, from its own key or the document node's configuration, and none otherwise", async () => {
    const none = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: layoutWith() });
    expect(none.document!.conformance).toBeUndefined();
    expect(none.document!.accessibility).toEqual({ tagged: true, displayDocTitle: true });

    const own = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: { ...layoutWith(), conformance: { pdfa: "2u" } } });
    expect(own.document!.conformance).toEqual({ pdfa: "2u" });

    const onRoot: PdfGeneratedLayout = layoutWith();
    onRoot.root.configuration = { conformance: { pdfa: "3B" } };
    expect((await buildPdfRenderModel(root(), state(), resolver, {}, { layout: onRoot })).document!.conformance).toEqual({ pdfa: "3b" });
  });

  it("falls back to the theme's level and output intent tier by tier, the layout's own winning", async () => {
    const themed: PdfThemeDefinition = { id: "archive", version: "1.0.0", target: "pdf", pdf: { pdfa: "2b", outputIntent: { profile, identifier: "Org RGB" } } };
    const fromTheme = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: layoutWith(), theme: themed });
    expect(fromTheme.document!.conformance).toEqual({ pdfa: "2b", outputIntent: { profile: { data: "AAAA" }, identifier: "Org RGB", info: "Org RGB" } });

    const levelOnly = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: { ...layoutWith(), conformance: { pdfa: "3u" } }, theme: themed });
    expect(levelOnly.document!.conformance).toEqual({ pdfa: "3u", outputIntent: { profile: { data: "AAAA" }, identifier: "Org RGB", info: "Org RGB" } });

    const intentToo = await buildPdfRenderModel(root(), state(), resolver, {}, {
      layout: { ...layoutWith(), conformance: { pdfa: "3u", outputIntent: { profile: hosted, info: "The org's press", registry: "http://www.color.org" } } },
      theme: themed
    });
    // A host-storage profile waits for the host; its identifier comes from the file name.
    expect(intentToo.document!.conformance).toEqual({
      pdfa: "3u",
      outputIntent: { profile: { source: hosted }, identifier: "org", info: "The org's press", registry: "http://www.color.org" }
    });
  });

  it("names a built-in profile's condition from the kernel's table, and passes the envelope through for the kernel to resolve", async () => {
    const cmyk = await buildPdfRenderModel(root(), state(), resolver, {}, {
      layout: { ...layoutWith(), conformance: { pdfa: "2b", outputIntent: { profile: builtinProfileSource("cmyk") } } }
    });
    expect(cmyk.document!.conformance).toEqual({
      pdfa: "2b",
      outputIntent: {
        profile: { source: { storage: "builtin", ref: "cmyk", name: "CGATS TR 001 compatible.icc", type: "application/vnd.iccprofile", size: 8464 } },
        identifier: "CGATS TR 001",
        info: "CGATS TR 001 (U.S. Web Coated SWOP), compact compatible profile",
        registry: "http://www.color.org"
      }
    });
    // Its own names win, and naming the condition drops the registry the built-in would have claimed.
    const named = await buildPdfRenderModel(root(), state(), resolver, {}, {
      layout: { ...layoutWith(), conformance: { pdfa: "2b", outputIntent: { profile: builtinProfileSource("gray"), identifier: "House grey" } } }
    });
    expect(named.document!.conformance!.outputIntent).toEqual({ profile: { source: builtinProfileSource("gray") }, identifier: "House grey", info: "House grey" });
  });

  it("attaches the submission under part 3 as stable-key JSON with the configured name and localized description, and warns under part 2", async () => {
    const translations: FormTranslations = { fr: { pdf: { [layoutWith().id]: { conformance: { attachment: { description: entry("Réponses", "Answers") } } } } } };
    const attached = await buildPdfRenderModel(root(), state(), resolver, { locale: "fr", translations }, {
      layout: { ...layoutWith(), conformance: { pdfa: "3b", attachData: true, attachment: { name: "answers.json", description: "Answers" } } }
    });
    const conformance = attached.document!.conformance!;
    expect(conformance.pdfa).toBe("3b");
    expect(conformance.attachments).toHaveLength(1);
    const [attachment] = conformance.attachments!;
    expect(attachment).toMatchObject({ name: "answers.json", mimeType: "application/json", description: "Réponses", relationship: "Data" });
    const payload = stored(attachment!.data);
    expect(payload).toMatchObject({ form: "root", layout: layoutWith().id, locale: "fr" });
    expect((payload.values as Record<string, unknown>).firstName).toBe("Ada");
    // Stable keys: what the sandbox would serialize, so both hosts embed the same bytes.
    expect(Object.keys(payload)).toEqual(["form", "layout", "locale", "values"]);
    expect(Object.keys(payload.values as object)).toEqual([...Object.keys(payload.values as object)].sort());

    const refused = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: { ...layoutWith(), conformance: { pdfa: "2b", attachData: true } } });
    expect(refused.document!.conformance).toEqual({ pdfa: "2b" });
    expect(refused.warnings).toEqual([expect.objectContaining({ code: "pdfa.attachments" })]);

    const defaults = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: { ...layoutWith(), conformance: { pdfa: "3u", attachData: true } } });
    expect(defaults.document!.conformance!.attachments![0]).toMatchObject({ name: "submission.json", description: "Submission data" });
  });

  it("carries a template layout's claim into the fill plan, without an output intent — the template keeps its own", async () => {
    const template: PdfTemplateLayout = {
      id: "gov",
      kind: "template",
      template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
      fields: [{ pdfField: "Name", source: { kind: "path", path: "firstName" } }],
      conformance: { pdfa: "3b", attachData: true, outputIntent: { profile } }
    };
    const model = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: template });
    expect(model.fill!.conformance).toMatchObject({ pdfa: "3b", attachments: [expect.objectContaining({ name: "submission.json" })] });
    expect(model.fill!.conformance!.outputIntent).toBeUndefined();
    expect(model.warnings).toEqual([expect.objectContaining({ code: "pdfa.outputIntent" })]);

    // A theme's intent is for the documents it generates: no word about it under a template.
    const themed: PdfThemeDefinition = { id: "archive", version: "1.0.0", target: "pdf", pdf: { pdfa: "2b", outputIntent: { profile } } };
    const { conformance: _own, ...unclaimed } = template;
    const quiet = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: unclaimed, theme: themed });
    expect(quiet.fill!.conformance).toEqual({ pdfa: "2b" });
    expect(quiet.warnings).toEqual([]);

    const plain = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: unclaimed });
    expect(plain.fill!.conformance).toBeUndefined();
  });
});

describe("buildPdfRenderModel — attachments", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  const photo = { storage: "base64", name: "photo.png", type: "image/png", size: 68, data: PNG };
  const scan = { storage: "base64", name: "scan.pdf", type: "application/pdf", size: 4, data: "JVBERg==" };
  const receiptA = { storage: "base64", name: "receipt-a.jpg", type: "image/jpeg", size: 3, data: "AAAA" };
  const receiptB = { storage: "base64", name: "receipt-b.jpg", type: "image/jpeg", size: 3, data: "BBBB" };
  const hosted = { storage: "s3", name: "big.zip", type: "application/zip", size: 1024, ref: { key: "u/1" } };

  function claims(configuration: Record<string, unknown> = {}): ComponentNode {
    return {
      id: "root",
      type: "form",
      configuration: { title: "Claim" },
      children: {
        content: [
          { id: "doc", type: "file", configuration: { label: "Supporting document", storage: "base64", pdf: { attach: true }, ...configuration } },
          { id: "photos", type: "file", configuration: { label: "Photos", storage: "base64", multiple: true } },
          { id: "secretFile", type: "file", configuration: { label: "Secret", hidden: true, pdf: { attach: true } } },
          {
            id: "items",
            type: "panel",
            configuration: { label: "Items" },
            collection: { collectionPath: "items", itemFields: ["sku", "receipt"] },
            children: {
              content: [
                { id: "sku", type: "text", configuration: { label: "SKU" } },
                { id: "receipt", type: "file", configuration: { label: "Receipt", pdf: { attach: true } } }
              ]
            }
          }
        ]
      }
    };
  }

  const claimValues = {
    doc: scan,
    photos: [photo, scan],
    secretFile: photo,
    "items[0].sku": "A-1",
    "items[0].receipt": receiptA,
    "items[1].sku": "B-2",
    "items[1].receipt": receiptB
  };

  function layoutOf(body: ComponentNode[], extra: Partial<PdfGeneratedLayout> = {}): PdfGeneratedLayout {
    return { id: "claims", kind: "generated", root: { id: "document", type: "pdf-document", configuration: {}, children: { body } }, ...extra };
  }

  const field = (id: string, componentId: string, configuration: Record<string, unknown> = {}): ComponentNode => ({
    id,
    type: "pdf-field",
    configuration: { componentId, ...configuration }
  });

  it("embeds a file component's uploads when its instance says so, described by its label, whatever rendition draws it", async () => {
    const model = await buildPdfRenderModel(claims({ pdf: { attach: true, rendition: "image" } }), state(claimValues), resolver, {}, {
      layout: layoutOf([field("f1", "doc"), field("f2", "photos")])
    });
    expect(model.warnings).toEqual([]);
    expect(model.document!.attachments).toEqual([
      { name: "scan.pdf", mimeType: "application/pdf", description: "Supporting document", relationship: "Supplement", componentId: "doc", data: "JVBERg==" }
    ]);
    expect(byKind(model.document, "image")).toHaveLength(0);
  });

  it("lets a binding decide either way, and embeds a file once however many bindings draw it", async () => {
    const bound = await buildPdfRenderModel(claims(), state(claimValues), resolver, {}, {
      layout: layoutOf([field("f1", "photos", { attach: true, label: "Pictures" }), field("f2", "photos", { attach: true }), field("f3", "doc", { attach: false })])
    });
    expect(bound.document!.attachments!.map((entry) => [entry.name, entry.componentId, entry.description])).toEqual([
      ["photo.png", "photos", "Pictures"],
      ["scan.pdf", "photos", "Pictures"]
    ]);
  });

  it("attaches nothing for a hidden or excluded component, or one whose value holds no file", async () => {
    const tree = claims({ pdf: { attach: true, exclude: true } });
    const model = await buildPdfRenderModel(tree, state({ ...claimValues, photos: "not a file" }), resolver, {}, {
      layout: layoutOf([field("f1", "doc"), field("f2", "secretFile"), field("f3", "photos", { attach: true })])
    });
    expect(model.document!.attachments).toBeUndefined();
  });

  it("gathers each row's files through a repeat, and through a collection drawn as a table", async () => {
    const repeated = await buildPdfRenderModel(claims(), state(claimValues), resolver, {}, {
      layout: layoutOf([
        { id: "rep", type: "pdf-repeat", configuration: { collectionPath: "items" }, children: { row: [field("rf", "receipt")] } }
      ])
    });
    expect(repeated.document!.attachments!.map((entry) => entry.name)).toEqual(["receipt-a.jpg", "receipt-b.jpg"]);

    const tabled = await buildPdfRenderModel(claims(), state(claimValues), resolver, {}, { layout: layoutOf([field("f1", "items")]) });
    expect(tabled.document!.attachments!.map((entry) => entry.name)).toEqual(["receipt-a.jpg", "receipt-b.jpg"]);

    const derived = await buildPdfRenderModel(claims(), state(claimValues), resolver);
    expect(derived.document!.attachments!.map((entry) => entry.name)).toEqual(["scan.pdf", "receipt-a.jpg", "receipt-b.jpg"]);
  });

  it("carries a hosted file as its envelope for the host to resolve", async () => {
    const model = await buildPdfRenderModel(claims(), state({ ...claimValues, doc: hosted }), resolver, {}, { layout: layoutOf([field("f1", "doc")]) });
    expect(model.document!.attachments).toEqual([
      { name: "big.zip", mimeType: "application/zip", description: "Supporting document", relationship: "Supplement", componentId: "doc", source: hosted }
    ]);
  });

  it("applies the layout's budget — skipping with a warning, or refusing — and lets the call override it", async () => {
    const body = [field("f1", "doc"), field("f2", "photos", { attach: true })];
    const skipped = await buildPdfRenderModel(claims(), state(claimValues), resolver, {}, { layout: layoutOf(body, { attachments: { budgetMb: 70 / (1024 * 1024) } }) });
    expect(skipped.document!.attachments!.map((entry) => entry.name)).toEqual(["scan.pdf"]);
    expect(skipped.warnings).toEqual([{ code: "attachment.skipped", componentId: "photos", message: expect.stringContaining('"photo.png"') }]);

    const onRoot = layoutOf(body);
    onRoot.root.configuration = { attachments: { budgetMb: 70 / (1024 * 1024), onExceeded: "fail" } };
    await expect(buildPdfRenderModel(claims(), state(claimValues), resolver, {}, { layout: onRoot })).rejects.toMatchObject({ name: "PdfKernelError", code: "attachment_budget" });

    const raised = await buildPdfRenderModel(claims(), state(claimValues), resolver, {}, { layout: onRoot, attachments: { budgetBytes: 1024, onExceeded: "skip" } });
    expect(raised.document!.attachments!.map((entry) => entry.name)).toEqual(["scan.pdf", "photo.png"]);
    expect(raised.warnings).toEqual([]);
  });

  it("gathers a template layout's files from the form itself, rows included, on the instance rung alone", async () => {
    const template: PdfTemplateLayout = {
      id: "gov",
      kind: "template",
      template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
      fields: [{ pdfField: "Name", source: { kind: "path", path: "firstName" } }],
      attachments: { budgetMb: 1 }
    };
    const model = await buildPdfRenderModel(claims(), state(claimValues), resolver, {}, { layout: template });
    expect(model.fill!.attachments!.map((entry) => [entry.name, entry.componentId])).toEqual([
      ["scan.pdf", "doc"],
      ["receipt-a.jpg", "receipt"],
      ["receipt-b.jpg", "receipt"]
    ]);

    await expect(
      buildPdfRenderModel(claims(), state(claimValues), resolver, {}, { layout: { ...template, attachments: { budgetMb: 0, onExceeded: "fail" } } })
    ).rejects.toMatchObject({ name: "PdfKernelError", code: "attachment_budget" });
  });
});

describe("buildPdfRenderModel — signatures", () => {
  const layoutWith = (body: ComponentNode[], configuration: Record<string, unknown> = {}): PdfGeneratedLayout => ({
    id: "sealed",
    kind: "generated",
    root: { id: "document", type: "pdf-document", configuration, children: { body } }
  });
  const block = (id: string, configuration: Record<string, unknown>): ComponentNode => ({ id, type: "pdf-signature", configuration });

  it("makes a signature block a named signature widget with its caption, or a line to sign on", async () => {
    const layout = layoutWith([
      block("sig", { fieldName: "server-signature", label: "Certified by {{firstName}}", width: 200, height: 56 }),
      block("pen", { mode: "line", label: "Applicant's signature" }),
      block("bare", {})
    ]);
    const model = await buildPdfRenderModel(root(), state({ firstName: "Ada" }), resolver, {}, { layout });
    expect(model.warnings).toEqual([]);
    const widgets = byKind(model.document, "widget");
    expect(widgets.map((widget) => [widget.field.name, widget.field.kind, widget.label, widget.width, widget.height])).toEqual([
      ["server-signature", "signature", "Certified by Ada", 200, 56],
      ["bare", "signature", undefined, undefined, 40]
    ]);
    expect(widgets[0]!.field.tooltip).toBe("Certified by Ada");
    expect(widgets[0]!.componentId).toBeUndefined();
    const line = byKind(model.document, "labelValue").find((entry) => entry.arrangement === "ruled");
    expect(line).toMatchObject({ label: "Applicant's signature", lines: 1, value: [] });
  });

  it("warns when two blocks name one field", async () => {
    const layout = layoutWith([block("a", { fieldName: "same" }), block("b", { fieldName: "same" })]);
    const model = await buildPdfRenderModel(root(), state(), resolver, {}, { layout });
    expect(model.warnings.map((warning) => warning.code)).toEqual(["layout.duplicateWidgetName"]);
  });

  it("carries the layout's signature settings, the reason localized, from its own key or the document node", async () => {
    const layout = layoutWith([block("sig", { fieldName: "server-signature" })]);
    const settings = { field: "server-signature", certify: "noChanges", reason: "Submitted through the web form", timestamp: true, required: true, appearance: { fontSize: 9 } };
    const own = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: { ...layout, signature: settings } as PdfGeneratedLayout });
    expect(own.document!.signature).toEqual({ field: "server-signature", certify: "noChanges", reason: "Submitted through the web form", timestamp: true, required: true, appearance: { fontSize: 9 } });
    expect(own.warnings).toEqual([]);

    const translations: FormTranslations = { fr: { pdf: { [layout.id]: { signature: { reason: entry("Soumis par le formulaire", "Submitted through the web form") } } } } };
    const french = await buildPdfRenderModel(root(), state(), resolver, { locale: "fr", translations }, { layout: { ...layout, signature: settings } as PdfGeneratedLayout });
    expect(french.document!.signature!.reason).toBe("Soumis par le formulaire");

    const onRoot = layoutWith([block("sig", { fieldName: "server-signature" })], { signature: { certify: "formFilling", subFilter: "adbe.pkcs7.detached", bogus: 1 } });
    expect((await buildPdfRenderModel(root(), state(), resolver, {}, { layout: onRoot })).document!.signature).toEqual({ certify: "formFilling", subFilter: "adbe.pkcs7.detached" });

    const none = await buildPdfRenderModel(root(), state(), resolver, {}, { layout });
    expect(none.document!.signature).toBeUndefined();
  });

  it("warns when the layout names a field no signature block makes", async () => {
    const layout = { ...layoutWith([block("sig", { fieldName: "other" })]), signature: { field: "server-signature" } } as PdfGeneratedLayout;
    const model = await buildPdfRenderModel(root(), state(), resolver, {}, { layout });
    expect(model.warnings.map((warning) => warning.code)).toEqual(["signature.fieldMissing"]);
    expect(model.document!.signature).toEqual({ field: "server-signature" });
  });

  it("carries a template layout's signature settings into the fill plan", async () => {
    const template: PdfTemplateLayout = {
      id: "gov",
      kind: "template",
      template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
      fields: [{ pdfField: "Name", source: { kind: "path", path: "firstName" } }],
      signature: { field: "OfficerSignature", certify: "noChanges", reason: "Reviewed" }
    };
    const model = await buildPdfRenderModel(root(), state(), resolver, {}, { layout: template });
    expect(model.fill!.signature).toEqual({ field: "OfficerSignature", certify: "noChanges", reason: "Reviewed" });
    expect(model.warnings).toEqual([]);
  });
});

describe("buildPdfRenderModel — layouts chosen by the answers", () => {
  const body = (text: string): PdfGeneratedLayout["root"] => ({
    id: "document",
    type: "pdf-document",
    configuration: {},
    children: { body: [{ id: "t", type: "pdf-text", configuration: { text } }] }
  });
  const standard: PdfGeneratedLayout = { id: "standard", kind: "generated", root: body("Standard") };
  const french: PdfGeneratedLayout = {
    id: "french",
    kind: "generated",
    when: { kind: "binary", operator: "eq", left: { kind: "path", path: "country" }, right: { kind: "literal", value: "FR" } },
    root: body("Français")
  };
  const paper: PdfTemplateLayout = {
    id: "paper",
    kind: "template",
    when: { kind: "path", path: "agree" },
    template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
    fields: [{ pdfField: "Name", source: { kind: "component", componentId: "firstName" } }]
  };
  const pdf = { layouts: [standard, french, paper], defaultLayoutId: "standard" };

  it("names how the layout was chosen on every return: generated, template and derived", async () => {
    // state(): country CA, agree true — the template's condition holds, the French one does not.
    const byCondition = await buildPdfRenderModel(root(), state(), resolver, {}, { pdf });
    expect(byCondition).toMatchObject({ layoutId: "paper", layoutKind: "template", layoutChoice: "condition" });
    const french$ = await buildPdfRenderModel(root(), state({ country: "FR" }), resolver, {}, { pdf });
    expect(french$).toMatchObject({ layoutId: "french", layoutKind: "generated", layoutChoice: "condition" });
    const byDefault = await buildPdfRenderModel(root(), state({ agree: false }), resolver, {}, { pdf });
    expect(byDefault).toMatchObject({ layoutId: "standard", layoutChoice: "default" });
    const fallback = await buildPdfRenderModel(root(), state({ agree: false }), resolver, {}, { pdf: { layouts: pdf.layouts } });
    expect(fallback).toMatchObject({ layoutId: "standard", layoutChoice: "fallback" });
    const asked = await buildPdfRenderModel(root(), state({ country: "FR" }), resolver, {}, { pdf, layoutId: "standard" });
    expect(asked).toMatchObject({ layoutId: "standard", layoutChoice: "asked" });
    const given = await buildPdfRenderModel(root(), state({ country: "FR" }), resolver, {}, { pdf, layout: standard });
    expect(given).toMatchObject({ layoutId: "standard", layoutChoice: "given" });
    const derived = await buildPdfRenderModel(root(), state(), resolver, {}, {});
    expect(derived).toMatchObject({ layoutKind: "derived", layoutChoice: "derived" });
    expect([byCondition, french$, byDefault, fallback, asked, given, derived].every((model) => model.warnings.every((warning) => !warning.code.startsWith("layout.")))).toBe(true);
  });

  it("chooses over selectionValues when given, and prints the state's values all the same", async () => {
    // The raw state still holds an answer the submittable view leaves out (an abandoned branch):
    // the choice reads the submittable view, what prints is the state.
    const model = await buildPdfRenderModel(root(), state({ country: "FR", agree: false }), resolver, {}, { pdf, selectionValues: { country: "CA", agree: false } });
    expect(model).toMatchObject({ layoutId: "standard", layoutChoice: "default" });
    const chosen = await buildPdfRenderModel(root(), state({ agree: false }), resolver, {}, { pdf, selectionValues: { country: "FR" } });
    expect(chosen).toMatchObject({ layoutId: "french", layoutChoice: "condition" });
  });

  it("warns layout.conditionInvalid for a when it cannot run and layout.conditionFailed for one that throws, counting each as not holding", async () => {
    // A misspelt tree is a condition the evaluator cannot run; a string is a formula
    // of formulas, and one the parser rejects is dropped at compile time with its own warning.
    const odd = { ...french, id: "odd", when: { kind: "binary", operator: "equals", left: { kind: "path", path: "country" }, right: { kind: "literal", value: "FR" } } as unknown as NonNullable<PdfGeneratedLayout["when"]> };
    const written = { ...french, id: "written", when: "country is FR" };
    const throwing: PdfGeneratedLayout = {
      ...french,
      id: "throwing",
      when: { kind: "binary", operator: "eq", left: { kind: "path", path: "notes.deep" }, right: { kind: "literal", value: "x" } }
    };
    const model = await buildPdfRenderModel(root(), state({ agree: false }), resolver, {}, {
      pdf: { layouts: [standard, odd, written, throwing, french], defaultLayoutId: "standard" },
      // The `written` formula does not parse: under the default (fail) that refuses, so
      // this case pins what the explicit warn opt-in does with it.
      formulaErrors: "warn",
      // An answer that cannot be read: reading `notes.deep` throws inside the evaluator (a
      // function call never does: it is no answer, and a comparison over a non-number is no
      // answer too). Under a key the form defines (`notes`): a key no component owns is not read
      // at all.
      selectionValues: { country: "FR", notes: new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("unwritable"); } }) }
    });
    expect(model).toMatchObject({ layoutId: "french", layoutChoice: "condition" });
    expect(model.warnings.filter((warning) => warning.code.startsWith("layout."))).toEqual([
      { code: "layout.conditionInvalid", message: 'The condition of PDF layout "odd" is not one the evaluator can run; it counted as not holding.' },
      { code: "layout.conditionFailed", message: expect.stringMatching(/^The condition of PDF layout "throwing" could not be evaluated \(.+\); it counted as not holding\.$/) }
    ]);
    expect(model.warnings.filter((warning) => warning.code === "formula.invalid")).toEqual([{ code: "formula.invalid", message: expect.stringContaining("pdf:written") }]);
  });
});

// A literal matches pattern that repeats a repeat is a formula problem, unless the host allows it.
describe("buildPdfRenderModel — riskyPatterns", () => {
  const body = (text: string): PdfGeneratedLayout["root"] => ({
    id: "document",
    type: "pdf-document",
    configuration: {},
    children: { body: [{ id: "t", type: "pdf-text", configuration: { text } }] }
  });
  const standard: PdfGeneratedLayout = { id: "standard", kind: "generated", root: body("Standard") };
  const french: PdfGeneratedLayout = {
    id: "french",
    kind: "generated",
    when: { kind: "binary", operator: "eq", left: { kind: "path", path: "country" }, right: { kind: "literal", value: "FR" } },
    root: body("Français")
  };
  const riskyLayout: PdfGeneratedLayout = { ...french, id: "risky", when: 'matches(country, "(F+)+$")' };
  const pdfWith = { layouts: [standard, riskyLayout, french], defaultLayoutId: "standard" };

  it("refuses a literal risky matches pattern in a layout condition under the default policy, as pattern.risky", async () => {
    await expect(buildPdfRenderModel(root(), state({ country: "FR" }), resolver, {}, { pdf: pdfWith })).rejects.toMatchObject({ code: "formula_invalid" });
    await expect(buildPdfRenderModel(root(), state({ country: "FR" }), resolver, {}, { pdf: pdfWith })).rejects.toThrow(/\(F\+\)\+\$/);
  });

  it("drops the rule with a formula.invalid warning under warn, and compiles it when the host allows risky patterns", async () => {
    const warned = await buildPdfRenderModel(root(), state({ country: "FR" }), resolver, {}, { pdf: pdfWith, formulaErrors: "warn" });
    expect(warned.warnings.filter((warning) => warning.code === "formula.invalid")).toEqual([{ code: "formula.invalid", message: expect.stringContaining("pdf:risky") }]);
    const allowed = await buildPdfRenderModel(root(), state({ country: "FR" }), resolver, {}, { pdf: pdfWith, riskyPatterns: "allow" });
    expect(allowed.warnings.filter((warning) => warning.code === "formula.invalid")).toEqual([]);
    expect(allowed).toMatchObject({ layoutId: "french" });
  });
});

describe("buildPdfRenderModel — answers as the envelope carries them", () => {
  it("prints a calculation's NaN or Infinity as the unanswered value a server's PDF of the same submission prints", async () => {
    const printed = async (notes: unknown, qty: unknown) => {
      const model = await buildPdfRenderModel(root(), state({ notes, "items[1].qty": qty }), resolver);
      const labelValues = byKind(model.document, "labelValue").map((block) => [block.label, runsText(block.value)]);
      const rows = byKind(model.document, "table")[1]!.rows.map((row) => row.cells.map((cell) => textOf(cell.blocks[0])));
      return { labelValues, rows };
    };
    // What a server holds once the submission has crossed the wire as JSON: null.
    const server = await printed(null, null);
    expect(server.labelValues).toContainEqual(["Notes", "—"]);
    expect(server.rows).toEqual([
      ["A-1", "2"],
      ["B-2", ""]
    ]);
    for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const browser = await printed(nonFinite, nonFinite);
      expect(browser, String(nonFinite)).toEqual(server);
      expect(JSON.stringify(browser)).not.toMatch(/NaN|Infinity/);
    }
  });
});

describe("buildPdfRenderModel — a data grid", () => {
  function gridForm(configuration: Record<string, unknown> = {}, extra: Partial<ComponentNode> = {}): ComponentNode {
    return {
      id: "root",
      type: "form",
      configuration: { title: "Order" },
      children: {
        content: [
          {
            id: "lines",
            type: "dataGrid",
            configuration: { label: "Line items", ...configuration },
            collection: { collectionPath: "items" },
            children: {
              content: [
                { id: "sku", type: "text", configuration: { label: "SKU" } },
                { id: "qty", type: "number", configuration: { label: "Qty" } }
              ]
            },
            ...extra
          }
        ]
      }
    };
  }

  const rowsOf = (table: Extract<PdfBlock, { kind: "table" }>) => table.rows.map((row) => row.cells.map((cell) => textOf(cell.blocks[0])));

  it("prints as a table by default: a header from the children's labels, one kept-together row per entry, no unknown-component warning", async () => {
    const model = await buildPdfRenderModel(gridForm(), state(), resolver);
    const tables = byKind(model.document, "table");
    expect(tables).toHaveLength(1);
    const table = tables[0]!;
    expect(table).toMatchObject({ role: "Table", repeatHeader: true, borders: "all", componentId: "lines", caption: "Line items" });
    expect(table.header?.cells.map((cell) => textOf(cell.blocks[0]))).toEqual(["SKU", "Qty"]);
    expect(rowsOf(table)).toEqual([
      ["A-1", "2"],
      ["B-2", "5"]
    ]);
    expect(table.rows.every((row) => row.keepTogether)).toBe(true);
    expect(model.warnings).toEqual([]);
  });

  it("words a grid's caption in the render's language at components > grid > label; its on-screen texts (emptyText, addLabel, rowLabel) never print", async () => {
    const translations: FormTranslations = {
      "fr-CA": {
        components: {
          lines: {
            label: entry("Lignes de commande", "Line items"),
            emptyText: entry("Aucune ligne", "No lines yet"),
            addLabel: entry("Ajouter une ligne", "Add line"),
            rowLabel: entry("Ligne", "Line")
          }
        }
      }
    };
    const form = gridForm({ emptyText: "No lines yet", addLabel: "Add line", rowLabel: "Line" });
    const french = await buildPdfRenderModel(form, { ...state(), locale: "fr-CA" }, resolver, { locale: "fr-CA", translations });
    expect(byKind(french.document, "table")[0]).toMatchObject({ componentId: "lines", caption: "Lignes de commande" });
    // Another language keeps the string.
    const english = await buildPdfRenderModel(form, state(), resolver, { locale: "en-CA", translations });
    expect(byKind(english.document, "table")[0]).toMatchObject({ caption: "Line items" });
    // The sections rendition numbers its rows from the caption, in French too.
    const sections = await buildPdfRenderModel(gridForm({ pdf: { rendition: "sections" } }), { ...state(), locale: "fr-CA" }, resolver, { locale: "fr-CA", translations });
    expect(byKind(sections.document, "heading").map(textOf)).toEqual(expect.arrayContaining(["Lignes de commande 1", "Lignes de commande 2"]));
    // A grid with no rows prints its header only: the empty-state and button words are the screen's.
    const noRows = state();
    for (const key of ["items[0].sku", "items[0].qty", "items[1].sku", "items[1].qty"]) {
      delete noRows.values[key];
    }
    const empty = await buildPdfRenderModel(form, { ...noRows, locale: "fr-CA" }, resolver, { locale: "fr-CA", translations });
    expect(byKind(empty.document, "table")[0]!.rows).toEqual([]);
    const everything = JSON.stringify([french.document, empty.document]);
    for (const word of ["Aucune ligne", "No lines yet", "Ajouter une ligne", "Add line"]) {
      expect(everything, word).not.toContain(word);
    }
  });

  it("prints rows stored whole as a list the way it prints flat keys, and a data key is read from its own place in the row", async () => {
    const form = gridForm();
    form.children!.content![0]!.children!.content![1]!.configuration = { label: "Qty", dataKey: "quantity" };
    const whole = await buildPdfRenderModel(form, state({ "items[0].sku": undefined, "items[0].qty": undefined, "items[1].sku": undefined, "items[1].qty": undefined, items: [{ sku: "C-3", quantity: 7 }, { sku: "D-4", quantity: 8 }] }), resolver);
    expect(rowsOf(byKind(whole.document, "table")[0]!)).toEqual([
      ["C-3", "7"],
      ["D-4", "8"]
    ]);
    const flat = await buildPdfRenderModel(form, state({ "items[0].quantity": 9, "items[1].quantity": 10 }), resolver);
    expect(rowsOf(byKind(flat.document, "table")[0]!)).toEqual([
      ["A-1", "9"],
      ["B-2", "10"]
    ]);
  });

  it("prints a cell inside a data-scoping container of the row template from its path within the entry", async () => {
    const form = gridForm();
    form.children!.content![0]!.children!.content!.push({
      id: "where",
      type: "container",
      configuration: { label: "Where", dataKey: "address" },
      children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] }
    });
    const model = await buildPdfRenderModel(form, state({ "items[0].address.city": "Ottawa", "items[1].address.city": "Hull" }), resolver);
    const table = byKind(model.document, "table")[0]!;
    expect(table.header?.cells.map((cell) => textOf(cell.blocks[0]))).toEqual(["SKU", "Qty", "City"]);
    expect(rowsOf(table).map((row) => row[2])).toEqual(["Ottawa", "Hull"]);
  });

  it("draws an empty row as a blank table row and a grid with no rows as a header alone", async () => {
    const blank = await buildPdfRenderModel(gridForm(), state({ items: [{}, { sku: "Z" }], "items[0].sku": undefined, "items[0].qty": undefined, "items[1].sku": undefined, "items[1].qty": undefined }), resolver);
    expect(rowsOf(byKind(blank.document, "table")[0]!)).toEqual([
      ["", ""],
      ["Z", ""]
    ]);
    // Rows drawn with nothing answered yet hold their keys as `undefined` in a live form's state
    // and each prints as a blank row, as the server's PDF of the posted `items: [{}, {}]`
    // does; one between two answered rows is not folded into the next.
    const drawn = await buildPdfRenderModel(gridForm(), state({ "items[0].sku": undefined, "items[0].qty": undefined, "items[1].sku": undefined, "items[1].qty": undefined }), resolver);
    expect(rowsOf(byKind(drawn.document, "table")[0]!)).toEqual([
      ["", ""],
      ["", ""]
    ]);
    const middle = await buildPdfRenderModel(
      gridForm(),
      state({ "items[0].sku": "A", "items[0].qty": undefined, "items[1].sku": undefined, "items[1].qty": undefined, "items[2].sku": "C", "items[2].qty": undefined }),
      resolver
    );
    expect(rowsOf(byKind(middle.document, "table")[0]!)).toEqual([
      ["A", ""],
      ["", ""],
      ["C", ""]
    ]);
    const empty = state();
    for (const key of Object.keys(empty.values).filter((key) => key.startsWith("items["))) {
      delete empty.values[key];
    }
    const none = await buildPdfRenderModel(gridForm(), empty, resolver);
    expect(byKind(none.document, "table")[0]!.rows).toEqual([]);
  });

  it("prints one labelled group per row under layout: stacked, and keeps the table for table and auto", async () => {
    const stacked = await buildPdfRenderModel(gridForm({ layout: "stacked" }), state(), resolver);
    expect(byKind(stacked.document, "table")).toHaveLength(0);
    const groups = byKind(stacked.document, "group").filter((block) => block.role === "Sect");
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => textOf(group.blocks[0]))).toEqual(["Line items 1", "Line items 2"]);
    expect(groups[1]!.blocks.filter((block) => block.kind === "labelValue").map((block) => [block.label, runsText(block.value)])).toEqual([
      ["SKU", "B-2"],
      ["Qty", "5"]
    ]);
    for (const layout of ["table", "auto"]) {
      const model = await buildPdfRenderModel(gridForm({ layout }), state(), resolver);
      expect(byKind(model.document, "table"), layout).toHaveLength(1);
    }
  });

  it("lets a layout's binding, the instance or renditionDefaults pick either rendition over the grid's own layout", async () => {
    const layoutFor = (configuration: Record<string, unknown>, renditionDefaults?: Record<string, string>): PdfGeneratedLayout => ({
      id: "g",
      kind: "generated",
      ...(renditionDefaults ? { renditionDefaults } : {}),
      root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "b", type: "pdf-field", configuration: { componentId: "lines", ...configuration } }], header: [], footer: [] } }
    });
    const bound = await buildPdfRenderModel(gridForm({ layout: "stacked" }), state(), resolver, {}, { layout: layoutFor({ rendition: "table" }) });
    expect(byKind(bound.document, "table")).toHaveLength(1);
    const defaults = await buildPdfRenderModel(gridForm(), state(), resolver, {}, { layout: layoutFor({}, { dataGrid: "sections" }) });
    expect(byKind(defaults.document, "table")).toHaveLength(0);
    expect(byKind(defaults.document, "group").filter((block) => block.role === "Sect")).toHaveLength(2);
    const instance = await buildPdfRenderModel(gridForm({ pdf: { rendition: "sections" } }), state(), resolver);
    expect(byKind(instance.document, "table")).toHaveLength(0);
    // A rendition the collection set lacks is skipped quietly for a wildcard: the grid still prints as its default.
    const wildcard = await buildPdfRenderModel(gridForm(), state(), resolver, {}, { layout: layoutFor({}, { "*": "field" }) });
    expect(byKind(wildcard.document, "table")).toHaveLength(1);
  });

  it("still names a grid it cannot print: an unregistered type with no renditions warns, a dataGrid does not", async () => {
    const form = gridForm();
    form.children!.content!.push({ id: "mystery", type: "mystery", configuration: { label: "Mystery" } });
    const model = await buildPdfRenderModel(form, state(), resolver);
    expect(model.warnings.map((warning) => [warning.code, warning.componentId])).toEqual([["component.unknown", "mystery"]]);
  });
});
