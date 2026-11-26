/**
 * The Alberta Design System's form-level pieces for the engine contract: the error summary, the
 * host's receipt and a journey page's heading and buttons. Datum's own draw the rest (the
 * submitting line, the required note, the language switcher, the chrome parts): Alberta has no
 * pattern for them.
 *
 * Alberta's callout is what the design system itself draws over a form's errors (goa-fieldset, the
 * public-form page: "There is a problem" over a list of links), so the summary is a
 * `goa-callout type="emergency"` and the receipt is the same callout by kind. A callout's heading is
 * a property, not an element: `SummaryState.headingLevel` cannot be honoured, so the callout is
 * named by `aria-label` and is the alert itself.
 */
import type { FormNoticeState, LiveBinding, PageState, SummaryEntry, SummaryState } from "../../../engine/form-engine/render/live/contract.js";
import type { Lit, TemplateResult } from "../../../engine/form-engine/render/live/lit.js";
import { bool, levelOf } from "./shared.js";

/** A heading of `level`, clamped to what HTML has. */
function headingAt(lit: Lit, level: number, props: { id?: string | undefined; className: string; focusable?: boolean; journey?: boolean }, content: TemplateResult | string): TemplateResult {
  const { html, ifDefined, nothing } = lit;
  const id = ifDefined(props.id);
  const tabindex = props.focusable === true ? "-1" : nothing;
  const journey = props.journey === true ? "" : nothing;
  switch (levelOf(level)) {
    case 1:
      return html`<h1 id=${id} class=${props.className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h1>`;
    case 2:
      return html`<h2 id=${id} class=${props.className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h2>`;
    case 3:
      return html`<h3 id=${id} class=${props.className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h3>`;
    case 4:
      return html`<h4 id=${id} class=${props.className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h4>`;
    case 5:
      return html`<h5 id=${id} class=${props.className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h5>`;
    default:
      return html`<h6 id=${id} class=${props.className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h6>`;
  }
}

/** goa-callout types by the receipt's kind. */
const CALLOUT_TYPES = { success: "success", info: "information", warning: "important", error: "emergency" } as const;

export function createForm(lit: Lit) {
  const { html, nothing } = lit;

  /**
   * goa-callout over a list of links. Form-level errors are text first, then one link per field error.
   * The callout is the alert and takes focus when no control can; the second copy of a summary
   * placed at both ends is a visual echo: no role, never focused.
   */
  const summary = (entries: readonly SummaryEntry[], state: SummaryState): TemplateResult => {
    const list = html`<ul class="datum-goa-summary">
      ${state.formEntries.map((entry) => html`<li>${entry.text}</li>`)}
      ${entries.map(
        (entry) => html`<li><a
            href=${entry.href}
            @click=${(event: Event) => {
              event.preventDefault();
              entry.focus();
            }}
            >${entry.authored ? entry.message : entry.text}</a></li>`
      )}
    </ul>`;
    return state.echo === true
      ? html`<goa-callout type="emergency" heading=${state.heading} aria-hidden="true">${list}</goa-callout>`
      : html`<goa-callout type="emergency" heading=${state.heading} arialive="off" role="alert" tabindex="-1" aria-label=${state.heading}>${list}</goa-callout>`;
  };

  /** The host's receipt: goa-callout by kind, the kind said once for assistive technology. The echo copy at the other end is hidden from it. */
  const notice = (state: FormNoticeState): TemplateResult => {
    const kindWord = state.kindWord !== "" ? html`<span class="datum-goa-sr-only">${state.kindWord} </span>` : nothing;
    const body = html`${kindWord}${state.message !== undefined ? html`<p class="datum-goa-receipt__message">${state.message}</p>` : nothing}${state.details.length > 0
      ? html`<dl class="datum-goa-receipt__details">${state.details.map((detail) => html`<div><dt>${detail.label}</dt><dd>${detail.value}</dd></div>`)}</dl>`
      : nothing}`;
    const callout = html`<goa-callout type=${CALLOUT_TYPES[state.kind]} heading=${state.title ?? ""} arialive="off">${body}</goa-callout>`;
    return state.echo
      ? html`<div class="datum-goa-receipt" aria-hidden="true">${callout}</div>`
      : html`<div class="datum-form__notice datum-goa-receipt" role=${state.assertive ? "alert" : "status"} tabindex="-1">${callout}</div>`;
  };

  /** A journey page: the progress caption and heading (the page's own heading, which takes focus after a page change), then goa-buttons in a goa-button-group. */
  const page: NonNullable<LiveBinding["page"]> = {
    heading: (p: PageState): TemplateResult =>
      html`${p.progress ? html`<p class="datum-goa-progress" data-journey-progress>${p.progress}</p>` : nothing}${p.title !== ""
        ? headingAt(lit, p.headingLevel, { id: p.headingId, className: "datum-goa-page-title", focusable: true, journey: true }, p.title)
        : nothing}${p.description ? html`<p class="datum-goa-page-description">${p.description}</p>` : nothing}${p.redirected === true ? html`<p role="status">${p.words("pageRedirected")}</p>` : nothing}`,
    // Busy is aria-disabled, never disabled: goa-button's inner button is its own, so the host carries it and the press is dropped here.
    actions: (p: PageState): TemplateResult => html`<goa-button-group alignment="start" class="datum-goa-page-actions">
        ${p.back ? html`<goa-button type="secondary" data-journey-back aria-disabled=${bool(p.busy)} @click=${() => (p.busy ? undefined : p.back?.())}>${p.backLabel}</goa-button>` : nothing}
        ${p.next ? html`<goa-button type="primary" data-journey-continue aria-disabled=${bool(p.busy)} @click=${() => (p.busy ? undefined : p.next?.())}>${p.nextLabel}</goa-button>` : nothing}
      </goa-button-group>
      ${p.checking !== undefined && p.checking !== "" ? html`<p role="status" aria-live="polite" data-journey-checking>${p.checking}</p>` : nothing}`
  };

  return { summary, notice, page };
}
