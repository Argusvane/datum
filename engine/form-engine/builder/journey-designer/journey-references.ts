/**
 * Following a form component's rename into the journeys that reference it. A journey
 * names components in two places: a page's `components`, and the `path` nodes of its pages' and
 * routes' conditions (`when`), which read answers by component id. When the form renames a
 * component, both are rewritten in every journey, so the journeys go on asking the same question
 * and branching on the same answer.
 *
 * A page may also hold nodes the presentation owns, written as objects beside the
 * ids. They name form components in four more places, and each follows the rename: a
 * reference's `configuration.componentId`, an alias's `configuration.fills`, a worked-out
 * value's `configuration.to`, and the form-scoped paths in an own node's rules (`visibleWhen`,
 * `enabledWhen`, `readonlyWhen`, `requiredWhen`), all the way down its own layouts. A
 * worked-out value's expression (`configuration.value`) reads the page's own fields only, so it
 * is left as written; so is every key of an own node this module does not know.
 *
 * A condition path is rewritten when its leading segment — the part before any `.` or `[`, the
 * way the path engine resolves a key (`journeyLeadingSegment`) — is the old id: `applicants` also
 * renames `applicants[0].name`. Paths from outside the form's answers (`row.`, `ancestor.`,
 * `host.`, `component`) are never rewritten; a journey condition may not read them anyway. A
 * condition stored as a formula string, alone or as the object form's `formula`, is rewritten
 * over the parser's spans (`renamePathsInFormula`), the author's spacing kept; one the parser
 * rejects is left as written, there being no span to trust.
 *
 * Pure: every function returns what it was given, the same object, when nothing in it names the
 * old id, so a caller can compare by identity. Journeys that fail `validateJourneyShape` are left
 * exactly as they are, as everywhere else in the builder.
 *
 * Static and free of work at import.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import { PRESENTATION_REFERENCE_TYPE, PRESENTATION_VALUE_TYPE, type Journey, type JourneyPageEntry } from "../../core/schema/journey.js";
import { journeyLeadingSegment } from "../../core/journey/journey-shared.js";
import { formulaReadsField } from "../formula/rename.js";
import { OWN_RULE_KEYS, isScopedPath, renameConditionPaths, renameEntry, renameReviewLabels } from "./journey-config-rename.js";

// The configuration-level rename lives in an eager module of its own, so the builder
// follows a rename into the definition's journeys without the Journeys mode's chunk.
export { renameConditionPaths, renameJourneyReferences, renamePathSegment, renameReferencesInConfiguration } from "./journey-config-rename.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every id a node of a presentation's own carries, in every journey the
 * block declares — usable or not, opened in a designer or not — all the way down its own
 * layouts: the ids a form component must not take, since a form id beside an own one makes the
 * own entry unusable (rule A). A reference carries none of its own.
 */
export function journeyOwnNodeIds(configuration: unknown): Set<string> {
  const ids = new Set<string>();
  const declared = isRecord(configuration) && Array.isArray(configuration.journeys) ? configuration.journeys : [];
  const stack: unknown[] = [];
  for (const journey of declared) {
    for (const page of isRecord(journey) && Array.isArray(journey.pages) ? journey.pages : []) {
      if (isRecord(page) && Array.isArray(page.components)) {
        stack.push(...page.components);
      }
    }
  }
  while (stack.length > 0) {
    const node = stack.pop();
    // A reference written with an id of its own is still a reference: nothing reads that id.
    if (!isRecord(node) || node.type === PRESENTATION_REFERENCE_TYPE) {
      continue;
    }
    if (typeof node.id === "string") {
      ids.add(node.id);
    }
    for (const held of isRecord(node.children) ? Object.values(node.children) : []) {
      if (Array.isArray(held)) {
        stack.push(...held);
      }
    }
  }
  return ids;
}

/**
 * Whether a condition reads the component `id`: a form-scoped `path` node leading with it,
 * anywhere in it, or a formula string (alone, or the object form's `formula`) that reads it.
 */
export function conditionReadsComponent(condition: unknown, id: string): boolean {
  if (typeof condition === "string") {
    return formulaReadsField(condition, id);
  }
  if (Array.isArray(condition)) {
    return condition.some((item) => typeof item !== "string" && conditionReadsComponent(item, id));
  }
  if (!isRecord(condition)) {
    return false;
  }
  if (condition.kind === "path" && typeof condition.path === "string") {
    return !isScopedPath(condition.path) && journeyLeadingSegment(condition.path) === id;
  }
  if (condition.kind === undefined && typeof condition.formula === "string" && formulaReadsField(condition.formula, id)) {
    return true;
  }
  return Object.values(condition).some((item) => typeof item !== "string" && conditionReadsComponent(item, id));
}

