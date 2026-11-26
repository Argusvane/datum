import { describe, expect, it } from "vitest";

import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { SLOW_FACTOR } from "./slow-machine.js";
import { kernelStableStringify, kernelValidatorErrorsCopy, runKernel, type KernelValidator } from "../form-engine/validation/wasm/portable-kernel.js";

/**
 * A validator's answer is copied once, every level, by index and own key: what is judged is what
 * is kept and written. A list subclass whose `Symbol.species` hands back another object cannot
 * swap the entries after they were judged, and parameters that hold themselves, or nest past
 * the bound, make the answer unusable (the run fails closed) instead of overflowing the stack
 * while the outcome is written.
 */

const root = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "a", type: "text", configuration: {} }] } } as unknown as ComponentNode;
const run = (validator: KernelValidator) => runKernel({ formId: "f", values: { a: "x" }, locale: "en", form: root }, [validator], undefined, formulaFunctionSignatures());

describe("kernelValidatorErrorsCopy", () => {
  it("copies every level into fresh plain data, reading each member once", () => {
    let reads = 0;
    const entry = {
      get code() {
        reads += 1;
        return "x";
      },
      parameters: { list: [1, { b: [true, null] }], when: "now" }
    };
    const copied = kernelValidatorErrorsCopy([entry, "loose", 5]) as unknown[];
    expect(copied).toEqual([{ code: "x", parameters: { list: [1, { b: [true, null] }], when: "now" } }, "loose", 5]);
    expect(reads).toBe(1);
    expect((copied[0] as { parameters: unknown }).parameters).not.toBe(entry.parameters);
  });

  it("gives up on a list that holds itself, nests past 32 levels or is past 100,000 members", () => {
    const loop: Record<string, unknown> = { code: "x" };
    loop.parameters = loop;
    expect(kernelValidatorErrorsCopy([loop])).toBeUndefined();
    let deep: unknown = 1;
    for (let i = 0; i < 40; i += 1) {
      deep = { next: deep };
    }
    expect(kernelValidatorErrorsCopy([{ code: "x", parameters: deep }])).toBeUndefined();
    let shallow: unknown = 1;
    for (let i = 0; i < 20; i += 1) {
      shallow = { next: shallow };
    }
    expect(kernelValidatorErrorsCopy([{ code: "x", parameters: shallow }])).toEqual([{ code: "x", parameters: shallow }]);
    expect(kernelValidatorErrorsCopy([{ code: "x", parameters: { many: new Array(100001).fill(0) } }])).toBeUndefined();
  });
});

describe("kernelValidatorErrorsCopy past the member bound", () => {
  /** A list of `length` slots that counts every slot read. */
  function counted(length: number): { list: unknown[]; reads: () => number } {
    let reads = 0;
    const list = new Proxy(new Array(length), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads += 1;
        }
        return Reflect.get(target, key, receiver);
      }
    });
    return { list, reads: () => reads };
  }

  it("gives up on a list past the bound before reading or holding any of its members", () => {
    const top = counted(100001);
    expect(kernelValidatorErrorsCopy(top.list)).toBeUndefined();
    expect(top.reads()).toBe(0);
    const nested = counted(20_000_000);
    expect(kernelValidatorErrorsCopy([{ code: "x", parameters: { many: nested.list } }])).toBeUndefined();
    expect(nested.reads()).toBe(0);
  });

  it("refuses a 20,000,000-slot answer quickly, and the run fails closed", () => {
    const started = performance.now();
    expect(kernelValidatorErrorsCopy(new Array(20_000_000))).toBeUndefined();
    expect(kernelValidatorErrorsCopy([{ code: "x", parameters: { many: new Array(20_000_000) } }])).toBeUndefined();
    // Reading every slot took seconds; weighing the list first takes next to nothing.
    // Scaled by how slow this machine is right now; reading every slot is still far past it.
    expect(performance.now() - started).toBeLessThan(1000 * SLOW_FACTOR);
    expect(() => run(() => ({ errors: [{ code: "x", parameters: { many: new Array(20_000_000) } }] }) as never)).toThrow(/past 100,000 members/);
  });
});

describe("a run over a validator's answer", () => {
  it("a list subclass's species cannot swap the entries judged for others", () => {
    let reads = 0;
    const makeEntry = () => ({
      get code() {
        reads += 1;
        return reads <= 1 ? "plugin.ok" : 42;
      },
      severity: "warning"
    });
    class Evil {
      constructor() {
        return new Proxy([], {
          get(target, key) {
            if (key === "length") {
              return 1;
            }
            if (key === "0") {
              return makeEntry();
            }
            return Reflect.get(target, key);
          }
        });
      }
    }
    class Species extends Array {
      static override get [Symbol.species](): ArrayConstructor {
        return Evil as unknown as ArrayConstructor;
      }
    }
    const listed = new Species();
    listed.push({ code: "plugin.ok", severity: "warning" });
    const outcome = run(() => ({ errors: listed as never }));
    expect(outcome.errors).toEqual([{ code: "plugin.ok", severity: "warning" }]);
  });

  it("parameters that hold themselves fail the run closed, and nothing overflows", () => {
    const parameters: Record<string, unknown> = {};
    parameters.self = parameters;
    expect(() => run(() => ({ errors: [{ code: "x", parameters }] } as never))).toThrow(/validator 1 returned errors nested past 32 levels/);
  });

  it("parameters a few hundred levels deep fail the run closed too", () => {
    let parameters: unknown = { leaf: true };
    for (let i = 0; i < 500; i += 1) {
      parameters = { next: parameters };
    }
    expect(() => run(() => ({ errors: [{ code: "x", parameters }] } as never))).toThrow(/validator 1 returned errors/);
  });

  it("an honest answer is kept as it was and written as before", () => {
    const outcome = run(() => ({ errors: [{ code: "plugin.note", severity: "warning", componentId: "a", parameters: { limit: 3, words: ["a", "b"] } }] }) as never);
    expect(outcome.errors).toEqual([{ code: "plugin.note", severity: "warning", componentId: "a", parameters: { limit: 3, words: ["a", "b"] } }]);
    expect(kernelStableStringify(outcome.errors)).toBe('[{"code":"plugin.note","componentId":"a","parameters":{"limit":3,"words":["a","b"]},"severity":"warning"}]');
  });
});
