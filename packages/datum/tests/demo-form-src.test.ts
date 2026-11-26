import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs demo module, no declaration file
import { formSrcFromSearch } from "../demo/form-src.mjs";

describe("demo form.html ?src=", () => {
  it("accepts relative paths and http(s) addresses", () => {
    expect(formSrcFromSearch("?src=/demo/other.json")).toBe("/demo/other.json");
    expect(formSrcFromSearch("?src=forms/a.json")).toBe("forms/a.json");
    expect(formSrcFromSearch("?src=https%3A%2F%2Fexample.org%2Fa.json")).toBe("https://example.org/a.json");
  });
  it("ignores other schemes and an absent or empty value", () => {
    for (const bad of ["javascript:alert(1)", "data:application/json,{}", "file:///etc/passwd", "blob:x"]) {
      expect(formSrcFromSearch(`?src=${encodeURIComponent(bad)}`)).toBeUndefined();
    }
    expect(formSrcFromSearch("")).toBeUndefined();
    expect(formSrcFromSearch("?src=")).toBeUndefined();
  });
});
