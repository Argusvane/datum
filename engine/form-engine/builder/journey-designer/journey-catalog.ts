/**
 * A form's journeys as a catalog the builder edits: add, copy, rename, remove, choose
 * the default and what the form opens as, with ids kept unique and the default following a
 * rename. It mirrors the PDF layouts' catalog (`pdf-designer/layout-catalog.ts`); the runtime side
 * needs nothing new, since `findJourney` and `resolveJourneySelection` already read the block.
 *
 * Pure functions over the definition's `journey` block: each returns a new block and leaves the
 * one given alone. Three rules keep what an author wrote by hand intact:
 *
 * - **Only usable journeys are listed.** A journey that fails `validateJourneyShape` is one the
 *   runtime never reads (`readJourneys` drops it), and a journey whose id an earlier journey
 *   already has is one nothing can open (`findJourney` finds the first). Both stay in the block
 *   exactly where and as they were, are never listed or edited here, and are reported by
 *   {@link unlistedJourneysOf} so the builder can say so.
 * - **Keys this module does not know are kept**, on the block and on each journey, in their
 *   order; a key the catalog changes keeps its place too.
 * - **Nothing written fails the shape check.** Adding or replacing a journey that would be
 *   dropped on the next read throws instead, since a saved file would silently lose it.
 *
 * A journey whose pages hold nodes of its own (page-only fields, written as objects
 * beside the component ids) is listed like any other, and every action here — the default, a
 * rename, a copy, a removal — leaves its pages exactly as written. The designer opens it too:
 * its tree holds those nodes as written (`journey-tree.ts`).
 *
 * Static and free of work at import (`sideEffects: false`): the builder's bundle
 * carries it before the Journeys designer's chunk is loaded.
 */
import { addressOf, resolveText, type TextAddress, type TextSources } from "../../core/localization/translations.js";
import { validateJourneyShape, type Journey, type JourneyConfiguration } from "../../core/schema/journey.js";
import { kernelStructureMessage } from "../../core/expressions/definition-structure.js";
import { fitsComponentIdGrammar } from "../../core/tree/component-id.js";
import { isPrototypeName } from "../../core/tree/prototype-names.js";
import { builderText, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";

/** What the form opens as when the host does not say: its default journey, or the whole form. */
export type JourneyOpensAs = NonNullable<JourneyConfiguration["opensAs"]>;

/** Why a declared journey is not listed. */
export type UnlistedJourneyReason =
  /** It fails `validateJourneyShape`, so the runtime never reads it. */
  | "unreadable"
  /** An earlier usable journey has its id, so nothing can open it. */
  | "duplicate-id";

/** A declared journey the catalog keeps as it is but does not list. */
export interface UnlistedJourney {
  /** Its position in the declared `journeys` list. */
  index: number;
  reason: UnlistedJourneyReason;
  /** Its id, when it has a usable one. */
  id?: string;
  /** Why it is unreadable, from `validateJourneyShape`; empty for a duplicate. */
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `journeys` list as declared, usable or not. */
function declaredJourneys(configuration: JourneyConfiguration | undefined): unknown[] {
  const journeys = configuration?.journeys as unknown;
  return Array.isArray(journeys) ? journeys : [];
}

/** The id a declared entry carries, whether or not the entry is usable. */
function declaredId(entry: unknown): string | undefined {
  return isRecord(entry) && typeof entry.id === "string" && entry.id !== "" ? entry.id : undefined;
}

/** Declared index -> whether the catalog lists that entry: usable, and the first with its id. */
function listedIndexes(configuration: JourneyConfiguration | undefined): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  declaredJourneys(configuration).forEach((entry, index) => {
    if (validateJourneyShape(entry).length > 0) {
      return;
    }
    const id = (entry as Journey).id;
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    out.push(index);
  });
  return out;
}

/**
 * The journeys the catalog lists, in declared order: each usable one (it passes
 * `validateJourneyShape`), the first with each id. The objects are the block's own.
 */
export function journeysOf(configuration: JourneyConfiguration | undefined): Journey[] {
  const declared = declaredJourneys(configuration);
  return listedIndexes(configuration).map((index) => declared[index] as Journey);
}

/** The declared journeys the catalog keeps untouched and does not list, and why. */
export function unlistedJourneysOf(configuration: JourneyConfiguration | undefined): UnlistedJourney[] {
  const listed = new Set(listedIndexes(configuration));
  const out: UnlistedJourney[] = [];
  declaredJourneys(configuration).forEach((entry, index) => {
    if (listed.has(index)) {
      return;
    }
    const problems = validateJourneyShape(entry);
    const id = declaredId(entry);
    out.push({
      index,
      reason: problems.length > 0 ? "unreadable" : "duplicate-id",
      ...(id !== undefined ? { id } : {}),
      problems
    });
  });
  return out;
}

/**
 * What a journey is called: its name in `locale` (the definition's translation, a host's catalog
 * entry over it, else the default string), else its id (the way the renderer's picker
 * names it).
 */
export function journeyLabel(journey: Journey, locale: string, sources?: TextSources): string {
  const name = typeof journey.name === "string" ? resolveText(journey.name, addressOf.journey(journey.id, "name"), locale, sources ?? {}) : "";
  return name.trim() !== "" ? name : journey.id;
}


/**
 * A journey id from a name a person typed, in the component-id grammar the id must follow:
 * `"Step by step"` → `"step-by-step"`, accents folded, anything but letters, digits and dashes
 * dropped, and `journey-` in front when what is left does not start with a letter
 * (`"2026 intake"` → `"journey-2026-intake"`). `"journey"` when nothing is left.
 */
export function journeyIdFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") {
    return "journey";
  }
  return /^[a-z]/.test(slug) ? slug : `journey-${slug}`;
}

