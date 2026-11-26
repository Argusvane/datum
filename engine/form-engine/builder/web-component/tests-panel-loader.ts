/**
 * The Tests panel's loader. The panel, the runner, the words and the
 * editor's plain-text box are one chunk, fetched the first time the author opens the panel (or
 * the first time a rename has scenarios to follow), once per page. A failed load is forgotten so
 * the next call tries again (Retry on the panel's failure card), as the Variables and Header &
 * footer panels' loaders do.
 *
 * Nothing here imports the panel's module statically: a value import would put the chunk back in
 * the builder's entry. The tag is repeated here for the same reason.
 */
export type TestsPanelModule = typeof import("./builder-tests-panel.js");

/** Same as `DATUM_BUILDER_TESTS_PANEL_TAG`, which lives in the lazy module. */
export const TESTS_PANEL_TAG = "datum-builder-tests-panel";

let memo: Promise<TestsPanelModule> | undefined;
let loaded: TestsPanelModule | undefined;

/** The panel's module, fetched once. Does not define the element: the shell does, when it is ready to feed it. */
export function loadTestsPanel(): Promise<TestsPanelModule> {
  if (!memo) {
    const next = import("./builder-tests-panel.js");
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
export function testsPanelLoaded(): TestsPanelModule | undefined {
  return loaded;
}
