/**
 * The Languages workspace's model: every text of the form as a row keyed by the
 * address its translations live at — the texts each component declares
 * (`BuilderController.translatableTexts`), the modes' own (`BuilderMode.languageTexts`: the
 * journeys', the PDF layouts') and any text the page's catalog words that the form does not
 * list — with the default string and, per language, the cell: what the map says, whether that
 * is stale, and whether the host's catalog overrides it.
 *
 * The typed cells leave as `setTranslations` edits (`{ locale, address, text }`): the controller
 * writes every address now, so there is no "outside" edit for a mode's document and no
 * `setProperties` shape to rebuild. The language-list arithmetic is `controller/language-edits.ts`
 * and is only re-exported here, so the list and the map cannot drift apart.
 *
 * Pure functions over plain data, so the surface stays a painter and this stays testable
 * without a DOM.
 */
import type { TranslatableText } from "../controller/builder-controller.js";
import type { LocalizationConfiguration } from "../../core/schema/types.js";
import {
  TRANSLATION_KINDS,
  isSafeSegment,
  type FormTranslations,
  type TextAddress,
  type TranslationCatalog,
  type TranslationKind
} from "../../core/localization/translations.js";
import { effectiveDefaultLocale } from "../controller/language-edits.js";
import type { EngineText } from "./engine-texts.js";
import { primaryLocaleSubtag } from "../../core/localization/localized-text.js";
import {
  catalogExact,
  catalogPrimary,
  cellLocales,
  cellOf as cellFromSources,
  cellStatusOf,
  coverageOf,
  type CellStatus,
  type LanguageCoverage,
  type LanguagesCell
} from "./languages-cells.js";

// The cell rules and the language list are the leaf's (`languages-cells.ts`): the pointer line
// in the eager builder entry counts with the same functions, while this model stays a lazy chunk.
export {
  cellStatusOf,
  coverageOf,
  languageEntries,
  translationColumns,
  type CellStatus,
  type LanguageCoverage,
  type LanguageEntry,
  type LanguagesCell
} from "./languages-cells.js";

// The one copy of the language-list arithmetic (the controller's actions run it; the surface
// asks it for the problem to show before it calls an action).
export {
  defaultAfterRemoval,
  effectiveDefaultLocale,
  languageCodeProblem,
  languageRenameProblem,
  withDefaultLanguage,
  withLanguageAdded,
  withLanguageLabel,
  withLanguageRemoved,
  withLanguageRenamed
} from "../controller/language-edits.js";

/**
 * Where a text comes from, as the group rail names it. `texts` holds the engine's own words
 * (form texts and validation messages, English as their source); `catalog` what only the page's
 * catalog words.
 */
export type LanguagesGroupId = "fields" | "options" | "messages" | "chrome" | "print" | "journeys" | "pdf" | "texts" | "catalog";

/**
 * The groups in the order the rail lists them. The labels are the English the surface shows
 * until it words them through `languages.group.*` (the keys exist for all but the last).
 */
export const LANGUAGES_GROUPS: ReadonlyArray<{ id: LanguagesGroupId; label: string }> = [
  { id: "fields", label: "Fields" },
  { id: "options", label: "Options" },
  { id: "messages", label: "Messages" },
  { id: "chrome", label: "Header & footer" },
  { id: "print", label: "Print" },
  { id: "journeys", label: "Journeys" },
  { id: "pdf", label: "PDF" },
  { id: "texts", label: "Built-in texts" },
  { id: "catalog", label: "Page catalog" }
];

/** One text of the form (or of the page's catalog) as the Texts grid shows it. */
export interface LanguagesRow {
  address: TextAddress;
  groupId: LanguagesGroupId;
  /** The component it belongs to (a journey's or a layout's group id for their texts; the form root's id for the form's own). */
  componentId: string;
  componentLabel: string;
  /** What the text is: "Label", "Option “yes”", "Message “required”", "Header › welcome". */
  label: string;
  /** The text in the form's default language (an engine word's English); empty for a text only the catalog words. */
  default: string;
  /**
   * By locale, for every language but the default one. An engine word (group `texts`) has its
   * source in English, so it has a cell for every declared language not written in English,
   * the default language included.
   */
  cells: Record<string, LanguagesCell>;
  /** The builder's name for the property, when the row is a component's (what "show it in Form" selects). */
  propertyPath?: string;
  /** Whether `componentId` is a component of the form (Form can select it). */
  inForm: boolean;
}

