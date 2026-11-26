/**
 * CMS `SignedData` (RFC 5652) for a PDF signature: the signed attributes the host
 * signs, the `ContentInfo` that goes into `/Contents`, the RFC 3161 request and token for a
 * PAdES-B-T timestamp, and the reader `verify` uses to take a signature apart again. PAdES
 * (`ETSI.CAdES.detached`, ETSI EN 319 122-1) wants contentType, messageDigest and ESS
 * signing-certificate-v2 and no signingTime attribute — the claimed time is the dictionary's
 * `/M`; the older `adbe.pkcs7.detached` adds signingTime.
 */
import { PdfKernelError } from "@argusvane/datum-engine/render";
import { sha1 } from "../util/sha1.js";
import { sha256 } from "../util/sha256.js";
import { sha384, sha512 } from "../util/sha512.js";
import {
  NULL,
  OID,
  TAG,
  boolean,
  bytesEqual,
  children,
  content,
  expect,
  explicit,
  implicit,
  integer,
  octetString,
  oid,
  raw,
  read,
  readIntegerBytes,
  readOid,
  readSmallInteger,
  readString,
  readTime,
  sequence,
  setOf,
  time,
  toHex,
  utf8String,
  type Tlv
} from "./der.js";
import { nameText, type ParsedCertificate, type PdfSignatureAlgorithmId } from "./x509.js";

export type PdfSubFilterId = "ETSI.CAdES.detached" | "adbe.pkcs7.detached";

export interface SignedAttributesInput {
  /** SHA-256 over the `/ByteRange`. */
  digest: Uint8Array;
  leaf: ParsedCertificate;
  subFilter: PdfSubFilterId;
  /** ISO instant; only `adbe.pkcs7.detached` carries it as an attribute. */
  signingTime: string;
  /** A CAdES commitment type (an ETSI proof-of-* OID) and the signer's statement, signed with the rest. */
  commitment?: { typeOid: string; statement?: string };
}

/** The commitment types a signature may declare (ETSI EN 319 122-1) and their OIDs. */
export const COMMITMENT_TYPE_OIDS = {
  origin: OID.proofOfOrigin,
  receipt: OID.proofOfReceipt,
  delivery: OID.proofOfDelivery,
  sender: OID.proofOfSender,
  approval: OID.proofOfApproval,
  creation: OID.proofOfCreation
} as const;

export type CommitmentTypeName = keyof typeof COMMITMENT_TYPE_OIDS;

/** The name of a commitment-type OID, or the OID itself for one this kernel does not name. */
export function commitmentTypeName(oidValue: string): CommitmentTypeName | string {
  const entry = (Object.entries(COMMITMENT_TYPE_OIDS) as Array<[CommitmentTypeName, string]>).find(([, candidate]) => candidate === oidValue);
  return entry ? entry[0] : oidValue;
}

/**
 * `CommitmentTypeIndication ::= SEQUENCE { commitmentTypeId OID, commitmentTypeQualifier
 * SEQUENCE OF CommitmentTypeQualifier OPTIONAL }`, the qualifier carrying Datum's statement.
 */
function commitmentTypeIndication(commitment: NonNullable<SignedAttributesInput["commitment"]>): Uint8Array {
  const parts = [oid(commitment.typeOid)];
  if (commitment.statement !== undefined && commitment.statement !== "") {
    parts.push(sequence(sequence(oid(OID.datumStatement), utf8String(commitment.statement))));
  }
  return sequence(...parts);
}

export interface SignedAttributes {
  /** `[0] IMPLICIT` — as written inside the SignerInfo. */
  implicitSet: Uint8Array;
  /** The same content as an explicit SET OF — what the host signs (RFC 5652 §5.4). */
  toBeSigned: Uint8Array;
}

function attribute(type: string, value: Uint8Array): Uint8Array {
  return sequence(oid(type), setOf([value]));
}

function digestAlgorithm(): Uint8Array {
  // RFC 5754 §2: absent parameters for SHA-2.
  return sequence(oid(OID.sha256));
}

