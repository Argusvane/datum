import { describe, expect, it } from "vitest";

import { ErrorStore } from "../form-engine/validation/core/error-store.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormError } from "../form-engine/core/errors/form-error.js";

function tree(): ComponentTree {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "step1",
          type: "step",
          configuration: {},
          children: {
            content: [
              {
                id: "addressTab",
                type: "tab",
                configuration: {},
                children: {
                  content: [
                    { id: "street", type: "text", configuration: {} },
                    { id: "postalCode", type: "text", configuration: {} }
                  ]
                }
              }
            ]
          }
        },
        {
          id: "step2",
          type: "step",
          configuration: {},
          children: { content: [{ id: "email", type: "text", configuration: {} }] }
        }
      ]
    }
  };
  return new ComponentTree(root);
}

const err = (componentId: string, code = "required"): FormError => ({
  id: `${componentId}-${code}`,
  code,
  componentId,
  stage: "field",
  source: "client"
});

describe("ErrorStore hierarchical aggregation", () => {
  it("collects errors across a subtree", () => {
    const store = new ErrorStore();
    store.setTree(tree());
    store.setAll([err("street"), err("postalCode"), err("email")]);

    expect(store.forSubtree("addressTab").map((e) => e.componentId).sort()).toEqual([
      "postalCode",
      "street"
    ]);
    expect(store.forSubtree("step1")).toHaveLength(2);
    expect(store.forSubtree("step2")).toHaveLength(1);
  });

  it("rolls counts up to containers via ancestor resolution", () => {
    const store = new ErrorStore();
    store.setTree(tree());
    store.setAll([err("street"), err("postalCode")]);

    const byContainer = store.aggregateByContainer();
    expect(byContainer.get("street")).toEqual({ own: 1, descendants: 0 });
    expect(byContainer.get("addressTab")).toEqual({ own: 0, descendants: 2 });
    expect(byContainer.get("step1")).toEqual({ own: 0, descendants: 2 });
    expect(byContainer.get("root")).toEqual({ own: 0, descendants: 2 });
  });

  it("summarizes errors per wizard step", () => {
    const store = new ErrorStore();
    store.setTree(tree());
    store.setAll([err("street"), err("postalCode"), err("email")]);

    expect(store.summaryForStep("step1")).toEqual({
      errorCount: 2,
      componentIds: ["street", "postalCode"]
    });
    expect(store.summaryForStep("step2")).toEqual({
      errorCount: 1,
      componentIds: ["email"]
    });
  });
});
