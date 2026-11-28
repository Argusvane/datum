import { describe, expect, it } from "vitest";

import { kernelBuiltInFunctionSignatures } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { kernelRunInspect, runKernel } from "../form-engine/validation/wasm/portable-kernel.js";

/**
 * A kernel run or inspect handed no signatures parses against the built-in functions, as every
 * host's own list starts from them; a function no built-in names is still unknown. The sandbox
 * program cannot read the function table, so the kernel carries the built-ins' names and
 * argument counts itself, and they must stay the table's.
 */

function form(rules: Record<string, unknown>): ComponentNode {
  return {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "a", type: "number", configuration: {} },
        { id: "b", type: "number", configuration: {}, rules }
      ]
    }
  };
}

const sumTree = { kind: "call", name: "sum", args: [{ kind: "path", path: "a" }, { kind: "literal", value: 2 }] };

describe("a kernel given no signatures", () => {
  it("carries the function table's built-ins, name for name and count for count", () => {
    expect(kernelBuiltInFunctionSignatures()).toEqual(formulaFunctionSignatures());
    // Fresh data each call: a host that adds its plugins to the list never changes the next one.
    expect(kernelBuiltInFunctionSignatures()).not.toBe(kernelBuiltInFunctionSignatures());
  });

  it("runs a tree and a formula calling a built-in, as a host's run does", () => {
    for (const value of [sumTree, "sum(a, 2)", { expression: sumTree }]) {
      const outcome = runKernel({ formId: "f", values: { a: 3 }, locale: "en", form: form({ value }) }, []);
      expect(outcome.errors, JSON.stringify(value)).toEqual([]);
      expect(outcome.values, JSON.stringify(value)).toEqual({ a: 3, b: 5 });
    }
  });

  it("still refuses a call to a function no built-in names, and checks a built-in's argument count", () => {
    const tree = runKernel({ formId: "f", values: { a: 3 }, locale: "en", form: form({ value: { kind: "call", name: "shout", args: [] } }) }, []);
    expect(tree.errors).toEqual([expect.objectContaining({ code: "formula.invalid", parameters: expect.objectContaining({ where: "rules:b:value" }) })]);
    const arity = runKernel({ formId: "f", values: { a: 3 }, locale: "en", form: form({ value: "abs(a, 2)" }) }, []);
    expect(arity.errors).toEqual([expect.objectContaining({ code: "formula.invalid" })]);
  });

  it("checks a definition calling a built-in as passing in inspect", () => {
    const definition = { id: "f", version: "1", root: form({ value: sumTree }) };
    const answer = kernelRunInspect({ op: "check", abi: "1.0.0", definition }) as { verdict?: string; problems?: unknown[] };
    expect(answer.problems ?? []).toEqual([]);
  });
});
