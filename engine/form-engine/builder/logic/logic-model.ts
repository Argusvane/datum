/**
 * The Logic workspace's model: a walk over every rule
 * the form holds, and the rules its journeys and PDF layouts hold, into the list the workspace
 * draws: each rule as a sentence of tokens, grouped by the step its target is on, counted per
 * filter, with the problems that only show across rules (two fields hiding each other, a rule
 * reading a field that is not there or not yet answered, a rule the server can never run).
 *
 * A stored rule is text (a FEEL-subset formula, bare or in the object form with its run scope).
 * The walk reads every rule through
 * `ruleExpression` and words it the same way: the shapes the catalog has sentences for
 * (`is`, `is not`, `is any of`, ticked, chains of `and` / `or`) read as sentences, anything
 * else reads as the formula printed with field labels as tokens (`formula/feel-print.ts`), an
 * `if` as its cases ("250 when …; otherwise 120"), a secret rule as "a formula the server keeps".
 *
 * Rules read the form's answers by component id, whatever data key or container stores them
 * (`core/tree/data-scope.ts`), so a path is resolved to its component by id first.
 * A path written as a value path (`billing.street`) or reaching into a component's value
 * (`address.city`, `items[0].sku`) is resolved too, so the list can still name the field.
 *
 * Pure and dependency-light: it runs in node for the tests, and in the Logic workspace's lazy
 * chunk in the browser. The types are `logic-types.ts`, the words `builder-texts.ts`.
 */
import type { Expression, IfExpression, RunScope } from "../../core/expressions/expression.js";
import { isEvaluableExpression, isScopedExpressionPath } from "../../core/expressions/condition-shape.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import { readInlineOptions } from "../../core/schema/inline-options.js";
import {
  JOURNEY_END,
  journeyPageFormIds,
  readJourneys,
  type Journey,
  type JourneyPage
} from "../../core/schema/journey.js";
import { readPdfConfiguration } from "../../core/schema/pdf-layout.js";
import { STEP_COMPONENT_TYPE, STEPS_COMPONENT_TYPE, stepNodesOf } from "../../core/schema/steps.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import { addressOf, resolveText, type FormTranslations, type TextSources } from "../../core/localization/translations.js";
import type { HiddenValueBehavior } from "../../core/state/effective-state.js";
import { buildComponentIdsByPath, buildDataPaths, holdsData } from "../../core/tree/data-scope.js";
import { kernelExprReadsClock, kernelExprReadsHost } from "../../rules/evaluator/evaluator.js";
import { printFormula, printFormulaTokens } from "../formula/feel-print.js";
import { ruleExpression, ruleRun, ruleText } from "../property-editor/rule-source.js";
import { DATA_GRID_ROW_BOUND_DESCRIPTORS, RULE_DESCRIPTORS } from "../property-editor/rules-model.js";
import {
  formatList,
  formulaErrorText,
  type BuilderTextCatalog,
  type BuilderTextKey,
  type BuilderTextOptions
} from "./builder-texts.js";
import { builderTemplateParts, builderText, formatListText } from "./logic-texts-en.js";
import type { LogicDiagnostic, LogicFilterId, LogicGroup, LogicJourneySummary, LogicModel, LogicRule, LogicRuleKind, LogicToken } from "./logic-types.js";

export interface LogicModelOptions {
  /** Supplies the journeys and PDF layouts, listed read-only. Absent: the form's rules alone. */
  definition?: FormDefinition | undefined;
  /** BCP 47, for labels and words. Absent: English. */
  locale?: string | undefined;
  catalog?: BuilderTextCatalog | undefined;
  /**
   * The form's translations, to name fields and options in `locale`. Absent: the
   * definition's own, else the default-language strings.
   */
  translations?: FormTranslations | undefined;
  /** The host's translation catalog, over the form's translations. */
  translationCatalog?: TranslationCatalog | undefined;
  /**
   * A component's name in the sentences. Absent, or `undefined` for a component: its
   * configuration's label (else title), resolved for the locale, else its id.
   */
  labelOf?: ((componentId: string) => string | undefined) | undefined;
  /**
   * The formulas the last rename could not follow (`controller.renameNotes()`): each is drawn
   * as a finding beside the rule it names, while that rule still holds the text as written.
   */
  renameNotes?: ReadonlyArray<{ componentId: string; rule: string; from: string; to: string; formula: string }> | undefined;
  /**
   * The kind an author gave a rule in this session, by rule id, with the text it was stored as.
   * Show over `not(…)` and Hide over a bare condition store the same JSON, so the stored rule
   * cannot say which was meant; while the stored text is still the one that was written, the
   * authored kind wins over the heuristic. Nothing is written to the definition.
   */
  authoredKinds?: ReadonlyMap<string, { kind: LogicRuleKind; stored: string }> | undefined;
  /**
   * The journeys to list, when they are not the definition's: the Journeys mode's own, always
   * current, where the definition a host hands over may lag a change by a tick. Absent: the
   * definition's.
   */
  journeys?: readonly Journey[] | undefined;
  /** Whether a journey's routes are editable here (the builder has a Journeys mode that writes them). Default: read-only. */
  journeysEditable?: boolean | undefined;
}

// --- the tree, indexed once per walk ------------------------------------------------------

