/**
 * What the Nova Scotia binding's files share: class lists, the described-by attribute, the first
 * control of a field, and a heading of any level.
 */
import type { View } from "../../../engine/form-engine/render/live/contract.js";
import type { Lit, TemplateResult } from "../../../engine/form-engine/render/live/lit.js";

/** A class list from names, skipping empty ones. */
export const cls = (...names: ReadonlyArray<string | false | undefined>): string => names.filter((name): name is string => typeof name === "string" && name !== "").join(" ");

/** `aria-describedby` from the ids that exist (the state's own list), else no attribute. */
export const describedByOf = (ids: readonly string[] | undefined): string | undefined => (ids !== undefined && ids.length > 0 ? ids.join(" ") : undefined);

/** The first control of a field, for a summary link. */
export function firstControl(field: HTMLElement): HTMLElement | null {
  return field.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea");
}

/** `spellcheck` as the attribute's text, or no attribute. */
export const spellcheckOf = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : String(value));

/** A heading of `level` (clamped to what HTML has), which may take focus (`tabindex="-1"`). */
export function headingAt(
  lit: Lit,
  level: number,
  props: { id?: string | undefined; className?: string; focusable?: boolean; journey?: boolean },
  content: View | string
): TemplateResult {
  const { html, ifDefined, nothing } = lit;
  const id = ifDefined(props.id);
  const className = ifDefined(props.className === undefined || props.className === "" ? undefined : props.className);
  const tabindex = props.focusable === true ? "-1" : nothing;
  const journey = props.journey === true ? "" : nothing;
  switch (Math.min(6, Math.max(1, Math.round(Number.isFinite(level) ? level : 1)))) {
    case 1:
      return html`<h1 id=${id} class=${className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h1>`;
    case 2:
      return html`<h2 id=${id} class=${className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h2>`;
    case 3:
      return html`<h3 id=${id} class=${className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h3>`;
    case 4:
      return html`<h4 id=${id} class=${className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h4>`;
    case 5:
      return html`<h5 id=${id} class=${className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h5>`;
    default:
      return html`<h6 id=${id} class=${className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h6>`;
  }
}
