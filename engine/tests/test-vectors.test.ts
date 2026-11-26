import { describe, expect, it } from "vitest";

import type { ValidationResult } from "../form-engine/core/schema/contracts.js";
import {
  runDeterministicVectors,
  type DeterministicValidationVector
} from "../form-engine/validation/core/test-vectors.js";

describe("deterministic validation vectors", () => {
  it("passes when signatures match independent of order", () => {
    const vectors: DeterministicValidationVector[] = [
      {
        id: "v1",
        context: { formId: "f1", values: { firstName: "" } },
        expectedErrors: [
          {
            code: "validation.required",
            componentId: "firstName",
            stage: "field",
            source: "client"
          },
          {
            code: "form.invalid",
            stage: "form",
            source: "client"
          }
        ]
      }
    ];

    const report = runDeterministicVectors(vectors, () => ({
      errors: [
        {
          code: "form.invalid",
          stage: "form",
          source: "client"
        },
        {
          code: "validation.required",
          componentId: "firstName",
          stage: "field",
          source: "client"
        }
      ]
    }));

    expect(report.failed).toBe(0);
    expect(report.passed).toBe(1);
  });

  it("reports mismatch details", () => {
    const vectors: DeterministicValidationVector[] = [
      {
        id: "v2",
        context: { formId: "f1", values: {} },
        expectedErrors: [
          {
            code: "validation.required",
            componentId: "email",
            stage: "field",
            source: "client"
          }
        ]
      }
    ];

    const report = runDeterministicVectors(
      vectors,
      (): ValidationResult => ({ errors: [] })
    );

    expect(report.failed).toBe(1);
    expect(report.mismatches[0]?.vectorId).toBe("v2");
  });
});
