/**
 * Datum's static content: the `html` block and the `image`.
 *
 * Neither holds an answer or carries a label, hint or error. The `html` block is the author's own
 * markup, already reduced to the allowlist by `sanitizeStaticHtml` on the model (every surface
 * gets the same safe string, and no adapter can forget to ask), drawn as the block's content inside
 * the wrapper element the author chose through `unsafeHTML`, which parses it as template HTML under
 * lit-html's Trusted Types policy (an `.innerHTML` assignment would be refused on a page that
 * enforces `require-trusted-types-for 'script'`). The `image` is a picture from a URL the model already
 * checked (unsafe reads as none): a missing or unsafe URL draws an empty frame with a caption
 * instead, visible on the builder canvas where the author can select it and supply a URL, and
 * nothing in the way of harm in the live form.
 */
import { readHtmlTag } from "../../../core/schema/static-html.js";
import type { FieldAdapter } from "../contract.js";
import { html, ifDefined, unsafeHTML, type TemplateResult } from "../lit.js";
import { configurationOf } from "./leaf-kit.js";

type Block = (markup: string) => TemplateResult;

/** The wrapper elements an author may choose (`HTML_BLOCK_TAGS`), each with the markup as its content. */
const BLOCKS: Readonly<Record<string, Block>> = {
  div: (markup) => html`<div class="datum-form__html">${unsafeHTML(markup)}</div>`,
  section: (markup) => html`<section class="datum-form__html">${unsafeHTML(markup)}</section>`,
  article: (markup) => html`<article class="datum-form__html">${unsafeHTML(markup)}</article>`,
  aside: (markup) => html`<aside class="datum-form__html">${unsafeHTML(markup)}</aside>`,
  p: (markup) => html`<p class="datum-form__html">${unsafeHTML(markup)}</p>`,
  span: (markup) => html`<span class="datum-form__html">${unsafeHTML(markup)}</span>`,
  h1: (markup) => html`<h1 class="datum-form__html">${unsafeHTML(markup)}</h1>`,
  h2: (markup) => html`<h2 class="datum-form__html">${unsafeHTML(markup)}</h2>`,
  h3: (markup) => html`<h3 class="datum-form__html">${unsafeHTML(markup)}</h3>`,
  h4: (markup) => html`<h4 class="datum-form__html">${unsafeHTML(markup)}</h4>`,
  h5: (markup) => html`<h5 class="datum-form__html">${unsafeHTML(markup)}</h5>`,
  h6: (markup) => html`<h6 class="datum-form__html">${unsafeHTML(markup)}</h6>`,
  blockquote: (markup) => html`<blockquote class="datum-form__html">${unsafeHTML(markup)}</blockquote>`,
  pre: (markup) => html`<pre class="datum-form__html">${unsafeHTML(markup)}</pre>`
};

/** Datum's `html` block. */
export const datumHtml: FieldAdapter = {
  kind: "field",
  name: "datum html",
  capabilities: {},
  template(state) {
    const tag = readHtmlTag(configurationOf(state));
    const block = Object.prototype.hasOwnProperty.call(BLOCKS, tag) ? BLOCKS[tag] : BLOCKS.div;
    return (block ?? BLOCKS.div!)(state.model.staticHtml ?? "");
  }
};

/** Datum's `image`. */
export const datumImage: FieldAdapter = {
  kind: "field",
  name: "datum image",
  capabilities: {},
  template(state) {
    const image = state.model.image;
    if (!image?.src) {
      return html`<div class="datum-form__image datum-form__image--empty"><span class="datum-form__image-placeholder">${state.words("imageEmpty")}</span></div>`;
    }
    return html`<figure class="datum-form__image"><img
        src=${image.src}
        alt=${image.alt}
        width=${ifDefined(image.width)}
        height=${ifDefined(image.height)}
        loading="lazy"
        referrerpolicy="no-referrer"
      /></figure>`;
  }
};
