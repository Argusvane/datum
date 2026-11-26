import { describe, expect, it } from "vitest";

import { buildInteractiveRenderModel } from "../form-engine/render/react/interactive-renderer.js";
import { buildReadonlyRenderModel } from "../form-engine/render/readonly/readonly-renderer.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import type { FormState } from "../form-engine/core/state/form-state.js";

function state(): FormState {
  return {
    values: { country: "CA", notes: "hello" },
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    locale: "en-CA",
    navigation: {
      mode: "wizard",
      currentStepId: "step1",
      visitedSteps: new Set(["step1", "step2"]),
      completedSteps: new Set(["step1"])
    }
  };
}

function root() {
  return {
    id: "root",
    type: "container",
    configuration: {},
    children: {
      children: [
        {
          id: "step1",
          type: "step",
          configuration: {},
          children: {
            children: [
              {
                id: "country",
                type: "select",
                configuration: { data: { sourceId: "countries" } }
              }
            ]
          }
        },
        {
          id: "step2",
          type: "step",
          configuration: {},
          children: {
            children: [{ id: "notes", type: "text", configuration: { readOnly: true } }]
          }
        }
      ]
    }
  };
}

const resolver: DataSourceResolver = {
  resolveDataSource: async ({ componentId }) => {
    if (componentId === "country") {
      return { items: [{ value: "CA", label: "Canada" }] };
    }
    return undefined;
  }
};

describe("render mode models", () => {
  it("builds interactive model with option state", async () => {
    const model = await buildInteractiveRenderModel(root(), state(), resolver);
    const country = model.components.find((component) => component.id === "country");

    expect(model.mode).toBe("interactive");
    expect(country?.optionState.status).toBe("ready");
    expect(country?.readOnly).toBe(false);
  });

  it("builds readonly model with display values and forced readonly", async () => {
    const model = await buildReadonlyRenderModel(root(), state(), resolver);
    const notes = model.components.find((component) => component.id === "notes");

    expect(model.mode).toBe("readonly");
    expect(notes?.readOnly).toBe(true);
    expect(notes?.displayValue).toBe("hello");
  });
});
