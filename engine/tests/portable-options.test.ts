import { describe, expect, it } from "vitest";

import { kernelCompileNode } from "../form-engine/core/expressions/compile.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { kernelFoldHoldsOwnAnswer } from "../form-engine/core/state/submittable-fold.js";
import { readSourceId } from "../form-engine/core/schema/data-source-capability.js";
import { isInlineOption } from "../form-engine/core/schema/inline-options.js";
import {
  kernelFoldSubmission,
  kernelKnownKeyShapes,
  kernelNormalizeDataGrids,
  kernelPartitionValues,
  runKernel,
  type KernelValidationError
} from "../form-engine/validation/wasm/portable-kernel.js";
import {
  PORTABLE_OPTIONS_FUNCTIONS,
  kernelCheckOptions,
  kernelOptionHoldsOwnAnswer,
  kernelOptionInlineValues,
  kernelOptionQuestions,
  kernelOptionSourceId,
  type KernelOptionSnapshot
} from "../form-engine/validation/wasm/portable-options.js";

function leaf(id: string, type: string, configuration: Record<string, unknown> = {}, extra: Partial<ComponentNode> = {}): ComponentNode {
  return { id, type, configuration: { label: id, ...configuration }, ...extra };
}

function group(id: string, type: string, children: ComponentNode[], configuration: Record<string, unknown> = {}, extra: Partial<ComponentNode> = {}): ComponentNode {
  return { id, type, configuration: { label: id, ...configuration }, children: { content: children }, ...extra };
}

function form(...children: ComponentNode[]): ComponentNode {
  return group("form", "form", children);
}

function options(...values: string[]): Array<{ value: string; label: string }> {
  return values.map((value) => ({ value, label: value.toUpperCase() }));
}

function select(id: string, values: string[], configuration: Record<string, unknown> = {}): ComponentNode {
  return leaf(id, "select", { options: options(...values), ...configuration });
}

function refused(componentId: string, path: string, keys: string[]): unknown {
  return { code: "option.notAllowed", componentId, path, stage: "options", source: "wasm", parameters: { keys } };
}

function unavailable(componentId: string, path: string, keys: string[], sourceId: string): unknown {
  return { code: "option.sourceUnavailable", componentId, path, stage: "options", source: "wasm", parameters: { keys, sourceId } };
}

function eq(path: string, value: string): string {
  return `${path} = ${JSON.stringify(value)}`;
}

const check = kernelCheckOptions;

describe("kernelCheckOptions: inline select and radio", () => {
  const root = form(select("province", ["ON", "QC"]), leaf("topic", "radio", { options: options("roads", "parks") }));

  it("passes an answer among the options", () => {
    expect(check(root, { province: "QC", topic: "parks" }, undefined)).toEqual([]);
  });

  it("refuses an answer that is not among the options, once per component with its path", () => {
    expect(check(root, { province: "ZZ", topic: "roads" }, undefined)).toEqual([refused("province", "province", ["province"])]);
    expect(check(root, { province: "ON", topic: "other" }, undefined)).toEqual([refused("topic", "topic", ["topic"])]);
  });

  it("matches option values exactly: no trimming, no case folding, no label", () => {
    for (const value of [" ON", "on", "ON ", "Ontario", "ON\u0000"]) {
      expect(check(root, { province: value }, undefined), JSON.stringify(value)).toHaveLength(1);
    }
  });

  it("refuses a select or radio answer of the wrong shape", () => {
    for (const value of [{ ON: true }, ["ON"], 1, true, false, 0]) {
      expect(check(root, { province: value }, undefined), JSON.stringify(value)).toEqual([refused("province", "province", ["province"])]);
      expect(check(root, { topic: value }, undefined), JSON.stringify(value)).toEqual([refused("topic", "topic", ["topic"])]);
    }
  });

  it("passes no answer: an empty string, null, undefined, or no key at all", () => {
    expect(check(root, { province: "", topic: null }, undefined)).toEqual([]);
    expect(check(root, { province: undefined }, undefined)).toEqual([]);
    expect(check(root, {}, undefined)).toEqual([]);
  });

  it("holds a whitespace answer to the options: only an empty string is no answer", () => {
    expect(check(root, { province: " " }, undefined)).toHaveLength(1);
  });

  it("returns errors in the kernel's error contract, ready to push beside its own", () => {
    const errors: KernelValidationError[] = check(root, { province: "ZZ" }, undefined);
    expect(errors).toEqual([{ code: "option.notAllowed", componentId: "province", path: "province", stage: "options", source: "wasm", parameters: { keys: ["province"] } }]);
  });

  it("reports in document order, whatever order the keys came in", () => {
    expect(check(root, { topic: "x", province: "y" }, undefined).map((error) => error.componentId)).toEqual(["province", "topic"]);
  });
});

describe("kernelCheckOptions: checkboxes", () => {
  const root = form(leaf("topics", "checkboxes", { options: options("roads", "parks", "water") }));

  it("passes an object of booleans whose ticked keys are options", () => {
    expect(check(root, { topics: { roads: true, parks: false, water: true } }, undefined)).toEqual([]);
    expect(check(root, { topics: {} }, undefined)).toEqual([]);
    expect(check(root, { topics: { roads: false } }, undefined)).toEqual([]);
  });

  it("refuses a ticked key that is not an option", () => {
    expect(check(root, { topics: { roads: true, bridges: true } }, undefined)).toEqual([refused("topics", "topics", ["topics"])]);
  });

  it("ignores an unticked key, option or not: false picks nothing", () => {
    expect(check(root, { topics: { roads: true, bridges: false } }, undefined)).toEqual([]);
  });

  it("refuses any entry that is not a boolean, and any value that is not a plain object", () => {
    for (const value of [{ roads: "true" }, { roads: 1 }, { roads: null }, { roads: true, parks: {} }, "roads", ["roads"], 1, true, new Date(0)]) {
      expect(check(root, { topics: value }, undefined), String(JSON.stringify(value))).toEqual([refused("topics", "topics", ["topics"])]);
    }
  });

  it("passes no answer", () => {
    expect(check(root, { topics: "" }, undefined)).toEqual([]);
    expect(check(root, { topics: null }, undefined)).toEqual([]);
  });

  it("reads no inherited member as an option, and keeps an option named like one", () => {
    const parsed = JSON.parse('{ "__proto__": true }') as Record<string, unknown>;
    expect(check(root, { topics: parsed }, undefined)).toHaveLength(1);
    expect(check(root, { topics: { constructor: true } }, undefined)).toHaveLength(1);
    expect(check(root, { topics: { toString: true } }, undefined)).toHaveLength(1);
    const odd = form(leaf("topics", "checkboxes", { options: options("__proto__", "constructor") }));
    expect(check(odd, { topics: parsed }, undefined)).toEqual([]);
    expect(check(odd, { topics: { constructor: true } }, undefined)).toEqual([]);
  });
});

