/**
 * A heading of a given level in Fluent UI's text component. `fluent-text` sets the size and weight
 * a heading is read in and wraps a semantic child (its own documentation wraps `h1`..`h6` and `p`);
 * it does not reset the browser's own heading margin and size, so the heading inside takes
 * `datum-fluent-heading` (css.ts: no margin, `font: inherit`).
 */
import type { TemplateResult } from "../../../engine/form-engine/render/live/lit.js";
import type { Lit } from "./shared.js";

export interface HeadingProps {
  /** The `fluent-text` size: 200..1000 (Fluent's type ramp); left out, its default (300). */
  size?: string;
  id?: string | undefined;
  /** Focusable by script (`tabindex="-1"`): the heading focus goes to. */
  focusable?: boolean;
  /** Marks the heading a journey page's (`data-journey-heading`). */
  journey?: boolean;
}

export function createHeading(lit: Lit): (level: number, props: HeadingProps, content: unknown) => TemplateResult {
  const { html, ifDefined, nothing } = lit;
  return (level, props, content) => {
    const id = ifDefined(props.id);
    const tabindex = props.focusable === true ? "-1" : nothing;
    const journey = props.journey === true ? "" : nothing;
    const inner = ((): TemplateResult => {
      switch (Math.min(6, Math.max(1, Math.round(Number.isFinite(level) ? level : 2)))) {
        case 1:
          return html`<h1 id=${id} class="datum-fluent-heading" tabindex=${tabindex} data-journey-heading=${journey}>${content}</h1>`;
        case 2:
          return html`<h2 id=${id} class="datum-fluent-heading" tabindex=${tabindex} data-journey-heading=${journey}>${content}</h2>`;
        case 3:
          return html`<h3 id=${id} class="datum-fluent-heading" tabindex=${tabindex} data-journey-heading=${journey}>${content}</h3>`;
        case 4:
          return html`<h4 id=${id} class="datum-fluent-heading" tabindex=${tabindex} data-journey-heading=${journey}>${content}</h4>`;
        case 5:
          return html`<h5 id=${id} class="datum-fluent-heading" tabindex=${tabindex} data-journey-heading=${journey}>${content}</h5>`;
        default:
          return html`<h6 id=${id} class="datum-fluent-heading" tabindex=${tabindex} data-journey-heading=${journey}>${content}</h6>`;
      }
    })();
    return props.size === undefined ? html`<fluent-text weight="semibold" block>${inner}</fluent-text>` : html`<fluent-text size=${props.size} weight="semibold" block>${inner}</fluent-text>`;
  };
}
