import type { RuleSource } from "../expressions/expression.js";
import type { HiddenValueBehavior } from "../state/effective-state.js";

/**
 * Journeys: multi-page flows over one form. The form's tree is the data model and
 * the questions, authored once; a journey arranges some of its components into pages and
 * branches between them by routes; a page has no condition of its own. Journeys sit on the definition as a list,
 * the way PDF layouts do (`pdf.layouts[]`), and reference components by id — a page is not a
 * node of the tree.
 */

/** A route target meaning "the journey ends here": the page is the last on the path. */
export const JOURNEY_END = "$end";

/** What Continue does with the page's answers before it moves on. */
export type JourneyContinueValidation =
  /** Validate the page's components and stay while any error blocks (asked for explicitly). */
  | "page"
  /**
   * Move on unvalidated, the default; the page's errors surface when the journey ends. A deferred page that
   * already holds an error that blocks (the end check sent the person back to it) is validated
   * on Continue, so a fix can be confirmed. Resuming a draft never validates a deferred page.
   */
  | "defer";

/**
 * What a check against the host's server does when there is no verdict — a timeout, a network
 * failure, any status that is no verdict (a 4xx as much as a 5xx), a malformed reply, or no
 * validator at all.
 */
export type JourneyServerUnavailable = "block" | "continue";

/**
 * How a page's answers are checked on Continue. Set on the journey as the default for every
 * page and on a page to override it, key by key.
 */
export interface JourneyValidation {
  /** Absent: `"defer"`, move on and check at the end. */
  continue?: JourneyContinueValidation;
  /**
   * Continue also asks the host's server to check the page (a registration number, an
   * address), after the page's own validation passes, sending every submittable answer. The
   * host supplies the way to its server (`<datum-form>`'s `serverValidator` or `validate-url`);
   * without one the check counts as unavailable. Ignored on a deferred page (the diagnostic
   * `page.validation-server-deferred`). On the last page, which submits rather than
   * continues, the check runs as the submit's last validation stage instead, unless the
   * journey's `end` is `"server"`. A builder's preview is never checked. Absent: `false`.
   */
  server?: boolean;
  /**
   * What an unreachable server means. Absent: `"block"` — the person stays with a message to
   * try again. The journey's own setting governs its `end` check.
   */
  onUnavailable?: JourneyServerUnavailable;
}

/** The journey-wide validation settings: the page defaults, plus the check at the end. */
export interface JourneyValidationSettings extends JourneyValidation {
  /**
   * The check run when the person submits from the last page. `"client"` validates every page
   * on the path in the browser, then the sandbox checks the answers. `"server"` then also asks
   * the host's server to check the whole journey — the last validation stage (after the
   * client and sandbox checks), over the exact values the submission will carry, before the envelope is completed,
   * signed or delivered — under the journey's `onUnavailable`. A download skips it, and so
   * does a builder's preview. Absent: `"client"`.
   */
  end?: "client" | "server";
}

export interface JourneyRoute {
  /** Absent: the route always matches. A formula or the object form (`RuleSource`); compiled to a tree before it is read. */
  when?: RuleSource;
  /** A later page's id, or {@link JOURNEY_END}. */
  to: string;
}

export type JourneyPageKind =
  /** Questions: the referenced components, with Continue (or Submit on the last page). */
  | "questions"
  /** A terminal page ("You are not eligible"): content only, no Continue and no Submit. */
  | "exit"
  /**
   * Check answers (the GOV.UK pattern): lists the answers given on the path, step by step, with
   * a Change link back to each, and submits. One per journey, the last page before the end: the
   * walk ends at it (its routes are never followed), and it counts in "Step n of N". It places no form component — what it lists is the path's — but
   * may hold content of the journey's own, a declaration say.
   */
  | "review";

/** What an optional question left blank shows on a review page. */
export type JourneyReviewEmptyOptional =
  /** A row reading "Not provided" (the renderer's `notProvided` text), the default. */
  | "notProvided"
  /** No row at all. */
  | "omit";

