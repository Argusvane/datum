import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumPdfLayoutChangeDetail, DatumFormBuilderElement, DatumPdfLayoutSelectDetail } from "../src/builder.js";
import { createAddPopover, MAX_PDF_TEMPLATE_BYTES } from "@argusvane/datum-engine/builder";
import { createPdfTemplateResolver, type PdfGeneratedLayout, type PdfRenderProvider, type PdfTemplateLayout } from "@argusvane/datum-engine";

import { sampleDefinition, until, pdfAlone } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(setup?: (element: DatumFormBuilderElement) => void): DatumFormBuilderElement {
  const element = pdfAlone();
  setup?.(element);
  document.body.append(element);
  return element;
}

/** Waits for the PDF side to be up over a custom layout, with the PDF palette on the panels. */
async function ready(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.pdfMode!.ready && element.pdfMode?.controller.componentTypes().some((entry) => entry.type === "pdf-field"));
}

/** Waits for the PDF side of a form with no layout: its empty state on the canvas. */
async function readyEmpty(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas")?.shadowRoot?.querySelector("[data-canvas-surface] [data-pdf-empty]"));
}

/** The engine builder's shadow root: the bar, the tabs and the PDF side's dialogs live there. */
function shell(element: DatumFormBuilderElement): ShadowRoot {
  return element.builder!.shadowRoot!;
}

function canvasShadow(element: DatumFormBuilderElement): ShadowRoot | undefined {
  const canvas = shell(element).querySelector("datum-builder-canvas") as (HTMLElement & { previewRoot(): ShadowRoot | undefined }) | null;
  return canvas?.previewRoot();
}

/** The canvas element's own shadow root: where a populated form's surface stands in for the sheet. */
function canvasRoot(element: DatumFormBuilderElement): ShadowRoot {
  return shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
}

function surface(element: DatumFormBuilderElement): HTMLElement | null {
  return canvasRoot(element).querySelector<HTMLElement>("[data-canvas-surface] [data-template-surface]");
}

function status(element: DatumFormBuilderElement): string | undefined {
  return surface(element)?.querySelector("[data-template-status]")?.textContent ?? undefined;
}

/** The bar's label for the layout on the page. */
function face(element: DatumFormBuilderElement): HTMLElement {
  return shell(element).querySelector<HTMLElement>("[data-document-face]")!;
}

/** The name the bar's label gives the layout on the page. */
function labelName(element: DatumFormBuilderElement): string | null {
  return face(element).querySelector("[data-document-picker-name]")!.textContent;
}

/** Puts a layout on the page as the shell does, through its unsaved-edits guard. */
function selectThroughShell(element: DatumFormBuilderElement, id: string): boolean {
  return element.builder!.selectDocument("pdf", id);
}

function properties(element: DatumFormBuilderElement): ShadowRoot {
  return shell(element).querySelector("datum-builder-properties")!.shadowRoot!;
}

function prop<T extends HTMLElement = HTMLInputElement>(element: DatumFormBuilderElement, path: string): T {
  return properties(element).querySelector<T>(`[data-prop="${path}"]`)!;
}