interface TreeIndex {
  root: ComponentNode;
  nodeById: Map<string, ComponentNode>;
  parentOf: Map<string, string>;
  /** Every node, the root first, in document order. */
  order: ComponentNode[];
  /** Value path -> owning component ids. */
  idsByPath: Map<string, string[]>;
  /** Data path, a list's entries marked `[]` (`order.items[].sku`) -> the component storing there. */
  idByDataPath: Map<string, string>;
  /** Component id -> the step it is on (a step is on itself), for components inside a `steps` container. */
  stepOf: Map<string, string>;
  /** Step id -> its `steps` container and position there. */
  stepPosition: Map<string, { containerId: string; index: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStepOfSteps(node: ComponentNode, parent: ComponentNode | undefined): boolean {
  return node.type === STEP_COMPONENT_TYPE && parent?.type === STEPS_COMPONENT_TYPE;
}

function indexTree(root: ComponentNode): TreeIndex {
  const nodeById = new Map<string, ComponentNode>();
  const parentOf = new Map<string, string>();
  const order: ComponentNode[] = [];
  const stepOf = new Map<string, string>();
  const stepPosition = new Map<string, { containerId: string; index: number }>();
  // An explicit stack rather than recursion: a deep hand-written tree cannot exhaust the call stack.
  const stack: Array<{ node: ComponentNode; parent: ComponentNode | undefined; step: string | undefined }> = [
    { node: root, parent: undefined, step: undefined }
  ];
  while (stack.length > 0) {
    const { node, parent, step } = stack.pop() as { node: ComponentNode; parent: ComponentNode | undefined; step: string | undefined };
    if (nodeById.has(node.id)) {
      continue;
    }
    nodeById.set(node.id, node);
    order.push(node);
    if (parent !== undefined) {
      parentOf.set(node.id, parent.id);
    }
    const ownStep = isStepOfSteps(node, parent) ? node.id : step;
    if (ownStep !== undefined) {
      stepOf.set(node.id, ownStep);
    }
    if (node.type === STEPS_COMPONENT_TYPE) {
      stepNodesOf(node).forEach((child, index) => {
        if (!stepPosition.has(child.id)) {
          stepPosition.set(child.id, { containerId: node.id, index });
        }
      });
    }
    const children = Object.values(node.children ?? {}).flat();
    for (let at = children.length - 1; at >= 0; at -= 1) {
      stack.push({ node: children[at] as ComponentNode, parent: node, step: ownStep });
    }
  }
  const idByDataPath = new Map<string, string>();
  for (const [id, dataPath] of buildDataPaths(root)) {
    const node = nodeById.get(id);
    // Only what stores an answer: a fieldset inside a container has a path too, but holds nothing.
    if (node !== undefined && id !== root.id && holdsData(node) && !idByDataPath.has(dataPath)) {
      idByDataPath.set(dataPath, id);
    }
  }
  return { root, nodeById, parentOf, order, idsByPath: buildComponentIdsByPath(root), idByDataPath, stepOf, stepPosition };
}

/** The component a path names on its own: by id, by value path, else by data path with any entry index as `[]`. */
function componentNamed(index: TreeIndex, path: string): { id: string; exact: boolean } | undefined {
  if (path !== index.root.id && index.nodeById.has(path)) {
    return { id: path, exact: true };
  }
  const owner = index.idsByPath.get(path)?.[0];
  if (owner !== undefined) {
    return { id: owner, exact: true };
  }
  const entries = path.replace(/\[\d+\]/g, "[]");
  const stored = index.idByDataPath.get(entries);
  // A path naming one entry's field (`items[0].sku`) names the field, but not all of it.
  return stored !== undefined ? { id: stored, exact: entries === path } : undefined;
}

/**
 * The component a form-scoped path names, and whether it names it exactly: the component id
 * itself (how rules address answers), else the value path or data path a component stores at
 * (an entry's field, `order.items[0].sku`, names the field but not exactly), else the longest
 * leading part that names one — a path into a component's own value (`address.city`). `undefined` for a
 * path that names nothing in the form.
 */
function componentOfPath(index: TreeIndex, path: string): { id: string; exact: boolean } | undefined {
  const named = componentNamed(index, path);
  if (named) {
    return named;
  }
  for (let at = path.length - 1; at > 0; at -= 1) {
    const char = path[at];
    if (char !== "." && char !== "[") {
      continue;
    }
    const prefix = componentNamed(index, path.slice(0, at));
    if (prefix) {
      return { id: prefix.id, exact: false };
    }
  }
  return undefined;
}

// --- words ---------------------------------------------------------------------------------

interface WordContext {
  index: TreeIndex;
  locale: string;
  text: BuilderTextOptions;
  /** What a field's or an option's text is worded through for `locale`. */
  sources: TextSources;
  /** Always a name: the caller's, else the configuration's, else the id. */
  labelOf: (componentId: string) => string;
  authoredKinds: ReadonlyMap<string, { kind: LogicRuleKind; stored: string }> | undefined;
}

/** A definition text as the Logic workspace names things by: the string in the form's default language. */
function localized(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function configurationLabel(node: ComponentNode | undefined, locale: string, sources: TextSources, isRoot: boolean): string | undefined {
  if (!node || !isRecord(node.configuration)) {
    return undefined;
  }
  const configuration = node.configuration;
  // The label (else the title) worded for `locale` through the translations at the component's id; the form root's are the form's own.
  const read = (property: "label" | "title"): string | undefined => {
    const value = localized(configuration[property]);
    if (value === undefined || value.trim() === "") {
      return undefined;
    }
    return resolveText(value, isRoot ? addressOf.form(property) : addressOf.component(node.id, property), locale, sources);
  };
  return read("label") ?? read("title");
}

function createWordContext(
  root: ComponentNode,
  options: {
    locale?: string | undefined;
    catalog?: BuilderTextCatalog | undefined;
    labelOf?: ((id: string) => string | undefined) | undefined;
    authoredKinds?: ReadonlyMap<string, { kind: LogicRuleKind; stored: string }> | undefined;
    translations?: FormTranslations | undefined;
    translationCatalog?: TranslationCatalog | undefined;
    definition?: FormDefinition | undefined;
  }
): WordContext {
  const index = indexTree(root);
  const locale = options.locale ?? "en";
  const sources: TextSources = { translations: options.translations ?? options.definition?.translations, catalog: options.translationCatalog };
  const text: BuilderTextOptions = { locale, catalog: options.catalog };
  const labelOf = (componentId: string): string => {
    const given = options.labelOf?.(componentId);
    if (given !== undefined && given !== "") {
      return given;
    }
    const node = index.nodeById.get(componentId);
    const own = configurationLabel(node, locale, sources, componentId === root.id);
    if (own !== undefined) {
      return own;
    }
    // The form itself reads as "This form" rather than as its id.
    return componentId === root.id ? builderText("logic.group.form", undefined, text) : componentId;
  };
  return { index, locale, text, sources, labelOf, authoredKinds: options.authoredKinds };
}

/** A path as a field token: its component's name and id, or the path as written. */
function fieldToken(path: string, context: WordContext): LogicToken {
  if (isScopedExpressionPath(path)) {
    return { kind: "field", text: path };
  }
  const resolved = componentOfPath(context.index, path);
  if (!resolved) {
    return { kind: "field", text: path, unknown: true };
  }
  return { kind: "field", text: resolved.exact ? context.labelOf(resolved.id) : path, componentId: resolved.id };
}

/** A path's name inside expression text: the component's name when the path names it exactly. */
function expressionPathLabel(context: WordContext): (path: string) => string | undefined {
  return (path) => {
    if (isScopedExpressionPath(path)) {
      return undefined;
    }
    const resolved = componentOfPath(context.index, path);
    return resolved?.exact ? context.labelOf(resolved.id) : undefined;
  };
}

/** A value as the person filling the form would read it: the option's label when one stores it. */
function valueText(raw: string, path: string, context: WordContext): string {
  const resolved = isScopedExpressionPath(path) ? undefined : componentOfPath(context.index, path);
  if (resolved?.exact) {
    const node = context.index.nodeById.get(resolved.id);
    const option = readInlineOptions(node?.configuration).find((entry) => entry.value === raw);
    if (option) {
      return resolveText(option.label, addressOf.option(resolved.id, option.value, "label"), context.locale, context.sources);
    }
  }
  // The editor writes a null literal as "null" (formatConditionValue): it reads as "empty".
  return raw === "null" ? builderText("cond.value.empty", undefined, context.text) : raw;
}

// --- expression text -------------------------------------------------------------------------

/**
 * An expression as formula text (`employees > 10 and province = "QC"`, `price * 1.13`,
 * `sum(a, b)`): the printer's spelling, so what the list shows is what the editor opens. Paths
 * read as `labelOf(path)` when it names them, else as written; strings are quoted so they
 * cannot be mistaken for a field. Kept for the Data workspace's rows.
 */
export function expressionText(expression: Expression, labelOf?: (path: string) => string | undefined): string {
  if (!isRecord(expression)) {
    return "?";
  }
  return printFormula(expression, labelOf ? { labelOf } : {});
}

/** The option label a value stands for, when `path` names a choice field storing it. */
function optionLabel(path: string, value: string, context: WordContext): string | undefined {
  const resolved = isScopedExpressionPath(path) ? undefined : componentOfPath(context.index, path);
  if (!resolved?.exact) {
    return undefined;
  }
  const node = context.index.nodeById.get(resolved.id);
  const option = readInlineOptions(node?.configuration).find((entry) => entry.value === value);
  return option ? resolveText(option.label, addressOf.option(resolved.id, option.value, "label"), context.locale, context.sources) : undefined;
}

/** Every function name called anywhere in `expression`. An explicit stack: a left-folded chain of thousands of terms is as deep as it is long. */
function callNamesIn(expression: unknown, out: Set<string> = new Set()): Set<string> {
  const stack: unknown[] = [expression];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (Array.isArray(entry)) {
      stack.push(...entry);
      continue;
    }
    const node = entry as Record<string, unknown>;
    if (node.kind === "call" && typeof node.name === "string") {
      out.add(node.name);
    }
    stack.push(...Object.values(node));
  }
  return out;
}

/**
 * Whether a tree can be read out as a sentence or a formula: the evaluator's shape check, with
 * every function it calls counted as known. A call to a plugin function prints as its formula
 * like a call to a built-in (the sentences do not know which functions the host wired; the
 * problems under the box say when a name is unknown). A tree with a misspelt operator or a
 * missing operand still reads as "a custom condition".
 */
function isPrintableExpression(expression: unknown): expression is Expression {
  return isEvaluableExpression(expression, callNamesIn(expression));
}

/**
 * An expression as the printed formula, as tokens: fields as `field` tokens with their
 * component (the label shown, as the sentences name them), literals as `value` tokens (an
 * option's label when the field beside them stores it), everything else (keywords, operators,
 * function names, parentheses) run together as `word` tokens.
 */
function formulaTokens(expression: Expression, context: WordContext): LogicToken[] {
  const out: LogicToken[] = [];
  for (const token of printFormulaTokens(expression, {
    labelOf: expressionPathLabel(context),
    optionLabelOf: (path, value) => optionLabel(path, value, context)
  })) {
    if (token.kind === "field") {
      const path = token.path ?? token.text;
      if (isScopedExpressionPath(path)) {
        out.push({ kind: "field", text: token.text });
        continue;
      }
      const resolved = componentOfPath(context.index, path);
      out.push(resolved ? { kind: "field", text: token.text, componentId: resolved.id } : { kind: "field", text: token.text, unknown: true });
      continue;
    }
    if (token.kind === "value") {
      out.push({ kind: "value", text: token.value ?? token.text });
      continue;
    }
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === "word") {
      last.text += token.text;
    } else {
      out.push({ kind: "word", text: token.text });
    }
  }
  return out;
}

// --- the shapes the catalog has sentences for ----------------------------------------------

/** A sentence's comparison, or the inverse of an `anyOf` ("is not A or B"). */
type ClauseComparator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "isTrue" | "isFalse" | "anyOf" | "noneOf";

interface Clause {
  path: string;
  comparator: ClauseComparator;
  /** As the literal spells them: a number as digits, `null` as "null". */
  values: string[];
}

const COMPARISON_OPERATORS: ReadonlySet<string> = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);

