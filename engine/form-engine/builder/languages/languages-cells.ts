/**
 * The rules of one cell of the Languages grid and of a language's coverage, in a leaf of their own: the Languages model builds its rows from them, and the
 * pointer line under a component's texts (the inspector, the Header & footer panel) counts with
 * them, so the two cannot disagree. The model itself is a shared lazy chunk the surface and the
 * agent load (check-bundles keeps it out of the builder entry); this leaf is what the eager
 * entry may carry.
 */
import type { LocalizationConfiguration } from "../../core/schema/types.js";
import {
  isStale,
  readCatalogText,
  readPrimaryTranslationText,
  readTranslation,
  resolveText,
  type FormTranslations,
  type TextAddress,
  type TranslationCatalog
} from "../../core/localization/translations.js";
import { effectiveDefaultLocale } from "../controller/language-edits.js";
import { addressKey } from "../controller/translation-rules.js";
import { supportedLocaleEntries, supportedLocaleOptions } from "../../core/localization/supported-locales.js";

/** What one cell of the grid is: the four states the filter and the coverage count. */
export type CellStatus = "missing" | "stale" | "overridden" | "present";

/** One language's cell of a row. */
export interface LanguagesCell {
  /** What the map stores for the text in this language; absent when it stores none. */
  text?: string;
  /** The stored text answered some other wording than the current default ("Source changed"). */
  stale: boolean;
  /** The host's catalog has a text for this address under the language's exact tag; it wins over `text` at run time. */
  overriddenBy?: "catalog";
  /** What the catalog says, when `overriddenBy` is set. */
  catalogText?: string;
  /**
   * What the catalog says under the language's primary subtag (`fr` for `fr-CA`) when it has no
   * text under the exact tag. The cell stays editable: the author's own text beats it at
   * run time, and until there is one the page shows this.
   */
  pageText?: string;
  /**
   * What the form's own map says under the language's primary subtag (`fr` for `fr-CA`) when the
   * cell has no text of its own and the catalog words it under neither tag: the text the form
   * shows the language. It makes the cell present, shown as served by `fallbackFrom`,
   * and the cell stays editable. It is not the cell's own wording: the default language promotion
   * and the "has wording" tests read `text` alone.
   */
  fallbackText?: string;
  /** Where `fallbackText` comes from: the form's own map (the page's catalog is `pageText`). */
  fallbackFrom?: "form";
}

/** What a cell is read from: the committed map and the page's catalog. */
export interface CellSources {
  translations: FormTranslations | undefined;
  catalog?: TranslationCatalog | undefined;
}

/** A sentinel no wording equals: `resolveText` answers it when the catalog has nothing. */
const NO_TEXT = "\u0000";

/**
 * What the catalog says for the address under the exact tag of `locale`: that always wins
 * over the map, so the cell is the page's and read-only.
 */
export function catalogExact(catalog: TranslationCatalog | undefined, locale: string, address: TextAddress): string | undefined {
  return catalog ? readCatalogText(catalog, locale, address) : undefined;
}

/**
 * What the catalog says under the primary subtag (`fr` for `fr-CA`), when the exact tag has
 * nothing. The map's own text for the exact tag beats it, so it never locks the cell.
 */
export function catalogPrimary(catalog: TranslationCatalog | undefined, locale: string, address: TextAddress): string | undefined {
  if (!catalog || readCatalogText(catalog, locale, address) !== undefined) {
    return undefined;
  }
  const resolved = resolveText(NO_TEXT, address, locale, { catalog });
  return resolved === NO_TEXT ? undefined : resolved;
}

/** The cell of `address` in `locale`: the map's entry, its staleness against `defaultText`, and what the catalog says. */
export function cellOf(sources: CellSources, locale: string, address: TextAddress, defaultText: string): LanguagesCell {
  const entry = readTranslation(sources.translations, locale, address);
  const text = entry !== undefined && entry.text.trim() !== "" ? entry.text : undefined;
  const cell: LanguagesCell = { stale: text !== undefined && isStale(entry!, defaultText) };
  if (text !== undefined) {
    cell.text = text;
  }
  const held = catalogExact(sources.catalog, locale, address);
  if (held !== undefined) {
    cell.overriddenBy = "catalog";
    cell.catalogText = held;
  } else {
    const served = catalogPrimary(sources.catalog, locale, address);
    if (served !== undefined) {
      cell.pageText = served;
    } else if (text === undefined) {
      // The catalog's primary subtag beats the map's, so the map's serves only when the catalog has none.
      const base = readPrimaryTranslationText(sources.translations, locale, address);
      if (base !== undefined) {
        cell.fallbackText = base;
        cell.fallbackFrom = "form";
      }
    }
  }
  return cell;
}

