import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../form-engine/core/crypto/sha256.js";
import { base64ToBytes } from "../form-engine/core/schema/file-upload.js";
import { signedCanonicalForSignature, signedCanonicalOf, type CanonicalSubmission } from "../form-engine/core/submission/canonical-submission.js";
import { canonicalizeJcs } from "../form-engine/core/submission/jcs.js";
import { DEFAULT_SUBMISSION_SIGNING_FORMAT, normalizeSigningFormat, readSigningFormat, type SignatureResult, type SignedSubmissionDocument } from "../form-engine/core/submission/signing.js";
import { COSE_ALGORITHM, base64UrlToBytes, bytesToBase64Url, parseClientData } from "../form-engine/core/submission/webauthn-assertion.js";
import { ecdsaDerToP1363, requestAssertion, verifyAssertion } from "../form-engine/render/webauthn/assertion.js";
import { parseAuthenticatorData } from "../form-engine/render/webauthn/authenticator-data.js";
import { WebAuthnError, describeWebAuthnError, toWebAuthnError } from "../form-engine/render/webauthn/errors.js";
import { registerCredential, verifyRegistration } from "../form-engine/render/webauthn/registration.js";
import { signalAllAcceptedCredentials, signalApiAvailable, signalUnknownCredential } from "../form-engine/render/webauthn/signal.js";
import { createWebAuthnSigningProvider, verifyWebAuthnSubmission, webAuthnAlgorithmName } from "../form-engine/render/webauthn/signing-provider.js";
import { createSoftwareAuthenticator, installWebAuthnGlobals, p1363ToDer } from "./webauthn-fixture.js";

const RP = "localhost";
const ORIGIN = "http://localhost:5173";

describe("SHA-256 and base64url", () => {
  it("hashes like the standard says and round-trips base64url", () => {
    expect([...sha256(new TextEncoder().encode("abc"))].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const bytes = new Uint8Array([251, 255, 191, 0, 1]);
    const text = bytesToBase64Url(bytes);
    expect(text).toBe("-_-_AAE");
    expect(text).not.toMatch(/[+/=]/);
    expect([...base64UrlToBytes(text)]).toEqual([...bytes]);
    expect([...base64ToBytes("+/+/AAE=")]).toEqual([...bytes]);
  });

  it("converts DER ECDSA signatures to r‖s and back", () => {
    const raw = new Uint8Array(64);
    raw.fill(0x7f, 0, 32);
    raw.fill(0x81, 32, 64);
    const der = p1363ToDer(raw);
    expect(der[0]).toBe(0x30);
    expect([...ecdsaDerToP1363(der)]).toEqual([...raw]);
    expect(() => ecdsaDerToP1363(new Uint8Array([1, 2, 3]))).toThrow(/DER/);
  });
});

describe("authenticator data", () => {
  it("reads the rpId hash, the flags and the counter", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, userVerified: true, backupEligible: true, signCount: 41 });
    const parsed = parseAuthenticatorData(authenticator.authenticatorData());
    expect([...parsed.rpIdHash]).toEqual([...sha256(new TextEncoder().encode(RP))]);
    expect(parsed.flags).toEqual({ userPresent: true, userVerified: true, backupEligible: true, backedUp: false, attestedCredentialData: false, extensionData: false });
    expect(parsed.signCount).toBe(41);
    expect(() => parseAuthenticatorData(new Uint8Array(10))).toThrow(/37/);
  });
});

