import { kernelRuleExpression, kernelRuleRun } from "../expressions/compile.js";
import { isEvaluableExpression, isScopedExpressionPath as isScopedPath } from "../expressions/condition-shape.js";
import type { Expression, RunScope } from "../expressions/expression.js";
import { kernelParseFormula } from "../expressions/formula.js";
import { FORMULA_FUNCTION_TABLE, formulaFunctionSignatures } from "../expressions/function-table.js";
import type { ComponentNode } from "../schema/types.js";
import {
  PRESENTATION_REFERENCE_TYPE,
  PRESENTATION_VALUE_TYPE,
  journeyPageValidation,
  readJourneys,
  type Journey,
  type JourneyPage,
  type PresentationNode
} from "../schema/journey.js";
import { STEP_COMPONENT_TYPE } from "../schema/steps.js";
import { kernelReadFlag } from "../state/semantic-state.js";
import { kernelFoldRequiredReadsHost, kernelFoldVisibilityReadsHost } from "../state/submittable-fold.js";
import { isValidComponentId } from "../tree/component-id.js";
import { collectionPathOf, holdsData } from "../tree/data-scope.js";
import { extractDependencies } from "../../rules/dependencies/dependency-extractor.js";
import { kernelExprReadsClock, kernelExprReadsHost } from "../../rules/evaluator/evaluator.js";
import {
  journeyFormKeys,
  journeyOwnNodeRule,
  journeyEntryPlacesForm,
  journeyOwnership,
  journeyStaticGraph,
  journeyTargetUsable
} from "./journey-path.js";
import {
  journeyHoldsOwnAnswer,
  journeyLeadingSegment,
  journeyOwn
} from "./journey-shared.js";

/**
 * What is wrong with a journey as written, for the builder to show beside it and
 * `<datum-form debug>` to log when a journey starts. Findings, never throws: a journey with
 * errors still runs — the path engine passes over what it cannot follow (an unknown or
 * backward route, a component the form does not have) — but it will not do what its author
 * meant.
 *
 * Errors are journeys that cannot work as written; warnings are journeys that work but
 * probably not as intended (a page no path reaches, a condition that can only ever read an
 * unanswered question).
 *
 * **Presentations.** A page may hold nodes of its own beside the component ids it
 * lists. Where they stand is never worked out here: every finding reads the one ownership the
 * browser and the server share (`journeyOwnership`) and the usability rules behind it
 * (`journeyOwnNodeRule`, `journeyTargetUsable`, `journeyHoldsOwnAnswer`), so a form field a
 * page references, fills through an alias or works out is on that page for every check — never
 * left out, never unknown. A
 * condition or a form rule reading an own field, which no side can follow, is an error
 * (`condition.reads-presentation-field`, `rule.reads-presentation-field`).
 *
 * **The nodes of a page's own** are judged node by node, each finding
 * naming the node it is about (`ownNodeId`) for the designer to draw it there. A node a
 * usability rule ignores is an error under the code that says why — an id that is not its own
 * (`field.id-clash`), a type or a data binding a page cannot hold (`field.unsupported-type`,
 * `field.data-binding`), a reference naming nothing (`page.unknown-component`), an unknown,
 * unusable or already placed target (`map.unknown-target`, `map.target-unusable`,
 * `map.target-conflict`) — and `presentation.entry-unusable` for the rest (an id outside the
 * grammar, `fills` on a node holding no answer, the journey's own id, a key the form uses). An
 * entry a rule drops is said for why it is dropped alone. Beside the rules: an alias or a
 * worked-out value of another shape or with choices its field lacks, a worked-out value reading
 * what is not its page's own or none of its page's own fields, sources that may all hide a
 * required field, a visibility that
 * would hide a form field, a field hidden for good, an own field kept in the browser only, a
 * form field placed twice on one page, an own rule reading nothing, a page that may draw
 * nothing though the path keeps it, a path turning on a value worked out in the browser, and a
 * key of the form's own data under `@`. Each says what the runtime and the kernel do, and
 * `journey-diagnostics-own-nodes.test.ts` holds each to it.
 *
 * **Formulas, the clock and run scopes.** A rule or a condition may be written as a tree, as a
 * formula string or as the object form with a `run` scope (`RuleSource`); every read here goes
 * through {@link ruleOf}, so a formula is diagnosed as its tree is and one that does not parse
 * reads as no rule, which is how every runtime reads it. A rule reading `today()` or `age()` is
 * judged by whichever clock the side that runs it has (`rule.reads-clock`,
 * `condition.reads-clock`). A rule the server alone runs (`run: "server"` or `"server-secret"`)
 * that reads `host.` can never run, and one reading the clock runs only when the host gives the
 * server a day (`rule.server-cannot-run`); a browser-only required rule is not enforced by the
 * server (`rule.browser-only-required`); a secret rule reading a field a browser-only rule may
 * hide reads what the browser kept or dropped (`rule.secret-reads-browser-hidden`).
 */

export type JourneyDiagnosticCode =
  // Errors
  | "journey.duplicate-id"
  | "journey.no-end"
  | "page.duplicate-id"
  | "page.id-is-component-id"
  | "page.unknown-component"
  | "page.root-component"
  // Check answers (`kind: "review"`): one per journey, the last page before the end, asking no
  // form field of its own
  | "page.review-repeated"
  | "page.review-not-last"
  | "page.review-form-field"
  | "page.review-bypassed"
  | "route.unknown-target"
  | "route.backward"
  | "condition.scope"
  | "condition.invalid"
  // A condition, or a rule of the form, reading a field the journey's pages own
  | "condition.reads-presentation-field"
  | "rule.reads-presentation-field"
  // A required field hidden on the form for good, which no page can ask
  | "component.hidden-required"
  // A required calculation empty for want of an input the journey never asks; a
  // warning when the input's default answers
  | "calc.input-left-out"
  // A node of the journey's own that a usability rule has ignored, on both sides, where no
  // code below says why
  | "presentation.entry-unusable"
  // The nodes of the journey's own: ids, types and data bindings a page
  // cannot hold as its own; what an alias fills and a worked-out value sets; a visibility rule
  // that would hide a form field; a key of the form's own data under `@`
  | "field.id-clash"
  | "field.unsupported-type"
  | "field.data-binding"
  | "map.unknown-target"
  | "map.target-unusable"
  | "map.target-conflict"
  | "map.shape-mismatch"
  | "map.options-not-subset"
  | "map.reads-other-page"
  | "map.sources-conditional"
  // A worked-out value reading none of its page's own fields, so worked out only once an
  // unrelated one is answered, if ever: an error for a field the form requires
  // outright, else a warning
  | "map.reads-no-source"
  | "own.hides-form-field"
  // Warnings (`component.unassigned` is an error for a required field)
  // A form collection path or data path under `@`, where presentations keep their answers
  | "data-key.reserved-prefix"
  | "component.unassigned"
  | "presentation.fields-left-out"
  | "component.multiple-pages"
  // A form field a page shows twice: listed, referenced or filled more than once on it
  | "component.placed-twice"
  // An own field of the journey that fills no form field and feeds no worked-out value
  | "field.goes-nowhere"
  | "map.target-hidden"
  // A route's condition reading a value worked out in the browser
  | "condition.reads-client-derived"
  // A rule of a node of the journey's own reading what it can never read
  | "rule.unknown-field"
  | "page.unreachable"
  // Not reported when the journey hides its page headings: no heading shows the id
  | "page.no-title"
  | "page.entry-field"
  | "page.validation-server-deferred"
  | "page.validation-on-exit"
  | "route.shadowed"
  | "condition.unknown-field"
  | "condition.reads-later-page"
  | "calc.reads-branch"
  | "rule.reads-host"
  // A rule, or a condition, reading today() or age(): the server judges it by its own clock
  | "rule.reads-clock"
  | "condition.reads-clock"
  // A server-only or secret rule reading host. (an error: it never runs) or the clock (a
  // warning: it runs only when the host gives the server a day)
  | "rule.server-cannot-run"
  // A browser-only required rule, which the server does not enforce
  | "rule.browser-only-required"
  // A required field whose own or inherited visibility is browser-only: the server demands what the browser hid
  | "rule.browser-only-visibility"
  // A secret rule reading a field a browser-only rule may hide, which the server never runs
  | "rule.secret-reads-browser-hidden";

export interface JourneyDiagnostic {
  severity: "error" | "warning";
  code: JourneyDiagnosticCode;
  journeyId: string;
  pageId?: string;
  /**
   * The page's position in the journey's `pages`, 0-based: what tells two pages sharing an id
   * apart (a finding is about the page at this position, not the first with its id).
   */
  pageIndex?: number;
  /** The route's position in its page's `routes`, 0-based. */
  routeIndex?: number;
  componentId?: string;
  /**
   * On `component.unassigned`: the form requires the field — Required, or a
   * Required-when rule — so a submission through the journey can never pass while it is asked
   * on no page (the server holds every answer to the form's rules, asked or not). An error.
   * False for a required field answered by a non-empty literal `rules.defaultValue`, which the
   * form's rule is met by without asking, and for one held to its Required only as the host
   * decides (`hostBound`): neither side holds such a field to that rule while it is on no page,
   * since the server cannot replay the host, so it is a warning that says so rather than a
   * blocking error. True too on `component.hidden-required` (the field is on a page, or beside
   * a field a page can ask, and still blocks) and on a `calc.input-left-out` error, where the
   * component is the input on no page — what "Ask it here" adds — and the form requires the
   * calculation worked out from it.
   */
  required?: boolean;
  /**
   * With `required`: the field whose Required makes it so — the component itself, or, for a
   * container reported whole with what it holds, the first field in it that the form holds to
   * its Required (one a page can ask, when there is one); on `calc.input-left-out`, the
   * calculated field. What "Make it optional on the form" opens.
   */
  requiredField?: string;
  /**
   * With `required`: the field whose Required it is is hidden on the form with no rule to show
   * it (and opts in to being required and validated while hidden), so no page can ask it:
   * putting it, or the container it sits in, on a page changes nothing — the host or a default
   * fills it, or the form makes it optional. The tray offers no "Ask it here" for it.
   */
  hidden?: boolean;
  /**
   * On `component.unassigned`: the field — or, for a container reported whole, a required
   * field in it — is on no page and its visibility (its own rule's or an ancestor's, the fold's
   * `kernelFoldVisibilityReadsHost`) or its own Required-when rule (`kernelFoldRequiredReadsHost`)
   * reads `host.`, which the server cannot replay: neither side holds it to that rule through
   * this journey. What the tray qualifies its "the server still holds their answers" by.
   */
  hostBound?: boolean;
  /**
   * On `presentation.entry-unusable`: the id of the entry of the page the finding is
   * about — the node written on the page, which may hold the one that breaks the rule. Absent
   * when the entry has no usable id to go by.
   */
  entryId?: string;
  /**
   * On a finding about a node of the journey's own: that node's id, as written on the
   * page — what the designer draws the finding on. For a reference inside an own layout (which
   * has no id of its own), the id of the own node holding it, with `componentId` the form
   * component it names. Absent on a finding about the journey, a page, a route or a form
   * component, and when neither the node nor anything around it has a usable id.
   */
  ownNodeId?: string;
  /**
   * With `ownNodeId`, when nodes of the journey's own on the finding's page share that id (rule
   * A drops every one after the first): how many of them come before the node the finding is
   * about, in document order — absent for the first. What a designer drawing each of those
   * nodes tells their findings apart by.
   */
  ownNodeRepeat?: number;
  /**
   * On a finding about a node a usability rule ignores, by the rule's letter. A, B,
   * C, H or I drops the whole entry (an id that is not the node's own, a type or a data binding
   * a presentation cannot hold, a journey id a component could not have, an answer that would
   * live under a key the form uses); D skips a reference naming no form component; E and F
   * leave an alias filling nothing, and E or G a worked-out value ignored. Carried by
   * `presentation.entry-unusable` and by the codes that now say why: `field.id-clash` (A),
   * `field.unsupported-type` (B), `field.data-binding` (C), `page.unknown-component` and
   * `page.root-component` of a reference in an own layout (D), `map.unknown-target` and
   * `map.target-unusable` (E), `map.target-conflict` (G).
   */
  rule?: JourneyUsabilityRule;
  message: string;
}

/** The usability rules a presentation's own node can break, by letter. */
export type JourneyUsabilityRule = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I";

type DiagnosticPlace = Partial<
  Pick<
    JourneyDiagnostic,
    "pageId" | "pageIndex" | "routeIndex" | "componentId" | "required" | "requiredField" | "hidden" | "hostBound" | "entryId" | "ownNodeId" | "ownNodeRepeat" | "rule"
  >
>;

/** What {@link diagnoseJourney} is told beside the journey. */
export interface JourneyDiagnosticOptions {
  /**
   * Which components hold no answer beyond the engine's own valueless types (a plugin's link,
   * say): the builder's `isValueless`. A node of the journey's own of such a type is never said
   * to go nowhere (`field.goes-nowhere`). What the runtime and the kernel place is unchanged.
   */
  isValueless?: ((node: ComponentNode) => boolean) | undefined;
}

/** What each built-in function comes to, by name, as the function table says. */
const FUNCTION_RETURNS: ReadonlyMap<string, string> = new Map(FORMULA_FUNCTION_TABLE.map((row) => [row.name, row.returns]));
/**
 * The number functions that come to no answer when an argument does (the evaluator's
 * `kernelExprUnaryNumber` and the number group): a `coalesce` passes over them as it passes
 * over a bare path. `sum`, `min`, `max`, `avg` and `count` are not here: they leave an empty
 * item out and come to a number.
 */
const NUMBER_OF_ONE: ReadonlySet<string> = new Set(["abs", "round", "floor", "ceil", "roundTo", "roundUp", "roundDown", "sqrt", "power", "modulo", "clamp", "number"]);
/** The built-ins' arities, for the parser; read only. */
const FORMULA_SIGNATURES = formulaFunctionSignatures();

/**
 * The tree a rule or a condition stands for, however it is written (a tree, a formula string,
 * the object form), or `undefined` when there is none the evaluator can run: a formula that
 * does not parse, or a hand-edited tree with a misspelt operator, reads as no rule, as it does
 * at run time.
 */
function ruleOf(source: unknown): Expression | undefined {
  const expression = kernelRuleExpression(source, kernelParseFormula, FORMULA_SIGNATURES);
  return expression !== undefined && isEvaluableExpression(expression) ? expression : undefined;
}

/**
 * Whether a text has any words in it. A definition text is a plain string in the form's default
 * language; a translation never stands in for a missing default, so only the
 * string counts.
 */
function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function labelOf(node: { configuration?: unknown } | undefined): unknown {
  const configuration = node?.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration)
    ? (configuration as Record<string, unknown>).label
    : undefined;
}

/**
 * Whether a value is an empty answer for a component of `type`: the reading of `isEmptyValue`
 * (`validation/core/field-constraints.ts`) and the kernel's `kernelIsEmptyValue` (which lives
 * in `schema/answer-kinds.ts` and the kernel re-exports), which decide
 * `required` on both sides — anything but `true` on a checkbox, blank text and an empty list are
 * empty, a `0` is not. Mirrored here rather than imported: the validation layer imports the core, and
 * the diagnostics are a chunk of their own. `journey-diagnostics.test.ts` pins that the three
 * agree.
 */
export function journeyEmptyAnswer(value: unknown, type: string): boolean {
  if (type === "checkbox") {
    return value !== true;
  }
  if (type === "checkboxes") {
    return (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.values(value as Record<string, unknown>).some((entry) => entry === true)
    );
  }
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

const emptyAnswer = journeyEmptyAnswer;

function quotedList(ids: readonly string[]): string {
  const quoted = ids.map((id) => `"${id}"`);
  if (quoted.length <= 1) {
    return quoted.join("");
  }
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/** The tree, indexed once. */
interface TreeIndex {
  root: ComponentNode;
  order: ComponentNode[];
  nodeById: Map<string, ComponentNode>;
  parentOf: Map<string, string>;
}

function indexTree(root: ComponentNode): TreeIndex {
  const order: ComponentNode[] = [];
  const nodeById = new Map<string, ComponentNode>();
  const parentOf = new Map<string, string>();
  const walk = (node: ComponentNode): void => {
    order.push(node);
    nodeById.set(node.id, node);
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group ?? []) {
        parentOf.set(child.id, node.id);
        walk(child);
      }
    }
  };
  walk(root);
  return { root, order, nodeById, parentOf };
}

function ancestorsOf(index: TreeIndex, componentId: string): ComponentNode[] {
  const out: ComponentNode[] = [];
  let parent = index.parentOf.get(componentId);
  while (parent !== undefined) {
    const node = index.nodeById.get(parent);
    if (node) {
      out.push(node);
    }
    parent = index.parentOf.get(parent);
  }
  return out;
}

