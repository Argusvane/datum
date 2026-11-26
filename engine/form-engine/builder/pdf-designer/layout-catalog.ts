/**
 * Several PDF layouts on one form: the definition's `pdf.layouts` as a catalog a
 * host edits — add, copy, rename, remove, choose the default — with ids kept unique and the
 * default following a rename or falling back when its layout goes. The runtime side needs
 * nothing new: `findPdfLayout` already picks by id, and the renderer's picker already lists
 * every declared layout. What was missing is the authoring side, and this is its model.
 *
 * Pure functions over `PdfConfiguration`: each returns a new configuration and leaves the one
 * given alone, so a host that keeps its state immutable (a React host) and one that keeps a
 * ref both fit. A host draws the list however it likes.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import { isPrototypeName } from "../../core/tree/prototype-names.js";
import { kernelStructureMessage } from "../../core/expressions/definition-structure.js";
import { addressOf, resolveText, type TextSources } from "../../core/localization/translations.js";
import { builderText, type BuilderTextOptions } from "../logic/builder-texts.js";
import {
  PDF_DOCUMENT_BODY_SLOT,
  PDF_DOCUMENT_COMPONENT_TYPE,
  PDF_DOCUMENT_FOOTER_SLOT,
  PDF_DOCUMENT_HEADER_SLOT,
  readPdfLayoutCondition,
  type PdfConfiguration,
  type PdfGeneratedLayout,
  type PdfLayoutDocument
} from "../../core/schema/pdf-layout.js";
import { deriveDefaultPdfLayout } from "../../render/pdf/default-layout.js";

/**
 * What a layout is called: its name in `locale` (the string, or its translation at
 * `pdf › <id> › name`), else its id, the way the renderer's picker shows it. `sources` are the
 * definition's translations and the host's catalog; without them the name is the one
 * authored.
 */
export function pdfLayoutLabel(layout: PdfLayoutDocument, locale: string, sources: TextSources = {}): string {
  if (typeof layout.name !== "string" || layout.name === "") {
    return layout.id;
  }
  return resolveText(layout.name, addressOf.pdf(layout.id, ["name"]), locale, sources) || layout.id;
}

/** The layouts a configuration declares, in order — every one, unvalidated, since the catalog edits them as they are. */
export function pdfLayoutsOf(configuration: PdfConfiguration | undefined): PdfLayoutDocument[] {
  return configuration?.layouts ?? [];
}

/**
 * A layout id from a name a person typed: `"Client copy"` → `"client-copy"`, accents folded,
 * anything but letters, digits and dashes dropped. `"layout"` when nothing is left.
 */
export function pdfLayoutIdFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "layout" : slug;
}

/**
 * `candidate` unless a layout already has it, else `candidate-2`, `candidate-3`, … A layout's
 * texts are translated under its id (`translations.pdf.<id>`), which a map cannot key for a
 * name every object has, so a name that slugs to one steps past it the same way.
 */
export function uniquePdfLayoutId(candidate: string, taken: Iterable<string>): string {
  const ids = new Set(taken);
  if (!ids.has(candidate) && !isPrototypeName(candidate)) {
    return candidate;
  }
  let n = 2;
  while (ids.has(`${candidate}-${n}`)) {
    n += 1;
  }
  return `${candidate}-${n}`;
}

/**
 * The layout a "Download PDF" with no further choice produces when no layout's `when` holds:
 * the declared default when it names a layout the configuration has, else the first — the
 * rule `findPdfLayout` applies.
 */
export function effectivePdfDefaultLayoutId(configuration: PdfConfiguration | undefined): string | undefined {
  const layouts = pdfLayoutsOf(configuration);
  const declared = configuration?.defaultLayoutId;
  if (declared !== undefined && layouts.some((layout) => layout.id === declared)) {
    return declared;
  }
  return layouts[0]?.id;
}

function requireId(id: string, kept?: string): string {
  const trimmed = id.trim();
  if (trimmed === "") {
    throw new Error("A PDF layout needs an id");
  }
  // The layout's translations are keyed by its id, and a map cannot hold these.
  // A layout that already has one is still edited in place; only a new id is refused, in the
  // sentence the definition's structure check gives it.
  if (isPrototypeName(trimmed) && trimmed !== kept) {
    throw new Error(kernelStructureMessage("pdf.layout.id.reserved", undefined, trimmed));
  }
  return trimmed;
}

