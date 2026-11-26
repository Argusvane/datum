import { describe, expect, it } from "vitest";

import type { FormDefinition, ComponentNode } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { ComponentRegistry } from "../../form-engine/registry/components/component-registry.js";
import type { ComponentDefinition } from "../../form-engine/core/schema/contracts.js";
import type { SigningProvider } from "../../form-engine/core/submission/signing.js";
import { serializeCanonicalSubmission } from "../../form-engine/core/submission/canonical-submission.js";
import { SubmissionHandlerRegistry } from "../../form-engine/registry/submission/submission-handler-registry.js";

// The runtime only reads `.version` off a resolved component definition.
const def = (type: string, version: string): ComponentDefinition =>
  ({ type, version }) as unknown as ComponentDefinition;

function form(): FormDefinition {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: {} },
        {
          id: "sig",
          type: "signature",
          configuration: {
            participants: [
              { id: "applicant", role: "primary" },
              { id: "witness", role: "witness" }
            ]
          }
        }
      ]
    }
  };
  return { id: "f1", version: "2", schemaVersion: "1", root, localization: { defaultLocale: "en" } };
}

const clientCtx = () => ({
  form: { id: "f1", version: "2" },
  client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" }
});

const stubSigner: SigningProvider = {
  id: "stub",
  sign: async (request) =>
    request.participants.map((participant) => ({
      signature: `sig(${participant.id}:${request.canonical.length})`,
      algorithm: "stub-256",
      signedAt: 0,
      participantId: participant.id
    }))
};

function baseRuntime(overrides = {}): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "plain", validate: true, sign: false, serverValidation: false });
  modes.register({ id: "signed", validate: true, sign: true, serverValidation: false });
  modes.register({ id: "server", validate: true, sign: false, serverValidation: true });
  return new FormRuntime(form(), {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([]),
    ...overrides
  });
}

describe("submission envelope + signing integration", () => {
  it("signs the canonical submission when the mode requests it", async () => {
    const runtime = baseRuntime({ signingProvider: stubSigner });
    runtime.setValue("name", "Ada");

    const result = await runtime.submit("signed", clientCtx());

    expect(result.accepted).toBe(true);
    expect(result.signatures?.map((s) => s.participantId)).toEqual(["applicant", "witness"]);
    expect(result.canonicalSubmission?.signatures).toHaveLength(2);
  });

  it("rejects a signing mode with no signing provider", async () => {
    const runtime = baseRuntime();
    const result = await runtime.submit("signed", clientCtx());
    expect(result.accepted).toBe(false);
    expect(result.errors[0]?.code).toBe("signing.providerMissing");
  });

  it("blocks acceptance when server manifests are missing for a server-validation mode", async () => {
    const runtime = baseRuntime();
    const events: string[] = [];
    runtime.events().subscribe("SUBMISSION_BLOCKED_ENVELOPE", () => events.push("blocked"));

    const result = await runtime.submit("server", clientCtx());

    expect(result.accepted).toBe(false);
    expect(result.errors.map((e) => e.parameters?.field)).toEqual(
      expect.arrayContaining(["server.runtimeVersion", "server.validatorVersion"])
    );
    expect(events).toEqual(["blocked"]);
  });

  it("accepts a server-validation mode once server manifests are provided", async () => {
    const runtime = baseRuntime();
    const result = await runtime.submit("server", {
      form: { id: "f1", version: "2" },
      client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" },
      server: { runtimeVersion: "1.0.0", validatorVersion: "1.0.0" }
    });
    expect(result.accepted).toBe(true);
  });

  it("auto-populates client.components from the component registry and enforces coverage", async () => {
    const registry = new ComponentRegistry();
    registry.register(def("form", "1.0.0"));
    registry.register(def("text", "2.1.0"));
    // note: no "signature" registered -> coverage gap

    const runtime = baseRuntime({ componentRegistry: registry });
    const blocked = await runtime.submit("plain", clientCtx());
    expect(blocked.accepted).toBe(false);
    expect(blocked.errors.map((e) => e.parameters?.field)).toContain("client.components.signature");

    registry.register(def("signature", "1.0.0"));
    const ok = await runtime.submit("plain", clientCtx());
    expect(ok.accepted).toBe(true);
    expect(ok.canonicalSubmission?.versionContext.client.components).toMatchObject({
      text: "2.1.0",
      signature: "1.0.0"
    });
  });
});

