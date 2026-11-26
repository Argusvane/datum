import { describe, expect, it } from "vitest";

import {
  DEFAULT_GRID_COLUMNS,
  GRID_TRACK_COUNT,
  emptyGridChildren,
  foldGridChildrenIntoColumns,
  formatGridColumnWidths,
  gridColumnSlotId,
  gridColumnSlotIds,
  parseGridColumnWidths,
  readGridColumnCount,
  readGridColumnSpec,
  readGridColumnWidths
} from "../form-engine/core/schema/grid.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

const field = (id: string): ComponentNode => ({ id, type: "text", configuration: {} });

describe("grid columns", () => {
  it("reads the column count, defaulting and clamping to a usable grid", () => {
    expect(readGridColumnCount({ columns: 3 })).toBe(3);
    expect(readGridColumnCount({})).toBe(DEFAULT_GRID_COLUMNS);
    expect(readGridColumnCount(undefined)).toBe(DEFAULT_GRID_COLUMNS);
    // The builder's text box stores the count as text; it reads the same.
    expect(readGridColumnCount({ columns: "3" })).toBe(3);
    expect(readGridColumnCount({ columns: " 4 " })).toBe(4);
    expect(readGridColumnCount({ columns: "three" })).toBe(DEFAULT_GRID_COLUMNS);
    expect(readGridColumnCount({ columns: Number.NaN })).toBe(DEFAULT_GRID_COLUMNS);
    // Below one is not a grid; a fraction has no slot.
    expect(readGridColumnCount({ columns: 0 })).toBe(1);
    expect(readGridColumnCount({ columns: -4 })).toBe(1);
    expect(readGridColumnCount({ columns: 2.9 })).toBe(2);
  });

  it("names one slot per column, left to right", () => {
    expect(gridColumnSlotId(1)).toBe("column_1");
    expect(gridColumnSlotIds({ columns: 3 })).toEqual(["column_1", "column_2", "column_3"]);
    expect(gridColumnSlotIds({})).toEqual(["column_1", "column_2"]);
    expect(Object.keys(emptyGridChildren({ columns: 2 }))).toEqual(["column_1", "column_2"]);
    expect(emptyGridChildren({ columns: 1 })).toEqual({ column_1: [] });
  });

  it("folds a removed column's children into the last remaining one, after its own", () => {
    const folded = foldGridChildrenIntoColumns(
      {
        column_1: [field("a")],
        column_2: [field("b")],
        column_3: [field("c"), field("d")]
      },
      ["column_1", "column_2"]
    );
    expect(folded).toEqual({
      column_1: [field("a")],
      column_2: [field("b"), field("c"), field("d")]
    });
  });

  it("folds a legacy content slot the same way, so nothing authored is lost", () => {
    // A grid from before columns were slots kept everything under `content`.
    const folded = foldGridChildrenIntoColumns(
      { content: [field("a"), field("b")] },
      ["column_1", "column_2"]
    );
    expect(folded).toEqual({ column_1: [], column_2: [field("a"), field("b")] });
  });

  it("reports nothing to do when every slot is a declared column", () => {
    // Including when some declared columns have no key yet — materializing them is not an edit
    // worth an undo entry.
    expect(
      foldGridChildrenIntoColumns({ column_1: [field("a")] }, ["column_1", "column_2"])
    ).toBeUndefined();
    expect(foldGridChildrenIntoColumns(undefined, ["column_1"])).toBeUndefined();
    expect(foldGridChildrenIntoColumns({ column_1: [] }, [])).toBeUndefined();
  });

  it("drops an empty stray slot's key without moving anything", () => {
    expect(
      foldGridChildrenIntoColumns({ column_1: [field("a")], column_2: [] }, ["column_1"])
    ).toEqual({ column_1: [field("a")] });
  });
});