/** How a review page (`kind: "review"`) lists the answers. Every key is optional. */
export interface JourneyReviewSettings {
  /**
   * The wording of a row, by the form component's id, in place of the component's label ("Own
   * or rent" for "Do you own or rent?"). Strings in the form's default language, as every text a
   * form holds; translated at
   * `journeys › <journey id> › pages › <page id> › review › labels › <component id>`.
   */
  labels?: Record<string, string>;
  /** Absent: `"notProvided"`. */
  emptyOptional?: JourneyReviewEmptyOptional;
  /** Whether each row has a Change link back to its page. Absent: `true`. */
  change?: boolean;
}

/** The `type` of a reference to a form component inside a node a presentation owns. */
export const PRESENTATION_REFERENCE_TYPE = "journey-field";

/** The `type` of a worked-out value: a form field computed from the page's own fields. */
export const PRESENTATION_VALUE_TYPE = "journey-value";

/**
 * A component a presentation — a journey, one page or many — **owns**: a field,
 * a text or a layout that exists on its page only, never in the form's tree. Shaped like a
 * component, and written on the page where it is drawn.
 *
 * - A field with `configuration.fills: "<form component id>"` is an **alias**: its answer *is*
 *   that form field's answer, stored at the form field's value path. It may have its own label,
 *   help and Required; it shows the form field's visibility, disabled and read-only state.
 * - `type: "journey-value"` with `configuration: { to, value, label? }` is a **worked-out
 *   value**: the form field `to`, computed in the browser by the expression `value` from the
 *   own fields on the same page, drawn read-only. The server keeps the value, holds it to the
 *   form field's own rules and lists it as client-derived.
 * - Any other own field keeps its answer in the browser (`@<presentation id>.<id>`): checked
 *   there by its own rules, kept in drafts, never sent, printed or exported.
 *
 * `rules` are evaluated in the browser only; the validation kernel never reads them, nor a
 * worked-out value's expression.
 */
export interface PresentationNode {
  /** Component-id grammar; never a form component's id, unique among the presentation's own nodes. */
  id: string;
  /** A form component type, or `"journey-value"`. */
  type: string;
  configuration?: Record<string, unknown>;
  rules?: Record<string, unknown>;
  children?: Record<string, Array<PresentationNode | PresentationReference>>;
}

/**
 * A form component placed inside a layout a presentation owns: drawn there exactly
 * as on the form, and counted as placed on that page. At the top of a page it reads as the
 * component's id written as a string does.
 */
export interface PresentationReference {
  /** Ignored: a designer numbers its references for itself. */
  id?: string;
  type: typeof PRESENTATION_REFERENCE_TYPE;
  configuration: { componentId: string };
}

/**
 * What a page lists: a string is a **reused** form component, drawn exactly as on
 * the form; an object is a node the presentation owns, or a reference to a form component.
 * A reader from before own nodes refuses a journey holding an object entry, by construction:
 * its shape check asked for strings.
 */
export type JourneyPageEntry = string | PresentationNode | PresentationReference;

export interface JourneyPage {
  /** Unique within the journey; never the id of a component of the form. */
  id: string;
  /** Absent: `"questions"`. */
  kind?: JourneyPageKind;
  /**
   * The page's heading, in the form's default language; translated in the definition's map at
   * `journeys › <journey id> › pages › <page id> › title`. Absent: the first
   * referenced component's label.
   */
  title?: string;
  /** Translated at `journeys › <journey id> › pages › <page id> › description`. */
  description?: string;
  /**
   * What the page draws, in order: form component ids (each brings its subtree), and the nodes
   * the presentation owns. {@link journeyPageFormIds} reads the ids alone.
   */
  components?: JourneyPageEntry[];
  /** Tried in order when the person leaves the page; the first that matches wins. */
  routes?: JourneyRoute[];
  /**
   * Overrides of the journey's texts for this page ("Continue" → "Accept and send"), by text key.
   * Strings in the form's default language; translated at
   * `journeys › <journey id> › pages › <page id> › texts › <key>`.
   */
  texts?: Record<string, string>;
  /** Overrides of the journey's validation defaults, key by key. */
  validation?: JourneyValidation;
  /** How a review page lists the answers; read only when `kind` is `"review"`. */
  review?: JourneyReviewSettings;
}

