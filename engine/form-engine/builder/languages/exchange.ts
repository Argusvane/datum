import { normalizeLocaleTag, primaryLocaleSubtag } from "../../core/localization/localized-text.js";
import { languageCodeProblem } from "../controller/language-edits.js";
import { guardSpreadsheetCell, unguardSpreadsheetCell } from "../../core/text/spreadsheet-cell.js";
import { isSafeSegment, isSourceHash, sourceHash, TRANSLATION_KINDS } from "../../core/localization/translations.js";
import type { TextAddress, TranslationKind } from "../../core/localization/translations.js";
import { enginePluralAddresses, enginePluralTexts, engineTexts } from "./engine-texts.js";

/**
 * The Languages workspace's exchange: texts out as JSON, CSV or XLIFF 2.0 (or as a prompt for an
 * AI assistant), translations back in with a preview first. Pure string work:
 * no DOM, no file API, no controller. The workspace adapts its rows to {@link ExchangeText} and
 * hands the {@link ImportEdit}s that {@link applyImport} answers to the controller's one-undo-step
 * `setTranslations`.
 *
 * A file is untrusted input: it is capped in size and in rows, every address
 * segment passes {@link isSafeSegment}, and nothing here throws on what a hostile file holds; a
 * refusal or a skipped row is a {@link ImportProblem} the caller words. The XML reader is a small
 * tolerant parser of its own: it refuses a document type declaration (so no entity can expand),
 * knows only the five predefined entities and numeric references, and caps its depth.
 */

// --- Shapes ------------------------------------------------------------------------------

/** What the exchange needs of one text; the workspace builds these from its rows. */
export interface ExchangeText {
  address: TextAddress;
  /** The default-language string. */
  default: string;
  /** The group rail the text sits under (Fields, Options, Messages, ...), for the `{ group }` scope. */
  group: string;
  /** The component's (or document's) label: where a translator finds the text. */
  where: string;
  /** The translation per locale; an absent key is a missing translation. */
  texts: Record<string, string>;
  /** The `source` fingerprint each stored translation answered, per locale. */
  sources: Record<string, string>;
  /**
   * The languages the text has a cell for. A language outside it has nothing to translate here (an
   * engine word has no cell in English, a plural form only in the language that needs it), so it
   * is never counted missing, an export leaves its cell blank, and an import cell for it is
   * skipped. Absent: every language.
   */
  applicable?: ReadonlySet<string>;
  /**
   * Where the page's catalog words the text, per language: `overridden` under the exact tag (it
   * wins over the map and the grid refuses the cell) or `served` under the primary subtag while
   * the map has no text. Either way the form shows wording, so the cell is not missing; an
   * overridden one is not stale either, and an import skips it.
   */
  catalog?: Record<string, "overridden" | "served">;
}

export type ExchangeScope = "all" | "missing" | "stale" | { group: string };

/** The facts a file states about the form it came from. */
export interface ExchangeHeader {
  form?: string;
  defaultLocale: string;
  /** Written as given; the caller supplies the time so an export is reproducible. */
  exportedAt?: string;
}

export type ImportMode = "replace" | "fill";

/**
 * What applying a cell does. `unknown` is a text the form does not have; `pageWorded` a text whose
 * cell the page's catalog words under the exact tag (it wins at run time, so nothing written would
 * show); `noCell` a language the text has no cell for (an engine word in English, a plural form
 * the language does not use). The last three are skipped, each for its own reason.
 */
export type ImportStatus = "new" | "changed" | "unchanged" | "unknown" | "pageWorded" | "noCell";

export type ImportFormat = "json" | "csv" | "xliff";

export type ImportProblemCode =
  | "tooLarge"
  | "tooManyRows"
  | "tooManyLocales"
  | "empty"
  | "notUtf8"
  | "malformedJson"
  | "malformedCsv"
  | "malformedXml"
  | "unsafeXml"
  | "notXliff"
  | "missingTargetLanguage"
  | "missingColumns"
  | "noLanguageColumns"
  | "unrecognizedShape"
  | "badAddress"
  | "unsafeSegment"
  | "badLocale"
  | "defaultLocaleColumn"
  | "duplicateRow"
  | "badCell"
  | "badRow"
  | "tooLong"
  | "moreProblems";

/** A thing the preview wants the author to know; the caller words the code (no English here). */
export interface ImportProblem {
  code: ImportProblemCode;
  /** The 1-based record in the file (the header of a CSV is record 0), when the problem is one row's. */
  row?: number;
  /** The offending locale code, column or segment, when there is one. */
  detail?: string;
}

export interface ImportRow {
  address: TextAddress;
  /** The form's spelling when the language exists, else the file's (with `_` read as `-`). */
  locale: string;
  text: string;
  status: ImportStatus;
  /** The file's source fingerprint no longer matches the current default (only when the file states one). */
  stale: boolean;
  /** The language is not declared by the form: it is applied only when the caller adds it. */
  newLocale: boolean;
  /** What the form holds there now, for the row-by-row diff. */
  current?: string;
  /** The file's source fingerprint, when it stated one. */
  source?: string;
  /** The 1-based record in the file. */
  row: number;
}

export interface ImportPreview {
  name: string;
  format?: ImportFormat;
  rows: ImportRow[];
  /** Languages in the file that the form does not declare, in the file's order. */
  newLocales: string[];
  /** How many distinct addresses of the file no text of the form has. */
  unknownCount: number;
  /**
   * XLIFF units that state a source and no target at all: nothing to import, counted so the
   * author sees that the file was read and these were left. A unit with an empty target is
   * not one of them: an empty cell is the ordinary "not translated yet" in every format.
   */
  noTargetCount: number;
  /** Rows (one per address and language) by status; `stale` counts rows whose source no longer matches. */
  counts: ImportCounts;
  problems: ImportProblem[];
}

/** `skipped` adds the `pageWorded` and `noCell` rows, which are skipped but are not unknown texts. */
export interface ImportCounts {
  new: number;
  changed: number;
  unchanged: number;
  unknown: number;
  skipped: number;
  stale: number;
}

export interface ImportOptions {
  mode: ImportMode;
  /**
   * The form's default language. A column for it is read for the engine's own words (kind `texts`,
   * whose source is English) and ignored for every other text, whose default-language wording is
   * the form's own.
   */
  defaultLocale?: string;
}

/** One edit for `controller.setTranslations`; `source` is the file's fingerprint when it no longer matches. */
export interface ImportEdit {
  locale: string;
  address: TextAddress;
  text: string;
  source?: string;
}

