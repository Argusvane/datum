import type { Expression, RuleSource, RunScope } from "../../core/expressions/expression.js";
import { FORMULA_FUNCTION_NAMES } from "../../core/expressions/function-table.js";
import { DATA_GRID_COMPONENT_TYPE } from "../../core/schema/data-grid.js";
import type { ComponentRules } from "../../core/schema/types.js";
import { printFormula } from "../formula/feel-print.js";
import { FORM_ROOT_COMPONENT_TYPE } from "./inspector-model.js";
import { ruleRun, ruleText } from "./rule-source.js";

/**
 * Render-agnostic model behind the properties panel's Logic tab.
 *
 * A rule is stored as a formula string (the FEEL subset), as the expression tree the engine
 * evaluates, or as the object form `{ formula | expression, run }` that also says where it runs
 * (`RuleSource`). The tab edits every rule as text: a stored tree opens printed with ids
 * (`feel-print.ts`), a string as written, and the author's text is written back as a string
 * (or the object form, for a run scope other than both). A rule opened and left alone stays
 * byte for byte. The engine parses the text (`kernelParseFormula`); this module only shapes
 * what the tab shows and what the draft gets.
 */

export type RuleKey = keyof ComponentRules;

/** Whether a rule reads as a boolean test or produces a value. */
export type RuleKind = "condition" | "value";

export interface RuleDescriptor {
  /**
   * The rule's name on the tab: one of {@link RuleKey} for the rules the engine evaluates, or,
   * for a descriptor a builder mode supplies with a {@link target}, any name of the mode's own,
   * unique among the node's descriptors.
   */
  key: string;
  label: string;
  /**
   * What the rule does, under its heading. A mode's descriptor says here what the expression
   * may read, since that can differ from rule to rule (a journey route's condition sees its own
   * page and the ones before it).
   */
  description: string;
  kind: RuleKind;
  /**
   * Where the expression is stored, when it is not `rules[key]`: a property of the node's
   * configuration (a journey route's `when`), read and written through the draft's
   * configuration like any other property. Absent: `rules[key]`, as for the form.
   */
  target?: { propertyPath: string } | undefined;
}

/** Every rule the engine evaluates, in the order the panel lists them. */
export const RULE_DESCRIPTORS: readonly RuleDescriptor[] = [
  {
    key: "visibleWhen",
    label: "Visible when",
    description: "The component is hidden unless this is true.",
    kind: "condition"
  },
  {
    key: "requiredWhen",
    label: "Required when",
    description:
      "Makes the component required while this is true, on top of Required. Checked in the browser and by the server (a rule reading host. only in the browser).",
    kind: "condition"
  },
  {
    key: "enabledWhen",
    label: "Enabled when",
    description: "The component is disabled unless this is true.",
    kind: "condition"
  },
  {
    key: "readonlyWhen",
    label: "Read-only when",
    description: "The component becomes read-only while this is true.",
    kind: "condition"
  },
  {
    key: "value",
    label: "Calculated value",
    description: "Recomputes the value from other fields. The author cannot type over it.",
    kind: "value"
  },
  {
    key: "defaultValue",
    label: "Default value",
    description: "Applied only while the value is still empty.",
    kind: "value"
  },
  {
    key: "filter",
    label: "Option filter",
    description: "Keeps only the options/rows this is true for.",
    kind: "condition"
  },
  {
    key: "navigationGating",
    label: "Navigation gating",
    description: "On a wizard step: navigation is blocked unless this is true.",
    kind: "condition"
  }
];

/**
 * The Validate rule, listed after "Required when" where the caller says the fold
 * reads it ({@link ApplicableRulesOptions.offersValid}). Kept out of {@link RULE_DESCRIPTORS},
 * which the Logic list reads with `validWhen` already placed after `requiredWhen`.
 */
export const VALID_WHEN_DESCRIPTOR: RuleDescriptor = {
  key: "validWhen",
  label: "Valid when",
  description:
    "True means the answer is accepted. Otherwise the field shows its rule message (configuration.messages.rule); an empty answer is not checked. Checked in the browser and by the server.",
  kind: "condition"
};

/**
 * A data grid's row-count bounds as formulas (`rules.minRows` / `rules.maxRows`):
 * offered for the type `dataGrid` alone, after the other rules, since no other component's
 * fold reads them. They are values (a number), not conditions, and evaluate form-scoped: a
 * row's answers (`row.`) are not in scope because the bound belongs to the whole grid.
 */
export const MIN_ROWS_DESCRIPTOR: RuleDescriptor = {
  key: "minRows",
  label: "Minimum rows formula",
  description:
    "A formula giving the fewest rows; reads form answers, never row. A whole number from 0 wins over the Minimum rows box; anything else leaves that box in force.",
  kind: "value"
};

