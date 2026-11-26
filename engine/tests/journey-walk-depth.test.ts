import { describe, expect, it } from "vitest";

import { kernelMaxComponentDepth } from "../form-engine/core/expressions/compile.js";
import { buildPresentationIndex } from "../form-engine/core/journey/presentation.js";
import { JOURNEY_PATH_FUNCTIONS, journeyMaxDepth, journeyOwnership, journeyTargetUsable } from "../form-engine/core/journey/journey-path.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { formRecords, listedAbove } from "../form-engine/builder/journey-designer/journey-authoring.js";

// The walks up and down a form's tree that the journey path, the presentation index and the
// designer make are bounded by the depth no definition may pass, so a tree that loops back on
// itself (a node its own descendant) or nests absurdly ends instead of hanging the tab or the
// server.

const DEPTH = kernelMaxComponentDepth();

function leaf(id: string): ComponentNode {
  return { id, type: "text", configuration: { label: id } };
}

/** A form whose one section holds itself: the same object, its own child. */
function selfHolding(): ComponentNode {
  const loop: ComponentNode = { id: "loop", type: "group", configuration: { label: "loop" }, children: { content: [] } };
  (loop.children as Record<string, ComponentNode[]>).content!.push(loop, leaf("inside"));
  return { id: "form", type: "form", configuration: {}, children: { content: [loop] } };
}

/** A form nested `levels` groups deep, a field at the bottom. */
function nested(levels: number): ComponentNode {
  let inner: ComponentNode = leaf("bottom");
  for (let level = levels; level > 0; level -= 1) {
    inner = { id: `g${level}`, type: "group", configuration: { label: `g${level}` }, children: { content: [inner] } };
  }
  return { id: "form", type: "form", configuration: {}, children: { content: [inner] } };
}

const journey: Journey = { id: "main", pages: [{ id: "one", components: ["loop"] }] } as unknown as Journey;

describe("the journey walks are bounded by the depth a definition may nest", () => {
  it("the path engine's own copy of the bound is the kernel's, and is spliced in beside the others", () => {
    expect(journeyMaxDepth()).toBe(DEPTH);
    expect(JOURNEY_PATH_FUNCTIONS).toContain(journeyMaxDepth);
  });

  it("journeyTargetUsable ends on a parent map that loops", () => {
    const nodeById = { a: leaf("a"), b: { id: "b", type: "group", configuration: {} } as ComponentNode, form: { id: "form", type: "form", configuration: {} } as ComponentNode };
    expect(journeyTargetUsable("a", nodeById, { a: "b", b: "a" }, "form")).toBe(false);
    expect(journeyTargetUsable("a", nodeById, { a: "a" }, "form")).toBe(false);
  });

  it("journeyTargetUsable still reads an honest chain, to the deepest level", () => {
    const root = nested(DEPTH - 2);
    const { nodeById, parentOf } = formRecords(root);
    expect(journeyTargetUsable("bottom", nodeById, parentOf, "form")).toBe(true);
  });

  it("journeyOwnership ends on a tree that holds itself, and indexes no node past the bound", () => {
    const ownership = journeyOwnership(selfHolding(), journey);
    expect(ownership.order.length).toBeLessThanOrEqual(DEPTH * 2 + 1);
    expect(ownership.pagesOf.loop).toEqual(["one"]);
  });

  it("journeyOwnership indexes an over-deep tree to the bound and no further", () => {
    const ownership = journeyOwnership(nested(DEPTH * 4), { id: "main", pages: [{ id: "one", components: ["g1"] }] } as unknown as Journey);
    expect(ownership.order).toHaveLength(DEPTH);
  });

  it("buildPresentationIndex reads an over-deep tree to the bound and no further", () => {
    const own = { id: "note", type: "text", configuration: { label: "Note" } };
    const deep = { id: "main", pages: [{ id: "one", components: ["g1", own] }] } as unknown as Journey;
    const root = nested(DEPTH * 4);
    const index = buildPresentationIndex(root, deep, journeyOwnership(root, deep), () => true);
    expect(index).toBeDefined();
    expect(Object.keys(index!.nodeById)).toContain("note");
    // g1 and what is below it, within the bound: the page draws no further down.
    expect(Object.keys(index!.drawnOf.one!)).toHaveLength(DEPTH);
  });

  it("the designer's form records end on a tree that holds itself and on an over-deep one", () => {
    expect(Object.keys(formRecords(selfHolding()).nodeById).length).toBeLessThanOrEqual(3);
    expect(Object.keys(formRecords(nested(DEPTH * 4)).nodeById)).toHaveLength(DEPTH);
  });

  it("the designer's listed-above walk ends on a parent map that loops", () => {
    const placed = new Set<string>(["elsewhere"]);
    expect(listedAbove("a", { a: "b", b: "a" }, placed)).toBe(false);
    expect(listedAbove("a", { a: "b", b: "c" }, new Set(["c"]))).toBe(true);
    expect(listedAbove("a", { a: "a" }, placed)).toBe(false);
  });
});
