import { describe, expect, it } from "vitest";
import { PDF_ABI_VERSION, type FormDefinition, type PdfKernelResponse } from "@argusvane/datum-engine";
import { DEFAULT_FONT_PACK, createInProcessPdfProvider, handlePdfRequest, loadFontPack } from "@argusvane/datum-pdf-kernel";

import { ENV, document, fonts } from "../../pdf-kernel/tests/helpers.js";
import { WIDGETS } from "../../pdf-kernel/tests/pdfa-fixtures.js";
import { InMemorySubmissionStore, base64ToBytes, createKernelValidator, createProviderPdfRenderer, createSubmissionService, extractFromTemplateFields, templateMatchScore } from "../src/index.js";

/**
 * A PDF with AcroForm fields and no record.json — someone filled a template elsewhere and sent
 * it back — read through a registered form's template layout: each mapped field's value lands
 * on its component, the rest is noted.
 */
async function widgetsPdf(): Promise<Uint8Array> {
  const response = (await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "render", document: document(WIDGETS), fonts: await fonts(), env: ENV })) as Extract<PdfKernelResponse, { op: "document" | "render" }>;
  return base64ToBytes(response.bytes);
}

function surveyWithTemplate(template: Uint8Array): FormDefinition {
  return {
    id: "survey",
    version: "3.0.0",
    schemaVersion: "1.0.0",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "firstName", type: "text", configuration: {} },
          { id: "notes", type: "textarea", configuration: {} },
          { id: "agree", type: "checkbox", configuration: {} },
          { id: "colour", type: "radio", configuration: { options: [{ value: "r", label: "Red" }, { value: "g", label: "Green" }] } },
          // Inline options: a PDF reader reports a dropdown's or list box's pick by its label; the form wants the value.
          { id: "country", type: "select", configuration: { options: [{ value: "CA", label: "Canada" }, { value: "FR", label: "France" }] } },
          { id: "toppings", type: "multiselect", configuration: { options: [{ value: "a", label: "Olives" }, { value: "b", label: "Onions" }] } },
          {
            id: "meta",
            type: "container",
            configuration: {},
            children: { content: [{ id: "score", type: "number", configuration: {} }] }
          }
        ]
      }
    },
    pdf: {
      layouts: [
        {
          id: "paper",
          kind: "template",
          template: { storage: "base64", name: "survey.pdf", type: "application/pdf", size: template.length, data: Buffer.from(template).toString("base64") },
          fields: [
            { pdfField: "first", source: { kind: "component", componentId: "firstName" } },
            { pdfField: "notes", source: { kind: "component", componentId: "notes" } },
            { pdfField: "agree", source: { kind: "component", componentId: "agree" } },
            { pdfField: "colour", source: { kind: "component", componentId: "colour" } },
            { pdfField: "country", source: { kind: "component", componentId: "country" } },
            { pdfField: "toppings", source: { kind: "component", componentId: "toppings" } },
            { pdfField: "score", source: { kind: "component", componentId: "score" }, format: { kind: "number" } },
            { pdfField: "sig", source: { kind: "literal", value: "received" } },
            { pdfField: "missing", source: { kind: "component", componentId: "firstName" } }
          ]
        }
      ]
    }
  };
}

describe("a PDF back into a record through a template layout's fields", () => {
  it("scores layouts by the fields the PDF has, maps values back by component, and notes what it skipped", async () => {
    const bytes = await widgetsPdf();
    const renderer = createProviderPdfRenderer({ provider: createInProcessPdfProvider(), fonts: await loadFontPack({ entries: DEFAULT_FONT_PACK.filter((entry) => entry.id.startsWith("dejavu-sans")) }), build: handlePdfRequest });
    const info = await renderer.inspect(bytes, { attachments: "data" });
    expect(info.attachments).toEqual([]);
    // The fixture's six value widgets and its signature field; the mapping names the six.
    expect(info.fields.map((field) => field.name).sort()).toEqual(["agree", "colour", "country", "first", "notes", "sig", "toppings"]);

    const definition = surveyWithTemplate(bytes);
    const store = new InMemorySubmissionStore();
    const service = createSubmissionService({ store, validator: createKernelValidator(), pdf: renderer, ids: () => "imported-1" });
    const entry = await service.register(definition);
    // Seven of the nine mappings name a field the PDF has (the literal-filled signature field among them).
    expect(templateMatchScore(info, definition.pdf!.layouts![0]! as never)).toBe(7);

    const extracted = extractFromTemplateFields(info, entry, definition.pdf!.layouts![0]! as never);
    expect(extracted.method).toBe("template-fields");
    expect(extracted.values).toEqual({ firstName: "Ada", notes: "Line one\nLine two", agree: true, colour: "g", country: "CA", toppings: ["a"] });
    expect(extracted.notes).toEqual(['the PDF has no field "score"', '"sig" is filled from a literal, not a component; skipped', 'the PDF has no field "missing"']);

    const result = await service.importPdf(bytes, { fileName: "paper.pdf" });
    expect(result.method).toBe("template-fields");
    expect(result.record).toMatchObject({
      id: "imported-1",
      status: "accepted",
      source: "pdf-import",
      formId: "survey",
      formVersion: "3.0.0",
      importedFrom: { fileName: "paper.pdf", method: "template-fields" }
    });
    const envelope = result.record.document as { submission: { values: Record<string, unknown> }; versionContext: { client: { runtimeVersion: string } } };
    expect(envelope.submission.values).toEqual(extracted.values);
    expect(envelope.versionContext.client.runtimeVersion).toBe("server");
    // No PDF of its own to render: the imported one stays with the record, unsigned.
    expect(result.record.pdf).toMatchObject({ fileName: "paper.pdf", layoutId: "imported", signed: false, attached: false });
    expect(result.record.importedFrom?.signatureStatus).toBe("none");

    // Told the form, the search is narrowed to it; a form without a matching layout is refused.
    expect((await service.importPdf(bytes, { formKey: "survey@3.0.0" })).method).toBe("template-fields");
    const { pdf: _pdf, ...withoutLayouts } = definition;
    await service.register({ ...withoutLayouts, id: "other" });
    await expect(service.importPdf(bytes, { formKey: "other@3.0.0" })).rejects.toMatchObject({ code: "not_extractable", message: expect.stringContaining("template layout") });
  });
});
