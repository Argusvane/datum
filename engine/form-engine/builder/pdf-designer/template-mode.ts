/**
 * The designer's template mode: an existing PDF, its fields as the kernel's
 * `inspect` op lists them, and what fills each one — and, where the PDF has no field, the
 * areas drawn on its pages that answers land in. This is the model behind the
 * mapping table — pure, so a host draws the table however it likes — plus a schematic of the pages with one box per field, for a host
 * without a PDF viewer to hand.
 */
import type {
  PdfAccessibilityConfiguration,
  PdfConformanceConfiguration,
  PdfSignatureConfiguration,
  PdfFieldMapping,
  PdfFieldMappingSource,
  PdfTemplateArea,
  PdfTemplateAreaDraw,
  PdfTemplateAreaField,
  PdfTemplateFillOptions,
  PdfTemplateLayout,
  PdfTemplateSource,
  PdfValueFormat
} from "../../core/schema/pdf-layout.js";
import type { PdfTemplateFieldInfo, PdfTemplateInfo } from "../../render/pdf/pdf-abi.js";
import type { PdfBindableComponent } from "../../render/pdf/pdf-components.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { InsertComponentEntry } from "../controller/builder-controller.js";
import { dataKeyFromName, humanizeKey, type DataModelNode } from "../data-model/data-model.js";
import { generateComponents, rootInsertTarget, type GenerateOptions } from "../data-model/generate.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { builderText } from "./pdf-texts-en.js";

export interface TemplateMappingEditorOptions {
  layoutId: string;
  name?: string | undefined;
  template: PdfTemplateSource;
  /** What the kernel's `inspect` op said about the template. */
  inspection: PdfTemplateInfo;
  /** Mappings to start from (an existing layout's). */
  fields?: readonly PdfFieldMapping[] | undefined;
  /** Areas to start from (an existing layout's). */
  areas?: readonly PdfTemplateArea[] | undefined;
  options?: PdfTemplateFillOptions | undefined;
  accessibility?: PdfAccessibilityConfiguration | undefined;
  /** The archival profile to keep through the fill. */
  conformance?: PdfConformanceConfiguration | undefined;
  /** How the filled document is sealed: which of the template's signature fields the server signs into. */
  signature?: PdfSignatureConfiguration | undefined;
}

/** One row of the mapping table: a template field and what fills it, if anything. */
export interface TemplateFieldRow {
  field: PdfTemplateFieldInfo;
  mapping: PdfFieldMapping | undefined;
}

export type PdfAreaRect = PdfTemplateArea["rect"];

/** What a new area starts with; the rest takes the defaults. */
export interface TemplateAreaInit {
  page: number;
  rect: PdfAreaRect;
  source?: PdfFieldMappingSource | undefined;
  label?: string | undefined;
  draw?: PdfTemplateAreaDraw | undefined;
}

/** A change to an area's drawing choices: a key set to `undefined` goes back to its default. */
export type TemplateAreaDrawPatch = { [K in keyof PdfTemplateAreaDraw]?: PdfTemplateAreaDraw[K] | undefined };

/** A change to an area's field choices: a key set to `undefined` drops it (its default applies). */
export type TemplateAreaFieldPatch = { [K in keyof PdfTemplateAreaField]?: PdfTemplateAreaField[K] | undefined };

/**
 * A change to an area: `rect`, `draw` and `field` patches merge into what is there. `field: null`
 * makes the area page content again; `field: {}` makes it a fillable field with every default.
 */
export interface TemplateAreaPatch {
  label?: string | undefined;
  page?: number | undefined;
  rect?: Partial<PdfAreaRect> | undefined;
  draw?: TemplateAreaDrawPatch | undefined;
  field?: TemplateAreaFieldPatch | null | undefined;
  format?: PdfValueFormat | undefined;
}

