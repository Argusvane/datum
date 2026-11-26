import { describe, expect, it } from "vitest";

import type { FormDefinition, ComponentNode } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { buildRuntimeRenderOutput } from "../../form-engine/render/core/runtime-render-bridge.js";
import { buildErrorAnnouncement } from "../../form-engine/render/core/error-accessibility.js";

function form(): FormDefinition {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "step1",
          type: "step",
          configuration: {},
          children: {
            content: [
              {
                id: "billingTab",
                type: "tab",
                configuration: {},
                children: {
                  content: [
                    {
                      id: "postalCode",
                      type: "text",
                      configuration: { label: "Postal code", required: true, description: "A1A 1A1" }
                    }
                  ]
                }
              }
            ]
          }
        }
      ]
    }
  };
  return { id: "f1", version: "1", schemaVersion: "1", root, localization: { defaultLocale: "en" } };
}

function runtime(): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form(), {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([
      {
        id: "required",
        version: "1.0.0",
        validate: (ctx) =>
          ctx.values.postalCode
            ? { errors: [] }
            : {
                errors: [
                  { code: "required", componentId: "postalCode", path: "postalCode", stage: "field", source: "client" }
                ]
              }
      }
    ])
  });
}

describe("accessibility integration", () => {
  it("wires aria attributes and description ids onto the render model", async () => {
    const rt = runtime();
    await rt.validate();
    const output = await buildRuntimeRenderOutput(rt, "interactive");
    const field = output.components.find((c) => c.id === "postalCode");

    expect(field?.accessibility.required).toBe(true);
    expect(field?.accessibility.invalid).toBe(true);
    expect(field?.accessibility.ariaDescribedBy).toEqual(
      expect.arrayContaining(["postalCode__description", "postalCode__error"])
    );
  });

  it("resolves a first-error focus target with the containing tab and step to activate", async () => {
    const rt = runtime();
    await rt.validate();
    const output = await buildRuntimeRenderOutput(rt, "interactive");

    expect(output.meta.firstErrorFocus).toMatchObject({
      componentId: "postalCode",
      activateTabIds: ["billingTab"],
      activateStepIds: ["step1"]
    });
  });

  it("builds a screen-reader announcement for an error", () => {
    const announcement = buildErrorAnnouncement({
      id: "e1",
      code: "required",
      componentId: "postalCode",
      stage: "field",
      source: "client"
    });
    expect(announcement.text).toContain("required");
    expect(announcement.targetComponentId).toBe("postalCode");
  });
});
