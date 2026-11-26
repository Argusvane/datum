import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { bytesToBase64, type PdfDocumentAttachment } from "@argusvane/datum-engine/render";
import { renderDocument } from "../src/kernel/render.js";
import { fillTemplate } from "../src/kernel/template.js";
import { ENV, RED_PNG_BASE64, fonts, reload } from "./helpers.js";
import { FILL_OPTIONS, SUBMISSION, archivalDocument, pdfLibTemplate, plainTemplate, withoutClaim } from "./pdfa-fixtures.js";

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

const PHOTO: PdfDocumentAttachment = {
  name: "photo.png",
  mimeType: "image/png",
  description: "Supporting document",
  relationship: "Supplement",
  data: RED_PNG_BASE64,
  componentId: "supportingDocument"
};

const NOTES: PdfDocumentAttachment = {
  name: "notes.txt",
  mimeType: "text/plain",
  relationship: "Supplement",
  data: bytesToBase64(new TextEncoder().encode("hello ".repeat(200))),
  componentId: "notes"
};

/** The file specifications the catalog associates, keyed by their `F` name. */
async function specsOf(bytes: Uint8Array): Promise<Map<string, PDFDict>> {
  const pdf = await reload(bytes);
  const af = pdf.catalog.lookup(PDFName.of("AF"), PDFArray);
  const out = new Map<string, PDFDict>();
  for (let i = 0; i < af.size(); i += 1) {
    const spec = af.lookup(i, PDFDict);
    out.set(spec.lookup(PDFName.of("UF"), PDFHexString).decodeText(), spec);
  }
  return out;
}

function embeddedStream(spec: PDFDict): PDFStream {
  return spec.lookup(PDFName.of("EF"), PDFDict).lookup(PDFName.of("F"), PDFStream);
}

