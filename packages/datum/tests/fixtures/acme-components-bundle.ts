/**
 * The fixture component plugin's bundle entry (tests/fixtures/acme-components.ts), as a plugin
 * package's src/bundle.ts is: importing it registers the plugin into the page's shared plugin
 * registry, the way a page loading the package's bundle does.
 */
import { acmeComponentsPlugin } from "./acme-components.js";

import { plugins } from "../../src/plugin-bundle.js";

plugins.register(acmeComponentsPlugin);

export { plugins } from "../../src/plugin-bundle.js";
export * from "./acme-components.js";