/**
 * The ids a host names something else by: `"form"` opens the whole form
 * and `"journey"` the default journey, so a journey under either could never be opened by its
 * id. No journey the builder makes or re-identifies takes one; one a file already declares is
 * kept and listed as it is. The prototype names (`constructor`, `prototype`) are refused besides:
 * a journey's texts are kept under its id in the translations map, which cannot key them. The
 * words a rule reads as its own (`row`, `host`, …) are free: no rule reads a journey by its id.
 */
export const RESERVED_JOURNEY_IDS: readonly string[] = ["form", "journey"];

/**
 * `candidate` unless a journey already has it, else `candidate-2`, `candidate-3`, … A reserved
 * id ({@link RESERVED_JOURNEY_IDS}) is never given: it is numbered from 1 (`"journey"` →
 * `"journey-1"`, so the nameless "Journey" a first start is called sits beside "Journey 2"'s
 * `journey-2`). A prototype name is numbered from 2, as a taken id is.
 */
export function uniqueJourneyId(candidate: string, taken: Iterable<string>): string {
  const ids = new Set(taken);
  const reserved = RESERVED_JOURNEY_IDS.includes(candidate);
  if (!reserved && !ids.has(candidate) && !isPrototypeName(candidate)) {
    return candidate;
  }
  let n = reserved ? 1 : 2;
  while (ids.has(`${candidate}-${n}`)) {
    n += 1;
  }
  return `${candidate}-${n}`;
}

/** Every id a declared journey carries, listed or not: what a new id must avoid. */
export function takenJourneyIds(configuration: JourneyConfiguration | undefined): string[] {
  return declaredJourneys(configuration)
    .map((entry) => declaredId(entry))
    .filter((id): id is string => id !== undefined);
}

/**
 * The journey the form opens as when it opens as a journey and nothing names one: the declared
 * default when it names a listed journey, else the first — the rule `findJourney` applies.
 */
export function effectiveDefaultJourneyId(configuration: JourneyConfiguration | undefined): string | undefined {
  const journeys = journeysOf(configuration);
  const declared = configuration?.defaultJourneyId;
  if (declared !== undefined && journeys.some((journey) => journey.id === declared)) {
    return declared;
  }
  return journeys[0]?.id;
}

/**
 * The block with `changes` made, every other key where it was: a changed key keeps its place,
 * a new one goes last, and one set to `undefined` goes.
 */
