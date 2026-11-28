import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { kernelStableStringify, type ComponentNode, type PdfConfiguration, type PdfGeneratedLayout, type PdfTemplateLayout } from "@argusvane/datum-engine";
import { PDF_ABI_VERSION, bytesToBase64, type PdfDocumentRequest, type PdfKernelRequest, type PdfKernelResponse } from "@argusvane/datum-engine/render";
import { DOCUMENT_PROFILE, createQuickJsProgramHost, type QuickJsProgramHost } from "@argusvane/datum-quickjs-wasm-host";
import { createInProcessPdfProvider } from "../src/in-process-provider.js";
import { handlePdfRequest } from "../src/program/entry.js";
import { loadPdfProgram } from "../src/quickjs-provider.js";
import { ENV, extractText, reload } from "./helpers.js";

/**
 * Layouts chosen by the answers inside the program: a `document` or
 * `build` that names no layout prints the first whose `when` holds on the request's values,
 * else the default, else the first — the same choice in-process and under QuickJS, which is
 * what a Python, Java or .NET host gets — and the `document` reply says which printed.
 */

const IS_QUEBEC = 'province = "QC"';
const LARGE_PRINT = "largePrint";

/** The province sits in a container, so its answer travels under `address.province` and a `when` names it by id. */
const FORM: ComponentNode = {
  id: "claim",
  type: "form",
  configuration: { title: "Claim" },
  children: {
    content: [
      { id: "name", type: "text", configuration: { label: "Name" } },
      { id: "largePrint", type: "checkbox", configuration: { label: "Large print" } },
      {
        id: "address",
        type: "container",
        configuration: {},
        children: { content: [{ id: "province", type: "select", configuration: { label: "Province" } }] }
      }
    ]
  }
};

function generated(id: string, heading: string, when?: string): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name: heading,
    ...(when !== undefined ? { when } : {}),
    root: {
      id: `${id}-doc`,
      type: "pdf-document",
      configuration: {},
      children: { body: [{ id: `${id}-title`, type: "pdf-text", configuration: { text: heading, variant: "h1" } }], header: [], footer: [] }
    }
  };
}

/** Standard is the default; Quebec copy prints for Quebec. */
const PDF: PdfConfiguration = {
  layouts: [generated("standard", "Standard copy"), generated("quebec", "Copie du Québec", IS_QUEBEC)],
  defaultLayoutId: "standard"
};

function documentRequest(values: Record<string, unknown>, extra: Partial<PdfDocumentRequest> = {}): PdfDocumentRequest {
  return { abi: PDF_ABI_VERSION, op: "document", form: FORM, pdf: PDF, values, locale: "en", fonts: [], env: ENV, options: { compact: false }, ...extra };
}

function buildRequest(values: Record<string, unknown>): PdfKernelRequest {
  return { abi: PDF_ABI_VERSION, op: "build", form: FORM, pdf: PDF, values, locale: "en" };
}

/** Two AcroForms that tell themselves apart: the default paper's field is "Name", Quebec's is "Nom". */
async function paper(field: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const page = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.getForm().createTextField(field).addToPage(page, { x: 20, y: 340, width: 200, height: 20, font });
  return pdf.save({ useObjectStreams: false, objectsPerTick: Infinity });
}

/** A template layout whose PDF the host keeps (not inline): the request must carry its bytes. */
function paperLayout(id: string, field: string, when?: string): PdfTemplateLayout {
  return {
    id,
    kind: "template",
    ...(when !== undefined ? { when } : {}),
    template: { storage: "url", name: `${id}.pdf`, type: "application/pdf", size: 1, ref: `/templates/${id}.pdf` },
    fields: [{ pdfField: field, source: { kind: "component", componentId: "name" } }]
  };
}