export interface ImportChoices {
  /** The new languages (from {@link ImportPreview.newLocales}) the author chose to add. */
  addLocales: readonly string[];
  mode: ImportMode;
}

/** The largest file read, in bytes of UTF-8. */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
/** The most texts one file may carry (CSV records, JSON objects, XLIFF units). */
export const MAX_IMPORT_ROWS = 20_000;
/** The longest single translation read, in bytes of UTF-8; a longer cell is a `tooLong` problem and skipped. */
export const MAX_IMPORT_CELL_BYTES = 16 * 1024;
const MAX_LOCALES = 100;
const MAX_PROBLEMS = 200;
const MAX_XML_DEPTH = 64;

// --- Scope -------------------------------------------------------------------------------

function applies(text: ExchangeText, locale: string): boolean {
  return text.applicable === undefined || text.applicable.has(locale);
}

function isStaleIn(text: ExchangeText, locale: string): boolean {
  const source = text.sources[locale];
  return applies(text, locale) && text.catalog?.[locale] !== "overridden" && Boolean(text.texts[locale]) && source !== undefined && source !== sourceHash(text.default);
}

/** The texts a scope picks, judged against the languages being exported. */
export function textsInScope(texts: readonly ExchangeText[], locales: readonly string[], scope: ExchangeScope): ExchangeText[] {
  if (scope === "all") {
    return [...texts];
  }
  if (scope === "missing") {
    return texts.filter((text) => text.default !== "" && locales.some((locale) => statusOf(text, locale) === "missing"));
  }
  if (scope === "stale") {
    return texts.filter((text) => locales.some((locale) => isStaleIn(text, locale)));
  }
  return texts.filter((text) => text.group === scope.group);
}

// --- Addresses as strings ----------------------------------------------------------------

/**
 * One segment as a file spells it: `%`, `/`, whitespace and control characters become `%XX`, so a
 * segment (an option value, a message code, a field name) may hold anything and the `/` that joins
 * the segments stays unambiguous.
 */