describe("verifyAssertion", () => {
  it("accepts an ES256 and an RS256 assertion over the expected challenge", async () => {
    for (const algorithm of ["ES256", "RS256"] as const) {
      const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, algorithm });
      const challenge = sha256(new TextEncoder().encode("the document"));
      const assertion = await authenticator.assert(challenge);
      const verdict = await verifyAssertion(assertion, { expectedChallenge: challenge, expectedOrigins: [ORIGIN], rpId: RP, requireUserVerification: true });
      expect(verdict.valid).toBe(true);
      expect(verdict.checks).toEqual({ type: true, challenge: true, origin: true, rpId: true, userPresent: true, userVerified: true, signature: true });
      expect(verdict.signCount).toBe(1);
      expect(verdict.reason).toBeUndefined();
      expect(assertion.algorithm).toBe(algorithm === "ES256" ? COSE_ALGORITHM.ES256 : COSE_ALGORITHM.RS256);
      expect(webAuthnAlgorithmName(assertion.algorithm)).toBe(algorithm === "ES256" ? "webauthn-es256" : "webauthn-rs256");
    }
  });

  it("names the check that failed: challenge, origin, rpId, type, presence, verification, signature", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const challenge = sha256(new TextEncoder().encode("the document"));
    const base = { expectedChallenge: challenge, expectedOrigins: [ORIGIN], rpId: RP };
    const good = await authenticator.assert(challenge);

    const other = await verifyAssertion(good, { ...base, expectedChallenge: sha256(new TextEncoder().encode("another document")) });
    expect(other.valid).toBe(false);
    expect(other.checks.challenge).toBe(false);
    expect(other.reason).toMatch(/challenge/);

    const origin = await verifyAssertion(await authenticator.assert(challenge, { origin: "https://evil.example" }), base);
    expect(origin.checks.origin).toBe(false);

    const rp = await verifyAssertion(good, { ...base, rpId: "example.com" });
    expect(rp.checks.rpId).toBe(false);

    const type = await verifyAssertion(await authenticator.assert(challenge, { type: "webauthn.create" }), base);
    expect(type.checks.type).toBe(false);

    const absent = await verifyAssertion(await authenticator.assert(challenge, { userPresent: false }), base);
    expect(absent.checks.userPresent).toBe(false);

    const unverified = await authenticator.assert(challenge, { userVerified: false });
    expect((await verifyAssertion(unverified, { ...base, requireUserVerification: true })).checks.userVerified).toBe(false);
    expect((await verifyAssertion(unverified, base)).valid).toBe(true);

    const forged = await verifyAssertion(await authenticator.assert(challenge, { wrongKey: true }), base);
    expect(forged.checks.signature).toBe(false);
    expect(forged.reason).toMatch(/does not verify/);

    // A registered key given by the verifier wins over the archived one.
    const { publicKey: _archived, ...bare } = good;
    await expect(verifyAssertion(bare, base)).rejects.toMatchObject({ code: "no_credentials" });
    expect((await verifyAssertion(bare, { ...base, publicKey: authenticator.publicKey })).valid).toBe(true);
  });
});

