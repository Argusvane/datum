import { describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import type { Expression, FormDefinition, PdfGeneratedLayout, PdfTemplateLayout } from "@argusvane/datum-engine";
import { DEFAULT_FONT_PACK, createInProcessPdfProvider, handlePdfRequest, loadFontPack, parseCertificate } from "@argusvane/datum-pdf-kernel";

import {
  InMemorySubmissionStore,
  SUBMISSION_ATTACHMENT_NAME,
  base64ToBytes,
  buildSubmissionAttachment,
  bytesDigest,
  createKernelValidator,
  createProviderPdfRenderer,
  createServerKeys,
  createSubmissionService,
  inspectPdfSignatures,
  mintServerKey,
  parseSubmissionAttachment,
  submissionDigest,
  type SubmissionPdfRenderer
} from "../src/index.js";
import { GOOD_VALUES, INTAKE, envelopeOf } from "./service-receive.test.js";

const fontsPromise = loadFontPack({ entries: DEFAULT_FONT_PACK.filter((entry) => entry.id.startsWith("dejavu-sans")) });

async function renderer(): Promise<SubmissionPdfRenderer> {
  return createProviderPdfRenderer({ provider: createInProcessPdfProvider(), fonts: await fontsPromise, build: handlePdfRequest, producer: "datum submissions test" });
}

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 15, 12, 0, tick++));
}