/**
 * The status of a cell: `overridden` when the page's catalog words it under the exact tag
 * (nothing typed matters), else `present` for a current text, `stale` for one that answered
 * other wording, `missing` for none. A pending edit (`typed`) counts as the author's word: typed
 * text is present, cleared text missing. A cell with no text of its own (stored or typed) that
 * the catalog words under the primary subtag, or the form's own map words under it (a regional
 * language its base language serves), is `present`: the form shows that wording.
 */
export function cellStatusOf(cell: LanguagesCell | undefined, typed?: string): CellStatus {
  if (cell?.overriddenBy === "catalog") {
    return "overridden";
  }
  const served = cell?.pageText !== undefined || cell?.fallbackText !== undefined;
  if (typed !== undefined) {
    return typed.trim() === "" ? (served ? "present" : "missing") : "present";
  }
  if (cell?.text === undefined) {
    return served ? "present" : "missing";
  }
  return cell.stale ? "stale" : "present";
}

export interface LanguageCoverage {
  /** Texts the form shows in the language: a current translation, or the page's catalog wording it. */
  translated: number;
  total: number;
  /** Texts with none, and texts whose translation answered other wording (these count as not translated). */
  missing: number;
  stale: number;
  overridden: number;
}

/** The coverage the statuses add up to: stale counts as missing for the percentage. */
export function coverageOf(statuses: Iterable<CellStatus>): LanguageCoverage {
  const out: LanguageCoverage = { translated: 0, total: 0, missing: 0, stale: 0, overridden: 0 };
  for (const status of statuses) {
    out.total += 1;
    if (status === "present" || status === "overridden") {
      out.translated += 1;
    }
    if (status === "overridden") {
      out.overridden += 1;
    } else if (status === "stale") {
      out.stale += 1;
    } else if (status === "missing") {
      out.missing += 1;
    }
  }
  return out;
}

/** The declared languages that get a cell each: every one but the language the default strings are written in. */
export function cellLocales(localization: LocalizationConfiguration | undefined): string[] {
  const source = effectiveDefaultLocale(localization);
  return supportedLocaleEntries(localization)
    .map((entry) => entry.code)
    .filter((code) => code !== source);
}

/** A text as the controller or a mode lists it: enough to count. */
export interface CountedText {
  address: TextAddress;
  default: string;
}

/**
 * The texts the Languages grid lists among `texts`: the same address once, and only a text with
 * some wording (a default, or a stored translation in any cell language); the rest is counted,
 * not listed, by the model. What the pointer line and the model both start from.
 */
export function wordedTexts<T extends CountedText>(texts: readonly T[], localization: LocalizationConfiguration | undefined, sources: CellSources): T[] {
  const locales = cellLocales(localization);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const text of texts) {
    const key = addressKey(text.address);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const worded = text.default.trim() !== "" || locales.some((locale) => cellOf(sources, locale, text.address, text.default).text !== undefined);
    if (worded) {
      out.push(text);
    }
  }
  return out;
}

/** How much of `texts` (already {@link wordedTexts}) says something in `locale`, the stored cells alone. */
export function textsCoverage(texts: readonly CountedText[], locale: string, sources: CellSources): LanguageCoverage {
  return coverageOf(texts.map((text) => cellStatusOf(cellOf(sources, locale, text.address, text.default))));
}

// --- the form's languages ------------------------------------------------------------------------

/** One language of the form as the Languages card lists it. */
export interface LanguageEntry {
  code: string;
  /** The label the form stores, `""` when none (the language's own name stands in). */
  storedLabel: string;
  /** What it is called: the stored label, else its own name, else its code. */
  label: string;
  isDefault: boolean;
}

export function languageEntries(config: LocalizationConfiguration | undefined): LanguageEntry[] {
  const options = supportedLocaleOptions(config);
  return supportedLocaleEntries(config).map((entry, index) => ({
    code: entry.code,
    storedLabel: entry.label ?? "",
    label: options[index]?.label ?? entry.code,
    isDefault: config?.defaultLocale === entry.code
  }));
}

/**
 * The languages the grid has a column for: every one but the language the default strings are
 * written in. That language has no translation of its own (its text is the string),
 * so there is nothing to type in a column for it.
 */
export function translationColumns(config: LocalizationConfiguration | undefined): LanguageEntry[] {
  const source = effectiveDefaultLocale(config);
  return languageEntries(config).filter((entry) => entry.code !== source);
}
