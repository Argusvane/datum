/**
 * `ComponentSpec` to nodes: what
 * `add_components` and `replace_form` hand the controller, checked in full before anything is
 * placed. Children stay nested on the node the controller receives (never flattened), so one
 * call is one undo step and the controller's own subtree checks run over the same shape.
 *
 * The pass runs every check it can and refuses with the first failure in the documented order
 * (the type, then the ids, the slots, the inspector's blockers, the formulas, the data paths,
 * the structure limits); what else the same pass saw is appended to the refusal's hint, so one
 * round trip fixes everything. Nothing here writes: `planComponents` returns the entries and
 * the would-be root, and the tool decides whether to write (a dry run stops here).
 *
 * The spec tree is walked with an explicit stack (a deep or hostile input is answered, never a
 * RangeError) and nodes are attached to their parents in that order, never by recursion.
 */
import { kernelStructureLimits } from "../../core/expressions/definition-structure.js";
import type { FormulaPathRef } from "../../core/expressions/formula-types.js";
import { componentIdProblem, isValidComponentId } from "../../core/tree/component-id.js";
import { ComponentTree } from "../../core/tree/component-tree.js";
import { buildDataPaths, dataKeyProblemOf, findDataKeyProblems, type DataKeyProblem } from "../../core/tree/data-scope.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { BuilderTypeInfo, InsertComponentEntry } from "../../builder/controller/builder-controller.js";
import { applyBlockers, type InspectorControl } from "../../builder/property-editor/inspector-model.js";
import { canAcceptInSlot, type ParentConstraints, type ParentConstraintsResolver } from "../../builder/tree-editor/slot-constraints.js";
import { configuredSlotIds } from "../../render/core/tab-slots.js";
import { ToolRefusal } from "../tool-types.js";
import type { BuilderCallScope, BuilderToolsShared } from "./context.js";
import { formulaWarning } from "./formulas.js";
import { committedView } from "./outline.js";
import { structureProblemOf } from "./structure.js";
import { badInput, derivedWarning, isPrototypeName, isRecord, isRuleKey, kindValue, normaliseOptions, prototypeKeyIn, prototypeRefusal, tooLarge, type InputProblem } from "./properties.js";
import { isSeededSubmit } from "./reads.js";
import type { FormulaProblem, MoveTargetRef } from "./types.js";

/** Input caps. */
export const MAX_TOP_LEVEL = 500;
export const MAX_NODES = 2_000;
const ID_CHARS = 128;
const ACCEPTING_CAP = 20;

/** The keys a component spec takes; any other is ignored and named in `warnings`. */
const SPEC_KEYS: ReadonlySet<string> = new Set([
  "type",
  "id",
  "label",
  "description",
  "required",
  "dataKey",
  "placeholder",
  "options",
  "configuration",
  "rules",
  "collection",
  "children",
  "slots",
  "parentId",
  "slotId",
  "index"
]);
const PLACEMENT_KEYS = ["parentId", "slotId", "index"] as const;

/** The order refusals are reported in. */
const CHECK_ORDER = ["unknown-component", "unknown-type", "invalid-id", "duplicate-id", "slot-refused", "blocked-property", "formula-error", "data-path-conflict", "structure-limit"];

/** Where the planned components go. */
export type PlanMode = { kind: "add" } | { kind: "replace"; slotId: string; keep: readonly string[] };

/** One planned row of `added`. */
export interface PlannedRow {
  id: string;
  type: string;
  label: string;
  parentId: string;
  slotId: string;
  index: number;
}

export interface ComponentPlan {
  /** What `requestInsertComponents` takes (add). */
  entries: InsertComponentEntry[];
  /** The top-level nodes in order (replace). */
  nodes: ComponentNode[];
  ids: string[];
  allIds: string[];
  generatedIds: Record<string, string>;
  /** Every node in document order, where it is planned to land. */
  rows: PlannedRow[];
  warnings: string[];
  lints: FormulaProblem[];
  /** The form root as the write would leave it. */
  wouldBeRoot: ComponentNode;
}

/** One spec of the input, flattened in pre-order. */
interface SpecItem {
  spec: Record<string, unknown>;
  /** The input key (`components[0].children[1]`) for bad-input problems. */
  key: string;
  /** The position `generatedIds` names (`0`, `0.children.2`, `1.slots.tab_1.0`). */
  position: string;
  depth: number;
  parent: SpecItem | undefined;
  /** The slot it was given in (`slots` map), else the parent's default. */
  slot: string | undefined;
  top: number;
  node?: ComponentNode;
  failed?: boolean;
}

