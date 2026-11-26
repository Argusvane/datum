import { describe, expect, it } from "vitest";

import { computeEffectiveNodeState } from "../form-engine/core/state/effective-state.js";

describe("effective state", () => {
  it("inherits hidden state and disabled state from ancestors", () => {
    const effective = computeEffectiveNodeState(
      { visible: true, disabled: false, readonly: false },
      [{ visible: false, disabled: true, readonly: false }]
    );

    expect(effective.visible).toBe(false);
    expect(effective.disabled).toBe(true);
    expect(effective.runValidation).toBe(false);
    expect(effective.requiredApplies).toBe(false);
  });

  it("applies hidden behavior policy", () => {
    const effective = computeEffectiveNodeState(
      {
        visible: false,
        disabled: false,
        readonly: false,
        hiddenValueBehavior: "exclude-from-submission",
        hiddenValidationBehavior: "validate",
        hiddenRequiredBehavior: "required"
      },
      []
    );

    expect(effective.submitValue).toBe(false);
    expect(effective.runValidation).toBe(true);
    expect(effective.requiredApplies).toBe(true);
    expect(effective.clearValue).toBe(false);
  });
});
