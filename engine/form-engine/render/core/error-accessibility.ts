import type { FormError } from "../../core/errors/form-error.js";
import type { ComponentTree } from "../../core/tree/component-tree.js";
import { resolveErrorNavigationTarget } from "../../core/errors/error-navigation.js";

export interface ErrorAnnouncement {
  text: string;
  targetComponentId?: string | undefined;
  targetInstancePath?: string | undefined;
}

export interface ErrorFocusTarget {
  componentId: string;
  /**
   * The value path of the control the first error goes to (the summary entry's `targetPath`):
   * the row's control for an error at a data grid's entry (`items[1].sku`), the grid for a cell
   * error no row owns, else the component's own path. Set by the render orchestrator once the
   * summary is worded; absent from a target resolved on its own.
   */
  targetPath?: string | undefined;
  /** The component that entry goes to: the grid for a cell error no row owns, else `componentId`. */
  targetComponentId?: string | undefined;
  activateTabIds: string[];
  activateStepIds: string[];
}

export function buildErrorAnnouncement(error: FormError): ErrorAnnouncement {
  const targetInstancePath = error.path ? error.path.segments.map((segment) =>
    segment.index === undefined ? segment.key : `${segment.key}[${segment.index}]`
  ).join(".") : undefined;

  const text = [
    error.code,
    targetInstancePath,
    error.componentId
  ].filter(Boolean).join(" | ");

  return {
    text,
    targetComponentId: error.componentId,
    targetInstancePath
  };
}

export function resolveFirstErrorFocusTarget(
  errors: FormError[],
  tree: ComponentTree
): ErrorFocusTarget | undefined {
  const first = errors.find((error) => (error.severity ?? "error") === "error" && error.componentId);
  if (!first || !first.componentId) {
    return undefined;
  }

  const target = resolveErrorNavigationTarget(first, tree);

  return {
    componentId: first.componentId,
    activateTabIds: target.activateTabIds,
    activateStepIds: target.activateStepIds
  };
}
