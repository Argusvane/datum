// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPdfBuilderMode, type PdfBuilderMode, type PdfBuilderModeOptions } from "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import type { PdfConfiguration, PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import type { PdfTemplateInfo } from "../form-engine/render/pdf/pdf-abi.js";
import { BASE64_TEMPLATE_RESOLVER, type PdfRenderProvider } from "../form-engine/render/pdf/pdf-provider.js";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { bindableCollections, bindableComponents, createPdfDesigner, pdfSheetWidth } from "../form-engine/builder/pdf-designer/pdf-designer.js";
import { createPdfDesignerBinding } from "../form-engine/builder/pdf-designer/pdf-canvas-adapters.js";
import {
  PDF_DOCUMENT_COMPONENT_TYPE,
  PDF_FIELD_COMPONENT_TYPE,
  PDF_SECTION_COMPONENT_TYPE,
  PDF_TABLE_COMPONENT_TYPE,
  PDF_TEXT_COMPONENT_TYPE,
  type PdfGeneratedLayout
} from "../form-engine/core/schema/pdf-layout.js";
import { FormulaFunctionRegistry } from "../form-engine/registry/formula-functions/formula-function-registry.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { PDF_DESIGNER_CSS } from "../form-engine/render/pdf/pdf-designer-styles.js";
import { designerCanvasHtml, mountDesignerCanvas } from "./fixtures/designer-canvas.js";

function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Customer Intake" },
    children: {
      content: [
        {
          id: "who",
          type: "panel",
          configuration: { label: "Who" },
          children: {
            content: [
              { id: "firstName", type: "text", configuration: { label: "First name" } },
              { id: "agree", type: "checkbox", configuration: { label: "I agree" } }
            ]
          }
        },
        {
          id: "items",
          type: "panel",
          configuration: { label: "Items" },
          collection: { collectionPath: "items", itemFields: ["sku"] },
          children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
        },
        { id: "submit", type: "button", configuration: { label: "Send" } }
      ]
    }
  };
}

/**
 * The designer's canvas markup, the way `<datum-builder>` draws it: the layout tree through the
 * live renderer under the designer's binding with the PDF faces laid over it, and, with `chrome`,
 * the builder's own selection chrome.
 */
function canvasHtml(controller: BuilderController, chrome?: { selectedId: string | undefined }): Promise<string> {
  return designerCanvasHtml(controller, chrome);
}

