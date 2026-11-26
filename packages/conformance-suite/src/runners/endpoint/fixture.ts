import { BASE_DEFINITION } from "../../fixtures/base-form.js";

/**
 * The fixture form with the id and version the operator installs it under (a host may limit the
 * characters of a form id, so `datum_security_suite` may be needed). The
 * endpoint run is told the same two values with `--form` and `--form-version`.
 */
export function fixtureDefinition(formId?: string, formVersion?: string): unknown {
  return { ...BASE_DEFINITION, ...(formId !== undefined ? { id: formId } : {}), ...(formVersion !== undefined ? { version: formVersion } : {}) };
}

/**
 * What `fixture --format submissions` prints: the body of `POST /api/forms` (a registration) for a
 * host built on `@argusvane/datum-submissions`, the fixture definition and no special settings (the defaults
 * strip unknown fields and keep the sandbox's default log level).
 */
export function submissionsFixture(formId?: string, formVersion?: string): { definition: unknown; settings: Record<string, unknown> } {
  return { definition: fixtureDefinition(formId, formVersion), settings: {} };
}