function escapeSegment(segment: string): string {
  return segment.replace(/[%/\u0000- \u007f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function unescapeSegment(segment: string): string | undefined {
  if (/%(?![0-9A-Fa-f]{2})/.test(segment)) {
    return undefined;
  }
  let bad = false;
  const out = segment.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
    const code = parseInt(hex, 16);
    if (code > 0x7f) {
      bad = true;
    }
    return String.fromCharCode(code);
  });
  return bad ? undefined : out;
}

function pathString(address: TextAddress): string {
  return address.path.map(escapeSegment).join("/");
}

function addressKey(address: TextAddress): string {
  return JSON.stringify([address.kind, address.owner ?? null, address.path]);
}

function isKind(value: string): value is TranslationKind {
  return (TRANSLATION_KINDS as readonly string[]).includes(value);
}

type AddressResult = { address: TextAddress } | { problem: ImportProblemCode; detail?: string };

/** The address a file's `kind`, `key` and `path` name, or why it is refused. */
function addressFromParts(kind: string, owner: string, path: readonly string[]): AddressResult {
  if (!isKind(kind)) {
    return { problem: "badAddress", detail: kind };
  }
  if (kind === "form" ? owner !== "" : owner === "") {
    return { problem: "badAddress", detail: owner };
  }
  if (kind !== "form" && !isSafeSegment(owner)) {
    return { problem: "unsafeSegment", detail: owner };
  }
  if (path.length === 0) {
    return { problem: "badAddress" };
  }
  for (const segment of path) {
    if (!isSafeSegment(segment)) {
      return { problem: "unsafeSegment", detail: segment };
    }
  }
  return kind === "form" ? { address: { kind, path: [...path] } } : { address: { kind, owner, path: [...path] } };
}

function addressFromStrings(kind: string, key: string, path: string): AddressResult {
  const segments: string[] = [];
  for (const raw of path.split("/")) {
    const segment = unescapeSegment(raw);
    if (segment === undefined) {
      return { problem: "badAddress", detail: raw };
    }
    segments.push(segment);
  }
  return addressFromParts(kind.trim(), key, path === "" ? [] : segments);
}

/** The XLIFF unit id: `kind/owner/path…`, each segment escaped (the form kind has no owner). */
function unitId(address: TextAddress): string {
  return [address.kind, ...(address.owner === undefined ? [] : [address.owner]), ...address.path].map(escapeSegment).join("/");
}

function addressFromUnitId(id: string): AddressResult {
  const parts: string[] = [];
  for (const raw of id.split("/")) {
    const part = unescapeSegment(raw);
    if (part === undefined) {
      return { problem: "badAddress", detail: raw };
    }
    parts.push(part);
  }
  const kind = parts[0] ?? "";
  if (kind === "form") {
    return addressFromParts(kind, "", parts.slice(1));
  }
  return addressFromParts(kind, parts[1] ?? "", parts.slice(2));
}

// --- Export ------------------------------------------------------------------------------

/**
 * Where one translation stands, as an export tells the translator: `missing` has no text,
 * `stale` has one that answered other wording than the current default, `fresh` is current.
 */
export type TranslationStatus = "fresh" | "stale" | "missing";

/** `""` for a language the text has no cell for: there is nothing to say about it. */
function statusOf(text: ExchangeText, locale: string): TranslationStatus | "" {
  if (!applies(text, locale)) {
    return "";
  }
  const held = text.catalog?.[locale];
  if (held === "overridden" || (held === "served" && !text.texts[locale])) {
    return "fresh";
  }
  if (!text.texts[locale]) {
    return "missing";
  }
  return isStaleIn(text, locale) ? "stale" : "fresh";
}

function csvField(value: string): string {
  const guarded = guardSpreadsheetCell(value);
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(",");
}

/** The prefix that makes a CSV column a language: `lang:fr-CA`. A column without it is never one. */
const LANGUAGE_PREFIX = /^lang:/i;

/**
 * JSON: a header and one object per text, `{ kind, key, path, where, default, source, status,
 * <locale>… }`. `source` is the fingerprint of the default exported, which an import compares
 * with the form's current default to flag a translation of wording that has since changed;
 * `status` says per language whether the translation is fresh, stale or missing.
 */
export function exportJson(texts: readonly ExchangeText[], locales: readonly string[], scope: ExchangeScope, header: ExchangeHeader): string {
  const rows = textsInScope(texts, locales, scope).map((text) => {
    const row: Record<string, unknown> = {
      kind: text.address.kind,
      key: text.address.owner ?? "",
      path: pathString(text.address),
      where: text.where
    };
    row.default = text.default;
    row.source = sourceHash(text.default);
    row.status = Object.fromEntries(locales.filter((locale) => applies(text, locale)).map((locale) => [locale, statusOf(text, locale)]));
    for (const locale of locales) {
      row[locale] = text.texts[locale] ?? "";
    }
    return row;
  });
  return JSON.stringify(
    {
      ...(header.form === undefined ? {} : { form: header.form }),
      ...(header.exportedAt === undefined ? {} : { exportedAt: header.exportedAt }),
      defaultLocale: header.defaultLocale,
      locales: [...locales],
      texts: rows
    },
    null,
    2
  );
}

/**
 * CSV, RFC 4180: `kind,key,path,where,default,source,` then `lang:<locale>,status:<locale>` for
 * each language (no status columns when `status` is false: an assistant's prompt does not need
 * them), `\r\n` rows. A file leads with a UTF-8 byte-order mark when `bom` is set, so Excel reads
 * the accents instead of taking the bytes for its ANSI code page; text that is pasted rather than
 * saved (the prompt) has none. A cell a spreadsheet would run as a formula is guarded (see
 * {@link guardSpreadsheetCell}).
 */
export function exportCsv(texts: readonly ExchangeText[], locales: readonly string[], scope: ExchangeScope, options: { status?: boolean; bom?: boolean } = {}): string {
  const withStatus = options.status !== false;
  const lines = [csvRow(["kind", "key", "path", "where", "default", "source", ...locales.flatMap((locale) => (withStatus ? [`lang:${locale}`, `status:${locale}`] : [`lang:${locale}`]))])];
  for (const text of textsInScope(texts, locales, scope)) {
    lines.push(
      csvRow([
        text.address.kind,
        text.address.owner ?? "",
        pathString(text.address),
        text.where,
        text.default,
        sourceHash(text.default),
        ...locales.flatMap((locale) => (withStatus ? [text.texts[locale] ?? "", statusOf(text, locale)] : [text.texts[locale] ?? ""]))
      ])
    );
  }
  return `${options.bom === true ? "\ufeff" : ""}${lines.join("\r\n")}\r\n`;
}

/** Characters XML 1.0 cannot carry in any form: C0 controls but tab, LF and CR, and U+FFFE and U+FFFF. */
const XML_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

/**
 * The five specials escaped; the characters XML 1.0 cannot carry are dropped (attributes and
 * notes). A carriage return is written as a reference: the reader sees a raw one as a line feed
 * (XML 1.0 §2.11), so a text that holds one would otherwise come back changed.
 */
function xmlEscape(value: string): string {
  return value
    .replace(XML_FORBIDDEN, "")
    .replace(/&/g, "&amp;")
    .replace(/\r/g, "&#13;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Text for a `<source>` or `<target>`: a character XML 1.0 cannot carry is written as XLIFF 2.0's
 * `<cp hex="000B"/>` and read back by the importer, so a default or a translation that holds one
 * survives the round trip (and its fingerprint still matches).
 */
function xliffText(value: string): string {
  let out = "";
  let from = 0;
  for (const match of value.matchAll(XML_FORBIDDEN)) {
    const at = match.index as number;
    out += `${xmlEscape(value.slice(from, at))}<cp hex="${(match[0].codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}"/>`;
    from = at + 1;
  }
  return out + xmlEscape(value.slice(from));
}

/** XLIFF 2.0 for one language: the address is the unit id, the default the source, the text the target. */
export function exportXliff(texts: readonly ExchangeText[], locale: string, scope: ExchangeScope, header: ExchangeHeader): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="${xmlEscape(header.defaultLocale)}" trgLang="${xmlEscape(locale)}">`,
    `  <file id="f1"${header.form === undefined ? "" : ` original="${xmlEscape(header.form)}"`} xml:space="preserve">`
  ];
  for (const text of textsInScope(texts, [locale], scope)) {
    if (text.default === "" || !applies(text, locale)) {
      continue;
    }
    const translated = text.texts[locale] ?? "";
    lines.push(`    <unit id="${xmlEscape(unitId(text.address))}">`);
    lines.push("      <notes>");
    lines.push(`        <note category="location">${xmlEscape(text.where)}</note>`);
    lines.push("      </notes>");
    // XLIFF 2.0 states: a translation to make is `initial`; one made is `translated`, and one
    // made for a default that has since changed says so in a `datum:` subState.
    const status = statusOf(text, locale);
    const state = status === "missing" ? "initial" : "translated";
    lines.push(`      <segment state="${state}"${status === "stale" ? ' subState="datum:stale"' : ""}>`);
    lines.push(`        <source>${xliffText(text.default)}</source>`);
    lines.push(`        <target>${xliffText(translated)}</target>`);
    lines.push("      </segment>");
    lines.push("    </unit>");
  }
  lines.push("  </file>", "</xliff>");
  return `${lines.join("\n")}\n`;
}

/**
 * The text a person pastes into an AI assistant: a short instruction and the CSV. The prompt is
 * data for the assistant, not builder chrome, so it is not worded through the builder's catalog.
 */
export function promptText(texts: readonly ExchangeText[], locales: readonly string[], scope: ExchangeScope, header: ExchangeHeader): string {
  // A translation of a default that has since changed is written as an empty cell, so the
  // assistant refreshes it instead of handing the outdated wording back unchanged.
  const asked = textsInScope(texts, locales, scope).map((text) => {
    const stale = locales.filter((locale) => isStaleIn(text, locale));
    if (stale.length === 0) {
      return text;
    }
    const kept = { ...text.texts };
    for (const locale of stale) {
      delete kept[locale];
    }
    return { ...text, texts: kept };
  });
  // Rows of kind "texts" are the engine's own words, written in English: the default language's
  // column holds only those, and English has none of them. Every other cell of those two columns
  // is empty on purpose, so the assistant is told to leave it empty.
  const defaultKey = normalizeLocaleTag(header.defaultLocale);
  const defaultColumn = locales.find((locale) => normalizeLocaleTag(locale) === defaultKey);
  const englishColumn = locales.find((locale) => primaryLocaleSubtag(locale.trim()).toLowerCase() === "en");
  const leaveEmpty: string[] = [];
  if (defaultColumn !== undefined) {
    leaveEmpty.push(`The column lang:${defaultColumn} is the form's own language: translate only the rows of kind "texts" there (their default text is English) and leave its cell empty on every other row.`);
  }
  if (englishColumn !== undefined && englishColumn !== defaultColumn) {
    leaveEmpty.push(`Rows of kind "texts" are already English: leave their lang:${englishColumn} cell empty.`);
  }
  return [
    `Below is a CSV of the texts of a web form, written in "${header.defaultLocale}". Translate each text into the language columns (${locales.map((locale) => `lang:${locale}`).join(", ")}).`,
    "Fill every empty cell of those columns. A cell is empty either because it was never translated or because its default text changed since; keep the cells that hold a translation as they are.",
    ...leaveEmpty,
    'Do not change or reorder the rows, and do not change the header row or the columns "kind", "key", "path", "where", "default" and "source"; "where" only tells you which field or part the text belongs to.',
    "Keep placeholders such as {{name}}, HTML tags and punctuation conventions exactly as in the default text.",
    "Answer with the complete CSV only, quoted as RFC 4180 (double a quote inside a quoted cell), and nothing else.",
    "",
    exportCsv(asked, locales, "all", { status: false }).replace(/\r\n$/, "")
  ].join("\n");
}

// --- Import: reading a file ---------------------------------------------------------------

/** A text of the file before it is matched to the form: an address as the file spelled it and its cells. */
interface RawRow {
  row: number;
  address: AddressResult;
  /** The file's source fingerprint, if it stated one. */
  source?: string;
  /** Locale column (as the file spelled it) and its text. */
  cells: Array<[string, string]>;
  /** An XLIFF unit with a source and no target element. */
  noTarget?: true;
}

type Parsed = { rows: RawRow[]; problems: ImportProblem[] } | { refusal: ImportProblem };

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OWN = Object.prototype.hasOwnProperty;

function ownString(record: Record<string, unknown>, key: string): string | undefined {
  const value = OWN.call(record, key) ? record[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

// JSON

const RESERVED_COLUMNS: ReadonlySet<string> = new Set(["kind", "key", "path", "where", "note", "default", "source", "status"]);

/**
 * JSON keys a spreadsheet-minded author commonly adds to a row that the controller's code
 * pattern would still take for a language ("id" is two letters). A CSV names its language
 * columns with `lang:`, so only JSON, whose keys carry no prefix, needs the list. A form that
 * declares one of them as a language matches it earlier; only a new language is refused under
 * these names.
 */
const JSON_NOT_A_LANGUAGE: ReadonlySet<string> = new Set(["id", "ref", "tag", "uid", "url", "row", "num", "nr", "no"]);

function parseJson(text: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { refusal: { code: "malformedJson" } };
  }
  let list: unknown;
  if (Array.isArray(value)) {
    list = value;
  } else if (isRecord(value) && OWN.call(value, "texts")) {
    list = value.texts;
  }
  if (!Array.isArray(list)) {
    return { refusal: { code: "unrecognizedShape" } };
  }
  if (list.length > MAX_IMPORT_ROWS) {
    return { refusal: { code: "tooManyRows" } };
  }
  const rows: RawRow[] = [];
  const problems: ImportProblem[] = [];
  list.forEach((item, index) => {
    const row = index + 1;
    if (!isRecord(item)) {
      problems.push({ code: "unrecognizedShape", row });
      return;
    }
    const kind = ownString(item, "kind");
    const key = ownString(item, "key") ?? "";
    const path = OWN.call(item, "path") ? item.path : undefined;
    if (kind === undefined || (typeof path !== "string" && !Array.isArray(path))) {
      problems.push({ code: "badAddress", row });
      return;
    }
    // A path hand-written as an array of segments is taken as it is; a string is the export's spelling.
    const address =
      typeof path === "string"
        ? addressFromStrings(kind, key, path)
        : addressFromParts(kind, key, path.every((segment) => typeof segment === "string") ? (path as string[]) : []);
    const cells: Array<[string, string]> = [];
    for (const name of Object.keys(item)) {
      if (RESERVED_COLUMNS.has(name)) {
        continue;
      }
      const cell = item[name];
      if (typeof cell === "string") {
        cells.push([name, cell]);
      } else if (cell !== undefined && cell !== null) {
        problems.push({ code: "badCell", row, detail: name });
      }
    }
    const stated = ownString(item, "source");
    const source = isSourceHash(stated) ? stated : undefined;
    rows.push({ row, address, ...(source ? { source } : {}), cells });
  });
  return { rows, problems };
}

// CSV

function detectDelimiter(text: string): string {
  // A spreadsheet in a French or German locale saves with `;`, and some tools with tabs: the
  // header line (outside quotes) says which. The export itself always uses commas.
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (c === '"') {
      quoted = !quoted;
    } else if (!quoted && (c === "\n" || c === "\r")) {
      break;
    } else if (!quoted && OWN.call(counts, c)) {
      counts[c] = (counts[c] ?? 0) + 1;
    }
  }
  let best = ",";
  for (const candidate of [";", "\t"]) {
    if ((counts[candidate] ?? 0) > (counts[best] ?? 0)) {
      best = candidate;
    }
  }
  return best;
}

/** `positions[i]` is where `records[i]` sat in the file, blank records counted (a problem names it). */
type CsvRecords = { records: string[][]; positions: number[] } | { error: "malformed" | "tooMany" };

function readCsvRecords(text: string, delimiter: string): CsvRecords {
  const stop = new RegExp(`[${delimiter === "\t" ? "\\t" : delimiter}\\r\\n]`, "g");
  const records: string[][] = [];
  const positions: number[] = [];
  let seen = 0;
  let record: string[] = [];
  // A blank line is no record: it is skipped before it counts toward the row cap, so a file of
  // exactly the cap that ends in blank lines is read, and the positions still follow the file.
  const finish = (): boolean => {
    if (!(record.length === 1 && record[0] === "")) {
      records.push(record);
      positions.push(seen);
    }
    seen += 1;
    record = [];
    return records.length <= MAX_IMPORT_ROWS + 1;
  };
  let i = 0;
  const n = text.length;
  const nextStop = (from: number): number => {
    stop.lastIndex = from;
    const match = stop.exec(text);
    return match ? match.index : n;
  };
  while (i < n) {
    let field: string;
    if (text[i] === '"') {
      i += 1;
      let quoted = "";
      for (;;) {
        const quote = text.indexOf('"', i);
        if (quote < 0) {
          return { error: "malformed" };
        }
        quoted += text.slice(i, quote);
        if (text[quote + 1] === '"') {
          quoted += '"';
          i = quote + 2;
          continue;
        }
        i = quote + 1;
        break;
      }
      // Text after the closing quote (a sloppy writer) is kept rather than refused.
      const end = nextStop(i);
      // A line break inside quotes reads as the one break the form's texts hold (`\n`), the way
      // a spreadsheet saving in Windows text mode wrote it as `\r\n`.
      field = quoted.replace(/\r\n?/g, "\n") + text.slice(i, end);
      i = end;
    } else {
      const end = nextStop(i);
      field = text.slice(i, end);
      i = end;
    }
    record.push(field);
    if (i >= n) {
      finish();
      break;
    }
    if (text[i] === delimiter) {
      i += 1;
      if (i >= n) {
        record.push("");
        finish();
      }
      continue;
    }
    i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1;
    if (!finish()) {
      return { error: "tooMany" };
    }
  }
  if (records.length > MAX_IMPORT_ROWS + 1) {
    return { error: "tooMany" };
  }
  return { records, positions };
}

function parseCsv(text: string): Parsed {
  const read = readCsvRecords(text, detectDelimiter(text));
  if ("error" in read) {
    return { refusal: { code: read.error === "tooMany" ? "tooManyRows" : "malformedCsv" } };
  }
  const { records, positions } = read;
  const header = (records[0] ?? []).map((name) => name.trim());
  const lower = header.map((name) => name.toLowerCase());
  const column = (name: string): number => lower.indexOf(name);
  if (column("kind") < 0 || column("path") < 0) {
    return { refusal: { code: "missingColumns" } };
  }
  // Each language may bring a status column beside its own.
  if (header.length > 2 * MAX_LOCALES + RESERVED_COLUMNS.size + 1) {
    return { refusal: { code: "tooManyLocales" } };
  }
  // Only a header with the `lang:` prefix names a language; any other column (a note, a status,
  // a translator's remark) is left alone, whatever it is called.
  const localeColumns: Array<[number, string]> = [];
  header.forEach((name, index) => {
    if (LANGUAGE_PREFIX.test(name)) {
      // A bare `lang:` names no code; the dialog reports the header as it was written.
      const code = name.replace(LANGUAGE_PREFIX, "").trim();
      localeColumns.push([index, code === "" ? name : code]);
    }
  });
  const rows: RawRow[] = [];
  const problems: ImportProblem[] = [];
  if (localeColumns.length === 0 && records.length > 1) {
    problems.push({ code: "noLanguageColumns" });
  }
  // The header is the first record kept; a problem's `row` is how far into the file a record sat
  // from it, blank lines included.
  const base = positions[0] ?? 0;
  for (let r = 1; r < records.length; r += 1) {
    const record = (records[r] as string[]).map(unguardSpreadsheetCell);
    const cell = (name: string): string => record[column(name)] ?? "";
    const stated = column("source") < 0 ? "" : cell("source").trim();
    const source = isSourceHash(stated) ? stated : "";
    // A cell that lost its quotes around a comma spills into more fields than the header has, and
    // every cell after it reads one column to the left. A row that is wider than the header, or
    // whose `source` is no fingerprint, is such a row: reading it would write a fingerprint or a
    // status word as a translation, so it is reported and left out. A short row is fine.
    if (record.slice(header.length).some((field) => field.trim() !== "") || (stated !== "" && source === "")) {
      problems.push({ code: "badRow", row: (positions[r] as number) - base });
      continue;
    }
    rows.push({
      row: (positions[r] as number) - base,
      address: addressFromStrings(cell("kind"), column("key") < 0 ? "" : cell("key"), cell("path")),
      ...(source ? { source } : {}),
      cells: localeColumns.map(([index, name]): [string, string] => [name, record[index] ?? ""])
    });
  }
  return { rows, problems };
}

// XLIFF

interface XmlNode {
  name: string;
  attrs: Map<string, string>;
  content: Array<string | XmlNode>;
}

/** `unit` is the id of the XLIFF unit the reader was inside when it gave up, when it was inside one. */
type XmlResult = { root: XmlNode } | { error: "malformedXml"; unit?: string } | { error: "unsafeXml" };

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

/** Decodes the five predefined entities and numeric references; `undefined` on anything else. */
function decodeEntities(value: string): string | undefined {
  if (!value.includes("&")) {
    return value;
  }
  let out = "";
  let i = 0;
  for (;;) {
    const amp = value.indexOf("&", i);
    if (amp < 0) {
      return out + value.slice(i);
    }
    const semi = value.indexOf(";", amp);
    if (semi < 0 || semi - amp > 12) {
      return undefined;
    }
    out += value.slice(i, amp);
    const body = value.slice(amp + 1, semi);
    if (body === "amp") {
      out += "&";
    } else if (body === "lt") {
      out += "<";
    } else if (body === "gt") {
      out += ">";
    } else if (body === "quot") {
      out += '"';
    } else if (body === "apos") {
      out += "'";
    } else {
      const match = /^#(?:x([0-9A-Fa-f]+)|([0-9]+))$/.exec(body);
      if (!match) {
        return undefined;
      }
      const code = match[1] ? parseInt(match[1], 16) : parseInt(match[2] as string, 10);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return undefined;
      }
      out += String.fromCodePoint(code);
    }
    i = semi + 1;
  }
}

