import { describe, expect, it } from "vitest";
import { sha256 } from "../form-engine/core/crypto/sha256.js";
import { base64UrlToBytes, bytesToBase64Url } from "../form-engine/core/submission/webauthn-assertion.js";
import { verifyAssertion } from "../form-engine/render/webauthn/assertion.js";
import { registerCredential, verifyRegistration } from "../form-engine/render/webauthn/registration.js";
import { createSoftwareAuthenticator } from "./webauthn-fixture.js";

const RP = "localhost";
const ORIGIN = "http://localhost:5173";
const challenge = sha256(new TextEncoder().encode("the document"));
const options = { expectedChallenge: challenge, expectedOrigins: [ORIGIN], rpId: RP };

/** An assertion whose client data says what `extra` adds, signed so the signature itself holds. */
async function assertionWith(extra: Record<string, unknown>) {
  const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
  const base = await authenticator.assert(challenge);
  const authenticatorData = base64UrlToBytes(base.authenticatorData);
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: bytesToBase64Url(challenge), origin: ORIGIN, ...extra }));
  const signature = await authenticator.sign(authenticatorData, clientDataJSON);
  return { ...base, clientDataJSON: bytesToBase64Url(clientDataJSON), signature: bytesToBase64Url(signature) };
}

async function registration(authenticatorOptions: Parameters<typeof createSoftwareAuthenticator>[0] = {}) {
  const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, ...authenticatorOptions });
  const serverChallenge = bytesToBase64Url(sha256(new TextEncoder().encode("server challenge")));
  const result = await registerCredential({ rpId: RP, rpName: "Datum", user: { id: "AQID", name: "n", displayName: "n" }, name: "Key", challenge: serverChallenge, credentials: authenticator.container() });
  return { result, verifyOptions: { expectedChallenge: serverChallenge, expectedOrigins: [ORIGIN], rpId: RP } };
}

describe("an assertion or a registration made in a cross-origin frame", () => {
  it("refuses an assertion with crossOrigin true or a topOrigin, and accepts crossOrigin false", async () => {
    expect((await verifyAssertion(await assertionWith({ crossOrigin: false }), options)).valid).toBe(true);
    for (const extra of [{ crossOrigin: true }, { crossOrigin: true, topOrigin: "https://embedder.example" }, { topOrigin: "https://embedder.example" }]) {
      const verdict = await verifyAssertion(await assertionWith(extra), options);
      expect(verdict).toMatchObject({ valid: false, checks: { crossOrigin: false, signature: true } });
      expect(verdict.reason).toMatch(/cross-origin/);
    }
  });

  it("refuses a registration with crossOrigin true", async () => {
    const { result, verifyOptions } = await registration();
    expect(verifyRegistration(result, verifyOptions).checks.crossOrigin).toBe(true);
    const clientData = JSON.parse(new TextDecoder().decode(base64UrlToBytes(result.response.clientDataJSON))) as Record<string, unknown>;
    const framed = { ...result, response: { ...result.response, clientDataJSON: bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ ...clientData, crossOrigin: true }))) } };
    const verdict = verifyRegistration(framed, verifyOptions);
    expect(verdict).toMatchObject({ valid: false, checks: { crossOrigin: false } });
    expect(verdict.reason).toMatch(/cross-origin/);
  });
});

describe("a credential reported backed up but not backup eligible", () => {
  it("is refused in an assertion", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, backupEligible: false, backedUp: true });
    const verdict = await verifyAssertion(await authenticator.assert(challenge), options);
    expect(verdict).toMatchObject({ valid: false, checks: { backupState: false, signature: true } });
    expect(verdict.reason).toMatch(/backup eligible/);
    const eligible = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, backupEligible: true, backedUp: true });
    expect((await verifyAssertion(await eligible.assert(challenge), options)).valid).toBe(true);
  });

  it("is refused in a registration", async () => {
    const { result, verifyOptions } = await registration({ backupEligible: false, backedUp: true });
    const verdict = verifyRegistration(result, verifyOptions);
    expect(verdict).toMatchObject({ valid: false, checks: { backupState: false } });
    expect(verdict.reason).toMatch(/backup eligible/);
  });
});
