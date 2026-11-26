/**
 * GOV.UK's form-level pieces for the engine contract: the error summary, the language navigation,
 * a journey page's heading and buttons, a Check answers page's list (summary lists and summary
 * cards), and the host's receipt (a notification banner). Datum's own draw the rest (the
 * submitting line, the required note).
 *
 * The summary lists a message written for the error alone, as GOV.UK's guidance has it (the
 * message names the field: "Enter your full name"), and a default one with its field's label
 * (`entry.text`, "Full name: This field is required", so it still says which field it is):
 * `entry.authored` tells them apart. It sends focus the way the renderer does (`entry.focus()`: the
 * field's first control, GOV.UK's guidance). GOV.UK's error-summary script is not started: its
 * link handler looks the field up through `document`.
 */
import type {
  FormNoticeState,
  LanguageSwitcherState,
  LiveBinding,
  PageState,
  ReviewLinkState,
  ReviewRowState,
  ReviewState,
  SummaryEntry,
  SummaryState
} from "../../../engine/form-engine/render/live/contract.js";
import type { Lit, TemplateResult } from "../../../engine/form-engine/render/live/lit.js";

/** The names GOV.UK writes for the languages it publishes in; any other shows the form's own label for it. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = { en: "English", cy: "Cymraeg" };

export function createForm(lit: Lit) {
  const { html, nothing } = lit;

  /** A heading element at `level` (clamped to what HTML has): the summary's and the page's take the level the form's place in the page gives them. */
  const heading = (level: number, props: { id: string; className: string; page?: boolean }, content: string): TemplateResult => {
    const { className } = props;
    // An empty id is none (the receipt's echo copy carries no id).
    const id = props.id === "" ? nothing : props.id;
    const page = props.page === true;
    const tabindex = page ? "-1" : nothing;
    switch (Math.min(6, Math.max(1, Math.round(Number.isFinite(level) ? level : 1)))) {
      case 1:
        return html`<h1 id=${id} class=${className} tabindex=${tabindex} ?data-journey-heading=${page}>${content}</h1>`;
      case 2:
        return html`<h2 id=${id} class=${className} tabindex=${tabindex} ?data-journey-heading=${page}>${content}</h2>`;
      case 3:
        return html`<h3 id=${id} class=${className} tabindex=${tabindex} ?data-journey-heading=${page}>${content}</h3>`;
      case 4:
        return html`<h4 id=${id} class=${className} tabindex=${tabindex} ?data-journey-heading=${page}>${content}</h4>`;
      case 5:
        return html`<h5 id=${id} class=${className} tabindex=${tabindex} ?data-journey-heading=${page}>${content}</h5>`;
      default:
        return html`<h6 id=${id} class=${className} tabindex=${tabindex} ?data-journey-heading=${page}>${content}</h6>`;
    }
  };

  /** govuk-error-summary: form-level errors as text first, then one link per field error; its own alert role. */
  const summary = (entries: readonly SummaryEntry[], state: SummaryState): TemplateResult => html`<div class="govuk-error-summary" tabindex="-1">
    <div role="alert">
      ${heading(state.headingLevel, { id: state.headingId, className: "govuk-error-summary__title" }, state.heading)}
      <div class="govuk-error-summary__body">
        <ul class="govuk-list govuk-error-summary__list">
          ${state.formEntries.map((entry) => html`<li>${entry.text}</li>`)}
          ${entries.map(
            (entry) => html`<li><a
                href=${entry.href}
                @click=${(event: Event) => {
                  event.preventDefault();
                  entry.focus();
                }}
              >${entry.authored && entry.message !== undefined ? entry.message : entry.text}</a></li>`
          )}
        </ul>
      </div>
    </div>
  </div>`;

  /** govuk-language-navigation: the current language as text, the others as links. */
  const languageSwitcher = (state: LanguageSwitcherState): TemplateResult => html`<nav class="govuk-language-navigation" aria-label=${state.label} data-chrome-part="language-switcher">
    <ul class="govuk-language-navigation__list">
      ${state.locales.map((entry) => {
        const primary = entry.code.split("-")[0] ?? entry.code;
        const name = LANGUAGE_NAMES[primary] ?? entry.label;
        return entry.code === state.current
          ? html`<li class="govuk-language-navigation__list-item"><span class="govuk-language-navigation__text" aria-current="true" lang=${entry.code}>${name}</span></li>`
          : html`<li class="govuk-language-navigation__list-item"><a
                class="govuk-language-navigation__link"
                href="#"
                rel="alternate"
                lang=${entry.code}
                hreflang=${entry.code}
                @click=${(event: Event) => {
                  event.preventDefault();
                  state.switchTo(entry.code);
                }}
              >${name}</a></li>`;
      })}
    </ul>
  </nav>`;

  /** A journey page: the caption and heading (at the form's own level, `PageState.headingLevel`; it takes focus after a page change), then the buttons. */
  const page: NonNullable<LiveBinding["page"]> = {
    heading: (p: PageState): TemplateResult =>
      html`${p.progress !== undefined && p.progress !== "" ? html`<span class="govuk-caption-l" data-journey-progress>${p.progress}<span class="govuk-visually-hidden">: </span></span>` : nothing}${
        p.title !== "" ? heading(p.headingLevel, { id: p.headingId, className: "govuk-heading-l", page: true }, p.title) : nothing
      }${p.description !== undefined && p.description !== "" ? html`<p class="govuk-body">${p.description}</p>` : nothing}`,
    // Busy is aria-disabled, never disabled: the button keeps the focus it was pressed with.
    actions: (p: PageState): TemplateResult => html`<div class="govuk-button-group">
        ${p.next !== undefined
          ? html`<button type="button" class="govuk-button" data-module="govuk-button" data-journey-continue aria-disabled=${p.busy ? "true" : "false"} @click=${() => p.next?.()}>${p.nextLabel}</button>`
          : nothing}
        ${p.back !== undefined
          ? html`<button type="button" class="govuk-button govuk-button--secondary" data-module="govuk-button" data-journey-back aria-disabled=${p.busy ? "true" : "false"} @click=${() => p.back?.()}>${p.backLabel}</button>`
          : nothing}
      </div>
      ${p.checking !== undefined && p.checking !== "" ? html`<p class="govuk-body" role="status" aria-live="polite" data-journey-checking>${p.checking}</p>` : nothing}`
  };

  /**
   * The host's receipt after a delivered submission: GOV.UK's notification banner, the pattern for
   * telling a user an action is done. Success is the success variant with `role="alert"`, as
   * GOV.UK's template writes it; any other kind is the standard banner, a `region` named by its
   * title, or an alert on the draw that first shows an error (`assertive`). The title is the kind's
   * word (the form's "Success", GOV.UK's own default title), the receipt's title the banner's heading.
   * It carries the class and `tabindex` the renderer's `focusNotice` finds, so the renderer moves
   * focus to it; GOV.UK's banner script (which only focuses it) is not started (no `data-module`).
   * The echo copy at the other end of the form is hidden from assistive technology, with no id.
   */
  const notice = (n: FormNoticeState): TemplateResult => {
    const word = n.kindWord.replace(/\s*:?\s*$/, "");
    const success = n.kind === "success";
    const titleId = n.echo ? undefined : "datum-govuk-receipt-title";
    const bannerTitle = word !== "" ? word : (n.title ?? "");
    const contentHeading = word !== "" ? n.title : undefined;
    const content = html`${contentHeading !== undefined ? html`<p class="govuk-notification-banner__heading">${contentHeading}</p>` : nothing}${
      n.message !== undefined ? html`<p class="govuk-body">${n.message}</p>` : nothing
    }${n.details.length > 0
      ? html`<dl class="govuk-summary-list">${n.details.map(
          (detail) => html`<div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">${detail.label}</dt><dd class="govuk-summary-list__value">${detail.value}</dd></div>`
        )}</dl>`
      : nothing}`;
    const className = success ? "govuk-notification-banner govuk-notification-banner--success" : "govuk-notification-banner";
    const header = html`<div class="govuk-notification-banner__header">${heading(n.headingLevel, { id: titleId ?? "", className: "govuk-notification-banner__title" }, bannerTitle)}</div>`;
    if (n.echo) {
      return html`<div class=${className} aria-hidden="true">${header}<div class="govuk-notification-banner__content">${content}</div></div>`;
    }
    const role = success || n.assertive ? "alert" : "region";
    return html`<div class=${`${className} datum-form__notice`} role=${role} aria-labelledby=${titleId ?? nothing} tabindex="-1">${header}<div class="govuk-notification-banner__content">${content}</div></div>`;
  };

  /** A Change or Enter link: `govuk-link`, the rest of its name in `govuk-visually-hidden` (`hidden` replaces it, for a card's title in brackets as GOV.UK's macro writes it). */
  const reviewLink = (link: ReviewLinkState, hidden = link.hidden): TemplateResult => html`<a
      class="govuk-link"
      href=${link.href}
      aria-describedby=${link.describedBy ?? nothing}
      @click=${(event: Event) => {
        event.preventDefault();
        link.go();
      }}
      >${link.reordered ? html`<span aria-hidden="true">${link.text}</span><span class="govuk-visually-hidden">${link.name}</span>` : html`${link.text}${hidden !== "" ? html`<span class="govuk-visually-hidden">${hidden}</span>` : nothing}`}</a
    >`;

  /** An answer's lines, as GOV.UK's summary list writes an address: a line break between each. */
  const lines = (value: string): TemplateResult => html`${value.split("\n").map((line, at) => (at === 0 ? html`${line}` : html`<br />${line}`))}`;

  /** A row's errors: GOV.UK's error message, in the value cell above the answer. */
  const rowErrors = (errors: readonly string[], id: string, prefix: string): TemplateResult | typeof nothing =>
    errors.length > 0
      ? html`<p id=${id} class="govuk-error-message">${errors.map((message, at) => html`${at > 0 ? html`<br />` : nothing}${prefix !== "" ? html`<span class="govuk-visually-hidden">${prefix}</span> ` : nothing}${message}`)}</p>`
      : nothing;

  /**
   * A summary list (`govuk-summary-list`): key, value, and the Change link in the actions cell with
   * the row named in visually hidden text. A row with no Change, among rows that have one, is
   * `govuk-summary-list__row--no-actions`; a missing answer's "Enter …" link is its value.
   */
  const summaryList = (rows: readonly ReviewRowState[], prefix: string): TemplateResult => {
    const anyActions = rows.some((row) => row.change !== undefined);
    return html`<dl class="govuk-summary-list">
      ${rows.map(
        (row) => html`<div class=${anyActions && row.change === undefined ? "govuk-summary-list__row govuk-summary-list__row--no-actions" : "govuk-summary-list__row"} id=${row.id}>
          <dt class="govuk-summary-list__key">${row.label}</dt>
          <dd class="govuk-summary-list__value">${rowErrors(row.errors, row.errorId, prefix)}${row.enter !== undefined ? reviewLink(row.enter) : lines(row.value)}</dd>
          ${row.change !== undefined ? html`<dd class="govuk-summary-list__actions">${reviewLink(row.change)}</dd>` : nothing}
        </div>`
      )}
    </dl>`;
  };

  /**
   * GOV.UK's check answers pattern: a `govuk-heading-m` per step, its answers as a summary list, a
   * data grid's rows as summary cards (`govuk-summary-card`: the row's heading as the card title, at
   * the level under the step's, and its one Change in the card's actions, named by the title in
   * brackets as GOV.UK's macro names a card's action).
   */
  const review = (state: ReviewState): TemplateResult => {
    const prefix = state.errorPrefix;
    const cardLevel = state.headingLevel + 1;
    return html`${state.sections.map((section) => {
      const runs: Array<{ rows: ReviewRowState[] } | { card: Extract<ReviewState["sections"][number]["items"][number], { kind: "card" }> }> = [];
      for (const item of section.items) {
        const last = runs[runs.length - 1];
        if (item.kind === "card") {
          runs.push({ card: item });
        } else if (last !== undefined && "rows" in last) {
          last.rows.push(item);
        } else {
          runs.push({ rows: [item] });
        }
      }
      return html`${heading(state.headingLevel, { id: section.headingId, className: "govuk-heading-m" }, section.title)}${runs.map((run) =>
        "rows" in run
          ? summaryList(run.rows, prefix)
          : html`<div class="govuk-summary-card" id=${run.card.id}>
              <div class="govuk-summary-card__title-wrapper">
                ${heading(cardLevel, { id: "", className: "govuk-summary-card__title" }, run.card.title)}
                ${run.card.change !== undefined ? html`<div class="govuk-summary-card__actions">${reviewLink(run.card.change, ` (${run.card.title})`)}</div>` : nothing}
              </div>
              <div class="govuk-summary-card__content">${rowErrors(run.card.errors, run.card.errorId, prefix)}${run.card.rows.length > 0 ? summaryList(run.card.rows, prefix) : nothing}</div>
            </div>`
      )}`;
    })}`;
  };

  return { summary, languageSwitcher, page, notice, review };
}
