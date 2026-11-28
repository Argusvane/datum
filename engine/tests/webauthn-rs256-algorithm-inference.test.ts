import { describe, expect, it } from "vitest";
import { signedCanonicalOf, type CanonicalSubmission } from "../form-engine/core/submission/canonical-submission.js";
import { normalizeSigningFormat } from "../form-engine/core/submission/signing.js";
import { COSE_ALGORITHM } from "../form-engine/core/submission/webauthn-assertion.js";
import { registerCredential } from "../form-engine/render/webauthn/registration.js";
import { createWebAuthnSigningProvider, verifyWebAuthnSubmission } from "../form-engine/render/webauthn/signing-provider.js";
import { createSoftwareAuthenticator } from "./webauthn-fixture.js";

const RP = "localhost";
const ORIGIN = "http://localhost:5173";

const envelope: CanonicalSubmission = {
  versionContext: { form: { id: "f", version: "1" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
  submission: { locale: "en", values: { a: 1 } }
};
const request = { canonical: signedCanonicalOf(envelope), participants: [], modeId: "m", format: normalizeSigningFormat({}) };

describe("an RS256 credential whose algorithm is not stated", () => {
  it("is archived as RS256 when the listed credential gives its key without an algorithm", async () => {
    const rsa = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, algorithm: "RS256" });
    const provider = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [{ id: rsa.id, publicKey: rsa.publicKey }], credentialsContainer: rsa.container() });
    const [signed] = await provider.sign(request);
    expect(signed).toMatchObject({ algorithm: "webauthn-rs256", webauthn: { algorithm: COSE_ALGORITHM.RS256 } });
  });

  it("verifies against a registered key given without an algorithm, though a discoverable signature is archived as ES256", async () => {
    const rsa = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, algorithm: "RS256" });
    const provider = createWebAuthnSigningProvider({ rpId: RP, discoverable: true, credentialsContainer: rsa.container() });
    const [signed] = await provider.sign(request);
    expect(signed?.webauthn?.algorithm).toBe(COSE_ALGORITHM.ES256);
    const [verdict] = await verifyWebAuthnSubmission({ ...envelope, signatures: [signed!] }, { expectedOrigins: [ORIGIN], rpId: RP, publicKeyFor: (id) => (id === rsa.id ? { publicKey: rsa.publicKey } : undefined) });
    expect(verdict).toMatchObject({ valid: true, key: "registered" });
  });

  it("is recorded as RS256 at registration when the browser has no getPublicKeyAlgorithm", async () => {
    const rsa = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, algorithm: "RS256" });
    const inner = rsa.container();
    const container = {
      ...inner,
      async create(options?: CredentialCreationOptions) {
        const credential = (await inner.create(options)) as unknown as { response: Record<string, unknown> };
        const { getPublicKeyAlgorithm: _absent, ...response } = credential.response;
        return { ...credential, response } as unknown as Credential;
      }
    } as CredentialsContainer;
    const record = await registerCredential({ rpId: RP, rpName: "Datum", user: { id: "AQID", name: "n", displayName: "n" }, name: "Key", credentials: container });
    expect(record.algorithm).toBe(COSE_ALGORITHM.RS256);
  });
});
