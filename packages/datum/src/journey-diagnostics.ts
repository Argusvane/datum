import { diagnoseJourneys as diagnose } from "@argusvane/datum-engine";
import { journeyEngineBundle } from "./journey-engine-chunk.js";

/**
 * The journey diagnostics as a module reached by dynamic import alone, so the
 * bundler gives it a lazy chunk (`datum-form-journey-diagnostics-*.js` beside
 * `datum-form.js`). Only `debug` and a page's own `loadJourneyDiagnostics()` ask for it: a
 * form that is being filled never pays for the checks an author runs. Nothing may import it
 * statically, and `form.ts` must not re-export from it, or it rides in the bundle again.
 *
 * It reads one binding of the journeys runtime chunk on purpose. The diagnostics
 * and the runtime both use the path engine (journey-path.ts); with no static link between
 * their chunks the bundler splits the path engine into a third file, so the renderer would have
 * two journey files to deploy, retry and delete. A real read of the runtime chunk's export keeps
 * the import (a bare side-effect import is tree-shaken, the chunk has none), the diagnostics
 * chunk then always loads beside the runtime chunk, and the path engine lives in the runtime
 * chunk alone. The cost is on the debug path only.
 */
export const diagnoseJourneys: typeof diagnose = (definition, options) =>
  journeyEngineBundle.sentinel ? diagnose(definition, options) : diagnose(definition, options);