describe("the ceremonies through a credentials container", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("registers: the record carries the SPKI key, the algorithm, the transports and the flags", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, transports: ["usb", "nfc"], backupEligible: true });
    const installed = installWebAuthnGlobals(authenticator.container());
    restore = installed.restore;
    const result = await registerCredential({ rpId: RP, rpName: "Datum", user: { id: new TextEncoder().encode("ada"), name: "ada@example", displayName: "Ada" }, name: "Ada's key", userVerification: "required", now: () => new Date("2026-09-15T10:00:00Z") });
    const { response, userHandle, ...record } = result;
    expect(userHandle).toBe("YWRh");
    expect(response.transports).toEqual(["usb", "nfc"]);
    expect(parseClientData(response.clientDataJSON).type).toBe("webauthn.create");
    expect(record).toEqual({
      id: authenticator.id,
      name: "Ada's key",
      publicKey: authenticator.publicKey,
      algorithm: COSE_ALGORITHM.ES256,
      transports: ["usb", "nfc"],
      attachment: "cross-platform",
      signCount: 0,
      flags: { userVerified: true, backupEligible: true, backedUp: false },
      createdAt: "2026-09-15T10:00:00.000Z"
    });
    const request = authenticator.calls.create[0]!;
    expect(request.rp).toEqual({ id: RP, name: "Datum" });
    expect(request.authenticatorSelection?.userVerification).toBe("required");
    expect(request.attestation).toBe("none");
    expect(request.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257]);
  });

  it("asserts: the archived bundle verifies, and the allow list reaches the platform", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    restore = installWebAuthnGlobals(authenticator.container()).restore;
    const challenge = sha256(new TextEncoder().encode("doc"));
    const assertion = await requestAssertion({ challenge, rpId: RP, allowCredentials: [authenticator.record()], userVerification: "required", now: () => new Date("2026-09-15T10:00:00Z") });
    expect(assertion.credentialId).toBe(authenticator.id);
    expect(assertion.publicKey).toBe(authenticator.publicKey);
    expect(assertion.origin).toBe(ORIGIN);
    expect(assertion.signedAt).toBe("2026-09-15T10:00:00.000Z");
    expect(parseClientData(assertion.clientDataJSON).challenge).toBe(bytesToBase64Url(challenge));
    expect((await verifyAssertion(assertion, { expectedChallenge: challenge, expectedOrigins: [ORIGIN], rpId: RP })).valid).toBe(true);
    const request = authenticator.calls.get[0]!;
    expect(request.userVerification).toBe("required");
    expect(request.allowCredentials?.map((entry) => bytesToBase64Url(new Uint8Array(entry.id as ArrayBuffer)))).toEqual([authenticator.id]);
  });

  it("words what the platform refused, and says so when there is no WebAuthn at all", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const cancelled = Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
    restore = installWebAuthnGlobals(authenticator.container({ getError: cancelled })).restore;
    await expect(requestAssertion({ challenge: new Uint8Array(32), rpId: RP })).rejects.toMatchObject({ name: "WebAuthnError", code: "cancelled" });
    expect(toWebAuthnError(Object.assign(new Error("x"), { name: "InvalidStateError" }), "registration").code).toBe("in_use");
    expect(toWebAuthnError(Object.assign(new Error("x"), { name: "SecurityError" }), "assertion").code).toBe("security");
    expect(toWebAuthnError(Object.assign(new Error("x"), { name: "NotSupportedError" }), "assertion").code).toBe("unsupported");
    expect(toWebAuthnError(Object.assign(new Error("x"), { name: "AbortError" }), "assertion").code).toBe("aborted");
    expect(toWebAuthnError(new Error("odd"), "assertion")).toMatchObject({ code: "protocol", message: "odd" });
    expect(describeWebAuthnError(new WebAuthnError("cancelled", "Dismissed."))).toContain("Try again right after clicking");
    expect(describeWebAuthnError(new WebAuthnError("in_use", "Held."))).toContain("delete the existing registration");
    restore();
    restore = undefined;
    await expect(requestAssertion({ challenge: new Uint8Array(32), rpId: RP })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("signals: the Signal API when present, 'unsupported' when not", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const installed = installWebAuthnGlobals(authenticator.container(), { signals: true });
    restore = installed.restore;
    expect(signalApiAvailable()).toBe(true);
    expect(await signalUnknownCredential({ rpId: RP, credentialId: authenticator.id })).toBe("signalled");
    expect(await signalAllAcceptedCredentials({ rpId: RP, userId: "YWRh", allAcceptedCredentialIds: [] })).toBe("signalled");
    expect(installed.signals.map((entry) => entry.method)).toEqual(["signalUnknownCredential", "signalAllAcceptedCredentials"]);
    restore();
    restore = installWebAuthnGlobals(authenticator.container()).restore;
    expect(signalApiAvailable()).toBe(false);
    expect(await signalUnknownCredential({ rpId: RP, credentialId: authenticator.id })).toBe("unsupported");
  });
});