/** Whether a form component may be hidden by its own configuration or rules, or an ancestor's. */
function chainMayBeHidden(index: TreeIndex, componentId: string): boolean {
  const chain = [index.nodeById.get(componentId), ...ancestorsOf(index, componentId)];
  return chain.some((node) => node !== undefined && (kernelReadFlag(node.configuration, "hidden") || node.rules?.visibleWhen !== undefined));
}

/**
 * Whether a form component is always hidden: it or an ancestor is hidden by its configuration
 * with no rule to show it (the runtime starts from `hidden`, and only `visibleWhen` overrides it).
 */
function chainAlwaysHidden(index: TreeIndex, componentId: string): boolean {
  const chain = [index.nodeById.get(componentId), ...ancestorsOf(index, componentId)];
  return chain.some((node) => node !== undefined && kernelReadFlag(node.configuration, "hidden") && node.rules?.visibleWhen === undefined);
}

/**
 * The shape of the answer a component of an engine type holds (`map.shape-mismatch`):
 * text, one of a list of choices (`select`, `radio`), a list of ticked choices (`checkboxes`),
 * a number, a date (`YYYY-MM-DD`, kind-checked on both sides) or a tick. `undefined`
 * for any other type — a plugin's, whose answer nothing here knows.
 */
type ValueShape = "text" | "choice" | "list" | "number" | "date" | "boolean";

const SHAPE_OF_TYPE: Record<string, ValueShape> = {
  text: "text",
  textarea: "text",
  select: "choice",
  radio: "choice",
  checkboxes: "list",
  number: "number",
  date: "date",
  checkbox: "boolean"
};

function shapeOfType(type: unknown): ValueShape | undefined {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(SHAPE_OF_TYPE, type) ? SHAPE_OF_TYPE[type] : undefined;
}

/** What JSON carries an answer of a shape as: a choice and a date are text there. */
function jsonShape(shape: ValueShape): "text" | "list" | "number" | "boolean" {
  return shape === "choice" || shape === "date" ? "text" : shape;
}

/**
 * Whether an answer of shape `from` is one a field of shape `to` can hold: the same shape, or
 * any text-like answer (a choice, a date) in a text field. A free text into a list of choices,
 * a number into text, a tick into anything else do not fit.
 */
function shapeFits(from: ValueShape, to: ValueShape): boolean {
  return from === to || (to === "text" && (from === "choice" || from === "date"));
}

const SHAPE_WORDS: Record<ValueShape, string> = {
  text: "text",
  choice: "one of a list of choices",
  list: "a list of ticked choices",
  number: "a number",
  date: "a date",
  boolean: "a tick (yes or no)"
};

/** The values of a choice component's inline options (`configuration.options`), in order. */
function optionValuesOf(configuration: unknown): string[] {
  const options = isRecord(configuration) ? configuration.options : undefined;
  if (!Array.isArray(options)) {
    return [];
  }
  const values: string[] = [];
  for (const option of options) {
    if (isRecord(option) && typeof option.value === "string") {
      values.push(option.value);
    }
  }
  return values;
}

/** Whether a component takes its options from a data source (`configuration.data.sourceId`). */
function namesDataSource(configuration: unknown): boolean {
  const data = isRecord(configuration) ? configuration.data : undefined;
  return isRecord(data) && typeof data.sourceId === "string" && data.sourceId !== "";
}

/**
 * Whether an own field of `type` with `configuration` may fill the form field `target`
 * without `map.shape-mismatch` or `map.options-not-subset`: the same tests
 * `diagnoseJourney` applies to an alias in use, for the designer's "Fills form field" picker.
 * A type whose answer nothing here knows (a plugin's) fits anything, as it is never reported.
 */
export function journeyAliasFits(type: string, configuration: unknown, target: ComponentNode): boolean {
  const from = shapeOfType(type);
  const to = shapeOfType(target.type);
  if (from === undefined || to === undefined) {
    return true;
  }
  if (!shapeFits(from, to)) {
    return false;
  }
  if ((from === "choice" || from === "list") && from === to && !namesDataSource(target.configuration)) {
    const has = optionValuesOf(target.configuration);
    return optionValuesOf(configuration).every((value) => has.indexOf(value) >= 0);
  }
  return true;
}

/**
 * The walk the path engine can take through a journey, conditions aside: from each page, the
 * ways the walk may leave it. Every page the walk arrives at is on the path, shown even when
 * nothing on it shows (a page has no condition of its own, and is never passed over); it leaves
 * by its own static-graph edges (its forward routes up to the first unconditional one, then the
 * fall-through), by position, as the path engine takes them; an exit page ends the walk, and a
 * review page leaves only for the end.
 */
interface WalkGraph {
  /** The number of pages; index `count` is the journey's end. */
  count: number;
  exit: boolean[];
  /** Page index -> the indexes the walk may go to after the page (`count` is the end). */
  next: number[][];
}

function buildWalkGraph(journey: Journey): WalkGraph {
  const pages = journey.pages;
  const count = pages.length;
  const indexOf = new Map<string, number>();
  pages.forEach((page, at) => {
    if (!indexOf.has(page.id)) {
      indexOf.set(page.id, at);
    }
  });

  // Each page's own edges, by position. The static graph lists them page by page, a questions
  // page's ending with its fall-through or its first unconditional route (an exit page has
  // none), so two pages sharing an id (itself an error) keep their own ways out, as the path
  // engine takes them, rather than each taking the other's.
  const edges = journeyStaticGraph(journey).edges;
  const next: number[][] = pages.map(() => []);
  let cursor = 0;
  pages.forEach((page, at) => {
    while (page.kind !== "exit" && cursor < edges.length && edges[cursor]!.from === page.id) {
      const edge = edges[cursor]!;
      cursor += 1;
      if (edge.kind === "next") {
        // A review page's fall-through is the end, whatever page is listed after it.
        next[at]!.push(page.kind === "review" ? count : at + 1);
        break;
      }
      const target = edge.to === "$end" ? count : indexOf.get(edge.to);
      if (target !== undefined) {
        next[at]!.push(target);
      }
      if (!edge.conditional) {
        break;
      }
    }
  });

  const exit = pages.map((page) => page.kind === "exit");
  return { count, exit, next };
}

interface WalkOptions {
  /** Pages the walk may not put on the path: a walk arriving at one stops there. */
  avoid?: ReadonlySet<number>;
  /** When set, a walk counts only once it has put one of these pages on the path. */
  meet?: ReadonlySet<number>;
}

interface WalkResult {
  /** Page index -> some walk puts it on the path. */
  onPath: boolean[];
  /** Some walk (that met `meet`, when given) runs off the end — a path that can submit. */
  ends: boolean;
}

/** Every walk from the first page at once: a search over (page, met) states. */
function exploreWalks(graph: WalkGraph, options: WalkOptions = {}): WalkResult {
  const onPath: boolean[] = new Array<boolean>(graph.count).fill(false);
  const seen = new Set<string>();
  const stack: Array<[number, boolean]> = [];
  let ends = false;
  const visit = (at: number, met: boolean): void => {
    const key = `${at}:${met ? 1 : 0}`;
    if (!seen.has(key)) {
      seen.add(key);
      stack.push([at, met]);
    }
  };
  visit(0, options.meet === undefined);
  while (stack.length > 0) {
    const [at, met] = stack.pop() as [number, boolean];
    if (at >= graph.count) {
      if (met) {
        ends = true;
      }
      continue;
    }
    if (options.avoid?.has(at)) {
      continue;
    }
    onPath[at] = true;
    if (graph.exit[at]) {
      continue;
    }
    const nowMet = met || options.meet?.has(at) === true;
    for (const target of graph.next[at] ?? []) {
      visit(target, nowMet);
    }
  }
  return { onPath, ends };
}

/**
 * Everything wrong with one journey over the form under `root`. See the module comment; the
 * codes are listed there.
 */