describe("createPdfDesigner", () => {
  it("hands the builder the PDF palette, the derived layout, and the page theme", async () => {
    const designer = await createPdfDesigner({ formRoot: form(), values: { firstName: "Ada" } });
    expect(designer.layout.kind).toBe("generated");
    expect(designer.layout.root.type).toBe(PDF_DOCUMENT_COMPONENT_TYPE);
    // The edited tree is the layout's root with the derived layout's name on it, for the inspector.
    expect(designer.builderOptions.initialRoot).toEqual({ ...designer.layout.root, configuration: { ...(designer.layout.root.configuration as Record<string, unknown>), name: designer.layout.name } });
    // The canvas draws under the designer's binding (Datum's look and the sheet's rules), the PDF faces laid over it.
    expect(designer.builderOptions.binding).toBe(createPdfDesignerBinding());
    expect(createPdfDesignerBinding().css).toContain(PDF_DESIGNER_CSS.trim());
    expect(Object.keys(designer.builderOptions.canvasComponents ?? {})).toEqual(expect.arrayContaining([PDF_DOCUMENT_COMPONENT_TYPE, PDF_FIELD_COMPONENT_TYPE, PDF_TABLE_COMPONENT_TYPE]));
    expect(designer.builderOptions.componentTypes?.map((entry) => entry.type)).toContain(PDF_FIELD_COMPONENT_TYPE);
    expect(designer.builderOptions.componentTypes?.map((entry) => entry.type)).not.toContain("text");

    const field = designer.builderOptions.componentDefinitions?.find((definition) => definition.type === PDF_FIELD_COMPONENT_TYPE);
    const picker = field?.propertyEditor?.fields?.find((entry) => entry.id === "componentId");
    expect(picker?.type).toBe("select");
    expect(picker?.choices?.map((choice) => choice.value)).toEqual(["", "who", "firstName", "agree", "items", "sku"]);
    expect(picker?.choices?.find((choice) => choice.value === "firstName")?.label).toBe("First name (firstName)");

    // The PDF field name's help text carries the semantics an author cannot see from the box.
    const widgetName = field?.propertyEditor?.fields?.find((entry) => entry.id === "widgetName");
    expect(widgetName?.type).toBe("text");
    expect(widgetName?.description).toContain("value path");
    expect(widgetName?.description).toContain("repeat");
    expect(widgetName?.description).toContain("unique");
  });

  it("offers the host's PDF themes on the document's properties", async () => {
    const designer = await createPdfDesigner({ formRoot: form(), pdfThemes: [{ id: "gcds", label: "GC Design System" }] });
    const document = designer.builderOptions.componentDefinitions?.find((definition) => definition.type === PDF_DOCUMENT_COMPONENT_TYPE);
    const theme = document?.propertyEditor?.fields?.find((entry) => entry.id === "theme");
    expect(theme?.type).toBe("select");
    expect(theme?.choices?.map((choice) => choice.value)).toEqual(["", "gcds"]);
  });

  it("previews a field a plugin formula function works out, and follows functions wired later", async () => {
    const fundForm = (): ComponentNode =>
      ({
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "employees", type: "number", configuration: { label: "Employees" } },
            { id: "fee", type: "number", configuration: { label: "Fee" }, rules: { value: "double(employees)" } }
          ]
        }
      }) as unknown as ComponentNode;
    const registry = new FormulaFunctionRegistry();
    registry.register({ name: "double", params: ["n"], summary: "Twice a number.", example: "double(2)", returns: "number", evaluate: (args) => Number(args[0]) * 2 }, "double-plugin");

    const shown = (designer: { fieldPreview(id: string): HTMLElement | undefined }): string => designer.fieldPreview("fee")?.querySelector("input")?.value ?? "";
    const wired = await createPdfDesigner({ formRoot: fundForm(), values: { employees: 21 }, formulaFunctions: registry });
    expect(shown(wired)).toBe("42");

    const bare = await createPdfDesigner({ formRoot: fundForm(), values: { employees: 21 } });
    expect(shown(bare)).not.toBe("42");
    await bare.setFormulaFunctions(registry);
    expect(shown(bare)).toBe("42");
    await bare.setFormulaFunctions(undefined);
    expect(shown(bare)).not.toBe("42");
  });

  it("fixes the sheet at the page's paper width, so the canvas follows the page setup rather than a picker", async () => {
    const document = (page: unknown): ComponentNode => ({ id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: { page }, children: { body: [] } });
    // 96 CSS px to the inch against 72 points: Letter's 612pt is 816px, A4's 595.28pt rounds to 794px.
    expect(pdfSheetWidth(document({ size: "Letter" }))).toBe(816);
    expect(pdfSheetWidth(document({ size: "A4" }))).toBe(794);
    expect(pdfSheetWidth(document({ size: "Legal" }))).toBe(816);
    expect(pdfSheetWidth(document({ size: "Letter", orientation: "landscape" }))).toBe(1056);
    expect(pdfSheetWidth(document({ size: { width: 360, height: 720 } }))).toBe(480);
    // No setup, or a hand-edited one the kernel would not accept, previews at the kernel's default: Letter.
    expect(pdfSheetWidth(document(undefined))).toBe(816);
    expect(pdfSheetWidth(document({ size: "Tabloid" }))).toBe(816);

    const designer = await createPdfDesigner({ formRoot: form() });
    expect(designer.builderOptions.sheetWidth).toBe(pdfSheetWidth);

    // Through the controller: the width follows the document's page setup as it is edited.
    const controller = new BuilderController(designer.builderOptions);
    expect(controller.sheetWidth()).toBe(816);
    controller.setProperty("document", "page.orientation", "landscape");
    expect(controller.sheetWidth()).toBe(1056);
    controller.setProperty("document", "page.size", "A4");
    expect(controller.sheetWidth()).toBe(1123);
    controller.undo();
    expect(controller.sheetWidth()).toBe(1056);
  });

  it("lists bindable components without the root or buttons, and collections by path", () => {
    expect(bindableComponents(form(), "en").map((component) => [component.id, component.container])).toEqual([
      ["who", true],
      ["firstName", false],
      ["agree", false],
      ["items", true],
      ["sku", false]
    ]);
    expect(bindableCollections(form(), "en")).toEqual([{ path: "items", label: "Items" }]);
  });

  it("previews a bound field read-only through Datum's adapter over the sample values, and refreshes", async () => {
    const designer = await createPdfDesigner({ formRoot: form(), values: { firstName: "Ada" } });
    const preview = designer.fieldPreview("firstName");
    const input = preview?.querySelector("input");
    expect(input?.value).toBe("Ada");
    expect(input?.readOnly).toBe(true);
    expect(preview?.textContent).toContain("First name");
    // A picture: inert, with the state hooks a sheet reads and none of the DOM contract the canvas owns.
    expect(preview?.hasAttribute("inert")).toBe(true);
    const wrapper = preview?.querySelector(".datum-live-field");
    expect(wrapper?.getAttribute("data-kind")).toBe("text");
    expect(wrapper?.hasAttribute("data-readonly")).toBe(true);
    expect(preview?.querySelector("[data-component-id], [data-value-path]")).toBeNull();
    expect(designer.fieldPreview("who")).toBeUndefined();
    expect(designer.fieldPreview("missing")).toBeUndefined();

    await designer.refresh({ firstName: "Grace" });
    expect(designer.fieldPreview("firstName")?.querySelector("input")?.value).toBe("Grace");
    expect(designer.fieldPreview("firstName")).not.toBe(preview);
  });

  it("keeps the newer refresh's previews when an older one finishes after it", async () => {
    const withCountry: ComponentNode = {
      ...form(),
      children: { content: [...form().children!["content"]!, { id: "country", type: "select", configuration: { label: "Country", data: { sourceId: "countries" } } }] }
    };
    // The data source answers when the test says so: the first refresh's call is held back.
    const held: Array<() => void> = [];
    let holding = false;
    const dataSourceResolver: DataSourceResolver = {
      resolveDataSource: () =>
        new Promise((resolve) => {
          const answer = (): void => resolve({ items: [{ value: "CA", label: "Canada" }] });
          if (holding) {
            held.push(answer);
          } else {
            answer();
          }
        })
    };
    const designer = await createPdfDesigner({ formRoot: withCountry, values: { firstName: "Ada" }, dataSourceResolver });
    holding = true;
    const older = designer.refresh({ firstName: "Older" });
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
    holding = false;
    await designer.refresh({ firstName: "Newer" });
    expect(designer.fieldPreview("firstName")?.querySelector("input")?.value).toBe("Newer");
    for (const answer of held) {
      answer();
    }
    await older;
    expect(designer.fieldPreview("firstName")?.querySelector("input")?.value).toBe("Newer");
  });

  it("refreshes over the host's values with the answers tried laid over them", async () => {
    const designer = await createPdfDesigner({ formRoot: form(), values: { firstName: "Ada" } });
    // The wrapper hands the mode the merged map: Try it's answers win, the host's others stay.
    await designer.refresh({ ...{ firstName: "Ada", agree: true }, ...{ firstName: "Grace" } });
    expect(designer.fieldPreview("firstName")?.querySelector("input")?.value).toBe("Grace");
    expect(designer.fieldPreview("agree")?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    // Clearing Try it's answers falls back to the host's.
    await designer.refresh({ firstName: "Ada", agree: true });
    expect(designer.fieldPreview("firstName")?.querySelector("input")?.value).toBe("Ada");
  });

  it("previews through the presentation fold: a hidden field, a field behind a tab, and a collection's column", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "secret", type: "text", configuration: { label: "Secret", hidden: true } },
          {
            id: "sections",
            type: "tabs",
            configuration: { tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] },
            children: { one: [], two: [{ id: "deep", type: "text", configuration: { label: "Deep" } }] }
          },
          {
            id: "kids",
            type: "panel",
            configuration: { label: "Children", rowLabel: "Child {{ n }}" },
            collection: { collectionPath: "kids", itemFields: ["kid"] },
            children: { content: [{ id: "kid", type: "text", configuration: { label: "Name" } }] }
          }
        ]
      }
    };
    const designer = await createPdfDesigner({ formRoot: root, values: { secret: "s", deep: "d", kids: [{ kid: "Ann" }, { kid: "Bo" }] } });
    expect(designer.fieldPreview("secret")?.querySelector("input")?.value).toBe("s");
    expect(designer.fieldPreview("deep")?.querySelector("input")?.value).toBe("d");
    // A collection's column is previewed as authored, the template being the one row: one box, with no row's answer.
    const kid = designer.fieldPreview("kid");
    expect(kid?.querySelectorAll("input")).toHaveLength(1);
    expect(kid?.textContent).toContain("Name");
  });

  it("previews a type no adapter draws as its label and its answer", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "stars", type: "x-rating", configuration: { label: "Rating" } }] }
    };
    const designer = await createPdfDesigner({ formRoot: root, values: { stars: "4" } });
    const preview = designer.fieldPreview("stars");
    expect(preview?.querySelector(".datum-live-field")?.getAttribute("data-kind")).toBe("unknown");
    expect(preview?.textContent).toContain("Rating");
  });

  it("drives a BuilderController: add a field, bind it, undo; the canvas shows the sheet and the bound preview", async () => {
    const designer = await createPdfDesigner({ formRoot: form(), values: { firstName: "Ada" }, layout: { id: "blank", kind: "generated", root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: { page: { size: "A4" } }, children: { body: [], header: [], footer: [] } } } });
    const controller = new BuilderController(designer.builderOptions);
    expect(controller.componentTypes().map((entry) => entry.type)).toContain(PDF_TABLE_COMPONENT_TYPE);

    controller.add(PDF_FIELD_COMPONENT_TYPE, "document", "body");
    const fieldId = controller.snapshot().children?.body?.[0]?.id;
    expect(fieldId).toBeDefined();
    controller.setProperty(fieldId!, "componentId", "firstName");
    controller.add(PDF_TEXT_COMPONENT_TYPE, "document", "footer");
    const textId = controller.snapshot().children?.footer?.[0]?.id;
    controller.setProperty(textId!, "text", "Page {{page}} of {{pages}}");
    controller.add(PDF_TABLE_COMPONENT_TYPE, "document", "body");

    const canvas = await mountDesignerCanvas(controller);
    const html = canvas.html();
    expect(html).toContain('class="datum-pdf-sheet"');
    expect(html).toContain("--datum-pdf-ratio:1.4143");
    expect(html).toContain('data-bound="firstName"');
    expect(html).toContain('<div class="datum-pdf-field__preview">');
    // The bound field's own drawing, over the sample answers.
    expect(canvas.root.querySelector<HTMLInputElement>('[data-bound="firstName"] .datum-pdf-field__preview input')?.value).toBe("Ada");
    canvas.unmount();
    expect(html).toContain('<span class="datum-pdf-token">{{page}}</span>');
    expect(html).toContain('<table class="datum-pdf-table datum-pdf-table--all"');
    expect(html).toContain('data-cell="r2c2"');

    const layout = designer.layoutFrom(controller.snapshot());
    expect(layout.id).toBe("blank");
    expect(layout.root.children?.body?.map((node) => node.type)).toEqual([PDF_FIELD_COMPONENT_TYPE, PDF_TABLE_COMPONENT_TYPE]);

    controller.undo();
    expect(controller.snapshot().children?.body?.map((node) => node.type)).toEqual([PDF_FIELD_COMPONENT_TYPE]);
    expect(designer.layout.root.children?.body).toEqual([]);
  });

  it("keeps the document root out of the canvas's hover and click chrome: the Layout button is the way to it", async () => {
    // The sheet is the document's face, and the document is the root. Wrapped as a `db-node`
    // it outlined the whole sheet on hover and selected the document on a click of its blank
    // paper — neither of which the form root does. It gets the form root's treatment instead.
    const designer = await createPdfDesigner({ formRoot: form(), layout: { id: "blank", kind: "generated", root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: { page: { size: "A4" } }, children: { body: [], header: [], footer: [] } } } });
    const controller = new BuilderController(designer.builderOptions);
    controller.add(PDF_SECTION_COMPONENT_TYPE, "document", "body");
    const sectionId = controller.snapshot().children?.body?.[0]?.id;
    expect(sectionId).toBeDefined();

    for (const selectedId of [undefined, "document"]) {
      // Selected from the Layout button or not, the sheet is drawn in the root's own wrapper with no node chrome.
      const html = await canvasHtml(controller, { selectedId });
      expect(html).toContain('<div class="datum-live-container" data-container-id="document" data-kind="pdf-document"><div class="datum-pdf-sheet">');
      expect(html).not.toMatch(/class="db-node[^"]*" data-component-id="document"/);
      expect(html).not.toContain('data-db-handle="document"');
      // A section inside it is an ordinary container node, hovered and selected as ever.
      expect(html).toContain(`class="db-node db-node--container" data-component-id="${sectionId}"`);
    }
  });

  it("carries the layout's name on the edited tree's document root, so the inspector's Layout name and the layout agree", async () => {
    const named: PdfGeneratedLayout = {
      id: "client",
      kind: "generated",
      name: "Client copy",
      root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: {}, children: { body: [], header: [], footer: [] } }
    };
    const designer = await createPdfDesigner({ formRoot: form(), layout: named });
    // The tree the inspector edits carries the name; the layout keeps it at its top level only,
    // so opening a layout hands back the catalog's layout as it was.
    expect(designer.builderOptions.initialRoot!.configuration).toEqual({ name: named.name });
    expect(designer.layout).toEqual(named);
    expect(designer.layoutFrom(designer.builderOptions.initialRoot!)).toEqual(named);
    const controller = new BuilderController(designer.builderOptions);
    expect(designer.layoutFrom(controller.snapshot()).name).toEqual(named.name);

    // Typed in the inspector's box, the name comes back as the layout's; blank is no name.
    controller.setProperty("document", "name", "Client-facing copy");
    expect(designer.layoutFrom(controller.snapshot())).toMatchObject({ id: "client", name: "Client-facing copy" });
    expect(designer.layoutFrom(controller.snapshot()).root.configuration).toEqual({});
    controller.setProperty("document", "name", "  ");
    expect(designer.layoutFrom(controller.snapshot()).name).toBeUndefined();

    // The derived layout's title is its name; a layout with no name leaves its root as it was.
    const derived = await createPdfDesigner({ formRoot: form() });
    expect(derived.layout.name).toBe("Customer Intake");
    expect(derived.builderOptions.initialRoot!.configuration).toEqual({ name: "Customer Intake" });
    const { name: _unnamed, ...nameless } = named;
    const plain = await createPdfDesigner({ formRoot: form(), layout: nameless });
    expect(plain.layout.root).toBe(nameless.root);
  });

  it("round-trips the layout's when: on the document root for the Rules tab, one copy at the top level in the layout", async () => {
    const quebec = { kind: "binary", operator: "eq", left: { kind: "path", path: "province" }, right: { kind: "literal", value: "QC" } } as const;
    const conditional: PdfGeneratedLayout = {
      id: "quebec",
      kind: "generated",
      name: "Quebec copy",
      when: quebec,
      root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: { page: { size: "A4" } }, children: { body: [], header: [], footer: [] } }
    };
    const designer = await createPdfDesigner({ formRoot: form(), layout: conditional });
    // The catalog's copy keeps its condition at the top level only; the edited tree carries it on the root.
    expect(designer.layout.when).toEqual(quebec);
    expect(designer.layout.root.configuration).toEqual({ page: { size: "A4" } });
    expect(designer.builderOptions.initialRoot!.configuration).toEqual({ page: { size: "A4" }, name: "Quebec copy", when: quebec });
    // Opened and handed back untouched, the layout is the one the catalog holds.
    expect(designer.layoutFrom(designer.builderOptions.initialRoot!)).toEqual(designer.layout);

    // An unrelated edit keeps the condition, and exactly one copy of it.
    const controller = new BuilderController(designer.builderOptions);
    controller.add(PDF_TEXT_COMPONENT_TYPE, "document", "body");
    const edited = designer.layoutFrom(controller.snapshot());
    expect(edited.when).toEqual(quebec);
    expect(edited.root.configuration).not.toHaveProperty("when");
    expect(edited.root.children?.body?.map((node) => node.type)).toEqual([PDF_TEXT_COMPONENT_TYPE]);

    // Edited on the root, it comes back as the layout's; cleared, the layout has none.
    const large = { kind: "path", path: "largePrint" } as const;
    controller.setProperty("document", "when", large);
    expect(designer.layoutFrom(controller.snapshot()).when).toEqual(large);
    // A when the evaluator cannot run is kept as written, for the author to see and mend.
    controller.setProperty("document", "when", "province is QC");
    expect(designer.layoutFrom(controller.snapshot()).when).toBe("province is QC");
    controller.setProperty("document", "when", undefined);
    expect(designer.layoutFrom(controller.snapshot())).not.toHaveProperty("when");

    // A `when` found on the root is never the layout's (the engine reads the top level only): dropped on open.
    const { when: _unconditional, ...plain } = conditional;
    const stray = await createPdfDesigner({ formRoot: form(), layout: { ...plain, root: { ...conditional.root, configuration: { when: quebec } } } });
    expect(stray.layout.root.configuration).toEqual({});
    expect(stray.layoutFrom(stray.builderOptions.initialRoot!)).not.toHaveProperty("when");
  });

  it("takes a palette click into the document's body when no parent or slot is named", async () => {
    // The toolbar's palette click is `requestAdd(type)` with nothing else: on a form that is
    // the root's `content`; a PDF document has no such slot, so its first — the body — takes it.
    const designer = await createPdfDesigner({ formRoot: form() });
    const controller = new BuilderController(designer.builderOptions);
    const before = controller.snapshot();
    const bodyBefore = before.children?.body?.length ?? 0;
    expect(controller.requestAdd(PDF_TEXT_COMPONENT_TYPE)).toBe(true);
    const snapshot = controller.snapshot();
    expect(snapshot.children?.body?.length).toBe(bodyBefore + 1);
    expect(snapshot.children?.body?.at(-1)?.type).toBe(PDF_TEXT_COMPONENT_TYPE);
    expect(snapshot.children?.header).toEqual(before.children?.header);
    expect(controller.dropError).toBeUndefined();
    expect(controller.selectedComponentId()).toBe(snapshot.children?.body?.at(-1)?.id);
  });

  it("shows an unbound field and an image without a source as placeholders", async () => {
    const designer = await createPdfDesigner({ formRoot: form() });
    const controller = new BuilderController(designer.builderOptions);
    controller.add(PDF_FIELD_COMPONENT_TYPE, "document", "body");
    controller.add("pdf-image", "document", "body");
    controller.add("pdf-page-break", "document", "body");
    const html = await canvasHtml(controller);
    expect(html).toContain("No form component chosen");
    expect(html).toContain("Image: no URL yet");
    expect(html).toContain('class="datum-pdf-break"');
  });

  it("shows a signature block as a boxed field with its caption, or a line to sign on", async () => {
    const designer = await createPdfDesigner({ formRoot: form() });
    const controller = new BuilderController(designer.builderOptions);
    controller.add("pdf-signature", "document", "body");
    // The derived layout already lists the form's fields; the new block is the last in the body.
    const body = controller.snapshot().children?.body ?? [];
    const id = body[body.length - 1]!.id;
    controller.setProperty(id, "fieldName", "server-signature");
    controller.setProperty(id, "label", "Certified by {{firstName}}");
    const boxed = await canvasHtml(controller);
    expect(boxed).toContain('class="datum-pdf-signature"');
    expect(boxed).toContain("Signature field");
    expect(boxed).toContain("server-signature");
    expect(boxed).toContain("Certified by");
    controller.setProperty(id, "mode", "line");
    const line = await canvasHtml(controller);
    expect(line).toContain("datum-pdf-signature--line");
    expect(line).toContain('class="datum-pdf-signature__rule"');
    // The layout inspector offers the signature policy on the document root.
    const root = (designer.builderOptions.componentDefinitions ?? []).find((definition) => definition.type === "pdf-document");
    const ids = (root?.propertyEditor?.fields ?? []).map((field) => field.propertyPath);
    expect(ids).toEqual(expect.arrayContaining(["signature.field", "signature.certify", "signature.reason", "signature.required", "signature.timestamp"]));
  });
});