/** A refusal found by the pass, with its place in the reporting order. */
export interface Failure {
  order: number;
  refusal: ToolRefusal;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Every id in a subtree, pre-order (explicit stack). */
export function subtreeIds(node: ComponentNode): string[] {
  const out: string[] = [];
  const stack = [node];
  while (stack.length > 0) {
    const next = stack.pop() as ComponentNode;
    out.push(next.id);
    const children = Object.values(next.children ?? {}).flat();
    for (let at = children.length - 1; at >= 0; at -= 1) {
      stack.push(children[at] as ComponentNode);
    }
  }
  return out;
}

/** Every node in a subtree, pre-order. */
export function subtreeNodes(node: ComponentNode): ComponentNode[] {
  const out: ComponentNode[] = [];
  const stack = [node];
  while (stack.length > 0) {
    const next = stack.pop() as ComponentNode;
    out.push(next);
    const children = Object.values(next.children ?? {}).flat();
    for (let at = children.length - 1; at >= 0; at -= 1) {
      stack.push(children[at] as ComponentNode);
    }
  }
  return out;
}

/** The node with `id` under `root`, or `undefined`. */
export function findNode(root: ComponentNode, id: string): ComponentNode | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const next = stack.pop() as ComponentNode;
    if (next.id === id) {
      return next;
    }
    for (const group of Object.values(next.children ?? {})) {
      stack.push(...group);
    }
  }
  return undefined;
}

/**
 * The slot constraints of each type, from `typeInfo()`: the declared slots of a
 * container, "takes no children" for a type that declares none and whose template holds none,
 * and nothing (unconstrained) for a type the controller cannot describe. A tree owner's
 * `otherSlots` rule is not visible here; the controller's own check still runs at write time.
 */
export function slotResolver(scope: BuilderCallScope): ParentConstraintsResolver {
  const cached = scope.cache.get("slot-resolver") as ParentConstraintsResolver | undefined;
  if (cached !== undefined) {
    return cached;
  }
  const known = new Map<string, ParentConstraints | undefined>();
  const resolver: ParentConstraintsResolver = (type) => {
    if (known.has(type)) {
      return known.get(type);
    }
    const info = typeInfoOf(scope, type);
    let constraints: ParentConstraints | undefined;
    if (info === undefined) {
      constraints = undefined;
    } else if (info.slots !== undefined) {
      constraints = { children: { slots: structuredClone(info.slots) } };
    } else if (info.template.children !== undefined) {
      constraints = undefined;
    } else {
      constraints = {};
    }
    known.set(type, constraints);
    return constraints;
  };
  scope.cache.set("slot-resolver", resolver);
  return resolver;
}

/** A node's slots as the builder knows them: configured (tabs, grid), declared, then what it holds. */
export function slotIdsOf(scope: BuilderCallScope, node: ComponentNode): string[] {
  const declared = typeInfoOf(scope, node.type)?.slots?.map((slot) => slot.id) ?? [];
  return [...new Set([...(configuredSlotIds(node) ?? []), ...declared, ...Object.keys(node.children ?? {})])];
}

/** Whether a node's slot list is definite (a slot not in it is refused): configured or declared slots. */
function definiteSlots(scope: BuilderCallScope, node: ComponentNode): string[] | undefined {
  const configured = configuredSlotIds(node);
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  const declared = typeInfoOf(scope, node.type)?.slots?.map((slot) => slot.id) ?? [];
  return declared.length > 0 ? declared : undefined;
}

/** The slot children land in when none is named: `content`, else the node's first slot (tabs: its first tab, grid: column_1). */
export function defaultSlotOf(scope: BuilderCallScope, node: ComponentNode, childType?: string): string {
  const slots = slotIdsOf(scope, node);
  if (slots.includes("content") || slots.length === 0) {
    return "content";
  }
  if (childType !== undefined) {
    const declared = typeInfoOf(scope, node.type)?.slots ?? [];
    const accepting = slots.find((id) => {
      const definition = declared.find((slot) => slot.id === id);
      return definition?.allowedTypes === undefined || definition.allowedTypes.length === 0 || definition.allowedTypes.includes(childType);
    });
    if (accepting !== undefined) {
      return accepting;
    }
  }
  return slots[0] as string;
}

/** The slots that would take `child` (`slot-refused.details.accepting`), at most 20. */
export function acceptingSlots(scope: BuilderCallScope, child: ComponentNode, cap = ACCEPTING_CAP): MoveTargetRef[] {
  const resolver = slotResolver(scope);
  const out: MoveTargetRef[] = [];
  const root = scope.controller.snapshot();
  const rootTitle = textOf(isRecord(root.configuration) ? root.configuration.title : undefined);
  const stack = [committedView(scope)];
  while (stack.length > 0 && out.length < cap) {
    const view = stack.shift() as ReturnType<typeof committedView>;
    for (const slot of view.slots) {
      if (out.length >= cap) {
        break;
      }
      if (canAcceptInSlot(view.node, child, slot.slotId, slot.children.length, resolver).ok) {
        out.push({ parentId: view.id, slotId: slot.slotId, label: view.depth === 0 && rootTitle !== undefined && rootTitle !== "" ? rootTitle : view.label, depth: view.depth, siblings: slot.children.length });
      }
    }
    for (const slot of view.slots) {
      stack.push(...slot.children);
    }
  }
  return out;
}

