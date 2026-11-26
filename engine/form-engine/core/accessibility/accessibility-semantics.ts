import type { FormError } from "../errors/form-error.js";
import type { ComponentPath } from "../schema/types.js";
import { stringifyComponentPath } from "../tree/component-path.js";

export type LabelPosition = "top" | "left" | "hidden";
export type TextDirection = "ltr" | "rtl";

export interface AccessibilityOptions {
  labelPosition?: LabelPosition;
  announceErrors?: boolean;
  focusFirstError?: boolean;
  keyboardMode?: "standard" | "wizard";
  locale?: string;
  textDirection?: TextDirection;
  /**
   * Describe the control by its notices as well: {@link AccessibilitySemantics.noticeId} joins
   * `ariaDescribedBy`, after the description. Set by a drawing surface that draws notices under
   * that id; left off, the notice id is reported but never referenced, so no control points at
   * an element that is not there.
   */
  describeNotices?: boolean;
}

export interface AccessibilitySemantics {
  fieldId: string;
  labelId: string;
  descriptionId?: string | undefined;
  /** The character count's limit sentence, described to the control beside its description. */
  countId?: string | undefined;
  errorId?: string | undefined;
  /**
   * The id of the field's notices (warnings and info, which never block): present when the
   * field has any. Unlike {@link errorId} it does not mark the field invalid.
   */
  noticeId?: string | undefined;
  required: boolean;
  invalid: boolean;
  readonly: boolean;
  disabled: boolean;
  labelPosition: LabelPosition;
  textDirection: TextDirection;
  ariaDescribedBy: string[];
}

export interface SemanticsInput {
  componentId: string;
  path?: ComponentPath;
  required: boolean;
  readonly: boolean;
  disabled: boolean;
  errors: FormError[];
  hasDescription?: boolean;
  hasCount?: boolean;
  options?: AccessibilityOptions;
}

export function buildAccessibilitySemantics(
  input: SemanticsInput
): AccessibilitySemantics {
  const instanceSuffix = input.path ? `-${stringifyComponentPath(input.path).replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
  const fieldId = `${input.componentId}${instanceSuffix}`;
  const labelId = `${fieldId}__label`;
  const descriptionId = input.hasDescription ? `${fieldId}__description` : undefined;
  const countId = input.hasCount ? `${fieldId}__count` : undefined;
  const invalid = input.errors.some((error) => (error.severity ?? "error") === "error");
  const errorId = invalid ? `${fieldId}__error` : undefined;
  const hasNotices = input.errors.some((error) => (error.severity ?? "error") !== "error");
  const noticeId = hasNotices ? `${fieldId}__notice` : undefined;

  const ariaDescribedBy: string[] = [];
  if (descriptionId) {
    ariaDescribedBy.push(descriptionId);
  }
  if (noticeId && input.options?.describeNotices === true) {
    ariaDescribedBy.push(noticeId);
  }
  if (countId) {
    ariaDescribedBy.push(countId);
  }
  if (errorId) {
    ariaDescribedBy.push(errorId);
  }

  return {
    fieldId,
    labelId,
    descriptionId,
    countId,
    errorId,
    noticeId,
    required: input.required,
    invalid,
    readonly: input.readonly,
    disabled: input.disabled,
    labelPosition: input.options?.labelPosition ?? "top",
    textDirection: input.options?.textDirection ?? "ltr",
    ariaDescribedBy
  };
}