function save(element: DatumFormBuilderElement): void {
  properties(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
}

/** The strip's Form panel, which is where a layout's own root is edited. */
function formPanel(element: DatumFormBuilderElement): ShadowRoot {
  const panel = shell(element).querySelector("datum-builder-form-panel") as HTMLElement;
  // A panel behind its strip item is not on screen and does not paint, so it is opened the
  // way an author opens it. Harmless when it is already open.
  if (panel.hidden) {
    shell(element).querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
  }
  return panel.shadowRoot!;
}

function rootProp<T extends HTMLElement = HTMLInputElement>(element: DatumFormBuilderElement, path: string): T {
  return formPanel(element).querySelector<T>(`[data-prop="${path}"]`)!;
}

function saveRoot(element: DatumFormBuilderElement): void {
  formPanel(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
}

function isOpen(dialog: HTMLDialogElement | null): boolean {
  return !!dialog && (dialog.open || dialog.hasAttribute("open"));
}

function setValue(input: Element, value: string, event: "input" | "change" = "input"): void {
  (input as HTMLInputElement).value = value;
  input.dispatchEvent(new Event(event, { bubbles: true }));
}

/** A checkbox control streams on `input` like a text box (the inspector routes it so); `change` follows as a browser's would. */
function setChecked(input: Element, checked: boolean): void {
  (input as HTMLInputElement).checked = checked;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function designedLayout(): PdfGeneratedLayout {
  return {
    id: "letter",
    kind: "generated",
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: {
        body: [{ id: "name-field", type: "pdf-field", configuration: { componentId: "fullName" } }],
        header: [],
        footer: []
      }
    }
  };
}

const HOSTED = { storage: "url", name: "paper.pdf", type: "application/pdf", size: 3072, ref: "/templates/paper.pdf" };

function templateLayout(): PdfTemplateLayout {
  return {
    id: "paper",
    kind: "template",
    name: "Paper form",
    template: HOSTED,
    fields: [{ pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } }]
  };
}

function fakeProvider(calls: { renders: unknown[]; fills: unknown[] }): PdfRenderProvider {
  const bytes = (text: string) => new TextEncoder().encode(text);
  return {
    id: "fake",
    abiVersion: "4.0.0",
    render: async (request: unknown) => {
      calls.renders.push(request);
      return { bytes: bytes("%PDF-fake"), pageCount: 1, pages: [], warnings: [], providerId: "fake" };
    },
    inspect: async () => ({
      pageCount: 1,
      pages: [{ index: 1, width: 612, height: 792 }],
      fields: [
        { name: "Full Name", kind: "text", page: 1, rect: { x: 250, y: 660, width: 300, height: 22 }, readOnly: false, required: false },
        { name: "Subscribe", kind: "checkbox", page: 1, rect: { x: 250, y: 500, width: 14, height: 14 }, exportValues: ["Yes"], readOnly: false, required: false }
      ],
      hasXfa: false,
      encrypted: false
    }),
    fill: async (request: { values: Record<string, unknown> }) => {
      calls.fills.push(request);
      return {
        bytes: bytes("%PDF-filled"),
        pageCount: 1,
        pages: [],
        warnings: [],
        providerId: "fake",
        fields: Object.keys(request.values).map((pdfField) => ({ pdfField, status: "filled" as const }))
      };
    }
  } as unknown as PdfRenderProvider;
}

describe("the PDF layouts alone: <datum-form-builder workspaces=\"pdf\">", () => {
  it("is the builder opened on its PDF side, the form's side put away: derives no layout, and offers the PDF palette over one added", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
      el.values = { fullName: "Ada Lovelace" };
    });
    await readyEmpty(element);
    expect(element.mode).toBe("pdf");
    expect(element.builder!.hiddenModeIds).toEqual(["form"]);
    // A form declaring no layout gets none: the empty state stands in the sheet's
    // place, with no palette beside it, and the definition reads back without a pdf block.
    expect(element.pdfMode!.layouts).toEqual([]);
    expect(element.pdfMode!.pdfLayout).toBeUndefined();
    expect(element.pdfMode!.controller.componentTypes()).toEqual([]);
    expect(element.definition.pdf).toBeUndefined();
    // Its button opens the add popover, without "A copy of this layout": there is none to copy.
    canvasRoot(element).querySelector<HTMLButtonElement>("[data-pdf-empty-add]")!.click();
    const popover = shell(element).querySelector<HTMLElement>("[data-add-popover]")!;
    // The popover is the designer chunk's: it opens once the chunk is in (the first add on a form with no layout loads it).
    await until(() => !popover.hidden && popover.querySelector('[data-add-custom="form"]'));
    expect(popover.querySelector('[data-add-custom="copy"]')).toBeNull();
    popover.querySelector<HTMLButtonElement>('[data-add-custom="form"]')!.click();
    // The layout is named before it is made; the usual name is offered.
    expect(popover.querySelector<HTMLInputElement>("[data-add-name]")!.value).toBe("Custom layout");
    popover.querySelector<HTMLButtonElement>("[data-add-confirm]")!.click();
    await ready(element);
    expect(canvasRoot(element).querySelector("[data-pdf-empty]")).toBeNull();
    // The bar names the layout from the form, the default; the form's side is left off the bar.
    expect(shell(element).querySelector<HTMLElement>("[data-documents]")!.hidden).toBe(false);
    expect(labelName(element)).toBe("Custom layout");
    expect(face(element).querySelector("[data-document-kind]")!.textContent).toBe("PDF layout");
    expect([...face(element).querySelectorAll(".document-face-badge")].map((badge) => badge.textContent)).toEqual(["Default"]);
    expect(element.builder!.hiddenModeIds).toEqual(["form"]);
    // The label opens the layout's options; another layout is added through the shell's API.
    expect(face(element).hasAttribute("data-document-menu")).toBe(true);
    expect(face(element).title).toBe("Layout options");
    const types = element.pdfMode!.controller.componentTypes().map((entry) => entry.type);
    expect(types).toContain("pdf-table");
    expect(types).not.toContain("text");
    expect(element.pdfMode!.pdfLayout?.kind).toBe("generated");
    expect((element.pdfMode!.pdfLayout as PdfGeneratedLayout).root.type).toBe("pdf-document");

    // The canvas draws the page sheet, with the form's fields previewed over the sample answers.
    await until(() => canvasShadow(element)?.querySelector(".datum-pdf-sheet"));
    const sheet = canvasShadow(element)!;
    const preview = sheet.querySelector('.datum-pdf-field[data-bound="fullName"] .datum-pdf-field__preview');
    expect(preview?.textContent).toContain("Full name");
    // The live renderer sets an input's value as a property, not an attribute.
    expect(preview?.querySelector("input")?.value).toBe("Ada Lovelace");
    // The definition read back carries the layout the author added.
    expect(element.definition.pdf?.layouts?.map((layout) => layout.id)).toEqual(["custom-layout"]);
  });

  it("edits the definition's own layout, reports edits with the whole definition, and reads them back", async () => {
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()], defaultLayoutId: "letter" } };
    });
    await ready(element);
    expect(element.pdfMode!.pdfLayout?.id).toBe("letter");
    expect(element.pdfMode!.controller.snapshot().children?.body?.map((node) => node.id)).toEqual(["name-field"]);

    const changes: DatumPdfLayoutChangeDetail[] = [];
    element.addEventListener("datum-pdf-layout-change", (event) => changes.push((event as CustomEvent<DatumPdfLayoutChangeDetail>).detail));
    element.pdfMode!.controller.add("pdf-text", "document", "body");
    await until(() => changes.length > 0);
    const reported = changes.at(-1)!;
    expect(reported.reason).toBe("add");
    expect(reported.layout.id).toBe("letter");
    expect((reported.layout as PdfGeneratedLayout).root.children?.body?.length).toBe(2);
    expect(reported.pdf.layouts?.length).toBe(1);
    expect(reported.definition.pdf?.defaultLayoutId).toBe("letter");
    expect(element.definition.pdf?.layouts?.[0]).toEqual(reported.layout);
  });

  it("names the layout on the page on the bar, moves between the definition's layouts, and shows a populated form's pages on the canvas", async () => {
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), templateLayout()], defaultLayoutId: "letter" } };
    });
    await ready(element);
    expect(element.pdfMode!.layouts.map((layout) => layout.id)).toEqual(["letter", "paper"]);
    expect(labelName(element)).toBe("letter");

    const selections: DatumPdfLayoutSelectDetail[] = [];
    element.addEventListener("datum-pdf-layout-select", (event) => selections.push((event as CustomEvent<DatumPdfLayoutSelectDetail>).detail));
    expect(selectThroughShell(element, "paper")).toBe(true);
    await until(() => status(element)?.includes("paper.pdf"));
    // The sheet stands down for the PDF's pages; the panels beside the canvas stay. The element's
    // default executor loader tries at once and, under Node, cannot: the status says so where
    // the field count would, and the tree holds the PDF and its settings alone.
    expect(canvasRoot(element).querySelector(".canvas-page")!.hasAttribute("data-surface")).toBe(true);
    expect(shell(element).querySelector("datum-builder-properties")).toBeTruthy();
    expect(status(element)).toContain("provided by the host");
    await until(() => element.pdfMode!.ready && !status(element)?.includes("Inspecting"));
    expect(element.pdfMode!.controller.snapshot().type).toBe("pdf-template");
    expect(element.pdfMode!.controller.snapshot().children?.widgets).toEqual([]);
    expect(element.pdfMode!.pdfLayout?.kind).toBe("template");
    expect(labelName(element)).toBe("Paper form");
    expect(selections.map((selection) => selection.layoutId)).toEqual(["paper"]);

    // And back: the sheet returns over the custom layout's own tree.
    element.pdfMode!.selectLayout("letter");
    await until(() => !canvasRoot(element).querySelector(".canvas-page")!.hasAttribute("data-surface") && element.pdfMode?.controller.snapshot().children?.body?.length === 1);
    expect(labelName(element)).toBe("letter");
    expect(() => element.pdfMode!.selectLayout("nope")).toThrow(/No PDF layout/);
  });

  it("has no workspace switch, and '‹ Layouts' lists the layouts to open another", async () => {
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), templateLayout()], defaultLayoutId: "letter" } };
    });
    await ready(element);
    const builder = element.builder!;
    expect(builder.availableWorkspaces()).toEqual(["pdf"]);
    expect(builder.workspace).toBe("pdf");
    expect(shell(element).querySelector<HTMLElement>("[data-workspaces-nav]")!.hidden).toBe(true);
    await until(() => shell(element).querySelector<HTMLElement>("[data-overview-back]")?.hidden === false);
    shell(element).querySelector<HTMLButtonElement>("[data-overview-back]")!.click();
    const overview = (): ShadowRoot | null | undefined => shell(element).querySelector("datum-builder-overview")?.shadowRoot;
    await until(() => overview()?.querySelectorAll('[data-overview-open="pdf"]').length === 2);
    expect(builder.workspace).toBe("pdf");
    overview()!.querySelector<HTMLButtonElement>('[data-overview-open="pdf"][data-document-id="paper"]')!.click();
    await until(() => builder.mode === "pdf" && element.layoutId === "paper");
  });

  it("manages the layouts through its API, reporting each change with the whole definition", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await readyEmpty(element);
    const changes: DatumPdfLayoutChangeDetail[] = [];
    element.addEventListener("datum-pdf-layout-change", (event) => changes.push((event as CustomEvent<DatumPdfLayoutChangeDetail>).detail));
    const ids = () => element.pdfMode!.layouts.map((layout) => layout.id);
    expect(element.pdfMode!.newLayout({ name: "Default", from: "form" })).toMatchObject({ id: "default", kind: "generated" });
    await until(() => element.pdfMode!.pdfLayout?.id === "default" && element.pdfMode!.ready);
    const added = element.pdfMode!.newLayout({ name: "Back-office copy", from: "blank" });
    expect(added).toMatchObject({ id: "back-office-copy", kind: "generated", name: "Back-office copy" });
    expect(ids()).toEqual(["default", "back-office-copy"]);
    expect(changes.at(-1)).toMatchObject({ reason: "layouts", layout: { id: "back-office-copy" } });
    expect(changes.at(-1)!.definition.pdf?.layouts?.length).toBe(2);
    await until(() => element.pdfMode!.pdfLayout?.id === "back-office-copy" && element.pdfMode!.ready);
    expect(element.pdfMode?.controller.snapshot().children?.body).toEqual([]);
    expect(labelName(element)).toBe("Back-office copy");

    const copy = element.pdfMode!.duplicateLayout("default");
    expect(copy).toMatchObject({ id: "default-copy", name: "Default (copy)" });
    element.pdfMode!.setDefaultLayout("back-office-copy");
    expect(element.definition.pdf?.defaultLayoutId).toBe("back-office-copy");
    element.pdfMode!.replaceLayout("back-office-copy", { ...element.pdfMode!.layouts[1]!, id: "internal", name: "Internal" });
    expect(element.definition.pdf?.defaultLayoutId).toBe("internal");
    await until(() => element.pdfMode!.pdfLayout?.id === "internal" && element.pdfMode!.ready);
    expect(ids()).toEqual(["default", "internal", "default-copy"]);
    element.pdfMode!.renameLayout("internal", "Internal use");
    expect(element.pdfMode!.layouts[1]!.name).toBe("Internal use");
    expect(labelName(element)).toBe("Internal use");
    // Where a layout's condition is tried: the page stays on the layout it showed.
    element.pdfMode!.moveLayout("default-copy", 0);
    expect(ids()).toEqual(["default-copy", "default", "internal"]);
    expect(element.pdfMode!.pdfLayout?.id).toBe("internal");
    expect(labelName(element)).toBe("Internal use");
    element.pdfMode!.moveLayout("default-copy", 2);
    expect(ids()).toEqual(["default", "internal", "default-copy"]);
    element.pdfMode!.removeLayout("default-copy");
    expect(ids()).toEqual(["default", "internal"]);
    expect(() => element.pdfMode!.addLayout(designedLayout(), { select: false })).not.toThrow();
    expect(() => element.pdfMode!.addLayout(designedLayout())).toThrow(/already exists/);
    element.pdfMode!.removeLayout("letter");
    element.pdfMode!.removeLayout("internal");
    await until(() => element.pdfMode!.pdfLayout?.id === "default" && element.pdfMode!.ready);
    // The last one goes too: the page stays on the PDF side, on its empty state.
    element.pdfMode!.removeLayout("default");
    expect(ids()).toEqual([]);
    expect(element.definition.pdf).toBeUndefined();
    expect(changes.at(-1)!.definition.pdf).toBeUndefined();
    await readyEmpty(element);
    expect(element.mode).toBe("pdf");
    expect(changes.every((change) => change.reason === "layouts" && change.definition.root.id === "root")).toBe(true);
  });

  it("adds a custom layout and a populated form over a host-provided PDF from the Add popover, and suggests the mappings", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const element = mount((el) => {
      el.definition = sampleDefinition();
      el.pdfSupport = { provider: fakeProvider(calls) };
      el.pdfTemplates = createPdfTemplateResolver(
        { url: async () => new Uint8Array([1, 2, 3]) },
        { templates: [{ id: "paper-host", label: "Paper (host)", source: HOSTED }] }
      );
    });
    await readyEmpty(element);
    const changes: DatumPdfLayoutChangeDetail[] = [];
    element.addEventListener("datum-pdf-layout-change", (event) => changes.push((event as CustomEvent<DatumPdfLayoutChangeDetail>).detail));
    const popover = () => shell(element).querySelector<HTMLElement>("[data-add-popover]")!;
    // A new layout, as the PDF overview's New and the command palette start one: the popover under the bar's label.
    const add = () => expect(element.builder!.newDocument("pdf")).toBe(true);

    // Add → a custom layout from the form.
    add();
    await until(() => !popover().hidden && popover().querySelector('[data-add-custom="form"]'));
    popover().querySelector<HTMLButtonElement>('[data-add-custom="form"]')!.click();
    popover().querySelector<HTMLButtonElement>("[data-add-confirm]")!.click();
    expect(popover().hidden).toBe(true);
    expect(element.pdfMode!.layouts.map((layout) => layout.id)).toEqual(["custom-layout"]);
    expect(JSON.stringify(element.pdfMode!.layouts[0])).toContain('"componentId":"fullName"');
    expect(changes.at(-1)).toMatchObject({ reason: "layouts", layout: { id: "custom-layout", name: "Custom layout" } });
    await until(() => element.pdfMode!.pdfLayout?.id === "custom-layout" && element.pdfMode!.ready);
    expect(labelName(element)).toBe("Custom layout");

    // Add → populate an existing PDF form, the host's: the layout is added and put on the page, its fields read.
    add();
    await until(() => !popover().hidden && popover().querySelector('[data-add-host="paper-host"]'));
    popover().querySelector<HTMLButtonElement>('[data-add-host="paper-host"]')!.click();
    popover().querySelector<HTMLButtonElement>("[data-add-confirm]")!.click();
    expect(popover().hidden).toBe(true);
    const saved = element.pdfMode!.layouts.at(-1) as PdfTemplateLayout;
    expect(saved).toMatchObject({ id: "paper-host", kind: "template", name: "Paper (host)", template: HOSTED, fields: [] });
    expect(changes.at(-1)).toMatchObject({ reason: "template", layout: { id: "paper-host" } });
    await until(() => status(element)?.includes("2 fields on 1 page"));
    expect(element.pdfMode!.pdfLayout?.id).toBe("paper-host");
    expect(element.pdfMode!.controller.snapshot().children?.widgets?.map((node) => node.id)).toEqual(["widget_full_name", "widget_subscribe"]);

    // Suggest maps "Full Name" to fullName and "Subscribe" to the checkbox with its export value — landed at once, on the layout.
    const suggest = canvasRoot(element).querySelector<HTMLButtonElement>("[data-suggest-mappings]")!;
    expect(suggest.hidden).toBe(false);
    suggest.click();
    const paper = () => element.pdfMode!.layouts.find((layout) => layout.id === "paper-host") as PdfTemplateLayout;
    expect(paper().fields).toEqual([
      { pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } },
      { pdfField: "Subscribe", source: { kind: "component", componentId: "subscribe" }, checkedValue: "Yes" }
    ]);
    expect(changes.at(-1)).toMatchObject({ reason: "edit", layout: { id: "paper-host" } });
    // Each guess is its own edit, a checkbox's source and export value together: undo takes the last one back whole.
    element.pdfMode!.controller.undo();
    expect(paper().fields).toEqual([{ pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } }]);
  });

  it("edits a populated form's mapping as its tree: a field box selects its widget, the inspector edits it, Save lands it, undo takes it back", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const provider = fakeProvider(calls);
    const inspect = provider.inspect!.bind(provider);
    let inspections = 0;
    provider.inspect = (request) => {
      inspections += 1;
      return inspect(request);
    };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), templateLayout()], defaultLayoutId: "letter" } };
      el.values = { fullName: "Grace Hopper" };
      el.pdfSupport = { provider };
      el.pdfTemplates = createPdfTemplateResolver(
        { url: async () => new Uint8Array([1, 2, 3]) },
        { templates: [{ id: "paper-host", label: "Paper (host)", source: HOSTED }] }
      );
    });
    await ready(element);
    const changes: DatumPdfLayoutChangeDetail[] = [];
    element.addEventListener("datum-pdf-layout-change", (event) => changes.push((event as CustomEvent<DatumPdfLayoutChangeDetail>).detail));
    const paper = () => element.pdfMode!.layouts.find((layout) => layout.kind === "template") as PdfTemplateLayout;
    const box = (name: string) => surface(element)!.querySelector<SVGRectElement>(`[data-template-pages] [data-fields] rect[data-field="${name}"]`);
    const controller = () => element.pdfMode!.controller;

    // On arrival the PDF is read and the tree seeded from the layout: one widget per field, the mapped one filled.
    element.pdfMode!.selectLayout("paper");
    await until(() => status(element)?.includes("2 fields on 1 page"));
    expect(controller().snapshot().children?.widgets?.map((node) => node.id)).toEqual(["widget_full_name", "widget_subscribe"]);
    expect(controller().getProperty("widget_full_name", "source.componentId")).toBe("fullName");
    expect(controller().getProperty("widget_subscribe", "source.kind")).toBe("");
    expect(changes).toEqual([]);
    // The page viewer boxes every field the kernel placed, in the page's own points (y from the top), marking the mapped one.
    expect(surface(element)!.querySelectorAll("[data-template-pages] [data-fields] rect").length).toBe(2);
    expect(box("Full Name")?.classList.contains("datum-pdf-schematic__field--mapped")).toBe(true);
    expect(box("Full Name")?.getAttribute("y")).toBe((792 - 660 - 22).toFixed(2));
    expect(box("Subscribe")?.classList.contains("datum-pdf-schematic__field--mapped")).toBe(false);
    expect(status(element)).not.toContain("no page position");
    // The palette offers an area to draw; the widgets themselves are the PDF's and never on it.
    expect(controller().componentTypes().map((entry) => entry.type)).toEqual(["pdf-area"]);

    // Picking a field's box selects its widget; the inspector shows what fills it, no Delete for a field that is the PDF's own.
    box("Subscribe")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    expect(controller().selectedComponentId()).toBe("widget_subscribe");
    await until(() => prop<HTMLSelectElement>(element, "source.kind"));
    expect(properties(element).querySelector("[data-inspector-delete]")).toBeNull();
    expect(prop<HTMLSelectElement>(element, "source.kind").value).toBe("");

    // Edits are a draft: the box on the page shows the mapping at once, the layout waits for Save.
    setValue(prop(element, "source.kind"), "component", "change");
    setValue(prop(element, "source.componentId"), "subscribe", "change");
    setValue(prop(element, "checkedValue"), "Yes", "input");
    expect(box("Subscribe")?.classList.contains("datum-pdf-schematic__field--mapped")).toBe(true);
    expect(paper().fields).toEqual([{ pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } }]);
    expect(changes).toEqual([]);
    save(element);
    expect(paper().fields).toEqual([
      { pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } },
      { pdfField: "Subscribe", source: { kind: "component", componentId: "subscribe" }, checkedValue: "Yes" }
    ]);
    expect(changes.map((change) => change.reason)).toEqual(["edit"]);
    expect(changes.at(-1)!.layout.id).toBe("paper");
    expect(inspections).toBe(1);

    // One undo entry: the mapping comes off and goes back on.
    controller().undo();
    expect(paper().fields.length).toBe(1);
    expect(box("Subscribe")?.classList.contains("datum-pdf-schematic__field--mapped")).toBe(false);
    controller().redo();
    expect(paper().fields.length).toBe(2);

    // A preview fills the layout as it stands, through the provider over the sample answers, and lists what filled each field.
    await element.pdfMode!.previewPdf();
    expect((calls.fills.at(-1) as { values: Record<string, unknown> }).values).toEqual({ "Full Name": "Grace Hopper", Subscribe: false });
    const preview = shell(element).querySelector<HTMLDialogElement>("[data-preview-dialog]")!;
    expect(isOpen(preview)).toBe(true);
    expect(preview.querySelector("[data-template-report]")?.textContent).toContain("Full Name: filled");
    preview.querySelector<HTMLButtonElement>('[data-action="close"]')!.click();

    // Leaving for another layout with an unsaved draft raises the inspector's prompt; Keep editing stays put, Discard goes.
    setValue(prop(element, "source.kind"), "", "change");
    selectThroughShell(element, "letter");
    const prompt = () => properties(element).querySelector<HTMLDialogElement>("dialog[data-unsaved-prompt]");
    await until(() => isOpen(prompt()));
    expect(element.layoutId).toBe("paper");
    prompt()!.querySelector<HTMLButtonElement>("[data-unsaved-stay]")!.click();
    expect(isOpen(prompt())).toBe(false);
    expect(element.layoutId).toBe("paper");
    expect(prop<HTMLSelectElement>(element, "source.kind").value).toBe("");
    selectThroughShell(element, "letter");
    await until(() => isOpen(prompt()));
    prompt()!.querySelector<HTMLButtonElement>("[data-unsaved-discard]")!.click();
    await until(() => element.layoutId === "letter" && element.pdfMode!.ready);
    expect(paper().fields.length).toBe(2);

    // Back: the tree is as it was, the PDF not read again; the widget's mapping shows as saved.
    element.pdfMode!.selectLayout("paper");
    await until(() => element.layoutId === "paper" && element.pdfMode!.ready);
    expect(inspections).toBe(1);
    expect(controller().getProperty("widget_subscribe", "source.componentId")).toBe("subscribe");

    // A change made through the API rebuilds the tree over the cached reading, still without another inspection.
    element.pdfMode!.replaceLayout("paper", { ...paper(), fields: [] });
    await until(() => controller().getProperty("widget_full_name", "source.kind") === "");
    expect(controller().getProperty("widget_subscribe", "source.kind")).toBe("");
    expect(inspections).toBe(1);
  });

  it("fills a field from a saved value path or a formula: the path list offers the Data workspace's paths, the formula goes through the live seam", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), templateLayout()], defaultLayoutId: "letter" } };
      el.values = { fullName: "Grace Hopper" };
      el.pdfSupport = { provider: fakeProvider(calls) };
      el.pdfTemplates = createPdfTemplateResolver({ url: async () => new Uint8Array([1, 2, 3]) }, { templates: [{ id: "paper-host", label: "Paper (host)", source: HOSTED }] });
    });
    await ready(element);
    const paper = () => element.pdfMode!.layouts.find((layout) => layout.kind === "template") as PdfTemplateLayout;
    const controller = () => element.pdfMode!.controller;
    element.pdfMode!.selectLayout("paper");
    await until(() => status(element)?.includes("2 fields on 1 page"));
    controller().select("widget_subscribe");
    await until(() => prop<HTMLSelectElement>(element, "source.kind"));

    // The picker offers both new kinds; neither box is drawn until its kind is chosen.
    const kinds = [...prop<HTMLSelectElement>(element, "source.kind").options].map((option) => option.value);
    expect(kinds).toEqual(["", "component", "template", "literal", "path", "expression"]);
    expect(prop(element, "source.path")).toBeNull();
    expect(properties(element).querySelector("[data-formula-field]")).toBeNull();

    // Path: free typing with the form's saved paths offered, and a lint for one the form does not save.
    setValue(prop(element, "source.kind"), "path", "change");
    await until(() => prop(element, "source.path"));
    const list = properties(element).querySelector<HTMLDataListElement>(`datalist[id="${prop(element, "source.path").getAttribute("list")}"]`)!;
    expect([...list.options].map((option) => option.value)).toContain("fullName");
    setValue(prop(element, "source.path"), "fullName", "input");
    expect(properties(element).querySelector("[data-problem], .rule-error")).toBeNull();
    setValue(prop(element, "source.path"), "nowhere.at.all", "input");
    save(element);
    expect(paper().fields.find((mapping) => mapping.pdfField === "Subscribe")?.source).toEqual({ kind: "path", path: "nowhere.at.all" });
    controller().select("widget_subscribe");
    await until(() => properties(element).textContent?.includes('The form saves nothing at "nowhere"'));
    setValue(prop(element, "source.path"), "fullName.first", "input");
    save(element);
    expect(paper().fields.find((mapping) => mapping.pdfField === "Subscribe")?.source).toEqual({ kind: "path", path: "fullName.first" });

    // Formula: the Rules tab's box, a keystroke reaches the draft without repainting the panel, Save stores the string.
    controller().select("widget_subscribe");
    await until(() => prop<HTMLSelectElement>(element, "source.kind")?.value === "path");
    const kindBox = prop<HTMLSelectElement>(element, "source.kind");
    setValue(kindBox, "expression", "change");
    await until(() => properties(element).querySelector("textarea[data-rule-formula]"));
    expect(prop(element, "source.path")).toBeNull();
    const kindBoxAfter = prop<HTMLSelectElement>(element, "source.kind");
    const formulaBox = () => properties(element).querySelector<HTMLTextAreaElement>('textarea[data-rule="field:source.expression"][data-rule-formula]')!;
    const type = (text: string) => {
      formulaBox().value = text;
      formulaBox().dispatchEvent(new Event("input", { bubbles: true }));
    };
    const box = formulaBox();
    type("upper(fullName)");
    type("upper(fullName) + 1");
    type("upper(fullName)");
    // Nothing repainted: the same nodes are still on the page, and the draft already holds the text.
    expect(prop(element, "source.kind")).toBe(kindBoxAfter);
    expect(formulaBox()).toBe(box);
    expect(controller().draftProperty("widget_subscribe", "source.expression")).toBe("upper(fullName)");
    expect(paper().fields.find((mapping) => mapping.pdfField === "Subscribe")?.source).toEqual({ kind: "path", path: "fullName.first" });
    // The box says what it reads, as a rule's does.
    expect(properties(element).querySelector("[data-rule-reads]")).not.toBeNull();
    save(element);
    expect(paper().fields.find((mapping) => mapping.pdfField === "Subscribe")?.source).toEqual({ kind: "expression", expression: "upper(fullName)" });

    // A formula that does not read is a problem under its box and is not stored.
    controller().select("widget_subscribe");
    await until(() => formulaBox());
    type("upper(");
    await until(() => properties(element).querySelector('[data-problem="rules:field:source.expression"]'));
    expect(properties(element).querySelector<HTMLTextAreaElement>('textarea[data-rule-formula]')!.getAttribute("aria-invalid")).toBe("true");
    type("fullName");
    await until(() => !properties(element).querySelector('[data-problem="rules:field:source.expression"]'));

    // Changing the kind back keeps every other binding field: the component is still there.
    setValue(prop(element, "source.kind"), "component", "change");
    await until(() => prop(element, "source.componentId"));
    expect(controller().getProperty("widget_subscribe", "source.path")).toBe("fullName.first");
    expect(controller().draftProperty("widget_subscribe", "source.expression")).toBe("fullName");
  });

  it("renders the designed layout over the sample answers through the PDF support it is given", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()] } };
      el.values = { fullName: "Grace Hopper" };
      el.pdfSupport = { provider: fakeProvider(calls) };
    });
    await ready(element);
    const result = await element.pdfMode!.renderPdf();
    expect(new TextDecoder().decode(result.bytes)).toBe("%PDF-fake");
    expect(result.layoutId).toBe("letter");
    expect(calls.renders.length).toBe(1);
    expect(JSON.stringify(calls.renders[0])).toContain("Grace Hopper");
  });

  /** The answers Try it holds, set the way typing in the previewed form does: on the canvas's shared preview runtime. */
  function tryAnswer(element: DatumFormBuilderElement, id: string, value: unknown): void {
    const canvas = shell(element).querySelector("datum-builder-canvas") as HTMLElement & { previewRuntime(): { setValue(path: string, value: unknown): void } };
    canvas.previewRuntime().setValue(id, value);
  }

  it("fills the bar's Preview PDF with the answers tried, over the host's values", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()] } };
      el.values = { fullName: "Grace Hopper" };
      el.pdfSupport = { provider: fakeProvider(calls) };
    });
    await ready(element);
    await until(() => (shell(element).querySelector("datum-builder-canvas") as { previewRuntime?(): unknown }).previewRuntime?.());
    tryAnswer(element, "fullName", "Ada Lovelace");
    await element.pdfMode!.previewPdf();
    const sent = JSON.stringify(calls.renders[0]);
    expect(sent).toContain("Ada Lovelace");
    expect(sent).not.toContain("Grace Hopper");
    // The sheet's own previews follow the same merge.
    const preview = shell(element).querySelector<HTMLDialogElement>("[data-preview-dialog]")!;
    expect(isOpen(preview)).toBe(true);
  });

  it("says in the preview dialog how many answers filled it and which layout printed", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [{ ...designedLayout(), name: "Standard" }] } };
      el.pdfSupport = { provider: fakeProvider(calls) };
    });
    await ready(element);
    await until(() => (shell(element).querySelector("datum-builder-canvas") as { previewRuntime?(): unknown }).previewRuntime?.());
    const preview = shell(element).querySelector<HTMLDialogElement>("[data-preview-dialog]")!;
    await element.pdfMode!.previewPdf();
    expect(preview.querySelector("h2")?.textContent).toBe("Standard · PDF");
    expect(preview.querySelector("[data-preview-meta]")?.textContent).toContain("no answers yet");
    tryAnswer(element, "fullName", "Ada Lovelace");
    await element.pdfMode!.previewPdf();
    expect(preview.querySelector("[data-preview-meta]")?.textContent).toContain("Letter · 1 page · filled with the 1 answer from Try it");
    expect(preview.querySelector("[data-preview-answers]")?.textContent).toContain("From Try it: 1 typed answer");
    expect(preview.querySelector("[data-preview-layout]")?.textContent).toContain("Standard, the open layout");
    expect(preview.querySelector("[data-action='download']")?.getAttribute("download")).toBeTruthy();
    expect(preview.querySelector("[data-action='maximize']")).toBeTruthy();
    // Close and Escape both put it away.
    preview.querySelector<HTMLElement>("[data-action='close']")!.click();
    expect(isOpen(preview)).toBe(false);
  });

  it("counts only the typed answers, not the host's sample values", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()] } };
      el.values = { fullName: "Grace Hopper", subscribe: true };
      el.pdfSupport = { provider: fakeProvider(calls) };
    });
    await ready(element);
    await until(() => (shell(element).querySelector("datum-builder-canvas") as { previewRuntime?(): unknown }).previewRuntime?.());
    const preview = shell(element).querySelector<HTMLDialogElement>("[data-preview-dialog]")!;
    await element.pdfMode!.previewPdf();
    expect(preview.querySelector("[data-preview-meta]")?.textContent).toContain("no answers yet");
    tryAnswer(element, "fullName", "Ada Lovelace");
    await element.pdfMode!.previewPdf();
    expect(preview.querySelector("[data-preview-meta]")?.textContent).toContain("filled with the 1 answer from Try it");
  });

  it("draws the sheet's field previews without the tried answers after Back to editing", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()] } };
      el.pdfSupport = { provider: fakeProvider(calls) };
    });
    await ready(element);
    const canvas = shell(element).querySelector("datum-builder-canvas") as HTMLElement & { previewing: boolean };
    await until(() => (canvas as unknown as { previewRuntime?(): unknown }).previewRuntime?.());
    canvas.previewing = true;
    tryAnswer(element, "fullName", "Ada Lovelace");
    canvas.previewing = false;
    // The answers go with Try it: the store empties, and the sheet's previews are drawn over the form's own values.
    await until(() => Object.keys(element.triedAnswers()).length === 0);
    await until(() => canvasShadow(element)?.querySelector('.datum-pdf-field[data-bound="fullName"]'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const inputs = [...(canvasShadow(element)?.querySelectorAll<HTMLInputElement>('.datum-pdf-field[data-bound="fullName"] input') ?? [])];
    expect(inputs.map((input) => input.value)).not.toContain("Ada Lovelace");
    expect(canvasShadow(element)?.querySelector('.datum-pdf-field[data-bound="fullName"]')?.textContent ?? "").not.toContain("Ada Lovelace");
  });

  it("previews the OPEN layout from the Try panel in the PDF workspace, with the tried runtime", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()] } };
      el.pdfSupport = { provider: fakeProvider(calls) };
    });
    await ready(element);
    const canvas = shell(element).querySelector("datum-builder-canvas") as HTMLElement & { previewing: boolean; previewRuntime(): { setValue(path: string, value: unknown): void } };
    await until(() => canvas.previewRuntime?.());
    const spy = vi.spyOn(element.pdfMode!, "renderPdf");
    canvas.previewing = true;
    canvas.previewRuntime().setValue("fullName", "Ada Lovelace");
    const button = () => canvas.shadowRoot!.querySelector<HTMLElement>("[data-try-pdf]");
    await until(() => button());
    button()!.click();
    await until(() => spy.mock.calls.length > 0 && calls.renders.length > 0);
    expect(spy.mock.calls[0]![0]).toMatchObject({ byAnswers: false });
    expect(spy.mock.calls[0]![0]!.runtime).toBeDefined();
    expect(JSON.stringify(calls.renders[0])).toContain("Ada Lovelace");
  });

  it("closes on Escape with focus back on the Preview PDF button, and the Download link is no drag handle", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()] } };
      el.pdfSupport = { provider: fakeProvider(calls) };
    });
    await ready(element);
    await element.pdfMode!.previewPdf();
    const preview = shell(element).querySelector<HTMLDialogElement>("[data-preview-dialog]")!;
    expect(isOpen(preview)).toBe(true);
    const head = preview.querySelector<HTMLElement>("[data-preview-head]")!;
    const capture = vi.fn();
    head.setPointerCapture = capture;
    const down = (target: Element) => target.dispatchEvent(Object.assign(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }), { pointerId: 1 }));
    down(preview.querySelector("[data-action='download']")!);
    expect(capture).not.toHaveBeenCalled();
    down(preview.querySelector("h2")!);
    expect(capture).toHaveBeenCalledTimes(1);
    preview.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(isOpen(preview)).toBe(false);
    expect(canvasRoot(element).activeElement).toBe(canvasRoot(element).querySelector("[data-preview-pdf]"));
  });

  it("offers Try it on a template layout's page viewer, not on the empty state", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), templateLayout()], defaultLayoutId: "letter" } };
      el.pdfSupport = {
        provider: fakeProvider(calls),
        // A rasteriser that cannot draw (no canvas here): the viewer falls back to blank sheets.
        pages: {
          open: async () => ({ pageCount: 1, pageSize: () => ({ width: 612, height: 792 }), render: async () => Promise.reject(new Error("no canvas in jsdom")), close: () => undefined })
        }
      };
      el.pdfTemplates = createPdfTemplateResolver({ url: async () => new Uint8Array([1, 2, 3]) });
    });
    await ready(element);
    element.pdfMode!.selectLayout("paper");
    await until(() => element.pdfMode!.pdfLayout?.kind === "template" && element.pdfMode!.ready);
    await until(() => canvasRoot(element).querySelector(".dpd-page"));
    // On a phone the bottom bar's Try it button is the visible proof.
    const phone = (target: DatumFormBuilderElement) => {
      const wrap = shell(target).querySelector<HTMLElement>(".wrap")!;
      wrap.getBoundingClientRect = () => ({ width: 390, height: 844, x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 844, toJSON: () => ({}) }) as DOMRect;
      window.dispatchEvent(new Event("resize"));
    };
    const tryShown = (target: DatumFormBuilderElement) => shell(target).querySelector(".wrap[data-phone] [data-bottom-try]:not([hidden])") !== null;
    phone(element);
    await until(() => tryShown(element));

    const empty = mount();
    await readyEmpty(empty);
    phone(empty);
    await until(() => shell(empty).querySelector(".wrap[data-phone]"));
    expect(tryShown(empty)).toBe(false);
  });

  it("renders a populated-form layout through the host's template resolver, and previews it in its own panel", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const resolved: string[] = [];
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), templateLayout()] } };
      el.values = { fullName: "Grace Hopper" };
      el.pdfSupport = { provider: fakeProvider(calls) };
      el.pdfTemplates = createPdfTemplateResolver({
        url: async (source) => {
          resolved.push(String(source.ref));
          return new Uint8Array([1, 2, 3]);
        }
      });
    });
    await ready(element);
    const result = await element.pdfMode!.renderPdf({ layoutId: "paper" });
    expect(result.layoutId).toBe("paper");
    expect(resolved).toEqual(["/templates/paper.pdf"]);
    expect(calls.fills.length).toBe(1);
    expect((calls.fills[0] as { values: Record<string, unknown> }).values).toEqual({ "Full Name": "Grace Hopper" });

    element.pdfMode!.selectLayout("paper");
    await until(() => element.pdfMode!.pdfLayout?.kind === "template" && element.pdfMode!.ready);
    await element.pdfMode!.previewPdf();
    const preview = shell(element).querySelector<HTMLDialogElement>("[data-preview-dialog]")!;
    expect(isOpen(preview)).toBe(true);
    expect(preview.querySelector("[data-preview-meta]")?.textContent).toContain("1 page");
    expect(calls.fills.length).toBe(2);
  });

  it("reports an executor that cannot load rather than failing silently", async () => {
    const errors: string[] = [];
    const element = mount((el) => {
      el.setAttribute("pdf", "/nowhere/datum-pdf.js");
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()] } };
      el.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    });
    await ready(element);
    await expect(element.pdfMode!.renderPdf()).rejects.toThrow();
    await until(() => errors.some((message) => message.includes("executor")));
  });

  it("puts the layout named by layout-id on the page first", async () => {
    const element = mount((el) => {
      el.setAttribute("layout-id", "paper");
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), templateLayout()], defaultLayoutId: "letter" } };
    });
    await until(() => element.pdfMode!.ready && element.pdfMode!.pdfLayout?.id === "paper");
    expect(element.layoutId).toBe("paper");
    expect(surface(element)).toBeTruthy();
    // The page viewer's stylesheet sits beside the surface inside the canvas's shadow root.
    expect(canvasRoot(element).querySelector("[data-canvas-surface] style[data-surface-styles]")?.textContent).toContain(".dpd-page__overlay");
    expect(labelName(element)).toBe("Paper form");
  });

  it("says which fields the kernel could not place on a page, and draws no box for them", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const provider = fakeProvider(calls);
    const inspect = provider.inspect!.bind(provider);
    provider.inspect = async (request) => {
      const info = await inspect(request);
      // A widget with a rectangle but no page: what an older program reports for a form re-saved by macOS Preview.
      return { ...info, fields: [...info.fields, { name: "Stray", kind: "text", rect: { x: 10, y: 10, width: 50, height: 12 }, readOnly: false, required: false }] };
    };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), templateLayout()], defaultLayoutId: "letter" } };
      el.pdfSupport = { provider };
      el.pdfTemplates = createPdfTemplateResolver({ url: async () => new Uint8Array([1, 2, 3]) });
    });
    await ready(element);
    element.pdfMode!.selectLayout("paper");
    await until(() => status(element)?.includes("3 fields on 1 page"));
    expect(status(element)).toContain("1 field has no page position and is not drawn on the pages");
    expect([...surface(element)!.querySelectorAll("[data-template-pages] [data-fields] rect")].map((rect) => rect.getAttribute("data-field"))).toEqual(["Full Name", "Subscribe"]);
    // The widget is still there to map, in the tree and the outline.
    expect(element.pdfMode!.controller.snapshot().children?.widgets?.some((node) => node.id === "widget_stray")).toBe(true);
  });

  it("offers the archival profile on a populated form's root, tells whether the template is PDF/A, and lands the choice on the layout", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const provider = fakeProvider(calls);
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), templateLayout()], defaultLayoutId: "letter" } };
      el.pdfSupport = { provider };
      el.pdfTemplates = createPdfTemplateResolver({ url: async () => new Uint8Array([1, 2, 3]) });
    });
    await ready(element);
    element.pdfMode!.selectLayout("paper");
    const paper = () => element.pdfMode!.layouts.find((layout) => layout.kind === "template") as PdfTemplateLayout;
    await until(() => status(element)?.includes("2 fields on 1 page"));
    // The template declares nothing: the status says so.
    expect(status(element)).toContain("not PDF/A");
    // The layout itself — the PDF, the fill options, the archival level — is the strip's
    // Form panel, whatever the canvas selection is.
    await until(() => rootProp<HTMLSelectElement>(element, "conformance.pdfa"));
    expect(rootProp<HTMLSelectElement>(element, "conformance.pdfa").value).toBe("");
    expect(formPanel(element).querySelector('[data-prop="template"][data-control="file"]')).toBeTruthy();
    setValue(rootProp(element, "conformance.pdfa"), "3b", "change");
    setChecked(rootProp(element, "conformance.attachData"), true);
    setValue(rootProp(element, "conformance.attachment.name"), "answers.json", "input");
    // Held until Save, like every other edit.
    expect(paper().conformance).toBeUndefined();
    saveRoot(element);
    expect(paper().conformance).toEqual({ pdfa: "3b", attachData: true, attachment: { name: "answers.json" } });
    expect(paper().options).toBeUndefined();

    // Off again clears the block: a level set back to none and a switch turned off are as good as never set.
    setValue(rootProp(element, "conformance.pdfa"), "", "change");
    setChecked(rootProp(element, "conformance.attachData"), false);
    setValue(rootProp(element, "conformance.attachment.name"), "", "input");
    saveRoot(element);
    expect(paper().conformance).toBeUndefined();

    // A PDF/A template reports its level in the status.
    const archival = fakeProvider(calls);
    const inspect = archival.inspect!.bind(archival);
    archival.inspect = async (request) => ({ ...(await inspect(request)), pdfa: "2b" as const });
    const second = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), { ...templateLayout(), conformance: { pdfa: "2b" } }], defaultLayoutId: "letter" } };
      el.pdfSupport = { provider: archival };
      el.pdfTemplates = createPdfTemplateResolver({ url: async () => new Uint8Array([1, 2, 3]) });
    });
    await ready(second);
    second.pdfMode!.selectLayout("paper");
    await until(() => status(second)?.includes("PDF/A-2b"));
    await until(() => rootProp<HTMLSelectElement>(second, "conformance.pdfa"));
    expect(rootProp<HTMLSelectElement>(second, "conformance.pdfa").value).toBe("2b");
  });

  it("says in the status line that a PDF carries scripts when the inspection warns template.javascript_*", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const scripted = fakeProvider(calls);
    const inspect = scripted.inspect!.bind(scripted);
    scripted.inspect = async (request) => ({
      ...(await inspect(request)),
      warnings: [{ code: "template.javascript_open_action", message: "The PDF has a JavaScript open action." }]
    });
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), templateLayout()], defaultLayoutId: "letter" } };
      el.pdfSupport = { provider: scripted };
      el.pdfTemplates = createPdfTemplateResolver({ url: async () => new Uint8Array([1, 2, 3]) });
    });
    await ready(element);
    element.pdfMode!.selectLayout("paper");
    await until(() => status(element)?.includes("This PDF carries scripts; they are kept and run only in the viewer"));
    // A PDF without the warning says nothing of scripts.
    const plain = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), templateLayout()], defaultLayoutId: "letter" } };
      el.pdfSupport = { provider: fakeProvider(calls) };
      el.pdfTemplates = createPdfTemplateResolver({ url: async () => new Uint8Array([1, 2, 3]) });
    });
    await ready(plain);
    plain.pdfMode!.selectLayout("paper");
    await until(() => status(plain)?.includes("2 fields"));
    expect(status(plain)).not.toContain("scripts");
  });

  it("draws the page box of a field whose component the form lost as a warning, not as mapped, titled with the missing id", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const lost = { ...templateLayout(), fields: [{ pdfField: "Full Name", source: { kind: "component", componentId: "gone" } }, { pdfField: "Subscribe", source: { kind: "component", componentId: "fullName" } }] } as PdfTemplateLayout;
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), lost], defaultLayoutId: "letter" } };
      el.pdfSupport = { provider: fakeProvider(calls) };
      el.pdfTemplates = createPdfTemplateResolver({ url: async () => new Uint8Array([1, 2, 3]) });
    });
    await ready(element);
    element.pdfMode!.selectLayout("paper");
    await until(() => status(element)?.includes("2 fields"));
    const box = (name: string) => surface(element)!.querySelector<SVGRectElement>(`[data-template-pages] [data-fields] rect[data-field="${name}"]`)!;
    await until(() => box("Full Name"));
    expect(box("Full Name").classList.contains("datum-pdf-schematic__field--unresolved")).toBe(true);
    expect(box("Full Name").classList.contains("datum-pdf-schematic__field--mapped")).toBe(false);
    expect(box("Full Name").querySelector("title")!.textContent).toContain('"gone"');
    expect(box("Subscribe").classList.contains("datum-pdf-schematic__field--mapped")).toBe(true);
    expect(box("Subscribe").classList.contains("datum-pdf-schematic__field--unresolved")).toBe(false);
  });

  it("takes the output intent's ICC profile through the document's properties — a built-in, one the host lists, or an upload — refuses a file that is no profile, and removes it again", async () => {
    const hosted = { storage: "asset", name: "FOGRA39.icc", type: "application/vnd.iccprofile", size: 1_800_000, ref: "icc/fogra39" };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()], defaultLayoutId: "letter" } };
      el.pdfTemplates = createPdfTemplateResolver({}, { profiles: [{ id: "fogra39", label: "ISO Coated v2 (FOGRA39)", source: hosted }] });
    });
    await ready(element);
    // The layout's root is the Form panel's subject, whatever the canvas selection.
    const fileInput = () => formPanel(element).querySelector<HTMLInputElement>('input[data-control="file"][data-prop="conformance.outputIntent.profile"]');
    await until(() => fileInput());
    expect(fileInput()!.getAttribute("accept")).toBe("application/vnd.iccprofile,.icc,.icm");
    expect(fileInput()!.hidden).toBe(true);
    const summary = () => formPanel(element).querySelector("[data-file-summary]")?.textContent;
    expect(summary()).toBe("None");
    const layoutRoot = () => (element.pdfMode!.layouts[0] as PdfGeneratedLayout).root.configuration as { conformance?: { pdfa?: string; outputIntent?: { profile?: unknown } } };

    // Ready-made: the kernel's built-ins and the host's profile, grouped, landed as envelopes.
    const choice = () => formPanel(element).querySelector<HTMLSelectElement>('select[data-file-choice="conformance.outputIntent.profile"]')!;
    expect(Array.from(choice().querySelectorAll("optgroup")).map((group) => group.label)).toEqual(["Built in", "From the host"]);
    expect(Array.from(choice().options).map((option) => option.value)).toEqual(["", "builtin:srgb", "builtin:gray", "builtin:cmyk", "host:fogra39", "__upload"]);
    setValue(choice(), "builtin:cmyk", "change");
    await until(() => summary() === "CMYK, SWOP-compatible (CGATS TR 001) · built in");
    saveRoot(element);
    await until(() => layoutRoot().conformance?.outputIntent?.profile);
    expect(layoutRoot().conformance?.outputIntent?.profile).toEqual({ storage: "builtin", ref: "cmyk", name: "CGATS TR 001 compatible.icc", type: "application/vnd.iccprofile", size: 8464 });
    setValue(choice(), "host:fogra39", "change");
    await until(() => summary() === "ISO Coated v2 (FOGRA39) · from the host");
    saveRoot(element);
    await until(() => (layoutRoot().conformance?.outputIntent?.profile as { ref?: string } | undefined)?.ref === "icc/fogra39");
    expect(layoutRoot().conformance?.outputIntent?.profile).toEqual(hosted);
    // "Upload a file…" opens the picker and the select goes back to what is set.
    let clicks = 0;
    fileInput()!.click = () => {
      clicks += 1;
    };
    setValue(choice(), "__upload", "change");
    expect(clicks).toBe(1);
    expect(choice().value).toBe("host:fogra39");
    setValue(choice(), "", "change");
    await until(() => summary() === "None");

    const pick = (file: File): void => {
      const input = fileInput()!;
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    // A text file, however named, is refused where it was picked; the draft is untouched.
    pick(new File([new TextEncoder().encode("not a profile at all, whatever the name says")], "press.icc", { type: "" }));
    await until(() => formPanel(element).querySelector("[data-file-error]"));
    expect(formPanel(element).querySelector("[data-file-error]")?.textContent).toContain('"press.icc" is not an ICC profile');
    expect(summary()).toBe("None");
    // One with the wrong type or extension does not even get read.
    pick(new File([new TextEncoder().encode("hello")], "notes.txt", { type: "text/plain" }));
    await until(() => formPanel(element).querySelector("[data-file-error]")?.textContent?.includes("notes.txt"));
    expect(formPanel(element).querySelector("[data-file-error]")?.textContent).toContain("is not a file this property takes");

    // An ICC header: the colour space at 16, the `acsp` signature at 36.
    const icc = new Uint8Array(128);
    icc.set([0x52, 0x47, 0x42, 0x20], 16);
    icc.set([0x61, 0x63, 0x73, 0x70], 36);
    pick(new File([icc], "org.icc", { type: "application/vnd.iccprofile" }));
    await until(() => summary()?.includes("org.icc"));
    expect(summary()).toBe("org.icc · 128 B · kept in the form definition");
    expect(formPanel(element).querySelector("[data-file-error]")).toBeNull();
    // An upload is neither ready-made value: the select shows it as its own, disabled entry.
    expect(choice().value).toBe("__custom");
    // Held in the draft with the level, landed by Save as the attachment envelope.
    setValue(formPanel(element).querySelector('select[data-prop="conformance.pdfa"]')!, "2a", "change");
    saveRoot(element);
    await until(() => (layoutRoot().conformance?.outputIntent?.profile as { storage?: string } | undefined)?.storage === "base64");
    expect(layoutRoot().conformance?.pdfa).toBe("2a");
    expect(layoutRoot().conformance?.outputIntent?.profile).toEqual({
      storage: "base64",
      name: "org.icc",
      type: "application/vnd.iccprofile",
      size: 128,
      data: Buffer.from(icc).toString("base64")
    });

    // Remove clears the property; Save lands that too.
    formPanel(element).querySelector<HTMLButtonElement>("[data-file-clear]")!.click();
    await until(() => summary() === "None");
    expect(formPanel(element).querySelector("[data-file-clear]")).toBeNull();
    saveRoot(element);
    await until(() => layoutRoot().conformance?.outputIntent?.profile === undefined);
    expect(layoutRoot().conformance?.pdfa).toBe("2a");
  });

  it("refuses an uploaded ICC profile that would make the form unloadable, and takes it under a raised limit", async () => {
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()], defaultLayoutId: "letter" } };
    });
    await ready(element);
    const fileInput = () => formPanel(element).querySelector<HTMLInputElement>('input[data-control="file"][data-prop="conformance.outputIntent.profile"]');
    await until(() => fileInput());
    const summary = () => formPanel(element).querySelector("[data-file-summary]")?.textContent;
    const pick = (file: File): void => {
      const input = fileInput()!;
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    // An RGB profile header, padded to 30 KB: base64 inside the definition makes it 40 KB.
    const icc = new Uint8Array(30_000);
    icc.set([0x52, 0x47, 0x42, 0x20], 16);
    icc.set([0x61, 0x63, 0x73, 0x70], 36);

    element.maxDefinitionBytes = 20_000;
    pick(new File([icc], "big.icc", { type: "application/vnd.iccprofile" }));
    await until(() => formPanel(element).querySelector("[data-file-error]"));
    expect(formPanel(element).querySelector("[data-file-error]")?.textContent).toMatch(/"big\.icc" \(30 KB\) would make this form \d+ KB\. A form opens only up to 19 KB/);
    expect(summary()).toBe("None");

    element.maxDefinitionBytes = 200_000;
    pick(new File([icc], "big.icc", { type: "application/vnd.iccprofile" }));
    await until(() => summary()?.includes("big.icc"));
    expect(formPanel(element).querySelector("[data-file-error]")).toBeNull();
  });

  it("draws areas over a PDF that has no fields: on the page viewer, as nodes edited in the inspector, drawn by the kernel", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const provider = fakeProvider(calls);
    // A two-page paper form with no AcroForm at all.
    provider.inspect = async () => ({
      pageCount: 2,
      pages: [
        { index: 1, width: 612, height: 792 },
        { index: 2, width: 612, height: 792 }
      ],
      fields: [],
      hasXfa: false,
      encrypted: false
    });
    provider.fill = async (request) => {
      calls.fills.push(request);
      return {
        bytes: new TextEncoder().encode("%PDF-filled"),
        pageCount: 2,
        pages: [],
        warnings: [],
        providerId: "fake",
        fields: [],
        areas: (request.areas ?? []).map((area) => ({
          id: area.id,
          page: area.page,
          status: area.value === null ? ("empty" as const) : ("filled" as const),
          // A fillable area comes back naming its field, the way the kernel reports it.
          ...(area.field ? { field: area.field.name } : {})
        }))
      };
    };
    const rasterized: number[] = [];
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout(), { ...templateLayout(), fields: [] }], defaultLayoutId: "letter" } };
      el.values = { fullName: "Grace Hopper", subscribe: true };
      el.pdfSupport = {
        provider,
        // A rasteriser that cannot draw (no canvas here): the viewer falls back to blank sheets and still works.
        pages: {
          open: async () => ({
            pageCount: 2,
            pageSize: () => ({ width: 612, height: 792 }),
            render: async (index) => {
              rasterized.push(index);
              throw new Error("no canvas in jsdom");
            },
            close: () => undefined
          })
        }
      };
      el.pdfTemplates = createPdfTemplateResolver({ url: async () => new Uint8Array([1, 2, 3]) });
    });
    await ready(element);
    const changes: DatumPdfLayoutChangeDetail[] = [];
    element.addEventListener("datum-pdf-layout-change", (event) => changes.push((event as CustomEvent<DatumPdfLayoutChangeDetail>).detail));
    const viewer = () => surface(element)!.querySelector<HTMLElement>("[data-template-pages]")!;
    const overlay = (page: number) => viewer().querySelector<SVGSVGElement>(`.dpd-page[data-page="${page}"] .dpd-page__overlay`)!;
    const controller = () => element.pdfMode!.controller;
    const areaNodes = () => controller().snapshot().children?.areas ?? [];
    const paper = () => element.pdfMode!.layouts.find((layout) => layout.kind === "template") as PdfTemplateLayout;
    const pointer = (target: Element, type: string, x: number, y: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));

    element.pdfMode!.selectLayout("paper");
    await until(() => status(element)?.includes("no form fields on 2 pages"));
    expect(status(element)).toContain("draw areas on the pages");
    // The viewer: one sheet per page, with the overlay in the page's own points.
    expect(viewer().querySelectorAll(".dpd-page").length).toBe(2);
    expect(overlay(2).getAttribute("viewBox")).toBe("0 0 612 792");
    await until(() => rasterized.length > 0 && viewer().getAttribute("data-pages-state") === "blank");
    expect(viewer().querySelector("[data-pages-status]")?.textContent).toContain("blank sheets");

    // A drag on empty paper draws an area: one node, one undo entry, selected. jsdom's overlay
    // sits at 0,0 with no width, so the viewer's fit scale is the fallback (300 − 18) / 612 px per point.
    const scale = (300 - 18) / 612;
    pointer(overlay(2), "pointerdown", 30 * scale, 40 * scale);
    pointer(overlay(2), "pointermove", 230 * scale, 54 * scale);
    expect(overlay(2).querySelector("[data-draft]")).toBeTruthy();
    pointer(overlay(2), "pointerup", 230 * scale, 54 * scale);
    expect(overlay(2).querySelector("[data-draft]")).toBeNull();
    await until(() => areaNodes().length === 1);
    const first = areaNodes()[0]!.id;
    expect(controller().selectedComponentId()).toBe(first);
    // The click a browser fires after the drag lands on the surface, not on empty canvas: the
    // canvas must not put the new area down again.
    overlay(2).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(controller().selectedComponentId()).toBe(first);
    expect(controller().getProperty(first, "page")).toBe(2);
    expect(controller().getProperty(first, "rect")).toEqual({ x: 30, y: 40, width: 200, height: 14 });
    expect(overlay(2).querySelector(`[data-area="${first}"].is-selected`)).toBeTruthy();
    expect(overlay(2).querySelectorAll("[data-handle]").length).toBe(8);
    expect(overlay(1).querySelector("[data-area]")).toBeNull();
    // Live: the layout carries the area at once, nothing filling it yet.
    expect(paper().areas).toEqual([{ id: first, page: 2, rect: { x: 30, y: 40, width: 200, height: 14 }, source: { kind: "literal", value: null } }]);
    expect(changes.map((change) => change.reason)).toEqual(["add"]);

    // The inspector edits the rectangle; the box on the page follows the draft before Save.
    await until(() => prop(element, "rect.x"));
    setValue(prop(element, "rect.x"), "62", "input");
    expect(overlay(2).querySelector(`[data-area="${first}"] .dpd-area__box`)?.getAttribute("x")).toBe("62");
    expect(paper().areas?.[0]?.rect.x).toBe(30);
    // A nudge from the keyboard joins the open draft rather than landing under it.
    overlay(2).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    expect((controller().draftProperty(first, "rect") as { x: number }).x).toBe(72);
    expect(paper().areas?.[0]?.rect.x).toBe(30);
    // Fill it from a component and name it; Save lands it all as one edit.
    setValue(prop(element, "source.kind"), "component", "change");
    setValue(prop(element, "source.componentId"), "fullName", "change");
    setValue(prop(element, "label"), "Name", "input");
    save(element);
    expect(paper().areas?.[0]).toEqual({ id: first, label: "Name", page: 2, rect: { x: 72, y: 40, width: 200, height: 14 }, source: { kind: "component", componentId: "fullName" } });
    expect(changes.map((change) => change.reason)).toEqual(["add", "edit"]);

    // A check-mark area from the palette, on the first page, then a nudge with nothing drafted lands at once.
    const toolbar = shell(element).querySelector("datum-builder-toolbar")!.shadowRoot!;
    toolbar.querySelector<HTMLButtonElement>('[data-add-type="pdf-area"]')!.click();
    await until(() => areaNodes().length === 2);
    const second = areaNodes()[1]!.id;
    expect(controller().selectedComponentId()).toBe(second);
    expect(overlay(1).querySelector(`[data-area="${second}"]`)).toBeTruthy();
    overlay(1).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(paper().areas?.[1]?.rect.y).toBe(73);
    setValue(prop(element, "draw.kind"), "check", "change");
    setValue(prop(element, "source.kind"), "component", "change");
    setValue(prop(element, "source.componentId"), "subscribe", "change");
    save(element);
    expect(overlay(1).querySelector(`[data-area="${second}"].dpd-area--check`)).toBeTruthy();
    expect(paper().areas?.[1]).toEqual({ id: second, page: 1, rect: { x: 72, y: 73, width: 144, height: 18 }, source: { kind: "component", componentId: "subscribe" }, draw: { kind: "check" } });

    // The first area becomes a fillable text field; the viewer marks it.
    controller().select(first);
    await until(() => prop(element, "field.enabled"));
    setChecked(prop(element, "field.enabled"), true);
    setValue(prop(element, "field.name"), "applicant_name", "input");
    setChecked(prop(element, "field.required"), true);
    save(element);
    expect(paper().areas?.[0]?.field).toEqual({ name: "applicant_name", required: true });
    expect(overlay(2).querySelector(`[data-area="${first}"].dpd-area--field`)).toBeTruthy();
    expect(overlay(2).querySelector(`[data-area="${first}"] .dpd-area__label`)?.textContent).toBe("⌨ Name");

    // A preview sends the areas as they stand and lists what the kernel made of them, field names included.
    await element.pdfMode!.previewPdf();
    const request = calls.fills.at(-1) as { areas?: Array<{ id: string; value: unknown; page: number; field?: { name: string; required: boolean } }> };
    expect(request.areas?.map((area) => [area.id, area.page, area.value, area.field])).toEqual([
      [first, 2, "Grace Hopper", { name: "applicant_name", required: true, readOnly: false, tooltip: "Name" }],
      [second, 1, true, undefined]
    ]);
    const preview = shell(element).querySelector<HTMLDialogElement>("[data-preview-dialog]")!;
    expect(preview.querySelector(`[data-area-report="${first}"]`)?.textContent).toContain("(area, p.2): filled · field “applicant_name”");
    preview.querySelector<HTMLButtonElement>('[data-action="close"]')!.click();

    // Back to page content: the field block goes.
    setChecked(prop(element, "field.enabled"), false);
    save(element);
    expect(paper().areas?.[0]).not.toHaveProperty("field");
    expect(overlay(2).querySelector(`[data-area="${first}"].dpd-area--field`)).toBeNull();

    // Delete on the page removes the selected area; the API removes another; undo brings one back.
    pointer(overlay(2).querySelector(`[data-area="${first}"] .dpd-area__box`)!, "pointerdown", 100 * scale, 45 * scale);
    pointer(overlay(2), "pointerup", 100 * scale, 45 * scale);
    overlay(2).dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await until(() => areaNodes().length === 1);
    expect(areaNodes()[0]!.id).toBe(second);
    controller().remove(second);
    expect(paper().areas).toBeUndefined();
    controller().undo();
    expect(paper().areas?.map((area) => area.id)).toEqual([second]);
  });

  it("leaves the page imagery out for pdf-pages=\"off\" and when its module cannot load", async () => {
    const calls = { renders: [] as unknown[], fills: [] as unknown[] };
    const element = mount((el) => {
      el.setAttribute("pdf", "/nowhere/datum-pdf.js");
      el.setAttribute("pdf-pages", "off");
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()] } };
    });
    await ready(element);
    expect(element.pdfPages).toBe("off");
    // With a support the page built itself, the element uses it as given: no imagery unless it carries some.
    const supported = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [{ ...templateLayout(), fields: [] }] } };
      el.pdfSupport = { provider: fakeProvider(calls) };
      el.pdfTemplates = createPdfTemplateResolver({ url: async () => new Uint8Array([1, 2, 3]) });
    });
    await until(() => supported.pdfMode!.ready && supported.pdfMode!.pdfLayout?.kind === "template");
    const viewer = surface(supported)?.querySelector<HTMLElement>("[data-template-pages]");
    await until(() => viewer?.getAttribute("data-pages-state") === "blank");
    expect(viewer?.querySelector("[data-pages-status]")?.textContent).toBe("No page images — blank sheets");
  });
});

