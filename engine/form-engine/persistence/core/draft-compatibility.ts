import { DraftError, type FormDraft } from "./draft-store.js";

/** The host's rule for which of its own form versions a draft may come back into. */
export interface DraftCompatibilityPolicy {
  /** Allowed `draft.formVersion` values; when omitted, any is allowed. */
  allowedFormVersions?: string[];
}

export interface DraftCompatibilityResult {
  compatible: boolean;
  issues: string[];
}

/**
 * Checks a draft against the runtime it is being restored into: its schema version must be the
 * runtime's, and its form version one the host's policy allows (any, without a policy).
 */
export function evaluateDraftCompatibility(
  draft: FormDraft,
  runtime: { formVersion: string; schemaVersion: string },
  policy: DraftCompatibilityPolicy = {}
): DraftCompatibilityResult {
  const issues: string[] = [];

  if (policy.allowedFormVersions && !policy.allowedFormVersions.includes(draft.formVersion)) {
    issues.push(
      `draft form version ${draft.formVersion} is not in [${policy.allowedFormVersions.join(", ")}]`
    );
  }

  if (draft.runtime.schemaVersion !== runtime.schemaVersion) {
    issues.push(
      `draft schema version ${draft.runtime.schemaVersion} is incompatible with runtime schema ${runtime.schemaVersion}`
    );
  }

  return { compatible: issues.length === 0, issues };
}

export function assertDraftCompatible(
  draft: FormDraft,
  runtime: { formVersion: string; schemaVersion: string },
  policy?: DraftCompatibilityPolicy
): void {
  const result = evaluateDraftCompatibility(draft, runtime, policy);
  if (!result.compatible) {
    throw new DraftError("draft.incompatible", `Draft is incompatible: ${result.issues.join("; ")}`);
  }
}
