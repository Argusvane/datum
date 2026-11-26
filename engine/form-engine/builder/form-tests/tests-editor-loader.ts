/**
 * The test editor's loader: its CodeMirror chunk is fetched the first time the Tests panel opens
 * a scenario for editing, once per page, and never as part of the panel's own chunk. The panel mounts the plain textarea (`tests-textarea.ts`) first and swaps the
 * editor in when the chunk lands, keeping the text and the caret's line, or keeps the textarea
 * on failure with a Retry. A failed load is tried again on the next call rather than remembered
 * (the formula editor's and the Logic surface's rule), so Retry works.
 */
export type TestsEditorModule = typeof import("./tests-editor.js");

let memo: Promise<TestsEditorModule> | undefined;

/** The editor's module, loaded once; a rejected load is forgotten so the next call tries again. */
export function loadTestsEditor(): Promise<TestsEditorModule> {
  if (!memo) {
    const next = import("./tests-editor.js");
    next.catch(() => {
      if (memo === next) {
        memo = undefined;
      }
    });
    memo = next;
  }
  return memo;
}