describe("grid column widths", () => {
  it("reads authored widths as spans of a twelve-track row, from a list or its text form", () => {
    expect(GRID_TRACK_COUNT).toBe(12);
    expect(parseGridColumnWidths([6, 4, 2])).toEqual([6, 4, 2]);
    expect(parseGridColumnWidths("6,4,2")).toEqual([6, 4, 2]);
    expect(parseGridColumnWidths("6 / 4 / 2")).toEqual([6, 4, 2]);
    expect(parseGridColumnWidths(" 8, 4 ")).toEqual([8, 4]);
    expect(parseGridColumnWidths([6.9, 5.1])).toEqual([6, 5]);
    expect(formatGridColumnWidths([6, 4, 2])).toBe("6,4,2");
  });

  it("treats anything that is not a list of spans as no widths at all", () => {
    expect(parseGridColumnWidths("")).toBeUndefined();
    expect(parseGridColumnWidths([])).toBeUndefined();
    expect(parseGridColumnWidths([0, 12])).toBeUndefined();
    expect(parseGridColumnWidths([13])).toBeUndefined();
    expect(parseGridColumnWidths("6,four,2")).toBeUndefined();
    expect(parseGridColumnWidths(undefined)).toBeUndefined();
    expect(parseGridColumnWidths({ 0: 6 })).toBeUndefined();
  });

  it("reads a span list in `columns` as sized columns, the count implied by its length", () => {
    // One property, two jobs: a count means equal columns; a list means sized ones, and there
    // is no separate count to keep in step with it.
    expect(readGridColumnSpec({ columns: "8/4" })).toEqual({ count: 2, spans: [8, 4] });
    expect(readGridColumnSpec({ columns: "3 / 6 / 3" })).toEqual({ count: 3, spans: [3, 6, 3] });
    expect(readGridColumnSpec({ columns: [6, 4, 2] })).toEqual({ count: 3, spans: [6, 4, 2] });
    expect(readGridColumnWidths({ columns: "8,4" })).toEqual([8, 4]);
    expect(gridColumnSlotIds({ columns: "8/4" })).toEqual(["column_1", "column_2"]);
  });

  it("treats equal spans as equal columns, exactly like the count", () => {
    // "6/6" is what an author writes for "two halves"; it must lay out and wrap as `2` does,
    // not take the fixed-track path a sized grid needs.
    expect(readGridColumnSpec({ columns: "6/6" })).toEqual(readGridColumnSpec({ columns: 2 }));
    expect(readGridColumnSpec({ columns: [4, 4, 4] })).toEqual({ count: 3, spans: undefined });
    expect(readGridColumnSpec({ columns: [12] })).toEqual({ count: 1, spans: undefined });
    expect(readGridColumnWidths({ columns: "6/6" })).toBeUndefined();
  });

  it("reads a lone number as a count, never as a single span", () => {
    expect(readGridColumnSpec({ columns: 12 })).toEqual({ count: 12, spans: undefined });
    expect(readGridColumnSpec({ columns: "6" })).toEqual({ count: 6, spans: undefined });
  });

  it("falls back to the default equal columns for anything it cannot read", () => {
    // A half-typed value must never leave the grid with nothing to drop into.
    for (const columns of ["", "6,four,2", "0/12", [13], {}, null]) {
      expect(readGridColumnSpec({ columns })).toEqual({
        count: DEFAULT_GRID_COLUMNS,
        spans: undefined
      });
    }
    // A dangling separator is still a list — of one span, which is one column. The canvas
    // previews it that way mid-keystroke; nothing is committed until Save.
    expect(readGridColumnSpec({ columns: "8/" })).toEqual({ count: 1, spans: undefined });
    expect(readGridColumnWidths({ columns: 2 })).toBeUndefined();
    expect(readGridColumnWidths(undefined)).toBeUndefined();
    // The list once lived in its own property; nothing reads that any more.
    expect(readGridColumnSpec({ columns: 2, columnWidths: "8/4" })).toEqual({
      count: 2,
      spans: undefined
    });
  });
});
