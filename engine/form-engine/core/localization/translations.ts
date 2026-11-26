import type { ComponentNode } from "../schema/types.js";
import { normalizeLocaleTag, primaryLocaleSubtag } from "./localized-text.js";

/**
 * A form's translations: every text a definition authors is a plain string in the
 * form's default language, and `FormDefinition.translations` holds what the other languages say,
 * as one map — locale, then kind, then the owner's id, then a tree of property segments whose
 * leaves are entries. This module is the only reader and writer of that map and of the host's
 * catalog of the same shape; nothing else walks either by hand.
 *
 * Every function is pure: a write returns a copy (sharing what it did not touch) and leaves its
 * input alone, and an operation that changes nothing returns its input as it was, so a caller
 * can tell "no change" by identity. A segment that is not {@link isSafeSegment} is refused on
 * every route in, since a key such as `__proto__` written through a plain object
 * would reach its prototype.
 */

/**
 * The fixed vocabulary of the map's second level. A user-chosen name only ever appears below it.
 * `texts` holds the engine's own words in other languages: owner {@link TEXTS_FORM_OWNER} keyed
 * by form text key (`EngineFormTextKey`), owner {@link TEXTS_MESSAGES_OWNER} keyed by validation
 * code. Their source is the engine's English, not a string of the definition.
 */
export type TranslationKind = "form" | "components" | "chrome" | "journeys" | "pdf" | "texts";

export const TRANSLATION_KINDS: readonly TranslationKind[] = ["form", "components", "chrome", "journeys", "pdf", "texts"];

/** The `texts` owner whose entries are the form texts, by key (`summaryHeading`, `dataGridAdd`). */
export const TEXTS_FORM_OWNER = "form";

/** The `texts` owner whose entries are the validation messages, by code (`required`, `date.min`). */
export const TEXTS_MESSAGES_OWNER = "messages";

/**
 * One translation: its text, and `source`, the {@link sourceHash} of the default-language string
 * it answered. An entry whose `source` differs from the hash of the current default is stale
 * ("Source changed") until the author confirms or edits it.
 */
export interface TranslationEntry {
  text: string;
  source: string;
}

export type TranslationTree = { [segment: string]: TranslationEntry | TranslationTree };

export interface LocaleTranslations {
  form?: TranslationTree;
  components?: Record<string, TranslationTree>;
  chrome?: Record<string, TranslationTree>;
  journeys?: Record<string, TranslationTree>;
  pdf?: Record<string, TranslationTree>;
  texts?: Record<string, TranslationTree>;
}

/** By locale code, as the form's `localization.supportedLocales` names it. */
export type FormTranslations = Record<string, LocaleTranslations>;

/** The host's catalog has the map's shape with string leaves: a host has no fingerprints. */
export type CatalogTree = { [segment: string]: string | CatalogTree };

export interface LocaleCatalog {
  form?: CatalogTree;
  components?: Record<string, CatalogTree>;
  chrome?: Record<string, CatalogTree>;
  journeys?: Record<string, CatalogTree>;
  pdf?: Record<string, CatalogTree>;
  texts?: Record<string, CatalogTree>;
}

/** By locale, host data: an entry here overrides the form's own for the same address. */
export type TranslationCatalog = Record<string, LocaleCatalog>;

/** Where a text lives. `owner` is absent for kind `form`. `path` never holds an index. */
export interface TextAddress {
  kind: TranslationKind;
  owner?: string;
  path: readonly string[];
}

/** A subtree of the map: everything under an owner, or under an address prefix (an option, a message, a page). */
export interface TranslationPrefix {
  kind: TranslationKind;
  owner?: string;
  path?: readonly string[];
}

/** What {@link resolveText} reads besides the default: the definition's map and the host's catalog. */
export interface TextSources {
  translations?: FormTranslations | undefined;
  catalog?: TranslationCatalog | undefined;
}

/** By locale, a text per key: one table of a {@link LanguagePack}. */
export type LanguagePackTable = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Words a binding ships for the engine's own texts in the languages it supports: `texts` by
 * form text key, `messages` by validation code, each by locale. Read after the form's `texts`
 * translations and before the engine's English. The engine holds no pack of its own.
 */
export interface LanguagePack {
  texts?: LanguagePackTable | undefined;
  messages?: LanguagePackTable | undefined;
}

/**
 * Where the engine's own words come from before its English: the form's `texts` translations
 * (the host catalog's over the definition's map, as {@link resolveText} reads them), then `pack`.
 */
export interface EngineWordSources extends TextSources {
  pack?: LanguagePack | undefined;
}

// --- Fingerprints and guards -------------------------------------------------------------

/**
 * The fingerprint of a default-language string: FNV-1a 32-bit over its UTF-16 code units, in
 * base 36 (the hash the builder's source-change tracker used, so its values carry over).
 */
export function sourceHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** A key the map may hold: a non-empty string that is not `__proto__`, `constructor` or `prototype`. */
export function isSafeSegment(segment: unknown): segment is string {
  return typeof segment === "string" && segment.length > 0 && !UNSAFE_SEGMENTS.has(segment);
}

/**
 * Whether `value` is the shape of a {@link sourceHash}: base 36, at most eight characters (a
 * 32-bit hash is seven). What a file or a clipboard says an entry answered is held to it, so a
 * stray cell cannot put a long string into the definition as a fingerprint.
 */
export function isSourceHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-z]{1,8}$/.test(value);
}

/**
 * What an entry's `source` is set to when the one it was given is not a fingerprint: a value no
 * {@link sourceHash} can equal (it is not base 36), so the entry is kept and reads "Source
 * changed" until the author confirms it, and a long string never enters the definition.
 */
export const STALE_SOURCE = "?";

/** `source` when it is a fingerprint, else the {@link STALE_SOURCE} marker. */
function boundedSource(source: unknown): string {
  return isSourceHash(source) ? source : STALE_SOURCE;
}

export function isTranslationEntry(value: unknown): value is TranslationEntry {
  return isRecord(value) && typeof value.text === "string" && typeof value.source === "string";
}

