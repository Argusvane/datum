import { describe, expect, it } from "vitest";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * Alt+ArrowUp/Down and the command palette's Up/Down reach moveBy for whatever is selected. A
 * fixed component is not moved, as the selection bar's disabled Up and Down say, and nothing is
 * left behind for the canvas to paint as an alert on the next click.
 */

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

describe("moving a fixed component one place by keyboard", () => {
  it("does nothing and leaves no alert for the next selection to paint", () => {
    const c = make();
    c.select("w1");
    const events: Array<{ reason: string; dropError: string | undefined }> = [];
    c.on("change", (event) => events.push({ reason: event.reason, dropError: c.dropError }));
    expect(c.moveBy("w1", -1)).toBe(false);
    expect(c.requestMoveBy("w1", -1)).toBe(true);
    expect(order(c)).toEqual(["a", "w1"]);
    expect(c.dropError).toBeUndefined();
    expect(c.canUndo()).toBe(false);
    c.select("a");
    expect(events).toEqual([{ reason: "select", dropError: undefined }]);
  });

  it("a selection change puts down the alert a refused move() left", () => {
    const c = make();
    expect(c.move("w1", { parentId: "root", slotId: "content", index: 0 })).toBe(false);
    expect(c.dropError).toMatch(/fixed/);
    c.select("a");
    expect(c.dropError).toBeUndefined();
  });

  it("still moves a component that is not fixed", () => {
    const c = make();
    expect(c.moveBy("a", 1)).toBe(true);
    expect(order(c)).toEqual(["w1", "a"]);
  });
});
