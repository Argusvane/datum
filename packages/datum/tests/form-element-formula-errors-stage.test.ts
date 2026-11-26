import { describe, expect, it } from "vitest";

import type { FormDefinition } from "@argusvane/datum-engine";
import { createFormRuntime } from "../src/runtime-factory.js";

// A pattern no browser can compile: the field-constraints stage does not run it, and fails a
// non-empty answer closed only under `formulaErrors: "fail"`, the word the sandbox reads too.
function definition(formulaErrors?: string): FormDefinition {
  return {
    id: "f",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: {
      id: "form",
      type: "form",
      configuration: formulaErrors !== undefined ? { formulaErrors } : {},
      children: { content: [{ id: "code", type: "text", configuration: { label: "Code", pattern: "(" } }] }
    }
  } as unknown as FormDefinition;
}

async function patternErrors(form: FormDefinition, config: Parameters<typeof createFormRuntime>[1] = {}): Promise<unknown[]> {
  const runtime = createFormRuntime(form, config);
  runtime.setValue("code", "abc");
  const errors = await runtime.validate();
  return errors.filter((error) => error.code === "pattern").map((error) => error.parameters);
}

describe("the field-constraints stage of a runtime the factory builds", () => {
  it("fails an unrunnable pattern closed by default", async () => {
    expect(await patternErrors(definition())).toEqual([expect.objectContaining({ invalid: true })]);
  });

  it("follows the host's formulaErrors word over the form's", async () => {
    expect(await patternErrors(definition(), { formulaErrors: "warn" })).toEqual([]);
    expect(await patternErrors(definition("warn"), { formulaErrors: "fail" })).toEqual([expect.objectContaining({ invalid: true })]);
  });

  it("follows the form's own word when the host gives none", async () => {
    expect(await patternErrors(definition("warn"))).toEqual([]);
  });
});