function literalText(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}

/** One comparison of a path with a literal, a bare path, or a negated path, as a clause. */
function leafClause(expression: Expression): Clause | undefined {
  if (expression.kind === "path") {
    return { path: expression.path, comparator: "isTrue", values: [] };
  }
  if (expression.kind === "unary" && expression.operand.kind === "path") {
    return { path: expression.operand.path, comparator: "isFalse", values: [] };
  }
  if (
    expression.kind === "binary" &&
    COMPARISON_OPERATORS.has(expression.operator) &&
    expression.left.kind === "path" &&
    expression.right.kind === "literal"
  ) {
    return { path: expression.left.path, comparator: expression.operator as ClauseComparator, values: [literalText(expression.right.value)] };
  }
  return undefined;
}

/** The most `and`/`or` joins a condition may have to be worded as clauses; a longer chain reads as its printed formula. */
const CLAUSE_JOINS_MAX = 200;

/** Whether `expression` holds more than {@link CLAUSE_JOINS_MAX} `and`/`or` joins. An explicit stack, so a chain of any length is counted without recursion. */
function joinedPastLimit(expression: Expression): boolean {
  let joins = 0;
  const stack: Expression[] = [expression];
  while (stack.length > 0) {
    const node = stack.pop() as Expression;
    if (node.kind === "logical") {
      joins += 1;
      if (joins > CLAUSE_JOINS_MAX) {
        return true;
      }
      stack.push(node.left, node.right);
    }
  }
  return false;
}

/** An `or` of `eq` on one path ("is A or B") as one `anyOf` clause; `undefined` for anything else. */
function anyOfClause(expression: Expression): Clause | undefined {
  if (expression.kind !== "logical" || expression.operator !== "or") {
    return undefined;
  }
  const values: string[] = [];
  let path: string | undefined;
  const visit = (node: Expression): boolean => {
    if (node.kind === "logical") {
      return node.operator === "or" && visit(node.left) && visit(node.right);
    }
    if (node.kind === "binary" && node.operator === "eq" && node.left.kind === "path" && node.right.kind === "literal") {
      if (path === undefined) {
        path = node.left.path;
      } else if (path !== node.left.path) {
        return false;
      }
      values.push(literalText(node.right.value));
      return true;
    }
    return false;
  };
  return visit(expression) && path !== undefined ? { path, comparator: "anyOf", values } : undefined;
}

/**
 * A condition as the clauses the catalog words ("is", "is not", "is any of", ticked, joined by
 * one `and` or one `or`), or `undefined` when it does not fit: a function, arithmetic, a
 * comparison of two fields, `and` and `or` mixed other than "is A or B" inside an `and`, an
 * `if`. `undefined` means the condition reads as its printed formula instead.
 */
function conditionClauses(expression: Expression | undefined): { join: "and" | "or"; clauses: Clause[] } | undefined {
  if (expression === undefined || !isPrintableExpression(expression) || joinedPastLimit(expression)) {
    return undefined;
  }
  const single = leafClause(expression);
  if (single) {
    return { join: "and", clauses: [single] };
  }
  if (expression.kind !== "logical") {
    return undefined;
  }
  // "Partnership or Corporation" on its own is one clause, whatever join the rows would have.
  const whole = anyOfClause(expression);
  if (whole) {
    return { join: "and", clauses: [whole] };
  }
  const join = expression.operator;
  const clauses: Clause[] = [];
  const visit = (node: Expression): boolean => {
    if (node.kind === "logical" && node.operator === join) {
      return visit(node.left) && visit(node.right);
    }
    if (join === "and") {
      const anyOf = anyOfClause(node);
      if (anyOf) {
        clauses.push(anyOf);
        return true;
      }
    }
    const clause = leafClause(node);
    if (!clause) {
      return false;
    }
    clauses.push(clause);
    return true;
  };
  return visit(expression) ? { join, clauses } : undefined;
}

// --- condition sentences ---------------------------------------------------------------------

const CLAUSE_KEYS: Record<ClauseComparator, BuilderTextKey> = {
  eq: "cond.eq",
  neq: "cond.neq",
  gt: "cond.gt",
  gte: "cond.gte",
  lt: "cond.lt",
  lte: "cond.lte",
  isTrue: "cond.isTrue",
  isFalse: "cond.isFalse",
  anyOf: "cond.anyOf",
  noneOf: "cond.noneOf"
};

/**
 * Adjacent comparisons of one field that read as one: "is A or is B" under `or` becomes "is A
 * or B", and "is not A and is not B" under `and` becomes "is not A or B" (neither of them).
 */
function mergeClauses(join: "and" | "or", clauses: Clause[]): Clause[] {
  const single: ClauseComparator = join === "or" ? "eq" : "neq";
  const merged: ClauseComparator = join === "or" ? "anyOf" : "noneOf";
  const out: Clause[] = [];
  for (const clause of clauses) {
    const previous = out[out.length - 1];
    const joinable = clause.comparator === single || clause.comparator === merged;
    if (
      previous !== undefined &&
      joinable &&
      previous.path === clause.path &&
      (previous.comparator === single || previous.comparator === merged)
    ) {
      out[out.length - 1] = { path: clause.path, comparator: merged, values: [...previous.values, ...clause.values] };
      continue;
    }
    out.push(clause);
  }
  return out;
}

function clauseTokens(clause: Clause, context: WordContext): LogicToken[] {
  const tokens: LogicToken[] = [];
  for (const part of builderTemplateParts(CLAUSE_KEYS[clause.comparator], context.text)) {
    if ("text" in part) {
      tokens.push({ kind: "word", text: part.text });
    } else if (part.slot === "field") {
      tokens.push(fieldToken(clause.path, context));
    } else if (part.slot === "value") {
      tokens.push({ kind: "value", text: valueText(clause.values[0] ?? "", clause.path, context) });
    } else if (part.slot === "values") {
      const texts = clause.values.map((value) => valueText(value, clause.path, context));
      for (const piece of formatList(texts, { ...context.text, type: "disjunction" })) {
        tokens.push({ kind: piece.kind === "element" ? "value" : "word", text: piece.text });
      }
    } else {
      tokens.push({ kind: "word", text: `{${part.slot}}` });
    }
  }
  return tokens;
}

function clausesTokens(join: "and" | "or", clauses: Clause[], context: WordContext): LogicToken[] {
  const joinWord = ` ${builderText(join === "and" ? "cond.join.and" : "cond.join.or", undefined, context.text)} `;
  const tokens: LogicToken[] = [];
  mergeClauses(join, clauses).forEach((clause, index) => {
    if (index > 0) {
      tokens.push({ kind: "word", text: joinWord });
    }
    tokens.push(...clauseTokens(clause, context));
  });
  return tokens;
}

