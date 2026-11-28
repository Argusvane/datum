import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../form-engine/core/crypto/sha256.js";
import { signedCanonicalOf, type CanonicalSubmission } from "../form-engine/core/submission/canonical-submission.js";
import { normalizeSigningFormat } from "../form-engine/core/submission/signing.js";
import { base64UrlToBytes, bytesToBase64Url } from "../form-engine/core/submission/webauthn-assertion.js";
import { verifyAssertion } from "../form-engine/render/webauthn/assertion.js";
import { WebAuthnError } from "../form-engine/render/webauthn/errors.js";
import { createWebAuthnSigningProvider, verifyWebAuthnSubmission } from "../form-engine/render/webauthn/signing-provider.js";
import { createSoftwareAuthenticator } from "./webauthn-fixture.js";

const RP = "localhost";
const ORIGIN = "http://localhost:5173";

const envelope: CanonicalSubmission = {
  versionContext: { form: { id: "f", version: "1" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
  submission: { locale: "en", values: { a: 1 } }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a signature that cannot be read", () => {
  it("throws a protocol WebAuthnError from verifyAssertion when the authenticator data is truncated", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const challenge = sha256(new TextEncoder().encode("x"));
    const assertion = await authenticator.assert(challenge);
    const truncated = { ...assertion, authenticatorData: bytesToBase64Url(base64UrlToBytes(assertion.authenticatorData).slice(0, 20)) };
    const refusal = verifyAssertion(truncated, { expectedChallenge: challenge, expectedOrigins: [ORIGIN], rpId: RP });
    await expect(refusal).rejects.toBeInstanceOf(WebAuthnError);
    await expect(refusal).rejects.toMatchObject({ code: "protocol" });
  });

  it("is an invalid verdict in verifyWebAuthnSubmission, and the other signatures still get theirs", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const provider = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [authenticator.record()], credentialsContainer: authenticator.container() });
    const [good] = await provider.sign({ canonical: signedCanonicalOf(envelope), participants: [], modeId: "m", format: normalizeSigningFormat({}) });
    const truncated = { ...good!, participantId: "truncated", webauthn: { ...good!.webauthn!, authenticatorData: "AAAA" } };
    const keyless = { ...good!, participantId: "keyless", webauthn: { ...good!.webauthn!, credentialId: "zzzz", publicKey: undefined } as never };

    const archived = await verifyWebAuthnSubmission({ ...envelope, signatures: [truncated, keyless, good!] }, { expectedOrigins: [ORIGIN], rpId: RP });
    expect(archived.map((verdict) => [verdict.participantId, verdict.valid])).toEqual([
      ["truncated", false],
      ["keyless", false],
      ["submitter", true]
    ]);
    expect(archived[0]?.reason).toMatch(/could not be read/);
    expect(archived[1]?.reason).toMatch(/no public key/);

    // A registered key under an algorithm this verifier does not check fails that signature's key check only.
    const unknownAlgorithm = await verifyWebAuthnSubmission({ ...envelope, signatures: [good!, { ...good!, participantId: "other" }] }, {
      expectedOrigins: [ORIGIN],
      rpId: RP,
      publicKeyFor: () => ({ publicKey: authenticator.publicKey, algorithm: -8 })
    });
    expect(unknownAlgorithm.map((verdict) => verdict.checks.publicKey)).toEqual([false, false]);
  });

  it("still throws when there is no WebCrypto", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const provider = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [authenticator.record()], credentialsContainer: authenticator.container() });
    const signatures = await provider.sign({ canonical: signedCanonicalOf(envelope), participants: [], modeId: "m", format: normalizeSigningFormat({}) });
    vi.stubGlobal("crypto", undefined);
    await expect(verifyWebAuthnSubmission({ ...envelope, signatures }, { expectedOrigins: [ORIGIN], rpId: RP })).rejects.toMatchObject({ code: "unsupported" });
  });
});
