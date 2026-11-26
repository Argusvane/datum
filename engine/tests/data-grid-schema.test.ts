import { describe, expect, it } from "vitest";

import {
  DATA_GRID_COMPONENT_TYPE,
  DATA_GRID_NORMALIZE_DEPTH,
  DATA_GRID_ROWS_CAP,
  DATA_GRID_SLOT_ID,
  dataGridSettingsOf,
  isDataGrid,
  normalizeDataGrids,
  resolveDataGridRowBounds,
  rowOperationsOf
} from "../form-engine/core/schema/data-grid.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import {
  PORTABLE_KERNEL_FUNCTIONS,
  kernelDataGridRowBounds,
  kernelDataGridRowsCap,
  kernelNormalizeDataGrids,
  kernelResolveDataGridRowBounds
} from "../form-engine/validation/wasm/portable-kernel.js";
import { kernelStructureGridRowsCap } from "../form-engine/core/expressions/definition-structure.js";
import { kernelMaxComponentDepth } from "../form-engine/core/expressions/compile.js";
import { collectionPathOf, findDataKeyProblems, holdsData } from "../form-engine/core/tree/data-scope.js";
import { collectionEntryCount } from "../form-engine/render/core/component-model.js";

// A data grid is a container whose children are the row template, bound through
// `collection.collectionPath`, else bound at its id by the normalizer.

const grid = (configuration: Record<string, unknown> = {}, extra: Partial<ComponentNode> = {}): ComponentNode => ({
  id: "lines",
  type: DATA_GRID_COMPONENT_TYPE,
  configuration,
  ...extra
});
const field = (id: string, type = "text", configuration: Record<string, unknown> = {}): ComponentNode => ({ id, type, configuration });
const form = (...children: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content: children } });

describe("dataGridSettingsOf: defaults and clamps", () => {
  it("applies every default to an empty configuration", () => {
    expect(dataGridSettingsOf(grid())).toEqual({
      layout: "auto",
      showHeader: true,
      showRowNumbers: true,
      canAdd: true,
      canRemove: true,
      canReorder: false,
      minRows: 0,
      maxRows: undefined,
      initialRows: 1
    });
    expect(dataGridSettingsOf({ id: "g", type: "dataGrid" } as ComponentNode).initialRows).toBe(1);
    expect(dataGridSettingsOf(grid([] as unknown as Record<string, unknown>)).layout).toBe("auto");
  });

  it("reads each layout, and an unknown one as auto", () => {
    for (const layout of ["auto", "table", "stacked"]) {
      expect(dataGridSettingsOf(grid({ layout })).layout).toBe(layout);
    }
    for (const layout of ["grid", "", 3, null]) {
      expect(dataGridSettingsOf(grid({ layout })).layout, String(layout)).toBe("auto");
    }
  });

  it("heads each row by its number unless showRowNumbers is false", () => {
    expect(dataGridSettingsOf(grid({ showRowNumbers: false })).showRowNumbers).toBe(false);
    for (const showRowNumbers of ["no", 0, null, undefined, true]) {
      expect(dataGridSettingsOf(grid({ showRowNumbers })).showRowNumbers, String(showRowNumbers)).toBe(true);
    }
  });

  it("draws the column headings unless showHeader is false", () => {
    expect(dataGridSettingsOf(grid({ showHeader: false })).showHeader).toBe(false);
    expect(dataGridSettingsOf(grid({ showHeader: true })).showHeader).toBe(true);
    for (const showHeader of ["no", 0, null, undefined]) {
      expect(dataGridSettingsOf(grid({ showHeader })).showHeader, String(showHeader)).toBe(true);
    }
  });

  it("reads the row operations by their booleans: add and remove unless false, reorder only when true", () => {
    expect(dataGridSettingsOf(grid({ canAdd: false, canRemove: false, canReorder: true }))).toMatchObject({ canAdd: false, canRemove: false, canReorder: true });
    expect(dataGridSettingsOf(grid({ canAdd: "no", canRemove: 0, canReorder: "yes" }))).toMatchObject({ canAdd: true, canRemove: true, canReorder: false });
  });

  it("floors a fraction, reads a negative or unreadable bound as its default and one past the cap as the cap", () => {
    expect(dataGridSettingsOf(grid({ minRows: 2.7, maxRows: 4.2 }))).toMatchObject({ minRows: 2, maxRows: 4 });
    expect(dataGridSettingsOf(grid({ minRows: -1, maxRows: "5" }))).toMatchObject({ minRows: 0, maxRows: undefined });
    expect(dataGridSettingsOf(grid({ minRows: Number.NaN, maxRows: Number.POSITIVE_INFINITY }))).toMatchObject({ minRows: 0, maxRows: undefined });
    expect(dataGridSettingsOf(grid({ minRows: 900, maxRows: 9000 }))).toMatchObject({ minRows: DATA_GRID_ROWS_CAP, maxRows: DATA_GRID_ROWS_CAP });
    expect(DATA_GRID_ROWS_CAP).toBe(500);
  });

  it("reads a maximum below the minimum as the minimum, and keeps the opening rows within the bounds", () => {
    expect(dataGridSettingsOf(grid({ minRows: 3, maxRows: 1 }))).toMatchObject({ minRows: 3, maxRows: 3, initialRows: 3 });
    expect(dataGridSettingsOf(grid({ minRows: 2 }))).toMatchObject({ initialRows: 2 });
    expect(dataGridSettingsOf(grid({ maxRows: 0 }))).toMatchObject({ initialRows: 0 });
    expect(dataGridSettingsOf(grid({ initialRows: 4, maxRows: 2 }))).toMatchObject({ initialRows: 2 });
    expect(dataGridSettingsOf(grid({ initialRows: 0 }))).toMatchObject({ initialRows: 0 });
  });
});

