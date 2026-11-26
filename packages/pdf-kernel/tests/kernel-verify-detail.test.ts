/**
 * What `verify` reports so a server host need not read the PDF itself: the
 * timestamp token taken apart (and the TSA's signature verified here with Node's crypto, as a
 * host would), the signature dictionary as the revision it covers defines it, and the trailer
 * `/ID`.
 */
import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from "@cantoo/pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { PDF_ABI_VERSION, base64ToBytes, buildPdfVerifyRequest, bytesToBase64, type PdfKernelResponse, type PdfSignatureSpec, type PdfTimestampReport } from "@argusvane/datum-engine/render";
import { renderDocument } from "../src/kernel/render.js";
import { ecdsaToP1363, parseTimestampToken } from "../src/kernel/signature/cms.js";
import { OID, TAG, children, explicit, implicit, integer, oid, raw, read, sequence, setOf, tlv } from "../src/kernel/signature/der.js";
import { findSignatureFields } from "../src/kernel/signature/field.js";
import { parseCertificate } from "../src/kernel/signature/x509.js";
import { loadRevision } from "../src/kernel/signature/revision.js";
import { completeSignature, prepareSignature } from "../src/kernel/signature/sign.js";
import { verifySignatures } from "../src/kernel/signature/verify.js";
import { sha1 } from "../src/kernel/util/sha1.js";
import { sha384, sha512 } from "../src/kernel/util/sha512.js";
import { handlePdfRequest } from "../src/program/entry.js";
import { ENV, document, fonts, paragraph } from "./helpers.js";
import { certificateBase64, hasOpenssl, hostSign, hostVerify, identity, opensslTimestamp, type FixtureName } from "./signing-fixtures.js";

const openssl = hasOpenssl();

const HASH_NAMES: Record<string, string> = { [OID.sha1]: "sha1", [OID.sha256]: "sha256", [OID.sha384]: "sha384", [OID.sha512]: "sha512" };

async function unsignedRecord(): Promise<Uint8Array> {
  const rendered = await renderDocument(document([paragraph("p1", "An application, as submitted."), paragraph("p2", "Second paragraph.")]), await fonts(), ENV);
  return rendered.bytes;
}

async function signWith(name: FixtureName, input: Uint8Array, spec: Partial<PdfSignatureSpec> = {}) {
  const who = identity(name);
  const prepared = await prepareSignature(input, { certificates: who.certificates, ...spec }, await fonts(), ENV);
  const value = hostSign(who, prepared.signing.toBeSigned);
  const { timestamp: _reserve, ...completionSpec } = spec;
  const completed = await completeSignature(prepared.bytes, { certificates: who.certificates, ...completionSpec, value, toBeSignedDigest: prepared.signing.toBeSignedDigest });
  return { who, prepared, completed };
}

/**
 * A signature with a token from the fixture TSA. `settings` changes the TSA's configuration;
 * `alter` changes the token's bytes before it is embedded, as an attacker or a broken TSA would.
 */
async function timestamped(settings: Record<string, string> = {}, alter?: (token: Buffer) => Buffer | void, editRequest?: (request: Uint8Array) => Uint8Array) {
  const input = await unsignedRecord();
  const who = identity("rsa2048");
  const prepared = await prepareSignature(input, { certificates: who.certificates, timestamp: true, reason: "Submitted" }, await fonts(), ENV);
  const value = hostSign(who, prepared.signing.toBeSigned);
  const request = (await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "timestampRequest", signature: value })) as Extract<PdfKernelResponse, { op: "timestampRequest" }>;
  const asked = editRequest ? bytesToBase64(editRequest(base64ToBytes(request.request))) : request.request;
  let reply: Buffer = Buffer.from(opensslTimestamp(asked, settings), "base64");
  if (alter) {
    reply = alter(reply) ?? reply;
  }
  const completed = await completeSignature(prepared.bytes, { certificates: who.certificates, reason: "Submitted", value, timestamp: { token: reply.toString("base64") } });
  return { value, completed };
}