/** ESS `SigningCertificateV2` (RFC 5035): the leaf's hash and its issuer/serial. */
function signingCertificateV2(leaf: ParsedCertificate): Uint8Array {
  const issuerSerial = sequence(sequence(explicit(4, leaf.issuerTlv)), leaf.serialTlv);
  const essCertId = sequence(octetString(sha256(leaf.der)), issuerSerial);
  return sequence(sequence(essCertId));
}

export function signedAttributes(input: SignedAttributesInput): SignedAttributes {
  const attributes = [attribute(OID.contentType, oid(OID.data)), attribute(OID.messageDigest, octetString(input.digest)), attribute(OID.signingCertificateV2, signingCertificateV2(input.leaf))];
  if (input.subFilter === "adbe.pkcs7.detached") {
    attributes.push(attribute(OID.signingTime, time(input.signingTime)));
  }
  if (input.commitment) {
    attributes.push(attribute(OID.commitmentType, commitmentTypeIndication(input.commitment)));
  }
  const toBeSigned = setOf(attributes);
  return { implicitSet: implicit(0, toBeSigned), toBeSigned };
}

function signatureAlgorithmIdentifier(algorithm: PdfSignatureAlgorithmId): Uint8Array {
  if (algorithm === "RSASSA-PKCS1-v1_5-SHA256") {
    // RFC 5754 §3.2: NULL parameters for the RSA PKCS#1 v1.5 identifiers.
    return sequence(oid(OID.sha256WithRSA), NULL);
  }
  // RFC 5758 §3.2: absent parameters for ecdsa-with-SHA2.
  return sequence(oid(OID.ecdsaWithSHA256));
}

function ecdsaFieldSize(algorithm: PdfSignatureAlgorithmId): number {
  return algorithm === "ECDSA-P384-SHA256" ? 48 : 32;
}

/**
 * The signature value as CMS wants it: RSA as-is; ECDSA as DER `Ecdsa-Sig-Value` — a host
 * may hand over `r‖s` (WebCrypto, .NET's default), which is converted.
 */
export function normalizeSignatureValue(value: Uint8Array, algorithm: PdfSignatureAlgorithmId): Uint8Array {
  if (algorithm === "RSASSA-PKCS1-v1_5-SHA256") {
    if (value.length < 128) {
      throw new PdfKernelError("signature", `An RSA signature value is at least 128 bytes; ${value.length} were given`);
    }
    return value;
  }
  const size = ecdsaFieldSize(algorithm);
  if (value.length === size * 2) {
    return sequence(integer(value.subarray(0, size)), integer(value.subarray(size)));
  }
  if (value[0] === TAG.sequence) {
    try {
      const outer = read(value, 0);
      const parts = children(value, outer, 0);
      if (outer.end === value.length && parts.length === 2 && parts.every((part) => part.tag === TAG.integer)) {
        return value;
      }
    } catch {
      // fall through to the error below
    }
  }
  throw new PdfKernelError("signature", `An ECDSA signature value must be DER (r, s) or ${size * 2} raw bytes; ${value.length} bytes were given`);
}

/**
 * DER `Ecdsa-Sig-Value` as fixed-width `r‖s`, for hosts that verify with WebCrypto. An integer
 * wider than the curve's field is refused, never cut to fit.
 */
export function ecdsaToP1363(der: Uint8Array, size: number): Uint8Array {
  const outer = read(der, 0);
  const [r, s] = children(der, outer, 0);
  if (!r || !s) {
    throw new PdfKernelError("signature", "Malformed ECDSA signature");
  }
  const out = new Uint8Array(size * 2);
  const rBytes = readIntegerBytes(der, r);
  const sBytes = readIntegerBytes(der, s);
  if (rBytes.length > size || sBytes.length > size) {
    throw new PdfKernelError("signature", `An ECDSA signature integer is wider than the ${size}-byte field`);
  }
  out.set(rBytes.subarray(Math.max(0, rBytes.length - size)), Math.max(0, size - rBytes.length));
  out.set(sBytes.subarray(Math.max(0, sBytes.length - size)), size + Math.max(0, size - sBytes.length));
  return out;
}

