/**
 * Kernel parity for datum-timestamp: feeds the Java-made tokens (src/test/resources/kernel, written by
 * KernelParityTest with -Ddatum.timestamp.writeKernelFixtures=true) through the PDF kernel's own parser
 * (parseTimestampToken) and timestampCovers, and verifies the TSA signature over the kernel's toBeVerified with
 * Node's crypto, as the kernel's verify tests do host-side. Writes what the kernel read to
 * src/test/resources/kernel/kernel-parity.golden.json, which KernelParityTest holds the Java reader to.
 *
 * Run from packages/pdf-kernel (its vite config resolves @argusvane/datum-engine):
 *   cd packages/pdf-kernel && npx vite-node ../../integrations/jvm/libs/datum-timestamp/src/test/kernel/kernel-parity.ts
 */
import { createPublicKey, verify, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTimestampToken, timestampCovers } from "../../../../../../../packages/pdf-kernel/src/kernel/signature/cms.ts";

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, "..", "resources");
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const digestNames: Record<string, string> = {
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512"
};

interface Entry {
  file: string;
  value: string;
  certificate: string;
  candidate: boolean;
}

const manifest = JSON.parse(readFileSync(join(resources, "kernel", "tokens.json"), "utf8")) as Entry[];
const golden: Record<string, unknown> = {};
for (const entry of manifest) {
  const bytes = new Uint8Array(readFileSync(join(resources, "kernel", entry.file)));
  const parsed = parseTimestampToken(bytes);
  const value = new TextEncoder().encode(entry.value);
  // The token's own certificate, else the one the host would hand over (a token asked for without certReq).
  const certificateDer = parsed.certificates[0] ?? (entry.candidate ? new X509Certificate(readFileSync(join(resources, "fixtures", entry.certificate))).raw : undefined);
  let signatureVerifies = false;
  if (parsed.signer && certificateDer) {
    const key = createPublicKey(new X509Certificate(Buffer.from(certificateDer)).publicKey.export({ type: "spki", format: "pem" }));
    const digest = digestNames[parsed.signer.digestAlgorithm] ?? "sha256";
    signatureVerifies = verify(digest, Buffer.from(parsed.signer.toBeVerified), key, Buffer.from(parsed.signer.signature));
  }
  golden[entry.file] = {
    time: parsed.time,
    serialHex: parsed.serialHex,
    imprintAlgorithm: parsed.imprintAlgorithm,
    imprintHex: hex(parsed.imprint),
    ...(parsed.nonceHex !== undefined ? { nonceHex: parsed.nonceHex } : {}),
    ...(parsed.accuracy !== undefined ? { accuracy: parsed.accuracy } : {}),
    ...(parsed.tsa !== undefined ? { tsa: parsed.tsa } : {}),
    certificates: parsed.certificates.length,
    ...(parsed.signerProblem !== undefined ? { signerProblem: parsed.signerProblem } : {}),
    digestAlgorithm: parsed.signer?.digestAlgorithm,
    signatureAlgorithm: parsed.signer?.signatureAlgorithm,
    contentType: parsed.signer?.contentType,
    messageDigestHex: parsed.signer?.messageDigest ? hex(parsed.signer.messageDigest) : undefined,
    essCertId: parsed.signer?.essCertId ? { algorithm: parsed.signer.essCertId.algorithm, hashHex: hex(parsed.signer.essCertId.hash) } : parsed.signer?.essCertId,
    hasIssuerSerial: Boolean(parsed.signer?.issuerTlv && parsed.signer?.serialTlv),
    coversRight: timestampCovers(parsed, value),
    coversWrong: timestampCovers(parsed, new TextEncoder().encode(entry.value + " (altered)")),
    signatureVerifies
  };
}
const text = JSON.stringify(golden, null, 2) + "\n";
writeFileSync(join(resources, "kernel", "kernel-parity.golden.json"), text);
process.stdout.write(text);
