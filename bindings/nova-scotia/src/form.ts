/**
 * The Nova Scotia pattern library's form-level pieces for the engine contract: the error summary
 * and the host's receipt (its alert block, feedback/feedback-*.html), the sentence explaining the
 * required mark, the language links and a journey page's heading and buttons. Datum's own draw the
 * rest (the submitting line, the chrome parts).
 *
 * The library's alert block is a glyph beside a message (`div.alert-block` > `i.fa` +
 * `div.alert-message`), `role="alert"` as its snippets write it. Its snippets word the message as a
 * paragraph; here the heading is a heading element at the level the form's place in the page gives
 * it (`SummaryState.headingLevel`, `FormNoticeState.headingLevel`), drawn as the block's bold line.
 */
import type {
  FormNoticeState,
  LanguageSwitcherState,
  LiveBinding,
  PageState,
  RequiredNoteState,
  SummaryEntry,
  SummaryState
} from "../../../engine/form-engine/render/live/contract.js";
import type { Lit, TemplateResult } from "../../../engine/form-engine/render/live/lit.js";
import { headingAt } from "./shared.js";

/** The glyph the library's feedback snippets use for each kind of receipt. */
const KIND_GLYPH: Readonly<Record<string, string>> = {
  success: "fa fa-check-circle",
  info: "fa fa-info-circle",
  warning: "fa fa-exclamation-triangle",
  error: "fa fa-exclamation-circle"
};

export function createForm(lit: Lit) {
  const { html, nothing } = lit;

  /** The alert block: form-level errors as text first, then one link per field error; its own alert role, the box takes focus when no control can. */
  const summary = (entries: readonly SummaryEntry[], state: SummaryState): TemplateResult => {
    const body = html`<i class="fa fa-exclamation-circle" aria-hidden="true"></i>
      <div class="alert-message">
        ${headingAt(lit, state.headingLevel, { id: state.headingId, className: "datum-ns-alert-title" }, html`<strong>${state.heading}</strong>`)}
        <ul>
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
        </ul>
      </div>`;
    // The second copy of a summary placed at both ends is a visual echo: no role, never focused.
    return state.echo === true
      ? html`<div class="alert-block datum-ns-summary" aria-hidden="true">${body}</div>`
      : html`<div class="alert-block datum-ns-summary" role="alert" tabindex="-1">${body}</div>`;
  };

  /** The host's receipt: the alert block with the glyph of its kind, the kind said once for assistive technology. */
  const notice = (state: FormNoticeState): TemplateResult => {
    const kindWord = state.kindWord !== "" ? html`<span class="sr-only">${state.kindWord} </span>` : nothing;
    const body = html`<i class=${KIND_GLYPH[state.kind] ?? KIND_GLYPH.info!} aria-hidden="true"></i>
      <div class="alert-message">
        ${state.title !== undefined ? headingAt(lit, state.headingLevel, { className: "datum-ns-alert-title" }, html`${kindWord}<strong>${state.title}</strong>`) : nothing}
        ${state.message !== undefined ? html`<p>${state.title !== undefined ? nothing : kindWord}${state.message}</p>` : nothing}
        ${state.details.length > 0
          ? html`<dl class="datum-ns-details">${state.details.map((detail) => html`<div><dt>${detail.label}</dt><dd>${detail.value}</dd></div>`)}</dl>`
          : nothing}
      </div>`;
    return state.echo
      ? html`<div class="alert-block datum-ns-notice-block" aria-hidden="true">${body}</div>`
      : html`<div class="alert-block datum-ns-notice-block" role=${state.assertive ? "alert" : "status"} tabindex="-1">${body}</div>`;
  };

  /** "Fields marked with * are required.": the form's word for the mark is the one set apart, wherever it stands in the sentence. */
  const requiredNote = (state: RequiredNoteState): TemplateResult => {
    const mark = state.words("required");
    const at = mark === "" ? -1 : state.note.indexOf(mark);
    return at < 0
      ? html`<p class="datum-ns-required-note">${state.note}</p>`
      : html`<p class="datum-ns-required-note">${state.note.slice(0, at)}<abbr title=${state.words("requiredTitle")} class="datum-ns-required">${mark}</abbr>${state.note.slice(at + mark.length)}</p>`;
  };

  /** The language links (the library's ribbon header has an EN / FR link): the current language as text, the others as links. */
  const languageSwitcher = (state: LanguageSwitcherState): TemplateResult => html`<nav class="datum-ns-languages" aria-label=${state.label} data-chrome-part="language-switcher">
    <ul>
      ${state.locales.map((entry) =>
        entry.code === state.current
          ? html`<li><span aria-current="true" lang=${entry.code}>${entry.label}</span></li>`
          : html`<li><a
                href="#"
                rel="alternate"
                lang=${entry.code}
                hreflang=${entry.code}
                @click=${(event: Event) => {
                  event.preventDefault();
                  state.switchTo(entry.code);
                }}
              >${entry.label}</a></li>`
      )}
    </ul>
  </nav>`;

  /** A journey page: the progress caption and heading (at the form's own level, `PageState.headingLevel`; it takes focus after a page change), then the buttons. */
  const page: NonNullable<LiveBinding["page"]> = {
    heading: (p: PageState): TemplateResult =>
      html`${p.progress !== undefined && p.progress !== "" ? html`<span class="datum-ns-caption" data-journey-progress>${p.progress}<span class="sr-only">: </span></span>` : nothing}${
        p.title !== "" ? headingAt(lit, p.headingLevel, { id: p.headingId, focusable: true, journey: true }, p.title) : nothing
      }${p.description !== undefined && p.description !== "" ? html`<p>${p.description}</p>` : nothing}${p.redirected === true ? html`<p role="status">${p.words("pageRedirected")}</p>` : nothing}`,
    // Busy is aria-disabled, never disabled: the button keeps the focus it was pressed with. The last page's button is the library's green submit.
    actions: (p: PageState): TemplateResult => html`<div class="datum-ns-actions">
        ${p.next !== undefined
          ? html`<button type="button" class=${p.final ? "btn btn-success" : "btn btn-default"} data-journey-continue aria-disabled=${p.busy ? "true" : "false"} @click=${() => p.next?.()}>${p.nextLabel}</button>`
          : nothing}
        ${p.back !== undefined
          ? html`<button type="button" class="btn btn-clear" data-journey-back aria-disabled=${p.busy ? "true" : "false"} @click=${() => p.back?.()}>${p.backLabel}</button>`
          : nothing}
      </div>
      ${p.checking !== undefined && p.checking !== "" ? html`<p role="status" aria-live="polite" data-journey-checking>${p.checking}</p>` : nothing}`
  };

  return { summary, notice, requiredNote, languageSwitcher, page };
}
