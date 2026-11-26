/**
 * The PDF renditions the engine's own component types offer, as a vocabulary:
 * ids, labels and each type's default. The renderers behind the ids live in the render layer
 * (`render/pdf/standard-renditions.ts`), which a test holds to this list; this is what the
 * form builder's inspector and a host's own tooling read without the render layer.
 */
import { BUTTON_COMPONENT_TYPE } from "./button.js";
import { BUTTON_GROUP_COMPONENT_TYPE } from "./button-group.js";
import { DATA_GRID_COMPONENT_TYPE, dataGridSettingsOf } from "./data-grid.js";
import { FILE_COMPONENT_TYPE } from "./file-upload.js";
import { IMAGE_COMPONENT_TYPE } from "./image.js";
import { HTML_COMPONENT_TYPE } from "./static-html.js";
import type { ComponentNode } from "./types.js";

export interface PdfRenditionCatalogEntry {
  id: string;
  label: string;
}

export interface PdfRenditionCatalogType {
  defaultRendition: string;
  renditions: PdfRenditionCatalogEntry[];
}

const TEXT: PdfRenditionCatalogEntry = { id: "text", label: "Text — the label and the answer" };
const FIELD: PdfRenditionCatalogEntry = { id: "field", label: "Field — fillable in a PDF viewer" };
const RULED: PdfRenditionCatalogEntry = { id: "ruled", label: "Ruled — a blank line to write on" };
const CHECKMARK: PdfRenditionCatalogEntry = { id: "checkmark", label: "Check mark — a box, ticked when true" };
const CHECKLIST: PdfRenditionCatalogEntry = { id: "checklist", label: "Checklist — every option, the chosen ones ticked" };
const IMAGE: PdfRenditionCatalogEntry = { id: "image", label: "Image — the picture itself" };
const LINE: PdfRenditionCatalogEntry = { id: "line", label: "Line — a signature line" };
const NONE: PdfRenditionCatalogEntry = { id: "none", label: "Nothing" };
const GROUP: PdfRenditionCatalogEntry = { id: "group", label: "Group — the children, no heading" };
const SECTION: PdfRenditionCatalogEntry = { id: "section", label: "Section — a heading, then the children" };
const SECTIONS: PdfRenditionCatalogEntry = { id: "sections", label: "Sections — one per tab or entry" };
const TABLE: PdfRenditionCatalogEntry = { id: "table", label: "Table — one column per cell or field" };
const PANEL: PdfRenditionCatalogEntry = { id: "panel", label: "Panel — a titled box around the children" };

function type(defaultRendition: string, ...renditions: PdfRenditionCatalogEntry[]): PdfRenditionCatalogType {
  return { defaultRendition, renditions };
}

/** A text-like field: `text`, `email`, `number`, `date` and the rest. */
export const PDF_TEXT_FIELD_RENDITIONS: PdfRenditionCatalogType = type("text", TEXT, FIELD, RULED);
/** A choice field: `select`, `multiselect`, `radio`. */
export const PDF_CHOICE_FIELD_RENDITIONS: PdfRenditionCatalogType = type("text", TEXT, FIELD, CHECKLIST, RULED);
/** A container the engine knows: the form. */
export const PDF_GROUP_RENDITIONS: PdfRenditionCatalogType = type("group", GROUP, SECTION);
/** A container that may draw as a titled box: container, panel. */
export const PDF_PANEL_RENDITIONS: PdfRenditionCatalogType = type("group", GROUP, SECTION, PANEL);
/** A headed container: fieldset, step. */
export const PDF_SECTION_RENDITIONS: PdfRenditionCatalogType = type("section", GROUP, SECTION, PANEL);
/** A grid container. */
export const PDF_GRID_RENDITIONS: PdfRenditionCatalogType = type("table", TABLE, GROUP);

/** What a leaf type with no entry of its own offers. */
export const PDF_GENERIC_LEAF_RENDITIONS: PdfRenditionCatalogType = PDF_TEXT_FIELD_RENDITIONS;
/** What a type with children and no entry of its own offers. */
export const PDF_GENERIC_CONTAINER_RENDITIONS: PdfRenditionCatalogType = PDF_GROUP_RENDITIONS;
/** What a component carrying a `collection` offers, whatever its type says. */
export const PDF_COLLECTION_RENDITIONS: PdfRenditionCatalogType = type("table", TABLE, SECTIONS);

