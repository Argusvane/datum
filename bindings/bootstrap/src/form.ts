/**
 * Bootstrap's form-level pieces for the engine contract: the error summary, the host's receipt, the
 * sentence explaining the required mark, the language switcher and a journey page's heading and
 * buttons. Datum's own draw the rest (the submitting line, the chrome parts).
 *
 * Bootstrap has no error summary: its validation pattern is per-field feedback, so the summary is
 * an `alert alert-danger` (an alert is Bootstrap's component for a message that needs attention)
 * listing the problems as `alert-link`s. The receipt is the same alert by kind. The language
 * switcher is a `btn-group` of buttons, the current language the active one.
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

/** A heading of `level`, clamped to what HTML has. */
function headingAt(lit: Lit, level: number, props: { id?: string | undefined; className: string; focusable?: boolean; journey?: boolean }, content: TemplateResult | string): TemplateResult {
  const { html, ifDefined, nothing } = lit;
  const id = ifDefined(props.id);
  const tabindex = props.focusable === true ? "-1" : nothing;
  const journey = props.journey === true ? "" : nothing;
  switch (Math.min(6, Math.max(1, Math.round(Number.isFinite(level) ? level : 1)))) {
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

/** A language's name in itself, capitalised. */
function nameOf(code: string, fallback: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    return name === undefined || name === code ? fallback : name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return fallback;
  }
}

/** Bootstrap's contextual colour for a receipt's kind. */
const ALERT_TONE = { success: "success", info: "info", warning: "warning", error: "danger" } as const;

export function createForm(lit: Lit) {
  const { html, nothing } = lit;

  /** alert-danger: form-level errors as text first, then one link per field error; its own alert role, the box takes focus when no control can. */
  const summary = (entries: readonly SummaryEntry[], state: SummaryState): TemplateResult => {
    const body = html`${headingAt(lit, state.headingLevel, { id: state.headingId, className: "alert-heading h5" }, state.heading)}
      <ul class="mb-0">
        ${state.formEntries.map((entry) => html`<li>${entry.text}</li>`)}
        ${entries.map(
          (entry) => html`<li><a
              class="alert-link"
              href=${entry.href}
              @click=${(event: Event) => {
                event.preventDefault();
                entry.focus();
              }}
            >${entry.text}</a></li>`
        )}
      </ul>`;
    // The second copy of a summary placed at both ends is a visual echo: no role, never focused.
    return state.echo === true
      ? html`<div class="alert alert-danger datum-bs-summary" aria-hidden="true">${body}</div>`
      : html`<div class="alert alert-danger datum-bs-summary" role="alert" tabindex="-1">${body}</div>`;
  };

  /** The host's receipt: an alert by kind (success, info, warning, danger), the kind said once for assistive technology. */
  const notice = (state: FormNoticeState): TemplateResult => {
    const kindWord = state.kindWord !== "" ? html`<span class="visually-hidden">${state.kindWord} </span>` : nothing;
    const title = state.title !== undefined ? headingAt(lit, state.headingLevel, { className: "alert-heading h5" }, html`${kindWord}${state.title}`) : nothing;
    const body = html`${title}
      ${state.message !== undefined ? html`<p class="mb-0">${state.title !== undefined ? nothing : kindWord}${state.message}</p>` : nothing}
      ${state.details.length > 0
        ? html`<dl class="row mb-0 mt-2">${state.details.map((detail) => html`<dt class="col-sm-3">${detail.label}</dt><dd class="col-sm-9 mb-0">${detail.value}</dd>`)}</dl>`
        : nothing}`;
    const className = `alert alert-${ALERT_TONE[state.kind]} datum-bs-notice`;
    return state.echo
      ? html`<div class=${className} aria-hidden="true">${body}</div>`
      : html`<div class=${className} role=${state.assertive ? "alert" : "status"} tabindex="-1">${body}</div>`;
  };

  /**
   * "Required fields are marked with an asterisk (*)." with the mark set apart as the fields carry
   * it (`text-danger`). The form's word for the mark (the `required` text) is the one set apart,
   * wherever it stands in the sentence.
   */
  const requiredNote = (state: RequiredNoteState): TemplateResult => {
    const mark = state.words("required");
    const at = mark === "" ? -1 : state.note.indexOf(mark);
    return at < 0
      ? html`<p class="form-text">${state.note}</p>`
      : html`<p class="form-text">${state.note.slice(0, at)}<span class="text-danger">${mark}</span>${state.note.slice(at + mark.length)}</p>`;
  };

  /** A `btn-group` of one button per language, the current one the active button. */
  const languageSwitcher = (state: LanguageSwitcherState): TemplateResult => {
    if (state.locales.every((entry) => entry.code === state.current)) {
      return html`${nothing}`;
    }
    return html`<div class="btn-group btn-group-sm mb-3" role="group" aria-label=${state.label} data-chrome-part="language-switcher">
      ${state.locales.map(
        (entry) =>
          html`<button type="button" class=${entry.code === state.current ? "btn btn-outline-secondary active" : "btn btn-outline-secondary"} aria-current=${entry.code === state.current ? "true" : nothing} @click=${() => (entry.code === state.current ? undefined : state.switchTo(entry.code))}><span lang=${entry.code} xml:lang=${entry.code}>${nameOf(entry.code, entry.label)}</span></button>`
      )}
    </div>`;
  };

  /** A journey page: the progress caption and heading (the page's own heading, which takes focus after a page change), then the buttons. */
  const page: NonNullable<LiveBinding["page"]> = {
    heading: (p: PageState): TemplateResult =>
      html`${p.title !== ""
        ? headingAt(
            lit,
            p.headingLevel,
            { id: p.headingId, className: "h3 mb-3", focusable: true, journey: true },
            html`${p.progress !== undefined && p.progress !== "" ? html`<span class="d-block fs-6 fw-normal text-body-secondary" data-journey-progress>${p.progress}<span class="visually-hidden">: </span></span>` : nothing}${p.title}`
          )
        : nothing}${p.description !== undefined && p.description !== "" ? html`<p>${p.description}</p>` : nothing}${p.redirected === true ? html`<p role="status">${p.words("pageRedirected")}</p>` : nothing}`,
    // Busy is aria-disabled with Bootstrap's `disabled` look, never `disabled`: the button keeps the focus it was pressed with.
    actions: (p: PageState): TemplateResult => html`<div class="d-flex gap-2 mt-4 mb-3 datum-bs-page-actions">
        ${p.back !== undefined
          ? html`<button type="button" class=${p.busy ? "btn btn-outline-secondary disabled" : "btn btn-outline-secondary"} data-journey-back aria-disabled=${p.busy ? "true" : "false"} @click=${() => p.back?.()}>${p.backLabel}</button>`
          : nothing}
        ${p.next !== undefined
          ? html`<button type="button" class=${p.busy ? "btn btn-primary disabled" : "btn btn-primary"} data-journey-continue aria-disabled=${p.busy ? "true" : "false"} @click=${() => p.next?.()}>${p.nextLabel}</button>`
          : nothing}
      </div>
      ${p.checking !== undefined && p.checking !== "" ? html`<p class="form-text" role="status" aria-live="polite" data-journey-checking>${p.checking}</p>` : nothing}`
  };

  return { summary, notice, requiredNote, languageSwitcher, page };
}