export function diagnoseJourney(root: ComponentNode, journey: Journey, options: JourneyDiagnosticOptions = {}): JourneyDiagnostic[] {
  const out: JourneyDiagnostic[] = [];
  const report = (severity: JourneyDiagnostic["severity"], code: JourneyDiagnosticCode, message: string, place: DiagnosticPlace = {}): void => {
    const diagnostic: JourneyDiagnostic = { severity, code, journeyId: journey.id, message };
    if (place.pageId !== undefined) {
      diagnostic.pageId = place.pageId;
    }
    if (place.pageIndex !== undefined) {
      diagnostic.pageIndex = place.pageIndex;
    }
    if (place.routeIndex !== undefined) {
      diagnostic.routeIndex = place.routeIndex;
    }
    if (place.componentId !== undefined) {
      diagnostic.componentId = place.componentId;
    }
    if (place.required !== undefined) {
      diagnostic.required = place.required;
    }
    if (place.requiredField !== undefined) {
      diagnostic.requiredField = place.requiredField;
    }
    if (place.hidden !== undefined) {
      diagnostic.hidden = place.hidden;
    }
    if (place.hostBound !== undefined) {
      diagnostic.hostBound = place.hostBound;
    }
    if (place.entryId !== undefined) {
      diagnostic.entryId = place.entryId;
    }
    if (place.ownNodeId !== undefined) {
      diagnostic.ownNodeId = place.ownNodeId;
    }
    if (place.ownNodeRepeat !== undefined) {
      diagnostic.ownNodeRepeat = place.ownNodeRepeat;
    }
    if (place.rule !== undefined) {
      diagnostic.rule = place.rule;
    }
    out.push(diagnostic);
  };

  const index = indexTree(root);
  const ownership = journeyOwnership(root, journey);
  const pages: JourneyPage[] = journey.pages;
  const pageIndex = new Map<string, number>();
  pages.forEach((page, at) => {
    if (!pageIndex.has(page.id)) {
      pageIndex.set(page.id, at);
    }
  });

  /** The component a form-scoped path names: the id itself, else its leading segment. */
  const componentOfPath = (path: string): string | undefined => {
    if (index.nodeById.has(path) && path !== root.id) {
      return path;
    }
    const leading = journeyLeadingSegment(path);
    return leading !== path && index.nodeById.has(leading) && leading !== root.id ? leading : undefined;
  };

  // The form's tree as the prototype-free records the shared usability rules and the fold read.
  const nodeRecord = Object.create(null) as Record<string, ComponentNode>;
  const parentRecord = Object.create(null) as Record<string, string>;
  for (const [id, node] of index.nodeById) {
    nodeRecord[id] = node;
  }
  for (const [id, parent] of index.parentOf) {
    parentRecord[id] = parent;
  }
  /** The form's keys, as rule I reads them. */
  const formKeys = journeyFormKeys(root);

  /** Rule D, as the ownership reads it: the form component a reference names, when the form has it below the root. */
  const referencedComponent = (componentId: unknown): string | undefined =>
    typeof componentId === "string" && componentId !== root.id && index.nodeById.has(componentId) ? componentId : undefined;
  const unusableTarget = (targetId: unknown): string => {
    if (typeof targetId !== "string" || targetId === "") {
      return "no form field";
    }
    const target = index.nodeById.get(targetId);
    if (target === undefined) {
      return `${targetId}, which is not a component of the form`;
    }
    if (targetId === root.id) {
      return `the form itself (${targetId})`;
    }
    if (!journeyHoldsOwnAnswer(target)) {
      return `${targetId}, which holds no answer of its own (a ${target.type})`;
    }
    if (target.rules && target.rules.value) {
      return `${targetId}, which the form calculates itself`;
    }
    // A data grid is a repeating section with a collection.
    const holder = ancestorsOf(index, targetId).find((ancestor) => ancestor.collection !== undefined);
    return holder !== undefined ? `${targetId}, which is inside ${holder.id} (a repeating section or a data grid)` : `${targetId}, which a page cannot fill`;
  };
  // --- The nodes the journey's pages own ---
  //
  // Read once, before anything is judged, in the presentation's own order (pages, entries, each
  // entry's nodes in document order), which is the order the usability rules are asked in: which
  // ids are the journey's own, which entries its pages draw, and what each node of an entry in
  // use is to the runtime. What is in use is never decided here: an entry is dropped exactly
  // when one of its nodes breaks a rule the shared `journeyOwnNodeRule` names (as
  // `journeyOwnNodeUsable` asks it), and what an alias fills or a worked-out value sets is read
  // off the ownership. The findings themselves are made with the page, below.
  const aliasOf = ownership.aliasOf ?? (Object.create(null) as Record<string, string>);
  const workedOutOf = ownership.workedOutOf ?? (Object.create(null) as Record<string, string>);
  /**
   * The id of every own node written on a page that no form component has -> the form field
   * to read in its place, in words, when it fills or works one out: what no condition and no
   * rule of the form may read.
   */
  const ownIds = new Map<string, string | undefined>();
  /** A page's own entries in use, by id: what a page without a title borrows its heading from. */
  const ownEntries = new Map<string, PresentationNode>();
  /**
   * What a node of an own entry is to the runtime, as the presentation index reads it: a
   * reference to a form component, an own field kept in the browser, an alias in use, a
   * worked-out value in use or one ignored (rules E, G), an own layout, or content holding no
   * answer (a text, a button — or a node whose `fills` is ignored for holding none, rule F).
   */
  type OwnKind = "reference" | "field" | "alias" | "worked-out" | "ignored" | "layout" | "content";
  interface OwnNode {
    /** The node as written. */
    held: Record<string, unknown>;
    kind: OwnKind;
    /** Its own id, when it has one to go by (a non-empty string); never for a reference. */
    id: string | undefined;
    /** What a finding about it is drawn on: its own id, else that of the own node around it. */
    placeOn: string | undefined;
    /** How many own nodes on its page before the one it is drawn on share that one's id (`ownNodeRepeat`). */
    placeRepeat: number;
    /** The own node holding it; `undefined` for the entry written on the page. */
    parent: OwnNode | undefined;
    settings: Record<string, unknown>;
    /** The rule it breaks by itself (A, B, C, H or I), `""` when none; `""` for a reference. */
    rule: "" | "A" | "B" | "C" | "H" | "I";
    /** Its id is that of an own node met before it in the presentation (rule A). */
    repeated: boolean;
    /**
     * It is, or holds, an alias, a worked-out value or a reference in use: its own visibility is
     * never read (`PresentationIndex.mapped`), since hiding it would hide a form field.
     */
    mapped: boolean;
    /** What it holds, in document order. */
    children: OwnNode[];
  }
  interface OwnEntry {
    entryId: string | undefined;
    /** The entry's id, else "entry n" by its place on the page. */
    entryName: string;
    pageAt: number;
    pageId: string;
    /** The entry's nodes in document order, the entry first. */
    nodes: OwnNode[];
    /** A node in it breaks rule A, B, C, H or I: the page does not draw it, on both sides. */
    dropped: boolean;
    /**
     * It sits on a review page and places a form field there (`journeyEntryPlacesForm`): the
     * ownership drops it whole, on both sides (`page.review-form-field`).
     */
    reviewDropped: boolean;
  }
  /** `pageIndex:entryIndex` -> the entry. */
  const ownEntryAt = new Map<string, OwnEntry>();
  /** Own node id -> the node, for the entries in use. */
  const ownNodeById = new Map<string, { node: OwnNode; entry: OwnEntry }>();
  /**
   * Page id -> the own value fields on it — plain fields and aliases — in document order: what a
   * worked-out value there reads (the presentation index's `sourceIds`, keyed as it keys them).
   */
  const sourcesOf = new Map<string, string[]>();
  /** Page id -> what the expressions of the worked-out values on it read. */
  const workedOutReads = new Map<string, Set<string>>();
  /**
   * Own node id -> the ids of the own nodes whose rules read it (by its id or its key's leading
   * segment): only the rules the browser reads for that node's kind ({@link ownRulesRead}).
   */
  const ownRuleReaders = new Map<string, Set<string>>();
  /** The rules of an own node the browser reads, by the name the Rules tab gives them. */
  const OWN_RULES: ReadonlyArray<[string, string]> = [
    ["visibleWhen", "visibility rule"],
    ["enabledWhen", "enabled rule"],
    ["readonlyWhen", "read-only rule"],
    ["requiredWhen", "required rule"]
  ];
  /**
   * The rules the browser reads on an own node of a kind (the overlay): a field all
   * four; an alias its Required-when alone, the rest being its form field's; a layout and content
   * holding no answer their visibility, enabled and read-only rules — a layout showing a form
   * field not its visibility, which would hide it; a worked-out value, ignored or not, and a
   * reference none. What `checkOwnRules` judges, and the only rules that count as reading a field.
   */
  const ownRulesRead = (node: OwnNode): readonly string[] =>
    node.kind === "field"
      ? ["visibleWhen", "enabledWhen", "readonlyWhen", "requiredWhen"]
      : node.kind === "alias"
        ? ["requiredWhen"]
        : node.kind === "layout" || node.kind === "content"
          ? node.mapped
            ? ["enabledWhen", "readonlyWhen"]
            : ["visibleWhen", "enabledWhen", "readonlyWhen"]
          : [];
  {
    const seenOwn = Object.create(null) as Record<string, true>;
    pages.forEach((page, at) => {
      /** Own id -> how many own nodes on this page have it so far (`placeRepeat`). */
      const onPage = Object.create(null) as Record<string, number>;
      (page.components ?? []).forEach((listed: unknown, entryAt) => {
        if (listed === null || typeof listed !== "object" || (listed as { type?: unknown }).type === PRESENTATION_REFERENCE_TYPE) {
          // An id, or a reference at the top of the page: read with the page, as an id is.
          return;
        }
        const entryRecord = listed as Record<string, unknown>;
        const entryId = typeof entryRecord.id === "string" && entryRecord.id !== "" ? entryRecord.id : undefined;
        const info: OwnEntry = { entryId, entryName: entryId ?? `entry ${entryAt + 1}`, pageAt: at, pageId: page.id, nodes: [], dropped: false, reviewDropped: false };
        // A stack of its own, children pushed last first: document order, however deep a
        // hand-written page nests. Whatever is an object is a node, as the shared rules read it.
        const stack: Array<{ held: unknown; parent: OwnNode | undefined }> = [{ held: entryRecord, parent: undefined }];
        while (stack.length > 0) {
          const { held, parent } = stack.pop() as { held: unknown; parent: OwnNode | undefined };
          if (held === null || typeof held !== "object") {
            continue;
          }
          const record = held as Record<string, unknown>;
          const settings = isRecord(record.configuration) ? record.configuration : {};
          if (record.type === PRESENTATION_REFERENCE_TYPE) {
            const reference: OwnNode = {
              held: record,
              kind: "reference",
              id: undefined,
              placeOn: parent?.placeOn,
              placeRepeat: parent?.placeRepeat ?? 0,
              parent,
              settings,
              rule: "",
              repeated: false,
              mapped: false,
              children: []
            };
            info.nodes.push(reference);
            parent?.children.push(reference);
            continue;
          }
          const id: unknown = record.id;
          const repeated = typeof id === "string" && journeyOwn(seenOwn, id) === true;
          const rule = journeyOwnNodeRule(record as unknown as PresentationNode, nodeRecord, seenOwn, journey.id, formKeys);
          const ownId = typeof id === "string" && id !== "" ? id : undefined;
          if (ownId !== undefined && !index.nodeById.has(ownId) && !ownIds.has(ownId)) {
            const filled = journeyOwn(aliasOf, ownId);
            const worked = journeyOwn(workedOutOf, ownId);
            ownIds.set(ownId, filled !== undefined ? `${filled}, the form field it fills,` : worked !== undefined ? `${worked}, the form field it works out,` : undefined);
          }
          const kind: OwnKind =
            record.type === PRESENTATION_VALUE_TYPE
              ? ownId !== undefined && journeyOwn(workedOutOf, ownId) !== undefined
                ? "worked-out"
                : "ignored"
              : record.children !== undefined
                ? "layout"
                : ownId !== undefined && journeyOwn(aliasOf, ownId) !== undefined
                  ? "alias"
                  : journeyHoldsOwnAnswer(record as { type: string })
                    ? "field"
                    : "content";
          let placeRepeat = parent?.placeRepeat ?? 0;
          if (ownId !== undefined) {
            placeRepeat = journeyOwn(onPage, ownId) ?? 0;
            onPage[ownId] = placeRepeat + 1;
          }
          const node: OwnNode = { held: record, kind, id: ownId, placeOn: ownId ?? parent?.placeOn, placeRepeat, parent, settings, rule, repeated, mapped: false, children: [] };
          info.nodes.push(node);
          parent?.children.push(node);
          const children: unknown = record.children;
          if (children !== null && typeof children === "object") {
            const slots = Object.keys(children);
            for (let slotIndex = slots.length - 1; slotIndex >= 0; slotIndex -= 1) {
              const group: unknown = (children as Record<string, unknown>)[slots[slotIndex] as string];
              if (Array.isArray(group)) {
                for (let childIndex = group.length - 1; childIndex >= 0; childIndex -= 1) {
                  stack.push({ held: group[childIndex], parent: node });
                }
              }
            }
          }
        }
        info.dropped = info.nodes.some((node) => node.kind !== "reference" && node.rule !== "");
        info.reviewDropped = !info.dropped && page.kind === "review" && journeyEntryPlacesForm(entryRecord as unknown as PresentationNode);
        ownEntryAt.set(`${at}:${entryAt}`, info);
        if (info.dropped || info.reviewDropped) {
          return;
        }
        if (entryId !== undefined) {
          ownEntries.set(entryId, entryRecord as unknown as PresentationNode);
        }
        for (const node of info.nodes) {
          // What shows a form field — an alias or a worked-out value in use, a reference naming a
          // form component — makes it and every own node around it "mapped".
          const shows =
            node.kind === "alias" ||
            node.kind === "worked-out" ||
            (node.kind === "reference" && referencedComponent(node.settings.componentId) !== undefined);
          for (let around: OwnNode | undefined = shows ? node : undefined; around !== undefined && !around.mapped; around = around.parent) {
            around.mapped = true;
          }
          if (node.id === undefined) {
            continue;
          }
          ownNodeById.set(node.id, { node, entry: info });
          if (node.kind === "field" || node.kind === "alias") {
            const sources = sourcesOf.get(page.id) ?? [];
            sources.push(node.id);
            sourcesOf.set(page.id, sources);
          }
          if (node.held.type === PRESENTATION_VALUE_TYPE) {
            const value = ruleOf(node.settings.value);
            const reads = workedOutReads.get(page.id) ?? new Set<string>();
            for (const path of value !== undefined ? extractDependencies(value) : []) {
              reads.add(path);
              reads.add(journeyLeadingSegment(path));
            }
            workedOutReads.set(page.id, reads);
          }
        }
        // Once every node of the entry is known to be mapped or not: what each one's rules that
        // the browser reads read.
        for (const node of info.nodes) {
          const rules = node.held.rules;
          if (node.id !== undefined && isRecord(rules)) {
            for (const key of ownRulesRead(node)) {
              const rule = ruleOf(rules[key]);
              for (const path of rule !== undefined ? extractDependencies(rule) : []) {
                for (const read of [path, journeyLeadingSegment(path)]) {
                  if (read !== node.id) {
                    const readers = ownRuleReaders.get(read) ?? new Set<string>();
                    readers.add(node.id);
                    ownRuleReaders.set(read, readers);
                  }
                }
              }
            }
          }
        }
      });
    });
  }
  /**
   * What a form-scoped path reads of the journey's own, when it does: the id of a
   * node a page owns (that no form component has), by the path itself or its leading segment,
   * or a key under `@`, where a browser keeps such answers. `instead` names the form field the
   * node fills or works out, when it has one.
   */
  const presentationRead = (path: string, anyKey: boolean): { what: string; instead: string | undefined } | undefined => {
    const leading = journeyLeadingSegment(path);
    if (path.startsWith("@")) {
      if (!anyKey && leading !== `@${journey.id}`) {
        return undefined;
      }
      const own = leading === `@${journey.id}` ? journeyLeadingSegment(path.slice(leading.length + 1)) : "";
      return { what: `${path}, where the browser keeps the answer of a field the journey's pages own`, instead: ownIds.get(own) };
    }
    if (componentOfPath(path) !== undefined) {
      return undefined;
    }
    const id = ownIds.has(path) ? path : leading;
    return ownIds.has(id) ? { what: `${path}, a field of journey "${journey.id}"'s own`, instead: ownIds.get(id) } : undefined;
  };

  /** The page indexes that own a component (its own listing or an ancestor's). */
  const ownerIndexes = (componentId: string): number[] =>
    (ownership.pagesOf[componentId] ?? [])
      .map((pageId) => pageIndex.get(pageId))
      .filter((at): at is number => at !== undefined);

  /**
   * The components a condition that may read pages before `limit` would find unanswered: the
   * ones only on pages at or after `limit`, reached directly or through the calculations
   * (`rules.value`) the condition reads.
   */
  const lateReads = (
    componentId: string,
    limit: number,
    visited: Set<string>
  ): Array<{ componentId: string; pageId: string }> => {
    if (visited.has(componentId)) {
      return [];
    }
    visited.add(componentId);
    const owners = ownerIndexes(componentId);
    if (owners.length > 0 && owners.every((at) => at >= limit)) {
      const earliest = Math.min(...owners);
      return [{ componentId, pageId: (pages[earliest] as JourneyPage).id }];
    }
    const calculation = ruleOf(index.nodeById.get(componentId)?.rules?.value);
    if (calculation === undefined) {
      return [];
    }
    const found: Array<{ componentId: string; pageId: string }> = [];
    for (const path of extractDependencies(calculation)) {
      if (isScopedPath(path)) {
        continue;
      }
      const read = componentOfPath(path);
      if (read !== undefined) {
        found.push(...lateReads(read, limit, visited));
      }
    }
    return found;
  };

  /** Form field -> the worked-out value in use that sets it, and its page. */
  const workedOutTargets = new Map<string, { nodeId: string; pageId: string }>();
  for (const nodeId of Object.keys(workedOutOf)) {
    const placed = ownNodeById.get(nodeId);
    workedOutTargets.set(workedOutOf[nodeId] as string, { nodeId, pageId: placed !== undefined ? placed.entry.pageId : "" });
  }
  /**
   * The values worked out in the browser that reading `componentId` reads: itself,
   * when a worked-out value of the journey sets it, else through the calculations
   * (`rules.value`) it is worked out by — what `kernelClientDerived` lists, as a path condition
   * reads it.
   */
  const clientDerivedReads = (componentId: string, visited: Set<string>): Array<{ target: string; nodeId: string; pageId: string }> => {
    if (visited.has(componentId)) {
      return [];
    }
    visited.add(componentId);
    const worked = workedOutTargets.get(componentId);
    if (worked !== undefined) {
      return [{ target: componentId, ...worked }];
    }
    const calculation = ruleOf(index.nodeById.get(componentId)?.rules?.value);
    if (calculation === undefined) {
      return [];
    }
    const found: Array<{ target: string; nodeId: string; pageId: string }> = [];
    for (const path of extractDependencies(calculation)) {
      const read = isScopedPath(path) ? undefined : componentOfPath(path);
      if (read !== undefined) {
        found.push(...clientDerivedReads(read, visited));
      }
    }
    return found;
  };

  /**
   * A route's condition: evaluable, reading the form's answers only, naming components the form
   * has, and none it cannot have seen yet. A route is tried once its page is on the path, so it
   * sees the answers of that page and the pages before it.
   */
  const checkCondition = (source: unknown, where: string, at: number, place: DiagnosticPlace): void => {
    const condition = ruleOf(source);
    if (condition === undefined) {
      report("error", "condition.invalid", `${where} is not a condition the engine can evaluate, or a formula that does not parse.`, place);
      return;
    }
    // Judged by the clock of whichever side walks the path: the browser's as the person goes
    // through, the server's as it replays the path from the answers it is sent.
    if (kernelExprReadsClock(condition)) {
      report(
        "warning",
        "condition.reads-clock",
        `${where} reads today(): the server judges it by its own clock, so a submission checked on another day may be judged differently.`,
        place
      );
    }
    const limit = at + 1;
    const reported = new Set<string>();
    const reportedDerived = new Set<string>();
    for (const path of extractDependencies(condition)) {
      if (isScopedPath(path)) {
        report(
          "error",
          "condition.scope",
          `${where} reads ${path}. A journey condition reads the form's answers by component id; row., ancestor., host. and component paths are not available to it.`,
          place
        );
        continue;
      }
      // An own field's answer is never among the form's: the walk, in the browser and
      // on the server, reads the form's answers alone.
      const own = presentationRead(path, true);
      if (own !== undefined) {
        report(
          "error",
          "condition.reads-presentation-field",
          `${where} reads ${own.what}: a condition reads the form's answers only, on the server as in the browser, so it always reads as unanswered. ${
            own.instead !== undefined ? `Read ${own.instead} instead.` : "Read a form field instead."
          }`,
          place
        );
        continue;
      }
      const componentId = componentOfPath(path);
      if (componentId === undefined) {
        report(
          "warning",
          "condition.unknown-field",
          `${where} reads ${path}, which is not a component of the form, so it always reads as unanswered.`,
          place
        );
        continue;
      }
      for (const late of lateReads(componentId, limit, new Set<string>())) {
        if (reported.has(late.componentId)) {
          continue;
        }
        reported.add(late.componentId);
        const via = late.componentId === componentId ? "," : `, calculated from ${late.componentId},`;
        const own = late.pageId === (pages[at] as JourneyPage).id ? "this page" : `page "${late.pageId}"`;
        report(
          "warning",
          "condition.reads-later-page",
          `${where} reads ${componentId}${via} which is asked only on ${own} or later, so it always reads as unanswered there.`,
          { ...place, componentId: late.componentId }
        );
      }
      // A value worked out in the browser: the server keeps it as sent — checked by
      // the form's rules, listed in `clientDerived` — and replays the path from it.
      for (const derived of clientDerivedReads(componentId, new Set<string>())) {
        if (reportedDerived.has(derived.target)) {
          continue;
        }
        reportedDerived.add(derived.target);
        const via = derived.target === componentId ? "," : `, calculated from ${derived.target},`;
        report(
          "warning",
          "condition.reads-client-derived",
          `${where} reads ${componentId}${via} which journey "${journey.id}" works out in the browser (${derived.nodeId} on page "${derived.pageId}"): the server keeps the value it is sent, held to the form's rules, but cannot work it out again, so the way the path goes rests on what the browser sent.`,
          { ...place, componentId: derived.target }
        );
      }
    }
  };

  // Whether the form requires a node's answer (Required, or a Required-when rule,
  // read by truthiness as the fold reads it — `requiredWhen: null` is no rule).
  const requiresOwnAnswer = (node: ComponentNode): "static" | "rule" | undefined =>
    kernelReadFlag(node.configuration, "required") ? "static" : node.rules && node.rules.requiredWhen ? "rule" : undefined;
  // How a required field's `rules.defaultValue` answers it. A literal that is not empty for the
  // node's type answers it outright: the browser seeds the default and submits it unchanged, so
  // the form's rule is met without asking. A default worked out from other answers (a path, a
  // calculation) answers it only when that comes to a non-empty value, which the definition
  // alone cannot tell — a `host.` path with no host, a path to an unanswered field, seed
  // nothing — so it does not lift the requirement. No default, or an empty literal (`false` on
  // a checkbox, blank text, an empty list, as `isEmptyValue` reads an answer), answers nothing.
  const defaultAnswer = (node: ComponentNode): "literal" | "derived" | undefined => {
    // A literal is read as written, whatever it holds (a flags object for a checkbox group is
    // seeded as is), so it is not held to the evaluable shape the way a rule is.
    const rule = kernelRuleExpression(node.rules ? node.rules.defaultValue : undefined, kernelParseFormula, FORMULA_SIGNATURES);
    if (rule === undefined) {
      return undefined;
    }
    if (rule.kind !== "literal") {
      return ruleOf(rule) === undefined ? undefined : "derived";
    }
    return emptyAnswer(rule.value, node.type) ? undefined : "literal";
  };
  const whenRule = (field: ComponentNode): string => (requiresOwnAnswer(field) === "rule" ? " when its rule holds" : "");

  // --- What is wrong with a page's own entries ---

  /** The journey's page ids, which no own node may share (their texts are translated by id). */
  const pageIds = new Set(pages.map((page) => page.id));

  /** A form component a page shows inside a repeating section: a page cannot show one field of every entry. */
  const checkEntryField = (pageId: string, at: number, componentId: string, extra: DiagnosticPlace = {}): void => {
    const section = ancestorsOf(index, componentId).find((ancestor) => collectionPathOf(ancestor) !== undefined);
    if (section !== undefined) {
      report(
        "warning",
        "page.entry-field",
        `Page "${pageId}" lists ${componentId}, which is part of each entry of ${section.id}; a page cannot show one field of every entry, so list ${section.id} instead.`,
        { pageId, pageIndex: at, componentId, ...extra }
      );
    }
  };

  /** How an own node hides itself: by a visibility rule, by its configuration, or not at all. */
  const ownHides = (node: OwnNode): "rule" | "hidden" | undefined => {
    const rules = node.held.rules;
    if (isRecord(rules) && ruleOf(rules.visibleWhen) !== undefined) {
      return "rule";
    }
    return kernelReadFlag(node.held.configuration, "hidden") ? "hidden" : undefined;
  };

  /**
   * What an own node's rule reads that it can never read, as the browser evaluates it:
   * over the form's answers by component id and the journey's own fields by id (`fold.idValues`
   * plus the own answers) — a field or an alias in use on any page. `undefined` for a path it
   * can read; scoped paths (`host.` and the like) are not this check's.
   */
  const ownReadProblem = (path: string): { what: string; instead?: string } | undefined => {
    const leading = journeyLeadingSegment(path);
    if (path.startsWith("@")) {
      const own = leading === `@${journey.id}` ? journeyLeadingSegment(path.slice(leading.length + 1)) : "";
      const known = ownNodeById.get(own);
      return {
        what: `${path}, where the browser keeps an answer: the rules of the journey's own nodes read its fields by id`,
        ...(known !== undefined && (known.node.kind === "field" || known.node.kind === "alias") ? { instead: own } : {})
      };
    }
    if (componentOfPath(path) !== undefined) {
      return undefined;
    }
    const id = ownNodeById.has(path) ? path : leading;
    const known = ownNodeById.get(id);
    if (known !== undefined) {
      switch (known.node.kind) {
        case "field":
        case "alias":
          return undefined;
        case "worked-out":
          return { what: `${path}, a worked-out value, which holds no answer of its own`, instead: `${journeyOwn(workedOutOf, id) as string}, the form field it works out,` };
        case "ignored":
          return { what: `${path}, a worked-out value the page does not show` };
        default:
          return { what: `${path}, which holds no answer (a ${String(known.node.held.type)})` };
      }
    }
    return ownIds.has(id)
      ? { what: `${path}, a node of journey "${journey.id}"'s own that the page does not show` }
      : { what: `${path}, which is neither a component of the form nor a field of journey "${journey.id}"'s own` };
  };

  /** `rule.unknown-field` for each read of an own node's rules that names nothing it can read. */
  const checkOwnRules = (node: OwnNode, named: string, place: DiagnosticPlace): void => {
    const keys = ownRulesRead(node);
    const rules = node.held.rules;
    if (!isRecord(rules)) {
      return;
    }
    for (const [key, name] of OWN_RULES) {
      const rule = ruleOf(rules[key]);
      if (keys.indexOf(key) < 0 || rule === undefined) {
        continue;
      }
      const said = new Set<string>();
      for (const path of extractDependencies(rule)) {
        const problem = isScopedPath(path) || said.has(path) ? undefined : ownReadProblem(path);
        if (problem === undefined) {
          continue;
        }
        said.add(path);
        report(
          "warning",
          "rule.unknown-field",
          `The ${name} of ${named} on page "${place.pageId as string}" reads ${problem.what}, so it always reads as unanswered${
            problem.instead !== undefined ? ` — read ${problem.instead} instead` : ""
          }.`,
          place
        );
      }
    }
  };

  /** `own.hides-form-field`: an own node showing a form field, whose own visibility is never read. */
  const checkHidesFormField = (node: OwnNode, named: string, place: DiagnosticPlace, shows: string, componentId: string | undefined): void => {
    const hides = ownHides(node);
    if (hides === undefined) {
      return;
    }
    report(
      "error",
      "own.hides-form-field",
      `${named} on page "${place.pageId as string}" ${hides === "rule" ? "has a visibility rule" : "is set to be hidden"}, but it ${shows}: hiding it would hide a field the server still asks for, so ${
        hides === "rule" ? "the rule is never read" : "the setting is ignored"
      } and it shows whenever its page does. Put the condition on the form field instead.`,
      { ...place, ...(componentId !== undefined ? { componentId } : {}) }
    );
  };

  /** `map.target-hidden`: an alias or a worked-out value of a form field no rule can show. */
  const checkTargetHidden = (named: string, place: DiagnosticPlace, target: string, alias: boolean): void => {
    if (!chainAlwaysHidden(index, target)) {
      return;
    }
    report(
      "warning",
      "map.target-hidden",
      alias
        ? `${named} on page "${place.pageId as string}" fills ${target}, which is hidden on the form with no rule to show it, so it never shows: an alias shows only while the form field it fills does.`
        : `${named} on page "${place.pageId as string}" works out ${target}, which is hidden on the form with no rule to show it, so the page never shows the value: a worked-out value shows only while the form field it sets does.`,
      { ...place, componentId: target }
    );
  };

  /** Whether an own value field may be hidden: an alias with its form field, a field by its own visibility or that of a layout around it whose visibility is read. */
  const sourceMayHide = (id: string): boolean => {
    const known = ownNodeById.get(id);
    if (known === undefined) {
      return false;
    }
    if (known.node.kind === "alias") {
      return chainMayBeHidden(index, journeyOwn(aliasOf, id) as string);
    }
    for (let around: OwnNode | undefined = known.node; around !== undefined; around = around.parent) {
      if (!around.mapped && ownHides(around) !== undefined) {
        return true;
      }
    }
    return false;
  };

  /**
   * Whether an own value field is sure to be answered once its page is passed: it can never be
   * hidden, and it is required for good — by its own tick, or, for an alias, by its form field's
   * Required. What sets a worked-out value off whatever else is answered.
   */
  const sourceAnswered = (id: string): boolean => {
    const known = ownNodeById.get(id);
    if (known === undefined || sourceMayHide(id)) {
      return false;
    }
    return known.node.kind === "alias"
      ? requiresOwnAnswer(index.nodeById.get(journeyOwn(aliasOf, id) as string) as ComponentNode) === "static"
      : kernelReadFlag(known.node.held.configuration, "required");
  };

  /**
   * The shape of what a worked-out value's expression comes to, as JSON carries it, when the
   * expression says so for certain: arithmetic a number, a comparison and a condition true or
   * false, a function what its table entry says it returns (a date is text in JSON), an `if`
   * the one shape every `then` and the `else` agree on, a source its field's shape; `undefined`
   * when it cannot tell (a `coalesce` or an `if` of mixed shapes, an `if` with no `else`, a
   * function returning anything, a plugin's function, a `null`).
   */
  const expressionShape = (expression: Expression, sourceShape: (id: string) => ValueShape | undefined): "text" | "list" | "number" | "boolean" | undefined => {
    switch (expression.kind) {
      case "literal":
        return typeof expression.value === "number" ? "number" : typeof expression.value === "string" ? "text" : typeof expression.value === "boolean" ? "boolean" : undefined;
      case "path": {
        const shape = isScopedPath(expression.path) ? undefined : sourceShape(expression.path);
        return shape !== undefined ? jsonShape(shape) : undefined;
      }
      case "arithmetic":
        return "number";
      case "unary":
      case "binary":
      case "logical":
        return "boolean";
      case "call": {
        if (expression.name === "coalesce") {
          const shapes = new Set(expression.args.map((argument) => expressionShape(argument, sourceShape)));
          const [only] = [...shapes];
          return shapes.size === 1 ? only : undefined;
        }
        switch (FUNCTION_RETURNS.get(expression.name)) {
          case "number":
            return "number";
          case "text":
          case "date":
            return "text";
          case "boolean":
            return "boolean";
          case "list":
            return "list";
          default:
            return undefined;
        }
      }
      case "if": {
        if (expression.else === undefined) {
          return undefined;
        }
        const shapes = new Set([...expression.cases.map((entry) => expressionShape(entry.then, sourceShape)), expressionShape(expression.else, sourceShape)]);
        const [only] = [...shapes];
        return shapes.size === 1 ? only : undefined;
      }
      default:
        return undefined;
    }
  };

  /** An alias in use: what it fills, its shape and options against the form field's, and its own visibility. */
  const checkAlias = (node: OwnNode, named: string, place: DiagnosticPlace): void => {
    const id = node.id as string;
    const target = journeyOwn(aliasOf, id) as string;
    const targetNode = index.nodeById.get(target) as ComponentNode;
    checkHidesFormField(node, named, place, `fills ${target}, a form field`, target);
    checkTargetHidden(named, place, target, true);
    const from = shapeOfType(node.held.type);
    const to = shapeOfType(targetNode.type);
    if (from !== undefined && to !== undefined && !shapeFits(from, to)) {
      report(
        "error",
        "map.shape-mismatch",
        `${named} on page "${place.pageId as string}" asks for ${SHAPE_WORDS[from]} but fills ${target}, which holds ${SHAPE_WORDS[to]}: the answer is stored as given, so ${target} gets an answer of another kind${
          to === "number" || to === "date" ? `, which the form refuses unless it is ${SHAPE_WORDS[to]}` : ""
        }. Make ${id} the same kind of field as ${target}.`,
        { ...place, componentId: target }
      );
    } else if ((from === "choice" || from === "list") && from === to && !namesDataSource(targetNode.configuration)) {
      const has = optionValuesOf(targetNode.configuration);
      const extra = optionValuesOf(node.settings).filter((value) => has.indexOf(value) < 0);
      if (extra.length > 0) {
        report(
          "error",
          "map.options-not-subset",
          `${named} on page "${place.pageId as string}" offers ${extra.length === 1 ? "the choice" : "the choices"} ${quotedList(extra)}, which ${target} does not have: a browser without the sandbox would send such an answer, but the server refuses it as option.notAllowed, and ${target}'s own list cannot show it on the form, in a review or in a PDF. Keep the journey's list a subset of ${target}'s options.`,
          { ...place, componentId: target }
        );
      }
    }
    // Its own visibility, enabled and read-only state are the form field's; only its Required-when rule is its own.
    checkOwnRules(node, named, place);
  };

  /** A worked-out value in use: what it reads, whether its sources can all hide, its shape, and its own visibility. */
  const checkWorkedOut = (node: OwnNode, named: string, place: DiagnosticPlace): void => {
    const id = node.id as string;
    const pageId = place.pageId as string;
    const target = journeyOwn(workedOutOf, id) as string;
    const targetNode = index.nodeById.get(target) as ComponentNode;
    const at: DiagnosticPlace = { ...place, componentId: target };
    checkHidesFormField(node, named, place, `shows ${target}, the form field it works out`, target);
    checkTargetHidden(named, place, target, false);
    const value = ruleOf(node.settings.value);
    if (value === undefined) {
      return;
    }
    // What the browser reads it over: the own fields and aliases of its page, by id (the
    // presentation index's `sourceIds`). Anything else reads as unanswered.
    const sources = sourcesOf.get(pageId) ?? [];
    const read: string[] = [];
    const said = new Set<string>();
    for (const path of extractDependencies(value)) {
      if (isScopedPath(path) || said.has(path)) {
        continue;
      }
      said.add(path);
      if (sources.indexOf(path) >= 0) {
        read.push(path);
        continue;
      }
      const formField = path.startsWith("@") ? undefined : componentOfPath(path);
      if (formField !== undefined) {
        const filledHere = sources.find((source) => journeyOwn(aliasOf, source) === formField);
        report(
          "error",
          "map.reads-other-page",
          `${named} on page "${pageId}" works out ${target} from ${path}, a form field: a worked-out value reads only the journey's own fields on its page, so ${path} always reads as unanswered there${
            filledHere !== undefined ? ` — read ${filledHere}, which fills it on this page, instead` : ""
          }.`,
          at
        );
        continue;
      }
      const known = path.startsWith("@") ? undefined : (ownNodeById.get(path) ?? ownNodeById.get(journeyLeadingSegment(path)));
      if (known !== undefined && (known.node.kind === "field" || known.node.kind === "alias") && known.entry.pageId !== pageId) {
        report(
          "error",
          "map.reads-other-page",
          `${named} on page "${pageId}" works out ${target} from ${path}, a field of page "${known.entry.pageId}": a worked-out value reads only the journey's own fields on its page, so ${path} always reads as unanswered there.`,
          at
        );
        continue;
      }
      const problem = ownReadProblem(path);
      if (problem !== undefined) {
        report(
          "warning",
          "rule.unknown-field",
          `${named} on page "${pageId}" works out ${target} from ${problem.what}, so it always reads as unanswered there${
            problem.instead !== undefined ? ` — read ${problem.instead} instead` : ""
          }.`,
          at
        );
      }
    }
    // How the form requires the field worked out, a literal default answering it outright.
    const need = defaultAnswer(targetNode) === "literal" ? undefined : requiresOwnAnswer(targetNode);
    // A required form field worked out only from fields that may all be hidden: while they are,
    // nothing works it out, and the page shows it read-only, so it cannot be passed. An error
    // when the form requires it outright; a warning under a Required-when rule, which may hold
    // only while they show (as when it reads what hides them).
    if (read.length > 0 && need !== undefined && read.every(sourceMayHide)) {
      report(
        need === "static" ? "error" : "warning",
        "map.sources-conditional",
        `${target} is required by the form${whenRule(targetNode)}, and ${named} on page "${pageId}" works it out from ${quotedList(read)}, ${
          read.length === 1 ? "which may be hidden" : "each of which may be hidden"
        }: ${need === "static" ? "while" : "whenever"} ${read.length === 1 ? "it is" : "they all are"}${
          need === "static" ? "" : " while that rule holds"
        }, nothing works ${target} out and the page shows it read-only, so the page cannot be passed${
          need === "static" ? "" : ` — which never happens if ${read.length === 1 ? "it is" : "they are"} hidden only while the rule does not hold`
        }. Let one of them always show, or ask ${target} on the page.`,
        at
      );
    }
    // Worked out only once one of its page's own value fields is answered — any of them, read
    // or not (the presentation index's `sourceIds`). One that reads none of them (nothing, or
    // host. and literals alone) is never worked out on a page with none, and not until an
    // unrelated one is answered on a page with some, unless one of those is sure to be.
    if (said.size === 0 && !sources.some(sourceAnswered)) {
      const until = sources.length === 0 ? "" : "until then ";
      report(
        need === "static" ? "error" : "warning",
        "map.reads-no-source",
        `${named} on page "${pageId}" works out ${target} without reading any field of its page's own, and a worked-out value is worked out only once one of those is answered: ${
          sources.length === 0
            ? `this page has none, so ${target} is never worked out`
            : `here ${quotedList(sources)}, which it does not read and which may be left unanswered, so ${target} is not worked out until one of them is`
        }${
          need === "static"
            ? `, and the form requires it, so ${until}no submission through the journey can pass`
            : need === "rule"
              ? `, and the form requires it when its rule holds, so while that rule holds ${until}no submission through the journey can pass`
              : ""
        }. Work it out from a field the page asks, or ask ${target} on the page.`,
        at
      );
    }
    const to = shapeOfType(targetNode.type);
    // A copy of one source: held to the source's own shape, as an alias is to its field's (a
    // date or a choice is text to JSON, which a text field takes and a date field does not).
    const copied = value.kind === "path" && sources.indexOf(value.path) >= 0 ? ownNodeById.get(value.path) : undefined;
    const from = copied !== undefined ? shapeOfType(copied.node.held.type) : undefined;
    if (copied !== undefined) {
      if (from !== undefined && to !== undefined && !shapeFits(from, to)) {
        report(
          "error",
          "map.shape-mismatch",
          `${named} on page "${pageId}" copies ${copied.node.id as string}, which asks for ${SHAPE_WORDS[from]}, into ${target}, which holds ${SHAPE_WORDS[to]}: the value is kept as worked out, so ${target} gets an answer of another kind${
            to === "number" || to === "date" ? `, which the form refuses unless it is ${SHAPE_WORDS[to]}` : ""
          }. Make ${copied.node.id as string} the same kind of field as ${target}.`,
          at
        );
      }
      return;
    }
    const shape = expressionShape(value, (source) => {
      const known = ownNodeById.get(source);
      return known !== undefined && sources.indexOf(source) >= 0 ? shapeOfType(known.node.held.type) : undefined;
    });
    if (shape !== undefined && to !== undefined && jsonShape(to) !== shape) {
      const words: Record<string, string> = { text: "text", list: "a list", number: "a number", boolean: "true or false" };
      report(
        "error",
        "map.shape-mismatch",
        `${named} on page "${pageId}" works out ${words[shape]} for ${target}, which holds ${SHAPE_WORDS[to]}: the value is kept as worked out, so ${target} gets an answer of another kind. Work out ${SHAPE_WORDS[to]} instead.`,
        at
      );
    }
  };

  /** Rules E and G: a worked-out value the ownership ignores, and why. */
  const reportIgnoredWorkedOut = (node: OwnNode, named: string, place: DiagnosticPlace): void => {
    const to = node.settings.to;
    if (typeof to !== "string" || !journeyTargetUsable(to, nodeRecord, parentRecord, root.id)) {
      const known = typeof to === "string" && index.nodeById.has(to);
      report(
        "error",
        known ? "map.target-unusable" : "map.unknown-target",
        `${named} on page "${place.pageId as string}" works out ${unusableTarget(to)}, so it is ignored: the page does not show it.`,
        { ...place, rule: "E", ...(typeof to === "string" && to !== "" ? { componentId: to } : {}) }
      );
      return;
    }
    const earlier = Object.keys(workedOutOf).find((nodeId) => workedOutOf[nodeId] === to);
    const alias = earlier === undefined ? Object.keys(aliasOf).find((nodeId) => aliasOf[nodeId] === to) : undefined;
    const taken = earlier !== undefined ? `${earlier} already works out` : alias !== undefined ? `${alias} already fills` : "the journey already asks or shows on a page";
    report(
      "error",
      "map.target-conflict",
      `${named} on page "${place.pageId as string}" works out ${to}, which ${taken}, so it is ignored: a worked-out field must be placed by nothing else.`,
      { ...place, rule: "G", componentId: to }
    );
  };

  /** An own node with `fills` that fills nothing: rule F (it holds no answer), else rule E (an unknown or unusable form field). */
  const reportUnusedFills = (entry: OwnEntry, node: OwnNode, named: string, place: DiagnosticPlace): void => {
    const fills = node.settings.fills;
    const stays = "so it fills nothing: its answer stays in the browser, and the form field is not asked through it";
    if (node.kind !== "field") {
      report(
        "error",
        "presentation.entry-unusable",
        `${named} on page "${place.pageId as string}" is set to fill ${String(fills)} but holds no answer itself (a ${String(node.held.type)}), ${stays}.`,
        { ...place, rule: "F", ...(entry.entryId !== undefined ? { entryId: entry.entryId } : {}) }
      );
      return;
    }
    const known = typeof fills === "string" && index.nodeById.has(fills);
    report("error", known ? "map.target-unusable" : "map.unknown-target", `${named} on page "${place.pageId as string}" is set to fill ${unusableTarget(fills)}, ${stays}.`, {
      ...place,
      rule: "E",
      ...(typeof fills === "string" && fills !== "" ? { componentId: fills } : {})
    });
  };

  /** Why a node of a dropped entry breaks rule A, B, C, H or I, in words, under the code that says so. */
  const droppedFinding = (entry: OwnEntry, node: OwnNode): { code: JourneyDiagnosticCode; message: string } => {
    const id: unknown = node.held.id;
    const name = typeof id === "string" && id !== "" ? id : "A node with no id";
    const named = node.parent === undefined ? name : `${name} (in ${entry.entryName})`;
    const effect = `so the page does not show ${node.parent === undefined ? "it" : `${entry.entryName}, which holds it`}`;
    const said = (code: JourneyDiagnosticCode, why: string): { code: JourneyDiagnosticCode; message: string } => ({
      code,
      message: `${named} on page "${entry.pageId}" ${why}, ${effect}.`
    });
    switch (node.rule) {
      case "A":
        return typeof id !== "string" || !isValidComponentId(id)
          ? said("presentation.entry-unusable", "has an id a component cannot have (a letter first, then letters, digits, _ or -)")
          : node.repeated
            ? said("field.id-clash", "has the id of an earlier node of the journey's own; each needs an id of its own")
            : said("field.id-clash", "has the id of a component of the form; a node of the journey's own needs an id of its own");
      case "B":
        return said("field.unsupported-type", `is a ${String(node.held.type)}, which a journey's page cannot hold as its own (no repeating section, data grid, file, signature or steps)`);
      case "C":
        return said("field.data-binding", "binds data of its own (a collection, a data path or key, or a container that scopes data), which a node of the journey's own cannot");
      case "H":
        return said(
          "presentation.entry-unusable",
          `is a node of the journey's own, and a journey holding such nodes needs an id a component could have (a letter first, then letters, digits, _ or -), which "${journey.id}" is not`
        );
      default:
        return said(
          "presentation.entry-unusable",
          `would keep its answer at @${journey.id}.${String(id)}, a key the form's own data already uses, so the answer would be sent as a form value; give it another id`
        );
    }
  };

  /**
   * Everything wrong with one entry of a page's own, node by node in document order,
   * each finding on the node it is about (`ownNodeId`). An entry a rule drops (A, B, C, H or I)
   * places nothing, so what else is wrong in it is beside the point: only why it is dropped is
   * said — every node that drops it, rule H once.
   */
  /** Where a finding about an own node is drawn: on the node it names, told apart from others on its page sharing its id. */
  const ownPlace = (node: OwnNode): DiagnosticPlace =>
    node.placeOn === undefined ? {} : node.placeRepeat > 0 ? { ownNodeId: node.placeOn, ownNodeRepeat: node.placeRepeat } : { ownNodeId: node.placeOn };

  const reportOwnEntry = (entry: OwnEntry): void => {
    const pageId = entry.pageId;
    const pageIndexAt = entry.pageAt;
    if (entry.reviewDropped) {
      report(
        "error",
        "page.review-form-field",
        `${entry.entryName} on page "${pageId}" shows or fills a form field, but "${pageId}" is a Check answers page, which lists the answers and asks none, so it is not drawn. Keep only content of the journey's own there (a declaration), and ask the field on an earlier page.`,
        { pageId, pageIndex: pageIndexAt, ...(entry.entryId !== undefined ? { entryId: entry.entryId, ownNodeId: entry.entryId } : {}) }
      );
      return;
    }
    if (entry.dropped) {
      let saidH = false;
      for (const node of entry.nodes) {
        if (node.kind === "reference" || node.rule === "" || (node.rule === "H" && saidH)) {
          continue;
        }
        saidH = saidH || node.rule === "H";
        const { code, message } = droppedFinding(entry, node);
        report("error", code, message, {
          pageId,
          pageIndex: pageIndexAt,
          rule: node.rule,
          ...ownPlace(node),
          ...(code === "presentation.entry-unusable" && entry.entryId !== undefined ? { entryId: entry.entryId } : {})
        });
      }
      return;
    }
    for (const node of entry.nodes) {
      const place: DiagnosticPlace = { pageId, pageIndex: pageIndexAt, ...ownPlace(node) };
      if (node.kind === "reference") {
        // Rule D: a reference in an own layout shows a form component other than the form itself.
        const holder = node.parent !== undefined && node.parent.id !== undefined ? node.parent.id : entry.entryName;
        const componentName: unknown = node.settings.componentId;
        const shown = referencedComponent(componentName);
        if (shown !== undefined) {
          checkEntryField(pageId, pageIndexAt, shown, ownPlace(node));
        } else if (componentName === root.id) {
          report("error", "page.root-component", `A reference in ${holder} on page "${pageId}" shows the form itself (${root.id}), so it is skipped: nothing is drawn in its place.`, {
            ...place,
            componentId: root.id,
            rule: "D"
          });
        } else {
          const what = typeof componentName === "string" && componentName !== "" ? `${componentName}, which is not a component of the form` : "no component of the form";
          report("error", "page.unknown-component", `A reference in ${holder} on page "${pageId}" shows ${what}, so it is skipped: nothing is drawn in its place.`, {
            ...place,
            ...(typeof componentName === "string" && componentName !== "" ? { componentId: componentName } : {}),
            rule: "D"
          });
        }
        continue;
      }
      const id = node.id as string;
      const named = node.parent === undefined ? id : `${id} (in ${entry.entryName})`;
      // Ids the designer refuses though the runtime reads them: a page's, and its own prefix.
      if (pageIds.has(id)) {
        report(
          "error",
          "field.id-clash",
          `${named} on page "${pageId}" has the id of a page of the journey ("${id}"); a node of the journey's own needs an id no page has, as the texts of both are translated by their id.`,
          place
        );
      } else if (id === "journey" || id.startsWith("journey-")) {
        report("error", "field.id-clash", `${named} on page "${pageId}" has an id starting with "journey", which the designer keeps for its own nodes; give it another id.`, place);
      }
      switch (node.kind) {
        case "worked-out":
          checkWorkedOut(node, named, place);
          break;
        case "ignored":
          reportIgnoredWorkedOut(node, named, place);
          break;
        case "alias":
          checkAlias(node, named, place);
          break;
        case "layout": {
          if (node.settings.fills !== undefined) {
            reportUnusedFills(entry, node, named, place);
          }
          if (node.mapped) {
            // What it holds that shows a form field: the first, in words.
            const first = entry.nodes.find((inner) => {
              let around = inner.parent;
              while (around !== undefined && around !== node) {
                around = around.parent;
              }
              return around === node && (inner.kind === "alias" || inner.kind === "worked-out" || (inner.kind === "reference" && referencedComponent(inner.settings.componentId) !== undefined));
            }) as OwnNode;
            const field =
              first.kind === "reference"
                ? (first.settings.componentId as string)
                : ((first.kind === "alias" ? journeyOwn(aliasOf, first.id as string) : journeyOwn(workedOutOf, first.id as string)) as string);
            const shows =
              first.kind === "reference"
                ? `holds ${field}, a form field`
                : `holds ${first.id as string}, which ${first.kind === "alias" ? "fills" : "works out"} ${field}`;
            checkHidesFormField(node, named, place, shows, field);
          }
          checkOwnRules(node, named, place);
          break;
        }
        case "field": {
          if (node.settings.fills !== undefined) {
            reportUnusedFills(entry, node, named, place);
          } else if (workedOutReads.get(pageId)?.has(id) !== true && !ownRuleReaders.has(id) && options.isValueless?.(node.held as unknown as ComponentNode) !== true) {
            // A plugin's type the host says holds no answer (a link) has nothing to keep.
            report(
              "warning",
              "field.goes-nowhere",
              `${named} on page "${pageId}" fills no form field, and no worked-out value or rule of the journey reads it, so its answer is kept in the browser only: checked there and kept in drafts, never sent, printed or exported. That is allowed — to send it, set the form field it fills.`,
              place
            );
          }
          checkOwnRules(node, named, place);
          break;
        }
        default:
          if (node.settings.fills !== undefined) {
            reportUnusedFills(entry, node, named, place);
          }
          checkOwnRules(node, named, place);
      }
    }
  };

  /**
   * `component.placed-twice`: a form field a page places more than once, where one of
   * them is the page's own doing — an alias filling it, or a reference in an own layout showing
   * it (or what holds it) — beside a listing or another of those. Said once, for the outermost
   * component placed so, as `component.multiple-pages` is.
   */
  const checkPlacedTwice = (page: JourneyPage, at: number): void => {
    type Placement = { key: string; via: string; own: string | undefined; kind: "listed" | "reference" | "alias"; holder?: string };
    const placements = new Map<string, Placement[]>();
    const place = (componentId: string, placement: Placement): void => {
      const subtree: ComponentNode[] = [index.nodeById.get(componentId) as ComponentNode];
      while (subtree.length > 0) {
        const node = subtree.pop() as ComponentNode;
        const list = placements.get(node.id) ?? [];
        if (!list.some((existing) => existing.key === placement.key)) {
          list.push(placement);
        }
        placements.set(node.id, list);
        for (const group of Object.values(node.children ?? {})) {
          for (const child of group ?? []) {
            subtree.push(child);
          }
        }
      }
    };
    let ownPlaced = false;
    (page.components ?? []).forEach((listed: unknown, entryAt) => {
      if (typeof listed === "string" || (isRecord(listed) && listed.type === PRESENTATION_REFERENCE_TYPE)) {
        const componentId = typeof listed === "string" ? referencedComponent(listed) : referencedComponent(isRecord(listed.configuration) ? listed.configuration.componentId : undefined);
        if (componentId !== undefined) {
          place(componentId, { key: `listed:${entryAt}`, via: componentId, own: undefined, kind: "listed" });
        }
        return;
      }
      const entry = ownEntryAt.get(`${at}:${entryAt}`);
      if (entry === undefined || entry.dropped || entry.reviewDropped) {
        return;
      }
      entry.nodes.forEach((node, position) => {
        if (node.kind === "reference") {
          const shown = referencedComponent(node.settings.componentId);
          if (shown !== undefined) {
            ownPlaced = true;
            const holder = node.parent !== undefined && node.parent.id !== undefined ? node.parent.id : entry.entryName;
            place(shown, { key: `reference:${entryAt}:${position}`, via: shown, own: node.placeOn, kind: "reference", holder });
          }
        } else if (node.kind === "alias") {
          ownPlaced = true;
          place(journeyOwn(aliasOf, node.id as string) as string, { key: `alias:${node.id as string}`, via: node.id as string, own: node.id, kind: "alias" });
        }
      });
    });
    if (!ownPlaced) {
      return;
    }
    for (const node of index.order) {
      const list = placements.get(node.id);
      if (list === undefined || list.length < 2 || !list.some((placement) => placement.kind !== "listed")) {
        continue;
      }
      const parent = index.parentOf.get(node.id);
      const parentList = parent !== undefined ? placements.get(parent) : undefined;
      if (parentList !== undefined && parentList.length === list.length && list.every((placement) => parentList.indexOf(placement) >= 0)) {
        continue;
      }
      const words = list.map((placement) =>
        placement.kind === "alias"
          ? `filled by ${placement.via}`
          : placement.kind === "reference"
            ? `shown by a reference in ${placement.holder as string}${placement.via === node.id ? "" : ` (inside ${placement.via})`}`
            : `listed on the page${placement.via === node.id ? "" : ` (inside ${placement.via})`}`
      );
      const said = words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1] as string}`;
      const asked = list.some((placement) => placement.kind === "alias");
      const second = list[1] as Placement;
      const own = second.own ?? list.find((placement) => placement.own !== undefined)?.own;
      report(
        "warning",
        "component.placed-twice",
        `${node.id} is placed ${list.length === 2 ? "twice" : `${list.length} times`} on page "${page.id}": ${said}. ${
          asked ? "Each shows the same answer, so the page asks it more than once" : "The page draws it once, where it comes first, and the other shows nothing"
        }; place it once.`,
        { pageId: page.id, pageIndex: at, componentId: node.id, ...(own !== undefined ? { ownNodeId: own } : {}) }
      );
    }
  };

  // The walk the path engine can take.
  const graph = buildWalkGraph(journey);

  // Pages, their components, conditions and routes, in page order.
  const seenPageIds = new Set<string>();
  pages.forEach((page, at) => {
    const pageId = page.id;
    if (seenPageIds.has(pageId)) {
      report("error", "page.duplicate-id", `Two pages of journey "${journey.id}" have the id "${pageId}"; routes reach only the first.`, { pageId, pageIndex: at });
    }
    seenPageIds.add(pageId);
    if (index.nodeById.has(pageId)) {
      report("error", "page.id-is-component-id", `Page "${pageId}" has the id of a component of the form; give the page an id of its own.`, { pageId, pageIndex: at });
    }

    // What the page lists, in its order: form components by id — or, at the top of the page, by
    // a reference, which reads as the id does — and the entries of the page's own,
    // each node of which is judged where it stands (`reportOwnEntry`).
    (page.components ?? []).forEach((listed: unknown, entryAt) => {
      const entry = ownEntryAt.get(`${at}:${entryAt}`);
      if (entry !== undefined) {
        reportOwnEntry(entry);
        return;
      }
      const named: unknown = isRecord(listed) ? (isRecord(listed.configuration) ? listed.configuration.componentId : undefined) : listed;
      if (typeof named !== "string") {
        // Neither an id nor a node: nothing the shape check lets through, and nothing to judge.
        return;
      }
      const componentId = named;
      if (page.kind === "review") {
        // A review page lists the path's answers and asks none: the ownership places nothing of
        // the form on it, on both sides.
        report(
          "error",
          "page.review-form-field",
          `Page "${pageId}" is a Check answers page and lists ${componentId}; a Check answers page lists the answers given on the way and asks none, so it is not drawn there. Ask it on an earlier page.`,
          { pageId, pageIndex: at, componentId }
        );
        return;
      }
      if (componentId === root.id) {
        report("error", "page.root-component", `Page "${pageId}" lists the form itself (${root.id}); list the components it should show instead.`, { pageId, pageIndex: at, componentId });
        return;
      }
      if (!index.nodeById.has(componentId)) {
        report("error", "page.unknown-component", `Page "${pageId}" lists ${componentId}, which is not a component of the form.`, { pageId, pageIndex: at, componentId });
        return;
      }
      checkEntryField(pageId, at, componentId);
    });
    if (page.kind !== "review") {
      checkPlacedTwice(page, at);
    }

    const members = ownership.membersOf[pageId] ?? [];
    // A member's label, for the heading a page without a title borrows, as the runtime draws the
    // page: a form component's, or — for an entry of the page's own — its own label;
    // a worked-out value with no label at all is drawn as a copy of its form field, under that
    // field's label. An alias is drawn as written, so one with no label borrows nothing.
    const memberLabel = (memberId: string): unknown => {
      const own = ownEntries.get(memberId);
      if (own === undefined || index.nodeById.has(memberId)) {
        return labelOf(index.nodeById.get(memberId));
      }
      const label = labelOf(own);
      const worked = journeyOwn(workedOutOf, memberId);
      return label === undefined && worked !== undefined ? labelOf(index.nodeById.get(worked)) : label;
    };
    const isExit = page.kind === "exit";
    const isReview = page.kind === "review";
    if (isExit) {
      if (page.validation !== undefined) {
        report(
          "warning",
          "page.validation-on-exit",
          `Page "${pageId}" is an exit page and has validation settings; an exit page has no Continue and sends nothing, so they are never used.`,
          { pageId, pageIndex: at }
        );
      }
    } else {
      const validation = journeyPageValidation(journey, page);
      if (validation.continue === "defer" && validation.server) {
        report(
          "warning",
          "page.validation-server-deferred",
          `Page "${pageId}" is not checked on Continue (the default is to move on and check at the end) yet asks the host's server to check it; a step is checked against the server on Continue only when its validation.continue is "page", so server is ignored there.`,
          { pageId, pageIndex: at }
        );
      }
    }
    if (journey.heading !== "hidden" && !hasText(page.title)) {
      const first = members[0];
      if (first === undefined) {
        report("warning", "page.no-title", `Page "${pageId}" has no title and no component to borrow one from, so it is shown without a heading. Give the page a title.`, { pageId, pageIndex: at });
      } else if (!hasText(memberLabel(first))) {
        report(
          "warning",
          "page.no-title",
          `Page "${pageId}" has no title, and its first component, ${first}, has no label to borrow, so it is shown without a heading. Give the page a title.`,
          { pageId, pageIndex: at }
        );
      }
    }

    let shadowedBy: number | undefined;
    (page.routes ?? []).forEach((route, routeIndex) => {
      const where = `Route ${routeIndex + 1} of page "${pageId}"`;
      const place: DiagnosticPlace = { pageId, pageIndex: at, routeIndex };
      if (isReview && route.to !== "$end") {
        // The walk ends at a review page: a route on it to anywhere but the end is never taken.
        report(
          "error",
          "page.review-not-last",
          `${where} goes on to "${route.to}", but "${pageId}" is a Check answers page, which is the last page before the end: its routes are never taken, and the journey submits from it. Move the route to an earlier page.`,
          place
        );
      }
      if (shadowedBy !== undefined) {
        report("warning", "route.shadowed", `${where} can never be taken: route ${shadowedBy + 1} before it always matches.`, place);
      }
      const target = route.to === "$end" ? pages.length : pageIndex.get(route.to);
      if (target === undefined) {
        report("error", "route.unknown-target", `${where} goes to "${route.to}", which is not a page of the journey, so it is ignored.`, place);
      } else if (target <= at) {
        const back = target === at ? "to the page itself" : `back to page "${route.to}"`;
        report("error", "route.backward", `${where} goes ${back}; routes only go forward, so it is ignored.`, place);
      } else if (route.when === undefined && shadowedBy === undefined) {
        shadowedBy = routeIndex;
      }
      if (route.when !== undefined) {
        checkCondition(route.when, where, at, place);
      }
    });
  });

  // Check answers: one per journey, the last page before the end. The walk ends at a review
  // page whatever follows it, so a page listed after it — bar an ending (an exit page) — is one
  // its author meant the person to reach after checking their answers, or one a path reaches
  // only by passing the check by.
  let firstReview: number | undefined;
  pages.forEach((page, at) => {
    if (page.kind !== "review") {
      return;
    }
    if (firstReview !== undefined) {
      report(
        "error",
        "page.review-repeated",
        `Page "${page.id}" is a second Check answers page; a journey has one, its last page before the end (page "${(pages[firstReview] as JourneyPage).id}" is the first). Make this one a questions page or remove it.`,
        { pageId: page.id, pageIndex: at }
      );
      return;
    }
    firstReview = at;
    for (let after = at + 1; after < pages.length; after += 1) {
      if (graph.exit[after] !== true) {
        report(
          "error",
          "page.review-not-last",
          `Page "${page.id}" is a Check answers page but page "${(pages[after] as JourneyPage).id}" comes after it; a Check answers page is the last page before the end, so the journey submits from it and "${(pages[after] as JourneyPage).id}" is never reached through it. Move the Check answers page to the end (only ending pages may follow it).`,
          { pageId: page.id, pageIndex: at }
        );
        break;
      }
    }
  });

  // The walk: can a path end with a submit, and which pages can a path reach?
  const everyWalk = exploreWalks(graph);
  if (pages.length === 0) {
    report("error", "journey.no-end", `Journey "${journey.id}" has no pages, so there is nothing to submit from.`);
  } else if (!everyWalk.ends) {
    report("error", "journey.no-end", `Every path through journey "${journey.id}" ends at an exit page, so it can never be submitted.`);
  }
  pages.forEach((page, at) => {
    if (!everyWalk.onPath[at]) {
      report("warning", "page.unreachable", `No path through the journey reaches page "${page.id}".`, { pageId: page.id, pageIndex: at });
    }
  });

  // A journey with a Check answers page submits through it: a path that reaches the end without
  // it sends answers the person never checked. Read as every walk that may not put the review
  // page on the path (a walk arriving there stops): one that still ends left it out. Each route to the end that such a walk can take is named; a path past it by a
  // page listed after it is page.review-not-last's.
  const reviewAt = pages.findIndex((page) => page.kind === "review");
  if (reviewAt >= 0 && everyWalk.ends) {
    const reviewId = (pages[reviewAt] as JourneyPage).id;
    const around = exploreWalks(graph, { avoid: new Set([reviewAt]) });
    if (around.ends) {
      let named = false;
      pages.forEach((page, at) => {
        if (at >= reviewAt || !around.onPath[at] || graph.exit[at] === true) {
          return;
        }
        for (const [routeIndex, route] of (page.routes ?? []).entries()) {
          const target = route.to === "$end" ? pages.length : pageIndex.get(route.to);
          if (target === undefined || target <= at) {
            continue;
          }
          if (target === pages.length) {
            named = true;
            report(
              "warning",
              "page.review-bypassed",
              `Route ${routeIndex + 1} of page "${page.id}" goes to the end, so a path through it submits without passing the Check answers page "${reviewId}". Send it to "${reviewId}" instead, or let the page fall through.`,
              { pageId: page.id, pageIndex: at, routeIndex }
            );
          }
          if (route.when === undefined) {
            break;
          }
        }
      });
      if (!named) {
        report("warning", "page.review-bypassed", `A path through journey "${journey.id}" submits without passing the Check answers page "${reviewId}".`, { pageId: reviewId, pageIndex: reviewAt });
      }
    }
  }

  // Hidden by its configuration with no rule to show it: off screen on both sides, as the walk
  // graph's `alwaysHidden` reads it. A hidden field with a `visibleWhen` may be shown.
  const alwaysHidden = (node: ComponentNode): boolean => kernelReadFlag(node.configuration, "hidden") && !(node.rules && node.rules.visibleWhen);
  // A field the fold holds to its Required off screen, on the whole form and through a journey
  // alike: one that opts in to being required while hidden AND to being validated while hidden.
  // `computeEffectiveNodeState` gates `requiredApplies` by `hiddenRequiredBehavior`, but a
  // hidden field not validated is held only to the shape of the answer it submits — the
  // kernel's `shapeOnly`, the browser's `errorPassesHiddenPolicy` — so `hiddenRequiredBehavior:
  // "required"` alone enforces nothing.
  const requiredWhenHidden = (node: ComponentNode): boolean => {
    const configuration = node.configuration;
    if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration)) {
      return false;
    }
    const record = configuration as Record<string, unknown>;
    return record.hiddenRequiredBehavior === "required" && record.hiddenValidationBehavior === "validate";
  };
  // A node whose own `visibleWhen` reads `host.`, and one whose own Required-when rule does
  // (`kernelFoldRequiredReadsHost`): the server cannot replay either, so on no page the fold
  // holds the field to neither, on both sides.
  const ownVisibilityReadsHost = (node: ComponentNode): boolean => {
    const visibility = ruleOf(node.rules ? node.rules.visibleWhen : undefined);
    return visibility !== undefined && kernelExprReadsHost(visibility);
  };
  const requiredRuleReadsHost = (node: ComponentNode): boolean => requiresOwnAnswer(node) === "rule" && kernelFoldRequiredReadsHost(node);
  /**
   * What makes the form require a node's answer, for a node reported whole with what it holds
   * (a data-scoping container) as for a field — the first of each kind, in document order:
   * `blocking`, a field in it the form holds to its Required through this journey and a page
   * can ask; `hiddenBlocking`, one it holds to its Required while hidden for good (it opts in),
   * which no page can ask; and `hostBound`, one held to a Required only as the host decides
   * (its visibility, its own rule's or one below `node`, or its Required-when rule reads
   * `host.`), which neither side enforces on no page. A calculated field is passed over: what
   * it comes to is the calculation's, judged with its inputs (`calc.input-left-out`). The
   * entries of a repeating section only exist once someone adds them, so a section is looked
   * into no further. `hidden`: off screen by configuration, the node's own or an ancestor's, so
   * only an opt-in counts; `viaHost`: an ancestor's visibility, below the node reported, reads
   * `host.`.
   */
  interface RequiredWithin {
    blocking?: ComponentNode;
    hiddenBlocking?: ComponentNode;
    hostBound?: ComponentNode;
  }
  const requiredWithin = (node: ComponentNode, hidden: boolean, viaHost: boolean, found: RequiredWithin): RequiredWithin => {
    const hostHere = viaHost || ownVisibilityReadsHost(node);
    if (
      node.rules?.value === undefined &&
      requiresOwnAnswer(node) !== undefined &&
      defaultAnswer(node) !== "literal" &&
      (!hidden || requiredWhenHidden(node))
    ) {
      if (hostHere || requiredRuleReadsHost(node)) {
        found.hostBound ??= node;
      } else if (hidden) {
        found.hiddenBlocking ??= node;
      } else {
        found.blocking ??= node;
      }
    }
    if (collectionPathOf(node) !== undefined) {
      return found;
    }
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group ?? []) {
        requiredWithin(child, hidden || alwaysHidden(child), hostHere, found);
      }
    }
    return found;
  };
  /**
   * A field hidden for good that the form still holds to its Required: no page can
   * ask it, wherever it sits — on a page, or on none beside a field a page can ask.
   */
  const reportHiddenRequired = (field: ComponentNode): void => {
    report(
      "error",
      "component.hidden-required",
      `${field.id} is required by the form${whenRule(field)} while hidden, and no page of journey "${journey.id}" can ask it — it is hidden on the form — so no submission through the journey can pass unless the host or a default fills it.`,
      { componentId: field.id, required: true, requiredField: field.id, hidden: true }
    );
  };
  // Whether a node's visibility — its own rule's or an ancestor's — reads `host.`, as the fold
  // decides it (`kernelFoldVisibilityReadsHost`): a field on no page whose visibility
  // does keeps the lenient fold on both sides, since the server cannot replay the host. The
  // fold reads prototype-free records: the index's maps, laid into two above.
  const visibilityReadsHost = (componentId: string): boolean => kernelFoldVisibilityReadsHost(componentId, nodeRecord, parentRecord);
  /** The node whose own `visibleWhen` reads `host.`: the component itself, else the nearest such ancestor. */
  const hostVisibilityOwner = (componentId: string): ComponentNode | undefined =>
    [index.nodeById.get(componentId), ...ancestorsOf(index, componentId)].find((node) => node !== undefined && ownVisibilityReadsHost(node));
  /** Why the host decides a field's Required: through which rule, and whose. */
  const hostReason = (field: ComponentNode): string => {
    if (requiredRuleReadsHost(field) && !visibilityReadsHost(field.id)) {
      return "that rule reads host.";
    }
    const owner = hostVisibilityOwner(field.id);
    return `its visibility${owner !== undefined && owner.id !== field.id ? ` (through ${owner.id})` : ""} reads host.`;
  };

  // Components: on no page, or on several.
  const skipBelow = new Set<string>();
  // Off screen by configuration, its own or an ancestor's, with no rule to show it: only a
  // field opting in to being required while hidden is reported under one.
  const hiddenAbove = new Set<string>();
  const leftOut: string[] = [];
  /** The components on no page reported here, host-bound ones included, for `rule.reads-host` to name. */
  const reportedLeftOut = new Set<string>();
  for (const node of index.order) {
    const parent = index.parentOf.get(node.id);
    if (node.id === root.id) {
      continue;
    }
    if (parent !== undefined && skipBelow.has(parent)) {
      skipBelow.add(node.id);
      continue;
    }
    const owners = ownership.pagesOf[node.id];
    if (owners === undefined || owners.length === 0) {
      if (ownership.structural[node.id]) {
        continue;
      }
      const offScreen = alwaysHidden(node) || (parent !== undefined && hiddenAbove.has(parent));
      if (offScreen) {
        hiddenAbove.add(node.id);
      }
      if (holdsData(node) && node.rules?.value === undefined) {
        const within = requiredWithin(node, offScreen, false, {});
        // A field a page can ask comes first: asking the node then helps, and what is hidden
        // for good beside it is said on its own, below.
        const required = within.blocking ?? within.hiddenBlocking;
        const heldByHost = within.hostBound;
        if (offScreen && required === undefined && heldByHost === undefined) {
          // Hidden by its configuration with nothing in it opting in, it and everything in it
          // is meant to be off screen.
          skipBelow.add(node.id);
          continue;
        }
        if (visibilityReadsHost(node.id)) {
          // Its visibility reads host., which the server cannot replay: on no page, the fold
          // keeps it hidden and unchecked on both sides, so the form's Required, if
          // any, is not enforced through this journey — a warning, never a blocking error.
          const owner = hostVisibilityOwner(node.id);
          const via = owner !== undefined && owner.id !== node.id ? ` (through ${owner.id})` : "";
          const held = required ?? heldByHost;
          const placed = held !== undefined ? `is required by the form${held === node ? "" : ` (${held.id} in it is)`}${whenRule(held)} and on no page` : "is on no page";
          const consequence =
            held !== undefined
              ? "neither side holds it to its rules there, so the form's requirement is not enforced through this journey"
              : "neither side holds it to its rules there";
          report(
            "warning",
            "component.unassigned",
            `${node.id} ${placed} of journey "${journey.id}", and its visibility${via} reads host., which the server cannot replay: ${consequence}.`,
            { componentId: node.id, required: false, hostBound: true }
          );
        } else if (required !== undefined) {
          // The server holds every answer to the form's rules, asked or not: a
          // required field on no page can never be filled, so nothing submitted through the
          // journey passes. A hidden field that opts in to being required is held to it too —
          // and no page can show it, so asking it changes nothing: the host or a default fills
          // it, or the form makes it optional. A default worked out from other answers meets
          // the rule only when it comes to one.
          const by = required === node ? "" : ` (${required.id} in it is)`;
          const hiddenToo = within.blocking === undefined;
          const holds = hiddenToo
            ? "so no submission through the journey can pass unless the host or a default fills it — hidden on the form, no page can ask it"
            : defaultAnswer(required) === "derived"
              ? "so its default, worked out from other answers, must come to one, or no submission through the journey can pass until it is asked"
              : requiresOwnAnswer(required) === "rule"
                ? "so no submission through the journey can pass while that rule holds, until it is asked"
                : "so no submission through the journey can pass until it is asked";
          report(
            "error",
            "component.unassigned",
            `${node.id} is required by the form${by}${whenRule(required)}${hiddenToo ? " while hidden" : ""} and on no page of journey "${journey.id}", ${holds}.`,
            { componentId: node.id, required: true, requiredField: required.id, ...(hiddenToo ? { hidden: true } : {}) }
          );
          if (!hiddenToo && within.hiddenBlocking !== undefined) {
            reportHiddenRequired(within.hiddenBlocking);
          }
        } else if (heldByHost !== undefined) {
          // Required only as the host decides — its own Required-when rule reads host., or,
          // for a field in a container reported whole, its visibility below the container does:
          // the server cannot replay the host, so on no page neither side holds it to that
          // rule — a warning, never a blocking error.
          const message =
            heldByHost === node
              ? `${node.id} is required by the form when its rule holds and on no page of journey "${journey.id}", and that rule reads host., which the server cannot replay: neither side holds it to the rule there, so the form's requirement is not enforced through this journey.`
              : `${node.id} is on no page of journey "${journey.id}", and ${heldByHost.id} in it is required by the form${whenRule(heldByHost)}, but ${hostReason(
                  heldByHost
                )}, which the server cannot replay: neither side holds it to its rules there, so the form's requirement is not enforced through this journey.`;
          report("warning", "component.unassigned", message, { componentId: node.id, required: false, hostBound: true });
        } else if (requiresOwnAnswer(node) !== undefined) {
          report(
            "warning",
            "component.unassigned",
            `${node.id} is required by the form and on no page of journey "${journey.id}": its default answer is submitted unchanged, so the form's rule is met without asking.`,
            { componentId: node.id, required: false }
          );
          leftOut.push(node.id);
        } else {
          report("warning", "component.unassigned", `${node.id} is on no page of journey "${journey.id}", so the journey never asks for it.`, { componentId: node.id, required: false });
          leftOut.push(node.id);
        }
        reportedLeftOut.add(node.id);
        skipBelow.add(node.id);
      }
      continue;
    }
    if (owners.length > 1) {
      const parentOwners = parent !== undefined ? ownership.pagesOf[parent] : undefined;
      const sameAsParent =
        parentOwners !== undefined &&
        parentOwners.length === owners.length &&
        owners.every((pageId) => parentOwners.indexOf(pageId) >= 0);
      if (!sameAsParent) {
        report(
          "warning",
          "component.multiple-pages",
          `${node.id} is on pages ${quotedList(owners)}. That suits branches that exclude each other, but a path that takes more than one of them shows it on each.`,
          { componentId: node.id }
        );
      }
    }
  }

  // The optional fields left out, once for the journey: their answers are still held to the
  // form's rules, only never asked here. Named and counted as the builder's tray lists them
  // (`unassignedMembers`): a field inside a container that holds no answer of its own (a
  // fieldset; never a step, whose frame is its steps container's) is that container's, the
  // outermost one, named once.
  if (leftOut.length > 0) {
    const listedAs = (id: string): string => {
      let listed = id;
      for (const ancestor of ancestorsOf(index, id)) {
        if (
          ancestor.id !== root.id &&
          !ownership.structural[ancestor.id] &&
          ancestor.type !== STEP_COMPONENT_TYPE &&
          !holdsData(ancestor) &&
          (ownership.pagesOf[ancestor.id] ?? []).length === 0
        ) {
          listed = ancestor.id;
        }
      }
      return listed;
    };
    const named = [...new Set(leftOut.map(listedAs))];
    const shown = named.length > 5 ? `${named.slice(0, 5).map((id) => `"${id}"`).join(", ")} and ${named.length - 5} more` : quotedList(named);
    report(
      "warning",
      "presentation.fields-left-out",
      `${named.length} form ${named.length === 1 ? "field is" : "fields are"} not asked in journey "${journey.id}": ${shown}. The server still holds ${
        named.length === 1 ? "its answer" : "their answers"
      } to the form's rules.`
    );
  }

  // Inside a repeating section: its entries only exist once someone adds them.
  const sectionAbove = (componentId: string): boolean => ancestorsOf(index, componentId).some((ancestor) => collectionPathOf(ancestor) !== undefined);
  // Off screen for good: hidden by its configuration, its own or an ancestor's, with no rule to show it.
  const hiddenForGood = (node: ComponentNode): boolean => alwaysHidden(node) || ancestorsOf(index, node.id).some(alwaysHidden);

  // A field hidden for good that opts in to being required and validated while hidden is held
  // to its Required on a page as on none — the fold reads it as the whole form does — and
  // listing it, or the container it sits in, shows nothing: the error stands while it is on a
  // page too. On no page it is reported above, itself or with what holds it.
  for (const node of index.order) {
    if (
      node.id !== root.id &&
      node.rules?.value === undefined &&
      holdsData(node) &&
      ownerIndexes(node.id).length > 0 &&
      requiresOwnAnswer(node) !== undefined &&
      defaultAnswer(node) !== "literal" &&
      requiredWhenHidden(node) &&
      hiddenForGood(node) &&
      !sectionAbove(node.id)
    ) {
      reportHiddenRequired(node);
    }
  }

  // A required calculation that comes out empty for want of an input the journey never asks
  //: the fold holds the calculated field to its Required wherever it sits, on a
  // page or on none, so every side refuses every submission until the input is asked. The
  // node reported is the input's — itself, or the container reported whole above it — since
  // that is what a page can ask; `requiredField` is the calculated field.
  const leftOutUnit = (componentId: string): string | undefined =>
    [componentId, ...ancestorsOf(index, componentId).map((ancestor) => ancestor.id)].find((id) => reportedLeftOut.has(id));
  interface EmptyFor {
    /** The calculated field judged: a calculation reading itself reads nothing new. */
    self: string;
    /** The calculations being read through, so one reading another in a circle ends. */
    open: Set<string>;
    /** Count an input answered by its default ({@link inputDefault}) as unanswered all the same: what the warning names. */
    defaults: boolean;
    /** The calculated field is a checkbox, for which `false` is no answer. */
    checkbox: boolean;
    /** The calculated field's type: what a literal argument is read as empty against. */
    type: string;
  }
  /**
   * How an input on no page is answered all the same: by a literal default that is not empty
   * for its type (`literal`: the browser seeds it and submits it unchanged), or by a default
   * that is a plain path to an answer a page asks (`placed`, with the component it reads: the
   * browser seeds it once that is answered, and sends it). Under this check's own assumption —
   * everything a page asks is answered — either answers the input. Any other default (a path to
   * an answer no page asks, a calculation, `host.`) may come to nothing.
   */
  const inputDefault = (node: ComponentNode): { kind: "literal" } | { kind: "placed"; source: string } | undefined => {
    const answer = defaultAnswer(node);
    if (answer === "literal") {
      return { kind: "literal" };
    }
    const rule = ruleOf(node.rules ? node.rules.defaultValue : undefined);
    if (answer !== "derived" || rule === undefined || rule.kind !== "path" || isScopedPath(rule.path)) {
      return undefined;
    }
    const source = index.nodeById.get(rule.path);
    return source !== undefined &&
      source.id !== root.id &&
      source.id !== node.id &&
      journeyHoldsOwnAnswer(source) &&
      !(source.rules && source.rules.value) &&
      ownerIndexes(source.id).length > 0
      ? { kind: "placed", source: source.id }
      : undefined;
  };
  /**
   * Whether an argument of a `coalesce` reads as no answer when its inputs are missing, so that
   * the coalesce passes over it: a bare path (an unanswered field is `null`), a `null` literal,
   * arithmetic over such an argument (an operand that is no answer makes the result no answer,
   * never `NaN`), a one-value number function over one (`abs`, `round`, `floor`, `ceil`,
   * `roundTo`, `roundUp`, `roundDown`, `sqrt`, `power`, `modulo`, `clamp`, `number`), a
   * `coalesce` of only those, or an `if` with no `else` (no case holding is no answer) or whose
   * every branch is one of those. Any other expression comes to a value whatever it reads: a
   * `concat` to `""`, a `sum` to a number.
   */
  const nullWhenMissing = (argument: Expression): boolean =>
    argument.kind === "path" ||
    (argument.kind === "literal" && (argument.value === null || argument.value === undefined)) ||
    (argument.kind === "arithmetic" && (nullWhenMissing(argument.left) || nullWhenMissing(argument.right))) ||
    (argument.kind === "call" && NUMBER_OF_ONE.has(argument.name) && argument.args.some(nullWhenMissing)) ||
    (argument.kind === "call" && argument.name === "coalesce" && argument.args.every(nullWhenMissing)) ||
    (argument.kind === "if" && (argument.else === undefined || (argument.cases.every((entry) => nullWhenMissing(entry.then)) && nullWhenMissing(argument.else))));
  /**
   * The inputs on no page for want of which `expression` comes out empty, as the evaluator
   * works it out with them unanswered and everything else answered: arithmetic and the
   * number and text functions come to nothing when an operand does; a `sum` and a `len` always
   * come to a number; a `concat` only comes to nothing when every argument does — an input
   * missing, or a literal blank once joined (`""`, `" "`); a `coalesce` comes to its first
   * argument that is not `null`: it passes over an argument that reads as `null` with its
   * inputs missing ({@link nullWhenMissing}: a bare path), and stops at any other, which comes
   * to a value all the same, empty when its inputs are missing (a `concat` to `""`), so it
   * comes to nothing when the inputs up to such an argument, or up to an empty
   * literal (empty for the calculated field's type), or every argument, are missing; a
   * comparison, a condition and a function returning true or false (`contains`, `empty`,
   * `startsWith`, `any`) always come to a value, except for a checkbox, where any input they
   * read may leave it unticked (`strict`); a `count` and a `today()` always come to a value; an
   * `if` comes to nothing only when every branch does for want of some input (a missing `else`
   * is a branch that comes to nothing with no input wanting, so it does not block; a branch
   * coming to a value whatever is missing means the whole may), and on a checkbox every `when`
   * counts too. A calculation read is followed into what it reads.
   */
  const emptyFor = (expression: Expression, context: EmptyFor, strict = false): ComponentNode[] => {
    switch (expression.kind) {
      case "path": {
        const read = isScopedPath(expression.path) ? undefined : componentOfPath(expression.path);
        const node = read !== undefined ? index.nodeById.get(read) : undefined;
        if (node === undefined || node.id === context.self || context.open.has(node.id)) {
          return [];
        }
        if (node.rules?.value !== undefined) {
          const calculation = ruleOf(node.rules.value);
          if (calculation === undefined) {
            return [];
          }
          context.open.add(node.id);
          const through = emptyFor(calculation, context, strict);
          context.open.delete(node.id);
          return through;
        }
        if (leftOutUnit(node.id) === undefined || (!context.defaults && inputDefault(node) !== undefined)) {
          return [];
        }
        return [node];
      }
      case "arithmetic":
      case "binary":
      case "logical": {
        // A chain (a + b + c ..., a and b and c ...) is read down its left spine with a list, not
        // by recursion, and its inputs gathered in reading order: a 20,000-term condition costs
        // neither call-stack depth nor a copy of the list per link. Arithmetic keeps `strict`; a
        // comparison or condition reads strictly, and only for a strict read or a checkbox.
        const rights: Array<{ expression: Expression; strict: boolean }> = [];
        let walk: Expression = expression;
        let held = strict;
        let blank = false;
        while (walk.kind === "arithmetic" || walk.kind === "binary" || walk.kind === "logical") {
          if (walk.kind !== "arithmetic") {
            if (!(held || context.checkbox)) {
              blank = true;
              break;
            }
            held = true;
          }
          rights.push({ expression: walk.right, strict: held });
          walk = walk.left;
        }
        const found: ComponentNode[] = blank ? [] : emptyFor(walk, context, held);
        for (let at = rights.length - 1; at >= 0; at -= 1) {
          const right = rights[at] as { expression: Expression; strict: boolean };
          for (const input of emptyFor(right.expression, context, right.strict)) {
            found.push(input);
          }
        }
        return found;
      }
      case "call": {
        if (FUNCTION_RETURNS.get(expression.name) === "boolean") {
          return strict || context.checkbox ? expression.args.flatMap((argument) => emptyFor(argument, context, true)) : [];
        }
        const each = expression.args.map((argument) => emptyFor(argument, context, strict));
        if (strict) {
          return each.flat();
        }
        if (expression.name === "sum" || expression.name === "len" || expression.name === "count" || expression.name === "today") {
          return [];
        }
        if (expression.name === "concat") {
          const blank = (argument: Expression): boolean => argument.kind === "literal" && String(argument.value ?? "").trim() === "";
          return expression.args.every((argument, at) => blank(argument) || (each[at] as ComponentNode[]).length > 0) ? each.flat() : [];
        }
        if (expression.name === "coalesce") {
          const before: ComponentNode[] = [];
          for (let at = 0; at < expression.args.length; at += 1) {
            const argument = expression.args[at] as Expression;
            if (argument.kind === "literal") {
              if (argument.value === null || argument.value === undefined) {
                continue;
              }
              // What the calculation comes to when everything before it is missing.
              return emptyAnswer(argument.value, context.type) ? before : [];
            }
            const inputs = each[at] as ComponentNode[];
            if (inputs.length === 0) {
              return [];
            }
            before.push(...inputs);
            // Only what reads as no answer with its inputs missing is passed over: a bare path,
            // arithmetic over one, or a coalesce of nothing else. Anything else comes to a value
            // even then (a concat to "") which ends the coalesce, empty.
            if (!nullWhenMissing(argument)) {
              return before;
            }
          }
          return before;
        }
        return each.flat();
      }
      case "unary":
        return strict || context.checkbox ? emptyFor(expression.operand, context, true) : [];
      case "if": {
        if (strict || context.checkbox) {
          return [
            ...expression.cases.flatMap((entry) => [...emptyFor(entry.when, context, true), ...emptyFor(entry.then, context, true)]),
            ...(expression.else !== undefined ? emptyFor(expression.else, context, true) : [])
          ];
        }
        // Empty for want of inputs only when every branch is: a branch that comes to a value
        // whatever is missing (a literal, a sum) means the calculation may come to one; a
        // missing else comes to nothing, wanting no input, so it does not block.
        const branches = [...expression.cases.map((entry) => emptyFor(entry.then, context, strict)), ...(expression.else !== undefined ? [emptyFor(expression.else, context, strict)] : [])];
        return branches.every((inputs) => inputs.length > 0) ? branches.flat() : [];
      }
      default:
        return [];
    }
  };
  for (const node of index.order) {
    const calculation = ruleOf(node.rules?.value);
    if (node.id === root.id || calculation === undefined || requiresOwnAnswer(node) === undefined || sectionAbove(node.id)) {
      continue;
    }
    // Held to its Required here as a field is: not while hidden for good unless it opts in, and
    // not on no page when only the host decides whether it is shown or required.
    if (hiddenForGood(node) && !requiredWhenHidden(node)) {
      continue;
    }
    if (ownerIndexes(node.id).length === 0 && (visibilityReadsHost(node.id) || requiredRuleReadsHost(node))) {
      continue;
    }
    const inputsFor = (defaults: boolean): ComponentNode[] => [
      ...new Set(emptyFor(calculation, { self: node.id, open: new Set<string>(), defaults, checkbox: node.type === "checkbox", type: node.type }))
    ];
    const blocking = inputsFor(false);
    // Nothing blocks: an input answered by its default is still worth a word, as a required
    // field answered by its default is.
    const inputs = blocking.length > 0 ? blocking : inputsFor(true).filter((input) => inputDefault(input) !== undefined);
    const said = new Set<string>();
    for (const input of inputs) {
      const unit = leftOutUnit(input.id) as string;
      if (said.has(unit)) {
        continue;
      }
      said.add(unit);
      const from = `${node.id} is required by the form${whenRule(node)} and worked out from ${input.id}${unit === input.id ? "" : ` (in ${unit})`}, which journey "${journey.id}" never asks`;
      if (blocking.length > 0) {
        report(
          "error",
          "calc.input-left-out",
          `${from}: it comes out empty, so no submission through the journey can pass${requiresOwnAnswer(node) === "rule" ? " while that rule holds," : ""} until ${unit} is asked.`,
          { componentId: unit, required: true, requiredField: node.id }
        );
      } else {
        const answered = inputDefault(input);
        report(
          "warning",
          "calc.input-left-out",
          answered !== undefined && answered.kind === "placed"
            ? `${from}: its default is taken from ${answered.source}, which a page asks, so the form's rule is met once that is answered.`
            : `${from}: its default answer is submitted unchanged, so the form's rule is met without asking.`,
          { componentId: unit, required: false }
        );
      }
    }
  }

  // Calculations reading answers some path leaves off: they may be worked out without them.
  const canLeaveOff = new Map<string, boolean>();
  for (const node of index.order) {
    const calculation = ruleOf(node.rules?.value);
    if (calculation === undefined) {
      continue;
    }
    const meet = new Set(ownerIndexes(node.id));
    const flagged = new Set<string>();
    for (const path of extractDependencies(calculation)) {
      if (isScopedPath(path)) {
        continue;
      }
      const read = componentOfPath(path);
      if (read === undefined || read === node.id || flagged.has(read)) {
        continue;
      }
      const owners = ownerIndexes(read);
      if (owners.length === 0) {
        continue;
      }
      const key = `${node.id}\u0000${read}`;
      let off = canLeaveOff.get(key);
      if (off === undefined) {
        const options: WalkOptions = { avoid: new Set(owners) };
        if (meet.size > 0) {
          options.meet = meet;
        }
        off = exploreWalks(graph, options).ends;
        canLeaveOff.set(key, off);
      }
      if (off) {
        flagged.add(read);
        report(
          "warning",
          "calc.reads-branch",
          `The calculation of ${node.id} reads ${read}, which some paths through the journey leave off, so ${node.id} may be calculated without it.`,
          { componentId: node.id }
        );
      }
    }
  }

  // Rules a server checking the submission cannot evaluate: it has no host context.
  for (const node of index.order) {
    const rules = node.rules;
    if (!rules) {
      continue;
    }
    // A component on no page of the journey whose visibility reads host. keeps the lenient
    // fold on both sides: hidden, not required, not checked. One on a page, or
    // holding a listed component, keeps the usual difference — the browser follows the host,
    // the server its configuration — and the components on no page under it are named, since
    // the fold reads them the lenient way through it.
    const onNoPage = node.id !== root.id && !ownership.structural[node.id] && (ownership.pagesOf[node.id] ?? []).length === 0;
    const configured = kernelReadFlag(node.configuration, "hidden") ? "hidden" : "shown";
    const under =
      onNoPage || !rules.visibleWhen
        ? []
        : index.order.filter((candidate) => reportedLeftOut.has(candidate.id) && ancestorsOf(index, candidate.id).some((ancestor) => ancestor.id === node.id)).map((candidate) => candidate.id);
    const visibility = onNoPage
      ? `, and ${node.id} is on no page of journey "${journey.id}": neither side holds it to its rules there — not required, not checked`
      : `, so the server treats ${node.id} as ${configured}${
          under.length > 0
            ? `; ${quotedList(under)} in it ${under.length === 1 ? "is" : "are"} on no page of journey "${journey.id}", so neither side holds ${under.length === 1 ? "it" : "them"} to ${
                under.length === 1 ? "its" : "their"
              } rules there`
            : ""
        }`;
    const checked: Array<[string, unknown, string, string]> = [
      ["visibleWhen", rules.visibleWhen, "visibility rule", visibility],
      ["enabledWhen", rules.enabledWhen, "enabled rule", ""],
      ["readonlyWhen", rules.readonlyWhen, "read-only rule", ""],
      // The kernel reads such a rule as false: the browser holds the field to it, the
      // server does not — and on no page of the journey, neither does the browser (`kernelFoldRequiredReadsHost`): it would hold the person to a rule nobody can answer here.
      [
        "requiredWhen",
        rules.requiredWhen,
        "required rule",
        onNoPage
          ? `, and ${node.id} is on no page of journey "${journey.id}": neither side holds it to that rule there`
          : `, so the server does not hold ${node.id} to it`
      ],
      ["value", rules.value, "calculation", ""]
    ];
    /** The names of the rules reading the clock that no finding above has covered: one `rule.reads-clock` names them all. */
    const clockRules: string[] = [];
    /** The form fields a secret rule reads that a browser-only rule may hide, each said once. */
    const saidHidden = new Set<string>();
    for (const [key, source, name, consequence] of checked) {
      const rule = ruleOf(source);
      if (rule === undefined) {
        continue;
      }
      const run: RunScope = kernelRuleRun(source);
      const serverOnly = run === "server" || run === "server-secret";
      const paths = [...extractDependencies(rule)];
      const hostPath = paths.find((path) => path.startsWith("host."));
      const clock = kernelExprReadsClock(rule);
      // A rule run on both sides that reads `host.` warns. A browser-only rule the server skips as it skips a host read, so
      // there is nothing to say; a server-only one is the next finding's.
      if (run === "both" && hostPath !== undefined && key !== "value") {
        report(
          "warning",
          "rule.reads-host",
          `The ${name} of ${node.id} reads ${hostPath}, which a server checking the submission does not have${consequence}.`,
          { componentId: node.id }
        );
      }
      if (serverOnly && hostPath !== undefined) {
        report(
          "error",
          "rule.server-cannot-run",
          `The ${name} of ${node.id} runs on the server only and reads ${hostPath}, which the server does not have, so it never runs: ${node.id} behaves as if it had no ${name}.`,
          { componentId: node.id }
        );
      } else if (serverOnly && clock) {
        report(
          "warning",
          "rule.server-cannot-run",
          `The ${name} of ${node.id} runs on the server only and reads today(): it runs only when the host gives the server the day, and is skipped otherwise, as if ${node.id} had no ${name}.`,
          { componentId: node.id }
        );
      } else if (clock) {
        clockRules.push(name);
      }
      if (key === "requiredWhen" && run === "browser") {
        report(
          "warning",
          "rule.browser-only-required",
          `The required rule of ${node.id} runs in the browser only, so the server does not enforce it: a submission that skips the answer passes there.`,
          { componentId: node.id }
        );
      }
      if (run === "server-secret") {
        for (const path of paths) {
          const read = isScopedPath(path) ? undefined : componentOfPath(path);
          if (read === undefined || saidHidden.has(read)) {
            continue;
          }
          const chain = [index.nodeById.get(read), ...ancestorsOf(index, read)];
          const hider = chain.find((candidate) => candidate !== undefined && candidate.rules !== undefined && ruleOf(candidate.rules.visibleWhen) !== undefined && kernelRuleRun(candidate.rules.visibleWhen) === "browser");
          if (hider === undefined) {
            continue;
          }
          saidHidden.add(read);
          const through = hider.id === read ? "" : ` (through ${hider.id})`;
          report(
            "warning",
            "rule.secret-reads-browser-hidden",
            `The secret ${name} of ${node.id} reads ${read}, which a browser-only rule may hide${through}: the server, which never runs that rule, reads the answer the browser kept or dropped by ${read}'s hidden-value behaviour.`,
            { componentId: node.id }
          );
        }
      }
    }
    if (clockRules.length > 0) {
      const names = clockRules.length === 1 ? (clockRules[0] as string) : `${clockRules.slice(0, -1).join(", ")} and ${clockRules[clockRules.length - 1] as string}`;
      report(
        "warning",
        "rule.reads-clock",
        `The ${names} of ${node.id} ${clockRules.length === 1 ? "reads" : "read"} today(): the server judges it by its own clock, so a submission checked on another day may be judged differently.`,
        { componentId: node.id }
      );
    }
  }

  browserOnlyVisibility(index, (code, message, componentId) => report("warning", code, message, { componentId }));

  // Rules of the form reading a field the journey's pages own: the form's rules and
  // calculations see the form's answers only — an own answer is kept out of them in the
  // browser and never reaches the server — so such a read is always unanswered. Read by the
  // own node's id, or by its key under this journey's `@` prefix.
  const RULE_NAMES: Record<string, string> = {
    visibleWhen: "visibility rule",
    enabledWhen: "enabled rule",
    readonlyWhen: "read-only rule",
    requiredWhen: "required rule",
    value: "calculation",
    defaultValue: "default value",
    filter: "filter"
  };
  for (const node of index.order) {
    if (!isRecord(node.rules)) {
      continue;
    }
    for (const [key, source] of Object.entries(node.rules as Record<string, unknown>)) {
      const rule = ruleOf(source);
      if (rule === undefined) {
        continue;
      }
      const said = new Set<string>();
      for (const path of extractDependencies(rule)) {
        const own = isScopedPath(path) || said.has(path) ? undefined : presentationRead(path, false);
        if (own === undefined) {
          continue;
        }
        said.add(path);
        report(
          "error",
          "rule.reads-presentation-field",
          `The ${journeyOwn(RULE_NAMES, key) ?? `${key} rule`} of ${node.id} reads ${own.what}: the form's rules read the form's answers only, so it always reads as unanswered${
            own.instead !== undefined ? ` — read ${own.instead} instead` : ""
          }.`,
          { componentId: node.id }
        );
      }
    }
  }

  // `@` starts the keys a presentation keeps its own fields' answers under in the browser
  //: a form key spelled so is a form value all the same — the browser keeps it and
  // sends it, the kernel judges it — so it is a warning, never an error; but an own field whose
  // key it would be is dropped (rule I, an error where it happens). Only a repeating section's
  // collection path (a data grid's among them) can be spelled so: a data key under `@` is no
  // data key (the engine keys the field by its id) and an id under `@` no id, and the builder
  // refuses both. Said once per component in a definition (`diagnoseJourneys`).
  for (const node of index.order) {
    if (node.id === root.id) {
      continue;
    }
    const collection: unknown = node.collection;
    const keys: Array<[string, unknown]> = [["collection path", isRecord(collection) ? collection.collectionPath : undefined]];
    for (const [what, value] of keys) {
      if (typeof value === "string" && value.startsWith("@")) {
        report(
          "warning",
          "data-key.reserved-prefix",
          `${node.id}: its ${what} "${value}" starts with @, as the keys a journey keeps its own fields' answers under in the browser do (@ and its id). The form's values there are kept and sent as any others; but a page's own field whose answer would land on one of them is left off its page. Start it with a letter to keep the two apart.`,
          { componentId: node.id }
        );
        break;
      }
    }
  }

  return out;
}