function patched(configuration: JourneyConfiguration | undefined, changes: Record<string, unknown>): JourneyConfiguration {
  const base: Record<string, unknown> = isRecord(configuration) ? configuration : {};
  const out: Array<[string, unknown]> = [];
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(changes, key);
  for (const [key, value] of Object.entries(base)) {
    const next = has(key) ? changes[key] : value;
    if (next !== undefined) {
      out.push([key, next]);
    }
  }
  for (const [key, value] of Object.entries(changes)) {
    if (!Object.prototype.hasOwnProperty.call(base, key) && value !== undefined) {
      out.push([key, value]);
    }
  }
  // Defined, not assigned: a key such as `__proto__` stays a key of the block, as written.
  return Object.fromEntries(out) as JourneyConfiguration;
}

function requireListedIndex(configuration: JourneyConfiguration | undefined, id: string): number {
  const declared = declaredJourneys(configuration);
  const index = listedIndexes(configuration).find((at) => (declared[at] as Journey).id === id);
  if (index === undefined) {
    throw new Error(`No journey has the id "${id}"`);
  }
  return index;
}

/**
 * Why `journey` cannot be written into the block (the strict shape, so a repeated page id
 * counts), empty when it can. What a caller that commits a transient state asks first, so it
 * reports a refusal instead of catching the throw of {@link addJourney} / {@link replaceJourney}.
 */
export function journeyUnusableProblems(journey: Journey): string[] {
  return validateJourneyShape(journey);
}

function requireUsable(journey: Journey): void {
  const problems = journeyUnusableProblems(journey);
  if (problems.length > 0) {
    throw new Error(`The journey is not usable: ${problems.join("; ")}`);
  }
}

function requireNewId(configuration: JourneyConfiguration | undefined, id: string, exceptIndex?: number): void {
  if (!fitsComponentIdGrammar(id)) {
    throw new Error(`"${id}" cannot be a journey id: start with a letter, then letters, digits, _ or -`);
  }
  if (isPrototypeName(id)) {
    throw new Error(kernelStructureMessage("journey.id.reserved", undefined, id));
  }
  if (RESERVED_JOURNEY_IDS.includes(id)) {
    throw new Error(`"${id}" cannot be a journey id: a host names ${id === "form" ? "the whole form" : "the default journey"} by it`);
  }
  const clash = declaredJourneys(configuration).some((entry, index) => index !== exceptIndex && declaredId(entry) === id);
  if (clash) {
    throw new Error(`A journey with the id "${id}" already exists`);
  }
}

/**
 * `journey` appended. Its id must follow the component-id grammar and not be in use (use
 * {@link uniqueJourneyId} first), and it must be usable.
 *
 * The first journey sets what the form opens as:
 * added to a block with no listed journeys, it also writes `opensAs: "journey"`, whether the key
 * was unset or `"form"`, so the journey just built is what the published form opens as. A later
 * journey leaves `opensAs` alone. Every journey saved into a form is one a client may submit
 * through, whatever `opensAs` says.
 */
export function addJourney(configuration: JourneyConfiguration | undefined, journey: Journey): JourneyConfiguration {
  requireUsable(journey);
  requireNewId(configuration, journey.id);
  const first = journeysOf(configuration).length === 0;
  return patched(configuration, {
    journeys: [...declaredJourneys(configuration), journey],
    ...(first ? { opensAs: "journey" } : {})
  });
}

/**
 * The listed journey `id` replaced by `journey`, in place. `journey.id` may differ: the new id must
 * follow the grammar and be free, and the default follows it when it pointed there.
 */
export function replaceJourney(configuration: JourneyConfiguration | undefined, id: string, journey: Journey): JourneyConfiguration {
  const index = requireListedIndex(configuration, id);
  requireUsable(journey);
  if (journey.id !== id) {
    requireNewId(configuration, journey.id, index);
  }
  const journeys = declaredJourneys(configuration).map((entry, at) => (at === index ? journey : entry));
  return patched(configuration, {
    journeys,
    ...(configuration?.defaultJourneyId === id && journey.id !== id ? { defaultJourneyId: journey.id } : {})
  });
}

