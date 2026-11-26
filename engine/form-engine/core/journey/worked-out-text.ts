import type { ComponentNode } from "../schema/types.js";

/*
 * A leaf on purpose: the form bundle's renderers import this, and `presentation.ts` pulls the
 * journey path engine with it, which belongs to the journeys chunk alone (check-bundles guards it).
 */

/**
 * The component id whose address words one of a node's configuration texts. Every
 * node words its texts at its own id except a worked-out value's read-only copy, whose texts
 * are the target's own (copied from its configuration, so the Languages workspace lists them
 * under the target and nowhere else): they resolve at the target's address. The one text the
 * journey node authors itself, its `label`, stays at its own id; a copy that took the target's
 * label (`inheritsLabel`) words that at the target's address too.
 */
export function workedOutTextOwner(node: ComponentNode, property: string): string {
  const configuration: unknown = node.configuration;
  const held = configuration !== null && typeof configuration === "object" ? (configuration as Record<string, unknown>).presentation : undefined;
  if (held === null || typeof held !== "object") {
    return node.id;
  }
  const { kind, to, inheritsLabel } = held as Record<string, unknown>;
  if (kind !== "worked-out" || typeof to !== "string") {
    return node.id;
  }
  return property === "label" && inheritsLabel !== true ? node.id : to;
}