export interface LanguagesRowsInput {
  /** The form's own texts (`BuilderController.translatableTexts()`). */
  texts: readonly TranslatableText[];
  /** The journey and PDF modes' texts (`BuilderMode.languageTexts()`), written by the controller all the same. */
  modeTexts?: readonly TranslatableText[];
  /** The committed map (`BuilderController.translations()`). */
  translations: FormTranslations | undefined;
  /** The page's catalog, when it lent one (`BuilderController.translationCatalog()`). */
  catalog?: TranslationCatalog | undefined;
  /** The form's `localization`: the languages that get a cell each, and which one is the default. */
  localization: LocalizationConfiguration | undefined;
  /** The engine's own words to list (`engineTexts()`), after the form's and the modes' texts; none when absent. */
  engineTexts?: readonly EngineText[];
  /** The counted texts' extra plural-category rows a language needs (`enginePluralTexts`), listed for the languages that have them. */
  enginePluralTexts?: ((locale: string) => readonly EngineText[]) | undefined;
}

export interface LanguagesTexts {
  rows: LanguagesRow[];
  /** Texts with no wording and no translation: nothing to translate until Form words them. */
  emptyCount: number;
}

// --- row keys -------------------------------------------------------------------------------

const ESCAPES: ReadonlyArray<[string, string]> = [["%", "%25"], ["/", "%2F"]];

function escapeSegment(segment: string): string {
  return ESCAPES.reduce((text, [raw, escaped]) => text.split(raw).join(escaped), segment);
}

function unescapeSegment(segment: string): string | undefined {
  // Only the two escapes this module writes are valid: a stray `%` is a key from somewhere else.
  const bad = segment.replace(/%25|%2F/g, "").includes("%");
  return bad ? undefined : segment.replace(/%2F/g, "/").replace(/%25/g, "%");
}

/**
 * A stable string for an address — `kind/owner/path…`, each segment with `%` and `/` escaped
 * (`form/title`, `components/contact/options/email/label`) — what the pending edits, the cells
 * and the exchange's unit ids are keyed by. Segments are ids, values and codes: a code may hold
 * a dot or a slash, so nothing here splits on a dot.
 */
export function rowKey(address: TextAddress): string {
  const segments = address.kind === "form" ? address.path : [address.owner ?? "", ...address.path];
  return [address.kind, ...segments.map(escapeSegment)].join("/");
}

/** The address a {@link rowKey} names, or `undefined` for a string that is not one (an unknown kind, an unsafe or empty segment). */
export function addressFromRowKey(key: string): TextAddress | undefined {
  const [kind, ...parts] = key.split("/");
  if (!(TRANSLATION_KINDS as readonly string[]).includes(kind ?? "")) {
    return undefined;
  }
  const segments: string[] = [];
  for (const part of parts) {
    const segment = unescapeSegment(part);
    if (segment === undefined || !isSafeSegment(segment)) {
      return undefined;
    }
    segments.push(segment);
  }
  if (kind === "form") {
    return segments.length > 0 ? { kind: "form", path: segments } : undefined;
  }
  const [owner, ...path] = segments;
  return owner !== undefined && path.length > 0 ? { kind: kind as TranslationKind, owner, path } : undefined;
}

// --- building the rows -----------------------------------------------------------------------

/** Quoted the way the controller words a value: `“yes”`. */
function quoted(text: string): string {
  return `“${text}”`;
}

