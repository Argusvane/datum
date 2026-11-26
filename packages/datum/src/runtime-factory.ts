import {
  ComponentRegistry,
  FormRuntime,
  SubmissionModeRegistry,
  ValidationPipeline,
  createFieldConstraintsStage,
  type ComponentDefinition,
  type DataSourceSet,
  type DraftStore,
  type FormDefinition,
  type FormPlugin,
  type FormRuntimeDependencies,
  type FormulaErrorPolicy,
  compileFormDefinition,
  type JourneyEngine,
  type JourneyHostChoice,
  type JourneyServerValidator,
  type SigningProvider,
  type SubmissionSigningOptions,
  type SubmissionVersionContext,
  type TranslationCatalog,
  type WasmLogLevel,
  type WasmSandboxPolicy,
  type WasmValidationHost
} from "@argusvane/datum-engine";

import { createPluginPlatform, pluginComponents, plugins as sharedPlugins, withPluginDataSources, type DatumPluginRegistry } from "./plugins.js";
import { mergeComponentDefinitions } from "./standard-components.js";

/** The one submission mode the embedded form runs: validate, no signing, no server stage. */
export const EMBED_SUBMISSION_MODE = "embed";

/** What the canonical submission records as the client's runtime and renderer versions. */
export const EMBED_RUNTIME_VERSION = "1.0.0";

export interface FormRuntimeConfig {
  /** Data sources the page wired (`defineDataSources`); the runtime and its validation see them too. */
  dataSources?: DataSourceSet | undefined;
  /**
   * `false` leaves the data sources the plugins carry out of the runtime too (the page's own
   * `dataSources` is whatever the caller passes): `<datum-form>` sets it when its `features`
   * list leaves `data-sources` out. The default, `true`, adds them behind the page's.
   */
  pluginDataSources?: boolean | undefined;
  /** Translations for the form's `LocalizedText.key` entries, sourced by the page. */
  translations?: TranslationCatalog | undefined;
  /** Component types beyond the standard catalogue (a type matching a standard one replaces it). */
  componentDefinitions?: readonly ComponentDefinition[] | undefined;
  /**
   * Plugins for this runtime alone, beside those the page registered on `plugins`:
   * their components join the catalogue, their validators the pipeline, their hooks,
   * submission handlers, PDF renditions and sandbox modules the runtime, their data sources
   * the set. A plugin the page also registered counts once.
   */
  plugins?: readonly FormPlugin[] | undefined;
  /** The page-wide registry the plugins come from; the shared `plugins` unless a host keeps its own. */
  pluginRegistry?: DatumPluginRegistry | undefined;
  /** Where `saveDraft` / `hydrateFromDraft` go; none means drafts are off. */
  draftStore?: DraftStore | undefined;
  /**
   * A sandbox to validate and sanitize in at submit — the QuickJS host
   * `datum-wasm.js` builds, wired with the page's plugin modules. None means field
   * constraints alone, in-process.
   */
  wasmValidationHost?: WasmValidationHost | undefined;
  /**
   * What the sandbox may read beside the values, resolved by the page per submit:
   * the sandbox itself never fetches.
   */
  wasmExternalDataProvider?: FormRuntimeDependencies["wasmExternalDataProvider"] | undefined;
  /**
   * The run policy: privileges stay all-`false` (the engine refuses anything else); it exists
   * so `allowedExternalDataKeys` can name exactly what the provider may inject. Default: the
   * strict policy, with every key the provider returns allowed.
   */
  wasmPolicy?: WasmSandboxPolicy | undefined;
  /** What the sandbox's run log keeps by default; a submit may say otherwise. */
  wasmLogLevel?: WasmLogLevel | undefined;
  /**
   * Signing: the default provider a signing mode would use, the providers a
   * button's `signature` option may name by id (a WebAuthn one, `createWebAuthnSigningProvider`),
   * and the format — what is hashed and where the signatures land. The embed's own submission
   * mode does not force signing; a button option, or a page's own runtime, does.
   */
  signingProvider?: SigningProvider | undefined;
  signingProviders?: readonly SigningProvider[] | undefined;
  signing?: SubmissionSigningOptions | undefined;
  /**
   * Which journey the form opens as: a journey's id, `"form"` for the whole form on
   * one page, or `"journey"` for the definition's default journey. Absent, the definition
   * decides; an id it does not have is warned about and the definition decides.
   */
  journey?: JourneyHostChoice;
  /**
   * The journeys to run in place of the definition's own — for a builder previewing
   * journeys while they are edited: a function is read on every recompute, so the
   * runtime follows the edits (`refreshJourney`) without a rebuild. It makes the runtime a
   * preview, which is never checked against a server; a form in service leaves it out.
   */
  journeyConfiguration?: FormRuntimeDependencies["journeyConfiguration"] | undefined;
  /** The page the journey opens on (a deep link, a resume point), when the person may reach it. */
  page?: string | undefined;
  /**
   * The host's way to its server for the checks a journey asks for: a page's on
   * Continue, the whole journey's before submit. `createFetchJourneyValidator` builds one over
   * a URL. Without it, a journey that asks for a server check is treated as the server being
   * unavailable.
   */
  journeyServerValidator?: JourneyServerValidator | undefined;
  /** How long a check may take, in milliseconds, before it counts as unavailable; `0` for no limit. The runtime's default applies when absent. */
  journeyServerValidationTimeoutMs?: number | undefined;
  /**
   * The journey machinery the runtime asks. `<datum-form>` hands the engine the
   * journeys chunk carries. A host that builds runtimes itself on datum-form.js awaits
   * `(await loadJourneyEngine()).forDefinition(definition)` and passes its `engine` here AND sets
   * `renderer.journeyKit` to its `renderKit` (without the kit the journey is drawn as one page;
   * the bundle's plain `renderKit` draws a Check answers page with no list, as `forDefinition`
   * loads that page's code only for a definition that has one, and `<datum-form>` fetches it beside the journeys chunk); a host that bundles the engine passes
   * `EagerJourneyEngine` and `EagerJourneyRenderKit`. Absent, the runtime takes the page's default engine
   * (`setDefaultJourneyEngine`), the Noop one unless something registered another, which runs a
   * journey definition as one page and says so once. This factory carries no engine of its own:
   * a static default would pull the whole journey engine into the renderer bundle.
   */
  journeyEngine?: JourneyEngine | undefined;
  /**
   * What the runtime does with a rule whose formula does not parse: `"fail"`
   * (the default when the form says nothing), which refuses the definition, or `"warn"`,
   * the explicit opt-in for preview and staging. Overrides the form's own `configuration.formulaErrors`.
   */
  formulaErrors?: FormulaErrorPolicy | undefined;
  /** `"refuse"` (the default) or `"allow"`: what the runtime does with a regular expression of a catastrophic shape (see `FormRuntimeDependencies.riskyPatterns`). */
  riskyPatterns?: "refuse" | "allow" | undefined;
  /** The calendar day the rules read (`today()`), `YYYY-MM-DD`, or a function read on every recompute. Absent: the day where the page runs. */
  today?: string | (() => string) | undefined;
  /**
   * What the rules' `host.` paths read (`host.role`): the page's own values, plain data. For
   * display only: they travel in no submission, and a server judges with values of its own.
   */
  hostContext?: Record<string, unknown> | undefined;
}