function assertFree(configuration: PdfConfiguration | undefined, id: string, except?: string): void {
  if (pdfLayoutsOf(configuration).some((layout) => layout.id === id && layout.id !== except)) {
    throw new Error(`A PDF layout with the id "${id}" already exists`);
  }
}

function requireLayout(configuration: PdfConfiguration | undefined, id: string): PdfLayoutDocument {
  const found = pdfLayoutsOf(configuration).find((layout) => layout.id === id);
  if (!found) {
    throw new Error(`No PDF layout has the id "${id}"`);
  }
  return found;
}

function withLayouts(
  configuration: PdfConfiguration | undefined,
  layouts: PdfLayoutDocument[],
  defaultLayoutId: string | undefined
): PdfConfiguration {
  // Each key where the configuration had it, so an edit rewrites the block's values, not its
  // shape: a definition saved after one reads as the one loaded but for what changed.
  const next: PdfConfiguration = { ...(configuration ?? {}), layouts };
  if (defaultLayoutId !== undefined) {
    next.defaultLayoutId = defaultLayoutId;
  } else {
    delete next.defaultLayoutId;
  }
  return next;
}

/**
 * `next` with its default declared, when a layout in it has a `when` and it declares none it
 * has: the layout that was the default before the edit when it is still there,
 * else the first. Once conditions exist the default is always written down, so every reader
 * prints the same layout when no condition holds, and an edit to the list (removing or moving
 * the first layout) never quietly changes it.
 */
function keepingDefaultDeclared(previous: PdfConfiguration | undefined, next: PdfConfiguration): PdfConfiguration {
  const layouts = pdfLayoutsOf(next);
  const declared = next.defaultLayoutId;
  if (!layouts.some((layout) => readPdfLayoutCondition(layout) !== undefined) || (declared !== undefined && layouts.some((layout) => layout.id === declared))) {
    return next;
  }
  const before = effectivePdfDefaultLayoutId(previous);
  const kept = before !== undefined && layouts.some((layout) => layout.id === before) ? before : layouts[0]?.id;
  return kept === undefined ? next : withLayouts(next, layouts, kept);
}

/**
 * `layout` appended. Its id must be non-empty and not already in use: use {@link uniquePdfLayoutId} first.
 * With a `when` among the layouts, the default is declared (see {@link keepingDefaultDeclared}).
 */
export function addPdfLayout(configuration: PdfConfiguration | undefined, layout: PdfLayoutDocument): PdfConfiguration {
  const id = requireId(layout.id);
  assertFree(configuration, id);
  return keepingDefaultDeclared(configuration, withLayouts(configuration, [...pdfLayoutsOf(configuration), { ...layout, id }], configuration?.defaultLayoutId));
}

/**
 * The layout with the id `id` replaced by `layout`, in place. `layout.id` may differ (a rename):
 * the default follows it when it pointed there, and the new id must not be another layout's.
 * The layout given a `when` — a condition saved on it — declares the default the form had
 * (see {@link keepingDefaultDeclared}), unless `options.declareDefault` is `false`: the
 * builder's own reading of a layout it opens is not an edit, and writes nothing the author did
 * not (the Rules save, Duplicate and a copy are where the default gets written).
 */
export function replacePdfLayout(
  configuration: PdfConfiguration | undefined,
  id: string,
  layout: PdfLayoutDocument,
  options: { declareDefault?: boolean | undefined } = {}
): PdfConfiguration {
  requireLayout(configuration, id);
  const nextId = requireId(layout.id, id);
  assertFree(configuration, nextId, id);
  const layouts = pdfLayoutsOf(configuration).map((entry) => (entry.id === id ? { ...layout, id: nextId } : entry));
  const defaultLayoutId = configuration?.defaultLayoutId === id ? nextId : configuration?.defaultLayoutId;
  const next = withLayouts(configuration, layouts, defaultLayoutId);
  return options.declareDefault === false ? next : keepingDefaultDeclared(configuration, next);
}

/**
 * The layout with the id `id` gone. When it was the declared default, the first remaining
 * layout becomes the default — or none is named, when none remain. With a `when` among those
 * left, the default stays declared (see {@link keepingDefaultDeclared}).
 */
export function removePdfLayout(configuration: PdfConfiguration | undefined, id: string): PdfConfiguration {
  requireLayout(configuration, id);
  const layouts = pdfLayoutsOf(configuration).filter((entry) => entry.id !== id);
  const defaultLayoutId = configuration?.defaultLayoutId === id ? layouts[0]?.id : configuration?.defaultLayoutId;
  return keepingDefaultDeclared(configuration, withLayouts(configuration, layouts, defaultLayoutId));
}

