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
  id: "rowcells",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "items",
          type: "dataGrid",
          collection: { collectionPath: "items" },
          configuration: { initialRows: 0 },
          children: {
            content: [
              { id: "sku", type: "text", configuration: {} },
              { id: "qty", type: "number", configuration: {} },
              { id: "tags", type: "checkboxes", configuration: { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } }
            ]
          }
        }
      ]
    }
  }
} as unknown as FormDefinition;

const sandbox = new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi());

async function runAll(source: string): Promise<{ browser: FormTestScenarioResult; kernel: FormTestScenarioResult; op: FormTestScenarioResult }> {
  const parsed = kernelParseFormTests(source, formulaFunctionSignatures());
  expect(parsed.problems).toEqual([]);
  const [browser] = await runFormTestScenarios([parsed.scenarios[0]!], () => createFormTestRuntimeDriver(FORM, { makeRuntime }));
  const [kernel] = await runFormTestScenarios([parsed.scenarios[0]!], () => createFormTestKernelDriver(FORM, { host: createInProcessWasmValidationHost([]) }));
  const answer = JSON.parse(sandbox.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "test", definition: FORM, tests: source })) as string) as {
    report: { scenarios: Array<FormTestScenarioResult & { id?: unknown; line?: unknown }> };
  };
  const { id: _id, line: _line, ...op } = answer.report.scenarios[0]!;
  return { browser: browser!, kernel: kernel!, op };
}

/**
 * An `add row … with` cell holding a list, on a field of the row that holds one value, is refused
 * as a `set` of it is: `action.refused` with reason `value.notScalar` and the cell's path in the
 * row that would have been added, before any row is added, by the runtime driver, the kernel
 * driver and the sandbox's `test` op alike.
 */
describe("a form test's add row with a list in a single-valued cell", () => {
  it("is refused as value.notScalar, naming the cell of the new row, on all three sides", async () => {
    const pair = await runAll(['test "list in a text cell"', "  given journey = none", '  add row to items with sku = ("a", "b")', "  submit"].join("\n"));
    expect(pair.browser.status).toBe("error");
    expect(pair.browser.steps.at(-1)).toEqual({ line: 3, status: "error", code: "action.refused", params: { action: "addRow", reason: "value.notScalar", path: "items[0].sku" } });
    expect(pair.kernel.steps, JSON.stringify(pair.kernel)).toEqual(pair.browser.steps);
    expect(pair.op.steps, JSON.stringify(pair.op)).toEqual(pair.browser.steps);
  });

  it("names the row the add would make, after the rows already there, and the first refused cell", async () => {
    const pair = await runAll(
      ['test "second row"', "  given journey = none", '  add row to items with sku = "A1"', '  add row to items with sku = "A2", qty = (1, 2)'].join("\n")
    );
    expect(pair.browser.steps.at(-1)).toEqual({ line: 4, status: "error", code: "action.refused", params: { action: "addRow", reason: "value.notScalar", path: "items[1].qty" } });
    expect(pair.kernel.steps).toEqual(pair.browser.steps);
    expect(pair.op.steps).toEqual(pair.browser.steps);
  });

  it("still adds a row of single values, and takes a list in a checkbox group cell", async () => {
    const pair = await runAll(['test "fine"', "  given journey = none", '  add row to items with sku = "A1", qty = 2', "  submit", "  expect accepted"].join("\n"));
    expect(pair.browser.status, JSON.stringify(pair.browser)).toBe("passed");
    expect(pair.kernel.steps).toEqual(pair.browser.steps);
    expect(pair.op.steps).toEqual(pair.browser.steps);
    const group = await runAll(['test "group"', "  given journey = none", '  add row to items with sku = "A1", tags = ("a", "b")', "  submit"].join("\n"));
    expect(group.browser.steps[0]).toEqual({ line: 3, status: "ran" });
    expect(group.kernel.steps).toEqual(group.browser.steps);
    expect(group.op.steps).toEqual(group.browser.steps);
  });

  it("stores a list in a checkbox group cell as the group's record, as a set of the cell does", async () => {
    const added = await runAll(
      ['test "added"', "  given journey = none", '  add row to items with sku = "A1", tags = ("a")', "  submit", "  expect accepted"].join("\n")
    );
    expect(added.browser.status, JSON.stringify(added.browser)).toBe("passed");
    expect(added.kernel.steps, JSON.stringify(added.kernel)).toEqual(added.browser.steps);
    expect(added.op.steps, JSON.stringify(added.op)).toEqual(added.browser.steps);
    const set = await runAll(
      ['test "set"', "  given journey = none", '  add row to items with sku = "A1"', '  set items[0].tags = ("a")', "  submit", "  expect accepted"].join("\n")
    );
    expect(set.browser.status, JSON.stringify(set.browser)).toBe("passed");
    // The picked option is ticked and the other left unticked, in the row the add made, on every side.
    const read = await runAll(
      ['test "read"', "  given journey = none", '  add row to items with tags = ("a")', '  expect items[0].tags = ("a")'].join("\n")
    );
    expect(read.browser.status, JSON.stringify(read.browser)).toBe("passed");
    expect(read.kernel.steps, JSON.stringify(read.kernel)).toEqual(read.browser.steps);
    expect(read.op.steps, JSON.stringify(read.op)).toEqual(read.browser.steps);
  });
});
