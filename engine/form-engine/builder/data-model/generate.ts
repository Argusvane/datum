import type { ComponentNode } from "../../core/schema/types.js";
import { DATA_GRID_COMPONENT_TYPE } from "../../core/schema/data-grid.js";
import type { InsertComponentEntry } from "../controller/builder-controller.js";
import {
  humanizeKey,
  indexDataModel,
  type DataModel,
  type DataModelNode,
  type DataModelNote
} from "./data-model.js";
import type { DataModelComparison } from "./compare.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { builderText } from "../data/data-texts-en.js";
import { isReservedComponentId } from "../../core/tree/component-id.js";
import { mappingFor, RADIO_MAX_OPTIONS } from "./mapping.js";

/**
 * Building components from a data model: each place in the data becomes the
 * component `mappingFor` chooses, keyed so its answer lands exactly there — an
 * object a data-scoping container, a list of entries a repeating section — with its label,
 * choices, bounds and whether it is required carried into its configuration.
 *
 * Ids are unique across the form: a key is its component's id when that id is free, else the
 * id takes its parents' keys in front (`billing_street`), else a number (`street_2`), and the
 * component keeps the key as its data key. A place that cannot be built is reported with why.
 */

export interface GenerateOptions {
  /** Ids already in use, which nothing built may take. */
  takenIds?: Iterable<string>;
  /** Whether the builder has a type; only those are built. */
  hasType(type: string): boolean;
  /** What a type starts as — its registered default — for the configuration built over it. */
  template?(type: string): ComponentNode | undefined;
  /** Up to this many choices a radio group, more a select; default {@link RADIO_MAX_OPTIONS}. */
  radioMax?: number;
  /** The builder's locale and catalog for the reasons a place is skipped; English when absent. */
  text?: BuilderTextOptions | undefined;
}

/** A component built for one place, with what is worth knowing about it. */
export interface GeneratedComponent {
  node: ComponentNode;
  /** The place it holds. */
  path: string;
  notes: DataModelNote[];
}

/** A place nothing was built for, and why. */
export interface SkippedPlace {
  path: string;
  reason: string;
}

/** What {@link planAddMissing} would insert, and what it leaves out. */
export interface DataModelPlan {
  entries: InsertComponentEntry[];
  added: Array<{ path: string; componentId: string; notes: DataModelNote[] }>;
  skipped: SkippedPlace[];
}

/** What {@link planReplace} would put in the form's place. */
export interface DataModelReplacement {
  nodes: ComponentNode[];
  /** The root's closing buttons, kept after the new content. */
  keep: string[];
  added: DataModelPlan["added"];
  skipped: SkippedPlace[];
}

const ID_CHARACTERS = /[^A-Za-z0-9_-]+/g;

function asId(raw: string): string {
  const cleaned = raw.replace(ID_CHARACTERS, "_");
  if (cleaned.length === 0) {
    return "field";
  }
  // The reserved words (`row`, `host`, `constructor` and the rest) fit the id grammar but are not
  // ids a component may take; the key stays the data key, so the answer still lands at it.
  const safe = isReservedComponentId(cleaned) ? `${cleaned}_field` : cleaned;
  return /^[A-Za-z]/.test(safe) ? safe : `f_${safe}`;
}

