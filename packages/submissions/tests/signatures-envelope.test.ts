import { describe, expect, it } from "vitest";
import { DEFAULT_SUBMISSION_SIGNING_FORMAT, createWebAuthnSigningProvider, normalizeSigningFormat, sha256, signedCanonicalOf, type CanonicalSubmission, type SignedSubmissionDocument } from "@argusvane/datum-engine";

import { createSoftwareAuthenticator } from "../../../engine/tests/webauthn-fixture.js";
import { inspectEnvelopeSignatures, summarize, type EnvelopeVerifierDeps } from "../src/index.js";

const RP = "localhost";
const ORIGIN = "http://localhost:5173";

const ENVELOPE: CanonicalSubmission = {
  versionContext: { form: { id: "intake", version: "1.0.0" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" } },
  submission: { locale: "en", values: { name: "Ada", consent: true } }
};

async function signedBy(authenticator: Awaited<ReturnType<typeof createSoftwareAuthenticator>>, placement: "embedded" | "wrapper" = "embedded"): Promise<CanonicalSubmission | SignedSubmissionDocument> {
  const format = normalizeSigningFormat({ placement });
  const provider = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [{ id: authenticator.id, algorithm: authenticator.algorithm, publicKey: authenticator.publicKey }], credentialsContainer: authenticator.container() });
  const signatures = await provider.sign({ canonical: signedCanonicalOf(ENVELOPE, format.scope), participants: [{ id: "applicant", role: "primary" }], modeId: "m", format });
  return placement === "wrapper" ? { format, payload: ENVELOPE, signatures } : { ...ENVELOPE, signatures };
}

function depsFor(authenticator: Awaited<ReturnType<typeof createSoftwareAuthenticator>> | undefined, name = "Ada's key"): EnvelopeVerifierDeps {
  return {
    credentials: (id) => (authenticator && id === authenticator.id ? { publicKey: authenticator.publicKey, algorithm: authenticator.algorithm, name } : undefined),
    expectedOrigins: [ORIGIN],
    rpId: RP,
    requireUserVerification: true
  };
}

