import { describe, expect, it } from "vitest";

import {
  kernelCompileDefinition,
  kernelCompileRules,
  kernelExpressionFault,
  kernelRuleExpression
} from "../form-engine/core/expressions/compile.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { FORMULA_FUNCTION_NAMES, formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { FormulaProblem } from "../form-engine/core/expressions/formula-types.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { runInspect } from "../form-engine/validation/wasm/portable-kernel.js";
import { JsonWasmAbi, WASM_ABI_VERSION, stableStringify } from "../form-engine/validation/wasm/wasm-validation-host.js";

/**
 * An expression tree is the compiled copy's shape, never an author's: a rule written as one,
 * well-formed or not, at any depth, is `invalidRule` at the rule's place, so `check` fails and a
 * run refuses typed, and a tree never passes through unread (a hidden required field stored, a
 * raw TypeError, a stack overflow). The tree readers a compiled copy goes through
 * (`kernelExpressionFault`, `kernelRuleExpression`) still judge its shape and the names it calls.
 */

const signatures = formulaFunctionSignatures();
const builtins = [...FORMULA_FUNCTION_NAMES];
const serverCall = { kind: "call", name: "serverCheck", args: [{ kind: "path", path: "a" }] };
const visibleTree = { kind: "binary", operator: "eq", left: serverCall, right: { kind: "literal", value: true } };
const visibleFormula = "serverCheck(a) = true";

function form(rule: unknown, configuration: Record<string, unknown> = {}): ComponentNode {
  return {
    id: "form",
    type: "form",
    configuration,
    children: {
      content: [
        { id: "a", type: "text", configuration: {} },
        { id: "b", type: "text", configuration: { required: true }, rules: { visibleWhen: rule } }
      ]
    }
  } as unknown as ComponentNode;
}

/** The run's request; a root given as text is a form already written, for a tree deeper than JSON.stringify's own stack reaches. */
function run(root: ComponentNode | string, values: Record<string, unknown> = { a: "x" }): { errors: Array<{ code: string; parameters?: Record<string, unknown> }>; values?: Record<string, unknown> } {
  const instance = new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi());
  const form = typeof root === "string" ? root : JSON.stringify(root);
  return JSON.parse(instance.run(`{"formId":"f","locale":"en","form":${form},"values":${JSON.stringify(values)}}`) as string);
}

/** {@link form} as text with `ruleText` (JSON already written) as b's visibleWhen. */
function formText(ruleText: string): string {
  return JSON.stringify(form("__rule__")).replace('"__rule__"', ruleText);
}

function check(root: ComponentNode): { verdict: string; problems: FormulaProblem[] } {
  return runInspect({ abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root } }, signatures, builtins) as never;
}

function chain(kind: "not" | "and", depth: number): unknown {
  let node: unknown = { kind: "path", path: "a" };
  for (let i = 0; i < depth; i += 1) {
    node = kind === "not" ? { kind: "unary", operator: "not", operand: node } : { kind: "logical", operator: "and", left: { kind: "path", path: "a" }, right: node };
  }
  return node;
}

/** {@link chain} written as JSON text by hand, so a depth past JSON.stringify's stack is still one request. */
function chainText(kind: "not" | "and", depth: number): string {
  const open = kind === "not" ? '{"kind":"unary","operator":"not","operand":' : '{"kind":"logical","operator":"and","left":{"kind":"path","path":"a"},"right":';
  return `${open.repeat(depth)}{"kind":"path","path":"a"}${"}".repeat(depth)}`;
}

const MALFORMED: Array<[string, unknown]> = [
  ["logical with no operands", { kind: "logical", operator: "and" }],
  ["unary with no operand", { kind: "unary", operator: "not" }],
  ["binary with a null left", { kind: "binary", operator: "eq", left: null, right: { kind: "literal", value: 1 } }],
  ["call with no args", { kind: "call", name: "sum" }],
  ["call with junk args", { kind: "call", name: "sum", args: [5, null] }],
  ["if with no cases", { kind: "if" }],
  ["if with a null case", { kind: "if", cases: [null] }],
  ["if with a null else", { kind: "if", cases: [], else: null }],
  ["unknown kind", { kind: "zzz" }],
  ["path with no text", { kind: "path", path: "" }],
  ["unary that is not a not", { kind: "unary", operator: "neg", operand: { kind: "literal", value: 1 } }]
];