/**
 * The layout with the id `id` moved to `toIndex` among the others (clamped to the list), which
 * is where its `when` is tried: layouts are tried in list order. The default is
 * written down first when the configuration names none — the first layout's place made it the
 * default only for want of one — so a move changes what is tried first, never what prints
 * when no condition holds.
 */
export function movePdfLayout(configuration: PdfConfiguration | undefined, id: string, toIndex: number): PdfConfiguration {
  requireLayout(configuration, id);
  if (!Number.isFinite(toIndex)) {
    throw new Error("A PDF layout's new place must be a number");
  }
  const layouts = [...pdfLayoutsOf(configuration)];
  const [moved] = layouts.splice(layouts.findIndex((entry) => entry.id === id), 1);
  layouts.splice(Math.max(0, Math.min(layouts.length, Math.trunc(toIndex))), 0, moved!);
  return withLayouts(configuration, layouts, effectivePdfDefaultLayoutId(configuration));
}

/** `id` made the default. It must name one of the configuration's layouts. */
export function setDefaultPdfLayout(configuration: PdfConfiguration | undefined, id: string): PdfConfiguration {
  requireLayout(configuration, id);
  return withLayouts(configuration, pdfLayoutsOf(configuration), id);
}

export interface DuplicatePdfLayoutOptions {
  /** The copy's id. Absent: the original's id with `-copy`, made unique. */
  id?: string | undefined;
  /** The copy's name. Absent: the original's with " (copy)" after it, in its default language only. */
  name?: string | undefined;
  /** The builder's locale and texts: the copy's stored name is worded in them ("(copy)" in English). */
  text?: BuilderTextOptions | undefined;
}

function copyName(name: string | undefined, id: string, text?: BuilderTextOptions): string {
  return builderText("pdf.copyName", { name: name ?? id }, text);
}

/**
 * A deep copy of the layout with the id `id`, appended under a new id and name. Layouts are
 * JSON data (a definition is), so the copy shares nothing with the original — a template
 * layout's inline PDF bytes included, and its `when`: the copy is tried after the original,
 * so it prints only once its condition is changed. A copy that brings a `when` into the list
 * declares the default the form had (see {@link keepingDefaultDeclared}).
 */
export function duplicatePdfLayout(
  configuration: PdfConfiguration | undefined,
  id: string,
  options: DuplicatePdfLayoutOptions = {}
): { configuration: PdfConfiguration; layout: PdfLayoutDocument } {
  const original = requireLayout(configuration, id);
  const taken = pdfLayoutsOf(configuration).map((layout) => layout.id);
  const copyId = options.id !== undefined ? requireId(options.id) : uniquePdfLayoutId(`${id}-copy`, taken);
  assertFree(configuration, copyId);
  const cloned = JSON.parse(JSON.stringify(original)) as PdfLayoutDocument;
  const name = options.name ?? copyName(original.name, id, options.text);
  const copy: PdfLayoutDocument = { ...cloned, id: copyId, name };
  return { configuration: addPdfLayout(configuration, copy), layout: copy };
}

export interface NewGeneratedPdfLayoutOptions {
  id: string;
  name?: string | undefined;
  /** The form the layout prints. */
  formRoot: ComponentNode;
  /**
   * `"form"`: the layout the engine derives from the form tree (its title, sections, every
   * field), the place to start a variant that prints most of the form. `"blank"`: an empty
   * document, for one built up from nothing.
   */
  from: "form" | "blank";
  /** The form's title, for a derived layout's heading. Absent: the root's `configuration.title`. */
  title?: string | undefined;
}

/** A fresh generated layout to add to a catalog. Its id is the caller's to make unique. */
export function newGeneratedPdfLayout(options: NewGeneratedPdfLayoutOptions): PdfGeneratedLayout {
  const id = requireId(options.id);
  if (options.from === "form") {
    const derived = deriveDefaultPdfLayout(options.formRoot, { id, title: options.title });
    return options.name !== undefined ? { ...derived, name: options.name } : derived;
  }
  return {
    id,
    kind: "generated",
    ...(options.name !== undefined ? { name: options.name } : {}),
    root: {
      id: "document",
      type: PDF_DOCUMENT_COMPONENT_TYPE,
      configuration: {},
      children: {
        [PDF_DOCUMENT_BODY_SLOT]: [],
        [PDF_DOCUMENT_HEADER_SLOT]: [],
        [PDF_DOCUMENT_FOOTER_SLOT]: []
      }
    }
  };
}
