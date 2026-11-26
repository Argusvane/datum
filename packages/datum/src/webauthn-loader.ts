import type { SigningProvider, SigningRequest } from "@argusvane/datum-engine";

import { ChunkLoadError } from "./chunk-load-error.js";

/**
 * WebAuthn as a lazy chunk. The renderer bundle does not re-export the
 * engine's WebAuthn code (about 20 KB minified, and the same again in the builder's preview),
 * though `<datum-form>` itself only holds the provider objects a host passes in. The bundle
 * exports the same names as light wrappers from here, and the code arrives in a chunk of its own
 * (`webauthn.ts`) the first time one of them has real work to do:
 *
 * - `createWebAuthnSigningProvider(options)` stays synchronous and returns a provider at once,
 *   with the id the real one would have; its `sign` loads the chunk, builds the real provider
 *   once, and signs through it. A form that never signs never fetches the chunk, and nothing
 *   fetches it at connect.
 * - `verifyWebAuthnSubmission`, `requestAssertion`, `verifyAssertion` and `registerCredential`
 *   were async already and load the chunk before they run.
 * - The small, synchronous or error-shaped names stay in the bundle as they were
 *   (`WebAuthnError`, `describeWebAuthnError`, `verifyRegistration`, the Signal API helpers):
 *   `form.ts` exports them straight from the engine, since a class that `instanceof` names, or a
 *   function that returns a value rather than a promise, cannot sit behind a load. They share
 *   their modules with the chunk, so the chunk imports them from the bundle: one copy, not two.
 */
type WebAuthnModule = typeof import("./webauthn.js");
type Engine = typeof import("@argusvane/datum-engine");

/** One load of the chunk per page, shared by every provider and every call. */
let webauthnLoad: Promise<WebAuthnModule> | undefined;

/**
 * Loads the chunk, once. A failed load is forgotten so the next signature or verification asks
 * again (a chunk that 404ed for a moment); in the builder's module build the import goes through
 * the retrying loader (vite.config.ts), which asks the module map for a URL it has not failed on.
 */
export function loadWebAuthn(): Promise<WebAuthnModule> {
  if (!webauthnLoad) {
    // A missing or blocked chunk rejects as a ChunkLoadError, naming what was wanted (absent-code resilience).
    const load = import("./webauthn.js").catch((error: unknown): never => {
      throw new ChunkLoadError("The WebAuthn code (datum-form-webauthn-*.js, or the ./webauthn module)", error);
    });
    load.catch(() => {
      if (webauthnLoad === load) {
        webauthnLoad = undefined;
      }
    });
    webauthnLoad = load;
  }
  return webauthnLoad;
}

const WEBAUTHN_SIGNING_PROVIDER_ID = "webauthn";

/**
 * A signing provider over WebAuthn: the same options and the same provider as the
 * engine's `createWebAuthnSigningProvider`, whose code loads on the first `sign`.
 */
export const createWebAuthnSigningProvider: Engine["createWebAuthnSigningProvider"] = (options): SigningProvider => {
  let real: Promise<SigningProvider> | undefined;
  // No preload here: a host that excludes signing may still build a provider, and
  // building one must not fetch the chunk. <datum-form> preloads through loadWebAuthn() when
  // signing is allowed and a provider is assigned (so Safari's user gesture is not spent on the
  // fetch inside sign()); a failure there is swallowed and surfaces, retried, through sign().
  return {
    id: options.id ?? WEBAUTHN_SIGNING_PROVIDER_ID,
    async sign(request: SigningRequest) {
      // Built once from the chunk. A failed load is forgotten here as in loadWebAuthn(), so the next signature asks again.
      const building = (real ??= loadWebAuthn().then((module) => module.createWebAuthnSigningProvider(options)));
      building.catch(() => {
        if (real === building) {
          real = undefined;
        }
      });
      return (await building).sign(request);
    }
  };
};

export const verifyWebAuthnSubmission: Engine["verifyWebAuthnSubmission"] = async (document, options) =>
  (await loadWebAuthn()).verifyWebAuthnSubmission(document, options);

export const requestAssertion: Engine["requestAssertion"] = async (options) => (await loadWebAuthn()).requestAssertion(options);

export const verifyAssertion: Engine["verifyAssertion"] = async (assertion, options) => (await loadWebAuthn()).verifyAssertion(assertion, options);

export const registerCredential: Engine["registerCredential"] = async (options) => (await loadWebAuthn()).registerCredential(options);
