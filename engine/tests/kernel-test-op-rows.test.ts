import { describe, expect, it } from "vitest";

import { InProcessWasmHostAdapter } from "../form-engine/validation/wasm/in-process-host.js";
import { kernelDataGridRowsCap, kernelFormTestServerWrite } from "../form-engine/validation/wasm/portable-kernel.js";
import { JsonWasmAbi, WASM_ABI_VERSION, stableStringify } from "../form-engine/validation/wasm/wasm-validation-host.js";

/**
 * The test op's `set` on a row path adds rows up to the index, as the runtime does, but never
 * past the most a person could add: the grid's `maxRows`, else the cap every collection is drawn
 * to. Past it the step is refused with the `rows.max` an `add row` gets, where a thirty-byte
 * statement used to build two hundred thousand rows (and exhaust memory nearer a billion).
 */

const instance = new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi());
const ask = (request: Record<string, unknown>): any => JSON.parse(instance.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "test", ...request })) as string);

function definition(configuration: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "f",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "items", type: "dataGrid", collection: {}, configuration, children: { content: [{ id: "sku", type: "text", configuration: {} }] } }] }
    }
  };
}

function scenario(index: number): string {
  return `test "rows"\n  set items[${index}].sku = "x"\n  expect rows of items = ${index + 1}\n`;
}

describe("the test op: a set past the last row", () => {
  it("adds rows up to the index while they fit", () => {
    const answer = ask({ definition: definition({ maxRows: 3 }), tests: scenario(2) });
    expect(JSON.stringify(answer)).toContain('"status":"passed"');
  });

  it.each([
    [3, { maxRows: 3 }, 3],
    [200000, { maxRows: 3 }, 3],
    [2000000, {}, 500]
  ])("refuses set items[%i] with rows.max, quickly", (index, configuration, max) => {
    const started = Date.now();
    const answer = ask({ definition: definition(configuration), tests: scenario(index) });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(answer.report.scenarios[0].steps).toEqual([
      { code: "action.refused", line: 2, params: { action: "set", max, path: "items", reason: "rows.max" }, status: "error" }
    ]);
  });
});

describe("the test op: index spellings the row reader does not take", () => {
  it.each(["items[0000300000].sku", "items[300000]", "items.300000.sku"])("set %s is a plain answer, never two hundred thousand rows, and finishes quickly", (path) => {
    const started = Date.now();
    const answer = ask({ definition: definition({ maxRows: 3 }), tests: `test "rows"\n  set ${path} = "x"\n` });
    expect(Date.now() - started).toBeLessThan(500);
    expect(answer.report.scenarios[0].steps).toEqual([{ line: 2, status: "ran" }]);
  });
});

describe("kernelFormTestServerWrite: a row write past the last row", () => {
  const lists = { items: true } as Record<string, true>;
  const answers = (): { flat: Record<string, unknown>; rows: Record<string, Array<Record<string, unknown>>> } => ({ flat: {}, rows: {} });

  it("adds rows up to the index within the limit it is given, else the cap every collection is drawn to", () => {
    const held = answers();
    expect(kernelFormTestServerWrite(held, lists, "items[2].sku", "x", 3)).toBe(true);
    expect(held.rows.items).toHaveLength(3);
    expect(kernelFormTestServerWrite(held, lists, "items[3].sku", "x", 3)).toBe(false);
    expect(held.rows.items).toHaveLength(3);
    const capped = answers();
    expect(kernelFormTestServerWrite(capped, lists, `items[${kernelDataGridRowsCap() - 1}].sku`, "x")).toBe(true);
    expect(capped.rows.items).toHaveLength(kernelDataGridRowsCap());
  });

  it("writes nothing for an index at or past the cap, whoever calls it, and quickly", () => {
    for (const index of [kernelDataGridRowsCap(), 300000, 2000000000]) {
      const held = answers();
      const started = Date.now();
      expect(kernelFormTestServerWrite(held, lists, `items[${index}].sku`, "x"), String(index)).toBe(false);
      expect(Date.now() - started).toBeLessThan(200);
      expect(held.rows.items ?? []).toHaveLength(0);
    }
  });

  it("still writes a row that is already held, and a clear past the end is a no-op", () => {
    const held = answers();
    held.rows.items = [{}, {}, {}, {}];
    expect(kernelFormTestServerWrite(held, lists, "items[3].sku", "y", 2)).toBe(true);
    expect(held.rows.items[3]).toEqual({ sku: "y" });
    expect(kernelFormTestServerWrite(held, lists, "items[9].sku", undefined, 2)).toBe(true);
    expect(held.rows.items).toHaveLength(4);
  });
});
