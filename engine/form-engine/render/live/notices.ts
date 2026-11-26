/**
 * Warnings and info on a field, the way the renderer hands them to an adapter
 * and the standard drawing for an adapter whose design system has nothing better.
 *
 * - `FieldState.errors` holds blocking errors only. A warning or info message goes to
 *   `FieldState.notices` and never sets `invalid` (so never `aria-invalid`), never enters the
 *   error summary, and is never drawn with the design system's error styling.
 * - A field with notices carries `noticeId` (`<field id>__notice`), and the engine's
 *   `describedBy` lists it after the description. The adapter puts the id on the element that
 *   holds the notices. An adapter that answers the `notice` capability `none` draws nothing for
 *   them: the renderer leaves the id out of `describedBy` (mount.ts) so no reference dangles, and
 *   records `<component id>: notice` in `unsupported()`.
 * - `drawn` is what the design system offers for a non-blocking message (GOV.UK warning text, a
 *   slim alert); `degraded` is {@link noticesView}: hint-styled text with the severity word from
 *   the form's texts. Neither is announced as an error: no `role="alert"`, no live region.
 */
import { html, nothing } from "./lit.js";
import type { FieldState, View } from "./contract.js";

/** The standard drawing of a field's notices: one block under the control, each message led by its severity word. */
export function noticesView(state: Pick<FieldState, "notices" | "noticeId" | "words">): View {
  if (state.notices.length === 0) {
    return nothing;
  }
  return html`<div id=${state.noticeId ?? nothing} class="datum-live-notices" data-notices>
    ${state.notices.map(
      (notice) => html`<p class="datum-live-notice" data-severity=${notice.severity}><strong>${state.words(notice.severity === "warning" ? "noticeWarning" : "noticeInfo")}</strong>${notice.message}</p>`
    )}
  </div>`;
}
