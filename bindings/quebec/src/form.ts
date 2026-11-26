/**
 * The Québec design system's form-level pieces for the engine contract: the error summary, the
 * host's receipt, the sentence explaining the required mark, the language switcher and a journey
 * page's heading and buttons. Datum's own draw the rest (the submitting line, the chrome parts).
 *
 * The toolkit has no error summary; its documentation writes an error notice (`qc-notice
 * type="error"`) with the links slotted in, and that is the summary. The receipt is the same
 * component by kind. A notice's heading is a slotted heading element, so the level the form asks
 * for (`SummaryState.headingLevel`, `FormNoticeState.headingLevel`) is honoured. The component's
 * script wires its own alert role (`error`) and status role (`success`) and a tabindex on its box,
 * which the renderer finds and focuses after a validation that found errors.
 */
import type { FormNoticeState, LanguageSwitcherState, LiveBinding, PageState, RequiredNoteState, SummaryEntry, SummaryState } from "../../../engine/form-engine/render/live/contract.js";
import type { Lit, TemplateResult } from "../../../engine/form-engine/render/live/lit.js";
import { cls, headingAt } from "./shared.js";

/** qc-notice types by the receipt's kind. */
const NOTICE_TYPES = { success: "success", info: "information", warning: "warning", error: "error" } as const;

export function createForm(lit: Lit) {
  const { html, nothing } = lit;

  /**
   * `qc-notice type="error"` over a list of links. Form-level errors are text first, then one link
   * per field error. The second copy of a summary placed at both ends is a visual echo: inert (the
   * notice's box would otherwise be a tab stop), hidden from assistive technology, never focused.
   */
  const summary = (entries: readonly SummaryEntry[], state: SummaryState): TemplateResult => {
    const body = html`${headingAt(lit, state.headingLevel, { id: state.headingId, className: "datum-qc-notice-heading" }, state.heading)}<ul>
        ${state.formEntries.map((entry) => html`<li>${entry.text}</li>`)}
        ${entries.map(
          (entry) => html`<li><a
              href=${entry.href}
              @click=${(event: Event) => {
                event.preventDefault();
                entry.focus();
              }}
              >${entry.text}</a></li>`
        )}
      </ul>`;
    return state.echo === true
      ? html`<div class="datum-qc-summary datum-qc-summary--echo" inert aria-hidden="true"><qc-notice type="error">${body}</qc-notice></div>`
      : html`<div class="datum-qc-summary"><qc-notice type="error">${body}</qc-notice></div>`;
  };

  /** The host's receipt: `qc-notice` by kind, the kind said once for assistive technology. The echo copy at the other end is inert and hidden from it. */
  const notice = (state: FormNoticeState): TemplateResult => {
    const kindWord = state.kindWord !== "" ? html`<span class="qc-sr-only">${state.kindWord}</span>` : nothing;
    const title = state.title !== undefined ? headingAt(lit, state.headingLevel, { className: "datum-qc-notice-heading" }, html`${kindWord}${state.title}`) : nothing;
    const body = html`${title}${state.message !== undefined ? html`<p>${state.title !== undefined ? nothing : kindWord}${state.message}</p>` : state.title === undefined ? kindWord : nothing}${state.details.length > 0
      ? html`<dl class="datum-qc-receipt-details">${state.details.map((detail) => html`<div><dt>${detail.label}</dt><dd>${detail.value}</dd></div>`)}</dl>`
      : nothing}`;
    const callout = html`<qc-notice type=${NOTICE_TYPES[state.kind]}>${body}</qc-notice>`;
    return state.echo ? html`<div class="datum-qc-receipt" inert aria-hidden="true">${callout}</div>` : html`<div class="datum-qc-receipt" role=${state.assertive ? "alert" : "status"}>${callout}</div>`;
  };

  /** "Required fields are marked with an asterisk (*)." with the mark set apart in the toolkit's red, as the fields carry it. */
  const requiredNote = (state: RequiredNoteState): TemplateResult => {
    const mark = state.words("required");
    const at = mark === "" ? -1 : state.note.indexOf(mark);
    return at < 0
      ? html`<p class="qc-description datum-qc-required-note">${state.note}</p>`
      : html`<p class="qc-description datum-qc-required-note">${state.note.slice(0, at)}<span class="qc-required">${mark}</span>${state.note.slice(at + mark.length)}</p>`;
  };

  /** The languages as links, the current one marked: Québec's header offers a language link, the form a row of them. */
  const languageSwitcher = (state: LanguageSwitcherState): TemplateResult => {
    if (state.locales.every((entry) => entry.code === state.current)) {
      return html`${nothing}`;
    }
    return html`<nav class="datum-qc-language" aria-label=${state.label} data-chrome-part="language-switcher">
      ${state.locales.map((entry) =>
        entry.code === state.current
          ? html`<span lang=${entry.code} aria-current="true">${entry.label}</span>`
          : html`<a href="#" lang=${entry.code} hreflang=${entry.code} @click=${(event: Event) => {
              event.preventDefault();
              state.switchTo(entry.code);
            }}>${entry.label}</a>`
      )}
    </nav>`;
  };

  /** A journey page: the progress caption and heading (the page's own heading, which takes focus after a page change), then the toolkit's buttons. */
  const page: NonNullable<LiveBinding["page"]> = {
    heading: (p: PageState): TemplateResult =>
      html`${p.progress !== undefined && p.progress !== "" ? html`<p class="qc-description datum-qc-progress" data-journey-progress>${p.progress}</p>` : nothing}${p.title !== ""
        ? headingAt(lit, p.headingLevel, { id: p.headingId, className: "datum-qc-page-title", focusable: true, journey: true }, p.title)
        : nothing}${p.description !== undefined && p.description !== "" ? html`<p class="datum-qc-page-description">${p.description}</p>` : nothing}${p.redirected === true ? html`<p role="status">${p.words("pageRedirected")}</p>` : nothing}`,
    // Busy is aria-disabled with the toolkit's disabled look, never `disabled`: the button keeps the focus it was pressed with.
    actions: (p: PageState): TemplateResult => html`<div class="qc-button-group datum-qc-page-actions">
        ${p.back !== undefined
          ? html`<button type="button" class=${cls("qc-button", "qc-secondary", p.busy && "qc-disabled")} data-journey-back aria-disabled=${p.busy ? "true" : "false"} @click=${() => (p.busy ? undefined : p.back?.())}>${p.backLabel}</button>`
          : nothing}
        ${p.next !== undefined
          ? html`<button type="button" class=${cls("qc-button", "qc-primary", p.busy && "qc-disabled")} data-journey-continue aria-disabled=${p.busy ? "true" : "false"} @click=${() => (p.busy ? undefined : p.next?.())}>${p.nextLabel}</button>`
          : nothing}
      </div>
      ${p.checking !== undefined && p.checking !== "" ? html`<p class="qc-description" role="status" aria-live="polite" data-journey-checking>${p.checking}</p>` : nothing}`
  };

  return { summary, notice, requiredNote, languageSwitcher, page };
}
