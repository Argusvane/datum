import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  InProcessWasmHostAdapter,
  JsonWasmAbi,
  WASM_ABI_VERSION,
  WasmValidationHost,
  stableStringify,
  type ComponentNode,
  type WasmValidatorInstance
} from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter } from "../src/index.js";

/**
 * A data grid in the sandbox: the row count (`rows.min` / `rows.max`) and the `check`
 * and `inspect` ops, answered byte for byte alike by the real QuickJS program and the in-process
 * kernel.
 */

const formOf = (...children: unknown[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content: children } }) as unknown as ComponentNode;

/** A grid in the container shape, with row bounds, a required text and a select in each row. */
const container = formOf(
  { id: "kind", type: "text", configuration: {} },
  {
    id: "lines",
    type: "dataGrid",
    configuration: { label: "Lines", minRows: 2, maxRows: 3 },
    collection: { collectionPath: "items" },
    children: {
      content: [
        { id: "sku", type: "text", configuration: { required: true, maxLength: 4 } },
        { id: "size", type: "select", configuration: { options: [{ value: "s", label: "S" }, { value: "m", label: "M" }] } }
      ]
    },
    rules: { visibleWhen: 'kind = "order"' }
  }
);

const cases: Array<Record<string, unknown>> = [
  { kind: "order" },
  { kind: "order", items: [{}, {}] },
  { kind: "order", items: [{ sku: "A1" }] },
  { kind: "order", "items[0].sku": "A1" },
  { kind: "order", items: [{ sku: "A1", size: "s" }, { sku: "B2" }] },
  { kind: "order", items: [{ sku: "A1" }, { sku: "toolong" }, {}, { size: "xl" }] },
  { kind: "order", items: [{}, {}, {}, {}], "items[0].sku": "A1", "items[1].sku": "B2" },
  // Hidden by its rule: no row is counted and none is checked.
  { kind: "quote" },
  { kind: "quote", items: [{}, {}, {}, {}, {}] }
];

