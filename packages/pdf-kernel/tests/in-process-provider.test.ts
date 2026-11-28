import { describe, expect, it } from "vitest";

import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, TextAlignment } from "@cantoo/pdf-lib";
import type { ComponentNode } from "@argusvane/datum-engine/core";
import {
  PDF_ABI_VERSION,
  PdfKernelError,
  buildPdfFillRequest,
  buildPdfInspectRequest,
  buildPdfLayoutRequest,
  buildPdfRenderRequest,
  bytesToBase64,
  DEFAULT_TEMPLATE_FILL_OPTIONS,
  type PdfDocumentRequest,
  type PdfFillArea,
  type PdfFillPlan
} from "@argusvane/datum-engine/render";
import { DEFAULT_PDF_AREA_DRAW, MAX_PDF_TEMPLATE_BYTES } from "@argusvane/datum-engine/core";
import { createInProcessPdfProvider } from "../src/in-process-provider.js";
import { PDF_PROGRAM_VERSION, handlePdfRequest, handlePdfRequestJson } from "../src/program/entry.js";
import { detachedTemplateBytes, document, ENV, extractText, fonts, head, paragraph, PDF_MAGIC, PLAN_THEME, reload, widgetsShown } from "./helpers.js";

function form(): ComponentNode {
  return {
    id: "intake",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name" } },
        { id: "vip", type: "checkbox", configuration: { label: "VIP" } },
        {
          id: "vipCode",
          type: "text",
          configuration: { label: "VIP code" },
          rules: { visibleWhen: "vip" }
        },
        { id: "country", type: "select", configuration: { label: "Country", data: { sourceId: "countries" } } }
      ]
    }
  };
}

function documentRequest(values: Record<string, unknown>, fontsList: Awaited<ReturnType<typeof fonts>>): PdfDocumentRequest {
  return {
    abi: PDF_ABI_VERSION,
    op: "document",
    form: form(),
    values,
    locale: "en",
    optionSnapshot: { country: [{ value: "CA", label: "Canada" }] },
    fonts: fontsList,
    env: ENV
  };
}

/** A template PDF with the field kinds a government form has. */
async function templateBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const page = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const formApi = pdf.getForm();
  const name = formApi.createTextField("Name");
  name.addToPage(page, { x: 20, y: 340, width: 200, height: 20, font });
  const agree = formApi.createCheckBox("Agree");
  agree.addToPage(page, { x: 20, y: 300, width: 14, height: 14 });
  const colour = formApi.createRadioGroup("Colour");
  colour.addOptionToPage("Red", page, { x: 20, y: 260, width: 14, height: 14 });
  colour.addOptionToPage("Green", page, { x: 60, y: 260, width: 14, height: 14 });
  const country = formApi.createDropdown("Country");
  country.addOptions(["Canada", "France"]);
  country.addToPage(page, { x: 20, y: 220, width: 200, height: 20, font });
  const list = formApi.createOptionList("Toppings");
  list.addOptions(["Olives", "Onions"]);
  list.enableMultiselect();
  list.addToPage(page, { x: 20, y: 140, width: 200, height: 60, font });
  return pdf.save({ useObjectStreams: false, objectsPerTick: Infinity });
}

/** A template whose AcroForm carries XFA beside its fields. */
async function xfaTemplateBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const page = pdf.addPage([400, 400]);
  const formApi = pdf.getForm();
  formApi.createTextField("Name").addToPage(page, { x: 20, y: 340, width: 200, height: 20, font: await pdf.embedFont(StandardFonts.Helvetica) });
  formApi.acroForm.dict.set(PDFName.of("XFA"), pdf.context.obj([PDFString.of("template"), pdf.context.register(pdf.context.stream("<xdp/>"))]));
  return pdf.save({ useObjectStreams: false, objectsPerTick: Infinity, updateFieldAppearances: false });
}