/**
 * A required field whose own or inherited `visibleWhen` runs in the browser only: the server
 * skips that rule, so it still demands the answer the browser hid. One finding per field.
 */
function browserOnlyVisibility(index: TreeIndex, say: (code: JourneyDiagnosticCode, message: string, componentId: string) => void): void {
  for (const node of index.order) {
    const required = kernelReadFlag(node.configuration, "required") || node.rules?.requiredWhen !== undefined;
    if (!required) {
      continue;
    }
    const hider = [node, ...ancestorsOf(index, node.id)].find((candidate) => candidate.rules !== undefined && ruleOf(candidate.rules.visibleWhen) !== undefined && kernelRuleRun(candidate.rules.visibleWhen) === "browser");
    if (hider === undefined) {
      continue;
    }
    const through = hider.id === node.id ? "" : ` (through ${hider.id})`;
    say(
      "rule.browser-only-visibility",
      `The visibility rule of ${node.id}${through} runs in the browser only, so the server does not hide ${node.id} and still requires its answer where the browser hid it.`,
      node.id
    );
  }
}

/**
 * Findings about the form alone, for a definition with no journey: the browser-only rules the
 * server does not enforce (a required rule, a visibility rule over a required field).
 */
function diagnoseFormRules(root: ComponentNode): JourneyDiagnostic[] {
  const out: JourneyDiagnostic[] = [];
  const index = indexTree(root);
  const say = (code: JourneyDiagnosticCode, message: string, componentId: string): void => {
    out.push({ severity: "warning", code, journeyId: "", message, componentId });
  };
  for (const node of index.order) {
    if (node.rules?.requiredWhen !== undefined && ruleOf(node.rules.requiredWhen) !== undefined && kernelRuleRun(node.rules.requiredWhen) === "browser") {
      say("rule.browser-only-required", `The required rule of ${node.id} runs in the browser only, so the server does not enforce it: a submission that skips the answer passes there.`, node.id);
    }
  }
  browserOnlyVisibility(index, say);
  return out;
}

