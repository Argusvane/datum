/**
 * What happens to a component's answer while it is hidden (`configuration.hiddenValueBehavior`):
 * `exclude-from-submission` (the default) keeps it in the form's state and leaves it out of the
 * submission; `retain` keeps it and sends it; `clear` sends it empty.
 */
export type HiddenValueBehavior = "retain" | "clear" | "exclude-from-submission";

/**
 * The value a component that sets no `hiddenValueBehavior` has: its hidden answer is left out of
 * the submission. For the builder and other readers outside the kernel; the kernel's functions
 * spell the literal, as they must. A component that asks to be required or validated
 * while hidden is the one exception, see {@link defaultHiddenValueBehaviorFor}.
 */
export const DEFAULT_HIDDEN_VALUE_BEHAVIOR: HiddenValueBehavior = "exclude-from-submission";

/**
 * What a component's hidden answer does when its configuration names no `hiddenValueBehavior`,
 * the rule {@link computeEffectiveNodeState} applies: left out of the submission, unless the
 * component asks to be required (`hiddenRequiredBehavior: "required"`) or validated
 * (`hiddenValidationBehavior: "validate"`) while hidden. Such a component is one whose hidden
 * answer matters (a host or a default fills it in), so it is kept and sent: leaving it out
 * would make its Required impossible to meet and its checks read nothing.
 */
export function defaultHiddenValueBehaviorFor(configuration: unknown): HiddenValueBehavior {
  const record = configuration && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>) : {};
  return record.hiddenRequiredBehavior === "required" || record.hiddenValidationBehavior === "validate" ? "retain" : DEFAULT_HIDDEN_VALUE_BEHAVIOR;
}

export type HiddenValidationBehavior = "validate" | "skip";
export type HiddenRequiredBehavior = "required" | "not-required";

export interface SemanticNodeState {
  visible: boolean;
  disabled: boolean;
  readonly: boolean;
  hiddenValueBehavior?: HiddenValueBehavior;
  hiddenValidationBehavior?: HiddenValidationBehavior;
  hiddenRequiredBehavior?: HiddenRequiredBehavior;
}

export interface EffectiveNodeState {
  visible: boolean;
  disabled: boolean;
  readonly: boolean;
  runValidation: boolean;
  requiredApplies: boolean;
  submitValue: boolean;
  clearValue: boolean;
}

export function computeEffectiveNodeState(
  own: SemanticNodeState,
  ancestorChain: SemanticNodeState[]
): EffectiveNodeState {
  // Effective visibility is conjunctive across the ancestor chain.
  const ancestorHidden = ancestorChain.some((state) => !state.visible);
  const visible = own.visible && !ancestorHidden;

  const disabled = own.disabled || ancestorChain.some((state) => state.disabled);
  const readonly = own.readonly || ancestorChain.some((state) => state.readonly);

  const hiddenValidationBehavior = own.hiddenValidationBehavior ?? "skip";
  const hiddenRequiredBehavior = own.hiddenRequiredBehavior ?? "not-required";
  // A hidden answer is left out of the submission unless the component says otherwise: kept in
  // the form's state (showing the field again shows it), not sent while hidden. A component
  // that asks to be required or validated while hidden keeps and sends it: its hidden answer is
  // the one those checks read (`defaultHiddenValueBehaviorFor`, the same rule for the builder).
  const hiddenValueBehavior =
    own.hiddenValueBehavior ?? (hiddenRequiredBehavior === "required" || hiddenValidationBehavior === "validate" ? "retain" : "exclude-from-submission");

  if (visible) {
    return {
      visible,
      disabled,
      readonly,
      runValidation: true,
      requiredApplies: true,
      submitValue: true,
      clearValue: false
    };
  }

  return {
    visible,
    disabled,
    readonly,
    runValidation: hiddenValidationBehavior === "validate",
    requiredApplies: hiddenRequiredBehavior === "required",
    // Hidden value policy is split from hidden validation/required policies.
    submitValue: hiddenValueBehavior !== "exclude-from-submission",
    clearValue: hiddenValueBehavior === "clear"
  };
}
