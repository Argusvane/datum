import type { ErrorPresentationConfiguration } from "./render-contracts.js";

export interface ErrorPresentationPolicy {
  showInlineErrors: boolean;
  showSummary: boolean;
  summaryPosition: "top" | "bottom" | "custom";
  focusFirstError: boolean;
}

/**
 * What the page or host asked for (`config`) over what the form's definition says
 * (`definitionFocusFirstError`, `accessibility.focusFirstError`) over the default. Focus going
 * to the first error is the default; a form whose author turned it off keeps focus on the
 * summary, unless the host set it itself.
 */
export function resolveErrorPresentationPolicy(
  config: ErrorPresentationConfiguration,
  definitionFocusFirstError?: boolean
): ErrorPresentationPolicy {
  // Summary visibility is intentionally independent from inline error visibility.
  return {
    showInlineErrors: config.showComponentErrors,
    showSummary: config.showErrorSummary,
    summaryPosition: config.errorSummaryPosition ?? "top",
    focusFirstError: config.focusFirstError ?? definitionFocusFirstError ?? true
  };
}

/**
 * What stops a field from taking input, kept as separate facts (the model carries each as its
 * own flag so a drawing surface can treat them differently):
 *
 * - `disabled`: the field is switched off, by its own configuration or `enabledWhen` or an
 *   ancestor's. Nothing is submitted from it as a person's answer and it is out of the tab order.
 * - `readOnly`: the field shows an answer it will not take, by its own configuration, a rule or
 *   an ancestor's, because a presentation works its value out, or because the render mode is a
 *   review. A read-only control stays focusable where its kind allows it.
 * - `lockedByMode`: the render mode (readonly, pdf) is what makes every field read-only, not
 *   anything the field itself says. Always `false` while the form is interactive.
 *
 * `disabled` never implies `readOnly` or the other way round; a surface that disables a
 * control for either reason (the HTML controls without a readonly attribute) joins the two
 * itself.
 */
export interface FieldLocking {
  readOnly: boolean;
  disabled: boolean;
  lockedByMode: boolean;
}

export interface FieldLockingInput {
  /** The render mode makes every field read-only (`readonly` and `pdf` modes). */
  readOnlyByMode: boolean;
  /** A worked-out value's copy: never a control the person can change. */
  workedOut: boolean;
  /** The runtime's effective state for the field, when it supplies one; its flags then replace the configuration's. */
  effective?: { readonly readonly: boolean; readonly disabled: boolean } | undefined;
  /** The field's own `configuration.readOnly` / `configuration.disabled`, used when no effective state is supplied. */
  configured: { readonly readOnly: boolean; readonly disabled: boolean };
}

export function resolveFieldLocking(input: FieldLockingInput): FieldLocking {
  const own = input.effective
    ? { readOnly: input.effective.readonly, disabled: input.effective.disabled }
    : input.configured;
  return {
    readOnly: input.readOnlyByMode || input.workedOut || own.readOnly,
    disabled: own.disabled,
    lockedByMode: input.readOnlyByMode
  };
}
