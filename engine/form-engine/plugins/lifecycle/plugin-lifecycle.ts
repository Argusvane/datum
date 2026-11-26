import type {
  FormPlugin,
  PluginContext,
  PluginLifecycleHooks
} from "../../core/schema/contracts.js";

export interface PluginInitializationResult {
  initializedPluginIds: string[];
  failedPluginIds: string[];
}

export class PluginLifecycle {
  constructor(
    private readonly plugins: FormPlugin[],
    private readonly hooks: PluginLifecycleHooks = {}
  ) {}

  public initialize(context: PluginContext): PluginInitializationResult {
    const initializedPluginIds: string[] = [];
    const failedPluginIds: string[] = [];

    for (const plugin of this.plugins) {
      try {
        this.hooks.beforeInitialize?.(context);
        plugin.initialize?.(context);
        this.hooks.afterInitialize?.(context);
        initializedPluginIds.push(plugin.id);
      } catch (error) {
        failedPluginIds.push(plugin.id);
        this.hooks.onError?.(error, context);
      }
    }

    return {
      initializedPluginIds,
      failedPluginIds
    };
  }
}
