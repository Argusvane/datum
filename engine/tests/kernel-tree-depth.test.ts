import { describe, expect, it } from "vitest";

import { kernelCompileDefinition, kernelExpressionFault, kernelExpressionMaxDepth, kernelRuleExpression } from "../form-engine/core/expressions/compile.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { kernelRulesInventory } from "../form-engine/core/expressions/inspect.js";
import type { FormulaProblem } from "../form-engine/core/expressions/formula-types.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { runInspect } from "../form-engine/validation/wasm/portable-kernel.js";
import { JsonWasmAbi, WASM_ABI_VERSION } from "../form-engine/validation/wasm/wasm-validation-host.js";

/**
 * How deep a tree may nest is a question about what an author wrote as JSON: the QuickJS host
 * refuses a request nested past 320 levels before it parses it, so a tree written into a
 * definition is measured in JSON levels (every record and list, a chain's left side included)
 * against a cap that leaves room for the deepest component the form may hold. A tree the parser
 * built from a formula never travels as JSON (the formula's text does) and is never cut by that
 * cap, on either side.
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

/** A tree of exactly `levels` JSON levels: `not` over `not` (each one level) down to a path. */
function notsOfDepth(levels: number): unknown {
  return nested(levels - 1, (inner) => ({ kind: "unary", operator: "not", operand: inner }));
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

describe("a tree written as JSON is measured in JSON levels", () => {
  it("counts every record and list: a not, a chain's left side, a call's argument list, an if's cases, a literal's value", () => {
    const max = kernelExpressionMaxDepth();
    expect(kernelExpressionFault(notsOfDepth(max), signatures)).toBeUndefined();
    expect(kernelExpressionFault(notsOfDepth(max + 1), signatures)?.code).toBe("tooDeep");
    // A chain's left side is a level too: the request carries it nested.
    const chain = leftChain(max - 1);
    expect(jsonDepth(chain)).toBe(max);
    expect(kernelExpressionFault(chain, signatures)).toBeUndefined();
    expect(kernelExpressionFault(leftChain(max), signatures)?.code).toBe("tooDeep");
    expect(kernelExpressionFault(leftChain(20000), signatures)?.code).toBe("tooDeep");
    // A call spends two levels per argument (the list, the argument), an if three per case.
    const calls = nested(Math.floor((max - 1) / 2), (inner) => ({ kind: "call", name: "abs", args: [inner] }));
    expect(jsonDepth(calls)).toBeLessThanOrEqual(max);
    expect(kernelExpressionFault(calls, signatures)).toBeUndefined();
    const deeperCalls = nested(Math.floor((max - 1) / 2) + 1, (inner) => ({ kind: "call", name: "abs", args: [inner] }));
    expect(jsonDepth(deeperCalls)).toBeGreaterThan(max);
    expect(kernelExpressionFault(deeperCalls, signatures)?.code).toBe("tooDeep");
    const ifs = (count: number): unknown => nested(count, (inner) => ({ kind: "if", cases: [{ when: inner, then: leaf }] }));
    const fits = Math.floor((max - 1) / 3);
    expect(jsonDepth(ifs(fits))).toBeLessThanOrEqual(max);
    expect(kernelExpressionFault(ifs(fits), signatures)).toBeUndefined();
    expect(kernelExpressionFault(ifs(fits + 1), signatures)?.code).toBe("tooDeep");
    // A literal hands its value back as written; a value nested past the cap is as deep a request.
    const deepValue = nested(max, (inner) => ({ v: inner }), 1);
    expect(kernelExpressionFault({ kind: "literal", value: deepValue }, signatures)?.code).toBe("tooDeep");
    expect(kernelExpressionFault({ kind: "literal", value: nested(max - 2, (inner) => [inner], 1) }, signatures)).toBeUndefined();
  });

  it("leaves room for the deepest component a form may hold under the sandbox's 320 request levels", () => {
    // Run request: context (1) > form (2), three levels per component layer (node, children,
    // slot), the rules record and the object form's record, then the tree; 32 component levels.
    const deepestComponent = 2 + 3 * 31;
    expect(deepestComponent + 2 + kernelExpressionMaxDepth()).toBeLessThan(320);
  });

  it("a deep tree written as JSON fails check and the run refuses, in-process, as the sandbox refuses the request", () => {
    for (const tree of [leftChain(400), leftChain(3000), nested(150, (inner) => ({ kind: "call", name: "abs", args: [inner] }))]) {
      const root = form(tree);
      expect(check(root).problems.map((problem) => problem.code)).toEqual(["tooDeep"]);
      expect(run(root).errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    }
  });
});

describe("a tree the parser built is not cut by the JSON cap", () => {
  it("a formula of many precedence steps per parenthesis compiles, and kernelRuleExpression reads its tree", () => {
    const text = steppedFormula(60);
    const parsed = kernelParseFormula(text, signatures);
    expect(parsed.ok).toBe(true);
    const tree = parsed.ok ? parsed.expression : undefined;
    expect(jsonDepth(tree)).toBeGreaterThan(kernelExpressionMaxDepth());
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

describe("the inventory reads a tree calling many plugin names in one compile", () => {
  function definition(names: number, fields: number): FormDefinition {
    const content: unknown[] = [];
    for (let i = 0; i < fields; i += 1) {
      content.push({ id: "f" + i, type: "text", configuration: {}, rules: { visibleWhen: 'a = "x" and b' + i + ' = "y"' } });
    }
    const args = Array.from({ length: names }, (_, i) => ({ kind: "call", name: "plug" + i, args: [] }));
    content.push({ id: "z", type: "text", configuration: {}, rules: { visibleWhen: { kind: "call", name: "coalesce", args } } });
    return { id: "f", version: "1", schemaVersion: "1", root: { id: "form", type: "form", configuration: {}, children: { content } } } as unknown as FormDefinition;
  }

  it("lists every plugin a tree calls, past a thousand names, and the tree's rule with them", () => {
    const inventory = kernelRulesInventory(definition(1001, 50), kernelParseFormula, signatures, signatures.map((s) => s.name));
    expect(inventory.pluginsNeeded).toHaveLength(1001);
    expect(inventory.functionsUsed).toHaveLength(1002);
    const z = inventory.rules.filter((rule) => rule.componentId === "z");
    expect(z).toHaveLength(1);
    expect(z[0]?.functions).toHaveLength(1002);
  });

  it("costs one compile, not one per name", () => {
    const one = definition(1, 2000);
    const many = definition(400, 2000);
    kernelRulesInventory(one, kernelParseFormula, signatures);
    const t0 = performance.now();
    kernelRulesInventory(one, kernelParseFormula, signatures);
    const base = performance.now() - t0;
    const t1 = performance.now();
    kernelRulesInventory(many, kernelParseFormula, signatures);
    const wide = performance.now() - t1;
    // 400 names used to mean 400 compiles of the whole definition (over thirty times the one).
    expect(wide).toBeLessThan(base * 8 + 50);
  });
});
