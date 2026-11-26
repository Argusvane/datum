import type { ComponentDefinition } from "../../core/schema/contracts.js";
import { compareVersions } from "../versioning.js";

export class ComponentRegistry {
  private readonly definitions = new Map<string, ComponentDefinition[]>();

  public register(definition: ComponentDefinition): void {
    const list = this.definitions.get(definition.type) ?? [];
    if (list.some((d) => d.version === definition.version)) {
      throw new Error(
        `Component ${definition.type}@${definition.version} is already registered`
      );
    }

    list.push(definition);
    list.sort((a, b) => compareVersions(a.version, b.version));
    this.definitions.set(definition.type, list);
  }

  public resolve(type: string, version?: string): ComponentDefinition {
    const list = this.definitions.get(type);
    if (!list || list.length === 0) {
      throw new Error(`No component registered for type: ${type}`);
    }

    if (version) {
      const exact = list.find((d) => d.version === version);
      if (!exact) {
        throw new Error(`No component registered for type ${type} version ${version}`);
      }
      return exact;
    }

    const latest = list[list.length - 1];
    if (!latest) {
      throw new Error(`No component registered for type: ${type}`);
    }
    return latest;
  }

  public list(type: string): ComponentDefinition[] {
    return [...(this.definitions.get(type) ?? [])];
  }

  /** The latest definition of every registered type, in the order the types were first registered. */
  public latest(): ComponentDefinition[] {
    const out: ComponentDefinition[] = [];
    for (const list of this.definitions.values()) {
      const latest = list[list.length - 1];
      if (latest) {
        out.push(latest);
      }
    }
    return out;
  }
}