/**
 * The listed journey `id` gone; the list may empty. A removed default is cleared, so the first
 * journey left would become the default. When the journey removed is the one the form opens as
 * (the effective default while the form does not open whole), `opensAs` is written `"form"` in
 * the same edit rather than let another journey silently become what the form opens as. When no journey at all is left, `opensAs` and `defaultJourneyId` go too: they mean
 * nothing without one, and the next first journey sets them again.
 */
export function removeJourney(configuration: JourneyConfiguration | undefined, id: string): JourneyConfiguration {
  const index = requireListedIndex(configuration, id);
  const journeys = declaredJourneys(configuration).filter((_entry, at) => at !== index);
  if (journeys.length === 0) {
    return patched(configuration, { journeys, defaultJourneyId: undefined, opensAs: undefined });
  }
  // Only while another listed journey remains: with none, `opensAs` means nothing (an unlisted one is no journey).
  const openedAs = configuration?.opensAs !== "form" && effectiveDefaultJourneyId(configuration) === id && journeysOf(configuration).length > 1;
  return patched(configuration, {
    journeys,
    ...(configuration?.defaultJourneyId === id ? { defaultJourneyId: undefined } : {}),
    ...(openedAs ? { opensAs: "form" } : {})
  });
}

/** `id` made the default. It must name a listed journey. */
export function setDefaultJourney(configuration: JourneyConfiguration | undefined, id: string): JourneyConfiguration {
  requireListedIndex(configuration, id);
  return patched(configuration, { defaultJourneyId: id });
}

/**
 * The form made to open as the journey `id`, or as the whole form when `id` is
 * `"form"`: one edit, so a reader never sees the default moved and `opensAs` not yet. A journey
 * becomes the default (only written when it is not already) and `opensAs` is written
 * `"journey"` when it said `"form"`; a key that is unset already means a journey.
 */
export function chooseOpensAs(configuration: JourneyConfiguration | undefined, id: string): JourneyConfiguration {
  if (id === "form") {
    return patched(configuration, { opensAs: "form" });
  }
  requireListedIndex(configuration, id);
  return patched(configuration, {
    ...(effectiveDefaultJourneyId(configuration) !== id ? { defaultJourneyId: id } : {}),
    ...(configuration?.opensAs === "form" ? { opensAs: "journey" } : {})
  });
}

/** What the form opens as; `undefined` removes the key, which means a journey whenever there is one. */
export function setOpensAs(configuration: JourneyConfiguration | undefined, opensAs: JourneyOpensAs | undefined): JourneyConfiguration {
  return patched(configuration, { opensAs });
}

export interface DuplicateJourneyOptions {
  /** The copy's id. Absent: the original's with `-copy`, made unique. */
  id?: string | undefined;
  /** The copy's name. Absent: the original's with " (copy)" after it, in its default language only. */
  name?: string | undefined;
}

function copyName(name: string | undefined, id: string): string {
  const base = name ?? id;
  return `${base.trim() === "" ? id : base} (copy)`;
}

/**
 * A deep copy of the listed journey `id`, appended under a new id and name. Journeys are JSON
 * data, so the copy shares nothing with the original.
 */
export function duplicateJourney(
  configuration: JourneyConfiguration | undefined,
  id: string,
  options: DuplicateJourneyOptions = {}
): { configuration: JourneyConfiguration; journey: Journey } {
  const original = declaredJourneys(configuration)[requireListedIndex(configuration, id)] as Journey;
  const candidate = fitsComponentIdGrammar(`${id}-copy`) ? `${id}-copy` : journeyIdFromName(`${id}-copy`);
  const copyId = options.id ?? uniqueJourneyId(candidate, takenJourneyIds(configuration));
  const copy: Journey = {
    ...(JSON.parse(JSON.stringify(original)) as Journey),
    id: copyId,
    name: options.name ?? copyName(original.name, id)
  };
  requireNewId(configuration, copyId);
  return { configuration: patched(configuration, { journeys: [...declaredJourneys(configuration), copy] }), journey: copy };
}

/**
 * The block as a definition should hold it: `undefined` when it says nothing — no journeys
 * declared and no other key — so a form that never had journeys gains no empty block; else the
 * block as it is, unknown keys and all.
 */
