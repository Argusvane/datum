/**
 * Datum's drawing of a journey page's own chrome: the heading block (the progress count, the
 * page's title, its description) and the actions (Continue or Submit, then Back, and the line
 * that says a server check is out). The journey page module (`journey-page.ts`) draws these for
 * a binding that has no `page` of its own; the Datum binding's `parts` wrap them.
 *
 * The heading, at the form's own level (`PageState.headingLevel`: the page stands for the form),
 * carries `PageState.headingId` and `tabindex="-1"`: focus goes there after a page change.
 * While the page is busy the buttons are `aria-disabled`, never `disabled`, so the button keeps
 * the focus it was pressed with.
 */
import type { LiveBinding, PageState } from "../contract.js";
import { html, nothing, type TemplateResult } from "../lit.js";

/** Datum's heading block and buttons, for a binding that has none. */
/** The page's heading element at its level (`PageState.headingLevel`, the form's own), focusable by script. */
function pageHeading(p: PageState, content: TemplateResult): TemplateResult {
  switch (Math.min(6, Math.max(1, Math.round(Number.isFinite(p.headingLevel) ? p.headingLevel : 1)))) {
    case 1:
      return html`<h1 class="datum-form__journey-heading" id=${p.headingId} tabindex="-1" data-journey-heading>${content}</h1>`;
    case 2:
      return html`<h2 class="datum-form__journey-heading" id=${p.headingId} tabindex="-1" data-journey-heading>${content}</h2>`;
    case 3:
      return html`<h3 class="datum-form__journey-heading" id=${p.headingId} tabindex="-1" data-journey-heading>${content}</h3>`;
    case 4:
      return html`<h4 class="datum-form__journey-heading" id=${p.headingId} tabindex="-1" data-journey-heading>${content}</h4>`;
    case 5:
      return html`<h5 class="datum-form__journey-heading" id=${p.headingId} tabindex="-1" data-journey-heading>${content}</h5>`;
    default:
      return html`<h6 class="datum-form__journey-heading" id=${p.headingId} tabindex="-1" data-journey-heading>${content}</h6>`;
  }
}

export const datumPage: NonNullable<LiveBinding["page"]> = {
  heading: (p: PageState): TemplateResult =>
    html`${p.title !== ""
      ? pageHeading(
          p,
          html`${p.progress
            ? html`<span class="datum-form__journey-progress">${p.progress}<span class="datum-form__visually-hidden">: </span></span>`
            : nothing}${p.title}`
        )
      : nothing}${p.description ? html`<p class="datum-form__journey-description">${p.description}</p>` : nothing}${p.redirected
      ? html`<p role="status" class="datum-form__journey-redirect">${p.words("pageRedirected")}</p>`
      : nothing}`,
  actions: (p: PageState): TemplateResult =>
    html`<div class="datum-form__journey-actions">
      ${p.next
        ? html`<button type="button" class=${p.final ? "datum-form__button datum-form__journey-submit" : "datum-form__button datum-form__journey-continue"} data-journey-continue aria-disabled=${p.busy ? "true" : "false"} @click=${() => p.next?.()}>${p.nextLabel}</button>`
        : nothing}
      ${p.back
        ? html`<button type="button" class="datum-form__journey-back" data-journey-back aria-disabled=${p.busy ? "true" : "false"} @click=${() => p.back?.()}>${p.backLabel}</button>`
        : nothing}
    </div>
    ${p.checking
      ? html`<div role="status" aria-live="polite" class="datum-form__status datum-form__journey-checking"><span class="datum-form__status-text">${p.checking}</span></div>`
      : nothing}`
};
