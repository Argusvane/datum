import type { ComponentNode, ComponentRules } from "../schema/types.js";
import { assertValidComponentId } from "./component-id.js";
import { assertSafePropertyPath } from "./prototype-names.js";

function cloneChildren(
  children: Record<string, ComponentNode[]>
): Record<string, ComponentNode[]> {
  return Object.fromEntries(
    Object.entries(children).map(([slotId, group]) => [slotId, group.map(cloneNode)])
  );
}

/**
 * A deep copy of a node and its subtree, each node's own keys first and `children` last. An
 * explicit stack rather than recursion, so a tree nested however deep — a presentation's own
 * layout the shape checks accept — never exhausts the call stack.
 */
function cloneNode(node: ComponentNode): ComponentNode {
  const shallow = (source: ComponentNode): ComponentNode => {
    const { children: _children, ...rest } = source;
    return { ...rest };
  };
  const top = shallow(node);
  // A node that is its own ancestor (an object with a cycle: JSON cannot carry one, a host's
  // assignment can) would be copied for ever; the nodes on the way down are known, and one
  // met again there ends the copy with an error that names it.
  const onPath = new WeakSet<ComponentNode>();
  const stack: Array<{ source: ComponentNode; target: ComponentNode; leaving?: true }> = [{ source: node, target: top }];
  while (stack.length > 0) {
    const entry = stack.pop() as { source: ComponentNode; target: ComponentNode; leaving?: true };
    const { source, target } = entry;
    if (entry.leaving) {
      onPath.delete(source);
      continue;
    }
    if (onPath.has(source)) {
      throw new Error(`The definition contains a cycle at component "${String(source.id)}": a component cannot be its own ancestor.`);
    }
    if (!source.children) {
      continue;
    }
    onPath.add(source);
    stack.push({ source, target, leaving: true });
    const slots: Array<[string, ComponentNode[]]> = [];
    for (const [slotId, group] of Object.entries(source.children)) {
      slots.push([
        slotId,
        group.map((child) => {
          const copy = shallow(child);
          stack.push({ source: child, target: copy });
          return copy;
        })
      ]);
    }
    // `fromEntries`: a slot named `__proto__` is a slot like any other.
    target.children = Object.fromEntries(slots);
  }
  return top;
}

/**
 * Throws when a node of the tree is its own ancestor (an object with a cycle: JSON cannot
 * carry one, a host's assignment can), naming it, before any walk that would never end. An
 * explicit stack, so a tree nested however deep is checked without exhausting the call stack.
 */
export function assertAcyclicComponentTree(root: ComponentNode): void {
  const onPath = new WeakSet<ComponentNode>();
  const stack: Array<{ node: ComponentNode; leaving?: true }> = [{ node: root }];
  while (stack.length > 0) {
    const entry = stack.pop() as { node: ComponentNode; leaving?: true };
    if (entry.leaving) {
      onPath.delete(entry.node);
      continue;
    }
    if (onPath.has(entry.node)) {
      throw new Error(`The definition contains a cycle at component "${String(entry.node.id)}": a component cannot be its own ancestor.`);
    }
    if (!entry.node.children) {
      continue;
    }
    onPath.add(entry.node);
    stack.push({ node: entry.node, leaving: true });
    for (const group of Object.values(entry.node.children)) {
      if (!Array.isArray(group)) {
        continue;
      }
      for (const child of group) {
        if (child !== null && typeof child === "object") {
          stack.push({ node: child });
        }
      }
    }
  }
}

/** The ids a node and its subtree hold, in walking order (repeats included). */
function subtreeIds(node: ComponentNode): string[] {
  const ids: string[] = [];
  const stack: ComponentNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as ComponentNode;
    ids.push(current.id);
    for (const group of Object.values(current.children ?? {})) {
      for (const child of group) {
        stack.push(child);
      }
    }
  }
  return ids;
}

/**
 * The ids a component tree holds more than once, each once, in the order first repeated. A
 * definition loaded whole is not checked as {@link ComponentTree.insert} checks a node, so a
 * host that wants to say so reads it here. Explicit stack: depth is no limit.
 */
