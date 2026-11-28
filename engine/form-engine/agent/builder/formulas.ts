/**
 * Formulas for the builder tools: a rule's FEEL
 * text parsed with the host's signatures (plugins included, so an unknown function is an error),
 * worded from the builder's catalog; the names it reads checked against the form's fields
 * (`unknown-field`, a warning, never a refusal); and the editor's lint, only when the formula
 * editor's chunk is already on the page. No tool, read or write, ever fetches that chunk.
 *
 * The parse is the kernel's (`kernelParseFormula`), the same one the inspector, the runtime and
 * the sandbox run, so a formula the agent is told parses is one the person's form runs.
 */
import { isScopedExpressionPath } from "../../core/expressions/condition-shape.js";
import { kernelIsExpressionTree, kernelJsonTypeOf, kernelRiskGuardParser, kernelRiskyPatternMessage, kernelRuleShape } from "../../core/expressions/compile.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import type { FormulaFunctionSignature, FormulaParseResult, FormulaPathRef } from "../../core/expressions/formula-types.js";
import { formulaFieldsOf, isKnownFormulaPath, suggestFormulaField, type FormulaField } from "../../builder/formula/formula-fields.js";
import { ruleText } from "../../builder/property-editor/rule-source.js";
import { builderText, formulaErrorText } from "../../builder/logic/builder-texts.js";
import { ToolRefusal } from "../tool-types.js";
import type { BuilderCallScope } from "./context.js";
import type { FormulaProblem, RuleKey } from "./types.js";

/** Ends every `formula-error` hint. */
export const FEEL_PRIMER = "FEEL: `and`/`or`/`not()`, `=` for equality (not `==`), strings in double quotes, field ids as bare names.";

/** The whole `ComponentRules` key set, in that order. */
export const RULE_KEYS: readonly RuleKey[] = [
  "visibleWhen",
  "requiredWhen",
  "enabledWhen",
  "readonlyWhen",
  "validWhen",
  "value",
  "defaultValue",
  "minRows",
  "maxRows",
  "filter",
  "navigationGating"
];

/** The keys a yes-or-no formula holds: the lint warns when one would not answer true or false. */
const CONDITION_KEYS: readonly string[] = ["visibleWhen", "requiredWhen", "enabledWhen", "readonlyWhen", "validWhen", "navigationGating", "filter"];

/** Whether the rule `key` is a condition. */
export function isCondition(key: string): boolean {
  return CONDITION_KEYS.includes(key);
}

/** One rule as a tool hands it to the checker. */
export interface RuleRef {
  componentId?: string;
  /** The rule key (`visibleWhen`), without the `rules.` prefix. */
  key: string;
}

/** A rule's parse: the text and the names it reads, or the worded problem. */
export type RuleParse =
  | { ok: true; formula: string; blank: boolean; paths: FormulaPathRef[]; parsed: FormulaParseResult }
  | { ok: false; formula: string; problem: FormulaProblem };

/** What a batch adds to the form before it is written: its ids and value paths count as known names. */
export interface PendingNames {
  ids?: Iterable<string>;
  paths?: Iterable<string>;
}

export interface FormulaChecker {
  /** Parses one stored rule (bare text or `{ formula, run }`); blank text parses (the rule goes); any other value (an expression tree among them) is a problem. */
  parseRule(scope: BuilderCallScope, rule: RuleRef & { source: unknown }): RuleParse;
  /** `unknownField` warnings for the names a parsed rule reads. */
  unknownFields(scope: BuilderCallScope, rule: RuleRef & { formula: string; paths: readonly FormulaPathRef[] }, pending?: PendingNames): FormulaProblem[];
  /** The editor's lint, or `undefined` when its chunk is not on the page (check_form then lists `lint` as skipped). */
  lintRule(scope: BuilderCallScope, rule: RuleRef & { formula: string; parsed: FormulaParseResult }): FormulaProblem[] | undefined;
  /** The `formula-error` refusal over every failure a pass saw; `partial` adds set_properties' last sentence. */
  refusal(problems: readonly FormulaProblem[], options?: { partial?: boolean; extra?: string }): ToolRefusal;
}

/** The warning string a non-fatal formula problem becomes (code, colon, sentence). */
export function formulaWarning(problem: FormulaProblem): string {
  const where = `${problem.componentId !== undefined ? `${problem.componentId}.` : ""}${problem.propertyPath}`;
  if (problem.code === "unknownField") {
    const name = problem.formula.slice(problem.start, problem.end);
    return `unknown-field: ${where} reads ${name}, which is not a field.`;
  }
  return `lint: ${where} ${problem.message}`;
}

/** The spanless problem for a stored rule that is neither a formula nor the object form (an expression tree among them). */
function invalidShapeProblem(rule: RuleRef, source: unknown): FormulaProblem {
  const problem: FormulaProblem = {
    propertyPath: `rules.${rule.key}`,
    formula: "",
    code: "unexpected",
    message: `A ${rule.key} rule is a formula or an object with a formula; this one is ${kernelIsExpressionTree(source) || (typeof source === "object" && source !== null && kernelIsExpressionTree((source as { expression?: unknown }).expression)) ? "an expression tree" : kernelJsonTypeOf(source)}.`,
    start: 0,
    end: 0
  };
  if (rule.componentId !== undefined) {
    problem.componentId = rule.componentId;
  }
  return problem;
}

