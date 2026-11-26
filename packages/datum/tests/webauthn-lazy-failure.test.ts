import { afterEach, describe, expect, it, vi } from "vitest";

import { WebAuthnError, createWebAuthnSigningProvider, type DatumFormElement } from "../src/form.js";
import "../src/form.js";
import { ChunkLoadError } from "../src/chunk-load-error.js";
import { normalizeSigningFormat } from "@argusvane/datum-engine";
import type { DatumErrorDetail } from "../src/form.js";
import { createSoftwareAuthenticator } from "./fixtures/webauthn-fixture.js";
import { sampleDefinition, until } from "./helpers.js";

/*
 * A WebAuthn chunk that fails to load rejects that signature
 * with a ChunkLoadError naming what was wanted, tells the page as `datum-error` when it was
 * <datum-form> that asked, is forgotten, and is asked for again by the next signature: a chunk
 * that 404ed for a moment does not leave the page unable to sign until it reloads.
 */
const chunk = vi.hoisted(() => ({ imports: 0, failures: 3 }));
vi.mock("../src/webauthn.js", async (importActual) => {
  chunk.imports += 1;
  if (chunk.failures > 0) {
    chunk.failures -= 1;
    throw new Error("chunk 404");
  }
  return importActual();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const RP = "localhost";

describe("a WebAuthn chunk that fails to load", () => {
  it("fails the signature closed and reports it, tries again on the next one, and signs once the chunk arrives", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const authenticator = await createSoftwareAuthenticator({ rpId: RP, origin: "http://localhost:5173" });
    const provider = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [authenticator.record()], credentialsContainer: authenticator.container() });
    // Creating the provider fetches nothing; <datum-form> below preloads it, and that load fails, is swallowed, and is forgotten.
    expect(chunk.imports).toBe(0);
    const request = { canonical: "{}", participants: [], modeId: "m", format: normalizeSigningFormat({}) };

    // Through <datum-form>: never delivered unsigned, and the page hears why.
    const element = document.createElement("datum-form") as DatumFormElement;
    element.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
    element.definition = sampleDefinition();
    element.values = { fullName: "Ada Lovelace" };
    element.signingProviders = [provider];
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("form"));
    const errors: DatumErrorDetail[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<DatumErrorDetail>).detail));
    const refused = await element.submit({ signWith: "webauthn" });
    expect(refused.accepted).toBe(false);
    expect(refused.submission?.signatures).toBeUndefined();
    await until(() => errors.length > 0);
    expect(errors[0]!.message).toContain("The WebAuthn code");
    expect(errors[0]!.message).toContain("could not be loaded");
    expect(chunk.imports).toBe(2);

    // Called directly: a clear Error, with the browser's own as its cause; the load is asked for again.
    const failure = await provider.sign(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChunkLoadError);
    expect((failure as ChunkLoadError).cause).toBeInstanceOf(Error);
    expect(chunk.imports).toBe(3);

    const results = await provider.sign(request);
    expect(results[0]).toMatchObject({ algorithm: "webauthn-es256" });
    expect(chunk.imports).toBe(4);

    // Loaded: the next signature does not ask again, and the engine's errors are the bundle's class.
    const empty = createWebAuthnSigningProvider({ rpId: RP, credentials: () => [] });
    await expect(empty.sign(request)).rejects.toBeInstanceOf(WebAuthnError);
    expect(chunk.imports).toBe(4);
  });
});
