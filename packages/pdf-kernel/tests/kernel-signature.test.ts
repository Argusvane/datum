import { PDFDict, PDFHexString, PDFName } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, type PdfKernelResponse, type PdfSignatureReport, type PdfSignatureSpec } from "@argusvane/datum-engine/render";
import { renderDocument } from "../src/kernel/render.js";
import { OID, compareEncodings, integer, oid, read, readOid, readTime, setOf, time, tlv } from "../src/kernel/signature/der.js";
import { parseSignedData } from "../src/kernel/signature/cms.js";
import { completeSignature, prepareSignature } from "../src/kernel/signature/sign.js";
import { verifySignatures } from "../src/kernel/signature/verify.js";
import { parseCertificate, signatureAlgorithmFor } from "../src/kernel/signature/x509.js";
import { handlePdfRequest } from "../src/program/entry.js";
import { ENV, document, fonts, paragraph, reload, widgetsShown } from "./helpers.js";
import { certificateBase64, hasOpenssl, hostSign, hostVerify, identity, opensslTimestamp, opensslVerifies, type FixtureName } from "./signing-fixtures.js";

const openssl = hasOpenssl();

async function unsignedRecord(): Promise<Uint8Array> {
  const rendered = await renderDocument(document([paragraph("p1", "An application, as submitted."), paragraph("p2", "Second paragraph.")]), await fonts(), ENV);
  return rendered.bytes;
}

