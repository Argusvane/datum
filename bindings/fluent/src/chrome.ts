/**
 * The Fluent UI form-level pieces: the error summary, the host's receipt (notice), a journey page's
 * heading and buttons, the language switcher and the required note. Datum draws the rest (the
 * submitting line, the chrome parts), tinted with FLUENT_FALLBACK_TOKENS. The button field adapter
 * belongs to fields.ts.
 *
 * Fluent UI has no error summary and no language switcher component. The summary is `fluent-message-bar`
 * (intent error), Fluent's component for a message that needs attention, holding a heading and one
 * link per problem; the receipt is the same bar by kind (success, info, warning, error); the
 * language switcher is Fluent's own `fluent-dropdown` in a `fluent-field`. The bar's own role (status) is replaced
 * by the one the renderer needs: an alert on the summary, none on the receipt (its region carries
 * the status).
 */
import type { FormNoticeState, LanguageSwitcherState, LiveBinding, PageState, RequiredNoteState, SummaryEntry, SummaryState } from "../../../engine/form-engine/render/live/contract.js";
import type { TemplateResult } from "../../../engine/form-engine/render/live/lit.js";
import { createHeading } from "./heading.js";
import { VISUALLY_HIDDEN, type Lit } from "./shared.js";

/** The binding members chrome.ts may fill; each left out is Datum's. */
export type FluentChrome = Partial<Pick<LiveBinding, "summary" | "notice" | "status" | "requiredNote" | "page" | "languageSwitcher" | "chrome">>;

type Kind = FormNoticeState["kind"];

/** The bar's intent for a receipt's kind. */
const INTENT: Readonly<Record<Kind, "success" | "info" | "warning" | "error">> = { success: "success", info: "info", warning: "warning", error: "error" };

/**
 * The 20px icons of Fluent's own message-bar documentation (message-bar.stories.ts): CheckmarkCircle
 * filled, Info regular, Warning filled, DismissCircle filled. `currentColor`; the colour is the
 * wrapper's (css.ts), from Fluent's status tokens.
 */
const ICON_PATHS: Readonly<Record<Kind, string>> = {
  success:
    "M10 2a8 8 0 1 1 0 16a8 8 0 0 1 0-16m3.358 5.646a.5.5 0 0 0-.637-.057l-.07.057L9 11.298L7.354 9.651l-.07-.058a.5.5 0 0 0-.695.696l.057.07l2 2l.07.057a.5.5 0 0 0 .568 0l.07-.058l4.004-4.004l.058-.07a.5.5 0 0 0-.058-.638",
  info: "M10.492 8.91A.5.5 0 0 0 9.5 9v4.502l.008.09a.5.5 0 0 0 .992-.09V9zm.307-2.16a.75.75 0 1 0-1.5 0a.75.75 0 0 0 1.5 0M18 10a8 8 0 1 0-16 0a8 8 0 0 0 16 0M3 10a7 7 0 1 1 14 0a7 7 0 0 1-14 0",
  warning:
    "M8.681 2.785c.568-1.047 2.071-1.047 2.638 0l6.5 12.002A1.5 1.5 0 0 1 16.502 17H3.498a1.5 1.5 0 0 1-1.319-2.215zM10.5 7.5a.5.5 0 0 0-1 0v4a.5.5 0 0 0 1 0zm.25 6.25a.75.75 0 1 0-1.5 0a.75.75 0 0 0 1.5 0",
  error:
    "M10 2a8 8 0 1 1 0 16a8 8 0 0 1 0-16M7.81 7.114a.5.5 0 0 0-.638.058l-.058.069a.5.5 0 0 0 .058.638L9.292 10l-2.12 2.121l-.058.07a.5.5 0 0 0 .058.637l.069.058a.5.5 0 0 0 .638-.058L10 10.708l2.121 2.12l.07.058a.5.5 0 0 0 .637-.058l.058-.069a.5.5 0 0 0-.058-.638L10.708 10l2.12-2.121l.058-.07a.5.5 0 0 0-.058-.637l-.069-.058a.5.5 0 0 0-.638.058L10 9.292l-2.121-2.12z"
};

