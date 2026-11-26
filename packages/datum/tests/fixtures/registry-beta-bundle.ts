/**
 * A second fixture plugin's bundle entry (the beta plugin of tests/fixtures/acme-theme.ts),
 * for the test that a second plugin's bundle registers into the same registry as the first:
 * importing it registers the plugin's one PDF theme, the assets base its own URL.
 */
import { betaThemePlugin } from "./acme-theme.js";

import { themes } from "../../src/themes.js";

themes.pdf.register(betaThemePlugin, { assetsBase: import.meta.url });

export { themes };
export * from "./acme-theme.js";
