import { describe, expect, it } from "vitest";

import { buildAccessibilitySemantics } from "../form-engine/core/accessibility/accessibility-semantics.js";
import { parseComponentPath } from "../form-engine/core/tree/component-path.js";

describe("accessibility semantics", () => {
  it("builds deterministic ids and invalid semantics", () => {
    const semantics = buildAccessibilitySemantics({
      componentId: "postalCode",
      path: parseComponentPath("addresses[1].postalCode"),
      required: true,
      readonly: false,
      disabled: false,
      hasDescription: true,
      errors: [
        {
          id: "e1",
          code: "validation.required",
          stage: "field",
          source: "client"
        }
      ]
    });

    expect(semantics.invalid).toBe(true);
    expect(semantics.errorId).toContain("postalCode");
    expect(semantics.ariaDescribedBy.length).toBe(2);
  });

  it("respects configured label position and direction", () => {
    const semantics = buildAccessibilitySemantics({
      componentId: "firstName",
      required: false,
      readonly: false,
      disabled: false,
      errors: [],
      options: { labelPosition: "left", textDirection: "rtl" }
    });

    expect(semantics.labelPosition).toBe("left");
    expect(semantics.textDirection).toBe("rtl");
  });
});
