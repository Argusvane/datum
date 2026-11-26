/**
 * The PDF half of the GC Design System package, a module a page loads beside the form and PDF
 * bundles: the theme, and the suggestion the binding carries (`pdfTheme: "gcds"`).
 *
 *   import { pdfThemes } from "@argusvane/datum";
 *   import { gcdsPdfTheme } from "@argusvane/datum-binding-gcds/pdf";
 *   pdfThemes.register(gcdsPdfTheme);          // the binding's suggestion now resolves
 *
 * The render ladder (the engine's `selectPdfTheme`) is: the render call's theme id, the layout's
 * theme id, the host's `pdfTheme`, the binding's suggestion, then `datum-pdf`. A host that
 * registers nothing prints under `datum-pdf` and gets one `theme.notFound` warning. On a server
 * host the host catalog maps the binding id to this theme instead. The fonts are not part of
 * the theme: it names `@gcds-core/fonts` WOFF files relative to the folder the host serves.
 */
export { box, font, GCDS_PDF_FACES, GCDS_PDF_THEME, GCDS_PDF_THEME_ID, GCDS_TOKENS_VERSION, pt, REM_PT } from "./theme.js";
import { GCDS_PDF_THEME, GCDS_PDF_THEME_ID } from "./theme.js";
import type { PdfBindingSuggestion } from "../../../engine/form-engine/render/pdf/pdf-theme.js";

/** The theme under the name a host registers it by. */
export const gcdsPdfTheme = GCDS_PDF_THEME;

/** What the live binding suggests about paper, resolved through the host's registry. */
export const GCDS_BINDING_PDF_SUGGESTION: PdfBindingSuggestion = { id: "gcds", pdfTheme: GCDS_PDF_THEME_ID };
