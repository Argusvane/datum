import { describe, expect, it } from "vitest";

import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { parseComponentPath } from "../form-engine/core/tree/component-path.js";
import { resolveErrorNavigationTarget } from "../form-engine/core/errors/error-navigation.js";

describe("error navigation", () => {
  it("collects tab and step activation ancestors", () => {
    const tree = new ComponentTree({
      id: "root",
      type: "container",
      configuration: {},
      children: {
        children: [
          {
            id: "step1",
            type: "step",
            configuration: {},
            children: {
              content: [
                {
                  id: "tabA",
                  type: "tab",
                  configuration: {},
                  children: {
                    content: [{ id: "postalCode", type: "text", configuration: {} }]
                  }
                }
              ]
            }
          }
        ]
      }
    });

    const target = resolveErrorNavigationTarget(
      {
        id: "e1",
        code: "validation.required",
        componentId: "postalCode",
        path: parseComponentPath("addresses[1].postalCode"),
        stage: "field",
        source: "client"
      },
      tree
    );

    expect(target.activateTabIds).toEqual(["tabA"]);
    expect(target.activateStepIds).toEqual(["step1"]);
    expect(target.instancePath).toBe("addresses[1].postalCode");
  });

  it("returns empty activation for form-level errors", () => {
    const tree = new ComponentTree({
      id: "root",
      type: "container",
      configuration: {}
    });

    const target = resolveErrorNavigationTarget(
      {
        id: "e2",
        code: "form.blocked",
        stage: "form",
        source: "server"
      },
      tree
    );

    expect(target.componentId).toBeUndefined();
    expect(target.activateTabIds).toEqual([]);
    expect(target.activateStepIds).toEqual([]);
  });
});

describe("error navigation through a steps container", () => {
  it("names the step an error's field sits in, nearest first, with the wizard's own steps", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "journey",
            type: "steps",
            configuration: {},
            children: {
              content: [
                { id: "about", type: "step", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: {} }] } },
                { id: "where", type: "step", configuration: {}, children: { content: [{ id: "city", type: "text", configuration: {} }] } }
              ]
            }
          }
        ]
      }
    };
    const tree = new ComponentTree(root);
    const target = resolveErrorNavigationTarget({ id: "e", code: "required", componentId: "city", stage: "field", source: "client" }, tree);
    expect(target.activateStepIds).toEqual(["where"]);
    expect(target.activateTabIds).toEqual([]);
  });
});
