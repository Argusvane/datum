/**
 * The PDF themes a host has, and the lookup a document's theme id resolves through. A module of
 * its own beside pdf-theme-defaults.ts: the web components' theme registry answers
 * `pdfLookup(id)` synchronously when the bundle loads, so this stays in the entry, while the
 * merge, scale and selection logic in pdf-theme.ts (which re-exports this module) loads with the
 * PDF service.
 */
import { VersionedThemeRegistry } from "../../registry/versioned-theme-registry.js";
import type { PdfThemeDefinition } from "./pdf-theme-defaults.js";

/** A PDF theme that `extends` another, merged over its base: each field it sets, its whole `pdf` block included. */
export function mergePdfThemeOverBase(variant: PdfThemeDefinition, base: PdfThemeDefinition): PdfThemeDefinition {
  return { ...base, ...variant };
}

/**
 * PDF themes by id and version. A second registration of the same id and version is an error;
 * `resolve` without a version answers the latest; a theme that `extends` another is merged over
 * its base, which must already be registered.
 */
export class PdfThemeRegistry extends VersionedThemeRegistry<"pdf", PdfThemeDefinition> {
  public constructor() {
    super("pdf", "PDF theme", mergePdfThemeOverBase);
  }
}

/** Finds the PDF theme registered under an id; `undefined` when there is none. */
export type PdfThemeLookup = (id: string) => PdfThemeDefinition | undefined;

/** Where a host keeps its PDF themes: a lookup function, or a PDF theme registry. */
export type PdfThemeSource = PdfThemeLookup | Pick<PdfThemeRegistry, "has" | "resolve">;

/** A {@link PdfThemeSource} as a lookup function; `undefined` stays `undefined`. */
export function pdfThemeLookup(source: PdfThemeSource | undefined): PdfThemeLookup | undefined {
  if (source === undefined) {
    return undefined;
  }
  if (typeof source === "function") {
    return source;
  }
  return (id) => (source.has(id) ? source.resolve(id) : undefined);
}
