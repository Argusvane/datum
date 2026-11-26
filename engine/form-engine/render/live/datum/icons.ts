/**
 * SVG glyphs as css `url("data:image/svg+xml,…")` values:
 * what the icon tokens carry (`icon-check`, `icon-radio`, `icon-chevron`, `icon-error`) and
 * what a host builds its own glyph from. The engine draws a glyph through `mask-image` with a
 * token-coloured `background-color`, so the SVG's own colour is irrelevant (only its alpha
 * counts) and the data URI need not know the palette, which a `background-image` icon could
 * not avoid.
 */

/** `svg` as a css `url()` data URI, encoded for a stylesheet: quotes, `#` and `<` become escapes; parentheses stay balanced. */
export function svgDataUri(svg: string): string {
  const encoded = encodeURIComponent(svg.replace(/\s+/g, " ").trim())
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  return `url("data:image/svg+xml,${encoded}")`;
}

const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** A tick in a 16-unit box, drawn as a stroke; the mask takes its alpha. */
export const CHECK_ICON: string = svgDataUri(
  `<svg ${NS} viewBox="0 0 16 16"><path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
);

/** A dot in a 16-unit box: a checked radio's mark. */
export const RADIO_ICON: string = svgDataUri(`<svg ${NS} viewBox="0 0 16 16"><circle cx="8" cy="8" r="4"/></svg>`);

/** A chevron pointing down in a 16-unit box: a select's affordance. */
export const CHEVRON_ICON: string = svgDataUri(
  `<svg ${NS} viewBox="0 0 16 16"><path d="M3 6l5 5 5-5" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
);

/** An exclamation mark in a ring, for the inline error's icon. */
export const ERROR_ICON: string = svgDataUri(
  `<svg ${NS} viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="#000" stroke-width="2"/><path d="M8 4.5v4.5" stroke="#000" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="11.75" r="1.1"/></svg>`
);