describe("kernelExpressionFault: one shape walker, the builder's isExpression rules", () => {
  it.each(MALFORMED)("%s is invalidRule", (_name, tree) => {
    expect(kernelExpressionFault(tree, signatures)?.code).toBe("invalidRule");
  });

  it("every tree the parser builds passes, plugin names included when the side has them", () => {
    for (const text of ['if a > 1 then "x" else upper(b)', "not(a = 1) and b in [1..3]", "-a + 2 * (b - 1)", 'today() > @"2020-01-01"', "rowIndex() + rowCount()", "age(a) >= 18 or a != null"]) {
      const parsed = kernelParseFormula(text, signatures);
      expect(parsed.ok, text).toBe(true);
      expect(kernelExpressionFault(parsed.ok ? parsed.expression : undefined, signatures), text).toBeUndefined();
    }
    // A literal is handed back as written: a choice's default ticks a record or a list.
    expect(kernelExpressionFault({ kind: "literal", value: { a: true } }, signatures)).toBeUndefined();
    expect(kernelExpressionFault({ kind: "literal", value: ["a"] }, signatures)).toBeUndefined();
    expect(kernelExpressionFault(serverCall, signatures)).toEqual({ code: "unknownFunction", message: 'Unknown function "serverCheck".', params: { name: "serverCheck" } });
    expect(kernelExpressionFault(serverCall, [...signatures, { name: "serverCheck", min: 1, max: 1 }])).toBeUndefined();
    // Absent signatures: the shape only.
    expect(kernelExpressionFault(serverCall, undefined)).toBeUndefined();
  });

  it("reads a chain of any length, its left spine included, without recursion", () => {
    let flat: unknown = { kind: "path", path: "a" };
    for (let i = 0; i < 20000; i += 1) {
      flat = { kind: "logical", operator: "and", left: flat, right: { kind: "path", path: "a" } };
    }
    expect(kernelExpressionFault(flat, signatures)).toBeUndefined();
    expect(kernelExpressionFault(chain("and", 200000), signatures)).toBeUndefined();
  });

  it("a shape fault wins over an unknown name", () => {
    expect(kernelExpressionFault({ kind: "logical", operator: "and", left: serverCall, right: null }, signatures)?.code).toBe("invalidRule");
  });
});