describe("Load a PDF checks the file before embedding it", () => {
  function popover() {
    const host = document.createElement("div");
    document.body.append(host);
    const calls: Array<{ name: string; dataLength: number }> = [];
    const pop = createAddPopover(host, {
      templates: async () => [],
      canPopulate: () => true,
      locale: () => "en",
      translations: () => undefined,
      onCustom: () => undefined,
      onTemplate: (source: { name: string; data?: string }) => {
        calls.push({ name: source.name, dataLength: source.data?.length ?? 0 });
      }
    } as never);
    pop.open(undefined);
    return { host, calls };
  }

  async function pick(host: HTMLElement, file: File): Promise<void> {
    // jsdom's File has no arrayBuffer(); give it one over the same bytes, as browsers do
    if (typeof (file as unknown as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
      const buffer = await new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(file);
      });
      Object.defineProperty(file, "arrayBuffer", { value: async () => buffer });
    }
    const input = host.querySelector<HTMLInputElement>("[data-add-file]")!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    // An accepted file waits for its layout's name: the suggestion is accepted here.
    host.querySelector<HTMLButtonElement>("[data-add-confirm]")?.click();
  }

  const errorOf = (host: HTMLElement): string => host.querySelector("[data-add-error]")?.textContent ?? "";

  it("accepts a real PDF header", async () => {
    const { host, calls } = popover();
    await pick(host, new File([new TextEncoder().encode("%PDF-1.4\n%%EOF\n")], "good.pdf", { type: "application/pdf" }));
    expect(calls.map((c) => c.name)).toEqual(["good.pdf"]);
  });

  it("refuses a text file named .pdf with a message", async () => {
    const { host, calls } = popover();
    await pick(host, new File(["<html><script>window.AUDIT_XSS=1</script></html>"], "report.pdf", { type: "application/pdf" }));
    expect(calls).toEqual([]);
    expect(errorOf(host)).toContain("not a PDF");
  });

  it("refuses an empty file", async () => {
    const { host, calls } = popover();
    await pick(host, new File([], "empty.pdf", { type: "application/pdf" }));
    expect(calls).toEqual([]);
    expect(errorOf(host)).toContain("empty");
  });

  it("refuses a file over the cap without reading it", async () => {
    const { host, calls } = popover();
    const file = new File(["%PDF-1.7"], "huge.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: MAX_PDF_TEMPLATE_BYTES + 1 });
    Object.defineProperty(file, "arrayBuffer", { value: async () => { throw new Error("read whole"); } });
    await pick(host, file);
    expect(calls).toEqual([]);
    expect(errorOf(host)).toContain("larger than");
  });
});
