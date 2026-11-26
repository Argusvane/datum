import { describe, expect, it } from "vitest";

import type { CapabilityDefinition } from "../form-engine/core/schema/contracts.js";
import { composePropertyEditor } from "../form-engine/builder/property-editor/editor-composer.js";

describe("property editor composer", () => {
  function cap(id: string): CapabilityDefinition {
    return {
      id,
      version: "1.0.0",
      apply: (component) => component,
      configureEditor: () => ({
        fields: [{ id: `${id}-field`, type: "text", propertyPath: `${id}.value` }],
        sections: [{ id: `${id}-section`, fieldIds: [`${id}-field`] }],
        features: [
          {
            id: `${id}-feature`,
            label: `${id}-feature`,
            isAvailable: () => true
          }
        ]
      })
    };
  }

  const capabilityContext = {
    component: { id: "c1", type: "text", configuration: {} }
  };

  it("composes default mode from capabilities", () => {
    const composed = composePropertyEditor([cap("required")], capabilityContext);
    expect(composed?.mode).toBe("default");
    expect(composed?.fields.map((f) => f.id)).toEqual(["required-field"]);
  });

  it("extends capability editor with component fields", () => {
    const composed = composePropertyEditor([cap("required")], capabilityContext, {
      mode: "extend",
      fields: [{ id: "component-field", type: "text", propertyPath: "label" }],
      sections: [{ id: "component-section", fieldIds: ["component-field"] }],
      features: [
        {
          id: "component-feature",
          label: "component-feature",
          isAvailable: () => true
        }
      ]
    });

    expect(composed?.fields.map((f) => f.id)).toEqual([
      "required-field",
      "component-field"
    ]);
  });

  it("replaces generated editor in replace mode", () => {
    const composed = composePropertyEditor([cap("required")], capabilityContext, {
      mode: "replace",
      fields: [{ id: "only", type: "text", propertyPath: "x" }]
    });

    expect(composed?.fields.map((f) => f.id)).toEqual(["only"]);
  });

  it("returns undefined in none mode", () => {
    const composed = composePropertyEditor([cap("required")], capabilityContext, {
      mode: "none"
    });

    expect(composed).toBeUndefined();
  });
});