export function createChrome(lit: Lit): FluentChrome {
  const { html, nothing } = lit;
  const heading = createHeading(lit);

  /** The message bar's icon, in the status colour of its kind. */
  const icon = (kind: Kind): TemplateResult =>
    html`<span slot="icon" class="datum-fluent-bar-icon" data-intent=${kind}
      ><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d=${ICON_PATHS[kind]}></path></svg></span
    >`;

  // ── The error summary ────────────────────────────────────────────────────────────────────

  /**
   * A `fluent-message-bar` (intent error, multiline) holding the heading at the level the state
   * gives (the binding's own `fluent-text` heading), a native list of the errors with no field as
   * text, then one `fluent-link` per entry. A link is Fluent's own, which draws a proxy anchor in its
   * light DOM (`a[href]`) and navigates through it. The click is the renderer's: the default (a jump
   * to the hash) is stopped and the field takes focus. `stopImmediatePropagation` keeps Fluent's own
   * handler, registered after this one, from opening a new window on a modifier click (it ignores
   * `defaultPrevented`). The bar is the alert and takes focus when no control can; the echo copy at
   * the other end of the form is no alert (the bar's own status role is set aside) and no place for
   * focus, like Datum's own echo; its links stay in the tab order and in the accessibility tree, as
   * they do there.
   */
  const summary = (entries: readonly SummaryEntry[], state: SummaryState): TemplateResult => {
    const body = html`<div>
      ${heading(state.headingLevel, { id: state.headingId }, state.heading)}
      <ul>
        ${state.formEntries.map((entry) => html`<li>${entry.text}</li>`)}
        ${entries.map(
          (entry) => html`<li><fluent-link
              inline
              href=${entry.href}
              @click=${(event: Event) => {
                event.preventDefault();
                event.stopImmediatePropagation();
                entry.focus();
              }}
            >${entry.text}</fluent-link></li>`
        )}
      </ul>
    </div>`;
    return state.echo === true
      ? html`<fluent-message-bar intent="error" layout="multiline" role="presentation" class="datum-fluent-summary datum-fluent-summary--echo">${icon("error")}${body}</fluent-message-bar>`
      : html`<fluent-message-bar intent="error" layout="multiline" role="alert" tabindex="-1" class="datum-fluent-summary">${icon("error")}${body}</fluent-message-bar>`;
  };

  // ── The receipt ──────────────────────────────────────────────────────────────────────────

  /**
   * The host's receipt: a `fluent-message-bar` of the receipt's kind inside the region the renderer's
   * `focusNotice` finds (`datum-form__notice`, its role and `tabindex`; the bar itself takes the
   * `presentation` role so a status region is not nested in one). The kind is said once for assistive
   * technology, in a visually hidden word at the head of the title (the message when there is none).
   */
  const notice = (state: FormNoticeState): TemplateResult => {
    const word = state.kindWord !== "" ? html`<span class=${VISUALLY_HIDDEN}>${state.kindWord} </span>` : nothing;
    const title = state.title !== undefined ? heading(state.headingLevel, {}, html`${word}${state.title}`) : nothing;
    const message = state.message !== undefined ? html`<fluent-text block>${state.title !== undefined ? nothing : word}${state.message}</fluent-text>` : nothing;
    const details =
      state.details.length > 0
        ? html`<dl class="datum-fluent-receipt-details">${state.details.map((detail) => html`<div><dt>${detail.label}</dt><dd>${detail.value}</dd></div>`)}</dl>`
        : nothing;
    const bar = html`<fluent-message-bar intent=${INTENT[state.kind]} layout="multiline" role="presentation">${icon(state.kind)}<div>${title}${message}${details}</div></fluent-message-bar>`;
    return state.echo
      ? html`<div class="datum-form__notice datum-fluent-receipt" aria-hidden="true">${bar}</div>`
      : html`<div class="datum-form__notice datum-fluent-receipt" role=${state.assertive ? "alert" : "status"} tabindex="-1">${bar}</div>`;
  };

  // ── The required note ────────────────────────────────────────────────────────────────────

  /** The sentence, the form's word for the mark set apart in the colour the fields draw it in. */
  const requiredNote = (state: RequiredNoteState): TemplateResult => {
    const mark = state.words("required");
    const at = mark === "" ? -1 : state.note.indexOf(mark);
    return at < 0
      ? html`<fluent-text size="200" block class="datum-fluent-required-note">${state.note}</fluent-text>`
      : html`<fluent-text size="200" block class="datum-fluent-required-note">${state.note.slice(0, at)}<span class="datum-fluent-required-mark">${mark}</span>${state.note.slice(at + mark.length)}</fluent-text>`;
  };

  // ── The journey page ─────────────────────────────────────────────────────────────────────

  /** The page's heading (focusable, so the renderer can move focus to it after a page change) with its progress line, and the description. */
  const page: NonNullable<LiveBinding["page"]> = {
    heading: (p: PageState): TemplateResult =>
      html`${p.title !== ""
        ? heading(
            p.headingLevel,
            { id: p.headingId, size: "600", focusable: true, journey: true },
            html`${p.progress !== undefined && p.progress !== "" ? html`<span class="datum-fluent-progress" data-journey-progress>${p.progress}<span class=${VISUALLY_HIDDEN}>: </span></span>` : nothing}${p.title}`
          )
        : nothing}${p.description !== undefined && p.description !== "" ? html`<fluent-text block class="datum-fluent-page-description">${p.description}</fluent-text>` : nothing}${p.redirected === true
        ? html`<fluent-text block role="status">${p.words("pageRedirected")}</fluent-text>`
        : nothing}`,
    // `role="button"` on the host too: the element's own role lives in ElementInternals, which a selector cannot see. A busy page draws the button disabled-focusable (Fluent's aria-disabled that keeps focus), never disabled; the press is dropped here too.
    actions: (p: PageState): TemplateResult => html`<div class="datum-fluent-page-actions">
        ${p.back !== undefined
          ? html`<fluent-button type="button" role="button" appearance="outline" ?disabled-focusable=${p.busy} data-journey-back @click=${() => (p.busy ? undefined : p.back?.())}>${p.backLabel}</fluent-button>`
          : nothing}
        ${p.next !== undefined
          ? html`<fluent-button type="button" role="button" appearance="primary" ?disabled-focusable=${p.busy} data-journey-continue @click=${() => (p.busy ? undefined : p.next?.())}>${p.nextLabel}</fluent-button>`
          : nothing}
      </div>
      ${p.checking !== undefined && p.checking !== "" ? html`<fluent-text size="200" block role="status" aria-live="polite" data-journey-checking>${p.checking}</fluent-text>` : nothing}`
  };

  // ── The language switcher ────────────────────────────────────────────────────────────────

  /**
   * A `fluent-field` (label before the control) holding Fluent's own `fluent-dropdown type="select"`
   * with one `fluent-option` per language, the current one selected, in the part's `div` the renderer
   * finds by `data-chrome-part`. The label is the state's (hidden visually when it asks); the field
   * names the dropdown's control by it. The dropdown's `change` (an option's bubbles through the
   * dropdown first and is not it) goes to `switchTo`; a refusal puts the dropdown back to the current
   * language, as Datum's own select does. Each option carries its language in `lang`.
   */
  const languageSwitcher = (state: LanguageSwitcherState): TemplateResult => {
    if (state.locales.every((entry) => entry.code === state.current)) {
      return html`${nothing}`;
    }
    return html`<div class="datum-form__language-switcher datum-fluent-language" data-chrome-part="language-switcher">
      <fluent-field label-position="before">
        <label slot="label" for=${state.controlId} class=${state.hideLabel ? VISUALLY_HIDDEN : nothing}>${state.label}</label>
        <fluent-dropdown
          slot="input"
          type="select"
          id=${state.controlId}
          data-locale-switch
          @change=${(event: Event) => {
            if (event.target === event.currentTarget) {
              const dropdown = event.currentTarget as HTMLElement & { value?: string | null };
              const code = String(dropdown.value ?? "");
              if (code !== state.current && !state.switchTo(code)) {
                dropdown.value = state.current;
              }
            }
          }}
        >
          <fluent-listbox>${state.locales.map((entry) => html`<fluent-option value=${entry.code} lang=${entry.code} ?selected=${entry.code === state.current}>${entry.label}</fluent-option>`)}</fluent-listbox>
        </fluent-dropdown>
      </fluent-field>
    </div>`;
  };

  return { summary, notice, requiredNote, page, languageSwitcher };
}