describe("the WebAuthn signing provider and its verifier", () => {
  const envelope: CanonicalSubmission = {
    versionContext: { form: { id: "intake", version: "3" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
    submission: { locale: "en", values: { zeta: "z", alpha: { b: 2, a: 1 } } }
  };

  it("signedCanonicalOf sorts keys, strips signatures, and scopes to the envelope, the submission or the values", () => {
    const signed = { ...envelope, signatures: [{ signature: "x", algorithm: "y", signedAt: 1, participantId: "p" }] };
    expect(signedCanonicalOf(signed)).toBe(signedCanonicalOf(envelope));
    expect(signedCanonicalOf(envelope)).toBe('{"submission":{"locale":"en","values":{"alpha":{"a":1,"b":2},"zeta":"z"}},"versionContext":{"client":{"rendererVersion":"1","runtimeVersion":"1","schemaVersion":"1"},"form":{"id":"intake","version":"3"}}}');
    expect(signedCanonicalOf(envelope, "submission")).toBe('{"locale":"en","values":{"alpha":{"a":1,"b":2},"zeta":"z"}}');
    expect(signedCanonicalOf(envelope, "values")).toBe('{"alpha":{"a":1,"b":2},"zeta":"z"}');
    const wrapper: SignedSubmissionDocument = { format: normalizeSigningFormat({ placement: "wrapper" }), payload: envelope, signatures: [] };
    expect(signedCanonicalOf(wrapper, "values")).toBe(signedCanonicalOf(envelope, "values"));
    expect(normalizeSigningFormat({ scope: "bogus", placement: "wrapper" })).toEqual({ scope: "envelope", placement: "wrapper", digest: "sha-256", canonicalization: "jcs" });
    // A host cannot sign in another key order: the canonicalization is "jcs" whatever it asks.
    expect(normalizeSigningFormat({ canonicalization: "stable-v1" }).canonicalization).toBe("jcs");
    expect(normalizeSigningFormat({ canonicalization: "other" }).canonicalization).toBe("jcs");
  });

  it("signs the scoped canonical through the passkey and verifies from the delivered document, under each scope", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const uses: string[] = [];
    const provider = createWebAuthnSigningProvider({
      rpId: RP,
      credentials: () => [authenticator.record()],
      userVerification: "required",
      credentialsContainer: authenticator.container(),
      now: () => new Date("2026-09-15T10:00:00Z"),
      onSigned: (assertion) => uses.push(assertion.credentialId)
    });
    expect(provider.id).toBe("webauthn");
    for (const scope of ["envelope", "submission", "values"] as const) {
      const format = normalizeSigningFormat({ scope });
      const results = await provider.sign({ canonical: signedCanonicalOf(envelope, scope), participants: [{ id: "applicant", role: "primary" }], modeId: "m", format });
      expect(results).toHaveLength(1);
      const result = results[0]!;
      expect(result).toMatchObject({ participantId: "applicant", algorithm: "webauthn-es256", signedAt: new Date("2026-09-15T10:00:00Z").getTime(), format });
      expect(result.signature).toBe(result.webauthn?.signature);
      const delivered = { ...envelope, signatures: results };
      const verdicts = await verifyWebAuthnSubmission(delivered, { expectedOrigins: [ORIGIN], rpId: RP, requireUserVerification: true });
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]).toMatchObject({ valid: true, participantId: "applicant", credentialId: authenticator.id, algorithm: "webauthn-es256", format });
      // The wrapper placement verifies the same way.
      const wrapper: SignedSubmissionDocument = { format: { ...format, placement: "wrapper" }, payload: envelope, signatures: results };
      expect((await verifyWebAuthnSubmission(wrapper, { expectedOrigins: [ORIGIN], rpId: RP }))[0]?.valid).toBe(true);
      // A changed value breaks the challenge.
      const tampered = { ...envelope, submission: { ...envelope.submission, values: { ...envelope.submission.values, zeta: "changed" } }, signatures: results };
      const broken = await verifyWebAuthnSubmission(tampered, { expectedOrigins: [ORIGIN], rpId: RP });
      expect(broken[0]?.valid).toBe(false);
      expect(broken[0]?.checks.challenge).toBe(false);
    }
    expect(uses).toEqual([authenticator.id, authenticator.id, authenticator.id]);
    // The verifier's own key lookup wins; a key for another credential fails the signature.
    const results = await provider.sign({ canonical: signedCanonicalOf(envelope), participants: [], modeId: "m", format: normalizeSigningFormat({}) });
    const other = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const fromStore = await verifyWebAuthnSubmission({ ...envelope, signatures: results }, { expectedOrigins: [ORIGIN], rpId: RP, publicKeyFor: () => ({ publicKey: other.publicKey }) });
    expect(fromStore[0]?.checks.signature).toBe(false);
    expect(results[0]?.participantId).toBe("submitter");
    // Signatures from other providers are left out of the verdicts.
    expect(await verifyWebAuthnSubmission({ ...envelope, signatures: [{ signature: "demo", algorithm: "demo-none", signedAt: 0, participantId: "p" }] }, { expectedOrigins: [ORIGIN], rpId: RP })).toEqual([]);
  });

  it("refuses to sign with no registered credential", async () => {
    const provider = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [] });
    await expect(provider.sign({ canonical: "{}", participants: [], modeId: "m", format: normalizeSigningFormat({}) })).rejects.toMatchObject({ code: "no_credentials" });
  });
});