/** Whether `entry` answered some other wording than `defaultText`. */
export function isStale(entry: TranslationEntry, defaultText: string): boolean {
  return entry.source !== sourceHash(defaultText);
}

// --- Addresses ---------------------------------------------------------------------------

/** The address builders, one per shape of text. */
export const addressOf = {
  /** A property of the form itself: `title`, `description`. */
  form(property: string): TextAddress {
    return { kind: "form", path: [property] };
  },
  /** A printed form's header or footer slot (`root.configuration.print.<band>.<slot>`). */
  printSlot(band: "header" | "footer", slot: "start" | "end"): TextAddress {
    return { kind: "form", path: ["print", band, slot] };
  },
  /** A validation message the form authors for every field (`root.configuration.messages`). */
  formMessage(code: string): TextAddress {
    return { kind: "form", path: ["messages", code] };
  },
  component(id: string, property: string): TextAddress {
    return { kind: "components", owner: id, path: [property] };
  },
  /** An inline option's text, by the option's value (never its index). */
  option(id: string, value: string, property: "label" | "description"): TextAddress {
    return { kind: "components", owner: id, path: ["options", value, property] };
  },
  /** A component's own validation message, by its code. */
  message(id: string, code: string): TextAddress {
    return { kind: "components", owner: id, path: ["messages", code] };
  },
  /** A header or footer part's text, by the part's id (no region level: ids are unique across both). */
  chrome(partId: string, property: string): TextAddress {
    return { kind: "chrome", owner: partId, path: [property] };
  },
  journey(journeyId: string, property: string): TextAddress {
    return { kind: "journeys", owner: journeyId, path: [property] };
  },
  journeyPage(journeyId: string, pageId: string, property: string): TextAddress {
    return { kind: "journeys", owner: journeyId, path: ["pages", pageId, property] };
  },
  /** A PDF layout's text; the path segments come from the layout's own ids and property names. */
  pdf(layoutId: string, path: readonly string[]): TextAddress {
    return { kind: "pdf", owner: layoutId, path: [...path] };
  },
  /** One of the engine's form texts in another language, by its key (`summaryHeading`). */
  formText(key: string): TextAddress {
    return { kind: "texts", owner: TEXTS_FORM_OWNER, path: [key] };
  },
  /** The engine's validation message for `code` in another language. */
  engineMessage(code: string): TextAddress {
    return { kind: "texts", owner: TEXTS_MESSAGES_OWNER, path: [code] };
  }
};

/**
 * The address of a text named the way the builder names it: `label`, `options.2.label`,
 * `messages.required`, `print.note`, `tabs.1.label` on a component (a `step` container's `label` is
 * the plain one-segment case); `title`, `messages.required`, `chrome.header.0.text` (or
 * `chrome.header.0.parts.1.text` inside a group) on the form root. An option index becomes the
 * option's `value`, a tab index the tab's `id` and a part index the part's `id`, read from `node`, so nothing written to the
 * map ever holds an index. Everything after `messages.` is the code, dots included.
 * `undefined` for a path that names no text, an index that is out of range, or an id or value
 * the map may not hold.
 */
export function addressOfPropertyPath(node: ComponentNode, propertyPath: string, isRoot: boolean): TextAddress | undefined {
  const configuration = isRecord(node.configuration) ? node.configuration : {};
  if (propertyPath.startsWith("messages.")) {
    const code = propertyPath.slice("messages.".length);
    if (isRoot) {
      return safeAddress(addressOf.formMessage(code));
    }
    return safeAddress(addressOf.message(node.id, code));
  }
  const segments = propertyPath.split(".");
  if (segments.length === 1) {
    // A list or map of texts is not itself a text.
    if (CONTAINER_PROPERTIES.has(propertyPath)) {
      return undefined;
    }
    return safeAddress(isRoot ? addressOf.form(propertyPath) : addressOf.component(node.id, propertyPath));
  }
  if (!isRoot && segments.length === 3 && segments[0] === "options") {
    const property = segments[2];
    if (property !== "label" && property !== "description") {
      return undefined;
    }
    const option = itemAt(configuration.options, segments[1]!);
    if (!isRecord(option) || typeof option.value !== "string") {
      return undefined;
    }
    return safeAddress(addressOf.option(node.id, option.value, property));
  }
  if (!isRoot && segments.length === 2 && segments[0] === "print" && segments[1] === "note") {
    // The note printed beside a hidden field: nested under the component's id, where the renderer resolves it.
    return safeAddress({ kind: "components", owner: node.id, path: ["print", "note"] });
  }
  if (isRoot && segments.length === 3 && segments[0] === "print") {
    // A printed form's running header and footer slots, where the print model resolves them.
    const band = segments[1];
    const slot = segments[2];
    return (band === "header" || band === "footer") && (slot === "start" || slot === "end") ? addressOf.printSlot(band, slot) : undefined;
  }
  if (!isRoot && segments.length === 3 && segments[0] === "tabs" && segments[2] === "label") {
    // A tab caption is named by the tab's id, like an option by its value.
    const tab = itemAt(configuration.tabs, segments[1]!);
    if (!isRecord(tab) || typeof tab.id !== "string") {
      return undefined;
    }
    return safeAddress({ kind: "components", owner: node.id, path: ["tabs", tab.id, "label"] });
  }
  if (isRoot && segments[0] === "chrome" && segments.length >= 4) {
    const chrome = configuration.chrome;
    const region = segments[1]!;
    if (!isRecord(chrome) || (region !== "header" && region !== "footer")) {
      return undefined;
    }
    // chrome.<region>.<i>(.parts.<j>)*.<property>: walk the indices to the part, then name it by id.
    let part = itemAt(chrome[region], segments[2]!);
    let at = 3;
    while (segments[at] === "parts" && at + 2 < segments.length) {
      part = isRecord(part) ? itemAt(part.parts, segments[at + 1]!) : undefined;
      at += 2;
    }
    if (at !== segments.length - 1 || !CHROME_TEXT_PROPERTIES.has(segments[at]!) || !isRecord(part) || typeof part.id !== "string") {
      return undefined;
    }
    return safeAddress(addressOf.chrome(part.id, segments[at]!));
  }
  return undefined;
}