export function duplicateComponentIds(root: ComponentNode): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  const stack: ComponentNode[] = [root];
  const visiting = new WeakSet<ComponentNode>();
  while (stack.length > 0) {
    const current = stack.pop() as ComponentNode;
    if (visiting.has(current)) {
      continue;
    }
    visiting.add(current);
    if (seen.has(current.id)) {
      if (!repeated.includes(current.id)) {
        repeated.push(current.id);
      }
    } else {
      seen.add(current.id);
    }
    const groups = Object.values(current.children ?? {});
    for (let g = groups.length - 1; g >= 0; g -= 1) {
      const group = groups[g] ?? [];
      for (let i = group.length - 1; i >= 0; i -= 1) {
        stack.push(group[i] as ComponentNode);
      }
    }
  }
  return repeated;
}

interface NodeLocation {
  node: ComponentNode;
  parent?: ComponentNode | undefined;
  slotId?: string | undefined;
  index?: number | undefined;
}

export interface ComponentLocation {
  node: ComponentNode;
  parentId?: string | undefined;
  slotId?: string | undefined;
  index?: number | undefined;
}

/**
 * Whether a value can be walked into by a further path segment. Arrays count: a configuration
 * path like `tabs.0.label` addresses an element of an array, and treating an array as a
 * dead end used to *replace* it with an empty object — silently destroying the list on the
 * first edit to anything inside it.
 */
function isTraversable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function setNestedValue(target: Record<string, unknown>, path: string, value: unknown): void {
  assertSafePropertyPath(path);
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) {
    return;
  }

  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (key === undefined) {
      return;
    }
    const current = cursor[key];
    if (!isTraversable(current)) {
      // A numeric next segment wants an array here, not an object.
      cursor[key] = /^\d+$/.test(parts[i + 1] ?? "") ? [] : {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }

  const lastKey = parts[parts.length - 1];
  if (lastKey === undefined) {
    return;
  }
  cursor[lastKey] = value;
}

function getNestedValue(target: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let cursor: unknown = target;

  for (const part of parts) {
    if (!isTraversable(cursor)) {
      return undefined;
    }
    // Own keys only: `constructor` and `__proto__` are inherited, not part of the configuration.
    // hasOwnProperty, not Object.hasOwn: this module is in the PDF program, which runs on an older QuickJS.
    cursor = Object.prototype.hasOwnProperty.call(cursor as object, part) ? (cursor as Record<string, unknown>)[part] : undefined;
  }

  return cursor;
}

function removeNestedValue(target: Record<string, unknown>, path: string): void {
  assertSafePropertyPath(path);
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) {
    return;
  }

  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (key === undefined) {
      return;
    }
    const next = cursor[key];
    if (!isTraversable(next)) {
      return;
    }
    cursor = next as Record<string, unknown>;
  }

  const lastKey = parts[parts.length - 1];
  if (lastKey === undefined) {
    return;
  }
  delete cursor[lastKey];
}

export class ComponentTree {
  private root: ComponentNode;

  constructor(root: ComponentNode) {
    assertValidComponentId(root.id);
    this.root = cloneNode(root);
  }

  public getRoot(): ComponentNode {
    return cloneNode(this.root);
  }

  /** The root's id, without the deep copy {@link getRoot} makes (read on every change of a large form). */
  public rootId(): string {
    return this.root.id;
  }

  public find(id: string): ComponentNode | undefined {
    return this.findLocation(id)?.node;
  }

  public parentOf(id: string): ComponentNode | undefined {
    return this.findLocation(id)?.parent;
  }

  public locate(id: string): ComponentLocation | undefined {
    const location = this.findLocation(id);
    if (!location) {
      return undefined;
    }

    return {
      node: location.node,
      parentId: location.parent?.id,
      slotId: location.slotId,
      index: location.index
    };
  }