export interface TemplateMappingEditor {
  /** The template's fields in the order the template declares them, each with its mapping. */
  rows(): TemplateFieldRow[];
  mapping(pdfField: string): PdfFieldMapping | undefined;
  /** Sets what fills a field; `undefined` clears the mapping. */
  setSource(pdfField: string, source: PdfFieldMappingSource | undefined): void;
  setCheckedValue(pdfField: string, value: string | undefined): void;
  setFormat(pdfField: string, format: PdfValueFormat | undefined): void;
  setOptions(options: PdfTemplateFillOptions | undefined): void;
  options(): PdfTemplateFillOptions | undefined;
  setConformance(conformance: PdfConformanceConfiguration | undefined): void;
  conformance(): PdfConformanceConfiguration | undefined;
  setSignature(signature: PdfSignatureConfiguration | undefined): void;
  signature(): PdfSignatureConfiguration | undefined;
  /** Names the template signature field the server seals; `undefined` for none (the rest of the block is kept). */
  setSignatureField(pdfField: string | undefined): void;
  /** Template fields nothing fills. */
  unmapped(): PdfTemplateFieldInfo[];
  /** Mappings naming a field the template no longer has (kept in the layout until cleared). */
  stale(): PdfFieldMapping[];
  /** Maps every unmapped field whose name matches a component's id or label; returns how many. */
  suggest(components: readonly PdfBindableComponent[]): number;
  /** The areas in the order they were added (copies: edit through the methods). */
  areas(): PdfTemplateArea[];
  area(id: string): PdfTemplateArea | undefined;
  /** Adds an area under a fresh id (`area_1`, `area_2`, …) and returns it. Nothing fills it until a source is set. */
  addArea(init: TemplateAreaInit): PdfTemplateArea;
  updateArea(id: string, patch: TemplateAreaPatch): void;
  removeArea(id: string): void;
  /** Sets what fills an area; `undefined` leaves it empty (a `null` literal), the area itself stays. */
  setAreaSource(id: string, source: PdfFieldMappingSource | undefined): void;
  setAreaCheckedValue(id: string, value: string | undefined): void;
  /** Areas on a page the template does not have (kept: the kernel reports them missing). */
  unplacedAreas(): PdfTemplateArea[];
  /** The layout as it stands. Stale mappings are dropped; `areas` is present only when there are any. */
  layout(): PdfTemplateLayout;
}

/** The first `area_N` not among `taken`. */
export function newAreaId(taken: Iterable<string>): string {
  const used = new Set(taken);
  let index = 1;
  while (used.has(`area_${index}`)) {
    index += 1;
  }
  return `area_${index}`;
}

/**
 * A rectangle kept on the page, at least `min` points each way, rounded to 1/100 pt — the
 * viewer's drags and the table's numbers both go through here.
 */
