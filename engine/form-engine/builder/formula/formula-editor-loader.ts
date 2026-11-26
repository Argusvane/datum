/**
 * The formula editor's loader: its CodeMirror chunk (shared with the JSON viewer's pieces) is
 * fetched the first time a host opens a rule, once per page. Hosts mount the plain textarea
 * first and swap the editor in when the chunk lands, keeping the text and the focus, or keep
 * the textarea on failure with a Retry. A failed load is tried again on the next call rather
 * than remembered (the Logic surface's and journeys designer's rule), so Retry works.
 */
export type FormulaEditorModule = typeof import("./formula-editor.js");

let memo: Promise<FormulaEditorModule> | undefined;
let loaded: FormulaEditorModule | undefined;

/** The editor's module, loaded once; a rejected load is forgotten so the next call tries again. */
export function loadFormulaEditor(): Promise<FormulaEditorModule> {
  if (!memo) {
    const next = import("./formula-editor.js");
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

/**
 * The module once a load has finished, `undefined` before: a synchronous "already on the page"
 * read (the `testsPanelLoaded()` pattern) for a caller that must never fetch the chunk itself,
 * such as the agent's `check_form` linting a formula.
 */
export function formulaEditorLoaded(): FormulaEditorModule | undefined {
  return loaded;
}