describe("kernelCheckOptions: options from a data source snapshot", () => {
  const root = form(
    leaf("province", "select", { data: { sourceId: "provinces" }, options: options("XX") }),
    leaf("regions", "checkboxes", { data: { sourceId: "regions" } })
  );
  const snapshot: KernelOptionSnapshot = {
    provinces: [
      { value: "ON", label: "Ontario" },
      { value: "QC", label: "Québec" }
    ],
    regions: [{ value: "north" }, { value: "south" }]
  };

  it("passes an answer among the snapshot's values", () => {
    expect(check(root, { province: "ON", regions: { north: true } }, snapshot)).toEqual([]);
  });

  it("refuses an answer that is not among them", () => {
    expect(check(root, { province: "ZZ", regions: { east: true } }, snapshot)).toEqual([
      refused("province", "province", ["province"]),
      refused("regions", "regions", ["regions"])
    ]);
  });

  it("ignores the inline list once a source is named: the source wins", () => {
    expect(check(root, { province: "XX" }, snapshot)).toEqual([refused("province", "province", ["province"])]);
  });

  it("fails closed for a source the snapshot does not have, naming it, and still holds the shape", () => {
    // 2.9 passed these answers unchecked.
    expect(check(root, { province: "anything" }, { regions: [] })).toEqual([unavailable("province", "province", ["province"], "provinces")]);
    expect(check(root, { province: "anything" }, undefined)).toEqual([unavailable("province", "province", ["province"], "provinces")]);
    expect(check(root, { province: "anything" }, {})).toEqual([unavailable("province", "province", ["province"], "provinces")]);
    // A ticked box of a checkboxes question, its source missing too.
    expect(check(root, { regions: { north: true } }, undefined)).toEqual([unavailable("regions", "regions", ["regions"], "regions")]);
    // The shape is refused as ever, whether or not the source is there.
    expect(check(root, { province: { ON: true } }, undefined)).toEqual([refused("province", "province", ["province"])]);
    // An answer that picks nothing is no answer: it needs no source.
    expect(check(root, { province: "", regions: { north: false } }, undefined)).toEqual([]);
    expect(check(root, {}, undefined)).toEqual([]);
  });

  it("reads only the snapshot's own keys", () => {
    const named = form(leaf("pick", "select", { data: { sourceId: "constructor" } }));
    expect(check(named, { pick: "x" }, {})).toEqual([unavailable("pick", "pick", ["pick"], "constructor")]);
    expect(check(named, { pick: "x" }, { constructor: [{ value: "y" }] } as unknown as KernelOptionSnapshot)).toHaveLength(1);
  });

  it("refuses every answer for a source whose list is empty; one that is not a list is unavailable", () => {
    expect(check(root, { province: "ON" }, { provinces: [] })).toEqual([refused("province", "province", ["province"])]);
    // Before 2.10 these allowed nothing (`option.notAllowed`); a malformed entry now names its source.
    expect(check(root, { province: "ON" }, { provinces: "ON" } as unknown as KernelOptionSnapshot)).toEqual([
      unavailable("province", "province", ["province"], "provinces")
    ]);
    expect(check(root, { province: "ON" }, { provinces: null } as unknown as KernelOptionSnapshot)).toEqual([
      unavailable("province", "province", ["province"], "provinces")
    ]);
    expect(check(root, { province: "ON" }, { provinces: {} } as unknown as KernelOptionSnapshot)).toHaveLength(1);
  });

  it("reads a snapshot item's finite number value as its string form", () => {
    const numbered = { provinces: [{ value: 35 }, { value: 24 }, { value: Number.NaN }] } as unknown as KernelOptionSnapshot;
    expect(check(root, { province: "35" }, numbered)).toEqual([]);
    expect(check(root, { province: "NaN" }, numbered)).toHaveLength(1);
    expect(check(root, { province: 35 }, numbered)).toHaveLength(1);
  });

  it("tells the log once which questions name a source the snapshot lacks, and warns of the answers refused for it", () => {
    const entries: Array<[string, unknown]> = [];
    const warnings: Array<[string, unknown]> = [];
    const log = {
      info: (message: string, data?: unknown): void => void entries.push([message, data]),
      warn: (message: string, data?: unknown): void => void warnings.push([message, data])
    };
    expect(check(root, { province: "anything" }, { regions: [] }, log)).toEqual([unavailable("province", "province", ["province"], "provinces")]);
    expect(entries).toHaveLength(1);
    expect(entries[0]![1]).toEqual({ unchecked: [{ componentId: "province", path: "province", sourceId: "provinces" }] });
    expect(warnings).toEqual([
      [
        "choice answers refused: the option snapshot lacks their sources",
        { unavailable: [{ componentId: "province", path: "province", sourceId: "provinces", keys: ["province"] }] }
      ]
    ]);
    entries.length = 0;
    check(root, {}, undefined, log);
    expect(entries[0]![1]).toEqual({
      unchecked: [
        { componentId: "province", path: "province", sourceId: "provinces" },
        { componentId: "regions", path: "regions", sourceId: "regions" }
      ]
    });
    entries.length = 0;
    warnings.length = 0;
    check(root, {}, snapshot, log);
    expect(entries).toEqual([]);
    // No answer refused for a missing source, no warning (the info line says the source was lacking).
    check(root, {}, undefined, log);
    expect(warnings).toEqual([]);
  });

  it("reads each source from the snapshot once, however many questions name it", () => {
    let reads = 0;
    const counted = {} as KernelOptionSnapshot;
    Object.defineProperty(counted, "terms", { enumerable: true, get: () => ((reads += 1), [{ value: "a" }]) });
    const many = form(...Array.from({ length: 50 }, (_, index) => leaf("q" + index, "select", { data: { sourceId: "terms" } })));
    expect(check(many, { q1: "a", q2: "b" }, counted).map((error) => error.componentId)).toEqual(["q2"]);
    expect(reads).toBe(1);
  });

  it("skips a snapshot item without a string or finite number value", () => {
    const loose = { provinces: [{ value: true }, null, "ON", { label: "ON" }, { value: { v: "X" } }, { value: Number.POSITIVE_INFINITY }, { value: "QC" }] } as unknown as KernelOptionSnapshot;
    expect(check(root, { province: "QC" }, loose)).toEqual([]);
    for (const answer of ["ON", "true", "X", "[object Object]", "Infinity"]) {
      expect(check(root, { province: answer }, loose), answer).toHaveLength(1);
    }
  });

  it("treats a snapshot that is not a record as no snapshot: the source is unavailable", () => {
    for (const bad of [null, "provinces", 3, [{ value: "ON" }]]) {
      expect(check(root, { province: "anything" }, bad as unknown as KernelOptionSnapshot)).toEqual([
        unavailable("province", "province", ["province"], "provinces")
      ]);
    }
  });

  it("names no source with an empty or non-string id: the inline list applies", () => {
    const blank = form(leaf("a", "select", { data: { sourceId: "" }, options: options("x") }), leaf("b", "select", { data: { sourceId: 7 }, options: options("x") }));
    expect(check(blank, { a: "x", b: "x" }, undefined)).toEqual([]);
    expect(check(blank, { a: "y", b: "y" }, undefined).map((error) => error.componentId)).toEqual(["a", "b"]);
  });
});