/** The fields a formula may read, once per call (the walk costs a pass over the tree). */
function fieldsOf(scope: BuilderCallScope): { fields: FormulaField[]; ids: Set<string> } {
  const cached = scope.cache.get("formula-fields") as { fields: FormulaField[]; ids: Set<string> } | undefined;
  if (cached !== undefined) {
    return cached;
  }
  const controller = scope.controller;
  const root = controller.snapshot();
  const fields = formulaFieldsOf(root, { dataPathOf: (id) => controller.dataPathOf(id), locale: controller.currentLocale(), translations: controller.translations(), translationCatalog: controller.translationCatalog() });
  const ids = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    ids.add(node.id);
    for (const group of Object.values(node.children ?? {})) {
      stack.push(...group);
    }
  }
  const entry = { fields, ids };
  scope.cache.set("formula-fields", entry);
  return entry;
}

/** Whether `path` or one of its leading parts (`address` of `address.city`, `items` of `items[0]`) is in `known`. */
function knownByPrefix(path: string, known: ReadonlySet<string>): boolean {
  if (known.has(path)) {
    return true;
  }
  for (let at = 0; at < path.length; at += 1) {
    const ch = path.charAt(at);
    if ((ch === "." || ch === "[") && known.has(path.slice(0, at))) {
      return true;
    }
  }
  return false;
}

/** The checker over the host's signatures (read per parse: a plugin registered later counts). */
export function createFormulaChecker(signatures: () => readonly FormulaFunctionSignature[]): FormulaChecker {
  return {
    parseRule(scope, rule) {
      const text = ruleText(rule.source);
      if (text === undefined) {
        const shape = kernelRuleShape(rule.source);
        if (shape !== "absent") {
          // The compile drops a rule that is neither a formula nor the object form (an expression
          // tree among them) as `invalidRule`; a form loaded with one is not clean.
          return { ok: false, formula: "", problem: invalidShapeProblem(rule, rule.source) };
        }
        return { ok: true, formula: "", blank: rule.source === undefined || rule.source === null, paths: [], parsed: { ok: true, expression: undefined, paths: [] } };
      }
      // The same parser the compile runs: a literal pattern of a catastrophic shape does not parse.
      const parsed = kernelRiskGuardParser(kernelParseFormula, undefined)(text, [...signatures()]);
      if (!parsed.ok) {
        const problem: FormulaProblem = {
          propertyPath: `rules.${rule.key}`,
          formula: text,
          code: parsed.code,
          // The builder's own table has no sentence for a risky pattern (the formula editor's chunk does); the kernel's wording stands in.
          message: parsed.code === "pattern.risky" ? kernelRiskyPatternMessage(String(parsed.params?.pattern ?? "")) : formulaErrorText(parsed.code, parsed.params, scope.words.options()),
          start: parsed.start,
          end: parsed.end
        };
        if (rule.componentId !== undefined) {
          problem.componentId = rule.componentId;
        }
        return { ok: false, formula: text, problem };
      }
      return { ok: true, formula: text, blank: text.trim() === "", paths: parsed.paths, parsed };
    },

    unknownFields(scope, rule, pending) {
      const { fields, ids } = fieldsOf(scope);
      const extra = new Set<string>([...(pending?.ids ?? []), ...(pending?.paths ?? [])]);
      const problems: FormulaProblem[] = [];
      const reported = new Set<string>();
      for (const ref of rule.paths) {
        const path = ref.path;
        if (path.startsWith("@") || isScopedExpressionPath(path) || isKnownFormulaPath(path, fields) || knownByPrefix(path, ids) || knownByPrefix(path, extra)) {
          continue;
        }
        const key = `${ref.start}:${ref.end}`;
        if (reported.has(key)) {
          continue;
        }
        reported.add(key);
        const nearest = suggestFormulaField(path, fields);
        let message = builderText("formula.unknownField", { name: path }, scope.words.options());
        const problem: FormulaProblem = { propertyPath: `rules.${rule.key}`, formula: rule.formula, code: "unknownField", message, start: ref.start, end: ref.end };
        if (nearest !== undefined) {
          message += " " + builderText("formula.unknownField.hint", { suggestion: nearest.path }, scope.words.options());
          problem.message = message;
          problem.suggestion = nearest.path;
        }
        if (rule.componentId !== undefined) {
          problem.componentId = rule.componentId;
        }
        problems.push(problem);
      }
      return problems;
    },

    lintRule(scope, rule) {
      const module = scope.ctx.host.formulaEditorLoaded?.();
      if (module === undefined) {
        return undefined;
      }
      if (rule.formula.trim() === "") {
        return [];
      }
      // riskyPatterns: no shell or controller code supplies it.
      const lints = module.lintFormula(rule.formula, module.scanFormula(rule.formula), rule.parsed, scope.words.options(), isCondition(rule.key), undefined);
      return lints.map((lint) => {
        const problem: FormulaProblem = { propertyPath: `rules.${rule.key}`, formula: rule.formula, code: "lint", message: lint.message, start: lint.start, end: lint.end };
        if (rule.componentId !== undefined) {
          problem.componentId = rule.componentId;
        }
        if (lint.suggestion !== undefined) {
          problem.suggestion = lint.suggestion;
        }
        return problem;
      });
    },

    refusal(problems, options = {}) {
      const count = problems.length;
      const first = problems[0];
      const message =
        count === 1 && first !== undefined
          ? `The formula for ${first.componentId !== undefined ? `${first.componentId}.` : ""}${first.propertyPath} did not parse; nothing was written.`
          : `${count} formulas did not parse; nothing was written.`;
      let hint = `Fix the formula at start..end; nothing was written. ${FEEL_PRIMER}`;
      if (options.partial === true) {
        hint += " Pass partial: true to write the edits that parse.";
      }
      if (options.extra !== undefined && options.extra !== "") {
        hint += ` ${options.extra}`;
      }
      return new ToolRefusal("formula-error", message, hint, { problems: problems.map((problem) => ({ ...problem })) });
    }
  };
}
