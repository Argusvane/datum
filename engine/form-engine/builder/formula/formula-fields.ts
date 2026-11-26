/**
 * The fields a formula may read, listed from the form tree for the formula editor's chips,
 * autocomplete and unknown-field check. One helper for both hosts (the Logic workspace and
 * the inspector), so they agree on what a field is called and what it stores.
 *
 * Rules read answers by component id, so `path` is the id unless the host supplies
 * `dataPathOf`. The kind follows the component type the way the data model does
 * (`builder/data-model/from-form.ts`): a checkbox group stores flags, a multiselect a list, a
 * select or radio one choice, a checkbox or toggle a boolean; numbers, dates and text-like
 * types as named; anything else (a file, an address, a repeating section) is `other`, or
 * `list` for a repeating section since a formula reads its entries as one.
 */
import { readInlineOptions } from "../../core/schema/inline-options.js";
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { addressOf, resolveText, type FormTranslations, type TextSources } from "../../core/localization/translations.js";
import { holdsData } from "../../core/tree/data-scope.js";

export type FormulaFieldKind = "boolean" | "choice" | "flags" | "list" | "number" | "date" | "text" | "other";

export interface FormulaField {
  /** What a formula writes to read the field (the component id, or the host's data path). */
  path: string;
  label: string;
  componentId?: string;
  kind: FormulaFieldKind;
  /** The inline options of a choice, flags or list field, labels for the locale; empty otherwise. */
  options: Array<{ value: string; label: string }>;
}

export interface FormulaFieldsOptions {
  /** Component ids to leave out (the rule's own target, say). */
  exclude?: readonly string[] | undefined;
  /** A component's name; `undefined` falls back to its configuration's label, then title, then id. */
  labelOf?: ((componentId: string) => string | undefined) | undefined;
  /** What a formula writes for a component; `undefined` keeps the id. */
  dataPathOf?: ((componentId: string) => string | undefined) | undefined;
  /** BCP 47, for labels; absent: English. */
  locale?: string | undefined;
  /** The form's translations, to word labels and options in `locale`; absent: the default-language strings. */
  translations?: FormTranslations | undefined;
  /** The host's translation catalog, over the form's translations. */
  translationCatalog?: TranslationCatalog | undefined;
}

const KIND_BY_TYPE: Readonly<Record<string, FormulaFieldKind>> = {
  text: "text",
  tel: "text",
  password: "text",
  email: "text",
  url: "text",
  textarea: "text",
  number: "number",
  currency: "number",
  rating: "number",
  checkbox: "boolean",
  toggle: "boolean",
  boolean: "boolean",
  select: "choice",
  radio: "choice",
  checkboxes: "flags",
  multiselect: "list",
  date: "date"
};

/** The kind a component type stores, for the editor's typed help; `other` for a type the table lacks. */
export function formulaFieldKind(type: string): FormulaFieldKind {
  return KIND_BY_TYPE[type] ?? "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationLabel(node: ComponentNode, locale: string, sources: TextSources): string | undefined {
  if (!isRecord(node.configuration)) {
    return undefined;
  }
  for (const key of ["label", "title"]) {
    const raw = node.configuration[key];
    if (typeof raw === "string" && raw.trim() !== "") {
      return resolveText(raw, addressOf.component(node.id, key), locale, sources);
    }
  }
  return undefined;
}

/**
 * Every data-holding component under `root` in document order as a formula field; the root,
 * grouping containers and valueless components (a button, static HTML) are left out.
 */
