import { describe, expect, it } from "vitest";

import type { FormulaErrorPolicy } from "../form-engine/core/expressions/expression.js";
import type { PresentationNode } from "../form-engine/core/schema/journey.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { presentationForm } from "./fixtures/presentation-form.js";

// A journey's own field with a pattern no browser can compile: the presentation's constraints
// stage fails a non-empty answer closed only under the formula policy in force, as the form's
// own stage and the sandbox do.
function runtimeFor(formulaErrors: FormulaErrorPolicy | undefined): FormRuntime {
  const definition = presentationForm();
  const details = (definition.journey as { journeys: Array<{ pages: Array<{ components: unknown[] }> }> }).journeys[0]!.pages[0]!;
  (details.components as PresentationNode[]).push({ id: "nick", type: "text", configuration: { label: "Nick", pattern: "(" } } as PresentationNode);
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const runtime = new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
    journeyEngine: EagerJourneyEngine,
    ...(formulaErrors !== undefined ? { formulaErrors } : {})
  });
  runtime.startJourney("apply");
  runtime.setValue("@apply.nick", "abc");
  return runtime;
}

async function nickPatternErrors(runtime: FormRuntime): Promise<unknown[]> {
  const errors = await runtime.validate();
  return errors.filter((error) => error.code === "pattern" && error.componentId === "nick");
}

describe("a presentation's own field constraints", () => {
  it("fail a pattern they cannot run closed by default", async () => {
    expect(await nickPatternErrors(runtimeFor(undefined))).toHaveLength(1);
  });

  it("follow the host's warn", async () => {
    expect(await nickPatternErrors(runtimeFor("warn"))).toEqual([]);
  });
});
