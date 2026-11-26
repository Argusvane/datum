import { DATUM_ICON_NAMES, type DatumIconName } from "./icon-names.js";

/**
 * The engine's own drawings: what the chrome shows for any name the active icon set leaves
 * out, and everything it shows when no set is registered at all. Clean 24×24 stroke tracings
 * on `currentColor`, the same trade the GC Design System components make for their icon
 * vocabulary — no library, no webfont, so they work inside every shadow root and cost the
 * engine no dependency.
 *
 * Every chrome name has a drawing of its own. The palette names collapse onto one drawing per
 * kind here: an input box for a field, a cursor for an action, a framed box for a container, text
 * lines for content, a cube for the unknown. The form's bundle carries this file and never draws
 * a palette, so the drawing per palette name is the builder's own (`palette-glyphs.ts`), which
 * the palette uses for any name the page's icon set leaves out.
 */

/** One glyph as inner SVG markup; the shared wrapper supplies the viewBox and stroke defaults. */
export interface BuiltinGlyph {
  viewBox: string;
  body: string;
  attrs?: string | undefined;
}

const VIEWBOX = "0 0 24 24";

/** A filled dot for grips and palette wells — stroke-only dots render as specks. */
const dot = (cx: number, cy: number, r = 1.4): string =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

const CHROME: Record<Exclude<DatumIconName, `${"field" | "action" | "container" | "content"}-${string}` | "component">, string> = {
  undo: `<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>`,
  redo: `<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>`,
  "preview-width": `<path d="M3 12h18"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/>`,
  binding:
    `<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2v-1a2 2 0 0 1 2-2h1.5A3.5 3.5 0 0 0 21 12.5 9.5 9.5 0 0 0 12 3z"/>` +
    dot(7.5, 12, 1.3) +
    dot(10, 7.5, 1.3) +
    dot(15, 7.5, 1.3),
  "show-hidden": `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
  "hide-hidden": `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="m3 3 18 18"/>`,
  "drag-handle": dot(9, 6) + dot(15, 6) + dot(9, 12) + dot(15, 12) + dot(9, 18) + dot(15, 18),
  "form-panel": `<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>`,
  "chrome-panel": `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M7 6.5h6"/><path d="M7 17.5h4"/>`,
  "components-panel": `<rect x="3" y="13" width="8" height="8" rx="1.5"/><circle cx="17" cy="17" r="4"/><path d="m12 3 4.5 8h-9L12 3z"/>`,
  "properties-panel": `<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h13"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="19" cy="18" r="2"/>`,
  "outline-panel": `<path d="M4 5h16"/><path d="M4 5v14h4"/><path d="M9 12h11"/><path d="M9 19h11"/>`,
  "variables-panel": `<path d="M9 4H8a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1"/><path d="M15 4h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/>`,
  "view-panel": `<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18"/><path d="M8 20h8"/>`,
  "settings-panel": `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
  "translations-panel": `<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>`,
  // A checklist: a tick beside each of two lines.
  "fields-panel": `<path d="M4 6h10"/><path d="M4 12h10"/><path d="M4 18h6"/><path d="M17 15v6"/><path d="M14 18h6"/>`,
  "tests-panel": `<path d="m4 7 2 2 3.5-3.5"/><path d="m4 17 2 2 3.5-3.5"/><path d="M13 7h7"/><path d="M13 17h7"/>`,
  "document-menu": dot(5, 12) + dot(12, 12) + dot(19, 12),
  // The bar's file actions: a page with a plus, an open folder, an arrow down onto a tray.
  "new-form": `<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/><path d="M12 11v7M8.5 14.5h7"/>`,
  "open-form": `<path d="M3 19V6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v3"/><path d="M3 19l3-8h15l-3 8z"/>`,
  "download-form": `<path d="M12 3v11"/><path d="m7.5 9.5 4.5 4.5 4.5-4.5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>`,
  validate: `<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v2H9z"/><path d="m8.5 13 2.5 2.5 4.5-4.5"/>`,
  print: `<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>`,
  pdf: `<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/><path d="M9 13h6M9 17h6"/>`
};

/** One drawing per palette kind. */
const KINDS: Record<"field" | "action" | "container" | "content" | "component", string> = {
  field: `<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11v2"/>`,
  action: `<path d="m5 3 14 8-6 1.5L16 20l-2.5 1-3-7.5L6 18z"/>`,
  container: `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/>`,
  content: `<path d="M4 6h16M4 10h16M4 14h10M4 18h7"/>`,
  component: `<path d="M12 2.5 20 7v10l-8 4.5L4 17V7l8-4.5z"/><path d="m4 7 8 4.5L20 7M12 11.5v10"/>`
};

function kindOf(name: DatumIconName): keyof typeof KINDS {
  const prefix = name.split("-")[0];
  return prefix === "field" || prefix === "action" || prefix === "container" || prefix === "content"
    ? prefix
    : "component";
}

function glyphBody(name: DatumIconName): string {
  return name in CHROME ? CHROME[name as keyof typeof CHROME] : KINDS[kindOf(name)];
}

/** The stroke defaults every built-in drawing is traced for. */
export const BUILTIN_ICON_ATTRS =
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

/** Every name's built-in drawing, the shared wrapper's job left to the icon set that wraps them. */
export const BUILTIN_GLYPHS: Readonly<Record<DatumIconName, BuiltinGlyph>> = Object.fromEntries(
  DATUM_ICON_NAMES.map((name) => [name, { viewBox: VIEWBOX, body: glyphBody(name) }])
) as Record<DatumIconName, BuiltinGlyph>;