/** `slot-refused` for `child` refused by `parentId`'s slot. */
export function slotRefusal(scope: BuilderCallScope, parentId: string, slotId: string | undefined, child: ComponentNode, reason: string): ToolRefusal {
  const sentence = reason.charAt(0).toLowerCase() + reason.slice(1);
  const details: Record<string, unknown> = { parentId, childType: child.type, reason, accepting: acceptingSlots(scope, child) };
  if (slotId !== undefined) {
    details.slotId = slotId;
  }
  return new ToolRefusal(
    "slot-refused",
    `"${child.id}" cannot go in "${parentId}": ${sentence.replace(/\.$/, "")}.`,
    `Use one of details.accepting, or call list_component_types to see which slots take ${child.type}.`,
    details
  );
}

/** The new data-place problems an edit makes, as the controller judges them: invalid keys aside, problems the form had before aside. */
export function newDataProblems(before: ComponentNode, after: ComponentNode): DataKeyProblem[] {
  const keyOf = (problem: DataKeyProblem): string => `${problem.code}:${problem.path}`;
  const had = new Set(findDataKeyProblems(before).map(keyOf));
  return findDataKeyProblems(after).filter((problem) => problem.code !== "invalid-key" && !had.has(keyOf(problem)));
}

/** `data-path-conflict`. */
export function dataPathRefusal(problems: readonly DataKeyProblem[]): ToolRefusal {
  const first = problems[0];
  return new ToolRefusal(
    "data-path-conflict",
    first !== undefined ? first.message : "Two components would store their answers in one place.",
    "Change dataKey on one of the components named, or move it to another container.",
    { problems: problems.map((problem) => ({ ...problem, componentIds: [...problem.componentIds] })) }
  );
}

/**
 * `structure-limit` for the kernel sentence. With the limit known (the
 * depth the tool counts itself or the engine's gate words, the component count) the hint and
 * `details.limit` name it as the tool documents them; the kernel pass's other sentences carry
 * no number the tool can read, so the hint then says only that a server limit would be passed.
 */
export function structureRefusal(problem: string, known?: { name: string; max: number }): ToolRefusal {
  const depth = /^Components nest more than (\d+) levels deep/.exec(problem);
  const limit = known ?? (depth !== null ? { name: "levels", max: Number(depth[1]) } : undefined);
  if (limit !== undefined) {
    return new ToolRefusal("structure-limit", problem, `Send fewer or shallower components; the limit is ${limit.max} ${limit.name}.`, { problem, limit: { ...limit } });
  }
  return new ToolRefusal("structure-limit", problem, "Send fewer or shallower components; the form would pass a limit the server enforces.", { problem });
}

/** `blocked-property`. */
export function blockedRefusal(componentId: string, propertyPath: string, message: string): ToolRefusal {
  return new ToolRefusal("blocked-property", `${componentId}.${propertyPath}: ${message}`, `The inspector would refuse this value too: ${message} Send a valid value.`, {
    componentId,
    propertyPath,
    message
  });
}

/** What would stop the builder taking the definition with `root`: the element's gate, else the engine's mirror. */
export function structureProblem(shared: BuilderToolsShared, root: ComponentNode): string | undefined {
  const definition = { ...shared.host.definition(), root };
  return shared.host.definitionProblem !== undefined ? shared.host.definitionProblem(definition) : structureProblemOf(definition);
}

/** One type's `typeInfo()` entry, read once per call (composing its inspector model is not free). */
export function typeInfoOf(scope: BuilderCallScope, type: string): BuilderTypeInfo | undefined {
  let cache = scope.cache.get("type-info") as Map<string, BuilderTypeInfo | undefined> | undefined;
  if (cache === undefined) {
    cache = new Map();
    scope.cache.set("type-info", cache);
  }
  if (!cache.has(type)) {
    cache.set(type, scope.controller.typeInfo(type)[0]);
  }
  return cache.get(type);
}

/** Whether a node is a submit button. */
export function isSubmitButton(node: ComponentNode): boolean {
  return node.type === "button" && isRecord(node.configuration) && node.configuration.action === "submit";
}

