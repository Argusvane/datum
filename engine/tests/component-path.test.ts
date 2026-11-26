import { describe, expect, it } from "vitest";

import {
  appendSegment,
  equalsPath,
  parseComponentPath,
  stringifyComponentPath
} from "../form-engine/core/tree/component-path.js";

describe("component path", () => {
  it("parses and stringifies row-scoped paths", () => {
    const path = parseComponentPath("addresses[1].postalCode");
    expect(path.segments).toHaveLength(2);
    expect(stringifyComponentPath(path)).toBe("addresses[1].postalCode");
  });

  it("appends segments deterministically", () => {
    const base = parseComponentPath("accounts[0]");
    const appended = appendSegment(base, { key: "balance" });
    expect(stringifyComponentPath(appended)).toBe("accounts[0].balance");
  });

  it("checks structural equality", () => {
    const a = parseComponentPath("a[0].b");
    const b = parseComponentPath("a[0].b");
    const c = parseComponentPath("a[1].b");

    expect(equalsPath(a, b)).toBe(true);
    expect(equalsPath(a, c)).toBe(false);
  });
});
