import type { Json } from "../../../observation.js";
import type { Gen } from "../../../vectors/schema.js";
import type { EndpointTarget, ProfileName } from "../http.js";

/**
 * A logical check or submission, before a profile puts it on the wire. Every field that is left
 * out takes the fixture's own value (`omit*` flags leave a member out of the body altogether).
 */
export interface CheckParts {
  values?: Json | Gen;
  omitValues?: boolean;
  locale?: unknown;
  omitLocale?: boolean;
  formId?: string;
  formVersion?: string;
  /** `null`: no journey at all. */
  journeyId?: string | null;
  /**
   * The journey id exactly as given, whatever its type (a number, `null`, `"__proto__"`): sent as
   * `journeyId` on a check and as `submission.journey.id` on a submission. Takes precedence over
   * `journeyId`.
   */
  journeyIdRaw?: Json;
  scope?: unknown;
  omitScope?: boolean;
  pageId?: unknown;
  /**
   * The submission's key (the receive route only): absent, a fresh one per body, as a browser mints
   * one per submit attempt; a string, that key (a retry of one attempt sends the same); `null`, no key.
   */
  submissionKey?: string | null;
  /** Members added to the body's top level (the receive route refuses a `scope` or `pageId` there). */
  extra?: Record<string, Json>;
}

export interface Profile {
  name: ProfileName;
  /** The JSON body of a check (the validate route). */
  checkBody(target: EndpointTarget, parts: CheckParts): string;
  /** The JSON body of a submission (the receive route). */
  submitBody(target: EndpointTarget, parts: CheckParts, deliver?: (envelope: Record<string, unknown>) => unknown): string;
}
