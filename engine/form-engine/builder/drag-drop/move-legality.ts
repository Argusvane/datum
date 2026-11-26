import type { ComponentNode } from "../../core/schema/types.js";
import { canAcceptInSlot, type ParentConstraintsResolver } from "../tree-editor/slot-constraints.js";

/**
 * Where a component may move: the rules a drop of it meets, asked without trying the
 * move. The drop itself (`MoveComponentCommand`, the tree's cycle guard) applies the same ones,
 * so a place this allows is a place a drag lands, and the other way round; the controller adds
 * what it adds to a drop (a fixed node, a data-place clash).
 *
 * - `root`: the form's root (the tree's top) never moves.
 * - `missing`: the component or the parent is not in the tree.
 * - `fixed`: the component's type is fixed (edited, never moved or removed); only asked when the
 *   caller says which components are (`isFixed`), so a drop, a keyboard Move to and the controller
 *   word the same refusal.
 * - `inside-itself`: the parent is the component or something inside it.
 * - `slot`: the parent's slot does not take it (its allowed types, `multiple`, `max`; a leaf
 *   takes nothing). The component counts against the slot only when it arrives from elsewhere.
 */
export interface MoveRefusal {
  code: "root" | "missing" | "fixed" | "inside-itself" | "slot";
  reason: string;
}

/** Why `componentId` may not move into `parentId`'s `slotId` in `root`; `undefined` when it may. */
export function moveRefusal(
  root: ComponentNode,
  componentId: string,
  parentId: string,
  slotId: string,
  resolveParentConstraints?: ParentConstraintsResolver,
  isFixed?: (node: ComponentNode) => boolean
): MoveRefusal | undefined {
  if (componentId === root.id) {
    return { code: "root", reason: "The form itself cannot be moved" };
  }
  const found = locate(root, componentId);
  if (!found) {
    return { code: "missing", reason: `Component not found: ${componentId}` };
  }
  if (isFixed?.(found.node)) {
    return { code: "fixed", reason: `Component "${componentId}" is fixed and cannot be moved` };
  }
  if (find(found.node, parentId)) {
    return { code: "inside-itself", reason: "A component cannot be moved into itself" };
  }
  const parent = find(root, parentId);
  if (!parent) {
    return { code: "missing", reason: `Component not found: ${parentId}` };
  }
  const sameSlot = found.parentId === parentId && found.slotId === slotId;
  const existing = (parent.children?.[slotId]?.length ?? 0) - (sameSlot ? 1 : 0);
  const acceptance = canAcceptInSlot(parent, found.node, slotId, existing, resolveParentConstraints);
  return acceptance.ok ? undefined : { code: "slot", reason: acceptance.reason ?? `Slot ${slotId} does not take it` };
}

/** `id` in `node`'s subtree, `node` itself included. */
function find(node: ComponentNode, id: string): ComponentNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const children of Object.values(node.children ?? {})) {
    for (const child of children ?? []) {
      const hit = find(child, id);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

/** The node `id` with the parent and slot it sits in; `undefined` for the root or an id not in the tree. */
function locate(root: ComponentNode, id: string): { node: ComponentNode; parentId: string; slotId: string } | undefined {
  for (const [slotId, children] of Object.entries(root.children ?? {})) {
    for (const child of children ?? []) {
      if (child.id === id) {
        return { node: child, parentId: root.id, slotId };
      }
      const deeper = locate(child, id);
      if (deeper) {
        return deeper;
      }
    }
  }
  return undefined;
}
