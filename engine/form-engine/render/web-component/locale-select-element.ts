import { HTMLElementBase, canDefineCustomElements } from "./custom-element-base.js";
import type { LocaleOption } from "../../core/localization/supported-locales.js";
import { resolveFormText } from "../../core/localization/form-texts.js";

export const DATUM_LOCALE_SELECT_TAG = "datum-locale-select";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Standalone locale switcher: set `.locales` / `.value`, listen for `locale-change`. Renders
 * nothing when `locales` is empty (no host opt-in, no control shown) so it composes safely
 * into any layout; the builder's bar embeds it. The native select is exposed as part
 * `select`, so the page around it can draw it in its own look (the builder's bar draws it as a
 * pill); the rules here are the plain look it has otherwise.
 */
export class DatumLocaleSelectElement extends HTMLElementBase {
  private readonly root: ShadowRoot;
  private opts: LocaleOption[] = [];
  private current = "";
  private selectEl: HTMLSelectElement | undefined;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  public set locales(value: LocaleOption[]) {
    this.opts = value;
    this.render();
  }

  public get locales(): LocaleOption[] {
    return this.opts;
  }

  public set value(code: string) {
    this.current = code;
    if (this.selectEl) {
      this.selectEl.value = code;
    } else {
      this.render();
    }
  }

  public get value(): string {
    return this.current;
  }

  public connectedCallback(): void {
    this.render();
  }

  private render(): void {
    if (this.opts.length === 0) {
      this.root.innerHTML = "";
      this.selectEl = undefined;
      return;
    }
    const optionsHtml = this.opts
      .map(
        (entry) =>
          `<option value="${esc(entry.code)}"${entry.code === this.current ? " selected" : ""}>${esc(entry.label)}</option>`
      )
      .join("");
    const name = esc(this.getAttribute("label") ?? resolveFormText(undefined, "localeLabel", this.current || "en"));
    const showLabel = this.hasAttribute("show-label");
    this.root.innerHTML = `
      <style>
        select {
          border: 1px solid #a9bbcb; background: #eef3f8;
          border-radius: 6px; padding: 3px 6px; font-size: 12px; cursor: pointer;
        }
      </style>
      ${
        // With `show-label` the visible words are a real label and the select is named by them
        // (aria-labelledby cannot reach across the shadow root from the page's own heading).
        showLabel
          ? `<label id="name" for="pick" part="label">${name}</label><select id="pick" part="select" title="${name}" aria-labelledby="name">${optionsHtml}</select>`
          : `<select part="select" title="${name}" aria-label="${name}">${optionsHtml}</select>`
      }`;
    this.selectEl = this.root.querySelector("select") ?? undefined;
    this.selectEl?.addEventListener("change", () => {
      this.current = this.selectEl?.value ?? this.current;
      this.dispatchEvent(
        new CustomEvent<{ locale: string }>("locale-change", {
          detail: { locale: this.current },
          bubbles: true,
          composed: true
        })
      );
    });
  }
}

export function defineDatumLocaleSelectElement(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_LOCALE_SELECT_TAG)) {
    customElements.define(DATUM_LOCALE_SELECT_TAG, DatumLocaleSelectElement);
  }
}