/**
 * Everything wrong with a definition's journeys: each one's {@link diagnoseJourney}, plus
 * journeys sharing an id. Journeys that fail the shape check (`validateJourneyShape`) are not
 * read at all, as the runtime does not read them. A finding about the form alone that every
 * journey would repeat (`data-key.reserved-prefix`) is said once, with the first journey's.
 */
export function diagnoseJourneys(definition: { root: ComponentNode; journey?: unknown }, options: JourneyDiagnosticOptions = {}): JourneyDiagnostic[] {
  const out: JourneyDiagnostic[] = [];
  const seen = new Set<string>();
  const formSaid = new Set<string>();
  const journeys = readJourneys(definition);
  if (journeys.length === 0) {
    return diagnoseFormRules(definition.root);
  }
  for (const journey of journeys) {
    if (seen.has(journey.id)) {
      out.push({
        severity: "error",
        code: "journey.duplicate-id",
        journeyId: journey.id,
        message: `Two journeys have the id "${journey.id}"; only the first can be opened.`
      });
    }
    seen.add(journey.id);
    for (const diagnostic of diagnoseJourney(definition.root, journey, options)) {
      if (diagnostic.code === "data-key.reserved-prefix") {
        if (formSaid.has(diagnostic.componentId as string)) {
          continue;
        }
        formSaid.add(diagnostic.componentId as string);
      }
      out.push(diagnostic);
    }
  }
  return out;
}

