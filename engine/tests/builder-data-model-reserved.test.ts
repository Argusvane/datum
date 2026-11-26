import { describe, expect, it } from "vitest";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { assignKeys, dataKeyFromName } from "../form-engine/builder/data-model/data-model.js";
import { readDataModelInput } from "../form-engine/builder/data-model/read-input.js";
import { planDataModelReplace } from "../form-engine/builder/data/data-model-plan.js";
import { kernelStructureCheck } from "../form-engine/core/expressions/definition-structure.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

const DEFS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() }
];
const root = (): ComponentNode => ({ id: "root", type: "form", configuration: {}, children: { content: [] } });

describe("a sample key that is a name every object has", () => {
  it("is stored under a suffixed key, with a note saying why", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      expect(dataKeyFromName(name)).toBe(`${name}_key`);
    }
    expect(dataKeyFromName("toString")).toBe("toString");
    expect(dataKeyFromName("constructorName")).toBe("constructorName");
    const [entry] = assignKeys(["constructor"]);
    expect(entry?.key).toBe("constructor_key");
    expect(entry?.note?.code).toBe("renamed");
    expect(entry?.note?.message).toMatch(/name every object has/);
  });
  for (const name of ["__proto__", "constructor", "prototype"]) {
    it(`Replace from a sample with "${name}" succeeds and the form passes the kernel`, () => {
      const read = readDataModelInput(`{"${name}": "x", "ok": "y"}`);
      expect(read.ok).toBe(true);
      if (!read.ok) {
        return;
      }
      const c = new BuilderController({ initialRoot: root(), componentDefinitions: DEFS });
      const plan = planDataModelReplace(c, read.model);
      const result = c.replaceContent(plan.nodes, { keep: plan.keep });
      expect(result.ok).toBe(true);
      const found = kernelStructureCheck({ id: "f", version: "1", schemaVersion: "1", root: c.snapshot() } as never, undefined);
      expect(found.structure).toEqual([]);
    });
  }
});