function parseXml(source: string): XmlResult {
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let closed = false;
  let i = 0;
  const n = source.length;
  // The innermost open unit names where the document broke, so the author can find it.
  const bad = (): XmlResult => {
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      const open = stack[k] as XmlNode;
      if (localName(open.name) === "unit") {
        const unit = open.attrs.get("id");
        return unit === undefined ? { error: "malformedXml" } : { error: "malformedXml", unit };
      }
    }
    return { error: "malformedXml" };
  };
  const startTag = /<([^\s/>=<"']+)/y;
  const attribute = /\s*([^\s=/>"'<]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  const tagEnd = /\s*(\/?)>/y;
  while (i < n) {
    const lt = source.indexOf("<", i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      const chunk = source.slice(i, textEnd);
      const top = stack[stack.length - 1];
      if (top === undefined) {
        if (chunk.trim() !== "") {
          return bad();
        }
      } else {
        const decoded = decodeEntities(chunk);
        if (decoded === undefined) {
          return bad();
        }
        top.content.push(decoded);
      }
      i = textEnd;
    }
    if (lt < 0) {
      break;
    }
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end < 0) {
        return bad();
      }
      i = end + 3;
    } else if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      const top = stack[stack.length - 1];
      if (end < 0 || top === undefined) {
        return bad();
      }
      top.content.push(source.slice(i + 9, end));
      i = end + 3;
    } else if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      if (end < 0) {
        return bad();
      }
      i = end + 2;
    } else if (source.startsWith("<!", i)) {
      // A document type declaration is where entity definitions live; an XLIFF file has no use for one.
      return { error: "unsafeXml" };
    } else if (source.startsWith("</", i)) {
      const end = source.indexOf(">", i);
      const top = stack[stack.length - 1];
      if (end < 0 || top === undefined || source.slice(i + 2, end).trim() !== top.name) {
        return bad();
      }
      stack.pop();
      i = end + 1;
      if (stack.length === 0) {
        closed = true;
      }
    } else {
      if (closed) {
        return bad();
      }
      startTag.lastIndex = i;
      const tag = startTag.exec(source);
      if (!tag) {
        return bad();
      }
      i = startTag.lastIndex;
      const node: XmlNode = { name: tag[1] as string, attrs: new Map(), content: [] };
      for (;;) {
        attribute.lastIndex = i;
        const attr = attribute.exec(source);
        if (!attr) {
          break;
        }
        const value = decodeEntities(attr[2] ?? attr[3] ?? "");
        if (value === undefined) {
          return bad();
        }
        node.attrs.set(localName(attr[1] as string), value);
        i = attribute.lastIndex;
      }
      tagEnd.lastIndex = i;
      const endMatch = tagEnd.exec(source);
      if (!endMatch) {
        return bad();
      }
      i = tagEnd.lastIndex;
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.content.push(node);
      } else {
        root = node;
      }
      if (endMatch[1] === "/") {
        if (stack.length === 0) {
          closed = true;
        }
      } else {
        if (stack.length >= MAX_XML_DEPTH) {
          return bad();
        }
        stack.push(node);
      }
    }
  }
  return stack.length === 0 && root !== undefined && closed ? { root } : bad();
}

