import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import type { ComponentNode } from "@argusvane/datum-engine/core";
import { DEFAULT_PDF_AREA_DRAW, PDF_BUILTIN_PROFILES, builtinProfileSource } from "@argusvane/datum-engine/core";
import {
  PDF_ABI_VERSION,
  PdfKernelError,
  buildPdfCompleteRequest,
  buildPdfFillRequest,
  buildPdfInspectRequest,
  buildPdfRenderRequest,
  buildPdfSignRequest,
  buildPdfVerifyRequest,
  bytesToBase64,
  type PdfBlock,
  type PdfDocumentRequest,
  type PdfRenderProvider
} from "@argusvane/datum-engine/render";
import { createInProcessPdfProvider } from "../src/in-process-provider.js";
import { createQuickJsPdfProvider, type QuickJsPdfProvider } from "../src/quickjs-provider.js";
import { formTemplate } from "./encryption-fixtures.js";
import { ENV, PDF_MAGIC, RED_PNG_BASE64, detachedTemplateBytes, document, extractText, fonts, head, paragraph } from "./helpers.js";
import { SUBMISSION, WIDGETS, archivalDocument, cffFont, cmykProfile, syllabicsDocument } from "./pdfa-fixtures.js";
import { hostSign, hostVerify, identity } from "./signing-fixtures.js";

/**
 * The invariant: the same request yields the same bytes whether the program
 * runs in-process or inside QuickJS-WASM — which is what a JVM or .NET host gets.
 */