const CONTAINER_PROPERTIES: ReadonlySet<string> = new Set(["options", "messages", "chrome", "print", "tabs"]);

/** The members of a chrome part that hold text (form-chrome.ts `ChromeTextProperty`). */
const CHROME_TEXT_PROPERTIES: ReadonlySet<string> = new Set(["label", "src", "alt", "href", "text", "html"]);

/** The list's entry at a decimal index, or `undefined` for a non-list, a non-index or one out of range. */
function itemAt(list: unknown, index: string): unknown {
  if (!Array.isArray(list) || !/^(0|[1-9][0-9]*)$/.test(index)) {
    return undefined;
  }
  const at = Number(index);
  return at < list.length ? list[at] : undefined;
}

function isSafeAddress(address: TextAddress | TranslationPrefix): boolean {
  if (!TRANSLATION_KINDS.includes(address.kind)) {
    return false;
  }
  if (address.kind === "form" ? address.owner !== undefined : !isSafeSegment(address.owner)) {
    return false;
  }
  return (address.path ?? []).every(isSafeSegment);
}

function safeAddress(address: TextAddress): TextAddress | undefined {
  return isSafeAddress(address) && address.path.length > 0 ? address : undefined;
}

/** The key path from a locale's object down to the address: kind, owner (none for `form`), then the property segments. */
function keyPath(address: TextAddress | TranslationPrefix): string[] {
  const path = [...(address.path ?? [])];
  return address.kind === "form" ? ["form", ...path] : [address.kind, address.owner as string, ...path];
}

// --- Reading -----------------------------------------------------------------------------

/** The value at `keys` under `root`, by own properties only (an option named `toString` is not the method). */
function nodeAt(root: unknown, keys: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const key of keys) {
    if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, key)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}

/** The entry at `address` in `locale` (the map's key exactly as written), or `undefined`. */
export function readTranslation(map: FormTranslations | undefined, locale: string, address: TextAddress): TranslationEntry | undefined {
  if (!map || !isSafeSegment(locale) || !isSafeAddress(address) || address.path.length === 0) {
    return undefined;
  }
  const value = nodeAt(map, [locale, ...keyPath(address)]);
  return isTranslationEntry(value) ? value : undefined;
}

/**
 * The host catalog's text at `address` for `locale`, or `undefined`. The locale matches the
 * catalog's key ignoring case and `_` against `-` (a host's spelling need not be the form's);
 * an empty string is no text.
 */
export function readCatalogText(catalog: TranslationCatalog | undefined, locale: string, address: TextAddress): string | undefined {
  if (!catalog || !isSafeAddress(address) || address.path.length === 0) {
    return undefined;
  }
  return catalogText(catalog, matchLocaleKey(catalog, locale, "exact"), address);
}

/**
 * The form's own text at `address` under the primary subtag of `locale` (`fr` for `fr-CA`), the
 * fourth rung of {@link lookupText}: what the form shows a regional language that has no text of
 * its own. `undefined` when `locale` is already a primary tag or the base language has none.
 */
export function readPrimaryTranslationText(map: FormTranslations | undefined, locale: string, address: TextAddress): string | undefined {
  if (!map || !isSafeAddress(address) || address.path.length === 0) {
    return undefined;
  }
  return mapText(map, matchLocaleKey(map, locale, "primary"), address);
}

function catalogText(catalog: TranslationCatalog, key: string | undefined, address: TextAddress): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  const value = nodeAt(catalog, [key, ...keyPath(address)]);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function mapText(map: FormTranslations, key: string | undefined, address: TextAddress): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  const value = nodeAt(map, [key, ...keyPath(address)]);
  return isTranslationEntry(value) && value.text.trim() !== "" ? value.text : undefined;
}

/**
 * Which of `holder`'s locale keys serves `locale`: `exact` the whole tag, `primary` its primary
 * subtag's (none when the tag is already primary). Tags compare case-insensitively with `_` read
 * as `-`; a key spelled exactly as asked wins over another spelling of the same tag.
 */
function matchLocaleKey(holder: Record<string, unknown>, locale: string, mode: "exact" | "primary"): string | undefined {
  const normalized = normalizeLocaleTag(locale);
  const wanted = mode === "exact" ? normalized : primaryLocaleSubtag(normalized);
  if (mode === "primary" && wanted === normalized) {
    return undefined;
  }
  if (mode === "exact" && Object.prototype.hasOwnProperty.call(holder, locale) && isSafeSegment(locale)) {
    return locale;
  }
  for (const key of Object.keys(holder)) {
    if (isSafeSegment(key) && normalizeLocaleTag(key) === wanted) {
      return key;
    }
  }
  return undefined;
}

/**
 * The text to show for `address` in `locale`: the host catalog's exact locale, the
 * map's exact locale, the catalog's primary subtag, the map's primary subtag, then `defaultText`.
 * So `fr` serves `fr-CA`, but the map's own `fr-CA` beats a catalog's `fr`. An empty string at
 * any step is no text and falls through. A stale entry still resolves: staleness is the
 * author's concern, not the reader's.
 */
export function resolveText(defaultText: string, address: TextAddress, locale: string, sources: TextSources): string {
  return lookupText(address, locale, sources) ?? defaultText;
}

/** {@link resolveText} without a default: the text the sources hold for `address` in `locale`, or `undefined`. */
export function lookupText(address: TextAddress, locale: string, sources: TextSources): string | undefined {
  const { translations, catalog } = sources;
  if ((!translations && !catalog) || !isSafeAddress(address) || address.path.length === 0) {
    return undefined;
  }
  return (
    (catalog ? catalogText(catalog, matchLocaleKey(catalog, locale, "exact"), address) : undefined) ??
    (translations ? mapText(translations, matchLocaleKey(translations, locale, "exact"), address) : undefined) ??
    (catalog ? catalogText(catalog, matchLocaleKey(catalog, locale, "primary"), address) : undefined) ??
    (translations ? mapText(translations, matchLocaleKey(translations, locale, "primary"), address) : undefined)
  );
}