describe("signing by name and the signing format", () => {
  const passkey: SigningProvider = {
    id: "webauthn",
    sign: async (request) => [
      { signature: `passkey(${request.canonical})`, algorithm: "webauthn-es256", signedAt: 7, participantId: request.participants[0]?.id ?? "submitter" }
    ]
  };

  it("a plain mode signs when the call names a provider, and the request says which and what it covers", async () => {
    const seen: unknown[] = [];
    const spy: SigningProvider = { id: "webauthn", sign: async (request) => { seen.push(request); return passkey.sign(request); } };
    const runtime = baseRuntime({ signingProvider: stubSigner, signingProviders: [spy] });
    const result = await runtime.submit("plain", clientCtx(), { signWith: "webauthn", trigger: { componentId: "send" } });
    expect(result.accepted).toBe(true);
    expect(result.signatures?.map((s) => s.algorithm)).toEqual(["webauthn-es256"]);
    expect(result.signatures?.[0]?.format).toEqual({ scope: "envelope", placement: "embedded", digest: "sha-256", canonicalization: "jcs" });
    expect(result.canonicalSubmission?.signatures).toHaveLength(1);
    expect(result.signed).toBeUndefined();
    expect(seen[0]).toMatchObject({ modeId: "plain", signWith: "webauthn", trigger: { componentId: "send" }, format: { scope: "envelope", placement: "embedded" } });
    // The canonical the provider saw is the envelope without signatures, sorted.
    const { signatures: _s, ...unsigned } = result.canonicalSubmission!;
    expect((seen[0] as { canonical: string }).canonical).toBe(serializeCanonicalSubmission(unsigned));
    expect((seen[0] as { canonical: string }).canonical).not.toContain("signatures");
  });

  it("refuses an id no provider carries, and finds the default provider by its id too", async () => {
    const runtime = baseRuntime({ signingProvider: stubSigner });
    const unknown = await runtime.submit("plain", clientCtx(), { signWith: "webauthn" });
    expect(unknown.accepted).toBe(false);
    expect(unknown.errors[0]?.code).toBe("signing.providerMissing");
    const byId = await runtime.submit("plain", clientCtx(), { signWith: "stub" });
    expect(byId.accepted).toBe(true);
    expect(byId.signatures?.map((s) => s.algorithm)).toEqual(["stub-256", "stub-256"]);
  });

  it("stores a signing rejection and announces ERRORS_CHANGED, so the form shows it where a host's result panel did", async () => {
    const refusing: SigningProvider = {
      id: "refusing",
      sign: async () => {
        throw Object.assign(new Error("No passkey or security key is registered to sign with."), { code: "NotAllowedError" });
      }
    };
    const runtime = baseRuntime({ signingProviders: [refusing] });
    const announced: number[] = [];
    runtime.events().subscribe("ERRORS_CHANGED", (event) => {
      announced.push((event.data as { errorCount: number }).errorCount);
    });

    const failed = await runtime.submit("plain", clientCtx(), { signWith: "refusing" });
    expect(failed.accepted).toBe(false);
    // What submit() returned is what the renderer's pull model now reads, announced once.
    expect(runtime.errors()).toEqual(failed.errors);
    expect(runtime.errors()[0]).toMatchObject({
      code: "signing.failed",
      stage: "signing",
      message: "The submission could not be signed: No passkey or security key is registered to sign with.",
      parameters: { providerId: "refusing", errorCode: "NotAllowedError" }
    });
    expect(announced.at(-1)).toBe(1);

    // A provider nobody registered is stored the same way, worded for the summary.
    const missing = await runtime.submit("plain", clientCtx(), { signWith: "webauthn" });
    expect(missing.accepted).toBe(false);
    expect(runtime.errors()).toEqual(missing.errors);
    expect(runtime.errors()[0]?.message).toBe('The submission could not be signed: no signing provider "webauthn" is registered.');

    // The next validation is the pipeline's verdict again: the signing error is gone.
    await runtime.validate();
    expect(runtime.errors()).toEqual([]);
  });

  it("a signing mode forces the default provider — the host's way to make every submit sign with a passkey", async () => {
    const runtime = baseRuntime({ signingProvider: passkey, signingProviders: [stubSigner] });
    const result = await runtime.submit("signed", clientCtx());
    expect(result.accepted).toBe(true);
    expect(result.signatures?.map((s) => s.algorithm)).toEqual(["webauthn-es256"]);
    // A button naming another provider still wins for its own submit.
    const other = await runtime.submit("signed", clientCtx(), { signWith: "stub" });
    expect(other.signatures?.map((s) => s.algorithm)).toEqual(["stub-256", "stub-256"]);
  });

  it("scopes the signed bytes and places the signatures as the format says, per runtime and per call", async () => {
    const seen: string[] = [];
    const spy: SigningProvider = { id: "webauthn", sign: async (request) => { seen.push(request.canonical); return passkey.sign(request); } };
    const runtime = baseRuntime({ signingProvider: spy, signing: { scope: "values", placement: "wrapper" } });
    const wrapped = await runtime.submit("signed", clientCtx());
    expect(wrapped.accepted).toBe(true);
    expect(wrapped.canonicalSubmission?.signatures).toBeUndefined();
    expect(wrapped.signed).toMatchObject({ format: { scope: "values", placement: "wrapper", digest: "sha-256" }, payload: { submission: { locale: "en" } } });
    expect(wrapped.signed?.signatures[0]?.format).toEqual({ scope: "values", placement: "wrapper", digest: "sha-256", canonicalization: "jcs" });
    expect(seen[0]).toBe(JSON.stringify(wrapped.canonicalSubmission!.submission.values));
    // Per call: the submission block, embedded.
    const embedded = await runtime.submit("signed", clientCtx(), { signing: { scope: "submission", placement: "embedded" } });
    expect(embedded.signed).toBeUndefined();
    expect(embedded.canonicalSubmission?.signatures?.[0]?.format).toEqual({ scope: "submission", placement: "embedded", digest: "sha-256", canonicalization: "jcs" });
    expect(seen[1]).toBe(JSON.stringify({ locale: "en", values: embedded.canonicalSubmission!.submission.values }));
    // Submission handlers see the wrapper document beside the envelope.
    const contexts: unknown[] = [];
    const handlers = new SubmissionHandlerRegistry();
    handlers.register({ id: "h", version: "1.0.0", handle: (_submission, context) => { contexts.push(context); } });
    const withHandler = baseRuntime({ signingProvider: spy, signing: { placement: "wrapper" }, submissionHandlerRegistry: handlers });
    await withHandler.submit("signed", clientCtx());
    expect(contexts[0]).toMatchObject({ modeId: "signed", formId: "f1", signed: { format: { placement: "wrapper" } } });
  });
  it("a host's signWith makes every submit sign with that provider; a call's own still wins; a missing one refuses", async () => {
    const runtime = baseRuntime({ signingProviders: [passkey, stubSigner], signWith: "webauthn" });
    const forced = await runtime.submit("plain", clientCtx());
    expect(forced.accepted).toBe(true);
    expect(forced.signatures?.map((s) => s.algorithm)).toEqual(["webauthn-es256"]);
    const named = await runtime.submit("plain", clientCtx(), { signWith: "stub" });
    expect(named.signatures?.map((s) => s.algorithm)).toEqual(["stub-256", "stub-256"]);
    const missing = baseRuntime({ signingProviders: [stubSigner], signWith: "webauthn" });
    const refused = await missing.submit("plain", clientCtx());
    expect(refused.accepted).toBe(false);
    expect(refused.errors.map((error) => error.code)).toEqual(["signing.providerMissing"]);
    expect(refused.canonicalSubmission).toBeUndefined();
    // An empty signWith requires nothing.
    expect((await baseRuntime({ signWith: "" }).submit("plain", clientCtx())).signatures).toBeUndefined();
  });

  it("signs the statement with the document and records it on each signature", async () => {
    const seen: Array<{ canonical: string; statement?: string }> = [];
    const spy: SigningProvider = { id: "webauthn", sign: async (request) => { seen.push(request); return passkey.sign(request); } };
    const statement = "I confirm these answers are true.";
    const runtime = baseRuntime({ signingProvider: spy, signing: { scope: "values", statement } });
    runtime.setValue("name", "Ada");
    const result = await runtime.submit("signed", clientCtx());
    expect(result.accepted).toBe(true);
    expect(seen[0]?.statement).toBe(statement);
    expect(seen[0]?.canonical).toBe(`{"document":{"name":"Ada"},"statement":${JSON.stringify(statement)}}`);
    expect(result.signatures?.[0]?.statement).toBe(statement);
    expect(result.signatures?.[0]?.format).toEqual({ scope: "values", placement: "embedded", digest: "sha-256", canonicalization: "jcs" });
    // A call's statement replaces the host's; an empty one clears it.
    await runtime.submit("signed", clientCtx(), { signing: { statement: "Other words." } });
    expect(seen[1]?.canonical).toContain('"statement":"Other words."');
    const bare = await runtime.submit("signed", clientCtx(), { signing: { statement: "" } });
    expect(seen[2]?.canonical).toBe('{"name":"Ada"}');
    expect(seen[2]?.statement).toBeUndefined();
    expect(bare.signatures?.[0]?.statement).toBeUndefined();
  });
});
