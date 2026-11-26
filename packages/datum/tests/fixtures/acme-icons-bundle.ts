/**
 * The fixture icon set's bundle entry (tests/fixtures/acme-icons.ts), as an icon package's
 * src/bundle.ts is: importing it makes the set the page's default, the way a page loading the
 * package's bundle before the builder script does.
 */
import { setDefaultIconSet } from "@argusvane/datum-engine";

import { ACME_ICONS } from "./acme-icons.js";

setDefaultIconSet(ACME_ICONS);

export * from "./acme-icons.js";
