import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, decodePDFRawStream, type SecurityOptions } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import type { PdfFillArea } from "@argusvane/datum-engine/render";
import { fillTemplate, inspectTemplate } from "../src/kernel/template.js";
import { formTemplate, templateWithClearMetadata } from "./encryption-fixtures.js";
import { ENV, fonts, PLAN_THEME, reload } from "./helpers.js";
import { FILL_OPTIONS } from "./pdfa-fixtures.js";

/**
 * Encrypted templates are decrypted on load. The fixtures are made here with the
 * fork's own `encrypt()` (`encryption-fixtures.ts`): a one-page AcroForm, the empty user
 * password every published "can print and fill, cannot edit" form uses, and an owner password
 * the kernel never sees.
 */
const template = formTemplate;

const FILL_ONLY: SecurityOptions = { userPassword: "", ownerPassword: "owner", algorithm: "AES-128", permissions: { printing: "lowResolution", fillingForms: true } };

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");
const codes = (warnings: Array<{ code: string }>): string[] => warnings.map((warning) => warning.code);

const draw: PdfFillArea["draw"] = { kind: "text", fontSize: 10, align: "start", valign: "top", padding: 2, wrap: true, bold: false };
const AREA: PdfFillArea = { id: "note", page: 1, rect: { x: 20, y: 20, width: 200, height: 20 }, value: "Drawn", draw };

