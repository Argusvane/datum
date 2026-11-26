import { DATUM_ICON_NAMES, svgIconSet, type DatumIconName, type IconSet, type SvgGlyph } from "@argusvane/datum-engine";

/**
 * A fixture icon set for this package's own tests: what an icon package hands the builder,
 * made up, so a test of the chrome's icon seam has a set to register as the page's
 * default without depending on a real library (the real one is a package of its own under
 * plugins/). Every glyph is one filled square path marked `data-acme-icon`, so a test can tell
 * the set's drawing from the engine's.
 */
export const ACME_ICONS_ID = "acme-icons";

const SQUARE: SvgGlyph = { viewBox: "0 0 16 16", body: '<path fill="currentColor" data-acme-icon d="M1 1h14v14H1z"/>' };

export const ACME_ICONS: IconSet = svgIconSet(
  ACME_ICONS_ID,
  Object.fromEntries(DATUM_ICON_NAMES.map((name) => [name, SQUARE])) as Record<DatumIconName, SvgGlyph>
);
