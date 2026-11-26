import type {
  FormPlugin,
  PluginContext,
  PluginLifecycleHooks,
  ValidationStage,
  WasmPluginContribution
} from "../../core/schema/contracts.js";
import { mergeFormHooks, type FormHooks } from "../../core/events/hooks.js";
import { satisfies } from "../../registry/version-range.js";
import { ENGINE_VERSION } from "../../registry/engine-version.js";
import type { DataSourceProviderRegistry } from "../../data/providers/data-source-provider-registry.js";
import type { ComponentRegistry } from "../../registry/components/component-registry.js";
import type { DataSourceRegistry } from "../../registry/data-sources/data-source-registry.js";
import type { PluginRegistry } from "../../registry/plugins/plugin-registry.js";
import type { BuilderThemeDefinition, BuilderThemeRegistry } from "../../builder/web-component/builder-theme-registry.js";
import type { PdfThemeDefinition } from "../../render/pdf/pdf-theme-defaults.js";
import type { PdfThemeRegistry } from "../../render/pdf/pdf-theme-registry.js";
import type { ValidatorRegistry } from "../../registry/validators/validator-registry.js";
import type { SubmissionHandlerRegistry } from "../../registry/submission/submission-handler-registry.js";
import type { FormulaFunctionRegistry } from "../../registry/formula-functions/formula-function-registry.js";
import type { PdfRenditionRegistry } from "../../registry/pdf/pdf-rendition-registry.js";
import type { SubmissionHandlerDefinition } from "../../core/submission/submission-handler.js";
import { PluginLifecycle, type PluginInitializationResult } from "../lifecycle/plugin-lifecycle.js";

export interface PluginPlatformRegistries {
  plugins: PluginRegistry;
  components: ComponentRegistry;
  validators: ValidatorRegistry;
  dataSourceProviders: DataSourceProviderRegistry;
  dataSources: DataSourceRegistry;
  submissionHandlers?: SubmissionHandlerRegistry;
  /** Where `FormPlugin.pdfRenditions` land; a host without PDF may omit it. */
  pdfRenditions?: PdfRenditionRegistry;
  /** Where `FormPlugin.formulaFunctions` land; a host without plugin formulas may omit it. */
  formulaFunctions?: FormulaFunctionRegistry;
  /** Where `FormPlugin.builderThemes` land; a host without a builder may omit it, and they are not taken up. */
  builderThemes?: BuilderThemeRegistry;
  /** Where `FormPlugin.pdfThemes` land; a host without PDF themes may omit it, and they are not taken up. */
  pdfThemes?: PdfThemeRegistry;
}

export interface PluginCompatibilityPolicy {
  /** Engine version installed plugins are checked against via `plugin.engineRange`; the engine's own when omitted. */
  engineVersion?: string;
}

export interface PluginIncompatibility {
  pluginId: string;
  reason: string;
}

export interface PluginPlatformResult extends PluginInitializationResult {
  installedPluginIds: string[];
  incompatiblePluginIds: string[];
  incompatibilities: PluginIncompatibility[];
  /** Runtime hooks contributed by successfully installed plugins, merged. */
  mergedHooks: FormHooks;
  /** Submission handlers contributed by successfully installed plugins, in install order. */
  mergedSubmissionHandlers: SubmissionHandlerDefinition[];
  /**
   * Portable WASM sandbox modules contributed by successfully installed plugins, in install
   * order. Hosts hand these to the wasm validation host they construct at startup (e.g.
   * `createQuickJsValidationHost(mergedWasmPlugins)`); the engine does not run them itself.
   */
  mergedWasmPlugins: WasmPluginContribution[];
  /**
   * Validation stages contributed by successfully installed plugins, in install order — what
   * `FormRuntime` appends to its validation pipeline, so a plugin's validators run at
   * validate and submit like the host's own.
   */
  mergedValidators: ValidationStage[];
  /**
   * The formula functions contributed by successfully installed plugins, by name, ready for
   * `RuleEvaluationContext.functions`. Empty when the platform has no registry.
   */
  mergedFormulaFunctions: Record<string, (args: unknown[]) => unknown>;
}

type Held = Map<unknown, unknown> | Set<unknown>;

/**
 * What a registry holds right now: each of its maps and sets copied one level down (an array
 * or map value too), so {@link restoreRegistry} can put it back. The registries have no
 * unregister, so an install that fails part-way is undone this way.
 */
function snapshotRegistry(registry: object): Array<[Held, Held]> {
  const out: Array<[Held, Held]> = [];
  for (const value of Object.values(registry)) {
    if (value instanceof Map) {
      out.push([value, new Map([...value].map(([key, entry]) => [key, Array.isArray(entry) ? [...entry] : entry instanceof Map ? new Map(entry) : entry]))]);
    } else if (value instanceof Set) {
      out.push([value, new Set(value)]);
    }
  }
  return out;
}

function restoreRegistry(saved: Array<[Held, Held]>): void {
  for (const [live, copy] of saved) {
    live.clear();
    if (live instanceof Map) {
      for (const [key, entry] of copy as Map<unknown, unknown>) {
        live.set(key, entry);
      }
    } else {
      for (const entry of copy) {
        (live as Set<unknown>).add(entry);
      }
    }
  }
}

export class PluginPlatform {
  constructor(
    private readonly registries: PluginPlatformRegistries,
    private readonly hooks: PluginLifecycleHooks = {},
    private readonly policy: PluginCompatibilityPolicy = {}
  ) {}

  /** Where the installed plugins' PDF renditions landed, for a PDF's rendition lookup. */
  public get pdfRenditions(): PdfRenditionRegistry | undefined {
    return this.registries.pdfRenditions;
  }

