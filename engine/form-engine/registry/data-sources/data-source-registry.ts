import { compareVersions } from "../versioning.js";
import type { DataSourceDefinition } from "../../core/schema/contracts.js";

export type { DataSourceDefinition } from "../../core/schema/contracts.js";

export class DataSourceRegistry {
  private readonly definitions = new Map<string, DataSourceDefinition[]>();

  public register(definition: DataSourceDefinition): void {
    const list = this.definitions.get(definition.id) ?? [];
    if (list.some((d) => d.version === definition.version)) {
      throw new Error(`Data source ${definition.id}@${definition.version} is already registered`);
    }

    list.push(definition);
    list.sort((a, b) => compareVersions(a.version, b.version));
    this.definitions.set(definition.id, list);
  }

  /** Every registered source id, in registration order — what a builder's data-source picker offers. */
  public ids(): string[] {
    return [...this.definitions.keys()];
  }

  public resolve(id: string, version?: string): DataSourceDefinition {
    const list = this.definitions.get(id);
    if (!list || list.length === 0) {
      throw new Error(`No data source registered for id: ${id}`);
    }

    if (version) {
      const exact = list.find((definition) => definition.version === version);
      if (!exact) {
        throw new Error(`No data source registered for id ${id} version ${version}`);
      }
      return exact;
    }

    const latest = list[list.length - 1];
    if (!latest) {
      throw new Error(`No data source registered for id: ${id}`);
    }
    return latest;
  }
}
