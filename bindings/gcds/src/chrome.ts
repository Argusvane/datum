/**
 * The GC Design System button, error summary, journey page, language switcher and the host's
 * receipt on the engine's contract.
 */
import type { ButtonFieldState, FieldAdapter, FormNoticeState, LiveBinding, SummaryEntry } from "../../../engine/form-engine/render/live/contract.js";
import { busyButton, languageOf, type Hydrating, type Lit } from "./shared.js";

type Hook<K extends keyof LiveBinding> = NonNullable<LiveBinding[K]>;

export function createChrome(lit: Lit): {
  button: FieldAdapter<ButtonFieldState>;
  summary: Hook<"summary">;
  notice: Hook<"notice">;
  page: Hook<"page">;
  languageSwitcher: Hook<"languageSwitcher">;
} {
  const { html, nothing, ifDefined, ref } = lit;

  // The renderer hears the press by `data-button-action` on the element it lands on, a custom element included.
  const buttonRole = (variant: string | undefined): string => (variant === "danger" ? "danger" : variant === "secondary" || variant === "light" || variant === "dark" ? "secondary" : "primary");

  const button: FieldAdapter<ButtonFieldState> = {
    kind: "field",
    name: "gcds-button",
    capabilities: {},
    template(s) {
      const action = s.action ?? s.model.buttonAction;
      const working = action !== undefined && (s.busy === "submitting" || s.busy === "navigating");
      return html`<gcds-button
        type="button"
        button-role=${buttonRole(s.variant ?? s.model.buttonVariant)}
        size=${(s.size ?? s.model.buttonSize) === "sm" ? "small" : "regular"}
        data-button-action=${ifDefined(action)}
        data-button-signature=${ifDefined(s.model.buttonSignature)}
        ?disabled=${s.disabled || s.readOnly}
        aria-disabled=${working ? "true" : nothing}
        lang=${languageOf(s.locale)}
        >${s.label}</gcds-button
      >`;
    },
    // gcds-button cannot be aria-disabled from outside: its inner button is its own, so it is marked here.
    after(field, s) {
      const action = s.action ?? s.model.buttonAction;
      const inner = field.querySelector("gcds-button")?.shadowRoot?.querySelector("button");
      if (inner) {
        if (action !== undefined && (s.busy === "submitting" || s.busy === "navigating")) {
          inner.setAttribute("aria-disabled", "true");
        } else {
          inner.removeAttribute("aria-disabled");
        }
      }
    },
    ready: async (field) => {
      await (field.querySelector("gcds-button") as Hydrating | null)?.componentOnReady?.();
    },
    focusTarget: (field) => field.querySelector<HTMLElement>("gcds-button")
  };

  /**
   * The real `<gcds-error-summary>`, given the links. Its own click handler looks the field up in
   * the document, which cannot see into the form's shadow root, so the click is answered here first
   * (capture) and never reaches it; `listen` is off since there are no gcdsError events: Datum is
   * the validator. The errors with no field to go to are text above it.
   * `error-links` is an object keyed by the link's address, so the errors one field has share one
   * link: its first line, then the other messages ("Nickname - Enter a nickname; Too short").
   */
  const linkTexts = (entries: readonly SummaryEntry[]): Record<string, string> => {
    const links = new Map<string, string>();
    for (const entry of entries) {
      const first = links.get(entry.href);
      links.set(entry.href, first === undefined ? entry.text : `${first}; ${entry.message ?? entry.text}`);
    }
    return Object.fromEntries(links);
  };
  const summary: Hook<"summary"> = (entries, state) =>
    html`${state.formEntries.length > 0 ? html`<ul class="datum-gcds-form-errors">${state.formEntries.map((entry) => html`<li>${entry.text}</li>`)}</ul>` : nothing}<gcds-error-summary
      heading=${state.heading}
      error-links=${JSON.stringify(linkTexts(entries))}
      listen="false"
      lang=${languageOf(state.locale)}
      @click=${{
        handleEvent(event: Event) {
          const anchor = event.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
          const entry = anchor ? entries.find((candidate) => candidate.href === anchor.getAttribute("href")) : undefined;
          if (entry) {
            event.preventDefault();
            event.stopPropagation();
            entry.focus();
          }
        },
        capture: true
      }}
    ></gcds-error-summary>`;

  /**
   * The host's receipt after a delivered submission: a real `<gcds-notice>` (success, info, warning
   * or danger by the receipt's kind) inside the region the renderer's `focusNotice` finds (the class
   * and `tabindex`). The receipt carries a title (`gcds-notice` requires one: the host's, led by the kind's word
   * so colour and icon are not the only cue, else the kind's word alone); its heading takes a level under the form's own, between the h2 and h5 the
   * component allows. The echo copy at the other end of the form is hidden from assistive technology.
   */
  const NOTICE_ROLES = { success: "success", info: "info", warning: "warning", error: "danger" } as const;
  const notice: Hook<"notice"> = (n: FormNoticeState) => {
    const word = n.kindWord.replace(/\s*:?\s*$/, "");
    const tag = `h${Math.min(5, Math.max(2, n.headingLevel))}` as "h2" | "h3" | "h4" | "h5";
    const body = html`${n.message !== undefined ? html`<gcds-text margin-bottom="0">${n.message}</gcds-text>` : nothing}${n.details.length > 0
      ? html`<dl class="datum-gcds-receipt__details">${n.details.map((detail) => html`<div><dt>${detail.label}</dt><dd>${detail.value}</dd></div>`)}</dl>`
      : nothing}`;
    const card = html`<gcds-notice notice-role=${NOTICE_ROLES[n.kind]} notice-title=${n.title !== undefined ? `${n.kindWord.trimEnd()} ${n.title}` : word} notice-title-tag=${tag}>${body}</gcds-notice>`;
    return n.echo
      ? html`<div class="datum-gcds-receipt" aria-hidden="true">${card}</div>`
      : html`<div class="datum-form__notice datum-gcds-receipt" role=${n.assertive ? "alert" : "status"} tabindex="-1">${card}</div>`;
  };

  /** A journey page: `gcds-heading` (focusable, so the renderer can move focus to it after a page change) under its progress in `gcds-text`, and `gcds-button`s, Back secondary. */
  const page: Hook<"page"> = {
    heading: (p) => html`${p.progress ? html`<gcds-text margin-bottom="0">${p.progress}</gcds-text>` : nothing}
      <gcds-heading tag=${`h${Math.min(6, Math.max(1, p.headingLevel))}`} id=${p.headingId} tabindex="-1" margin-top="0">${p.title}</gcds-heading>
      ${p.description ? html`<gcds-text>${p.description}</gcds-text>` : nothing}`,
    // A busy page draws aria-disabled, never disabled, on the host and on the button inside it (busyButton: the component
    // copies the host's only on load and click); the click is dropped here.
    actions: (p) => html`<div class="datum-gcds-page-actions">
      ${p.back ? html`<gcds-button type="button" button-role="secondary" aria-disabled=${p.busy ? "true" : nothing} ${ref(busyButton(p.busy))} @click=${() => (p.busy ? undefined : p.back?.())}>${p.backLabel}</gcds-button>` : nothing}
      ${p.next ? html`<gcds-button type="button" aria-disabled=${p.busy ? "true" : nothing} ${ref(busyButton(p.busy))} @click=${() => (p.busy ? undefined : p.next?.())}>${p.nextLabel}</gcds-button>` : nothing}
    </div>`
  };

  /**
   * The real `<gcds-lang-toggle>`: it offers the other of GC Design System's two languages, from
   * the `lang` it is given. Its link is a page address by design (one page per language); here
   * the click is answered first and the form switches locale in place, to the form's first
   * supported locale in the other language.
   */
  const languageSwitcher: Hook<"languageSwitcher"> = (state) => {
    const current = languageOf(state.current);
    const other = state.locales.find((entry) => languageOf(entry.code) !== current);
    return html`<gcds-lang-toggle
      href="#"
      lang=${current}
      @click=${{
        handleEvent(event: Event) {
          if (event.composedPath().some((node) => node instanceof HTMLAnchorElement)) {
            event.preventDefault();
            event.stopPropagation();
            if (other) {
              state.switchTo(other.code);
            }
          }
        },
        capture: true
      }}
    ></gcds-lang-toggle>`;
  };

  return { button, summary, notice, page, languageSwitcher };
}
