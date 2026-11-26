import { describe, expect, it } from "vitest";

import { buildErrorAnnouncement, resolveFirstErrorFocusTarget } from "../form-engine/render/core/error-accessibility.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { parseComponentPath } from "../form-engine/core/tree/component-path.js";

describe("error accessibility", () => {
  it("builds announcement text", () => {
    const announcement = buildErrorAnnouncement({
      id: "e1",
      code: "validation.required",
      componentId: "postalCode",
      path: parseComponentPath("addresses[1].postalCode"),
      stage: "field",
      source: "client"
    });

    expect(announcement.text).toContain("validation.required");
    expect(announcement.text).toContain("addresses[1].postalCode");
  });

  it("resolves first error focus with ancestor activation", () => {
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

    const target = resolveFirstErrorFocusTarget(
      [
        {
          id: "e1",
          code: "validation.required",
          componentId: "postalCode",
          stage: "field",
          source: "client"
        }
      ],
      tree
    );

    expect(target?.componentId).toBe("postalCode");
    expect(target?.activateTabIds).toEqual(["tabA"]);
    expect(target?.activateStepIds).toEqual(["step1"]);
  });
});