export interface Journey {
  /** Component-id grammar; unique among the form's journeys. */
  id: string;
  /** In the form's default language; translated at `journeys › <journey id> › name`. */
  name?: string;
  pages: JourneyPage[];
  /**
   * What happens to the answers on pages the path does not take. A component's own
   * `hiddenValueBehavior` wins. Absent: `"exclude-from-submission"` — kept for the person
   * (switching back to a branch restores them) but never submitted.
   */
  offPathValues?: HiddenValueBehavior;
  /**
   * Absent: `"count"`, which captions each questions and Check answers page's heading "Step 2 of
   * 5" (the `pageOf` text). `"none"` draws no count.
   */
  progress?: "none" | "count";
  /**
   * Absent: `"shown"`. `"hidden"` draws no page heading: the form's title heads
   * each page as it heads the whole form, the page's description opens its fields, and the
   * count is not drawn. A one-page journey with its heading hidden looks like the form.
   * Presentation only: neither the browser nor the kernel checks it, and any other value
   * reads as `"shown"`.
   */
  heading?: "shown" | "hidden";
  /**
   * Wording for the journey's chrome (`back`, `continue`, `submit`, `pageOf`, ...), by text key.
   * Strings in the form's default language; translated at `journeys › <journey id> › texts › <key>`.
   */
  texts?: Record<string, string>;
  validation?: JourneyValidationSettings;
}