/** The host's check on a token: the TSA's signature over `toBeVerified`, with the reported signer's key. */
function hostVerifyTimestamp(timestamp: PdfTimestampReport): boolean {
  if (!timestamp.signer || !timestamp.toBeVerified || !timestamp.signature) {
    return false;
  }
  const key = createPublicKey({ key: Buffer.from(base64ToBytes(timestamp.signer.publicKey)), format: "der", type: "spki" });
  const hash = HASH_NAMES[timestamp.digestAlgorithm ?? ""];
  if (!hash) {
    return false;
  }
  const data = Buffer.from(base64ToBytes(timestamp.toBeVerified));
  const signature = Buffer.from(base64ToBytes(timestamp.signature));
  return key.asymmetricKeyType === "rsa" ? nodeVerify(hash, data, key, signature) : nodeVerify(hash, data, { key, dsaEncoding: "der" }, signature);
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

/**
 * Appends an incremental update: the objects as given, a cross-reference section of their own,
 * and a trailer with `/Prev`. The trailer carries the last `/ID` forward unless `id` gives
 * another (`/ID [...]` or `/ID n 0 R`).
 */
function appendUpdate(pdf: Uint8Array, objects: Array<{ number: number; generation: number; body: string }>, trailerExtra = "", id?: string): Uint8Array {
  const text = latin1(pdf);
  const root = /\/Root (\d+ \d+ R)/.exec(text)![1]!;
  const size = Math.max(...[...text.matchAll(/\/Size (\d+)/g)].map((match) => Number(match[1])));
  const previous = [...text.matchAll(/startxref\s+(\d+)/g)].at(-1)![1]!;
  const ids = [...text.matchAll(/\/ID\s*\[[^\]]*\]/g)];
  const lastId = ids.length > 0 ? ` ${ids.at(-1)![0]}` : "";
  let body = `${text}\n`;
  let xref = "xref\n0 1\n0000000000 65535 f \n";
  let newSize = size;
  for (const object of objects) {
    const offset = body.length;
    body += `${object.number} ${object.generation} obj\n${object.body}\nendobj\n`;
    xref += `${object.number} 1\n${String(offset).padStart(10, "0")} ${String(object.generation).padStart(5, "0")} n \n`;
    newSize = Math.max(newSize, object.number + 1);
  }
  const at = body.length;
  body += `${xref}trailer\n<< /Size ${newSize} /Root ${root} /Prev ${previous}${trailerExtra}${id !== undefined ? ` ${id}` : lastId} >>\nstartxref\n${at}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

/**
 * A later update that defines the last signature's dictionary again with some entries replaced
 * or added: `/ByteRange` and `/Contents` stay, so the signed bytes still hold.
 */
function redefineSignature(pdf: Uint8Array, entries: Record<string, string>): Uint8Array {
  const text = latin1(pdf);
  const at = text.lastIndexOf("/ByteRange");
  const header = [...text.slice(0, at).matchAll(/(\d+) (\d+) obj/g)].at(-1)!;
  const end = text.indexOf("endobj", at);
  let object = text.slice(header.index! + header[0].length, end).trim();
  for (const [key, value] of Object.entries(entries)) {
    const pattern = new RegExp(`${key.replace("/", "\\/")}\\s*(<[0-9A-Fa-f\\s]*>|\\([^)]*\\))`);
    object = pattern.test(object) ? object.replace(pattern, `${key} ${value}`) : object.replace("<<", `<< ${key} ${value}`);
  }
  return appendUpdate(pdf, [{ number: Number(header[1]), generation: Number(header[2]), body: object }]);
}

/** A later update that adds a new `/Info` and changes nothing the signature's dictionary says. */
function addInfo(pdf: Uint8Array, title: string): Uint8Array {
  const size = Math.max(...[...latin1(pdf).matchAll(/\/Size (\d+)/g)].map((match) => Number(match[1])));
  return appendUpdate(pdf, [{ number: size, generation: 0, body: `<< /Title (${title}) >>` }], ` /Info ${size} 0 R`);
}

/** An update that defines an indirect object again, as pdf-lib writes the given dictionary. */
function redefine(pdf: Uint8Array, ref: PDFRef, dict: PDFDict): Uint8Array {
  return appendUpdate(pdf, [{ number: ref.objectNumber, generation: ref.generationNumber, body: dict.toString() }]);
}

/** An update whose catalog drops `/AcroForm` and `/Perms`: no field and no DocMDP entry links a signature any more. */
async function unlinkSignatures(pdf: Uint8Array, alsoEmptyTheDictionary = false): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const catalog = doc.catalog.clone(doc.context);
  catalog.delete(PDFName.of("AcroForm"));
  catalog.delete(PDFName.of("Perms"));
  const root = doc.context.trailerInfo.Root as PDFRef;
  const objects = [{ number: root.objectNumber, generation: root.generationNumber, body: catalog.toString() }];
  if (alsoEmptyTheDictionary) {
    const value = findSignatureFields(doc)[0]!.dict.get(PDFName.of("V")) as PDFRef;
    objects.push({ number: value.objectNumber, generation: value.generationNumber, body: "<< >>" });
  }
  return appendUpdate(pdf, objects);
}

/**
 * A token (out of the fixture TSA's reply) rebuilt with its SignedData fields or its SignerInfo's
 * parts edited; lengths are encoded afresh. What is not signed (the certificates, the
 * SignerIdentifier) can change and leave the TSA's signature standing; what is, cannot.
 */
function rebuildToken(reply: Buffer, edit: { signedData?: (fields: Uint8Array[]) => Uint8Array[]; signerInfo?: (parts: Uint8Array[]) => Uint8Array[] }): Buffer {
  const bytes = new Uint8Array(reply);
  const [, tokenNode] = children(bytes, read(bytes, 0));
  const token = raw(bytes, tokenNode!);
  const [typeNode, wrapper] = children(token, read(token, 0));
  const fields = children(token, children(token, wrapper!)[0]!);
  const signerInfos = fields.at(-1)!;
  expect(signerInfos.tag).toBe(TAG.set);
  const parts = children(token, children(token, signerInfos)[0]!).map((part) => raw(token, part));
  const signerInfo = sequence(...(edit.signerInfo ? edit.signerInfo(parts) : parts));
  const others = fields.slice(0, -1).map((field) => raw(token, field));
  const rebuilt = sequence(...(edit.signedData ? edit.signedData(others) : others), setOf([signerInfo]));
  return Buffer.from(sequence(raw(token, typeNode!), explicit(0, rebuilt)));
}

function includes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle));
}

describe("the digests a timestamp token may name", () => {
  it("agree with Node's SHA-1, SHA-384 and SHA-512 at every padding boundary", () => {
    const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
    // Lengths around the 64- and 128-byte block edges, where the length field spills into a block of its own.
    const lengths = [0, 1, 3, 55, 56, 57, 63, 64, 65, 111, 112, 113, 127, 128, 129, 239, 240, 1000, 4099];
    for (const length of lengths) {
      const data = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        data[i] = (i * 151 + 7) & 0xff;
      }
      expect(hex(sha1(data)), `sha1 of ${length}`).toBe(createHash("sha1").update(data).digest("hex"));
      expect(hex(sha384(data)), `sha384 of ${length}`).toBe(createHash("sha384").update(data).digest("hex"));
      expect(hex(sha512(data)), `sha512 of ${length}`).toBe(createHash("sha512").update(data).digest("hex"));
    }
  });
});

describe("the r‖s form of an ECDSA signature", () => {
  it("refuses an integer wider than the curve's field rather than cutting it", () => {
    const fits = sequence(integer(new Uint8Array(32).fill(0x11)), integer(new Uint8Array(32).fill(0x22)));
    expect(ecdsaToP1363(fits, 32)).toHaveLength(64);
    const wide = sequence(integer(new Uint8Array(48).fill(0x11)), integer(new Uint8Array(32).fill(0x22)));
    expect(() => ecdsaToP1363(wide, 32)).toThrow(/wider than the 32-byte field/);
  });
});

describe.runIf(openssl)("a timestamp reported whole", () => {
  it("hands over the token, its signed attributes and the TSA's certificate, and checks the digests", async () => {
    const { value, completed } = await timestamped();
    const report = (await verifySignatures(completed.bytes)).signatures[0]!;
    expect(hostVerify(report)).toBe(true);
    const timestamp = report.timestamp!;
    const tsaCertificate = certificateBase64("tsa.cert.pem");
    expect(timestamp).toMatchObject({
      coversSignature: true,
      imprintAlgorithm: OID.sha256,
      digestAlgorithm: OID.sha256,
      // The fixture's serial file holds the last serial issued, so openssl answers with the next one.
      serial: "02",
      accuracy: { seconds: 1 },
      messageDigestMatches: true,
      contentTypeMatches: true,
      certificateMatches: true,
      certificates: [tsaCertificate]
    });
    expect(timestamp.nonce).toBeUndefined();
    expect(timestamp.signer?.certificate).toBe(tsaCertificate);
    expect(timestamp.signer?.subject).toContain("Datum demo TSA");
    expect(timestamp.imprint).toBe(createHash("sha256").update(Buffer.from(base64ToBytes(value))).digest("base64"));
    // The host's one step: the TSA's signature over the signed attributes, with the key reported.
    expect(hostVerifyTimestamp(timestamp)).toBe(true);
    // The token round-trips: it is the very ContentInfo the signature carries.
    const again = parseTimestampToken(base64ToBytes(timestamp.token!));
    expect(again.time).toBe(timestamp.time);
    expect(again.serialHex).toBe("02");
    expect(bytesToBase64(again.token)).toBe(timestamp.token);
  });

  it("reads a TSA that signs with SHA-512 and names its certificate by an ESSCertID (SHA-1)", async () => {
    const { completed } = await timestamped({ signer_digest: "sha512", ess_cert_id_alg: "sha1" });
    const timestamp = (await verifySignatures(completed.bytes)).signatures[0]!.timestamp!;
    expect(timestamp).toMatchObject({ digestAlgorithm: OID.sha512, messageDigestMatches: true, certificateMatches: true, coversSignature: true });
    expect(latin1(base64ToBytes(timestamp.toBeVerified!))).toContain(latin1(oid(OID.signingCertificate)));
    expect(hostVerifyTimestamp(timestamp)).toBe(true);
  });

  it("reads a TSA that signs with SHA-384 and states the ESSCertIDv2 algorithm", async () => {
    const { completed } = await timestamped({ signer_digest: "sha384", ess_cert_id_alg: "sha384" });
    const timestamp = (await verifySignatures(completed.bytes)).signatures[0]!.timestamp!;
    expect(timestamp).toMatchObject({ digestAlgorithm: OID.sha384, messageDigestMatches: true, certificateMatches: true });
    expect(hostVerifyTimestamp(timestamp)).toBe(true);
  });

  it("finds the TSA's certificate when the SignerInfo names it by subject key identifier", async () => {
    // openssl names the signer by issuer and serial; rewrite the token's SignerIdentifier as
    // `[0] subjectKeyIdentifier` (version 3), which is not signed, so the TSA's signature still holds.
    const keyId = parseCertificate(base64ToBytes(certificateBase64("tsa.cert.pem"))).subjectKeyId!;
    expect(keyId.length).toBeGreaterThan(0);
    const { completed } = await timestamped({}, (reply) => {
      const bytes = new Uint8Array(reply);
      const [, tokenNode] = children(bytes, read(bytes, 0));
      const token = raw(bytes, tokenNode!);
      const [typeNode, wrapper] = children(token, read(token, 0));
      const signedData = children(token, wrapper!)[0]!;
      const fields = children(token, signedData);
      const signerInfos = fields.at(-1)!;
      expect(signerInfos.tag).toBe(TAG.set);
      const parts = children(token, children(token, signerInfos)[0]!);
      const signerInfo = sequence(integer(3), tlv(0x80, keyId), ...parts.slice(2).map((part) => raw(token, part)));
      const rebuilt = sequence(...fields.slice(0, -1).map((field) => raw(token, field)), setOf([signerInfo]));
      return Buffer.from(sequence(raw(token, typeNode!), explicit(0, rebuilt)));
    });
    const timestamp = (await verifySignatures(completed.bytes)).signatures[0]!.timestamp!;
    expect(timestamp.signer?.certificate).toBe(certificateBase64("tsa.cert.pem"));
    expect(timestamp).toMatchObject({ messageDigestMatches: true, contentTypeMatches: true, certificateMatches: true });
    expect(hostVerifyTimestamp(timestamp)).toBe(true);
  });

  it("reports a token without a signing-certificate attribute as unbound (RFC 3161 §2.4.2)", async () => {
    const { completed } = await timestamped({}, (reply) =>
      rebuildToken(reply, {
        signerInfo: (parts) =>
          parts.map((part) => {
            if (part[0] !== 0xa0) {
              return part;
            }
            const set = read(part, 0);
            const kept = children(part, set).map((attribute) => raw(part, attribute)).filter((attribute) => !includes(attribute, oid(OID.signingCertificateV2)));
            return implicit(0, setOf(kept));
          })
      })
    );
    const verified = await verifySignatures(completed.bytes);
    const timestamp = verified.signatures[0]!.timestamp!;
    expect(timestamp.signer).not.toBeNull();
    expect(timestamp).toMatchObject({ messageDigestMatches: true, contentTypeMatches: true, certificateMatches: false });
    expect(verified.warnings.map((warning) => warning.message).join("\n")).toContain("RFC 3161 requires");
  });

  it("reports a signed contentType that is not id-ct-TSTInfo", async () => {
    const tstInfo = Buffer.from(oid(OID.tstInfo));
    const { completed } = await timestamped({}, (reply) => {
      // The first is the eContentType; the second the signed contentType attribute.
      const first = reply.indexOf(tstInfo);
      const second = reply.indexOf(tstInfo, first + 1);
      expect(second).toBeGreaterThan(first);
      reply[second + tstInfo.length - 1] = 5;
    });
    const timestamp = (await verifySignatures(completed.bytes)).signatures[0]!.timestamp!;
    expect(timestamp).toMatchObject({ contentTypeMatches: false, messageDigestMatches: true });
  });

  it("reports no signer when the token does not carry the TSA's certificate", async () => {
    const { completed } = await timestamped({}, (reply) => rebuildToken(reply, { signedData: (fields) => fields.filter((field) => field[0] !== 0xa0) }));
    const verified = await verifySignatures(completed.bytes);
    const timestamp = verified.signatures[0]!.timestamp!;
    expect(timestamp).toMatchObject({ signer: null, certificates: [], certificateMatches: false, messageDigestMatches: true });
    // The host may still check it with a TSA certificate it knows: everything it needs is there.
    expect(timestamp.toBeVerified).not.toBe("");
    expect(verified.warnings.map((warning) => warning.message).join("\n")).toContain("neither it nor the known certificates hold");
  });

  it("keeps the rest of a token whose SignerInfo it cannot read", async () => {
    const { completed } = await timestamped({}, (reply) => rebuildToken(reply, { signerInfo: (parts) => parts.filter((part) => part[0] !== 0xa0) }));
    const verified = await verifySignatures(completed.bytes);
    const timestamp = verified.signatures[0]!.timestamp!;
    expect(timestamp).toMatchObject({ coversSignature: true, toBeVerified: "", signature: "", signatureAlgorithm: "", signer: null, messageDigestMatches: false, certificateMatches: false });
    expect(timestamp.certificates).toHaveLength(1);
    expect(verified.warnings.map((warning) => warning.message).join("\n")).toContain("SignerInfo the kernel cannot read");
  });

  it("does not check a messageDigest under a digest algorithm it does not know", async () => {
    const sha3 = "2.16.840.1.101.3.4.2.8";
    const { completed } = await timestamped({}, (reply) => rebuildToken(reply, { signerInfo: (parts) => parts.map((part, index) => (index === 2 ? sequence(oid(sha3)) : part)) }));
    const verified = await verifySignatures(completed.bytes);
    const timestamp = verified.signatures[0]!.timestamp!;
    expect(timestamp).toMatchObject({ digestAlgorithm: sha3, messageDigestMatches: false });
    expect(verified.warnings.map((warning) => warning.message).join("\n")).toContain(`digest algorithm ${sha3}`);
  });

  it("names the signer of a token that carries no certificate from the known certificates", async () => {
    // A TimeStampReq without certReq: { version, messageImprint } and no BOOLEAN, so the TSA leaves its certificate out.
    const withoutCertReq = (request: Uint8Array): Uint8Array => sequence(...children(request, read(request, 0)).filter((part) => part.tag !== 0x01).map((part) => raw(request, part)));
    const { completed } = await timestamped({}, undefined, withoutCertReq);
    const tsa = base64ToBytes(certificateBase64("tsa.cert.pem"));

    const alone = await verifySignatures(completed.bytes);
    expect(alone.signatures[0]!.timestamp).toMatchObject({ certificates: [], signer: null, signerSource: null, certificateMatches: false, messageDigestMatches: true });
    expect(alone.signatures[0]!.signerSource).toBe("signature");

    const known = await verifySignatures(completed.bytes, { knownCertificates: [tsa] });
    const timestamp = known.signatures[0]!.timestamp!;
    expect(timestamp).toMatchObject({ certificates: [], signerSource: "known", certificateMatches: true, messageDigestMatches: true, contentTypeMatches: true });
    expect(timestamp.signer?.certificate).toBe(certificateBase64("tsa.cert.pem"));
    expect(hostVerifyTimestamp(timestamp)).toBe(true);
    // The signature's own signer is still the one it carries.
    expect(known.signatures[0]!.signerSource).toBe("signature");

    // Through the program, as a host asks it.
    const verify = (await handlePdfRequest(buildPdfVerifyRequest(completed.bytes, [tsa]))) as Extract<PdfKernelResponse, { op: "verify" }>;
    expect(verify.signatures[0]!.timestamp).toMatchObject({ signerSource: "known", certificateMatches: true });
    expect(await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "verify", pdf: { data: bytesToBase64(completed.bytes) }, knownCertificates: "nope" as never })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    // At most 64, of at most 16 KiB each.
    const many = Array.from({ length: 65 }, () => certificateBase64("tsa.cert.pem"));
    expect(await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "verify", pdf: { data: bytesToBase64(completed.bytes) }, knownCertificates: many })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const huge = bytesToBase64(new Uint8Array(16 * 1024 + 1));
    expect(await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "verify", pdf: { data: bytesToBase64(completed.bytes) }, knownCertificates: [huge] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "verify", pdf: { data: bytesToBase64(completed.bytes) }, knownCertificates: many.slice(0, 64) })).toMatchObject({ ok: true });
  });

  it("finds a TSTInfo changed after signing and a binding that names another certificate", async () => {
    // The policy OID sits inside the TSTInfo: changing it leaves the token readable and its messageDigest wrong.
    const policy = Buffer.from(oid("1.3.6.1.4.1.99999.1"));
    const changed = await timestamped({}, (token) => {
      const at = token.indexOf(policy);
      expect(at).toBeGreaterThan(0);
      token[at + policy.length - 1] = 2;
    });
    const altered = (await verifySignatures(changed.completed.bytes)).signatures[0]!.timestamp!;
    expect(altered).toMatchObject({ coversSignature: true, messageDigestMatches: false, certificateMatches: true });
    // The signed attributes were not touched, so the TSA's signature over them still holds: only the digest tells.
    expect(hostVerifyTimestamp(altered)).toBe(true);

    // The ESSCertIDv2 hash is the TSA certificate's SHA-256; one byte off and it names another certificate.
    const hash = createHash("sha256").update(Buffer.from(base64ToBytes(certificateBase64("tsa.cert.pem")))).digest();
    const rebound = await timestamped({}, (token) => {
      const at = token.indexOf(hash);
      expect(at).toBeGreaterThan(0);
      token[at] = token[at]! ^ 0xff;
    });
    const unbound = (await verifySignatures(rebound.completed.bytes)).signatures[0]!.timestamp!;
    expect(unbound).toMatchObject({ messageDigestMatches: true, certificateMatches: false });
    // The attribute is signed, so the TSA's signature no longer holds either.
    expect(hostVerifyTimestamp(unbound)).toBe(false);
  });
});

describe("the signed revision", () => {
  it("reads the dictionary a later update defined again from the revision the signature covers", async () => {
    const input = await unsignedRecord();
    const { completed } = await signWith("rsa2048", input, { reason: "Submitted through the web form", location: "Ottawa" });
    const before = (await verifySignatures(completed.bytes)).signatures[0]!;
    expect(before).toMatchObject({ coversDocument: true, details: "signed", changedAfter: {} });
    expect(before.signedRevision).toBeUndefined();

    const redefined = redefineSignature(completed.bytes, { "/Reason": "(Changed later)", "/M": "(D:20270101000000Z)", "/ContactInfo": "(someone@example.org)" });
    const verified = await verifySignatures(redefined);
    const report = verified.signatures[0]!;
    expect(report).toMatchObject({ coversDocument: false, digestMatches: true, details: "signed" });
    // The top level is the file as it is now; signedRevision is what was signed.
    expect(report.reason).toBe("Changed later");
    expect(report.signingTime).toBe("2027-01-01T00:00:00Z");
    expect(report.contactInfo).toBe("someone@example.org");
    expect(report.signedRevision).toEqual({ reason: "Submitted through the web form", location: "Ottawa", name: before.name, signingTime: "2026-09-05T10:11:12Z", certification: null });
    expect(report.changedAfter).toEqual({ reason: "Changed later", signingTime: "2027-01-01T00:00:00Z", contactInfo: "someone@example.org" });
    expect(hostVerify(report)).toBe(true);
    expect(verified.warnings.filter((warning) => warning.code === "signature.revision")).toEqual([]);
  });

  it("reports nothing changed after an update that only adds a new /Info", async () => {
    const input = await unsignedRecord();
    const { completed } = await signWith("rsa2048", input, { reason: "Submitted", certify: "formFilling" });
    const report = (await verifySignatures(addInfo(completed.bytes, "Later title"))).signatures[0]!;
    expect(report).toMatchObject({ coversDocument: false, digestMatches: true, details: "signed", changedAfter: {} });
    expect(report.signedRevision).toEqual({ reason: "Submitted", name: report.name, signingTime: report.signingTime, certification: { permissions: "formFilling" } });
  });

  it("reads the first of two signatures from its own revision", async () => {
    const input = await unsignedRecord();
    const first = await signWith("rsa2048", input, { certify: "formFilling", name: "Forms office" });
    const second = await signWith("p256", first.completed.bytes, { reason: "Countersigned" });
    const [one, two] = (await verifySignatures(second.completed.bytes)).signatures;
    expect(one).toMatchObject({ coversDocument: false, details: "signed", changedAfter: {}, signedRevision: { name: "Forms office", certification: { permissions: "formFilling" } } });
    expect(two).toMatchObject({ coversDocument: true, details: "signed", changedAfter: {} });
  });

  it("loads a revision or says it cannot, never throwing", async () => {
    const input = await unsignedRecord();
    expect(await loadRevision(input, input.length)).toBeInstanceOf(PDFDocument);
    expect(await loadRevision(input, 0)).toBeUndefined();
    expect(await loadRevision(input, input.length + 1)).toBeUndefined();
    expect(await loadRevision(new Uint8Array([1, 2, 3, 4]), 4)).toBeUndefined();
  });
});

describe("the updates after a signature", () => {
  it("permits a second signature under a P=2 certification", async () => {
    const input = await unsignedRecord();
    const first = await signWith("rsa2048", input, { certify: "formFilling" });
    const second = await signWith("p256", first.completed.bytes, { reason: "Countersigned" });
    const [one, two] = (await verifySignatures(second.completed.bytes)).signatures;
    expect(one!.laterRevisions).toMatchObject({ revisions: 1, permitted: true });
    expect(one!.laterRevisions!.changes.length).toBeGreaterThan(0);
    for (const change of one!.laterRevisions!.changes) {
      expect(["signature-field", "acroform", "page-annots"]).toContain(change.kind);
    }
    // The second signature sealed the update the first's verdict allows: the host must check it is valid.
    expect(one!.laterRevisions!.reliedOnSignatures).toEqual([{ field: "Signature2", byteRange: two!.byteRange }]);
    // The last signature covers the file: nothing came after it.
    expect(two!.laterRevisions).toBeUndefined();
  });

  it("forbids a new /Info under a P=1 certification", async () => {
    const input = await unsignedRecord();
    const { completed } = await signWith("rsa2048", input, { certify: "noChanges" });
    const report = (await verifySignatures(addInfo(completed.bytes, "Later title"))).signatures[0]!;
    expect(report.laterRevisions).toMatchObject({ revisions: 1, permitted: false });
    expect(report.laterRevisions!.changes.map((change) => change.kind)).toContain("info");
  });

  it("judges nothing for an approval signature", async () => {
    const input = await unsignedRecord();
    const { completed } = await signWith("rsa2048", input, { reason: "Submitted" });
    const report = (await verifySignatures(addInfo(completed.bytes, "Later title"))).signatures[0]!;
    expect(report.certification).toBeNull();
    expect(report.laterRevisions).toMatchObject({ revisions: 1, permitted: null });
    expect(report.laterRevisions!.changes.map((change) => change.kind)).toContain("info");
  });
});

describe("the document id", () => {
  it("is the trailer /ID's first element for a rendered document, and null for a file without one", async () => {
    const { completed } = await signWith("rsa2048", await unsignedRecord());
    const expected = createHash("sha256").update(ENV.documentId).digest("hex").slice(0, 32);
    expect((await verifySignatures(completed.bytes)).documentId).toBe(expected);
    // An update that carries the /ID forward keeps it.
    expect((await verifySignatures(addInfo(completed.bytes, "Later"))).documentId).toBe(expected);

    const bare = await PDFDocument.create({ updateMetadata: false });
    bare.addPage();
    const bareBytes = await bare.save({ useObjectStreams: false });
    expect(latin1(bareBytes)).not.toContain("/ID");
    const signed = await signWith("rsa2048", bareBytes);
    const verified = await verifySignatures(signed.completed.bytes);
    expect(verified.signatures[0]?.digestMatches).toBe(true);
    expect(verified.documentId).toBeNull();
    expect(verified.signatures[0]?.signedDocumentId).toBeNull();
  });

  it("keeps the signed /ID per signature when a later update claims another", async () => {
    const { completed } = await signWith("rsa2048", await unsignedRecord());
    const expected = createHash("sha256").update(ENV.documentId).digest("hex").slice(0, 32);
    const untouched = await verifySignatures(completed.bytes);
    expect(untouched.signatures[0]!.signedDocumentId).toBe(untouched.documentId);
    expect(untouched.documentId).toBe(expected);
    const claimed = await verifySignatures(appendUpdate(completed.bytes, [], "", "/ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]"));
    expect(claimed.documentId).toBe("00112233445566778899aabbccddeeff");
    expect(claimed.signatures[0]).toMatchObject({ coversDocument: false, details: "signed", signedDocumentId: expected });
  });

  it("reads an /ID written as literal strings or behind a reference", async () => {
    const { completed } = await signWith("rsa2048", await unsignedRecord());
    const literal = await verifySignatures(appendUpdate(completed.bytes, [], "", "/ID [(abc) (abc)]"));
    expect(literal.documentId).toBe("616263");
    const size = Math.max(...[...latin1(completed.bytes).matchAll(/\/Size (\d+)/g)].map((match) => Number(match[1])));
    const indirect = await verifySignatures(appendUpdate(completed.bytes, [{ number: size, generation: 0, body: "[<0a0b> <0a0b>]" }], "", `/ID ${size} 0 R`));
    expect(indirect.documentId).toBe("0a0b");
  });
});

describe("signatures no field links any more", () => {
  it("reports both a signature and a later copy with the same /Contents linked in its place", async () => {
    const { completed } = await signWith("rsa2048", await unsignedRecord(), { certify: "formFilling" });
    const doc = await PDFDocument.load(completed.bytes, { updateMetadata: false });
    const entry = findSignatureFields(doc)[0]!;
    const range = (entry.value!.lookup(PDFName.of("ByteRange")) as PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    const copy = entry.value!.clone(doc.context);
    copy.set(PDFName.of("ByteRange"), doc.context.obj([0, range[1]!, range[2]!, range[3]! + 1]));
    const size = Math.max(...[...latin1(completed.bytes).matchAll(/\/Size (\d+)/g)].map((match) => Number(match[1])));
    const field = entry.dict.clone(doc.context);
    field.set(PDFName.of("V"), PDFRef.of(size));
    const swapped = appendUpdate(completed.bytes, [
      { number: size, generation: 0, body: copy.toString() },
      { number: entry.ref.objectNumber, generation: entry.ref.generationNumber, body: field.toString() }
    ]);
    const verified = await verifySignatures(swapped);
    expect(verified.signatures).toHaveLength(2);
    const [linked, genuine] = verified.signatures;
    // The copy the field now links frames no signature; the certification it copies is still there, unlinked, and judged.
    expect(linked).toMatchObject({ field: "Signature1", digestMatches: false });
    expect(genuine).toMatchObject({ field: "Signature1", digestMatches: true, coversDocument: false, certification: { permissions: "formFilling" }, byteRange: range });
    expect(genuine!.laterRevisions).toBeDefined();
    expect(verified.warnings.map((warning) => warning.code)).toContain("signature.unlinked");
  });

  it("gives a real certification its revision before 70 decoy ranges ending at planted %%EOFs", async () => {
    const { completed } = await signWith("rsa2048", await unsignedRecord(), { certify: "formFilling" });
    let tail = "";
    const decoys: Array<[number, number, number]> = [];
    for (let i = 0; i < 70; i += 1) {
      // `%<ab>%%EOF`: a comment that frames hex and ends where a revision would.
      const at = completed.bytes.length + tail.length + 1;
      tail += "%<ab>%%EOF\n";
      decoys.push([at, at + 4, at + 4 + "%%EOF".length]);
    }
    tail += decoys.map(([start, after, end]) => `% /ByteRange [0 ${start} ${after} ${end - after}]\n`).join("");
    // An empty update after them, so the file still ends with a cross-reference section as a reader looks for it.
    const planted = appendUpdate(new Uint8Array(Buffer.concat([Buffer.from(completed.bytes), Buffer.from(tail, "latin1")])), []);
    const verified = await verifySignatures(planted);
    expect(verified.signatures).toHaveLength(1);
    const report = verified.signatures[0]!;
    expect(report).toMatchObject({ field: "Signature1", coversDocument: false, digestMatches: true, details: "signed", certification: { permissions: "formFilling" } });
    expect(verified.warnings.filter((warning) => warning.code === "signature.revisions")).toEqual([]);
    expect(report.laterRevisions).toBeDefined();
    // The decoys hit the limit, and say so; the certification was not among what it cut.
    expect(verified.warnings.map((warning) => warning.message).join("\n")).toContain(`More than 64 earlier revisions`);
  });

  it("does not parse the file again for every /ByteRange written in a comment", async () => {
    const { completed } = await signWith("rsa2048", await unsignedRecord());
    const text = latin1(completed.bytes);
    const end = completed.bytes.length;
    // Ranges that pass every cheap test: they start at a hex string, frame hex, and end at the file's %%EOF.
    const hexStrings = [...text.matchAll(/(?<!<)<([0-9A-Fa-f]+)>(?!>)/g)].map((match) => [match.index!, match.index! + match[0].length] as const);
    expect(hexStrings.length).toBeGreaterThan(1);
    const fakes: string[] = [];
    for (let i = 0; fakes.length < 300; i += 1) {
      const [start, after] = hexStrings[i % hexStrings.length]!;
      // Every other one also misses the end by a byte, so it does not end a revision at all.
      const miss = i % 2;
      fakes.push(`% /ByteRange [0 ${start} ${after} ${end - after - miss}]\n`);
    }
    const noisy = new Uint8Array(Buffer.concat([Buffer.from(completed.bytes), Buffer.from(fakes.join(""), "latin1")]));
    const quiet = new Uint8Array(Buffer.concat([Buffer.from(completed.bytes), Buffer.from("% nothing here\n", "latin1")]));
    const loads = vi.spyOn(PDFDocument, "load");
    try {
      const baseline = await verifySignatures(quiet);
      const baselineLoads = loads.mock.calls.length;
      loads.mockClear();
      const verified = await verifySignatures(noisy);
      expect(loads.mock.calls.length).toBe(baselineLoads);
      expect(baseline.signatures).toHaveLength(1);
      expect(verified.signatures).toHaveLength(1);
      expect(verified.signatures[0]).toMatchObject({ field: "Signature1", digestMatches: true, coversDocument: false, details: "signed" });
    } finally {
      loads.mockRestore();
    }
  });

  it("still reports a certification an update unlinked, as changed", async () => {
    const { completed } = await signWith("rsa2048", await unsignedRecord(), { certify: "noChanges" });
    const verified = await verifySignatures(await unlinkSignatures(completed.bytes));
    expect(verified.signatures).toHaveLength(1);
    const report = verified.signatures[0]!;
    expect(report).toMatchObject({ field: "Signature1", coversDocument: false, digestMatches: true, details: "signed", certification: { permissions: "noChanges" } });
    expect(report.laterRevisions?.permitted).toBe(false);
    expect(hostVerify(report)).toBe(true);
    expect(verified.warnings.filter((warning) => warning.code === "signature.unlinked").map((warning) => warning.message)).toEqual(['A signature once in "Signature1" is in no field of the file\'s latest revision.']);
  });

  it("still reports one whose dictionary an update emptied, from the revision it signed", async () => {
    const { completed } = await signWith("rsa2048", await unsignedRecord(), { certify: "noChanges", reason: "Sealed" });
    const verified = await verifySignatures(await unlinkSignatures(completed.bytes, true));
    expect(verified.signatures).toHaveLength(1);
    const report = verified.signatures[0]!;
    expect(report).toMatchObject({ field: "Signature1", coversDocument: false, digestMatches: true, details: "signed", reason: "Sealed", signedRevision: { reason: "Sealed" } });
    expect(report.laterRevisions?.permitted).toBe(false);
    expect(report.laterRevisions?.changes.map((change) => change.kind)).toContain("signature-dictionary");
    // Found by its /ByteRange in the bytes, then read from the revision it signed.
    expect(verified.warnings.filter((warning) => warning.code === "signature.unlinked").map((warning) => warning.message)).toEqual([
      'A signature in "Signature1" is no longer defined by the file\'s latest revision; it is read from the revision it signed.'
    ]);
  });

  it("reads past a field whose /Kids or /V an update broke, without throwing", async () => {
    const { completed } = await signWith("rsa2048", await unsignedRecord());
    const doc = await PDFDocument.load(completed.bytes, { updateMetadata: false });
    const entry = findSignatureFields(doc)[0]!;
    const brokenKids = entry.dict.clone(doc.context);
    brokenKids.set(PDFName.of("Kids"), PDFNumber.of(7));
    const kids = await verifySignatures(redefine(completed.bytes, entry.ref, brokenKids));
    expect(kids.signatures.map((report) => [report.field, report.digestMatches])).toEqual([["Signature1", true]]);
    expect(kids.warnings.map((warning) => warning.message).join("\n")).toContain("/Kids that is not an array");

    const brokenValue = entry.dict.clone(doc.context);
    brokenValue.set(PDFName.of("V"), PDFNumber.of(7));
    const value = await verifySignatures(redefine(completed.bytes, entry.ref, brokenValue));
    // No field holds it now, but the dictionary is still in the file: reported, and flagged.
    expect(value.signatures.map((report) => [report.field, report.digestMatches, report.coversDocument])).toEqual([["Signature1", true, false]]);
    expect(value.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["signature.malformed", "signature.unlinked"]));
  });
});

describe("through the program", () => {
  it.runIf(openssl)("carries the new fields on the verify reply and names the feature", async () => {
    const { completed } = await timestamped();
    const later = redefineSignature(completed.bytes, { "/Reason": "(Changed later)" });
    const verify = (await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "verify", pdf: { data: bytesToBase64(later) } })) as Extract<PdfKernelResponse, { op: "verify" }>;
    expect(verify.ok).toBe(true);
    expect(verify.documentId).toBe(createHash("sha256").update(ENV.documentId).digest("hex").slice(0, 32));
    const report = verify.signatures[0]!;
    expect(report).toMatchObject({ details: "signed", reason: "Changed later", signedRevision: { reason: "Submitted" }, changedAfter: { reason: "Changed later" } });
    expect(report.laterRevisions).toMatchObject({ revisions: 1, permitted: null });
    expect(report.laterRevisions!.changes.map((change) => change.kind)).toContain("signature-dictionary");
    expect(report.timestamp).toMatchObject({ messageDigestMatches: true, contentTypeMatches: true, certificateMatches: true });
    expect(hostVerifyTimestamp(report.timestamp!)).toBe(true);
    const capabilities = (await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "capabilities" })) as Extract<PdfKernelResponse, { op: "capabilities" }>;
    expect(capabilities.features).toContain("verify-detail");
    expect(capabilities.abi).toBe("4.0.0");
  });
});
