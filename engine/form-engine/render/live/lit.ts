/**
 * The one lit-html copy the engine carries. Every module that draws with lit imports it from
 * here and from nowhere else: the live renderer in `render/live/`, the `<datum-form-renderer>`
 * element, and the builder's canvas hooks, panels and designers. Nothing a DOM-free entry
 * imports at run time reaches this module (guards/16-lit-isolation.mjs and
 * `live-lit-isolation.test.ts` hold that), so the program bundles (the sandbox, the PDF program,
 * any kernel bundle) never carry lit-html: its top level reads `document`, calls `Math.random()`
 * and creates a Trusted Types policy named `lit-html`, none of which a QuickJS context has or
 * may do.
 *
 * A binding never imports lit by specifier. A binding module exports `createBinding(lit, datum)`
 * and the host hands it {@link lit}, this namespace: the template tags and the directives a
 * binding draws with. `render` is the renderer's alone and is not in it.
 */
import { html, noChange, nothing, render, svg } from "lit-html";
import { ifDefined } from "lit-html/directives/if-defined.js";
import { live } from "lit-html/directives/live.js";
import { createRef, ref } from "lit-html/directives/ref.js";
import { repeat } from "lit-html/directives/repeat.js";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { unsafeSVG } from "lit-html/directives/unsafe-svg.js";

// `unsafeHTML` is the engine's own (Datum's sanitized static markup), not in the binding's `lit`: it
// parses its string as template HTML, through lit-html's Trusted Types policy, where an `.innerHTML`
// property binding is a raw string sink a `require-trusted-types-for 'script'` page refuses.
export { createRef, html, ifDefined, live, noChange, nothing, ref, render, repeat, svg, unsafeHTML, unsafeSVG };
export type { RenderOptions, SVGTemplateResult, TemplateResult } from "lit-html";
export type { Ref, RefOrCallback } from "lit-html/directives/ref.js";

declare const NOTHING_BRAND: unique symbol;

/**
 * lit's `nothing` as a binding holds it. lit types it as a `unique symbol`, which TypeScript widens
 * to plain `symbol` the moment it is read into a local (`const { nothing } = lit`), and a plain
 * symbol is no `View`. The brand keeps the type through a destructuring; lit's own `nothing` is
 * one of these.
 */
export type Nothing = typeof nothing & { readonly [NOTHING_BRAND]?: never };

/** What a binding's `createBinding(lit, datum)` is given as `lit`, as a type: what a binding module imports, type-only. */
export interface Lit {
  readonly html: typeof html;
  readonly svg: typeof svg;
  /** Destructures as is (`const { html, nothing } = lit`): see {@link Nothing}. */
  readonly nothing: Nothing;
  readonly live: typeof live;
  readonly repeat: typeof repeat;
  readonly ifDefined: typeof ifDefined;
  readonly ref: typeof ref;
  readonly unsafeSVG: typeof unsafeSVG;
}

/** The template tags and directives a binding draws with. */
export const lit: Lit = Object.freeze({ html, svg, nothing, live, repeat, ifDefined, ref, unsafeSVG });
