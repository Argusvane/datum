/**
 * Every place a PDF evaluates an expression refuses a `matches` pattern of a catastrophic shape: the compile reports one written as a tree, and the evaluators
 * run under a cache that refuses it at the call, so a pattern the compile never saw cannot hang
 * the render. `riskyPatterns: "allow"` is the host's opt-out.
 */
import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import { kernelCompileDefinition } from "../form-engine/core/expressions/compile.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { PDF_DOCUMENT_COMPONENT_TYPE, PDF_TEXT_COMPONENT_TYPE } from "../form-engine/core/schema/pdf-layout.js";
import type { PdfFieldMapping, PdfGeneratedLayout, PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { evaluatePdfLayoutCondition, pdfLayoutConditionEvaluator, selectPdfLayoutForValues } from "../form-engine/render/pdf/pdf-layout-selection.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { resolveFieldMappings } from "../form-engine/render/pdf/pdf-template.js";

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };
const form: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "a", type: "text", configuration: { label: "A" } },
      { id: "tags", type: "select", configuration: { label: "Tags", multiple: true, options: [{ value: "x" }, { value: "y" }] } },
      { id: "kind", type: "radio", configuration: { label: "Kind", options: [{ value: "x" }, { value: "y" }] } }
    ]
  }
};
const held = (values: Record<string, unknown>): FormState => ({
  values,
  touched: new Set(),
  dirty: new Set(),
  validation: { valid: true },
  submission: { status: "idle", attempts: 0 },
  navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
  locale: "en-CA"
});

const RISKY = "^(a+)+$";
// A run of a's that ends in a character the pattern refuses: 2^27 steps for an engine that runs it.
const HOSTILE = "a".repeat(27) + "!";
const risky = (name: string, pattern: string): Expression => ({ kind: "call", name: name as never, args: [{ kind: "path", path: "a" }, { kind: "literal", value: pattern }] });
const generated = (id: string, children: ComponentNode[], when?: unknown): PdfGeneratedLayout => ({
  id,
  kind: "generated",
  ...(when !== undefined ? { when: when as Expression } : {}),
  root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: {}, children: { body: children, header: [], footer: [] } }
});
const timed = <T,>(run: () => T): { value: T; ms: number } => {
  const started = Date.now();
  const value = run();
  return { value, ms: Date.now() - started };
};

