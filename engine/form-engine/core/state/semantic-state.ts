import type { ComponentNode } from "../schema/types.js";
import type {
  HiddenRequiredBehavior,
  HiddenValidationBehavior,
  HiddenValueBehavior,
  SemanticNodeState
} from "./effective-state.js";

/**
 * A node's semantic state from its configuration flags alone — `hidden`, `disabled`,
 * `readOnly` and the three hidden-behaviour policies — before any rule is evaluated.
 *
 * Written the validation kernel's way (top-level `function` declarations, type-only
 * imports, no module constants) because it runs in two places: the browser runtime's
 * orchestrator, and the sandbox program, where a server re-validating a submission
 * folds visibility the way the browser did. {@link SEMANTIC_STATE_FUNCTIONS} lists them.
 */

/** `configuration[key] === true`, for a configuration that is an object. */
export function kernelReadFlag(configuration: unknown, key: string): boolean {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return false;
  }
  return (configuration as Record<string, unknown>)[key] === true;
}

/** `configuration[key]` when it is one of `allowed`. */
export function kernelReadEnum(configuration: unknown, key: string, allowed: readonly string[]): string | undefined {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return undefined;
  }
  const raw = (configuration as Record<string, unknown>)[key];
  return typeof raw === "string" && allowed.indexOf(raw) >= 0 ? raw : undefined;
}

/** The node's semantic state from its configuration alone. */
export function kernelBaseSemanticState(node: ComponentNode): SemanticNodeState {
  const configuration = node.configuration;
  const state: SemanticNodeState = {
    visible: !kernelReadFlag(configuration, "hidden"),
    disabled: kernelReadFlag(configuration, "disabled"),
    readonly: kernelReadFlag(configuration, "readOnly")
  };
  const valueBehavior = kernelReadEnum(configuration, "hiddenValueBehavior", ["retain", "clear", "exclude-from-submission"]);
  if (valueBehavior !== undefined) {
    state.hiddenValueBehavior = valueBehavior as HiddenValueBehavior;
  }
  const validationBehavior = kernelReadEnum(configuration, "hiddenValidationBehavior", ["validate", "skip"]);
  if (validationBehavior !== undefined) {
    state.hiddenValidationBehavior = validationBehavior as HiddenValidationBehavior;
  }
  const requiredBehavior = kernelReadEnum(configuration, "hiddenRequiredBehavior", ["required", "not-required"]);
  if (requiredBehavior !== undefined) {
    state.hiddenRequiredBehavior = requiredBehavior as HiddenRequiredBehavior;
  }
  return state;
}

/** For the sandbox program: every function above. */
export const SEMANTIC_STATE_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelReadFlag,
  kernelReadEnum,
  kernelBaseSemanticState
];
