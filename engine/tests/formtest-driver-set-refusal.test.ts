import { describe, expect, it } from "vitest";

import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { kernelParseFormTests } from "../form-engine/core/form-tests/form-test-parse.js";
import { runFormTestScenarios } from "../form-engine/core/form-tests/form-test-run.js";
import type { FormTestDriver, FormTestGiven, FormTestRefusal } from "../form-engine/core/form-tests/form-test-types.js";
import { DATA_GRID_ROWS_CAP } from "../form-engine/core/schema/data-grid.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFormTestRuntimeDriver, type FormTestRuntimeFactory } from "../form-engine/runtime/browser/form-test-runtime-driver.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFormTestKernelDriver } from "../form-engine/validation/wasm/form-test-kernel-driver.js";
import { createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";

// A form test's `set` can be refused (rows.max) by either driver, and the contract types the answer
// so the runner can read it: the kernel driver must refuse where the browser's does, not grow rows
// past a grid's maximum or silently drop a write at the cap.

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
  id: "set-refusal",
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

const none: FormTestGiven[] = [{ kind: "given", key: "journey", value: "none", line: 1 }];

function drivers(): Array<[string, () => FormTestDriver]> {
  return [
    ["browser", () => createFormTestRuntimeDriver(FORM, { makeRuntime })],
    ["kernel", () => createFormTestKernelDriver(FORM, { host: createInProcessWasmValidationHost() })]
  ];
}

describe.each(drivers())("the %s driver's set past the rows a grid may hold", (_side, make) => {
  it("answers the rows.max refusal at the grid's maximum and writes nothing", async () => {
    const driver = make();
    await driver.start(none);
    const refusal = (await driver.set("lines[5].amt", 3)) as FormTestRefusal | void;
    expect(refusal).toEqual({ refused: "rows.max", params: { path: "lines", max: 2 } });
    const snapshot = await driver.snapshot();
    expect(snapshot.rows.lines ?? 0).toBe(0);
  });

  it("answers the same refusal, at the cap, for a grid with no maximum", async () => {
    const driver = make();
    await driver.start(none);
    const refusal = (await driver.set(`open[${DATA_GRID_ROWS_CAP}].amt2`, 3)) as FormTestRefusal | void;
    expect(refusal).toEqual({ refused: "rows.max", params: { path: "open", max: DATA_GRID_ROWS_CAP } });
  });

  it("still writes a row under the maximum, answering nothing", async () => {
    const driver = make();
    await driver.start(none);
    expect(await driver.set("lines[1].amt", 3)).toBeUndefined();
    expect((await driver.snapshot()).rows.lines).toBe(2);
  });

  it("is recorded by the runner as action.refused", async () => {
    const parsed = kernelParseFormTests(['test "past max"', "  given journey = none", "  set lines[5].amt = 3"].join("\n"), formulaFunctionSignatures());
    expect(parsed.problems).toEqual([]);
    const [result] = await runFormTestScenarios([parsed.scenarios[0]!], make);
    expect(result!.steps.at(-1)).toEqual({ line: 3, status: "error", code: "action.refused", params: { action: "set", reason: "rows.max", path: "lines", max: 2 } });
  });
});
