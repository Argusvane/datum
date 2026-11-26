/**
 * What the kernel needs from an X.509 certificate: the issuer and serial that
 * name the signer inside the CMS, the validity window, the subject for the appearance, and
 * the public-key algorithm that decides how the host must sign. Raw TLVs are kept as they
 * are — the issuer `Name` and the serial are copied into the CMS byte for byte, never
 * re-encoded. Nothing here verifies anything; that is the host's platform crypto.
 */
import { PdfKernelError } from "@argusvane/datum-engine/render";
import { OID, TAG, bytesEqual, children, content, expect, raw, read, readOid, readString, readTime, toHex, type Tlv } from "./der.js";

export type PdfSignatureAlgorithmId = "RSASSA-PKCS1-v1_5-SHA256" | "ECDSA-P256-SHA256" | "ECDSA-P384-SHA256";

export interface ParsedCertificate {
  der: Uint8Array;
  /** The serial INTEGER, whole TLV. */
  serialTlv: Uint8Array;
  serialHex: string;
  /** The issuer Name, whole TLV. */
  issuerTlv: Uint8Array;
  issuer: string;
  subjectTlv: Uint8Array;
  subject: string;
  /** The subject's common name, when it has one. */
  commonName?: string;
  notBefore: string;
  notAfter: string;
  /** The SubjectPublicKeyInfo, whole TLV — what a host imports as an "spki" key. */
  spki: Uint8Array;
  keyAlgorithm: string;
  curve?: string;
  keyUsage?: string[];
  /** The subjectKeyIdentifier extension's key identifier, which a SignerInfo may name the signer by. */
  subjectKeyId?: Uint8Array;
  selfSigned: boolean;
}

const RDN_LABELS: Record<string, string> = {
  [OID.commonName]: "CN",
  [OID.organization]: "O",
  [OID.organizationalUnit]: "OU",
  [OID.country]: "C",
  [OID.locality]: "L",
  [OID.state]: "ST",
  [OID.serialNumberAttribute]: "serialNumber",
  [OID.emailAddress]: "E"
};

const KEY_USAGE_BITS = ["digitalSignature", "nonRepudiation", "keyEncipherment", "dataEncipherment", "keyAgreement", "keyCertSign", "cRLSign", "encipherOnly", "decipherOnly"];

/** `CN=…, O=…, C=…` in certificate order; other attribute types shown by their dotted id. */
export function nameText(bytes: Uint8Array, name: Tlv): { text: string; commonName?: string } {
  const parts: string[] = [];
  let commonName: string | undefined;
  for (const rdn of children(bytes, expect(name, TAG.sequence, "a Name"), 1)) {
    for (const attribute of children(bytes, expect(rdn, TAG.set, "a relative distinguished name"), 2)) {
      const [type, value] = children(bytes, expect(attribute, TAG.sequence, "an attribute"), 3);
      if (!type || !value) {
        continue;
      }
      const id = readOid(bytes, type);
      const text = readString(bytes, value);
      if (id === OID.commonName && commonName === undefined) {
        commonName = text;
      }
      parts.push(`${RDN_LABELS[id] ?? id}=${text.replace(/,/g, "\\,")}`);
    }
  }
  return { text: parts.join(", "), ...(commonName !== undefined ? { commonName } : {}) };
}

/** An extension's `extnValue` content (the DER inside the OCTET STRING), by OID. */
function extensionValue(bytes: Uint8Array, extensions: Tlv | undefined, id: string): Uint8Array | undefined {
  if (!extensions) {
    return undefined;
  }
  const list = children(bytes, extensions, 1)[0];
  if (!list) {
    return undefined;
  }
  for (const extension of children(bytes, expect(list, TAG.sequence, "extensions"), 2)) {
    const fields = children(bytes, extension, 3);
    if (!fields[0] || readOid(bytes, fields[0]) !== id) {
      continue;
    }
    return content(bytes, expect(fields[fields.length - 1]!, TAG.octetString, "an extension value"));
  }
  return undefined;
}

/** `SubjectKeyIdentifier ::= KeyIdentifier (OCTET STRING)`. */
function subjectKeyIdOf(bytes: Uint8Array, extensions: Tlv | undefined): Uint8Array | undefined {
  const value = extensionValue(bytes, extensions, OID.subjectKeyIdentifier);
  if (!value) {
    return undefined;
  }
  return content(value, expect(read(value, 0), TAG.octetString, "a key identifier"));
}

function keyUsageOf(bytes: Uint8Array, extensions: Tlv | undefined): string[] | undefined {
  if (!extensions) {
    return undefined;
  }
  const list = children(bytes, extensions, 1)[0];
  if (!list) {
    return undefined;
  }
  for (const extension of children(bytes, expect(list, TAG.sequence, "extensions"), 2)) {
    const fields = children(bytes, extension, 3);
    if (!fields[0] || readOid(bytes, fields[0]) !== OID.keyUsage) {
      continue;
    }
    const valueNode = fields[fields.length - 1]!;
    const inner = read(content(bytes, valueNode), 0);
    const bits = content(content(bytes, valueNode), inner);
    const flags: string[] = [];
    for (let bit = 0; bit < KEY_USAGE_BITS.length; bit += 1) {
      const byte = bits[1 + (bit >> 3)];
      if (byte !== undefined && byte & (0x80 >> (bit & 7))) {
        flags.push(KEY_USAGE_BITS[bit]!);
      }
    }
    return flags;
  }
  return undefined;
}