/** A condition with no clauses as its printed formula, or "a custom condition" when the tree cannot run. */
function opaqueConditionTokens(expression: Expression, context: WordContext): LogicToken[] {
  if (!isPrintableExpression(expression)) {
    return [{ kind: "expression", text: builderText("cond.custom", undefined, context.text) }];
  }
  return formulaTokens(expression, context);
}

function conditionTokensIn(expression: Expression | undefined, context: WordContext): LogicToken[] {
  if (expression === undefined) {
    return [];
  }
  const shape = conditionClauses(expression);
  if (!shape) {
    return opaqueConditionTokens(expression, context);
  }
  return clausesTokens(shape.join, shape.clauses, context);
}

/**
 * A condition as sentence tokens: "[Business structure] is [Partnership] or [Corporation]".
 * Fields are `field` tokens carrying their component id when the path names one, values are
 * `value` tokens (a choice's option label when one matches), join words are `word` tokens. A
 * condition the catalog has no sentence for is its printed formula, as tokens. Concatenating
 * the texts gives the sentence.
 */
export function conditionSentence(
  expression: Expression | undefined,
  context: {
    root: ComponentNode;
    locale?: string | undefined;
    catalog?: BuilderTextCatalog | undefined;
    labelOf?: ((id: string) => string | undefined) | undefined;
    translations?: FormTranslations | undefined;
    translationCatalog?: TranslationCatalog | undefined;
  }
): LogicToken[] {
  return conditionTokensIn(expression, createWordContext(context.root, context));
}

// --- rule sentences ------------------------------------------------------------------------

/** What fills a sentence template's slots: a token, or a run of tokens. */
type SlotFill = Record<string, LogicToken | LogicToken[] | undefined>;

/**
 * A template's parts as tokens, its slots filled. The words before the first slot say what the
 * rule does, so a rule sentence sets them apart as the `verb`; a nested template (a case of a
 * value rule) keeps them as words.
 */
function templateTokens(key: BuilderTextKey, fill: SlotFill, context: WordContext, verb: boolean): LogicToken[] {
  const tokens: LogicToken[] = [];
  builderTemplateParts(key, context.text).forEach((part, index) => {
    if ("text" in part) {
      tokens.push({ kind: verb && index === 0 ? "verb" : "word", text: part.text });
      return;
    }
    const value = fill[part.slot];
    if (value === undefined) {
      tokens.push({ kind: "word", text: `{${part.slot}}` });
    } else if (Array.isArray(value)) {
      tokens.push(...value);
    } else {
      tokens.push(value);
    }
  });
  return tokens;
}

function ruleSentence(key: BuilderTextKey, target: LogicToken, fill: SlotFill, context: WordContext): LogicToken[] {
  return templateTokens(key, { ...fill, target }, context, true);
}

/** A value rule's result: a literal as one value token, anything else as its printed formula. */
function valueTokens(expression: Expression, context: WordContext): LogicToken[] {
  if (expression.kind === "literal") {
    return [{ kind: "value", text: valueText(literalText(expression.value), "", context) }];
  }
  return formulaTokens(expression, context);
}

/**
 * An `if` as its cases: "250 when … and …; 180 when …; otherwise 120" (one case reads
 * "250 when …, otherwise 120"). Each `when` is a condition sentence, each result a value.
 */
function branchesTokens(node: IfExpression, context: WordContext): LogicToken[] {
  const parts: LogicToken[][] = node.cases.map((entry) =>
    templateTokens("value.case", { value: valueTokens(entry.then, context), condition: conditionTokensIn(entry.when, context) }, context, false)
  );
  if (node.else !== undefined) {
    parts.push(templateTokens("value.otherwise", { value: valueTokens(node.else, context) }, context, false));
  }
  const tokens: LogicToken[] = [];
  parts.forEach((part, index) => {
    if (index > 0) {
      const last = index === parts.length - 1 && node.else !== undefined;
      tokens.push({ kind: "word", text: builderText(last && node.cases.length === 1 ? "ifCases.sepLast" : "ifCases.sepCase", undefined, context.text) });
    }
    tokens.push(...part);
  });
  return tokens;
}

/** Whether a `visibleWhen` reads as "Hide X when …": `not` over a condition that is not one bare field. */
function isHideRule(ruleKey: string, expression: Expression | undefined): boolean {
  return ruleKey === "visibleWhen" && expression !== undefined && expression.kind === "unary" && isRecord(expression.operand) && expression.operand.kind !== "path";
}

/**
 * A form rule's sentence from what the editor holds: the kind's template, the target, and the
 * condition or value as the list words it. A secret rule reads as "a formula the server keeps";
 * a formula that does not parse (`expression` undefined, `text` given) reads as its text; a tree
 * the evaluator cannot read (`unreadable`: written as JSON, dropped by the compile) reads as "a
 * custom condition", as a tree that cannot be printed does.
 */
function formRuleTokens(
  kind: LogicRuleKind,
  target: LogicToken,
  expression: Expression | undefined,
  run: RunScope,
  text: string | undefined,
  context: WordContext,
  unreadable = false
): LogicToken[] {
  const isValueRule = kind === "calculate" || kind === "default" || kind === "min-rows" || kind === "max-rows";
  if (run === "server-secret") {
    const secret: LogicToken[] = [{ kind: "word", text: builderText("rule.secret.sentence", undefined, context.text) }];
    return ruleSentence(KIND_TEMPLATES[kind], target, isValueRule ? { expression: secret } : { condition: secret }, context);
  }
  if (expression === undefined) {
    const raw: LogicToken[] =
      text !== undefined && text.trim() !== ""
        ? [{ kind: "expression", text: text.trim() }]
        : unreadable
          ? [{ kind: "expression", text: builderText("cond.custom", undefined, context.text) }]
          : [];
    return ruleSentence(KIND_TEMPLATES[kind], target, isValueRule ? { expression: raw } : { condition: raw }, context);
  }
  if (isValueRule) {
    if (!isPrintableExpression(expression)) {
      return ruleSentence(KIND_TEMPLATES[kind], target, { expression: [{ kind: "expression", text: builderText("cond.custom", undefined, context.text) }] }, context);
    }
    if (expression.kind === "if" && (kind === "calculate" || kind === "default")) {
      return ruleSentence(kind === "calculate" ? "rule.calculate.branches" : "rule.default.branches", target, { branches: branchesTokens(expression, context) }, context);
    }
    return ruleSentence(KIND_TEMPLATES[kind], target, { expression: valueTokens(expression, context) }, context);
  }
  if (kind === "hide" || kind === "hide-step") {
    const operand = expression.kind === "unary" ? expression.operand : expression;
    return ruleSentence(KIND_TEMPLATES[kind], target, { condition: conditionTokensIn(operand, context) }, context);
  }
  return ruleSentence(KIND_TEMPLATES[kind], target, { condition: conditionTokensIn(expression, context) }, context);
}

/** What the editor describes: a rule by its key on a component, as a tree (or as text that does not parse). */
export interface FormRuleDescription {
  /** The rule's target; absent (a new rule with no field yet) reads as "…". */
  componentId?: string | undefined;
  ruleKey: string;
  expression: Expression | undefined;
  /** The formula as typed, read when `expression` is undefined. */
  text?: string | undefined;
  run?: RunScope | undefined;
  /** The kind the editor holds (an authored Show over `not(…)`); absent: read from the rule's shape. */
  kind?: LogicRuleKind | undefined;
}

/** The words of one form, built once and asked many times (every keystroke in the editor). */
export interface LogicWords {
  /** The rule-list sentence a form rule would have: the "Reads as" line. */
  ruleSentence(rule: FormRuleDescription): LogicToken[];
  /** A condition as sentence tokens (see {@link conditionSentence}). */
  conditionSentence(expression: Expression | undefined): LogicToken[];
  /** A component's name as the sentences use it. */
  labelOf(componentId: string): string;
  /**
   * A journey route's sentence for the editor's "Reads as": the destination as `destination`
   * (a step's name, or "the end"), the condition as a tree, or as the text that does not parse;
   * no condition at all reads "always".
   */
  routeSentence(destination: string | undefined, expression: Expression | undefined, text?: string | undefined): LogicToken[];
}

