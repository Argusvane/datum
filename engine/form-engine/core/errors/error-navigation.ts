import type { ComponentNode } from "../schema/types.js";
import type { ComponentTree } from "../tree/component-tree.js";
import { stringifyComponentPath } from "../tree/component-path.js";
import type { FormError } from "./form-error.js";

export interface ErrorNavigationOptions {
  /** Types whose node is itself a tab, opened by its own id (default `["tab"]`). */
  tabTypes?: string[];
  /** Types that hold their tabs as slots, one slot per declared tab (default `["tabs"]`). */
  tabsTypes?: string[];
  stepTypes?: string[];
}

/** A tab of a slot-based `tabs` container: the container and the slot (the tab's declared id). */
export interface ErrorNavigationTabSlot {
  tabsId: string;
  slotId: string;
}

export interface ErrorNavigationTarget {
  componentId?: string | undefined;
  instancePath?: string | undefined;
  ancestorIds: string[];
  /**
   * The tabs to open for the field to be seen, nearest first: a `tab` ancestor's id, and for a
   * `tabs` container the id of the tab (its slot) the field sits in.
   */
  activateTabIds: string[];
  /** The `tabs` containers' tabs among {@link activateTabIds}, each with its container, nearest first. */
  activateTabSlots: ErrorNavigationTabSlot[];
  activateStepIds: string[];
}

function idsForTypes(ancestors: ComponentNode[], types: Set<string>): string[] {
  return ancestors.filter((node) => types.has(node.type)).map((node) => node.id);
}

export function resolveErrorNavigationTarget(
  error: FormError,
  tree: ComponentTree,
  options: ErrorNavigationOptions = {}
): ErrorNavigationTarget {
  const tabTypes = new Set(options.tabTypes ?? ["tab"]);
  const tabsTypes = new Set(options.tabsTypes ?? ["tabs"]);
  // The `steps` container's `step` children.
  const stepTypes = new Set(options.stepTypes ?? ["step"]);

  if (!error.componentId) {
    return {
      componentId: undefined,
      instancePath: error.path ? stringifyComponentPath(error.path) : undefined,
      ancestorIds: [],
      activateTabIds: [],
      activateTabSlots: [],
      activateStepIds: []
    };
  }

  const ancestors = tree.ancestorsOf(error.componentId);
  // Ancestor activation ordering is nearest-first from ancestorsOf. A `tab` node is opened by
  // its own id; a `tabs` container by the slot the path to the field runs through.
  const activateTabIds: string[] = [];
  const activateTabSlots: ErrorNavigationTabSlot[] = [];
  let childId = error.componentId;
  for (const ancestor of ancestors) {
    if (tabTypes.has(ancestor.type)) {
      activateTabIds.push(ancestor.id);
    } else if (tabsTypes.has(ancestor.type)) {
      const slotId = tree.locate(childId)?.slotId;
      if (slotId !== undefined) {
        activateTabIds.push(slotId);
        activateTabSlots.push({ tabsId: ancestor.id, slotId });
      }
    }
    childId = ancestor.id;
  }

  return {
    componentId: error.componentId,
    instancePath: error.path ? stringifyComponentPath(error.path) : undefined,
    ancestorIds: ancestors.map((a) => a.id),
    activateTabIds,
    activateTabSlots,
    activateStepIds: idsForTypes(ancestors, stepTypes)
  };
}
