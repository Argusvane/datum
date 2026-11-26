import type { PdfBindingSuggestion, PdfServiceDependencies, PdfTemplateResolver, PdfThemeDefinition, PdfThemeSource } from "@argusvane/datum-engine";

import type { DatumPdfSupport } from "./pdf.js";

/** What a PDF is drawn with beside the support: the settings `<datum-form>` keeps as properties and `renderPdf` takes as options. */
export interface PdfDrawingSettings {
  /** The default PDF theme, resolved: the element's `pdf-theme`, the call's `theme`. */
  theme?: PdfThemeDefinition | undefined;
  /** Where a theme named by id is looked up when the support names no lookup of its own. */
  themes?: PdfThemeSource | undefined;
  /** Where a template layout's file comes from. */
  templates?: PdfTemplateResolver | undefined;
  /** The binding the form is drawn by, when it suggests a PDF theme. */
  binding?: PdfBindingSuggestion | undefined;
}

/**
 * What the PDF pipeline (`renderFormPdf`) is handed for a support and the drawing settings, in one
 * place: `<datum-form>` sets its renderer's PDF properties from it, and `renderPdf(runtime)` in
 * `datum-pdf.js` passes it straight on, so the two draw the same document. The settings' theme wins
 * over the support's; the support's theme lookup wins over the settings'. No provider is handed on
 * when there is no support.
 */
export function pdfServiceDependencies(
  support: DatumPdfSupport | undefined,
  settings: PdfDrawingSettings
): Partial<PdfServiceDependencies> {
  // The support's provider, fonts and images, the settings' templates and binding; then the two
  // that both may name. (Written short: the form bundle carries it eagerly.)
  return { ...support, ...settings, theme: settings.theme ?? support?.theme, themes: support?.themes ?? settings.themes };
}
