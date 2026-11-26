import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import {
  WebAuthnError,
  createWebAuthnSigningProvider,
  describeWebAuthnError,
  verifyRegistration,
  verifyWebAuthnSubmission,
  type CanonicalSubmission,
  type DatumFormElement,
  type DatumFormSubmitDetail
} from "../src/form.js";
import { normalizeSigningFormat, signedCanonicalOf } from "@argusvane/datum-engine";
import { createSoftwareAuthenticator } from "./fixtures/webauthn-fixture.js";
import { sampleDefinition, until } from "./helpers.js";

/*
 * WebAuthn is a lazy chunk: form.ts keeps the names, as light wrappers, and the
 * code behind them is fetched on the first signature or verification, once. The chunk's module
 * is a counting stand-in around the real one, so each import of it is seen. Tests run in
 * order on purpose: the page's one load is shared across the file, so "never requested" is
 * asserted before the first thing that signs.
 */
const chunk = vi.hoisted(() => ({ imports: 0 }));
vi.mock("../src/webauthn.js", async (importActual) => {
  chunk.imports += 1;
  return importActual();
});

afterEach(() => {
  document.body.innerHTML = "";
});

const RP = "localhost";
const ORIGIN = "http://localhost:5173";

function passkeyDefinition() {
  const definition = sampleDefinition();
  definition.root.children = {
    content: [
      ...(definition.root.children?.content ?? []),
      { id: "sign", type: "button", configuration: { label: "Submit with passkey", action: "submit", signature: "webauthn" } }
    ]
  };
  return definition;
}

const envelope: CanonicalSubmission = {
  versionContext: { form: { id: "intake", version: "3" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
  submission: { locale: "en", values: { fullName: "Ada Lovelace" } }
};

describe("the WebAuthn chunk", () => {
  it("is never requested by importing form.ts or connecting an element with no signing configured", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    element.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
    element.definition = passkeyDefinition();
    element.values = { fullName: "Ada Lovelace" };
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("form"));
    // A plain submit signs nothing: the chunk is still not fetched.
    const submits: DatumFormSubmitDetail[] = [];
    element.addEventListener("datum-submit", (event) => submits.push((event as CustomEvent<DatumFormSubmitDetail>).detail));
    element.renderer!.shadowRoot!.querySelector<HTMLElement>('[data-button-action="submit"]:not([data-button-signature])')!.click();
    await until(() => submits.length === 1);
    expect(submits[0]!.submission?.signatures).toBeUndefined();
    expect(chunk.imports).toBe(0);
  });

  it("keeps the small names in the bundle: they work without the chunk", () => {
    const error = new WebAuthnError("cancelled", "Dismissed.");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("cancelled");
    expect(describeWebAuthnError(error)).toContain("Try again right after clicking");
    expect(typeof verifyRegistration).toBe("function");
    expect(chunk.imports).toBe(0);
  });

  it("is not fetched when a provider is created; <datum-form> preloads it when signing is allowed and a provider is assigned", async () => {
    expect(chunk.imports).toBe(0);
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const provider = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [authenticator.record()], credentialsContainer: authenticator.container() });
    expect(provider.id).toBe("webauthn");
    expect(createWebAuthnSigningProvider({ id: "site-passkey", rpId: RP, discoverable: true }).id).toBe("site-passkey");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(chunk.imports).toBe(0);

    // A host that leaves signing out of the features list still builds a provider: the chunk is never fetched.
    const excluded = document.createElement("datum-form") as DatumFormElement;
    excluded.setAttribute("features", "print");
    excluded.definition = passkeyDefinition();
    excluded.signingProviders = [provider];
    excluded.signingProvider = provider;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    document.body.append(excluded);
    await until(() => excluded.renderer?.shadowRoot?.querySelector("form"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(chunk.imports).toBe(0);
    excluded.remove();

    // Signing allowed and a provider assigned: fetched at connect, once, before any click.
    const allowed = document.createElement("datum-form") as DatumFormElement;
    allowed.definition = passkeyDefinition();
    allowed.signingProviders = [provider];
    document.body.append(allowed);
    await until(() => chunk.imports === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunk.imports).toBe(1);
  });

  it("keeps the id of a class-instance provider whose id is a prototype getter, for signWith", async () => {
    class PrototypeProvider {
      public get id(): string {
        return "proto-signer";
      }
      public calls = 0;
      public async sign(): Promise<never[]> {
        this.calls += 1;
        return [];
      }
    }
    const element = document.createElement("datum-form") as DatumFormElement;
    element.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
    element.definition = passkeyDefinition();
    element.values = { fullName: "Ada Lovelace" };
    const proto = new PrototypeProvider();
    element.signingProviders = [proto as never];
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("form"));
    await element.submit({ signWith: "proto-signer" });
    expect(proto.calls).toBe(1);
  });

  it("loads on the first signature, once, and signs and verifies as the engine's provider does", async () => {
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const signed: string[] = [];
    const provider = createWebAuthnSigningProvider({
      rpId: RP,
      credentials: () => [authenticator.record()],
      userVerification: "required",
      credentialsContainer: authenticator.container(),
      now: () => new Date("2026-09-15T10:00:00Z"),
      onSigned: (assertion) => signed.push(assertion.credentialId)
    });
    const element = document.createElement("datum-form") as DatumFormElement;
    element.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
    element.definition = passkeyDefinition();
    element.values = { fullName: "Ada Lovelace" };
    element.signingProviders = [provider];
    element.setAttribute("signing-scope", "values");
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("form"));
    // Already fetched when the provider was made; the click only signs.
    expect(chunk.imports).toBe(1);

    // Signing through the element: the button's `signature` names the provider by id.
    const detail = await element.submit({ signWith: "webauthn" });
    expect(detail.accepted).toBe(true);
    const signature = detail.submission?.signatures?.[0];
    expect(signature).toMatchObject({ participantId: "submitter", algorithm: "webauthn-es256", signedAt: new Date("2026-09-15T10:00:00Z").getTime() });
    expect(chunk.imports).toBe(1);

    // A second signature, and a direct call, reuse the one load.
    const results = await provider.sign({ canonical: signedCanonicalOf(envelope, "values"), participants: [{ id: "applicant", role: "primary" }], modeId: "m", format: normalizeSigningFormat({ scope: "values" }) });
    expect(results[0]).toMatchObject({ participantId: "applicant", algorithm: "webauthn-es256" });
    expect(signed).toEqual([authenticator.id, authenticator.id]);

    // The verifier is a wrapper too, and agrees with what signed.
    const verdicts = await verifyWebAuthnSubmission({ ...envelope, signatures: results }, { expectedOrigins: [ORIGIN], rpId: RP, requireUserVerification: true });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ valid: true, participantId: "applicant", credentialId: authenticator.id });
    expect(chunk.imports).toBe(1);
  });

  it("refuses to sign with no credential, with the engine's error and its instance", async () => {
    const provider = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [] });
    const failure = await provider.sign({ canonical: "{}", participants: [], modeId: "m", format: normalizeSigningFormat({}) }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WebAuthnError);
    expect(failure).toMatchObject({ code: "no_credentials" });
  });
});