/**
 * Whether an entry of a page names the form component `id`: the id itself, or a node
 * the presentation owns that references it, fills it, works it out or reads it in a rule,
 * anywhere under it. Exactly what {@link renameJourneyReferences} would rewrite.
 */
function entryNamesComponent(entry: JourneyPageEntry, id: string): boolean {
  return typeof entry === "string" ? entry === id : id !== "" && renameEntry(entry, id, `${id}_`) !== entry;
}

/** Whether a journey names the component `id` on a page — by its id or from a node of its own — or in a condition. */
export function journeyReferencesComponent(journey: Journey, id: string): boolean {
  return journey.pages.some(
    (page) =>
      (page.components ?? []).some((entry) => entryNamesComponent(entry, id)) ||
      (page.routes ?? []).some((route) => conditionReadsComponent(route.when, id))
  );
}

/**
 * The designer's own node types (`journey-mode-model.ts` names them; spelled out here, which that
 * module imports, rather than imported back). A question is a reference, `journey-field`.
 */
const DESIGNER_FRAME_TYPES: readonly string[] = ["journey", "journey-page", "journey-route"];

/** Whether a node of a designer tree is one of the journey's own: neither the designer's frame nor a question. */
function isOwnTreeNode(node: ComponentNode): boolean {
  return !DESIGNER_FRAME_TYPES.includes(node.type) && node.type !== PRESENTATION_REFERENCE_TYPE;
}

/** Every node of a designer tree, the root first, in document order, with a stack of its own (a layout of the journey's own nests). */
function treeNodes(root: ComponentNode): ComponentNode[] {
  const out: ComponentNode[] = [];
  const stack: ComponentNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    out.push(node);
    const children = Object.values(node.children ?? {}).flat();
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]!);
    }
  }
  return out;
}

/** One property a designer tree must change to follow a rename in place. */
export interface JourneyTreeRename {
  nodeId: string;
  /**
   * The configuration property to set — a question's `componentId`, a page's or route's
   * `when`, a Check answers step's `review.labels` (a dotted path, nested as `setProperties`
   * reads it), an alias's `fills`, a worked-out value's `to` or `value` — or, with `rules`, the
   * key of the rule to set.
   */
  property: string;
  value: unknown;
  /** The edit is to the node's rule `property` (a node of the journey's own), not to its configuration. */
  rules?: true;
}

/** The edits that rename the paths a node of the journey's own reads in its rules (`visibleWhen` and the rest) from `from` to `to`. */
function ownRuleRenames(node: ComponentNode, from: string, to: string): JourneyTreeRename[] {
  const rules: Record<string, unknown> | undefined = isRecord(node.rules) ? (node.rules as Record<string, unknown>) : undefined;
  const out: JourneyTreeRename[] = [];
  for (const key of OWN_RULE_KEYS) {
    const rule = rules?.[key];
    if (rule === undefined || rule === null) {
      continue;
    }
    const renamed = renameConditionPaths(rule, from, to);
    if (renamed !== rule) {
      out.push({ nodeId: node.id, property: key, value: renamed, rules: true });
    }
  }
  return out;
}

/**
 * The edits that follow a form component's rename in a designer's tree already built
 * (`journey-tree.ts`): each question whose `componentId` is `from` — at the top of a page or
 * inside a layout of the journey's own — each page's or route's `when` that reads it, and,
 * on the nodes the journey owns, an alias's `fills`, a worked-out value's `to` and
 * the form paths of their rules (`visibleWhen`, `enabledWhen`, `readonlyWhen`, `requiredWhen`):
 * exactly what {@link renameJourneyReferences} rewrites in the stored journey, so the tree
 * written afterwards is that journey. A worked-out value's expression reads the page's own
 * fields, and is left alone. The mode writes them with one `setProperties` under its syncing
 * flag — one undo step, so an Undo never leaves the journey half renamed — and the journey's
 * undo history, drafts and selection survive. Read from the tree's node types,
 * spelled out here, so this module needs nothing from the designer's chunk.
 */
export function journeyTreeRenames(root: ComponentNode, from: string, to: string): JourneyTreeRename[] {
  return treeNodes(root).flatMap((node) => formRenamesOf(node, from, to));
}

