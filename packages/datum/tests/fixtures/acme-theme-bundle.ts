/**
 * The fixture plugin's bundle entry (tests/fixtures/acme-theme.ts), as the bundle entry of a package
 * that ships builder and PDF themes is: importing it registers the plugin's themes into the page's shared registries,
 * the assets base its own URL.
 */
import { acmeThemePlugin } from "./acme-theme.js";

import { themes } from "../../src/themes.js";

themes.pdf.register(acmeThemePlugin, { assetsBase: import.meta.url });
themes.builder.register(acmeThemePlugin, { assetsBase: import.meta.url });

export { themes };
export * from "./acme-theme.js";
