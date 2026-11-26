import type { JourneyServerValidator, JourneyValidationRequest, JourneyValidationResponse } from "@argusvane/datum-engine";

import { ChunkLoadError } from "./chunk-load-error.js";
import type { FetchJourneyValidatorOptions } from "./server-validator.js";

export { JourneyValidationHttpError } from "./server-validator-error.js";
export type { FetchJourneyValidatorOptions } from "./server-validator.js";

/**
 * The server validator as a lazy chunk: `server-validator.ts` holds the
 * fetch-and-read-back code and is reached by dynamic import alone, so a form with no
 * `validate-url` and no validator of its own never downloads it. This module is what the bundle
 * carries instead: the same `createFetchJourneyValidator` name, with the same signature, that
 * returns a validator at once and asks the chunk on the first check.
 */
type ServerValidatorModule = typeof import("./server-validator.js");

/** One load of the chunk per page, shared by every element and every validator made here. */
let validatorLoad: Promise<ServerValidatorModule> | undefined;

/**
 * Loads the chunk, once; a failed load is forgotten so the next check asks again (a chunk that
 * 404ed for a moment). In the module build of the builder the dynamic import goes through the
 * retrying loader (vite.config.ts), which asks the module map for a URL it has not failed on.
 */
export function loadServerValidator(): Promise<ServerValidatorModule> {
  if (!validatorLoad) {
    // A missing or blocked chunk rejects as a ChunkLoadError, which <datum-form> reports as datum-error.
    const load = import("./server-validator.js").catch((error: unknown): never => {
      throw new ChunkLoadError("The server validator (datum-form-server-validator-*.js)", error);
    });
    load.catch(() => {
      if (validatorLoad === load) {
        validatorLoad = undefined;
      }
    });
    validatorLoad = load;
  }
  return validatorLoad;
}

/**
 * A `JourneyServerValidator` that posts each check to `url` as a Datum host's
 * `POST /api/submissions/validate` takes it, `{ document, scope, pageId? }` (see
 * `server-validator.ts` for the contract). The code behind it loads on the first check; the check waits for it. A
 * load that fails rejects the check like any outage with no verdict, which the runtime reads as
 * the server being unavailable: the journey's `onUnavailable` decides, `"block"` by default, so a missing chunk never passes a check.
 *
 * `<datum-form validate-url>` calls `loadServerValidator()` itself when the URL is applied, so
 * the first Continue does not wait on the network for the code.
 */
export function createFetchJourneyValidator(url: string, options: FetchJourneyValidatorOptions = {}): JourneyServerValidator {
  let real: JourneyServerValidator | undefined;
  return async (request: JourneyValidationRequest, call?: Parameters<JourneyServerValidator>[1]): Promise<JourneyValidationResponse> => {
    if (!real) {
      const module = await loadServerValidator();
      real = module.createFetchJourneyValidator(url, options);
    }
    return real(request, call);
  };
}
