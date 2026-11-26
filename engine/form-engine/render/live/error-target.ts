/**
 * The field the first error goes to: the control at the error's value path, so
 * an error in a data grid's second row focuses that row's control, not the first row's (every row
 * of a grid's template shares one component id). An output that carries no path (a target resolved
 * on its own) falls back to the component's one drawn field, never to a row.
 *
 * Pure: the mount's default error focus and the summary feature both read it.
 */
import type { ErrorFocusTarget } from "../core/error-accessibility.js";
import type { DrawnField } from "./mount.js";

/** The drawn field the first error goes to; `undefined` when none is drawn (a grid's own error, a field the page does not draw). */
export function errorFieldOf(fields: readonly DrawnField[], target: ErrorFocusTarget | undefined): DrawnField | undefined {
  if (target === undefined) {
    return undefined;
  }
  if (target.targetPath !== undefined) {
    const byPath = fields.find((candidate) => candidate.state.valuePath === target.targetPath);
    if (byPath !== undefined) {
      return byPath;
    }
    // A grid's own error, or a cell error no row owns: the grid's, never a row's control.
    if (target.targetComponentId !== undefined && target.targetComponentId !== target.componentId) {
      return undefined;
    }
  }
  return fields.find((candidate) => candidate.node.id === (target.targetComponentId ?? target.componentId) && candidate.state.row === undefined);
}