describe("the PDF faces on the canvas", () => {
  it("draw the builder's words, English where its catalog says nothing", async () => {
    const designer = await createPdfDesigner({
      formRoot: form(),
      locale: "fr",
      textCatalog: {
        fr: {
          "pdfComponent.face.repeatNone": "Répéter : aucune collection",
          "pdfComponent.face.fieldNone": "Aucun composant choisi",
          "pdfComponent.face.pageBreak": "Saut de page"
        }
      },
      layout: {
        id: "x",
        kind: "generated",
        root: {
          id: "document",
          type: PDF_DOCUMENT_COMPONENT_TYPE,
          configuration: {},
          children: {
            body: [
              { id: "r", type: "pdf-repeat", configuration: {}, children: { row: [] } },
              { id: "f", type: PDF_FIELD_COMPONENT_TYPE, configuration: {} },
              { id: "b", type: "pdf-page-break", configuration: {} }
            ],
            header: [],
            footer: []
          }
        }
      }
    });
    const html = await canvasHtml(new BuilderController(designer.builderOptions));
    expect(html).toContain("Répéter : aucune collection");
    expect(html).toContain("Aucun composant choisi");
    expect(html).toContain("Saut de page");
    // Untranslated: the header band's own label.
    expect(html).toContain('<span class="datum-pdf-page__band-label">header</span>');
  });

  it("put each face in the renderer's container wrapper or field wrapper, and write none of the DOM contract themselves", async () => {
    const designer = await createPdfDesigner({
      formRoot: form(),
      values: { firstName: "Ada" },
      layout: {
        id: "x",
        kind: "generated",
        root: {
          id: "document",
          type: PDF_DOCUMENT_COMPONENT_TYPE,
          configuration: {},
          children: {
            body: [
              { id: "s", type: PDF_SECTION_COMPONENT_TYPE, configuration: { label: "About" }, children: { content: [{ id: "f", type: PDF_FIELD_COMPONENT_TYPE, configuration: { componentId: "firstName" } }] } }
            ],
            header: [],
            footer: []
          }
        }
      }
    });
    const canvas = await mountDesignerCanvas(new BuilderController(designer.builderOptions));
    const root = canvas.root;
    expect(root.querySelectorAll('[data-container-id="s"]')).toHaveLength(1);
    expect(root.querySelector('[data-container-id="s"] > .datum-pdf-section > .datum-pdf-section__heading')?.textContent).toBe("About");
    // The pdf-field is the layout node; the bound component's picture inside it carries no id of the form's.
    expect(root.querySelectorAll('[data-component-id="f"]')).toHaveLength(1);
    expect(root.querySelector('[data-component-id="firstName"]')).toBeNull();
    expect(canvas.live.unsupported()).toEqual([]);
    expect(canvas.live.adapterOf("f")).toMatchObject({ from: "binding", name: "pdf-field" });
    canvas.unmount();
  });
});