/**
 * The pack table's text for `key` in `locale`: the whole tag, then its primary subtag (tags
 * compared as {@link resolveText} compares them). Own properties only; an empty text is none.
 */
export function packText(table: LanguagePackTable | undefined, locale: string, key: string): string | undefined {
  if (!isRecord(table) || !isSafeSegment(key)) {
    return undefined;
  }
  for (const mode of ["exact", "primary"] as const) {
    const code = matchLocaleKey(table as Record<string, unknown>, locale, mode);
    const words = code !== undefined ? (table as Record<string, unknown>)[code] : undefined;
    if (isRecord(words) && Object.prototype.hasOwnProperty.call(words, key)) {
      const text = words[key];
      if (typeof text === "string" && text !== "") {
        return text;
      }
    }
  }
  return undefined;
}

/**
 * One of the engine's own words in `locale` from `sources`: the form's `texts` translation at
 * `address` (`addressOf.formText` / `addressOf.engineMessage`), else the pack's entry for `key`
 * in `table`. `undefined` when neither has it, and the engine's English applies.
 */
export function engineWord(
  address: TextAddress,
  key: string,
  locale: string,
  sources: EngineWordSources | undefined,
  table: "texts" | "messages"
): string | undefined {
  if (!sources) {
    return undefined;
  }
  return lookupText(address, locale, sources) ?? packText(sources.pack?.[table], locale, key);
}

/** Every entry of `locale` (its key exactly), or of every locale, with its address, in the map's order. */
export function listTranslations(
  map: FormTranslations | undefined,
  locale?: string
): Array<{ locale: string; address: TextAddress; entry: TranslationEntry }> {
  const out: Array<{ locale: string; address: TextAddress; entry: TranslationEntry }> = [];
  if (!map) {
    return out;
  }
  const locales = locale === undefined ? Object.keys(map) : Object.prototype.hasOwnProperty.call(map, locale) ? [locale] : [];
  for (const code of locales) {
    const byKind = map[code];
    if (!isSafeSegment(code) || !isRecord(byKind)) {
      continue;
    }
    for (const kind of TRANSLATION_KINDS) {
      const value: unknown = Object.prototype.hasOwnProperty.call(byKind, kind) ? byKind[kind] : undefined;
      if (!isRecord(value)) {
        continue;
      }
      if (kind === "form") {
        walkEntries(value, [], (path, entry) => out.push({ locale: code, address: { kind, path }, entry }));
        continue;
      }
      for (const [owner, tree] of Object.entries(value)) {
        if (isSafeSegment(owner) && isRecord(tree)) {
          walkEntries(tree, [], (path, entry) => out.push({ locale: code, address: { kind, owner, path }, entry }));
        }
      }
    }
  }
  return out;
}

function walkEntries(tree: Record<string, unknown>, path: string[], visit: (path: string[], entry: TranslationEntry) => void, depth = 0): void {
  if (depth > MAX_TREE_DEPTH) {
    return;
  }
  for (const [segment, child] of Object.entries(tree)) {
    if (!isSafeSegment(segment)) {
      continue;
    }
    if (isTranslationEntry(child)) {
      visit([...path, segment], child);
    } else if (isRecord(child)) {
      walkEntries(child, [...path, segment], visit, depth + 1);
    }
  }
}

// --- Writing -----------------------------------------------------------------------------

/**
 * `root` with `value` at `keys` (or the key removed, `value` undefined), copying each object on
 * the way down and dropping every parent the removal leaves empty. `root` itself when nothing
 * changes or the write cannot land: a key on the way holds an entry (an address cannot run
 * through a leaf), or an entry is written where a tree stands. An absent `root` reads as `{}`.
 */
function setAt(root: Record<string, unknown> | undefined, keys: readonly string[], value: unknown): Record<string, unknown> | undefined {
  const [head, ...rest] = keys;
  if (head === undefined) {
    return root;
  }
  const base = root ?? {};
  const has = Object.prototype.hasOwnProperty.call(base, head);
  const current = has ? base[head] : undefined;
  let next: unknown;
  if (rest.length === 0) {
    if (value === undefined && !has) {
      return root;
    }
    if (isTranslationEntry(value) && isRecord(current) && !isTranslationEntry(current)) {
      return root;
    }
    next = value;
  } else {
    if (current !== undefined && (!isRecord(current) || isTranslationEntry(current))) {
      return root;
    }
    if (current === undefined && value === undefined) {
      return root;
    }
    const child = setAt(current as Record<string, unknown> | undefined, rest, value);
    if (child === current) {
      return root;
    }
    next = child !== undefined && Object.keys(child).length > 0 ? child : undefined;
  }
  const copy: Record<string, unknown> = { ...base };
  if (next === undefined) {
    delete copy[head];
  } else {
    copy[head] = next;
  }
  return copy;
}

/**
 * A copy of `map` with `text` written at `address` in `locale`, its `source` the hash of
 * `defaultText`. An empty `text` deletes the entry and drops the parents it leaves empty. An
 * unsafe locale, owner or segment is refused: `map` comes back unchanged.
 */
export function writeTranslation(
  map: FormTranslations | undefined,
  locale: string,
  address: TextAddress,
  text: string,
  defaultText: string
): FormTranslations {
  const base = map ?? {};
  if (!isSafeSegment(locale) || !isSafeAddress(address) || address.path.length === 0) {
    return base;
  }
  // A blank text is no wording: the grid, the agent and an import all treat a cell so. The text
  // itself is kept as the author wrote it; the trim only decides blankness.
  const entry: TranslationEntry | undefined = text.trim() === "" ? undefined : { text, source: sourceHash(defaultText) };
  const existing = readTranslation(map, locale, address);
  if (entry && existing && existing.text === entry.text && existing.source === entry.source) {
    return base;
  }
  return (setAt(base, [locale, ...keyPath(address)], entry) ?? {}) as FormTranslations;
}

/**
 * A copy of `map` with `entry` written at `address` in `locale` exactly as given, `source`
 * included: a paste that carries a clipboard entry keeps the fingerprint it was written
 * against, so a stale one stays stale. An unsafe locale, address or a malformed entry is
 * refused: `map` comes back unchanged. Use `writeTranslation` to word a text against the
 * current default.
 */