describe("uploaded files as attachments", () => {
  it("embeds uploaded files in an ordinary PDF, raw for binary types and flate for text, and echoes their names", async () => {
    const rendered = await renderDocument(withoutClaim(archivalDocument({ attachments: [PHOTO, NOTES] })), await fonts(), ENV);
    expect(rendered.pdfa).toBeUndefined();
    expect(rendered.attachments).toEqual(["photo.png", "notes.txt"]);
    expect(rendered.warnings).toEqual([]);
    const specs = await specsOf(rendered.bytes);
    expect([...specs.keys()].sort()).toEqual(["notes.txt", "photo.png"]);

    const photo = specs.get("photo.png")!;
    expect(photo.lookup(PDFName.of("AFRelationship"))).toBe(PDFName.of("Supplement"));
    expect(photo.lookup(PDFName.of("Desc"), PDFHexString).decodeText()).toBe("Supporting document");
    expect(photo.lookup(PDFName.of("F"), PDFHexString).decodeText()).toBe("photo.png"); // hex text string
    const photoStream = embeddedStream(photo);
    expect(photoStream.dict.lookup(PDFName.of("Subtype"))).toBe(PDFName.of("image/png"));
    expect(photoStream.dict.has(PDFName.of("Filter"))).toBe(false);
    expect(bytesToBase64((photoStream as PDFRawStream).contents)).toBe(RED_PNG_BASE64);
    expect(photoStream.dict.lookup(PDFName.of("Params"), PDFDict).lookup(PDFName.of("ModDate"))?.toString()).toBe("(D:20260905101112Z)");

    const notesStream = embeddedStream(specs.get("notes.txt")!);
    expect(notesStream.dict.lookup(PDFName.of("Filter"))).toBe(PDFName.of("FlateDecode"));
    expect(Buffer.from(decodePDFRawStream(notesStream as PDFRawStream).decode()).toString("utf8")).toBe("hello ".repeat(200));

    const names = (await reload(rendered.bytes)).catalog.lookup(PDFName.of("Names"), PDFDict).lookup(PDFName.of("EmbeddedFiles"), PDFDict).lookup(PDFName.of("Names"), PDFArray);
    expect(names.size()).toBe(4);
    expect(latin1(rendered.bytes)).not.toContain("pdfaid:part");
  });

  it("sits beside the submission under PDF/A-3, a clash earning the upload a -2 suffix", async () => {
    const rendered = await renderDocument(
      archivalDocument({ conformance: { pdfa: "3b", attachments: [SUBMISSION] }, attachments: [PHOTO, { ...PHOTO, name: "submission.json", data: bytesToBase64(new TextEncoder().encode("{}")) }] }),
      await fonts(),
      ENV
    );
    expect(rendered.pdfa).toBe("3b");
    expect(rendered.warnings).toEqual([]);
    expect(rendered.attachments).toEqual(["submission.json", "photo.png", "submission-2.json"]);
    const specs = await specsOf(rendered.bytes);
    expect(specs.get("submission.json")!.lookup(PDFName.of("AFRelationship"))).toBe(PDFName.of("Data"));
    expect(specs.get("submission-2.json")!.lookup(PDFName.of("AFRelationship"))).toBe(PDFName.of("Supplement"));
  });

  it("refuses uploads under PDF/A-2 with one warning naming them, and echoes an empty list", async () => {
    const rendered = await renderDocument(archivalDocument({ conformance: { pdfa: "2b" }, attachments: [PHOTO, NOTES] }), await fonts(), ENV);
    expect(rendered.pdfa).toBe("2b");
    expect(rendered.attachments).toEqual([]);
    expect(rendered.warnings.map((warning) => warning.code)).toEqual(["pdfa.attachments"]);
    expect(rendered.warnings[0]!.message).toContain("photo.png, notes.txt");
    expect(latin1(rendered.bytes)).not.toContain("/EmbeddedFile");
  });

  it("keeps the uploads and drops the submission when the render says no PDF/A", async () => {
    const rendered = await renderDocument(archivalDocument({ conformance: { pdfa: "3b", attachments: [SUBMISSION] }, attachments: [PHOTO] }), await fonts(), ENV, { pdfa: false });
    expect(rendered.pdfa).toBeUndefined();
    expect(rendered.attachments).toEqual(["photo.png"]);
  });

  it("leaves out a file the host did not resolve, with the component named, and falls back to octet-stream for a type that is none", async () => {
    const pending: PdfDocumentAttachment = { name: "scan.pdf", mimeType: "application/pdf", relationship: "Supplement", source: { storage: "s3", name: "scan.pdf", type: "application/pdf", size: 3 }, componentId: "scan" };
    const untyped: PdfDocumentAttachment = { ...NOTES, name: "mystery", mimeType: "" };
    const rendered = await renderDocument(withoutClaim(archivalDocument({ attachments: [pending, untyped] })), await fonts(), ENV);
    expect(rendered.attachments).toEqual(["mystery"]);
    expect(rendered.warnings).toEqual([{ code: "attachment.unresolved", message: expect.stringContaining('storage "s3"'), componentId: "scan" }]);
    const specs = await specsOf(rendered.bytes);
    expect(embeddedStream(specs.get("mystery")!).dict.lookup(PDFName.of("Subtype"))).toBe(PDFName.of("application/octet-stream"));
  });

  it("echoes nothing when nothing was asked for", async () => {
    const rendered = await renderDocument(withoutClaim(archivalDocument()), await fonts(), ENV);
    expect(rendered.attachments).toBeUndefined();
    expect(latin1(rendered.bytes)).not.toContain("/EmbeddedFiles");
  });

  describe("templates", () => {
    it("embeds uploads into a plain template as any PDF, and into a part-2 template raised to 3", async () => {
      const plain = await fillTemplate(await plainTemplate(), { Name: "Ada" }, FILL_OPTIONS, await fonts(), ENV, [], undefined, [PHOTO]);
      expect(plain.pdfa).toBeUndefined();
      expect(plain.attachments).toEqual(["photo.png"]);
      expect((await specsOf(plain.bytes)).get("photo.png")!.lookup(PDFName.of("AFRelationship"))).toBe(PDFName.of("Supplement"));

      const raised = await fillTemplate(await pdfLibTemplate("2B"), { Name: "Ada" }, FILL_OPTIONS, await fonts(), ENV, [], { pdfa: "3b" }, [PHOTO]);
      expect(raised.pdfa).toBe("3b");
      expect(raised.attachments).toEqual(["photo.png"]);
      expect(raised.warnings.map((warning) => warning.code)).not.toContain("pdfa.attachments");
    });

    it("refuses uploads for a template kept at part 2", async () => {
      const kept = await fillTemplate(await pdfLibTemplate("2B"), { Name: "Ada" }, FILL_OPTIONS, await fonts(), ENV, [], { pdfa: "2b" }, [PHOTO]);
      expect(kept.pdfa).toBe("2b");
      expect(kept.attachments).toEqual([]);
      expect(kept.warnings.map((warning) => warning.code)).toContain("pdfa.attachments");
    });
  });
});