describe("in-process provider", () => {
  const provider = createInProcessPdfProvider();

  it("answers capabilities and renders, lays out and reports through the ABI", async () => {
    const capabilities = await provider.capabilities!();
    expect(capabilities.abi).toBe(PDF_ABI_VERSION);
    expect(capabilities.kernelVersion).toBe(PDF_PROGRAM_VERSION);

    const doc = document([paragraph("p", "Provider text")]);
    const rendered = await provider.render(buildPdfRenderRequest(doc, await fonts(), ENV));
    expect(head(rendered.bytes)).toBe(PDF_MAGIC);
    expect(rendered.pageCount).toBe(1);
    expect(rendered.providerId).toBe("datum-pdf-kernel");
    const laid = await provider.layout!(buildPdfLayoutRequest(doc, await fonts(), ENV));
    expect(laid.pages[0]!.blockIds).toEqual(["p"]);
  });

  it("renders a form from its tree and values in one `document` call, evaluating the rules inside", async () => {
    const list = await fonts();
    const hidden = await provider.document!(documentRequest({ name: "Ada", vip: false, vipCode: "SECRET", country: "CA" }, list));
    const shown = await provider.document!(documentRequest({ name: "Ada", vip: true, vipCode: "SECRET", country: "CA" }, list));
    expect(head(hidden.bytes)).toBe(PDF_MAGIC);
    const hiddenText = (await extractText(hidden.bytes))[0]!;
    const shownText = (await extractText(shown.bytes))[0]!;
    expect(hiddenText).toContain("Ada");
    expect(hiddenText).toContain("Canada");
    expect(hiddenText).not.toContain("SECRET");
    expect(shownText).toContain("SECRET");
  });

  it("evaluates rules by component id and prints entries by key when answers are keyed", async () => {
    const keyed: ComponentNode = {
      id: "intake",
      type: "form",
      configuration: { title: "Intake" },
      children: {
        content: [
          {
            id: "member",
            type: "container",
            configuration: { label: "Membership", dataKey: "membership" },
            children: { content: [{ id: "vip_flag", type: "checkbox", configuration: { label: "VIP", dataKey: "vip" } }] }
          },
          { id: "vipCode", type: "text", configuration: { label: "VIP code" }, rules: { visibleWhen: "vip_flag" } },
          {
            id: "order",
            type: "container",
            configuration: { label: "Order" },
            children: {
              content: [
                {
                  id: "order_items",
                  type: "panel",
                  configuration: { label: "Items" },
                  collection: { collectionPath: "order.items" },
                  children: { content: [{ id: "item_name", type: "text", configuration: { label: "Item", dataKey: "name" } }] }
                }
              ]
            }
          }
        ]
      }
    };
    const list = await fonts();
    const request = (vip: boolean): PdfDocumentRequest => ({
      abi: PDF_ABI_VERSION,
      op: "document",
      form: keyed,
      values: { "membership.vip": vip, vipCode: "SECRET", "order.items[0].name": "Widget", "order.items[1].name": "Gadget" },
      locale: "en",
      fonts: list,
      env: ENV
    });
    const shown = (await extractText((await provider.document!(request(true))).bytes)).join("\n");
    const hidden = (await extractText((await provider.document!(request(false))).bytes)).join("\n");
    expect(shown).toContain("SECRET");
    expect(hidden).not.toContain("SECRET");
    expect(shown).toContain("Widget");
    expect(shown).toContain("Gadget");
  });

  it("prints a data grid as the table of its rows", async () => {
    const form: ComponentNode = {
      id: "order",
      type: "form",
      configuration: { title: "Order" },
      children: {
        content: [
          {
            id: "lines",
            type: "dataGrid",
            configuration: { label: "Lines" },
            collection: { collectionPath: "items" },
            children: {
              content: [
                { id: "sku", type: "text", configuration: { label: "SKU" } },
                { id: "quantity", type: "number", configuration: { label: "Quantity" } }
              ]
            }
          }
        ]
      }
    };
    const request: PdfDocumentRequest = {
      abi: PDF_ABI_VERSION,
      op: "document",
      form,
      values: { "items[0].sku": "Widget", "items[0].quantity": 3 },
      locale: "en",
      fonts: await fonts(),
      env: ENV
    };
    const rendered = await provider.document!(request);
    expect(rendered.warnings.filter((warning) => warning.code === "component.unknown")).toEqual([]);
    const text = (await extractText(rendered.bytes)).join("\n");
    expect(text).toContain("SKU");
    expect(text).toContain("Quantity");
    expect(text).toContain("Widget");
    expect(text).toContain("3");
  });

  it("honours effective states the host sends instead of evaluating rules", async () => {
    const request = documentRequest({ name: "Ada", vip: true, vipCode: "SECRET" }, await fonts());
    const state = { visible: false, disabled: false, readonly: false, runValidation: false, requiredApplies: false, submitValue: false, clearValue: false };
    const rendered = await provider.document!({ ...request, effectiveStates: { vipCode: state } });
    expect((await extractText(rendered.bytes))[0]).not.toContain("SECRET");
  });

  it("reports a component type the program has no rendition for, refuses it on request, and stops once a module registers one", async () => {
    const survey: ComponentNode = {
      id: "survey",
      type: "form",
      configuration: { title: "Survey" },
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "stars", type: "rating", configuration: { label: "Stars" } }
        ]
      }
    };
    const request: PdfDocumentRequest = { ...documentRequest({ name: "Ada", stars: 4 }, []), form: survey };

    // By default the answer still prints, generically, and the warning says so.
    const warned = await provider.document!(request);
    expect(head(warned.bytes)).toBe(PDF_MAGIC);
    expect(warned.warnings).toContainEqual({
      code: "component.unknown",
      componentId: "stars",
      message: 'Component "stars" has type "rating", which offers no PDF rendition here; the generic "text" rendition was used.'
    });
    const quiet = await provider.document!({ ...request, unknownComponents: "ignore" });
    expect(quiet.warnings.some((warning) => warning.code === "component.unknown")).toBe(false);

    // `fail` is a typed failure on the wire, a PdfKernelError through the provider — for `build` too.
    const refused = await handlePdfRequest({ ...request, unknownComponents: "fail" });
    expect(refused).toEqual({
      ok: false,
      error: {
        code: "unknown_component",
        message: 'Component "stars" has type "rating", which offers no PDF rendition here; register one for the type or set unknownComponents to "warn" or "ignore".'
      }
    });
    expect(await handlePdfRequest({ ...request, op: "build", unknownComponents: "fail" })).toMatchObject({ ok: false, error: { code: "unknown_component" } });
    await expect(provider.document!({ ...request, unknownComponents: "fail" })).rejects.toMatchObject({ name: "PdfKernelError", code: "unknown_component" });

    // A plugin module makes the type known — and its rendition the type's default.
    const registered = createInProcessPdfProvider({
      modules: [
        {
          pdfRenditions: [
            {
              componentType: "rating",
              id: "stars",
              render: (_node: unknown, context: unknown) => {
                const ctx = context as { nextId(): string; value: { text: string } };
                return [{ id: ctx.nextId(), kind: "paragraph", runs: [{ text: `${"*".repeat(Number(ctx.value.text))} (${ctx.value.text})` }] }];
              }
            }
          ]
        }
      ]
    });
    const known = await registered.document!({ ...request, unknownComponents: "fail" });
    expect(known.warnings.some((warning) => warning.code === "component.unknown")).toBe(false);
    expect((await extractText(known.bytes))[0]).toContain("**** (4)");
  });

  it("returns the document model for `build`", async () => {
    const response = await handlePdfRequest({ ...documentRequest({ name: "Ada" }, []), op: "build" });
    expect(response.ok).toBe(true);
    if (response.ok && response.op === "build") {
      expect(response.layoutKind).toBe("derived");
      expect(response.document?.blocks.length).toBeGreaterThan(0);
    }
  });

  it("refuses another ABI major and a malformed request as typed failures", async () => {
    await expect(provider.render({ abi: "2.0.0", op: "render", document: document([]), fonts: [], env: ENV })).rejects.toThrow(PdfKernelError);
    const bad = await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "render", fonts: [], env: ENV });
    expect(bad).toEqual({ ok: false, error: { code: "invalid_request", message: "The request carries no document" } });
    // A document without the theme's geometry is not filled in: it is refused, for render and layout alike.
    const { controls: _controls, spacing: _spacing, ...partial } = document([paragraph("p", "Hello")]);
    for (const op of ["render", "layout"] as const) {
      const refused = await handlePdfRequest({ abi: PDF_ABI_VERSION, op, document: partial as never, fonts: [], env: ENV });
      expect(refused, op).toEqual({ ok: false, error: { code: "invalid_request", message: "The document carries no controls, spacing: send the document as the engine builds it, with the theme's geometry" } });
    }
    // A fill with areas needs the type and colours its plan was built under.
    const area = { id: "a1", page: 1, rect: { x: 10, y: 10, width: 100, height: 14 }, value: "drawn", draw: DEFAULT_PDF_AREA_DRAW };
    const blank = await PDFDocument.create();
    blank.addPage();
    const template = bytesToBase64(await blank.save());
    const unthemed = await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "fill", template: { data: template }, values: {}, areas: [area], fonts: [], env: ENV, options: DEFAULT_TEMPLATE_FILL_OPTIONS });
    expect(unthemed).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const json = await handlePdfRequestJson("not json");
    expect(JSON.parse(json)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const unknown = await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "teleport" });
    expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("fills an existing AcroForm, reports each field, and inspects a template", async () => {
    const template = await templateBytes();
    const info = await provider.inspect!(buildPdfInspectRequest(template));
    expect(info.pageCount).toBe(1);
    expect(info.hasXfa).toBe(false);
    expect(info.fields.map((field) => [field.name, field.kind, field.page])).toEqual([
      ["Name", "text", 1],
      ["Agree", "checkbox", 1],
      ["Colour", "radio", 1],
      ["Country", "dropdown", 1],
      ["Toppings", "listbox", 1]
    ]);
    expect(info.fields[2]!.options).toEqual(["Red", "Green"]);
    // pdf-lib grows a widget by half its border on each side.
    const rect = info.fields[0]!.rect!;
    expect(Math.abs(rect.x - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.y - 340)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.width - 200)).toBeLessThanOrEqual(2);
    expect(Math.abs(rect.height - 20)).toBeLessThanOrEqual(2);

    const plan = {
      layoutId: "gov",
      ...PLAN_THEME,
      template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: template.length, data: bytesToBase64(template) },
      values: { Name: "Ada Lovelace", Agree: true, Colour: "Green", Country: "Canada", Toppings: ["Olives", "Onions"], Missing: "x", Nobody: null },
      areas: [],
      options: { flatten: false, readOnly: false, appearances: "regenerate" as const }
    };
    const filled = await provider.fill!(buildPdfFillRequest(plan, template, await fonts(), ENV));
    expect(head(filled.bytes)).toBe(PDF_MAGIC);
    // Reports come in the request's ABI-canonical (code-unit sorted) order, the same on every host.
    expect(filled.fields).toEqual([
      { pdfField: "Agree", status: "filled", kind: "checkbox" },
      { pdfField: "Colour", status: "filled", kind: "radio" },
      { pdfField: "Country", status: "filled", kind: "dropdown" },
      { pdfField: "Missing", status: "missing", message: 'No field named "Missing" in the template.' },
      { pdfField: "Name", status: "filled", kind: "text" },
      { pdfField: "Nobody", status: "missing", message: 'No field named "Nobody" in the template.' },
      { pdfField: "Toppings", status: "filled", kind: "listbox" }
    ]);
    const pdf = await reload(filled.bytes);
    const formApi = pdf.getForm();
    expect(formApi.getTextField("Name").getText()).toBe("Ada Lovelace");
    expect(formApi.getCheckBox("Agree").isChecked()).toBe(true);
    expect(formApi.getRadioGroup("Colour").getSelected()).toBe("Green");
    expect(formApi.getDropdown("Country").getSelected()).toEqual(["Canada"]);
    expect(formApi.getOptionList("Toppings").getSelected()).toEqual(["Olives", "Onions"]);

    const flattened = await provider.fill!(buildPdfFillRequest({ ...plan, options: { ...plan.options, flatten: true } }, template, [], ENV));
    const flat = await reload(flattened.bytes);
    expect(flat.getForm().getFields()).toHaveLength(0);
    expect((await extractText(flattened.bytes))[0]).toContain("Ada Lovelace");

    const viewer = await provider.fill!(buildPdfFillRequest({ ...plan, options: { ...plan.options, appearances: "viewer" } }, template, [], ENV));
    expect(Buffer.from(viewer.bytes).toString("latin1")).toContain("/NeedAppearances true");

    // A checked value that matched selects the option of that name; one that did not (`false`) clears the group.
    const off = await provider.fill!(buildPdfFillRequest({ ...plan, values: { Colour: false, Agree: "Yes" } }, template, [], ENV));
    expect(off.fields).toEqual([
      { pdfField: "Agree", status: "filled", kind: "checkbox" },
      { pdfField: "Colour", status: "cleared", kind: "radio" }
    ]);
    const offForm = (await reload(off.bytes)).getForm();
    expect(offForm.getRadioGroup("Colour").getSelected()).toBeUndefined();
    expect(offForm.getCheckBox("Agree").isChecked()).toBe(true);
  });

  it("lists a field's tooltip on inspect, the words a reader announces for it", async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([400, 400]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const formApi = pdf.getForm();
    const named = formApi.createTextField("topmostSubform[0].Page1[0].f1_01[0]");
    named.addToPage(page, { x: 20, y: 340, width: 200, height: 20, font });
    named.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText("Full legal name"));
    const blank = formApi.createTextField("Blank");
    blank.addToPage(page, { x: 20, y: 300, width: 200, height: 20, font });
    blank.acroField.dict.set(PDFName.of("TU"), PDFString.of("   "));
    formApi.createCheckBox("Plain").addToPage(page, { x: 20, y: 260, width: 14, height: 14 });
    const template = await pdf.save({ useObjectStreams: false, objectsPerTick: Infinity });

    const info = await provider.inspect!(buildPdfInspectRequest(template));
    // A tooltip of only spaces is none, and a field without one carries no key.
    expect(info.fields.map((field) => [field.name, field.tooltip])).toEqual([
      ["topmostSubform[0].Page1[0].f1_01[0]", "Full legal name"],
      ["Blank", undefined],
      ["Plain", undefined]
    ]);
    expect(info.fields.every((field) => field.tooltip !== undefined || !("tooltip" in field))).toBe(true);
  });

  it("places and reattaches widgets a re-save (macOS Preview) detached from their pages", async () => {
    const template = await detachedTemplateBytes();
    // Inspect: the pages list copies, yet every field is placed by its copy's shape and name — except the one with no copy at all.
    const info = await provider.inspect!(buildPdfInspectRequest(template));
    expect(info.pageCount).toBe(2);
    expect(info.fields.map((field) => [field.name, field.kind, field.page])).toEqual([
      ["Name", "text", 1],
      ["Colour", "radio", 1],
      ["Other", "text", 2],
      ["Agree", "checkbox", 2],
      ["Lost", "text", undefined]
    ]);

    // Before the fill, a viewer draws the copies (Agree's says nothing but its rectangle): the fields' own widgets are on no page.
    const before = await widgetsShown(template);
    expect(before.map((widget) => [widget.page, widget.name])).toEqual([
      [1, "Name"],
      [1, "Colour"],
      [1, "Colour"],
      [2, "Other"],
      [2, ""]
    ]);

    const plan = {
      layoutId: "paper",
      ...PLAN_THEME,
      template: { storage: "base64", name: "paper.pdf", type: "application/pdf", size: template.length, data: bytesToBase64(template) },
      values: { Name: "Ada Lovelace", Colour: "Green", Other: "Elsewhere", Agree: true, Lost: "Nowhere" },
      areas: [],
      options: { flatten: false, readOnly: false, appearances: "regenerate" as const }
    };
    const filled = await provider.fill!(buildPdfFillRequest(plan, template, [], ENV));
    expect(filled.fields.map((report) => report.status)).toEqual(["filled", "filled", "filled", "filled", "filled"]);
    expect(filled.warnings).toEqual([
      {
        code: "template.widgets_relinked",
        message:
          "5 of the template's field widgets were on no page (the PDF was re-saved by another application, such as macOS Preview); they were reattached so the answers show. 1 could not be placed and will not show."
      }
    ]);
    // After: the pages list the fields' own widgets, now carrying the answers, and the copies are gone.
    const after = await widgetsShown(filled.bytes);
    expect(after.map((widget) => [widget.page, widget.name, widget.value])).toEqual([
      [1, "Name", "Ada Lovelace"],
      [1, "Colour", "Green"],
      [1, "Colour", "Green"],
      [2, "Other", "Elsewhere"],
      [2, "Agree", "Yes"]
    ]);
    const pdf = await reload(filled.bytes);
    expect(pdf.getForm().getTextField("Lost").getText()).toBe("Nowhere");
    expect(filled.bytes.length).toBeLessThan(template.length + 2000);
    // The filled document places its fields outright: each reattached widget names its page.
    const again = await provider.inspect!(buildPdfInspectRequest(filled.bytes));
    expect(again.fields.map((field) => field.page)).toEqual([1, 1, 2, 2, undefined]);

    // Flattening burns the reattached answers into the pages.
    const flattened = await provider.fill!(buildPdfFillRequest({ ...plan, options: { ...plan.options, flatten: true } }, template, [], ENV));
    expect(flattened.warnings.map((warning) => warning.code)).toEqual(["template.widgets_relinked"]);
    const text = await extractText(flattened.bytes);
    expect(text[0]).toContain("Ada Lovelace");
    expect(text[1]).toContain("Elsewhere");
  });

  it("keeps a template's scripts and says so, once per kind, on inspect and fill", async () => {
    const build = async (scripts: boolean): Promise<Uint8Array> => {
      const pdf = await PDFDocument.create({ updateMetadata: false });
      const page = pdf.addPage([300, 200]);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      pdf.getForm().createTextField("Name").addToPage(page, { x: 20, y: 150, width: 100, height: 20, font });
      if (scripts) {
        const js = (source: string) => pdf.context.obj({ S: "JavaScript", JS: PDFString.of(source) });
        pdf.catalog.set(PDFName.of("OpenAction"), js("app.alert(1)"));
        pdf.catalog.set(PDFName.of("Names"), pdf.context.obj({ JavaScript: { Names: [PDFString.of("a"), js("1"), PDFString.of("b"), js("2")] } }));
        page.node.set(PDFName.of("AA"), pdf.context.obj({ O: js("3") }));
        pdf.getForm().getTextField("Name").acroField.dict.set(PDFName.of("AA"), pdf.context.obj({ K: js("4"), F: js("5") }));
      }
      return pdf.save({ useObjectStreams: false, objectsPerTick: Infinity });
    };
    const template = await build(true);
    const expected = ["template.javascript_open_action", "template.javascript_additional_actions", "template.javascript_names"];
    const info = await provider.inspect!(buildPdfInspectRequest(template));
    expect(info.warnings?.map((warning) => warning.code)).toEqual(expected);
    expect(info.warnings?.[1]?.message).toContain("(3)");
    expect(info.warnings?.[2]?.message).toContain("(2)");
    const plan = {
      layoutId: "js",
      ...PLAN_THEME,
      template: { storage: "base64" as const, name: "js.pdf", type: "application/pdf", size: template.length, data: bytesToBase64(template) },
      values: { Name: "Ada" },
      areas: [],
      options: { flatten: false, readOnly: false, appearances: "regenerate" as const }
    };
    const filled = await provider.fill!(buildPdfFillRequest(plan, template, [], ENV));
    expect(filled.warnings.map((warning) => warning.code)).toEqual(expected);
    // Kept: the open action survives the fill, and the bytes are the same on a second run.
    expect((await reload(filled.bytes)).catalog.has(PDFName.of("OpenAction"))).toBe(true);
    const again = await provider.fill!(buildPdfFillRequest(plan, template, [], ENV));
    expect(Buffer.compare(Buffer.from(filled.bytes), Buffer.from(again.bytes))).toBe(0);
    // A template without scripts says nothing.
    expect((await provider.inspect!(buildPdfInspectRequest(await build(false)))).warnings ?? []).toEqual([]);
  });

  it("reports XFA on inspect and its removal on fill", async () => {
    const template = await xfaTemplateBytes();
    expect((await provider.inspect!(buildPdfInspectRequest(template))).hasXfa).toBe(true);
    expect((await provider.inspect!(buildPdfInspectRequest(await templateBytes()))).hasXfa).toBe(false);
    const filled = await provider.fill!(
      buildPdfFillRequest(
        {
          layoutId: "xfa",
          ...PLAN_THEME,
          template: { storage: "base64", name: "xfa.pdf", type: "application/pdf", size: template.length, data: bytesToBase64(template) },
          values: { Name: "Ada" },
          areas: [],
          options: { flatten: false, readOnly: false, appearances: "regenerate" }
        },
        template,
        [],
        ENV
      )
    );
    expect(filled.warnings.map((warning) => warning.code)).toEqual(["template.xfa_removed"]);
    expect((await reload(filled.bytes)).getForm().acroForm.dict.has(PDFName.of("XFA"))).toBe(false);
  });

  it("fills a template layout through `document` when the layout carries the bytes inline", async () => {
    const template = await templateBytes();
    const request: PdfDocumentRequest = {
      ...documentRequest({ name: "Ada", vip: true }, []),
      layout: {
        id: "gov",
        kind: "template",
        template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: template.length, data: bytesToBase64(template) },
        fields: [
          { pdfField: "Name", source: { kind: "component", componentId: "name" } },
          { pdfField: "Agree", source: { kind: "component", componentId: "vip" } }
        ]
      }
    };
    const result = await provider.document!(request);
    // Built inside the program from the layout's field list, so reported in the layout's order.
    expect(result.fields).toEqual([
      { pdfField: "Name", status: "filled", kind: "text" },
      { pdfField: "Agree", status: "filled", kind: "checkbox" }
    ]);
    expect(result.areas).toEqual([]);
    const pdf = await reload(result.bytes);
    expect(pdf.getForm().getTextField("Name").getText()).toBe("Ada");
  });

  describe("areas", () => {
    /** A printed form with no fields: labels, rules and two boxes to tick. Two pages. */
    async function paperBytes(): Promise<Uint8Array> {
      const pdf = await PDFDocument.create({ updateMetadata: false });
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const page = pdf.addPage([400, 400]);
      page.drawText("Name:", { x: 20, y: 360, size: 10, font });
      page.drawLine({ start: { x: 60, y: 358 }, end: { x: 380, y: 358 }, thickness: 0.5 });
      page.drawText("Newsletter:", { x: 20, y: 320, size: 10, font });
      page.drawRectangle({ x: 90, y: 316, width: 12, height: 12, borderWidth: 0.75 });
      pdf.addPage([400, 400]);
      return pdf.save({ useObjectStreams: false, objectsPerTick: Infinity });
    }

    const draw = { kind: "text" as const, fontSize: 10, align: "start" as const, valign: "top" as const, padding: 2, wrap: true, bold: false };

    function plan(paper: Uint8Array, areas: PdfFillArea[]): PdfFillPlan {
      return {
        layoutId: "paper",
        ...PLAN_THEME,
        template: { storage: "base64", name: "paper.pdf", type: "application/pdf", size: paper.length, data: bytesToBase64(paper) },
        values: {},
        areas,
        options: { flatten: false, readOnly: false, appearances: "regenerate" }
      };
    }

    it("draws text and check areas onto a PDF that has no form, reporting each", async () => {
      const paper = await paperBytes();
      expect((await provider.inspect!(buildPdfInspectRequest(paper))).fields).toEqual([]);
      const areas: PdfFillArea[] = [
        { id: "name", label: "Name", page: 1, rect: { x: 62, y: 28, width: 316, height: 14 }, value: "Ada Lovelace", draw },
        { id: "centred", page: 1, rect: { x: 20, y: 60, width: 360, height: 14 }, value: "Centred", draw: { ...draw, align: "center" } },
        { id: "right", page: 1, rect: { x: 20, y: 80, width: 360, height: 14 }, value: "Right", draw: { ...draw, align: "end", bold: true } },
        { id: "middle", page: 1, rect: { x: 20, y: 100, width: 360, height: 40 }, value: "Middle", draw: { ...draw, valign: "middle" } },
        { id: "oneLine", page: 1, rect: { x: 20, y: 150, width: 360, height: 14 }, value: "One line only", draw: { ...draw, wrap: false } },
        { id: "news", label: "Newsletter", page: 1, rect: { x: 90, y: 72, width: 12, height: 12 }, value: true, draw: { ...draw, kind: "check" } },
        { id: "unticked", page: 1, rect: { x: 110, y: 72, width: 12, height: 12 }, value: false, draw: { ...draw, kind: "check" } },
        { id: "blank", page: 1, rect: { x: 20, y: 200, width: 100, height: 14 }, value: null, draw },
        { id: "second", page: 2, rect: { x: 20, y: 20, width: 100, height: 14 }, value: "Page two", draw },
        { id: "tooLong", label: "Notes", page: 1, rect: { x: 20, y: 220, width: 60, height: 12 }, value: "This sentence is far longer than the little box it was given.", draw },
        { id: "nowhere", page: 3, rect: { x: 0, y: 0, width: 10, height: 10 }, value: "Lost", draw }
      ];
      const filled = await provider.fill!(buildPdfFillRequest(plan(paper, areas), paper, await fonts(), ENV));
      expect(head(filled.bytes)).toBe(PDF_MAGIC);
      expect(filled.fields).toEqual([]);
      expect(filled.areas).toEqual([
        { id: "name", page: 1, status: "filled" },
        { id: "centred", page: 1, status: "filled" },
        { id: "right", page: 1, status: "filled" },
        { id: "middle", page: 1, status: "filled" },
        { id: "oneLine", page: 1, status: "filled" },
        { id: "news", page: 1, status: "filled" },
        { id: "unticked", page: 1, status: "empty" },
        { id: "blank", page: 1, status: "empty" },
        { id: "second", page: 2, status: "filled" },
        { id: "tooLong", page: 1, status: "overflow", message: "The value did not fit; it was clipped at the box's edge." },
        { id: "nowhere", page: 3, status: "missing", message: "The template has 2 pages." }
      ]);
      expect(filled.warnings.map((warning) => warning.code)).toEqual(["area.overflow", "area.page"]);
      expect(filled.warnings[0]!.message).toContain('Area "Notes" on page 1');
      const [first, second] = await extractText(filled.bytes);
      expect(first).toContain("Ada Lovelace");
      expect(first).toContain("Centred");
      expect(first).toContain("Right");
      expect(first).toContain("Middle");
      expect(first).toContain("One line only");
      expect(first).not.toContain("Lost");
      expect(second).toContain("Page two");
      // Areas are page content: the paper form gains no AcroForm for them.
      expect(Buffer.from(filled.bytes).toString("latin1")).not.toContain("/AcroForm");
      // Clipped text still sits in the content stream (the clip is a graphics state, not a cut).
      expect(first).toContain("This sentence");
    });

    it("leaves a fields-only fill byte-identical whether `areas` is empty or absent", async () => {
      const template = await templateBytes();
      const list = await fonts();
      const withKey = await provider.fill!(buildPdfFillRequest({ ...plan(template, []), values: { Name: "Ada" } }, template, list, ENV));
      const request = buildPdfFillRequest({ ...plan(template, []), values: { Name: "Ada" } }, template, list, ENV);
      expect("areas" in request).toBe(false);
      const explicit = await provider.fill!({ ...request, areas: [] });
      expect(Buffer.from(explicit.bytes).equals(Buffer.from(withKey.bytes))).toBe(true);
      expect(withKey.areas).toEqual([]);
    });

    it("draws areas beside filled fields through `document` for a template layout", async () => {
      const template = await templateBytes();
      const request: PdfDocumentRequest = {
        ...documentRequest({ name: "Ada", vip: true }, await fonts()),
        layout: {
          id: "gov",
          kind: "template",
          template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: template.length, data: bytesToBase64(template) },
          fields: [{ pdfField: "Name", source: { kind: "component", componentId: "name" } }],
          areas: [
            { id: "stamp", page: 1, rect: { x: 250, y: 20, width: 130, height: 14 }, source: { kind: "literal", value: "RECEIVED" } },
            { id: "vipTick", page: 1, rect: { x: 250, y: 40, width: 12, height: 12 }, source: { kind: "component", componentId: "vip" }, draw: { kind: "check" } }
          ]
        }
      };
      const result = await provider.document!(request);
      expect(result.fields).toEqual([{ pdfField: "Name", status: "filled", kind: "text" }]);
      expect(result.areas).toEqual([
        { id: "stamp", page: 1, status: "filled" },
        { id: "vipTick", page: 1, status: "filled" }
      ]);
      expect((await extractText(result.bytes))[0]).toContain("RECEIVED");
      expect((await reload(result.bytes)).getForm().getTextField("Name").getText()).toBe("Ada");
    });

    describe("fillable areas", () => {
      const field = (name: string, extra: Partial<NonNullable<PdfFillArea["field"]>> = {}) => ({ name, required: false, readOnly: false, ...extra });

      it("creates transparent widgets on a PDF that has no form, filled or left blank", async () => {
        const paper = await paperBytes();
        const areas: PdfFillArea[] = [
          { id: "name", label: "Full name", page: 1, rect: { x: 62, y: 28, width: 316, height: 14 }, value: "Ada Lovelace", draw, field: field("applicant_name", { tooltip: "Your full name", required: true }) },
          { id: "blank", page: 1, rect: { x: 62, y: 60, width: 200, height: 14 }, value: null, draw, field: field("file_number") },
          { id: "notes", page: 1, rect: { x: 62, y: 100, width: 300, height: 60 }, value: "Line one\nLine two", draw: { ...draw, fontSize: 9, align: "center", color: "#1a4480" }, field: field("notes") },
          { id: "oneLine", page: 1, rect: { x: 62, y: 170, width: 300, height: 14 }, value: "Right", draw: { ...draw, wrap: false, align: "end", bold: true }, field: field("one_line") },
          { id: "news", page: 1, rect: { x: 90, y: 72, width: 12, height: 12 }, value: true, draw: { ...draw, kind: "check" }, field: field("newsletter", { tooltip: "Newsletter" }) },
          { id: "unticked", page: 1, rect: { x: 110, y: 72, width: 12, height: 12 }, value: false, draw: { ...draw, kind: "check" }, field: field("phone") },
          // The same name twice: one field, two widgets.
          { id: "nameAgain", page: 2, rect: { x: 20, y: 20, width: 200, height: 14 }, value: "Ada Lovelace", draw, field: field("applicant_name") },
          // A page the paper does not have.
          { id: "nowhere", page: 3, rect: { x: 0, y: 0, width: 10, height: 10 }, value: "Lost", draw, field: field("lost") },
          // Mixed kinds on one name are refused.
          { id: "clash", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, value: true, draw: { ...draw, kind: "check" }, field: field("applicant_name") }
        ];
        const filled = await provider.fill!(buildPdfFillRequest(plan(paper, areas), paper, await fonts(), ENV));
        expect(filled.areas).toEqual([
          { id: "name", page: 1, status: "filled", field: "applicant_name" },
          { id: "blank", page: 1, status: "empty", field: "file_number" },
          { id: "notes", page: 1, status: "filled", field: "notes" },
          { id: "oneLine", page: 1, status: "filled", field: "one_line" },
          { id: "news", page: 1, status: "filled", field: "newsletter" },
          { id: "unticked", page: 1, status: "empty", field: "phone" },
          { id: "nameAgain", page: 2, status: "filled", field: "applicant_name" },
          { id: "nowhere", page: 3, status: "missing", message: "The template has 2 pages." },
          { id: "clash", page: 1, status: "unsupported", field: "applicant_name", message: '"applicant_name" is a text field made by another area; a check box cannot share it.' }
        ]);
        expect(filled.warnings.map((warning) => warning.code)).toEqual(["area.page", "area.field"]);

        const form = (await reload(filled.bytes)).getForm();
        expect(form.getFields().map((entry) => entry.getName()).sort()).toEqual(["applicant_name", "file_number", "newsletter", "notes", "one_line", "phone"]);
        const name = form.getTextField("applicant_name");
        expect(name.getText()).toBe("Ada Lovelace");
        expect(name.isRequired()).toBe(true);
        expect(name.isMultiline()).toBe(true);
        expect((name.acroField.dict.get(PDFName.of("TU")) as PDFHexString).decodeText()).toBe("Your full name");
        // Two widgets of the one field, each at its area (top-left points flipped to PDF space).
        const widgets = name.acroField.getWidgets();
        expect(widgets.length).toBe(2);
        const first = widgets[0]!.getRectangle();
        expect([first.x, first.y, first.width, first.height]).toEqual([62, 400 - 28 - 14, 316, 14]);
        expect(widgets[1]!.getRectangle().y).toBe(400 - 20 - 14);
        // Transparent: no background, no border colour, no border width.
        for (const widget of widgets) {
          const characteristics = widget.getAppearanceCharacteristics();
          expect(characteristics?.getBackgroundColor()).toBeUndefined();
          expect(characteristics?.getBorderColor()).toBeUndefined();
          expect(widget.getBorderStyle()?.getWidth() ?? 0).toBe(0);
        }
        expect(name.acroField.getDefaultAppearance()).toContain(" 10 Tf");
        expect(form.getTextField("file_number").getText()).toBeUndefined();
        const notes = form.getTextField("notes");
        expect(notes.getText()).toBe("Line one\nLine two");
        expect(notes.getAlignment()).toBe(TextAlignment.Center);
        expect(notes.acroField.getDefaultAppearance()).toContain(" 9 Tf");
        const oneLine = form.getTextField("one_line");
        expect(oneLine.isMultiline()).toBe(false);
        expect(oneLine.getAlignment()).toBe(TextAlignment.Right);
        expect(form.getCheckBox("newsletter").isChecked()).toBe(true);
        expect(form.getCheckBox("phone").isChecked()).toBe(false);
        const box = form.getCheckBox("newsletter").acroField.getWidgets()[0]!;
        expect(box.getAppearanceCharacteristics()?.getBackgroundColor()).toBeUndefined();
        expect(box.getBorderStyle()?.getWidth() ?? 0).toBe(0);
        // The page content carries no drawn text for a fillable area: the value lives in the field.
        expect((await extractText(filled.bytes))[0]).not.toContain("Right");
        expect(Buffer.from(filled.bytes).toString("latin1")).toContain("/AcroForm");
      });

      it("refuses a template's own field name, locks filled fields under readOnly, and burns them in under flatten", async () => {
        const template = await templateBytes();
        const list = await fonts();
        const areas: PdfFillArea[] = [
          { id: "taken", page: 1, rect: { x: 250, y: 20, width: 130, height: 14 }, value: "x", draw, field: field("Name") },
          { id: "extra", page: 1, rect: { x: 250, y: 40, width: 130, height: 14 }, value: "Extra", draw, field: field("Extra") },
          { id: "blank", page: 1, rect: { x: 250, y: 60, width: 130, height: 14 }, value: null, draw, field: field("Blank") }
        ];
        const base = { ...plan(template, areas), values: { Name: "Ada" } };
        const locked = await provider.fill!(buildPdfFillRequest({ ...base, options: { ...base.options, readOnly: true } }, template, list, ENV));
        expect(locked.areas).toEqual([
          { id: "taken", page: 1, status: "unsupported", field: "Name", message: 'the template already has a field named "Name"; the area was not made a field.' },
          { id: "extra", page: 1, status: "filled", field: "Extra" },
          { id: "blank", page: 1, status: "empty", field: "Blank" }
        ]);
        const form = (await reload(locked.bytes)).getForm();
        expect(form.getTextField("Name").getText()).toBe("Ada");
        expect(form.getTextField("Extra").isReadOnly()).toBe(true);
        expect(form.getTextField("Blank").isReadOnly()).toBe(false);

        const flat = await provider.fill!(buildPdfFillRequest({ ...base, options: { ...base.options, flatten: true } }, template, list, ENV));
        expect((await reload(flat.bytes)).getForm().getFields()).toHaveLength(0);
        const text = (await extractText(flat.bytes))[0]!;
        expect(text).toContain("Ada");
        expect(text).toContain("Extra");
      });

      it("keeps a content-only fill unchanged and reports fillable areas through `document`", async () => {
        const paper = await paperBytes();
        const contentOnly = plan(paper, [{ id: "a", page: 1, rect: { x: 62, y: 28, width: 316, height: 14 }, value: "Ada", draw }]);
        const before = await provider.fill!(buildPdfFillRequest(contentOnly, paper, [], ENV));
        expect(Buffer.from(before.bytes).toString("latin1")).not.toContain("/AcroForm");
        const request: PdfDocumentRequest = {
          ...documentRequest({ name: "Ada", vip: true }, await fonts()),
          layout: {
            id: "paper",
            kind: "template",
            template: { storage: "base64", name: "paper.pdf", type: "application/pdf", size: paper.length, data: bytesToBase64(paper) },
            fields: [],
            areas: [
              { id: "who", label: "Applicant", page: 1, rect: { x: 62, y: 28, width: 316, height: 14 }, source: { kind: "component", componentId: "name" }, field: {} },
              { id: "vip", page: 1, rect: { x: 90, y: 72, width: 12, height: 12 }, source: { kind: "component", componentId: "vip" }, draw: { kind: "check" }, field: { name: "vip_member" } }
            ]
          }
        };
        const result = await provider.document!(request);
        // A field's name defaults to the area's label.
        expect(result.areas).toEqual([
          { id: "who", page: 1, status: "filled", field: "Applicant" },
          { id: "vip", page: 1, status: "filled", field: "vip_member" }
        ]);
        const form = (await reload(result.bytes)).getForm();
        expect(form.getTextField("Applicant").getText()).toBe("Ada");
        expect(form.getCheckBox("vip_member").isChecked()).toBe(true);
      });
    });
  });
});

