import { describe, expect, it } from "vitest";

import {
  nextFocusableId,
  previousFocusableId
} from "../form-engine/core/accessibility/keyboard-navigation.js";

describe("keyboard navigation", () => {
  it("resolves next focusable id", () => {
    const next = nextFocusableId({
      mode: "standard",
      orderedFocusableIds: ["a", "b", "c"],
      currentFocusIndex: 0
    });

    expect(next).toBe("b");
  });

  it("resolves previous focusable id", () => {
    const prev = previousFocusableId({
      mode: "standard",
      orderedFocusableIds: ["a", "b", "c"],
      currentFocusIndex: 2
    });

    expect(prev).toBe("b");
  });
});
