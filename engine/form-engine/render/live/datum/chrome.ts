/**
 * Datum's drawing of the form's chrome parts: the picture, heading, paragraph, markup,
 * the form's own title and description, and the language switcher, in the header and footer.
 *
 * The renderer (`chrome.ts` in the parent folder) decides which parts there are, resolves their
 * texts for the locale, checks a picture's URL and reduces a part's markup to the allowlist; each
 * adapter here only draws the resolved part. A `group` is the renderer's own row of parts, drawn
 * around the parts it holds, so Datum has no adapter for it: its markup is the renderer's.
 *
 * - The form's title as the caption of a journey page is a paragraph (`caption`), never a second
 *   heading: the page's own heading is the main one.
 * - The switcher is a labelled select, one option per locale, each with its `lang` so a screen
 *   reader pronounces "Français" in French. {@link createLanguageLinks} is the other way design
 *   systems draw it: links, the current language as plain text or a marked link.
 */
import type { ChromeAdapter, ChromeState, LanguageSwitcherState, LiveBinding } from "../contract.js";
import { html, ifDefined, live, nothing, unsafeHTML, type TemplateResult } from "../lit.js";
import { headingOf } from "./leaf-kit.js";

/** The part types Datum draws itself. */
export const datumChrome: Readonly<Record<string, ChromeAdapter>> = {
  image: {
    template(state: ChromeState): TemplateResult {
      const image = state.image;
      if (image === undefined) {
        return html`${state.content}`;
      }
      const picture = html`<img src=${image.src} alt=${image.alt} width=${ifDefined(image.width)} height=${ifDefined(image.height)} referrerpolicy="no-referrer" />`;
      return html`<figure class="datum-form__chrome-image" data-chrome-part="image">${image.href !== undefined ? html`<a href=${image.href}>${picture}</a>` : picture}</figure>`;
    }
  },
  heading: {
    template: (state) => headingOf(state.level ?? 2, "datum-form__chrome-heading", state.text ?? "", "heading")
  },
  text: {
    template: (state) => html`<p class="datum-form__chrome-text" data-chrome-part="text">${state.text ?? ""}</p>`
  },
  html: {
    template: (state) => html`<div class="datum-form__chrome-html datum-form__html" data-chrome-part="html">${unsafeHTML(state.html ?? "")}</div>`
  },
  "form-title": {
    template: (state) =>
      state.caption === true
        ? html`<p class="datum-form__chrome-title datum-form__journey-title" data-chrome-part="form-title">${state.text ?? ""}</p>`
        : headingOf(state.level ?? 1, "datum-form__title datum-form__chrome-title", state.text ?? "", "form-title")
  },
  "form-description": {
    template: (state) => html`<p class="datum-form__chrome-description" data-chrome-part="form-description">${state.text ?? ""}</p>`
  }
};

// ── The language switcher ──────────────────────────────────────────────────────────────────

/** Datum's switcher: a labelled `<select>` of the form's locales. A refusal puts the select back to the current locale. */
export function datumLanguageSwitcher(state: LanguageSwitcherState): TemplateResult {
  const labelClass = state.hideLabel ? "datum-form__language-switcher-label datum-form__visually-hidden" : "datum-form__language-switcher-label";
  // A current locale none of the options is shows a blank, never the first language, so choosing that one is still a switch.
  const unlisted = !state.locales.some((entry) => entry.code === state.current);
  return html`<div class="datum-form__language-switcher" data-chrome-part="language-switcher"><label class=${labelClass} for=${state.controlId}>${state.label}</label><select
      id=${state.controlId}
      class="datum-form__language-switcher-select datum-form__control datum-form__control--select"
      data-locale-switch
      .value=${live(unlisted ? "" : state.current)}
      @change=${(event: Event) => {
        const control = event.currentTarget as HTMLSelectElement;
        if (!state.switchTo(control.value)) {
          control.value = unlisted ? "" : state.current;
        }
      }}
    >${unlisted ? html`<option value="" disabled hidden selected></option>` : nothing}${state.locales.map(
      (entry) => html`<option value=${entry.code} lang=${entry.code} ?selected=${entry.code === state.current}>${entry.label}</option>`
    )}</select></div>`;
}