export function clampAreaRect(rect: PdfAreaRect, page: { width: number; height: number }, min = 4): PdfAreaRect {
  const round = (value: number): number => Math.round(value * 100) / 100;
  const floor = Math.min(min, page.width, page.height);
  const width = Math.min(Math.max(floor, rect.width), page.width);
  const height = Math.min(Math.max(floor, rect.height), page.height);
  const x = Math.min(Math.max(0, rect.x), page.width - width);
  const y = Math.min(Math.max(0, rect.y), page.height - height);
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

const EMPTY_SOURCE: PdfFieldMappingSource = { kind: "literal", value: null };

function cloneArea(area: PdfTemplateArea): PdfTemplateArea {
  return { ...area, rect: { ...area.rect }, ...(area.draw ? { draw: { ...area.draw } } : {}), ...(area.field ? { field: { ...area.field } } : {}) };
}

/** `topmostSubform[0].Page1[0].Name[0]` → `name`; `Full Name` → `fullname`; `Text1.0` → `text10` (see {@link pdfFieldOwnName}). */
export function normalizeFieldName(name: string): string {
  return pdfFieldOwnName(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Mappings for the fields whose names match a component: the field's last path segment against
 * the component's id, then its label, both with punctuation and case ignored. A checkbox takes
 * its first export value as the checked value. A radio group takes none: the answer is the
 * option to select, and a checked value would clear the group on every other answer.
 */
export function suggestFieldMappings(
  fields: readonly PdfTemplateFieldInfo[],
  components: readonly PdfBindableComponent[]
): PdfFieldMapping[] {
  const byId = new Map<string, PdfBindableComponent>();
  const byLabel = new Map<string, PdfBindableComponent>();
  for (const component of components) {
    if (component.container) {
      continue;
    }
    const id = normalizeFieldName(component.id);
    if (id !== "" && !byId.has(id)) {
      byId.set(id, component);
    }
    const label = normalizeFieldName(component.label);
    if (label !== "" && !byLabel.has(label)) {
      byLabel.set(label, component);
    }
  }
  const out: PdfFieldMapping[] = [];
  for (const field of fields) {
    if (field.kind === "button" || field.kind === "signature" || field.kind === "unknown") {
      continue;
    }
    const key = normalizeFieldName(field.name);
    const component = byId.get(key) ?? byLabel.get(key);
    if (!component) {
      continue;
    }
    const mapping: PdfFieldMapping = { pdfField: field.name, source: { kind: "component", componentId: component.id } };
    const checked = field.exportValues?.[0];
    if (field.kind === "checkbox" && checked !== undefined) {
      mapping.checkedValue = checked;
    }
    out.push(mapping);
  }
  return out;
}

/** Fields whose tops sit within this many points of a row's first share that row. */
const ROW_TOLERANCE = 4;

/** A tooltip longer than this reads as help, not a name: it becomes the field's description, and its first sentence or clause the label. */
const TOOLTIP_LABEL_MAX = 80;

/**
 * The template's fields in reading order: page by page, rows top to bottom, left to right
 * within a row (a field whose top sits within {@link ROW_TOLERANCE} points of a row's first
 * joins it). A field the kernel could not place keeps its declared order after the placed ones.
 */
export function templateFieldsInReadingOrder(fields: readonly PdfTemplateFieldInfo[]): PdfTemplateFieldInfo[] {
  type Placed = { field: PdfTemplateFieldInfo; index: number; page: number; top: number; x: number; row: number };
  const placed: Placed[] = [];
  const unplaced: PdfTemplateFieldInfo[] = [];
  fields.forEach((field, index) => {
    if (field.page !== undefined && field.rect) {
      placed.push({ field, index, page: field.page, top: field.rect.y + field.rect.height, x: field.rect.x, row: 0 });
    } else {
      unplaced.push(field);
    }
  });
  // Rows per page, from the top down: PDF space grows upwards, so a higher top comes first.
  placed.sort((a, b) => a.page - b.page || b.top - a.top || a.index - b.index);
  let row = 0;
  let rowTop = Number.POSITIVE_INFINITY;
  let rowPage = -1;
  for (const entry of placed) {
    if (entry.page !== rowPage || entry.top < rowTop - ROW_TOLERANCE) {
      row += 1;
      rowTop = entry.top;
      rowPage = entry.page;
    }
    entry.row = row;
  }
  placed.sort((a, b) => a.row - b.row || a.x - b.x || a.index - b.index);
  return [...placed.map((entry) => entry.field), ...unplaced];
}

/** What "Create form fields" does with a template's fields. */
export interface TemplateFormFieldsPlan {
  /** The components to insert into the form, in the template's reading order, where "Add missing fields" puts a root-level one. */
  entries: InsertComponentEntry[];
  /** What fills each field: a component the form already had (a name match, as "Suggest mappings" finds it), else one of `entries`. */
  mappings: PdfFieldMapping[];
  /** How many of `mappings` name a component the form already had. */
  matched: number;
  /** The fields nothing is built for, and why. */
  skipped: Array<{ pdfField: string; reason: string }>;
}

/** Why nothing is built for a field, or `undefined` when something is. */
function skipReasonFor(field: PdfTemplateFieldInfo, text?: BuilderTextOptions): string | undefined {
  switch (field.kind) {
    case "signature":
      return builderText("pdf.skip.signature", undefined, text);
    case "button":
      return builderText("pdf.skip.button", undefined, text);
    case "unknown":
      return builderText("pdf.skip.unknown", undefined, text);
    default:
      return field.readOnly ? builderText("pdf.skip.readOnly", undefined, text) : undefined;
  }
}

/**
 * A field's own name: the last segment of its dotted path, without the `[0]` indexes a
 * converted form carries (`topmostSubform[0].Page1[0].FirstName[0]` → `FirstName`). A segment
 * that is only a number is a copy's index — Acrobat names copies `Text1.0`, `Text1.1` — so it
 * keeps the segments before it, up to the first that is a name: `Text1.0` → `Text1.0`,
 * `Phone.1.2` → `Phone.1.2`.
 */
export function pdfFieldOwnName(name: string): string {
  const segments = name.split(".").map((segment) => segment.replace(/\[\d+\]/g, "").trim());
  let start = segments.length - 1;
  while (start > 0 && /^\d+$/.test(segments[start]!)) {
    start -= 1;
  }
  const own = segments.slice(start).filter((segment) => segment !== "").join(".");
  return own === "" ? name : own;
}

/** How far apart, in points, the boxes of one question repeated on another page may sit. */
const REPEAT_TOLERANCE = 2;

/** A name a form tool gives a field nobody named (`Text1`, `TextField3`, `Check Box2`): no evidence two fields ask one thing. */
const DEFAULT_FIELD_NAME = /^(text|textfield|text field|check ?box|checkbox|radio ?button|radio|dropdown|drop-?down list|list ?box|combo ?box|field|button)\s*\d*$/i;

/**
 * Whether `b` is the question `a` asks, asked again on another page — a name in every page's
 * running header: the same own name (one somebody gave it), kind, choices and words, in the
 * same box. Anything less is two questions: `TextField1` on each page of a converted form, two
 * rows of a table.
 */
function sameQuestion(a: PdfTemplateFieldInfo, b: PdfTemplateFieldInfo): boolean {
  const own = pdfFieldOwnName(a.name);
  const near = (x: number, y: number): boolean => Math.abs(x - y) <= REPEAT_TOLERANCE;
  return (
    own === pdfFieldOwnName(b.name) &&
    !DEFAULT_FIELD_NAME.test(own) &&
    a.kind === b.kind &&
    (a.tooltip ?? "") === (b.tooltip ?? "") &&
    JSON.stringify(a.options ?? null) === JSON.stringify(b.options ?? null) &&
    JSON.stringify(a.exportValues ?? null) === JSON.stringify(b.exportValues ?? null) &&
    a.rect !== undefined &&
    b.rect !== undefined &&
    near(a.rect.x, b.rect.x) &&
    near(a.rect.y, b.rect.y) &&
    near(a.rect.width, b.rect.width) &&
    near(a.rect.height, b.rect.height)
  );
}

/** The first of `base`, `base_2`, `base_3`… that `taken` does not claim. */
function uniqueKey(base: string, taken: (candidate: string) => boolean): string {
  let key = base;
  for (let counter = 2; taken(key); counter += 1) {
    key = `${base}_${counter}`;
  }
  return key;
}

/** Every id in the form, and every key an answer is stored under (a component's data key, else its id). */
function collectIdsAndKeys(node: ComponentNode, ids: Set<string>, keys: Set<string>): void {
  ids.add(node.id);
  const dataKey = (node.configuration as Record<string, unknown> | undefined)?.dataKey;
  keys.add(typeof dataKey === "string" && dataKey !== "" ? dataKey : node.id);
  for (const group of Object.values(node.children ?? {})) {
    for (const child of group) {
      collectIdsAndKeys(child, ids, keys);
    }
  }
}

/**
 * A label from a long tooltip: its first sentence, else its first clause (up to a comma, a
 * semicolon or a colon), when that is short enough to read as a name; `undefined` otherwise.
 */
function labelFromLongTooltip(tooltip: string): string | undefined {
  const sentence = tooltip.split(/(?<=[.?!])\s/)[0]!.trim();
  const candidate = sentence.length <= TOOLTIP_LABEL_MAX ? sentence : tooltip.split(/[,;:]\s/)[0]!.trim();
  return candidate.length > 0 && candidate.length <= TOOLTIP_LABEL_MAX ? candidate.replace(/[.,;:]$/, "") : undefined;
}

/** The place in the form's data a field becomes: its kind, choices, limits and words. */
function placeFor(field: PdfTemplateFieldInfo, key: string): DataModelNode {
  // The field's tooltip (`/TU`), when the file gives it one.
  const tooltip = field.tooltip?.trim() || undefined;
  const long = tooltip !== undefined && tooltip.length > TOOLTIP_LABEL_MAX;
  const node: DataModelNode = {
    key,
    path: key,
    sourceKey: field.name,
    kind: field.kind === "checkbox" ? "boolean" : "string",
    label: (tooltip !== undefined ? (long ? labelFromLongTooltip(tooltip) : tooltip) : undefined) ?? humanizeKey(pdfFieldOwnName(field.name)),
    ...(long ? { description: tooltip } : {}),
    ...(field.required ? { required: true } : {})
  };
  if (field.kind === "text") {
    if (field.multiline) {
      node.format = "multiline";
    }
    if (field.maxLength !== undefined && field.maxLength > 0) {
      node.maxLength = field.maxLength;
    }
  } else if (field.kind !== "checkbox" && field.options && field.options.length > 0) {
    node.options = field.options.map((value) => ({ value }));
  }
  return node;
}

/**
 * The form fields for a template's fields: a field whose name matches a component
 * the form has is filled from it, as "Suggest mappings" would; every other field that holds an
 * answer gets a component of its own — text (multi-line, with its maximum length), a checkbox
 * (filled with its first export value), a radio group or a select with the field's choices —
 * labelled with the field's tooltip where it has one (a long one the description, its first
 * sentence or clause the label), required where the PDF says so, keyed by
 * the field's own name made usable and unique. A PDF radio group stays a radio group and a
 * dropdown or list a select, whatever their number of choices. Signature, button, unreadable
 * and read-only fields are left out with the reason.
 */
export function planTemplateFormFields(
  fields: readonly PdfTemplateFieldInfo[],
  formRoot: ComponentNode,
  components: readonly PdfBindableComponent[],
  options: GenerateOptions,
  text?: BuilderTextOptions
): TemplateFormFieldsPlan {
  const matches = suggestFieldMappings(fields, components);
  const matched = new Set(matches.map((mapping) => mapping.pdfField));
  const ids = new Set<string>(options.takenIds ?? []);
  const keys = new Set<string>();
  collectIdsAndKeys(formRoot, ids, keys);
  const target = rootInsertTarget(formRoot);
  let index = target.index;
  const plan: TemplateFormFieldsPlan = { entries: [], mappings: [...matches], matched: matches.length, skipped: [] };
  // What each component built so far was built for, and the pages it is asked on: the same
  // question on another page (a name repeated in every page's header) is filled from it too.
  const asked: Array<{ field: PdfTemplateFieldInfo; componentId: string; pages: Set<number> }> = [];
  for (const field of templateFieldsInReadingOrder(fields)) {
    if (matched.has(field.name)) {
      continue;
    }
    const reason = skipReasonFor(field, text);
    if (reason !== undefined) {
      plan.skipped.push({ pdfField: field.name, reason });
      continue;
    }
    // Only across pages: two such fields on one page are two answers (see sameQuestion).
    const again = field.page !== undefined ? asked.find((entry) => !entry.pages.has(field.page!) && sameQuestion(entry.field, field)) : undefined;
    if (again) {
      again.pages.add(field.page!);
      const mapping: PdfFieldMapping = { pdfField: field.name, source: { kind: "component", componentId: again.componentId } };
      const checked = field.exportValues?.[0];
      if (field.kind === "checkbox" && checked !== undefined) {
        mapping.checkedValue = checked;
      }
      plan.mappings.push(mapping);
      continue;
    }
    // Unique against every key and every id, so the component can take its key as its id.
    const key = uniqueKey(dataKeyFromName(pdfFieldOwnName(field.name)), (candidate) => keys.has(candidate) || ids.has(candidate));
    keys.add(key);
    const node = placeFor(field, key);
    const radioMax = field.kind === "radio" ? Number.POSITIVE_INFINITY : field.kind === "dropdown" || field.kind === "listbox" ? 0 : undefined;
    const built = generateComponents([node], { ...options, takenIds: ids, text, ...(radioMax !== undefined ? { radioMax } : {}) });
    const component = built.components[0];
    if (!component) {
      plan.skipped.push({ pdfField: field.name, reason: built.skipped[0]?.reason ?? builderText("pdf.skip.none", undefined, text) });
      continue;
    }
    ids.add(component.node.id);
    if (field.page !== undefined) {
      asked.push({ field, componentId: component.node.id, pages: new Set([field.page]) });
    }
    plan.entries.push({ node: component.node, parentId: target.parentId, slotId: target.slotId, ...(index !== undefined ? { index } : {}) });
    if (index !== undefined) {
      index += 1;
    }
    const mapping: PdfFieldMapping = { pdfField: field.name, source: { kind: "component", componentId: component.node.id } };
    const checked = field.exportValues?.[0];
    if (field.kind === "checkbox" && checked !== undefined) {
      mapping.checkedValue = checked;
    }
    plan.mappings.push(mapping);
  }
  return plan;
}

export function createTemplateMappingEditor(options: TemplateMappingEditorOptions): TemplateMappingEditor {
  const fields = options.inspection.fields;
  const known = new Set(fields.map((field) => field.name));
  const mappings = new Map<string, PdfFieldMapping>();
  for (const mapping of options.fields ?? []) {
    mappings.set(mapping.pdfField, { ...mapping });
  }
  const areas = new Map<string, PdfTemplateArea>();
  for (const area of options.areas ?? []) {
    areas.set(area.id, cloneArea(area));
  }
  let fillOptions = options.options ? { ...options.options } : undefined;
  let conformance = options.conformance ? { ...options.conformance } : undefined;
  let signature = options.signature ? { ...options.signature } : undefined;

  const require = (pdfField: string): PdfFieldMapping => {
    const existing = mappings.get(pdfField);
    if (existing) {
      return existing;
    }
    const created: PdfFieldMapping = { pdfField, source: EMPTY_SOURCE };
    mappings.set(pdfField, created);
    return created;
  };
  const pageOf = (page: number): { width: number; height: number } | undefined => options.inspection.pages.find((entry) => entry.index === page);

  return {
    rows: () => fields.map((field) => ({ field, mapping: mappings.get(field.name) })),
    mapping: (pdfField) => mappings.get(pdfField),
    setSource: (pdfField, source) => {
      if (source === undefined) {
        mappings.delete(pdfField);
        return;
      }
      require(pdfField).source = source;
    },
    setCheckedValue: (pdfField, value) => {
      const mapping = require(pdfField);
      if (value === undefined || value === "") {
        delete mapping.checkedValue;
      } else {
        mapping.checkedValue = value;
      }
    },
    setFormat: (pdfField, format) => {
      const mapping = require(pdfField);
      if (format === undefined) {
        delete mapping.format;
      } else {
        mapping.format = format;
      }
    },
    setOptions: (next) => {
      fillOptions = next ? { ...next } : undefined;
    },
    options: () => (fillOptions ? { ...fillOptions } : undefined),
    setConformance: (next) => {
      conformance = next ? { ...next } : undefined;
    },
    conformance: () => (conformance ? { ...conformance } : undefined),
    setSignature: (next) => {
      signature = next ? { ...next } : undefined;
    },
    signature: () => (signature ? { ...signature } : undefined),
    setSignatureField: (pdfField) => {
      if (pdfField === undefined || pdfField === "") {
        if (signature) {
          const { field: _field, ...rest } = signature;
          signature = Object.keys(rest).length > 0 ? rest : undefined;
        }
        return;
      }
      signature = { ...(signature ?? {}), field: pdfField };
    },
    unmapped: () => fields.filter((field) => !mappings.has(field.name)),
    stale: () => [...mappings.values()].filter((mapping) => !known.has(mapping.pdfField)),
    suggest: (components) => {
      const suggested = suggestFieldMappings(
        fields.filter((field) => !mappings.has(field.name)),
        components
      );
      for (const mapping of suggested) {
        mappings.set(mapping.pdfField, mapping);
      }
      return suggested.length;
    },
    areas: () => [...areas.values()].map(cloneArea),
    area: (id) => {
      const found = areas.get(id);
      return found ? cloneArea(found) : undefined;
    },
    addArea: (init) => {
      const id = newAreaId(areas.keys());
      const page = pageOf(init.page);
      const created: PdfTemplateArea = {
        id,
        ...(init.label !== undefined && init.label !== "" ? { label: init.label } : {}),
        page: init.page,
        rect: page ? clampAreaRect(init.rect, page) : { ...init.rect },
        source: init.source ?? EMPTY_SOURCE,
        ...(init.draw ? { draw: { ...init.draw } } : {})
      };
      areas.set(id, created);
      return cloneArea(created);
    },
    updateArea: (id, patch) => {
      const area = areas.get(id);
      if (!area) {
        return;
      }
      if (patch.label !== undefined) {
        if (patch.label === "") {
          delete area.label;
        } else {
          area.label = patch.label;
        }
      }
      if (patch.page !== undefined) {
        area.page = patch.page;
      }
      if (patch.rect) {
        const merged = { ...area.rect, ...patch.rect };
        const page = pageOf(area.page);
        area.rect = page ? clampAreaRect(merged, page) : merged;
      }
      if (patch.draw !== undefined) {
        const merged: TemplateAreaDrawPatch = { ...(area.draw ?? {}), ...patch.draw };
        // A choice put back to its default is dropped, so the layout only carries what differs.
        const draw = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as PdfTemplateAreaDraw;
        if (Object.keys(draw).length === 0) {
          delete area.draw;
        } else {
          area.draw = draw;
        }
      }
      if (patch.field === null) {
        delete area.field;
      } else if (patch.field !== undefined) {
        const merged: TemplateAreaFieldPatch = { ...(area.field ?? {}), ...patch.field };
        // Defaults (an empty name, an unticked flag) leave the layout; presence alone makes the area a field.
        area.field = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined && value !== "" && value !== false)) as PdfTemplateAreaField;
      }
      if ("format" in patch) {
        if (patch.format === undefined) {
          delete area.format;
        } else {
          area.format = patch.format;
        }
      }
    },
    removeArea: (id) => {
      areas.delete(id);
    },
    setAreaSource: (id, source) => {
      const area = areas.get(id);
      if (area) {
        area.source = source ?? EMPTY_SOURCE;
      }
    },
    setAreaCheckedValue: (id, value) => {
      const area = areas.get(id);
      if (!area) {
        return;
      }
      if (value === undefined || value === "") {
        delete area.checkedValue;
      } else {
        area.checkedValue = value;
      }
    },
    unplacedAreas: () => [...areas.values()].filter((area) => !pageOf(area.page)).map(cloneArea),
    layout: () => ({
      id: options.layoutId,
      kind: "template",
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.accessibility ? { accessibility: options.accessibility } : {}),
      template: options.template,
      fields: fields.filter((field) => mappings.has(field.name)).map((field) => ({ ...mappings.get(field.name)! })),
      ...(areas.size > 0 ? { areas: [...areas.values()].map(cloneArea) } : {}),
      ...(fillOptions ? { options: fillOptions } : {}),
      ...(conformance ? { conformance } : {}),
      ...(signature ? { signature } : {})
    })
  };
}

