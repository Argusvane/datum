import { describe, expect, it } from "vitest";

import {
  appliesToKind,
  DRAWING_CAPABILITIES,
  drawingCapabilitiesOf,
  drawingCapability
} from "../form-engine/registry/capabilities/drawing-capabilities.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";

describe("drawing capabilities", () => {
  it("lists each capability once", () => {
    const ids = DRAWING_CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["notice", "pending", "characterCount", "hideLabel", "prefix", "suffix", "tooltip", "rowNumbers"]));
  });

  it("applies notice and pending to every field kind", () => {
    for (const kind of ["text", "number", "date", "boolean", "choice", "multichoice", "collection", "file", "signature", "group"] as const) {
      expect(appliesToKind("notice", kind)).toBe(true);
      expect(appliesToKind("pending", kind)).toBe(true);
    }
  });

  it("scopes the narrower ones to the kinds that can draw them", () => {
    expect(drawingCapabilitiesOf("text").map((capability) => capability.id)).toEqual(
      expect.arrayContaining(["characterCount", "prefix", "suffix", "placeholder"])
    );
    expect(appliesToKind("characterCount", "choice")).toBe(false);
    expect(appliesToKind("rowNumbers", "collection")).toBe(true);
    expect(appliesToKind("rowNumbers", "text")).toBe(false);
  });

  it("is a separate set from the editor capabilities", () => {
    // `notice` and `pending` are drawn, never authored: there is no inspector capability for them.
    expect(standardFieldCapabilities().map((capability) => capability.id)).not.toContain("notice");
    expect(standardFieldCapabilities().map((capability) => capability.id)).not.toContain("pending");
    expect(() => drawingCapability("notice")).not.toThrow();
  });
});
