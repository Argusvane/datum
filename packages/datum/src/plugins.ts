import {
  ComponentRegistry,
  DataSourceProviderRegistry,
  DataSourceRegistry,
  FormulaFunctionRegistry,
  PdfRenditionRegistry,
  PluginPlatform,
  PluginRegistry,
  RegisteredClientDataSourceRuntime,
  SubmissionHandlerRegistry,
  ValidatorRegistry,
  componentAdapterProblem,
  paletteEntriesOf,
  type BuilderComponentType,
  type ComponentDefinition,
  type DataSourceSet,
  type FormPlugin
} from "@argusvane/datum-engine";

/**
 * The page's plugin registry: where a host hands a `FormPlugin` — a component
 * library, a validator, a submission handler, a builder or PDF theme — and every `<datum-form>` and
 * `<datum-form-builder>` on the page takes it up. The bundles carry the engine and its own
 * catalogue and nothing else; what a page wants beyond that is a package the host installs
 * and registers:
 *
 *     import { plugins } from "@argusvane/datum";
 *     import { acmeComponentsPlugin } from "@acme/datum-components";
 *     plugins.register(acmeComponentsPlugin);
 *
 * and `<datum-form>` draws the `acme-*` types, `<datum-form-builder>` lists them under the
 * group their definitions declare (`ComponentDefinition.palette`). A page without a bundler
 * loads the package's own bundle, which does the same on load.
 *
 * What a registered plugin contributes, and where it lands:
 * - `components` join the standard catalogue on both surfaces (`mergeComponentDefinitions`),
 *   their `palette` entries the builder's palette; each one's `adapter` draws its type under
 *   whatever binding draws the form, on the form and on the builder's canvas alike, and its
 *   `css` is adopted after the binding's rules. A type without an adapter shows the
 *   renderer's unknown-component note;
 * - `builderThemes` and `pdfThemes` reach the page's theme registries
 *   (`builderThemes.register`, `pdfThemes.register`), so an id resolves;
 * - `validators`, `hooks`, `submissionHandlers`, `pdfRenditions` and `wasmPlugin` reach each
 *   runtime through a `PluginPlatform` built for it (`createFormRuntime`): validators run at
 *   validate and submit after the field constraints, hooks after the host's, handlers after
 *   an accepted submission, renditions in the PDF, the sandbox module in the sandbox
 *   `<datum-form wasm>` loads;
 * - `dataSources` and `dataSourceProviders` resolve behind the page's own sources
 *   (`withPluginDataSources`), on the form and on the builder's canvas and picker.
 *
 * A component's inspector is its definition's `propertyEditor`, and its settings are its
 * definition's `capabilities`: a plugin has no list of either of its own.
 *
 * The registry is one object per page, shared across the bundles through a global, like the
 * binding registry; an element also takes plugins of its own (`plugins`), for one form alone.
 * A plugin already registered (same id and version) is skipped, never an error, so a page
 * that loads a bundle twice registers once.
 */
export interface RegisterPluginsOptions {
  /** Where the page serves the assets of the builder and PDF themes the plugin carries (see `builderThemes.register`). */
  assetsBase?: string | undefined;
  /** Further ids that name the themes the plugin carries: `{ dark: "acme-dark" }`. */
  aliases?: Readonly<Record<string, string>> | undefined;
}

/** One registration: the plugin, and the options it came with (what its themes are registered under). */
export interface PluginRegistration {
  plugin: FormPlugin;
  options: RegisterPluginsOptions;
}

