/**
 * The form as the builder tools describe it: `get_form`'s flat outline in document order, `detail: "full"` rows with each node's JSON,
 * and the `stale` refusal's first rows, all from one walk of the committed tree in the
 * shape `treeView()` answers (labels in the builder locale, slots in declared order).
 *
 * Not `treeView()` itself: it lays the person's drafts over the tree (it is the canvas's view),
 * and a draft is the person's until they apply it, so no read shows it: never the person's unsaved draft text. {@link committedView} builds the same shape from
 * `snapshot()`, slots ordered as the tree view orders them.
 *
 * Every row is a copy: `snapshot()` shares `configuration` and `rules` with the tree (BC
 * gotcha 1), so a node's JSON is `structuredClone`d before it leaves, and an agent that mutates
 * a result never touches the form.
 */
import { readSourceId } from "../../core/schema/data-source-capability.js";
import { INLINE_OPTIONS_PROPERTY, readInlineOptions } from "../../core/schema/inline-options.js";
import type { ComponentNode, SlotDefinition } from "../../core/schema/types.js";
import { buildDataPaths, collectionPathOf, holdsData } from "../../core/tree/data-scope.js";
import { addressOf, resolveText, type TextSources } from "../../core/localization/translations.js";
import { configuredSlotIds } from "../../render/core/tab-slots.js";
import type { BuilderController } from "../../builder/controller/builder-controller.js";
import { ruleText } from "../../builder/property-editor/rule-source.js";
import { cutString } from "../result-caps.js";
import type { BuilderCallScope } from "./context.js";
import type { FullNode, OutlineNode } from "./types.js";

/** Labels in a row are cut here. */
export const LABEL_CAP = 200;
/** Inline options a full row carries before `moreOptions`. */
export const INLINE_OPTIONS_CAP = 25;

/** The tree view node `treeView()` answers (its module is not one the agent layer imports). */
export type NestedTreeNodeView = ReturnType<BuilderController["treeView"]>;


/** Each registered type's declared slots, from `typeInfo()`, kept until the component definitions change. */
function slotsByType(scope: BuilderCallScope): ReadonlyMap<string, readonly SlotDefinition[]> {
  const memory = scope.slots;
  const cached = memory.value;
  if (cached !== undefined && cached.controller === scope.controller && cached.generation === memory.generation()) {
    return cached.slots;
  }
  const slots = new Map<string, readonly SlotDefinition[]>();
  for (const info of scope.controller.typeInfo()) {
    if (info.slots !== undefined) {
      slots.set(info.type, info.slots);
    }
  }
  memory.value = { controller: scope.controller, generation: memory.generation(), slots };
  return slots;
}

/** A node's label as the tree view words it, over the committed node: its label in the builder's locale (through the form's translations), else its id. */
function labelOfNode(node: ComponentNode, locale: string, sources: TextSources): string {
  const configuration = isRecord(node.configuration) ? node.configuration : {};
  const label = configuration.label;
  if (typeof label === "string" && label.length > 0) {
    return resolveText(label, addressOf.component(node.id, "label"), locale, sources);
  }
  return node.id;
}

/**
 * The committed tree in `treeView()`'s shape, once per call: configuration-declared slots first
 * (a grid's columns, a tab set's tabs), then the type's declared slots, then whatever the tree
 * holds besides, as the tree view orders them.
 */
export function committedView(scope: BuilderCallScope): NestedTreeNodeView {
  const cached = scope.cache.get("committed-view") as NestedTreeNodeView | undefined;
  if (cached !== undefined) {
    return cached;
  }
  const declared = slotsByType(scope);
  const locale = scope.controller.currentLocale();
  const sources = { translations: scope.controller.translations(), catalog: scope.controller.translationCatalog() };
  const build = (node: ComponentNode, depth: number): NestedTreeNodeView => {
    const definitions = declared.get(node.type) ?? [];
    const slotIds = [...new Set([...(configuredSlotIds(node) ?? []), ...definitions.map((slot) => slot.id), ...Object.keys(node.children ?? {})])];
    const slots = slotIds.map((slotId) => {
      const definition = definitions.find((slot) => slot.id === slotId);
      return {
        slotId,
        definition,
        allowedTypes: definition?.allowedTypes,
        multiple: definition?.multiple ?? true,
        children: (node.children?.[slotId] ?? []).map((child) => build(child, depth + 1))
      };
    });
    return { node, id: node.id, type: node.type, label: labelOfNode(node, locale, sources), depth, slots } as NestedTreeNodeView;
  };
  const view = build(scope.controller.snapshot(), 0);
  scope.cache.set("committed-view", view);
  return view;
}