export function writeTranslationEntry(
  map: FormTranslations | undefined,
  locale: string,
  address: TextAddress,
  entry: TranslationEntry
): FormTranslations {
  const base = map ?? {};
  if (!isSafeSegment(locale) || !isSafeAddress(address) || address.path.length === 0 || !isTranslationEntry(entry) || entry.text.trim() === "") {
    return base;
  }
  const source = boundedSource(entry.source);
  const existing = readTranslation(map, locale, address);
  if (existing && existing.text === entry.text && existing.source === source) {
    return base;
  }
  return (setAt(base, [locale, ...keyPath(address)], { text: entry.text, source }) ?? {}) as FormTranslations;
}

/** One edit of {@link writeTranslations}: what `writeTranslation` takes, plus the optional fingerprint of `writeTranslationEntry`. */
export interface TranslationEdit {
  locale: string;
  address: TextAddress;
  /** The new text; empty deletes the entry. */
  text: string;
  /** The current default of the text, which the entry's `source` is the hash of (unless `source` is given). */
  defaultText: string;
  /** Written as the entry's `source` exactly when the text is not empty; absent: the hash of `defaultText`. */
  source?: string;
}

/**
 * `root` with `value` written at `keys` in place (or the key removed, `value` undefined),
 * mirroring {@link setAt}'s rules: a parent the removal leaves empty goes, an address cannot
 * run through a leaf, an entry cannot replace a tree. Every object on the way is shallow-copied
 * once (`owned` remembers the copies), so a batch of writes costs the width of the levels it
 * touches once, not once per write. Answers whether the write landed.
 */
function setInPlace(root: Record<string, unknown>, keys: readonly string[], at: number, value: unknown, owned: Set<object>): boolean {
  const head = keys[at]!;
  const has = Object.prototype.hasOwnProperty.call(root, head);
  const current = has ? root[head] : undefined;
  if (at === keys.length - 1) {
    if (value === undefined) {
      if (!has) {
        return false;
      }
      delete root[head];
      return true;
    }
    // A tree a deletion of this batch emptied is not there any more (the sweep has not run yet).
    if (isTranslationEntry(value) && isRecord(current) && !isTranslationEntry(current) && Object.keys(current).length > 0) {
      return false;
    }
    root[head] = value;
    return true;
  }
  if (current !== undefined && (!isRecord(current) || isTranslationEntry(current))) {
    return false;
  }
  if (current === undefined && value === undefined) {
    return false;
  }
  let child: Record<string, unknown>;
  if (current === undefined) {
    child = {};
    owned.add(child);
  } else if (owned.has(current as object)) {
    child = current as Record<string, unknown>;
  } else {
    child = { ...(current as Record<string, unknown>) };
    owned.add(child);
  }
  const landed = setInPlace(child, keys, at + 1, value, owned);
  if (!landed) {
    return false;
  }
  root[head] = child;
  return true;
}

/**
 * Removes, from the objects the batch copied, every level a deletion left empty. Done once at the
 * end: asking each deletion whether its parent is empty would count the keys of a wide level
 * (4,000 components) per edit and bring the quadratic cost back.
 */
function sweepEmpty(node: Record<string, unknown>, owned: ReadonlySet<object>): void {
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (isRecord(child) && owned.has(child)) {
      sweepEmpty(child, owned);
      if (Object.keys(child).length === 0) {
        delete node[key];
      }
    }
  }
}

/**
 * Applies many edits in one pass: the same guards and results as calling {@link writeTranslation}
 * (or {@link writeTranslationEntry} for an edit with a `source`) once per edit in order, but each
 * touched locale is copied once instead of once per edit, so an import of thousands of texts
 * does not go quadratic. Answers the new map (`map` itself when nothing
 * changed) and how many edits wrote or deleted an entry.
 */
export function writeTranslations(
  map: FormTranslations | undefined,
  edits: ReadonlyArray<TranslationEdit>
): { translations: FormTranslations; changed: number } {
  const base = map ?? {};
  const owned = new Set<object>();
  const working: Record<string, unknown> = { ...base };
  owned.add(working);
  let changed = 0;
  for (const edit of edits) {
    const { locale, address, text } = edit;
    if (!isSafeSegment(locale) || !isSafeAddress(address) || address.path.length === 0) {
      continue;
    }
    // A `source` the caller gave that is not a fingerprint is not trusted, and not taken for the
    // current default's either: the entry is kept, marked as made against other wording.
    const entry: TranslationEntry | undefined =
      text.trim() === "" ? undefined : { text, source: edit.source === undefined ? sourceHash(edit.defaultText) : boundedSource(edit.source) };
    const keys = [locale, ...keyPath(address)];
    const existing = nodeAt(working, keys);
    if (entry && isTranslationEntry(existing) && existing.text === entry.text && existing.source === entry.source) {
      continue;
    }
    if (setInPlace(working, keys, 0, entry, owned)) {
      changed += 1;
    }
  }
  if (changed === 0) {
    return { translations: base, changed };
  }
  sweepEmpty(working, owned);
  return { translations: working as FormTranslations, changed };
}

/** Confirms a stale entry against the current default without changing its text; `map` itself when there is no entry or it is already current. */
export function reconcileTranslation(
  map: FormTranslations | undefined,
  locale: string,
  address: TextAddress,
  defaultText: string
): FormTranslations {
  const entry = readTranslation(map, locale, address);
  if (!entry || !isStale(entry, defaultText)) {
    return map ?? {};
  }
  return writeTranslation(map, locale, address, entry.text, defaultText);
}

/** `map` with `apply` run on each locale's object; `map` itself when no locale changes. */
function eachLocale(
  map: FormTranslations | undefined,
  apply: (locale: Record<string, unknown>) => Record<string, unknown> | undefined
): FormTranslations {
  const base = map ?? {};
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [code, value] of Object.entries(base)) {
    // A `__proto__` key of a loaded map would set the copy's prototype on assignment; it is
    // neither walked nor copied.
    if (!isSafeSegment(code)) {
      continue;
    }
    if (!isRecord(value)) {
      out[code] = value;
      continue;
    }
    const next = apply(value);
    if (next !== value) {
      changed = true;
    }
    if (next !== undefined && Object.keys(next).length > 0) {
      out[code] = next;
    }
  }
  return changed ? (out as FormTranslations) : base;
}

