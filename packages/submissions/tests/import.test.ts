import { describe, expect, it } from "vitest";
import { DEFAULT_FONT_PACK, createInProcessPdfProvider, handlePdfRequest, loadFontPack } from "@argusvane/datum-pdf-kernel";

import { InMemorySubmissionStore, createKernelValidator, createProviderPdfRenderer, createServerKeys, createSubmissionService, extractFromAttachment, type SubmissionPdfRenderer } from "../src/index.js";
import { GOOD_VALUES, INTAKE, envelopeOf } from "./service-receive.test.js";

const fontsPromise = loadFontPack({ entries: DEFAULT_FONT_PACK.filter((entry) => entry.id.startsWith("dejavu-sans")) });

async function renderer(): Promise<SubmissionPdfRenderer> {
  return createProviderPdfRenderer({ provider: createInProcessPdfProvider(), fonts: await fontsPromise, build: handlePdfRequest });
}

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 15, 12, 0, tick++));
}

describe("a PDF back into a record", () => {
  it("imports a server PDF through its record.json: the same document, the same digest, where it came from, and the PDF's signature verdict", async () => {
    const store = new InMemorySubmissionStore();
    const clock = fixedClock();
    const keys = createServerKeys(store, { commonName: "Import test", clock });
    let n = 0;
    const service = createSubmissionService({ store, validator: createKernelValidator(), pdf: await renderer(), keys, clock, ids: () => `rec-${++n}` });
    await service.register(INTAKE, { pdf: { enabled: true, sign: true, attachSubmission: true } });
    const original = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(GOOD_VALUES, "fr") }, { source: "renderer" });
    const pdf = (await service.getPdf(original.record.id))!;

    // The kernel hands the file back with its bytes when asked.
    const info = await (await renderer()).inspect(pdf.bytes, { attachments: "data" });
    expect(info.attachments?.map((entry) => entry.name)).toEqual(["record.json"]);
    expect(info.attachments?.[0]).toMatchObject({ relationship: "Data", mimeType: "application/json" });
    expect(extractFromAttachment(info)).toMatchObject({ method: "attachment", formId: "intake", formVersion: "1.0.0", locale: "fr", digest: original.record.digest });
    // ...and lists nothing when not asked, as a 3.7 caller expects.
    expect((await (await renderer()).inspect(pdf.bytes)).attachments).toBeUndefined();

    // Imported while the original is still here: a note says so; imported after it is gone: the record comes back.
    const duplicate = await service.importPdf(pdf.bytes, { fileName: "copy.pdf" });
    expect(duplicate.notes).toEqual([`a record with the same digest is already here: ${original.record.id}`]);
    await service.deleteRecord(original.record.id);
    await service.deleteRecord(duplicate.record.id);

    const imported = await service.importPdf(pdf.bytes, { fileName: "intake-rec-1.pdf" });
    expect(imported.method).toBe("attachment");
    expect(imported.notes).toEqual([]);
    expect(imported.record).toMatchObject({
      status: "accepted",
      source: "pdf-import",
      locale: "fr",
      digest: original.record.digest,
      document: original.record.document,
      importedFrom: { fileName: "intake-rec-1.pdf", method: "attachment", signatureStatus: "valid" }
    });
    expect(imported.receipt?.details?.[0]).toEqual({ label: "Record", value: imported.record.id });
    // The form still renders PDFs, so the imported record got a fresh one of its own, signed.
    expect(imported.record.pdf).toMatchObject({ signed: true, attached: true });
    expect(imported.record.pdf?.sha256).not.toBe(original.record.pdf?.sha256);

    // A form that renders no PDF keeps the imported one, so the record shows what it was read from.
    await service.updateSettings("intake@1.0.0", { pdf: null });
    await service.deleteRecord(imported.record.id);
    const kept = await service.importPdf(pdf.bytes, { fileName: "again.pdf" });
    expect(kept.record.pdf).toMatchObject({ fileName: "again.pdf", layoutId: "imported", signed: true, attached: true });
    expect(kept.record.signatures?.pdf).toEqual({ count: 1, status: "valid" });
    expect((await service.inspectRecord(kept.record.id)).pdf?.signatures[0]).toMatchObject({ status: "valid", trust: "this-server" });
  });

  it("refuses a PDF with neither record.json nor form fields, and one from an unknown form", async () => {
    const store = new InMemorySubmissionStore();
    const service = createSubmissionService({ store, validator: createKernelValidator(), pdf: await renderer() });
    await service.register(INTAKE, { pdf: { enabled: true, sign: false, attachSubmission: false } });
    const plain = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(GOOD_VALUES) });
    const pdf = (await service.getPdf(plain.record.id))!;
    await expect(service.importPdf(pdf.bytes)).rejects.toMatchObject({ code: "not_extractable", message: expect.stringContaining("has no form fields") });

    // The attachment names a form the server does not know.
    await service.updateSettings("intake@1.0.0", { pdf: { attachSubmission: true } });
    const carrying = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf({ ...GOOD_VALUES, notes: "carrying the document" }) });
    const bytes = (await service.getPdf(carrying.record.id))!.bytes;
    const other = createSubmissionService({ store: new InMemorySubmissionStore(), validator: createKernelValidator(), pdf: await renderer() });
    await expect(other.importPdf(bytes)).rejects.toMatchObject({ code: "unknown_form" });

    const none = createSubmissionService({ store: new InMemorySubmissionStore(), validator: createKernelValidator() });
    await expect(none.importPdf(bytes)).rejects.toMatchObject({ code: "pdf_unavailable" });
  });
});
