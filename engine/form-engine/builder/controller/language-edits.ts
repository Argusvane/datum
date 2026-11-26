/**
 * The form's list of languages as pure arithmetic over `FormDefinition.localization`: which code may be added, the configuration with a language added, removed, relabelled,
 * renamed or made the default. The controller's `localizationActions` run these and move the
 * translations map with them in one undo step; the Languages workspace and the agent's
 * `languages` tool call the actions, never these directly, so a language list and the map
 * cannot drift apart.
 */
import { kernelStructureLocaleMax } from "../../core/expressions/definition-structure.js";
import { normalizeLocaleTag } from "../../core/localization/localized-text.js";
import { declaredDefaultLocale, localeDisplayName, supportedLocaleEntries } from "../../core/localization/supported-locales.js";
import type { LocalizationConfiguration } from "../../core/schema/types.js";

/** The locale the default strings are taken to be in: the form's default, else the runtime's `en`. */
export function effectiveDefaultLocale(config: LocalizationConfiguration | undefined): string {
  return declaredDefaultLocale(config) ?? "en";
}

/** Whether two codes name one language: tags read case-insensitively, `_` as `-`. */
function sameLocale(a: string, b: string): boolean {
  return normalizeLocaleTag(a) === normalizeLocaleTag(b);
}

/** BCP-47-shaped: a 2-3 letter primary subtag plus optional 2-8 character subtags. */
const LOCALE_CODE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Why a code cannot be a new language, as data: the Languages surface words it through its text
 * table (a host's catalog or the builder's own language), the agent's tool through
 * {@link languageCodeProblem}. `value` is the code as trimmed.
 */
export type LanguageCodeIssue = { code: "empty" } | { code: "pattern"; value: string } | { code: "tooLong"; value: string; max: number } | { code: "taken"; value: string };

/** Why `code` cannot be added as a new language, or `undefined` when it can. */
export function languageCodeIssue(code: string, config: LocalizationConfiguration | undefined): LanguageCodeIssue | undefined {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return { code: "empty" };
  }
  if (!LOCALE_CODE_PATTERN.test(trimmed)) {
    return { code: "pattern", value: trimmed };
  }
  // The same length the kernel's structure check and the agent's tool allow, so a code the
  // panel, a rename or an import accepts is one a host's Save accepts too.
  if (trimmed.length > kernelStructureLocaleMax()) {
    return { code: "tooLong", value: trimmed, max: kernelStructureLocaleMax() };
  }
  if (supportedLocaleEntries(config).some((entry) => entry.code.toLowerCase() === trimmed.toLowerCase())) {
    return { code: "taken", value: trimmed };
  }
  return undefined;
}

/** {@link languageCodeIssue} in English, for the agent's tool, whose messages are English. */
export function languageCodeProblem(code: string, config: LocalizationConfiguration | undefined): string | undefined {
  const issue = languageCodeIssue(code, config);
  return issue === undefined ? undefined : languageCodeIssueEnglish(issue);
}

function languageCodeIssueEnglish(issue: LanguageCodeIssue): string {
  switch (issue.code) {
    case "empty":
      return "Enter a language code (e.g. fr-CA).";
    case "pattern":
      return `"${issue.value}" is not a language code (e.g. "en" or "fr-CA").`;
    case "tooLong":
      return `"${issue.value}" is longer than ${issue.max} characters.`;
    case "taken":
      return `"${issue.value}" is already one of the form's languages.`;
  }
}

/**
 * The configuration with `code` added, under the label typed, else the language's own name
 * (none when Intl cannot name it). The first language added becomes the default.
 */
export function withLanguageAdded(config: LocalizationConfiguration | undefined, code: string, label: string): LocalizationConfiguration {
  const current = config ?? {};
  const supported = supportedLocaleEntries(current);
  const trimmedCode = code.trim();
  const suggested = localeDisplayName(trimmedCode);
  const name = label.trim() || (suggested !== trimmedCode ? suggested : "");
  return {
    ...current,
    supportedLocales: [...supported, name ? { code: trimmedCode, label: name } : { code: trimmedCode }],
    ...(current.defaultLocale === undefined && supported.length === 0 ? { defaultLocale: trimmedCode } : {})
  };
}

/** The configuration without `code`; a default that goes follows to the first language left. */
export function withLanguageRemoved(config: LocalizationConfiguration | undefined, code: string): LocalizationConfiguration {
  const current = config ?? {};
  const supported = supportedLocaleEntries(current).filter((entry) => entry.code !== code);
  const next: LocalizationConfiguration = { ...current, supportedLocales: supported };
  if (next.defaultLocale !== undefined && sameLocale(next.defaultLocale, code)) {
    const first = supported[0];
    if (first) {
      next.defaultLocale = first.code;
    } else {
      delete next.defaultLocale;
    }
  }
  return next;
}

/** The configuration with `code` named `label` (blank: unnamed, its own name stands in). */
export function withLanguageLabel(config: LocalizationConfiguration | undefined, code: string, label: string): LocalizationConfiguration {
  const current = config ?? {};
  return {
    ...current,
    supportedLocales: supportedLocaleEntries(current).map((entry) => (entry.code === code ? (label.trim() ? { code, label: label.trim() } : { code }) : entry))
  };
}

/** The configuration starting in `code`. */
export function withDefaultLanguage(config: LocalizationConfiguration | undefined, code: string): LocalizationConfiguration {
  return { ...(config ?? {}), defaultLocale: code };
}

/** Why `to` cannot replace the code `from`, or `undefined` when it can: the code is checked as a new one is, among the others. */
export function languageRenameIssue(from: string, to: string, config: LocalizationConfiguration | undefined): LanguageCodeIssue | undefined {
  if (to.trim() === from) {
    return undefined;
  }
  return languageCodeIssue(to, withLanguageRemoved(config, from));
}

/** {@link languageRenameIssue} in English, for the agent's tool. */
export function languageRenameProblem(from: string, to: string, config: LocalizationConfiguration | undefined): string | undefined {
  const issue = languageRenameIssue(from, to, config);
  return issue === undefined ? undefined : languageCodeIssueEnglish(issue);
}

/**
 * The configuration with the language `from` under the code `to`, keeping its label and its
 * place in the list, and as the default when it was. The translations written under the old
 * code move with it (`BuilderController.localizationActions.renameLocale`).
 */
export function withLanguageRenamed(config: LocalizationConfiguration | undefined, from: string, to: string): LocalizationConfiguration {
  const current = config ?? {};
  const code = to.trim();
  const entries = supportedLocaleEntries(current);
  return {
    ...current,
    supportedLocales: entries.map((entry) => (entry.code === from ? { ...entry, code } : entry)),
    // The implicit default ("en" when none is written) renames with the language too, so the
    // form does not keep starting in a code it no longer declares.
    ...(entries.some((entry) => entry.code === from) && sameLocale(effectiveDefaultLocale(current), from) ? { defaultLocale: code } : {})
  };
}

/** The language the form starts in once `code` is removed (the first left when it was the default), or `undefined` when none changes or none is left. */
export function defaultAfterRemoval(config: LocalizationConfiguration | undefined, code: string): string | undefined {
  if (!sameLocale(effectiveDefaultLocale(config), code)) {
    return undefined;
  }
  return supportedLocaleEntries(config).find((entry) => entry.code !== code)?.code;
}