describe("the compile: a rule written as a tree is invalidRule", () => {
  it("bare or in the object form, the site dropped, the author's object untouched; a validWhen never holds", () => {
    const problems: FormulaProblem[] = [];
    const rules = {
      visibleWhen: visibleTree,
      requiredWhen: { expression: visibleTree, run: "server" },
      enabledWhen: { kind: "literal", value: true },
      readonlyWhen: { kind: "logical", operator: "and" },
      validWhen: { kind: "unary", operator: "not" },
      value: "1 + 1"
    };
    const before = JSON.stringify(rules);
    const compiled = kernelCompileRules(rules, "rules:b", true, kernelParseFormula, signatures, problems);
    expect(compiled).toEqual({ validWhen: { expression: { kind: "literal", value: false } }, value: { kind: "arithmetic", operator: "add", left: { kind: "literal", value: 1 }, right: { kind: "literal", value: 1 } } });
    expect(problems.map((problem) => [problem.code, problem.where, problem.params])).toEqual(
      ["visibleWhen", "requiredWhen", "enabledWhen", "readonlyWhen", "validWhen"].map((key) => ["invalidRule", "rules:b:" + key, { key, got: "tree" }])
    );
    expect(problems[0]?.message).toBe("A visibleWhen rule is a formula or an object with a formula; this one is an expression tree");
    expect(JSON.stringify(rules)).toBe(before);
  });

  it("journey and PDF sites refuse it the same way and drop the site", () => {
    const journey = { journeys: [{ id: "j", pages: [{ id: "p", components: ["a"], routes: [{ to: "$end", when: { kind: "path", path: "a" } }] }] }] };
    const pdf = { layouts: [{ id: "l", when: serverCall }] };
    const compiled = kernelCompileDefinition(form(undefined), journey, pdf, kernelParseFormula, signatures);
    expect(compiled.problems.map((problem) => [problem.code, problem.where])).toEqual([
      ["invalidRule", "journey:j:page:p:route:0"],
      ["invalidRule", "pdf:l"]
    ]);
    const page = (compiled.definition.journey as { journeys: Array<{ pages: Array<Record<string, unknown>> }> }).journeys[0]!.pages[0]!;
    expect((page.routes as Array<Record<string, unknown>>)[0]).toEqual({ to: "$end" });
    expect((compiled.definition.pdf as { layouts: Array<Record<string, unknown>> }).layouts[0]).toEqual({ id: "l" });
  });

  it("a compiled copy compiled again keeps its trees, through the guards a formula's parse applies", () => {
    const problems: FormulaProblem[] = [];
    const compiled = kernelCompileRules({ visibleWhen: { kind: "path", path: "a" }, requiredWhen: visibleTree }, "rules:b", true, kernelParseFormula, signatures, problems, true);
    expect(compiled).toEqual({ visibleWhen: { kind: "path", path: "a" } });
    expect(problems).toEqual([{ where: "rules:b:requiredWhen", code: "unknownFunction", message: 'Unknown function "serverCheck".', params: { name: "serverCheck" }, start: 0, end: 0 }]);
  });

  it("kernelRuleExpression reads a compiled copy's tree at any depth, a malformed one as no rule, and leaves the names to the compile", () => {
    expect(kernelRuleExpression({ kind: "logical", operator: "and" }, kernelParseFormula, signatures)).toBeUndefined();
    // What it reads is often the compiled copy, whose trees the parser built at any depth.
    const deep = chain("not", 300);
    expect(kernelRuleExpression({ expression: deep, run: "server" }, kernelParseFormula, signatures)).toBe(deep);
    expect(kernelRuleExpression(serverCall, kernelParseFormula, signatures)).toBe(serverCall);
  });
});

describe("check and the run agree, in-process", () => {
  it("a function the server lacks: check fails and the run refuses, under fail and under warn, both shapes", () => {
    for (const rule of [visibleFormula, { formula: visibleFormula, run: "server" }]) {
      for (const policy of ["fail", "warn"]) {
        const root = form(rule, { formulaErrors: policy });
        expect(check(root).verdict).toBe("fail");
        const outcome = run(root);
        expect(outcome.errors.map((error) => [error.code, error.parameters?.where, error.parameters?.function])).toEqual([
          ["formula.invalid", "rules:b:visibleWhen", "serverCheck"]
        ]);
      }
    }
  });

  it("the same function on a browser-only rule keeps the policy: warn drops it, nothing refused", () => {
    const root = form({ formula: visibleFormula, run: "browser" }, { formulaErrors: "warn" });
    expect(check(root).verdict).toBe("warn");
    expect(run(root, { a: "x", b: "y" }).errors).toEqual([]);
  });

  it.each<[string, unknown]>([["a well-formed tree", visibleTree], ["the object form around a tree", { expression: { kind: "path", path: "a" }, run: "server" }], ...MALFORMED])(
    "%s fails check and the run refuses typed, never throws",
    (_name, tree) => {
      const root = form(tree);
      expect(check(root).problems.map((problem) => problem.code)).toEqual(["invalidRule"]);
      expect(run(root).errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    }
  );

  it("a deep tree: check fails and the run refuses typed instead of overflowing the evaluator", () => {
    for (const depth of [300, 20000]) {
      const root = form(chain("and", depth));
      expect(check(root).problems.map((problem) => problem.code)).toEqual(["invalidRule"]);
      // The form goes over as text: JSON.stringify of a tree this deep overruns a small stack (a Linux worker's) before the kernel reads a node.
      expect(run(formText(chainText("and", depth))).errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    }
  });

  it("a tree under warn: dropped on both sides, the browser runtime builds", () => {
    const definition = { id: "f", version: "1", schemaVersion: "1", root: form({ kind: "logical", operator: "and" }, { formulaErrors: "warn" }) };
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition as never, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
      journeyEngine: EagerJourneyEngine,
      wasmValidationHost: createInProcessWasmValidationHost([])
    } as never);
    expect(runtime.formulaProblems().map((problem) => problem.code)).toEqual(["invalidRule"]);
  });
});
