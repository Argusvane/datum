/*
 * The forms the feature-coverage scenarios mount, by name: each one taken from the engine's own
 * test corpus (engine/tests/fixtures, engine/tests/form-tests/fixtures), never written here, so the
 * harness judges the renderer on the definitions the engine's other suites already run.
 * engine/tests/builder-form-tests defines its forms inline in each test and exports none; a
 * scenario that needs one of those shapes adds it to a corpus fixture file first.
 *
 * A fixture is a function so every mount gets a fresh copy the runtime may change.
 */
import type { DataSourceSet } from "../../form-engine/core/schema/contracts.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { defineDataSources } from "../../form-engine/data/host/data-source-set.js";
import { AGENT_SINGLE_FORM, AGENT_STEPS_FORM, PROVINCES, TRAVEL_CLAIM_FORM } from "../../tests/fixtures/agent-form.js";
import { coverageChromeForm, coverageDatesForm, coverageGridForm, coverageOneBoxForm, coverageSummaryForm, coverageTabsForm } from "../../tests/fixtures/coverage-forms.js";
import { BEHAVIOUR_FIXTURES } from "./fixtures-behaviour.js";
import { OTHER_FIXTURES } from "./fixtures-other.js";
import { presentationForm } from "../../tests/fixtures/presentation-form.js";
import { FORM_TESTS_FIXTURE } from "../../tests/form-tests/fixtures/form-tests-fixture.js";

export interface CoverageFixture {
  /** Where the form lives in the corpus (repo-relative from engine/), for the report. */
  source: string;
  definition(): FormDefinition;
  /** The data sources the form reads, as the corpus's own tests wire them. */
  dataSources?(): DataSourceSet;
  /**
   * The entries `unsupported()` lists for this form under Datum, when the form is made to hold
   * what nothing draws. Any other entry fails the shared `unsupported` assertion: Datum draws
   * every engine type.
   */
  unsupported?: readonly string[];
}

const copy = (definition: FormDefinition): FormDefinition => structuredClone(definition);
const provinces = (): DataSourceSet => defineDataSources({ provinces: PROVINCES });

export const FIXTURES: Readonly<Record<string, CoverageFixture>> = {
  ...BEHAVIOUR_FIXTURES,
  ...OTHER_FIXTURES,
  /** One page with every kind: required text, bounded number, date in a fieldset, rules, choices, a grid, a file, tabs, html, a submit button. */
  single: { source: "tests/fixtures/agent-form.ts AGENT_SINGLE_FORM", definition: () => copy(AGENT_SINGLE_FORM) },
  /** A steps container (a required name on step 1) and a field outside it. */
  steps: { source: "tests/fixtures/agent-form.ts AGENT_STEPS_FORM", definition: () => copy(AGENT_STEPS_FORM) },
  /** Required traveller and amount, a date, an empty expenses grid, a hidden field, a declaration. */
  "travel-claim": { source: "tests/fixtures/agent-form.ts TRAVEL_CLAIM_FORM", definition: () => copy(TRAVEL_CLAIM_FORM) },
  /** The form-tests journey: five pages, a repeating section, a data-source choice, requiredWhen/visibleWhen. */
  journey: { source: "tests/form-tests/fixtures/form-tests-fixture.ts FORM_TESTS_FIXTURE", definition: () => copy(FORM_TESTS_FIXTURE), dataSources: provinces },
  /** The presentations fixture: a journey asking the form through its own nodes, and a one-page variant. */
  presentation: { source: "tests/fixtures/presentation-form.ts presentationForm()", definition: () => presentationForm() },
  /** Errors of every kind a summary line links to: text, radios, a required date, a grid cell, a grid's row bound. */
  "coverage-summary": { source: "tests/fixtures/coverage-forms.ts coverageSummaryForm()", definition: coverageSummaryForm },
  /** Three tabs with a required field in the last two; en and ar. */
  "coverage-tabs": { source: "tests/fixtures/coverage-forms.ts coverageTabsForm()", definition: coverageTabsForm },
  /** A required date, an optional one and a date in a grid row. */
  "coverage-dates": { source: "tests/fixtures/coverage-forms.ts coverageDatesForm()", definition: coverageDatesForm },
  /** A grid of two text columns, empty to start. */
  "coverage-grid": { source: "tests/fixtures/coverage-forms.ts coverageGridForm()", definition: coverageGridForm },
  /** One required text box: Enter in it is a browser's implicit submission. */
  "coverage-one-box": { source: "tests/fixtures/coverage-forms.ts coverageOneBoxForm()", definition: coverageOneBoxForm },
  /** Header and footer parts, the outlined frame, a language switcher, French for labels, hint, options and words. */
  "coverage-chrome": { source: "tests/fixtures/coverage-forms.ts coverageChromeForm()", definition: coverageChromeForm }
};
