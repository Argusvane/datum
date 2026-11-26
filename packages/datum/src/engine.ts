/**
 * The engine bundle: the form runtime with no element, built as `dist/datum-engine.js` (a module
 * only). `datum-form.js` defines `<datum-form>` when it loads, and the element's module reads
 * `HTMLElement` and `customElements`, so it cannot be imported where there is no DOM: plain Node,
 * a web worker, a test runner without jsdom. This file can. It carries what a caller needs to run
 * a definition without drawing it: the runtime factory and the standard component definitions
 * (their types, defaults and validation capabilities, never their drawing code), the plugin
 * registry, data sources, the submission envelope's helpers, the draft file, the host context's
 * sanitiser, the event names and the journeys runtime.
 *
 * Journeys are in: `createFormRuntime` here builds every runtime with the
 * eager journey engine, imported statically, so a server, a worker or a test walks a journey page
 * by page as `<datum-form>` does, with no chunk to load. The engine is pure over the definition
 * and the state; the journey's drawing (the render kit, the Check answers list) and following the
 * address bar are the element's and the host page's, and stay out. Nothing is registered in the
 * page's default-engine slot: a runtime another bundle builds on the same page is not changed.
 *
 * Nothing here draws: no element, no renderer, no binding, no print or PDF pipeline. Drawing
 * stays behind `<datum-form>`, whose runtime (`form.runtime`) is the same class. The bundle is one
 * file with no chunks (vite.config.ts), so it loads the same way from a page, a worker or Node,
 * and `scripts/check-bundles.mjs` (guards/17-engine-entry.mjs) holds that it reaches no element,
 * renderer or binding module and reads no DOM global when it loads.
 */
import { EagerJourneyEngine, type FormDefinition, type FormRuntime } from "@argusvane/datum-engine";

import { createFormRuntime as createElementRuntime, type FormRuntimeConfig } from "./runtime-factory.js";

/**
 * `createFormRuntime` as `datum-form.js` exports it, with the journeys runtime as the default
 * engine: a definition with journeys opens as its journey (or as `config.journey` says), and
 * `nextPage`, `previousPage`, `goToPage`, `startJourney` and the page's server checks work as in
 * the element. A `journeyEngine` in `config` still wins.
 */
export function createFormRuntime(definition: FormDefinition, config: FormRuntimeConfig = {}): FormRuntime {
  return createElementRuntime(definition, { ...config, journeyEngine: config.journeyEngine ?? EagerJourneyEngine });
}

export {
  EMBED_RUNTIME_VERSION,
  EMBED_SUBMISSION_MODE,
  createComponentRegistry,
  versionContextFor,
  type FormRuntimeConfig
} from "./runtime-factory.js";
// A journey's server check over a URL: fetch only, no DOM. Statically here, where the element's
// bundle reaches it by dynamic import (server-validator-loader.ts).
export { createFetchJourneyValidator, type FetchJourneyValidatorOptions } from "./server-validator.js";
export { JourneyValidationHttpError } from "./server-validator-error.js";
export { mergeComponentDefinitions, standardComponentDefinitions, standardComponentTypes } from "./standard-components.js";
export {
  createPluginPlatform,
  createPluginRegistry,
  pluginComponents,
  plugins,
  uniquePlugins,
  withPluginDataSources,
  type DatumPluginRegistry,
  type PluginRegistration,
  type RegisterPluginsOptions
} from "./plugins.js";
export { HOST_CONTEXT_MAX_DEPTH, HOST_CONTEXT_MAX_VALUES, plainHostContext, type PlainHostContext } from "./host-context.js";
export { toFormDefinition } from "./support.js";
export {
  EagerJourneyEngine,
  FormEventType,
  FormRuntime,
  JOURNEY_END,
  ValidationPipeline,
  canonicalizeJcs,
  createFieldConstraintsStage,
  createFileStorageResolver,
  cssClassCapability,
  defineDataSources,
  paletteEntriesOf,
  parseDraftFile,
  serializeDraftFile,
  signedCanonicalForSignature,
  signedCanonicalOf,
  standardFieldCapabilities,
  type BuilderComponentType,
  type CanonicalSubmission,
  type ComponentDefinition,
  type ComponentNode,
  type ComponentPaletteEntry,
  type DataSourceInputs,
  type DataSourceSet,
  type DraftStore,
  type FormDefinition,
  type FormDraft,
  type FormError,
  type FormEvent,
  type FormEventListener,
  type FormPlugin,
  type HostError,
  type Journey,
  type JourneyBlockReason,
  type JourneyChangedEventData,
  type JourneyCheckCompletedEventData,
  type JourneyCheckEventData,
  type JourneyConfiguration,
  type JourneyContinueValidation,
  type JourneyEngine,
  type JourneyHostChoice,
  type JourneyNavigationResult,
  type JourneyPage,
  type JourneyPageEntry,
  type JourneyPageKind,
  type JourneyRoute,
  type JourneyServerUnavailable,
  type JourneyServerValidator,
  type JourneyState,
  type JourneyTrace,
  type JourneyValidation,
  type JourneyValidationRequest,
  type JourneyValidationResponse,
  type JourneyValidationSettings,
  type JourneyView,
  type LocaleOption,
  type PageBlockedEventData,
  type PageChangeDirection,
  type PageChangedEventData,
  type ResolvedJourneyValidation,
  type PluginPlatformResult,
  type SignedSubmissionDocument,
  type SigningProvider,
  type SubmissionCanonicalization,
  type SubmissionSigningFormat,
  type SubmissionSigningOptions,
  type SubmissionVersionContext,
  type TranslationCatalog,
  type ValidationMessageCatalog,
  type WasmLogEntry,
  type WasmLogLevel,
  type WasmSandboxPolicy,
  type WasmValidationHost
} from "@argusvane/datum-engine";