/** Which group an address belongs to; a mode's text is the journeys' unless it is a layout's. */
function groupOf(address: TextAddress, fromMode: boolean): LanguagesGroupId {
  if (address.kind === "chrome") {
    return "chrome";
  }
  if (address.kind === "pdf") {
    return "pdf";
  }
  if (address.kind === "journeys" || fromMode) {
    return "journeys";
  }
  const head = address.path[0];
  if (address.kind === "form" && head === "print") {
    // The printed form's running header and footer slots.
    return "print";
  }
  return head === "options" ? "options" : head === "messages" ? "messages" : "fields";
}

/**
 * The row's label. Messages, fields and the modes' texts keep the wording the controller or the
 * mode gave; an option and a header or footer part are worded here from the address, because
 * the controller lists them with a language-neutral placeholder.
 */
function labelOf(text: TranslatableText, groupId: LanguagesGroupId, fromMode: boolean): string {
  const { address } = text;
  if (fromMode) {
    return text.label;
  }
  if (groupId === "options" && address.path.length === 3) {
    const name = `Option ${quoted(address.path[1]!)}`;
    return address.path[2] === "description" ? `${name} · Description` : name;
  }
  if (groupId === "chrome" && address.owner !== undefined) {
    // The region is not part of the address; the builder's name for the property has it.
    const region = /^chrome\.(header|footer)\./.exec(text.propertyPath)?.[1];
    const where = region === "header" ? "Header" : region === "footer" ? "Footer" : "Header & footer";
    const property = address.path[0] ?? "text";
    const name = `${where} › ${address.owner}`;
    return property === "text" ? name : `${name} · ${property.charAt(0).toUpperCase()}${property.slice(1)}`;
  }
  return text.label;
}

/** Every address with a text in the catalog, in its order (hostile depth and unsafe keys skipped). */
function catalogAddresses(catalog: TranslationCatalog | undefined): TextAddress[] {
  const out: TextAddress[] = [];
  if (!catalog) {
    return out;
  }
  const walk = (tree: unknown, kind: TranslationKind, owner: string | undefined, path: string[]): void => {
    if (typeof tree === "string") {
      if (tree !== "" && path.length > 0) {
        out.push(owner === undefined ? { kind, path } : { kind, owner, path });
      }
      return;
    }
    if (!tree || typeof tree !== "object" || Array.isArray(tree) || path.length > 12) {
      return;
    }
    for (const [segment, child] of Object.entries(tree)) {
      if (isSafeSegment(segment)) {
        walk(child, kind, owner, [...path, segment]);
      }
    }
  };
  for (const byKind of Object.values(catalog)) {
    if (!byKind || typeof byKind !== "object") {
      continue;
    }
    for (const kind of TRANSLATION_KINDS) {
      const value: unknown = Object.hasOwn(byKind, kind) ? (byKind as Record<string, unknown>)[kind] : undefined;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      if (kind === "form") {
        walk(value, kind, undefined, []);
        continue;
      }
      for (const [owner, tree] of Object.entries(value)) {
        if (isSafeSegment(owner)) {
          walk(tree, kind, owner, []);
        }
      }
    }
  }
  return out;
}

/**
 * Every text of the form, in the controller's order (the form's title first), then the modes'
 * texts, then the addresses only the page's catalog words. A text with no wording at all is
 * counted, not listed; the same address listed twice is one row.
 */
