/**
 * The U.S. Web Design System's form-level pieces for the engine contract: the error summary, the
 * host's receipt, the sentence explaining the required mark, the language switcher and a journey
 * page's heading and buttons. Datum's own draw the rest (the submitting line, the chrome parts).
 *
 * USWDS has no error summary: its validation guidance is an error alert, so the summary is a
 * `usa-alert--error` listing the problems as `usa-link`s (usa-alert.twig). The receipt is the same
 * alert by kind. The language selector is USWDS's own button for two languages (usa-language-selector.twig)
 * and a list of unstyled buttons for more, since its menu needs its script.
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

/** A language's name in itself, capitalised as USWDS writes "Español". */
function nameOf(code: string, fallback: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    return name === undefined || name === code ? fallback : name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return fallback;
  }
}

export function createForm(lit: Lit) {
  const { html, nothing } = lit;

  /** usa-alert--error: form-level errors as text first, then one link per field error; its own alert role, the box takes focus when no control can. */
  const summary = (entries: readonly SummaryEntry[], state: SummaryState): TemplateResult => {
    const body = html`<div class="usa-alert__body">
      ${headingAt(lit, state.headingLevel, { id: state.headingId, className: "usa-alert__heading" }, state.heading)}
      <ul class="usa-list">
        ${state.formEntries.map((entry) => html`<li>${entry.text}</li>`)}
        ${entries.map(
          (entry) => html`<li><a
              class="usa-link"
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
      ? html`<div class="usa-alert usa-alert--error datum-usa-summary" aria-hidden="true">${body}</div>`
      : html`<div class="usa-alert usa-alert--error datum-usa-summary" role="alert" tabindex="-1">${body}</div>`;
  };

  /** The host's receipt: usa-alert by kind (success, info, warning, error), the kind said once for assistive technology. */
  const notice = (state: FormNoticeState): TemplateResult => {
    const kindWord = state.kindWord !== "" ? html`<span class="usa-sr-only">${state.kindWord} </span>` : nothing;
    const title = state.title !== undefined ? headingAt(lit, state.headingLevel, { className: "usa-alert__heading" }, state.title) : nothing;
    const body = html`<div class="usa-alert__body">
      ${state.title !== undefined ? html`${kindWord}${title}` : nothing}
      ${state.message !== undefined ? html`<p class="usa-alert__text">${state.title !== undefined ? nothing : kindWord}${state.message}</p>` : nothing}
      ${state.details.length > 0
        ? html`<dl class="datum-usa-notice-details">${state.details.map((detail) => html`<div><dt>${detail.label}</dt><dd>${detail.value}</dd></div>`)}</dl>`
        : nothing}
    </div>`;
    const className = `usa-alert usa-alert--${state.kind} datum-usa-notice`;
    return state.echo
      ? html`<div class=${className} aria-hidden="true">${body}</div>`
      : html`<div class=${className} role=${state.assertive ? "alert" : "status"} tabindex="-1">${body}</div>`;
  };

  /**
   * "Required fields are marked with an asterisk (*)." as USWDS's address form writes it: a plain
   * paragraph with the asterisk as its own abbr[title=required]. The form's word for the mark
   * (the `required` text) is the one set apart, wherever it stands in the sentence.
   */
  const requiredNote = (state: RequiredNoteState): TemplateResult => {
    const mark = state.words("required");
    const at = mark === "" ? -1 : state.note.indexOf(mark);
    return at < 0
      ? html`<p>${state.note}</p>`
      : html`<p>${state.note.slice(0, at)}<abbr title=${state.words("requiredTitle")} class="usa-hint usa-hint--required">${mark}</abbr>${state.note.slice(at + mark.length)}</p>`;
  };

  /**
   * Two languages: usa-language-selector's one button, naming the other language in that language.
   * More: a list of unstyled buttons, one per language, the current one as text (the selector's own
   * menu is a script's).
   */
  const languageSwitcher = (state: LanguageSwitcherState): TemplateResult => {
    const others = state.locales.filter((entry) => entry.code !== state.current);
    if (others.length === 0) {
      return html`${nothing}`;
    }
    if (state.locales.length === 2) {
      const other = others[0]!;
      return html`<div class="usa-language-container" data-chrome-part="language-switcher"><button type="button" class="usa-button" @click=${() => state.switchTo(other.code)}><span lang=${other.code} xml:lang=${other.code}>${nameOf(other.code, other.label)}</span></button></div>`;
    }
    return html`<div class="usa-language-container" role="group" aria-label=${state.label} data-chrome-part="language-switcher">
      <ul class="usa-button-group datum-usa-languages">
        ${state.locales.map((entry) =>
          entry.code === state.current
            ? html`<li class="usa-button-group__item"><span lang=${entry.code} xml:lang=${entry.code} aria-current="true" class="datum-usa-language-current">${nameOf(entry.code, entry.label)}</span></li>`
            : html`<li class="usa-button-group__item"><button type="button" class="usa-button usa-button--unstyled" @click=${() => state.switchTo(entry.code)}><span lang=${entry.code} xml:lang=${entry.code}>${nameOf(entry.code, entry.label)}</span></button></li>`
        )}
      </ul>
    </div>`;
  };

  /** A journey page: the progress caption and heading (the page's own heading, which takes focus after a page change), then the buttons. */
  const page: NonNullable<LiveBinding["page"]> = {
    heading: (p: PageState): TemplateResult =>
      html`${p.title !== ""
        ? headingAt(
            lit,
            p.headingLevel,
            { id: p.headingId, className: "font-heading-lg text-bold margin-top-0 margin-bottom-1", focusable: true, journey: true },
            html`${p.progress !== undefined && p.progress !== "" ? html`<span class="display-block text-normal font-sans-sm text-base-dark" data-journey-progress>${p.progress}<span class="usa-sr-only">: </span></span>` : nothing}${p.title}`
          )
        : nothing}${p.description !== undefined && p.description !== "" ? html`<p class="margin-top-0">${p.description}</p>` : nothing}${p.redirected === true ? html`<p role="status">${p.words("pageRedirected")}</p>` : nothing}`,
    // Busy is aria-disabled, never disabled: the button keeps the focus it was pressed with.
    actions: (p: PageState): TemplateResult => html`<ul class="usa-button-group datum-usa-page-actions">
        ${p.next !== undefined
          ? html`<li class="usa-button-group__item"><button type="button" class="usa-button" data-journey-continue aria-disabled=${p.busy ? "true" : "false"} @click=${() => p.next?.()}>${p.nextLabel}</button></li>`
          : nothing}
        ${p.back !== undefined
          ? html`<li class="usa-button-group__item"><button type="button" class="usa-button usa-button--outline" data-journey-back aria-disabled=${p.busy ? "true" : "false"} @click=${() => p.back?.()}>${p.backLabel}</button></li>`
          : nothing}
      </ul>
      ${p.checking !== undefined && p.checking !== "" ? html`<p role="status" aria-live="polite" data-journey-checking>${p.checking}</p>` : nothing}`
  };

  return { summary, notice, requiredNote, languageSwitcher, page };
}