export interface JourneyConfiguration {
  journeys?: Journey[];
  /** The journey the form opens as. Absent: the first. */
  defaultJourneyId?: string;
  /**
   * Whether the form opens as its default journey or as the whole form on one page, when the
   * host does not say. Absent: `"journey"` whenever the form has a journey.
   */
  opensAs?: "journey" | "form";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` reads as a rule source: a formula string or the object form (a record with a
 * string `formula`), or what a compiled journey holds in its place (a tree, or the object form's
 * tree `expression`). The shape only: whether a formula parses, and that an authored rule is no
 * tree, is the compile step's to report.
 */
function isExpressionLike(value: unknown): boolean {
  if (typeof value === "string") {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.kind === "string") {
    return true;
  }
  return typeof value.formula === "string" || (isRecord(value.expression) && typeof value.expression.kind === "string");
}

const PAGE_KINDS: readonly JourneyPageKind[] = ["questions", "exit", "review"];
const HIDDEN_VALUE_BEHAVIORS: readonly HiddenValueBehavior[] = ["retain", "clear", "exclude-from-submission"];

function validationProblems(value: unknown, where: string, allowEnd: boolean): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return [`${where}.validation must be an object`];
  }
  const problems: string[] = [];
  if (value.continue !== undefined && value.continue !== "page" && value.continue !== "defer") {
    problems.push(`${where}.validation.continue must be "page" or "defer"`);
  }
  if (value.server !== undefined && typeof value.server !== "boolean") {
    problems.push(`${where}.validation.server must be a boolean`);
  }
  if (value.onUnavailable !== undefined && value.onUnavailable !== "block" && value.onUnavailable !== "continue") {
    problems.push(`${where}.validation.onUnavailable must be "block" or "continue"`);
  }
  if (value.end !== undefined) {
    if (!allowEnd) {
      problems.push(`${where}.validation.end is set on the journey, not on a page`);
    } else if (value.end !== "client" && value.end !== "server") {
      problems.push(`${where}.validation.end must be "client" or "server"`);
    }
  }
  return problems;
}

/**
 * Why a page's `review` settings are not usable; empty when they are. Read on any page, so a
 * page whose kind is changed keeps a usable block; the kernel's `kernelIsJourney` refuses
 * exactly these.
 */
function reviewProblems(value: unknown, where: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return [`${where}.review must be an object`];
  }
  const problems: string[] = [];
  const labels = value.labels;
  if (labels !== undefined && (!isRecord(labels) || Object.keys(labels).some((key) => typeof labels[key] !== "string"))) {
    problems.push(`${where}.review.labels must map component ids to text`);
  }
  if (value.emptyOptional !== undefined && value.emptyOptional !== "notProvided" && value.emptyOptional !== "omit") {
    problems.push(`${where}.review.emptyOptional must be "notProvided" or "omit"`);
  }
  if (value.change !== undefined && typeof value.change !== "boolean") {
    problems.push(`${where}.review.change must be a boolean`);
  }
  return problems;
}

/**
 * Why an object entry of a page — a node the presentation owns, with everything under it — is
 * not usable; empty when it is. The shape only: whether its ids clash, its types
 * are allowed and its targets exist is for the usability rules both sides run
 * (`core/journey/journey-path.ts`), which ignore a node rather than drop the journey. Walked
 * with a stack of its own, so a deeply nested hand-written page cannot exhaust the call stack.
 * The validation kernel's `kernelIsPresentationNode` accepts exactly what this finds nothing
 * wrong with.
 */
function presentationNodeProblems(entry: Record<string, unknown>, at: string): string[] {
  const problems: string[] = [];
  const stack: Array<{ node: unknown; where: string }> = [{ node: entry, where: at }];
  while (stack.length > 0) {
    const { node, where } = stack.pop() as { node: unknown; where: string };
    if (!isRecord(node)) {
      problems.push(`${where} must be an object`);
      continue;
    }
    if (typeof node.type !== "string" || node.type === "") {
      problems.push(`${where} needs a type`);
      continue;
    }
    const configuration = node.configuration;
    if (node.type === PRESENTATION_REFERENCE_TYPE) {
      if (!isRecord(configuration) || typeof configuration.componentId !== "string" || configuration.componentId === "") {
        problems.push(`${where} needs the id of the form component it shows (configuration.componentId)`);
      }
      if (node.children !== undefined) {
        problems.push(`${where} is a reference to a form component and cannot hold children`);
      }
      continue;
    }
    if (typeof node.id !== "string" || node.id === "") {
      problems.push(`${where} needs an id`);
    }
    if (configuration !== undefined && !isRecord(configuration)) {
      problems.push(`${where} configuration must be an object`);
    }
    if (node.rules !== undefined && !isRecord(node.rules)) {
      problems.push(`${where} rules must be an object`);
    }
    if (isRecord(configuration) && configuration.fills !== undefined && (typeof configuration.fills !== "string" || configuration.fills === "")) {
      problems.push(`${where} fills must be the id of a form field`);
    }
    if (node.type === PRESENTATION_VALUE_TYPE) {
      if (!isRecord(configuration) || typeof configuration.to !== "string" || configuration.to === "") {
        problems.push(`${where} needs the form field it works out (configuration.to)`);
      }
      if (!isRecord(configuration) || !isExpressionLike(configuration.value)) {
        problems.push(`${where} needs an expression to work its value out with (configuration.value)`);
      }
      if (node.children !== undefined) {
        problems.push(`${where} is a worked-out value and cannot hold children`);
      }
      continue;
    }
    const children = node.children;
    if (children === undefined) {
      continue;
    }
    if (!isRecord(children)) {
      problems.push(`${where} children must be lists of nodes, by slot`);
      continue;
    }
    const slots = Object.keys(children);
    if (slots.some((slot) => !Array.isArray(children[slot]))) {
      problems.push(`${where} children must be lists of nodes, by slot`);
    }
    // Pushed last first, so the nodes are read, and their problems listed, in document order.
    for (let slotIndex = slots.length - 1; slotIndex >= 0; slotIndex -= 1) {
      const slot = slots[slotIndex] as string;
      const nodes = children[slot];
      if (!Array.isArray(nodes)) {
        continue;
      }
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        stack.push({ node: nodes[index], where: `${where} ${slot} ${index + 1}` });
      }
    }
  }
  return problems;
}

/**
 * Why a value is not a usable journey — the shape only; references to components and pages
 * are {@link diagnoseJourney}'s business. Empty when it is usable.
 *
 * A page's `components` holds form component ids and nodes the presentation
 * owns. The validation kernel's `kernelIsJourney` accepts exactly the same shapes, so a journey
 * the browser drops here is one a server refuses (`journey.invalid`). Both sides read a
 * compiled copy of the journey (the runtime's `readJourneys` and the kernel's
 * `runKernel` compile first), in which a route `when` is a tree or gone: one of a
 * shape no reader accepts, or a formula that does not parse, is the compile's problem under
 * the formula policy, reported alike on both sides, never a shape problem here. Over the
 * author's own journey, as the builder checks it, such a `when` is still named below. A page
 * that carries a `when` of its own is refused: pages have no condition, and a stale definition
 * fails loudly rather than walking a different path.
 *
 * Page ids must be unique in a stored journey. The builder, which holds a page under edit (one
 * renamed to an id another page has, a clone before its id is set), passes
 * `allowRepeatedPageIds` and reports the repeat through `diagnoseJourney`'s
 * `page.duplicate-id` instead of dropping the journey.
 */
export function validateJourneyShape(value: unknown, options: { allowRepeatedPageIds?: boolean } = {}): string[] {
  if (!isRecord(value)) {
    return ["a journey must be an object"];
  }
  const problems: string[] = [];
  if (typeof value.id !== "string" || value.id === "") {
    problems.push("a journey needs an id");
  }
  const where = typeof value.id === "string" && value.id !== "" ? `journey "${value.id}"` : "journey";
  if (!Array.isArray(value.pages)) {
    problems.push(`${where} needs a pages list`);
  } else {
    const seenPageIds = new Set<string>();
    value.pages.forEach((page, index) => {
      const at = `${where} page ${index + 1}`;
      if (!isRecord(page)) {
        problems.push(`${at} must be an object`);
        return;
      }
      if (typeof page.id !== "string" || page.id === "") {
        problems.push(`${at} needs an id`);
      } else if (seenPageIds.has(page.id)) {
        // Two pages sharing an id make page scoping ambiguous; the kernel refuses it too.
        if (options.allowRepeatedPageIds !== true) {
          problems.push(`${at} repeats the page id "${page.id}"; page ids must be unique`);
        }
      } else {
        seenPageIds.add(page.id);
      }
      if (page.kind !== undefined && !PAGE_KINDS.includes(page.kind as JourneyPageKind)) {
        problems.push(`${at} has an unknown kind`);
      }
      if (page.components !== undefined) {
        const entries: unknown = page.components;
        if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" && !isRecord(entry))) {
          problems.push(`${at} components must be a list of component ids and nodes`);
        }
        if (Array.isArray(entries)) {
          entries.forEach((entry, entryIndex) => {
            if (isRecord(entry)) {
              problems.push(...presentationNodeProblems(entry, `${at} component ${entryIndex + 1}`));
            }
          });
        }
      }
      if (page.when !== undefined) {
        // A page has no condition of its own; branching is a route on the page before it.
        problems.push(`${at} has a when, but a page has no condition of its own; branch with a route on the page before it`);
      }
      if (page.routes !== undefined) {
        if (!Array.isArray(page.routes)) {
          problems.push(`${at} routes must be a list`);
        } else {
          page.routes.forEach((route, routeIndex) => {
            if (!isRecord(route) || typeof route.to !== "string" || route.to === "") {
              problems.push(`${at} route ${routeIndex + 1} needs a target`);
            } else if (route.when !== undefined && !isExpressionLike(route.when)) {
              problems.push(`${at} route ${routeIndex + 1} when must be an expression`);
            }
          });
        }
      }
      problems.push(...validationProblems(page.validation, at, false));
      problems.push(...reviewProblems(page.review, at));
    });
  }
  if (value.offPathValues !== undefined && !HIDDEN_VALUE_BEHAVIORS.includes(value.offPathValues as HiddenValueBehavior)) {
    problems.push(`${where} offPathValues must be "retain", "clear" or "exclude-from-submission"`);
  }
  if (value.progress !== undefined && value.progress !== "none" && value.progress !== "count") {
    problems.push(`${where} progress must be "none" or "count"`);
  }
  problems.push(...validationProblems(value.validation, where, true));
  return problems;
}

/**
 * The journeys a definition declares, in order, skipping any that fail
 * {@link validateJourneyShape}. Never throws: a definition with no `journey` key, or a
 * hand-edited one, yields what is usable.
 */
export function readJourneys(definition: { journey?: unknown } | undefined): Journey[] {
  const configuration = definition?.journey;
  if (!isRecord(configuration) || !Array.isArray(configuration.journeys)) {
    return [];
  }
  return configuration.journeys.filter(
    (journey): journey is Journey => validateJourneyShape(journey).length === 0
  );
}

/** The definition's journey block, read tolerantly: unusable journeys dropped, bad keys ignored. */
export function readJourneyConfiguration(definition: { journey?: unknown } | undefined): JourneyConfiguration {
  const journeys = readJourneys(definition);
  const out: JourneyConfiguration = { journeys };
  const defaultId = readDefaultJourneyId(definition);
  if (defaultId !== undefined) {
    out.defaultJourneyId = defaultId;
  }
  const configuration = definition?.journey;
  if (isRecord(configuration) && (configuration.opensAs === "journey" || configuration.opensAs === "form")) {
    out.opensAs = configuration.opensAs;
  }
  return out;
}

/** The `defaultJourneyId` a definition names, when it is a string. */
export function readDefaultJourneyId(definition: { journey?: unknown } | undefined): string | undefined {
  const configuration = definition?.journey;
  if (!isRecord(configuration) || typeof configuration.defaultJourneyId !== "string" || configuration.defaultJourneyId === "") {
    return undefined;
  }
  return configuration.defaultJourneyId;
}

/**
 * The journey asked for by id, else the definition's default, else the first declared.
 * `undefined` when the definition declares none, or names one it does not have.
 */
export function findJourney(
  definition: { journey?: unknown } | undefined,
  journeyId?: string
): Journey | undefined {
  const journeys = readJourneys(definition);
  if (journeyId !== undefined) {
    return journeys.find((journey) => journey.id === journeyId);
  }
  const defaultId = readDefaultJourneyId(definition);
  if (defaultId !== undefined) {
    const preferred = journeys.find((journey) => journey.id === defaultId);
    if (preferred) {
      return preferred;
    }
  }
  return journeys[0];
}

/**
 * What a host may ask for: a journey by id, `"form"` for the whole form on one page, or
 * `"journey"` for the definition's default journey even when the definition opens as a form.
 * Absent: the definition decides.
 */
export type JourneyHostChoice = string | undefined;

export type JourneySelection =
  | { kind: "journey"; journeyId: string }
  | { kind: "form" };

export interface JourneySelectionResult {
  selection: JourneySelection;
  /** The host named a journey the definition does not have; the definition decided instead. */
  unknownJourneyId?: string;
}

/**
 * Which journey a form opens as. The definition holds the defaults — `opensAs`
 * (absent: a journey whenever there is one), then `defaultJourneyId`, then the first journey —
 * and the host overrides them, the way a host's `locale` overrides `defaultLocale` and a
 * `renderPdf({ layoutId })` overrides `pdf.defaultLayoutId`.
 */
export function resolveJourneySelection(
  definition: { journey?: unknown } | undefined,
  hostChoice?: JourneyHostChoice
): JourneySelectionResult {
  const configuration = readJourneyConfiguration(definition);
  const journeys = configuration.journeys ?? [];
  const defaultJourney = findJourney(definition);
  const byDefinition = (): JourneySelection => {
    if (!defaultJourney || configuration.opensAs === "form") {
      return { kind: "form" };
    }
    return { kind: "journey", journeyId: defaultJourney.id };
  };

  if (hostChoice === undefined || hostChoice === "") {
    return { selection: byDefinition() };
  }
  if (hostChoice === "form") {
    return { selection: { kind: "form" } };
  }
  const named = journeys.find((journey) => journey.id === hostChoice);
  if (named) {
    return { selection: { kind: "journey", journeyId: named.id } };
  }
  if (hostChoice === "journey") {
    return { selection: defaultJourney ? { kind: "journey", journeyId: defaultJourney.id } : { kind: "form" } };
  }
  return { selection: byDefinition(), unknownJourneyId: hostChoice };
}

/** A page's validation settings with the journey's defaults filled in. */
export interface ResolvedJourneyValidation {
  continue: JourneyContinueValidation;
  server: boolean;
  onUnavailable: JourneyServerUnavailable;
}

/** How Continue checks `page`: the page's own settings over the journey's, over the defaults. */
export function journeyPageValidation(journey: Journey, page: JourneyPage | undefined): ResolvedJourneyValidation {
  const base = journey.validation ?? {};
  const own = page?.validation ?? {};
  return {
    continue: own.continue ?? base.continue ?? "defer",
    server: own.server ?? base.server ?? false,
    onUnavailable: own.onUnavailable ?? base.onUnavailable ?? "block"
  };
}

/** The check run when the journey ends: `"client"` unless the journey asks for the server too. */
export function journeyEndValidation(journey: Journey): "client" | "server" {
  return journey.validation?.end ?? "client";
}

/** The page's kind, `"questions"` unless it says `"exit"` or `"review"`. */
export function journeyPageKind(page: JourneyPage): JourneyPageKind {
  return page.kind === "exit" || page.kind === "review" ? page.kind : "questions";
}

/** A review page's settings with the defaults filled in. */
export interface ResolvedJourneyReview {
  labels: Record<string, string>;
  emptyOptional: JourneyReviewEmptyOptional;
  change: boolean;
}

/**
 * How a review page lists the answers: its `review` block over the defaults (`"notProvided"`,
 * Change links shown). `labels` has no prototype, so a component called `constructor` reads its
 * own wording or none.
 */
export function journeyReviewSettings(page: JourneyPage | undefined): ResolvedJourneyReview {
  const own = page?.review ?? {};
  const labels = Object.create(null) as Record<string, string>;
  const written = own.labels;
  if (written !== undefined && written !== null && typeof written === "object") {
    for (const key of Object.keys(written)) {
      const text = written[key];
      if (typeof text === "string") {
        labels[key] = text;
      }
    }
  }
  return {
    labels,
    emptyOptional: own.emptyOptional === "omit" ? "omit" : "notProvided",
    change: own.change !== false
  };
}

/** Whether a page entry is an object — a node the presentation owns, or a reference — rather than a form component's id. */
export function isPresentationEntry(entry: JourneyPageEntry): entry is PresentationNode | PresentationReference {
  return typeof entry !== "string";
}

/** Whether a node of a presentation is a reference to a form component, not a node the presentation owns. */
export function isPresentationReference(node: PresentationNode | PresentationReference): node is PresentationReference {
  return node.type === PRESENTATION_REFERENCE_TYPE;
}

/**
 * The form component ids a page lists by name, in its order: its string entries alone. The
 * nodes a presentation owns are left out, and so are the form components they
 * reference or fill — for where those stand, read the journey's ownership (`journeyOwnership`,
 * `core/journey/journey-path.ts`), which places them. What a reader written for a page of ids
 * reads, unchanged for a page that holds nothing else.
 */
export function journeyPageFormIds(page: { components?: readonly JourneyPageEntry[] | undefined }): string[] {
  const ids: string[] = [];
  for (const entry of page.components ?? []) {
    if (typeof entry === "string") {
      ids.push(entry);
    }
  }
  return ids;
}

/** Whether a journey's pages hold any object entry: a node the presentation owns, or a reference. */
export function journeyHasOwnNodes(journey: Journey): boolean {
  return journey.pages.some((page) => (page.components ?? []).some((entry) => typeof entry !== "string"));
}

