import { GRID_COMPONENT_TYPE, gridColumnSlotIds } from "../../core/schema/grid.js";
import { PDF_TABLE_COMPONENT_TYPE, pdfTableSlotIds } from "../../core/schema/pdf-layout.js";
import type { ComponentNode } from "../../core/schema/types.js";

export const TABS_COMPONENT_TYPE = "tabs";

/**
 * A tab's declared id and caption. Authored as `configuration.tabs`; a tab's id is also the
 * child slot its content lives in, which is what makes reordering or renaming a tab a
 * configuration edit rather than a tree surgery.
 */
export interface TabDescriptor {
  id: string;
  /** In the form's default language; translated at `components › <container id> › tabs › <tab id> › label`. */
  label: string | undefined;
}

export function readTabDescriptors(node: ComponentNode): TabDescriptor[] {
  const configuration = node.configuration;
  const raw =
    configuration && typeof configuration === "object" && !Array.isArray(configuration)
      ? (configuration as Record<string, unknown>).tabs
      : undefined;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: TabDescriptor[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    const label = (entry as { label?: unknown }).label;
    out.push({ id, label: typeof label === "string" ? label : undefined });
  }
  return out;
}

/** Slot ids a `tabs` container declares, in authored order. */
export function tabSlotIds(node: ComponentNode): string[] {
  const declared = readTabDescriptors(node).map((tab) => tab.id);
  if (declared.length > 0) {
    return declared;
  }
  // A tabs node authored without a `tabs` list still has whatever slots its children occupy.
  return Object.keys(node.children ?? {});
}

/**
 * Slot ids a container declares through its own configuration rather than its registered
 * definition: a `tabs` container's tabs, a `grid`'s columns. `undefined` for a type whose
 * slots are static, so a caller falls back to the definition's (or the tree's) list.
 *
 * Both surfaces read this — the renderer to give an empty column its cell, the builder's
 * tree view to give it a drop zone — which is what keeps "which slots does this grid have"
 * a single answer.
 */
export function configuredSlotIds(node: ComponentNode): string[] | undefined {
  if (node.type === TABS_COMPONENT_TYPE) {
    return tabSlotIds(node);
  }
  if (node.type === GRID_COMPONENT_TYPE) {
    return gridColumnSlotIds(node.configuration);
  }
  // A PDF layout's visual table: one slot per cell, rows × columns.
  if (node.type === PDF_TABLE_COMPONENT_TYPE) {
    return pdfTableSlotIds(node.configuration);
  }
  return undefined;
}
