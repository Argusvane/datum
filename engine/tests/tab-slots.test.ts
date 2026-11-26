import { describe, expect, it } from "vitest";

import { readTabDescriptors, tabSlotIds } from "../form-engine/render/core/tab-slots.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

const tabs: ComponentNode = {
  id: "sections",
  type: "tabs",
  configuration: {
    tabs: [
      { id: "tab_1", label: "Contact" },
      { id: "tab_2", label: "Billing" }
    ]
  },
  children: {
    tab_1: [{ id: "email", type: "text", configuration: { label: "Email" } }],
    tab_2: [{ id: "card", type: "text", configuration: { label: "Card" } }]
  }
};

describe("tab slots", () => {
  it("reads its tabs from configuration, in authored order", () => {
    expect(tabSlotIds(tabs)).toEqual(["tab_1", "tab_2"]);
    expect(readTabDescriptors(tabs)).toHaveLength(2);
  });

  it("declares a slot for a tab with nothing in it yet", () => {
    // Otherwise a newly-added tab would have nowhere to drop into.
    const empty: ComponentNode = {
      id: "t",
      type: "tabs",
      configuration: { tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }
    };
    expect(tabSlotIds(empty)).toEqual(["a", "b"]);
  });
});