export interface TemplateSchematicOptions {
  /** Field names that have a mapping; drawn filled. */
  mapped?: ReadonlySet<string> | undefined;
  /** Field names filled from a component the form no longer has, each with that id; drawn as a warning (`__field--unresolved`), never as mapped. */
  unresolved?: ReadonlyMap<string, string> | undefined;
  /** Attribute-safe escaping; the engine's `escapeHtml` does. */
  escape: (value: string) => string;
  /** Page width in the host's units; the height follows the page's proportions. Default `100%`. */
  width?: string | undefined;
  /** The builder's words (locale and catalog) for the page labels and the field titles. */
  text?: BuilderTextOptions | undefined;
}

/**
 * The template's pages as inline SVG, one box per field (PDF space flipped: the kernel reports
 * rectangles from the page's bottom edge). Classes: `datum-pdf-schematic__page`, `__field`,
 * `__field--mapped`, and `data-field` carries the name so a host can select a row from a box.
 */
export function templateSchematicHtml(inspection: PdfTemplateInfo, options: TemplateSchematicOptions): string {
  const escape = options.escape;
  const width = options.width ?? "100%";
  return inspection.pages
    .map((page) => {
      const boxes = templateFieldBoxesHtml(inspection, page.index, options);
      return `<svg class="datum-pdf-schematic__page" data-page="${page.index}" viewBox="0 0 ${page.width} ${page.height}" width="${escape(width)}" role="img" aria-label="${escape(builderText("pdf.page.number", { page: page.index }, options.text))}"><rect class="datum-pdf-schematic__sheet" x="0" y="0" width="${page.width}" height="${page.height}"></rect>${boxes}</svg>`;
    })
    .join("");
}

