import { CONTROL_VALUES } from "../fixtures/controls.js";
import { addComponents, containerChain, containerPost, flatValid, flatWithout, nestedObject, parsed, selectNode, textNode } from "../fixtures/inputs.js";
import type { Json } from "../observation.js";
import type { Expectation } from "../predicates.js";
import { accepted, all, RUNS, vector } from "./helpers.js";
import type { Fixture, Variant, Vector, VectorInput } from "./schema.js";

/**
 * OPT: options and data scoping. A choice answer (select, radio, checkboxes) must be one of the
 * options the form or the data source offers, whatever spelling the filler posts it in. These
 * are the S1 vectors of the suite: a program that stores a value the form does not offer has
 * stopped being a gate. Paths come from the fixture form (`addr.pick`, `tags`, `rows`).
 */
const OPTIONS_TESTS = "engine/tests/portable-options.test.ts";
const QUICKJS_KERNEL_TESTS = "packages/quickjs-wasm-host/tests/quickjs-kernel-limits.test.ts";
const everywhere = { program: RUNS, endpoint: RUNS, parity: RUNS } as const;
const programOnly = { program: RUNS, endpoint: false, parity: false } as const;

const run = (values: Record<string, Json> | Json, extra: Partial<Extract<VectorInput, { kind: "values" }>> = {}): VectorInput => ({ kind: "values", values, ...extra });

const refusedAt = (field: string): Expectation => all(accepted(false), { op: "codes", exactly: [`option.notAllowed@${field}`] });
const unavailableAt = (field: string): Expectation => all(accepted(false), { op: "codes", exactly: [`option.sourceUnavailable@${field}`] });
const fine: Expectation = all(accepted(true), { op: "codes", exactly: [] });

/** OPT-14's grid with its minimum also written as a formula over a number answer. */
const formulaBoundGrid: Fixture = {
  definition: "base+patch",
  patch: addComponents(
    { id: "guests", type: "number", configuration: {} },
    {
      id: "lines",
      type: "dataGrid",
      configuration: { minRows: 2, maxRows: 3 },
      rules: { minRows: "guests" },
      collection: { collectionPath: "orders" },
      children: { content: [{ id: "item", type: "text", configuration: {} }] }
    }
  )
};

/** A value posted as `addr.pick` (the fixture's select; options ok and fine). */
const pick = (value: Json): Record<string, Json> => flatValid({ "addr.pick": value });

const pickVariants = (cases: [string, Json][]): Variant[] => cases.map(([id, value]) => ({ id, input: run(pick(value)) }));

// A town select that names a data source; the form's other fields are the fixture's.
const TOWNS = { data: { sourceId: "towns" } };
const withTown = (configuration: Record<string, unknown> = TOWNS) => addComponents(selectNode("town", ["inline"], configuration));
const townFixture = (snapshot: Record<string, unknown> | undefined, configuration?: Record<string, unknown>): Fixture => ({
  definition: "base+patch",
  patch: withTown(configuration),
  ...(snapshot !== undefined ? { snapshot } : {})
});
const SNAPSHOT = { towns: [{ value: "ON", label: "Ontario" }, { value: "QC", label: "Quebec" }] };
const town = (value: Json): VectorInput => run(flatValid({ town: value }));

const hostileTags = (text: string): VectorInput => run(flatValid({ tags: parsed(text) }));