/** A component registry over the standard catalogue, the registered plugins' definitions and a host's own. */
export function createComponentRegistry(
  extra: readonly ComponentDefinition[] = [],
  registered: readonly ComponentDefinition[] = []
): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const definition of mergeComponentDefinitions(extra, registered)) {
    registry.register(definition);
  }
  return registry;
}

/** The plugins a runtime is built with: the page's, then the runtime's own. */
export function runtimePlugins(config: Pick<FormRuntimeConfig, "plugins" | "pluginRegistry">): FormPlugin[] {
  return [...(config.pluginRegistry ?? sharedPlugins).plugins(), ...(config.plugins ?? [])];
}

/**
 * A fully wired `FormRuntime` for a form definition: the standard component registry
 * (required for submission-manifest completeness), the engine's field-constraints stage as
 * the validation pipeline — `required`, `pattern`, length and file limits, enforced from the
 * component configuration the builder authored — one submission mode, and whatever data
 * sources, translations and draft store the page supplied.
 *
 * The QuickJS sandbox is not part of the bundle: a page that wants plugin
 * validators to run there hands over a host — `<datum-form wasm>` loads one from
 * `datum-wasm.js` — and the runtime re-validates and sanitizes in it at submit.
 * Without one, field constraints validate in-process alone.
 *
 * The plugins the page registered (`plugins`) and the runtime's own are installed
 * through a platform of this runtime's: the runtime takes up their hooks, submission
 * handlers, validators (after the field constraints) and PDF renditions, and reports what it
 * installed on `installedPlugins()` — where `<datum-form>` reads the sandbox modules to load.
 * Their components are in the registry beside the standard catalogue — where `<datum-form>`'s
 * renderer reads each one's `adapter` to draw it (`FormRuntime.componentDefinitions`) — their
 * data sources behind the page's.
 */
