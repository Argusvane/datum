/**
 * Which PDF layout a download that names none prints, for a given set of answers:
 * `selectPdfLayout` (core) with the evaluator and the view the render model uses, so a host
 * that must know the layout before it renders — to resolve a template's bytes, to have a
 * signer ready, to name the file — gets the answer `buildPdfRenderModel` will reach.
 *
 * A layout's `when` reads the form's answers as they would be submitted, keyed by component id
 * — the whole submittable view, which is what a server holds (`recordValuesOf`), not the
 * partial view a journey's route reads mid-path. Form scope only — no `row.`, `ancestor.` or
 * `host.` — so the browser and every server agree. Which journey the person took is not an
 * answer and cannot be read; an answer or a calculated field the journey sets can.
 *
 * Two readings keep that agreement whatever the values went through on the way:
 * each answer is read as the envelope's JSON carries it (`kernelJsonAnswers`: a
 * calculation's `NaN` is `null`, an `undefined` entry is absent), and only the keys the schema
 * defines are read (`kernelPartitionValues(values, root).known`, the sandbox's allowlist) — a
 * key no component owns is stripped by a server's default `unknownFields`, so it chooses nothing
 * in the browser, the program or the server, whether that server strips or keeps it.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import { normalizeDataGrids } from "../../core/schema/data-grid.js";
import { selectPdfLayout, type PdfConditionEvaluate, type PdfLayoutSelection } from "../../core/schema/pdf-layout.js";
import { kernelJsonAnswers } from "../../core/state/submittable-fold.js";
import { buildComponentIdsByPath, valuesByComponentId } from "../../core/tree/data-scope.js";
import { evaluateExpression, type RuleEvaluationContext } from "../../rules/evaluator/evaluator.js";
import { kernelPartitionValues } from "../../validation/wasm/portable-kernel.js";
import { pdfRegexCache } from "./template-text.js";

/** The functions a plugin registered for formulas: name to a pure function of its arguments. */
export type PdfFormulaFunctions = NonNullable<RuleEvaluationContext["functions"]>;

/** A layout's condition over the answers by id: the evaluator in form scope, no host context, no clock. */
export const evaluatePdfLayoutCondition: PdfConditionEvaluate = (expression, values) =>
  evaluateExpression(expression, { values, regexCache: pdfRegexCache() });

/**
 * The evaluator a layout's `when` runs under, given the day `today()` reads and the plugin
 * functions it may call. Form scope, no host context. Without `today`, a condition that reads
 * the clock evaluates to no answer and never holds.
 */
export function pdfLayoutConditionEvaluator(today?: string, functions?: PdfFormulaFunctions, riskyPatterns?: "refuse" | "allow"): PdfConditionEvaluate {
  // One cache for the evaluator: a pattern of a catastrophic shape is refused at the call.
  const regexCache = pdfRegexCache(riskyPatterns);
  return (expression, values) =>
    evaluateExpression(expression, {
      values,
      regexCache,
      ...(today !== undefined ? { today } : {}),
      ...(functions ? { functions } : {})
    });
}

export interface SelectPdfLayoutForValuesOptions {
  /** An explicit choice: it wins over every condition, and an unknown id derives a layout. */
  layoutId?: string | undefined;
  /** The calendar day (`YYYY-MM-DD`) `today()` reads in a condition. Absent: a clock-reading condition never holds. */
  today?: string | undefined;
  /** Plugin functions a condition may call beside the built-ins. */
  functions?: PdfFormulaFunctions | undefined;
  /** `"allow"` lets a `matches` pattern of a catastrophic shape run; default `"refuse"`. */
  riskyPatterns?: "refuse" | "allow" | undefined;
}

/**
 * The layout a download prints for these answers: the one asked for by id, else the first whose
 * `when` holds, else the declared default, else the first, else none (one is derived).
 * `values` are the submittable answers keyed by value path, as a submission carries them (a
 * browser's `FormRuntime.submittableValues()`, a server's judged record values); only when some
 * layout has a condition to try, they are cut to the keys the schema defines, read as JSON
 * carries them and re-keyed by component id.
 */
export function selectPdfLayoutForValues(
  definition: { root: ComponentNode; pdf?: unknown },
  values: Record<string, unknown>,
  options: SelectPdfLayoutForValuesOptions = {}
): PdfLayoutSelection {
  // A data grid with no binding is bound at its id, as the kernel's run and the browser's
  // compile read it, so a condition reading a row (`orders[0].qty`) finds the answer on every
  // side.
  const root = normalizeDataGrids(definition.root);
  return selectPdfLayout(root === definition.root ? definition : { ...definition, root }, {
    layoutId: options.layoutId,
    values: () => valuesByComponentId(kernelJsonAnswers(kernelPartitionValues(values, root).known), buildComponentIdsByPath(root)),
    evaluate: pdfLayoutConditionEvaluator(options.today, options.functions, options.riskyPatterns),
    ...(options.functions ? { functions: Object.keys(options.functions) } : {})
  });
}
