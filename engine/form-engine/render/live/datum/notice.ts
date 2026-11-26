/**
 * Datum's drawing of the three lines the form shows around its fields that belong to the host and
 * the form's state, not to a field: the host's receipt after a delivered submission, the line that
 * says a submission is in flight, and the sentence explaining the required marker.
 *
 * Each takes a state the renderer resolved (`form-notices.ts`: the texts in the form's language,
 * the kind said once for assistive technology, whether this copy is the echo) and draws it with
 * the form's classes. They are the defaults a binding replaces through `notice`, `status` and
 * `requiredNote`.
 *
 * - The receipt is a status region (an alert for an error on the draw that first shows it) that
 *   takes focus (`tabindex="-1"`), so the host can move the person to it. The echo copy, drawn
 *   at the other end of the form, is hidden from assistive technology so the receipt is read once.
 *   The kind is said once in a visually hidden word at the head of the title (the message when
 *   there is no title): colour and edge are only the sighted cue (WCAG 1.4.1).
 * - The status line is a polite live region with a spinner beside it; its echo is aria-hidden.
 */
import type { FormNoticeState, FormStatusState, RequiredNoteState } from "../contract.js";
import { html, nothing, type TemplateResult } from "../lit.js";
import { classes, headingOf } from "./leaf-kit.js";

/** The host's receipt. */
export function datumNotice(state: FormNoticeState): TemplateResult {
  const className = classes("datum-form__notice", `datum-form__notice--${state.kind}`, state.echo && "datum-form__notice--echo");
  const kindWord = state.kindWord !== "" ? html`<span class="datum-form__visually-hidden">${state.kindWord} </span>` : nothing;
  const title =
    state.title !== undefined
      ? headingOf(state.headingLevel, "datum-form__notice-title", html`${kindWord}${state.title}`)
      : nothing;
  const message =
    state.message !== undefined ? html`<p class="datum-form__notice-text">${state.title !== undefined ? nothing : kindWord}${state.message}</p>` : nothing;
  const details =
    state.details.length > 0
      ? html`<dl class="datum-form__notice-details">${state.details.map(
          (detail) => html`<div class="datum-form__notice-detail"><dt>${detail.label}</dt><dd>${detail.value}</dd></div>`
        )}</dl>`
      : nothing;
  if (state.echo) {
    return html`<div class=${className} aria-hidden="true">${title}${message}${details}</div>`;
  }
  return html`<div class=${className} role=${state.assertive ? "alert" : "status"} tabindex="-1">${title}${message}${details}</div>`;
}

/** The line that says a submission is in flight. */
export function datumStatus(state: FormStatusState): TemplateResult {
  const spinner = html`<span class="datum-form__status-spinner" aria-hidden="true"></span><span class="datum-form__status-text">${state.message}</span>`;
  return state.echo
    ? html`<div class="datum-form__status datum-form__status--echo" aria-hidden="true">${spinner}</div>`
    : html`<div role="status" aria-live="polite" class="datum-form__status">${spinner}</div>`;
}

/** The sentence above the fields that explains the required marker. */
export function datumRequiredNote(state: RequiredNoteState): TemplateResult {
  return html`<p class="datum-form__required-note">${state.note}</p>`;
}