/**
 * The text of a `<source>` or `<target>`. `<cp hex>` is the character XML 1.0 cannot carry (the
 * exporter writes it); an empty `<ph/>`, `<sc/>` or `<ec/>` a CAT tool left for a placeholder or a
 * protected tag reads as its `equiv`, else its `disp`; one with neither cannot be read
 * faithfully, so `lost` is set and the caller reports the cell instead of importing a text with
 * the markup missing. A `<pc>` pair reads as its inner text.
 */
const INLINE_CODES: ReadonlySet<string> = new Set(["ph", "sc", "ec"]);

function textContent(node: XmlNode, state: { lost: boolean }): string {
  let out = "";
  for (const part of node.content) {
    if (typeof part === "string") {
      out += part;
    } else if (localName(part.name) === "cp") {
      const code = /^[0-9A-Fa-f]{1,6}$/.test(part.attrs.get("hex") ?? "") ? parseInt(part.attrs.get("hex") as string, 16) : -1;
      if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        state.lost = true;
      } else {
        out += String.fromCodePoint(code);
      }
    } else if (INLINE_CODES.has(localName(part.name)) && part.content.length === 0) {
      const stand = part.attrs.get("equiv") || part.attrs.get("disp");
      if (stand === undefined || stand === "") {
        state.lost = true;
      } else {
        out += stand;
      }
    } else {
      out += textContent(part, state);
    }
  }
  return out;
}

