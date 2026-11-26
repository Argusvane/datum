import type {
  FormPlugin,
  PluginDependency,
  PluginContext
} from "../../core/schema/contracts.js";
import { compareVersions } from "../versioning.js";
import { satisfies } from "../version-range.js";

export class PluginRegistry {
  private readonly plugins = new Map<string, FormPlugin[]>();

  public register(plugin: FormPlugin): void {
    const list = this.plugins.get(plugin.id) ?? [];
    if (list.some((entry) => entry.version === plugin.version)) {
      throw new Error(`Plugin ${plugin.id}@${plugin.version} is already registered`);
    }

    list.push(plugin);
    list.sort((a, b) => compareVersions(a.version, b.version));
    this.plugins.set(plugin.id, list);
  }

  /**
   * Resolves a plugin by id. `versionOrRange` is a version-range spec: a bare
   * `1.2.3` matches only that version; `^1.2.0` / `~1.2` / `>=1.0.0` / `1.x` select the
   * highest registered version that satisfies the range. Omitted → highest registered.
   */
  public resolve(id: string, versionOrRange?: string): FormPlugin {
    const list = this.plugins.get(id);
    if (!list || list.length === 0) {
      throw new Error(`No plugin registered for id: ${id}`);
    }

    if (versionOrRange) {
      const match = list
        .filter((entry) => satisfies(entry.version, versionOrRange))
        .sort((a, b) => compareVersions(a.version, b.version))
        .pop();
      if (!match) {
        throw new Error(`No plugin for id ${id} satisfies ${versionOrRange}`);
      }
      return match;
    }

    const latest = list[list.length - 1];
    if (!latest) {
      throw new Error(`No plugin registered for id: ${id}`);
    }
    return latest;
  }

  public initializeAll(context: PluginContext): void {
    for (const plugin of this.listLatest()) {
      plugin.initialize?.(context);
    }
  }

  public listLatest(): FormPlugin[] {
    const result: FormPlugin[] = [];
    for (const versions of this.plugins.values()) {
      const latest = versions[versions.length - 1];
      if (latest) {
        result.push(latest);
      }
    }
    return result;
  }

  public resolveDependencyOrder(seedPluginIds?: string[]): FormPlugin[] {
    const latestById = new Map(this.listLatest().map((plugin) => [plugin.id, plugin]));
    const seeds = seedPluginIds ?? [...latestById.keys()];

    const ordered: FormPlugin[] = [];
    const state = new Map<string, "visiting" | "visited">();

    const walk = (dependency: PluginDependency): void => {
      const phase = state.get(dependency.id);
      if (phase === "visiting") {
        throw new Error(`Plugin dependency cycle detected at ${dependency.id}`);
      }
      if (phase === "visited") {
        return;
      }

      state.set(dependency.id, "visiting");

      const plugin = dependency.versionRange
        ? this.resolve(dependency.id, dependency.versionRange)
        : latestById.get(dependency.id);
      if (!plugin) {
        throw new Error(`Plugin dependency not found: ${dependency.id}`);
      }

      for (const nested of plugin.dependencies ?? []) {
        walk(nested);
      }

      state.set(dependency.id, "visited");
      ordered.push(plugin);
    };

    for (const id of seeds) {
      walk({ id });
    }

    return ordered;
  }
}
