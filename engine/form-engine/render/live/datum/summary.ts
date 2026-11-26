/**
 * Datum's error summary: an alert box that holds a heading and one link per problem, drawn from
 * the lines the renderer resolved (`summary.ts` in the parent folder): the engine words the
 * heading and each line, the renderer gives each line the `href` of its control and the move of
 * focus to it. This module only draws.
 *
 * - The box is `role="alert"` and takes focus (`tabindex="-1"`) when no control can (the renderer
 *   moves focus here after a check that found errors, `errorFocus: "summary"`).
 * - The heading is a real one, a level under the form's own (the state's `headingLevel`, 2 for a
 *   form headed by an `h1`), and carries the id the state names.
 * - Errors with no field to go to are listed first as text (nothing to focus); each line is a link
 *   to its field, as every design system's summary has it (a screen reader announces "link", and a
 *   click moves focus rather than navigating).
 * - The list is unordered, or numbered where a form's controls ask for it (`list: "ordered"`).
 */
import type { LiveBinding, SummaryEntry, SummaryState } from "../contract.js";
import { html, type TemplateResult } from "../lit.js";
import { headingOf } from "./leaf-kit.js";

export interface DatumSummaryOptions {
  /** The summary heading's level, or a function returning it; left out, the renderer's (`SummaryState.headingLevel`: a level under the form's own heading). */
  headingLevel?: number | (() => number);
  /** `ordered` numbers the problems. */
  list?: "unordered" | "ordered";
}

/** A summary hook drawn with `options`. */
export function createDatumSummary(options: DatumSummaryOptions = {}): NonNullable<LiveBinding["summary"]> {
  return (entries: readonly SummaryEntry[], state: SummaryState): TemplateResult => {
    const level = typeof options.headingLevel === "function" ? options.headingLevel() : (options.headingLevel ?? state.headingLevel);
    const items = html`${state.formEntries.map((entry) => html`<li class="datum-form__summary-form-error">${entry.text}</li>`)}${entries.map(
      (entry) =>
        html`<li><a
            href=${entry.href}
            @click=${(event: Event) => {
              event.preventDefault();
              entry.focus();
            }}
          >${entry.text}</a></li>`
    )}`;
    // The echo at the other end of the form is no alert and no place for focus: the top copy is both.
    if (state.echo === true) {
      return html`<div class="datum-form__summary datum-form__summary--echo">${headingOf(level, "datum-form__summary-heading", state.heading, undefined, state.headingId)}${
        options.list === "ordered" ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`
      }</div>`;
    }
    return html`<div role="alert" class="datum-form__summary" tabindex="-1">${headingOf(level, "datum-form__summary-heading", state.heading, undefined, state.headingId)}${
      options.list === "ordered" ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`
    }</div>`;
  };
}

/** Datum's summary with the defaults. */
export const datumErrorSummary: NonNullable<LiveBinding["summary"]> = createDatumSummary();
