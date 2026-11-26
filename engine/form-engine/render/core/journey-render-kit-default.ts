import { NoopJourneyRenderKit, type JourneyRenderKit } from "./journey-render-kit.js";

/**
 * The kit the render layer uses when the host hands none: the Noop one, which draws
 * every form as the one page it is. The one place the default lives for the render
 * orchestrator, the bridge and the form's markup. Journey chrome is a lazy chunk of the
 * renderer bundle, so a default that named the eager kit here would pull it back into the
 * entry.
 *
 * A host that builds renderers itself and wants journey pages drawn says so once, with
 * {@link setDefaultJourneyRenderKit}: the builder bundle's entry, the demo app's entry and the
 * test setup files do (next to `setDefaultJourneyEngine`, the engine's twin). Never set by
 * importing the engine package, which is `sideEffects: false`, and `<datum-form>` hands the kit
 * it loaded to its renderer instead.
 *
 * Held on the global object under a registered symbol, as the engine's default is: the builder
 * and form bundles each carry a copy of this module, and one registration should reach every
 * renderer on the page.
 */
const DEFAULT_KIT_KEY = Symbol.for("datum.journeyRenderKit.default");

type KitHolder = { [DEFAULT_KIT_KEY]?: JourneyRenderKit };

/** Sets the kit renderers take when their options name none. */
export function setDefaultJourneyRenderKit(kit: JourneyRenderKit): void {
  (globalThis as KitHolder)[DEFAULT_KIT_KEY] = kit;
}

/** The kit renderers take when their options name none. */
export function defaultJourneyRenderKit(): JourneyRenderKit {
  return (globalThis as KitHolder)[DEFAULT_KIT_KEY] ?? NoopJourneyRenderKit;
}