export function createLogicWords(root: ComponentNode, options: LogicModelOptions = {}): LogicWords {
  return logicWordsIn(createWordContext(root, options));
}

function logicWordsIn(context: WordContext): LogicWords {
  return {
    ruleSentence: (rule) => {
      const node = rule.componentId !== undefined ? context.index.nodeById.get(rule.componentId) : undefined;
      const kind = rule.kind ?? ruleKindOf(node, rule.ruleKey, rule.expression, context);
      const target: LogicToken =
        rule.componentId !== undefined
          ? { kind: "field", text: context.labelOf(rule.componentId), componentId: rule.componentId }
          : { kind: "field", text: "…" };
      return formRuleTokens(kind, target, rule.expression, rule.run ?? "both", rule.text, context);
    },
    conditionSentence: (expression) => conditionTokensIn(expression, context),
    labelOf: (componentId) => context.labelOf(componentId),
    routeSentence: (destination, expression, text) =>
      routeTokens({ kind: "document", text: destination ?? "…" }, text !== undefined && text.trim() !== "" ? text : undefined, expression, context)
  };
}

/** The rule-list sentence a form rule would have, for one rule (see {@link createLogicWords} for many). */
export function formRuleSentence(root: ComponentNode, rule: FormRuleDescription, options: LogicModelOptions = {}): LogicToken[] {
  return createLogicWords(root, options).ruleSentence(rule);
}

/** The text the editor opens for a stored rule: its formula, else the tree printed with ids; "" for none. */
export function ruleFormulaText(source: unknown): string {
  const text = ruleText(source);
  if (text !== undefined) {
    return text;
  }
  const expression = ruleExpression(source);
  return expression !== undefined ? printFormula(expression) : "";
}

/** Whether a stored rule is text (a string or the object form with a formula) rather than a tree. */
export function ruleStoredAsText(source: unknown): boolean {
  return ruleText(source) !== undefined;
}

// --- the walk ------------------------------------------------------------------------------

const FORM_RULE_KINDS: Record<string, LogicRuleKind> = {
  visibleWhen: "show",
  requiredWhen: "require",
  validWhen: "validate",
  enabledWhen: "enable",
  readonlyWhen: "readonly",
  value: "calculate",
  defaultValue: "default",
  filter: "filter",
  navigationGating: "gate",
  minRows: "min-rows",
  maxRows: "max-rows"
};

const KIND_FILTERS: Record<LogicRuleKind, Exclude<LogicFilterId, "all">> = {
  show: "show",
  hide: "show",
  enable: "show",
  readonly: "show",
  filter: "show",
  require: "require",
  // A check on the answer sits with the other rules about what a field must hold.
  validate: "require",
  calculate: "calculate",
  default: "calculate",
  // A grid's row-count bounds are checks on what the form must hold, beside Required.
  "min-rows": "require",
  "max-rows": "require",
  "show-step": "steps",
  "hide-step": "steps",
  gate: "steps",
  route: "journeys",
  "pdf-layout": "pdf"
};

const KIND_TEMPLATES: Record<LogicRuleKind, BuilderTextKey> = {
  show: "rule.show.when",
  hide: "rule.hide.when",
  require: "rule.require.when",
  validate: "rule.validate.when",
  enable: "rule.enable.when",
  readonly: "rule.readonly.when",
  calculate: "rule.calculate.as",
  default: "rule.default.as",
  "min-rows": "rule.minRows.is",
  "max-rows": "rule.maxRows.is",
  filter: "rule.filter.where",
  gate: "rule.gate.when",
  "show-step": "rule.showStep.when",
  "hide-step": "rule.hideStep.when",
  route: "rule.route.when",
  "pdf-layout": "rule.pdfLayout.when"
};

/** The kinds one `visibleWhen` can be authored as: the same stored JSON reads as either of a pair. */
const SHOW_HIDE_KINDS: ReadonlySet<LogicRuleKind> = new Set(["show", "hide", "show-step", "hide-step"]);

const HIDDEN_VALUE_BEHAVIORS: ReadonlySet<string> = new Set(["retain", "clear", "exclude-from-submission"]);

/** The kind a rule key on a node reads as: a `visibleWhen` on a step is a step rule, `not(…)` over a condition a hide. */
function ruleKindOf(
  node: ComponentNode | undefined,
  ruleKey: string,
  expression: Expression | undefined,
  context: WordContext,
  stored?: string | undefined
): LogicRuleKind {
  let kind = FORM_RULE_KINDS[ruleKey] ?? "show";
  if (kind === "show") {
    const parentId = node !== undefined ? context.index.parentOf.get(node.id) : undefined;
    const parent = parentId !== undefined ? context.index.nodeById.get(parentId) : undefined;
    const step = node !== undefined && isStepOfSteps(node, parent);
    const hide = isHideRule(ruleKey, expression);
    kind = step ? (hide ? "hide-step" : "show-step") : hide ? "hide" : "show";
    const authored = node !== undefined && stored !== undefined ? context.authoredKinds?.get(`form:${node.id}:${ruleKey}`) : undefined;
    if (authored !== undefined && authored.stored === stored && SHOW_HIDE_KINDS.has(authored.kind) && step === (authored.kind === "show-step" || authored.kind === "hide-step")) {
      kind = authored.kind;
    }
  }
  return kind;
}

/** Every form-scoped path an expression reads, in reading order, each once; an `if` through every case and its else. */
export function expressionReads(expression: unknown): string[] {
  return formReads(expression);
}

function formReads(expression: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [expression];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node)) {
      continue;
    }
    if (node.kind === "path") {
      if (typeof node.path === "string" && node.path !== "" && !isScopedExpressionPath(node.path) && !out.includes(node.path)) {
        out.push(node.path);
      }
      continue;
    }
    // Pushed right to left, so the stack visits the operands in reading order.
    let operands: unknown[];
    if (node.kind === "unary") {
      operands = [node.operand];
    } else if (node.kind === "call") {
      operands = Array.isArray(node.args) ? node.args : [];
    } else if (node.kind === "if") {
      operands = [];
      for (const entry of Array.isArray(node.cases) ? node.cases : []) {
        if (isRecord(entry)) {
          operands.push(entry.when, entry.then);
        }
      }
      if (node.else !== undefined) {
        operands.push(node.else);
      }
    } else {
      operands = [node.left, node.right];
    }
    for (let at = operands.length - 1; at >= 0; at -= 1) {
      stack.push(operands[at]);
    }
  }
  return out;
}

function groupOf(id: string, context: WordContext): LogicGroup {
  if (id === "form") {
    return { id, label: builderText("logic.group.form", undefined, context.text), kind: "form" };
  }
  if (id === "steps") {
    return { id, label: builderText("logic.group.steps", undefined, context.text), kind: "steps" };
  }
  if (id === "journeys") {
    return { id, label: builderText("logic.group.journeys", undefined, context.text), kind: "journeys" };
  }
  if (id === "outputs") {
    return { id, label: builderText("logic.group.outputs", undefined, context.text), kind: "outputs" };
  }
  const stepId = id.slice("step:".length);
  return { id, label: context.labelOf(stepId), kind: "step" };
}

/** Whether a stored rule is a tree written as JSON (bare, or the object form's `expression`). */
function isWrittenTree(source: unknown): boolean {
  if (!isRecord(source)) {
    return false;
  }
  if (typeof source.kind === "string") {
    return true;
  }
  return source.kind === undefined && isRecord(source.expression) && typeof source.expression.kind === "string";
}

