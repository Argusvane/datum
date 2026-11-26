import { describe, expect, it } from "vitest";

import { buildRenderOutput } from "../form-engine/render/core/render-orchestrator.js";
import { layoutForNode } from "../form-engine/render/core/component-model.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

function form(children: ComponentNode[]): ComponentNode {
  return { id: "root", type: "form", configuration: {}, children: { content: children } };
}

async function render(root: ComponentNode) {
  return buildRenderOutput({
    mode: "interactive",
    root,
    state: new FormStateStore("en").snapshot(),
    resolver
  });
}

describe("layoutForNode", () => {
  it("stacks non-layout components and containers", () => {
    expect(layoutForNode({ id: "a", type: "text", configuration: {} })).toEqual({ kind: "stack" });
    expect(layoutForNode({ id: "s", type: "fieldset", configuration: {}, children: {} })).toEqual({
      kind: "stack"
    });
  });

  it("reads the column count of a grid (default 2)", () => {
    expect(layoutForNode({ id: "g", type: "grid", configuration: { columns: 3 } })).toEqual({
      kind: "grid",
      columns: 3
    });
    expect(layoutForNode({ id: "g", type: "grid", configuration: {} })).toEqual({
      kind: "grid",
      columns: 2
    });
  });
});

describe("render model — container-driven layout", () => {
  it("marks a grid container and stamps its layout onto descendant models", async () => {
    const root = form([
      { id: "name", type: "text", configuration: {} },
      {
        id: "address",
        type: "grid",
        configuration: { columns: 3 },
        children: {
          column_1: [{ id: "street", type: "text", configuration: {} }],
          column_2: [{ id: "city", type: "text", configuration: {} }]
        }
      },
      { id: "notes", type: "text", configuration: {} }
    ]);

    const output = await render(root);
    const pick = (id: string) => {
      const model = output.components.find((m) => m.id === id);
      if (!model) throw new Error(`no model ${id}`);
      return model;
    };

    // Top-level fields stack (no container path).
    expect(pick("name").containerPath).toEqual([]);
    expect(pick("notes").containerPath).toEqual([]);

    // The grid node is a layout container, not a field.
    expect(pick("address").isLayoutContainer).toBe(true);
    expect(pick("address").layout).toEqual({ kind: "grid", columns: 3 });

    // Its children carry it in containerPath and know their depth.
    expect(pick("street").containerPath).toEqual(["address"]);
    expect(pick("street").isLayoutContainer).toBe(false);
    expect(pick("street").parentId).toBe("address");
    expect(pick("city").containerPath).toEqual(["address"]);

    expect(output.meta.containersById["address"]).toEqual({
      type: "grid",
      layout: { kind: "grid", columns: 3 },
      slotIds: ["column_1", "column_2"]
    });
  });

  it("does not put children of a non-layout container in a container path", async () => {
    const root = form([
      {
        id: "section",
        type: "fieldset",
        configuration: {},
        children: { content: [{ id: "field", type: "text", configuration: {} }] }
      }
    ]);
    const output = await render(root);
    const field = output.components.find((m) => m.id === "field");
    expect(field?.containerPath).toEqual([]);
    expect(output.meta.containersById["section"]?.layout).toEqual({ kind: "stack" });
  });

  it("nests layout containers (grid inside grid) in containerPath order", async () => {
    const root = form([
      {
        id: "outer",
        type: "grid",
        configuration: { columns: 2 },
        children: {
          column_1: [
            {
              id: "inner",
              type: "grid",
              configuration: { columns: 2 },
              children: { column_1: [{ id: "leaf", type: "text", configuration: {} }] }
            }
          ]
        }
      }
    ]);
    const output = await render(root);
    const leaf = output.components.find((m) => m.id === "leaf");
    expect(leaf?.containerPath).toEqual(["outer", "inner"]);
    expect(leaf?.depth).toBe(3);
  });
});