/** Every built-in type's renditions, keyed by component type. */
export const PDF_RENDITION_CATALOG: Readonly<Record<string, PdfRenditionCatalogType>> = {
  text: PDF_TEXT_FIELD_RENDITIONS,
  email: PDF_TEXT_FIELD_RENDITIONS,
  tel: PDF_TEXT_FIELD_RENDITIONS,
  url: PDF_TEXT_FIELD_RENDITIONS,
  number: PDF_TEXT_FIELD_RENDITIONS,
  date: PDF_TEXT_FIELD_RENDITIONS,
  time: PDF_TEXT_FIELD_RENDITIONS,
  textarea: PDF_TEXT_FIELD_RENDITIONS,
  checkbox: type("checkmark", CHECKMARK, FIELD, TEXT),
  boolean: type("checkmark", CHECKMARK, FIELD, TEXT),
  checkboxes: type("checklist", CHECKLIST, FIELD, TEXT),
  select: PDF_CHOICE_FIELD_RENDITIONS,
  multiselect: PDF_CHOICE_FIELD_RENDITIONS,
  radio: PDF_CHOICE_FIELD_RENDITIONS,
  [FILE_COMPONENT_TYPE]: type("text", TEXT, FIELD, IMAGE),
  [IMAGE_COMPONENT_TYPE]: type("image", IMAGE),
  [HTML_COMPONENT_TYPE]: type("text", TEXT),
  signature: type("line", LINE, FIELD, IMAGE),
  [BUTTON_COMPONENT_TYPE]: type("none", NONE),
  // Its children, no heading: buttons print nothing, so a group of them prints nothing.
  [BUTTON_GROUP_COMPONENT_TYPE]: type("group", GROUP),
  // A data grid is a collection-bound container: it takes the collection set, a
  // table by default. Which of the two is the default for one grid follows its `layout`
  // setting; see {@link dataGridDefaultRendition}.
  [DATA_GRID_COMPONENT_TYPE]: PDF_COLLECTION_RENDITIONS,
  form: PDF_GROUP_RENDITIONS,
  container: PDF_PANEL_RENDITIONS,
  panel: PDF_PANEL_RENDITIONS,
  fieldset: PDF_SECTION_RENDITIONS,
  step: PDF_SECTION_RENDITIONS,
  tabs: type("sections", SECTIONS, GROUP),
  grid: PDF_GRID_RENDITIONS
};

/** Every distinct rendition id the catalog names, with its label, in first-seen order. */
export const PDF_RENDITION_LABELS: ReadonlyArray<PdfRenditionCatalogEntry> = (() => {
  const seen = new Map<string, PdfRenditionCatalogEntry>();
  for (const entry of [...Object.values(PDF_RENDITION_CATALOG), PDF_COLLECTION_RENDITIONS]) {
    for (const rendition of entry.renditions) {
      if (!seen.has(rendition.id)) {
        seen.set(rendition.id, rendition);
      }
    }
  }
  return [...seen.values()];
})();

/**
 * The renditions a component may pick from: the built-in entry for its type, else the generic
 * set for a leaf or a container; a collection always offers the collection set.
 */
export function pdfRenditionCatalogFor(
  componentType: string,
  options: { hasChildren?: boolean | undefined; collection?: boolean | undefined } = {}
): PdfRenditionCatalogType {
  if (options.collection) {
    return PDF_COLLECTION_RENDITIONS;
  }
  return PDF_RENDITION_CATALOG[componentType] ?? (options.hasChildren ? PDF_GENERIC_CONTAINER_RENDITIONS : PDF_GENERIC_LEAF_RENDITIONS);
}

/**
 * The rendition a data grid takes when nothing above it on the ladder chose one: the
 * stacked layout prints one labelled group per row (`sections`), the table and automatic
 * layouts a table. Automatic means "the table where it fits"; paper always fits, so it is the
 * table. Any other node reads as the collection set's own default.
 */
export function dataGridDefaultRendition(node: ComponentNode): string {
  if (node.type === DATA_GRID_COMPONENT_TYPE && dataGridSettingsOf(node).layout === "stacked") {
    return "sections";
  }
  return PDF_COLLECTION_RENDITIONS.defaultRendition;
}
