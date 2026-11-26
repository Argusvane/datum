import type { BuilderThemeDefinition, FormPlugin, PdfThemeDefinition } from "@argusvane/datum-engine";

/**
 * A fixture plugin for this package's own tests: what a package that ships PDF or builder themes
 * hands the registries, made up, so a test of the element, the registry, the builder or the PDF
 * path has a registered theme to name without depending on a real one.
 *
 * - `acme`: a PDF theme with a label whose typography names a family of its own (with faces
 *   under acme-fonts/pdf/) and a heading colour a test can find in the document the kernel is
 *   handed; and `acme-shell`, a builder-shell theme from the same plugin.
 * - `beta`: a second plugin's PDF theme that declares no assets.
 */

export const ACME_THEME_VERSION = "1.0.0";
/** The heading colour of the acme PDF companion: what a test looks for in the kernel's request. */
export const ACME_PDF_HEADING_COLOR = "#0b3d91";

export const ACME_PDF_THEME: PdfThemeDefinition = {
  id: "acme",
  version: ACME_THEME_VERSION,
  target: "pdf",
  label: "Acme Design System",
  assets: {
    fonts: [
      { family: "Acme Sans", weight: 400, style: "normal", file: "acme-fonts/pdf/acme-sans-400.ttf", coverage: ["Latn"] },
      { family: "Acme Sans", weight: 400, style: "italic", file: "acme-fonts/pdf/acme-sans-400-italic.ttf", coverage: ["Latn"] },
      { family: "Acme Sans", weight: 700, style: "normal", file: "acme-fonts/pdf/acme-sans-700.ttf", coverage: ["Latn"] },
      { family: "Acme Display", weight: 700, style: "normal", file: "acme-fonts/pdf/acme-display-700.ttf", coverage: ["Latn"] }
    ]
  },
  pdf: {
    page: { size: "Letter", orientation: "portrait", margins: { top: 54, right: 54, bottom: 54, left: 54 } },
    typography: {
      body: { family: "Acme Sans", size: 11, lineHeight: 1.5, weight: 400, color: "#1b1b1b" },
      heading: { family: "Acme Display", weight: 700, color: ACME_PDF_HEADING_COLOR, sizes: [20, 16, 14, 12, 11, 11] }
    }
  }
};

export const ACME_BUILDER_THEME: BuilderThemeDefinition = {
  id: "acme-shell",
  version: ACME_THEME_VERSION,
  target: "builder",
  label: "Acme shell",
  tokens: { "db-accent": "#0b3d91" }
};

/** The acme package's plugin: its PDF theme and its builder-shell theme. */
export const acmeThemePlugin: FormPlugin = {
  id: "acme-themes",
  version: ACME_THEME_VERSION,
  pdfThemes: [ACME_PDF_THEME],
  builderThemes: [ACME_BUILDER_THEME]
};

export const BETA_PDF_THEME: PdfThemeDefinition = {
  id: "beta",
  version: "2.0.0",
  target: "pdf",
  label: "Beta Kit"
};

/** A second package: one PDF theme, no assets. */
export const betaThemePlugin: FormPlugin = {
  id: "beta-themes",
  version: "2.0.0",
  pdfThemes: [BETA_PDF_THEME]
};