/** Flattens the spec list (pre-order) and checks its shape: `bad-input` for every problem at once, `too-large` past the caps. */
function flatten(raw: readonly unknown[], mode: PlanMode, warnings: string[]): SpecItem[] {
  if (raw.length > MAX_TOP_LEVEL) {
    throw tooLarge("components", MAX_TOP_LEVEL, raw.length);
  }
  const depthLimit = kernelStructureLimits().depth;
  const items: SpecItem[] = [];
  const problems: InputProblem[] = [];
  const seen = new Set<unknown>();
  const stack: Array<{ value: unknown; key: string; position: string; depth: number; parent: SpecItem | undefined; slot: string | undefined; top: number }> = [];
  for (let at = raw.length - 1; at >= 0; at -= 1) {
    stack.push({ value: raw[at], key: `components[${at}]`, position: String(at), depth: 0, parent: undefined, slot: undefined, top: at });
  }
  let count = 0;
  while (stack.length > 0) {
    const next = stack.pop() as (typeof stack)[number];
    count += 1;
    if (count > MAX_NODES) {
      throw tooLarge("components", MAX_NODES, count);
    }
    if (next.depth >= depthLimit) {
      throw structureRefusal(`Components nest more than ${depthLimit} levels deep: the validator reads at most ${depthLimit}.`, { name: "levels", max: depthLimit });
    }
    const value = next.value;
    if (!isRecord(value)) {
      problems.push({ key: next.key, expected: "a component entry (a JSON object with a type)" });
      continue;
    }
    if (seen.has(value)) {
      problems.push({ key: next.key, expected: "an entry that does not repeat another one" });
      continue;
    }
    seen.add(value);
    const item: SpecItem = { spec: value, key: next.key, position: next.position, depth: next.depth, parent: next.parent, slot: next.slot, top: next.top };
    items.push(item);
    for (const name of Object.keys(value)) {
      if (isPrototypeName(name)) {
        throw prototypeRefusal(`${next.key}.${name}`);
      }
      if (!SPEC_KEYS.has(name)) {
        warnings.push(`ignored unknown argument: ${next.key}.${name}`);
      }
    }
    const want = (name: string, ok: (field: unknown) => boolean, expected: string): void => {
      if (value[name] !== undefined && !ok(value[name])) {
        problems.push({ key: `${next.key}.${name}`, expected });
      }
    };
    if (typeof value.type !== "string" || value.type.trim() === "") {
      problems.push({ key: `${next.key}.type`, expected: "a component type from list_component_types" });
    }
    want("id", (field) => typeof field === "string", "a string");
    for (const name of ["label", "description", "dataKey", "placeholder"]) {
      want(name, (field) => typeof field === "string", "a string");
    }
    want("required", (field) => typeof field === "boolean", "a boolean");
    want("options", Array.isArray, "an array of strings or { value, label } objects");
    want("configuration", isRecord, "a JSON object");
    want("rules", isRecord, "a JSON object of rule key to FEEL text");
    want("collection", isRecord, "a JSON object");
    want("children", Array.isArray, "an array of component entries");
    want("slots", (field) => isRecord(field) && Object.values(field).every(Array.isArray), "a JSON object of slot id to an array of component entries");
    for (const name of PLACEMENT_KEYS) {
      if (value[name] === undefined) {
        continue;
      }
      if (next.depth > 0) {
        problems.push({ key: `${next.key}.${name}`, expected: "nothing: only top-level entries take parentId, slotId and index" });
      } else if (mode.kind === "replace") {
        warnings.push(`ignored unknown argument: ${next.key}.${name}`);
      }
    }
    // Hygiene: no prototype name anywhere a key is read.
    for (const name of ["configuration", "collection"]) {
      const found = prototypeKeyIn(value[name], `${next.key}.${name}`);
      if (found !== undefined) {
        throw prototypeRefusal(found);
      }
    }
    if (typeof value.dataKey === "string" && isPrototypeName(value.dataKey)) {
      throw prototypeRefusal(`${next.key}.dataKey`);
    }
    if (isRecord(value.rules)) {
      for (const [key, rule] of Object.entries(value.rules)) {
        if (isPrototypeName(key)) {
          throw prototypeRefusal(`${next.key}.rules.${key}`);
        }
        if (!isRuleKey(key)) {
          problems.push({ key: `${next.key}.rules.${key}`, expected: "a rule key: visibleWhen, requiredWhen, enabledWhen, readonlyWhen, validWhen, value, defaultValue, minRows, maxRows, filter, navigationGating" });
        } else if (rule !== null && typeof rule !== "string" && !(isRecord(rule) && typeof rule.formula === "string" && (rule.run === undefined || ["both", "browser", "server", "server-secret"].includes(rule.run as string)))) {
          problems.push({ key: `${next.key}.rules.${key}`, expected: 'FEEL text, or { "formula": "...", "run": "both" }' });
        }
      }
    }
    // Children are pushed so they pop in input order: the default slot first, then the slots map.
    const nested: Array<(typeof stack)[number]> = [];
    if (Array.isArray(value.children)) {
      value.children.forEach((child, index) =>
        nested.push({ value: child, key: `${next.key}.children[${index}]`, position: `${next.position}.children.${index}`, depth: next.depth + 1, parent: item, slot: undefined, top: next.top })
      );
    }
    if (isRecord(value.slots)) {
      for (const [slotId, group] of Object.entries(value.slots)) {
        if (isPrototypeName(slotId)) {
          throw prototypeRefusal(`${next.key}.slots.${slotId}`);
        }
        if (!Array.isArray(group)) {
          continue;
        }
        group.forEach((child, index) =>
          nested.push({ value: child, key: `${next.key}.slots.${slotId}[${index}]`, position: `${next.position}.slots.${slotId}.${index}`, depth: next.depth + 1, parent: item, slot: slotId, top: next.top })
        );
      }
    }
    for (let at = nested.length - 1; at >= 0; at -= 1) {
      stack.push(nested[at] as (typeof stack)[number]);
    }
  }
  if (problems.length > 0) {
    throw badInput(problems);
  }
  return items;
}