export const OPTIONS_VECTORS: Vector[] = [
  vector({
    id: "OPT-01",
    title: "A select answer outside the options is refused, whatever its spelling: case, padding, label, NUL",
    class: "options",
    severity: "S1",
    attacker: "filler",
    provenance: { tests: [{ path: OPTIONS_TESTS, name: "inline select and radio" }] },
    input: run(pick("ZZ")),
    expect: refusedAt("addr.pick"),
    variants: pickVariants([
      ["leading-space", " ok"],
      ["upper-case", "OK"],
      ["trailing-space", "ok "],
      ["label-not-value", "Ok"],
      ["nul-suffix", "ok\u0000"]
    ]),
    applies: everywhere
  }),
  vector({
    id: "OPT-02",
    title: "A select answer of the wrong shape (object, list, number, boolean) is refused",
    class: "options",
    severity: "S1",
    attacker: "filler",
    provenance: { tests: [{ path: OPTIONS_TESTS, name: "wrong shape" }] },
    input: run(pick({ ok: true })),
    expect: refusedAt("addr.pick"),
    variants: pickVariants([
      ["list", ["ok"]],
      ["number", 1],
      ["true", true],
      ["zero", 0]
    ]),
    applies: everywhere
  }),
  vector({
    id: "OPT-03",
    title: "A checkboxes answer ticking a non-option, or holding anything but booleans, is refused; unticked entries are ignored",
    class: "options",
    severity: "S1",
    attacker: "filler",
    provenance: { tests: [{ path: OPTIONS_TESTS, name: "checkboxes" }] },
    input: run(flatValid({ tags: { x: true, z: true } })),
    expect: refusedAt("tags"),
    variants: [
      { id: "text-not-boolean", input: run(flatValid({ tags: { x: "true" } })) },
      { id: "number-not-boolean", input: run(flatValid({ tags: { x: 1 } })) },
      { id: "null-entry", input: run(flatValid({ tags: { x: null } })) },
      { id: "text-answer", input: run(flatValid({ tags: "x" })) },
      { id: "list-answer", input: run(flatValid({ tags: ["x"] })) },
      { id: "number-answer", input: run(flatValid({ tags: 1 })) },
      { id: "proto-key", input: hostileTags('{"__proto__":true}') },
      { id: "constructor-key", input: run(flatValid({ tags: { constructor: true } })) },
      { id: "unticked-non-option-ignored", input: run(flatValid({ tags: { x: true, z: false } })), expect: fine }
    ],
    applies: everywhere
  }),
  vector({
    id: "OPT-04",
    title: "An answer outside the data source's snapshot is refused; the inline list is ignored once a source is named",
    class: "options",
    severity: "S1",
    attacker: "source-operator",
    provenance: { tests: [{ path: OPTIONS_TESTS, name: "options from a data source snapshot" }] },
    fixture: townFixture(SNAPSHOT),
    input: town("ZZ"),
    expect: refusedAt("town"),
    variants: [
      { id: "in-snapshot-passes", input: town("ON"), expect: fine },
      { id: "inline-value-ignored", input: town("inline") }
    ]
  }),
  vector({
    id: "OPT-05",
    title: "A source the snapshot lacks fails closed with option.sourceUnavailable; an empty or malformed list allows nothing",
    class: "options",
    severity: "S1",
    attacker: "source-operator",
    provenance: { tests: [{ path: OPTIONS_TESTS, name: "fails closed for a source the snapshot does not have" }] },
    fixture: townFixture(undefined),
    input: town("anything"),
    expect: unavailableAt("town"),
    variants: [
      { id: "null-snapshot", fixture: { ...townFixture(undefined), snapshot: null as unknown as Record<string, unknown> }, programOnly: true },
      { id: "list-snapshot", fixture: { ...townFixture(undefined), snapshot: [] as unknown as Record<string, unknown> }, programOnly: true },
      { id: "empty-snapshot", fixture: townFixture({}), programOnly: true },
      { id: "other-source-only", fixture: townFixture({ regions: [{ value: "x" }] }), programOnly: true },
      { id: "source-is-text", fixture: townFixture({ towns: "anything" }), programOnly: true },
      { id: "source-is-null", fixture: townFixture({ towns: null }), programOnly: true },
      { id: "empty-list-allows-nothing", fixture: townFixture({ towns: [] }), expect: refusedAt("town"), programOnly: true },
      { id: "object-value-allows-nothing", fixture: townFixture({ towns: [{ value: { v: "anything" } }] }), expect: refusedAt("town"), programOnly: true },
      { id: "source-named-constructor", fixture: townFixture({}, { data: { sourceId: "constructor" } }), programOnly: true },
      { id: "no-answer-needs-no-source", fixture: townFixture(undefined), input: run(flatValid()), expect: fine, programOnly: true }
    ]
  }),
  vector({
    id: "OPT-06",
    title: "An object posted at a data-scoping container's key is judged like the flat key it stands for, and stored flat",
    class: "options",
    severity: "S1",
    attacker: "filler",
    provenance: { tests: [{ path: OPTIONS_TESTS, name: "an object posted whole at a data-scoping container's key" }, { path: QUICKJS_KERNEL_TESTS, name: "an object posted at a container key is judged like the flat key" }] },
    input: run(flatWithout(["addr.city", "addr.pick"], { addr: { city: "Ottawa", pick: "evil" } })),
    expect: refusedAt("addr.pick"),
    variants: [
      { id: "flat-spelling", input: run(pick("evil")) },
      { id: "valid-nested-is-accepted-and-stored-flat", input: { kind: "values", values: CONTROL_VALUES["CTL-01"]() }, expect: all(accepted(true), { op: "golden", key: "CTL-01" }) }
    ],
    applies: everywhere
  }),
  vector({
    id: "OPT-07",
    title: "An object nested far past the schema at a container key is not stored (21 levels, any unknown-fields mode)",
    class: "options",
    severity: "S1",
    attacker: "filler",
    provenance: { tests: [{ path: OPTIONS_TESTS, name: "does not store an object nested too deep to read as keys" }, { path: QUICKJS_KERNEL_TESTS, name: "past the flattening cap" }] },
    input: run(flatWithout(["addr.city", "addr.pick"], { addr: { city: "Ottawa", pick: "ok", deep: nestedObject(21, { pick: "ZZEVILZZ" }) } })),
    expect: { op: "valuesExcludeText", text: ["ZZEVILZZ"] },
    variants: [
      {
        id: "twenty-one-containers",
        fixture: { definition: "base+patch", patch: addComponents(containerChain(21, selectNode("pick", ["ok"]))) },
        input: run(flatValid({ c0: containerPost(21, { pick: "ZZEVILZZ" }) })),
        programOnly: true
      }
    ],
    applies: everywhere
  }),
  vector({
    id: "OPT-08",
    title: "Rows posted whole at a list path are judged like their flat keys; a cell outside its options is refused, a deep unknown part is not stored",
    class: "options",
    severity: "S1",
    attacker: "filler",
    provenance: { tests: [{ path: OPTIONS_TESTS, name: "rows posted whole at a collection path" }] },
    input: run(flatWithout(["rows[0].sku", "rows[0].n"], { rows: [{ sku: "s1", n: 1, deep: nestedObject(12, "ZZEVILZZ") }] })),
    expect: { op: "valuesExcludeText", text: ["ZZEVILZZ"] },
    variants: [
      {
        id: "cell-outside-options",
        fixture: { definition: "base+patch", patch: rowsWithPick },
        input: run(flatWithout(["rows[0].sku", "rows[0].n"], { rows: [{ sku: "s1", pick: "evil" }] })),
        expect: all(accepted(false), { op: "codes", includes: ["option.notAllowed"] }),
        programOnly: true
      },
      {
        id: "cell-outside-options-flat",
        fixture: { definition: "base+patch", patch: rowsWithPick },
        input: run(flatWithout(["rows[0].sku", "rows[0].n"], { "rows[0].sku": "s1", "rows[0].pick": "evil" })),
        expect: all(accepted(false), { op: "codes", includes: ["option.notAllowed"] }),
        programOnly: true
      }
    ],
    applies: everywhere
  }),
  vector({
    id: "OPT-09",
    title: "Odd spellings of a list key (rows[00], rows[01], rows[ 0], rows[0]..), an index on a container, or a scalar or list at a container key are refused or dropped, never stored unchecked",
    class: "options",
    severity: "S3",
    attacker: "filler",
    provenance: { tests: [{ path: OPTIONS_TESTS, name: "an object posted whole at a data-scoping container's key" }] },
    input: run(flatValid({ "rows[00].sku": "ZZODDZZ" })),
    expect: { op: "valuesExcludeText", text: ["ZZODDZZ"] },
    variants: [
      ...[
        ["leading-zero-one", "rows[01].sku"],
        ["space-in-index", "rows[ 0].sku"],
        ["double-dot", "rows[0]..sku"],
        ["index-on-container", "addr[0].pick"]
      ].map(([id, key]) => ({ id: id as string, input: run(flatValid({ [key as string]: "ZZODDZZ" })) })),
      { id: "text-at-container-key", input: run(flatValid({ addr: "ZZODDZZ" })) },
      { id: "list-at-container-key", input: run(flatValid({ addr: ["ZZODDZZ"] })) }
    ],
    applies: everywhere
  }),
  vector({
    id: "OPT-10",
    title: "Only the boolean true frees a source's answers; any other word fails closed, and a held question on the same source stays held",
    class: "options",
    severity: "S1",
    attacker: "author",
    provenance: { tests: [{ path: OPTIONS_TESTS, name: "a source whose answers are free" }] },
    fixture: townFixture({ towns: [{ value: "ott" }] }, { data: { sourceId: "towns", answersFree: true } }),
    input: town("Nowhere"),
    expect: fine,
    variants: [
      ...[
        ["flag-is-text", "true"],
        ["flag-is-one", 1],
        ["flag-is-false", false]
      ].map(([id, flag]) => ({
        id: id as string,
        fixture: townFixture({ towns: [{ value: "ott" }] }, { data: { sourceId: "towns", answersFree: flag } }),
        input: town("Nowhere"),
        expect: refusedAt("town"),
        programOnly: true
      })),
      {
        id: "flag-absent",
        fixture: townFixture({ towns: [{ value: "ott" }] }),
        input: town("Nowhere"),
        expect: refusedAt("town"),
        programOnly: true
      },
      {
        id: "free-answers-still-hold-their-shape",
        input: town(7),
        expect: refusedAt("town"),
        programOnly: true
      },
      {
        id: "held-question-on-the-same-source-stays-held",
        fixture: {
          definition: "base+patch",
          patch: addComponents(selectNode("town", [], { data: { sourceId: "towns", answersFree: true } }), selectNode("home", [], { data: { sourceId: "towns" } })),
          snapshot: { towns: [{ value: "ott" }] }
        },
        input: run(flatValid({ town: "x", home: "x" })),
        expect: refusedAt("home"),
        programOnly: true
      }
    ]
  }),
  vector({
    id: "OPT-11",
    title: "A number, date or checkbox sharing a storage key with a sourced select does not switch the select's option check off (only a plain text input does, by design)",
    class: "options",
    severity: "S1",
    attacker: "author",
    provenance: { tests: [{ path: "engine/tests/kernel-data-key-and-text-caps.test.ts", name: "keeps the check when the other component is anything but a plain text input" }] },
    fixture: {
      definition: "base+patch",
      patch: addComponents({ id: "t", type: "number", configuration: { dataKey: "shared" } }, selectNode("s", [], { dataKey: "shared", data: { sourceId: "restricted" } })),
      snapshot: { restricted: [{ value: "ok", label: "Ok" }] }
    },
    input: run(flatValid({ shared: "evil" })),
    expect: all(accepted(false), { op: "codes", includes: ["option.notAllowed"] }),
    variants: [
      ...["date", "checkbox", "file"].map(
        (type): Variant => ({
          id: `${type}-sharer-keeps-the-check`,
          fixture: {
            definition: "base+patch",
            patch: addComponents({ id: "t", type, configuration: { dataKey: "shared" } }, selectNode("s", [], { dataKey: "shared", data: { sourceId: "restricted" } })),
            snapshot: { restricted: [{ value: "ok", label: "Ok" }] }
          },
          programOnly: true
        })
      ),
      {
        id: "a-plain-text-sharer-still-stands-aside",
        fixture: {
          definition: "base+patch",
          patch: addComponents(textNode("t", { dataKey: "shared" }), selectNode("s", [], { dataKey: "shared", data: { sourceId: "restricted" } })),
          snapshot: { restricted: [{ value: "ok", label: "Ok" }] }
        },
        expect: all(accepted(true), { op: "codes", excludes: ["option.notAllowed"] }),
        programOnly: true
      },
      {
        id: "select-alone-is-held",
        fixture: {
          definition: "base+patch",
          patch: addComponents(selectNode("s", [], { dataKey: "shared", data: { sourceId: "restricted" } })),
          snapshot: { restricted: [{ value: "ok", label: "Ok" }] }
        },
        programOnly: true
      }
    ],
    applies: programOnly
  }),
  vector({
    id: "OPT-12",
    title: "A plugin-type pick holding nested objects or lists is refused, not stored as picking nothing",
    class: "options",
    severity: "S3",
    attacker: "filler",
    provenance: { tests: [{ path: "engine/tests/kernel-data-key-and-text-caps.test.ts", name: "refuses a nested object, a list holding one, a null item and a record entry that is not a boolean" }] },
    fixture: {
      definition: "base+patch",
      patch: addComponents({ id: "r", type: "rating", configuration: { data: { sourceId: "s" } } }),
      snapshot: { s: [{ value: "1" }, { value: "2" }] }
    },
    input: run(flatValid({ r: ["1", parsed('{"evil":{"d":[1]}}')] })),
    expect: all(accepted(false), { op: "codes", includes: ["option.notAllowed"] }),
    variants: [
      { id: "object-of-objects", input: run(flatValid({ r: { a: { x: 1 } } })) },
      { id: "list-of-null", input: run(flatValid({ r: [null] })) }
    ],
    applies: programOnly
  }),
  vector({
    id: "OPT-13",
    title: "A data grid's column constraints (required, maxLength, file size) are enforced per row",
    class: "options",
    severity: "S3",
    attacker: "filler",
    provenance: {
      tests: [{ path: "engine/tests/kernel-data-key-and-text-caps.test.ts" }, { path: "packages/quickjs-wasm-host/tests/quickjs-kernel-data-key-and-text-caps.test.ts" }]
    },
    fixture: {
      definition: "base+patch",
      patch: addComponents({
        id: "g",
        type: "dataGrid",
        configuration: {},
        collection: { collectionPath: "orders" },
        children: {
          content: [
            { id: "c1", type: "text", configuration: { required: true, maxLength: 3, dataKey: "name" } },
            { id: "c2", type: "file", configuration: { maxFileSizeMb: 1, accept: ".pdf", dataKey: "doc" } }
          ]
        }
      })
    },
    input: run(flatValid({ "orders[0].name": "far-too-long" })),
    expect: all(accepted(false), { op: "codes", includes: ["maxLength"] }),
    variants: [
      { id: "required-column-blank", input: run(flatValid({ "orders[0].name": "" })), expect: all(accepted(false), { op: "codes", includes: ["required"] }) },
      {
        id: "oversized-file-cell",
        input: run(flatValid({ "orders[0].name": "ok", "orders[0].doc": { storage: "s", name: "a.exe", type: "x/y", size: 999999999 } })),
        expect: all(accepted(false), { op: "codes", includes: ["maxFileSize"] })
      }
    ],
    applies: programOnly
  }),
  vector({
    id: "OPT-14",
    title: "A data grid's row count is held to its minimum and maximum, an empty row posted as {} counted",
    class: "options",
    severity: "S3",
    attacker: "filler",
    provenance: {
      tests: [
        { path: "engine/tests/portable-kernel.test.ts", name: "a data grid's row count" },
        { path: "packages/quickjs-wasm-host/tests/quickjs-data-grid.test.ts" }
      ]
    },
    fixture: {
      definition: "base+patch",
      patch: addComponents({
        id: "lines",
        type: "dataGrid",
        configuration: { minRows: 2, maxRows: 3 },
        collection: { collectionPath: "orders" },
        children: { content: [{ id: "item", type: "text", configuration: {} }] }
      })
    },
    input: run(flatValid({ "orders[0].item": "one" })),
    expect: all(accepted(false), { op: "codes", exactly: ["rows.min@orders"] }),
    variants: [
      { id: "empty-rows-count", input: run(flatValid({ orders: [{}, {}] })), expect: fine },
      { id: "one-empty-row", input: run(flatValid({ orders: [{}] })), expect: all(accepted(false), { op: "codes", exactly: ["rows.min@orders"] }) },
      { id: "too-many", input: run(flatValid({ orders: [{ item: "a" }, {}, {}, { item: "d" }] })), expect: all(accepted(false), { op: "codes", exactly: ["rows.max@orders"] }) },
      // A bound may be a formula over the form's answers. A whole number wins
      // over the fixed bound; anything else (here a fraction) leaves the fixed bound in force.
      {
        id: "formula-minimum",
        fixture: formulaBoundGrid,
        input: run(flatValid({ guests: 3, orders: [{}, {}] })),
        expect: all(accepted(false), { op: "codes", exactly: ["rows.min@orders"] })
      },
      { id: "formula-not-a-whole-number", fixture: formulaBoundGrid, input: run(flatValid({ guests: 2.5, orders: [{}, {}] })), expect: fine },
      // A grid with no maximum is held to the row cap (500), as adding a row is in the browser.
      {
        id: "no-maximum-held-to-the-row-cap",
        fixture: {
          definition: "base+patch",
          patch: addComponents({ id: "lines", type: "dataGrid", configuration: {}, collection: { collectionPath: "orders" }, children: { content: [{ id: "item", type: "text", configuration: {} }] } })
        },
        input: run(flatValid({ orders: Array.from({ length: 501 }, () => ({ item: "a" })) })),
        expect: all(accepted(false), { op: "codes", exactly: ["rows.max@orders"] })
      },
      {
        id: "no-maximum-500-rows-pass",
        fixture: {
          definition: "base+patch",
          patch: addComponents({ id: "lines", type: "dataGrid", configuration: {}, collection: { collectionPath: "orders" }, children: { content: [{ id: "item", type: "text", configuration: {} }] } })
        },
        input: run(flatValid({ orders: Array.from({ length: 500 }, () => ({ item: "a" })) })),
        expect: fine
      },
      // A hidden grid whose rows are still submitted (`hiddenValueBehavior: "retain"`; by default a
      // hidden grid's rows are left out) is held to the cap too: no person could add a row past it,
      // so only a forged post has one. Its own bounds are not checked.
      {
        id: "hidden-grid-held-to-the-row-cap",
        fixture: {
          definition: "base+patch",
          patch: addComponents({
            id: "lines",
            type: "dataGrid",
            configuration: { maxRows: 3, hiddenValueBehavior: "retain" },
            collection: { collectionPath: "orders" },
            rules: { visibleWhen: "false" },
            children: { content: [{ id: "item", type: "text", configuration: {} }] }
          })
        },
        input: run(flatValid({ orders: Array.from({ length: 501 }, () => ({ item: "a" })) })),
        expect: all(accepted(false), { op: "codes", exactly: ["rows.max@orders"] })
      },
      // Held to the cap alone: ten rows are past the grid's own maximum of three and still pass.
      {
        id: "hidden-grid-own-maximum-not-checked",
        fixture: {
          definition: "base+patch",
          patch: addComponents({
            id: "lines",
            type: "dataGrid",
            configuration: { maxRows: 3, hiddenValueBehavior: "retain" },
            collection: { collectionPath: "orders" },
            rules: { visibleWhen: "false" },
            children: { content: [{ id: "item", type: "text", configuration: {} }] }
          })
        },
        input: run(flatValid({ orders: Array.from({ length: 10 }, () => ({ item: "a" })) })),
        expect: fine
      }
    ],
    applies: programOnly
  })
];

function rowsWithPick(root: Record<string, unknown>): Record<string, unknown> {
  const content = (root["children"] as { content: Record<string, unknown>[] }).content;
  const rows = content.find((node) => node["id"] === "rows") as { children: { content: Record<string, unknown>[] } };
  rows.children.content.push(selectNode("pick", ["ok"]));
  return root;
}

