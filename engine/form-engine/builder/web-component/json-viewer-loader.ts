/**
 * The builder's JSON boxes load their editor (CodeMirror, about 260 KB) on first use, in a
 * chunk of its own, rather than with the builder: the JSON sits behind the inspector's ⋯ and
 * in two panels' JSON views, so most sessions never open one. Until the chunk arrives the
 * panel shows the JSON as the plain `<pre>` it already draws; the editor then takes its place.
 * A host page that wants the box itself keeps importing `mountJsonViewer` (json-viewer.ts).
 */
import type { JsonViewer, JsonViewerOptions } from "./json-viewer.js";

let loading: Promise<typeof import("./json-viewer.js")> | undefined;
/** Whether the page has heard of a failed load since the last success: one datum-error per burst, not one per box. */
let failureReported = false;

/** The editor's module, loaded once. */
export function loadJsonViewer(): Promise<typeof import("./json-viewer.js")> {
  if (!loading) {
    const attempt = import("./json-viewer.js");
    loading = attempt;
    // A failed load is forgotten so the next open retries.
    attempt.then(
      () => {
        failureReported = false;
      },
      () => {
        if (loading === attempt) {
          loading = undefined;
        }
      }
    );
  }
  return loading;
}

/**
 * Puts a JSON editor after `source` once the editor's chunk is loaded, hides `source`, and
 * hands the editor to `mounted`. `source` is a `<pre data-json-view>` for a read-only box, or
 * the `<textarea>` an editable one types into until then (the inspector's JSON) —
 * its live text, and its caret when it has focus, carry over. Nothing happens when `source`
 * has left the page by then: the panel repainted and will mount its own.
 */
export function mountJsonViewerAfter(source: HTMLElement, options: JsonViewerOptions, mounted: (viewer: JsonViewer) => void): void {
  void loadJsonViewer().then(
    ({ mountJsonViewer }) => {
      if (!source.isConnected) {
        return;
      }
      const host = source.ownerDocument.createElement("div");
      host.className = "json-editor";
      source.insertAdjacentElement("afterend", host);
      const box = source.tagName === "TEXTAREA" ? (source as HTMLTextAreaElement) : undefined;
      const focused = box !== undefined && (box.getRootNode() as Document | ShadowRoot).activeElement === box;
      const viewer = mountJsonViewer(host, box ? box.value : (source.textContent ?? ""), options);
      source.hidden = true;
      if (focused) {
        viewer.focus(box.selectionStart);
      }
      mounted(viewer);
    },
    // The chunk did not load (offline, a host that dropped it): the <pre> stays, still the
    // JSON, and a <textarea> stays the box to type in. The host hears it once per burst as a
    // composed, bubbling datum-error from the box itself, whatever panel drew it.
    (cause: unknown) => {
      // A box that has left the page cannot carry the event to the host; the next one will.
      if (failureReported || !source.isConnected) {
        return;
      }
      failureReported = true;
      source.dispatchEvent(
        new CustomEvent("datum-error", {
          bubbles: true,
          composed: true,
          detail: { code: "file.unavailable", message: "The JSON editor didn't load. The plain text view still works.", cause }
        })
      );
    }
  );
}
