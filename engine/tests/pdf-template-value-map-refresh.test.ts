// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createPdfBuilderMode } from "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import type { PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { PdfTemplateInfo } from "../form-engine/render/pdf/pdf-abi.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import type { PdfRenderProvider } from "../form-engine/render/pdf/pdf-provider.js";

/**
 * How the Values section follows the form. The PDF mode reads the form
 * whenever it activates, which is each time the author comes back to the PDF workspace: the
 * form's components cannot be edited while the PDF designer is on the page, so there is nothing
 * to subscribe to. These tests edit the source component through the form's own controller and
 * come back, as the shell does.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Claim" },
  children: {
    content: [{ id: "change", type: "radio", configuration: { label: "Change", options: [{ value: "improved", label: "Improved" }, { value: "unchanged", label: "Unchanged" }, { value: "worsened", label: "Worsened" }] } }]
  }
};

const INSPECTION: PdfTemplateInfo = {
  pageCount: 1,
  pages: [{ index: 1, width: 612, height: 792 }],
  fields: [{ name: "Since", kind: "radio", page: 1, rect: { x: 10, y: 600, width: 12, height: 12 }, options: ["1", "2", "3"], readOnly: false, required: false }],
  hasXfa: false,
  encrypted: false
};

const TEMPLATE = { storage: "base64", name: "paper.pdf", type: "application/pdf", size: 3, data: "AAA=" } as const;

const until = async (check: () => unknown): Promise<void> => {
  for (let tries = 0; tries < 400 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBeTruthy();
};

async function open(inspection: PdfTemplateInfo = INSPECTION) {
  // A clone each time, as a host handing the mode snapshots would: the form controller shares
  // its nodes with a snapshot, so the designer would otherwise see an edit before the sync.
  const form = new BuilderController({ initialRoot: structuredClone(FORM) });
  const layout: PdfTemplateLayout = {
    id: "paper",
    kind: "template",
    template: TEMPLATE,
    fields: [{ pdfField: "Since", source: { kind: "component", componentId: "change" }, values: { improved: "1", unchanged: "2", worsened: "3" } }]
  };
  const provider = { id: "fake", abiVersion: "4.0.0", inspect: async () => inspection, render: async () => ({}) } as unknown as PdfRenderProvider;
  const mode = createPdfBuilderMode({ formRoot: () => structuredClone(form.snapshot()), form: () => form, runtime: () => ({}) as RenderableRuntime, pdf: { layouts: [layout], defaultLayoutId: "paper" }, support: { provider } });
  let surface: HTMLElement | undefined;
  const host = document.createElement("div");
  document.body.append(host);
  const context = { host, root: host.attachShadow({ mode: "open" }), showCanvasSurface: (next: HTMLElement | undefined) => (surface = next) };
  await mode.activate!(context);
  await until(() => mode.templateDesigner?.inspection !== undefined && mode.controller.snapshot().children?.widgets?.length === 1);
  const widget = "widget_since";
  const valuesField = () => mode.controller.inspectorModel(widget)!.sections.flatMap((section) => section.fields).find((field) => field.control === "value-map");
  const notes = () => mode.controller.notesOf(widget).filter((note) => note.target === "values").map((note) => note.message);
  const staleLine = () => surface!.querySelector<HTMLElement>("[data-template-stale]")!;
  return { form, mode, context, widget, valuesField, notes, staleLine, layout: () => mode.layouts.find((entry) => entry.id === "paper") as PdfTemplateLayout };
}

describe("the Values section after the form's options change", () => {
  it("starts with a matching map: no notes beyond none, the stale line hidden", async () => {
    const { valuesField, notes, staleLine } = await open();
    expect(valuesField()!.valueMap!.rows.map((row) => row.value)).toEqual(["improved", "unchanged", "worsened"]);
    expect(valuesField()!.valueMap!.stale).toEqual([]);
    expect(notes()).toEqual([]);
    expect(staleLine().hidden).toBe(true);
  });

  it("follows a renamed and a removed option when the PDF workspace is entered again, and not before", async () => {
    const { form, mode, context, valuesField, notes, staleLine, layout } = await open();
    // On the Form side: "unchanged" renamed to "kept", "worsened" removed.
    form.setProperty("change", "options", [{ value: "improved", label: "Improved" }, { value: "kept", label: "Kept" }]);

    // Nothing subscribes to the form while the designer is up (the form cannot be edited there):
    // the designer still stands over the form it was built on until the mode is entered again.
    expect(valuesField()!.valueMap!.rows.map((row) => row.value)).toEqual(["improved", "unchanged", "worsened"]);

    await mode.activate!(context);
    await until(() => valuesField()!.valueMap!.rows.map((row) => row.value).join() === "improved,kept");
    expect(valuesField()!.valueMap!.rows.map((row) => [row.value, row.target])).toEqual([
      ["improved", "1"],
      ["kept", ""]
    ]);
    expect(valuesField()!.valueMap!.stale).toEqual(["unchanged", "worsened"]);
    expect(notes()).toEqual([
      expect.stringMatching(/^Not matched to an option of this PDF field: "Kept"/),
      'Entries for options this form no longer has: "unchanged" and "worsened". They translate nothing now.'
    ]);
    expect(staleLine().hidden).toBe(false);
    expect(staleLine().textContent).toBe('1 field has value-map entries that no longer match: "Since".');
    // Reported, not removed: the layout still holds every entry until the author says.
    expect(layout().fields[0]!.values).toEqual({ improved: "1", unchanged: "2", worsened: "3" });
  });

  it("removes the stale entries on request as one undo step, and the notes and the line go", async () => {
    const { form, mode, context, widget, valuesField, notes, staleLine, layout } = await open();
    form.setProperty("change", "options", [{ value: "improved", label: "Improved" }, { value: "kept", label: "Kept" }]);
    await mode.activate!(context);
    await until(() => valuesField()!.valueMap!.stale.length === 2);

    // What the panel's button does: the stale keys leave the map in the one edit.
    const stale = valuesField()!.valueMap!.stale;
    const kept = Object.fromEntries(Object.entries(mode.controller.getProperty(widget, "values") as Record<string, string>).filter(([key]) => !stale.includes(key)));
    mode.controller.setProperty(widget, "values", kept);
    expect(layout().fields[0]!.values).toEqual({ improved: "1" });
    // What is left is the not-matched notice for the new option; nothing about stale entries.
    expect(notes()).toEqual([expect.stringMatching(/^Not matched to an option of this PDF field: "Kept"/)]);
    expect(valuesField()!.valueMap!.stale).toEqual([]);
    expect(staleLine().hidden).toBe(true);

    mode.controller.undo();
    expect(layout().fields[0]!.values).toEqual({ improved: "1", unchanged: "2", worsened: "3" });
    expect(notes()).toHaveLength(2);
    expect(staleLine().hidden).toBe(false);
  });

  it("names a mapping whose PDF field lists other export values, as a swapped template would", async () => {
    const swapped: PdfTemplateInfo = { ...INSPECTION, fields: [{ ...INSPECTION.fields[0]!, options: ["A", "B", "C"] }] };
    const { notes, staleLine, valuesField } = await open(swapped);
    expect(valuesField()!.valueMap!.stale).toEqual(["improved", "unchanged", "worsened"]);
    expect(notes()).toEqual([expect.stringMatching(/"1", "2", and "3" are not export values of this PDF field/)]);
    expect(staleLine().textContent).toContain('"Since"');
  });
});