export function languagesTexts(input: LanguagesRowsInput): LanguagesTexts {
  const locales = cellLocales(input.localization);
  const rows: LanguagesRow[] = [];
  const seen = new Set<string>();
  let emptyCount = 0;
  const add = (text: TranslatableText, fromMode: boolean): void => {
    const key = rowKey(text.address);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const groupId = groupOf(text.address, fromMode);
    const cells = Object.fromEntries(locales.map((locale) => [locale, cellFromSources(input, locale, text.address, text.default)]));
    const hasWording = text.default.trim() !== "" || Object.values(cells).some((cell) => cell.text !== undefined);
    if (!hasWording) {
      emptyCount += 1;
      return;
    }
    rows.push({
      address: text.address,
      groupId,
      componentId: text.componentId,
      componentLabel: text.componentLabel,
      label: labelOf(text, groupId, fromMode),
      default: text.default,
      cells,
      propertyPath: text.propertyPath,
      inForm: !fromMode
    });
  };
  for (const text of input.texts) {
    add(text, false);
  }
  for (const text of input.modeTexts ?? []) {
    add(text, true);
  }
  // The engine's own words: English is their source, so every declared language not written in
  // English has a cell, the default language included.
  if (input.engineTexts !== undefined && input.engineTexts.length > 0) {
    const defaultLocale = effectiveDefaultLocale(input.localization);
    const engineLocales = [...(defaultLocale !== undefined && !isEnglish(defaultLocale) ? [defaultLocale] : []), ...locales.filter((locale) => !isEnglish(locale))];
    // A form written only in English has nothing to translate them into.
    for (const text of engineLocales.length > 0 ? input.engineTexts : []) {
      const key = rowKey(text.address);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({
        address: text.address,
        groupId: "texts",
        componentId: "",
        componentLabel: text.table === "messages" ? "Validation message" : "Form text",
        label: text.key,
        default: text.default,
        cells: Object.fromEntries(engineLocales.map((locale) => [locale, cellFromSources(input, locale, text.address, text.default)])),
        inForm: false
      });
    }
    // A language with more plural forms than English words the extra ones of each counted text.
    const plural = input.enginePluralTexts;
    for (const locale of plural !== undefined && input.engineTexts.length > 0 ? engineLocales : []) {
      for (const text of plural?.(locale) ?? []) {
        const key = rowKey(text.address);
        const row = seen.has(key) ? rows.find((candidate) => rowKey(candidate.address) === key) : undefined;
        if (row !== undefined) {
          row.cells[locale] = cellFromSources(input, locale, text.address, text.default);
          continue;
        }
        seen.add(key);
        rows.push({
          address: text.address,
          groupId: "texts",
          componentId: "",
          componentLabel: "Form text",
          label: text.key,
          default: text.default,
          cells: { [locale]: cellFromSources(input, locale, text.address, text.default) },
          inForm: false
        });
      }
    }
  }
  // What only the page's catalog words: read-only rows with no default, so the author sees the
  // page speaks for them. A catalog text in a language the form does not declare is not shown.
  for (const address of catalogAddresses(input.catalog)) {
    const key = rowKey(address);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const cells: Record<string, LanguagesCell> = {};
    for (const locale of locales) {
      // A text only the page words is never the author's to translate, whichever tag the page worded it under.
      const held = catalogExact(input.catalog, locale, address) ?? catalogPrimary(input.catalog, locale, address);
      if (held !== undefined) {
        cells[locale] = { stale: false, overriddenBy: "catalog", catalogText: held };
      }
    }
    if (Object.keys(cells).length === 0) {
      continue;
    }
    const owner = address.owner ?? "";
    rows.push({
      address,
      groupId: "catalog",
      componentId: owner,
      componentLabel: owner === "" ? "Form" : owner,
      label: address.path.join(" › "),
      default: "",
      cells,
      inForm: false
    });
  }
  return { rows, emptyCount };
}

/** Whether a language is written in English (`en`, `en-CA`): an engine word's source, with no cell of its own. */
function isEnglish(locale: string): boolean {
  return primaryLocaleSubtag(locale.trim()).toLowerCase() === "en";
}

/** The rows of {@link languagesTexts}. */
export function languagesRows(input: LanguagesRowsInput): LanguagesRow[] {
  return languagesTexts(input).rows;
}

// --- cells and pending edits -------------------------------------------------------------------

/** Cells typed and not applied: row key → locale → the text as typed. */
export type LanguagesPending = Map<string, Record<string, string>>;

/** A value `map` holds under `key` itself: a hand-edited file may name a language like an `Object.prototype` member. */
function ownText(map: Record<string, string> | undefined, key: string): string | undefined {
  return map !== undefined && Object.hasOwn(map, key) && typeof map[key] === "string" ? map[key] : undefined;
}

