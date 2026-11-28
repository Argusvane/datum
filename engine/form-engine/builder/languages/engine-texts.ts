/**
 * The engine's own words as texts of the Languages grid: every form text key and every
 * validation code the engine words, with its English as the source. Their translations live in
 * the definition's map under kind `texts` (`texts › form › <key>`, `texts › messages › <code>`),
 * which the renderer reads before the English (`resolveFormText`, `defaultValidationMessage`).
 * A key whose English is empty (a marker the engine draws as nothing, such as `optional`) is not
 * listed: there is no text to translate.
 *
 * A leaf: the controller (eager) reads it to accept a `texts` edit, the Languages model (lazy)
 * to list the rows.
 */
import { DEFAULT_FORM_TEXTS } from "../../core/localization/form-texts.js";
import { addressOf, type TextAddress } from "../../core/localization/translations.js";
import { DEFAULT_VALIDATION_MESSAGES } from "../../core/localization/validation-messages.js";

/** One of the engine's own words, as the grid lists it. */
export interface EngineText {
  address: TextAddress;
  /** The form text key or the validation code. */
  key: string;
  /** Which table it belongs to: the form texts or the validation messages. */
  table: "form" | "messages";
  /** The engine's English: the source a translation is fingerprinted against. */
  default: string;
}

let listed: readonly EngineText[] | undefined;

/**
 * Form texts only the page can word, through the element's `texts`: the alert shown when the
 * definition itself did not arrive is drawn with no definition to read a translation from.
 */
const PAGE_ONLY_TEXTS: ReadonlySet<string> = new Set(["definitionUnavailable"]);

/** Every engine word with English to translate: the form texts in table order, then the validation messages. */
export function engineTexts(): readonly EngineText[] {
  if (listed === undefined) {
    const out: EngineText[] = [];
    for (const [key, text] of Object.entries(DEFAULT_FORM_TEXTS)) {
      if (text.trim() !== "" && !PAGE_ONLY_TEXTS.has(key)) {
        out.push({ address: addressOf.formText(key), key, table: "form", default: text });
      }
    }
    for (const [code, text] of Object.entries(DEFAULT_VALIDATION_MESSAGES)) {
      if (text.trim() !== "") {
        out.push({ address: addressOf.engineMessage(code), key: code, table: "messages", default: text });
      }
    }
    listed = out;
  }
  return listed;
}

/**
 * The counted texts, by base: every key the engine words as `<base>.other`, whose English each of
 * the base's other categories is fingerprinted against. `resolveFormTextPlural` reads
 * `<base>.<category>` for the count's CLDR category, so a language with more forms than English
 * (Polish `few` and `many`, Arabic `zero`, `two`) words them here.
 */
const PLURAL_BASES: readonly string[] = Object.keys(DEFAULT_FORM_TEXTS)
  .filter((key) => key.endsWith(".other"))
  .map((key) => key.slice(0, -".other".length));

/** The categories beyond `one` and `other` a count can take, in the order the plural rules list them. */
const EXTRA_PLURAL_CATEGORIES: readonly string[] = ["zero", "two", "few", "many"];

/** The extra categories `locale` uses for whole counts up to a thousand (French `many` starts at a million, so it is not one). */
function pluralCategoriesOf(locale: string): string[] {
  try {
    const rules = new Intl.PluralRules(locale.replace(/_/g, "-"));
    const used = new Set<string>();
    for (let n = 0; n <= 1000; n += 1) {
      used.add(rules.select(n));
    }
    return EXTRA_PLURAL_CATEGORIES.filter((category) => used.has(category));
  } catch {
    return [];
  }
}

function pluralText(base: string, category: string): EngineText {
  const key = `${base}.${category}`;
  return { address: addressOf.formText(key), key, table: "form", default: DEFAULT_FORM_TEXTS[`${base}.other` as keyof typeof DEFAULT_FORM_TEXTS] };
}

/** The counted texts' extra category rows a language needs (`countLeft.few` for Polish); none for English or French. */
export function enginePluralTexts(locale: string): readonly EngineText[] {
  const out: EngineText[] = [];
  for (const category of pluralCategoriesOf(locale)) {
    for (const base of PLURAL_BASES) {
      out.push(pluralText(base, category));
    }
  }
  return out;
}

/** Every counted text with every extra category: the addresses a translation edit may name, whatever the language. */
export function enginePluralAddresses(): readonly EngineText[] {
  return EXTRA_PLURAL_CATEGORIES.flatMap((category) => PLURAL_BASES.map((base) => pluralText(base, category)));
}

/** Whether `address` is one of the engine's own words (kind `texts`), whose source is English. */
export function isEngineTextAddress(address: TextAddress): boolean {
  return address.kind === "texts";
}