export interface SignedDataInput {
  /** Every certificate to carry, DER. */
  certificates: readonly Uint8Array[];
  leaf: ParsedCertificate;
  signedAttrsImplicit: Uint8Array;
  algorithm: PdfSignatureAlgorithmId;
  /** Already normalised. */
  signature: Uint8Array;
  /** An RFC 3161 `TimeStampToken` (a `ContentInfo`) over the signature value. */
  timestampToken?: Uint8Array;
}

/** `ContentInfo { id-signedData, [0] SignedData }` — the DER that goes into `/Contents`. */
export function buildSignedData(input: SignedDataInput): Uint8Array {
  const signerInfoParts = [
    integer(1),
    sequence(input.leaf.issuerTlv, input.leaf.serialTlv),
    digestAlgorithm(),
    input.signedAttrsImplicit,
    signatureAlgorithmIdentifier(input.algorithm),
    octetString(input.signature)
  ];
  if (input.timestampToken) {
    signerInfoParts.push(implicit(1, setOf([attribute(OID.signatureTimeStampToken, input.timestampToken)])));
  }
  const signedData = sequence(
    integer(1),
    setOf([digestAlgorithm()]),
    sequence(oid(OID.data)),
    implicit(0, setOf(input.certificates)),
    setOf([sequence(...signerInfoParts)])
  );
  return sequence(oid(OID.signedData), explicit(0, signedData));
}

export interface ParsedCms {
  certificates: Uint8Array[];
  signerIssuerTlv: Uint8Array;
  signerSerialTlv: Uint8Array;
  digestAlgorithm: string;
  /** The SignerInfo's `signedAttrs` as written, `[0] IMPLICIT`. */
  signedAttrsImplicit: Uint8Array;
  /** The same bytes re-tagged as a SET OF — what a verifier checks the signature over. */
  toBeVerified: Uint8Array;
  messageDigest?: Uint8Array;
  signingTime?: string;
  essCertHash?: Uint8Array;
  signatureAlgorithm: string;
  signature: Uint8Array;
  timestampToken?: Uint8Array;
  /** The signed commitment-type attribute, when present. */
  commitment?: { typeOid: string; statement?: string };
}

function attributesOf(bytes: Uint8Array, set: Tlv): Map<string, Tlv> {
  const out = new Map<string, Tlv>();
  for (const attr of children(bytes, set, 4)) {
    const [type, values] = children(bytes, expect(attr, TAG.sequence, "an attribute"), 5);
    if (!type || !values) {
      continue;
    }
    const first = children(bytes, expect(values, TAG.set, "attribute values"), 6)[0];
    if (first) {
      out.set(readOid(bytes, type), first);
    }
  }
  return out;
}