function formRule(node: ComponentNode, ruleKey: string, source: unknown, context: WordContext): LogicRule {
  const expression = ruleExpression(source);
  const text = ruleText(source);
  const run = ruleRun(source);
  const kind = ruleKindOf(node, ruleKey, expression, context, text);
  const step = context.index.stepOf.get(node.id);
  const isStepRule = kind === "show-step" || kind === "hide-step" || kind === "gate";
  const groupId = isStepRule ? "steps" : step !== undefined ? `step:${step}` : "form";
  const label = context.labelOf(node.id);
  const target: LogicToken = { kind: "field", text: label, componentId: node.id };
  const rule: LogicRule = {
    id: `form:${node.id}:${ruleKey}`,
    kind,
    filter: KIND_FILTERS[kind],
    source: { mode: "form" },
    editable: true,
    target: { id: node.id, label, type: node.type },
    ruleKey,
    expression,
    formula: text ?? (expression !== undefined ? printFormula(expression) : ""),
    storedAsText: text !== undefined,
    run,
    group: groupOf(groupId, context),
    sentence: formRuleTokens(kind, target, expression, run, text, context, expression === undefined && text === undefined && isWrittenTree(source)),
    reads: formReads(expression)
  };
  if ((kind === "show" || kind === "hide") && isRecord(node.configuration)) {
    const behavior = node.configuration.hiddenValueBehavior;
    if (typeof behavior === "string" && HIDDEN_VALUE_BEHAVIORS.has(behavior)) {
      rule.hiddenValueBehavior = behavior as HiddenValueBehavior;
    }
  }
  // A check's words are the field's own message for the code `rule`.
  if (kind === "validate" && isRecord(node.configuration) && isRecord(node.configuration.messages) && node.configuration.messages.rule !== undefined) {
    rule.message = node.configuration.messages.rule;
  }
  return rule;
}

/** A journey page's name: its title, else its first form component's label, else its id. */
function pageLabel(page: JourneyPage, context: WordContext): string {
  const title = localized(page.title);
  if (title !== undefined && title.trim() !== "") {
    return title;
  }
  const first = journeyPageFormIds(page)[0];
  return first !== undefined && context.index.nodeById.has(first) ? context.labelOf(first) : page.id;
}

/** A step's name as the editor's pickers and the sentences give it. */
function journeyLabelOf(journey: Journey): string {
  return typeof journey.name === "string" && journey.name.trim() !== "" ? journey.name : journey.id;
}

/** Whether a stored route condition says anything: a blank text, or none, is "always". */
function routeConditionBlank(when: unknown): boolean {
  if (when === undefined || when === null) {
    return true;
  }
  const text = ruleText(when);
  return text !== undefined && text.trim() === "" && !isRecord(when);
}

/**
 * The journeys as the rule editor's pickers need them: steps in order, which can be named by a
 * route (the first written under each id), which routes are unconditional.
 */
function journeySummaries(journeys: readonly Journey[], context: WordContext): LogicJourneySummary[] {
  return journeys.map((journey) => {
    const seen = new Set<string>();
    return {
      id: journey.id,
      label: journeyLabelOf(journey),
      pages: journey.pages.map((page) => {
        const firstOfId = !seen.has(page.id);
        seen.add(page.id);
        const routes = page.routes ?? [];
        return {
          id: page.id,
          label: pageLabel(page, context),
          exit: page.kind === "exit",
          // The path takes no route from a review step either: it records the way to the end and stops (`journeyPath`).
          stops: page.kind === "exit" || page.kind === "review",
          firstOfId,
          unconditional: routes.flatMap((route, at) => (routeConditionBlank(route.when) ? [at] : [])),
          routes: routes.length
        };
      })
    };
  });
}

/** A route's destination as the sentences name it: a page's label, "the end", or the id a route names that no page has. */
function routeDestinationLabel(journey: Journey, to: string, context: WordContext): string {
  if (to === JOURNEY_END) {
    return builderText("logic.route.end", undefined, context.text);
  }
  const destination = journey.pages.find((candidate) => candidate.id === to);
  return destination ? pageLabel(destination, context) : to;
}

/**
 * A route's sentence: "Go to [Your landlord] when [Own or rent] is [Own]", or "Go to [The work]
 * always" for one with no condition; a condition that does not parse reads as its text.
 */
function routeTokens(target: LogicToken, when: unknown, expression: Expression | undefined, context: WordContext): LogicToken[] {
  if (expression === undefined) {
    const text = ruleText(when)?.trim();
    if (routeConditionBlank(when)) {
      return ruleSentence("rule.route.always", target, {}, context);
    }
    return ruleSentence("rule.route.when", target, { condition: [{ kind: "expression", text: text !== undefined && text !== "" ? text : builderText("cond.custom", undefined, context.text) }] }, context);
  }
  return ruleSentence("rule.route.when", target, { condition: conditionTokensIn(expression, context) }, context);
}

function journeyRules(journey: Journey, context: WordContext, editable: boolean): LogicRule[] {
  const rules: LogicRule[] = [];
  const group = groupOf("journeys", context);
  for (const page of journey.pages) {
    const written = page.routes ?? [];
    written.forEach((route, routeIndex) => {
      const routeWhen = ruleExpression(route.when);
      const destinationLabel = routeDestinationLabel(journey, route.to, context);
      const target: LogicToken = { kind: "document", text: destinationLabel };
      rules.push({
        id: `journeys:${journey.id}:${page.id}:route:${routeIndex}`,
        kind: "route",
        filter: "journeys",
        source: { mode: "journeys", journeyId: journey.id, pageId: page.id, routeIndex, routeCount: written.length },
        editable,
        target: { id: route.to, label: destinationLabel, type: route.to === JOURNEY_END ? "journey-end" : "journey-page" },
        ruleKey: "when",
        expression: routeWhen,
        formula: ruleFormulaText(route.when),
        storedAsText: ruleStoredAsText(route.when),
        run: "both",
        group,
        sentence: routeTokens(target, route.when, routeWhen, context),
        reads: formReads(routeWhen)
      });
    });
  }
  return rules;
}

function pdfRules(definition: FormDefinition, context: WordContext): LogicRule[] {
  const group = groupOf("outputs", context);
  const rules: LogicRule[] = [];
  for (const layout of readPdfConfiguration(definition)) {
    const layoutWhen = ruleExpression(layout.when);
    if (layoutWhen === undefined) {
      continue;
    }
    const name = localized(layout.name);
    const label = name !== undefined && name.trim() !== "" ? name : layout.id;
    rules.push({
      id: `pdf:${layout.id}:when`,
      kind: "pdf-layout",
      filter: "pdf",
      source: { mode: "pdf", layoutId: layout.id },
      editable: false,
      target: { id: layout.id, label, type: "pdf-layout" },
      ruleKey: "when",
      expression: layoutWhen,
      formula: ruleFormulaText(layout.when),
      storedAsText: ruleStoredAsText(layout.when),
      run: "both",
      group,
      sentence: ruleSentence(
        "rule.pdfLayout.when",
        { kind: "document", text: label },
        { condition: conditionTokensIn(layoutWhen, context) },
        context
      ),
      reads: formReads(layoutWhen)
    });
  }
  return rules;
}

// --- diagnostics ---------------------------------------------------------------------------

interface Edge {
  from: string;
  to: string;
  ruleId: string;
  ownerId: string;
}

/**
 * Strongly connected components of a directed graph (Tarjan's), iteratively so a long chain of
 * rules cannot exhaust the call stack. Components come out in the order their roots finish.
 */