export function parseCertificate(der: Uint8Array): ParsedCertificate {
  const certificate = read(der, 0);
  expect(certificate, TAG.sequence, "a Certificate");
  const [tbs] = children(der, certificate, 0);
  if (!tbs) {
    throw new PdfKernelError("signature", "Malformed certificate: no TBSCertificate");
  }
  const fields = children(der, expect(tbs, TAG.sequence, "a TBSCertificate"), 1);
  let index = 0;
  if (fields[0]?.tag === 0xa0) {
    index = 1;
  }
  const serial = fields[index];
  const issuer = fields[index + 2];
  const validity = fields[index + 3];
  const subject = fields[index + 4];
  const spki = fields[index + 5];
  if (!serial || !issuer || !validity || !subject || !spki) {
    throw new PdfKernelError("signature", "Malformed certificate: TBSCertificate is missing fields");
  }
  expect(serial, TAG.integer, "a serial number");
  const [notBefore, notAfter] = children(der, expect(validity, TAG.sequence, "a validity period"), 2);
  if (!notBefore || !notAfter) {
    throw new PdfKernelError("signature", "Malformed certificate: validity");
  }
  const [algorithm] = children(der, expect(spki, TAG.sequence, "a SubjectPublicKeyInfo"), 2);
  if (!algorithm) {
    throw new PdfKernelError("signature", "Malformed certificate: public key algorithm");
  }
  const [algorithmOid, parameters] = children(der, expect(algorithm, TAG.sequence, "an AlgorithmIdentifier"), 3);
  if (!algorithmOid) {
    throw new PdfKernelError("signature", "Malformed certificate: public key algorithm");
  }
  const keyAlgorithm = readOid(der, algorithmOid);
  const curve = keyAlgorithm === OID.ecPublicKey && parameters?.tag === TAG.oid ? readOid(der, parameters) : undefined;
  const extensions = fields.slice(index + 6).find((field) => field.tag === 0xa3);
  const issuerName = nameText(der, issuer);
  const subjectName = nameText(der, subject);
  const issuerTlv = raw(der, issuer);
  const subjectTlv = raw(der, subject);
  const serialBody = content(der, serial);
  const keyUsage = keyUsageOf(der, extensions);
  let subjectKeyId: Uint8Array | undefined;
  try {
    subjectKeyId = subjectKeyIdOf(der, extensions);
  } catch {
    // A malformed identifier only means the certificate cannot be found by it.
    subjectKeyId = undefined;
  }
  return {
    der,
    serialTlv: raw(der, serial),
    serialHex: toHex(serialBody.length > 1 && serialBody[0] === 0 ? serialBody.subarray(1) : serialBody),
    issuerTlv,
    issuer: issuerName.text,
    subjectTlv,
    subject: subjectName.text,
    ...(subjectName.commonName !== undefined ? { commonName: subjectName.commonName } : {}),
    notBefore: readTime(der, notBefore),
    notAfter: readTime(der, notAfter),
    spki: raw(der, spki),
    keyAlgorithm,
    ...(curve !== undefined ? { curve } : {}),
    ...(keyUsage ? { keyUsage } : {}),
    ...(subjectKeyId ? { subjectKeyId } : {}),
    selfSigned: bytesEqual(issuerTlv, subjectTlv)
  };
}

/** How the host must sign, from the key the certificate certifies. */
export function signatureAlgorithmFor(certificate: ParsedCertificate): PdfSignatureAlgorithmId {
  if (certificate.keyAlgorithm === OID.rsaEncryption) {
    return "RSASSA-PKCS1-v1_5-SHA256";
  }
  if (certificate.keyAlgorithm === OID.ecPublicKey) {
    if (certificate.curve === OID.prime256v1) {
      return "ECDSA-P256-SHA256";
    }
    if (certificate.curve === OID.secp384r1) {
      return "ECDSA-P384-SHA256";
    }
    throw new PdfKernelError("signature", `Unsupported elliptic curve ${certificate.curve ?? "(unnamed)"}; use P-256 or P-384`);
  }
  if (certificate.keyAlgorithm === OID.rsassaPss) {
    throw new PdfKernelError("signature", "RSASSA-PSS keys are not supported; use an RSA (PKCS#1) or EC certificate");
  }
  throw new PdfKernelError("signature", `Unsupported public key algorithm ${certificate.keyAlgorithm}`);
}

/** The certificate a SignerInfo's IssuerAndSerialNumber names, if it is among the given ones. */
export function findByIssuerSerial(certificates: readonly ParsedCertificate[], issuerTlv: Uint8Array, serialTlv: Uint8Array): ParsedCertificate | undefined {
  return certificates.find((certificate) => bytesEqual(certificate.issuerTlv, issuerTlv) && bytesEqual(certificate.serialTlv, serialTlv));
}

/** The certificate a SignerInfo's `[0] subjectKeyIdentifier` names, if it is among the given ones. */
export function findBySubjectKeyId(certificates: readonly ParsedCertificate[], keyId: Uint8Array): ParsedCertificate | undefined {
  return certificates.find((certificate) => certificate.subjectKeyId !== undefined && bytesEqual(certificate.subjectKeyId, keyId));
}

/** Whether a leaf's issuer is among the certificates (by name), or the leaf signs itself. */
export function chainNamesIssuer(leaf: ParsedCertificate, certificates: readonly ParsedCertificate[]): boolean {
  return leaf.selfSigned || certificates.some((candidate) => candidate !== leaf && bytesEqual(candidate.subjectTlv, leaf.issuerTlv));
}