/**
 * Removes, in every locale, everything under an owner or under an address prefix (an option, a
 * message, a page), and the parents that leaves empty: what deleting the thing those texts
 * belonged to does. An unsafe prefix, or a non-form prefix without an owner, is
 * refused.
 */
export function pruneTranslations(map: FormTranslations | undefined, prefix: TranslationPrefix): FormTranslations {
  if (!isSafeAddress(prefix)) {
    return map ?? {};
  }
  const keys = keyPath(prefix);
  return eachLocale(map, (locale) => setAt(locale, keys, undefined));
}

/** A deep copy of JSON-shaped data, so a copied subtree shares nothing with its original. */
function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Duplicate or paste: in every locale, the owner `fromOwner`'s tree copied under `toOwner`
 * (replacing whatever `toOwner` had). Not for kind `form`, which has no owner.
 */
export function copyTranslations(map: FormTranslations | undefined, kind: TranslationKind, fromOwner: string, toOwner: string): FormTranslations {
  if (kind === "form" || fromOwner === toOwner || !isSafeAddress({ kind, owner: fromOwner }) || !isSafeAddress({ kind, owner: toOwner })) {
    return map ?? {};
  }
  return eachLocale(map, (locale) => {
    const tree = nodeAt(locale, [kind, fromOwner]);
    return isRecord(tree) ? setAt(locale, [kind, toOwner], cloneData(tree)) : locale;
  });
}

/**
 * Rename: in every locale, the subtree at `from` moved to `to` (replacing what was there) —
 * a component, part, journey or layout id renamed (`{ kind, owner }` to `{ kind, owner }`), or an
 * option value or page id (`{ kind, owner, path: ["options", old] }` to `[..., "options", new]`).
 */
export function moveTranslations(map: FormTranslations | undefined, from: TranslationPrefix, to: TranslationPrefix): FormTranslations {
  if (!isSafeAddress(from) || !isSafeAddress(to)) {
    return map ?? {};
  }
  const fromKeys = keyPath(from);
  const toKeys = keyPath(to);
  if (fromKeys.length <= 1 || toKeys.length <= 1 || fromKeys.join("\u0000") === toKeys.join("\u0000")) {
    return map ?? {};
  }
  return eachLocale(map, (locale) => {
    const subtree = nodeAt(locale, fromKeys);
    if (subtree === undefined) {
      return locale;
    }
    const without = setAt(locale, fromKeys, undefined) ?? {};
    const placed = setAt(without, toKeys, subtree);
    // A target that cannot hold the subtree (its path runs through an entry) leaves the locale as it was.
    return placed === without ? locale : placed;
  });
}

/** `map` without `locale`'s translations: what removing a language does. */
export function removeLocale(map: FormTranslations | undefined, locale: string): FormTranslations {
  const base = map ?? {};
  if (!Object.prototype.hasOwnProperty.call(base, locale)) {
    return base;
  }
  const out: FormTranslations = {};
  for (const [code, value] of Object.entries(base)) {
    // An unsafe key is not copied: assigning `__proto__` would replace the copy's prototype.
    if (code !== locale && isSafeSegment(code)) {
      out[code] = value;
    }
  }
  return out;
}

/**
 * `map` with the locale `from` renamed `to`, in the same place in the key order. The caller
 * guarantees `to` is not in use; were it, `from`'s translations replace its. An unsafe `to` is refused.
 */
export function renameLocale(map: FormTranslations | undefined, from: string, to: string): FormTranslations {
  const base = map ?? {};
  if (from === to || !isSafeSegment(to) || !Object.prototype.hasOwnProperty.call(base, from)) {
    return base;
  }
  const out: FormTranslations = {};
  for (const [code, value] of Object.entries(base)) {
    if (code === to || !isSafeSegment(code)) {
      continue;
    }
    out[code === from ? to : code] = value;
  }
  return out;
}

/**
 * Makes `to` the default language. For each text (the caller lists every one with
 * its current default): when `to` has a non-empty entry, that text becomes the new default, the
 * old default moves under `from`, and `to`'s entry goes; a text with no `to` entry keeps its
 * default. Entries in the other languages that were current against the old default are
 * re-fingerprinted against the new one (they still answer the same meaning, now worded in `to`);
 * stale ones stay stale. Returns the map and the default per address, in `texts` order, for the
 * caller to write into the configuration in the same undo step. Running it again the other way
 * round restores both.
 *
 * The `source` of the demoted entry follows how fresh the promoted one was. A `to` entry that
 * was current against the old default becomes the new default and the demoted old default is
 * current against it: its `source` is the hash of the new default. A `to` entry that was stale
 * (its `source` is the hash of some older default, not of `default`) was a translation of
 * wording that no longer exists, so the new default is itself of doubtful meaning and the
 * demoted entry must not claim to be current: it keeps the promoted entry's `source`, the hash
 * of the older wording, which is not the hash of the new default. Staleness therefore survives
 * the swap, and swapping back restores the original `source` exactly.
 */
export function makeDefaultLocale(
  map: FormTranslations | undefined,
  texts: ReadonlyArray<{ address: TextAddress; default: string }>,
  from: string,
  to: string
): { translations: FormTranslations; defaults: Array<{ address: TextAddress; default: string }> } {
  let next: FormTranslations = map ?? {};
  const defaults: Array<{ address: TextAddress; default: string }> = [];
  if (from === to || !isSafeSegment(from) || !isSafeSegment(to)) {
    return { translations: next, defaults: texts.map((text) => ({ address: text.address, default: text.default })) };
  }
  const others = Object.keys(map ?? {}).filter((code) => code !== from && code !== to);
  for (const text of texts) {
    const promoted = readTranslation(map, to, text.address);
    if (!promoted || promoted.text.trim() === "") {
      defaults.push({ address: text.address, default: text.default });
      continue;
    }
    const newDefault = promoted.text;
    next = writeTranslation(next, to, text.address, "", newDefault);
    next = isStale(promoted, text.default)
      ? writeTranslationEntry(next, from, text.address, { text: text.default, source: promoted.source })
      : writeTranslation(next, from, text.address, text.default, newDefault);
    for (const code of others) {
      const entry = readTranslation(next, code, text.address);
      if (entry && !isStale(entry, text.default)) {
        next = writeTranslation(next, code, text.address, entry.text, newDefault);
      }
    }
    defaults.push({ address: text.address, default: newDefault });
  }
  return { translations: inKeyOrder(map ?? {}, next, from, to), defaults };
}