describe("a generated layout bound to a removed collection or component", () => {
  async function canvas(body: ComponentNode[]): Promise<string> {
    const designer = await createPdfDesigner({
      formRoot: { id: "root", type: "form", configuration: { title: "T" }, children: { content: [{ id: "name", type: "text", configuration: { label: "name" } }] } },
      layout: { id: "x", kind: "generated", root: { id: "document", type: "pdf-document", configuration: {}, children: { body, header: [], footer: [] } } }
    });
    return canvasHtml(new BuilderController(designer.builderOptions));
  }

  it("a pdf-field naming a removed component says so", async () => {
    expect(await canvas([{ id: "f", type: "pdf-field", configuration: { componentId: "gone" } }])).toContain("not in the form");
  });

  it("a pdf-repeat over a removed collection is marked unbound", async () => {
    const html = await canvas([{ id: "r", type: "pdf-repeat", configuration: { collectionPath: "gone" }, children: { row: [] } }]);
    expect(html).toContain("Repeats for each");
    expect(html).toContain("not a repeating section of the form");
    expect(html).toContain("datum-pdf-field__chip--unbound");
  });

  it("a pdf-table over a removed collection is marked unbound", async () => {
    const html = await canvas([{ id: "t", type: "pdf-table", configuration: { rows: 1, columns: 1, header: false, borders: "all", collectionPath: "gone" }, children: {} }]);
    expect(html).toContain("Rows repeat from");
    expect(html).toContain("not a repeating section of the form");
    expect(html).toContain("datum-pdf-table__caption--unbound");
  });

  it("a repeat over a collection the form holds is not marked", async () => {
    const designer = await createPdfDesigner({
      formRoot: { id: "root", type: "form", configuration: { title: "T" }, children: { content: [{ id: "lines", type: "repeatingSection", configuration: { label: "Lines" }, collection: { collectionPath: "lines" }, children: { content: [] } }] } },
      layout: { id: "x", kind: "generated", root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "r", type: "pdf-repeat", configuration: { collectionPath: "lines" }, children: { row: [] } }], header: [], footer: [] } } }
    });
    const html = await canvasHtml(new BuilderController(designer.builderOptions));
    expect(html).toContain("Repeats for each");
    expect(html).not.toContain("not a repeating section of the form");
  });
});

// --- the PDF mode's seams for the browser-assistant tools ---------------
//
// What `documents { map_fields, create_form_fields, preview_pdf }` and the outside journal call
// on the PDF mode: each is the person's own path with a way to report or to mark the writes, and
// the person's buttons go through the same bodies as before.

const MODE_FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Claim" },
  children: {
    content: [
      { id: "firstName", type: "text", configuration: { label: "First name" } },
      { id: "email", type: "text", configuration: { label: "Email" } },
      { id: "submit", type: "button", configuration: { label: "Send" } }
    ]
  }
};

const MODE_TEMPLATE = { storage: "base64", name: "claim.pdf", type: "application/pdf", size: 3, data: "AAA=" } as const;

const MODE_INSPECTION: PdfTemplateInfo = {
  pageCount: 1,
  pages: [{ index: 1, width: 612, height: 792 }],
  fields: [
    { name: "firstName", kind: "text", page: 1, rect: { x: 10, y: 700, width: 200, height: 20 }, readOnly: false, required: false },
    { name: "email", kind: "text", page: 1, rect: { x: 10, y: 660, width: 200, height: 20 }, readOnly: false, required: false },
    { name: "Phone Number", kind: "text", page: 1, rect: { x: 10, y: 620, width: 200, height: 20 }, readOnly: false, required: false }
  ],
  hasXfa: false,
  encrypted: false
};