async function signWith(name: FixtureName, input: Uint8Array, spec: Partial<PdfSignatureSpec> = {}, encoding: "der" | "ieee-p1363" = "der") {
  const who = identity(name);
  const prepared = await prepareSignature(input, { certificates: who.certificates, ...spec }, await fonts(), ENV);
  const value = hostSign(who, prepared.signing.toBeSigned, encoding);
  const { timestamp: _reserve, ...completionSpec } = spec;
  const completed = await completeSignature(prepared.bytes, { certificates: who.certificates, ...completionSpec, value, toBeSignedDigest: prepared.signing.toBeSignedDigest });
  return { who, prepared, completed };
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

describe("DER", () => {
  it("encodes lengths, integers, object identifiers and times the way X.690 asks", () => {
    expect([...tlv(0x04, new Uint8Array(1))]).toEqual([4, 1, 0]);
    expect([...tlv(0x04, new Uint8Array(127)).subarray(0, 2)]).toEqual([4, 127]);
    expect([...tlv(0x04, new Uint8Array(128)).subarray(0, 3)]).toEqual([4, 0x81, 128]);
    expect([...tlv(0x04, new Uint8Array(256)).subarray(0, 4)]).toEqual([4, 0x82, 1, 0]);
    expect([...tlv(0x04, new Uint8Array(70000)).subarray(0, 5)]).toEqual([4, 0x83, 1, 0x11, 0x70]);
    expect([...integer(0)]).toEqual([2, 1, 0]);
    expect([...integer(127)]).toEqual([2, 1, 127]);
    expect([...integer(128)]).toEqual([2, 2, 0, 128]);
    expect([...integer(new Uint8Array([0, 0, 0x80]))]).toEqual([2, 2, 0, 0x80]);
    const sha = oid(OID.sha256);
    expect([...sha]).toEqual([6, 9, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
    expect(readOid(sha, read(sha, 0))).toBe(OID.sha256);
    const rsa = oid(OID.sha256WithRSA);
    expect(readOid(rsa, read(rsa, 0))).toBe(OID.sha256WithRSA);
    const utc = time("2026-09-14T10:11:12.000Z");
    expect(utc[0]).toBe(0x17);
    expect(readTime(utc, read(utc, 0))).toBe("2026-09-14T10:11:12Z");
    const general = time("2051-01-02T03:04:05Z");
    expect(general[0]).toBe(0x18);
    expect(readTime(general, read(general, 0))).toBe("2051-01-02T03:04:05Z");
  });

  it("sorts a SET OF by encoding — the length byte before the content, the shorter padded with zeros", () => {
    const a = tlv(0x30, new Uint8Array([1, 2]));
    const c = tlv(0x30, new Uint8Array([1, 3]));
    const b = tlv(0x30, new Uint8Array([1, 2, 0]));
    expect(compareEncodings(a, c)).toBeLessThan(0);
    // A longer element sorts after a shorter one whose bytes it shares, since its length byte is larger.
    expect(compareEncodings(c, b)).toBeLessThan(0);
    // Padding: equal up to the shorter's end, then the zeros of the padding against the rest.
    expect(compareEncodings(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(0);
    expect(compareEncodings(new Uint8Array([1, 2]), new Uint8Array([1, 2, 1]))).toBeLessThan(0);
    const set = setOf([b, c, a]);
    const inner = read(set, 0);
    expect([...set.subarray(inner.start, inner.start + a.length)]).toEqual([...a]);
    expect(setOf([a, b, c])).toEqual(set);
  });
});

describe("X.509", () => {
  it.each(["rsa2048", "p256", "p384", "chain-leaf"] as const)("reads the %s fixture", (name) => {
    const who = identity(name);
    const certificate = parseCertificate(base64ToBytes(who.certificates[0]!));
    expect(certificate.subject).toContain("CN=");
    expect(certificate.subject).toContain("O=Datum");
    expect(certificate.notBefore < certificate.notAfter).toBe(true);
    expect(certificate.serialHex.length).toBeGreaterThan(0);
    expect(signatureAlgorithmFor(certificate)).toBe(who.algorithm);
    expect(certificate.keyUsage).toContain("digitalSignature");
    expect(certificate.selfSigned).toBe(name !== "chain-leaf");
  });

  it("refuses a key it cannot describe", () => {
    const certificate = parseCertificate(base64ToBytes(certificateBase64("rsa2048.cert.pem")));
    expect(() => signatureAlgorithmFor({ ...certificate, keyAlgorithm: OID.rsassaPss })).toThrow(/RSASSA-PSS/);
    expect(() => signatureAlgorithmFor({ ...certificate, keyAlgorithm: OID.ecPublicKey, curve: "1.2.3" })).toThrow(/curve/);
  });
});

describe("signing a rendered record", () => {
  it.each(["rsa2048", "p256", "p384", "chain-leaf"] as const)("prepares, completes and verifies with %s", async (name) => {
    const input = await unsignedRecord();
    const { who, prepared, completed } = await signWith(name, input, { reason: "Submitted through the web form", location: "Ottawa" });
    expect(prepared.signing.signatureAlgorithm).toBe(who.algorithm);
    expect(prepared.signing.field).toBe("Signature1");
    expect(prepared.signing.subFilter).toBe("ETSI.CAdES.detached");
    // The original bytes are untouched; the update is appended.
    expect(latin1(prepared.bytes.subarray(0, input.length))).toBe(latin1(input));
    expect(prepared.bytes.length).toBeGreaterThan(input.length);
    expect(completed.field).toBe("Signature1");
    expect(completed.bytes.length).toBe(prepared.bytes.length);

    const verified = await verifySignatures(completed.bytes);
    expect(verified.warnings.filter((warning) => warning.code !== "signature.certificate")).toEqual([]);
    expect(verified.signatures).toHaveLength(1);
    const report = verified.signatures[0]!;
    expect(report).toMatchObject({
      field: "Signature1",
      subFilter: "ETSI.CAdES.detached",
      coversDocument: true,
      digestMatches: true,
      certificateMatches: true,
      reason: "Submitted through the web form",
      location: "Ottawa",
      signingTime: "2026-09-05T10:11:12Z",
      certification: null
    });
    expect(report.signer?.certificate).toBe(who.certificates[0]);
    expect(report.certificates).toHaveLength(who.certificates.length);
    expect(report.signingTimeAttribute).toBeUndefined();
    expect(hostVerify(report)).toBe(true);
    if (openssl) {
      const independent = opensslVerifies(completed.bytes, report, bytesToBase64(completed.cms));
      expect(independent.output).toContain("Verification successful");
      expect(independent.ok).toBe(true);
    }
    // pdf.js opens it and shows the widget.
    const shown = await widgetsShown(completed.bytes);
    expect(shown.map((widget) => widget.name)).toContain("Signature1");
  });

  it("signs a commitment type and the signer's statement as attributes the key covers", async () => {
    const input = await unsignedRecord();
    const commitment = { type: "approval" as const, statement: "I approve this application as submitted." };
    const { who, prepared, completed } = await signWith("rsa2048", input, { reason: "Approved", commitment });
    // The attributes the host signed carry the ETSI proof-of-approval OID and the statement.
    const toBeSigned = Buffer.from(prepared.signing.toBeSigned, "base64");
    expect(toBeSigned.includes(Buffer.from("I approve this application as submitted.", "utf8"))).toBe(true);
    const verified = await verifySignatures(completed.bytes);
    const report = verified.signatures[0]!;
    expect(report.commitment).toEqual(commitment);
    expect(report.digestMatches).toBe(true);
    expect(hostVerify(report)).toBe(true);
    if (openssl) {
      const independent = opensslVerifies(completed.bytes, report, bytesToBase64(completed.cms));
      expect(independent.output).toContain("Verification successful");
    }
    // Without a statement only the type rides along; an unknown type is refused.
    const bare = await signWith("p256", input, { commitment: { type: "receipt" } });
    expect((await verifySignatures(bare.completed.bytes)).signatures[0]?.commitment).toEqual({ type: "receipt" });
    await expect(prepareSignature(input, { certificates: who.certificates, commitment: { type: "telepathy" as never } }, await fonts(), ENV)).rejects.toThrow(/commitment type/);
    // A statement changed between sign and complete is caught by the attribute digest.
    const stale = await prepareSignature(input, { certificates: who.certificates, commitment }, await fonts(), ENV);
    await expect(
      completeSignature(stale.bytes, { certificates: who.certificates, commitment: { type: "approval", statement: "Something else" }, value: hostSign(who, stale.signing.toBeSigned, "der"), toBeSignedDigest: stale.signing.toBeSignedDigest })
    ).rejects.toThrow(/commitment changed/);
    // A signature without one reports none.
    const plain = await signWith("rsa2048", input);
    expect((await verifySignatures(plain.completed.bytes)).signatures[0]?.commitment).toBeUndefined();
  });

  it("is deterministic: the same inputs prepare and (with RSA) complete to the same bytes", async () => {
    const input = await unsignedRecord();
    const first = await signWith("rsa2048", input);
    const second = await signWith("rsa2048", input);
    expect(latin1(first.prepared.bytes)).toBe(latin1(second.prepared.bytes));
    expect(latin1(first.completed.bytes)).toBe(latin1(second.completed.bytes));
  });

  it("accepts an ECDSA value as raw r‖s and reports it back both ways", async () => {
    const input = await unsignedRecord();
    const { completed } = await signWith("p256", input, {}, "ieee-p1363");
    const report = (await verifySignatures(completed.bytes)).signatures[0]!;
    expect(report.digestMatches).toBe(true);
    expect(hostVerify(report)).toBe(true);
    expect(base64ToBytes(report.signatureP1363!)).toHaveLength(64);
  });

  it("writes the older Adobe PKCS#7 profile on request, with a signingTime attribute", async () => {
    const input = await unsignedRecord();
    const { completed } = await signWith("rsa2048", input, { subFilter: "adbe.pkcs7.detached" });
    const report = (await verifySignatures(completed.bytes)).signatures[0]!;
    expect(report.subFilter).toBe("adbe.pkcs7.detached");
    expect(report.signingTimeAttribute).toBe("2026-09-05T10:11:12Z");
    expect(report.digestMatches).toBe(true);
    expect(hostVerify(report)).toBe(true);
    const pdf = await reload(completed.bytes);
    expect(pdf.catalog.lookupMaybe(PDFName.of("Extensions"), PDFDict)).toBeUndefined();
  });

  it("certifies the document (DocMDP) and refuses a further signature under P=1", async () => {
    const input = await unsignedRecord();
    const { completed } = await signWith("rsa2048", input, { certify: "noChanges" });
    const report = (await verifySignatures(completed.bytes)).signatures[0]!;
    expect(report.certification).toEqual({ permissions: "noChanges" });
    const pdf = await reload(completed.bytes);
    const perms = pdf.catalog.lookupMaybe(PDFName.of("Perms"), PDFDict);
    expect(perms?.has(PDFName.of("DocMDP"))).toBe(true);
    // ISO 32000-1 readers learn the PAdES subfilter through the ESIC extension.
    const extensions = pdf.catalog.lookupMaybe(PDFName.of("Extensions"), PDFDict);
    expect(extensions?.lookupMaybe(PDFName.of("ESIC"), PDFDict)?.lookup(PDFName.of("ExtensionLevel"))?.toString()).toBe("2");
    await expect(prepareSignature(completed.bytes, { certificates: identity("p256").certificates }, await fonts(), ENV)).rejects.toThrow(/no changes allowed/);
  });

  it("adds a second approval signature under P=2 and keeps the first valid", async () => {
    const input = await unsignedRecord();
    const first = await signWith("rsa2048", input, { certify: "formFilling", name: "Forms office" });
    const second = await signWith("p256", first.completed.bytes, { reason: "Countersigned" });
    expect(second.prepared.signing.field).toBe("Signature2");
    const verified = await verifySignatures(second.completed.bytes);
    expect(verified.signatures.map((report) => [report.field, report.digestMatches, report.coversDocument])).toEqual([
      ["Signature1", true, false],
      ["Signature2", true, true]
    ]);
    expect(verified.signatures[0]!.certification).toEqual({ permissions: "formFilling" });
    expect(verified.signatures[0]!.name).toBe("Forms office");
    expect(hostVerify(verified.signatures[0]!)).toBe(true);
    expect(hostVerify(verified.signatures[1]!)).toBe(true);
    await expect(prepareSignature(second.completed.bytes, { certificates: identity("rsa2048").certificates, certify: "noChanges" }, await fonts(), ENV)).rejects.toThrow(/first signature/);
  });

  it("signs into a layout's own signature widget and draws the appearance there", async () => {
    const rendered = await renderDocument(
      document([paragraph("p1", "Please sign below."), { id: "w1", kind: "widget", label: "Authorised by", field: { name: "server-signature", kind: "signature" } }]),
      await fonts(),
      ENV
    );
    const { completed, prepared } = await signWith("rsa2048", rendered.bytes, { field: "server-signature", reason: "Approved" });
    expect(prepared.signing.field).toBe("server-signature");
    const pdf = await reload(completed.bytes);
    const widget = pdf.getForm().getField("server-signature").acroField.getWidgets()[0]!;
    const normal = widget.getAppearances()?.normal;
    expect(normal).toBeDefined();
    expect(latin1(completed.bytes)).toContain("/DatumSignatureFont");
    expect((widget.dict.get(PDFName.of("TU")) as PDFHexString).decodeText()).toContain("Digitally signed by Datum demo signer");
    const report = (await verifySignatures(completed.bytes)).signatures[0]!;
    expect(report.field).toBe("server-signature");
    expect(report.digestMatches).toBe(true);
    await expect(prepareSignature(completed.bytes, { certificates: identity("rsa2048").certificates, field: "server-signature" }, await fonts(), ENV)).rejects.toThrow(/already signed/);
    await expect(prepareSignature(rendered.bytes, { certificates: identity("rsa2048").certificates, field: "nowhere" }, await fonts(), ENV)).rejects.toThrow(/no signature field named/);
  });

  it("makes an invisible signature when the appearance is off, and places a visible one where asked", async () => {
    const input = await unsignedRecord();
    const invisible = await signWith("rsa2048", input, { appearance: false });
    let pdf = await reload(invisible.completed.bytes);
    let widget = pdf.getForm().getField("Signature1").acroField.getWidgets()[0]!;
    expect(widget.getRectangle()).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(widget.getAppearances()?.normal).toBeDefined();
    const placed = await signWith("rsa2048", input, { appearance: { page: 1, rect: [72, 72, 200, 60], lines: ["Sealed by the forms office", "Reference 42"], fontSize: 9 } });
    pdf = await reload(placed.completed.bytes);
    widget = pdf.getForm().getField("Signature1").acroField.getWidgets()[0]!;
    const rectangle = widget.getRectangle();
    expect(rectangle.width).toBe(200);
    expect(rectangle.height).toBe(60);
    expect(rectangle.x).toBe(72);
    expect(rectangle.y).toBeCloseTo(pdf.getPage(0).getHeight() - 72 - 60, 5);
    expect((widget.dict.get(PDFName.of("TU")) as PDFHexString).decodeText()).toBe("Sealed by the forms office, Reference 42");
  });

  it("carries a timestamp token the host fetched, and reports it", async () => {
    if (!openssl) {
      return;
    }
    const input = await unsignedRecord();
    const who = identity("rsa2048");
    const prepared = await prepareSignature(input, { certificates: who.certificates, timestamp: true }, await fonts(), ENV);
    const value = hostSign(who, prepared.signing.toBeSigned);
    const request = await handlePdfRequest({ abi: "4.0.0", op: "timestampRequest", signature: value });
    expect(request).toMatchObject({ ok: true, op: "timestampRequest" });
    const token = opensslTimestamp((request as { request: string }).request);
    const completed = await completeSignature(prepared.bytes, { certificates: who.certificates, value, timestamp: { token } });
    expect(completed.timestamped).toBe(true);
    const report = (await verifySignatures(completed.bytes)).signatures[0]!;
    expect(report.digestMatches).toBe(true);
    expect(report.timestamp).toMatchObject({ coversSignature: true, tsa: expect.stringContaining("Datum demo TSA") });
    expect(report.timestamp?.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(hostVerify(report)).toBe(true);
    const cms = parseSignedData(completed.cms);
    expect(cms.timestampToken).toBeDefined();
    // A token over a different value is refused.
    const other = await prepareSignature(input, { certificates: who.certificates, timestamp: true, reason: "other" }, await fonts(), ENV);
    const otherValue = hostSign(who, other.signing.toBeSigned);
    await expect(completeSignature(other.bytes, { certificates: who.certificates, reason: "other", value: otherValue, timestamp: { token } })).rejects.toThrow(/different signature value/);
  });
});

describe("what sign and complete refuse", () => {
  it("catches a change between sign and complete, a wrong value shape and a placeholder too small", async () => {
    const input = await unsignedRecord();
    const who = identity("rsa2048");
    const prepared = await prepareSignature(input, { certificates: who.certificates }, await fonts(), ENV);
    const value = hostSign(who, prepared.signing.toBeSigned);
    await expect(completeSignature(prepared.bytes, { certificates: identity("p256").certificates, value, toBeSignedDigest: prepared.signing.toBeSignedDigest })).rejects.toThrow(/differ/);
    await expect(completeSignature(prepared.bytes, { certificates: identity("p256").certificates, value })).rejects.toThrow(/ECDSA signature value/);
    await expect(completeSignature(prepared.bytes, { certificates: who.certificates, value: bytesToBase64(new Uint8Array(16)) })).rejects.toThrow(/at least 128 bytes/);
    await expect(prepareSignature(input, { certificates: who.certificates, placeholderBytes: 512 }, await fonts(), ENV)).rejects.toThrow(/no room/);
    await expect(prepareSignature(input, { certificates: who.certificates, placeholderBytes: 1 << 20 }, await fonts(), ENV)).rejects.toThrow(/up to 65536/);
    await expect(prepareSignature(input, { certificates: [] }, await fonts(), ENV)).rejects.toThrow(/at least the signer/);
    await expect(prepareSignature(input, { certificates: who.certificates, subFilter: "adbe.x509.rsa_sha1" as never }, await fonts(), ENV)).rejects.toThrow(/subFilter/);
    // A prepared file is not signed again before it is completed.
    await expect(prepareSignature(prepared.bytes, { certificates: who.certificates }, await fonts(), ENV)).rejects.toThrow(/complete it/);
    await expect(completeSignature(input, { certificates: who.certificates, value })).rejects.toThrow(/no prepared signature/);
  });

  it("finds tampering after the fact", async () => {
    const input = await unsignedRecord();
    const { completed } = await signWith("rsa2048", input);
    const tampered = new Uint8Array(completed.bytes);
    // One byte inside the signed range that leaves the file parseable: the header's minor version.
    const at = latin1(tampered).indexOf("%PDF-1.") + "%PDF-1.".length;
    expect(at).toBeGreaterThan("%PDF-1.".length - 1);
    tampered[at] = tampered[at] === "7".charCodeAt(0) ? "6".charCodeAt(0) : "7".charCodeAt(0);
    const report = (await verifySignatures(tampered)).signatures[0]!;
    expect(report.digestMatches).toBe(false);
    expect(report.certificateMatches).toBe(true);
    // The value still verifies over the attributes — it is the document that no longer matches them.
    expect(hostVerify(report)).toBe(true);
    // Appending bytes: the signature no longer covers the file.
    const appended = new Uint8Array(completed.bytes.length + 8);
    appended.set(completed.bytes);
    const later = (await verifySignatures(appended)).signatures[0]!;
    expect(later.coversDocument).toBe(false);
    expect(later.digestMatches).toBe(true);
  });

  it("warns about certificate hygiene", async () => {
    const input = await unsignedRecord();
    const expired = [certificateBase64("expired.cert.pem")];
    const prepared = await prepareSignature(input, { certificates: expired }, await fonts(), ENV);
    expect(prepared.warnings.map((warning) => warning.code)).toEqual(["signature.certificateExpired"]);
    const orphan = await prepareSignature(input, { certificates: [certificateBase64("chain-leaf.cert.pem")] }, await fonts(), ENV);
    expect(orphan.warnings.map((warning) => warning.code)).toEqual(["signature.chainIncomplete"]);
  });
});

describe("through the program", () => {
  it("prepares on document, completes and verifies through the ops, and inspect reports the field", async () => {
    const who = identity("rsa2048");
    const rendered = await renderDocument(document([paragraph("p1", "Hello")]), await fonts(), ENV);
    const sign = (await handlePdfRequest({ abi: "4.0.0", op: "sign", pdf: { data: bytesToBase64(rendered.bytes) }, signature: { certificates: who.certificates, certify: "noChanges" }, env: ENV })) as Extract<PdfKernelResponse, { op: "sign" }>;
    expect(sign.ok).toBe(true);
    const value = hostSign(who, sign.signing.toBeSigned);
    const complete = (await handlePdfRequest({ abi: "4.0.0", op: "complete", pdf: { data: sign.bytes }, signing: { certificates: who.certificates, certify: "noChanges", value } })) as Extract<PdfKernelResponse, { op: "complete" }>;
    expect(complete).toMatchObject({ ok: true, field: "Signature1", timestamped: false });
    const verify = (await handlePdfRequest({ abi: "4.0.0", op: "verify", pdf: { data: complete.bytes } })) as Extract<PdfKernelResponse, { op: "verify" }>;
    expect(verify.signatures).toHaveLength(1);
    expect(verify.signatures[0]).toMatchObject({ digestMatches: true, certification: { permissions: "noChanges" } });
    expect(hostVerify(verify.signatures[0] as PdfSignatureReport)).toBe(true);
    const inspect = (await handlePdfRequest({ abi: "4.0.0", op: "inspect", template: { data: complete.bytes } })) as Extract<PdfKernelResponse, { op: "inspect" }>;
    expect(inspect.info.signatures).toBe(1);
    expect(inspect.info.fields.find((field) => field.name === "Signature1")).toMatchObject({ kind: "signature", signed: true });
    const capabilities = (await handlePdfRequest({ abi: "4.0.0", op: "capabilities" })) as Extract<PdfKernelResponse, { op: "capabilities" }>;
    expect(capabilities.features).toContain("signature");
  });

  it("answers invalid requests with codes", async () => {
    expect(await handlePdfRequest({ abi: "4.0.0", op: "sign", pdf: {}, signature: {}, env: ENV })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await handlePdfRequest({ abi: "4.0.0", op: "complete", pdf: { data: "AA==" } })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await handlePdfRequest({ abi: "4.0.0", op: "timestampRequest", signature: "" })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await handlePdfRequest({ abi: "4.0.0", op: "verify", pdf: { data: bytesToBase64(new Uint8Array([1, 2, 3])) } })).toMatchObject({ ok: false });
  });
});