/** One node's edits for a form component renamed (see {@link journeyTreeRenames}). */
function formRenamesOf(node: ComponentNode, from: string, to: string): JourneyTreeRename[] {
  const out: JourneyTreeRename[] = [];
  if (from === "" || from === to) {
    return out;
  }
  const configuration = isRecord(node.configuration) ? node.configuration : {};
  if (node.type === PRESENTATION_REFERENCE_TYPE) {
    if (configuration.componentId === from) {
      out.push({ nodeId: node.id, property: "componentId", value: to });
    }
    return out;
  }
  if (DESIGNER_FRAME_TYPES.includes(node.type)) {
    // A Check answers step words its rows by form field.
    const review = configuration.review;
    const labels = isRecord(review) ? review.labels : undefined;
    if (node.type === "journey-page" && isRecord(labels)) {
      const renamed = renameReviewLabels(labels, from, to);
      if (renamed !== labels) {
        out.push({ nodeId: node.id, property: "review.labels", value: renamed });
      }
    }
    // A route's condition; a page has none of its own.
    if (configuration.when !== undefined) {
      const when = renameConditionPaths(configuration.when, from, to);
      if (when !== configuration.when) {
        out.push({ nodeId: node.id, property: "when", value: when });
      }
    }
    return out;
  }
  if (configuration.fills === from) {
    out.push({ nodeId: node.id, property: "fills", value: to });
  }
  if (node.type === PRESENTATION_VALUE_TYPE && configuration.to === from) {
    out.push({ nodeId: node.id, property: "to", value: to });
  }
  out.push(...ownRuleRenames(node, from, to));
  return out;
}

/**
 * The edits that follow a node of the journey's own renamed from `from` to `to` inside its
 * designer's tree: the journey's own rules and worked-out values read its own fields
 * by their bare ids, so every path leading with `from` in an own node's rules and in a
 * worked-out value's expression (`configuration.value`) leads with `to` after it. The pages'
 * and routes' conditions read form values only, and are left alone. The mode writes them with
 * one `setProperties`, as it writes a form rename's.
 */
export function journeyOwnRenames(root: ComponentNode, from: string, to: string): JourneyTreeRename[] {
  return treeNodes(root).flatMap((node) => ownRenamesOf(node, from, to));
}

/** One node's edits for a node of the journey's own renamed (see {@link journeyOwnRenames}). */
function ownRenamesOf(node: ComponentNode, from: string, to: string): JourneyTreeRename[] {
  const out: JourneyTreeRename[] = [];
  if (from === "" || from === to || !isOwnTreeNode(node)) {
    return out;
  }
  const configuration = isRecord(node.configuration) ? node.configuration : {};
  if (node.type === PRESENTATION_VALUE_TYPE && (isRecord(configuration.value) || typeof configuration.value === "string")) {
    const value = renameConditionPaths(configuration.value, from, to);
    if (value !== configuration.value) {
      out.push({ nodeId: node.id, property: "value", value });
    }
  }
  out.push(...ownRuleRenames(node, from, to));
  return out;
}

/** An edit as the journey's controller writes it (`BuilderController.setProperties`). */
export interface JourneyTreeEdit {
  componentId: string;
  propertyPath: string;
  value: unknown;
  target?: "rules" | "children";
}

/**
 * A rename's follow-up in a designer's tree as its controller writes it, in one `setProperties`
 * step: a form component's (`"form"`, {@link journeyTreeRenames}) or a node of the journey's
 * own (`"own"`, {@link journeyOwnRenames}). Each edit goes by its node's id while every id in the
 * tree is one node's. A hand-written own node sharing its id with another, or with the
 * journey's root, would take the edits of the first holding it instead: then one
 * edit puts the root's slots back with every rename made in its own place, as the catalog's
 * rename makes them.
 */
export function journeyRenameEdits(root: ComponentNode, kind: "form" | "own", from: string, to: string): JourneyTreeEdit[] {
  const renamesOf = (node: ComponentNode): JourneyTreeRename[] => (kind === "form" ? formRenamesOf : ownRenamesOf)(node, from, to);
  const nodes = treeNodes(root);
  if (new Set(nodes.map((node) => node.id)).size === nodes.length) {
    return nodes.flatMap(renamesOf).map((edit) => ({ componentId: edit.nodeId, propertyPath: edit.property, value: edit.value, ...(edit.rules ? { target: "rules" as const } : {}) }));
  }
  const copy = structuredClone(root);
  let changed = false;
  for (const node of treeNodes(copy)) {
    for (const edit of renamesOf(node)) {
      changed = true;
      let target = edit.rules ? ((node.rules ??= {}) as Record<string, unknown>) : (node.configuration = isRecord(node.configuration) ? node.configuration : {});
      // A dotted property (`review.labels`) is a path, as `setProperties` reads it.
      const parts = edit.property.split(".");
      const last = parts.pop()!;
      for (const part of parts) {
        target = target[part] = isRecord(target[part]) ? target[part] : {};
      }
      target[last] = edit.value;
    }
  }
  return changed ? [{ componentId: root.id, propertyPath: "", value: copy.children, target: "children" }] : [];
}

/**
 * The ids of the nodes a designer's tree holds of the journey's own, all the way down
 * its layouts: what the form must not take while the tree stands, written or not yet.
 */
export function journeyTreeOwnIds(root: ComponentNode): string[] {
  return treeNodes(root)
    .filter((node) => isOwnTreeNode(node))
    .map((node) => node.id);
}