export function createFormRuntime(definition: FormDefinition, config: FormRuntimeConfig = {}): FormRuntime {
  const submissionModes = new SubmissionModeRegistry();
  submissionModes.register({
    id: EMBED_SUBMISSION_MODE,
    validate: true,
    sign: false,
    serverValidation: false
  });
  const plugins = runtimePlugins(config);
  const dataSources = config.pluginDataSources === false ? config.dataSources : withPluginDataSources(config.dataSources, plugins);
  // The field-constraints stage reads the tree as the runtime will: a compiled
  // copy, every formula a tree, so a `requiredWhen` that does not parse counts as no rule here
  // as it does in the runtime, with the plugins' declared functions known to the parser. The
  // runtime compiles the author's definition again for itself (cheap: a copy) and reports the
  // problems under its policy; this compile reports nothing.
  const compiled = compileFormDefinition(definition, { plugins, riskyPatterns: config.riskyPatterns }).definition;

  return new FormRuntime(definition, {
    // The stage judges a pattern it cannot run by the same two host words the sandbox is given.
    validationPipeline: new ValidationPipeline([
      createFieldConstraintsStage(compiled.root, {
        ...(config.riskyPatterns !== undefined ? { riskyPatterns: config.riskyPatterns } : {}),
        ...(config.formulaErrors !== undefined ? { formulaErrors: config.formulaErrors } : {})
      })
    ]),
    submissionModes,
    versionContext: {
      formVersion: definition.version,
      schemaVersion: definition.schemaVersion,
      rendererVersion: EMBED_RUNTIME_VERSION
    },
    componentRegistry: createComponentRegistry(config.componentDefinitions ?? [], pluginComponents(plugins)),
    // A platform only when there is something to install: a runtime without plugins is
    // built as it always was, no plugin events published.
    ...(plugins.length > 0 ? { pluginPlatform: createPluginPlatform(plugins) } : {}),
    ...(dataSources ? { dataSources } : {}),
    ...(config.translations ? { translationCatalog: config.translations } : {}),
    ...(config.draftStore ? { draftStore: config.draftStore } : {}),
    ...(config.wasmValidationHost ? { wasmValidationHost: config.wasmValidationHost } : {}),
    ...(config.wasmExternalDataProvider ? { wasmExternalDataProvider: config.wasmExternalDataProvider } : {}),
    ...(config.wasmPolicy ? { wasmPolicy: config.wasmPolicy } : {}),
    ...(config.wasmLogLevel ? { wasmLogLevel: config.wasmLogLevel } : {}),
    ...(config.signingProvider ? { signingProvider: config.signingProvider } : {}),
    ...(config.signingProviders ? { signingProviders: [...config.signingProviders] } : {}),
    ...(config.signing ? { signing: config.signing } : {}),
    ...(config.journey !== undefined ? { journey: config.journey } : {}),
    ...(config.journeyConfiguration !== undefined ? { journeyConfiguration: config.journeyConfiguration } : {}),
    ...(config.page !== undefined ? { page: config.page } : {}),
    ...(config.journeyServerValidator ? { journeyServerValidator: config.journeyServerValidator } : {}),
    // A journey check's envelope is stamped as the element's Submit stamps its own.
    submissionVersionContext: versionContextFor(definition),
    ...(config.journeyServerValidationTimeoutMs !== undefined
      ? { journeyServerValidationTimeoutMs: config.journeyServerValidationTimeoutMs }
      : {}),
    // No engine of our own here: the chunk's, or the page's default (the slot).
    ...(config.journeyEngine ? { journeyEngine: config.journeyEngine } : {}),
    ...(config.formulaErrors !== undefined ? { formulaErrors: config.formulaErrors } : {}),
    ...(config.riskyPatterns !== undefined ? { riskyPatterns: config.riskyPatterns } : {}),
    ...(config.today !== undefined ? { today: config.today } : {}),
    ...(config.hostContext !== undefined ? { hostContext: config.hostContext } : {})
  });
}

/** The version context `FormRuntime.submit` stamps into the canonical submission. */
export function versionContextFor(definition: FormDefinition): SubmissionVersionContext {
  return {
    form: { id: definition.id, version: definition.version },
    client: {
      runtimeVersion: EMBED_RUNTIME_VERSION,
      rendererVersion: EMBED_RUNTIME_VERSION,
      schemaVersion: definition.schemaVersion
    }
  };
}

