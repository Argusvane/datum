import { describe, expect, it } from "vitest";

import type { ValidationStage } from "../form-engine/core/schema/contracts.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";

describe("validation pipeline", () => {
  it("executes stages in order and merges errors", async () => {
    const trace: string[] = [];

    const stages: ValidationStage[] = [
      {
        id: "field",
        version: "1.0.0",
        validate: () => {
          trace.push("field");
          return {
            errors: [
              {
                code: "validation.required",
                componentId: "firstName",
                stage: "field",
                source: "client"
              }
            ]
          };
        }
      },
      {
        id: "form",
        version: "1.0.0",
        validate: () => {
          trace.push("form");
          return {
            errors: [
              {
                code: "form.invalid",
                stage: "form",
                source: "client"
              }
            ]
          };
        }
      }
    ];

    const pipeline = new ValidationPipeline(stages);
    const result = await pipeline.run({ values: {}, formId: "f1" });

    expect(trace).toEqual(["field", "form"]);
    expect(result.stageResults).toHaveLength(2);
    expect(result.merged.errors).toHaveLength(2);
  });

  it("runs all deterministic stages before any async stage, preserving relative order", async () => {
    const trace: string[] = [];
    const stage = (id: string, kind: "deterministic" | "async"): ValidationStage => ({
      id,
      version: "1.0.0",
      kind,
      validate: async () => {
        trace.push(id);
        return { errors: [] };
      }
    });

    const pipeline = new ValidationPipeline([
      stage("async-1", "async"),
      stage("det-1", "deterministic"),
      stage("async-2", "async"),
      stage("det-2", "deterministic")
    ]);

    await pipeline.run({ values: {}, formId: "f1" });
    expect(trace).toEqual(["det-1", "det-2", "async-1", "async-2"]);
  });

  it("skips stages whose runIf returns false", async () => {
    const trace: string[] = [];
    const pipeline = new ValidationPipeline([
      {
        id: "conditional",
        version: "1.0.0",
        runIf: (ctx) => ctx.values.enabled === true,
        validate: () => {
          trace.push("conditional");
          return { errors: [] };
        }
      }
    ]);

    await pipeline.run({ values: { enabled: false }, formId: "f1" });
    expect(trace).toEqual([]);
    await pipeline.run({ values: { enabled: true }, formId: "f1" });
    expect(trace).toEqual(["conditional"]);
  });

  it("runDeterministic executes only pure stages synchronously", () => {
    const trace: string[] = [];
    const pipeline = new ValidationPipeline([
      {
        id: "det",
        version: "1.0.0",
        validate: () => {
          trace.push("det");
          return { errors: [{ code: "x", stage: "det", source: "client" as const }] };
        }
      },
      {
        id: "async",
        version: "1.0.0",
        kind: "async",
        validate: async () => {
          trace.push("async");
          return { errors: [] };
        }
      }
    ]);

    const result = pipeline.runDeterministic({ values: {}, formId: "f1" });
    expect(trace).toEqual(["det"]);
    expect(result.merged.errors).toHaveLength(1);
  });

  it("runDeterministic throws if a deterministic stage returns a promise", () => {
    const pipeline = new ValidationPipeline([
      {
        id: "bad",
        version: "1.0.0",
        validate: async () => ({ errors: [] })
      }
    ]);
    expect(() => pipeline.runDeterministic({ values: {}, formId: "f1" })).toThrow(/promise/i);
  });
});
