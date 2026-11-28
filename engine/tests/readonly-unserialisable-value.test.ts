import { describe, expect, it } from "vitest";

import { FormStateStore } from "../form-engine/core/state/form-state.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildReadonlyRenderModel } from "../form-engine/render/readonly/readonly-renderer.js";

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

const root: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "picks", type: "checkboxes", configuration: { label: "Picks", options: [{ value: "a", label: "A" }] } },
      { id: "name", type: "text", configuration: { label: "Name" } }
    ]
  }
};

async function displayOf(value: unknown): Promise<{ picks: string | undefined; name: string | undefined }> {
  const state = { ...new FormStateStore("en").snapshot(), values: { picks: value, name: "Ada" } };
  const model = await buildReadonlyRenderModel(root, state, resolver);
  const of = (id: string) => model.components.find((component) => component.id === id)?.displayValue;
  return { picks: of("picks"), name: of("name") };
}

describe("a read-only render of a value JSON cannot hold", () => {
  it("shows a BigInt as its digits, alone or inside a value", async () => {
    expect(await displayOf(12n)).toEqual({ picks: "12", name: "Ada" });
    expect(await displayOf([1n, "a"])).toEqual({ picks: '["1","a"]', name: "Ada" });
    expect(await displayOf({ x: 2n })).toEqual({ picks: '{"x":"2"}', name: "Ada" });
  });

  it("draws the rest of the form when a value refers to itself", async () => {
    const cycle: unknown[] = ["a"];
    cycle.push(cycle);
    expect(await displayOf(cycle)).toEqual({ picks: "", name: "Ada" });
  });

  it("draws the rest of the form when a value cannot be written out", async () => {
    const throwing = {
      get x(): never {
        throw new Error("unreadable");
      }
    };
    expect(await displayOf(throwing)).toEqual({ picks: "", name: "Ada" });
    expect(await displayOf(() => 1)).toEqual({ picks: "", name: "Ada" });
  });
});
