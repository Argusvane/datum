import { describe, expect, it } from "vitest";

import { estimatePageStarts } from "../form-engine/builder/print/print-breaks.js";

/**
 * The Print workspace's page-start estimate: blocks measured on one continuous sheet, walked
 * against the height of a page's content, by the print document's own break rules.
 */
describe("estimatePageStarts", () => {
  it("is one page and no start for no blocks, or a page height that is no height", () => {
    expect(estimatePageStarts([], 900)).toEqual({ starts: [], pages: 1 });
    expect(estimatePageStarts([{ top: 0, height: 100 }], 0)).toEqual({ starts: [], pages: 1 });
    expect(estimatePageStarts([{ top: 0, height: 100 }], Number.NaN)).toEqual({ starts: [], pages: 1 });
  });

  it("keeps blocks that fit on the first page there", () => {
    expect(estimatePageStarts([{ top: 0, height: 400 }, { top: 400, height: 500 }], 900)).toEqual({ starts: [], pages: 1 });
  });

  it("moves a block that crosses the foot of a page to the next one, whole", () => {
    const result = estimatePageStarts(
      [
        { top: 0, height: 700, componentId: "a" },
        { top: 700, height: 300, componentId: "b" },
        { top: 1000, height: 100, componentId: "c" }
      ],
      900
    );
    expect(result.starts).toEqual([{ page: 2, top: 700, forced: false, componentId: "b" }]);
    expect(result.pages).toBe(2);
  });

  it("starts a page at a forced break wherever it falls, but never a blank first page", () => {
    const result = estimatePageStarts(
      [
        { top: 0, height: 100, breakBefore: true, componentId: "first" },
        { top: 100, height: 100, componentId: "a" },
        { top: 200, height: 100, breakBefore: true, componentId: "household" }
      ],
      900
    );
    expect(result.starts).toEqual([{ page: 2, top: 200, forced: true, componentId: "household" }]);
  });

  it("measures the pages after a forced break from the break", () => {
    const result = estimatePageStarts(
      [
        { top: 0, height: 100 },
        { top: 100, height: 100, breakBefore: true, componentId: "b" },
        { top: 200, height: 750, componentId: "c" },
        { top: 950, height: 100, componentId: "d" }
      ],
      900
    );
    // The second page starts at 100 and ends at 1000: c fits on it, d does not.
    expect(result.starts.map((start) => [start.page, start.top, start.forced])).toEqual([
      [2, 100, true],
      [3, 950, false]
    ]);
  });

  it("splits a block taller than a page where each page ends", () => {
    const result = estimatePageStarts([{ top: 0, height: 100 }, { top: 100, height: 2000, componentId: "long" }], 900);
    // Taller than a page: it starts where it is and splits at 900 and 1800.
    expect(result.starts.map((start) => start.top)).toEqual([900, 1800]);
    expect(result.starts.every((start) => !start.forced && start.componentId === undefined)).toBe(true);
    expect(result.pages).toBe(3);
  });

  it("lets the fields and breaks inside a container taller than a page cut it, not page multiples", () => {
    const fields = Array.from({ length: 9 }, (_, index) => ({
      top: 100 + index * 300,
      height: 300,
      componentId: `f${index}`,
      ...(index === 5 ? { breakBefore: true } : {})
    }));
    const result = estimatePageStarts([{ top: 0, height: 100 }, { top: 100, height: 2700, breakBefore: true, container: true, componentId: "group" }, ...fields], 1000);
    expect(result.starts.map((start) => [start.top, start.forced, start.componentId])).toEqual([
      [100, true, "group"],
      [1000, false, "f3"],
      [1600, true, "f5"],
      [2500, false, "f8"]
    ]);
    expect(result.pages).toBe(5);
  });

  it("moves a kept-together container whole, and its fields with it", () => {
    const result = estimatePageStarts(
      [
        { top: 0, height: 800 },
        { top: 800, height: 400, componentId: "household" },
        { top: 810, height: 100, componentId: "member1" },
        { top: 910, height: 100, componentId: "member2" }
      ],
      900
    );
    expect(result.starts).toEqual([{ page: 2, top: 800, forced: false, componentId: "household" }]);
  });

  it("reads blocks in the order of the sheet whatever order they come in, and ignores unmeasurable ones", () => {
    const result = estimatePageStarts(
      [
        { top: 700, height: 300, componentId: "b" },
        { top: Number.NaN, height: 10 },
        { top: 0, height: 700, componentId: "a" },
        { top: 5, height: -1 }
      ],
      900
    );
    expect(result.starts).toEqual([{ page: 2, top: 700, forced: false, componentId: "b" }]);
  });
});