describe("the server's signing identity", () => {
  it("mints a P-256 key and a self-signed certificate once, keeps them, and exports PEMs a verifier can trust", async () => {
    const store = new InMemorySubmissionStore();
    const keys = createServerKeys(store, { commonName: "Test server", organization: "Datum tests", clock: fixedClock() });
    expect(await keys.certificate()).toBeUndefined();
    const [a, b] = await Promise.all([keys.material(), keys.material()]);
    expect(a.certificateDer).toBe(b.certificateDer);
    expect(a.algorithm).toBe("ECDSA-P256-SHA256");
    expect(a.subject).toContain("CN=Test server");
    expect((await store.getKeyMaterial())?.certificateDer).toBe(a.certificateDer);
    const parsed = parseCertificate(base64ToBytes(a.certificateDer));
    expect(parsed.selfSigned).toBe(true);
    // Valid from five minutes before the mint, for ten years.
    expect(parsed.notBefore.slice(0, 16)).toBe("2026-09-15T11:55");
    expect(parsed.notAfter.slice(0, 4)).toBe("2036");
    const exported = await keys.export();
    expect(exported.certificatePem).toMatch(/^-----BEGIN CERTIFICATE-----\n[\s\S]+-----END CERTIFICATE-----\n$/);
    expect(exported.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(new X509Certificate(exported.certificatePem).subject).toContain("CN=Test server");
    // Another service over the same store finds the same identity.
    expect((await createServerKeys(store).material()).certificateDer).toBe(a.certificateDer);
    const signer = await keys.signer();
    expect(signer.certificates).toEqual([a.certificateDer]);
    const value = await signer.sign(new TextEncoder().encode("hello"), "ECDSA-P256-SHA256");
    expect(value.length).toBe(64);
  });

  it("mints material with a clock and a subject of the caller's", async () => {
    const material = await mintServerKey({ commonName: "Elsewhere", days: 1, clock: () => new Date("2026-01-01T00:00:00.000Z") });
    const parsed = parseCertificate(base64ToBytes(material.certificateDer));
    expect(parsed.commonName).toBe("Elsewhere");
    expect(parsed.notAfter.slice(0, 10)).toBe("2026-01-02");
  });
});

describe("the record's PDF: rendered, signed, carrying its submission", () => {
  it("renders the record's layout with submission.json attached and the server's signature, and verify reads all of it back", async () => {
    const store = new InMemorySubmissionStore();
    // One clock for the key and the records: a certificate minted after the signing time it is checked against reads "not valid at signing", as it should.
    const clock = fixedClock();
    const keys = createServerKeys(store, { commonName: "Data tab test", clock });
    let n = 0;
    const service = createSubmissionService({ store, validator: createKernelValidator(), pdf: await renderer(), keys, clock, ids: () => `rec-${++n}` });
    await service.register(INTAKE, { pdf: { enabled: true, sign: true, attachSubmission: true } });
    const document = envelopeOf(GOOD_VALUES);
    const result = await service.receive({ submissionKey: crypto.randomUUID(), document });
    expect(result.record.status).toBe("accepted");
    expect(result.record.pdf).toMatchObject({ fileName: "intake-rec-1.pdf", signed: true, attached: true });
    expect(result.record.pdf?.pageCount).toBeGreaterThan(0);
    expect(result.record.signatures).toEqual({ envelope: { count: 0, status: "none" }, pdf: { count: 1, status: "valid" } });
    expect(result.receipt?.details?.map((detail) => detail.label)).toEqual(["Record", "Digest", "PDF"]);
    expect(result.receipt?.details?.[2]?.value).toBe("intake-rec-1.pdf (signed by the server)");

    const pdf = await service.getPdf("rec-1");
    expect(pdf?.mimeType).toBe("application/pdf");
    expect(new TextDecoder().decode(pdf!.bytes.subarray(0, 5))).toBe("%PDF-");
    expect(bytesDigest(pdf!.bytes)).toBe(result.record.pdf?.sha256);

    // Every attribute of the signature, itemised; the attachment's digest is the record's.
    const inspection = await service.inspectRecord("rec-1");
    expect(inspection.pdf?.summary).toEqual({ count: 1, status: "valid" });
    const [signature] = inspection.pdf!.signatures;
    expect(signature).toMatchObject({
      status: "valid",
      profile: "PAdES (CAdES detached)",
      trust: "this-server",
      chainLength: 1,
      signatureAlgorithm: "ecdsa-with-SHA256",
      checks: { coversDocument: true, digestMatches: true, certificateMatches: true, signatureValid: true, validAtSigning: true }
    });
    expect(signature?.signer?.subject).toContain("CN=Data tab test");
    expect(signature?.signer?.selfSigned).toBe(true);
    expect(signature?.reason).toBeUndefined();
    const attachment = inspection.pdf!.attachments.find((entry) => entry.name === SUBMISSION_ATTACHMENT_NAME);
    expect(attachment).toMatchObject({ relationship: "Data", matchesRecordDigest: true, sha256Hex: result.record.digest });

    // The same PDF inspected as a file names the record it came from, and a byte appended after the signature breaks it.
    const asFile = await service.inspectDocument({ kind: "pdf", bytes: pdf!.bytes });
    expect(asFile).toMatchObject({ kind: "pdf", carriesSubmission: true, recordId: "rec-1", formKey: "intake@1.0.0", digest: result.record.digest });
    const tampered = new Uint8Array(pdf!.bytes.length + 1);
    tampered.set(pdf!.bytes);
    tampered[tampered.length - 1] = 0x0a;
    const broken = await service.inspectDocument({ kind: "pdf", bytes: tampered });
    expect(broken.pdf?.summary.status).toBe("invalid");
    expect(broken.pdf?.signatures[0]).toMatchObject({ status: "invalid", checks: { coversDocument: false } });
    expect(broken.pdf?.signatures[0]?.reason).toMatch(/added after/);

    // Another server, with a key of its own, sees a signature it cannot trust: every check holds, the issuer is not its.
    const otherStore = new InMemorySubmissionStore();
    const other = createSubmissionService({ store: otherStore, validator: createKernelValidator(), pdf: await renderer(), keys: createServerKeys(otherStore, { commonName: "Other" }) });
    await other.exportServerKey();
    const foreign = await other.inspectDocument({ kind: "pdf", bytes: pdf!.bytes });
    expect(foreign.pdf?.signatures[0]).toMatchObject({ status: "unverifiable", trust: "self-signed", checks: { signatureValid: true } });
    expect(foreign.pdf?.signatures[0]?.reason).toMatch(/self-signed by a party not trusted here/);
    // ...unless it is told to trust that certificate.
    const trusting = createSubmissionService({ store: otherStore, validator: createKernelValidator(), pdf: await renderer(), trustedCertificates: [(await keys.material()).certificateDer] });
    expect((await trusting.inspectDocument({ kind: "pdf", bytes: pdf!.bytes })).pdf?.signatures[0]).toMatchObject({ status: "valid", trust: "trusted" });
  });

  it("renders unsigned when asked, warns instead of signing without a key, and skips the PDF without a renderer", async () => {
    const store = new InMemorySubmissionStore();
    const service = createSubmissionService({ store, validator: createKernelValidator(), pdf: await renderer(), ids: () => "r1" });
    await service.register(INTAKE, { pdf: { enabled: true, sign: false, attachSubmission: false } });
    const plain = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(GOOD_VALUES) });
    expect(plain.record.pdf).toMatchObject({ signed: false, attached: false });
    expect(plain.record.signatures?.pdf).toEqual({ count: 0, status: "none" });
    expect((await service.inspectRecord("r1")).pdf?.signatures).toEqual([]);

    await store.clear();
    await service.register(INTAKE, { pdf: { enabled: true, sign: true, attachSubmission: true } });
    const unsigned = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(GOOD_VALUES) });
    expect(unsigned.record.pdf?.signed).toBe(false);
    expect(unsigned.record.pdf?.warnings.some((warning) => warning.startsWith("pdf.unsigned"))).toBe(true);
    expect(unsigned.record.pdf?.attached).toBe(true);

    const bare = createSubmissionService({ store: new InMemorySubmissionStore(), validator: createKernelValidator() });
    await bare.register(INTAKE, { pdf: { enabled: true, sign: true, attachSubmission: true } });
    const none = await bare.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(GOOD_VALUES) });
    expect(none.record.pdf).toBeUndefined();
    expect(none.record.logs?.some((entry) => entry.message.startsWith("pdf.unavailable"))).toBe(true);
    expect(none.record.status).toBe("accepted");
    await expect(bare.inspectDocument({ kind: "pdf", bytes: new Uint8Array([1]) })).rejects.toMatchObject({ code: "pdf_unavailable" });
  });

  it("builds submission.json from the delivered document and reads it back to the same digest", () => {
    const document = envelopeOf(GOOD_VALUES);
    const attachment = buildSubmissionAttachment(document, "rec-9");
    expect(attachment).toMatchObject({ name: "record.json", mimeType: "application/json", relationship: "Data" });
    expect(attachment.description).toContain("rec-9");
    const back = parseSubmissionAttachment(base64ToBytes(attachment.data));
    expect(back.document).toEqual(document);
    expect(back.digest).toBe(submissionDigest(document));
    // The attachment's bytes hash to the record digest the kernel will report for it.
    expect(bytesDigest(base64ToBytes(attachment.data))).toBe(submissionDigest(document));
  });

  it("inspectPdfSignatures reports a PDF with no signatures as none, attachments listed", async () => {
    const pdf = await renderer();
    const rendered = await pdf.render({ definition: INTAKE as FormDefinition, values: GOOD_VALUES, locale: "en", documentId: "doc", createdAt: "2026-09-15T12:00:00.000Z", attachments: [buildSubmissionAttachment(envelopeOf(GOOD_VALUES), "x")] });
    expect(rendered.signed).toBe(false);
    expect(rendered.attached).toEqual(["record.json"]);
    const report = await inspectPdfSignatures(rendered.bytes, { verify: (bytes) => pdf.verify(bytes), expectedDigest: submissionDigest(envelopeOf(GOOD_VALUES)) });
    expect(report.summary).toEqual({ count: 0, status: "none" });
    expect(report.attachments[0]).toMatchObject({ name: "record.json", matchesRecordDigest: true });
  });
});