function elementsNamed(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = [];
  const pending: XmlNode[] = [node];
  while (pending.length > 0) {
    const next = pending.pop() as XmlNode;
    if (localName(next.name) === name) {
      found.push(next);
    }
    for (let i = next.content.length - 1; i >= 0; i -= 1) {
      const part = next.content[i];
      if (part !== undefined && typeof part !== "string") {
        pending.push(part);
      }
    }
  }
  return found;
}

function parseXliff(text: string): Parsed {
  // XML 1.0 §2.11: a processor sees `\r\n` and a lone `\r` as `\n`, before anything is parsed
  // (a `&#13;` reference, decoded after, still means a carriage return).
  const parsed = parseXml(text.replace(/\r\n?/g, "\n"));
  if ("error" in parsed) {
    return { refusal: { code: parsed.error, ...("unit" in parsed && parsed.unit !== undefined ? { detail: parsed.unit } : {}) } };
  }
  if (localName(parsed.root.name) !== "xliff") {
    return { refusal: { code: "notXliff" } };
  }
  const locale = parsed.root.attrs.get("trgLang");
  if (!locale) {
    return { refusal: { code: "missingTargetLanguage" } };
  }
  const units = elementsNamed(parsed.root, "unit");
  if (units.length > MAX_IMPORT_ROWS) {
    return { refusal: { code: "tooManyRows" } };
  }
  const rows: RawRow[] = [];
  const problems: ImportProblem[] = [];
  units.forEach((unit, index) => {
    const row = index + 1;
    const id = unit.attrs.get("id");
    if (id === undefined) {
      problems.push({ code: "badAddress", row });
      return;
    }
    let sourceText: string | undefined;
    let targetText: string | undefined;
    const state = { lost: false };
    for (const segment of elementsNamed(unit, "segment")) {
      for (const part of segment.content) {
        if (typeof part === "string") {
          continue;
        }
        if (localName(part.name) === "source") {
          sourceText = (sourceText ?? "") + textContent(part, { lost: false });
        } else if (localName(part.name) === "target") {
          targetText = (targetText ?? "") + textContent(part, state);
        }
      }
    }
    if (state.lost) {
      // A placeholder or character the file does not spell out: better a named problem than a
      // quietly shortened translation.
      problems.push({ code: "badCell", row, detail: id });
      return;
    }
    // XLIFF carries the default itself rather than a fingerprint; hashing it gives the same comparison.
    rows.push({
      row,
      address: addressFromUnitId(id),
      ...(sourceText === undefined ? {} : { source: sourceHash(sourceText) }),
      cells: targetText === undefined ? [] : [[locale, targetText]],
      ...(targetText === undefined ? { noTarget: true as const } : {})
    });
  });
  return { rows, problems };
}

// --- Import: preview ---------------------------------------------------------------------

function detectFormat(text: string): ImportFormat {
  const head = text.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) {
    return "json";
  }
  return head.startsWith("<") ? "xliff" : "csv";
}