/** How a switcher drawn as links looks. */
export interface LanguageLinksOptions {
  /**
   * How the current language shows: left out (a toggle names only the other language), as plain
   * text (the default), or as a link marked current.
   */
  current?: "omit" | "text" | "link";
  /** A visually hidden heading before the links, worded from `languageSelection`. Default: on. */
  heading?: boolean;
  /** An `<abbr>` with the language's subtag beside its name, for a stylesheet to pick between. */
  abbreviation?: boolean;
  /** Text drawn between entries ("|"). Default: none. */
  separator?: string;
  /**
   * The name a language shows regardless of the form's own label for the locale, keyed by its
   * primary subtag: a toggle always says "Français" or "English", never "Français (Canada)". A
   * language not listed keeps the locale's label.
   */
  names?: Readonly<Record<string, string>>;
  /** Extra class on the wrapper (a design system's own hook). */
  className?: string;
  /** Extra class on each link. */
  linkClass?: string;
}

/** The BCP-47 primary subtag, `fr` from `fr-CA`, which is what a toggle abbreviates to. */
export function languageOf(code: string): string {
  const [primary] = code.split("-");
  return (primary && primary.length > 0 ? primary : code).toLowerCase();
}

/** A switcher drawn as links rather than a select, for `LiveBinding.languageSwitcher`. */
export function createLanguageLinks(options: LanguageLinksOptions = {}): NonNullable<LiveBinding["languageSwitcher"]> {
  const current = options.current ?? "text";
  const heading = options.heading ?? true;
  return (state) => {
    const name = (entry: { code: string; label: string }): TemplateResult | string => {
      // An own name only: a locale code such as `constructor` must not read an inherited member.
      const key = languageOf(entry.code);
      const named = options.names !== undefined && Object.hasOwn(options.names, key) ? options.names[key] : undefined;
      const label = typeof named === "string" ? named : entry.label;
      return options.abbreviation ? html`<span>${label}</span><abbr title=${label}>${key}</abbr>` : label;
    };
    const linkClass = `datum-form__language-link${options.linkClass ? ` ${options.linkClass}` : ""}`;
    const entry = (item: { code: string; label: string }): TemplateResult | typeof nothing => {
      const language = languageOf(item.code);
      if (item.code === state.current) {
        if (current === "omit") {
          return nothing;
        }
        if (current === "text") {
          return html`<span class="datum-form__language-current" lang=${language} aria-current="true">${name(item)}</span>`;
        }
      }
      const marked = item.code === state.current;
      return html`<a
        class=${marked ? `${linkClass} datum-form__language-link--current` : linkClass}
        href="#"
        lang=${language}
        hreflang=${language}
        aria-current=${marked ? "true" : nothing}
        data-locale-switch=${item.code}
        @click=${(event: Event) => {
          // An `<a href="#">` would otherwise scroll the host page to its top.
          event.preventDefault();
          state.switchTo(item.code);
        }}
      >${name(item)}</a>`;
    };
    const entries = state.locales.map(entry).filter((view) => view !== nothing);
    const separated = entries.flatMap((view, index) =>
      index === 0 || !options.separator ? [view] : [html`<span class="datum-form__language-separator" aria-hidden="true">${options.separator}</span>`, view]
    );
    const className = `datum-form__language-switcher datum-form__language-links${options.className ? ` ${options.className}` : ""}`;
    return html`<div class=${className} data-chrome-part="language-switcher">${
      heading ? html`<h2 id=${`${state.controlId}__heading`} class="datum-form__visually-hidden">${state.words("languageSelection")}</h2>` : nothing
    }${separated}</div>`;
  };
}