export const MAX_ROWS_DESCRIPTOR: RuleDescriptor = {
  key: "maxRows",
  label: "Maximum rows formula",
  description:
    "A formula giving the most rows; reads form answers, never row. A whole number from 0 wins over the Maximum rows box; anything else leaves that box in force.",
  kind: "value"
};

/** The rules only a data grid offers, in the order the panel lists them. */
export const DATA_GRID_ROW_BOUND_DESCRIPTORS: readonly RuleDescriptor[] = [MIN_ROWS_DESCRIPTOR, MAX_ROWS_DESCRIPTOR];

export const RULE_DESCRIPTOR_BY_KEY: ReadonlyMap<string, RuleDescriptor> = new Map(
  [...RULE_DESCRIPTORS, VALID_WHEN_DESCRIPTOR, ...DATA_GRID_ROW_BOUND_DESCRIPTORS].map((descriptor) => [descriptor.key, descriptor])
);

/**
 * The rules that take effect on the form root. Its visibility, enablement and read-only state
 * fold into every descendant (`core/state/effective-state.ts`), which is what makes them
 * form-wide gates — "read-only once submitted", "disabled until consent is given". The rest
 * act on a node's own value, its options, or a wizard step, none of which the root has, so
 * offering them there would be offering settings that can never take effect.
 */
const ROOT_RULE_KEYS: ReadonlySet<string> = new Set<RuleKey>([
  "visibleWhen",
  "enabledWhen",
  "readonlyWhen"
]);

export interface ApplicableRulesOptions {
  /**
   * Whether the component can be required at all: it holds an answer of its own,
   * sits in no repeating section, and its definition offers Required. `false` leaves "Required
   * when" out — the fold never reads such a rule (a group, a static block, a row field) or
   * cannot tell the component from a field (a plugin's display component), so offering it
   * would promise a check that is not made. Default `true`; the panel, which knows the node
   * and the registry, decides (`datum-builder-properties`).
   */
  offersRequired?: boolean;
  /**
   * Whether the component holds data of its own: a field, a
   * data-scoping container, a repeating section, a data grid — the kernel's
   * `kernelClaimsData`. `false` leaves out "Calculated value" and "Default value": static HTML,
   * a button, an image or a plain group defines no key, so neither the browser nor a server
   * works such a rule out, and nothing draws the result. Default `true`; the panel, which knows
   * the node, decides.
   */
  holdsData?: boolean;
  /**
   * Whether "Valid when" is listed, after "Required when": where the fold reads it,
   * as for `requiredWhen` (a component holding an answer of its own, outside any repeating
   * section), or where the component already carries one. Default `false`: only the panel,
   * which knows the node, offers it.
   */
  offersValid?: boolean;
}

/** The rules that produce a value: offered only on a component that holds data. */
const VALUE_RULE_KEYS: ReadonlySet<string> = new Set<RuleKey>(["value", "defaultValue"]);

/**
 * The rules the Rules tab offers for a component of `componentType`, in
 * {@link RULE_DESCRIPTORS} order. A rule already authored under a key this leaves out is not
 * touched: the panel edits one rule at a time and leaves the others as they are.
 */
export function applicableRuleDescriptors(
  componentType: string,
  options: ApplicableRulesOptions = {}
): readonly RuleDescriptor[] {
  if (componentType === FORM_ROOT_COMPONENT_TYPE) {
    return RULE_DESCRIPTORS.filter((descriptor) => ROOT_RULE_KEYS.has(descriptor.key));
  }
  const offered =
    options.offersRequired === false || options.holdsData === false
      ? RULE_DESCRIPTORS.filter(
          (descriptor) =>
            !(options.offersRequired === false && descriptor.key === "requiredWhen") &&
            !(options.holdsData === false && VALUE_RULE_KEYS.has(descriptor.key))
        )
      : RULE_DESCRIPTORS;
  const withValid = options.offersValid === true ? withValidWhen(offered) : offered;
  // The grid's row-bound formulas follow the other rules; chosen by the type, as
  // the Rows section is, never by a property name another component might share.
  return componentType === DATA_GRID_COMPONENT_TYPE ? [...withValid, ...DATA_GRID_ROW_BOUND_DESCRIPTORS] : withValid;
}

/** `descriptors` with "Valid when" after "Required when", or after the conditions before the value rules when that is not listed. */
function withValidWhen(descriptors: readonly RuleDescriptor[]): readonly RuleDescriptor[] {
  const after = descriptors.findIndex((descriptor) => descriptor.key === "requiredWhen");
  const at = after >= 0 ? after + 1 : Math.max(0, descriptors.findIndex((descriptor) => descriptor.key === "enabledWhen"));
  return [...descriptors.slice(0, at), VALID_WHEN_DESCRIPTOR, ...descriptors.slice(at)];
}

// --- values as typed ---------------------------------------------------------------------