function collectIds(node: ComponentNode, into: Set<string>): void {
  into.add(node.id);
  for (const group of Object.values(node.children ?? {})) {
    for (const child of group) {
      collectIds(child, into);
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** An option's words: its title, else the value in words when it reads as a name (`in_progress` → "In progress"), else the value. */
function optionLabel(value: string, label: string | undefined): string {
  if (label !== undefined && label !== "") {
    return label;
  }
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) ? humanizeKey(value) : value;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** The keys above a place, from its parent path: `order.items[]` → `order`, `items`. */
function keysOf(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.replace(/\[\]$/, ""))
    .filter((segment) => segment.length > 0);
}

/** Builds components with one shared set of taken ids, so everything it builds is unique together. */
class Generator {
  private readonly taken: Set<string>;
  private readonly radioMax: number;
  public readonly skipped: SkippedPlace[] = [];

  constructor(private readonly options: GenerateOptions, taken: Iterable<string>) {
    this.taken = new Set(taken);
    this.radioMax = options.radioMax ?? RADIO_MAX_OPTIONS;
  }

  private id(key: string, parentKeys: readonly string[]): string {
    const base = asId(key);
    const take = (candidate: string): string => {
      this.taken.add(candidate);
      return candidate;
    };
    if (!this.taken.has(base)) {
      return take(base);
    }
    for (let depth = 1; depth <= parentKeys.length; depth += 1) {
      const candidate = asId([...parentKeys.slice(parentKeys.length - depth), key].join("_"));
      if (!this.taken.has(candidate)) {
        return take(candidate);
      }
    }
    let counter = 2;
    while (this.taken.has(`${base}_${counter}`)) {
      counter += 1;
    }
    return take(`${base}_${counter}`);
  }

  public build(node: DataModelNode, parentKeys: readonly string[], inEntry: boolean): GeneratedComponent | undefined {
    const mapping = mappingFor(node, this.options.hasType, inEntry, this.radioMax, this.options.text);
    if (mapping.fit === "unsupported" || mapping.type === undefined) {
      this.skipped.push({ path: node.path, reason: mapping.notes[0]?.message ?? builderText("dataModel.gen.nothingBuilt", undefined, this.options.text) });
      return undefined;
    }
    const type = mapping.type;
    const id = this.id(node.key, parentKeys);
    const template = this.options.template?.(type);
    const configuration: Record<string, unknown> = { ...record(template?.configuration) };
    configuration.label = node.label ?? humanizeKey(node.key);
    if (node.description) {
      configuration.description = node.description;
    } else {
      delete configuration.description;
    }
    Object.assign(configuration, mapping.configuration ?? {});

    const out: ComponentNode = { id, type, configuration };
    const isList = node.kind === "array" && node.items?.kind === "object";
    if (!isList && node.key !== id) {
      configuration.dataKey = node.key;
    }

    // Required: on an answer only — never a container or a section, whose place holds no value
    // of its own to check — never inside an entry (the form checks it outside any), never a
    // checkbox (false is an answer), and a list only when it must have an entry.
    const holdsAnswer = !isList && !(node.kind === "object" && type === "container");
    const listRequired = node.kind === "array" ? (node.minItems ?? 0) >= 1 : true;
    if (node.required && holdsAnswer && !node.nullable && !inEntry && type !== "checkbox" && listRequired) {
      configuration.required = true;
    }
    if (type === "text" || type === "textarea") {
      if (node.pattern) {
        configuration.pattern = node.pattern;
      }
      if (node.minLength !== undefined && node.minLength >= 1) {
        configuration.minLength = node.minLength;
      }
      if (node.maxLength !== undefined && node.maxLength >= 1) {
        configuration.maxLength = node.maxLength;
      }
    }
    if (type === "number") {
      if (node.minimum !== undefined) {
        configuration.min = node.minimum;
      }
      if (node.maximum !== undefined) {
        configuration.max = node.maximum;
      }
    }
    const options = node.kind === "array" ? node.items?.options : node.options;
    if (options && options.length > 0 && (type === "radio" || type === "select" || type === "checkboxes")) {
      configuration.options = options.map((option) => ({
        value: option.value,
        label: optionLabel(option.value, option.label),
        ...(option.description ? { description: option.description } : {})
      }));
    } else if (node.format === "flags" && type === "checkboxes") {
      configuration.options = (node.children ?? []).map((child) => ({ value: child.key, label: optionLabel(child.key, child.label) }));
    }
    if (!inEntry && isScalar(node.default) && node.kind !== "array" && node.kind !== "object") {
      out.rules = { defaultValue: { kind: "literal", value: node.default } };
    }

    if (node.kind === "object" && type === "container") {
      out.children = { content: this.children(node.children ?? [], [...parentKeys, node.key], inEntry) };
    } else if (isList) {
      const rows = this.children(node.items?.children ?? [], [...parentKeys, node.key], true);
      out.children = { content: rows };
      // A data grid keeps its rows at its collection path and derives its row fields from its
      // children, so it writes the path always and no `itemFields`; a repeating
      // section keeps listing its row fields by id, and the path only when it differs from the id.
      out.collection =
        type === DATA_GRID_COMPONENT_TYPE
          ? { collectionPath: node.path }
          : {
              ...(node.path !== id ? { collectionPath: node.path } : {}),
              itemFields: rows.map((row) => row.id)
            };
    } else if (template?.children) {
      out.children = structuredClone(template.children);
    }
    return { node: out, path: node.path, notes: mapping.notes };
  }

  public children(nodes: readonly DataModelNode[], parentKeys: readonly string[], inEntry: boolean): ComponentNode[] {
    return nodes.map((node) => this.build(node, parentKeys, inEntry)?.node).filter((node): node is ComponentNode => node !== undefined);
  }
}

/**
 * Components for places of a model, each with the place it holds; what cannot be built is in
 * `skipped`. `parentKeys` are the keys above the places (for ids that must avoid a clash),
 * `inEntry` whether they sit inside a repeating section's entry.
 */
export function generateComponents(
  nodes: readonly DataModelNode[],
  options: GenerateOptions & { parentKeys?: readonly string[]; inEntry?: boolean }
): { components: GeneratedComponent[]; skipped: SkippedPlace[] } {
  const generator = new Generator(options, options.takenIds ?? []);
  const components = nodes
    .map((node) => generator.build(node, options.parentKeys ?? [], options.inEntry ?? false))
    .filter((component): component is GeneratedComponent => component !== undefined);
  return { components, skipped: generator.skipped };
}

/**
 * The ids of the root's closing buttons, the ones a rebuilt form keeps after its fields and a
 * journey made from the form puts on its last page.
 */
export function trailingButtonIds(content: readonly ComponentNode[]): string[] {
  const ids: string[] = [];
  for (let index = content.length - 1; index >= 0 && content[index]!.type === "button"; index -= 1) {
    ids.unshift(content[index]!.id);
  }
  return ids;
}

function findNode(root: ComponentNode, id: string): ComponentNode | undefined {
  if (root.id === id) {
    return root;
  }
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      const found = findNode(child, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function firstSlotOf(node: ComponentNode | undefined): string {
  const slots = Object.keys(node?.children ?? {});
  return slots.includes("content") || slots.length === 0 ? "content" : slots[0]!;
}

/** Where a new top-level component goes: `index` is set only at the root, before its closing buttons. */
export interface RootInsertTarget {
  parentId: string;
  slotId: string;
  index?: number;
}

/**
 * Where a component for a root-level place goes: before the root's closing buttons, or into
 * the last step of a multi-step form. "Add missing fields" puts a root-level place there, and
 * so does the PDF designer's "Create form fields". A caller inserting several at
 * the root raises `index` by one after each.
 */
export function rootInsertTarget(formRoot: ComponentNode): RootInsertTarget {
  const content = formRoot.children?.content ?? [];
  const steps = content.find((node) => node.type === "steps");
  const lastStep = steps?.children ? Object.values(steps.children).flat().filter((node) => node.type === "step").pop() : undefined;
  return lastStep
    ? { parentId: lastStep.id, slotId: firstSlotOf(lastStep) }
    : { parentId: formRoot.id, slotId: "content", index: content.length - trailingButtonIds(content).length };
}

/**
 * What "Add missing fields" inserts: a component for each new place whose parent the form
 * already holds — at the root (before its closing buttons, or into the last step of a
 * multi-step form), inside the data-scoping container that holds the parent object, or inside
 * the repeating section whose entries are the parent. A place whose parent the form holds as
 * something else, or holds with no container, is skipped with the reason.
 */
export function planAddMissing(
  formRoot: ComponentNode,
  formModel: DataModel,
  comparison: DataModelComparison,
  options: GenerateOptions
): DataModelPlan {
  const taken = new Set<string>(options.takenIds ?? []);
  collectIds(formRoot, taken);
  const generator = new Generator(options, taken);
  const formIndex = indexDataModel(formModel);
  const rootTarget = rootInsertTarget(formRoot);
  let rootIndex = rootTarget.index;

  const plan: DataModelPlan = { entries: [], added: [], skipped: [] };
  const newPaths = new Set(comparison.entries.filter((entry) => entry.status === "new").map((entry) => entry.path));

  for (const entry of comparison.entries) {
    const parentPath = entry.parentPath;
    // Only the top of each new branch is placed; what is below it comes with it.
    const owner = parentPath.endsWith("[]") ? parentPath.slice(0, -2) : parentPath;
    if (entry.status !== "new" || !entry.incoming || newPaths.has(owner)) {
      continue;
    }
    let target: { parentId: string; slotId: string; index?: number } | undefined;
    let reason: string | undefined;
    if (parentPath === "") {
      target = rootIndex !== undefined ? { ...rootTarget, index: rootIndex } : { ...rootTarget };
    } else if (parentPath.endsWith("[]")) {
      const list = formIndex.get(parentPath.slice(0, -2));
      if (list?.componentId && list.collectionPath !== undefined) {
        target = { parentId: list.componentId, slotId: firstSlotOf(findNode(formRoot, list.componentId)) };
      } else {
        reason = builderText("dataModel.gen.noEntries", { path: parentPath.slice(0, -2) }, options.text);
      }
    } else {
      const parent = formIndex.get(parentPath);
      if (parent?.componentId && parent.kind === "object" && parent.format !== "flags" && !parent.implicit) {
        target = { parentId: parent.componentId, slotId: firstSlotOf(findNode(formRoot, parent.componentId)) };
      } else if (parent?.implicit) {
        reason = builderText("dataModel.gen.noContainer", { path: parentPath }, options.text);
      } else {
        reason = builderText("dataModel.gen.notObject", { path: parentPath }, options.text);
      }
    }
    if (!target) {
      plan.skipped.push({ path: entry.path, reason: reason ?? builderText("dataModel.gen.nowhere", undefined, options.text) });
      continue;
    }
    const built = generator.build(entry.incoming, keysOf(parentPath), parentPath.includes("[]"));
    if (!built) {
      continue;
    }
    plan.entries.push({ node: built.node, parentId: target.parentId, slotId: target.slotId, ...(target.index !== undefined ? { index: target.index } : {}) });
    plan.added.push({ path: built.path, componentId: built.node.id, notes: built.notes });
    if (target.index !== undefined && rootIndex !== undefined) {
      rootIndex += 1;
    }
  }
  plan.skipped.push(...generator.skipped);
  return plan;
}

/**
 * What "Replace form contents" puts in the form's place: a component for every place of the
 * incoming model, in its order. The root's own settings and its closing buttons stay; every
 * other id is free again, so the rebuilt form may reuse the ids it replaces.
 */
export function planReplace(formRoot: ComponentNode, incoming: DataModel, options: GenerateOptions): DataModelReplacement {
  const content = formRoot.children?.content ?? [];
  const keep = trailingButtonIds(content);
  const taken = new Set<string>(options.takenIds ?? []);
  taken.add(formRoot.id);
  for (const [slotId, group] of Object.entries(formRoot.children ?? {})) {
    for (const child of slotId === "content" ? content.filter((node) => keep.includes(node.id)) : group) {
      collectIds(child, taken);
    }
  }
  const generator = new Generator(options, taken);
  const nodes: ComponentNode[] = [];
  const added: DataModelPlan["added"] = [];
  for (const place of incoming.root.children ?? []) {
    const built = generator.build(place, [], false);
    if (built) {
      nodes.push(built.node);
      added.push({ path: built.path, componentId: built.node.id, notes: built.notes });
    }
  }
  return { nodes, keep, added, skipped: generator.skipped };
}
