import { describe, expect, it } from "vitest";

import type { ValidationContext, ValidationStage } from "../form-engine/core/schema/contracts.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";

const MANY = 300_000;

function stageReporting(count: number, kind: "deterministic" | "async" = "deterministic"): ValidationStage {
  const errors = Array.from({ length: count }, (_, index) => ({ componentId: `c${index}`, code: "required", stage: "field", source: "client" as const }));
  return { id: `stage-${kind}`, version: "1.0.0", kind, validate: () => ({ errors }) } as unknown as ValidationStage;
}

const context = { formId: "f", values: {}, locale: "en" } as unknown as ValidationContext;

describe("the validation pipeline's merge", () => {
  it("answers with every error a stage reports, however many, when run", async () => {
    const result = await new ValidationPipeline([stageReporting(MANY), stageReporting(2, "async")]).run(context);
    expect(result.merged.errors).toHaveLength(MANY + 2);
    expect(result.merged.errors[MANY]?.componentId).toBe("c0");
  });

  it("answers with every error a stage reports, however many, when run deterministically", () => {
    const result = new ValidationPipeline([stageReporting(MANY), stageReporting(1)]).runDeterministic(context);
    expect(result.merged.errors).toHaveLength(MANY + 1);
  });
});