  public childrenOf(id: string, slotId?: string): ComponentNode[] {
    const node = this.find(id);
    if (!node || !node.children) {
      return [];
    }

    if (slotId) {
      return [...(node.children[slotId] ?? [])];
    }

    return Object.values(node.children).flat();
  }

  public descendantsOf(id: string): ComponentNode[] {
    const start = this.find(id);
    if (!start) {
      return [];
    }

    const out: ComponentNode[] = [];
    const walk = (node: ComponentNode): void => {
      if (!node.children) {
        return;
      }
      for (const group of Object.values(node.children)) {
        for (const child of group) {
          out.push(child);
          walk(child);
        }
      }
    };

    walk(start);
    return out;
  }

  public ancestorsOf(id: string): ComponentNode[] {
    const chain: ComponentNode[] = [];
    let current = this.parentOf(id);

    while (current) {
      chain.push(current);
      current = this.parentOf(current.id);
    }

    return chain;
  }

  public insert(component: ComponentNode, parentId: string, slotId: string, index?: number): void {
    assertValidComponentId(component.id);

    // Component identity is global and stable, so duplicate ids are rejected
    // regardless of target slot or parent.
    if (this.find(component.id)) {
      throw new Error(`Duplicate component id: ${component.id}`);
    }
    // A copy first: it refuses a subtree that is its own ancestor before anything walks it.
    const copy = cloneNode(component);
    // ...and so are the ids below it: a subtree that repeats one of its own, or one the tree
    // has, would leave two components answering to an id (`find` takes the first).
    if (copy.children) {
      const held = new Set(subtreeIds(this.root));
      const own = new Set<string>();
      for (const id of subtreeIds(copy)) {
        if (own.has(id) || held.has(id)) {
          throw new Error(`Duplicate component id: ${id}`);
        }
        own.add(id);
      }
    }

    const parent = this.findMutable(parentId);
    // The index is judged against the slot as it stands, before an empty one is made for it: a
    // refused insert leaves no slot behind.
    const held = parent.children?.[slotId]?.length ?? 0;
    const targetIndex = index === undefined ? held : index;

    if (targetIndex < 0 || targetIndex > held) {
      throw new Error(`Invalid insert index ${targetIndex} for slot ${slotId}`);
    }

    parent.children ??= {};
    parent.children[slotId] ??= [];
    parent.children[slotId].splice(targetIndex, 0, copy);
  }

  public remove(id: string): void {
    if (id === this.root.id) {
      throw new Error("Cannot remove root component");
    }

    const location = this.findLocation(id);
    if (!location?.parent || location.slotId === undefined || location.index === undefined) {
      throw new Error(`Component not found: ${id}`);
    }

    const siblings = location.parent.children?.[location.slotId];
    if (!siblings) {
      throw new Error(`Component not found: ${id}`);
    }

    siblings.splice(location.index, 1);
  }

  public move(componentId: string, newParentId: string, slotId: string, index: number): void {
    if (componentId === this.root.id) {
      throw new Error("Cannot move root component");
    }

    const movingLocation = this.findLocation(componentId);
    if (!movingLocation?.parent || movingLocation.slotId === undefined || movingLocation.index === undefined) {
      throw new Error(`Component not found: ${componentId}`);
    }

    const targetParent = this.findMutable(newParentId);
    // Prevent graph corruption by prohibiting self/descendant moves.
    this.assertNoCycle(componentId, newParentId);

    const sourceGroup = movingLocation.parent.children?.[movingLocation.slotId];
    if (!sourceGroup) {
      throw new Error(`Source slot not found for component ${componentId}`);
    }

    const [movingNode] = sourceGroup.splice(movingLocation.index, 1);
    if (!movingNode) {
      throw new Error(`Component not found: ${componentId}`);
    }

    targetParent.children ??= {};
    targetParent.children[slotId] ??= [];
    const targetGroup = targetParent.children[slotId];

    // Bound indexes so callers can compute approximate drop positions safely.
    const boundedIndex = Math.max(0, Math.min(index, targetGroup.length));
    targetGroup.splice(boundedIndex, 0, movingNode);
  }

