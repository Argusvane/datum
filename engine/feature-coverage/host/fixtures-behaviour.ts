/*
 * The corpus forms the behaviour scenarios mount (count, files, locks, pending and busy, notices,
 * data sources, translations): definitions from engine/tests/fixtures/feature-coverage-forms.ts.
 * What the sources answer and the checks say is given at load time by recipe (behaviours.ts).
 */
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import {
  COVERAGE_CHECKS_FORM,
  COVERAGE_CHECKS_SUBMIT_FORM,
  COVERAGE_COUNTS_FORM,
  COVERAGE_LOCKS_FORM,
  COVERAGE_SOURCES_FORM,
  COVERAGE_TRANSLATED_FORM
} from "../../tests/fixtures/feature-coverage-forms.js";
import type { CoverageFixture } from "./fixtures.js";

const copy = (definition: FormDefinition): FormDefinition => structuredClone(definition);
const source = (name: string): string => `tests/fixtures/feature-coverage-forms.ts ${name}`;

export const BEHAVIOUR_FIXTURES: Readonly<Record<string, CoverageFixture>> = {
  /** Two text boxes and a textarea with a length limit and a visible count each. */
  counts: { source: source("COVERAGE_COUNTS_FORM"), definition: () => copy(COVERAGE_COUNTS_FORM) },
  /** A required name, an email, a nickname, a tip and a submit button (async check and warnings by recipe). */
  checks: { source: source("COVERAGE_CHECKS_FORM"), definition: () => copy(COVERAGE_CHECKS_FORM) },
  /** The same form with `validateOn: "submit"`. */
  "checks-submit": { source: source("COVERAGE_CHECKS_SUBMIT_FORM"), definition: () => copy(COVERAGE_CHECKS_SUBMIT_FORM) },
  /** A text and two choice fields fed by data sources (the `sources` recipe). */
  sources: { source: source("COVERAGE_SOURCES_FORM"), definition: () => copy(COVERAGE_SOURCES_FORM) },
  /** Fields read-only or disabled by their own configuration, beside a free one. */
  locks: { source: source("COVERAGE_LOCKS_FORM"), definition: () => copy(COVERAGE_LOCKS_FORM) },
  /** A French form: labels, hint, options, a message and the engine's own words (the `texts` kind). */
  translated: { source: source("COVERAGE_TRANSLATED_FORM"), definition: () => copy(COVERAGE_TRANSLATED_FORM) }
};