/**
 * The field boxes of one page, as SVG `<rect>`s in the page's point space (top-left origin:
 * the kernel reports rectangles from the page's bottom edge, flipped here). The schematic
 * and the designer's page viewer both draw them.
 */
export function templateFieldBoxesHtml(inspection: PdfTemplateInfo, pageIndex: number, options: Pick<TemplateSchematicOptions, "mapped" | "unresolved" | "escape" | "text">): string {
  const escape = options.escape;
  const page = inspection.pages.find((entry) => entry.index === pageIndex);
  if (!page) {
    return "";
  }
  return inspection.fields
    .filter((field) => field.page === page.index && field.rect)
    .map((field) => {
      const rect = field.rect!;
      const missing = options.unresolved?.get(field.name);
      const mapped = missing !== undefined ? " datum-pdf-schematic__field--unresolved" : options.mapped?.has(field.name) ? " datum-pdf-schematic__field--mapped" : "";
      const title = missing !== undefined ? builderText("pdf.field.unresolved", { name: field.name, kind: field.kind, source: missing }, options.text) : `${field.name} (${field.kind})`;
      return `<rect class="datum-pdf-schematic__field${mapped}" data-field="${escape(field.name)}" x="${rect.x.toFixed(2)}" y="${(page.height - rect.y - rect.height).toFixed(2)}" width="${rect.width.toFixed(2)}" height="${rect.height.toFixed(2)}"><title>${escape(title)}</title></rect>`;
    })
    .join("");
}
