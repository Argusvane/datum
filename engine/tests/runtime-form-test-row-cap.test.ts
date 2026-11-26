import { describe, expect, it } from "vitest";

import { kernelParseFormTests } from "../form-engine/core/form-tests/form-test-parse.js";
import { runFormTestScenarios } from "../form-engine/core/form-tests/form-test-run.js";
import type { FormTestScenarioResult } from "../form-engine/core/form-tests/form-test-types.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { DATA_GRID_ROWS_CAP } from "../form-engine/core/schema/data-grid.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFormTestRuntimeDriver, type FormTestRuntimeFactory } from "../form-engine/runtime/browser/form-test-runtime-driver.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
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
  id: "rows-form",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "lines",
          type: "dataGrid",
          configuration: { label: "Lines", initialRows: 0, maxRows: 2 },
          collection: { collectionPath: "lines" },
          children: { content: [{ id: "amt", type: "number", configuration: { label: "Amount" } }] }
        },
        {
          id: "open",
          type: "dataGrid",
          configuration: { label: "Open", initialRows: 0 },
          collection: { collectionPath: "open" },
          children: { content: [{ id: "amt2", type: "number", configuration: { label: "Amount" } }] }
        }
      ]
    }
  }
} as unknown as FormDefinition;

const sandbox = new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi());

/** One scenario on the browser's driver, and the sandbox's `test` op over the same text. */
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

describe("a form test's set past the rows a grid may hold", () => {
  it("is refused as rows.max at the grid's maximum, on both sides alike", async () => {
    const pair = await runBoth(['test "past max"', "  given journey = none", "  set lines[5].amt = 3"].join("\n"));
    expect(pair.browser.steps.at(-1)).toEqual({
      line: 3,
      status: "error",
      code: "action.refused",
      params: { action: "set", reason: "rows.max", path: "lines", max: 2 }
    });
    expect(pair.kernel.steps, JSON.stringify(pair)).toEqual(pair.browser.steps);
  });

  it("is refused at the cap every collection is held to when the grid sets no maximum", async () => {
    const pair = await runBoth(['test "past cap"', "  given journey = none", `  set open[${DATA_GRID_ROWS_CAP}].amt2 = 3`].join("\n"));
    expect(pair.browser.steps.at(-1)).toEqual({
      line: 3,
      status: "error",
      code: "action.refused",
      params: { action: "set", reason: "rows.max", path: "open", max: DATA_GRID_ROWS_CAP }
    });
    expect(pair.kernel.steps, JSON.stringify(pair)).toEqual(pair.browser.steps);
  });

  it("still writes a row under the maximum", async () => {
    const pair = await runBoth(['test "under"', "  given journey = none", "  set lines[1].amt = 3", "  expect rows of lines = 2"].join("\n"));
    expect(pair.browser.status, JSON.stringify(pair)).toBe("passed");
    expect(pair.kernel.steps).toEqual(pair.browser.steps);
  });
});