/**
 * `"true"` / `"false"` become booleans and a numeric string becomes a number, so a comparison
 * against a checkbox or a number field is typed the way the evaluator expects. Anything else
 * stays a string. Ordering comparisons (`gt`…`lte`) coerce numerically in the evaluator
 * regardless, so only equality is sensitive to this. Kept for the Logic model's value boxes.
 */
export function parseConditionValue(raw: string): string | number | boolean | null {
  const text = raw.trim();
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  if (text === "null") {
    return null;
  }
  if (text !== "" && Number.isFinite(Number(text))) {
    return Number(text);
  }
  return raw;
}

/** The inverse of {@link parseConditionValue}, for populating a value box. */
export function formatConditionValue(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}

// --- raw expression JSON ---------------------------------------------------

const EXPRESSION_KINDS = new Set([
  "literal",
  "path",
  "unary",
  "binary",
  "logical",
  "arithmetic",
  "call",
  "if"
]);

/**
 * Structural guard for a hand-authored expression. Deliberately shallow-but-recursive: it
 * checks the shape the evaluator switches on, so a typo like `{"kind":"pathh"}` is reported at
 * Save rather than silently evaluating to `undefined` at runtime. A call must name a built-in
 * or one of `knownFunctions` (the plugin functions the host wired); with none given, built-ins
 * only.
 */
export function isExpression(value: unknown, knownFunctions?: Iterable<string>): value is Expression {
  const known =
    knownFunctions === undefined ? undefined : knownFunctions instanceof Set ? (knownFunctions as ReadonlySet<string>) : new Set(knownFunctions);
  return expressionShape(value, known);
}

function expressionShape(value: unknown, known: ReadonlySet<string> | undefined): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const node = value as Record<string, unknown>;
  const kind = node.kind;
  if (typeof kind !== "string" || !EXPRESSION_KINDS.has(kind)) {
    return false;
  }
  switch (kind) {
    case "literal": {
      const literal = node.value;
      return (
        literal === null ||
        typeof literal === "string" ||
        typeof literal === "number" ||
        typeof literal === "boolean"
      );
    }
    case "path":
      return typeof node.path === "string" && node.path.length > 0;
    case "unary":
      return node.operator === "not" && expressionShape(node.operand, known);
    case "binary":
    case "logical":
    case "arithmetic":
      return typeof node.operator === "string" && expressionShape(node.left, known) && expressionShape(node.right, known);
    case "call":
      return (
        typeof node.name === "string" &&
        (FORMULA_FUNCTION_NAMES.has(node.name) || (known !== undefined && known.has(node.name))) &&
        Array.isArray(node.args) &&
        node.args.every((arg) => expressionShape(arg, known))
      );
    case "if":
      return (
        Array.isArray(node.cases) &&
        node.cases.every(
          (entry) =>
            !!entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            expressionShape((entry as Record<string, unknown>).when, known) &&
            expressionShape((entry as Record<string, unknown>).then, known)
        ) &&
        (node.else === undefined || expressionShape(node.else, known))
      );
    default:
      return false;
  }
}

export type ExpressionParseResult =
  | { ok: true; expression: Expression | undefined }
  | { ok: false; error: string };

/** Parses the JSON-mode textarea. Blank clears the rule. */
export function parseExpressionJson(text: string): ExpressionParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: true, expression: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON." };
  }
  if (!isExpression(parsed)) {
    return { ok: false, error: "Not a valid expression: every node needs a known \"kind\"." };
  }
  return { ok: true, expression: parsed };
}

export function formatExpressionJson(expression: Expression | undefined): string {
  return expression ? JSON.stringify(expression, null, 2) : "";
}

// --- per-rule editor state -------------------------------------------------

/** Off, or written as a formula. Save stays open either way. */
export type RuleEditorMode = "off" | "formula";

export interface RuleEditorState {
  key: string;
  descriptor: RuleDescriptor;
  mode: RuleEditorMode;
  /**
   * The formula as the box holds it: a stored string as written, a stored tree printed with
   * ids (`printFormula`), or what the author has typed since.
   */
  text: string;
  /** Where the rule runs; `both` when the rule says nothing. */
  run: RunScope;
  /** Why the text holds no rule yet: the parse error in words, under the box and in the summary above Save. */
  problem: string | undefined;
}

/** What the panel holds for a rule between paints: the author's choices over what the draft says. */
export interface RuleEditorWorking {
  mode?: RuleEditorMode | undefined;
  text?: string | undefined;
  problem?: string | undefined;
}

/**
 * The Runs control a rule gets: a choice of the four scopes; a fixed "Browser" chip for the
 * keys the server never applies (defaults, option filters, step gates: a non-browser scope is a
 * compile problem); none for a builder mode's own rule stored elsewhere (a journey page's or a
 * PDF layout's `when` keep their sides by design).
 */
