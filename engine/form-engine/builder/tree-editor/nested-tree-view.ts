import type { ComponentNode, SlotDefinition } from "../../core/schema/types.js";
import type { ParentConstraintsResolver } from "./slot-constraints.js";
import { addressOf, resolveText, type TextSources } from "../../core/localization/translations.js";
import { configuredSlotIds } from "../../render/core/tab-slots.js";

export interface NestedTreeSlotView {
  slotId: string;
  /** Slot definition from the registry, when the parent type declares one. */
  definition: SlotDefinition | undefined;
  allowedTypes: string[] | undefined;
  multiple: boolean;
  children: NestedTreeNodeView[];
}

export interface NestedTreeNodeView {
  node: ComponentNode;
  id: string;
  type: string;
  label: string;
  depth: number;
  /** Present when this node's type declares child slots (a container). */
  slots: NestedTreeSlotView[];
}

/**
 * A node's `label` (a string in the form's default language), shown in `locale` when
 * the form's translations or the host's catalog word it there; else its id.
 */
function readLabel(node: ComponentNode, locale: string, sources: TextSources | undefined): string {
  const cfg = node.configuration;
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const label = (cfg as Record<string, unknown>).label;
    if (typeof label === "string" && label.length > 0) {
      return sources ? resolveText(label, addressOf.component(node.id, "label"), locale, sources) : label;
    }
  }
  return node.id;
}

/**
 * What a node is called in the outline and wherever else the tree view names it, when its
 * configuration's `label` is not the name — a journey page's title, a question's form
 * component. `undefined` or blank falls back to the label, then the id.
 */
export type NestedTreeNodeLabeler = (node: ComponentNode, locale: string) => string | undefined;

/**
 * Recursive builder-canvas view model. Every container node exposes its slots (declared by
 * its own configuration — a grid's columns, a tabs container's tabs — from the component
 * registry via `resolveParentConstraints`, or inferred from existing `node.children` keys) so
 * the canvas can render per-slot drop zones with real `parentId` / `slotId` targets instead
 * of a single hardcoded `root.content`.
 */
export function buildNestedTreeView(
  root: ComponentNode,
  resolveParentConstraints?: ParentConstraintsResolver,
  locale = "en",
  nodeLabel?: NestedTreeNodeLabeler,
  sources?: TextSources
): NestedTreeNodeView {
  const labelOf = (node: ComponentNode): string => {
    const named = nodeLabel?.(node, locale);
    return typeof named === "string" && named.trim().length > 0 ? named : readLabel(node, locale, sources);
  };
  const build = (node: ComponentNode, depth: number): NestedTreeNodeView => {
    const declaredSlots = resolveParentConstraints?.(node.type)?.children?.slots ?? [];
    const existingSlotIds = node.children ? Object.keys(node.children) : [];
    // Configuration-declared slots lead so a grid's columns come out left to right; the
    // registry's follow; whatever the tree already holds comes last.
    const slotIds = [
      ...new Set([
        ...(configuredSlotIds(node) ?? []),
        ...declaredSlots.map((slot) => slot.id),
        ...existingSlotIds
      ])
    ];

    const slots: NestedTreeSlotView[] = slotIds.map((slotId) => {
      const definition = declaredSlots.find((slot) => slot.id === slotId);
      const children = (node.children?.[slotId] ?? []).map((child) => build(child, depth + 1));
      return {
        slotId,
        definition,
        allowedTypes: definition?.allowedTypes,
        multiple: definition?.multiple ?? true,
        children
      };
    });

    return {
      node,
      id: node.id,
      type: node.type,
      label: labelOf(node),
      depth,
      slots
    };
  };

  return build(root, 0);
}

/** Flattens a nested view to `{ node, parentId, slotId, index, depth }` rows in document order. */
export interface NestedTreeRow {
  node: ComponentNode;
  parentId: string;
  slotId: string;
  index: number;
  depth: number;
}

export function flattenNestedTreeView(view: NestedTreeNodeView): NestedTreeRow[] {
  const rows: NestedTreeRow[] = [];
  const walk = (parent: NestedTreeNodeView): void => {
    for (const slot of parent.slots) {
      slot.children.forEach((child, index) => {
        rows.push({
          node: child.node,
          parentId: parent.id,
          slotId: slot.slotId,
          index,
          depth: child.depth
        });
        walk(child);
      });
    }
  };
  walk(view);
  return rows;
}