describe("a data grid in the sandbox: QuickJS and the in-process kernel agree", () => {
  const abi = new JsonWasmAbi();
  let inProcess: WasmValidatorInstance;
  let quickJs: WasmValidatorInstance;

  beforeAll(async () => {
    inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
  });

  afterAll(() => {
    quickJs.dispose?.();
  });

  const runBoth = async (form: ComponentNode, values: Record<string, unknown>): Promise<string> => {
    const payload = abi.serializeContext({ formId: "f", locale: "en", form, values }, WasmValidationHost.STRICT_POLICY);
    const fromSandbox = await quickJs.run(payload);
    expect(fromSandbox, JSON.stringify(values)).toBe(await inProcess.run(payload));
    return fromSandbox;
  };

  it("counts rows alike, an empty row posted as {} included, and refuses below the minimum and above the maximum", async () => {
    const seen = new Set<string>();
    for (const values of cases) {
      const outcome = abi.deserializeOutcome(await runBoth(container, values));
      for (const error of outcome.errors) {
        seen.add(error.code);
      }
    }
    expect(seen).toEqual(new Set(["rows.min", "rows.max", "required", "maxLength", "option.notAllowed"]));
    const two = abi.deserializeOutcome(await runBoth(container, { kind: "order", items: [{ sku: "A1" }] }));
    expect(two.errors.find((error) => error.code === "rows.min")).toEqual({
      code: "rows.min",
      componentId: "lines",
      path: "items",
      stage: "field-constraints",
      source: "wasm",
      parameters: { min: 2, count: 1 }
    });
    const hidden = abi.deserializeOutcome(await runBoth(container, { kind: "quote", items: [{}, {}, {}, {}, {}] }));
    expect(hidden.errors).toEqual([]);
  });

  it("answers check and inspect alike: the grid listed as a collection, an unusable bound warned about", async () => {
    for (const op of ["check", "inspect"]) {
      const request = stableStringify({ abi: WASM_ABI_VERSION, op, definition: { id: "f", version: "1", schemaVersion: "1", root: container } });
      const fromKernel = await inProcess.inspect!(request);
      expect(await quickJs.inspect!(request), op).toBe(fromKernel);
    }
    const paths = JSON.parse(await quickJs.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "inspect", definition: { id: "f", version: "1", schemaVersion: "1", root: container } }))) as {
      paths: Array<{ path: string; componentId: string; collection?: unknown }>;
    };
    expect(paths.paths.map((entry) => `${entry.path}:${entry.componentId}`)).toEqual(["kind:kind", "items:lines", "items.sku:sku", "items.size:size"]);
    const bounded = formOf({ id: "g", type: "dataGrid", configuration: { minRows: 4, maxRows: 2 }, collection: { collectionPath: "g" }, children: { content: [] } });
    const request = stableStringify({ abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: bounded } });
    const answer = await quickJs.inspect!(request);
    expect(answer).toBe(await inProcess.inspect!(request));
    expect((JSON.parse(answer) as { structureWarnings: Array<{ code: string }> }).structureWarnings.map((warning) => warning.code)).toEqual(["component.dataGrid.bounds"]);
  });

  /** Bounds as formulas: over another answer, a server-only one, one that reads a row. */
  const formulaBounds = formOf(
    { id: "people", type: "number", configuration: {} },
    {
      id: "guests",
      type: "dataGrid",
      configuration: { minRows: 1, maxRows: 6 },
      collection: { collectionPath: "guests" },
      rules: { minRows: "people", maxRows: { formula: "people + 1", run: "server" } },
      children: { content: [{ id: "name", type: "text", configuration: {} }] }
    },
    {
      id: "rooms",
      type: "dataGrid",
      configuration: { minRows: 1 },
      collection: { collectionPath: "rooms" },
      rules: { minRows: "if row.name = null then 5 else 5" },
      children: { content: [{ id: "room", type: "text", configuration: {} }] }
    },
    { id: "note", type: "text", configuration: {}, rules: { maxRows: "2" } }
  );

  it("evaluates a bound formula alike: a whole number wins, anything else leaves the fixed bound, a row read is never evaluated", async () => {
    const formulaCases: Array<Record<string, unknown>> = [
      { people: 3, guests: [{}, {}], rooms: [{}] },
      { people: 2, guests: [{}, {}, {}, {}], rooms: [] },
      { people: 2.5, guests: [], rooms: [{}] },
      { people: -1, guests: [{}, {}, {}, {}, {}, {}, {}], rooms: [{}] },
      { guests: [{}], rooms: [{}] },
      { people: 9000, guests: [{}], rooms: [{}] }
    ];
    const seen: unknown[] = [];
    for (const values of formulaCases) {
      const outcome = abi.deserializeOutcome(await runBoth(formulaBounds, values));
      seen.push(outcome.errors.map((error) => [error.code, error.componentId, error.parameters]));
    }
    expect(seen).toEqual([
      [["rows.min", "guests", { min: 3, count: 2 }]],
      [["rows.max", "guests", { max: 3, count: 4 }], ["rows.min", "rooms", { min: 1, count: 0 }]],
      [["rows.min", "guests", { min: 1, count: 0 }]],
      // The maximum's formula comes to 0, a whole number: it wins, and reads as the fixed minimum of 1.
      [["rows.max", "guests", { max: 1, count: 7 }]],
      [],
      [["rows.min", "guests", { min: 500, count: 1 }]]
    ]);
    const server = abi.deserializeOutcome(await runBoth(formulaBounds, { people: 1, guests: [{}], rooms: [{}] }));
    expect(server.serverRules).toEqual(["guests"]);
  });

  it("answers check and inspect alike over bound formulas: the row read and the bound off a grid warned about", async () => {
    for (const op of ["check", "inspect"]) {
      const request = stableStringify({ abi: WASM_ABI_VERSION, op, definition: { id: "f", version: "1", schemaVersion: "1", root: formulaBounds } });
      expect(await quickJs.inspect!(request), op).toBe(await inProcess.inspect!(request));
    }
    const check = JSON.parse(
      await quickJs.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: formulaBounds } }))
    ) as { warnings: Array<{ where: string; code: string }>; structureWarnings: Array<{ code: string }> };
    expect(check.warnings.map((warning) => `${warning.where} ${warning.code}`)).toEqual(["rules:rooms:minRows rule.unsupportedScope"]);
    expect(check.structureWarnings.map((warning) => warning.code)).toEqual(["component.dataGrid.boundsRule"]);
    const inspect = JSON.parse(
      await quickJs.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "inspect", definition: { id: "f", version: "1", schemaVersion: "1", root: formulaBounds } }))
    ) as { rules: Array<{ componentId: string; key: string; run: string }> };
    // The request is canonical JSON, so a node's rules arrive with their keys sorted.
    expect(inspect.rules.map((rule) => `${rule.componentId}:${rule.key}:${rule.run}`)).toEqual(["guests:maxRows:server", "guests:minRows:both", "rooms:minRows:both", "note:maxRows:both"]);
  });

  // Further kernel edge cases, each answered alike.
  it("counts a row whose every key is stripped, or that holds only empty objects, alike", async () => {
    const withAddress = formOf({
      id: "lines",
      type: "dataGrid",
      configuration: { minRows: 3 },
      collection: { collectionPath: "items" },
      children: {
        content: [
          { id: "sku", type: "text", configuration: { required: true } },
          { id: "address", type: "container", configuration: {}, children: { content: [{ id: "city", type: "text", configuration: {} }] } }
        ]
      }
    });
    const counted: unknown[] = [];
    for (const values of [{ items: [{ junk: 1 }, {}] }, { items: [{ address: {} }, { junk: 1 }, { sku: "A" }] }, { items: [{ address: { zone: 1 } }] }]) {
      const outcome = abi.deserializeOutcome(await runBoth(withAddress, values));
      counted.push(outcome.errors.map((error) => `${error.code}@${error.path ?? ""}${error.code === "rows.min" ? JSON.stringify(error.parameters) : ""}`));
    }
    expect(counted).toEqual([
      ['rows.min@items{"count":2,"min":3}', "required@items[0].sku", "required@items[1].sku"],
      ["required@items[0].sku", "required@items[1].sku"],
      ['rows.min@items{"count":1,"min":3}', "required@items[0].sku"]
    ]);
  });

  it("reads the odd shapes a host may post alike: __proto__ keys, children: null, a slot that is no list, a numeric id", async () => {
    const odd = JSON.parse(
      JSON.stringify({
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "a", type: "dataGrid", configuration: { minRows: 2 }, children: { content: [{ id: "x", type: "text", configuration: { required: true } }] } },
            { id: "b", type: "dataGrid", configuration: {}, children: null },
            { id: "c", type: "dataGrid", configuration: { minRows: 1 }, children: { content: "bad" } },
            { id: 7, type: "dataGrid", configuration: { minRows: 3 } }
          ]
        }
      }).replace('"minRows":2,', '"__proto__":{"minRows":4},"minRows":2,')
    ) as ComponentNode;
    for (const values of [{}, { a: [{}], b: [{ y: "1" }] }, { "a[0].x": "1", "a[1].x": "", c: [{}] }]) {
      await runBoth(odd, values);
    }
    const request = stableStringify({ abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: odd } });
    expect(await quickJs.inspect!(request)).toBe(await inProcess.inspect!(request));
  });

  it("never evaluates a bound reading rowIndex(), rowCount() or ancestor., alike, and warns about it alike", async () => {
    const rowReads = formOf({
      id: "g",
      type: "dataGrid",
      configuration: { minRows: 1 },
      collection: { collectionPath: "g" },
      rules: { minRows: { formula: "if rowIndex() = null then 4 else 4", run: "server" }, maxRows: "if ancestor.kind = null then 0 else 0" },
      children: { content: [{ id: "v", type: "text", configuration: {} }] }
    });
    const outcome = abi.deserializeOutcome(await runBoth(rowReads, { g: [{}, {}] }));
    expect(outcome.errors).toEqual([]);
    expect(outcome.serverRules ?? []).toEqual([]);
    const request = stableStringify({ abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: rowReads } });
    const answer = await quickJs.inspect!(request);
    expect(answer).toBe(await inProcess.inspect!(request));
    expect((JSON.parse(answer) as { warnings: Array<{ where: string; code: string }> }).warnings.map((warning) => `${warning.where} ${warning.code}`)).toEqual([
      "rules:g:minRows rule.unsupportedScope",
      "rules:g:maxRows rule.unsupportedScope"
    ]);
  });
});