describe("encrypted templates", () => {
  it("fills a template whose owner permits filling but not modifying, and writes it unencrypted", async () => {
    const bytes = await template(FILL_ONLY);
    const filled = await fillTemplate(bytes, { Name: "Ada Lovelace", Agree: true }, FILL_OPTIONS, await fonts(), ENV);
    expect(filled.fields.map((field) => field.status)).toEqual(["filled", "filled"]);
    expect(codes(filled.warnings)).toEqual(["template.decrypted"]);
    // Loads with no password and no encryption flag: nothing of /Encrypt survives in the output.
    expect(latin1(filled.bytes)).not.toContain("/Encrypt");
    const pdf = await reload(filled.bytes);
    expect(pdf.isEncrypted).toBe(false);
    expect(pdf.getForm().getTextField("Name").getText()).toBe("Ada Lovelace");
    expect(pdf.getForm().getCheckBox("Agree").isChecked()).toBe(true);
  });

  it("reads each cipher and revision, with object streams too", async () => {
    const forms: Array<[string, SecurityOptions, { useObjectStreams: boolean }]> = [
      ["AES-256 (R6)", { userPassword: "", ownerPassword: "owner", algorithm: "AES-256", permissions: { fillingForms: true } }, { useObjectStreams: true }],
      ["AES-128 (R4)", { userPassword: "", ownerPassword: "owner", algorithm: "AES-128", permissions: { fillingForms: true } }, { useObjectStreams: true }],
      ["RC4-128 (R3)", { userPassword: "", ownerPassword: "owner", algorithm: "RC4-128", allowWeakCryptography: true, permissions: { fillingForms: true } }, { useObjectStreams: false }],
      // Revision 2 has no fill bit of its own: bit 6 (annotate) governs.
      ["RC4-40 (R2)", { userPassword: "", ownerPassword: "owner", algorithm: "RC4-40", allowWeakCryptography: true, permissions: { annotating: true } }, { useObjectStreams: false }]
    ];
    for (const [label, security, save] of forms) {
      const filled = await fillTemplate(await template(security, save), { Name: label }, FILL_OPTIONS, await fonts(), ENV);
      expect(codes(filled.warnings), label).toEqual(["template.decrypted"]);
      expect((await reload(filled.bytes)).getForm().getTextField("Name").getText(), label).toBe(label);
    }
  });

  it("warns, rather than refuses, when flattening or drawing areas goes beyond a template that forbids modifying", async () => {
    const bytes = await template(FILL_ONLY);
    const flattened = await fillTemplate(bytes, { Name: "Ada" }, { ...FILL_OPTIONS, flatten: true }, await fonts(), ENV);
    expect(codes(flattened.warnings)).toEqual(["template.decrypted", "template.permissions"]);
    expect((await reload(flattened.bytes)).getForm().getFields()).toHaveLength(0);

    const drawn = await fillTemplate(bytes, { Name: "Ada" }, FILL_OPTIONS, await fonts(), ENV, [AREA], undefined, undefined, PLAN_THEME);
    expect(codes(drawn.warnings)).toEqual(["template.decrypted", "template.permissions"]);
    expect(drawn.areas?.map((area) => area.status)).toEqual(["filled"]);

    // The owner allows modifying: the decryption is still said, the permissions are not in question.
    const modifiable = await template({ ...FILL_ONLY, permissions: { fillingForms: true, modifying: true } });
    const flat = await fillTemplate(modifiable, { Name: "Ada" }, { ...FILL_OPTIONS, flatten: true }, await fonts(), ENV, [AREA], undefined, undefined, PLAN_THEME);
    expect(codes(flat.warnings)).toEqual(["template.decrypted"]);
  });

  it("refuses a template whose owner does not allow filling", async () => {
    const bytes = await template({ userPassword: "", ownerPassword: "owner", algorithm: "AES-128", permissions: { printing: "highResolution" } });
    const attempt = fillTemplate(bytes, { Name: "Ada" }, FILL_OPTIONS, await fonts(), ENV);
    await expect(attempt).rejects.toMatchObject({ code: "template", message: expect.stringContaining("do not allow filling its form fields") });
    // Inspecting reads what the owner allows without filling anything: it still answers.
    const info = await inspectTemplate(bytes);
    expect(info.permissions).toMatchObject({ print: true, printHighQuality: true, fillForms: false, modify: false });
  });

  it("refuses a template that needs a real password, saying it is encrypted, and never asks for one", async () => {
    const bytes = await template({ userPassword: "open sesame", ownerPassword: "owner", algorithm: "AES-128", permissions: { fillingForms: true } });
    for (const attempt of [fillTemplate(bytes, {}, FILL_OPTIONS, await fonts(), ENV), inspectTemplate(bytes)]) {
      await expect(attempt).rejects.toMatchObject({ code: "template", message: expect.stringMatching(/encrypted with a password.*unencrypted copy/) });
    }
  });

  it("says an encrypted template could not be read, not that it needs a password, when something else fails", async () => {
    // The trailer's /ID keys the encryption: with it gone the reader fails, and a password is not what is missing.
    const bytes = await template(FILL_ONLY);
    const trailer = latin1(bytes).lastIndexOf("/ID");
    expect(trailer).toBeGreaterThan(0);
    const noId = Uint8Array.from(bytes);
    noId.set(Buffer.from("/XX"), trailer);
    for (const attempt of [fillTemplate(noId, {}, FILL_OPTIONS, await fonts(), ENV), inspectTemplate(noId)]) {
      const failure = await attempt.then(() => undefined, (error: unknown) => error as Error);
      expect(failure).toMatchObject({ code: "template", message: expect.stringMatching(/^The template is encrypted and could not be read: .+/) });
      expect(failure?.message).not.toMatch(/with a password|unencrypted copy/);
    }
  });

  it("refuses a security handler other than the standard one", async () => {
    const bytes = await template(FILL_ONLY);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const encrypt = pdf.context.lookup(pdf.context.trailerInfo.Encrypt, PDFDict);
    encrypt.set(PDFName.of("Filter"), PDFName.of("Adobe.PubSec"));
    const foreign = await pdf.save({ useObjectStreams: false });
    await expect(inspectTemplate(foreign)).rejects.toMatchObject({ code: "template", message: expect.stringMatching(/security handler.*unencrypted copy/) });
  });

  it("inspect says the original was encrypted and what the owner allows", async () => {
    const info = await inspectTemplate(await template(FILL_ONLY));
    expect(info.encrypted).toBe(true);
    expect(info.permissions).toEqual({ print: true, printHighQuality: false, modify: false, copy: false, annotate: false, fillForms: true, assemble: false });
    expect(info.fields.map((field) => field.name)).toEqual(["Name", "Agree"]);
    expect(info.warnings).toBeUndefined();

    const open = await inspectTemplate(await template({ userPassword: "", ownerPassword: "owner", algorithm: "AES-256", permissions: { printing: "highResolution", modifying: true, copying: true, annotating: true, fillingForms: true, documentAssembly: true } }));
    expect(open.permissions).toEqual({ print: true, printHighQuality: true, modify: true, copy: true, annotate: true, fillForms: true, assemble: true });

    const revisionTwo = await inspectTemplate(await template({ userPassword: "", ownerPassword: "owner", algorithm: "RC4-40", allowWeakCryptography: true, permissions: { printing: true, annotating: true } }));
    expect(revisionTwo.permissions).toMatchObject({ print: true, printHighQuality: true, annotate: true, fillForms: true, modify: false, assemble: false });
  });

  it("leaves an unencrypted template as it was: no permissions, no new warnings", async () => {
    const bytes = await template(undefined);
    const info = await inspectTemplate(bytes);
    expect(info.encrypted).toBe(false);
    expect(info).not.toHaveProperty("permissions");
    const filled = await fillTemplate(bytes, { Name: "Ada" }, { ...FILL_OPTIONS, flatten: true }, await fonts(), ENV, [AREA], undefined, undefined, PLAN_THEME);
    expect(filled.warnings).toEqual([]);
  });

  it("still refuses an encrypted template for PDF/A, keyed on what it was as supplied", async () => {
    const bytes = await template({ ...FILL_ONLY, permissions: { fillingForms: true, modifying: true } });
    await expect(fillTemplate(bytes, {}, FILL_OPTIONS, await fonts(), ENV, [], { pdfa: "2b" })).rejects.toMatchObject({ code: "conformance" });
  });

  it("reads a stream stored in the clear behind the Identity crypt filter (the XMP of /EncryptMetadata false)", async () => {
    // The fork cannot write /EncryptMetadata false; the stream is put into an encrypted file as such files carry it.
    const xmp = [
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2" pdfaid:conformance="B"/>',
      "</rdf:RDF></x:xmpmeta>",
      '<?xpacket end="w"?>'
    ].join("\n");
    const pdf = await PDFDocument.load(await template(FILL_ONLY), { ignoreEncryption: true, updateMetadata: false });
    const stream = pdf.context.stream(new TextEncoder().encode(xmp), { Type: "Metadata", Subtype: "XML", Filter: "Crypt" });
    pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(stream));
    const bytes = await pdf.save({ useObjectStreams: false });

    // Read as a PDF/A-2b file's metadata, which only decoding it right can do.
    expect((await inspectTemplate(bytes)).pdfa).toBe("2b");
    const filled = await fillTemplate(bytes, { Name: "Ada" }, FILL_OPTIONS, await fonts(), ENV);
    expect(codes(filled.warnings)).toEqual(["template.decrypted"]);
    const out = await reload(filled.bytes);
    const metadata = out.catalog.lookup(PDFName.of("Metadata"), PDFStream);
    expect(metadata.dict.has(PDFName.of("Filter"))).toBe(false);
    expect(new TextDecoder().decode((metadata as PDFRawStream).contents)).toBe(xmp);
    expect(out.context.trailerInfo.Encrypt).toBeUndefined();
  });

  it("keeps the deflated XMP of a file that sets /EncryptMetadata false: metadata is in the clear whatever its filters", async () => {
    const xmp = [
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2" pdfaid:conformance="B"/>',
      "</rdf:RDF></x:xmpmeta>",
      '<?xpacket end="w"?>'
    ].join("\n");
    const bytes = await templateWithClearMetadata(xmp);
    // The fixture is what it claims: the dictionary says so and the stream is deflated, not '<'.
    expect(latin1(bytes)).toContain("/EncryptMetadata false");

    expect((await inspectTemplate(bytes)).pdfa).toBe("2b");
    const filled = await fillTemplate(bytes, { Name: "Ada" }, FILL_OPTIONS, await fonts(), ENV);
    expect(codes(filled.warnings)).toEqual(["template.decrypted"]);
    const out = await reload(filled.bytes);
    const metadata = out.catalog.lookup(PDFName.of("Metadata"), PDFStream);
    expect(metadata.dict.lookup(PDFName.of("Filter"))).toBe(PDFName.of("FlateDecode"));
    expect(new TextDecoder().decode(decodePDFRawStream(metadata as PDFRawStream).decode())).toBe(xmp);
    expect(out.getForm().getTextField("Name").getText()).toBe("Ada");
  });
});
