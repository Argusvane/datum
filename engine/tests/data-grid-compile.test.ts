import { describe, expect, it } from "vitest";

import { compileFormDefinition } from "../form-engine/runtime/browser/form-runtime.js";
import { kernelMaxComponentDepth } from "../form-engine/core/expressions/compile.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";

// The browser compiles a definition through `normalizeDataGrids`
// before it measures the depth. The normalizer stops one level past the limit, as the kernel's
// mirror does, so a tree of any depth with an unbound grid in it is refused with the depth
// message, never a RangeError, and the browser refuses exactly what the kernel refuses.

const unboundGrid = (): ComponentNode =>
  ({
    id: "lines",
    type: "dataGrid",
    configuration: {},
    children: { content: [{ id: "sku", type: "text", configuration: { required: true } }] }
  }) as unknown as ComponentNode;

/** The unbound grid at `level`, the root being level 1. */
function gridAt(level: number): ComponentNode {
  let inner = unboundGrid();
  for (let at = level - 1; at >= 2; at -= 1) {
    inner = { id: "g" + at, type: "group", configuration: {}, children: { content: [inner] } } as unknown as ComponentNode;
  }
  return { id: "form", type: "form", configuration: {}, children: { content: [inner] } } as unknown as ComponentNode;
}

const definition = (root: ComponentNode): FormDefinition => ({ id: "f", version: "1", schemaVersion: "1", root }) as unknown as FormDefinition;
const depthMessage = new RegExp(`^Components nest more than ${kernelMaxComponentDepth()} levels deep \\(at root > `);

describe("compileFormDefinition and an unbound data grid near and past the depth limit", () => {
  it("binds a grid whose row stays within the limit at its id, as the kernel does", () => {
    const compiled = compileFormDefinition(definition(gridAt(31)));
    let grid: ComponentNode = compiled.definition.root;
    while (grid.type !== "dataGrid") {
      grid = grid.children!.content![0]!;
    }
    expect(grid.collection).toEqual({ collectionPath: "lines" });
    expect(grid.children?.content?.map((child) => child.id)).toEqual(["sku"]);
    expect(runKernel({ formId: "f", locale: "en", form: gridAt(31), values: { lines: [{}] } }, []).errors.map((error) => error.code)).toEqual(["required"]);
  });

  it("refuses with the depth message where the row lands past the limit, as the kernel does", () => {
    expect(() => compileFormDefinition(definition(gridAt(32)))).toThrow(depthMessage);
    expect(() => compileFormDefinition(definition(gridAt(32)))).toThrow(/ > lines > content > sku\)/);
    expect(runKernel({ formId: "f", locale: "en", form: gridAt(32), values: {} }, []).errors.map((error) => error.code)).toEqual(["definition.tooDeep"]);
  });

  it("refuses thousands of levels above an unbound grid with the depth message, never a RangeError", () => {
    for (const level of [40, 3000]) {
      let thrown: unknown;
      try {
        compileFormDefinition(definition(gridAt(level)));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, String(level)).toBeInstanceOf(Error);
      expect(thrown, String(level)).not.toBeInstanceOf(RangeError);
      expect((thrown as Error).message, String(level)).toMatch(depthMessage);
      expect(runKernel({ formId: "f", locale: "en", form: gridAt(level), values: {} }, []).errors.map((error) => error.code), String(level)).toEqual(["definition.tooDeep"]);
    }
  });
});