/** Where every path through a journey goes, read from the definition alone ({@link journeyCertainWalk}). */
export interface JourneyCertainWalk {
  /**
   * Whether any path can be submitted at all. When none can (every path ends at an exit page,
   * `journey.no-end`), nothing is certain, and `pages` and `slots` are empty.
   */
  submittable: boolean;
  /**
   * The indexes of the pages every path that can be submitted takes, in order — a Check answers
   * page left out: every path through the journey takes it, but it places no form field.
   */
  pages: number[];
  /**
   * The positions (0 to the page count) where a page with no routes, put in there, would be on
   * every path that can be submitted: never after a route that can pass it, or an exit page that
   * ends the paths reaching it.
   */
  slots: number[];
}

/** The pages every submittable walk of `pages` takes, by index; `undefined` when no walk can be submitted. */
function certainPagesOf(pages: readonly JourneyPage[]): Set<number> | undefined {
  const indexOf = new Map<string, number>();
  pages.forEach((page, at) => {
    if (!indexOf.has(page.id)) {
      indexOf.set(page.id, at);
    }
  });
  // Arriving at position `at` (the page count: the end), the pages every walk from there that
  // ends in a submission takes; `null` when none does. Routes only go forward, so the positions
  // after `at` are known when it is worked out.
  const must: Array<Set<number> | null> = new Array(pages.length + 1);
  must[pages.length] = new Set();
  const meet = (options: Array<Set<number> | null>): Set<number> | null => {
    const open = options.filter((option): option is Set<number> => option !== null);
    if (open.length === 0) {
      return null;
    }
    const [first, ...rest] = open;
    return new Set([...(first as Set<number>)].filter((at) => rest.every((option) => option.has(at))));
  };
  for (let at = pages.length - 1; at >= 0; at -= 1) {
    const page = pages[at] as JourneyPage;
    const fallsTo = must[at + 1] as Set<number> | null;
    if (page.kind === "review") {
      // Check answers: the walk submits from it whatever follows. It is
      // no page a field may be put on (it places no form field), so it is not counted certain.
      must[at] = new Set();
      continue;
    }
    const options: Array<Set<number> | null> = [];
    if (page.kind !== "exit") {
      // Taken: its routes in order, a conditional one either way, the first unconditional one
      // always; with none of those, on to the next page.
      const onwards: Array<Set<number> | null> = [];
      let always = false;
      for (const route of page.routes ?? []) {
        const target = route.to === "$end" ? pages.length : indexOf.get(route.to);
        if (target === undefined || target <= at) {
          continue;
        }
        onwards.push(must[target] as Set<number> | null);
        if (route.when === undefined) {
          always = true;
          break;
        }
      }
      if (!always) {
        onwards.push(fallsTo);
      }
      const taken = meet(onwards);
      options.push(taken === null ? null : new Set([at, ...taken]));
    }
    // An exit page taken ends a walk that is never submitted: no option.
    must[at] = meet(options);
  }
  return must[0] ?? undefined;
}

