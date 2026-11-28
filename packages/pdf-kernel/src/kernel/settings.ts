/**
 * The geometry a document draws with: the theme's settings the document carries, read as
 * given. The spacing table alone is partial — a theme may leave a block kind out — and a kind
 * left out takes the kernel's own pair from `PDF_KERNEL_FALLBACKS`, read rather than restated.
 */
import {
  PDF_KERNEL_FALLBACKS,
  type PdfBlock,
  type PdfBoxSettings,
  type PdfChoiceSettings,
  type PdfControlSettings,
  type PdfDocument,
  type PdfFieldSettings,
  type PdfHeadingSettings,
  type PdfListSettings,
  type PdfPanelSettings,
  type PdfTableSettings
} from "@argusvane/datum-engine/render";

export interface LayoutSettings {
  controls: PdfControlSettings;
  choice: PdfChoiceSettings;
  fields: PdfFieldSettings;
  headings: PdfHeadingSettings;
  table: PdfTableSettings;
  box: PdfBoxSettings;
  panel: PdfPanelSettings;
  list: PdfListSettings;
  /** Points of space before and after each block kind. */
  spacing: Record<PdfBlock["kind"], [number, number]>;
}

type SettingsSource = Pick<PdfDocument, "controls" | "choice" | "fields" | "headings" | "table" | "box" | "panel" | "list" | "spacing">;

/** The document's geometry, with the kernel's pair for each block kind its spacing table leaves out. */
export function resolveLayoutSettings(document: SettingsSource): LayoutSettings {
  const { controls, choice, fields, headings, table, box, panel, list } = document;
  return { controls, choice, fields, headings, table, box, panel, list, spacing: { ...PDF_KERNEL_FALLBACKS.spacing, ...document.spacing } };
}
