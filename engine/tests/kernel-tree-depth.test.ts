import { describe, expect, it } from "vitest";

import { kernelCompileDefinition, kernelRuleExpression } from "../form-engine/core/expressions/compile.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { FormulaProblem } from "../form-engine/core/expressions/formula-types.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { runInspect } from "../form-engine/validation/wasm/portable-kernel.js";
import { JsonWasmAbi, WASM_ABI_VERSION } from "../form-engine/validation/wasm/wasm-validation-host.js";

/**
 * A deep tree: written into a definition as JSON it is no rule (`invalidRule`), however deep; a
 * tree the parser built from a formula never travels as JSON (the formula's text does) and runs
 * at any depth the parser allows, on either side.
 */

const signatures = formulaFunctionSignatures();
const leaf = { kind: "path", path: "a" };

function form(rule: unknown): ComponentNode {
  return {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "a", type: "text", configuration: {} },
        { id: "b", type: "text", configuration: { required: true }, rules: { visibleWhen: rule } }
      ]
    }
  } as unknown as ComponentNode;
}

/** The JSON levels a value nests (a record or a list is one, a scalar none). */
function jsonDepth(value: unknown): number {
  let deepest = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (node === null || typeof node !== "object") {
      continue;
    }
    deepest = Math.max(deepest, depth);
    for (const member of Object.values(node as Record<string, unknown>)) {
      stack.push([member, depth + 1]);
    }
  }
  return deepest;
}

function leftChain(terms: number): unknown {
  let node: unknown = leaf;
  for (let i = 0; i < terms; i += 1) {
    node = { kind: "logical", operator: "and", left: node, right: leaf };
  }
  return node;
}

function nested(levels: number, wrap: (inner: unknown) => unknown, start: unknown = leaf): unknown {
  let node = start;
  for (let i = 0; i < levels; i += 1) {
    node = wrap(node);
  }
  return node;
}

/** A formula the parser accepts whose tree has many levels per parenthesis (from the precedence steps). */
function steppedFormula(levels: number): string {
  let inner = "1";
  for (let i = 0; i < levels; i += 1) {
    inner = 'a = "q" or a = "q" and a = 1 + 2 * (' + inner + ")";
  }
  return 'a = "x" or ' + inner.replace(/^a = "q" or /, "");
}

function check(root: ComponentNode): { verdict: string; problems: FormulaProblem[] } {
  return runInspect({ abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root } }, signatures, [...signatures.map((s) => s.name)]) as never;
}

function run(root: ComponentNode, values: Record<string, unknown> = { a: "x" }): { errors: Array<{ code: string; path?: string }> } {
  const instance = new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi());
  return JSON.parse(instance.run(JSON.stringify({ formId: "f", locale: "en", form: root, values })) as string);
}

describe("a deep tree written as JSON", () => {
  it("fails check as invalidRule and the run refuses, in-process", () => {
    for (const tree of [leftChain(400), leftChain(3000), nested(150, (inner) => ({ kind: "call", name: "abs", args: [inner] }))]) {
      const root = form(tree);
      expect(check(root).problems.map((problem) => problem.code)).toEqual(["invalidRule"]);
      expect(run(root).errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    }
  });
});

describe("a deep tree the parser built", () => {
  it("a formula of many precedence steps per parenthesis compiles, and kernelRuleExpression reads its tree", () => {
    const text = steppedFormula(60);
    const parsed = kernelParseFormula(text, signatures);
    expect(parsed.ok).toBe(true);
    const tree = parsed.ok ? parsed.expression : undefined;
    expect(jsonDepth(tree)).toBeGreaterThan(200);
    expect(kernelRuleExpression(tree, kernelParseFormula, signatures)).toBe(tree);
    expect(kernelRuleExpression({ expression: tree, run: "server" }, kernelParseFormula, signatures)).toBe(tree);
    const compiled = kernelCompileDefinition(form(text), undefined, undefined, kernelParseFormula, signatures);
    expect(compiled.problems).toEqual([]);
    // A 20,000-term chain written as text: the parser's tree runs on both sides.
    const long = Array.from({ length: 20000 }, () => 'a = "x"').join(" and ");
    const longTree = kernelParseFormula(long, signatures);
    expect(longTree.ok).toBe(true);
    expect(kernelRuleExpression(longTree.ok ? longTree.expression : undefined, kernelParseFormula, signatures)).toBeDefined();
  });

  it("the browser requires what the server requires for a requiredWhen built from such a formula", async () => {
    const root = {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "a", type: "text", configuration: {} }, { id: "b", type: "text", configuration: {}, rules: { requiredWhen: steppedFormula(60) } }] }
    } as unknown as ComponentNode;
    expect(run(root).errors.map((error) => error.code + "@" + (error.path ?? ""))).toEqual(["required@b"]);
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime({ id: "f", version: "1", schemaVersion: "1", root } as never, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(root)]),
      journeyEngine: EagerJourneyEngine,
      wasmValidationHost: createInProcessWasmValidationHost([])
    } as never);
    runtime.setValue("a", "x");
    expect(runtime.isRequired("b")).toBe(true);
  });
});