/** Records the first failure of each code; formula problems are gathered into one refusal by the caller. */
function record(failures: Failure[], refusal: ToolRefusal): void {
  if (failures.some((failure) => failure.refusal.code === refusal.code)) {
    return;
  }
  const order = CHECK_ORDER.indexOf(refusal.code);
  failures.push({ order: order < 0 ? CHECK_ORDER.length : order, refusal });
}

/** The first failure in the reporting order, its hint naming what else the pass saw (at most two sentences). */
export function firstFailure(failures: readonly Failure[]): ToolRefusal | undefined {
  const sorted = [...failures].sort((a, b) => a.order - b.order);
  const first = sorted[0]?.refusal;
  if (first === undefined) {
    return undefined;
  }
  const second = sorted[1]?.refusal;
  if (second === undefined) {
    return first;
  }
  const also = second.message.replace(/[.\s]+$/, "");
  return new ToolRefusal(first.code, first.message, `${first.hint} The same pass also found: ${also}. Fix both before resending.`, first.details);
}

/**
 * Plans `specs` against the committed tree. Throws the
 * first refusal in the documented order, with the rest of what the pass saw in its hint; else
 * returns what to write and the would-be root.
 */
export function planComponents(shared: BuilderToolsShared, scope: BuilderCallScope, raw: readonly unknown[], mode: PlanMode): ComponentPlan {
  const controller = scope.controller;
  const warnings: string[] = [];
  const items = flatten(raw, mode, warnings);
  const failures: Failure[] = [];
  const committed = controller.snapshot();
  const rootId = committed.id;
  const replaceSlot = mode.kind === "replace" ? mode.slotId : undefined;
  const keep = new Set(mode.kind === "replace" ? mode.keep : []);

  // Types, and the parents the top-level entries name.
  const insertable = (type: string): boolean => type !== "form" && controller.hasComponentType(type) && typeInfoOf(scope, type) !== undefined;
  for (const item of items) {
    if (item.depth === 0 && mode.kind === "add" && typeof item.spec.parentId === "string" && findNode(committed, item.spec.parentId) === undefined) {
      record(failures, shared.unknownComponent(scope, item.spec.parentId));
      item.failed = true;
    }
    const type = item.spec.type as string;
    if (!insertable(type)) {
      const known = controller
        .typeInfo()
        .map((info) => info.type)
        .filter((name) => name !== "form")
        .slice(0, 50);
      record(
        failures,
        new ToolRefusal("unknown-type", `"${type}" is not a component type this builder can add.`, "Call list_component_types; the list differs per host.", { type, position: item.position, known })
      );
      item.failed = true;
    }
  }

  // Ids. Taken = what stays in the tree (all of it for an add; for a replace the root,
  // its other slots and what is kept), what something beside the tree claims, the batch's own.
  const taken = new Set<string>();
  if (mode.kind === "add") {
    subtreeIds(committed).forEach((id) => taken.add(id));
  } else {
    taken.add(rootId);
    for (const [slotId, group] of Object.entries(committed.children ?? {})) {
      for (const child of group) {
        if (slotId !== replaceSlot || keep.has(child.id)) {
          subtreeIds(child).forEach((id) => taken.add(id));
        }
      }
    }
  }
  const claimed = new Set(controller.claimedIds());
  const given = new Set<string>();
  for (const item of items) {
    const id = item.spec.id;
    if (typeof id !== "string") {
      continue;
    }
    if (!isValidComponentId(id) || id.length > ID_CHARS) {
      record(
        failures,
        new ToolRefusal("invalid-id", componentIdProblem(id) ?? `"${id}" cannot be a component id: it is longer than 128 characters.`, "Use a letter, then letters, digits, _ or -, at most 128 characters, and not a reserved word; or omit id to have one generated.", { id, position: item.position })
      );
      item.failed = true;
      continue;
    }
    if (claimed.has(id)) {
      record(failures, new ToolRefusal("duplicate-id", `The id "${id}" is owned by a page-only field of a journey.`, "A journey page-only field owns this id; pick another.", { id, position: item.position, claimed: true }));
      item.failed = true;
      continue;
    }
    if (taken.has(id) || given.has(id)) {
      record(failures, new ToolRefusal("duplicate-id", `The id "${id}" is already used.`, "Pick another id or omit it.", { id, position: item.position }));
      item.failed = true;
      continue;
    }
    given.add(id);
  }
  const generatedIds: Record<string, string> = {};
  const used = new Set<string>([...taken, ...claimed, ...given]);
  for (const item of items) {
    if (typeof item.spec.id === "string") {
      continue;
    }
    const type = item.spec.type as string;
    let n = 1;
    while (used.has(`${type}_${n}`)) {
      n += 1;
    }
    const id = `${type}_${n}`;
    used.add(id);
    generatedIds[item.position] = id;
  }

  // The nodes, built over each type's template, children attached in pre-order.
  const resolver = slotResolver(scope);
  for (const item of items) {
    if (item.failed === true || (item.parent !== undefined && item.parent.node === undefined)) {
      item.failed = true;
      continue;
    }
    const spec = item.spec;
    const type = spec.type as string;
    const id = typeof spec.id === "string" ? spec.id : (generatedIds[item.position] as string);
    const info = typeInfoOf(scope, type);
    const template = structuredClone(info?.template ?? { id: type, type, configuration: {} });
    const node: ComponentNode = { ...template, id, type };
    // A template that files its rows under its own id files the new one's under the new id (BC's rule).
    if (node.collection?.collectionPath !== undefined && node.collection.collectionPath === template.id) {
      node.collection = { ...node.collection, collectionPath: id };
    }
    const configuration: Record<string, unknown> = { ...(isRecord(template.configuration) ? template.configuration : {}), ...(isRecord(spec.configuration) ? structuredClone(spec.configuration) : {}) };
    for (const name of ["label", "description", "dataKey", "placeholder"] as const) {
      if (typeof spec[name] === "string") {
        configuration[name] = spec[name];
      }
    }
    if (isRecord(spec.configuration)) {
      // A checkbox or number property in the configuration spread is judged as set_properties judges it: the
      // runtime reads `required: "yes"` as not required, so a value of the wrong shape is refused here.
      const controls = new Map<string, InspectorControl>();
      for (const section of info?.model?.sections ?? []) {
        for (const field of section.fields) {
          controls.set(field.propertyPath, field.control);
        }
      }
      for (const name of Object.keys(spec.configuration)) {
        const control = controls.get(name);
        if (control === "checkbox" || control === "number") {
          const kinded = kindValue(configuration[name], control, { componentId: id, path: name, key: `${item.key}.configuration.${name}` });
          configuration[name] = kinded.value;
          warnings.push(...kinded.warnings);
        }
      }
    }
    if (typeof spec.required === "boolean") {
      configuration.required = spec.required;
    }
    if (configuration.required !== undefined && !controller.typeOffersRequired(type)) {
      delete configuration.required;
      warnings.push(`required-not-offered: ${type} does not offer required; dropped.`);
    }
    const options = spec.options !== undefined ? spec.options : Array.isArray(isRecord(spec.configuration) ? spec.configuration.options : undefined) ? (spec.configuration as Record<string, unknown>).options : undefined;
    if (options !== undefined) {
      const normalised = normaliseOptions(options, spec.options !== undefined ? `${item.key}.options` : `${item.key}.configuration.options`);
      configuration.options = normalised.options;
      if (normalised.derived.length > 0) {
        warnings.push(derivedWarning(id, normalised.derived));
      }
    }
    node.configuration = configuration;
    if (isRecord(spec.rules)) {
      const rules: Record<string, unknown> = {};
      for (const [key, rule] of Object.entries(spec.rules)) {
        if (rule === null || rule === undefined || (typeof rule === "string" && rule.trim() === "")) {
          continue;
        }
        rules[key] = isRecord(rule) ? { formula: rule.formula, ...(rule.run !== undefined ? { run: rule.run } : {}) } : rule;
      }
      if (Object.keys(rules).length > 0) {
        node.rules = rules as NonNullable<ComponentNode["rules"]>;
      } else {
        delete node.rules;
      }
    }
    if (isRecord(spec.collection)) {
      node.collection = structuredClone(spec.collection) as NonNullable<ComponentNode["collection"]>;
    }
    // The slots a configured container shows (tab ids, column_N) are its slots; a template's
    // own empty groups for slots the configuration no longer declares are dropped.
    const configured = configuredSlotIds(node);
    if (configured !== undefined && configured.length > 0) {
      const children: Record<string, ComponentNode[]> = {};
      for (const slotId of configured) {
        children[slotId] = [...(template.children?.[slotId] ?? [])];
      }
      node.children = children;
    }
    item.node = node;
    const parent = item.parent?.node;
    if (parent === undefined) {
      continue;
    }
    // Nested placement: the would-be parent takes the would-be child in that slot: nodes, not names.
    const slotId = item.slot ?? defaultSlotOf(scope, parent, type);
    const definite = definiteSlots(scope, parent);
    if (item.slot !== undefined && definite !== undefined && !definite.includes(item.slot)) {
      record(failures, slotRefusal(scope, parent.id, item.slot, node, `A ${parent.type} component has no slot ${item.slot}`));
      item.failed = true;
      delete item.node;
      continue;
    }
    parent.children ??= {};
    parent.children[slotId] ??= [];
    const group = parent.children[slotId] as ComponentNode[];
    const acceptance = canAcceptInSlot(parent, node, slotId, group.length, resolver);
    if (!acceptance.ok) {
      record(failures, slotRefusal(scope, parent.id, slotId, node, acceptance.reason ?? "Not allowed there"));
      item.failed = true;
      delete item.node;
      continue;
    }
    group.push(node);
  }

  // Top-level placement: where each top-level entry lands, Submit kept last.
  const tops = items.filter((item) => item.depth === 0 && item.node !== undefined);
  const entries: InsertComponentEntry[] = [];
  const planned: Array<{ node: ComponentNode; parentId: string; slotId: string; index: number }> = [];
  const slotCounts = new Map<string, { count: number; submitAt: number | undefined }>();
  let keptSubmit = false;
  if (mode.kind === "add") {
    for (const item of tops) {
      const node = item.node as ComponentNode;
      const spec = item.spec;
      const parentId = typeof spec.parentId === "string" ? spec.parentId : rootId;
      const parent = findNode(committed, parentId);
      if (parent === undefined) {
        continue;
      }
      const given = typeof spec.slotId === "string" ? spec.slotId : undefined;
      const definite = definiteSlots(scope, parent);
      if (given !== undefined && definite !== undefined && !definite.includes(given)) {
        record(failures, slotRefusal(scope, parentId, given, node, `A ${parent.type} component has no slot ${given}`));
        continue;
      }
      const slotId = given ?? defaultSlotOf(scope, parent, node.type);
      const key = `${parentId}/${slotId}`;
      let state = slotCounts.get(key);
      if (state === undefined) {
        const group = parent.children?.[slotId] ?? [];
        const last = group[group.length - 1];
        state = { count: group.length, submitAt: slotId === "content" && isSeededSubmit(last) ? group.length - 1 : undefined };
        slotCounts.set(key, state);
      }
      const acceptance = canAcceptInSlot(parent, node, slotId, state.count, resolver);
      if (!acceptance.ok) {
        record(failures, slotRefusal(scope, parentId, slotId, node, acceptance.reason ?? "Not allowed there"));
        continue;
      }
      let index: number;
      if (typeof spec.index === "number") {
        if (spec.index > state.count) {
          throw badInput([{ key: `${item.key}.index`, expected: `at most ${state.count} (the slot's size)` }]);
        }
        index = spec.index;
        if (state.submitAt !== undefined && index <= state.submitAt) {
          state.submitAt += 1;
        }
      } else if (state.submitAt !== undefined) {
        index = state.submitAt;
        state.submitAt += 1;
        keptSubmit = true;
      } else {
        index = state.count;
      }
      state.count += 1;
      entries.push({ node, parentId, slotId, index });
      planned.push({ node, parentId, slotId, index });
    }
  } else {
    const slotId = replaceSlot as string;
    tops.forEach((item, index) => {
      const node = item.node as ComponentNode;
      const acceptance = canAcceptInSlot(committed, node, slotId, index, resolver);
      if (!acceptance.ok) {
        record(failures, slotRefusal(scope, rootId, slotId, node, acceptance.reason ?? "Not allowed there"));
        return;
      }
      planned.push({ node, parentId: rootId, slotId, index });
    });
  }
  if (keptSubmit) {
    warnings.push("kept-submit-last: placed before the Submit button so it stays last.");
  }

  const builtNodes = planned.flatMap((entry) => subtreeNodes(entry.node));
  // Every node the pass could build, placed or not: its blockers and formulas are judged too,
  // so a refusal names everything one round trip has to fix.
  const checkedNodes = items.flatMap((item) => (item.node !== undefined ? [item.node] : []));

  // Inspector blockers: what the inspector's Apply would refuse.
  for (const node of checkedNodes) {
    const blocker = applyBlockers(node, scope.words.options())[0];
    if (blocker !== undefined) {
      record(failures, blockedRefusal(node.id, blocker.fieldId, blocker.message));
      break;
    }
    const keyProblem = isRecord(node.configuration) ? dataKeyProblemOf(node.configuration.dataKey) : undefined;
    if (keyProblem !== undefined) {
      record(failures, blockedRefusal(node.id, "dataKey", keyProblem));
      break;
    }
  }

  // The would-be tree: the scratch copy the data paths and the structure are judged on.
  let wouldBeRoot = committed;
  const scratch = new ComponentTree(structuredClone(committed));
  try {
    if (mode.kind === "add") {
      for (const entry of planned) {
        scratch.insert(entry.node, entry.parentId, entry.slotId, entry.index);
      }
    } else {
      const live = committed.children ?? {};
      const kept = (live[replaceSlot as string] ?? []).filter((child) => keep.has(child.id));
      scratch.replaceChildren(rootId, { ...live, [replaceSlot as string]: [...planned.map((entry) => entry.node), ...kept] });
    }
    wouldBeRoot = scratch.getRoot();
  } catch {
    // The controller's own attempt reports why; the checks below run over what could be built.
  }

  // Formulas, all failures at once; unknown fields and lints are warnings.
  const lints: FormulaProblem[] = [];
  const formulaProblems: FormulaProblem[] = [];
  const pendingIds = checkedNodes.map((node) => node.id);
  let pendingPaths: string[] = [];
  try {
    const paths = buildDataPaths(wouldBeRoot);
    pendingPaths = pendingIds.map((id) => paths.get(id)).filter((path): path is string => path !== undefined);
  } catch {
    pendingPaths = [];
  }
  for (const node of checkedNodes) {
    for (const [key, source] of Object.entries(node.rules ?? {})) {
      const parsed = shared.formulas.parseRule(scope, { componentId: node.id, key, source });
      if (!parsed.ok) {
        formulaProblems.push(parsed.problem);
        continue;
      }
      if (parsed.blank) {
        continue;
      }
      const unknown = shared.formulas.unknownFields(scope, { componentId: node.id, key, formula: parsed.formula, paths: parsed.paths as readonly FormulaPathRef[] }, { ids: pendingIds, paths: pendingPaths });
      const linted = shared.formulas.lintRule(scope, { componentId: node.id, key, formula: parsed.formula, parsed: parsed.parsed }) ?? [];
      for (const problem of [...unknown, ...linted]) {
        lints.push(problem);
        warnings.push(formulaWarning(problem));
      }
    }
  }
  if (formulaProblems.length > 0) {
    record(failures, shared.formulas.refusal(formulaProblems));
  }

  // Data paths over the would-be tree; problems the form already had are not this write's.
  const dataProblems = wouldBeRoot === committed ? [] : newDataProblems(mode.kind === "replace" ? emptied(committed, replaceSlot as string, keep) : committed, wouldBeRoot);
  if (dataProblems.length > 0) {
    record(failures, dataPathRefusal(dataProblems));
  }

  // The structure limits the server enforces.
  if (wouldBeRoot !== committed) {
    const problem = structureProblem(shared, wouldBeRoot);
    if (problem !== undefined) {
      record(failures, structureRefusal(problem));
    }
  }

  const refusal = firstFailure(failures);
  if (refusal !== undefined) {
    throw refusal;
  }

  // Submit buttons: a second one is reported, never refused.
  const existingSubmit = subtreeNodes(committed).find((node) => isSubmitButton(node) && (mode.kind === "add" || keep.has(node.id) || !isUnderSlot(committed, node.id, replaceSlot as string)));
  const newSubmits = builtNodes.filter(isSubmitButton);
  if (newSubmits.length > 0 && (existingSubmit !== undefined || newSubmits.length > 1)) {
    warnings.push(`second-submit: the form already has a submit button (${existingSubmit?.id ?? newSubmits[0]?.id}).`);
  }

  const rows: PlannedRow[] = [];
  for (const entry of planned) {
    const stack: Array<{ node: ComponentNode; parentId: string; slotId: string; index: number }> = [entry];
    while (stack.length > 0) {
      const next = stack.pop() as (typeof stack)[number];
      const configuration = isRecord(next.node.configuration) ? next.node.configuration : {};
      rows.push({ id: next.node.id, type: next.node.type, label: textOf(configuration.label) ?? next.node.id, parentId: next.parentId, slotId: next.slotId, index: next.index });
      const nested: Array<(typeof stack)[number]> = [];
      for (const [slotId, group] of Object.entries(next.node.children ?? {})) {
        group.forEach((child, index) => nested.push({ node: child, parentId: next.node.id, slotId, index }));
      }
      for (let at = nested.length - 1; at >= 0; at -= 1) {
        stack.push(nested[at] as (typeof stack)[number]);
      }
    }
  }
  return {
    entries,
    nodes: planned.map((entry) => entry.node),
    ids: planned.map((entry) => entry.node.id),
    allIds: builtNodes.map((node) => node.id),
    generatedIds,
    rows,
    warnings,
    lints,
    wouldBeRoot
  };
}

/** The committed root with the replaced slot holding only what is kept: what a replace's data paths are judged against. */
function emptied(root: ComponentNode, slotId: string, keep: ReadonlySet<string>): ComponentNode {
  const copy = structuredClone(root);
  if (copy.children?.[slotId] !== undefined) {
    copy.children[slotId] = copy.children[slotId].filter((child) => keep.has(child.id));
  }
  return copy;
}

/** Whether `id` sits in the root's `slotId` (at any depth). */
function isUnderSlot(root: ComponentNode, id: string, slotId: string): boolean {
  return (root.children?.[slotId] ?? []).some((child) => subtreeIds(child).includes(id));
}