/**
 * `next` with its keys in a stable order. The writes above delete a key and
 * add another at the end, so two swaps would otherwise leave the saved JSON differing from where
 * it started although every value is the same. The languages keep the order `before` had them,
 * the old default (`from`) taking the place of the promoted language (`to`) when that language's
 * last entry went and `from` is new, so swapping back puts each where it was; the kinds of a
 * language that changed stand in {@link TRANSLATION_KINDS} order, which is the order a form's
 * map is written in.
 */
function inKeyOrder(before: FormTranslations, next: FormTranslations, from: string, to: string): FormTranslations {
  if (next === before) {
    return next;
  }
  const keys = Object.keys(next);
  const wanted: string[] = [];
  for (const key of Object.keys(before)) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      wanted.push(key);
    } else if (key === to && !Object.prototype.hasOwnProperty.call(before, from) && Object.prototype.hasOwnProperty.call(next, from)) {
      wanted.push(from);
    }
  }
  for (const key of keys) {
    if (!wanted.includes(key)) {
      wanted.push(key);
    }
  }
  const out: FormTranslations = {};
  for (const key of wanted) {
    if (!isSafeSegment(key)) {
      continue;
    }
    const locale = next[key]!;
    out[key] = locale === before[key] ? locale : inKindOrder(locale);
  }
  return out;
}

/** A locale's object with its kinds in {@link TRANSLATION_KINDS} order and anything else after them, as it came. */
function inKindOrder(locale: LocaleTranslations): LocaleTranslations {
  const keys = Object.keys(locale);
  const ordered = [...TRANSLATION_KINDS.filter((kind) => keys.includes(kind)), ...keys.filter((key) => !(TRANSLATION_KINDS as readonly string[]).includes(key))];
  if (ordered.every((key, index) => key === keys[index])) {
    return locale;
  }
  const out: Record<string, unknown> = {};
  for (const key of ordered) {
    if (isSafeSegment(key)) {
      out[key] = (locale as Record<string, unknown>)[key];
    }
  }
  return out as LocaleTranslations;
}

// --- Tolerant readers --------------------------------------------------------------------

/**
 * How deep a property tree below its owner is read. The deepest address the engine writes is a
 * handful of segments (`options › value › label`); a tree deeper than this is not one of ours,
 * and stopping keeps a hostile document from exhausting the stack.
 */
const MAX_TREE_DEPTH = 12;

/** What a reader leaves out and why a caller may want to say so: how many values, and where the first few sat. */
export interface DroppedTranslations {
  count: number;
  /** The addresses (locale, kind, owner, then property segments) of the first values left out; `[]` is the map itself. */
  first: string[][];
}

/** How many dropped addresses are kept to be named. */
const MAX_DROPPED_ADDRESSES = 5;

interface ReadContext<Leaf> {
  readLeaf: (value: unknown) => Leaf | undefined;
  /** A value that holds no wording on purpose (an empty text): left out without a word. */
  isBlank: (value: unknown) => boolean;
  /** A record that was meant as a leaf but is malformed (a text that is not text, no source). */
  looksLikeLeaf: (value: Record<string, unknown>) => boolean;
  drop: (path: readonly string[]) => void;
}

/**
 * `path` is the address of `value`, shared and extended in place on the way down (a map of
 * thousands of entries is read without a new array per node); the drop callback copies it.
 */