function modeLayout(id: string, name: string): PdfGeneratedLayout {
  return { id, kind: "generated", name, root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } } };
}

function templateLayout(): PdfTemplateLayout {
  return { id: "paper", kind: "template", name: "Paper", template: MODE_TEMPLATE, fields: [] };
}

/** A runtime as the renderers read one: the form, the sample answers, and the layouts the mode holds. */
function modeRuntime(pdf: () => PdfConfiguration | undefined): RenderableRuntime {
  const state: FormState = {
    values: { firstName: "Ada" },
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale: "en"
  };
  return {
    formRoot: () => MODE_FORM,
    state: () => state,
    errors: () => [],
    effectiveStatesMap: () => new Map(),
    requiredMap: () => new Map(),
    componentTree: () => new ComponentTree(MODE_FORM),
    resolveDataSource: async () => undefined,
    pdfConfiguration: pdf
  };
}

/** A kernel stand-in: renders and fills report a warning in kernel words, inspects the template it is given. */
function modeProvider(inspect: () => Promise<PdfTemplateInfo> = async () => MODE_INSPECTION): PdfRenderProvider & { requests: unknown[] } {
  const requests: unknown[] = [];
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  return {
    id: "fake",
    abiVersion: "1.0.0",
    requests,
    render: async (request: unknown) => {
      requests.push(request);
      return { bytes, pageCount: 2, pages: [], warnings: [{ code: "font.fallback_standard14", message: "Helvetica stood in for Kernel Sans", componentId: "firstName" }], providerId: "fake" };
    },
    fill: async (request: unknown) => {
      requests.push(request);
      return {
        bytes,
        pageCount: 1,
        pages: [],
        warnings: [],
        providerId: "fake",
        fields: [
          { pdfField: "firstName", status: "filled" },
          { pdfField: "email", status: "cleared", message: "kernel words" }
        ]
      };
    },
    inspect: async () => inspect()
  } as unknown as PdfRenderProvider & { requests: unknown[] };
}

const untilTrue = async (check: () => unknown): Promise<void> => {
  for (let tries = 0; tries < 400 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBeTruthy();
};

/** The mode on a shell's page: its overlays in the shell's root, as the shell mounts them, and activated. */
async function modeOnPage(options: Partial<PdfBuilderModeOptions> & { pdf: PdfConfiguration; provider?: PdfRenderProvider }, activate: "await" | "start" = "await") {
  const { provider = modeProvider(), ...rest } = options;
  let mode: PdfBuilderMode | undefined;
  const runtime = modeRuntime(() => mode?.pdfConfiguration);
  mode = createPdfBuilderMode({ formRoot: () => structuredClone(MODE_FORM), runtime: () => runtime, support: { provider }, locale: () => "en", ...rest });
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.append(...(mode.overlays ?? []));
  const context = { host, root, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) };
  const activated = mode.activate!(context);
  if (activate === "await") {
    await activated;
  }
  return { mode, context, runtime, activated, dialog: (mode.overlays ?? [])[0] as HTMLDialogElement };
}

/**
 * A browser's dialog methods, which jsdom 25 lacks: `show()` and `showModal()` open the dialog and
 * run the focusing steps (focus moves to its first control), `close()` closes it and fires
 * `close`. Without them every test takes the `open`-attribute stand-in and focus never moves.
 */
function browserDialogMethods() {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  const opening = function (this: HTMLDialogElement): void {
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>("button, a[href], input, select, textarea")?.focus();
  };
  const show = vi.fn(opening);
  const showModal = vi.fn(opening);
  const close = vi.fn(function (this: HTMLDialogElement): void {
    if (this.hasAttribute("open")) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    }
  });
  for (const [name, value] of Object.entries({ show, showModal, close })) {
    Object.defineProperty(proto, name, { value, configurable: true, writable: true });
  }
  return {
    show,
    showModal,
    close,
    restore: (): void => {
      for (const name of ["show", "showModal", "close"]) {
        delete proto[name];
      }
    }
  };
}

/** The focus events an element hears, in order. */
function focusEventsOf(element: HTMLElement): string[] {
  const heard: string[] = [];
  for (const type of ["blur", "focusout", "focus", "focusin", "change"]) {
    element.addEventListener(type, () => heard.push(type));
  }
  return heard;
}

/** How many steps a controller's history holds: undone one by one. */
function stepsOf(controller: BuilderController): number {
  let steps = 0;
  while (controller.canUndo()) {
    controller.undo();
    steps += 1;
  }
  return steps;
}