export interface OutlineOptions {
  /** Only this component and what is under it. */
  componentId?: string;
  /** Levels below the start to include; all when absent. */
  depth?: number;
  detail?: "outline" | "full";
  /** Committed-check findings per component id, for each row's `problems`. */
  problems?: ReadonlyMap<string, number>;
}

export interface Outline {
  rootId: string;
  nodes: Array<OutlineNode | FullNode>;
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A label-like value as text: the string, in the form's default language. */
function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Each component's value path over the committed tree, once per call: `dataPathOf` for every id without a walk per id. */
export function dataPathsOf(scope: BuilderCallScope): ReadonlyMap<string, string> {
  const cached = scope.cache.get("data-paths") as Map<string, string> | undefined;
  if (cached !== undefined) {
    return cached;
  }
  const root = scope.controller.snapshot();
  const all = buildDataPaths(root);
  const paths = new Map<string, string>();
  const stack: ComponentNode[] = [...Object.values(root.children ?? {}).flat()];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    const path = all.get(node.id);
    // The root and the nodes with no place of their own (a fieldset, a button) have no path, as dataPathOf answers.
    if (path !== undefined && holdsData(node)) {
      paths.set(node.id, path);
    }
    for (const group of Object.values(node.children ?? {})) {
      stack.push(...group);
    }
  }
  scope.cache.set("data-paths", paths);
  return paths;
}

/** Each component's label as the outline words it (its id when it has none), once per call. */
export function labelsOf(scope: BuilderCallScope): ReadonlyMap<string, string> {
  const cached = scope.cache.get("labels") as Map<string, string> | undefined;
  if (cached !== undefined) {
    return cached;
  }
  const labels = new Map<string, string>();
  const stack: NestedTreeNodeView[] = [committedView(scope)];
  while (stack.length > 0) {
    const view = stack.pop() as NestedTreeNodeView;
    labels.set(view.id, cutString(view.label, LABEL_CAP));
    for (const slot of view.slots) {
      stack.push(...slot.children);
    }
  }
  scope.cache.set("labels", labels);
  return labels;
}

/** The view node with `id` under `view`, depth-first. */
export function findView(view: NestedTreeNodeView, id: string): NestedTreeNodeView | undefined {
  const stack: NestedTreeNodeView[] = [view];
  while (stack.length > 0) {
    const next = stack.pop() as NestedTreeNodeView;
    if (next.id === id) {
      return next;
    }
    for (const slot of next.slots) {
      stack.push(...slot.children);
    }
  }
  return undefined;
}

/** One outline row for a view node at its place. */
export function outlineRow(
  scope: BuilderCallScope,
  view: NestedTreeNodeView,
  place: { parentId?: string; slotId?: string; index: number },
  problems?: ReadonlyMap<string, number>
): OutlineNode {
  const controller = scope.controller;
  const node = view.node;
  const configuration = isRecord(node.configuration) ? node.configuration : {};
  // The root is named by the form's title (the tree view names it by its id, the form having no label).
  const title = place.parentId === undefined && view.label === view.id ? textOf(configuration.title) ?? textOf(configuration.label) : undefined;
  const row: OutlineNode = { id: view.id, type: view.type, label: cutString(title !== undefined && title !== "" ? title : view.label, LABEL_CAP), index: place.index, depth: view.depth };
  if (place.parentId !== undefined) {
    row.parentId = place.parentId;
  }
  if (place.slotId !== undefined) {
    row.slotId = place.slotId;
  }
  const path = dataPathsOf(scope).get(view.id);
  if (path !== undefined) {
    row.path = path;
  }
  if (typeof configuration.dataKey === "string" && configuration.dataKey !== "") {
    row.dataKey = configuration.dataKey;
  }
  if (configuration.required === true && controller.typeOffersRequired(view.type)) {
    row.required = true;
  }
  if (configuration.hidden === true) {
    row.hidden = true;
  }
  const rules = Object.keys(node.rules ?? {}).filter((key) => (node.rules as Record<string, unknown>)[key] !== undefined);
  if (rules.length > 0) {
    row.rules = rules;
  }
  const options = readInlineOptions(configuration).length;
  if (options > 0) {
    row.options = options;
  }
  const source = readSourceId(configuration);
  if (source !== undefined) {
    row.source = source;
  }
  const collection = collectionPathOf(node);
  if (collection !== undefined) {
    row.collection = collection;
  }
  if (view.slots.length > 0) {
    row.slots = view.slots.map((slot) => {
      const entry: { id: string; count: number; allowedTypes?: string[]; multiple: boolean } = { id: slot.slotId, count: slot.children.length, multiple: slot.multiple };
      if (slot.allowedTypes !== undefined && slot.allowedTypes.length > 0) {
        entry.allowedTypes = [...slot.allowedTypes];
      }
      return entry;
    });
  }
  if (controller.isFixedNode(view.id)) {
    row.fixed = true;
  }
  const count = problems?.get(view.id) ?? 0;
  if (count > 0) {
    row.problems = count;
  }
  return row;
}