export function canonicalJourneyConfiguration(configuration: JourneyConfiguration | undefined): JourneyConfiguration | undefined {
  if (!isRecord(configuration)) {
    return undefined;
  }
  const saysSomething = Object.entries(configuration).some(([key, value]) =>
    key === "journeys" ? Array.isArray(value) && value.length > 0 : value !== undefined
  );
  return saysSomething ? configuration : undefined;
}

// --- the journeys' texts ----------------------------------------------------------------------

/** One text of a journey, or of a page of it, as the designer's inspector edits it. */
export interface JourneyTextField {
  /** The inspector field's id. */
  id: string;
  propertyPath: string;
  label: string;
  description?: string;
  /** The title of the inspector section it sits in. */
  section: string;
}

/**
 * The texts the designer's inspector edits — on the journey (the Journey panel) and on each
 * page — in the order it draws them. The designer's property editors are built from these, and
 * {@link journeyTranslatableTexts} lists them, so a host's catalog and the Languages workspace
 * name the same texts the same way.
 */
export const JOURNEY_TEXT_FIELDS: { readonly journey: readonly JourneyTextField[]; readonly page: readonly JourneyTextField[] } = {
  journey: [
    {
      id: "name",
      propertyPath: "name",
      label: "journey.designer.ui.journey-name",
      section: "Journey",
      description: "journey.designer.ui.what-the-journey-picker-and-this-builder-s-list-ca"
    },
    { id: "texts-back", propertyPath: "texts.back", label: "journey.designer.ui.back-button", section: "Wording" },
    { id: "texts-continue", propertyPath: "texts.continue", label: "journey.designer.ui.continue-button", section: "Wording" },
    { id: "texts-submit", propertyPath: "texts.submit", label: "journey.designer.ui.submit-button-the-last-page", section: "Wording" },
    {
      id: "texts-pageOf",
      propertyPath: "texts.pageOf",
      label: "journey.designer.ui.page-count-caption",
      section: "Wording",
      description: "journey.designer.ui.write-n-and-total-where-the-numbers-go"
    },
    { id: "texts-checking", propertyPath: "texts.checking", label: "journey.designer.ui.while-the-server-checks", section: "Wording" },
    { id: "texts-serverUnavailable", propertyPath: "texts.serverUnavailable", label: "journey.designer.ui.when-the-server-cannot-be-reached", section: "Wording" }
  ],
  page: [
    { id: "title", propertyPath: "title", label: "journey.designer.ui.title", section: "Step", description: "journey.designer.ui.the-page-s-heading-blank-its-first-question-s-labe" },
    { id: "description", propertyPath: "description", label: "journey.designer.ui.description", section: "Step" },
    { id: "texts-continue", propertyPath: "texts.continue", label: "journey.designer.ui.continue-button", section: "Wording" },
    { id: "texts-submit", propertyPath: "texts.submit", label: "journey.designer.ui.submit-button", section: "Wording" },
    { id: "texts-back", propertyPath: "texts.back", label: "journey.designer.ui.back-button", section: "Wording" }
  ]
};