export type RuleRunControl = "choice" | "browser" | "none";

/** The rule keys only the browser applies (a server never applies a default, filters no option, gates no step). */
export const BROWSER_ONLY_RULE_KEYS: ReadonlySet<string> = new Set<RuleKey>(["defaultValue", "filter", "navigationGating"]);

export function ruleRunControl(descriptor: RuleDescriptor): RuleRunControl {
  if (descriptor.target) {
    return "none";
  }
  return BROWSER_ONLY_RULE_KEYS.has(descriptor.key) ? "browser" : "choice";
}

/** The tree a stored rule holds as written, when it holds one (a formula string holds none until parsed). */
function storedTree(source: unknown): Expression | undefined {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  if (typeof record.kind === "string") {
    return source as Expression;
  }
  if (typeof record.formula !== "string" && typeof record.expression === "object" && record.expression !== null) {
    return record.expression as Expression;
  }
  return undefined;
}

/** A stored tree as formula text, one case per line for a value rule; a tree the printer cannot word falls back to its JSON. */
function printedTree(tree: Expression, descriptor: RuleDescriptor): string {
  try {
    return printFormula(tree, { multiline: descriptor.kind === "value" });
  } catch {
    return formatExpressionJson(tree);
  }
}

/**
 * The formula text a stored rule opens as: a string as written (bare or in the object form),
 * else its tree printed with ids, never labels. Blank for no rule.
 */
export function ruleEditorText(source: unknown, descriptor: RuleDescriptor): string {
  const text = ruleText(source);
  if (text !== undefined) {
    return text;
  }
  const tree = storedTree(source);
  return tree ? printedTree(tree, descriptor) : "";
}

/**
 * The editor state for one rule as it stands on the node, with the panel's working copy laid
 * over it: the author's mode choice (Formula over an empty box, say) and the text as typed.
 * The rule is named by its key, for one the engine evaluates, or given as a whole descriptor
 * (a builder mode's own, stored where its `target` says).
 */
export function buildRuleEditorState(
  rule: string | RuleDescriptor,
  source: unknown,
  working: RuleEditorWorking = {}
): RuleEditorState {
  const descriptor = typeof rule === "string" ? RULE_DESCRIPTOR_BY_KEY.get(rule) : rule;
  if (!descriptor) {
    throw new Error(`Unknown rule: ${String(rule)}`);
  }
  const stored = ruleEditorText(source, descriptor);
  const text = working.text ?? stored;
  const mode = working.mode ?? (stored !== "" || storedTree(source) !== undefined ? "formula" : "off");
  return {
    key: descriptor.key,
    descriptor,
    mode,
    text,
    run: ruleRun(source),
    problem: working.problem
  };
}

/**
 * What the draft stores for `text` under run scope `run`, given what the form holds for the
 * rule (`stored`: the committed rule, never the draft's, which a first keystroke has already
 * turned into a string): blank text is no rule; text that still prints the stored tree keeps
 * that tree as written, bare for both sides, else as `{ expression, run }`, so a rule opened and
 * left alone stays byte for byte and one typed into and typed back is a tree again; anything
 * else is the formula string, bare when it runs on both sides, else `{ formula, run }`.
 */
export function composeRuleSource(stored: unknown, text: string, run: RunScope): RuleSource | undefined {
  if (text.trim() === "") {
    return undefined;
  }
  const tree = storedTree(stored);
  if (tree && (printFormula(tree) === text || printFormula(tree, { multiline: true }) === text)) {
    return run === "both" ? tree : { expression: tree, run };
  }
  return run === "both" ? text : { formula: text, run };
}

/**
 * Whether `value` is a rule as stored: a formula string, a tree ({@link isExpression}), or the
 * object form with a formula or a tree and, when given, a known run scope.
 */
export function isRuleSourceShape(value: unknown, knownFunctions?: Iterable<string>): value is RuleSource {
  if (typeof value === "string") {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.kind === "string") {
    return isExpression(value, knownFunctions);
  }
  const hasFormula = typeof record.formula === "string";
  const hasTree = record.expression !== undefined;
  if (!hasFormula && !hasTree) {
    return false;
  }
  if (hasTree && !isExpression(record.expression, knownFunctions)) {
    return false;
  }
  return record.run === undefined || (typeof record.run === "string" && RUN_SCOPES.has(record.run));
}

const RUN_SCOPES: ReadonlySet<string> = new Set<RunScope>(["both", "browser", "server", "server-secret"]);

/** Writes one rule into a rules object, dropping the key when there is no rule. */
export function withRule(
  rules: ComponentRules | undefined,
  key: RuleKey,
  source: RuleSource | undefined
): ComponentRules | undefined {
  const next: ComponentRules = { ...(rules ?? {}) };
  if (source !== undefined) {
    next[key] = source;
  } else {
    delete next[key];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
