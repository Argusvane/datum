// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createAddPopover, layoutNameForFile } from "../form-engine/builder/pdf-designer/pdf-designer-panels.js";
import { createPdfBuilderMode } from "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import { defineBuilderOverview, type DatumBuilderOverviewElement } from "../form-engine/builder/overview/overview-surface.js";
import type { PdfConfiguration, PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { PdfTemplateInfo } from "../form-engine/render/pdf/pdf-abi.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import type { PdfRenderProvider } from "../form-engine/render/pdf/pdf-provider.js";

/**
 * The PDF designer's part of the new-user fixes: the note Suggest mappings leaves, the
 * name asked for when a layout is made and the actions a PDF with no fields does not offer,
 * and the PDF layouts overview naming a binding whose field was deleted.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const until = async (check: () => unknown): Promise<void> => {
  for (let tries = 0; tries < 400 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBeTruthy();
};

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Claim" },
  children: {
    content: [
      { id: "name", type: "text", configuration: { label: "Name" } },
      { id: "colour", type: "radio", configuration: { label: "Colour", options: [{ value: "red", label: "Red" }, { value: "green", label: "Green" }] } },
      { id: "phone", type: "text", configuration: { label: "Phone" } },
      { id: "submit", type: "button", configuration: { label: "Send", action: "submit" } }
    ]
  }
};

const FIELDS: PdfTemplateInfo = {
  pageCount: 1,
  pages: [{ index: 1, width: 612, height: 792 }],
  fields: [
    { name: "Name", kind: "text", page: 1, rect: { x: 10, y: 700, width: 100, height: 14 }, readOnly: false, required: false },
    { name: "Colour", kind: "radio", page: 1, rect: { x: 10, y: 600, width: 12, height: 12 }, options: ["1", "2"], readOnly: false, required: false }
  ],
  hasXfa: false,
  encrypted: false
};

const NO_FIELDS: PdfTemplateInfo = { ...FIELDS, fields: [] };

const TEMPLATE = { storage: "base64", name: "paper.pdf", type: "application/pdf", size: 3, data: "AAA=" } as const;

async function open(inspection: PdfTemplateInfo, fields: PdfTemplateLayout["fields"] = []) {
  const form = new BuilderController({ initialRoot: structuredClone(FORM) });
  const layout: PdfTemplateLayout = { id: "paper", kind: "template", template: TEMPLATE, fields };
  const provider = { id: "fake", abiVersion: "1.0.0", inspect: async () => inspection, render: async () => ({}) } as unknown as PdfRenderProvider;
  const mode = createPdfBuilderMode({ formRoot: () => structuredClone(form.snapshot()), form: () => form, runtime: () => ({}) as RenderableRuntime, pdf: { layouts: [layout], defaultLayoutId: "paper" }, support: { provider } });
  let surface: HTMLElement | undefined;
  const host = document.createElement("div");
  document.body.append(host);
  const context = { host, root: host.attachShadow({ mode: "open" }), showCanvasSurface: (next: HTMLElement | undefined) => (surface = next), holdForInspector: (run: () => void) => (run(), true) };
  await mode.activate!(context);
  await until(() => mode.templateDesigner?.inspection !== undefined && surface !== undefined);
  const bar = (selector: string): HTMLButtonElement => (mode.barActions ?? []).find((button) => button.matches(selector)) as HTMLButtonElement;
  return { form, mode, surface: () => surface!, bar };
}

describe("the note after Suggest mappings", () => {
  it("counts the fields mapped, names the form fields the PDF leaves out and the fields whose options do not line up", async () => {
    const { mode, surface } = await open(FIELDS);
    expect(surface().querySelector<HTMLElement>("[data-template-summary]")!.hidden).toBe(true);

    expect(mode.suggestMappings()).toBe(2);

    const note = surface().querySelector<HTMLElement>("[data-template-summary]")!;
    expect(note.hidden).toBe(false);
    // Read aloud as it arrives.
    expect(note.getAttribute("role")).toBe("status");
    expect(note.querySelector("[data-template-summary-text]")!.textContent).toBe(
      '2 PDF fields mapped (2 just now). 1 form field not placed on this PDF: "Phone". 1 option mismatch: "Colour".'
    );
    expect(note.querySelector("[data-template-summary-dismiss]")!.textContent).toBe("Dismiss");
  });

  it("says nothing was new and that all is placed when a second run finds the same, and the form field mapped by hand counts as placed", async () => {
    const { mode, surface } = await open(FIELDS);
    mode.suggestMappings();
    // Phone is answered by the PDF's Name field now (a hand-made mapping, as the inspector would write it).
    const widget = mode.templateDesigner!.widgetIdFor("Name")!;
    mode.controller.setProperty(widget, "source", { kind: "component", componentId: "phone" });
    expect(mode.suggestMappings()).toBe(0);

    const text = surface().querySelector("[data-template-summary-text]")!.textContent!;
    // Name is not placed (nothing reads it), Phone is: the note follows the tree as it stands, not the guess.
    expect(text).toBe('2 PDF fields mapped (none new). 1 form field not placed on this PDF: "Name". 1 option mismatch: "Colour".');
  });

  it("is dismissed with its own button and stays dismissed until the next suggestion", async () => {
    const { mode, surface } = await open(FIELDS);
    mode.suggestMappings();
    const note = surface().querySelector<HTMLElement>("[data-template-summary]")!;
    surface().querySelector<HTMLButtonElement>("[data-template-summary-dismiss]")!.click();
    expect(note.hidden).toBe(true);
    mode.suggestMappings();
    expect(note.hidden).toBe(false);
  });

  it("goes when the tree changes under it, rather than stating counts that no longer hold", async () => {
    const { mode, surface } = await open(FIELDS);
    mode.suggestMappings();
    const note = surface().querySelector<HTMLElement>("[data-template-summary]")!;
    expect(note.hidden).toBe(false);
    const widget = mode.templateDesigner!.widgetIdFor("Name")!;
    mode.controller.setProperty(widget, "source", { kind: "component", componentId: "phone" });
    expect(note.hidden).toBe(true);
  });
});

describe("a PDF with no fillable fields", () => {
  it("offers neither Suggest mappings nor Create form fields, and says so instead of 'filled already'", async () => {
    const { mode, bar, surface } = await open(NO_FIELDS);
    expect(bar("[data-suggest-mappings]").hidden).toBe(true);
    expect(bar("[data-create-form-fields]").hidden).toBe(true);

    const result = await mode.createFormFields();
    expect(result).toMatchObject({ added: [], mapped: 0 });
    const status = surface().querySelector("[data-template-status]")!.textContent;
    expect(status).toBe("This PDF has no fillable fields.");
    expect(status).not.toMatch(/filled already/);
  });

  it("offers both for a PDF that has fields", async () => {
    const { bar } = await open(FIELDS);
    expect(bar("[data-suggest-mappings]").hidden).toBe(false);
    expect(bar("[data-create-form-fields]").hidden).toBe(false);
  });
});

describe("naming a layout when it is made", () => {
  const FILE = new File([new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n")], "customer_intake-v2.pdf", { type: "application/pdf" });

  function popover(extra: { copyName?: () => string | undefined } = {}) {
    const host = document.createElement("div");
    document.body.append(host);
    const made: Array<{ kind: string; name: string }> = [];
    let dismissed = 0;
    const pop = createAddPopover(host, {
      locale: () => "en",
      templates: async () => [],
      canPopulate: () => true,
      onCustom: (from, name) => made.push({ kind: from, name }),
      onTemplate: (_source, name) => made.push({ kind: "template", name }),
      ...extra
    });
    pop.open(undefined, { onDismiss: () => (dismissed += 1) });
    const input = () => host.querySelector<HTMLInputElement>("[data-add-name]");
    return { host, pop, made, input, dismissed: () => dismissed };
  }

  it("makes the stem readable for the suggestion", () => {
    expect(layoutNameForFile("customer_intake-v2.pdf")).toBe("Customer intake v2");
    expect(layoutNameForFile("CustomerIntake.pdf")).toBe("Customer Intake");
    expect(layoutNameForFile("f1040.PDF")).toBe("F1040");
    expect(layoutNameForFile(".pdf")).toBe("Paper form");
  });

  it("asks for a name before a custom layout is made; Enter accepts the suggestion", () => {
    const { host, made, input, pop } = popover();
    host.querySelector<HTMLButtonElement>('[data-add-custom="blank"]')!.click();
    expect(made).toEqual([]);
    expect(input()!.value).toBe("Blank layout");
    expect(host.contains(document.activeElement) || document.activeElement === input()).toBe(true);

    input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(made).toEqual([{ kind: "blank", name: "Blank layout" }]);
    expect(pop.isOpen).toBe(false);
  });

  it("takes the name the author typed, and falls back to the suggestion for a blank box", () => {
    const first = popover();
    first.host.querySelector<HTMLButtonElement>('[data-add-custom="form"]')!.click();
    first.input()!.value = "  Cover sheet ";
    first.host.querySelector<HTMLButtonElement>("[data-add-confirm]")!.click();
    expect(first.made).toEqual([{ kind: "form", name: "Cover sheet" }]);

    const second = popover();
    second.host.querySelector<HTMLButtonElement>('[data-add-custom="form"]')!.click();
    second.input()!.value = "   ";
    second.host.querySelector<HTMLButtonElement>("[data-add-confirm]")!.click();
    expect(second.made).toEqual([{ kind: "form", name: "Custom layout" }]);
  });

  it("offers the copy's usual name for a copy", () => {
    const { host, made, input } = popover({ copyName: () => "Intake (copy)" });
    host.querySelector<HTMLButtonElement>('[data-add-custom="copy"]')!.click();
    expect(input()!.value).toBe("Intake (copy)");
    host.querySelector<HTMLButtonElement>("[data-add-confirm]")!.click();
    expect(made).toEqual([{ kind: "copy", name: "Intake (copy)" }]);
  });

  it("suggests the prettified file stem for an uploaded PDF", async () => {
    const { host, made, input } = popover();
    const file = host.querySelector<HTMLInputElement>("[data-add-file]")!;
    // jsdom's File has no arrayBuffer(); give it one over the same bytes, as browsers do.
    Object.defineProperty(FILE, "arrayBuffer", { configurable: true, value: async () => new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n").buffer });
    Object.defineProperty(file, "files", { value: [FILE] });
    file.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => input());
    expect(input()!.value).toBe("Customer intake v2");
    expect(made).toEqual([]);
    input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(made).toEqual([{ kind: "template", name: "Customer intake v2" }]);
  });

  it("makes nothing on Escape, and the flow is dismissed", () => {
    const { host, made, input, pop, dismissed } = popover();
    host.querySelector<HTMLButtonElement>('[data-add-custom="blank"]')!.click();
    input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(made).toEqual([]);
    expect(pop.isOpen).toBe(false);
    expect(dismissed()).toBe(1);
    // Opened again, it starts at the choices, not at a leftover name.
    pop.open(undefined);
    expect(host.querySelector("[data-add-name]")).toBeNull();
    expect(host.querySelector('[data-add-custom="blank"]')).not.toBeNull();
  });

  it("does not redraw the name box when the host's PDFs arrive late", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    let release: (value: never[]) => void = () => undefined;
    const pop = createAddPopover(host, {
      locale: () => "en",
      templates: () => new Promise((resolve) => (release = resolve as typeof release)),
      canPopulate: () => true,
      onCustom: () => undefined,
      onTemplate: () => undefined
    });
    pop.open(undefined);
    host.querySelector<HTMLButtonElement>('[data-add-custom="blank"]')!.click();
    const input = host.querySelector<HTMLInputElement>("[data-add-name]")!;
    input.value = "Typed";
    release([]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(host.querySelector("[data-add-name]")).toBe(input);
    expect(input.value).toBe("Typed");
  });

  it("makes the layout through the mode under the confirmed name", async () => {
    const mode = createPdfBuilderMode({ formRoot: () => structuredClone(FORM), runtime: () => ({}) as RenderableRuntime, pdf: { layouts: [] } });
    const host = document.createElement("div");
    host.append(...(mode.overlays ?? []));
    document.body.append(host);
    mode.openAdd();
    const add = mode.overlays![1]!;
    await until(() => add.querySelector('[data-add-custom="form"]'));
    add.querySelector<HTMLButtonElement>('[data-add-custom="form"]')!.click();
    const input = add.querySelector<HTMLInputElement>("[data-add-name]")!;
    input.value = "Claim summary";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(mode.layouts.map((layout) => [layout.id, layout.name])).toEqual([["claim-summary", "Claim summary"]]);
  });
});

describe("the PDF layouts overview and a deleted field", () => {
  const pdf: PdfConfiguration = {
    layouts: [
      {
        id: "paper",
        kind: "template",
        name: "Paper claim",
        template: TEMPLATE,
        fields: [
          { pdfField: "Name", source: { kind: "component", componentId: "name" } },
          { pdfField: "Tel", source: { kind: "component", componentId: "phone" } }
        ]
      },
      {
        id: "summary",
        kind: "generated",
        name: "Summary",
        root: {
          id: "document",
          type: "pdf-document",
          configuration: {},
          children: { body: [{ id: "f1", type: "pdf-field", configuration: { componentId: "colour" } }], header: [], footer: [] }
        }
      }
    ]
  } as unknown as PdfConfiguration;

  async function overview() {
    defineBuilderOverview();
    const form = new BuilderController({ initialRoot: structuredClone(FORM) });
    const element = document.createElement("datum-builder-overview") as DatumBuilderOverviewElement;
    document.body.append(element);
    element.definition = () => ({ id: "claim", version: "1", root: form.snapshot(), pdf }) as unknown as FormDefinition;
    element.controller = form;
    element.section = "pdf";
    const root = element.shadowRoot!;
    const problems = () => [...root.querySelectorAll("[data-overview-problem]")].map((item) => item.textContent!.replace(/^!/, ""));
    const section = () => root.querySelector(".section-head .status")!.textContent!.replace(/^!/, "");
    return { form, problems, section, root };
  }

  it("names a layout in the preview language from the form's translations", async () => {
    defineBuilderOverview();
    const form = new BuilderController({
      initialRoot: structuredClone(FORM),
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
      translations: { fr: { pdf: { paper: { name: { text: "Dossier papier", source: "x" } } } } }
    });
    const element = document.createElement("datum-builder-overview") as DatumBuilderOverviewElement;
    document.body.append(element);
    element.definition = () =>
      ({ id: "claim", version: "1", root: form.snapshot(), pdf, localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] } }) as unknown as FormDefinition;
    element.controller = form;
    element.section = "pdf";
    const names = (): string[] => [...element.shadowRoot!.querySelectorAll(".out-card strong")].map((item) => item.textContent!);
    expect(names()).toEqual(["Paper claim", "Summary"]);
    form.setOptions({ locale: "fr" });
    expect(names()).toEqual(["Dossier papier", "Summary"]);
  });

  it("shows no problems while every bound field is in the form", async () => {
    const { problems, section } = await overview();
    expect(problems()).toEqual([]);
    expect(section()).toBe("No problems");
  });

  it("names a deleted field on the layouts that bind it, counts it in the section, and clears when the delete is undone", async () => {
    const { form, problems, section, root } = await overview();

    form.remove("phone");
    expect(problems()).toEqual(['Field "phone" is not in the form']);
    expect(section()).toBe("1 problem");
    const card = [...root.querySelectorAll(".out-card")].find((item) => item.querySelector("strong")!.textContent === "Paper claim")!;
    expect(card.querySelector("[data-overview-problem]")!.textContent).toContain('Field "phone" is not in the form');

    // A generated layout's field binds by id as well.
    form.remove("colour");
    expect(problems()).toEqual(['Field "phone" is not in the form', 'Field "colour" is not in the form']);
    expect(section()).toBe("2 problems");

    form.undo();
    form.undo();
    expect(problems()).toEqual([]);
    expect(section()).toBe("No problems");
  });
});