/**
 * Reads a file and compares it with the form, changing nothing. The format is detected by content
 * (a JSON object or array, an XLIFF root element, else CSV); a byte-order mark is tolerated.
 */
export function previewImport(
  file: { name: string; text: string },
  texts: readonly ExchangeText[],
  declaredLocales: readonly string[],
  options: ImportOptions
): ImportPreview {
  const preview: ImportPreview = {
    name: file.name,
    rows: [],
    newLocales: [],
    unknownCount: 0,
    noTargetCount: 0,
    counts: { new: 0, changed: 0, unchanged: 0, unknown: 0, skipped: 0, stale: 0 },
    problems: []
  };
  const problems = preview.problems;
  let overflowed = false;
  const note = (problem: ImportProblem): void => {
    if (problems.length < MAX_PROBLEMS) {
      problems.push(problem);
    } else if (!overflowed) {
      overflowed = true;
      problems.push({ code: "moreProblems" });
    }
  };

  const raw = file.text.charCodeAt(0) === 0xfeff ? file.text.slice(1) : file.text;
  // Characters are never more than bytes, so a text over the cap in characters is over it in bytes;
  // only one that could fit pays for the exact count.
  if (raw.length > MAX_IMPORT_BYTES || utf8Length(raw) > MAX_IMPORT_BYTES) {
    note({ code: "tooLarge" });
    return preview;
  }
  if (raw.trim() === "") {
    note({ code: "empty" });
    return preview;
  }

  const format = detectFormat(raw);
  preview.format = format;
  const parsed = format === "json" ? parseJson(raw) : format === "xliff" ? parseXliff(raw) : parseCsv(raw);
  if ("refusal" in parsed) {
    note(parsed.refusal);
    return preview;
  }
  parsed.problems.forEach(note);

  const byAddress = new Map<string, ExchangeText>();
  for (const text of texts) {
    byAddress.set(addressKey(text.address), text);
  }
  const declared = new Map<string, string>();
  for (const code of declaredLocales) {
    declared.set(normalizeLocaleTag(code), code);
  }
  const defaultKey = options.defaultLocale === undefined ? undefined : normalizeLocaleTag(options.defaultLocale);

  // A file column is resolved once: to the form's spelling, to a new language, to the default
  // language (read for the engine's own words only), or to nothing.
  type Column = { locale: string; isNew: boolean; isDefault?: true } | null;
  const columns = new Map<string, Column>();
  // The new languages resolved so far, by their normalized tag: counted once as they are found
  // (the cap test must not walk every column seen), and `fr-CA`, `FR_ca` and `fr-ca` are one.
  const newLocales = new Map<string, Column>();
  const resolveColumn = (column: string, row: number): Column => {
    const known = columns.get(column);
    if (known !== undefined) {
      return known;
    }
    let resolved: Column = null;
    const code = column.trim();
    const key = normalizeLocaleTag(code);
    const spelled = declared.get(key);
    if (key === defaultKey) {
      // The default language's own wording is the form's property, so only an engine word takes
      // a cell here: the cell loop refuses the rest, once for the column.
      resolved = { locale: spelled ?? options.defaultLocale ?? code, isNew: false, isDefault: true };
    } else if (spelled !== undefined) {
      resolved = { locale: spelled, isNew: false };
    } else if (
      languageCodeProblem(code.replace(/_/g, "-"), undefined) !== undefined ||
      (format === "json" && JSON_NOT_A_LANGUAGE.has(code.toLowerCase())) ||
      !isSafeSegment(code)
    ) {
      // Only what the controller would accept as a language is a language: a CSV names its
      // language columns with `lang:`, and a JSON key that is no code (or is one of the
      // names a row commonly carries) is reported and skipped, never added to the form.
      note({ code: "badLocale", row, detail: column });
    } else if (newLocales.has(key)) {
      resolved = newLocales.get(key) as Column;
    } else if (newLocales.size >= MAX_LOCALES) {
      note({ code: "tooManyLocales", row, detail: column });
    } else {
      resolved = { locale: code.replace(/_/g, "-"), isNew: true };
      newLocales.set(key, resolved);
    }
    columns.set(column, resolved);
    return resolved;
  };

  // One cell per language and address: a later row of the same cell replaces the earlier one.
  const cells = new Map<string, ImportRow>();
  const unknownAddresses = new Set<string>();
  const refusedDefault = new Set<string>();
  for (const entry of parsed.rows) {
    if ("problem" in entry.address) {
      note({ code: entry.address.problem, row: entry.row, ...(entry.address.detail === undefined ? {} : { detail: entry.address.detail }) });
      continue;
    }
    const address = entry.address.address;
    const key = addressKey(address);
    const listed = byAddress.get(key);
    if (entry.noTarget) {
      preview.noTargetCount += 1;
    }
    for (const [name, cell] of entry.cells) {
      // The grid and the agent word a cell without the space around it, and a blank cell is no
      // cell at all (it must not overwrite a real translation in Replace mode).
      const text = cell.trim();
      if (text === "") {
        continue;
      }
      const column = resolveColumn(name, entry.row);
      if (!column) {
        continue;
      }
      // A language the form lacks has no engine rows in the list yet (an English-only form lists
      // none), but once it is added the grid has them: the engine's own list is the target, and
      // the address decides whether this language has a cell for it.
      const target = listed ?? (column.isNew ? engineTarget(address) : undefined);
      if (column.isDefault && address.kind !== "texts") {
        if (!refusedDefault.has(name)) {
          refusedDefault.add(name);
          note({ code: "defaultLocaleColumn", row: entry.row, detail: name });
        }
        continue;
      }
      if (cellTooLong(text)) {
        note({ code: "tooLong", row: entry.row, detail: column.locale });
        continue;
      }
      const cellKey = `${column.locale}\u0000${key}`;
      if (cells.has(cellKey)) {
        note({ code: "duplicateRow", row: entry.row, detail: column.locale });
      }
      const current = target !== undefined && OWN.call(target.texts, column.locale) ? target.texts[column.locale] : undefined;
      // A quoted CSV cell cannot hold a carriage return (the reader reads one as a line feed), so
      // a current text that has one is the same wording as its own export.
      // A text with no cell in this language (an engine word in English, a plural form the
      // language does not use) or one the page's catalog words under the exact tag has nowhere
      // to be written that would show: it is skipped, each for its own reason. A language the
      // form lacks has no cell to judge yet, so its engine words are judged by address.
      const skip = target === undefined ? undefined : skipReason(target, column);
      const status: ImportStatus = !target ? "unknown" : skip ?? (!current ? "new" : sameWording(current, text) ? "unchanged" : "changed");
      if (!target) {
        unknownAddresses.add(key);
      }
      cells.set(cellKey, {
        address,
        locale: column.locale,
        text,
        status,
        stale: target !== undefined && entry.source !== undefined && !answersDefault(entry.source, target.default),
        newLocale: column.isNew,
        ...(current ? { current } : {}),
        ...(entry.source === undefined ? {} : { source: entry.source }),
        row: entry.row
      });
    }
  }
  for (const row of cells.values()) {
    preview.rows.push(row);
    preview.counts[countKey(row.status)] += 1;
    if (row.stale) {
      preview.counts.stale += 1;
    }
    // A language is offered for adding only when something of it would be applied.
    if (row.newLocale && !isSkipped(row.status) && !preview.newLocales.includes(row.locale)) {
      preview.newLocales.push(row.locale);
    }
  }
  preview.unknownCount = unknownAddresses.size;
  return preview;
}