describe("previewReport: the preview dialog, reported", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders the layout named, shows it in the dialog, and reports the facts without the file or any kernel words", async () => {
    const { mode, dialog } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary"), modeLayout("b", "Full")], defaultLayoutId: "a" } });
    await untilTrue(() => mode.ready);
    const report = await mode.previewReport({ layoutId: "b" });
    expect(report).toMatchObject({ layoutId: "b", layoutChoice: "given", layoutKind: "generated", pageCount: 2 });
    if ("error" in report) {
      throw new Error(report.error);
    }
    expect(report.warnings).toContainEqual({ code: "font.fallback_standard14", componentId: "firstName" });
    for (const warning of report.warnings) {
      expect(Object.keys(warning).every((key) => key === "code" || key === "componentId")).toBe(true);
    }
    expect(JSON.stringify(report)).not.toContain("Helvetica");
    expect(Object.keys(report).sort()).toEqual(["layoutChoice", "layoutId", "layoutKind", "pageCount", "warnings"]);
    // The dialog still shows, as for the person: the layout's name, its pages, its warnings.
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.querySelector("h2")?.textContent).toContain("Full");
    expect(dialog.querySelectorAll("[data-preview-page]")).toHaveLength(2);
  });

  it("lets the answers choose when no layout is named, as a download that names none", async () => {
    const { mode } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary"), modeLayout("b", "Full")], defaultLayoutId: "b" } });
    const report = await mode.previewReport();
    expect(report).toMatchObject({ layoutId: "b", layoutKind: "generated" });
    expect((report as { layoutChoice: string }).layoutChoice).not.toBe("given");
  });

  it("reports a populated form's fields filled and left empty, never the kernel's message", async () => {
    const { mode } = await modeOnPage({ pdf: { layouts: [templateLayout()] } });
    await untilTrue(() => mode.templateInspection !== undefined);
    const report = await mode.previewReport({ layoutId: "paper" });
    expect(report).toMatchObject({ layoutId: "paper", layoutKind: "template", fields: { filled: 1, empty: 1 } });
    expect(JSON.stringify(report)).not.toContain("kernel words");
  });

  it("is the body the person's Preview PDF runs, one preview at a time", async () => {
    const { mode, dialog } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary"), modeLayout("b", "Full")], defaultLayoutId: "a" } });
    await untilTrue(() => mode.ready);
    const render = vi.spyOn(mode, "renderPdf");
    await mode.previewPdf();
    expect(render).toHaveBeenLastCalledWith({ runtime: undefined, byAnswers: false });
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.querySelector("h2")?.textContent).toContain("Summary");

    await mode.previewReport({ layoutId: "b" });
    expect(render).toHaveBeenLastCalledWith({ runtime: undefined, byAnswers: false, layoutId: "b" });

    // A second one while the first renders is refused at once, for the person and the assistant alike.
    const first = mode.previewPdf();
    expect(await mode.previewReport()).toEqual({ error: expect.any(String), busy: true });
    await first;
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("renders over the runtime it is handed (Try it's answers, or the host's)", async () => {
    const { mode } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary")] } });
    const tried = modeRuntime(() => undefined);
    const render = vi.spyOn(mode, "renderPdf");
    await mode.previewReport({ layoutId: "a", runtime: tried });
    expect(render.mock.calls[0]![0]).toMatchObject({ layoutId: "a", runtime: tried });
  });

  it("takes no focus while the person's focus is in a field, and opens without making the page inert", async () => {
    const { mode, dialog } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary")] } });
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    await mode.previewReport({ layoutId: "a" });
    expect(document.activeElement).toBe(field);
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.hasAttribute("data-preview-quiet")).toBe(true);
    // Placed over the shell's own box (modal-place.ts) rather than in the flow of the shadow root.
    expect(mode.styles).toContain("dialog.dpd[data-preview-quiet] { position: fixed; inset: var(--db-modal-inset, 0px); z-index: var(--db-z-popover); }");
  });

  it("closes a quiet preview when the person's own Preview runs, so theirs opens modal over an inert page", async () => {
    // A browser's dialog methods: without them the `open` attribute stands in for showModal()
    // either way, and a quiet dialog left open would pass for a modal one.
    const browser = browserDialogMethods();
    try {
      const { mode, dialog } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary")] } });
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const field = document.createElement("input");
      document.body.append(field);
      field.focus();
      await mode.previewReport({ layoutId: "a" });
      expect(dialog.hasAttribute("open")).toBe(true);
      expect(dialog.hasAttribute("data-preview-quiet")).toBe(true);
      expect(browser.show).not.toHaveBeenCalled();
      expect(browser.showModal).not.toHaveBeenCalled();
      browser.close.mockClear();

      await mode.previewPdf();
      // Closed first (the chunk's openDialog leaves an open dialog as it is), then shown modal.
      expect(browser.close).toHaveBeenCalledTimes(1);
      expect(browser.close.mock.contexts[0]).toBe(dialog);
      expect(browser.showModal).toHaveBeenCalledTimes(1);
      expect(browser.showModal.mock.contexts[0]).toBe(dialog);
      expect(browser.close.mock.invocationCallOrder[0]!).toBeLessThan(browser.showModal.mock.invocationCallOrder[0]!);
      expect(browser.show).not.toHaveBeenCalled();
      expect(dialog.hasAttribute("data-preview-quiet")).toBe(false);
      expect(dialog.hasAttribute("open")).toBe(true);
      // The person's preview takes focus, as a modal dialog does (inside the shell's shadow root).
      expect(dialog.contains((dialog.getRootNode() as ShadowRoot).activeElement)).toBe(true);
    } finally {
      browser.restore();
    }
  });

  it("takes no focus while the page itself lacks focus (the browser's assistant panel has it)", async () => {
    const { mode, dialog } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary")] } });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await mode.previewReport({ layoutId: "a" });
    expect(dialog.hasAttribute("data-preview-quiet")).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(false);
  });

  it("opens as the person's does when nothing on a focused page holds focus", async () => {
    const { mode, dialog } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary")] } });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    (document.activeElement as HTMLElement | null)?.blur();
    await mode.previewReport({ layoutId: "a" });
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.hasAttribute("data-preview-quiet")).toBe(false);
  });

  it("never runs a browser's dialog focusing steps on the quiet path: the person's field hears no blur", async () => {
    const browser = browserDialogMethods();
    try {
      const { mode, dialog } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary")] } });
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      // A preview the person opened and closed leaves its buttons in the dialog for show() to focus.
      (document.activeElement as HTMLElement | null)?.blur();
      await mode.previewPdf();
      expect(browser.showModal).toHaveBeenCalledTimes(1);
      dialog.querySelector<HTMLElement>('[data-action="close"]')!.click();
      expect(dialog.hasAttribute("open")).toBe(false);
      browser.show.mockClear();
      browser.showModal.mockClear();

      const field = document.createElement("input");
      document.body.append(field);
      field.focus();
      field.value = "half typed";
      const heard = focusEventsOf(field);
      await mode.previewReport({ layoutId: "a" });
      expect(dialog.hasAttribute("open")).toBe(true);
      expect(dialog.hasAttribute("data-preview-quiet")).toBe(true);
      // Again with the dialog open: the content is replaced, the dialog left as it is.
      await mode.previewReport({ layoutId: "a" });
      expect(browser.show).not.toHaveBeenCalled();
      expect(browser.showModal).not.toHaveBeenCalled();
      expect(heard).toEqual([]);
      expect(document.activeElement).toBe(field);

      // Closed by the person, it is an ordinary dialog again.
      dialog.querySelector<HTMLElement>('[data-action="close"]')!.click();
      expect(dialog.hasAttribute("data-preview-quiet")).toBe(false);
    } finally {
      browser.restore();
    }
  });

  it("opens quietly inside an inert shell (an assistant session), so it never covers the banner's Stop", async () => {
    const browser = browserDialogMethods();
    try {
      const { mode, dialog, context } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary")] } });
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      // The person clicked the greyed-out shell: focus fell to the body, the page kept it.
      (document.activeElement as HTMLElement | null)?.blur();
      context.host.setAttribute("inert", "");
      await mode.previewReport({ layoutId: "a" });
      expect(browser.showModal).not.toHaveBeenCalled();
      expect(dialog.hasAttribute("open")).toBe(true);
      expect(dialog.hasAttribute("data-preview-quiet")).toBe(true);
    } finally {
      browser.restore();
    }
  });

  it("refilling a preview Try it opened sends focus back to Try it when it closes", async () => {
    const { mode, dialog, context } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary")] } });
    const canvas = document.createElement("datum-builder-canvas");
    context.root.append(canvas);
    const tryButton = document.createElement("button");
    tryButton.setAttribute("data-try-pdf", "");
    canvas.attachShadow({ mode: "open" }).append(tryButton);
    await mode.tryIt!.pdf!.preview(modeRuntime(() => undefined), { workspace: "pdf", root: context.root });
    expect(dialog.hasAttribute("open")).toBe(true);
    await mode.previewReport({ layoutId: "a" });
    dialog.querySelector<HTMLElement>('[data-action="close"]')!.click();
    expect(canvas.shadowRoot!.activeElement).toBe(tryButton);
  });

  it("puts the dialog in the shell's root it is given when the mode is not on the page, and refuses when it has nowhere to show", async () => {
    let mode: PdfBuilderMode | undefined;
    const runtime = modeRuntime(() => mode?.pdfConfiguration);
    mode = createPdfBuilderMode({ formRoot: () => MODE_FORM, runtime: () => runtime, support: { provider: modeProvider() }, pdf: { layouts: [modeLayout("a", "Summary")] } });
    const dialog = (mode.overlays ?? [])[0] as HTMLDialogElement;
    const nowhere = await mode.previewReport({ layoutId: "a" });
    expect(nowhere).toEqual({ error: expect.any(String) });
    expect(dialog.hasAttribute("open")).toBe(false);

    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const report = await mode.previewReport({ layoutId: "a", root });
    expect(report).toMatchObject({ layoutId: "a" });
    expect(dialog.getRootNode()).toBe(root);
    expect(root.querySelector('style[data-mode-style="pdf-preview"]')).not.toBeNull();
  });

  it("reports a render that failed, and the dialog says so", async () => {
    const failing = { ...modeProvider(), render: async () => Promise.reject(new Error("kernel exploded")) } as unknown as PdfRenderProvider;
    const { mode, dialog } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary")] }, provider: failing });
    const report = await mode.previewReport({ layoutId: "a" });
    expect(report).toEqual({ error: expect.stringContaining("kernel exploded") });
    expect(dialog.querySelector("[data-preview-error]")).not.toBeNull();
  });
});