describe("the record's PDF: a layout chosen by the answers", () => {
  const IS_ADA: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "firstName" }, right: { kind: "literal", value: "Ada" } };

  function generated(id: string, when?: Expression): PdfGeneratedLayout {
    return {
      id,
      kind: "generated",
      ...(when ? { when } : {}),
      root: { id: `${id}-doc`, type: "pdf-document", configuration: {}, children: { body: [{ id: `${id}-title`, type: "pdf-text", configuration: { text: id } }] } }
    };
  }

  /** The intake form, with a copy for Ada: her first name sits in a container, so it arrives as `applicant.firstName` and the condition names it by id. */
  const CONDITIONAL: FormDefinition = { ...INTAKE, pdf: { layouts: [generated("standard"), generated("ada-copy", IS_ADA)], defaultLayoutId: "standard" } };

  async function serviceFor(definition: FormDefinition, layoutId?: string) {
    const store = new InMemorySubmissionStore();
    let n = 0;
    const service = createSubmissionService({ store, validator: createKernelValidator(), pdf: await renderer(), ids: () => `rec-${++n}` });
    await service.register(definition, { pdf: { enabled: true, sign: false, attachSubmission: false, ...(layoutId ? { layoutId } : {}) } });
    return service;
  }

  it("prints the layout whose condition holds on the judged answers when the settings name none, else the default; an operator's layout wins", async () => {
    const service = await serviceFor(CONDITIONAL);
    const ada = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(GOOD_VALUES) });
    expect(ada.record.pdf).toMatchObject({ layoutId: "ada-copy", layoutChoice: "condition" });
    const grace = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf({ ...GOOD_VALUES, "applicant.firstName": "Grace" }) });
    expect(grace.record.pdf).toMatchObject({ layoutId: "standard", layoutChoice: "default" });

    const operator = await serviceFor(CONDITIONAL, "standard");
    const overridden = await operator.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(GOOD_VALUES) });
    expect(overridden.record.pdf).toMatchObject({ layoutId: "standard", layoutChoice: "asked" });
    // A form without conditions prints its default as before, now saying so.
    const plain = await serviceFor({ ...INTAKE, pdf: { layouts: [generated("standard"), generated("other")], defaultLayoutId: "other" } });
    expect((await plain.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(GOOD_VALUES) })).record.pdf).toMatchObject({ layoutId: "other", layoutChoice: "default" });
  });

  it("accepts the record when the template its answers chose cannot be resolved, and the log names that layout", async () => {
    // Only the people whose answers choose the paper copy reach a template this server has no
    // resolver for: their records are still accepted, with the reason in the log.
    const paper: PdfTemplateLayout = {
      id: "paper-copy",
      kind: "template",
      when: IS_ADA,
      template: { storage: "url", name: "paper.pdf", type: "application/pdf", size: 1, ref: "/templates/paper.pdf" },
      fields: [{ pdfField: "Name", source: { kind: "component", componentId: "firstName" } }]
    };
    const service = await serviceFor({ ...INTAKE, pdf: { layouts: [generated("standard"), paper], defaultLayoutId: "standard" } });
    const ada = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(GOOD_VALUES) });
    expect(ada.record.status).toBe("accepted");
    expect(ada.record.pdf).toBeUndefined();
    const failed = ada.record.logs?.find((entry) => entry.message.startsWith("pdf.failed"));
    expect(failed?.level).toBe("error");
    expect(failed?.message).toContain('Template layout "paper-copy" (its condition held on the answers) has no PDF this server can resolve');
    expect(failed?.message).toContain('No resolver for template storage "url"');
    const grace = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf({ ...GOOD_VALUES, "applicant.firstName": "Grace" }) });
    expect(grace.record.pdf).toMatchObject({ layoutId: "standard", layoutChoice: "default" });
  });
});
