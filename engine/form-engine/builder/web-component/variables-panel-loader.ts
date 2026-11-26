/**
 * The Variables panel's loader The panel's body is a chunk of
 * its own, fetched the first time the author opens the panel (or a shell connects with the panel
 * remembered open under `persist-panels`: that is the host's own state, so the chunk is fetched
 * at connect then), once per page. A failed load is forgotten so the next call tries again
 * (Retry on the panel's failure card), as the Logic and Data surfaces' loaders do.
 *
 * Nothing here imports the panel's module statically: a value import would put it back in the
 * builder's entry chunk. The tag is repeated here for the same reason.
 */
export type VariablesPanelModule = typeof import("./builder-variables-panel.js");

/** Same as `DATUM_BUILDER_VARIABLES_PANEL_TAG`, which lives in the lazy module. */
export const VARIABLES_PANEL_TAG = "datum-builder-variables-panel";

let memo: Promise<VariablesPanelModule> | undefined;
let loaded: VariablesPanelModule | undefined;

/** The panel's module, fetched once. Does not define the element: the shell does, when it is ready to feed it. */
export function loadVariablesPanel(): Promise<VariablesPanelModule> {
  if (!memo) {
    const next = import("./builder-variables-panel.js");
    next.then(
      (module) => {
        loaded = module;
      },
      () => {
        if (memo === next) {
          memo = undefined;
        }
      }
    );
    memo = next;
  }
  return memo;
}

/** The module once a load has finished, so a shell drawn after it wires the panel at once. */
export function variablesPanelLoaded(): VariablesPanelModule | undefined {
  return loaded;
}
