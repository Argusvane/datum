import { describe, expect, it } from "vitest";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { kernelStructureCheck, kernelStructureLimits } from "../form-engine/core/expressions/definition-structure.js";

const DEFS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "group", version: "1.0.0", createDefault: () => ({ id: "group", type: "group", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() }
];
const make = () => new BuilderController({ initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } }, componentDefinitions: DEFS });
const group = (id: string): ComponentNode => ({ id, type: "group", configuration: {}, children: { content: [] } });
const tooDeep = (c: BuilderController): boolean =>
  kernelStructureCheck({ id: "f", version: "1", schemaVersion: "1", root: c.snapshot() } as never, undefined).structure.some((entry) => entry.code === "definition.tooDeep");
const chain = (c: BuilderController, tag: string, length: number): void => {
  let parent = "root";
  for (let i = 0; i < length; i += 1) {
    expect(c.insertComponents([{ node: group(`${tag}${i}`), parentId: parent, slotId: "content" } as never]).ok).toBe(true);
    parent = `${tag}${i}`;
  }
};

describe("the builder keeps a form within the depth the server reads", () => {
  it("insertComponents stops at the limit, with a reason and nothing placed", () => {
    const c = make();
    let parent = "root";
    let made = 0;
    let refusal = "";
    for (let i = 0; i < kernelStructureLimits().depth + 5; i += 1) {
      const result = c.insertComponents([{ node: group(`g${i}`), parentId: parent, slotId: "content" } as never]);
      if (!result.ok) {
        refusal = result.error ?? "";
        break;
      }
      parent = `g${i}`;
      made += 1;
    }
    expect(made).toBeLessThan(kernelStructureLimits().depth);
    expect(refusal).toMatch(/levels deep/);
    expect(c.dropError).toMatch(/levels deep/);
    expect(tooDeep(c)).toBe(false);
  });
  it("add stops at the limit too", () => {
    const c = make();
    chain(c, "x", kernelStructureLimits().depth - 2);
    const last = `x${kernelStructureLimits().depth - 3}`;
    c.add("group", last, "content");
    expect(tooDeep(c)).toBe(false);
  });
  it("move refuses a subtree that would nest past the limit", () => {
    const c = make();
    chain(c, "x", 20);
    chain(c, "y", 20);
    expect(c.move("x0", { parentId: "y19", slotId: "content", index: 0 })).toBe(false);
    expect(tooDeep(c)).toBe(false);
    expect(c.snapshot().children?.content?.map((n) => n.id)).toEqual(["x0", "y0"]);
  });
  it("a move that stays within the limit still lands", () => {
    const c = make();
    chain(c, "x", 3);
    chain(c, "y", 3);
    expect(c.move("x0", { parentId: "y2", slotId: "content", index: 0 })).toBe(true);
  });
});
