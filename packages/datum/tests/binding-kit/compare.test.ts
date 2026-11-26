import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { KIT, load } from "./load.js";

const mod = () => load(join(KIT, "lib", "compare.mjs"));
const box = (over: object = {}) => ({ el: "label", text: "Name", x: 0, y: 0, w: 100, h: 20, font: "19px 400 normal Arial / 25px", color: "rgb(0, 0, 0)", background: "rgba(0, 0, 0, 0)", border: "0px 0px 0px 0px none rgb(0, 0, 0)", ...over });

describe("comparing drawn trees", () => {
  it("diffs lines by side", async () => {
    const { diffLines } = await mod();
    expect(diffLines(["a", "b", "c"], ["a", "c", "d"])).toEqual([
      { side: "reference only", line: "b" },
      { side: "binding only", line: "d" }
    ]);
  });

  it("drops ignored lines from both sides before comparing", async () => {
    const { compareTexts } = await mod();
    const result = compareTexts(["x", "[live] [sr] You have 3", "y"], ["x", "y"], [{ match: "^\\[live\\]", reason: "announcer" }]);
    expect(result.equal).toBe(true);
    expect(compareTexts(["x"], ["y"]).equal).toBe(false);
  });

  it("pairs elements in order and allows the box tolerance but not a colour", async () => {
    const { compareBoxes } = await mod();
    expect(compareBoxes([box()], [box({ x: 1, w: 99 })], 1).mismatches).toEqual([]);
    const off = compareBoxes([box()], [box({ x: 3 })], 1);
    expect(off.mismatches[0].fields).toEqual(["x"]);
    expect(compareBoxes([box()], [box({ color: "rgb(1, 1, 1)" })], 1).mismatches[0].fields).toEqual(["color"]);
    expect(compareBoxes([box(), box()], [box()], 1).mismatches[0].fields).toEqual(["count"]);
  });

  it("leaves out elements an ignore entry matches, on both sides", async () => {
    const { compareBoxes } = await mod();
    const status = box({ text: "You have 10 characters r", w: 1, h: 1 });
    expect(compareBoxes([box(), status], [box()], 1, [{ match: "^You have", reason: "announcer" }]).mismatches).toEqual([]);
  });
});