function stronglyConnected(nodes: string[], next: Map<string, string[]>): string[][] {
  const indexOf = new Map<string, number>();
  const lowOf = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  for (const start of nodes) {
    if (indexOf.has(start)) {
      continue;
    }
    const work: Array<{ node: string; edge: number }> = [{ node: start, edge: 0 }];
    indexOf.set(start, counter);
    lowOf.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; edge: number };
      const targets = next.get(frame.node) ?? [];
      if (frame.edge < targets.length) {
        const target = targets[frame.edge] as string;
        frame.edge += 1;
        if (!indexOf.has(target)) {
          indexOf.set(target, counter);
          lowOf.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, edge: 0 });
        } else if (onStack.has(target)) {
          lowOf.set(frame.node, Math.min(lowOf.get(frame.node) as number, indexOf.get(target) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        lowOf.set(parent.node, Math.min(lowOf.get(parent.node) as number, lowOf.get(frame.node) as number));
      }
      if (lowOf.get(frame.node) === indexOf.get(frame.node)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop() as string;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * Fields whose visibility reads each other's answers. A component is shown only while its own
 * `visibleWhen` and every container's above it hold (`core/state/effective-state.ts`), so each
 * component depends on what all of those read; a loop in that graph is a set of answers that
 * hide one another.
 */
function visibilityCycles(rules: LogicRule[], context: WordContext): LogicDiagnostic[] {
  const visibility = new Map<string, LogicRule>();
  for (const rule of rules) {
    if (rule.source.mode === "form" && rule.ruleKey === "visibleWhen") {
      visibility.set(rule.target.id, rule);
    }
  }
  if (visibility.size === 0) {
    return [];
  }
  const readsOf = new Map<string, string[]>();
  for (const [ownerId, rule] of visibility) {
    const ids: string[] = [];
    for (const path of rule.reads) {
      const resolved = componentOfPath(context.index, path);
      if (resolved && !ids.includes(resolved.id)) {
        ids.push(resolved.id);
      }
    }
    readsOf.set(ownerId, ids);
  }
  const edges: Edge[] = [];
  for (const node of context.index.order) {
    let at: string | undefined = node.id;
    while (at !== undefined) {
      const rule = visibility.get(at);
      if (rule) {
        for (const read of readsOf.get(at) ?? []) {
          edges.push({ from: node.id, to: read, ruleId: rule.id, ownerId: at });
        }
      }
      at = context.index.parentOf.get(at);
    }
  }
  const next = new Map<string, string[]>();
  const nodes: string[] = [];
  for (const edge of edges) {
    for (const id of [edge.from, edge.to]) {
      if (!next.has(id)) {
        next.set(id, []);
        nodes.push(id);
      }
    }
    const targets = next.get(edge.from) as string[];
    if (!targets.includes(edge.to)) {
      targets.push(edge.to);
    }
  }
  const ruleOrder = new Map(rules.map((rule, position) => [rule.id, position]));
  const diagnostics: LogicDiagnostic[] = [];
  const components = stronglyConnected(nodes, next);
  // Reported in the order the rule list shows them, not the order the search finished them.
  const found: Array<{ ruleIds: string[]; owners: string[]; first: number }> = [];
  for (const component of components) {
    const members = new Set(component);
    const inside = edges.filter((edge) => members.has(edge.from) && members.has(edge.to));
    if (component.length === 1 && !inside.some((edge) => edge.from === edge.to)) {
      continue;
    }
    const ruleIds = [...new Set(inside.map((edge) => edge.ruleId))].sort(
      (a, b) => (ruleOrder.get(a) ?? 0) - (ruleOrder.get(b) ?? 0)
    );
    const owners = ruleIds.map((ruleId) => (inside.find((edge) => edge.ruleId === ruleId) as Edge).ownerId);
    found.push({ ruleIds, owners, first: ruleOrder.get(ruleIds[0] as string) ?? 0 });
  }
  found.sort((a, b) => a.first - b.first);
  for (const cycle of found) {
    const labels = cycle.owners.map((owner) => context.labelOf(owner));
    const message =
      labels.length === 1
        ? builderText("logic.diag.visibilitySelf", { field: labels[0] as string }, context.text)
        : builderText(
            "logic.diag.visibilityCycle",
            { fields: formatListText(labels, { ...context.text, type: "conjunction" }) },
            context.text
          );
    diagnostics.push({ code: "visibility-cycle", message, ruleIds: cycle.ruleIds });
  }
  return diagnostics;
}

/** Reads of a form-scoped path no component stores an answer at: it always reads as unanswered. */
function missingReads(rules: LogicRule[], context: WordContext): LogicDiagnostic[] {
  const diagnostics: LogicDiagnostic[] = [];
  for (const rule of rules) {
    for (const path of rule.reads) {
      const resolved = componentOfPath(context.index, path);
      const node = resolved ? context.index.nodeById.get(resolved.id) : undefined;
      if (node !== undefined && holdsData(node)) {
        continue;
      }
      diagnostics.push({
        code: "reads-missing-field",
        message: builderText("logic.diag.readsMissing", { target: rule.target.label, path }, context.text),
        ruleIds: [rule.id]
      });
    }
  }
  return diagnostics;
}

/** Form rules on a step reading an answer given on a later step of the same `steps` container. */
function laterStepReads(rules: LogicRule[], context: WordContext): LogicDiagnostic[] {
  const diagnostics: LogicDiagnostic[] = [];
  for (const rule of rules) {
    if (rule.source.mode !== "form") {
      continue;
    }
    const ownStep = context.index.stepOf.get(rule.target.id);
    const own = ownStep !== undefined ? context.index.stepPosition.get(ownStep) : undefined;
    if (own === undefined) {
      continue;
    }
    const said = new Set<string>();
    for (const path of rule.reads) {
      const resolved = componentOfPath(context.index, path);
      if (!resolved || said.has(resolved.id)) {
        continue;
      }
      const readStep = context.index.stepOf.get(resolved.id);
      const read = readStep !== undefined ? context.index.stepPosition.get(readStep) : undefined;
      if (read === undefined || read.containerId !== own.containerId || read.index <= own.index) {
        continue;
      }
      said.add(resolved.id);
      diagnostics.push({
        code: "reads-later-step",
        message: builderText(
          "logic.diag.readsLaterStep",
          { target: rule.target.label, field: context.labelOf(resolved.id) },
          context.text
        ),
        ruleIds: [rule.id]
      });
    }
  }
  return diagnostics;
}

/** The rule keys the findings may name (`logic.ruleName.<key>`); any other key reads as itself. */
const NAMED_RULE_KEYS: ReadonlySet<string> = new Set([
  "visibleWhen",
  "enabledWhen",
  "readonlyWhen",
  "requiredWhen",
  "validWhen",
  "value",
  "defaultValue",
  "filter",
  "navigationGating",
  "minRows",
  "maxRows"
]);

/**
 * The form-rule keys the list reads, in the inspector's order, with the Validate rule's key
 * after `requiredWhen`: Logic is where a check is written, so the inspector's Rules
 * tab does not list it.
 */
const LOGIC_RULE_KEYS: readonly string[] = [
  ...RULE_DESCRIPTORS.flatMap((descriptor) => (descriptor.key === "requiredWhen" ? [descriptor.key, "validWhen"] : [descriptor.key])),
  // A data grid's row-count bounds, after the rules every component may carry.
  ...DATA_GRID_ROW_BOUND_DESCRIPTORS.map((descriptor) => descriptor.key)
];

/** The words for a rule key in the findings ("visibility rule", "calculation"), from the catalog. */
function ruleName(ruleKey: string, context: WordContext): string {
  return NAMED_RULE_KEYS.has(ruleKey) ? builderText(`logic.ruleName.${ruleKey}` as BuilderTextKey, undefined, context.text) : ruleKey;
}

/** A stored formula the parser refuses: the rule is listed with its text, and this says why it will not run. */
function invalidFormulas(rules: LogicRule[], sources: Map<string, unknown>, context: WordContext): LogicDiagnostic[] {
  const diagnostics: LogicDiagnostic[] = [];
  for (const rule of rules) {
    if (rule.expression !== undefined || rule.source.mode !== "form") {
      continue;
    }
    const text = ruleText(sources.get(rule.id));
    if (text === undefined || text.trim() === "") {
      continue;
    }
    const parsed = kernelParseFormula(text, formulaFunctionSignatures());
    const message = parsed.ok ? "" : formulaErrorText(parsed.code, parsed.params, context.text);
    diagnostics.push({
      code: "formula-invalid",
      severity: "error",
      message: builderText(
        "logic.diag.formulaInvalid",
        { target: rule.target.label, rule: ruleName(rule.ruleKey, context), message },
        context.text
      ),
      ruleIds: [rule.id]
    });
  }
  return diagnostics;
}

/** A formula a rename left as written because it does not parse: a finding on the rule, until the text changes. */
function renameUnparsed(
  rules: LogicRule[],
  sources: Map<string, unknown>,
  notes: NonNullable<LogicModelOptions["renameNotes"]>,
  context: WordContext
): LogicDiagnostic[] {
  const diagnostics: LogicDiagnostic[] = [];
  for (const note of notes) {
    const id = `form:${note.componentId}:${note.rule}`;
    const rule = rules.find((candidate) => candidate.id === id);
    if (!rule || ruleText(sources.get(id)) !== note.formula) {
      continue;
    }
    diagnostics.push({
      code: "rename-unparsed",
      severity: "error",
      message: builderText(
        "logic.diag.renameUnparsed",
        { target: rule.target.label, rule: ruleName(rule.ruleKey, context), from: note.from, to: note.to },
        context.text
      ),
      ruleIds: [id]
    });
  }
  return diagnostics;
}

/** Whether a component, or any container above it, is shown by a rule that runs in the browser only. */
function hiddenByBrowserRule(componentId: string, context: WordContext): string | undefined {
  let at: string | undefined = componentId;
  while (at !== undefined) {
    const node = context.index.nodeById.get(at);
    const visibleWhen = isRecord(node?.rules) ? (node.rules as Record<string, unknown>).visibleWhen : undefined;
    if (visibleWhen !== undefined && visibleWhen !== null && ruleExpression(visibleWhen) !== undefined && ruleRun(visibleWhen) === "browser") {
      return at;
    }
    at = context.index.parentOf.get(at);
  }
  return undefined;
}

/**
 * Where a rule runs against what it reads (the same findings
 * journey-diagnostics raises per journey, here over the form alone): a server-only or secret
 * rule reading `host.` never runs (an error) and one reading the clock runs only when the host
 * gives the server the day (a warning); a browser-only required rule is not enforced by the
 * server; a secret rule reading a field a browser-only rule may hide reads what the browser
 * kept or dropped.
 */
function scopeFindings(rules: LogicRule[], context: WordContext): LogicDiagnostic[] {
  const diagnostics: LogicDiagnostic[] = [];
  for (const rule of rules) {
    if (rule.source.mode !== "form" || rule.expression === undefined) {
      continue;
    }
    const serverOnly = rule.run === "server" || rule.run === "server-secret";
    const name = ruleName(rule.ruleKey, context);
    const params = { target: rule.target.label, rule: name };
    if (serverOnly && kernelExprReadsHost(rule.expression)) {
      diagnostics.push({
        code: "rule.server-cannot-run",
        severity: "error",
        message: builderText("logic.diag.serverCannotRun.host", params, context.text),
        ruleIds: [rule.id]
      });
    } else if (serverOnly && kernelExprReadsClock(rule.expression)) {
      diagnostics.push({
        code: "rule.server-cannot-run",
        severity: "warning",
        message: builderText("logic.diag.serverCannotRun.clock", params, context.text),
        ruleIds: [rule.id]
      });
    }
    if (rule.ruleKey === "requiredWhen" && rule.run === "browser") {
      diagnostics.push({
        code: "rule.browser-only-required",
        severity: "warning",
        message: builderText("logic.diag.browserOnlyRequired", params, context.text),
        ruleIds: [rule.id]
      });
    }
    if (rule.run === "server-secret") {
      const said = new Set<string>();
      for (const path of rule.reads) {
        const resolved = componentOfPath(context.index, path);
        if (!resolved || said.has(resolved.id)) {
          continue;
        }
        const hider = hiddenByBrowserRule(resolved.id, context);
        if (hider === undefined) {
          continue;
        }
        said.add(resolved.id);
        diagnostics.push({
          code: "rule.secret-reads-browser-hidden",
          severity: "warning",
          message: builderText("logic.diag.secretReadsHidden", { ...params, field: context.labelOf(resolved.id) }, context.text),
          ruleIds: [rule.id]
        });
      }
    }
  }
  return diagnostics;
}

// --- the model -----------------------------------------------------------------------------

const FILTER_IDS: readonly LogicFilterId[] = ["all", "show", "require", "calculate", "steps", "journeys", "pdf"];

/**
 * Every rule of the form (editable) and of its journeys and PDF layouts (read-only, from
 * `options.definition`), as the Logic workspace lists them: in document order, then journeys,
 * then layouts; each with its sentence, group, the paths it reads; with the counts per filter,
 * the groups in display order, the steps strip and the cross-rule diagnostics.
 */
export function buildLogicModel(root: ComponentNode, options: LogicModelOptions = {}): LogicModel {
  return buildLogicModelIn(createWordContext(root, options), root, options);
}

/** The model and its words from one word context (the Logic surface paints with both). */
export function buildLogicModelAndWords(root: ComponentNode, options: LogicModelOptions = {}): { model: LogicModel; words: LogicWords } {
  const context = createWordContext(root, options);
  return { model: buildLogicModelIn(context, root, options), words: logicWordsIn(context) };
}

function buildLogicModelIn(context: WordContext, root: ComponentNode, options: LogicModelOptions): LogicModel {
  const rules: LogicRule[] = [];
  /** Each form rule's stored value, for the findings that read the text. */
  const sources = new Map<string, unknown>();
  for (const node of context.index.order) {
    if (!isRecord(node.rules)) {
      continue;
    }
    const nodeRules = node.rules as Record<string, unknown>;
    for (const key of LOGIC_RULE_KEYS) {
      const source = nodeRules[key];
      if (source === undefined || source === null) {
        continue;
      }
      const rule = formRule(node, key, source, context);
      rules.push(rule);
      sources.set(rule.id, source);
    }
  }
  const journeys = options.journeys ?? (options.definition !== undefined ? readJourneys(options.definition) : []);
  for (const journey of journeys) {
    rules.push(...journeyRules(journey, context, options.journeysEditable === true));
  }
  if (options.definition !== undefined) {
    rules.push(...pdfRules(options.definition, context));
  }

  const counts = Object.fromEntries(FILTER_IDS.map((filter) => [filter, 0])) as Record<LogicFilterId, number>;
  counts.all = rules.length;
  for (const rule of rules) {
    counts[rule.filter] += 1;
  }

  const used = new Set(rules.map((rule) => rule.group.id));
  const groups: LogicGroup[] = [];
  for (const node of context.index.order) {
    if (context.index.stepPosition.has(node.id) && used.has(`step:${node.id}`)) {
      groups.push(groupOf(`step:${node.id}`, context));
    }
  }
  for (const id of ["form", "steps", "journeys", "outputs"]) {
    if (used.has(id)) {
      groups.push(groupOf(id, context));
    }
  }

  const container = context.index.order.find((node) => node.type === STEPS_COMPONENT_TYPE);
  const steps = container
    ? stepNodesOf(container).map((step) => ({
        id: step.id,
        label: context.labelOf(step.id),
        ruleCount: rules.filter((rule) => rule.group.id === `step:${step.id}`).length,
        conditional: isRecord(step.rules) && step.rules.visibleWhen !== undefined
      }))
    : [];

  const diagnostics = [
    ...visibilityCycles(rules, context),
    ...invalidFormulas(rules, sources, context),
    ...(options.renameNotes ? renameUnparsed(rules, sources, options.renameNotes, context) : []),
    ...missingReads(rules, context),
    ...laterStepReads(rules, context),
    ...scopeFindings(rules, context)
  ];

  return { rules, counts, groups, steps, diagnostics, journeys: journeySummaries(journeys, context) };
}

/** The rules a filter shows: all of them for `all`. */
export function rulesForFilter(model: LogicModel, filter: LogicFilterId): LogicRule[] {
  return filter === "all" ? model.rules : model.rules.filter((rule) => rule.filter === filter);
}

/**
 * `root` with the path to `id` copied (new objects along the spine, siblings and everything
 * else shared with `root`), and the copy of the node `id`: what Try it writes one rule into
 * without cloning the whole tree. The preview runtime never writes into the tree it is given.
 */
export function withNodeCopy(root: ComponentNode, id: string): { root: ComponentNode; node: ComponentNode } | undefined {
  if (root.id === id) {
    const copy = { ...root };
    return { root: copy, node: copy };
  }
  for (const [slot, list] of Object.entries(root.children ?? {})) {
    for (let at = 0; at < list.length; at += 1) {
      const inner = withNodeCopy(list[at] as ComponentNode, id);
      if (inner) {
        const children = { ...root.children };
        const copied = [...list];
        copied[at] = inner.root;
        children[slot] = copied;
        return { root: { ...root, children }, node: inner.node };
      }
    }
  }
  return undefined;
}