/**
 * The pages every path through `journey` that can be submitted takes, whatever the answers, as
 * the path engine walks it (`journeyPath`), with every route's condition read as possibly
 * holding and possibly not: every page reached is taken, a Check answers page ends the walk
 * with a submit; leaving a page,
 * a route that can be taken (forward, to a known page or the end) may decide, an unconditional
 * one always does; an exit page ends a path nothing is submitted through, which is no concern.
 * Off the path a field is not required: what "Add unassigned" and "Ask it
 * here" may put a field on without relaxing its Required. Deliberately no diagnostic reads it:
 * a field required only on a branch the author chose is the ordinary branching pattern.
 */
export function journeyCertainWalk(journey: Journey): JourneyCertainWalk {
  const pages = journey.pages;
  const certain = certainPagesOf(pages);
  if (certain === undefined) {
    return { submittable: false, pages: [], slots: [] };
  }
  const slots: number[] = [];
  // A page put in at each position, with an id no page has and something listed.
  let probeId = "$probe";
  while (pages.some((page) => page.id === probeId)) {
    probeId = `${probeId}_`;
  }
  for (let at = 0; at <= pages.length; at += 1) {
    const probed = [...pages.slice(0, at), { id: probeId, components: [probeId] } as JourneyPage, ...pages.slice(at)];
    if (certainPagesOf(probed)?.has(at)) {
      slots.push(at);
    }
  }
  return { submittable: true, pages: [...certain].sort((a, b) => a - b), slots };
}

/**
 * The walk graph {@link diagnoseJourney} explores, for the flow map's graph facts
 * (`journeyFlow`): the same pages, exits and ways out, built the same way, so
 * the map cannot disagree with `page.unreachable` or `journey.no-end`.
 */
export type JourneyWalkGraph = WalkGraph;
export type JourneyWalkOptions = WalkOptions;
export type JourneyWalkResult = WalkResult;

export function journeyWalkGraph(journey: Journey): JourneyWalkGraph {
  return buildWalkGraph(journey);
}

/** Every walk through `graph` from its first page: {@link diagnoseJourney}'s own search. */
export function exploreJourneyWalks(graph: JourneyWalkGraph, options: JourneyWalkOptions = {}): JourneyWalkResult {
  return exploreWalks(graph, options);
}
