import { randomUUID } from "node:crypto";

import { resolveGenerators } from "../../../fixtures/builders.js";
import { validValues } from "../../../fixtures/base-form.js";
import type { Json } from "../../../observation.js";
import type { CheckParts, Profile } from "./types.js";

export const DEFAULT_JOURNEY = "main";

export function valuesOf(parts: CheckParts): Json {
  return resolveGenerators((parts.values ?? (validValues() as Json)) as Json);
}

/** JSON.stringify keeps an own `__proto__` key (the hostile vectors build them with defineProperty). */
export function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function envelope(target: { formId: string; formVersion: string }, parts: CheckParts): Record<string, unknown> {
  const submission: Record<string, unknown> = {};
  if (parts.omitLocale !== true) {
    submission["locale"] = "locale" in parts ? parts.locale : "en";
  }
  if (parts.omitValues !== true) {
    submission["values"] = valuesOf(parts);
  }
  if ("journeyIdRaw" in parts) {
    submission["journey"] = { id: parts.journeyIdRaw };
  } else if (parts.journeyId !== null) {
    submission["journey"] = { id: parts.journeyId ?? DEFAULT_JOURNEY };
  }
  return {
    versionContext: {
      form: { id: parts.formId ?? target.formId, version: parts.formVersion ?? target.formVersion },
      client: { runtimeVersion: "security-suite", rendererVersion: "security-suite", schemaVersion: "1" }
    },
    submission
  };
}

/**
 * The `@argusvane/datum-submissions` wire (`ReceiveInput` / `ValidateInput`, service.ts): both routes take
 * `{document}`; a check adds `scope` (and `pageId`), a delivery its `submissionKey`. The delivered
 * document is the envelope.
 */
export const submissionsProfile: Profile = {
  name: "submissions",
  checkBody(target, parts) {
    const body: Record<string, unknown> = { document: envelope(target, parts) };
    if (parts.omitScope !== true) {
      body["scope"] = "scope" in parts ? parts.scope : "journey";
    }
    if (parts.pageId !== undefined) {
      body["pageId"] = parts.pageId;
    }
    return stringify({ ...body, ...(parts.extra ?? {}) });
  },
  submitBody(target, parts, deliver) {
    const built = envelope(target, parts);
    const submissionKey = parts.submissionKey === undefined ? randomUUID() : parts.submissionKey;
    return stringify({ document: deliver !== undefined ? deliver(built) : built, ...(submissionKey !== null ? { submissionKey } : {}), ...(parts.extra ?? {}) });
  }
};
