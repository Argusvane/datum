import { X509Certificate, createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ecdsaSignatureToDer, mintSelfSignedCertificate, parseCertificate } from "../src/index.js";
import { hasOpenssl } from "./signing-fixtures.js";

const subtle = globalThis.crypto.subtle;

async function p256(): Promise<{ spki: Uint8Array; sign: (tbs: Uint8Array) => Promise<Uint8Array>; publicKey: CryptoKey }> {
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    spki: new Uint8Array(await subtle.exportKey("spki", pair.publicKey)),
    publicKey: pair.publicKey,
    sign: async (tbs) => new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, tbs as BufferSource))
  };
}

describe("mintSelfSignedCertificate", () => {
  it("mints a v3 certificate the kernel's own parser reads back: issuer = subject, validity, key usage, the key", async () => {
    const key = await p256();
    const der = await mintSelfSignedCertificate({
      spki: key.spki,
      subject: { commonName: "Datum Data tab (demo)", organization: "Datum", country: "CA" },
      notBefore: "2026-09-15T00:00:00.000Z",
      notAfter: "2036-09-15T00:00:00.000Z",
      serial: new Uint8Array([0x81, 0x02, 0x03, 0x04]),
      sign: key.sign
    });
    const parsed = parseCertificate(der);
    expect(parsed.commonName).toBe("Datum Data tab (demo)");
    expect(parsed.subject).toContain("CN=Datum Data tab (demo)");
    expect(parsed.subject).toContain("O=Datum");
    expect(parsed.subject).toContain("C=CA");
    expect(parsed.issuer).toBe(parsed.subject);
    expect(parsed.selfSigned).toBe(true);
    expect(parsed.notBefore.slice(0, 19)).toBe("2026-09-15T00:00:00");
    expect(parsed.notAfter.slice(0, 19)).toBe("2036-09-15T00:00:00");
    // The serial's top bit is cleared so it stays a positive INTEGER.
    expect(parsed.serialHex).toBe("01020304");
    // The parser keeps the OIDs: id-ecPublicKey on prime256v1.
    expect(parsed.keyAlgorithm).toBe("1.2.840.10045.2.1");
    expect(parsed.curve).toBe("1.2.840.10045.3.1.7");
    expect(parsed.keyUsage).toEqual(expect.arrayContaining(["digitalSignature", "nonRepudiation"]));
    expect(Buffer.from(parsed.spki).equals(Buffer.from(key.spki))).toBe(true);
  });

  it("is a certificate Node's X.509 accepts, self-issued and verifying under its own key; GeneralizedTime past 2049", async () => {
    const key = await p256();
    const der = await mintSelfSignedCertificate({
      spki: key.spki,
      subject: { commonName: "Later" },
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2126-01-01T00:00:00.000Z",
      sign: key.sign
    });
    const certificate = new X509Certificate(Buffer.from(der));
    expect(certificate.subject).toBe("CN=Later");
    expect(certificate.issuer).toBe(certificate.subject);
    // The signature over the TBSCertificate verifies under the key the certificate carries.
    expect(certificate.verify(createPublicKey({ key: Buffer.from(key.spki), format: "der", type: "spki" }))).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    // (`checkIssued` is not asked: OpenSSL wants keyCertSign on an issuer, and a leaf signing certificate has none — the same as the openssl-minted demo certificate.)
    expect(certificate.validTo).toContain("2126");
    // (Node's `keyUsage` accessor lists extended key usage; the plain usage bits are what the kernel's parser and openssl report, tested beside.)
    expect(parseCertificate(der).keyUsage).toEqual(expect.arrayContaining(["digitalSignature", "nonRepudiation"]));
    expect(certificate.ca).toBe(false);
    // The BIT STRING wraps the DER ECDSA signature, whatever shape the signer handed back.
    expect(ecdsaSignatureToDer(new Uint8Array(64).fill(1))[0]).toBe(0x30);
    expect(ecdsaSignatureToDer(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toEqual(new Uint8Array([0x30, 0x02, 0x02, 0x00]));
  });

  it("reads as a certificate to openssl", async () => {
    if (!hasOpenssl()) {
      return;
    }
    const key = await p256();
    const der = await mintSelfSignedCertificate({ spki: key.spki, subject: { commonName: "Openssl reads me", organization: "Datum" }, notBefore: "2026-09-15T00:00:00.000Z", notAfter: "2036-09-15T00:00:00.000Z", sign: key.sign });
    const dir = mkdtempSync(join(tmpdir(), "datum-selfsigned-"));
    writeFileSync(join(dir, "cert.der"), Buffer.from(der));
    const text = spawnSync("openssl", ["x509", "-inform", "DER", "-in", join(dir, "cert.der"), "-noout", "-text"], { encoding: "utf8" });
    expect(text.status).toBe(0);
    // OpenSSL 3 prints "CN = ..." where LibreSSL prints "CN=...".
    expect(text.stdout).toMatch(/CN ?= ?Openssl reads me/);
    expect(text.stdout).toContain("ecdsa-with-SHA256");
    expect(text.stdout).toContain("CA:FALSE");
    expect(text.stdout).toContain("Digital Signature, Non Repudiation");
    const verify = spawnSync("openssl", ["verify", "-CAfile", "/dev/stdin", join(dir, "cert.der")], { encoding: "utf8", input: spawnSync("openssl", ["x509", "-inform", "DER", "-in", join(dir, "cert.der")], { encoding: "utf8" }).stdout });
    // `openssl verify` wants PEM; a self-signed leaf verifies against itself.
    writeFileSync(join(dir, "cert.pem"), spawnSync("openssl", ["x509", "-inform", "DER", "-in", join(dir, "cert.der")], { encoding: "utf8" }).stdout);
    const pemVerify = spawnSync("openssl", ["verify", "-CAfile", join(dir, "cert.pem"), join(dir, "cert.pem")], { encoding: "utf8" });
    expect(`${pemVerify.stdout}${pemVerify.stderr}`).toContain("OK");
    void verify;
  });
});
