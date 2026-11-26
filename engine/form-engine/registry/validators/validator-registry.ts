import type { ValidationStage } from "../../core/schema/contracts.js";
import { compareVersions } from "../versioning.js";

export class ValidatorRegistry {
  private readonly definitions = new Map<string, ValidationStage[]>();

  public register(definition: ValidationStage): void {
    const list = this.definitions.get(definition.id) ?? [];

    if (list.some((d) => d.version === definition.version)) {
      throw new Error(
        `Validator ${definition.id}@${definition.version} is already registered`
      );
    }

    list.push(definition);
    list.sort((a, b) => compareVersions(a.version, b.version));
    this.definitions.set(definition.id, list);
  }

  public resolve(id: string, version?: string): ValidationStage {
    const list = this.definitions.get(id);
    if (!list || list.length === 0) {
      throw new Error(`No validator registered for id: ${id}`);
    }

    if (version) {
      const exact = list.find((d) => d.version === version);
      if (!exact) {
        throw new Error(`No validator registered for id ${id} version ${version}`);
      }
      return exact;
    }

    const latest = list[list.length - 1];
    if (!latest) {
      throw new Error(`No validator registered for id: ${id}`);
    }
    return latest;
  }
}
