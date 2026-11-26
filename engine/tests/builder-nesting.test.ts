import { describe, expect, it } from "vitest";
import { printFormula } from "../form-engine/builder/formula/feel-print.js";
import { buildLogicModel } from "../form-engine/builder/logic/logic-model.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { NESTING_MAX, nestsPast } from "../form-engine/core/tree/nesting.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

const DEFS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() }
];
/** A right-nested `and` chain `levels` deep, built without recursion. */
const chain = (levels: number): unknown => {
  let node: unknown = { kind: "path", path: "a" };
  for (let i = 0; i < levels; i += 1) {
    node = { kind: "logical", operator: "and", left: { kind: "path", path: "a" }, right: node };
  }
  return node;
};
const rootWith = (rule: unknown): ComponentNode => ({
  id: "root",
  type: "form",
  configuration: {},
  children: { content: [{ id: "a", type: "text", configuration: {} }, { id: "b", type: "text", configuration: {}, rules: { visibleWhen: rule } as never }] }
});

describe("nestsPast", () => {
  it("counts records and lists from 1 at the value, without recursion", () => {
    expect(nestsPast("text")).toBe(false);
    expect(nestsPast({ a: [{ b: 1 }] }, 3)).toBe(false);
    expect(nestsPast({ a: [{ b: [] }] }, 3)).toBe(true);
    expect(nestsPast(chain(100_000))).toBe(true);
  });
});

describe("a form nested far deeper than hosts read", () => {
  it("is refused with words where it is loaded, not with a stack overflow", () => {
    expect(() => new BuilderController({ initialRoot: rootWith(chain(5000)), componentDefinitions: DEFS })).toThrow(/nests more than 320 levels/);
    // Within what hosts read it opens and the logic around it works.
    const c = new BuilderController({ initialRoot: rootWith(chain(100)), componentDefinitions: DEFS });
    expect(() => c.inspectorModel("b")).not.toThrow();
  });
  it("is refused where a value is written, leaving the form as it was", () => {
    const c = new BuilderController({ initialRoot: rootWith(undefined), componentDefinitions: DEFS });
    expect(() => c.setProperty("b", "label", chain(NESTING_MAX + 5))).toThrow(/nests more than/);
    expect(() => c.setDraftProperty("b", "label", chain(NESTING_MAX + 5))).toThrow(/nests more than/);
    expect(() => c.setProperties([{ componentId: "b", propertyPath: "visibleWhen", value: chain(NESTING_MAX + 5), target: "rules" }])).toThrow(/nests more than/);
    expect(c.canUndo()).toBe(false);
  });
  it("is refused as an insert when the nodes would carry such a rule", () => {
    const c = new BuilderController({ initialRoot: rootWith(undefined), componentDefinitions: DEFS });
    const result = c.insertComponents([{ node: { id: "deep", type: "text", configuration: {}, rules: { visibleWhen: chain(NESTING_MAX + 5) } as never }, parentId: "root", slotId: "content" }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nest more than 320 levels/);
  });
});

describe("the formula printer and the logic model on a very long or very deep formula", () => {
  it("print a long flat formula and show a tree too deep for the stack as an ellipsis", () => {
    expect(printFormula(chain(30_000) as never)).toBe("…");
    let long: unknown = { kind: "binary", operator: "eq", left: { kind: "path", path: "a" }, right: { kind: "literal", value: 0 } };
    for (let i = 1; i < 20_000; i += 1) {
      long = { kind: "logical", operator: "or", left: long, right: { kind: "binary", operator: "eq", left: { kind: "path", path: "a" }, right: { kind: "literal", value: i } } };
    }
    expect(printFormula(long as never).length).toBeGreaterThan(100_000);
  });
  it("word no condition with thousands of joins as clauses, and do not overflow the stack", () => {
    const formula = Array.from({ length: 20_000 }, (_, i) => `a = ${i}`).join(" or ");
    expect(() => buildLogicModel(rootWith(formula), {})).not.toThrow();
  });
});