describe("template limits and reports", () => {
  const provider = createInProcessPdfProvider();
  const planFor = (bytes: Uint8Array, values: PdfFillPlan["values"]): PdfFillPlan => ({
    layoutId: "t",
    ...PLAN_THEME,
    template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: bytes.length, data: bytesToBase64(bytes) },
    values,
    areas: [],
    options: { flatten: false, readOnly: false, appearances: "regenerate" }
  } as PdfFillPlan);

  it("refuses a template over the cap, and bytes that are no PDF, as the template error on fill and inspect", async () => {
    const big = new Uint8Array(MAX_PDF_TEMPLATE_BYTES + 1);
    const garbage = new TextEncoder().encode("not a pdf at all");
    for (const bytes of [big, garbage]) {
      const fill = await provider.fill!(buildPdfFillRequest(planFor(bytes, { A: "x" }), bytes, await fonts(), ENV)).catch((error: unknown) => error);
      expect(fill).toMatchObject({ code: "template" });
      const inspect = await provider.inspect!(buildPdfInspectRequest(bytes)).catch((error: unknown) => error);
      expect(inspect).toMatchObject({ code: "template" });
    }
    const message = String(((await provider.inspect!(buildPdfInspectRequest(big)).catch((error: unknown) => error)) as Error).message);
    expect(message).toContain(String(big.length));
    expect(message).toContain("25 MiB");
  }, 60000);

  it("warns field.overflow, naming the field, when single-line text is wider than its widget at the chosen size", async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([300, 400]);
    const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.getForm().createTextField("Small").addToPage(page, { x: 20, y: 340, width: 50, height: 16, font: helvetica });
    pdf.getForm().createTextField("Roomy").addToPage(page, { x: 20, y: 300, width: 250, height: 16, font: helvetica });
    const bytes = await pdf.save({ useObjectStreams: false, objectsPerTick: Infinity });
    const long = "Supercalifragilistic expialidocious name that is far too long";
    const out = await provider.fill!(buildPdfFillRequest(planFor(bytes, { Small: long, Roomy: "short" }), bytes, await fonts(), ENV));
    const overflow = out.warnings.filter((warning) => warning.code === "field.overflow");
    expect(overflow).toHaveLength(1);
    expect(overflow[0]!.message).toContain('Field "Small"');
  }, 60000);
});
