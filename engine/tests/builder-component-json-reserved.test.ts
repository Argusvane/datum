import { describe, expect, it } from "vitest";
import { readComponentJson } from "../form-engine/builder/property-editor/component-json.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

const field: ComponentNode = { id: "a", type: "text", configuration: { label: "a" }, rules: { requiredWhen: "true" } };
const read = (text: string) => readComponentJson(text, field, { idEditable: false });

describe("the JSON tab refuses names every object has", () => {
  it("as a rule name, pointing at the key", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      const result = read(`{"id":"a","type":"text","configuration":{"label":"a"},"rules":{"${name}":"true"}}`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problem.message).toContain(`"${name}"`);
      }
    }
  });
  it("as a configuration key", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      const result = read(`{"id":"a","type":"text","configuration":{"label":"a","${name}":{"polluted":"yes"}}}`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problem.message).toContain(`"${name}"`);
      }
    }
  });
  it("still takes lookalikes and ordinary rules", () => {
    const result = read('{"id":"a","type":"text","configuration":{"label":"a","constructorName":1,"prototypes":2},"rules":{"requiredWhen":"true"}}');
    expect(result.ok).toBe(true);
  });
});