describe("the signed text in RFC 8785, and the signing statement", () => {
  // Keys where localeCompare and code-unit order disagree.
  const envelope: CanonicalSubmission = {
    versionContext: { form: { id: "intake", version: "3" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
    submission: { locale: "en", values: { text_1: "a", text1: "b", Text2: "c", "a-b": 1, a_b: 2, "10": 3, "2": 4 } }
  };

  it("writes JCS", () => {
    expect(signedCanonicalOf(envelope, "values")).toBe('{"10":3,"2":4,"Text2":"c","a-b":1,"a_b":2,"text1":"b","text_1":"a"}');
    expect(signedCanonicalOf(envelope, "values")).toBe(canonicalizeJcs(envelope.submission.values));
  });

  it("reads a delivered format strictly: a known scope and placement, sha-256 and jcs, or nothing", () => {
    expect(readSigningFormat(DEFAULT_SUBMISSION_SIGNING_FORMAT)).toEqual(DEFAULT_SUBMISSION_SIGNING_FORMAT);
    expect(readSigningFormat({ ...DEFAULT_SUBMISSION_SIGNING_FORMAT, canonicalization: "stable-v1" })).toBeUndefined();
    const { canonicalization: _jcs, ...unnamed } = DEFAULT_SUBMISSION_SIGNING_FORMAT;
    expect(readSigningFormat(unnamed)).toBeUndefined();
    expect(readSigningFormat({ ...DEFAULT_SUBMISSION_SIGNING_FORMAT, scope: "bogus" })).toBeUndefined();
    expect(readSigningFormat({ ...DEFAULT_SUBMISSION_SIGNING_FORMAT, placement: "beside" })).toBeUndefined();
    expect(readSigningFormat({ ...DEFAULT_SUBMISSION_SIGNING_FORMAT, digest: "md5" })).toBeUndefined();
    expect(readSigningFormat(undefined)).toBeUndefined();
    expect(readSigningFormat("jcs")).toBeUndefined();
  });

  it("folds a statement in as {document, statement}; an empty one is none", () => {
    const statement = "I confirm these answers are true.";
    const text = signedCanonicalOf(envelope, "submission", statement);
    expect(text).toBe(canonicalizeJcs({ document: envelope.submission, statement }));
    expect(text).toBe(`{"document":${signedCanonicalOf(envelope, "submission")},"statement":${JSON.stringify(statement)}}`);
    expect(signedCanonicalOf(envelope, "submission", "")).toBe(signedCanonicalOf(envelope, "submission"));
    const signature = { format: normalizeSigningFormat({ scope: "submission" }), statement };
    expect(signedCanonicalForSignature(envelope, signature)).toBe(text);
    // A signature without a format covers no text a verifier can rebuild.
    expect(signedCanonicalForSignature(envelope, {})).toBeUndefined();
  });

  it("verifies each signature under its own format: a JCS one and one with a statement", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const credentials = (): ReturnType<typeof authenticator.record>[] => [authenticator.record()];
    const provider = createWebAuthnSigningProvider({ rpId: RP, credentials, credentialsContainer: authenticator.container() });
    const options = { expectedOrigins: [ORIGIN], rpId: RP };

    const jcsFormat = normalizeSigningFormat({ scope: "values" });
    const [jcs] = await provider.sign({ canonical: signedCanonicalOf(envelope, "values"), participants: [], modeId: "m", format: jcsFormat });
    expect(jcs!.format?.canonicalization).toBe("jcs");
    expect(jcs!.statement).toBeUndefined();

    const statement = "I agree.";
    const [worded] = await provider.sign({ canonical: signedCanonicalOf(envelope, "envelope", statement), participants: [], modeId: "m", format: normalizeSigningFormat({}), statement });
    expect(worded!.statement).toBe(statement);

    const verdicts = await verifyWebAuthnSubmission({ ...envelope, signatures: [jcs!, worded!] }, options);
    expect(verdicts.map((verdict) => verdict.valid)).toEqual([true, true]);
    expect(verdicts[1]?.statement).toBe(statement);

    // A changed statement, or one dropped, no longer matches the challenge.
    const reworded = await verifyWebAuthnSubmission({ ...envelope, signatures: [{ ...worded!, statement: "I agree to nothing." }] }, options);
    expect(reworded[0]?.checks.challenge).toBe(false);
    const { statement: _gone, ...unworded } = worded!;
    expect((await verifyWebAuthnSubmission({ ...envelope, signatures: [unworded] }, options))[0]?.checks.challenge).toBe(false);
  });

  it("calls a signature invalid whose format names another key order, or no format at all, even when the passkey signed that very text", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const provider = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [authenticator.record()], credentialsContainer: authenticator.container() });
    const options = { expectedOrigins: [ORIGIN], rpId: RP };
    // The text a localeCompare key order gives, signed by a real passkey: its assertion holds on its own.
    const sortedText = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sortedText)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, sortedText(inner)]))
          : value;
    const { signatures: _none, ...unsigned } = envelope;
    const stableText = JSON.stringify(sortedText(unsigned));
    expect(stableText).not.toBe(signedCanonicalOf(envelope));
    const [signed] = await provider.sign({ canonical: stableText, participants: [], modeId: "m", format: normalizeSigningFormat({}) });
    const stableV1 = { ...signed!, format: { scope: "envelope", placement: "embedded", digest: "sha-256", canonicalization: "stable-v1" } } as unknown as SignatureResult;
    const { format: _dropped, ...unformatted } = signed!;
    const { canonicalization: _jcs, ...unnamed } = DEFAULT_SUBMISSION_SIGNING_FORMAT;
    const verdicts = await verifyWebAuthnSubmission({ ...envelope, signatures: [stableV1, unformatted, { ...signed!, format: unnamed as never }] }, options);
    expect(verdicts).toHaveLength(3);
    for (const verdict of verdicts) {
      expect(verdict.valid).toBe(false);
      expect(verdict.checks.challenge).toBe(false);
      expect(verdict.reason).toMatch(/"jcs"/);
      expect(verdict.format).toBeUndefined();
      // The passkey's own signature over the bytes it was given holds: the refusal is the format's.
      expect(verdict.checks.signature).toBe(true);
    }
    // The same signature stamped "jcs" fails the challenge: JCS is not the text the passkey signed.
    const relabelled = await verifyWebAuthnSubmission({ ...envelope, signatures: [signed!] }, options);
    expect(relabelled[0]).toMatchObject({ valid: false, checks: { challenge: false } });
  });
});