export interface DatumPluginRegistry {
  /** Registers plugins; one already registered (same id and version) is skipped, never an error. */
  register(input: FormPlugin | readonly FormPlugin[], options?: RegisterPluginsOptions): DatumPluginRegistry;
  /** Whether a plugin of this id (and version, when given) is registered. */
  has(id: string, version?: string): boolean;
  /** Every registration, in order. */
  registrations(): PluginRegistration[];
  /** Every registered plugin, in registration order. */
  plugins(): FormPlugin[];
  /** The component definitions the registered plugins contribute, a later plugin's type replacing an earlier one's. */
  components(): ComponentDefinition[];
  /** The palette entries those definitions declare. */
  paletteEntries(): BuilderComponentType[];
  /** A platform over fresh engine registries, seeded with the registered plugins and `extra` — one runtime's. */
  createPlatform(extra?: readonly FormPlugin[]): PluginPlatform;
  /** Called after every registration that added a plugin; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

const keyOf = (plugin: FormPlugin): string => `${plugin.id}@${plugin.version}`;

function isPlugin(input: unknown): input is FormPlugin {
  return !!input && typeof input === "object" && typeof (input as { id?: unknown }).id === "string" && typeof (input as { version?: unknown }).version === "string";
}

/** What each list a plugin contributes holds: an object, and for these the string that names it. */
const PLUGIN_LISTS: Readonly<Record<string, string | undefined>> = {
  components: "type",
  dependencies: "id",
  validators: undefined,
  formulaFunctions: undefined,
  pdfRenditions: undefined,
  builderThemes: undefined,
  pdfThemes: undefined,
  dataSourceProviders: "id",
  dataSources: "id",
  submissionHandlers: undefined
};

/** The target a theme must have in each of the plugin's theme lists that holds one target only. */
const PLUGIN_THEME_TARGETS: Readonly<Record<string, string>> = { builderThemes: "builder", pdfThemes: "pdf" };

/**
 * What is wrong with a plugin's shape, in a line that names the member; `undefined` when it
 * can be taken. Every list it contributes is a list of objects (the ones that are looked up by
 * a name have it): the registries and the merge read them on every element at once, so one
 * entry that is not an object would stop each form and builder on the page, naming the form
 * rather than the plugin.
 */
export function pluginShapeProblem(plugin: FormPlugin): string | undefined {
  const record = plugin as unknown as Record<string, unknown>;
  // The platform reads these at every install, on every form of the page.
  if (record.environments !== undefined && (!Array.isArray(record.environments) || record.environments.some((entry) => typeof entry !== "string"))) {
    return "environments must be a list of strings";
  }
  for (const [member, key] of Object.entries(PLUGIN_LISTS)) {
    const list = record[member];
    if (list === undefined) {
      continue;
    }
    if (!Array.isArray(list)) {
      return `${member} must be a list`;
    }
    for (let index = 0; index < list.length; index += 1) {
      const entry: unknown = list[index];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return `${member}[${index}] must be an object`;
      }
      if (key !== undefined && (typeof (entry as Record<string, unknown>)[key] !== "string" || (entry as Record<string, string>)[key] === "")) {
        return `${member}[${index}].${key} must be a non-empty string`;
      }
      const target = PLUGIN_THEME_TARGETS[member];
      if (target !== undefined && (entry as Record<string, unknown>).target !== target) {
        return `${member}[${index}].target must be "${target}"`;
      }
      // A component's drawing is read on every form and canvas of the page: one of another shape is refused here, by name.
      const adapterProblem = member === "components" ? componentAdapterProblem((entry as Record<string, unknown>).adapter) : undefined;
      if (adapterProblem !== undefined) {
        return `${member}[${index}].${adapterProblem}`;
      }
    }
  }
  return undefined;
}

/** `plugins` without a later duplicate of an id and version: the first registration of a plugin is the one that counts. */
export function uniquePlugins(plugins: readonly FormPlugin[]): FormPlugin[] {
  const seen = new Set<string>();
  const out: FormPlugin[] = [];
  for (const plugin of plugins) {
    const key = keyOf(plugin);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(plugin);
    }
  }
  return out;
}

/** `definitions` with one entry per type — the last one given — each at the position the type first appeared. */
function uniqueByType(definitions: readonly ComponentDefinition[]): ComponentDefinition[] {
  const byType = new Map<string, ComponentDefinition>();
  for (const definition of definitions) {
    byType.set(definition.type, definition);
  }
  return [...byType.values()];
}

/**
 * The component definitions `plugins` contribute, in plugin order; a later plugin's definition
 * of a type replaces an earlier one's, the way a host's own replaces a standard one.
 */
export function pluginComponents(plugins: readonly FormPlugin[]): ComponentDefinition[] {
  return uniqueByType(uniquePlugins(plugins).flatMap((plugin) => plugin.components ?? []));
}

/**
 * A platform over fresh engine registries seeded with `plugins`, for one runtime: the
 * engine's registries refuse a second registration of the same thing, so a platform is never
 * shared between runtimes. Installing is the runtime's (`FormRuntime` calls
 * `installAndInitialize` and takes up what came back).
 */
