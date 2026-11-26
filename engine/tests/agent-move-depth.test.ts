import { describe, expect, it } from "vitest";
import { agentBuilder } from "./fixtures/agent-builder.js";

describe("move_component and the depth limit", () => {
  it("refuses a move that nests the subtree past 32 levels, and moves within the limit", async () => {
    const builder = agentBuilder();
    const rootId = builder.controller.snapshot().id;
    for (const tag of ["x", "y"]) {
      let parent = rootId;
      for (let level = 0; level < 20; level += 1) {
        const result = builder.controller.insertComponents([
          { node: { id: `${tag}${level}`, type: "group", configuration: {}, children: { content: [] } }, parentId: parent, slotId: "content" } as never
        ]);
        expect(result.ok).toBe(true);
        parent = `${tag}${level}`;
      }
    }
    const revision = builder.controller.snapshot();
    const refused: any = await builder.execute("move_component", { componentId: "x0", parentId: "y19" });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("structure-limit");
    expect(refused.message).toContain("32 levels");
    expect(JSON.stringify(builder.controller.snapshot())).toBe(JSON.stringify(revision));

    // A shallower destination takes the same subtree.
    const allowed: any = await builder.execute("move_component", { componentId: "x0", parentId: "y2" });
    expect(allowed.ok).toBe(true);
    expect(builder.controller.parentOf("x0")?.parentId).toBe("y2");
  });
});