/** Takes a `/Contents` CMS apart; padding zeros past the outer length are ignored. */
export function parseSignedData(cms: Uint8Array): ParsedCms {
  const contentInfo = read(cms, 0);
  expect(contentInfo, TAG.sequence, "a ContentInfo");
  const [typeNode, wrapper] = children(cms, contentInfo, 0);
  if (!typeNode || !wrapper || readOid(cms, typeNode) !== OID.signedData) {
    throw new PdfKernelError("signature", "The signature is not a CMS SignedData");
  }
  const signedData = children(cms, wrapper, 1)[0];
  if (!signedData) {
    throw new PdfKernelError("signature", "Malformed SignedData");
  }
  const fields = children(cms, expect(signedData, TAG.sequence, "a SignedData"), 2);
  const certificates: Uint8Array[] = [];
  let signerInfos: Tlv | undefined;
  for (const field of fields.slice(3)) {
    if (field.tag === 0xa0) {
      for (const certificate of children(cms, field, 3)) {
        if (certificate.tag === TAG.sequence) {
          certificates.push(raw(cms, certificate));
        }
      }
    } else if (field.tag === TAG.set) {
      signerInfos = field;
    }
  }
  const signerInfo = signerInfos ? children(cms, signerInfos, 3)[0] : undefined;
  if (!signerInfo) {
    throw new PdfKernelError("signature", "The signature carries no SignerInfo");
  }
  const parts = children(cms, expect(signerInfo, TAG.sequence, "a SignerInfo"), 4);
  const [, sid, digestAlgorithmNode] = parts;
  if (!sid || !digestAlgorithmNode) {
    throw new PdfKernelError("signature", "Malformed SignerInfo");
  }
  if (sid.tag !== TAG.sequence) {
    throw new PdfKernelError("signature", "Signer identified by subjectKeyIdentifier is not supported");
  }
  const [issuer, serial] = children(cms, sid, 5);
  if (!issuer || !serial) {
    throw new PdfKernelError("signature", "Malformed IssuerAndSerialNumber");
  }
  const digestOid = children(cms, digestAlgorithmNode, 5)[0];
  let cursor = 3;
  let signedAttrs: Tlv | undefined;
  if (parts[cursor]?.tag === 0xa0) {
    signedAttrs = parts[cursor];
    cursor += 1;
  }
  const signatureAlgorithmNode = parts[cursor];
  const signatureNode = parts[cursor + 1];
  const unsigned = parts[cursor + 2]?.tag === 0xa1 ? parts[cursor + 2] : undefined;
  if (!signatureAlgorithmNode || !signatureNode || !signedAttrs) {
    throw new PdfKernelError("signature", "The SignerInfo has no signed attributes or no signature");
  }
  const signatureAlgorithmOid = children(cms, signatureAlgorithmNode, 5)[0];
  const attributes = attributesOf(cms, signedAttrs);
  const messageDigest = attributes.get(OID.messageDigest);
  const signingTime = attributes.get(OID.signingTime);
  const ess = attributes.get(OID.signingCertificateV2);
  let essCertHash: Uint8Array | undefined;
  if (ess) {
    const certs = children(cms, ess, 7)[0];
    const first = certs ? children(cms, certs, 8)[0] : undefined;
    const essFields = first ? children(cms, first, 9) : [];
    const hash = essFields.find((field) => field.tag === TAG.octetString);
    essCertHash = hash ? content(cms, hash) : undefined;
  }
  const toBeVerified = new Uint8Array(raw(cms, signedAttrs));
  toBeVerified[0] = TAG.set;
  let commitment: ParsedCms["commitment"];
  const commitmentNode = attributes.get(OID.commitmentType);
  if (commitmentNode) {
    const fields = children(cms, commitmentNode, 7);
    const typeNode = fields[0];
    if (typeNode && typeNode.tag === TAG.oid) {
      commitment = { typeOid: readOid(cms, typeNode) };
      const qualifiers = fields[1] && fields[1].tag === TAG.sequence ? children(cms, fields[1], 8) : [];
      for (const qualifier of qualifiers) {
        const [qualifierOid, qualifierValue] = children(cms, qualifier, 9);
        if (qualifierOid && qualifierOid.tag === TAG.oid && qualifierValue && readOid(cms, qualifierOid) === OID.datumStatement) {
          commitment.statement = readString(cms, qualifierValue);
        }
      }
    }
  }
  let timestampToken: Uint8Array | undefined;
  if (unsigned) {
    const token = attributesOf(cms, unsigned).get(OID.signatureTimeStampToken);
    timestampToken = token ? raw(cms, token) : undefined;
  }
  return {
    certificates,
    signerIssuerTlv: raw(cms, issuer),
    signerSerialTlv: raw(cms, serial),
    digestAlgorithm: digestOid ? readOid(cms, digestOid) : "",
    signedAttrsImplicit: raw(cms, signedAttrs),
    toBeVerified,
    ...(messageDigest ? { messageDigest: content(cms, messageDigest) } : {}),
    ...(signingTime ? { signingTime: readTime(cms, signingTime) } : {}),
    ...(essCertHash ? { essCertHash } : {}),
    signatureAlgorithm: signatureAlgorithmOid ? readOid(cms, signatureAlgorithmOid) : "",
    signature: content(cms, expect(signatureNode, TAG.octetString, "a signature value")),
    ...(timestampToken ? { timestampToken } : {}),
    ...(commitment ? { commitment } : {})
  };
}

