import type { DatumIconName } from "../../render/icons/icon-names.js";

/**
 * The builder's own drawings for the palette: one per component kind the palette names, so a
 * rail of five fields reads as five different fields with no icon library on the page. The
 * built-in icon set, which the form's bundle carries too, has only one drawing per palette kind;
 * these live on the builder's side so a form never loads them. The page's icon set still wins
 * for any name it draws (the Font Awesome plugin draws them all).
 */

export const PALETTE_GLYPH_VIEWBOX = "0 0 24 24";

/** A filled dot: stroke-only dots render as specks. */
const dot = (cx: number, cy: number, r = 1.4): string => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

const BOX = `<rect x="3" y="4" width="18" height="16" rx="2"/>`;

/**
 * One drawing per palette name, in the built-in set's hand: 24×24 strokes on `currentColor`.
 * `action-button` and `component` are left out and keep the built-in set's drawing for their kind.
 */
export const PALETTE_GLYPH_BODIES: Partial<Record<Extract<DatumIconName, `${"field" | "action" | "container" | "content"}-${string}`>, string>> = {
  // Fields.
  "field-text": `<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11v2"/>`,
  "field-textarea": `${BOX}<path d="M7 9h10M7 13h6"/><path d="m14 17 3-3"/>`,
  "field-email": `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>`,
  "field-password": `<rect x="3" y="7" width="18" height="10" rx="2"/>` + dot(8, 12) + dot(12, 12) + dot(16, 12),
  "field-phone": `<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>`,
  "field-url": `<path d="M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`,
  "field-number": `<path d="M9 4 7 20M17 4l-2 16M4.5 9H20M4 15h15.5"/>`,
  "field-currency": `<path d="M12 2.5v19"/><path d="M16.5 8c-.6-1.5-2.3-2.5-4.5-2.5-2.5 0-4.5 1.3-4.5 3.3 0 4.2 9.5 2.2 9.5 6.4 0 2-2.1 3.3-5 3.3-2.4 0-4.3-1-5-2.7"/>`,
  "field-slider": `<path d="M3 12h3M12 12h9"/><circle cx="9" cy="12" r="3"/>`,
  "field-rating": `<path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6-4.5-4.2 6.1-.8L12 3z"/>`,
  "field-checkbox": `<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 3 3 5-6"/>`,
  "field-checkboxes": `<rect x="3" y="4" width="6" height="6" rx="1"/><rect x="3" y="14" width="6" height="6" rx="1"/><path d="M13 7h8M13 17h8"/>`,
  "field-toggle": `<rect x="2" y="7" width="20" height="10" rx="5"/>` + dot(16, 12, 2.2),
  "field-radio": `<circle cx="12" cy="12" r="9"/>` + dot(12, 12, 3.5),
  "field-select": `<rect x="3" y="6" width="18" height="12" rx="2"/><path d="m12.5 11 2.5 2.5 2.5-2.5"/>`,
  "field-date": `<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`,
  "field-time": `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  "field-datetime": `<path d="M21 11V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6"/><path d="M3 10h18M8 3v4M16 3v4"/><circle cx="17.5" cy="17.5" r="4"/><path d="M17.5 15.8v1.7l1.2.8"/>`,
  "field-file": `<path d="M12 15V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>`,
  "field-signature": `<path d="M3 17c2.5-5 4-8 5.5-8 2 0 .5 7 2.5 7 1.5 0 2-3 3.5-3 1 0 1 2 2.5 2H21"/><path d="M3 21h18"/>`,
  // Containers.
  "container-form": `<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>`,
  "container-fieldset": `<path d="M8 5H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/><path d="M10.5 5h3"/>`,
  "container-section": `${BOX}<path d="M3 10h18"/>`,
  "container-box": `<rect x="3" y="4" width="18" height="16" rx="2" stroke-dasharray="3 3"/>`,
  "container-tabs": `<path d="M3 9V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3"/><path d="M11 6h4a2 2 0 0 1 2 2v1"/><rect x="3" y="9" width="18" height="11" rx="2"/>`,
  "container-grid": `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>`,
  "container-row": `<rect x="3" y="8" width="7" height="8" rx="1"/><rect x="14" y="8" width="7" height="8" rx="1"/>`,
  "container-column": `<rect x="8" y="3" width="8" height="7" rx="1"/><rect x="8" y="14" width="8" height="7" rx="1"/>`,
  "container-table": `${BOX}<path d="M3 10h18M3 15h18M10 4v16"/>`,
  "container-repeater": `<rect x="3" y="3" width="18" height="5" rx="1"/><rect x="3" y="10" width="18" height="5" rx="1"/><path d="M12 17.5v4M10 19.5h4"/>`,
  "container-step": `<circle cx="5" cy="12" r="2.5"/><circle cx="12" cy="12" r="2.5"/><circle cx="19" cy="12" r="2.5"/><path d="M7.5 12h2M14.5 12h2"/>`,
  // Static content.
  "content-heading": `<path d="M6 5v14M18 5v14M6 12h12"/>`,
  "content-paragraph": `<path d="M4 6h16M4 10h16M4 14h10M4 18h7"/>`,
  "content-html": `<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>`,
  "content-divider": `<path d="M3 12h18M8 6h8M8 18h8"/>`,
  "content-image": `${BOX}<circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 18 5-5 4 4 3-3 4 4"/>`,
  "content-header": `${BOX}<path d="M3 9h18M7 6.5h6"/>`,
  "content-footer": `${BOX}<path d="M3 15h18M7 17.5h6"/>`,
  "content-link": `<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>`,
  "content-card": `${BOX}<rect x="6" y="7" width="12" height="5" rx="1"/><path d="M6 16h8"/>`,
  "content-details": `<path d="m4 7 3 3 3-3"/><path d="M14 8.5h6M4 15h16M4 19h10"/>`,
  "content-notice": `<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/>` + dot(12, 7.7, 1.2),
  "content-alert": `<path d="M12 3.5 22 20H2L12 3.5z"/><path d="M12 10v4"/>` + dot(12, 17, 1.1),
  "content-icon": `<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8"/>` + dot(9, 10, 1.1) + dot(15, 10, 1.1),
  "content-error-summary": `${BOX}<path d="M7 9v3"/>` + dot(7, 15.5, 1.1) + `<path d="M11 9.5h6M11 14.5h6"/>`
};
