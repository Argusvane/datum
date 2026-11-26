import { describe, expect, it } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { DATA_GRID_ROWS_CAP } from "../form-engine/core/schema/data-grid.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";

function build(configuration: Record<string, unknown> = {}): FormRuntime {
  const form = {
    id: "f",
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
            configuration: { ...configuration },
            children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
          }
        ]
      }
    }
  } as unknown as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
    journeyEngine: EagerJourneyEngine
  } as FormRuntimeDependencies);
}

describe("an answer written at a row index", () => {
  it("refuses an index no collection may hold, before anything is written", () => {
    const runtime = build();
    const before = runtime.formValues();
    const rows = runtime.rows("items").length;
    expect(() => runtime.setValue(`items[${DATA_GRID_ROWS_CAP}].sku`, "x")).toThrow(RangeError);
    expect(() => runtime.setValue("items[3000000].sku", "x")).toThrow(RangeError);
    expect(runtime.rows("items")).toHaveLength(rows);
    expect(runtime.formValues()).toEqual(before);
  });

  it("hands the refusal back from setValues, the other answers still written", () => {
    const runtime = build();
    const failed = runtime.setValues({ "items[200000].sku": "far", "items[1].sku": "near" });
    expect(failed.map((entry) => entry.path)).toEqual(["items[200000].sku"]);
    expect(failed[0]?.error).toBeInstanceOf(RangeError);
    expect(runtime.rows("items")).toHaveLength(2);
    expect(runtime.rows("items")[1]).toMatchObject({ sku: "near" });
  });

  it("still lets a prefill write the last row the cap allows, past maxRows", () => {
    const runtime = build({ maxRows: 3 });
    runtime.setValue(`items[${DATA_GRID_ROWS_CAP - 1}].sku`, "last");
    expect(runtime.rows("items")).toHaveLength(DATA_GRID_ROWS_CAP);
  });
});