function readTree<Leaf>(value: unknown, ctx: ReadContext<Leaf>, path: string[], depth: number): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (depth > MAX_TREE_DEPTH) {
    ctx.drop(path);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [segment, child] of Object.entries(value)) {
    path.push(segment);
    try {
      if (!isSafeSegment(segment)) {
        ctx.drop(path);
        continue;
      }
      const leaf = ctx.readLeaf(child);
      if (leaf !== undefined) {
        out[segment] = leaf;
        continue;
      }
      if (ctx.isBlank(child)) {
        continue;
      }
      if (!isRecord(child) || ctx.looksLikeLeaf(child)) {
        ctx.drop(path);
        continue;
      }
      const tree = readTree(child, ctx, path, depth + 1);
      if (tree) {
        out[segment] = tree;
      }
    } finally {
      path.pop();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Merges `loser` into `winner` where `winner` has nothing, reporting each value of `loser` that has to go. */
function mergeInto(winner: Record<string, unknown>, loser: Record<string, unknown>, path: readonly string[], isLeaf: (value: unknown) => boolean, drop: (path: readonly string[]) => void): void {
  for (const [key, value] of Object.entries(loser)) {
    const here = [...path, key];
    if (!Object.prototype.hasOwnProperty.call(winner, key)) {
      winner[key] = value;
      continue;
    }
    const held = winner[key];
    if (isRecord(held) && isRecord(value) && !isLeaf(held) && !isLeaf(value)) {
      mergeInto(held, value, here, isLeaf, drop);
    } else if (JSON.stringify(held) !== JSON.stringify(value)) {
      drop(here);
    }
  }
}

function readLocales<Leaf>(
  value: unknown,
  ctx: ReadContext<Leaf>,
  declared?: readonly string[]
): Record<string, Record<string, unknown>> | undefined {
  if (!isRecord(value)) {
    if (value !== undefined && value !== null) {
      ctx.drop([]);
    }
    return undefined;
  }
  const read: Array<[string, Record<string, unknown>]> = [];
  for (const [code, byKind] of Object.entries(value)) {
    if (!isSafeSegment(code)) {
      ctx.drop([code]);
      continue;
    }
    if (!isRecord(byKind)) {
      ctx.drop([code]);
      continue;
    }
    const locale: Record<string, unknown> = {};
    for (const kind of TRANSLATION_KINDS) {
      const raw: unknown = Object.prototype.hasOwnProperty.call(byKind, kind) ? byKind[kind] : undefined;
      if (raw === undefined) {
        continue;
      }
      if (kind === "form") {
        const tree = readTree(raw, ctx, [code, kind], 0);
        if (tree) {
          locale.form = tree;
        } else if (!isRecord(raw)) {
          ctx.drop([code, kind]);
        }
        continue;
      }
      if (!isRecord(raw)) {
        ctx.drop([code, kind]);
        continue;
      }
      const owners: Record<string, unknown> = {};
      for (const [owner, tree] of Object.entries(raw)) {
        const here = [code, kind, owner];
        if (!isSafeSegment(owner)) {
          ctx.drop(here);
        } else if (ctx.isBlank(tree)) {
          continue;
        } else if (ctx.readLeaf(tree) !== undefined || (isRecord(tree) && ctx.looksLikeLeaf(tree)) || (!isRecord(tree) && !ctx.isBlank(tree))) {
          // An entry where an owner's tree belongs is an address with no property, which nothing can name.
          ctx.drop(here);
        } else {
          const owned = readTree(tree, ctx, [...here], 0);
          if (owned) {
            owners[owner] = owned;
          }
        }
      }
      if (Object.keys(owners).length > 0) {
        locale[kind] = owners;
      }
    }
    for (const key of Object.keys(byKind)) {
      if (!(TRANSLATION_KINDS as readonly string[]).includes(key)) {
        ctx.drop([code, key]);
      }
    }
    if (Object.keys(locale).length > 0) {
      read.push([code, locale]);
    }
  }
  // Each locale key is read as the form's language list spells it (the renderer matches keys
  // ignoring case and `_` against `-`), so the builder's exact lookups find what the renderer
  // shows. Two keys for one language merge; the declared spelling's own entries win.
  const targetOf = (code: string): string => {
    const tag = normalizeLocaleTag(code);
    return declared?.find((candidate) => normalizeLocaleTag(candidate) === tag) ?? code;
  };
  const groups = new Map<string, Array<[string, Record<string, unknown>]>>();
  for (const item of read) {
    const target = targetOf(item[0]);
    const group = groups.get(target);
    if (group) {
      group.push(item);
    } else {
      groups.set(target, [item]);
    }
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [target, group] of groups) {
    const ordered = [...group.filter(([code]) => code === target), ...group.filter(([code]) => code !== target)];
    const [first, ...rest] = ordered as [[string, Record<string, unknown>], ...Array<[string, Record<string, unknown>]>];
    const merged = first[1];
    for (const [code, other] of rest) {
      for (const kind of Object.keys(other)) {
        const loser = other[kind] as Record<string, unknown>;
        const held = merged[kind] as Record<string, unknown> | undefined;
        if (held === undefined) {
          merged[kind] = loser;
        } else {
          mergeInto(held, loser, [code, kind], (leaf) => ctx.readLeaf(leaf) !== undefined, ctx.drop);
        }
      }
    }
    out[target] = rest.length === 0 ? merged : (inKindOrder(merged as LocaleTranslations) as Record<string, unknown>);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readEntryLeaf(value: unknown): TranslationEntry | undefined {
  // An empty or blank text is no translation (the writers read it the same way); anything but
  // `text` and `source` is dropped. The text that is kept is not trimmed: the author's spacing stays.
  return isTranslationEntry(value) && value.text.trim() !== "" ? { text: value.text, source: value.source } : undefined;
}

function readCatalogLeaf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** A record with a `text` or `source` of its own that is not a tree: an entry written wrong. */
function looksLikeEntry(value: Record<string, unknown>): boolean {
  return ["text", "source"].some((key) => Object.prototype.hasOwnProperty.call(value, key) && !isRecord(value[key]));
}

function entryContext(drop: (path: readonly string[]) => void): ReadContext<TranslationEntry> {
  return { readLeaf: readEntryLeaf, isBlank: (value) => isTranslationEntry(value) && value.text.trim() === "", looksLikeLeaf: looksLikeEntry, drop };
}

/**
 * The definition's `translations` as the engine may use it: unsafe segments, unknown kinds,
 * leaves that are not `{ text, source }` and empty texts dropped, empty parents with them.
 * Never throws; `undefined` when nothing usable remains. `declaredLocales` are the form's
 * language codes: a key that names one of them in another case or with `_` for `-` is read under
 * the declared spelling (two such keys merge), so a lookup by the declared code finds it.
 */
export function readFormTranslations(value: unknown, declaredLocales?: readonly string[]): FormTranslations | undefined {
  return readFormTranslationsReport(value, declaredLocales).translations;
}

/**
 * {@link readFormTranslations} that also says what it left out (an empty text is no translation
 * and is not counted): how many values, and the addresses of the first few, so a host can tell
 * its author that saving will not keep them.
 */
export function readFormTranslationsReport(
  value: unknown,
  declaredLocales?: readonly string[]
): { translations: FormTranslations | undefined; dropped: DroppedTranslations } {
  const dropped: DroppedTranslations = { count: 0, first: [] };
  const drop = (path: readonly string[]): void => {
    dropped.count += 1;
    if (dropped.first.length < MAX_DROPPED_ADDRESSES) {
      dropped.first.push([...path]);
    }
  };
  const translations = readLocales(value, entryContext(drop), declaredLocales) as FormTranslations | undefined;
  return { translations, dropped };
}

/** A host's catalog read the same way, its leaves non-empty strings. */
export function readTranslationCatalog(value: unknown): TranslationCatalog | undefined {
  const ctx: ReadContext<string> = { readLeaf: readCatalogLeaf, isBlank: (leaf) => typeof leaf === "string" && leaf.trim() === "", looksLikeLeaf: () => false, drop: () => undefined };
  return readLocales(value, ctx) as TranslationCatalog | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