export function formulaFieldsOf(root: ComponentNode, options: FormulaFieldsOptions = {}): FormulaField[] {
  const locale = options.locale ?? "en";
  const sources: TextSources = { translations: options.translations, catalog: options.translationCatalog };
  const excluded = new Set(options.exclude ?? []);
  const fields: FormulaField[] = [];
  const seen = new Set<string>();
  const stack: ComponentNode[] = [];
  const pushChildren = (node: ComponentNode): void => {
    const children = Object.values(node.children ?? {}).flat();
    for (let at = children.length - 1; at >= 0; at -= 1) {
      stack.push(children[at] as ComponentNode);
    }
  };
  pushChildren(root);
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    if (!isRecord(node) || typeof node.id !== "string" || seen.has(node.id)) {
      continue;
    }
    seen.add(node.id);
    pushChildren(node);
    if (excluded.has(node.id) || !holdsData(node)) {
      continue;
    }
    const given = options.labelOf?.(node.id);
    const label = given !== undefined && given !== "" ? given : (configurationLabel(node, locale, sources) ?? node.id);
    const kind: FormulaFieldKind = node.collection !== undefined ? "list" : formulaFieldKind(node.type);
    const optionsList =
      kind === "choice" || kind === "flags" || kind === "list"
        ? readInlineOptions(node.configuration).map((option) => ({
            value: option.value,
            label: resolveText(option.label, addressOf.option(node.id, option.value, "label"), locale, sources)
          }))
        : [];
    fields.push({
      path: options.dataPathOf?.(node.id) ?? node.id,
      label,
      componentId: node.id,
      kind,
      options: optionsList
    });
  }
  return fields;
}

interface FieldIndex {
  size: number;
  known: Set<string>;
  normalized: Array<{ field: FormulaField; candidates: string[] }>;
  suggestions: Map<string, FormulaField | null>;
}

const FIELD_INDEXES = new WeakMap<readonly FormulaField[], FieldIndex>();

/** The lookup tables of one field list, built once per list (a list is replaced, not edited, between edits). */
function indexOf(fields: readonly FormulaField[]): FieldIndex {
  const cached = FIELD_INDEXES.get(fields);
  if (cached !== undefined && cached.size === fields.length) {
    return cached;
  }
  const known = new Set<string>();
  const normalized: FieldIndex["normalized"] = [];
  for (const field of fields) {
    known.add(field.path);
    const candidates = [field.path, field.label];
    if (field.componentId !== undefined) {
      known.add(field.componentId);
      candidates.push(field.componentId);
    }
    normalized.push({ field, candidates: candidates.map(normalize) });
  }
  const index: FieldIndex = { size: fields.length, known, normalized, suggestions: new Map() };
  FIELD_INDEXES.set(fields, index);
  return index;
}

/** Whether `path` names a listed field, exactly or as a value under it (`address.city`). */
export function isKnownFormulaPath(path: string, fields: readonly FormulaField[]): boolean {
  const { known } = indexOf(fields);
  if (known.has(path)) {
    return true;
  }
  let at = path.indexOf(".");
  while (at >= 0) {
    if (known.has(path.slice(0, at))) {
      return true;
    }
    at = path.indexOf(".", at + 1);
  }
  return false;
}

/** Edit distance between two short names, for the nearest-field suggestion. */
function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0 || b.length === 0) {
    return Math.max(a.length, b.length);
  }
  let previous: number[] = [];
  for (let at = 0; at <= b.length; at += 1) {
    previous.push(at);
  }
  for (let row = 1; row <= a.length; row += 1) {
    const current: number[] = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current.push(Math.min((previous[column] as number) + 1, (current[column - 1] as number) + 1, (previous[column - 1] as number) + cost));
    }
    previous = current;
  }
  return previous[b.length] as number;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * The field whose id or label is nearest to `name` (a misspelt or mis-cased path), or
 * `undefined` when none is close: within a third of the name's length, two edits at least.
 */
export function suggestFormulaField(name: string, fields: readonly FormulaField[]): FormulaField | undefined {
  const index = indexOf(fields);
  const remembered = index.suggestions.get(name);
  if (remembered !== undefined) {
    return remembered ?? undefined;
  }
  const wanted = normalize(name);
  if (wanted === "") {
    return undefined;
  }
  const allowed = Math.max(2, Math.ceil(wanted.length / 3));
  let best: { field: FormulaField; distance: number } | undefined;
  for (const entry of index.normalized) {
    for (const candidate of entry.candidates) {
      // The distance is at least the difference in length: skip the table when that alone is too far.
      if (Math.abs(candidate.length - wanted.length) > allowed) {
        continue;
      }
      const distance = editDistance(wanted, candidate);
      if (distance <= allowed && (best === undefined || distance < best.distance)) {
        best = { field: entry.field, distance };
      }
    }
  }
  index.suggestions.set(name, best?.field ?? null);
  return best?.field;
}
