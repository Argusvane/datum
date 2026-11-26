import { describe, expect, it } from "vitest";

import { kernelSortKeys, kernelStableStringify } from "../form-engine/validation/wasm/portable-kernel.js";
import { createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { WasmValidationHost } from "../form-engine/validation/wasm/wasm-validation-host.js";

/**
 * The canonical writer survives a value nested far past the recursion it used to need: a request
 * holding an author's expression tree thousands of levels deep is written whole, byte for byte
 * the text `JSON.stringify(kernelSortKeys(...))` writes, so the host's limits refuse it typed
 * rather than a stack overflow in the host before them. A value that holds itself is refused as
 * `JSON.stringify` refuses one.
 */

function chain(depth: number): unknown {
  let node: unknown = { kind: "path", path: "a" };
  for (let i = 0; i < depth; i += 1) {
    node = { kind: "unary", operator: "not", operand: node, list: [i, { "10": "x", "2": null, b: undefined, a: [] }] };
  }
  return node;
}

describe("kernelStableStringify past the recursive writer's depth", () => {
  it("writes the same bytes as the sorted JSON at every depth around the hand-off", () => {
    for (const depth of [0, 1, 50, 199, 200, 201, 202, 300]) {
      const value = chain(depth);
      expect(kernelStableStringify(value), String(depth)).toBe(JSON.stringify(kernelSortKeys(value)));
    }
    const mixed = { z: [[[[[[]]]]], { "1": 1, "01": 2, "0": 3, a: undefined, b: () => 1 }], a: [undefined, null, "x", 1.5, true] };
    let deep: unknown = mixed;
    for (let i = 0; i < 400; i += 1) {
      deep = i % 2 === 0 ? [deep, i] : { next: deep, n: i };
    }
    expect(kernelStableStringify(deep)).toBe(JSON.stringify(kernelSortKeys(deep)));
  });

  it("writes a 20,000-deep tree without a stack overflow", () => {
    const text = kernelStableStringify(chain(20000));
    expect(text.startsWith('{"kind":"unary","list":[19999,')).toBe(true);
    expect(text.length).toBeGreaterThan(20000 * 40);
  });

  it("refuses a value that holds itself, as JSON.stringify does, at any depth", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    let deep: Record<string, unknown> = loop;
    for (let i = 0; i < 300; i += 1) {
      deep = { next: deep };
    }
    expect(() => kernelStableStringify(deep)).toThrow(TypeError);
  });

  it("a deep request reaches the run, which refuses it typed instead of overflowing in the host", async () => {
    let rule: unknown = { kind: "path", path: "a" };
    for (let i = 0; i < 20000; i += 1) {
      rule = { kind: "unary", operator: "not", operand: rule };
    }
    const form = {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "a", type: "text", configuration: {} }, { id: "b", type: "text", configuration: {}, rules: { visibleWhen: rule } }] }
    };
    const host = createInProcessWasmValidationHost([]);
    const outcome = await host.run({ context: { formId: "f", values: { a: "x" }, locale: "en", form } as never, policy: WasmValidationHost.STRICT_POLICY });
    expect(outcome.errors.map((error) => error.code)).toEqual(["formula.invalid"]);
  });
});