describe("kernelCheckOptions: where the answers live", () => {
  it("holds every entry of a repeating section to the row field's options, index-free", () => {
    const root = form(group("items", "repeatingSection", [select("sku", ["A1", "B2"])], {}, { collection: { collectionPath: "lines" } }));
    expect(check(root, { "lines[0].sku": "A1", "lines[1].sku": "B2" }, undefined)).toEqual([]);
    expect(check(root, { "lines[0].sku": "A1", "lines[1].sku": "ZZ", "lines[2].sku": "YY" }, undefined)).toEqual([
      refused("sku", "lines.sku", ["lines[1].sku", "lines[2].sku"])
    ]);
  });

  it("follows a section's id when it writes no collection path, and a row field's data key", () => {
    const root = form(group("items", "repeatingSection", [select("sku", ["A1"], { dataKey: "code" })], {}, { collection: {} }));
    expect(check(root, { "items[0].code": "ZZ" }, undefined)).toEqual([refused("sku", "items.code", ["items[0].code"])]);
    expect(check(root, { "items[0].sku": "ZZ" }, undefined)).toEqual([]);
  });

  it("prefixes data-scoping containers, with their data keys, and not a container that does not scope", () => {
    const root = form(
      group("contact", "container", [select("province", ["ON"])]),
      group("billing", "container", [select("country", ["CA"])], { dataKey: "bill" }),
      group("plain", "container", [select("size", ["S"])], { scopeData: false }),
      group("box", "fieldset", [select("color", ["red"])])
    );
    expect(check(root, { "contact.province": "ON", "bill.country": "CA", size: "S", color: "red" }, undefined)).toEqual([]);
    expect(check(root, { "contact.province": "QC", "bill.country": "US", size: "M", color: "blue" }, undefined)).toEqual([
      refused("province", "contact.province", ["contact.province"]),
      refused("country", "bill.country", ["bill.country"]),
      refused("size", "size", ["size"]),
      refused("color", "color", ["color"])
    ]);
    // Not where the answer lives: no choice is stored at these keys.
    expect(check(root, { province: "QC", "billing.country": "US", "plain.size": "M" }, undefined)).toEqual([]);
  });

  it("scopes a container inside an entry", () => {
    const root = form(group("items", "repeatingSection", [group("addr", "container", [select("province", ["ON"])])], {}, { collection: {} }));
    expect(check(root, { "items[3].addr.province": "QC" }, undefined)).toEqual([refused("province", "items.addr.province", ["items[3].addr.province"])]);
  });

  it("keeps a section nested in another at its own collection path", () => {
    const inner = group("lines", "repeatingSection", [select("qty", ["1", "2"])], {}, { collection: {} });
    const root = form(group("orders", "repeatingSection", [inner], {}, { collection: {} }));
    expect(check(root, { "lines[0].qty": "3" }, undefined)).toEqual([refused("qty", "lines.qty", ["lines[0].qty"])]);
  });

  // A grid is a repeating section, and a choice in a row is reported as a section's field is.
  it("holds a data grid's choice fields as a section's", () => {
    const grid: ComponentNode = {
      id: "ordersGrid",
      type: "dataGrid",
      collection: { collectionPath: "orders" },
      configuration: {},
      children: { content: [leaf("item", "text"), leaf("status", "select", { options: options("open", "closed") }), leaf("flags", "checkboxes", { options: options("rush") })] }
    };
    const root = form(grid);
    expect(check(root, { "orders[0].item": "anything", "orders[0].status": "open", "orders[1].flags": { rush: true } }, undefined)).toEqual([]);
    expect(check(root, { "orders[0].status": "lost", "orders[1].flags": { slow: true } }, undefined)).toEqual([
      refused("status", "orders.status", ["orders[0].status"]),
      refused("flags", "orders.flags", ["orders[1].flags"])
    ]);
  });

  it("matches a key the schema does not define index-free, so a kept province[0] is held to province", () => {
    const root = form(select("province", ["ON"]), group("items", "repeatingSection", [select("sku", ["A1"])], {}, { collection: {} }));
    expect(check(root, { "province[0]": "ZZ" }, undefined)).toEqual([refused("province", "province", ["province[0]"])]);
    expect(check(root, { "province[01]": "ZZ" }, undefined)).toEqual([refused("province", "province", ["province[01]"])]);
    expect(check(root, { "items.sku": "ZZ", "items[0][1].sku": "YY" }, undefined)).toEqual([refused("sku", "items.sku", ["items.sku", "items[0][1].sku"])]);
    expect(check(root, { "province[0]": "ON" }, undefined)).toEqual([]);
    // Brackets with no digits are no index: no choice is stored there.
    expect(check(root, { "province[x]": "ZZ", "province[]": "ZZ" }, undefined)).toEqual([]);
  });

  it("matches the exact shape first: a key the schema defines for something else is not a choice answer", () => {
    const root = form(
      group("box", "container", [leaf("sku", "text")], { dataKey: "items" }),
      group("section", "repeatingSection", [select("sku", ["A1"])], {}, { collection: { collectionPath: "items" } })
    );
    expect(check(root, { "items.sku": "free text", "items[0].sku": "A1" }, undefined)).toEqual([]);
    expect(check(root, { "items.sku": "free text", "items[0].sku": "ZZ" }, undefined)).toEqual([refused("sku", "items.sku", ["items[0].sku"])]);
  });

  describe("an answer several components store at one path", () => {
    const visibleWhen = (value: string): NonNullable<ComponentNode["rules"]> => ({ visibleWhen: eq("country", value) });
    const choices = form(
      select("country", ["CA", "US", "DE"]),
      leaf("provinceCA", "select", { dataKey: "region", options: options("ON", "QC") }, { rules: visibleWhen("CA") }),
      leaf("stateUS", "select", { dataKey: "region", options: options("NY", "CA") }, { rules: visibleWhen("US") })
    );

    it("passes when any choice stored there accepts it", () => {
      expect(check(choices, { country: "CA", region: "ON" }, undefined)).toEqual([]);
      expect(check(choices, { country: "US", region: "NY" }, undefined)).toEqual([]);
    });

    it("is refused by each choice stored there when none accepts it", () => {
      expect(check(choices, { region: "ZZ" }, undefined)).toEqual([refused("provinceCA", "region", ["region"]), refused("stateUS", "region", ["region"])]);
      expect(check(choices, { "region[0]": "ZZ" }, undefined).map((error) => error.componentId)).toEqual(["provinceCA", "stateUS"]);
    });

    it("is not checked when a component that is not a choice stores there too", () => {
      const mixed = form(...(choices.children!.content as ComponentNode[]), leaf("regionOther", "text", { dataKey: "region" }, { rules: visibleWhen("DE") }));
      expect(check(mixed, { country: "DE", region: "Bayern" }, undefined)).toEqual([]);
      expect(check(mixed, { "region[0]": "Bayern" }, undefined)).toEqual([]);
    });

    // only a plain text input stands aside.
    it("is still checked where a data-scoping container stores", () => {
      const root = form(group("contact", "container", [leaf("x", "text")]), select("pick", ["a"], { dataKey: "contact" }));
      expect(check(root, { contact: "zz" }, undefined)).toEqual([refused("pick", "contact", ["contact"])]);
    });

    it("is still checked when a number, a date, a checkbox or a file stores there too, and not when a textarea does", () => {
      for (const type of ["number", "file", "date", "checkbox"]) {
        const root = form(leaf("other", type, { dataKey: "region" }), select("pick", ["a"], { dataKey: "region" }));
        expect(check(root, { region: "zz" }, undefined), type).toEqual([refused("pick", "region", ["region"])]);
        const reversed = form(select("pick", ["a"], { dataKey: "region" }), leaf("other", type, { dataKey: "region" }));
        expect(check(reversed, { region: "zz" }, undefined), type + " reversed").toEqual([refused("pick", "region", ["region"])]);
      }
      const area = form(leaf("note", "textarea", { dataKey: "region" }), select("pick", ["a"], { dataKey: "region" }));
      expect(check(area, { region: "zz" }, undefined)).toEqual([]);
    });
  });

  it("ignores a key for no component, and a key for a component that is not a choice", () => {
    const root = form(select("province", ["ON"]), leaf("name", "text"));
    expect(check(root, { stray: "ZZ", name: "anything", "nested.thing": { a: 1 } }, undefined)).toEqual([]);
  });
});

