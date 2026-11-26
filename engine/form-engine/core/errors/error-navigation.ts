import type { ComponentNode } from "../schema/types.js";
import type { ComponentTree } from "../tree/component-tree.js";
import { stringifyComponentPath } from "../tree/component-path.js";
import type { FormError } from "./form-error.js";

export interface ErrorNavigationOptions {
  tabTypes?: string[];
  stepTypes?: string[];
}

export interface ErrorNavigationTarget {
  componentId?: string | undefined;
  instancePath?: string | undefined;
  ancestorIds: string[];
  activateTabIds: string[];
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
  // The `steps` container's `step` children.
  const stepTypes = new Set(options.stepTypes ?? ["step"]);

  if (!error.componentId) {
    return {
      componentId: undefined,
      instancePath: error.path ? stringifyComponentPath(error.path) : undefined,
      ancestorIds: [],
      activateTabIds: [],
      activateStepIds: []
    };
  }

  const ancestors = tree.ancestorsOf(error.componentId);

  return {
    componentId: error.componentId,
    instancePath: error.path ? stringifyComponentPath(error.path) : undefined,
    ancestorIds: ancestors.map((a) => a.id),
    // Ancestor activation ordering is nearest-first from ancestorsOf.
    activateTabIds: idsForTypes(ancestors, tabTypes),
    activateStepIds: idsForTypes(ancestors, stepTypes)
  };
}
