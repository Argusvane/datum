import { EagerJourneyRenderKit } from "../../form-engine/render/core/journey-render-kit-eager.js";
import { setDefaultJourneyRenderKit } from "../../form-engine/render/core/journey-render-kit-default.js";
import { EagerJourneyEngine } from "../../form-engine/runtime/browser/journey-engine-eager.js";
import { setDefaultJourneyEngine } from "../../form-engine/runtime/browser/journey-engine.js";

/*
 * The engine's tests build `new FormRuntime(...)` with journeys everywhere, and a runtime takes
 * the Noop journey engine unless one is passed or set as the default; the render
 * layer likewise draws a journey form whole under the Noop render kit. This file is the
 * test-side registration: the eager engine and the eager kit, once per worker, before any test
 * module loads.
 *
 * It imports the four engine files directly: anything wider (the package root) would load
 * modules a test file means to mock before its own mocks are in place.
 * `tests/journey-engine.test.ts` passes engines explicitly and does not depend on it.
 */
// DATUM_NO_JOURNEY_SETUP=1 skips it, to prove which tests lean on the registration.
if (process.env.DATUM_NO_JOURNEY_SETUP !== "1") {
  setDefaultJourneyEngine(EagerJourneyEngine);
  setDefaultJourneyRenderKit(EagerJourneyRenderKit);
}