describe("a registration a server can verify", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("uses the server's challenge and user handle and returns the raw ceremony outputs", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, userVerified: true });
    const challenge = bytesToBase64Url(sha256(new TextEncoder().encode("server challenge")));
    const handle = bytesToBase64Url(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const result = await registerCredential({
      rpId: RP,
      rpName: "Datum",
      user: { id: handle, name: "Example site signer", displayName: "Example site signer" },
      name: "Signer",
      challenge,
      residentKey: "required",
      userVerification: "required",
      credentials: authenticator.container()
    });
    const request = authenticator.calls.create[0]!;
    expect(bytesToBase64Url(new Uint8Array(request.challenge as ArrayBuffer))).toBe(challenge);
    expect(bytesToBase64Url(new Uint8Array(request.user.id as ArrayBuffer))).toBe(handle);
    expect(request.authenticatorSelection?.residentKey).toBe("required");
    expect(result.userHandle).toBe(handle);
    expect(result.response.authenticatorData).not.toBe("");
    expect(result.response.attestationObject).not.toBe("");
    expect(parseClientData(result.response.clientDataJSON).challenge).toBe(challenge);

    const verdict = verifyRegistration(result, { expectedChallenge: challenge, expectedOrigins: [ORIGIN], rpId: RP, requireUserVerification: true });
    expect(verdict).toMatchObject({
      valid: true,
      checks: { type: true, challenge: true, origin: true, rpId: true, userPresent: true, userVerified: true, attestedCredential: true, credentialId: true }
    });
    expect(verdict.flags.attestedCredentialData).toBe(true);
    // Bytes work as the expected challenge too.
    expect(verifyRegistration(result, { expectedChallenge: base64UrlToBytes(challenge), expectedOrigins: [ORIGIN], rpId: RP }).valid).toBe(true);
  });

  it("names the check that failed", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN, userVerified: false });
    const challenge = bytesToBase64Url(sha256(new TextEncoder().encode("server challenge")));
    const result = await registerCredential({ rpId: RP, rpName: "Datum", user: { id: "AQID", name: "n", displayName: "n" }, name: "Signer", challenge, credentials: authenticator.container() });
    const base = { expectedChallenge: challenge, expectedOrigins: [ORIGIN], rpId: RP };
    expect(verifyRegistration(result, base).valid).toBe(true);
    const other = verifyRegistration(result, { ...base, expectedChallenge: bytesToBase64Url(new Uint8Array(32)) });
    expect(other.checks.challenge).toBe(false);
    expect(other.reason).toMatch(/challenge/);
    expect(verifyRegistration(result, { ...base, expectedOrigins: ["https://evil.example"] }).checks.origin).toBe(false);
    expect(verifyRegistration(result, { ...base, rpId: "example.com" }).checks.rpId).toBe(false);
    expect(verifyRegistration(result, { ...base, requireUserVerification: true }).checks.userVerified).toBe(false);
    expect(verifyRegistration({ ...result, id: bytesToBase64Url(new Uint8Array(16)) }, base).checks.credentialId).toBe(false);
    // An assertion's client data is not a registration.
    const asserted = await authenticator.assert(base64UrlToBytes(challenge));
    expect(verifyRegistration({ id: result.id, response: { ...result.response, clientDataJSON: asserted.clientDataJSON } }, base).checks.type).toBe(false);
    // Authenticator data without the AT flag (an assertion's) carries no credential.
    const plain = verifyRegistration({ id: result.id, response: { ...result.response, authenticatorData: asserted.authenticatorData } }, base);
    expect(plain.checks.attestedCredential).toBe(false);
    expect(plain.checks.credentialId).toBe(false);
    expect(() => verifyRegistration({ id: result.id, response: { ...result.response, authenticatorData: "" } }, base)).toThrow(WebAuthnError);
  });

  it("refuses a user handle or a challenge WebAuthn would not take", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const base = { rpId: RP, rpName: "Datum", name: "x", credentials: authenticator.container() };
    await expect(registerCredential({ ...base, user: { id: new Uint8Array(65), name: "n", displayName: "n" } })).rejects.toMatchObject({ code: "protocol" });
    await expect(registerCredential({ ...base, user: { id: "AQID", name: "n", displayName: "n" }, challenge: new Uint8Array(8) })).rejects.toMatchObject({ code: "protocol" });
    await expect(registerCredential({ ...base, user: { id: "not base64!", name: "n", displayName: "n" } })).rejects.toMatchObject({ code: "protocol" });
    expect(authenticator.calls.create).toHaveLength(0);
  });
});