describe("kernelCheckOptions: rows posted whole at a collection path", () => {
  const grid: ComponentNode = {
    id: "ordersGrid",
    type: "dataGrid",
    configuration: {},
    collection: { collectionPath: "orders" },
    children: { content: [leaf("status", "select", { options: options("open") })] }
  };
  const root = kernelNormalizeDataGrids(form(group("items", "repeatingSection", [select("sku", ["A1"]), group("addr", "container", [select("prov", ["ON"])])], {}, { collection: {} }), grid));

  it("holds each row's keys as the flat keys they stand for", () => {
    expect(check(root, { items: [{ sku: "A1", "addr.prov": "ON" }], orders: [{ status: "open" }] }, undefined)).toEqual([]);
    expect(check(root, { items: [{ sku: "A1" }, { sku: "ZZ", "addr.prov": "QC" }], orders: [{ status: "lost" }] }, undefined)).toEqual([
      refused("sku", "items.sku", ["items[1].sku"]),
      refused("prov", "items.addr.prov", ["items[1].addr.prov"]),
      refused("status", "orders.status", ["orders[0].status"])
    ]);
  });

  it("checks the list and the flat keys both, naming a key once", () => {
    expect(check(root, { items: [{ sku: "ZZ" }], "items[0].sku": "A1" }, undefined)).toEqual([refused("sku", "items.sku", ["items[0].sku"])]);
    expect(check(root, { "items[0].sku": "ZZ", items: [{ sku: "ZZ" }] }, undefined)).toEqual([refused("sku", "items.sku", ["items[0].sku"])]);
  });

  it("reads a row key the schema does not define index-free, like any key", () => {
    expect(check(root, { items: [{ "sku[0]": "ZZ", other: "x" }] }, undefined)).toEqual([refused("sku", "items.sku", ["items[0].sku[0]"])]);
  });

  it("refuses a plugin column's record holding a non-boolean entry, flattened or whole", () => {
    const pluginGrid = kernelNormalizeDataGrids(
      form({ id: "g", type: "dataGrid", configuration: {}, collection: { collectionPath: "orders" }, children: { content: [leaf("status", "status-picker", { options: options("open") })] } })
    );
    const flattened = kernelPartitionValues({ orders: [{ status: { "9": "yes" } }] }, pluginGrid).known;
    expect(Object.keys(flattened)).toEqual(["orders[0].status"]);
    expect(check(pluginGrid, flattened, undefined)).toHaveLength(1);
    expect(check(pluginGrid, { orders: [{ status: { "9": "yes" } }] }, undefined)).toHaveLength(1);
    expect(check(pluginGrid, { orders: [{ status: { "9": false } }] }, undefined)).toEqual([]);
  });

  it("passes over a value that is not a list, and list items that are not objects", () => {
    expect(check(root, { items: "ZZ", orders: { status: "lost" } }, undefined)).toEqual([]);
    expect(check(root, { items: ["ZZ", null, ["ZZ"], { sku: "ZZ" }] }, undefined)).toEqual([refused("sku", "items.sku", ["items[3].sku"])]);
  });

  it("closes the bypass under strip and keep: what the fold keeps is what is checked", () => {
    const values = { items: [{ sku: "ZZ" }], orders: [{ status: "lost" }] };
    // The kernel's partition flattens rows posted whole into the flat keys they stand for; the
    // raw list, handed to the fold directly, is what the check's own row reading defends against.
    const stripped = kernelPartitionValues(values, root).known;
    expect(Object.keys(stripped)).toEqual(["items[0].sku", "orders[0].status"]);
    for (const kept of [stripped, values]) {
      const fold = kernelFoldSubmission(root, kept, undefined);
      expect(check(root, { ...fold.submittable }, undefined).map((error) => error.path)).toEqual(["items.sku", "orders.status"]);
    }
  });
});