/** RFC 3161 `TimeStampReq` over a signature value: SHA-256 imprint, a certificate asked for, no nonce. */
export function timestampRequest(signatureValue: Uint8Array): Uint8Array {
  // TSAs are used to NULL parameters on the imprint's algorithm (openssl writes them), so keep them here.
  const imprint = sequence(sequence(oid(OID.sha256), NULL), octetString(sha256(signatureValue)));
  return sequence(integer(1), imprint, boolean(true));
}

/** The SignerInfo of a timestamp token, taken apart: what the host checks the TSA's signature with. */
export interface ParsedTimestampSigner {
  /** The signer named by issuer and serial, both whole TLVs. */
  issuerTlv?: Uint8Array;
  serialTlv?: Uint8Array;
  /** Or the signer named by its subject key identifier. */
  keyId?: Uint8Array;
  /** The SignerInfo's digest algorithm, dotted. */
  digestAlgorithm: string;
  /** The signed attributes re-tagged as a SET OF: what the TSA's signature covers. */
  toBeVerified: Uint8Array;
  messageDigest?: Uint8Array;
  /** The contentType signed attribute, dotted. */
  contentType?: string;
  /**
   * The first ESSCertIDv2 of a signingCertificateV2 attribute, else the first ESSCertID of a
   * signingCertificate attribute: the hash algorithm (dotted) and the certificate's hash.
   * `null` when the attribute is there and cannot be read; absent when there is none.
   */
  essCertId?: { algorithm: string; hash: Uint8Array } | null;
  /** The SignerInfo's signature algorithm, dotted. */
  signatureAlgorithm: string;
  signature: Uint8Array;
}

export interface ParsedTimestamp {
  /** The `TimeStampToken` `ContentInfo`, DER. */
  token: Uint8Array;
  /** The TSTInfo `genTime`, ISO. */
  time: string;
  imprintAlgorithm: string;
  imprint: Uint8Array;
  tsa?: string;
  /** The encapsulated TSTInfo, DER: what the messageDigest attribute is the digest of. */
  tstInfo: Uint8Array;
  /** The TSTInfo serial number, lowercase hex. */
  serialHex: string;
  /** The TSTInfo nonce, lowercase hex, when the request asked for one. */
  nonceHex?: string;
  accuracy?: { seconds?: number; millis?: number; micros?: number };
  /** Every certificate the token carries, DER. */
  certificates: Uint8Array[];
  /** The token's first SignerInfo; absent when it cannot be read (`signerProblem` says why). */
  signer?: ParsedTimestampSigner;
  signerProblem?: string;
}

/** A digest by its dotted OID, or `undefined` for one the kernel does not compute. */
export function digestFor(algorithm: string, data: Uint8Array): Uint8Array | undefined {
  switch (algorithm) {
    case OID.sha256:
      return sha256(data);
    case OID.sha384:
      return sha384(data);
    case OID.sha512:
      return sha512(data);
    case OID.sha1:
      return sha1(data);
    default:
      return undefined;
  }
}

/** The magnitude of an INTEGER under any tag (an accuracy's `[0] IMPLICIT` millis), as a number. */
function smallNumber(bytes: Uint8Array, node: Tlv): number {
  let value = 0;
  const body = content(bytes, node);
  if (body.length === 0 || body.length > 6) {
    throw new PdfKernelError("signature", "Malformed TSTInfo accuracy");
  }
  for (const byte of body) {
    value = value * 256 + byte;
  }
  return value;
}

