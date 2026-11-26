import { EagerJourneyEngine } from "../../../engine/form-engine/runtime/browser/journey-engine-eager";
import { setDefaultJourneyEngine } from "../../../engine/form-engine/runtime/browser/journey-engine";

/*
 * The demo-form tests build `new FormRuntime(...)` with journeys, and a runtime takes the Noop
 * journey engine unless one is passed or set as the default. The test-side
 * registration: the eager engine, once per worker, before any test module loads.
 */
setDefaultJourneyEngine(EagerJourneyEngine);
