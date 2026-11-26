import { describe, expect, it } from "vitest";
import { chromePartIds, chromeTextRows, repeatedChromeIds } from "../form-engine/builder/controller/translation-rules.js";
import { kernelMaxComponentDepth } from "../form-engine/core/expressions/compile.js";

/** A header of groups inside groups `levels` deep, each holding one text part with an id of its own. */
const nested = (levels: number): unknown => {
  const innermost: Record<string, unknown> = { id: `g${levels}`, type: "group", parts: [] };
  let part = innermost;
  for (let level = levels - 1; level >= 1; level -= 1) {
    part = { id: `g${level}`, type: "group", parts: [part, { id: `t${level}`, type: "text", text: `T${level}` }] };
  }
  return { chrome: { header: [part], footer: [{ id: "g1", type: "text", text: "again" }] } };
};

describe("the chrome walks stop at the nesting a definition may have", () => {
  it("reads a hostile chrome nested far past the limit without exhausting the stack", () => {
    const configuration = nested(50_000);
    expect(() => chromeTextRows(configuration)).not.toThrow();
    expect(() => chromePartIds(configuration)).not.toThrow();
    expect(() => repeatedChromeIds(configuration)).not.toThrow();
    const limit = kernelMaxComponentDepth();
    expect(chromePartIds(configuration).length).toBeLessThanOrEqual(limit * 2 + 1);
    expect(chromeTextRows(configuration).length).toBeLessThanOrEqual(limit * 2 + 1);
  });
  it("still reads a chrome within the limit in full", () => {
    const configuration = nested(10);
    expect(chromePartIds(configuration)).toContain("g10");
    expect(repeatedChromeIds(configuration)).toEqual(["g1"]);
    expect(chromeTextRows(configuration).map((row) => row.partId)).toContain("t1");
  });
});