describe("kernelCheckOptions: what a choice is", () => {
  describe("an extension type that carries options: read for what it picks, refused for a shape a choice cannot take", () => {
    const root = form(leaf("stars", "star-picker", { options: options("1", "2", "3") }));
    const no = [refused("stars", "stars", ["stars"])];

    it("holds a string", () => {
      expect(check(root, { stars: "2" }, undefined)).toEqual([]);
      expect(check(root, { stars: "4" }, undefined)).toEqual(no);
    });

    it("holds a finite number by its string form", () => {
      expect(check(root, { stars: 2 }, undefined)).toEqual([]);
      expect(check(root, { stars: 4 }, undefined)).toEqual(no);
      expect(check(root, { stars: 2.5 }, undefined)).toEqual(no);
      // Not a finite number: no choice writes one, so it is refused whole.
      expect(check(root, { stars: Number.NaN }, undefined)).toEqual(no);
    });

    it("holds each string, number or boolean of a list; any other item refuses the answer", () => {
      expect(check(root, { stars: ["1", 3] }, undefined)).toEqual([]);
      expect(check(root, { stars: [] }, undefined)).toEqual([]);
      expect(check(root, { stars: ["1", "9"] }, undefined)).toEqual(no);
      // A null, an object or a nested list in the list is the wrong shape, beside a valid pick or alone.
      expect(check(root, { stars: ["ZZ", null, { a: 1 }] }, undefined)).toEqual(no);
      expect(check(root, { stars: ["1", { evil: { deeper: [1, 2, 3] } }] }, undefined)).toEqual(no);
      expect(check(root, { stars: [null, { a: 1 }, ["1"]] }, undefined)).toEqual(no);
      expect(check(root, { stars: ["1", null] }, undefined)).toEqual(no);
    });

    it("holds a boolean, bare or in a list, by its string form, as the PDF prints it", () => {
      expect(check(root, { stars: [true] }, undefined)).toEqual(no);
      expect(check(root, { stars: ["1", false] }, undefined)).toEqual(no);
      expect(check(root, { stars: true }, undefined)).toEqual(no);
      expect(check(root, { stars: false }, undefined)).toEqual(no);
      const flags = form(leaf("flag", "toggle-picker", { options: options("true", "false") }));
      expect(check(flags, { flag: true }, undefined)).toEqual([]);
      expect(check(flags, { flag: [true, false, "true"] }, undefined)).toEqual([]);
    });

    it("holds an object's ticked keys; an entry that is not a boolean refuses it", () => {
      expect(check(root, { stars: { "1": true, "3": true, "9": false } }, undefined)).toEqual([]);
      expect(check(root, { stars: { "4": true } }, undefined)).toEqual(no);
      expect(check(root, { stars: { "4": true, junk: "yes" } }, undefined)).toEqual(no);
      expect(check(root, { stars: { "2": "yes", "9": 1, "8": null, "7": { x: true } } }, undefined)).toEqual(no);
      expect(check(root, { stars: { a: { x: 1 } } }, undefined)).toEqual(no);
    });

    it("refuses anything else", () => {
      for (const value of [new Date(0)]) {
        expect(check(root, { stars: value }, undefined), String(value)).toEqual(no);
      }
    });
  });

  it("checks an extension type that names a data source", () => {
    const root = form(leaf("city", "city-lookup", { data: { sourceId: "cities" } }));
    expect(check(root, { city: "Ottawa" }, { cities: [{ value: "Ottawa" }] })).toEqual([]);
    expect(check(root, { city: "Gotham" }, { cities: [{ value: "Ottawa" }] })).toHaveLength(1);
    expect(check(root, { city: ["Ottawa", "Gotham"] }, { cities: [{ value: "Ottawa" }] })).toHaveLength(1);
    expect(check(root, { city: 7 }, { cities: [{ value: 7 }] } as unknown as KernelOptionSnapshot)).toEqual([]);
    expect(check(root, { city: "Gotham" }, undefined)).toEqual([unavailable("city", "city", ["city"], "cities")]);
  });

  it("does not check an extension type with no source and no usable option", () => {
    const root = form(
      leaf("rating", "star-rating", { max: 5 }),
      leaf("empty", "star-rating", { options: [] }),
      leaf("junk", "star-rating", { options: [{ label: "no value" }, "x", null] })
    );
    expect(check(root, { rating: 4, empty: "x", junk: { a: 1 } }, undefined)).toEqual([]);
  });

  it("never checks a standard type whose control offers no options, whatever its configuration holds", () => {
    const root = form(
      leaf("name", "text", { options: options("x"), data: { sourceId: "names" } }),
      leaf("note", "textarea", { options: options("x") }),
      leaf("count", "number", { options: options("1") }),
      leaf("when", "date", { options: options("2026-01-01") }),
      leaf("agree", "checkbox", { options: options("yes") }),
      leaf("upload", "file", { options: options("a") })
    );
    expect(check(root, { name: "Ada", note: "hi", count: 5, when: "2026-10-07", agree: true, upload: [] }, { names: [] })).toEqual([]);
  });

  it("never checks a node that holds no answer of its own, though it carries options", () => {
    const root = form(
      group("panel", "panel", [], { options: options("x") }),
      leaf("go", "button", { options: options("x") }),
      group("items", "repeatingSection", [], { options: options("x") }, { collection: {} }),
      group("ext", "my-group", [leaf("inner", "text")], { options: options("x") })
    );
    expect(check(root, { panel: "y", go: "y", items: "y", ext: "y" }, undefined)).toEqual([]);
  });

  it("leaves a select, radio or checkboxes with no options and no data.sourceId unchecked: no refusal, whatever the answer", () => {
    // A host may name its source at a property path the definition does not carry; the kernel
    // cannot know that source, so it fails open rather than refusing every answer.
    for (const type of ["select", "radio", "checkboxes"]) {
      const root = form(leaf("q", type, { lookup: { source: "provinces" } }), leaf("r", type, { options: [] }));
      expect(kernelOptionQuestions(root).questions, type).toEqual([]);
      for (const value of ["ZZ", { ZZ: true }, 5, ["ZZ"], true]) {
        expect(check(root, { q: value, r: value }, { provinces: [] }), type + " " + JSON.stringify(value)).toEqual([]);
      }
    }
  });

  it("does not check a standard choice whose inline list is empty or unreadable and that names no source", () => {
    const root = form(
      leaf("a", "select", { options: [] }),
      leaf("b", "radio", { options: "x,y" }),
      leaf("c", "checkboxes", {}),
      leaf("e", "select", { options: [{ label: "no value" }, { value: 1 }] })
    );
    expect(check(root, { a: "x", b: "x", c: { x: true }, e: "1" }, undefined)).toEqual([]);
    // Not a choice, so its shape is not held either.
    expect(check(root, { a: { x: true }, c: "x" }, undefined)).toEqual([]);
  });

  it("reads only the options the renderer draws: an entry whose label is not text is not offered", () => {
    // A label is a string (its other languages live in the definition's map), so an old
    // `{ default, locales }` label is no text and its entry no option, as `isInlineOption` reads it.
    const root = form(
      leaf("d", "select", {
        options: [{ value: 1 }, { value: "ok", label: 5 }, { value: "old", label: { default: "Old", locales: { fr: "Vieux" } } }, { value: "fine", label: "Fine" }]
      })
    );
    expect(check(root, { d: "1" }, undefined)).toHaveLength(1);
    expect(check(root, { d: "ok" }, undefined)).toHaveLength(1);
    expect(check(root, { d: "old" }, undefined)).toHaveLength(1);
    expect(check(root, { d: "fine" }, undefined)).toEqual([]);
    for (const option of [{ value: "v" }, { value: "v", label: "L" }, { value: "v", description: "D" }, { value: "v", label: { default: "L" } }, { value: "v", description: null }]) {
      expect(kernelOptionInlineValues({ options: [option] }), JSON.stringify(option)).toEqual(isInlineOption(option) ? ["v"] : []);
    }
  });
});

describe("kernelCheckOptions: malformed input never throws", () => {
  it("passes over malformed trees, configurations and values", () => {
    const tree = {
      id: "form",
      type: "form",
      children: { content: [null, "x", { type: "select" }, select("ok", ["a"]), { id: "nocfg", type: "select", configuration: "bad" }], other: "not a list", none: null }
    } as unknown as ComponentNode;
    expect(() => check(tree, { ok: "b", nocfg: "z" }, undefined)).not.toThrow();
    // A select whose configuration is not a record carries no options: not a choice.
    expect(check(tree, { ok: "b", nocfg: "z" }, undefined).map((error) => error.componentId)).toEqual(["ok"]);
    const numeric = { id: "form", type: "form", children: { content: [{ id: 5, type: "repeatingSection", collection: {}, children: { content: [select("s", ["a"])] } }] } } as unknown as ComponentNode;
    expect(check(numeric, { "5[0].s": "z" }, undefined)).toEqual([refused("s", "5.s", ["5[0].s"])]);
    expect(check({ id: "form", type: "form", children: null } as unknown as ComponentNode, { a: 1 }, undefined)).toEqual([]);
    expect(check(null as unknown as ComponentNode, { a: 1 }, undefined)).toEqual([]);
    expect(check(form(select("ok", ["a"])), null as unknown as Record<string, unknown>, undefined)).toEqual([]);
    const grid = { id: "g", type: "dataGrid", configuration: {}, collection: { collectionPath: "rows" }, children: { content: "bad" } } as unknown as ComponentNode;
    expect(check(form(grid), { "rows[0].x": "y" }, undefined)).toEqual([]);
  });

  it("treats a value key that reads like an inherited member as any other key", () => {
    const root = form(select("constructor", ["a"]), select("__proto__", ["b"]));
    const values = JSON.parse('{ "constructor": "z", "__proto__": "z", "toString": "z" }') as Record<string, unknown>;
    expect(check(root, values, undefined).map((error) => error.componentId)).toEqual(["constructor", "__proto__"]);
  });
});