describe("suggestMappings and createFormFields for the assistant", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  async function templateOnPage(form: BuilderController | undefined, inspect?: () => Promise<PdfTemplateInfo>) {
    const opened = await modeOnPage({
      pdf: { layouts: [templateLayout()] },
      ...(form ? { form: () => form, formRoot: () => structuredClone(form.snapshot()) } : {}),
      ...(inspect ? { provider: modeProvider(inspect) } : {})
    });
    await untilTrue(() => opened.mode.templateInspection !== undefined && (opened.mode.controller.snapshot().children?.widgets?.length ?? 0) === 3);
    const paper = (): PdfTemplateLayout => opened.mode.layouts.find((layout) => layout.id === "paper") as PdfTemplateLayout;
    return { ...opened, paper };
  }

  it("lands every suggested mapping as one layout step with batch, through around once", async () => {
    const { mode, paper } = await templateOnPage(undefined);
    expect(mode.controller.canUndo()).toBe(false);
    const around = vi.fn((step: () => void) => step());
    expect(mode.suggestMappings({ batch: true, around })).toBe(2);
    expect(around).toHaveBeenCalledTimes(1);
    expect(paper().fields.map((field) => field.pdfField).sort()).toEqual(["email", "firstName"]);
    expect(stepsOf(mode.controller)).toBe(1);
    expect(paper().fields).toEqual([]);
  });

  it("keeps the person's button at one step per mapping", async () => {
    const { mode, paper } = await templateOnPage(undefined);
    const button = (mode.barActions ?? []).find((element) => element.hasAttribute("data-suggest-mappings")) as HTMLButtonElement;
    expect(button.hidden).toBe(false);
    button.click();
    expect(paper().fields).toHaveLength(2);
    expect(stepsOf(mode.controller)).toBe(2);
  });

  it("keeps a checkbox's mapping and its checked value one step: one Undo takes the guess back whole", async () => {
    const withAgree: ComponentNode = {
      ...MODE_FORM,
      children: { content: [...MODE_FORM.children!["content"]!, { id: "agree", type: "checkbox", configuration: { label: "I agree" } }] }
    };
    const form = new BuilderController({ initialRoot: structuredClone(withAgree) });
    const inspection: PdfTemplateInfo = {
      ...MODE_INSPECTION,
      fields: [
        ...MODE_INSPECTION.fields.slice(0, 2),
        { name: "agree", kind: "checkbox", page: 1, rect: { x: 10, y: 620, width: 14, height: 14 }, exportValues: ["Yes"], readOnly: false, required: false }
      ]
    };
    const { mode, paper } = await templateOnPage(form, async () => inspection);
    expect(mode.suggestMappings()).toBe(3);
    expect(paper().fields.find((field) => field.pdfField === "agree")).toMatchObject({ source: { kind: "component", componentId: "agree" }, checkedValue: "Yes" });
    mode.controller.undo();
    // The last guess, the checkbox's, is gone whole: no mapping left without its checked value.
    expect(paper().fields.find((field) => field.pdfField === "agree")).toBeUndefined();
    expect(stepsOf(mode.controller)).toBe(2);
  });

  it("runs the form's insert and the layout's write through around, each whole, and nothing across the waits", async () => {
    const form = new BuilderController({ initialRoot: structuredClone(MODE_FORM) });
    const { mode, paper } = await templateOnPage(form);
    let inside = false;
    const changes: string[] = [];
    form.on("change", (event) => changes.push(`form:${event.reason}:${inside}`));
    mode.controller.on("change", (event) => changes.push(`layout:${event.reason}:${inside}`));
    const around = vi.fn((step: () => void) => {
      inside = true;
      try {
        // Each step is synchronous: nothing it runs waits.
        expect(step()).toBeUndefined();
      } finally {
        inside = false;
      }
    });
    const result = await mode.createFormFields({ around });
    expect(result).toMatchObject({ mapped: 3, matched: 2 });
    expect(result.added).toHaveLength(1);
    expect(result.errorCode).toBeUndefined();
    expect(around).toHaveBeenCalledTimes(2);
    // The form's insert and the layout's mappings landed inside around; whatever else changed
    // between them (the pickers refreshed under the layout) is no edit.
    expect(changes).toContain("form:add:true");
    expect(changes).toContain("layout:edit:true");
    expect(changes.filter((change) => change.endsWith(":false")).every((change) => !/:(add|edit):/.test(change))).toBe(true);
    expect(paper().fields).toHaveLength(3);
    // One step each side, as for the person.
    expect(stepsOf(mode.controller)).toBe(1);
    expect(stepsOf(form)).toBe(1);
  });

  it("says which refusal it gave in errorCode, beside the words", async () => {
    // No form to add to.
    const noForm = await templateOnPage(undefined);
    expect(await noForm.mode.createFormFields()).toMatchObject({ errorCode: "no-form", error: expect.any(String) });

    // The form's selection holds unsaved edits.
    const form = new BuilderController({ initialRoot: structuredClone(MODE_FORM) });
    const page = await templateOnPage(form);
    form.select("email");
    form.setDraftProperty("email", "label", "E-mail");
    expect(await page.mode.createFormFields()).toMatchObject({ errorCode: "form-unsaved" });
    form.discardDraft("email");

    // The layout's own selection holds unsaved edits.
    const widget = page.mode.controller.snapshot().children!.widgets![0]!.id;
    page.mode.controller.select(widget);
    page.mode.controller.setDraftProperty(widget, "required", true);
    expect(await page.mode.createFormFields()).toMatchObject({ errorCode: "layout-unsaved" });
    page.mode.controller.discardDraft(widget);

    // The form held the insert for a prompt: let go with "stay".
    const insert = form.requestInsertComponents;
    const stay = vi.spyOn(form, "answerUnsavedChangesPrompt");
    form.requestInsertComponents = () => false;
    expect(await page.mode.createFormFields()).toMatchObject({ errorCode: "holding" });
    expect(stay).toHaveBeenCalledWith("stay");

    // The insert ran and was refused.
    form.requestInsertComponents = (_entries, options) => {
      options?.onResult?.({ ok: false, ids: [], error: "an id is taken" });
      return true;
    };
    expect(await page.mode.createFormFields()).toMatchObject({ errorCode: "refused", error: expect.stringContaining("an id is taken") });
    form.requestInsertComponents = insert;
  });
});