let engineByAddress: ReadonlyMap<string, ExchangeText> | undefined;

/** The engine's word at `address` as an exchange text with no translation yet, from the engine's own list. */
function engineTarget(address: TextAddress): ExchangeText | undefined {
  if (address.kind !== "texts") {
    return undefined;
  }
  if (engineByAddress === undefined) {
    const map = new Map<string, ExchangeText>();
    for (const word of [...engineTexts(), ...enginePluralAddresses()]) {
      map.set(addressKey(word.address), { address: word.address, default: word.default, group: "", where: "", texts: {}, sources: {} });
    }
    engineByAddress = map;
  }
  return engineByAddress.get(addressKey(address));
}

/** Why a cell of a known text is not written: no cell there, or the page's catalog words it. */
function skipReason(target: ExchangeText, column: { locale: string; isNew: boolean }): "noCell" | "pageWorded" | undefined {
  if (column.isNew) {
    return hasNoEngineCell(target.address, column.locale) ? "noCell" : undefined;
  }
  if (!applies(target, column.locale)) {
    return "noCell";
  }
  return target.catalog?.[column.locale] === "overridden" ? "pageWorded" : undefined;
}

let pluralKeys: ReadonlySet<string> | undefined;

/**
 * Whether `locale` has no cell for the engine word at `address`, judged by the address because a
 * language the form lacks has no row to ask. The engine's words are written in English, so an
 * English language has none of them; a counted text's `<key>.<category>` form exists only in a
 * language whose plural rules use the category. Any other text has a cell in every language.
 */
function hasNoEngineCell(address: TextAddress, locale: string): boolean {
  if (address.kind !== "texts") {
    return false;
  }
  if (primaryLocaleSubtag(locale.trim()).toLowerCase() === "en") {
    return true;
  }
  pluralKeys ??= new Set(enginePluralAddresses().map((text) => addressKey(text.address)));
  return pluralKeys.has(addressKey(address)) && !enginePluralTexts(locale).some((text) => addressKey(text.address) === addressKey(address));
}

/** A row that applying leaves alone because of what the text or the language is, not because of its wording. */
function isSkipped(status: ImportStatus): boolean {
  return status === "unknown" || status === "pageWorded" || status === "noCell";
}

function countKey(status: ImportStatus): keyof ImportCounts {
  return status === "pageWorded" || status === "noCell" ? "skipped" : status;
}

/**
 * Whether two texts differ only in how a line ends (a file reader reads `\r\n` and a lone `\r`
 * as `\n`) or in the space around them (an import words a cell without it, and the map keeps
 * what the author wrote).
 */
function sameWording(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n?/g, "\n").trim() === b.replace(/\r\n?/g, "\n").trim();
}

/** Whether a file's fingerprint is that of `defaultText`, or of it read with its line ends normalised (a file from before carriage returns were written as references). */
function answersDefault(source: string, defaultText: string): boolean {
  return source === sourceHash(defaultText) || (defaultText.includes("\r") && source === sourceHash(defaultText.replace(/\r\n?/g, "\n")));
}

/** A cell over the cap in bytes; the cheap length test first, since a character is at most three bytes. */
function cellTooLong(text: string): boolean {
  return text.length > MAX_IMPORT_CELL_BYTES || (text.length * 3 > MAX_IMPORT_CELL_BYTES && utf8Length(text) > MAX_IMPORT_CELL_BYTES);
}

/**
 * The preview's counts for the languages that would be applied: a row of a new language the
 * author has not ticked is skipped, so it is not counted as new, changed or stale.
 */
export function countsFor(preview: ImportPreview, addLocales: readonly string[]): ImportCounts {
  const added = new Set(addLocales.map(normalizeLocaleTag));
  const counts: ImportCounts = { new: 0, changed: 0, unchanged: 0, unknown: 0, skipped: 0, stale: 0 };
  for (const row of preview.rows) {
    if (row.newLocale && !added.has(normalizeLocaleTag(row.locale))) {
      continue;
    }
    counts[countKey(row.status)] += 1;
    if (row.stale) {
      counts.stale += 1;
    }
  }
  return counts;
}

/** Whether a row would change the form under a mode: not an unknown address, not a no-op, not over a text in fill mode. */
export function willApply(row: ImportRow, mode: ImportMode): boolean {
  if (isSkipped(row.status) || row.status === "unchanged") {
    return false;
  }
  return mode === "replace" || row.status === "new";
}

/**
 * The edits an import makes, for the controller's `setTranslations` (one undo step). A row of a
 * language the form lacks is applied only when the author chose to add it. A row whose source no
 * longer matches is still imported; its edit carries the file's `source` so the
 * caller may keep the entry flagged "Source changed" — written plainly, `writeTranslation` stamps
 * the current default's fingerprint instead.
 */
export function applyImport(preview: ImportPreview, choices: ImportChoices): { edits: ImportEdit[] } {
  const added = new Set(choices.addLocales.map(normalizeLocaleTag));
  const edits: ImportEdit[] = [];
  for (const row of preview.rows) {
    if (!willApply(row, choices.mode)) {
      continue;
    }
    if (row.newLocale && !added.has(normalizeLocaleTag(row.locale))) {
      continue;
    }
    edits.push({
      locale: row.locale,
      address: row.address,
      text: row.text,
      ...(row.stale && row.source !== undefined ? { source: row.source } : {})
    });
  }
  return { edits };
}
