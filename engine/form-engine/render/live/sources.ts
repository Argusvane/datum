/**
 * The state of a choice field's data source, said where the person is looking. The renderer writes `data-source` (`loading`, `error` or `truncated`) on the
 * field's wrapper and `FieldState.source` for the adapter, and this module adds what the
 * renderer itself says:
 * - a field whose choices have not arrived is `aria-busy` (mount.ts) with a status line under it
 *   (`optionsLoading`);
 * - a failed source gets its reason under the field (`optionsFailed`), and the note describes
 *   the control (its id joins `describedBy`);
 * - a list cut to the cap says how many are shown (`optionsTruncated`).
 *
 * The note is drawn in the field's wrapper, after the adapter's drawing, so every binding shows
 * it the same way. The failure itself is the host's to hear about: once per component and message,
 * a `datum-error` event carries the source's raw reason, its id and the component it feeds. The
 * sentence the person reads is the translated one alone.
 */
import { html } from "./lit.js";
import type { PresentationField } from "../core/presentation-tree.js";
import type { FieldState } from "./contract.js";
import type { LiveFeature } from "./mount.js";

/** The id of the note under a field (a failed source's note describes the control). */
export function sourceNoteIdOf(fieldId: string): string {
  return `${fieldId}__source-note`;
}

export function createSourcesFeature(): LiveFeature {
  const reported = new Set<string>();
  return {
    id: "sources",

    start() {
      return () => reported.clear();
    },

    fieldState(state: FieldState): FieldState | void {
      if (state.source !== "error") {
        return;
      }
      const id = sourceNoteIdOf(state.id);
      return state.describedBy.includes(id) ? undefined : { ...state, describedBy: [...state.describedBy, id] };
    },

    fieldExtra(state, node: PresentationField, draw) {
      if (state.source === undefined) {
        return undefined;
      }
      const id = sourceNoteIdOf(state.id);
      const option = node.model.optionState;
      if (state.source === "loading") {
        return html`<p class="datum-live-source-note" id=${id} role="status" data-source-note>${draw.words("optionsLoading")}</p>`;
      }
      if (state.source === "error") {
        return html`<p class="datum-live-source-note" id=${id} data-source-note data-source-error>${draw.words("optionsFailed")}</p>`;
      }
      const shown = option?.items.length ?? 0;
      const total = option?.truncated?.total ?? shown;
      return html`<p class="datum-live-source-note" id=${id} data-source-note>${draw.words("optionsTruncated", { shown, total })}</p>`;
    },

    afterDraw(report, live) {
      for (const model of report.output.components) {
        const option = model.optionState;
        if (option?.status !== "error" || option.error === undefined) {
          continue;
        }
        const key = `${model.id}\u0000${option.error}`;
        if (reported.has(key)) {
          continue;
        }
        reported.add(key);
        live.emit("datum-error", {
          code: "data-source.failed",
          message: option.error,
          ...(option.sourceId !== undefined ? { sourceId: option.sourceId } : {}),
          componentId: model.id
        });
      }
    }
  };
}
