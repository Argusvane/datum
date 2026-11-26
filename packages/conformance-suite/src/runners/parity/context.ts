import { BASE_FORM_ID } from "../../fixtures/base-form.js";
import { buildRoot, resolveGenerators } from "../../fixtures/builders.js";
import type { Fixture, VectorInput } from "../../vectors/schema.js";

/**
 * The context a values input stands for, as the program runner builds it (a copy: that runner's
 * method is private and another stage owns the file). Both parity sides serialize this one object
 * with the same ABI, so any difference they show is the engines', never the inputs'.
 */
export function contextFor(fixture: Pick<Fixture, "definition" | "patch" | "policy" | "snapshot">, input: Extract<VectorInput, { kind: "values" }>): Record<string, unknown> {
  const context: Record<string, unknown> = {
    formId: BASE_FORM_ID,
    values: resolveGenerators(input.values),
    locale: "locale" in input ? input.locale : "en",
    form: buildRoot(fixture)
  };
  if (input.translations !== undefined) {
    context["translations"] = input.translations;
  }
  if (input.catalog !== undefined) {
    context["catalog"] = input.catalog;
  }
  if (input.today !== undefined) {
    context["today"] = input.today;
  }
  if (input.hostContext !== undefined) {
    context["hostContext"] = input.hostContext;
  }
  if (input.document !== undefined) {
    context["document"] = input.document;
  }
  if (input.logLevel !== undefined) {
    context["logLevel"] = input.logLevel;
  }
  if (fixture.policy?.formulaErrors !== undefined) {
    context["formulaErrors"] = fixture.policy.formulaErrors;
  }
  if (fixture.policy?.riskyPatterns !== undefined) {
    context["riskyPatterns"] = fixture.policy.riskyPatterns;
  }
  if (fixture.policy?.unknownFields !== undefined) {
    context["unknownFields"] = fixture.policy.unknownFields;
  }
  if (fixture.snapshot !== undefined) {
    context["optionSnapshot"] = fixture.snapshot;
  }
  return context;
}
