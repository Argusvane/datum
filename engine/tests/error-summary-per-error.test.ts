import { describe, expect, it } from "vitest";

import { buildRenderOutput } from "../form-engine/render/core/render-orchestrator.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import type { FormError } from "../form-engine/core/errors/form-error.js";

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

/** Two `tab` panels in a `tabs` container, one field in each. */
function tabsRoot(first: string, second: string): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "tabs",
          type: "tabs",
          configuration: {},
          children: {
            content: [
              { id: "tab1", type: "tab", configuration: { label: "T1" }, children: { content: [{ id: first, type: "text", configuration: { label: "A field" } }] } },
              { id: "tab2", type: "tab", configuration: { label: "T2" }, children: { content: [{ id: second, type: "text", configuration: { label: "B field" } }] } }
            ]
          }
        }
      ]
    }
  };
}

async function render(root: ComponentNode, errors: FormError[]) {
  return buildRenderOutput({
    mode: "interactive",
    root,
    state: new FormStateStore("en").snapshot(),
    resolver,
    errors,
    componentTree: new ComponentTree(root)
  });
}

describe("the error summary outside a journey", () => {
  it("lists each error on a component the render does not carry, with its message, and counts them all", async () => {
    const output = await render(tabsRoot("a", "b"), [
      { id: "s1", code: "server.a", message: "Email already registered", componentId: "emailAddress", stage: "server", source: "server" },
      { id: "s2", code: "server.b", message: "Email domain blocked", componentId: "emailAddress", stage: "server", source: "server" }
    ]);
    const summary = output.meta.errorSummary;
    expect(summary.heading).toBe("2 errors");
    expect(summary.entries.map((entry) => [entry.targetPath, entry.message, entry.text])).toEqual([
      ["emailAddress", "Email already registered", "Email already registered"],
      ["emailAddress", "Email domain blocked", "Email domain blocked"]
    ]);
  });

  it("counts errors by component ids that name a property of every object", async () => {
    const output = await render(tabsRoot("toString", "valueOf"), [
      { id: "e1", code: "required", componentId: "toString", stage: "field", source: "client" },
      { id: "e2", code: "required", componentId: "valueOf", stage: "field", source: "client" },
      { id: "e3", code: "required", componentId: "valueOf", stage: "field", source: "client" }
    ]);
    expect({ ...output.meta.errorSummary.byComponent }).toEqual({ toString: 1, valueOf: 2 });
    expect(output.meta.errorSummary.entries.map((entry) => entry.componentId)).toEqual(["toString", "valueOf", "valueOf"]);
  });
});

describe("the first error's focus", () => {
  it("takes its component, its tabs and its control from the one error the summary lists first", async () => {
    // The warning puts `a` first in the summary's order; its blocking error comes after `b`'s.
    const output = await render(tabsRoot("a", "b"), [
      { id: "w", code: "custom", message: "Heads up", severity: "warning", componentId: "a", stage: "server", source: "server" },
      { id: "r", code: "required", componentId: "b", stage: "field", source: "client" },
      { id: "s", code: "server", message: "Server says no", componentId: "a", stage: "server", source: "server" }
    ]);
    const first = output.meta.errorSummary.entries[0];
    expect(first?.componentId).toBe("a");
    expect(output.meta.firstErrorFocus).toMatchObject({
      componentId: "a",
      targetComponentId: "a",
      targetPath: "a",
      activateTabIds: ["tab1", "content"]
    });
  });
});
