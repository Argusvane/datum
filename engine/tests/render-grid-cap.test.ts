// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  GRID_MAX_COLUMNS,
  foldGridChildrenIntoColumns,
  gridColumnSlotIds,
  parseGridColumnWidths,
  readGridColumnCount,
  readGridColumnSpec
} from "../form-engine/core/schema/grid.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { markupOf, unmountAll } from "./live-datum-parts-kit.js";

afterEach(unmountAll);

const field = (id: string): ComponentNode => ({ id, type: "text", configuration: { label: id } });

describe("grid column cap", () => {
  it("reads at most the track count of equal columns, whatever the number", () => {
    expect(GRID_MAX_COLUMNS).toBe(12);
    expect(readGridColumnCount({ columns: 12 })).toBe(12);
    expect(readGridColumnCount({ columns: 13 })).toBe(12);
    expect(readGridColumnCount({ columns: 3_000_000 })).toBe(12);
    expect(readGridColumnCount({ columns: 1e300 })).toBe(12);
    expect(readGridColumnCount({ columns: "999999999999" })).toBe(12);
    expect(gridColumnSlotIds({ columns: 1e300 })).toHaveLength(12);
  });

  it("reads a span list only up to its twelfth entry", () => {
    const long = Array.from({ length: 100_000 }, () => 1);
    expect(parseGridColumnWidths(long)).toHaveLength(12);
    expect(parseGridColumnWidths(long.join(","))).toHaveLength(12);
    // Equal spans are equal columns, so a long list of ones is twelve equal columns.
    expect(readGridColumnSpec({ columns: long })).toEqual({ count: 12, spans: undefined });
    const sized = readGridColumnSpec({ columns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 12] });
    expect(sized.count).toBe(12);
    expect(sized.spans).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("does not read the entries past the cut, so a bad one there does not spoil the list", () => {
    expect(parseGridColumnWidths([6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, "x", 99])).toHaveLength(12);
  });

  it("keeps children left in a column past the cap: drawn after the declared columns, folded into the last one on the next edit", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "g",
            type: "grid",
            configuration: { columns: 300_000 },
            children: { column_1: [field("a")], column_20: [field("late")] }
          }
        ]
      }
    };
    const html = (await markupOf(root)).html;
    expect(html).toContain('data-columns="12"');
    // Past the cut the slot is undeclared: its cell trails the twelfth, and nothing is lost.
    expect(html).toContain('data-grid-column="column_20"');
    expect(html.indexOf('data-grid-column="column_20"')).toBeGreaterThan(html.indexOf('data-grid-column="column_12"'));
    expect(html).toContain("late");
    expect(html.length).toBeLessThan(200_000);

    const folded = foldGridChildrenIntoColumns(root.children?.content?.[0]?.children, gridColumnSlotIds({ columns: 300_000 }));
    expect(folded?.column_12?.map((node) => node.id)).toEqual(["late"]);
    expect(Object.keys(folded ?? {})).toHaveLength(12);
  });
});