describe("kernelCheckOptions over the fold's values", () => {
  const hidden = { visibleWhen: eq("show", "yes") };
  const root = form(
    leaf("show", "text"),
    leaf("kept", "select", { options: options("a"), hiddenValueBehavior: "retain" }, { rules: hidden }),
    leaf("dropped", "select", { options: options("a"), hiddenValueBehavior: "exclude-from-submission" }, { rules: hidden })
  );
  // The fold reads the compiled copy, as the kernel's run hands it.
  const compiled = kernelCompileNode(root, kernelParseFormula, formulaFunctionSignatures(), []);

  it("refuses a hidden answer the form still submits, and has nothing to say of one the fold withheld", () => {
    const fold = kernelFoldSubmission(compiled, { show: "no", kept: "zz", dropped: "zz" }, undefined);
    expect(Object.keys(fold.submittable).sort()).toEqual(["kept", "show"]);
    expect(check(root, { ...fold.submittable }, undefined)).toEqual([refused("kept", "kept", ["kept"])]);
  });

  it("holds a visible answer just the same", () => {
    const fold = kernelFoldSubmission(compiled, { show: "yes", kept: "a", dropped: "zz" }, undefined);
    expect(check(root, { ...fold.submittable }, undefined)).toEqual([refused("dropped", "dropped", ["dropped"])]);
  });
});

describe("the options module's copies of the kernel's readings", () => {
  const mixed = form(
    leaf("name", "text"),
    select("province", ["ON"]),
    group("contact", "container", [leaf("email", "text"), group("inner", "container", [select("c", ["x"])], { dataKey: "deep" })]),
    group("plain", "container", [leaf("p", "text")], { scopeData: false }),
    group("box", "fieldset", [leaf("b", "text"), leaf("go", "button"), leaf("pic", "image")]),
    group("items", "repeatingSection", [select("sku", ["A1"]), group("addr", "container", [leaf("street", "text")]), group("lines", "repeatingSection", [leaf("qty", "number")], {}, { collection: {} })], {}, { collection: { collectionPath: "entries" } }),
    group("weird", "repeatingSection", [leaf("w", "text")], {}, { collection: { collectionPath: "bad[0]" } }),
    { id: "grid", type: "dataGrid", configuration: {}, collection: { collectionPath: "rows" }, children: { content: [leaf("a", "text")] } },
    leaf("ext", "star-rating", { dataKey: "stars" })
  );
  // The run reads a grid normalized; both walks are held to each other over that tree.
  const normalized = kernelNormalizeDataGrids(mixed);

  it("walks to the same key shapes as kernelKnownKeyShapes", () => {
    expect(Object.keys(kernelOptionQuestions(mixed).knownShapes).sort()).toEqual(Object.keys(kernelKnownKeyShapes(mixed)).sort());
    expect(Object.keys(kernelOptionQuestions(normalized).knownShapes).sort()).toEqual(Object.keys(kernelKnownKeyShapes(normalized)).sort());
    expect(kernelKnownKeyShapes(normalized)["rows[].a"]).toBe(true);
  });

  it("finds the choice questions at the shapes the kernel defines", () => {
    const found = kernelOptionQuestions(mixed);
    expect(found.questions.map((question) => [question.componentId, question.shape, question.path])).toEqual([
      ["province", "province", "province"],
      ["c", "contact.deep.c", "contact.deep.c"],
      ["sku", "entries[].sku", "entries.sku"]
    ]);
    const known = kernelKnownKeyShapes(mixed);
    for (const question of found.questions) {
      expect(known[question.shape]).toBe(true);
    }
  });

  it("copies the fold's own-answer reading to the letter", () => {
    const ours = kernelOptionHoldsOwnAnswer.toString().replace("kernelOptionHoldsOwnAnswer", "X");
    const theirs = kernelFoldHoldsOwnAnswer.toString().replace("kernelFoldHoldsOwnAnswer", "X");
    expect(ours).toBe(theirs);
  });

  it("reads a source id as readSourceId does", () => {
    const configurations: unknown[] = [
      undefined, null, "x", [], {}, { data: null }, { data: [] }, { data: "s" }, { data: { sourceId: "" } }, { data: { sourceId: 3 } },
      { data: { sourceId: "s" } }, { data: { sourceId: ["s"] } }, { lookup: { source: "t" } }, { data: { nested: { id: "u" } } }
    ];
    for (const configuration of configurations) {
      for (const path of [undefined, "data.sourceId", "lookup.source", "data.nested.id", "data"]) {
        expect(kernelOptionSourceId(configuration, path), JSON.stringify([configuration, path])).toBe(readSourceId(configuration, path));
      }
    }
  });

  it("walks to the same key shapes as kernelKnownKeyShapes over generated trees", () => {
    let seed = 20261007;
    function random(): number {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    }
    function pick<T>(items: readonly T[]): T {
      return items[Math.floor(random() * items.length)] as T;
    }
    const types = ["text", "select", "checkboxes", "radio", "container", "container", "fieldset", "panel", "repeatingSection", "dataGrid", "button", "star-rating", "number"];
    const ids = ["a", "b", "c", "items", "lines", "orders", "x_1", "constructor", "__proto__", "9"];
    let counter = 0;
    function node(depth: number): ComponentNode {
      counter += 1;
      const type = pick(types);
      const collection = type === "repeatingSection" ? pick<unknown>([{}, { collectionPath: "lines" }, { collectionPath: "a[0]" }, { collectionPath: "" }, undefined, null]) : pick<unknown>([undefined, undefined, undefined, undefined, null, false, 0, ""]);
      // A section's id is a string: the kernel's own walk would throw on any other.
      const id: unknown = collection ? pick(ids) + counter : pick<unknown>([...ids.map((name) => name + counter), 7, pick(ids)]);
      const configuration: Record<string, unknown> = {};
      const key = pick<unknown>([undefined, undefined, "k", "12", "bad key", "deep", 3]);
      if (key !== undefined) {
        configuration.dataKey = key;
      }
      if (type === "container" && random() < 0.3) {
        configuration.scopeData = false;
      }
      if (type === "select" || type === "checkboxes" || type === "star-rating") {
        configuration.options = options("o");
      }
      const built: Record<string, unknown> = { id, type, configuration };
      if (collection !== undefined) {
        built.collection = collection;
      }
      if (type === "dataGrid") {
        const path = pick<unknown>(["orders", "rows", "bad[0]", undefined]);
        if (path !== undefined) {
          built.collection = { collectionPath: path };
        }
        built.children = { content: [leaf("c", "text"), select("s", ["o"])] };
      }
      const isGroup = ["container", "fieldset", "panel", "repeatingSection"].indexOf(type) >= 0 || random() < 0.05;
      if (isGroup && depth < 4) {
        const count = Math.floor(random() * 4);
        built.children = { content: Array.from({ length: count }, () => node(depth + 1)), ...(random() < 0.2 ? { aside: [node(depth + 1)] } : {}) };
      }
      return built as unknown as ComponentNode;
    }
    for (let tree = 0; tree < 400; tree += 1) {
      const root = kernelNormalizeDataGrids(form(...Array.from({ length: 1 + Math.floor(random() * 5) }, () => node(0))));
      expect(Object.keys(kernelOptionQuestions(root).knownShapes).sort(), JSON.stringify(root)).toEqual(Object.keys(kernelKnownKeyShapes(root)).sort());
    }
  });

  it("reads a component's own answer as the fold does", () => {
    const types = ["text", "select", "radio", "checkboxes", "star-rating", "form", "fieldset", "panel", "grid", "tabs", "tab", "steps", "step", "repeatingSection", "container", "button", "html", "image", "signature", "dataGrid", "file", "checkbox"];
    for (const type of types) {
      for (const node of [leaf("n", type), group("n", type, []), leaf("n", type, {}, { collection: {} })]) {
        expect(kernelOptionHoldsOwnAnswer(node), type).toBe(kernelFoldHoldsOwnAnswer(node));
      }
    }
  });
});