describe("rowOperationsOf: the only reader of row operations", () => {
  it("derives a grid's from its configuration, whatever its binding says", () => {
    expect(rowOperationsOf(grid())).toEqual({ add: true, remove: true, reorder: false });
    expect(rowOperationsOf(grid({ canAdd: false, canReorder: true }, { collection: { operations: { add: true, reorder: false } } }))).toEqual({ add: false, remove: true, reorder: true });
  });

  it("reads another collection-bound container's binding, defaulting to add and remove but not reorder", () => {
    const section = (operations?: Record<string, unknown>): ComponentNode => ({ id: "s", type: "repeatingSection", configuration: {}, collection: operations ? { operations } : {} });
    expect(rowOperationsOf(section())).toEqual({ add: true, remove: true, reorder: false });
    expect(rowOperationsOf(section({ add: false, reorder: true }))).toEqual({ add: false, remove: true, reorder: true });
    expect(rowOperationsOf(field("plain"))).toEqual({ add: true, remove: true, reorder: false });
  });
});

describe("isDataGrid", () => {
  it("knows a grid by its type alone", () => {
    expect(isDataGrid(field("t", "text"))).toBe(false);
    expect(isDataGrid(grid())).toBe(true);
  });
});

describe("normalizeDataGrids: every grid in the tree", () => {
  it("returns the same root when nothing needs rewriting", () => {
    const already = form(field("a"), grid({}, { collection: { collectionPath: "lines" }, children: { content: [field("b")] } }));
    expect(normalizeDataGrids(already)).toBe(already);
    const plain = form(field("a"), { id: "box", type: "container", configuration: {}, children: { content: [field("b")] } });
    expect(normalizeDataGrids(plain)).toBe(plain);
  });

  it("binds an unbound grid at its id, nested in a container or in another grid's row, sharing what it did not change", () => {
    const untouched: ComponentNode = { id: "box", type: "fieldset", configuration: {}, children: { content: [field("c")] } };
    const inner: ComponentNode = { id: "parcels", type: "dataGrid", configuration: {}, children: { [DATA_GRID_SLOT_ID]: [field("weight", "number")] } };
    const outer = grid({}, { collection: { collectionPath: "orders" }, children: { [DATA_GRID_SLOT_ID]: [field("sku"), inner] } });
    const root = form(untouched, { id: "wrap", type: "container", configuration: {}, children: { content: [outer] } });
    const read = normalizeDataGrids(root);
    expect(read).not.toBe(root);
    expect(read.children?.content?.[0]).toBe(untouched);
    const readOuter = read.children!.content![1]!.children!.content![0]!;
    expect(readOuter.collection).toEqual({ collectionPath: "orders" });
    expect(readOuter.children![DATA_GRID_SLOT_ID]![0]).toBe(outer.children![DATA_GRID_SLOT_ID]![0]);
    const readInner = readOuter.children![DATA_GRID_SLOT_ID]![1]!;
    expect(readInner.collection).toEqual({ collectionPath: "parcels" });
    expect(readInner.children).toEqual({ [DATA_GRID_SLOT_ID]: [field("weight", "number")] });
    expect(collectionPathOf(readInner)).toBe("parcels");
    expect(normalizeDataGrids(form(grid())).children?.content?.[0]).toEqual({ ...grid(), collection: { collectionPath: "lines" } });
    // Every walker then reads a grid by its collection: the rows claim their place, the grid holds data.
    expect(holdsData(readOuter)).toBe(true);
    expect(findDataKeyProblems(read)).toEqual([]);
  });
});