  /** Where the installed plugins' formula functions landed, for the builder's function table. */
  public get formulaFunctions(): FormulaFunctionRegistry | undefined {
    return this.registries.formulaFunctions;
  }

  /**
   * The id and version of each plugin in `ids` (the installed ones), read from the manifests in
   * the platform's plugin registry. An id the registry no longer holds is left out.
   */
  public pluginVersions(ids: readonly string[]): Record<string, string> {
    const versions: Record<string, string> = {};
    for (const plugin of this.registries.plugins.listLatest()) {
      if (ids.includes(plugin.id)) {
        versions[plugin.id] = plugin.version;
      }
    }
    return versions;
  }

  private checkCompatibility(
    plugin: FormPlugin,
    context: PluginContext
  ): string | undefined {
    if (plugin.environments && !plugin.environments.includes(context.environment)) {
      return `plugin does not support environment "${context.environment}"`;
    }
    if (
      plugin.engineRange &&
      !satisfies(this.policy.engineVersion ?? ENGINE_VERSION, plugin.engineRange)
    ) {
      return `engine ${this.policy.engineVersion ?? ENGINE_VERSION} does not satisfy ${plugin.engineRange}`;
    }
    return undefined;
  }

  public installAndInitialize(context: PluginContext): PluginPlatformResult {
    const orderedPlugins = this.registries.plugins.resolveDependencyOrder();
    const installedPluginIds: string[] = [];
    const installFailedPluginIds = new Set<string>();
    const incompatibilities: PluginIncompatibility[] = [];
    const installSucceededPlugins: FormPlugin[] = [];

    for (const plugin of orderedPlugins) {
      const incompatibleReason = this.checkCompatibility(plugin, context);
      if (incompatibleReason) {
        installFailedPluginIds.add(plugin.id);
        incompatibilities.push({ pluginId: plugin.id, reason: incompatibleReason });
        this.hooks.onIncompatible?.(plugin.id, incompatibleReason, context);
        continue;
      }

      // A plugin that fails part-way leaves nothing behind: the registries it writes to are put back.
      const contributed = [
        this.registries.components,
        this.registries.validators,
        this.registries.dataSourceProviders,
        this.registries.dataSources,
        this.registries.submissionHandlers,
        this.registries.pdfRenditions,
        this.registries.formulaFunctions,
        this.registries.builderThemes,
        this.registries.pdfThemes
      ].filter((registry): registry is NonNullable<typeof registry> => registry !== undefined);
      const saved = contributed.map((registry) => snapshotRegistry(registry));
      try {
        for (const component of plugin.components ?? []) {
          this.registries.components.register(component);
        }
        for (const validator of plugin.validators ?? []) {
          this.registries.validators.register(validator);
        }
        for (const contribution of plugin.pdfRenditions ?? []) {
          if (!this.registries.pdfRenditions) {
            throw new Error(
              `Plugin "${plugin.id}" contributes PDF renditions but the platform has no pdfRenditions registry`
            );
          }
          this.registries.pdfRenditions.register(contribution);
        }
        for (const contribution of plugin.formulaFunctions ?? []) {
          if (!this.registries.formulaFunctions) {
            throw new Error(
              `Plugin "${plugin.id}" contributes formula functions but the platform has no formulaFunctions registry`
            );
          }
          this.registries.formulaFunctions.register(contribution, plugin.id);
        }
        // Core types these slots loosely; the registries check the target and read the full shape.
        for (const theme of plugin.builderThemes ?? []) {
          this.registries.builderThemes?.register(theme as BuilderThemeDefinition);
        }
        for (const theme of plugin.pdfThemes ?? []) {
          this.registries.pdfThemes?.register(theme as PdfThemeDefinition);
        }
        for (const provider of plugin.dataSourceProviders ?? []) {
          this.registries.dataSourceProviders.register(provider);
        }
        for (const dataSource of plugin.dataSources ?? []) {
          this.registries.dataSources.register(dataSource);
        }
        for (const handler of plugin.submissionHandlers ?? []) {
          this.registries.submissionHandlers?.register(handler);
        }

        installedPluginIds.push(plugin.id);
        installSucceededPlugins.push(plugin);
      } catch (error) {
        // Installation errors are reported to hooks and isolated per plugin.
        saved.forEach((snapshot) => restoreRegistry(snapshot));
        installFailedPluginIds.add(plugin.id);
        this.hooks.onError?.(error, context);
      }
    }

    const lifecycle = new PluginLifecycle(installSucceededPlugins, this.hooks);
    const initialized = lifecycle.initialize(context);
    const failedPluginIds = [...new Set([...initialized.failedPluginIds, ...installFailedPluginIds])];

    let mergedHooks: FormHooks = {};
    const mergedSubmissionHandlers: SubmissionHandlerDefinition[] = [];
    const mergedWasmPlugins: WasmPluginContribution[] = [];
    const mergedValidators: ValidationStage[] = [];
    for (const plugin of installSucceededPlugins) {
      mergedHooks = mergeFormHooks(mergedHooks, plugin.hooks);
      for (const handler of plugin.submissionHandlers ?? []) {
        mergedSubmissionHandlers.push(handler);
      }
      if (plugin.wasmPlugin) {
        mergedWasmPlugins.push(plugin.wasmPlugin);
      }
      mergedValidators.push(...(plugin.validators ?? []));
    }

    return {
      installedPluginIds,
      incompatiblePluginIds: incompatibilities.map((entry) => entry.pluginId),
      incompatibilities,
      initializedPluginIds: initialized.initializedPluginIds,
      failedPluginIds,
      mergedHooks,
      mergedSubmissionHandlers,
      mergedWasmPlugins,
      mergedValidators,
      mergedFormulaFunctions: this.registries.formulaFunctions?.functions() ?? {}
    };
  }
}