/** `Accuracy ::= SEQUENCE { seconds INTEGER OPTIONAL, millis [0] INTEGER OPTIONAL, micros [1] INTEGER OPTIONAL }`. */
function accuracyOf(tst: Uint8Array, node: Tlv): NonNullable<ParsedTimestamp["accuracy"]> {
  const out: NonNullable<ParsedTimestamp["accuracy"]> = {};
  for (const part of children(tst, node, 1)) {
    if (part.tag === TAG.integer) {
      out.seconds = smallNumber(tst, part);
    } else if (part.tag === 0x80) {
      out.millis = smallNumber(tst, part);
    } else if (part.tag === 0x81) {
      out.micros = smallNumber(tst, part);
    }
  }
  return out;
}

/**
 * The first ESSCertID(v2) of a signingCertificate(V2) attribute value:
 * `SEQUENCE { certs SEQUENCE OF ESSCertIDv2, policies OPTIONAL }`, where
 * `ESSCertIDv2 ::= SEQUENCE { hashAlgorithm DEFAULT sha256, certHash OCTET STRING, issuerSerial OPTIONAL }`
 * and an ESSCertID has no algorithm (SHA-1). RFC 2634 §5.4: the first one names the signer.
 */
function essCertIdOf(bytes: Uint8Array, value: Tlv, v2: boolean): ParsedTimestampSigner["essCertId"] {
  try {
    const certs = children(bytes, expect(value, TAG.sequence, "a SigningCertificate"), 7)[0];
    const first = certs ? children(bytes, expect(certs, TAG.sequence, "an ESSCertID list"), 8)[0] : undefined;
    if (!first) {
      return null;
    }
    const parts = children(bytes, expect(first, TAG.sequence, "an ESSCertID"), 9);
    let algorithm: string = v2 ? OID.sha256 : OID.sha1;
    let index = 0;
    if (v2 && parts[0]?.tag === TAG.sequence) {
      const algorithmOid = children(bytes, parts[0], 10)[0];
      if (!algorithmOid) {
        return null;
      }
      algorithm = readOid(bytes, algorithmOid);
      index = 1;
    }
    const hash = parts[index];
    return hash && hash.tag === TAG.octetString ? { algorithm, hash: content(bytes, hash) } : null;
  } catch {
    return null;
  }
}

/** A timestamp token's SignerInfo. RFC 3161 §2.4.1 wants signed attributes, so a SignerInfo without them is refused. */
function timestampSignerOf(token: Uint8Array, signerInfo: Tlv): ParsedTimestampSigner {
  const parts = children(token, expect(signerInfo, TAG.sequence, "a SignerInfo"), 4);
  const [, sid, digestAlgorithmNode] = parts;
  if (!sid || !digestAlgorithmNode) {
    throw new PdfKernelError("signature", "Malformed SignerInfo");
  }
  let named: Pick<ParsedTimestampSigner, "issuerTlv" | "serialTlv" | "keyId">;
  if (sid.tag === TAG.sequence) {
    const [issuer, serial] = children(token, sid, 5);
    if (!issuer || !serial) {
      throw new PdfKernelError("signature", "Malformed IssuerAndSerialNumber");
    }
    named = { issuerTlv: raw(token, issuer), serialTlv: raw(token, serial) };
  } else if (sid.tag === 0x80) {
    named = { keyId: content(token, sid) };
  } else {
    throw new PdfKernelError("signature", `Unknown SignerIdentifier (tag 0x${sid.tag.toString(16)})`);
  }
  const digestOid = children(token, expect(digestAlgorithmNode, TAG.sequence, "a digest algorithm"), 5)[0];
  const signedAttrs = parts[3]?.tag === 0xa0 ? parts[3] : undefined;
  const signatureAlgorithmNode = parts[4];
  const signatureNode = parts[5];
  if (!signedAttrs || !signatureAlgorithmNode || !signatureNode || !digestOid) {
    throw new PdfKernelError("signature", "The timestamp's SignerInfo has no signed attributes or no signature");
  }
  const signatureAlgorithmOid = children(token, expect(signatureAlgorithmNode, TAG.sequence, "a signature algorithm"), 5)[0];
  if (!signatureAlgorithmOid) {
    throw new PdfKernelError("signature", "Malformed signature algorithm");
  }
  const attributes = attributesOf(token, signedAttrs);
  const messageDigest = attributes.get(OID.messageDigest);
  const contentType = attributes.get(OID.contentType);
  const essV2 = attributes.get(OID.signingCertificateV2);
  const essV1 = attributes.get(OID.signingCertificate);
  const essCertId = essV2 ? essCertIdOf(token, essV2, true) : essV1 ? essCertIdOf(token, essV1, false) : undefined;
  const toBeVerified = new Uint8Array(raw(token, signedAttrs));
  toBeVerified[0] = TAG.set;
  return {
    ...named,
    digestAlgorithm: readOid(token, digestOid),
    toBeVerified,
    ...(messageDigest && messageDigest.tag === TAG.octetString ? { messageDigest: content(token, messageDigest) } : {}),
    ...(contentType && contentType.tag === TAG.oid ? { contentType: readOid(token, contentType) } : {}),
    ...(essCertId !== undefined ? { essCertId } : {}),
    signatureAlgorithm: readOid(token, signatureAlgorithmOid),
    signature: content(token, expect(signatureNode, TAG.octetString, "a signature value"))
  };
}

