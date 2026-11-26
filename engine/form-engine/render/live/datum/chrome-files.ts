/**
 * The parts of the Datum binding that draw the form's chrome and its non-field lines: the
 * chrome parts and the language switcher, the error summary, the host's receipt, the in-flight
 * line and the required note, plus the leaf components that hold no value or hold a file: buttons
 * and their group, the file field, the signature component and the static `html` and `image`
 * blocks; and the stylesheet and the form element's classes that style all of them.
 *
 * The result is a slice of a {@link LiveBinding}: the binding assembly spreads it in beside the
 * field and container adapters, and a host's `extendBinding` overrides wrap or patch single
 * entries. Every adapter answers its capabilities (contract.ts `CapabilityAnswers`); the
 * renderer's modules for the same parts (`buttons.ts`, `form-notices.ts`, `chrome.ts`,
 * `summary.ts`, `files.ts`) are listed as `features` by whoever mounts the form.
 */
import type { Adapter, AdapterEntry, LiveBinding } from "../contract.js";
import { createDatumButtonGroup, datumButton } from "./buttons.js";
import { createLanguageLinks, datumChrome, datumLanguageSwitcher, type LanguageLinksOptions } from "./chrome.js";
import { datumHtml, datumImage } from "./content.js";
import { datumCss, datumFormClass, type DatumCssOptions, type DatumDrawnControls } from "./css.js";
import type { DatumFieldOptionsInput } from "./field-scaffold.js";
import { createDatumFileAdapter } from "./file.js";
import { datumNotice, datumRequiredNote, datumStatus } from "./notice.js";
import { createDatumSignatureAdapter } from "./signature.js";
import { createDatumSummary, type DatumSummaryOptions } from "./summary.js";

/** What a host chooses about these parts of the Datum look. */
export interface DatumChromeFilesOptions {
  /** The order of a field's parts and the native-control choices, for the file and signature fields. */
  fields?: DatumFieldOptionsInput;
  /** The error summary's heading level and list. */
  summary?: DatumSummaryOptions;
  /** A button group drawn as a plain box or a list of items. */
  buttonGroup?: "div" | "list";
  /** The switcher drawn as links (GC Design System's toggle, Québec's side-by-side links) rather than a select. */
  languageLinks?: LanguageLinksOptions;
  /** The tokens, dark set and rules of the look (`datumCss`). */
  css?: DatumCssOptions;
  /** Drawn controls the form element opts into (`datumFormClass`). */
  drawn?: DatumDrawnControls;
}

/** The slice of the Datum binding these parts make. */
export type DatumChromeFilesParts = Required<
  Pick<LiveBinding, "components" | "chrome" | "languageSwitcher" | "summary" | "notice" | "status" | "requiredNote" | "css">
> & { formClass: (context: { colorScheme: "light" | "dark"; locale: string }) => string };

/** The component types these parts draw. */
export const DATUM_CHROME_FILES_TYPES: readonly string[] = ["button", "button-group", "file", "signature", "html", "image"];

export function createDatumChromeFiles(options: DatumChromeFilesOptions = {}): DatumChromeFilesParts {
  const components: Record<string, AdapterEntry> = {
    button: datumButton,
    "button-group": createDatumButtonGroup(options.buttonGroup !== undefined ? { buttonGroup: options.buttonGroup } : {}) as Adapter,
    file: createDatumFileAdapter(options.fields),
    signature: createDatumSignatureAdapter(options.fields),
    html: datumHtml,
    image: datumImage
  };
  return {
    components,
    chrome: datumChrome,
    languageSwitcher: options.languageLinks !== undefined ? createLanguageLinks(options.languageLinks) : datumLanguageSwitcher,
    summary: createDatumSummary(options.summary),
    notice: datumNotice,
    status: datumStatus,
    requiredNote: datumRequiredNote,
    css: datumCss(options.css),
    formClass: (context) => datumFormClass(context, options.drawn)
  };
}