describe("the kernel's mirror of the normalizer (kernelNormalizeDataGrids)", () => {
  /** A small deterministic generator of trees with grids in every shape the normalizer reads. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }

  /** An own key defined, never assigned: `__proto__` stays a key, as JSON.parse writes it. */
  const own = (target: object, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  };

  function generate(next: () => number): ComponentNode {
    let counter = 0;
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const node = (depth: number): ComponentNode => {
      counter += 1;
      const id = `n${counter}`;
      const type = pick(["text", "number", "container", "fieldset", "repeatingSection", "dataGrid", "dataGrid"]);
      const configuration: Record<string, unknown> = { label: id };
      const built: ComponentNode = { id, type, configuration };
      if (type === "dataGrid") {
        const shape = pick(["children", "bound", "empty", "emptySlot", "nullChildren", "nonArraySlot", "protoKeys"]);
        // A grid whose id is not a text (a definition `check` refuses) is left as written on both sides.
        if (next() < 0.1) {
          (built as unknown as { id: unknown }).id = counter;
        }
        if (shape === "children" || shape === "bound") {
          built.children = { content: depth < 3 ? [node(depth + 1)] : [] };
        }
        if (shape === "bound") {
          built.collection = { collectionPath: pick(["lines", id]) };
        }
        if (shape === "emptySlot") {
          built.children = pick([{ content: [] }, { content: [], side: [] }]);
          if (next() < 0.5) {
            built.collection = { collectionPath: "kept" };
          }
        }
        if (shape === "nullChildren") {
          (built as unknown as { children: unknown }).children = null;
        }
        // A slot that is not a list holds no template, and is kept as written.
        if (shape === "nonArraySlot") {
          (built as unknown as { children: unknown }).children = pick([{ content: "bad" }, { content: { id: "x" } }, { content: 3, side: depth < 3 ? [node(depth + 1)] : [] }]);
        }
        // `__proto__` as a configuration key and as a slot.
        if (shape === "protoKeys") {
          own(configuration, "__proto__", { minRows: 4 });
          if (next() < 0.5) {
            const children: Record<string, unknown> = {};
            own(children, "__proto__", depth < 3 ? [node(depth + 1)] : []);
            (built as unknown as { children: unknown }).children = children;
          }
        }
      } else if (["container", "fieldset", "repeatingSection"].includes(type) && depth < 3) {
        const content: unknown[] = Array.from({ length: Math.floor(next() * 3) }, () => node(depth + 1));
        // A child that is not an object is passed over and kept.
        if (next() < 0.15) {
          content.push(pick([null, 3, "x"]));
        }
        built.children = { content: content as ComponentNode[] };
        if (next() < 0.15) {
          (built.children as Record<string, unknown>).aside = pick(["bad", null, { id: "y" }]);
        }
        if (type === "repeatingSection") {
          built.collection = {};
        }
      }
      return built;
    };
    return form(...Array.from({ length: 1 + Math.floor(next() * 4) }, () => node(0)));
  }

  /** Every own key in order with its prototype, so a key turned into a prototype (`__proto__` assigned) shows. */
  function shapeOf(value: unknown): unknown {
    if (value === null || typeof value !== "object") {
      return value === undefined ? "<undefined>" : value;
    }
    if (Array.isArray(value)) {
      return value.map(shapeOf);
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    const pairs: unknown[] = [["<prototype>", prototype === Object.prototype ? "Object" : prototype === null ? "null" : shapeOf(prototype)]];
    for (const key of Object.keys(value)) {
      pairs.push([key, shapeOf((value as Record<string, unknown>)[key])]);
    }
    return pairs;
  }

  it("binds every generated tree exactly as the browser's normalizer does, and keeps an untouched tree by identity", () => {
    const next = random(20261023);
    let rewritten = 0;
    for (let round = 0; round < 300; round += 1) {
      const built = generate(next);
      // Every other round as a host posts it: through JSON, `__proto__` an own key from JSON.parse.
      const root = round % 2 === 0 ? (JSON.parse(JSON.stringify(built)) as ComponentNode) : built;
      const before = JSON.stringify(shapeOf(root));
      const browser = normalizeDataGrids(root);
      const kernel = kernelNormalizeDataGrids(root);
      expect(JSON.stringify(shapeOf(kernel)), `round ${round}`).toBe(JSON.stringify(shapeOf(browser)));
      expect(kernel === root, `round ${round} identity`).toBe(browser === root);
      expect(JSON.stringify(shapeOf(root)), `round ${round} pure`).toBe(before);
      rewritten += browser === root ? 0 : 1;
    }
    // The generator reaches both outcomes.
    expect(rewritten).toBeGreaterThan(30);
    expect(rewritten).toBeLessThan(300);
  });

  it("keeps a __proto__ key from JSON as a key, never a prototype, on both sides", () => {
    const posted = JSON.parse(
      '{"id":"form","type":"form","configuration":{},"children":{"content":[{"id":"lines","type":"dataGrid","configuration":{"__proto__":{"minRows":4}},"children":{"__proto__":[],"content":[{"id":"sku","type":"text","configuration":{}}]}}]}}'
    ) as ComponentNode;
    const browser = normalizeDataGrids(posted);
    const kernel = kernelNormalizeDataGrids(posted);
    const read = browser.children!.content![0]!;
    expect(Object.getPrototypeOf(read.configuration)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(read.configuration, "__proto__")).toBe(true);
    expect(dataGridSettingsOf(read).minRows).toBe(0);
    expect(read.collection).toEqual({ collectionPath: "lines" });
    expect(Object.prototype.hasOwnProperty.call(read.children, "__proto__")).toBe(true);
    expect(JSON.stringify(shapeOf(kernel))).toBe(JSON.stringify(shapeOf(browser)));
  });

  it("reads children: null and a slot that is not a list without throwing, and passes over a child that is not an object", () => {
    const odd = form(
      { id: "a", type: "dataGrid", configuration: {}, children: null } as unknown as ComponentNode,
      { id: "b", type: "container", configuration: {}, children: { content: [null, 3, field("c")], aside: "bad" } } as unknown as ComponentNode,
      { id: "d", type: "dataGrid", configuration: {}, children: { content: { id: "e" } } } as unknown as ComponentNode
    );
    const browser = normalizeDataGrids(odd);
    expect(JSON.stringify(shapeOf(kernelNormalizeDataGrids(odd)))).toBe(JSON.stringify(shapeOf(browser)));
    expect(browser.children!.content![0]).toEqual({ id: "a", type: "dataGrid", configuration: {}, children: null, collection: { collectionPath: "a" } });
    expect(browser.children!.content![1]).toBe(odd.children!.content![1]);
    expect(browser.children!.content![2]!.children).toEqual({ content: { id: "e" } });
  });

  it("leaves a grid whose id is not a text as written, on both sides (it has no key to bind)", () => {
    const odd = form({ id: 7, type: "dataGrid", configuration: {}, children: { content: [field("x")] } } as unknown as ComponentNode);
    expect(normalizeDataGrids(odd)).toBe(odd);
    expect(kernelNormalizeDataGrids(odd)).toBe(odd);
    expect(collectionPathOf(normalizeDataGrids(odd).children!.content![0]!)).toBeUndefined();
  });

  it("stops where the kernel stops: one level past the depth a definition may nest", () => {
    expect(DATA_GRID_NORMALIZE_DEPTH).toBe(kernelMaxComponentDepth() + 1);
    const unbound = (): ComponentNode => grid({}, { children: { content: [field("x")] } });
    // The grid at `level` (root = 1).
    const at = (level: number): ComponentNode => {
      let node = unbound();
      for (let wrap = level; wrap > 2; wrap -= 1) {
        node = { id: `c${wrap}`, type: "container", configuration: {}, children: { content: [node] } };
      }
      return form(node);
    };
    for (const level of [2, 31, 32, 33, 34, 40]) {
      const root = at(level);
      const browser = normalizeDataGrids(root);
      const kernel = kernelNormalizeDataGrids(root);
      expect(JSON.stringify(shapeOf(kernel)), `level ${level}`).toBe(JSON.stringify(shapeOf(browser)));
      expect(browser === root, `level ${level}`).toBe(level > DATA_GRID_NORMALIZE_DEPTH);
      expect(kernel === root, `level ${level}`).toBe(level > DATA_GRID_NORMALIZE_DEPTH);
    }
  });

  it("reads a tree deeper than any stack without recursion, and a grid with a non-text id as a plain group", () => {
    let deep: ComponentNode = grid({}, { children: { content: [field("x")] } });
    for (let level = 0; level < 5000; level += 1) {
      deep = { id: `c${level}`, type: "container", configuration: {}, children: { content: [deep] } };
    }
    expect(() => kernelNormalizeDataGrids(form(deep))).not.toThrow();
    // The browser's normalizer too: it stops at the same line, so the depth refusal is
    // what follows, never a RangeError; a grid below the line is left as written.
    const wrapped = form(deep);
    expect(normalizeDataGrids(wrapped)).toBe(wrapped);
    expect(kernelNormalizeDataGrids(wrapped)).toBe(wrapped);
    const odd = form({ id: 7, type: "dataGrid", configuration: {} } as unknown as ComponentNode);
    expect(kernelNormalizeDataGrids(odd)).toBe(odd);
  });

  it("reads the row bounds and the cap as dataGridSettingsOf does", () => {
    expect(kernelDataGridRowsCap()).toBe(DATA_GRID_ROWS_CAP);
    expect(kernelStructureGridRowsCap()).toBe(DATA_GRID_ROWS_CAP);
    const samples: unknown[] = [undefined, null, -1, 0, 1, 2.5, 3, 499, 500, 501, 9000, Number.NaN, Number.POSITIVE_INFINITY, "4", true];
    for (const minRows of samples) {
      for (const maxRows of samples) {
        const node = grid({ minRows, maxRows });
        const settings = dataGridSettingsOf(node);
        expect(kernelDataGridRowBounds(node), JSON.stringify([minRows, maxRows])).toEqual({ min: settings.minRows, max: settings.maxRows });
      }
    }
  });

  it("is spliced: every function is in the kernel's list, a top-level declaration", () => {
    for (const fn of [kernelNormalizeDataGrids, kernelDataGridRowBounds, kernelDataGridRowsCap]) {
      expect(PORTABLE_KERNEL_FUNCTIONS, fn.name).toContain(fn);
      expect(fn.toString().startsWith(`function ${fn.name}(`), fn.name).toBe(true);
    }
  });
});

describe("resolveDataGridRowBounds: a bound formula against the fixed bound", () => {
  const fixed = { minRows: 2, maxRows: 5 };

  it("lets a finite whole number from 0 win, one past the cap read as the cap", () => {
    expect(resolveDataGridRowBounds(fixed, { min: 3, max: 4 })).toEqual({ minRows: 3, maxRows: 4 });
    expect(resolveDataGridRowBounds(fixed, { min: 0 })).toEqual({ minRows: 0, maxRows: 5 });
    expect(resolveDataGridRowBounds(fixed, { max: 9000 })).toEqual({ minRows: 2, maxRows: DATA_GRID_ROWS_CAP });
    expect(resolveDataGridRowBounds({ minRows: 0, maxRows: undefined }, { max: 7 })).toEqual({ minRows: 0, maxRows: 7 });
    expect(Object.is(resolveDataGridRowBounds(fixed, { min: -0 }).minRows, 0)).toBe(true);
  });

  it("keeps the fixed bound for anything else: a fraction, a negative, a text, no answer, no formula", () => {
    for (const value of [2.5, -1, "4", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true, [3], { n: 3 }]) {
      expect(resolveDataGridRowBounds(fixed, { min: value, max: value }), String(value)).toEqual(fixed);
    }
    expect(resolveDataGridRowBounds(fixed, {})).toEqual(fixed);
    expect(resolveDataGridRowBounds({ minRows: 0, maxRows: undefined }, {})).toEqual({ minRows: 0, maxRows: undefined });
  });

  it("reads a maximum below the resolved minimum as the minimum", () => {
    expect(resolveDataGridRowBounds(fixed, { min: 8 })).toEqual({ minRows: 8, maxRows: 8 });
    expect(resolveDataGridRowBounds(fixed, { max: 1 })).toEqual({ minRows: 2, maxRows: 2 });
    expect(resolveDataGridRowBounds({ minRows: 0, maxRows: undefined }, { min: 4, max: 3 })).toEqual({ minRows: 4, maxRows: 4 });
  });

  it("is mirrored in the kernel exactly (kernelResolveDataGridRowBounds), spliced", () => {
    const formulas = [undefined, 0, -0, 1, 3, 4.5, -2, 499, 500, 501, 1e20, "3", null, Number.NaN, true];
    const fixedPairs: Array<{ minRows: number; maxRows: number | undefined }> = [
      { minRows: 0, maxRows: undefined },
      { minRows: 2, maxRows: 5 },
      { minRows: 3, maxRows: 3 },
      { minRows: 500, maxRows: 500 }
    ];
    for (const pair of fixedPairs) {
      for (const min of formulas) {
        for (const max of formulas) {
          const formula: { min?: unknown; max?: unknown } = {};
          if (min !== undefined) formula.min = min;
          if (max !== undefined) formula.max = max;
          const browser = resolveDataGridRowBounds(pair, formula);
          const kernel = kernelResolveDataGridRowBounds({ min: pair.minRows, max: pair.maxRows }, formula);
          expect(kernel, JSON.stringify([pair, min, max])).toEqual({ min: browser.minRows, max: browser.maxRows });
          expect(Object.is(kernel.min, browser.minRows) && Object.is(kernel.max, browser.maxRows)).toBe(true);
        }
      }
      expect(kernelResolveDataGridRowBounds({ min: pair.minRows, max: pair.maxRows }, undefined)).toEqual({ min: pair.minRows, max: pair.maxRows });
    }
    expect(PORTABLE_KERNEL_FUNCTIONS).toContain(kernelResolveDataGridRowBounds);
    expect(kernelResolveDataGridRowBounds.toString().startsWith("function kernelResolveDataGridRowBounds(")).toBe(true);
  });
});

describe("collectionEntryCount", () => {
  it("counts a collection's entries from its keys, a row with nothing typed in included", () => {
    // Highest index + 1; a prefix collision (itemsX) and a non-numeric index are not entries.
    expect(collectionEntryCount({ "items[0].a": undefined, "items[2].a": 1, "itemsX[9].a": 1, "items[x].a": 1 }, "items")).toBe(3);
    expect(collectionEntryCount({ items: [] }, "items")).toBe(0);
    // A key far past the rest is drawn no further than a grid may hold.
    expect(collectionEntryCount({ "items[100000].a": 1 }, "items")).toBe(DATA_GRID_ROWS_CAP);
    expect(DATA_GRID_ROWS_CAP).toBe(500);
  });
});