export function createPluginPlatform(plugins: readonly FormPlugin[]): PluginPlatform {
  const registries = {
    plugins: new PluginRegistry(),
    components: new ComponentRegistry(),
    validators: new ValidatorRegistry(),
    // No builder or PDF theme registries here: nothing in a runtime reads them, and fresh ones
    // lack the shipped themes, so a plugin theme that `extends` one would fail the whole plugin.
    // The page's theme registries take those slots (themes.ts).
    dataSourceProviders: new DataSourceProviderRegistry(),
    dataSources: new DataSourceRegistry(),
    submissionHandlers: new SubmissionHandlerRegistry(),
    pdfRenditions: new PdfRenditionRegistry(),
    formulaFunctions: new FormulaFunctionRegistry()
  };
  for (const plugin of uniquePlugins(plugins)) {
    registries.plugins.register(plugin);
  }
  // An install failure is isolated per plugin, so without a line here it would be silent.
  return new PluginPlatform(registries, {
    // A plugin outside the engine's range is refused, and the page is told.
    onIncompatible: (pluginId, reason) => {
      console.warn(`[datum] Plugin "${pluginId}" was not installed: ${reason}`);
    },
    onError: (error) => {
      console.warn(`[datum] A plugin failed to install: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * The page's data sources with the ones `plugins` register behind them: an id the set holds
 * resolves there, any other through the plugins' definitions and providers, in the client
 * environment. The set alone when no plugin registers a source, so nothing changes for a page
 * without one. The result is what the runtime, the renderer and the builder's canvas and
 * picker are handed, so a plugin's source is offered and previewed like the page's own.
 */
export function withPluginDataSources(set: DataSourceSet | undefined, plugins: readonly FormPlugin[]): DataSourceSet | undefined {
  const definitions = new DataSourceRegistry();
  const providers = new DataSourceProviderRegistry();
  const providerIds = new Set<string>();
  let registered = false;
  for (const plugin of uniquePlugins(plugins)) {
    for (const provider of plugin.dataSourceProviders ?? []) {
      // The first provider of an id is the one every plugin's sources resolve through.
      if (!providerIds.has(provider.id)) {
        providerIds.add(provider.id);
        providers.register(provider);
      }
    }
    for (const source of plugin.dataSources ?? []) {
      // A source registered twice (the same plugin given to the page and to an element) is one source.
      if (!definitions.ids().includes(source.id)) {
        definitions.register(source);
        registered = true;
      }
    }
  }
  if (!registered) {
    return set;
  }
  const runtime = new RegisteredClientDataSourceRuntime(definitions, providers);
  const ids = new Set(definitions.ids());
  return {
    has: (sourceId) => (set?.has(sourceId) ?? false) || ids.has(sourceId),
    ids: () => [...new Set([...(set?.ids() ?? []), ...ids])],
    load: (sourceId, query, context) =>
      set?.has(sourceId) ? set.load(sourceId, query, context) : runtime.load(sourceId, query, context)
  };
}

export function createPluginRegistry(): DatumPluginRegistry {
  const entries: PluginRegistration[] = [];
  const keys = new Set<string>();
  const listeners = new Set<() => void>();

  const registry: DatumPluginRegistry = {
    register(input, options = {}) {
      const items: readonly unknown[] = Array.isArray(input) ? input : [input];
      let added = false;
      for (const item of items) {
        if (!isPlugin(item)) {
          // A value that names itself but cannot be taken is said so; anything else has no name to give.
          const named = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
          if (typeof named === "string") {
            console.error(`[datum] Plugin "${named}" was not registered: version must be a string`);
          }
          continue;
        }
        if (keys.has(keyOf(item))) {
          continue;
        }
        // One plugin that is not shaped right is refused by name; the others are still served.
        const problem = pluginShapeProblem(item);
        if (problem) {
          console.error(`[datum] Plugin "${item.id}" was not registered: ${problem}`);
          continue;
        }
        keys.add(keyOf(item));
        entries.push({ plugin: item, options });
        added = true;
      }
      if (added) {
        for (const listener of listeners) {
          listener();
        }
      }
      return registry;
    },
    has: (id, version) => entries.some((entry) => entry.plugin.id === id && (version === undefined || entry.plugin.version === version)),
    registrations: () => [...entries],
    plugins: () => entries.map((entry) => entry.plugin),
    components: () => pluginComponents(entries.map((entry) => entry.plugin)),
    paletteEntries: () => paletteEntriesOf(registry.components()),
    createPlatform: (extra = []) => createPluginPlatform([...registry.plugins(), ...extra]),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
  return registry;
}

const SHARED = Symbol.for("datum.web-components.plugins");

/**
 * The page's plugin registry, one per page however many bundles are loaded: `datum-form.js`,
 * `datum-builder.js`, a plugin package's bundle and any other reach the same object through
 * a global, so a host registers once wherever it loads them from.
 */
export const plugins: DatumPluginRegistry = ((globalThis as Record<symbol, unknown>)[SHARED] as DatumPluginRegistry | undefined) ?? createPluginRegistry();
(globalThis as Record<symbol, unknown>)[SHARED] = plugins;