  public getConfigurationValue(componentId: string, propertyPath: string): unknown {
    const node = this.findMutable(componentId);
    if (!node.configuration || typeof node.configuration !== "object" || Array.isArray(node.configuration)) {
      return undefined;
    }

    return getNestedValue(node.configuration as Record<string, unknown>, propertyPath);
  }

  public getConfiguration(componentId: string): unknown {
    const node = this.findMutable(componentId);
    return structuredClone(node.configuration);
  }

  public replaceConfiguration(componentId: string, nextConfiguration: unknown): void {
    const node = this.findMutable(componentId);
    node.configuration = structuredClone(nextConfiguration);
  }

  /** A node's whole children map (a copy), or `undefined` when it has none. */
  public getChildren(componentId: string): Record<string, ComponentNode[]> | undefined {
    const node = this.findMutable(componentId);
    return node.children ? cloneChildren(node.children) : undefined;
  }

  /**
   * Replaces a node's whole children map — every slot, in the given order. Meant for
   * re-filing the node's own children between its slots (a grid folding a removed column
   * into the one before it); identity is not re-checked, so a caller introducing new nodes
   * must go through {@link insert}.
   */
  public replaceChildren(
    componentId: string,
    children: Record<string, ComponentNode[]> | undefined
  ): void {
    const node = this.findMutable(componentId);
    if (!children) {
      delete node.children;
      return;
    }
    node.children = cloneChildren(children);
  }

  public setConfigurationValue(componentId: string, propertyPath: string, value: unknown): void {
    const node = this.findMutable(componentId);
    if (!node.configuration || typeof node.configuration !== "object" || Array.isArray(node.configuration)) {
      node.configuration = {};
    }

    setNestedValue(node.configuration as Record<string, unknown>, propertyPath, value);
  }

  public removeConfigurationValue(componentId: string, propertyPath: string): void {
    const node = this.findMutable(componentId);
    if (!node.configuration || typeof node.configuration !== "object" || Array.isArray(node.configuration)) {
      return;
    }

    removeNestedValue(node.configuration as Record<string, unknown>, propertyPath);
  }

  /** A component's rule attachments, cloned so callers can edit freely. */
  public getRules(componentId: string): ComponentRules | undefined {
    const node = this.findMutable(componentId);
    return node.rules ? structuredClone(node.rules) : undefined;
  }

  /**
   * Replaces a component's rule attachments wholesale. Passing `undefined` — or a rules object
   * with no entries left — removes the key entirely rather than persisting an empty `{}`, so a
   * component the author cleared reads back identical to one that never had rules.
   */
  public setRules(componentId: string, rules: ComponentRules | undefined): void {
    const node = this.findMutable(componentId);
    if (!rules || Object.keys(rules).length === 0) {
      delete node.rules;
      return;
    }
    node.rules = structuredClone(rules);
  }

  private assertNoCycle(componentId: string, newParentId: string): void {
    if (componentId === newParentId) {
      throw new Error("Cannot move a component into itself");
    }

    const descendants = this.descendantsOf(componentId);
    if (descendants.some((node) => node.id === newParentId)) {
      throw new Error("Cannot move a component into its descendant");
    }
  }

  private findMutable(id: string): ComponentNode {
    const location = this.findLocation(id);
    if (!location) {
      throw new Error(`Component not found: ${id}`);
    }
    return location.node;
  }

  private findLocation(id: string): NodeLocation | undefined {
    const visit = (node: ComponentNode, parent?: ComponentNode, slotId?: string, index?: number): NodeLocation | undefined => {
      if (node.id === id) {
        return { node, parent, slotId, index };
      }

      if (!node.children) {
        return undefined;
      }

      for (const [childSlot, childNodes] of Object.entries(node.children)) {
        for (let i = 0; i < childNodes.length; i += 1) {
          const childNode = childNodes[i];
          if (childNode === undefined) {
            continue;
          }
          const found = visit(childNode, node, childSlot, i);
          if (found) {
            return found;
          }
        }
      }

      return undefined;
    };

    return visit(this.root);
  }
}
