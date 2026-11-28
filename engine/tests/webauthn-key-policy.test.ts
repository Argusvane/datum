import { describe, expect, it } from "vitest";
import { sha256 } from "../form-engine/core/crypto/sha256.js";
import { bytesToBase64 } from "../form-engine/core/schema/file-upload.js";
import { COSE_ALGORITHM, bytesToBase64Url } from "../form-engine/core/submission/webauthn-assertion.js";
import { verifyAssertion } from "../form-engine/render/webauthn/assertion.js";
import { registerCredential, verifyRegistration } from "../form-engine/render/webauthn/registration.js";
import { SoftwareAuthenticator } from "./webauthn-fixture.js";

const RP = "localhost";
const ORIGIN = "http://localhost:5173";
const subtle = globalThis.crypto.subtle;
const challenge = sha256(new TextEncoder().encode("the document"));
const options = { expectedChallenge: challenge, expectedOrigins: [ORIGIN], rpId: RP };

async function authenticatorWith(params: RsaHashedKeyGenParams | EcKeyGenParams, algorithm: number): Promise<SoftwareAuthenticator> {
  const pair = (await subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  return new SoftwareAuthenticator(RP, ORIGIN, algorithm, new Uint8Array(16).fill(algorithm === COSE_ALGORITHM.RS256 ? 7 : 9), spki, pair.privateKey, pair.privateKey, {}, subtle);
}

const rsa = (modulusLength: number): RsaHashedKeyGenParams => ({ name: "RSASSA-PKCS1-v1_5", modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" });

describe("the key policy: ES256 on P-256, RS256 of at least 2048 bits", () => {
  it("refuses an assertion from an RSA key under 2048 bits, though its signature holds", async () => {
    const weak = await authenticatorWith(rsa(1024), COSE_ALGORITHM.RS256);
    const verdict = await verifyAssertion(await weak.assert(challenge), options);
    expect(verdict).toMatchObject({ valid: false, checks: { publicKey: false } });
    expect(verdict.reason).toMatch(/2048/);
    const strong = await authenticatorWith(rsa(2048), COSE_ALGORITHM.RS256);
    expect((await verifyAssertion(await strong.assert(challenge), options)).valid).toBe(true);
  });

  it("refuses an ES256 assertion from an EC key not on P-256", async () => {
    const p384 = await authenticatorWith({ name: "ECDSA", namedCurve: "P-384" }, COSE_ALGORITHM.ES256);
    const verdict = await verifyAssertion(await p384.assert(challenge), options);
    expect(verdict).toMatchObject({ valid: false, checks: { publicKey: false } });
  });

  it("refuses a registration whose key is an RSA key under 2048 bits, or does not match its algorithm", async () => {
    const weak = await authenticatorWith(rsa(1024), COSE_ALGORITHM.RS256);
    const serverChallenge = bytesToBase64Url(sha256(new TextEncoder().encode("server challenge")));
    const result = await registerCredential({ rpId: RP, rpName: "Datum", user: { id: "AQID", name: "n", displayName: "n" }, name: "Key", challenge: serverChallenge, credentials: weak.container() });
    const verifyOptions = { expectedChallenge: serverChallenge, expectedOrigins: [ORIGIN], rpId: RP };
    const verdict = verifyRegistration(result, verifyOptions);
    expect(verdict).toMatchObject({ valid: false, checks: { publicKey: false, credentialId: true } });
    expect(verdict.reason).toMatch(/2048/);

    const strong = await authenticatorWith(rsa(2048), COSE_ALGORITHM.RS256);
    const accepted = { ...result, publicKey: bytesToBase64(strong.publicKeySpki) };
    expect(verifyRegistration(accepted, verifyOptions).checks.publicKey).toBe(true);
    expect(verifyRegistration({ ...accepted, algorithm: COSE_ALGORITHM.ES256 }, verifyOptions).checks.publicKey).toBe(false);
    expect(verifyRegistration({ ...accepted, publicKey: "" }, verifyOptions).checks.publicKey).toBe(false);
  });
});