describe("inspectEnvelopeSignatures", () => {
  it("reports an unsigned envelope as none, with the digest the signatures would cover", async () => {
    const report = await inspectEnvelopeSignatures(ENVELOPE, depsFor(undefined));
    expect(report.placement).toBe("none");
    expect(report.signatures).toEqual([]);
    expect(report.summary).toEqual({ count: 0, status: "none" });
    expect(report.scopedDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("itemises a WebAuthn signature's checks and calls it valid when the credential is registered and every check holds", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, userVerified: true });
    const report = await inspectEnvelopeSignatures(await signedBy(authenticator), depsFor(authenticator));
    expect(report.placement).toBe("embedded");
    expect(report.summary).toEqual({ count: 1, status: "valid", scope: "envelope" });
    const [verdict] = report.signatures;
    expect(verdict).toMatchObject({
      participantId: "applicant",
      provider: "webauthn",
      algorithm: "webauthn-es256",
      status: "valid",
      checks: { type: true, challenge: true, origin: true, rpId: true, userPresent: true, userVerified: true, signature: true },
      credential: { id: authenticator.id, name: "Ada's key", registered: true }
    });
    expect(verdict?.signCount).toBe(1);
    expect(verdict?.reason).toBeUndefined();

    // The wrapper placement reads the same, and says where the signatures are.
    const wrapped = await inspectEnvelopeSignatures(await signedBy(authenticator, "wrapper"), depsFor(authenticator));
    expect(wrapped.placement).toBe("wrapper");
    expect(wrapped.format.placement).toBe("wrapper");
    expect(wrapped.summary.status).toBe("valid");
  });

  it("calls a tampered envelope invalid at the challenge check, and says so", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, userVerified: true });
    const signed = (await signedBy(authenticator)) as CanonicalSubmission;
    const tampered: CanonicalSubmission = { ...signed, submission: { ...signed.submission, values: { ...signed.submission.values, name: "Eve" } } };
    const report = await inspectEnvelopeSignatures(tampered, depsFor(authenticator));
    expect(report.summary).toEqual({ count: 1, status: "invalid", scope: "envelope" });
    expect(report.signatures[0]).toMatchObject({ status: "invalid", checks: { challenge: false } });
    expect(report.signatures[0]?.reason).toMatch(/challenge/i);
  });

  it("marks a signature from a credential not registered here unverifiable, checks included, and the demo provider unverifiable with its reason", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, userVerified: true });
    const unknown = await inspectEnvelopeSignatures(await signedBy(authenticator), depsFor(undefined));
    expect(unknown.summary.status).toBe("unverifiable");
    expect(unknown.signatures[0]).toMatchObject({ status: "unverifiable", credential: { registered: false }, checks: { signature: true } });
    expect(unknown.signatures[0]?.reason).toMatch(/not registered/);

    const demo: CanonicalSubmission = { ...ENVELOPE, signatures: [{ signature: "demo", algorithm: "demo-none", signedAt: 1_757_900_000_000, participantId: "submitter", format: DEFAULT_SUBMISSION_SIGNING_FORMAT }] };
    const report = await inspectEnvelopeSignatures(demo, depsFor(undefined));
    expect(report.signatures[0]).toMatchObject({ provider: "demo", status: "unverifiable", reason: "demo provider, no cryptographic signature", signedAt: "2025-09-15T01:33:20.000Z" });
    expect(report.summary).toEqual({ count: 1, status: "unverifiable", scope: "envelope" });

    const other: CanonicalSubmission = { ...ENVELOPE, signatures: [{ signature: "x", algorithm: "hmac-sha256", signedAt: 0, participantId: "s", format: DEFAULT_SUBMISSION_SIGNING_FORMAT }] };
    expect((await inspectEnvelopeSignatures(other, depsFor(undefined))).signatures[0]).toMatchObject({ provider: "unknown", status: "unverifiable", reason: 'algorithm "hmac-sha256" has no verifier here' });
  });

  it("rebuilds each signature under its own scope and statement", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, userVerified: true });
    const provider = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [{ id: authenticator.id, algorithm: authenticator.algorithm, publicKey: authenticator.publicKey }], credentialsContainer: authenticator.container() });
    const whole = normalizeSigningFormat({});
    const [plain] = await provider.sign({ canonical: signedCanonicalOf(ENVELOPE, "envelope"), participants: [], modeId: "m", format: whole });
    const statement = "I confirm these answers.";
    const format = normalizeSigningFormat({ scope: "values" });
    const [worded] = await provider.sign({ canonical: signedCanonicalOf(ENVELOPE, "values", statement), participants: [], modeId: "m", format, statement });
    const report = await inspectEnvelopeSignatures({ ...ENVELOPE, signatures: [plain!, worded!] }, depsFor(authenticator));
    expect(report.signatures.map((entry) => entry.status)).toEqual(["valid", "valid"]);
    expect(report.signatures[1]).toMatchObject({ statement, format: { scope: "values", canonicalization: "jcs" } });
    expect(report.signatures[0]?.statement).toBeUndefined();
    // The digest is over what the first signature covers.
    expect(report.scopedDigest).toBe([...sha256(new TextEncoder().encode(signedCanonicalOf(ENVELOPE, "envelope")))].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
    // A changed statement is invalid at the challenge.
    const reworded = await inspectEnvelopeSignatures({ ...ENVELOPE, signatures: [{ ...worded!, statement: "Something else." }] }, depsFor(authenticator));
    expect(reworded.signatures[0]).toMatchObject({ status: "invalid", checks: { challenge: false } });
  });

  it("calls a signature invalid whose format names another key order or none at all, whatever its provider", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, userVerified: true });
    const provider = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [{ id: authenticator.id, algorithm: authenticator.algorithm, publicKey: authenticator.publicKey }], credentialsContainer: authenticator.container() });
    // A key order sorted by localeCompare, signed over that text: the passkey's own checks hold, the format does not.
    const sorted = JSON.stringify(Object.fromEntries(Object.entries({ ...ENVELOPE }).sort(([a], [b]) => a.localeCompare(b))));
    const [signed] = await provider.sign({ canonical: sorted, participants: [], modeId: "m", format: normalizeSigningFormat({}) });
    const stableV1 = { ...signed!, format: { scope: "envelope", placement: "embedded", digest: "sha-256", canonicalization: "stable-v1" } } as never;
    const { format: _dropped, ...unformatted } = signed!;
    const named = await inspectEnvelopeSignatures({ ...ENVELOPE, signatures: [stableV1] }, depsFor(authenticator));
    expect(named.summary.status).toBe("invalid");
    expect(named.signatures[0]).toMatchObject({ provider: "webauthn", status: "invalid", reason: expect.stringMatching(/"jcs"/) });
    expect(named.signatures[0]?.format).toBeUndefined();
    const none = await inspectEnvelopeSignatures({ ...ENVELOPE, signatures: [unformatted] }, depsFor(authenticator));
    expect(none.signatures[0]).toMatchObject({ status: "invalid", reason: expect.stringMatching(/"jcs"/) });
    // A format with no canonicalization is no format either.
    const { canonicalization: _jcs, ...bare } = DEFAULT_SUBMISSION_SIGNING_FORMAT;
    const unnamed = await inspectEnvelopeSignatures({ ...ENVELOPE, signatures: [{ ...signed!, format: bare as never }] }, depsFor(authenticator));
    expect(unnamed.signatures[0]?.status).toBe("invalid");
    // The demo stand-in with no format is invalid too, not merely unverifiable.
    const demo = await inspectEnvelopeSignatures({ ...ENVELOPE, signatures: [{ signature: "demo", algorithm: "demo-none", signedAt: 0, participantId: "submitter" }] }, depsFor(undefined));
    expect(demo.signatures[0]).toMatchObject({ provider: "demo", status: "invalid" });
    // A wrapper's own format stands for a signature that carries none; one without "jcs" does not.
    const wrapper: SignedSubmissionDocument = { format: normalizeSigningFormat({ placement: "wrapper" }), payload: ENVELOPE, signatures: [] };
    const [wrapped] = await provider.sign({ canonical: signedCanonicalOf(wrapper), participants: [], modeId: "m", format: wrapper.format });
    const { format: _own, ...bareWrapped } = wrapped!;
    expect((await inspectEnvelopeSignatures({ ...wrapper, signatures: [bareWrapped] }, depsFor(authenticator))).summary.status).toBe("valid");
    expect((await inspectEnvelopeSignatures({ ...wrapper, format: { ...wrapper.format, canonicalization: "stable-v1" } as never, signatures: [bareWrapped] }, depsFor(authenticator))).summary.status).toBe("invalid");
  });

  it("summarises a set: invalid beats unverifiable beats valid", () => {
    expect(summarize([])).toEqual({ count: 0, status: "none" });
    expect(summarize(["valid", "valid"])).toEqual({ count: 2, status: "valid" });
    expect(summarize(["valid", "unverifiable"])).toEqual({ count: 2, status: "unverifiable" });
    expect(summarize(["unverifiable", "invalid", "valid"])).toEqual({ count: 3, status: "invalid" });
  });
});