describe("the PDF evaluators refuse a risky pattern at the call", () => {
  it("a layout when: a tree-written condition never holds and costs nothing", () => {
    const { value, ms } = timed(() => evaluatePdfLayoutCondition(risky("matches", RISKY), { a: HOSTILE }));
    expect(value).toBeUndefined();
    expect(ms).toBeLessThan(500);
    expect(pdfLayoutConditionEvaluator("2026-01-01", undefined, "refuse")(risky("matches", RISKY), { a: HOSTILE })).toBeUndefined();
    const pdf = { layouts: [generated("risky", [], risky("matches", RISKY)), generated("plain", [])], defaultLayoutId: "plain" };
    const chosen = timed(() => selectPdfLayoutForValues({ root: form, pdf }, { a: HOSTILE }));
    expect(chosen.value.layout?.id).toBe("plain");
    expect(chosen.ms).toBeLessThan(500);
  });

  it("allow keeps the pattern running; an ordinary pattern runs under the default", () => {
    expect(pdfLayoutConditionEvaluator(undefined, undefined, "allow")(risky("matches", RISKY), { a: "aa" })).toBe(true);
    expect(evaluatePdfLayoutCondition(risky("matches", "^(a|b)+$"), { a: "abba" })).toBe(true);
  });

  it("a text block's expression tree and a template mapping's expression print nothing for a risky pattern", async () => {
    const block: ComponentNode = { id: "t", type: PDF_TEXT_COMPONENT_TYPE, configuration: { expression: { kind: "call", name: "concat", args: [risky("matches", RISKY), { kind: "literal", value: "!" }] } } };
    const started = Date.now();
    const model = await buildPdfRenderModel(form, held({ a: HOSTILE }), resolver, {}, { layout: generated("g", [block]), formulaErrors: "warn" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(model.warnings.some((warning) => warning.code === "formula.invalid" && /pattern/.test(warning.message))).toBe(true);
    const template: PdfTemplateLayout = {
      id: "tpl",
      kind: "template",
      template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
      fields: [{ pdfField: "F", source: { kind: "expression", expression: risky("matches", RISKY) as never } } as PdfFieldMapping]
    };
    const started2 = Date.now();
    const out = await buildPdfRenderModel(form, held({ a: HOSTILE }), resolver, {}, { layout: template, formulaErrors: "warn" });
    expect(Date.now() - started2).toBeLessThan(2000);
    expect(out.fill?.values.F).toBeNull();
  });
});

describe("a mapping resolved without the compile (a direct caller's string) is refused at the call", () => {
  it("prints blank for a risky string expression, quickly, and runs it under allow", () => {
    const layout: PdfTemplateLayout = {
      id: "tpl",
      kind: "template",
      template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
      fields: [{ pdfField: "F", source: { kind: "expression", expression: 'matches(a, "^(a+)+$")' } } as PdfFieldMapping]
    };
    const context = { modelsById: new Map(), values: { a: HOSTILE }, locale: "en", texts: { yes: "Yes", no: "No" } };
    const refused = timed(() => resolveFieldMappings(layout, context));
    expect(refused.value.values.F).toBe("");
    expect(refused.ms).toBeLessThan(500);
    const allowed = resolveFieldMappings(layout, { ...context, values: { a: "aaa" }, riskyPatterns: "allow" });
    expect(allowed.values.F).toBe("true");
  });
});

describe("the compile reports a risky literal in every PDF site, tree-written ones included", () => {
  const compile = (pdf: unknown, riskyPatterns?: unknown) => kernelCompileDefinition(form, undefined, pdf, kernelParseFormula, formulaFunctionSignatures(), riskyPatterns);
  const where = (pdf: unknown) => compile(pdf).problems.map((problem) => `${problem.where} ${problem.code}`);

  it("a template field and area source expression, as text and as a tree", () => {
    const text = 'matches(a, "(a+)+$")';
    const base = { id: "l", kind: "template", template: { storage: "x" } };
    expect(where({ layouts: [{ ...base, fields: [{ pdfField: "f", source: { kind: "expression", expression: text } }] }] })).toEqual(["pdf:l:field:0 pattern.risky"]);
    expect(where({ layouts: [{ ...base, fields: [{ pdfField: "f", source: { kind: "expression", expression: risky("matches", "(a+)+$") } }] }] })).toEqual(["pdf:l:field:0 pattern.risky"]);
    expect(where({ layouts: [{ ...base, fields: [], areas: [{ id: "ar", source: { kind: "expression", expression: { expression: risky("matches", "(a+)+$") } } }] }] })).toEqual(["pdf:l:area:0 pattern.risky"]);
    const dropped = compile({ layouts: [{ ...base, fields: [{ pdfField: "f", source: { kind: "expression", expression: risky("matches", "(a+)+$") } }] }] }).definition.pdf as { layouts: { fields: { source: Record<string, unknown> }[] }[] };
    expect(dropped.layouts[0]?.fields[0]?.source.expression).toBeUndefined();
  });

  it("a layout when as a tree, and the expression and rules of a block in the layout tree", () => {
    expect(where({ layouts: [{ id: "l", kind: "generated", when: risky("matches", "(a+)+$") }] })).toEqual(["pdf:l pattern.risky"]);
    const nested: ComponentNode = { id: "box", type: "pdf-box", configuration: {}, children: { content: [{ id: "t", type: PDF_TEXT_COMPONENT_TYPE, configuration: { expression: risky("matches", "(a+)+$") }, rules: { visibleWhen: 'matches(a, "(b*)*")', readonlyWhen: risky("matches", "(c+)+") } }] } };
    expect(where({ layouts: [generated("g", [nested])] })).toEqual(["pdf:g:node:t:expression pattern.risky", "pdf:g:node:t:rules:visibleWhen pattern.risky", "pdf:g:node:t:rules:readonlyWhen pattern.risky"]);
  });

  it("an ordinary pattern, and any pattern under allow, make no problem", () => {
    const pdf = { layouts: [{ id: "l", kind: "generated", when: risky("matches", "^(a|b)+$") }, generated("g", [{ id: "t", type: PDF_TEXT_COMPONENT_TYPE, configuration: { expression: risky("matches", "(a+)+$") } }])] };
    expect(compile(pdf, "allow").problems).toEqual([]);
    expect(where(pdf)).toEqual(["pdf:g:node:t:expression pattern.risky"]);
  });
});
