import { describe, expect, it } from "vitest";

import {
  parseVersionRange,
  satisfies,
  maxSatisfying
} from "../form-engine/registry/version-range.js";

describe("parseVersionRange", () => {
  it("parses caret ranges (with the 0.x special cases)", () => {
    expect(parseVersionRange("^1.2.3")).toEqual({ min: "1.2.3", max: "2.0.0", maxInclusive: false });
    expect(parseVersionRange("^0.2.3")).toEqual({ min: "0.2.3", max: "0.3.0", maxInclusive: false });
    expect(parseVersionRange("^0.0.3")).toEqual({ min: "0.0.3", max: "0.0.4", maxInclusive: false });
  });

  it("parses tilde ranges", () => {
    expect(parseVersionRange("~1.2.3")).toEqual({ min: "1.2.3", max: "1.3.0", maxInclusive: false });
    expect(parseVersionRange("~1")).toEqual({ min: "1.0.0", max: "2.0.0", maxInclusive: false });
  });

  it("parses comparators and wildcards", () => {
    expect(parseVersionRange(">=1.2.0")).toEqual({ min: "1.2.0" });
    expect(parseVersionRange(">1.2.0")).toEqual({ min: "1.2.0", minExclusive: true });
    expect(parseVersionRange("<2.0.0")).toEqual({ max: "2.0.0", maxInclusive: false });
    expect(parseVersionRange("<=2.0.0")).toEqual({ max: "2.0.0", maxInclusive: true });
    expect(parseVersionRange("1.x")).toEqual({ min: "1.0.0", max: "2.0.0", maxInclusive: false });
    expect(parseVersionRange("1.2.x")).toEqual({ min: "1.2.0", max: "1.3.0", maxInclusive: false });
    expect(parseVersionRange("*")).toEqual({});
  });

  it("treats a bare version as exact", () => {
    expect(parseVersionRange("1.2.3")).toEqual({ exact: "1.2.3" });
  });
});

describe("satisfies", () => {
  it.each([
    ["1.2.5", "^1.2.3", true],
    ["1.9.9", "^1.2.3", true],
    ["2.0.0", "^1.2.3", false],
    ["1.2.2", "^1.2.3", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["1.2.0", ">=1.2.0", true],
    ["1.2.0", ">1.2.0", false],
    ["1.5.0", "1.x", true],
    ["2.0.0", "1.x", false],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
    ["9.9.9", "*", true]
  ])("satisfies(%s, %s) === %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe("maxSatisfying", () => {
  it("returns the highest matching version", () => {
    expect(maxSatisfying(["1.0.0", "1.2.0", "1.9.0", "2.0.0"], "^1.1.0")).toBe("1.9.0");
    expect(maxSatisfying(["1.0.0", "2.0.0"], "^3.0.0")).toBeUndefined();
  });
});
