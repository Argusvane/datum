import { describe, expect, it } from "vitest";

import { moveRefusal } from "../form-engine/builder/drag-drop/move-legality.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/** A fixed component is edited, never moved: the refusal a drop and a keyboard Move to share. */

const root: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "stamp", type: "widget", configuration: {} },
      { id: "name", type: "text", configuration: {} },
      { id: "box", type: "container", configuration: {}, children: { content: [] } }
    ]
  }
};

const fixedWidgets = (node: ComponentNode): boolean => node.type === "widget";

describe("moveRefusal and a fixed component", () => {
  it("refuses a move of a fixed component with its own code, whichever the destination", () => {
    expect(moveRefusal(root, "stamp", "box", "content", undefined, fixedWidgets)).toEqual({
      code: "fixed",
      reason: 'Component "stamp" is fixed and cannot be moved'
    });
    expect(moveRefusal(root, "stamp", "root", "content", undefined, fixedWidgets)?.code).toBe("fixed");
  });

  it("keeps the other refusals first and lets an ordinary component go where it could", () => {
    expect(moveRefusal(root, "root", "box", "content", undefined, fixedWidgets)?.code).toBe("root");
    expect(moveRefusal(root, "nope", "box", "content", undefined, fixedWidgets)?.code).toBe("missing");
    expect(moveRefusal(root, "name", "box", "content", undefined, fixedWidgets)).toBeUndefined();
  });

  it("asks nothing about fixed-ness when the caller does not say", () => {
    expect(moveRefusal(root, "stamp", "box", "content")).toBeUndefined();
  });
});
