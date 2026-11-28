import { describe, expect, it } from "vitest";
import { signedCanonicalOf, type CanonicalSubmission } from "../form-engine/core/submission/canonical-submission.js";
import { normalizeSigningFormat } from "../form-engine/core/submission/signing.js";
import { createWebAuthnSigningProvider, verifyWebAuthnSubmission } from "../form-engine/render/webauthn/signing-provider.js";
import { createSoftwareAuthenticator } from "./webauthn-fixture.js";

const RP = "localhost";
const ORIGIN = "http://localhost:5173";

const envelope: CanonicalSubmission = {
  versionContext: { form: { id: "transfer", version: "1" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
  submission: { locale: "en", values: { amount: 1000000 } }
};

async function signedWith(authenticator: Awaited<ReturnType<typeof createSoftwareAuthenticator>>): Promise<CanonicalSubmission> {
  const provider = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [authenticator.record()], credentialsContainer: authenticator.container() });
  const signatures = await provider.sign({ canonical: signedCanonicalOf(envelope), participants: [], modeId: "m", format: normalizeSigningFormat({}) });
  return { ...envelope, signatures };
}

describe("a credential the verifier's key lookup does not know", () => {
  it("is invalid, even though the key archived in the assertion verifies it", async () => {
    const registered = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const attacker = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const keys = new Map([[registered.id, { publicKey: registered.publicKey, algorithm: registered.algorithm }]]);
    const forged = await signedWith(attacker);

    const [verdict] = await verifyWebAuthnSubmission(forged, { expectedOrigins: [ORIGIN], rpId: RP, publicKeyFor: (id) => keys.get(id) });
    expect(verdict).toMatchObject({ valid: false, checks: { challenge: true, publicKey: false, signature: false } });
    expect(verdict?.reason).toMatch(/not registered/);
    expect(verdict?.key).toBeUndefined();
  });

  it("says which key a valid signature was checked with: the registered one, or the archived one when there is no lookup", async () => {
    const registered = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const keys = new Map([[registered.id, { publicKey: registered.publicKey, algorithm: registered.algorithm }]]);
    const signed = await signedWith(registered);

    const [fromStore] = await verifyWebAuthnSubmission(signed, { expectedOrigins: [ORIGIN], rpId: RP, publicKeyFor: (id) => keys.get(id) });
    expect(fromStore).toMatchObject({ valid: true, key: "registered" });
    const [fromArchive] = await verifyWebAuthnSubmission(signed, { expectedOrigins: [ORIGIN], rpId: RP });
    expect(fromArchive).toMatchObject({ valid: true, key: "archived" });
  });
});