/**
 * A `TimeStampToken`, or the whole `TimeStampResp` a TSA answers with (the token is taken
 * out when the status says granted). The TSTInfo and the token's certificates are read here;
 * its SignerInfo too, though a SignerInfo the kernel cannot read leaves the rest standing.
 *
 * @code
 * TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber INTEGER, genTime,
 *   accuracy Accuracy OPTIONAL, ordering BOOLEAN DEFAULT FALSE, nonce INTEGER OPTIONAL,
 *   tsa [0] GeneralName OPTIONAL, extensions [1] IMPLICIT Extensions OPTIONAL }
 * @endcode
 */
export function parseTimestampToken(bytes: Uint8Array): ParsedTimestamp {
  let outer = read(bytes, 0);
  expect(outer, TAG.sequence, "a TimeStampToken or TimeStampResp");
  let tokenBytes = bytes.subarray(0, outer.end);
  const [first, second] = children(bytes, outer, 0);
  if (first?.tag === TAG.sequence) {
    // TimeStampResp { status PKIStatusInfo, timeStampToken OPTIONAL }
    const statusNode = children(bytes, first, 1)[0];
    const status = statusNode ? readSmallInteger(bytes, statusNode) : -1;
    if (status !== 0 && status !== 1) {
      throw new PdfKernelError("signature", `The timestamp authority refused the request (PKIStatus ${status})`);
    }
    if (!second) {
      throw new PdfKernelError("signature", "The timestamp response carries no token");
    }
    tokenBytes = raw(bytes, second);
    outer = read(tokenBytes, 0);
  }
  const [typeNode, wrapper] = children(tokenBytes, outer, 0);
  if (!typeNode || !wrapper || readOid(tokenBytes, typeNode) !== OID.signedData) {
    throw new PdfKernelError("signature", "The timestamp token is not a CMS SignedData");
  }
  const signedData = children(tokenBytes, wrapper, 1)[0];
  const fields = signedData ? children(tokenBytes, signedData, 2) : [];
  const encap = fields[2];
  if (!encap) {
    throw new PdfKernelError("signature", "Malformed timestamp token");
  }
  const [encapType, encapContent] = children(tokenBytes, encap, 3);
  if (!encapType || !encapContent || readOid(tokenBytes, encapType) !== OID.tstInfo) {
    throw new PdfKernelError("signature", "The timestamp token carries no TSTInfo");
  }
  const octets = children(tokenBytes, encapContent, 4)[0];
  if (!octets) {
    throw new PdfKernelError("signature", "Malformed TSTInfo");
  }
  const tst = content(tokenBytes, expect(octets, TAG.octetString, "a TSTInfo"));
  const info = read(tst, 0);
  const infoFields = children(tst, expect(info, TAG.sequence, "a TSTInfo"), 0);
  const imprintNode = infoFields[2];
  const serialNode = infoFields[3];
  const genTime = infoFields[4];
  if (!imprintNode || !serialNode || !genTime || genTime.tag !== TAG.generalizedTime) {
    throw new PdfKernelError("signature", "Malformed TSTInfo");
  }
  const [imprintAlgorithm, imprintHash] = children(tst, imprintNode, 1);
  const algorithmOid = imprintAlgorithm ? children(tst, imprintAlgorithm, 2)[0] : undefined;
  if (!algorithmOid || !imprintHash) {
    throw new PdfKernelError("signature", "Malformed TSTInfo message imprint");
  }
  // After genTime, every field is optional and each has a tag of its own.
  const optional = infoFields.slice(5);
  const accuracyNode = optional.find((field) => field.tag === TAG.sequence);
  const nonceNode = optional.find((field) => field.tag === TAG.integer);
  const tsaNode = optional.find((field) => field.tag === 0xa0);
  let tsa: string | undefined;
  if (tsaNode) {
    const generalName = children(tst, tsaNode, 1)[0];
    if (generalName?.tag === 0xa4) {
      const name = children(tst, generalName, 2)[0];
      tsa = name ? nameText(tst, name).text : undefined;
    }
  }
  // An accuracy the kernel cannot read is left out; it says how far genTime may be off, nothing the token's checks rest on.
  let accuracy: ParsedTimestamp["accuracy"];
  try {
    accuracy = accuracyNode ? accuracyOf(tst, accuracyNode) : undefined;
  } catch {
    accuracy = undefined;
  }
  const certificates: Uint8Array[] = [];
  let signerInfos: Tlv | undefined;
  for (const field of fields.slice(3)) {
    if (field.tag === 0xa0) {
      for (const certificate of children(tokenBytes, field, 3)) {
        if (certificate.tag === TAG.sequence) {
          certificates.push(raw(tokenBytes, certificate));
        }
      }
    } else if (field.tag === TAG.set) {
      signerInfos = field;
    }
  }
  let signer: ParsedTimestampSigner | undefined;
  let signerProblem: string | undefined;
  try {
    const signerInfo = signerInfos ? children(tokenBytes, signerInfos, 3)[0] : undefined;
    if (!signerInfo) {
      throw new PdfKernelError("signature", "The timestamp token carries no SignerInfo");
    }
    signer = timestampSignerOf(tokenBytes, signerInfo);
  } catch (error) {
    signerProblem = error instanceof Error ? error.message : String(error);
  }
  return {
    token: tokenBytes,
    time: readTime(tst, genTime),
    imprintAlgorithm: readOid(tst, algorithmOid),
    imprint: content(tst, imprintHash),
    ...(tsa !== undefined ? { tsa } : {}),
    tstInfo: tst,
    serialHex: toHex(readIntegerBytes(tst, serialNode)),
    ...(nonceNode ? { nonceHex: toHex(readIntegerBytes(tst, nonceNode)) } : {}),
    ...(accuracy ? { accuracy } : {}),
    certificates,
    ...(signer ? { signer } : {}),
    ...(signerProblem !== undefined ? { signerProblem } : {})
  };
}

/**
 * Whether a token vouches for this signature value: its imprint is the value's SHA-256,
 * SHA-384 or SHA-512. A SHA-1 imprint is not taken as vouching for anything.
 */
export function timestampCovers(timestamp: ParsedTimestamp, signatureValue: Uint8Array): boolean {
  const digest = timestamp.imprintAlgorithm === OID.sha1 ? undefined : digestFor(timestamp.imprintAlgorithm, signatureValue);
  return digest !== undefined && bytesEqual(timestamp.imprint, digest);
}