function readText(owner: unknown, path: string): unknown {
  let cursor: unknown = owner;
  for (const part of path.split(".")) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

/** A definition text is a plain string in the default language; anything else reads as unwritten. */
function defaultOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Where a Check answers step's row wording lives in its configuration: `review.labels.<component id>`. */
const REVIEW_LABELS_PATH = "review.labels";

/**
 * Where the translations of one text of a journey (`propertyPath` `name`, `texts.back`) or of
 * one of its pages (with `pageId`: `title`, `description`, `texts.continue`) live in the
 * definition's map: `journeys › <journey id> › <path>` and `journeys › <journey id> › pages ›
 * <page id> › <path>`. Keyed by the ids the catalog keeps unique, never by an index.
 */
export function journeyTextAddress(journeyId: string, propertyPath: string, pageId?: string): TextAddress {
  const path = propertyPath.split(".");
  return { kind: "journeys", owner: journeyId, path: pageId === undefined ? path : ["pages", pageId, ...path] };
}

/**
 * One row of the Languages workspace's list of texts: what `BuilderController.translatableTexts`
 * returns for the form's own, with the same members. Defined here so the journey mode, which
 * lists its texts without a designer, does not depend on the controller's declaration.
 */
export interface JourneyTextRow {
  componentId: string;
  componentLabel: string;
  propertyPath: string;
  label: string;
  section?: string;
  /** The text in the form's default language. */
  default: string;
  address: TextAddress;
}

/**
 * The one text of a worked-out value a catalog lists: its label, written or not,
 * under the group `group`. A page-only node is worded under its own id, as the renderer
 * resolves it (`components › <node id> › label`).
 */
export function journeyLabelText(node: { id: string; configuration?: unknown }, group: string, groupLabel: string, text?: BuilderTextOptions): JourneyTextRow[] {
  return [
    {
      componentId: group,
      componentLabel: groupLabel,
      propertyPath: "label",
      label: builderText("journey.designer.grid.label", undefined, text),
      default: defaultOf(readText(node.configuration, "label")),
      address: addressOf.component(node.id, "label")
    }
  ];
}

/**
 * Every text `journeys` show, for the Languages workspace (`BuilderMode.translatableTexts`): each journey's name and wording, then each page's title, description and
 * wording — written or not, as the designer's inspector lists them — each with its string in
 * the default language and the address its translations live at. Each journey and each page is
 * a group of its own (`componentId` `journey.<journeyId>[.<pageId>]`, which no form component
 * id can be, having a dot in it). `ownTexts` lists a page's own nodes' texts after
 * the page's: the caller knows the form's types, which this module does not.
 */
export function journeyTranslatableTexts(
  journeys: readonly Journey[],
  locale: string,
  sources?: TextSources,
  ownTexts?: (journey: Journey, page: Journey["pages"][number], index: number) => JourneyTextRow[],
  text?: BuilderTextOptions,
  fieldLabel?: (componentId: string) => string
): JourneyTextRow[] {
  const texts: JourneyTextRow[] = [];
  const add = (fields: readonly JourneyTextField[], owner: unknown, group: string, groupLabel: string, journeyId: string, pageId?: string): void => {
    for (const field of fields) {
      texts.push({
        componentId: group,
        componentLabel: groupLabel,
        propertyPath: field.propertyPath,
        label: builderText(field.label as BuilderTextKey, undefined, text),
        section: field.section,
        default: defaultOf(readText(owner, field.propertyPath)),
        address: journeyTextAddress(journeyId, field.propertyPath, pageId)
      });
    }
  };
  for (const journey of journeys) {
    const name = journeyLabel(journey, locale, sources);
    const group = `journey.${journey.id}`;
    add(JOURNEY_TEXT_FIELDS.journey, journey, group, builderText("journey.designer.grid.journey", { name }, text), journey.id);
    journey.pages.forEach((page, index) => {
      const title = resolveText(defaultOf(page.title), addressOf.journeyPage(journey.id, page.id, "title"), locale, sources ?? {});
      const shown = title.trim() !== "" ? title : page.id;
      const pageGroup = `${group}.${page.id}`;
      const pageLabel = builderText("journey.designer.grid.page", { name, number: index + 1, title: shown }, text);
      add(JOURNEY_TEXT_FIELDS.page, page, pageGroup, pageLabel, journey.id, page.id);
      // A Check answers step's row wording, one text for each row the step words (`review.labels`, by component id):
      // written ones only, since which rows the step lists depends on the answers the form's steps ask. Kept
      // under the step whatever its kind now is, as the settings are.
      const labels = isRecord(page.review) && isRecord(page.review.labels) ? page.review.labels : undefined;
      for (const componentId of Object.keys(labels ?? {})) {
        texts.push({
          componentId: pageGroup,
          componentLabel: pageLabel,
          propertyPath: `${REVIEW_LABELS_PATH}.${componentId}`,
          label: builderText("journey.designer.grid.reviewRow", { field: fieldLabel?.(componentId) ?? componentId }, text),
          section: "Wording",
          default: defaultOf((labels as Record<string, unknown>)[componentId]),
          // Built from the parts, not split from the property path: a component id is one segment whatever it holds.
          address: { kind: "journeys", owner: journey.id, path: ["pages", page.id, "review", "labels", componentId] }
        });
      }
      if (ownTexts) {
        texts.push(...ownTexts(journey, page, index));
      }
    });
  }
  return texts;
}
