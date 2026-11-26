import { kernelReadEnum } from "../state/semantic-state.js";

/**
 * When a field is checked as its answer is committed, the author's one choice per form
 * (`root.configuration.validateOn`, journeys included):
 *
 * - `"commitAfterError"` (the default): a committed answer is checked again once its field
 *   shows an error, or once the person has tried to go on (a submit, a journey page's Continue,
 *   a steps container's Continue) for the fields that attempt covered. A field is never checked
 *   on first blur.
 * - `"submit"`: answers are judged only when the person tries to go on; leaving a field checks
 *   nothing.
 */
export const VALIDATE_ON_SETTINGS = ["submit", "commitAfterError"] as const;
export type ValidateOnSetting = (typeof VALIDATE_ON_SETTINGS)[number];
export const DEFAULT_VALIDATE_ON: ValidateOnSetting = "commitAfterError";

/** The root configuration's value; an absent value or any other word reads as the default. */
export function readValidateOnSetting(rootConfiguration: unknown): ValidateOnSetting {
  return (kernelReadEnum(rootConfiguration, "validateOn", VALIDATE_ON_SETTINGS) as ValidateOnSetting | undefined) ?? DEFAULT_VALIDATE_ON;
}