describe("layouts chosen by the answers in the program", () => {
  let host: QuickJsProgramHost;
  /** The program as a server evaluates it: JSON in, JSON out, in QuickJS. */
  let sandboxed: (request: unknown) => string;

  beforeAll(async () => {
    host = await createQuickJsProgramHost({ limits: DOCUMENT_PROFILE });
    host.evaluate(await loadPdfProgram(), "datum-pdf.program.js");
    sandboxed = (request) => host.call("__datum_pdf", kernelStableStringify(request));
  }, 60_000);

  afterAll(() => {
    host?.dispose();
  });

  async function inProcess(request: unknown): Promise<string> {
    return kernelStableStringify(await handlePdfRequest(request));
  }

  it("build and document name the same layout for the same answers, in-process and under QuickJS", async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ name: "Ada", "address.province": "QC" }, "quebec", "condition"],
      [{ name: "Ada", "address.province": "ON" }, "standard", "default"],
      [{ name: "Ada" }, "standard", "default"]
    ];
    for (const [values, layoutId, layoutChoice] of cases) {
      const built = await inProcess(buildRequest(values));
      expect(sandboxed(buildRequest(values))).toBe(built);
      const document = await inProcess(documentRequest(values));
      // Byte for byte, the reply's layout fields and warnings included.
      expect(sandboxed(documentRequest(values))).toBe(document);

      const build = JSON.parse(built) as Extract<PdfKernelResponse, { op: "build" }>;
      const rendered = JSON.parse(document) as Extract<PdfKernelResponse, { op: "document" }>;
      expect(build).toMatchObject({ ok: true, layoutId, layoutKind: "generated", layoutChoice });
      expect(rendered).toMatchObject({ ok: true, layoutId, layoutKind: "generated", layoutChoice });
    }
  }, 60_000);

  it("refuses a layout whose `when` is an expression tree, in-process and under QuickJS alike", async () => {
    const tree = { kind: "binary", operator: "eq", left: { kind: "path", path: "province" }, right: { kind: "literal", value: "QC" } };
    const pdf: PdfConfiguration = { ...PDF, layouts: [...PDF.layouts!, generated("tree", "Tree", tree as never)] };
    for (const request of [buildRequest({ name: "Ada" }), documentRequest({ name: "Ada" })]) {
      const asked = { ...request, pdf };
      const refused = await inProcess(asked);
      expect(sandboxed(asked)).toBe(refused);
      expect(JSON.parse(refused)).toMatchObject({ ok: false, error: { code: "formula_invalid" } });
      expect((JSON.parse(refused) as { error: { message: string } }).error.message).toContain("this one is an expression tree");
    }
  }, 60_000);

  it("names the layout on the document reply and through the provider; render, handed a built document, names none", async () => {
    const provider = createInProcessPdfProvider();
    const quebec = await provider.document!(documentRequest({ "address.province": "QC" }));
    expect(quebec).toMatchObject({ layoutId: "quebec", layoutKind: "generated", layoutChoice: "condition" });
    expect((await extractText(quebec.bytes))[0]).toContain("Copie du Québec");

    const built = (await handlePdfRequest(buildRequest({ "address.province": "QC" }))) as Extract<PdfKernelResponse, { op: "build" }>;
    const render = await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "render", document: built.document, fonts: [], env: ENV, options: { compact: false } });
    expect(render).toMatchObject({ ok: true, op: "render" });
    for (const key of ["layoutId", "layoutKind", "layoutChoice"]) {
      expect(key in render).toBe(false);
    }
    // The same document, however it was reached.
    const again = await provider.render({ abi: PDF_ABI_VERSION, op: "render", document: built.document!, fonts: [], env: ENV, options: { compact: false } });
    expect(Buffer.from(again.bytes).equals(Buffer.from(quebec.bytes))).toBe(true);
  }, 60_000);

  it("answers a request that speaks another version of its major the same way: the major version is the line", async () => {
    const request = { ...documentRequest({ "address.province": "QC" }), abi: "1.2.0" };
    const reply = JSON.parse(sandboxed(request)) as Extract<PdfKernelResponse, { op: "document" }>;
    expect(reply).toMatchObject({ ok: true, op: "document", layoutId: "quebec", layoutChoice: "condition" });
    expect(sandboxed(request)).toBe(await inProcess(request));
  }, 60_000);

  it("prints an inline layout or one asked for by id whatever the conditions say", async () => {
    const quebecAnswers = { "address.province": "QC", largePrint: true };
    const inline = JSON.parse(sandboxed(documentRequest(quebecAnswers, { layout: PDF.layouts![0]! }))) as Extract<PdfKernelResponse, { op: "document" }>;
    expect(inline).toMatchObject({ ok: true, layoutId: "standard", layoutChoice: "given" });
    // An inline layout is the caller's choice: a `when` of its own is not tried either.
    const conditional = generated("large", "Large print", LARGE_PRINT);
    expect(JSON.parse(sandboxed(documentRequest({}, { layout: conditional })))).toMatchObject({ ok: true, layoutId: "large", layoutChoice: "given" });
    const asked = JSON.parse(sandboxed(documentRequest(quebecAnswers, { layoutId: "standard" }))) as Extract<PdfKernelResponse, { op: "document" }>;
    expect(asked).toMatchObject({ ok: true, layoutId: "standard", layoutChoice: "asked" });
    expect(asked.warnings.some((warning) => warning.code.startsWith("layout.condition"))).toBe(false);
    // An id the form lacks derives a layout, as it always did.
    expect(JSON.parse(sandboxed(documentRequest(quebecAnswers, { layoutId: "gone" })))).toMatchObject({ ok: true, layoutKind: "derived", layoutChoice: "derived" });
  }, 60_000);

  it("refuses template bytes a condition would fill under another layout's plan, and fills them once the layout is named", async () => {
    const [english, french] = await Promise.all([paper("Name"), paper("Nom")]);
    const pdf: PdfConfiguration = {
      layouts: [paperLayout("paper", "Name"), paperLayout("quebec-paper", "Nom", IS_QUEBEC), generated("large", "Large print", LARGE_PRINT)],
      defaultLayoutId: "paper"
    };
    const unasked = (values: Record<string, unknown>, bytes: Uint8Array, extra: Partial<PdfDocumentRequest> = {}): PdfDocumentRequest =>
      documentRequest({ name: "Ada", ...values }, { pdf, template: { data: bytesToBase64(bytes) }, ...extra });

    // The host resolved the default's bytes, as a 3.10 host would; the answers chose Quebec's paper.
    const refused = JSON.parse(sandboxed(unasked({ "address.province": "QC" }, english))) as { ok: false; error: { code: string; message: string } };
    expect(refused).toMatchObject({ ok: false, error: { code: "template" } });
    expect(refused.error.message).toContain('"quebec-paper"');
    expect(refused.error.message).toContain('send "layoutId": "quebec-paper"');
    expect(sandboxed(unasked({ "address.province": "QC" }, english))).toBe(await inProcess(unasked({ "address.province": "QC" }, english)));

    // Sent no bytes at all, the answers' template still needs them, and the refusal says how to ask.
    const bytesless = JSON.parse(sandboxed(documentRequest({ name: "Ada", "address.province": "QC" }, { pdf }))) as { ok: false; error: { code: string; message: string } };
    expect(bytesless).toMatchObject({ ok: false, error: { code: "template" } });
    expect(bytesless.error.message).toContain('Template layout "quebec-paper" needs its bytes');
    expect(bytesless.error.message).toContain('its condition chose it, so send "layoutId": "quebec-paper"');

    // The advice: build names the layout, and the document that names it takes that layout's bytes.
    const built = JSON.parse(sandboxed({ abi: PDF_ABI_VERSION, op: "build", form: FORM, pdf, values: { name: "Ada", "address.province": "QC" }, locale: "en" })) as Extract<PdfKernelResponse, { op: "build" }>;
    expect(built).toMatchObject({ layoutId: "quebec-paper", layoutKind: "template", layoutChoice: "condition" });
    const named = JSON.parse(sandboxed(unasked({ "address.province": "QC" }, french, { layoutId: built.layoutId }))) as Extract<PdfKernelResponse, { op: "document" }> & { bytes: string };
    expect(named).toMatchObject({ ok: true, layoutId: "quebec-paper", layoutKind: "template", layoutChoice: "asked", fields: [{ pdfField: "Nom", status: "filled", kind: "text" }] });
    expect((await reload(Buffer.from(named.bytes, "base64"))).getForm().getTextField("Nom").getText()).toBe("Ada");

    // Where the unasked bytes are the right ones, nothing is refused: no condition held, so the
    // default prints; a condition chose a generated layout, which takes no bytes.
    expect(JSON.parse(sandboxed(unasked({ "address.province": "ON" }, english)))).toMatchObject({ ok: true, layoutId: "paper", layoutChoice: "default", fields: [{ pdfField: "Name", status: "filled" }] });
    expect(JSON.parse(sandboxed(unasked({ largePrint: true }, english)))).toMatchObject({ ok: true, layoutId: "large", layoutKind: "generated", layoutChoice: "condition" });

    // ...and a condition that chose the very layout printed when none holds fills it as asked.
    const selfConditional: PdfConfiguration = { layouts: [paperLayout("paper", "Name", LARGE_PRINT), paperLayout("quebec-paper", "Nom", IS_QUEBEC)], defaultLayoutId: "paper" };
    expect(JSON.parse(sandboxed(unasked({ largePrint: true }, english, { pdf: selfConditional })))).toMatchObject({ ok: true, layoutId: "paper", layoutChoice: "condition", fields: [{ pdfField: "Name", status: "filled" }] });
  }, 60_000);
});
