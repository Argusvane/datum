import type { LocalizationConfiguration, SupportedLocale } from "../schema/types.js";

/** A locale as a switcher offers it: the code to switch to and the text to show for it. */
export interface LocaleOption {
  code: string;
  label: string;
}

/**
 * A language's name in its own language — "English", "Français (Canada)", "العربية (مصر)" —
 * which is how a switcher must name each choice: a person looking for their language reads
 * it, not the current page's word for it. Falls back to the code itself where `Intl` cannot
 * name it (an unknown tag, a runtime without locale data).
 */
export function localeDisplayName(code: string): string {
  try {
    // `fallback: "none"` reports an unnamed tag as undefined; the default would synthesize
    // "zz (Unknown Region)" from the pieces, which is no name at all.
    const name = new Intl.DisplayNames([code], { type: "language", fallback: "none" }).of(code);
    if (!name || name === code) {
      return code;
    }
    // Intl gives "français"; as a label it reads as a name, so it takes a capital.
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
}

/**
 * One `supportedLocales` entry as `{ code, label? }`: the code is trimmed, and a blank label is
 * dropped rather than stored. A non-blank label is kept exactly as written — this is a
 * *reader*, and the builder's properties panel repaints from what it reads on every keystroke,
 * so trimming here would eat the space an author has just typed before the next word. The
 * builder trims on Save.
 */
export function normalizeSupportedLocale(entry: SupportedLocale): SupportedLocale {
  // A definition is data from anywhere: an entry that is not a record, or whose code is not
  // text, names no language. It reads as a blank code, which the lists drop.
  if (typeof entry !== "object" || entry === null || Array.isArray(entry) || typeof entry.code !== "string") {
    return { code: "" };
  }
  const code = entry.code.trim();
  const label = entry.label;
  return typeof label === "string" && label.trim().length > 0 ? { code, label } : { code };
}

/**
 * The form's `defaultLocale` as text: trimmed, and `undefined` when it is absent, blank or not
 * a string (a block from outside the builder can hold anything), so a reader never calls a
 * string method on a number.
 */
export function declaredDefaultLocale(localization: LocalizationConfiguration | undefined): string | undefined {
  const value: unknown = localization?.defaultLocale;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The form's supported locales as objects, blank codes dropped; `[]` when none are declared. */
export function supportedLocaleEntries(
  localization: LocalizationConfiguration | undefined
): SupportedLocale[] {
  const listed: unknown = localization?.supportedLocales;
  if (!Array.isArray(listed)) {
    return [];
  }
  return listed
    .map(normalizeSupportedLocale)
    .filter((entry) => entry.code.length > 0);
}

/** The codes alone — what `setLocale` checks a request against. */
export function supportedLocaleCodes(localization: LocalizationConfiguration | undefined): string[] {
  return supportedLocaleEntries(localization).map((entry) => entry.code);
}

/**
 * The option list every switcher offers, in the form's order: each locale under its authored
 * label, else named in its own language by {@link localeDisplayName} (else the code). The one
 * place the label of a locale is decided, so the builder canvas, the inspector and the
 * rendered switcher all agree.
 */
export function supportedLocaleOptions(
  localization: LocalizationConfiguration | undefined
): LocaleOption[] {
  return supportedLocaleEntries(localization).map((entry) => ({
    code: entry.code,
    label: entry.label ?? localeDisplayName(entry.code)
  }));
}

function canonicalTag(tag: string): string {
  return tag.trim().replace(/_/g, "-").toLowerCase();
}

const REGION_SCRIPTS: Record<string, string> = { "zh-tw": "hant", "zh-hk": "hant", "zh-mo": "hant", "zh-cn": "hans", "zh-sg": "hans" };

/** The script a canonical tag spells in: its explicit script subtag, else the one zh regions imply. */
function scriptOf(tag: string): string | undefined {
  const parts = tag.split("-");
  const explicit = parts.slice(1).find((part) => /^[a-z]{4}$/.test(part));
  if (explicit) {
    return explicit;
  }
  const region = parts.slice(1).find((part) => /^[a-z]{2}$/.test(part));
  return region ? REGION_SCRIPTS[`${parts[0]}-${region}`] : undefined;
}

/** Whether two canonical tags can share a reader: no script is known for both, or they agree. */
function sameScript(a: string, b: string): boolean {
  const first = scriptOf(a);
  const second = scriptOf(b);
  return first === undefined || second === undefined || first === second;
}

/**
 * Settles which of a form's `supported` locales a host's request means (the attribute
 * path; the in-form switcher and `FormRuntime.setLocale` stay strict). Each requested tag, in
 * order, is tried three ways: a case-insensitive exact match ("_" read as "-", so "fr_CA" is
 * "fr-CA"), then its primary subtag against a plain supported code ("fr-CA" meets "fr"), then
 * any supported code sharing that primary subtag ("fr" meets "fr-CA", "fr-CA" meets "fr-FR"),
 * the first declared winning, except across scripts (zh-TW never meets zh-CN, sr-Latn never sr-Cyrl). A tag nothing matches falls through to the next; when none
 * match, `defaultLocale` is the answer. The result is always the code as the form declared
 * it, never the requested spelling; `undefined` when nothing matched and there is no default.
 */
export function negotiateLocale(
  requested: string | readonly string[],
  supported: readonly string[],
  defaultLocale?: string
): string | undefined {
  const tags = typeof requested === "string" ? [requested] : requested;
  const declared = supported.map((code) => ({ code, tag: canonicalTag(code) }));
  for (const raw of tags) {
    const tag = canonicalTag(raw);
    if (tag.length === 0 || tag === "*") {
      continue;
    }
    const primary = tag.split("-")[0]!;
    const found =
      declared.find((entry) => entry.tag === tag) ??
      declared.find((entry) => entry.tag === primary) ??
      declared.find((entry) => entry.tag.split("-")[0] === primary && sameScript(entry.tag, tag));
    if (found) {
      return found.code;
    }
  }
  return defaultLocale;
}