function cellFor(row: LanguagesRow, locale: string): LanguagesCell | undefined {
  return Object.hasOwn(row.cells, locale) ? row.cells[locale] : undefined;
}

/** What a row says in `locale`, a pending edit over what the map stores (the catalog not consulted). */
export function cellText(row: LanguagesRow, locale: string, pending?: LanguagesPending): string {
  const typed = ownText(pending?.get(rowKey(row.address)), locale);
  return typed !== undefined ? typed : (cellFor(row, locale)?.text ?? "");
}

/**
 * What the form shows for the row in `locale`: the catalog's exact-tag text when it has one,
 * else the cell, else the text its base language serves while the cell is empty: the catalog's
 * primary-subtag text, then the form's own. A cell the form shows from its base language
 * has `fallbackText`; the row reads it, not the default.
 */
export function resolvedCellText(row: LanguagesRow, locale: string, pending?: LanguagesPending): string {
  const cell = cellFor(row, locale);
  if (cell?.catalogText !== undefined) {
    return cell.catalogText;
  }
  const own = cellText(row, locale, pending);
  return own.trim() === "" ? (cell?.pageText ?? cell?.fallbackText ?? own) : own;
}

/**
 * The status of a cell: `overridden` when the page's catalog words it under the exact tag
 * (nothing typed matters), else `present` for a current text, `stale` for one that answered
 * other wording, `missing` for none. A pending edit counts as the author's word: typed text is
 * present, cleared text missing. A cell with no text of its own (stored or typed) that the
 * catalog or the form's own base language words under the primary subtag is `present`: the form
 * shows that wording.
 */
export function cellStatus(row: LanguagesRow, locale: string, pending?: LanguagesPending): CellStatus {
  return cellStatusOf(cellFor(row, locale), ownText(pending?.get(rowKey(row.address)), locale));
}

/** Whether the surface may take a typed text for the cell: not the page's, not a catalog-only row. */
export function cellEditable(row: LanguagesRow, locale: string): boolean {
  return row.groupId !== "catalog" && cellFor(row, locale) !== undefined && cellFor(row, locale)?.overriddenBy !== "catalog";
}

/**
 * The cells whose typed text differs from what the map stores (both trimmed), plus a stale cell
 * typed over with the same text: that is the author saying it still reads right, and the write
 * re-fingerprints it. Read-only cells (the page's) are never changed.
 */
export function changedCells(rows: readonly LanguagesRow[], pending: LanguagesPending): Array<{ row: LanguagesRow; locale: string; text: string }> {
  const out: Array<{ row: LanguagesRow; locale: string; text: string }> = [];
  for (const row of rows) {
    const cells = pending.get(rowKey(row.address));
    if (!cells) {
      continue;
    }
    for (const [locale, text] of Object.entries(cells)) {
      const cell = cellFor(row, locale);
      if (!cellEditable(row, locale) || !cell) {
        continue;
      }
      if (text.trim() !== (cell.text ?? "").trim() || (cell.stale && text.trim() !== "")) {
        out.push({ row, locale, text: text.trim() });
      }
    }
  }
  return out;
}

/** One `BuilderController.setTranslations` edit. */
export interface LanguagesEdit {
  locale: string;
  address: TextAddress;
  text: string;
}

/**
 * The pending cells as edits for one `setTranslations` call (one undo step). The controller
 * writes every address the form has (its tree's, the journeys', the layouts'), skips the
 * default language, and gives each entry the fingerprint of the current default; an empty text
 * deletes the entry. Rows come from {@link languagesRows}, so a cell for the default language
 * does not exist to be edited here — its text is the property itself.
 */
export function languagesEdits(rows: readonly LanguagesRow[], pending: LanguagesPending): LanguagesEdit[] {
  // The grid words a cell without the space around it; the map keeps whatever it is given.
  return changedCells(rows, pending).map(({ row, locale, text }) => ({ locale, address: row.address, text: text.trim() }));
}

