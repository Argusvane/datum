/*
 * The corpus forms the "other behaviour" scenarios mount (narrow tabs, a quiet page change, help
 * bubbles, media labels, unknown components, buttons, signatures): definitions from
 * engine/tests/fixtures/coverage-other-forms.ts and agent-form.ts.
 */
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { AGENT_PARTICIPANTS_FORM, AGENT_SIGNING_BUTTON_FORM } from "../../tests/fixtures/agent-form.js";
import { coverageButtonsForm, coverageMediaForm, coverageTooltipForm, coverageUnknownForm } from "../../tests/fixtures/coverage-other-forms.js";
import type { CoverageFixture } from "./fixtures.js";

const copy = (definition: FormDefinition): FormDefinition => structuredClone(definition);
const other = (name: string): string => `tests/fixtures/coverage-other-forms.ts ${name}()`;

export const OTHER_FIXTURES: Readonly<Record<string, CoverageFixture>> = {
  /** A text box with field help, and one without. */
  "coverage-tooltip": { source: other("coverageTooltipForm"), definition: coverageTooltipForm },
  /** A button group (submit, download) and a PDF button. */
  "coverage-buttons": { source: other("coverageButtonsForm"), definition: coverageButtonsForm },
  /** A field type and a container type nothing draws: the two entries `unsupported()` must list, and no other. */
  "coverage-unknown": { source: other("coverageUnknownForm"), definition: coverageUnknownForm, unsupported: ['dial: component "mystery-dial"', 'box: component "mystery-box"'] },
  /** One text box (its name follows the viewport under the `media-label` adapter). */
  "coverage-media": { source: other("coverageMediaForm"), definition: coverageMediaForm },
  /** A signature component naming who signs. */
  participants: { source: "tests/fixtures/agent-form.ts AGENT_PARTICIPANTS_FORM", definition: () => copy(AGENT_PARTICIPANTS_FORM) },
  /** A submit button that signs with a passkey. */
  "signing-button": { source: "tests/fixtures/agent-form.ts AGENT_SIGNING_BUTTON_FORM", definition: () => copy(AGENT_SIGNING_BUTTON_FORM) }
};
