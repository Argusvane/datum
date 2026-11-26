/**
 * Font Awesome as the chrome's default icon set: `@argusvane/datum-icons-fontawesome`
 * registered with `setDefaultIconSet` on load, built as `dist/datum-icons-fontawesome.js` (a
 * module) and `dist/datum-icons-fontawesome.iife.js` (a classic script,
 * `window.DatumIconsFontAwesome`). The builder bundle carries no icon library and draws with
 * the engine's own glyphs; a page that wants Font Awesome loads this *before*
 * `datum-builder.js`, so the set is registered when the elements upgrade — the default lives
 * on the page, not in either bundle — or sets `builder.icons = FONT_AWESOME_ICONS` on an
 * element already drawn. A page with a bundler registers the package itself:
 *
 *     import { setDefaultIconSet } from "@argusvane/datum-engine";
 *     import { FONT_AWESOME_ICONS } from "@argusvane/datum-icons-fontawesome";
 *     setDefaultIconSet(FONT_AWESOME_ICONS);
 * Built by `npm run build` (@argusvane/datum/scripts/plugin-build.mjs).
 */
import { setDefaultIconSet } from "@argusvane/datum-engine";
import { FONT_AWESOME_ICONS } from "./index.js";

setDefaultIconSet(FONT_AWESOME_ICONS);

export { FONT_AWESOME_GLYPHS, FONT_AWESOME_ICONS, FONT_AWESOME_ICONS_ID, fontAwesomeGlyph } from "./index.js";
export { BUILTIN_ICONS, defaultIconSet, setDefaultIconSet, type IconSet } from "@argusvane/datum-engine";