describe("discoverable signing", () => {
  const envelope: CanonicalSubmission = {
    versionContext: { form: { id: "intake", version: "3" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
    submission: { locale: "en", values: { name: "Ada" } }
  };

  it("signs with an empty allow list when no credential is known, and the result names the credential and the user handle", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const handle = bytesToBase64Url(new Uint8Array([9, 9, 9]));
    await registerCredential({ rpId: RP, rpName: "Datum", user: { id: handle, name: "n", displayName: "n" }, name: "k", residentKey: "required", credentials: authenticator.container() });
    const provider = createWebAuthnSigningProvider({ rpId: RP, discoverable: true, credentialsContainer: authenticator.container() });
    const format = normalizeSigningFormat({});
    const [result] = await provider.sign({ canonical: signedCanonicalOf(envelope), participants: [], modeId: "m", format });
    expect(authenticator.calls.get[0]?.allowCredentials).toEqual([]);
    expect(result!.webauthn).toMatchObject({ credentialId: authenticator.id, userHandle: handle });
    // The page knew no key: the verifier uses the one it registered for that id.
    expect(result!.webauthn?.publicKey).toBeUndefined();
    const verdicts = await verifyWebAuthnSubmission({ ...envelope, signatures: [result!] }, { expectedOrigins: [ORIGIN], rpId: RP, publicKeyFor: (id) => (id === authenticator.id ? { publicKey: authenticator.publicKey, algorithm: authenticator.algorithm } : undefined) });
    expect(verdicts[0]?.valid).toBe(true);
    // An empty list from the credentials function is the same as none.
    const listed = createWebAuthnSigningProvider({ rpId: RP, discoverable: true, credentials: () => [], credentialsContainer: authenticator.container() });
    await listed.sign({ canonical: "{}", participants: [], modeId: "m", format });
    expect(authenticator.calls.get[1]?.allowCredentials).toEqual([]);
    // A known list still narrows the prompt.
    const narrowed = createWebAuthnSigningProvider({ rpId: RP, discoverable: true, credentials: () => [authenticator.record()], credentialsContainer: authenticator.container() });
    await narrowed.sign({ canonical: "{}", participants: [], modeId: "m", format });
    expect(authenticator.calls.get[2]?.allowCredentials).toHaveLength(1);
  });

  it("reports no passkey and a closed prompt alike, as cancelled", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const cancelled = Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
    const provider = createWebAuthnSigningProvider({ rpId: RP, discoverable: true, credentialsContainer: authenticator.container({ getError: cancelled }) });
    await expect(provider.sign({ canonical: "{}", participants: [], modeId: "m", format: normalizeSigningFormat({}) })).rejects.toMatchObject({ code: "cancelled" });
    // Without `discoverable`, no credentials is still refused before any prompt.
    await expect(createWebAuthnSigningProvider({ rpId: RP, credentialsContainer: authenticator.container() }).sign({ canonical: "{}", participants: [], modeId: "m", format: normalizeSigningFormat({}) })).rejects.toMatchObject({ code: "no_credentials" });
  });
});