describe("PORTABLE_OPTIONS_FUNCTIONS", () => {
  it("lists every exported function of the module, each a top-level declaration", async () => {
    const module = (await import("../form-engine/validation/wasm/portable-options.js")) as Record<string, unknown>;
    const exported = Object.entries(module)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(PORTABLE_OPTIONS_FUNCTIONS.map((fn) => fn.name).sort()).toEqual(exported);
    for (const fn of PORTABLE_OPTIONS_FUNCTIONS) {
      expect(fn.toString().startsWith(`function ${fn.name}(`), fn.name).toBe(true);
      expect(fn.name.startsWith("kernel"), fn.name).toBe(true);
    }
  });

  it("calls nothing outside its own list: no function reads an imported binding", () => {
    for (const fn of PORTABLE_OPTIONS_FUNCTIONS) {
      expect(fn.toString(), fn.name).not.toMatch(/__vi(?:te)?_(?:ssr_)?import_\d+__/);
    }
  });

  it("runs spliced into one scope as the sandbox program splices it, with the same verdicts", () => {
    const source = PORTABLE_OPTIONS_FUNCTIONS.map((fn) => fn.toString()).join("\n") + "\nreturn kernelCheckOptions;";
    const spliced = new Function(source)() as typeof kernelCheckOptions;
    const root = form(
      select("province", ["ON"]),
      leaf("topics", "checkboxes", { data: { sourceId: "topics" } }),
      group("items", "repeatingSection", [select("sku", ["A1"])], {}, { collection: {} })
    );
    const values = { province: "QC", topics: { roads: true }, "items[0].sku": "A1", "items[1].sku": "B2" };
    const snapshot = { topics: [{ value: "parks" }] };
    const expected = check(root, values, snapshot);
    expect(expected.map((error) => error.componentId)).toEqual(["province", "topics", "sku"]);
    expect(JSON.parse(JSON.stringify(spliced(root, values, snapshot)))).toEqual(expected);
  });
});

describe("a source whose answers are free", () => {
  const free = (id: string, extra: Record<string, unknown> = {}) => select(id, [], { data: { sourceId: "towns", answersFree: true }, ...extra });

  it("takes any text with no snapshot, a snapshot lacking the source, or a list that does not hold it", () => {
    const root = form(free("town"));
    expect(check(root, { town: "Nowhere" }, undefined)).toEqual([]);
    expect(check(root, { town: "Nowhere" }, {})).toEqual([]);
    expect(check(root, { town: "Nowhere" }, { towns: [{ value: "ott" }] })).toEqual([]);
    expect(kernelOptionQuestions(root).questions[0]).toMatchObject({ sourceId: "towns", free: true });
  });

  it("logs nothing about a free source being unchecked", () => {
    const lines: string[] = [];
    check(form(free("town")), { town: "x" }, undefined, { info: (message) => lines.push(message), warn: (message) => lines.push(message) });
    expect(lines).toEqual([]);
  });

  it("still holds the answer's shape", () => {
    expect(check(form(free("town")), { town: 7 }, undefined)).toEqual([refused("town", "town", ["town"])]);
  });

  it("only the boolean true frees it: absent, false or a word leaves the check on, failing closed", () => {
    for (const flag of [false, "true", 1, undefined]) {
      const root = form(select("town", [], { data: { sourceId: "towns", ...(flag === undefined ? {} : { answersFree: flag }) } }));
      expect(check(root, { town: "x" }, undefined), String(flag)).toEqual([unavailable("town", "town", ["town"], "towns")]);
    }
  });

  it("a held question on the same source stays held beside a free one", () => {
    const root = form(free("town"), select("home", [], { data: { sourceId: "towns" } }));
    expect(check(root, { town: "x", home: "x" }, { towns: [{ value: "ott" }] })).toEqual([refused("home", "home", ["home"])]);
  });

  it("a free question inside a repeating section is free per entry", () => {
    const root = form({
      ...group("rows", "repeatingSection", [free("stop")], {}),
      collection: { itemFields: ["stop"] }
    });
    expect(check(root, { "rows[0].stop": "anywhere" }, undefined)).toEqual([]);
  });
});

