import { describe, expect, it } from "vitest";

import { kernelParseFormTests } from "../form-engine/core/form-tests/form-test-parse.js";
import { runFormTestScenarios } from "../form-engine/core/form-tests/form-test-run.js";
import type { FormTestScenarioResult } from "../form-engine/core/form-tests/form-test-types.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFormTestRuntimeDriver, type FormTestRuntimeFactory } from "../form-engine/runtime/browser/form-test-runtime-driver.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFormTestKernelDriver } from "../form-engine/validation/wasm/form-test-kernel-driver.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { JsonWasmAbi, WASM_ABI_VERSION, stableStringify } from "../form-engine/validation/wasm/wasm-validation-host.js";

const makeRuntime: FormTestRuntimeFactory = (definition, givens) => {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
    journeyEngine: EagerJourneyEngine,
    wasmValidationHost: createInProcessWasmValidationHost([]),
    ...givens
  });
};

const FORM = {
  id: "nonscalar",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: { id: "form", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { required: true } }, { id: "tags", type: "checkboxes", configuration: { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } }] } }
} as unknown as FormDefinition;

const sandbox = new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi());

async function runBoth(source: string): Promise<{ browser: FormTestScenarioResult; kernel: FormTestScenarioResult }> {
  const parsed = kernelParseFormTests(source, formulaFunctionSignatures());
  expect(parsed.problems).toEqual([]);
  const [browser] = await runFormTestScenarios([parsed.scenarios[0]!], () => createFormTestRuntimeDriver(FORM, { makeRuntime }));
  const answer = JSON.parse(sandbox.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "test", definition: FORM, tests: source })) as string) as {
    report: { scenarios: Array<FormTestScenarioResult & { id?: unknown; line?: unknown }> };
  };
  const { id: _id, line: _line, ...kernel } = answer.report.scenarios[0]!;
  return { browser: browser!, kernel };
}

/**
 * A form test's `set` of a list on a field that holds one value (a text, a number, a select...)
 * is refused by the runtime's write; the scenario reports it as a coded refusal on both sides,
 * `action.refused` with reason `value.notScalar`, so the browser and the kernel agree.
 */
describe("a form test's set of a list on a single-valued field", () => {
  it("is refused as value.notScalar, on both sides alike", async () => {
    const pair = await runBoth(['test "list on text"', "  given journey = none", '  set name = ("a", "b")', "  submit", "  expect refused"].join("\n"));
    expect(pair.browser.status).toBe("error");
    expect(pair.browser.steps.at(-1)).toEqual({ line: 3, status: "error", code: "action.refused", params: { action: "set", reason: "value.notScalar", path: "name" } });
    expect(pair.kernel.steps, JSON.stringify(pair)).toEqual(pair.browser.steps);
  });

  it("still writes a list on a checkbox group, and a single value on a text field", async () => {
    const pair = await runBoth(['test "fine"', "  given journey = none", '  set tags = ("a")', '  set name = "Ada"', "  submit", "  expect accepted"].join("\n"));
    expect(pair.browser.status, JSON.stringify(pair.browser)).toBe("passed");
    expect(pair.kernel.steps).toEqual(pair.browser.steps);
  });

  it("the kernel driver refuses it too", async () => {
    const parsed = kernelParseFormTests(['test "k"', "  given journey = none", "  set name = (1, 2)"].join("\n"), formulaFunctionSignatures());
    const [result] = await runFormTestScenarios([parsed.scenarios[0]!], () => createFormTestKernelDriver(FORM, { host: createInProcessWasmValidationHost([]) }));
    expect(result!.steps.at(-1)).toEqual({ line: 3, status: "error", code: "action.refused", params: { action: "set", reason: "value.notScalar", path: "name" } });
  });
});
