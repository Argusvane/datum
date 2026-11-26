import { describe, expect, it } from "vitest";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { BUILDER_DRAG_MIME_TYPE } from "../form-engine/builder/drag-drop/html5-drag-drop.js";
import { moveRefusal } from "../form-engine/builder/drag-drop/move-legality.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/** A fixed component is refused in the same words by a canvas drop, move() and the move-legality rules. */

const DEFS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() },
  { type: "widget", version: "1.0.0", fixed: true, createDefault: () => ({ id: "widget", type: "widget", configuration: {} }), capabilities: [] } as ComponentDefinition
];
const root = (): ComponentNode => ({
  id: "root",
  type: "form",
  configuration: {},
  children: { content: [{ id: "a", type: "text", configuration: { label: "a" } }, { id: "w1", type: "widget", configuration: {} }] }
});
const make = () => new BuilderController({ initialRoot: root(), componentDefinitions: DEFS });
const order = (c: BuilderController) => (c.snapshot().children?.content ?? []).map((node) => node.id);
const drag = (payload: unknown) => {
  const store = new Map<string, string>([[BUILDER_DRAG_MIME_TYPE, JSON.stringify(payload)]]);
  return { setData: () => undefined, getData: (type: string) => store.get(type) ?? "" } as never;
};
const REASON = moveRefusal(root(), "w1", "root", "content", undefined, (node) => node.type === "widget")?.reason;

describe("moving a fixed component", () => {
  it("is worded by the move-legality rules", () => {
    expect(REASON).toBe('Component "w1" is fixed and cannot be moved');
  });

  it("move() refuses it and leaves the reason in dropError, changing nothing", () => {
    const c = make();
    expect(c.move("w1", { parentId: "root", slotId: "content", index: 0 })).toBe(false);
    expect(c.dropError).toBe(REASON);
    expect(order(c)).toEqual(["a", "w1"]);
    expect(c.canUndo()).toBe(false);
  });

  it("a dropped payload naming it is refused with the same words, and the canvas is told", () => {
    const c = make();
    const reasons: string[] = [];
    c.on("change", (event) => reasons.push(event.reason));
    c.applyDrop(drag({ kind: "existing-component", componentId: "w1" }), "root", "content", 0);
    expect(c.dropError).toBe(REASON);
    expect(reasons).toEqual(["edit"]);
    expect(order(c)).toEqual(["a", "w1"]);
    expect(c.canUndo()).toBe(false);
    // The next move that lands clears it.
    expect(c.move("a", { parentId: "root", slotId: "content", index: 2 })).toBe(true);
    expect(c.dropError).toBeUndefined();
  });

  it("offers it no place to go", () => {
    expect(make().moveTargets("w1")).toEqual([]);
  });
});