describe("in-process vs QuickJS parity", () => {
  let quickJs: QuickJsPdfProvider;
  const inProcess: PdfRenderProvider = createInProcessPdfProvider();

  beforeAll(async () => {
    quickJs = await createQuickJsPdfProvider();
  }, 60_000);

  afterAll(() => {
    quickJs?.dispose();
  });

  function richDocument(): PdfBlock[] {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `r${index}`,
      cells: [
        { id: `r${index}a`, blocks: [paragraph(`r${index}a-p`, `Item ${index + 1}`)] },
        { id: `r${index}b`, blocks: [paragraph(`r${index}b-p`, `Quantity ${(index * 7) % 13}`)] }
      ]
    }));
    return [
      { id: "h1", kind: "heading", level: 1, runs: [{ text: "Parity fixture — مرحبا שלום" }] },
      { id: "lv", kind: "labelValue", label: "First name", value: [{ text: "Ada" }], arrangement: "inline" },
      { id: "ruled", kind: "labelValue", label: "Signature", value: [], arrangement: "ruled", lines: 2 },
      { id: "w1", kind: "widget", label: "Name", field: { name: "applicant.name", kind: "text", value: "Ada Lovelace", required: true } },
      { id: "w2", kind: "widget", label: "Agree", labelPosition: "after", field: { name: "agree", kind: "checkbox", value: true } },
      { id: "w3", kind: "widget", label: "Colour", field: { name: "colour", kind: "radio", value: "g", options: [{ value: "r", label: "Red" }, { value: "g", label: "Green" }] } },
      { id: "w4", kind: "widget", label: "Country", field: { name: "country", kind: "dropdown", value: "CA", options: [{ value: "CA", label: "Canada" }, { value: "FR", label: "France" }] } },
      { id: "chk", kind: "checklist", label: "Contact", items: [{ label: "Email", checked: true }, { label: "Phone", checked: false }] },
      { id: "img", kind: "image", resourceId: "logo", alt: "Logo", width: 40 },
      { id: "box", kind: "box", blocks: [paragraph("boxp", "In a box")], fill: "#eeeeee", border: { width: 1, color: "#333333" } },
      { id: "tbl", kind: "table", columns: [{ width: { fraction: 0.4 } }, {}], header: { id: "th", cells: [{ id: "h1c", header: true, blocks: [paragraph("h1p", "Item")] }, { id: "h2c", header: true, blocks: [paragraph("h2p", "Qty")] }] }, rows, repeatHeader: true, borders: "all" },
      { id: "brk", kind: "pageBreak" },
      paragraph("last", "After the break. ".repeat(80))
    ];
  }

  it("renders identical bytes for a rich document, plain and compact", async () => {
    const doc = document(richDocument(), {
      resources: { images: { logo: { type: "image/png", data: RED_PNG_BASE64 } } },
      header: [paragraph("hdr", "Header")],
      footer: [{ id: "ftr", kind: "paragraph", runs: [{ text: "Page " }, { text: "#", token: "pageNumber" }, { text: " of " }, { text: "#", token: "pageCount" }] }],
      page: { size: "A4", orientation: "portrait", margins: { top: 40, right: 40, bottom: 40, left: 40 }, header: { height: 20 }, footer: { height: 20 } },
      anchored: [{ id: "a", anchor: { page: "every", x: 400, y: 10, width: 150, height: 24 }, box: { id: "ab", kind: "box", blocks: [paragraph("abp", "Anchored")] } }]
    });
    for (const compact of [false, true]) {
      const request = buildPdfRenderRequest(doc, await fonts(), ENV, { compact });
      const started = Date.now();
      const sandboxed = await quickJs.render(request);
      const sandboxMs = Date.now() - started;
      const native = await inProcess.render(request);
      expect(head(sandboxed.bytes)).toBe(PDF_MAGIC);
      expect(sandboxed.pageCount).toBe(native.pageCount);
      expect(sandboxed.pages).toEqual(native.pages);
      expect(sandboxed.warnings).toEqual(native.warnings);
      expect(Buffer.compare(Buffer.from(sandboxed.bytes), Buffer.from(native.bytes))).toBe(0);
      // A visible record of the interpreter's cost, for the README's size table.
      console.log(`parity render (compact=${compact}): ${sandboxed.bytes.length} bytes, ${sandboxed.pageCount} pages, QuickJS ${sandboxMs} ms`);
    }
  }, 120_000);

  it("renders identical bytes for the `document` operation over a form tree", async () => {
    const form: ComponentNode = {
      id: "intake",
      type: "form",
      configuration: { title: "Parity form" },
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name", required: true } },
          { id: "vip", type: "checkbox", configuration: { label: "VIP" } },
          { id: "vipCode", type: "text", configuration: { label: "VIP code" }, rules: { visibleWhen: { kind: "path", path: "vip" } } },
          { id: "country", type: "select", configuration: { label: "Country", data: { sourceId: "countries" } } }
        ]
      }
    };
    const request: PdfDocumentRequest = {
      abi: PDF_ABI_VERSION,
      op: "document",
      form,
      values: { name: "Ada", vip: true, vipCode: "42", country: "CA" },
      locale: "en",
      optionSnapshot: { country: [{ value: "CA", label: "Canada" }] },
      fonts: await fonts(),
      env: ENV,
      options: { compact: false }
    };
    const sandboxed = await quickJs.document(request);
    const native = await inProcess.document!(request);
    expect(Buffer.compare(Buffer.from(sandboxed.bytes), Buffer.from(native.bytes))).toBe(0);
    expect(sandboxed.warnings).toEqual(native.warnings);
    // Both providers pass on which layout printed: none declared, so one was derived.
    expect({ layoutId: sandboxed.layoutId, layoutKind: sandboxed.layoutKind, layoutChoice: sandboxed.layoutChoice }).toEqual({ layoutId: native.layoutId, layoutKind: "derived", layoutChoice: "derived" });
  }, 60_000);

  it("tells a component type it has no rendition for the same way on both sides, and takes one from a module", async () => {
    const form: ComponentNode = {
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
    const request: PdfDocumentRequest = {
      abi: PDF_ABI_VERSION,
      op: "document",
      form,
      values: { name: "Ada", stars: 3 },
      locale: "en",
      fonts: await fonts(),
      env: ENV
    };
    const sandboxed = await quickJs.document(request);
    const native = await inProcess.document!(request);
    expect(Buffer.compare(Buffer.from(sandboxed.bytes), Buffer.from(native.bytes))).toBe(0);
    expect(sandboxed.warnings).toEqual(native.warnings);
    expect(sandboxed.warnings).toContainEqual(expect.objectContaining({ code: "component.unknown", componentId: "stars" }));

    const refusal = { ...request, unknownComponents: "fail" as const };
    const [fromSandbox, fromNative] = await Promise.all([
      quickJs.document(refusal).then(() => undefined, (error: unknown) => error as PdfKernelError),
      inProcess.document!(refusal).then(() => undefined, (error: unknown) => error as PdfKernelError)
    ]);
    expect(fromSandbox).toBeInstanceOf(PdfKernelError);
    expect(fromSandbox?.code).toBe("unknown_component");
    expect(fromSandbox?.message).toBe(fromNative?.message);

    // The module a Java or .NET host evaluates after the program: an ES2020 expression, no imports.
    const withModule = await createQuickJsPdfProvider({
      modules: [
        `({ pdfRenditions: [{ componentType: "rating", id: "stars", render: (node, context) => [{ id: context.nextId(), kind: "paragraph", runs: [{ text: "*".repeat(Number(context.value.text)) + " (" + context.value.text + ")" }] }] }] })`
      ]
    });
    try {
      const known = await withModule.document(refusal);
      expect(known.warnings.some((warning) => warning.code === "component.unknown")).toBe(false);
      expect((await extractText(known.bytes))[0]).toContain("*** (3)");
    } finally {
      withModule.dispose();
    }
  }, 120_000);

  it("decrypts, fills and inspects an encrypted template identically", async () => {
    // Decryption is the fork's pure JS: the sandbox needs no Web Crypto to read what a host's file already holds encrypted.
    const template = await formTemplate({ userPassword: "", ownerPassword: "owner", algorithm: "AES-128", permissions: { printing: "lowResolution", fillingForms: true } });
    const plan = {
      layoutId: "t",
      template: { storage: "base64", name: "locked.pdf", type: "application/pdf", size: template.length, data: bytesToBase64(template) },
      values: { Name: "Ada Lovelace", Agree: true },
      areas: [],
      options: { flatten: true, readOnly: false, appearances: "regenerate" as const }
    };
    const fillRequest = buildPdfFillRequest(plan, template, await fonts(), ENV);
    const sandboxed = await quickJs.fill(fillRequest);
    const native = await inProcess.fill!(fillRequest);
    expect(native.warnings.map((warning) => warning.code)).toEqual(["template.decrypted", "template.permissions"]);
    expect(sandboxed.warnings).toEqual(native.warnings);
    expect(sandboxed.fields).toEqual(native.fields);
    expect(Buffer.compare(Buffer.from(sandboxed.bytes), Buffer.from(native.bytes))).toBe(0);
    // Unencrypted output, whichever host wrote it.
    expect(Buffer.from(sandboxed.bytes).toString("latin1")).not.toContain("/Encrypt");

    const inspectRequest = buildPdfInspectRequest(template);
    const info = await quickJs.inspect(inspectRequest);
    expect(info).toEqual(await inProcess.inspect!(inspectRequest));
    expect(info).toMatchObject({ encrypted: true, permissions: { print: true, fillForms: true, modify: false } });

    // A static-XFA form, the usual kind: pdf-lib warns through a `console` the sandbox lacks.
    const xfa = await formTemplate({ userPassword: "", ownerPassword: "owner", algorithm: "AES-128", permissions: { fillingForms: true } }, undefined, { xfa: true });
    const xfaRequest = buildPdfFillRequest({ ...plan, template: { ...plan.template, size: xfa.length, data: bytesToBase64(xfa) } }, xfa, await fonts(), ENV);
    const xfaSandboxed = await quickJs.fill(xfaRequest);
    const xfaNative = await inProcess.fill!(xfaRequest);
    expect(xfaNative.warnings.map((warning) => warning.code)).toEqual(["template.decrypted", "template.permissions", "template.xfa_removed"]);
    expect(xfaSandboxed.warnings).toEqual(xfaNative.warnings);
    expect(Buffer.compare(Buffer.from(xfaSandboxed.bytes), Buffer.from(xfaNative.bytes))).toBe(0);
    expect(await quickJs.inspect(buildPdfInspectRequest(xfa))).toMatchObject({ hasXfa: true, encrypted: true });

    // A password the sandbox cannot be given is the same refusal in both.
    const locked = await formTemplate({ userPassword: "secret", ownerPassword: "owner", algorithm: "AES-128", permissions: { fillingForms: true } });
    const refusal = { code: "template", message: expect.stringContaining("encrypted with a password") };
    await expect(quickJs.inspect(buildPdfInspectRequest(locked))).rejects.toMatchObject(refusal);
    await expect(inProcess.inspect!(buildPdfInspectRequest(locked))).rejects.toMatchObject(refusal);
  }, 60_000);

  it("fills and inspects a template identically", async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([300, 300]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const formApi = pdf.getForm();
    formApi.createTextField("Name").addToPage(page, { x: 20, y: 240, width: 200, height: 20, font });
    formApi.createCheckBox("Agree").addToPage(page, { x: 20, y: 200, width: 14, height: 14 });
    const template = await pdf.save({ useObjectStreams: false, objectsPerTick: Infinity });

    const draw = { kind: "text" as const, fontSize: 10, align: "start" as const, valign: "top" as const, padding: 2, wrap: true, bold: false };
    const plan = {
      layoutId: "t",
      template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: template.length, data: bytesToBase64(template) },
      values: { Name: "Ada مرحبا", Agree: true },
      // Areas draw through the layout measurer and the writer inside the sandbox too.
      areas: [
        { id: "note", page: 1, rect: { x: 20, y: 20, width: 260, height: 40 }, value: "Drawn — نص عربي — over the page", draw: { ...draw, align: "center" as const, valign: "middle" as const } },
        { id: "tick", page: 1, rect: { x: 20, y: 70, width: 12, height: 12 }, value: "yes", draw: { ...draw, kind: "check" as const } },
        { id: "long", page: 1, rect: { x: 20, y: 90, width: 40, height: 10 }, value: "Too long for the box", draw: { ...draw, wrap: false } },
        // Fillable areas: transparent widgets made on the loaded page.
        { id: "extra", page: 1, rect: { x: 20, y: 110, width: 200, height: 14 }, value: "Fillable — عربي", draw: { ...draw, bold: true, align: "end" as const }, field: { name: "extra", required: true, readOnly: false, tooltip: "Extra" } },
        { id: "blank", page: 1, rect: { x: 20, y: 130, width: 200, height: 14 }, value: null, draw, field: { name: "blank", required: false, readOnly: false } },
        { id: "agreeToo", page: 1, rect: { x: 20, y: 150, width: 12, height: 12 }, value: "yes", draw: { ...draw, kind: "check" as const }, field: { name: "agree_too", required: false, readOnly: true } }
      ],
      options: { flatten: false, readOnly: false, appearances: "regenerate" as const }
    };
    const fillRequest = buildPdfFillRequest(plan, template, await fonts(), ENV);
    const sandboxed = await quickJs.fill(fillRequest);
    const native = await inProcess.fill!(fillRequest);
    expect(Buffer.compare(Buffer.from(sandboxed.bytes), Buffer.from(native.bytes))).toBe(0);
    expect(sandboxed.fields).toEqual(native.fields);
    expect(sandboxed.areas).toEqual(native.areas);
    expect(native.areas?.map((area) => area.status)).toEqual(["filled", "filled", "overflow", "filled", "empty", "filled"]);
    expect(native.areas?.slice(3).map((area) => area.field)).toEqual(["extra", "blank", "agree_too"]);
    expect(sandboxed.warnings).toEqual(native.warnings);

    const inspectRequest = buildPdfInspectRequest(template);
    expect(await quickJs.inspect(inspectRequest)).toEqual(await inProcess.inspect!(inspectRequest));
    expect(await quickJs.capabilities()).toEqual(await inProcess.capabilities!());
  }, 60_000);

  it("renders and fills PDF/A identically, attachment and custom intent included", async () => {
    const doc = archivalDocument({
      conformance: {
        pdfa: "3u",
        outputIntent: { profile: { data: bytesToBase64(cmykProfile()) }, identifier: "CGATS TR 001", info: "CGATS TR 001" },
        attachments: [SUBMISSION]
      }
    });
    const request = buildPdfRenderRequest(doc, await fonts(), ENV);
    const sandboxed = await quickJs.render(request);
    const native = await inProcess.render(request);
    expect(sandboxed.pdfa).toBe("3u");
    expect(sandboxed.warnings).toEqual([]);
    expect(Buffer.compare(Buffer.from(sandboxed.bytes), Buffer.from(native.bytes))).toBe(0);

    // The built-in conditions are the program's own bytes: the same on both sides, nothing resolved.
    for (const profile of PDF_BUILTIN_PROFILES) {
      const builtin = buildPdfRenderRequest(
        archivalDocument({ conformance: { pdfa: "2b", outputIntent: { profile: { source: builtinProfileSource(profile.id) }, identifier: profile.identifier, info: profile.info } } }),
        await fonts(),
        ENV
      );
      const fromSandbox = await quickJs.render(builtin);
      expect(fromSandbox.warnings).toEqual([]);
      expect(Buffer.compare(Buffer.from(fromSandbox.bytes), Buffer.from((await inProcess.render(builtin)).bytes))).toBe(0);
    }

    // The sandbox refuses the claim it cannot keep, the same way.
    const noFonts = buildPdfRenderRequest(doc, [], ENV);
    const [fromSandbox, fromNative] = await Promise.all([
      quickJs.render(noFonts).then(() => undefined, (error: unknown) => error as PdfKernelError),
      inProcess.render(noFonts).then(() => undefined, (error: unknown) => error as PdfKernelError)
    ]);
    expect(fromSandbox?.code).toBe("font");
    expect(fromSandbox?.message).toBe(fromNative?.message);

    const plan = {
      layoutId: "archive",
      template: { storage: "base64", name: "own.pdf", type: "application/pdf", size: native.bytes.length, data: bytesToBase64(native.bytes) },
      values: { first: "Grace", agree: false },
      areas: [],
      options: { flatten: true, readOnly: false, appearances: "regenerate" as const },
      conformance: { pdfa: "3b" as const, attachments: [SUBMISSION] }
    };
    const fillRequest = buildPdfFillRequest(plan, native.bytes, await fonts(), ENV);
    const filledSandboxed = await quickJs.fill(fillRequest);
    const filledNative = await inProcess.fill!(fillRequest);
    expect(filledSandboxed.pdfa).toBe("3u");
    expect(Buffer.compare(Buffer.from(filledSandboxed.bytes), Buffer.from(filledNative.bytes))).toBe(0);
    expect(filledSandboxed.warnings).toEqual(filledNative.warnings);
    expect((await quickJs.inspect(buildPdfInspectRequest(native.bytes))).pdfa).toBe("3u");
  }, 120_000);

  it("embeds uploaded files identically in an ordinary render and a fill, names echoed", async () => {
    const photo = { name: "photo.png", mimeType: "image/png", description: "Supporting document", relationship: "Supplement" as const, data: RED_PNG_BASE64, componentId: "doc" };
    const notes = { name: "notes.txt", mimeType: "text/plain", relationship: "Supplement" as const, data: bytesToBase64(new TextEncoder().encode("hello ".repeat(100))), componentId: "notes" };
    const plain = archivalDocument();
    const { conformance: _claim, ...unclaimed } = plain;
    const request = buildPdfRenderRequest({ ...unclaimed, attachments: [photo, notes] }, await fonts(), ENV);
    const sandboxed = await quickJs.render(request);
    const native = await inProcess.render(request);
    expect(sandboxed.pdfa).toBeUndefined();
    expect(sandboxed.attachments).toEqual(["photo.png", "notes.txt"]);
    expect(sandboxed.warnings).toEqual([]);
    expect(Buffer.compare(Buffer.from(sandboxed.bytes), Buffer.from(native.bytes))).toBe(0);
    expect(sandboxed.attachments).toEqual(native.attachments);

    const plan = {
      layoutId: "claims",
      template: { storage: "base64", name: "own.pdf", type: "application/pdf", size: native.bytes.length, data: bytesToBase64(native.bytes) },
      values: { first: "Grace" },
      areas: [],
      options: { flatten: false, readOnly: false, appearances: "regenerate" as const },
      attachments: [{ ...photo, name: "photo.png" }]
    };
    const fillRequest = buildPdfFillRequest(plan, native.bytes, await fonts(), ENV);
    const filledSandboxed = await quickJs.fill(fillRequest);
    const filledNative = await inProcess.fill!(fillRequest);
    // The template already carries a photo.png: the new one takes the next name.
    expect(filledSandboxed.attachments).toEqual(["photo-2.png"]);
    expect(Buffer.compare(Buffer.from(filledSandboxed.bytes), Buffer.from(filledNative.bytes))).toBe(0);
    expect(filledSandboxed.warnings).toEqual(filledNative.warnings);
  }, 120_000);

  it("prepares, completes and verifies a signature identically, over a plain and a compact file", async () => {
    const who = identity("rsa2048");
    const doc = document([paragraph("p", "A record to seal."), { id: "w", kind: "widget", label: "Sealed by", field: { name: "server-signature", kind: "signature" } }]);
    for (const compact of [false, true]) {
      const request = buildPdfRenderRequest(doc, await fonts(), ENV, { compact }, { certificates: who.certificates, certify: "noChanges", reason: "Parity", field: "server-signature" });
      const started = Date.now();
      const sandboxed = await quickJs.render(request);
      const sandboxMs = Date.now() - started;
      const native = await inProcess.render(request);
      expect(sandboxed.signing).toBeDefined();
      expect(sandboxed.signing).toEqual(native.signing);
      expect(sandboxed.warnings).toEqual(native.warnings);
      expect(Buffer.compare(Buffer.from(sandboxed.bytes), Buffer.from(native.bytes))).toBe(0);
      const value = hostSign(who, sandboxed.signing!.toBeSigned);
      const completion = buildPdfCompleteRequest(sandboxed.bytes, { certificates: who.certificates, certify: "noChanges", reason: "Parity", field: "server-signature", value, toBeSignedDigest: sandboxed.signing!.toBeSignedDigest });
      const completedSandboxed = await quickJs.complete(completion);
      const completedNative = await inProcess.complete!(completion);
      expect(Buffer.compare(Buffer.from(completedSandboxed.bytes), Buffer.from(completedNative.bytes))).toBe(0);
      const verifiedSandboxed = await quickJs.verify(buildPdfVerifyRequest(completedSandboxed.bytes));
      const verifiedNative = await inProcess.verify!(buildPdfVerifyRequest(completedNative.bytes));
      expect(verifiedSandboxed.signatures).toEqual(verifiedNative.signatures);
      expect(verifiedSandboxed.signatures[0]).toMatchObject({ field: "server-signature", digestMatches: true, coversDocument: true, certification: { permissions: "noChanges" } });
      expect(hostVerify(verifiedSandboxed.signatures[0]!)).toBe(true);
      // The update's cross-reference is the file's kind: a stream after a stream, a table after a table.
      const tail = Buffer.from(completedSandboxed.bytes.subarray(completedSandboxed.bytes.length - 2048)).toString("latin1");
      expect(tail.includes("/Type /XRef")).toBe(compact);
      console.log(`parity sign (compact=${compact}): ${completedSandboxed.bytes.length} bytes, QuickJS ${sandboxMs} ms`);
    }
    // A certification over a signed file is refused the same way on both sides.
    const request = buildPdfRenderRequest(doc, await fonts(), ENV, undefined, { certificates: who.certificates, certify: "noChanges" });
    const prepared = await inProcess.render(request);
    const again = buildPdfSignRequest(prepared.bytes, { certificates: who.certificates, certify: "noChanges" }, ENV);
    await expect(quickJs.sign(again)).rejects.toMatchObject({ code: "signature" });
    await expect(inProcess.sign!(again)).rejects.toMatchObject({ code: "signature" });
  }, 120_000);

  it("tags a level-\"a\" fill into the template's tree and embeds a CFF face identically", async () => {
    const both = [...(await fonts()), cffFont()];
    const request = buildPdfRenderRequest(syllabicsDocument({ conformance: { pdfa: "2a" }, blocks: [...syllabicsDocument().blocks, ...WIDGETS.slice(0, 2)] }), both, ENV);
    const sandboxed = await quickJs.render(request);
    const native = await inProcess.render(request);
    expect(sandboxed.pdfa).toBe("2a");
    expect(sandboxed.warnings).toEqual([]);
    expect(Buffer.compare(Buffer.from(sandboxed.bytes), Buffer.from(native.bytes))).toBe(0);

    const plan = {
      layoutId: "archive",
      template: { storage: "base64", name: "own.pdf", type: "application/pdf", size: native.bytes.length, data: bytesToBase64(native.bytes) },
      values: { first: "Grace" },
      areas: [
        { id: "a1", page: 1, rect: { x: 40, y: 600, width: 200, height: 20 }, value: "Drawn answer", draw: DEFAULT_PDF_AREA_DRAW },
        { id: "a3", page: 1, rect: { x: 40, y: 660, width: 200, height: 20 }, value: "Field answer", draw: DEFAULT_PDF_AREA_DRAW, field: { name: "area3", required: false, readOnly: false } }
      ],
      options: { flatten: false, readOnly: false, appearances: "regenerate" as const },
      conformance: { pdfa: "3a" as const, attachments: [SUBMISSION] }
    };
    const fillRequest = buildPdfFillRequest(plan, native.bytes, await fonts(), ENV);
    const filledSandboxed = await quickJs.fill(fillRequest);
    const filledNative = await inProcess.fill!(fillRequest);
    expect(filledSandboxed.pdfa).toBe("3a");
    expect(filledSandboxed.warnings).toEqual([]);
    expect(Buffer.compare(Buffer.from(filledSandboxed.bytes), Buffer.from(filledNative.bytes))).toBe(0);
    expect((await quickJs.inspect(buildPdfInspectRequest(filledNative.bytes))).pdfa).toBe("3a");
  }, 120_000);

  it("places and reattaches widgets a re-save detached from their pages identically", async () => {
    const template = await detachedTemplateBytes();
    const inspectRequest = buildPdfInspectRequest(template);
    const info = await inProcess.inspect!(inspectRequest);
    expect(info.fields.map((field) => field.page)).toEqual([1, 1, 2, 2, undefined]);
    expect(await quickJs.inspect(inspectRequest)).toEqual(info);

    const plan = {
      layoutId: "paper",
      template: { storage: "base64", name: "paper.pdf", type: "application/pdf", size: template.length, data: bytesToBase64(template) },
      values: { Name: "Ada", Colour: "Green", Other: "Elsewhere", Agree: true },
      areas: [],
      options: { flatten: false, readOnly: false, appearances: "regenerate" as const }
    };
    const fillRequest = buildPdfFillRequest(plan, template, [], ENV);
    const sandboxed = await quickJs.fill(fillRequest);
    const native = await inProcess.fill!(fillRequest);
    expect(Buffer.compare(Buffer.from(sandboxed.bytes), Buffer.from(native.bytes))).toBe(0);
    expect(native.warnings.map((warning) => warning.code)).toEqual(["template.widgets_relinked"]);
    expect(sandboxed.warnings).toEqual(native.warnings);
  }, 60_000);
});