// --- filters and coverage ----------------------------------------------------------------------

export interface LanguagesFilter {
  /** `"all"` (or absent) or one group. */
  group?: LanguagesGroupId | "all";
  /** Rows with a cell in this state in one of the asked languages; `"all"` (or absent) keeps every row. */
  status?: "all" | CellStatus;
  /** Matched against the component, the label, the default and the translations, ignoring case. */
  query?: string;
  /** Only the texts of one component (what the goto event asks for). */
  componentId?: string;
  /** Only the texts of one header or footer part (`chrome › <id> › …`): what the Header & footer panel's goto asks for. */
  chromePartId?: string;
  /** `"all"` (or absent) or one language's code: which cells the status and the query look at. */
  language?: string;
}

/**
 * The rows the filter keeps; a status is judged in `locales` (or the one language chosen), the pending cells over the stored.
 * The text search reads the row's name and place as the surface draws them (`labelOf`), so a
 * builder worded in another language is searched in the words its author sees; without one it
 * reads the model's own English fields.
 */
export function filterLanguagesRows(
  rows: readonly LanguagesRow[],
  filter: LanguagesFilter,
  locales: readonly string[],
  pending?: LanguagesPending,
  labelOf?: (row: LanguagesRow) => string
): LanguagesRow[] {
  const needle = (filter.query ?? "").trim().toLocaleLowerCase();
  const asked = filter.language === undefined || filter.language === "all" ? locales : locales.filter((code) => code === filter.language);
  const status = filter.status ?? "all";
  return rows.filter((row) => {
    if (filter.group !== undefined && filter.group !== "all" && row.groupId !== filter.group) {
      return false;
    }
    if (filter.componentId !== undefined && row.componentId !== filter.componentId) {
      return false;
    }
    if (filter.chromePartId !== undefined && !(row.address.kind === "chrome" && row.address.owner === filter.chromePartId)) {
      return false;
    }
    // A catalog-only row has a cell only for the languages the page words; it is judged on those.
    if (status !== "all" && !asked.some((code) => cellFor(row, code) !== undefined && cellStatus(row, code, pending) === status)) {
      return false;
    }
    if (needle.length > 0) {
      const haystack = [labelOf ? labelOf(row) : `${row.componentLabel}\n${row.label}`, row.default, ...asked.map((code) => resolvedCellText(row, code, pending))].join("\n").toLocaleLowerCase();
      if (!haystack.includes(needle)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * How much of the form says something in `locale`, the pending cells over the stored. Stale
 * counts as missing for the percentage; a text the page's catalog words counts as translated
 * (the form shows it): under the exact tag always, under the primary subtag only while nothing is
 * stored or typed (through {@link cellStatus}). Texts only the catalog words are not the
 * form's, and are left out, as are the engine's own words (group `texts`).
 */
export function languageCoverage(rows: readonly LanguagesRow[], locale: string, pending?: LanguagesPending): LanguageCoverage {
  // The engine's own words read in English until translated, so they are not counted against the form's texts.
  return coverageOf(rows.filter((row) => row.groupId !== "catalog" && row.groupId !== "texts").map((row) => cellStatus(row, locale, pending)));
}

/** The groups that have rows, in rail order, with how many each has. */
export function languagesGroupsOf(rows: readonly LanguagesRow[]): Array<{ id: LanguagesGroupId; label: string; count: number }> {
  return LANGUAGES_GROUPS.map((group) => ({ ...group, count: rows.filter((row) => row.groupId === group.id).length })).filter((group) => group.count > 0);
}

/** How many of the rows have wording of their own in `code` that becoming the default would promote. */
export function promotedTextCount(rows: readonly LanguagesRow[], code: string): number {
  // An engine word's translation stays under its language when that language becomes the default.
  return rows.filter((row) => row.groupId !== "catalog" && row.groupId !== "texts" && (cellFor(row, code)?.text ?? "").trim().length > 0).length;
}
