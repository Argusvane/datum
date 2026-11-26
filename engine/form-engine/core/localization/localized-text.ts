import type { LocalizedText } from "../schema/contracts.js";

/**
 * Host-data text: the `LocalizedText` a host hands in — data-source items, the
 * renderer's own words (`FormTextCatalog`), binding labels, the parts it adds through
 * `<datum-form-renderer>.chrome`, its `messages` catalog. A form's own texts are plain strings
 * translated through the definition's map (`translations.ts`) and never come here. The tag
 * helpers are shared with that module, so both read a locale the same way.
 */

/** The BCP-47 primary subtag of a locale, e.g. `"en"` from `"en-CA"` (or `"en_CA"`). */
export function primaryLocaleSubtag(locale: string): string {
  const [primary] = locale.split(/[-_]/);
  return primary && primary.length > 0 ? primary : locale;
}

/** A tag in comparison form: `_` read as `-` (POSIX `fr_CA`), lower-cased (BCP-47 is case-insensitive). */
export function normalizeLocaleTag(tag: string): string {
  return tag.replace(/_/g, "-").toLowerCase();
}

/**
 * Resolves a host's {@link LocalizedText} to a display string for `locale`: a bare string as it
 * is; an object's exact locale, then its primary subtag's (so `"en-CA"` falls back to an `"en"`
 * entry), then its `default`. Tags compare case-insensitively with `_` read as `-`, and an empty
 * translation falls through. `undefined` only when `text` itself is.
 */
export function resolveLocalizedText(text: LocalizedText | undefined, locale: string): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (typeof text === "string") {
    return text;
  }
  return lookupLocale(text.locales, locale, "exact") ?? lookupLocale(text.locales, locale, "primary") ?? text.default;
}

/**
 * The non-empty entry of `entries` for `locale`: `exact` matches the whole tag (ignoring case
 * and `_` vs `-`), `primary` the primary subtag's entry. An empty string is an untranslated
 * row, not a text.
 */
function lookupLocale(
  entries: Readonly<Record<string, string | undefined>> | undefined,
  locale: string,
  mode: "exact" | "primary"
): string | undefined {
  if (!entries) {
    return undefined;
  }
  const normalized = normalizeLocaleTag(locale);
  const wanted = mode === "exact" ? normalized : primaryLocaleSubtag(normalized);
  if (mode === "primary" && wanted === normalized) {
    return undefined;
  }
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== "" && normalizeLocaleTag(key) === wanted) {
      return value;
    }
  }
  return undefined;
}

// Primary subtags of the locales in common use that are written right-to-left.
const RTL_PRIMARY_SUBTAGS = new Set([
  "ar", // Arabic
  "he", // Hebrew
  "fa", // Persian
  "ur", // Urdu
  "ps", // Pashto
  "sd", // Sindhi
  "ug", // Uyghur
  "yi", // Yiddish
  "dv", // Divehi
  "ku", // Kurdish (Sorani)
  "ckb" // Central Kurdish
]);

/** Whether `locale` (by its primary subtag) is written right-to-left. */
export function isRtlLocale(locale: string): boolean {
  return RTL_PRIMARY_SUBTAGS.has(primaryLocaleSubtag(locale).toLowerCase());
}
