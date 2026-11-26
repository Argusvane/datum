/**
 * The Ontario Design System button, error summary, journey page, language switcher and the host's
 * receipt on the engine's contract.
 *
 * - Ontario has no error summary component; its pattern for an error that needs attention is the page
 *   alert of the error type (heading, then the message). The summary is one, its links in its slot (in
 *   Datum's shadow root, so a click can be answered here). The alert's heading is a fixed `h2`
 *   (`SummaryState.headingLevel` cannot be honoured: the design system's).
 * - The receipt is a page alert by the receipt's kind (success, informational, warning, error).
 * - Ontario's buttons are primary, secondary and tertiary: there is no destructive style, so a danger
 *   button is secondary. They take no `disabled` (the design system's policy): a busy press draws
 *   `aria-disabled` on the button inside.
 */
import type { ButtonFieldState, FieldAdapter, FormNoticeState, LiveBinding, SummaryEntry } from "../../../engine/form-engine/render/live/contract.js";
import { busyButton, headingOf, languageOf, type Hydrating, type Lit } from "./shared.js";

type Hook<K extends keyof LiveBinding> = NonNullable<LiveBinding[K]>;

export function createChrome(
  lit: Lit,
  datum: Pick<LiveBinding, "languageSwitcher">
): {
  button: FieldAdapter<ButtonFieldState>;
  summary: Hook<"summary">;
  notice: Hook<"notice">;
  page: Hook<"page">;
  languageSwitcher: Hook<"languageSwitcher">;
} {
  const { html, nothing, ifDefined, ref } = lit;

  // The renderer hears the press by `data-button-action` on the element it lands on, a custom element included.
  const buttonType = (variant: string | undefined): "primary" | "secondary" | "tertiary" => (variant === "link" || variant === "tertiary" ? "tertiary" : variant === "secondary" || variant === "light" || variant === "dark" || variant === "danger" ? "secondary" : "primary");

  const button: FieldAdapter<ButtonFieldState> = {
    kind: "field",
    name: "ontario-button",
    capabilities: {},
    template(s) {
      const action = s.action ?? s.model.buttonAction;
      const working = action !== undefined && (s.busy === "submitting" || s.busy === "navigating");
      const unavailable = s.disabled || s.readOnly || working;
      return html`<ontario-button
        type=${buttonType(s.variant ?? s.model.buttonVariant)}
        label=${s.label}
        data-button-action=${ifDefined(action)}
        data-button-signature=${ifDefined(s.model.buttonSignature)}
        ${ref(busyButton(unavailable))}
      ></ontario-button>`;
    },
    ready: async (field) => {
      await (field.querySelector("ontario-button") as Hydrating | null)?.componentOnReady?.();
    },
    focusTarget: (field) => field.querySelector("ontario-button")?.shadowRoot?.querySelector<HTMLElement>("button") ?? field.querySelector<HTMLElement>("ontario-button")
  };

  /**
   * The summary: an error page alert holding one link per line. The box carries the alert role and the
   * tabindex focus goes to; the alert's slot holds the links, in Datum's shadow root.
   */
  const summary: Hook<"summary"> = (entries: readonly SummaryEntry[], state) => {
    const list = html`<ul>
      ${state.formEntries.map((entry) => html`<li>${entry.text}</li>`)}
      ${entries.map(
        (entry) => html`<li>
          <a
            href=${entry.href}
            @click=${(event: Event) => {
              event.preventDefault();
              entry.focus();
            }}
            >${entry.text}</a
          >
        </li>`
      )}
    </ul>`;
    const alert = html`<ontario-page-alert type="error" heading=${state.heading}>${list}</ontario-page-alert>`;
    return state.echo === true ? html`<div class="datum-ontario-summary-box" aria-hidden="true" inert>${alert}</div>` : html`<div class="datum-ontario-summary-box" role="alert" tabindex="-1" aria-label=${state.heading}>${alert}</div>`;
  };

  /**
   * The host's receipt after a delivered submission: a page alert by kind inside the region the
   * renderer's `focusNotice` finds (the class and `tabindex`). The alert needs a heading: the host's
   * title led by the kind's word (so colour and icon are not the only cue), else the kind's word alone,
   * else the message. The echo copy at the other end of the form is hidden from assistive technology
 * and inert, so nothing in it (a link in the alert) is a tab stop.
   */
  const NOTICE_TYPES = { success: "success", info: "informational", warning: "warning", error: "error" } as const;
  const notice: Hook<"notice"> = (n: FormNoticeState) => {
    const word = n.kindWord.replace(/\s*:?\s*$/, "");
    const heading = n.title !== undefined ? `${n.kindWord.trimEnd()} ${n.title}`.trim() : word !== "" ? word : (n.message ?? "");
    const body = html`${n.message !== undefined && heading !== n.message ? html`<p>${n.message}</p>` : nothing}${n.details.length > 0
      ? html`<dl class="datum-ontario-receipt__details">${n.details.map((detail) => html`<div><dt>${detail.label}</dt><dd>${detail.value}</dd></div>`)}</dl>`
      : nothing}`;
    const card = html`<ontario-page-alert type=${NOTICE_TYPES[n.kind]} heading=${heading}>${body}</ontario-page-alert>`;
    return n.echo
      ? html`<div class="datum-ontario-receipt" aria-hidden="true" inert>${card}</div>`
      : html`<div class="datum-form__notice datum-ontario-receipt" role=${n.assertive ? "alert" : "status"} tabindex="-1">${card}</div>`;
  };

  /** A journey page: its progress, then its heading (focusable, so the renderer can move focus to it after a page change) in Ontario's heading class, and `ontario-button`s, Continue first. */
  const page: Hook<"page"> = {
    heading: (p) => html`${p.progress ? html`<p class="datum-ontario-hint">${p.progress}</p>` : nothing}
      ${headingOf(lit, p.headingLevel, { id: p.headingId, className: `ontario-h${Math.min(6, Math.max(1, p.headingLevel))}`, tabindex: "-1" }, p.title)}
      ${p.description ? html`<p>${p.description}</p>` : nothing}`,
    // A busy page draws aria-disabled, never disabled, on the button inside (busyButton); the click is dropped here.
    actions: (p) => html`<div class="datum-ontario-page-actions">
      ${p.next ? html`<ontario-button type="primary" label=${p.nextLabel} ${ref(busyButton(p.busy))} @click=${() => (p.busy ? undefined : p.next?.())}></ontario-button>` : nothing}
      ${p.back ? html`<ontario-button type="secondary" label=${p.backLabel} ${ref(busyButton(p.busy))} @click=${() => (p.busy ? undefined : p.back?.())}></ontario-button>` : nothing}
    </div>`
  };

  /**
   * The real `<ontario-language-toggle>`: it offers the other of Ontario's two languages, from the
   * `language` it is given. Its own click handler changes `<html lang>` of the host page and broadcasts
   * window events every Ontario component listens to; the click is answered first
   * (capture) and kept from it, and the form switches locale in place. The toggle can only say
   * "English" or "Français", so it is drawn only for a form in exactly one English and one French
   * locale; any other set (English and Spanish, or three languages) is Datum's switcher, which lists
   * each one.
   */
  const languageSwitcher: Hook<"languageSwitcher"> = (state) => {
    if (!englishAndFrench(state.locales)) {
      // Datum's binding always has a switcher; were it ever left out, the renderer draws its own default for an empty answer.
      return datum.languageSwitcher?.(state) as ReturnType<Hook<"languageSwitcher">>;
    }
    const current = languageOf(state.current);
    const other = state.locales.find((entry) => languageOf(entry.code) !== current);
    return html`<ontario-language-toggle
      language=${current}
      size="small"
      @click=${{
        handleEvent(event: Event) {
          event.preventDefault();
          event.stopPropagation();
          if (other) {
            state.switchTo(other.code);
          }
        },
        capture: true
      }}
    ></ontario-language-toggle>`;
  };

  return { button, summary, notice, page, languageSwitcher };
}

/** Exactly two locales, one English (`en`, `en-*`) and one French (`fr`, `fr-*`): the only pair Ontario's toggle can offer. */
function englishAndFrench(locales: ReadonlyArray<{ code: string }>): boolean {
  const base = locales.map((entry) => entry.code.toLowerCase().split(/[-_]/)[0]);
  return base.length === 2 && base.includes("en") && base.includes("fr");
}