describe("an object posted whole at a data-scoping container's key", () => {
  const pick = leaf("pick", "select", { options: options("ok") });
  const addr = group("addr", "container", [pick, leaf("note", "text", { maxLength: 3 })]);
  const root = form(addr);
  const run = (values: Record<string, unknown>, unknownFields?: "strip" | "keep" | "reject", node: ComponentNode = root) =>
    runKernel({ formId: "f", values, locale: "en", form: node, ...(unknownFields !== undefined ? { unknownFields } : {}) } as never, []);

  it("is read as the flat keys the runtime stores, so the option check and the constraints see it", () => {
    expect(kernelPartitionValues({ addr: { pick: "ok", note: "abc" } }, root).known).toEqual({ "addr.pick": "ok", "addr.note": "abc" });
    const refusedPick = run({ addr: { pick: "evil" } });
    expect(refusedPick.errors.map((error) => error.code)).toEqual(["option.notAllowed"]);
    expect(run({ "addr.pick": "evil" }).errors.map((error) => error.code)).toEqual(["option.notAllowed"]);
    expect(run({ addr: { note: "abcdef" } }).errors.map((error) => error.code)).toEqual(run({ "addr.note": "abcdef" }).errors.map((error) => error.code));
    expect(run({ addr: { pick: "ok", note: "abc" } }).errors).toEqual([]);
    expect(run({ addr: { pick: "ok" } }).values).toEqual({ "addr.pick": "ok" });
  });

  it("is read the same way in keep mode, and a key it does not define is the unknown key it is", () => {
    expect(run({ addr: { pick: "evil" } }, "keep").errors.map((error) => error.code)).toEqual(["option.notAllowed"]);
    expect(run({ addr: { pick: "ok", other: 1 } }, "strip").values).toEqual({ "addr.pick": "ok" });
    expect(run({ addr: { pick: "ok", other: 1 } }, "reject").errors).toEqual([
      { code: "unknown_field", stage: "sanitization", source: "wasm", parameters: { field: "addr.other" } }
    ]);
  });

  it("lets a key sent flat beside the object win", () => {
    const outcome = run({ addr: { pick: "evil" }, "addr.pick": "ok" });
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ "addr.pick": "ok" });
    expect(run({ "addr.pick": "ok", addr: { pick: "evil" } }).values).toEqual({ "addr.pick": "ok" });
  });

  it("reads nested containers a level at a time, and leaves a checkboxes answer object as the answer", () => {
    const deep = form(group("a", "container", [group("b", "container", [pick])]));
    expect(run({ a: { b: { pick: "evil" } } }, undefined, deep).errors.map((error) => error.code)).toEqual(["option.notAllowed"]);
    const boxes = form(leaf("tags", "checkboxes", { options: options("x") }));
    expect(kernelPartitionValues({ tags: { x: true } }, boxes).known).toEqual({ tags: { x: true } });
  });

  it("reads a container inside a repeating section's entry posted at its flat key too", () => {
    const rows = form({ ...group("rows", "repeatingSection", [group("addr", "container", [pick])]), collection: {} });
    expect(run({ "rows[0].addr": { pick: "evil" } }, undefined, rows).errors.map((error) => error.code)).toEqual(["option.notAllowed"]);
    expect(run({ rows: [{ addr: { pick: "evil" } }] }, undefined, rows).errors.map((error) => error.code)).toEqual(["option.notAllowed"]);
  });

  it("does not store an object nested too deep to read as keys, in any unknown-fields mode", () => {
    let inner: ComponentNode = pick;
    for (let level = 20; level >= 0; level -= 1) {
      inner = group("c" + level, "container", [inner]);
    }
    let cell: unknown = { pick: "evil" };
    for (let level = 20; level >= 0; level -= 1) {
      cell = { ["c" + level]: cell };
    }
    const tall = form(inner);
    for (const mode of ["strip", "keep"] as const) {
      expect(JSON.stringify(run({ c0: (cell as Record<string, unknown>).c0 }, mode, tall).values ?? null), mode).not.toContain("evil");
    }
    expect(run({ c0: (cell as Record<string, unknown>).c0 }, "reject", tall).errors.map((error) => error.code)).toEqual(["unknown_field"]);
  });
  // a container's own key holds no answer.
  it("does not store a scalar, a list or null posted at a container's own key, and rejects it under reject", () => {
    for (const posted of ["evil", 7, true, null, ["x"], [{ pick: "evil" }]]) {
      for (const mode of ["strip", "keep"] as const) {
        const outcome = run({ addr: posted }, mode);
        expect(outcome.values, JSON.stringify(posted) + " " + mode).toEqual({});
        expect(outcome.errors, JSON.stringify(posted) + " " + mode).toEqual([]);
      }
      expect(run({ addr: posted }, "reject").errors, JSON.stringify(posted)).toEqual([
        { code: "unknown_field", stage: "sanitization", source: "wasm", parameters: { field: "addr" } }
      ]);
    }
    // The known keys beside it are judged as ever; a container inside a container and inside an entry are held to the same.
    expect(run({ addr: "evil", "addr.pick": "ok" }).values).toEqual({ "addr.pick": "ok" });
    const nested = form(group("a", "container", [group("b", "container", [pick])]));
    expect(run({ a: { b: "evil" } }, undefined, nested).values).toEqual({});
    expect(run({ "a.b": "evil" }, "reject", nested).errors.map((error) => error.parameters)).toEqual([{ field: "a.b" }]);
    const rows = form(group("rows", "repeatingSection", [group("addr", "container", [pick])], {}, { collection: {} }));
    expect(run({ rows: [{ addr: "evil" }] }, undefined, rows).values).toEqual({});
    expect(run({ "rows[0].addr": null }, "reject", rows).errors.map((error) => error.parameters)).toEqual([{ field: "rows[0].addr" }]);
  });

  it("keeps a key a container shares with a field as a possible answer", () => {
    const shared = form(group("addr", "container", [pick]), leaf("addr", "text"));
    expect(run({ addr: "kept" }, undefined, shared).values).toEqual({ addr: "kept" });
  });

  // a list path reached through a container reads like its flat spelling.
  it("holds a grid's rows reached through a container to what the flat spelling is", () => {
    const grid = { id: "g", type: "dataGrid", configuration: {}, collection: { collectionPath: "addr.g" }, children: { content: [leaf("c", "text")] } } as unknown as ComponentNode;
    const tree = form(group("addr", "container", [grid]));
    for (const posted of [{ c: "evil" }, "evil", ["x"], 7]) {
      const flat = run({ "addr.g": posted }, "strip", tree);
      const nested = run({ addr: { g: posted } }, "strip", tree);
      expect(nested.values, JSON.stringify(posted)).toEqual(flat.values);
      expect(JSON.stringify(nested.values), JSON.stringify(posted)).not.toContain("evil");
      expect(run({ addr: { g: posted } }, "reject", tree).errors.map((error) => error.parameters), JSON.stringify(posted)).toEqual(
        run({ "addr.g": posted }, "reject", tree).errors.map((error) => error.parameters)
      );
    }
    expect(run({ addr: { g: [{ c: "fine" }] } }, "strip", tree).values).toEqual({ "addr.g[0].c": "fine" });
  });

  it("reads 17 nested containers and stores nothing from 18", () => {
    const chain = (levels: number): { tree: ComponentNode; posted: Record<string, unknown> } => {
      let inner: ComponentNode = pick;
      let cell: unknown = { pick: "evil" };
      for (let level = levels - 1; level >= 0; level -= 1) {
        inner = group("c" + level, "container", [inner]);
        cell = { ["c" + level]: cell };
      }
      return { tree: form(inner), posted: cell as Record<string, unknown> };
    };
    const ok = chain(17);
    expect(run(ok.posted, "strip", ok.tree).errors.map((error) => error.code)).toEqual(["option.notAllowed"]);
    const tall = chain(18);
    expect(JSON.stringify(run(tall.posted, "strip", tall.tree).values)).not.toContain("evil");
    expect(run(tall.posted, "reject", tall.tree).errors.map((error) => error.code)).toEqual(["unknown_field"]);
  });
});