/** A row with the node's JSON (`FullNode`): configuration copied, inline options capped at 25. */
export function fullRow(row: OutlineNode, node: ComponentNode): FullNode {
  const configuration = isRecord(node.configuration) ? (structuredClone(node.configuration) as Record<string, unknown>) : {};
  const full: FullNode = { ...row, configuration };
  const options = configuration[INLINE_OPTIONS_PROPERTY];
  if (Array.isArray(options) && options.length > INLINE_OPTIONS_CAP) {
    configuration[INLINE_OPTIONS_PROPERTY] = options.slice(0, INLINE_OPTIONS_CAP);
    full.moreOptions = options.length - INLINE_OPTIONS_CAP;
  }
  const rulesText: Record<string, string> = {};
  for (const [key, source] of Object.entries(node.rules ?? {})) {
    const text = ruleText(source);
    if (text !== undefined) {
      rulesText[key] = text;
    }
  }
  if (Object.keys(rulesText).length > 0) {
    full.rulesText = rulesText;
  }
  if (node.collection !== undefined) {
    full.collectionBinding = structuredClone(node.collection);
  }
  return full;
}

/**
 * The outline over the committed tree, depth-first with slots in declared order, from the root
 * or from `componentId`; `undefined` when `componentId` names nothing (the caller refuses with
 * `unknown-component`).
 */
export function buildOutline(scope: BuilderCallScope, options: OutlineOptions = {}): Outline | undefined {
  const view = committedView(scope);
  let start: { view: NestedTreeNodeView; place: { parentId?: string; slotId?: string; index: number } } = { view, place: { index: 0 } };
  if (options.componentId !== undefined && options.componentId !== view.id) {
    const found = placeOf(view, options.componentId);
    if (found === undefined) {
      return undefined;
    }
    start = found;
  }
  const nodes: Array<OutlineNode | FullNode> = [];
  const limit = options.depth === undefined ? Number.POSITIVE_INFINITY : start.view.depth + options.depth;
  const stack: Array<{ view: NestedTreeNodeView; place: { parentId?: string; slotId?: string; index: number } }> = [start];
  while (stack.length > 0) {
    const next = stack.pop() as (typeof stack)[number];
    const row = outlineRow(scope, next.view, next.place, options.problems);
    nodes.push(options.detail === "full" ? fullRow(row, next.view.node) : row);
    if (next.view.depth >= limit) {
      continue;
    }
    const children: Array<(typeof stack)[number]> = [];
    for (const slot of next.view.slots) {
      slot.children.forEach((child, index) => {
        children.push({ view: child, place: { parentId: next.view.id, slotId: slot.slotId, index } });
      });
    }
    for (let at = children.length - 1; at >= 0; at -= 1) {
      stack.push(children[at] as (typeof stack)[number]);
    }
  }
  return { rootId: view.id, nodes, total: nodes.length };
}

/** A view node with its parent, slot and index. */
function placeOf(root: NestedTreeNodeView, id: string): { view: NestedTreeNodeView; place: { parentId?: string; slotId?: string; index: number } } | undefined {
  const stack: NestedTreeNodeView[] = [root];
  while (stack.length > 0) {
    const parent = stack.pop() as NestedTreeNodeView;
    for (const slot of parent.slots) {
      const index = slot.children.findIndex((child) => child.id === id);
      if (index >= 0) {
        return { view: slot.children[index] as NestedTreeNodeView, place: { parentId: parent.id, slotId: slot.slotId, index } };
      }
      stack.push(...slot.children);
    }
  }
  return undefined;
}

/** Edit distance between two ids, stopping early once past `cap`. */
function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) {
    return cap + 1;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      const value = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > cap) {
      return cap + 1;
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** The id nearest to `id` within three edits (case counts), the first of equals; `undefined` when none is that close. */
export function closestId(ids: Iterable<string>, id: string, cap = 3): string | undefined {
  let best: { id: string; distance: number } | undefined;
  for (const candidate of ids) {
    if (candidate === id) {
      continue;
    }
    const d = distance(candidate, id, cap);
    if (d <= cap && (best === undefined || d < best.distance)) {
      best = { id: candidate, distance: d };
    }
  }
  return best?.id;
}
