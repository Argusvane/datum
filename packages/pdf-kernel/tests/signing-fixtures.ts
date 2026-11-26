/**
 * The demo keys and certificates under `tests/fixtures/signing/` (minted by
 * `scripts/make-signing-fixtures.mjs`), and a host's side of the two-call protocol done with
 * Node's `crypto` — what a server does with its platform crypto.
 */
import { X509Certificate, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PdfSignatureAlgorithm, PdfSignatureReport } from "@argusvane/datum-engine/render";
import { base64ToBytes, bytesToBase64 } from "@argusvane/datum-engine/render";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "signing");

export type FixtureName = "rsa2048" | "p256" | "p384" | "chain-leaf" | "demo-ca" | "tsa";

export interface SigningIdentity {
  name: FixtureName;
  key: KeyObject;
  /** DER, base64 — the leaf first, then its issuers. */
  certificates: string[];
  certificatePem: string;
  algorithm: PdfSignatureAlgorithm;
}

function pem(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

/** A PEM certificate as DER base64. */
export function certificateBase64(file: string): string {
  return new X509Certificate(pem(file)).raw.toString("base64");
}

export function identity(name: FixtureName): SigningIdentity {
  const key = createPrivateKey(pem(`${name}.key.pem`));
  const certificates = [certificateBase64(`${name}.cert.pem`)];
  if (name === "chain-leaf") {
    certificates.push(certificateBase64("demo-ca.cert.pem"));
  }
  const algorithm: PdfSignatureAlgorithm = key.asymmetricKeyType === "rsa" ? "RSASSA-PKCS1-v1_5-SHA256" : key.asymmetricKeyDetails?.namedCurve === "secp384r1" ? "ECDSA-P384-SHA256" : "ECDSA-P256-SHA256";
  return { name, key, certificates, certificatePem: pem(`${name}.cert.pem`), algorithm };
}

/** The host's one cryptographic step: sign the DER signed attributes. */
export function hostSign(identity: SigningIdentity, toBeSigned: string, encoding: "der" | "ieee-p1363" = "der"): string {
  const data = Buffer.from(base64ToBytes(toBeSigned));
  const signature = identity.key.asymmetricKeyType === "rsa" ? nodeSign("sha256", data, identity.key) : nodeSign("sha256", data, { key: identity.key, dsaEncoding: encoding });
  return bytesToBase64(new Uint8Array(signature));
}

/** The host's check on a `verify` report: the signature value over `toBeVerified` with the signer's public key. */
export function hostVerify(report: PdfSignatureReport): boolean {
  if (!report.signer) {
    return false;
  }
  const key = createPublicKey({ key: Buffer.from(base64ToBytes(report.signer.publicKey)), format: "der", type: "spki" });
  const data = Buffer.from(base64ToBytes(report.toBeVerified));
  const signature = Buffer.from(base64ToBytes(report.signature));
  return key.asymmetricKeyType === "rsa" ? nodeVerify("sha256", data, key, signature) : nodeVerify("sha256", data, { key, dsaEncoding: "der" }, signature);
}

export function hasOpenssl(): boolean {
  return spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
}

/**
 * An independent verdict: `openssl cms -verify` over the CMS the signature carries and the
 * bytes the ByteRange names. `-noverify` skips the chain (demo certificates), `-binary` keeps
 * the content as is.
 */
export function opensslVerifies(bytes: Uint8Array, report: PdfSignatureReport, cmsBase64: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "datum-cms-"));
  const [, length0, start1, length1] = report.byteRange;
  const content = Buffer.concat([Buffer.from(bytes.subarray(0, length0)), Buffer.from(bytes.subarray(start1, start1 + length1))]);
  writeFileSync(join(dir, "content.bin"), content);
  writeFileSync(join(dir, "cms.der"), Buffer.from(base64ToBytes(cmsBase64)));
  const result = spawnSync("openssl", ["cms", "-verify", "-inform", "DER", "-in", join(dir, "cms.der"), "-content", join(dir, "content.bin"), "-binary", "-noverify", "-out", join(dir, "out.bin")], { encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

/**
 * A timestamp token from the fixture TSA, as a host would fetch one, over the kernel's request.
 * `settings` replaces lines of `tsa.cnf` by key (`signer_digest`, `ess_cert_id_alg`, …), for a
 * TSA that signs with another digest or names its certificate the older way.
 */
export function opensslTimestamp(requestBase64: string, settings: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "datum-tsa-"));
  for (const file of ["tsa.cert.pem", "tsa.key.pem"]) {
    copyFileSync(join(FIXTURES_DIR, file), join(dir, file));
  }
  let config = readFileSync(join(FIXTURES_DIR, "tsa.cnf"), "utf8");
  for (const [key, value] of Object.entries(settings)) {
    const line = new RegExp(`^${key} = .*$`, "m");
    if (!line.test(config)) {
      throw new Error(`tsa.cnf has no "${key}" line to replace`);
    }
    config = config.replace(line, `${key} = ${value}`);
  }
  writeFileSync(join(dir, "tsa.cnf"), config);
  writeFileSync(join(dir, "tsa.serial"), "01\n");
  writeFileSync(join(dir, "request.tsq"), Buffer.from(base64ToBytes(requestBase64)));
  // OpenSSL 4 takes the TSA's signing digest from the command line only (`-sha512`), no longer
  // from the config's `signer_digest`; OpenSSL 1.1 and 3 accept the flag too, so both are given.
  const digest = settings.signer_digest !== undefined ? [`-${settings.signer_digest}`] : [];
  execFileSync("openssl", ["ts", "-reply", "-config", "tsa.cnf", "-queryfile", "request.tsq", ...digest, "-out", "reply.tsr"], { cwd: dir, stdio: "pipe" });
  return bytesToBase64(new Uint8Array(readFileSync(join(dir, "reply.tsr"))));
}
