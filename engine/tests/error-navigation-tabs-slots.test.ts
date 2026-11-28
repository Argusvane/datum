import { describe, expect, it } from "vitest";

import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { resolveErrorNavigationTarget } from "../form-engine/core/errors/error-navigation.js";
import { resolveFirstErrorFocusTarget } from "../form-engine/render/core/error-accessibility.js";
import type { FormError } from "../form-engine/core/errors/form-error.js";

const error: FormError = { id: "e", code: "validation.required", componentId: "x", stage: "field", source: "client" };

/** A slot-based `tabs` container: each declared tab is a child slot. */
function slotTabs(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "outer",
          type: "tabs",
          configuration: { tabs: [{ id: "first", label: "First" }, { id: "second", label: "Second" }] },
          children: {
            first: [],
            second: [
              {
                id: "inner",
                type: "tabs",
                configuration: { tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
                children: { a: [], b: [{ id: "x", type: "text", configuration: {} }] }
              }
            ]
          }
        }
      ]
    }
  };
}

describe("error navigation through a slot-based tabs container", () => {
  it("names the tab (slot) of each tabs container the field sits behind, nearest first", () => {
    const target = resolveErrorNavigationTarget(error, new ComponentTree(slotTabs()));
    expect(target.activateTabIds).toEqual(["b", "second"]);
    expect(target.activateTabSlots).toEqual([
      { tabsId: "inner", slotId: "b" },
      { tabsId: "outer", slotId: "second" }
    ]);
  });

  it("hands the same tabs to the first error's focus", () => {
    expect(resolveFirstErrorFocusTarget([error], new ComponentTree(slotTabs()))).toMatchObject({
      componentId: "x",
      activateTabIds: ["b", "second"],
      activateTabSlots: [
        { tabsId: "inner", slotId: "b" },
        { tabsId: "outer", slotId: "second" }
      ]
    });
  });

  it("keeps a `tab` node's own id, with no slot for a tabs container it is not in", () => {
    const tree = new ComponentTree({
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "tabA", type: "tab", configuration: {}, children: { content: [{ id: "x", type: "text", configuration: {} }] } }] }
    });
    const target = resolveErrorNavigationTarget(error, tree);
    expect(target.activateTabIds).toEqual(["tabA"]);
    expect(target.activateTabSlots).toEqual([]);
  });
});