describe("applyCatalogForAgent, openState and whenOpenReady", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("applies a catalog the way the mode's own actions do, keeping the open designer's undo history", async () => {
    const changes: string[] = [];
    const { mode } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary"), modeLayout("b", "Full")], defaultLayoutId: "a" }, onChange: (detail) => changes.push(`${detail.reason}:${detail.layout.id}`) });
    await untilTrue(() => mode.ready);
    const controller = mode.controller;
    controller.add("pdf-text", "document", "body");
    expect(controller.canUndo()).toBe(true);
    const [a, b] = mode.layouts;
    mode.applyCatalogForAgent({ ...mode.pdfConfiguration, layouts: [b!, a!] }, "b");
    expect(mode.layouts.map((layout) => layout.id)).toEqual(["b", "a"]);
    expect(mode.layoutId).toBe("a");
    expect(mode.controller).toBe(controller);
    expect(controller.canUndo()).toBe(true);
    expect(changes.at(-1)).toBe("layouts:b");

    // The public setter, by contrast, starts every designer over.
    mode.pdfConfiguration = { ...mode.pdfConfiguration, layouts: [a!, b!] };
    expect(mode.controller).not.toBe(controller);
  });

  it("puts a removed layout back at its place with its default, exactly", async () => {
    const { mode } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary"), modeLayout("b", "Full"), modeLayout("c", "Short")], defaultLayoutId: "b" } });
    await untilTrue(() => mode.ready);
    const before = structuredClone(mode.pdfConfiguration);
    mode.removeLayout("b");
    expect(mode.layouts.map((layout) => layout.id)).toEqual(["a", "c"]);
    mode.applyCatalogForAgent(before, "b");
    expect(JSON.stringify(mode.pdfConfiguration)).toBe(JSON.stringify(before));
    expect(() => mode.applyCatalogForAgent(before, "nope")).toThrow();
  });

  it("answers loading past its time while the template is being read, and ready once it is", async () => {
    let release!: (info: PdfTemplateInfo) => void;
    const reading = new Promise<PdfTemplateInfo>((resolve) => (release = resolve));
    const { mode } = await modeOnPage({ pdf: { layouts: [templateLayout()] }, provider: modeProvider(() => reading) }, "start");
    expect(await mode.whenOpenReady(40)).toBe("loading");
    expect(mode.openState()).toMatchObject({ id: "paper" });
    expect(mode.openState().template).toBeUndefined();
    release(MODE_INSPECTION);
    expect(await mode.whenOpenReady(2000)).toBe("ready");
    expect(mode.openState()).toEqual({ id: "paper", ready: true, template: { fields: 3 } });
    // Ready answers at once.
    expect(await mode.whenOpenReady(0)).toBe("ready");
  });

  it("answers failed when the template cannot be read, after trying the read again", async () => {
    let reads = 0;
    const { mode } = await modeOnPage({
      pdf: { layouts: [templateLayout()] },
      provider: modeProvider(async () => {
        reads += 1;
        throw new Error("not a PDF");
      })
    });
    await untilTrue(() => mode.ready);
    const before = reads;
    expect(await mode.whenOpenReady(2000)).toBe("failed");
    expect(reads).toBe(before + 1);
    expect(mode.openState()).toEqual({ id: "paper", ready: true });
  });

  it("waits for a read already under way rather than starting another, and answers failed only once that read has failed", async () => {
    let reads = 0;
    let fail!: (error: Error) => void;
    const provider = modeProvider(() => {
      reads += 1;
      return new Promise<PdfTemplateInfo>((_resolve, reject) => (fail = reject));
    });
    const { mode } = await modeOnPage({ pdf: { layouts: [templateLayout()] }, provider }, "start");
    await untilTrue(() => reads === 1);
    expect(await mode.whenOpenReady(40)).toBe("loading");
    let answer: string | undefined;
    const waiting = mode.whenOpenReady(2000).then((state) => (answer = state));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(answer).toBeUndefined();
    fail(new Error("not a PDF"));
    await waiting;
    expect(answer).toBe("failed");
    // Neither call started a second read of the same PDF.
    expect(reads).toBe(1);
  });

  it("answers loading when the person opens another layout while it waits, so the call is made again", async () => {
    let reads = 0;
    const provider = modeProvider(() => {
      reads += 1;
      return new Promise<PdfTemplateInfo>(() => undefined);
    });
    const { mode } = await modeOnPage({ pdf: { layouts: [templateLayout(), modeLayout("a", "Summary")], defaultLayoutId: "paper" }, provider }, "start");
    await untilTrue(() => reads === 1);
    expect(mode.layoutId).toBe("paper");
    const started = Date.now();
    const waiting = mode.whenOpenReady(2000);
    await mode.selectLayout("a");
    expect(mode.ready).toBe(true);
    // The generated layout now on the page is up, but it is not the one the call was about.
    expect(await waiting).toBe("loading");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("leaves no timer behind once the layout it opened has settled", async () => {
    const { mode } = await modeOnPage({
      pdf: { layouts: [templateLayout()] },
      provider: modeProvider(async () => {
        throw new Error("not a PDF");
      })
    });
    await untilTrue(() => mode.ready);
    const set = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    expect(await mode.whenOpenReady(5000)).toBe("failed");
    const deadlines = set.mock.calls.flatMap((call, index) => ((call[1] ?? 0) > 1000 ? [set.mock.results[index]!.value as unknown] : []));
    expect(deadlines.length).toBeGreaterThan(0);
    for (const handle of deadlines) {
      expect(cleared.mock.calls.some(([candidate]) => candidate === handle)).toBe(true);
    }
  });

  it("answers failed, not loading past its time, when a custom layout's designer cannot be built", async () => {
    const { mode } = await modeOnPage(
      {
        pdf: { layouts: [modeLayout("a", "Summary")] },
        pdfThemes: () => {
          throw new Error("themes broke");
        }
      },
      "start"
    );
    const started = Date.now();
    expect(await mode.whenOpenReady(1500)).toBe("failed");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(mode.openState()).toEqual({ id: "a", ready: false });
  });

  it("answers failed, not loading past its time, when a populated form's designer cannot be built after its read", async () => {
    let release: ((info: PdfTemplateInfo) => void) | undefined;
    let broken = false;
    const provider = modeProvider(() => new Promise<PdfTemplateInfo>((resolve) => (release = resolve)));
    const { mode, activated } = await modeOnPage(
      {
        pdf: { layouts: [templateLayout()] },
        provider,
        // Answers the read; then the host's template list throws, past the read's own catch.
        templates: () => {
          if (broken) {
            throw new Error("templates broke");
          }
          return undefined;
        }
      },
      "start"
    );
    const refused = Promise.resolve(activated).then(
      () => undefined,
      (error: unknown) => error
    );
    await untilTrue(() => release !== undefined);
    // Asked while the build is under way: it waits for that build rather than starting another.
    const started = Date.now();
    const waiting = mode.whenOpenReady(1500);
    broken = true;
    release!(MODE_INSPECTION);
    expect(await waiting).toBe("failed");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await refused).toBeInstanceOf(Error);
  });

  it("hands a populated form's own PDF over as read, and a hosted file it attaches from the host's resolver", async () => {
    const provider = modeProvider();
    const { mode } = await modeOnPage({
      pdf: { layouts: [templateLayout()] },
      provider,
      templates: () => ({
        resolve: async (source) => (source.storage === "s3" ? new Uint8Array([9, 9, 9]) : BASE64_TEMPLATE_RESOLVER.resolve(source))
      })
    });
    await untilTrue(() => mode.ready);
    const withUpload: ComponentNode = {
      ...MODE_FORM,
      children: { content: [...MODE_FORM.children!["content"]!, { id: "doc", type: "file", configuration: { label: "Document", pdf: { attach: true } } }] }
    };
    const base = modeRuntime(() => undefined);
    const hosted = { storage: "s3", name: "big.zip", type: "application/zip", size: 3, ref: { key: "uploads/big.zip" } };
    const runtime: RenderableRuntime = {
      ...base,
      formRoot: () => withUpload,
      componentTree: () => new ComponentTree(withUpload),
      state: () => ({ ...base.state(), values: { firstName: "Ada", doc: hosted } })
    };
    await mode.renderPdf({ layoutId: "paper", runtime });
    const fill = provider.requests.at(-1) as { template: { data: string }; attachments?: Array<{ name: string; data: string }> };
    expect(fill.template).toEqual({ data: "AAA=" });
    expect(fill.attachments?.map((attachment) => [attachment.name, attachment.data])).toEqual([["big.zip", "CQkJ"]]);
  });

  it("answers failed at once for a populated form when no PDF executor is assigned, and reads it once one is", async () => {
    const { mode } = await modeOnPage({ pdf: { layouts: [templateLayout()] }, support: undefined });
    await untilTrue(() => mode.ready);
    const started = Date.now();
    expect(await mode.whenOpenReady(2000)).toBe("failed");
    expect(Date.now() - started).toBeLessThan(1000);

    mode.support = { provider: modeProvider() };
    expect(await mode.whenOpenReady(2000)).toBe("ready");
    expect(mode.openState()).toEqual({ id: "paper", ready: true, template: { fields: 3 } });
  });

  it("answers ready for a custom layout once its designer is up, and with no layout at all", async () => {
    const { mode } = await modeOnPage({ pdf: { layouts: [modeLayout("a", "Summary")] } }, "start");
    expect(await mode.whenOpenReady(2000)).toBe("ready");
    expect(mode.openState()).toEqual({ id: "a", ready: true });

    const empty = await modeOnPage({ pdf: { layouts: [] } });
    expect(empty.mode.openState()).toEqual({ ready: false });
    expect(await empty.mode.whenOpenReady(10)).toBe("ready");
  });
});
