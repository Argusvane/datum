/**
 * The geometry a document draws with: the theme's settings when the document
 * carries them, else the constants the kernel always had — so a document from an older
 * engine, which carries none, renders byte for byte as it did. The fallbacks are the
 * engine's own `PDF_KERNEL_FALLBACKS`, read rather than restated, so the two cannot drift.
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

/** The document's settings over the fallbacks; a document without a block (an older engine's) keeps the fallback whole. */
export function resolveLayoutSettings(document?: Partial<SettingsSource>): LayoutSettings {
  const fallback = PDF_KERNEL_FALLBACKS;
  return {
    controls: { ...fallback.controls, ...(document?.controls ?? {}) },
    choice: { ...fallback.choice, ...(document?.choice ?? {}) },
    fields: { ...fallback.fields, ...(document?.fields ?? {}) },
    headings: { ...fallback.headings, ...(document?.headings ?? {}) },
    table: { ...fallback.table, ...(document?.table ?? {}) },
    box: { ...fallback.box, ...(document?.box ?? {}) },
    panel: { ...fallback.panel, ...(document?.panel ?? {}) },
    list: { ...fallback.list, ...(document?.list ?? {}) },
    spacing: { ...fallback.spacing, ...(document?.spacing ?? {}) }
  };
}
