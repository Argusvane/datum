import { EagerJourneyEngine, setDefaultJourneyEngine } from "@argusvane/datum-engine/runtime";

/*
 * Tests here build `new FormRuntime(...)` beside the server code to compare journeys, and a
 * runtime takes the Noop journey engine unless one is passed or set as the default.
 * The test-side registration: the eager engine, once per worker, before any test module loads.
 */
setDefaultJourneyEngine(EagerJourneyEngine);
