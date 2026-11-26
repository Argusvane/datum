import type { SubmissionHandlerDefinition } from "../../core/submission/submission-handler.js";
import { compareVersions } from "../versioning.js";

export class SubmissionHandlerRegistry {
  private readonly handlers = new Map<string, SubmissionHandlerDefinition[]>();

  public register(definition: SubmissionHandlerDefinition): void {
    const list = this.handlers.get(definition.id) ?? [];
    if (list.some((entry) => entry.version === definition.version)) {
      throw new Error(
        `Submission handler ${definition.id}@${definition.version} is already registered`
      );
    }
    list.push(definition);
    list.sort((a, b) => compareVersions(a.version, b.version));
    this.handlers.set(definition.id, list);
  }

  /** All registered handlers, latest version of each, in registration order. */
  public listLatest(): SubmissionHandlerDefinition[] {
    const result: SubmissionHandlerDefinition[] = [];
    for (const versions of this.handlers.values()) {
      const latest = versions[versions.length - 1];
      if (latest) {
        result.push(latest);
      }
    }
    return result;
  }
}
