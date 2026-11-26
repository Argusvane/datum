/**
 * The builder's own faces (Geist and Geist Mono, the studio look), linked into the page by
 * `<datum-form-builder load-fonts>`; without the attribute the builder draws in the system
 * face. The href is resolved against the bundle's own URL (the same base the PDF module finds
 * `fonts/` under), so the copy `copy-assets` places beside the bundles is found without
 * configuration.
 *
 * Idempotent: the sheet is linked once per document however many builders ask for it, marked
 * `data-datum-builder-font` with its resolved href so a page can find, move or remove it.
 */

export const BUILDER_FONT_ATTRIBUTE = "data-datum-builder-font";

/** Where the builder's own faces sit beside the bundles (copy-assets: `builder-fonts/`). */
export const BUILDER_FONTS_STYLESHEET = "builder-fonts/builder-fonts.css";

/**
 * Links the builder's own faces into `doc`'s head once. Returns the `<link>` elements now standing
 * for them, the ones just added and the ones already there.
 */
export function loadBuilderFonts(doc: Document = document, base: string = import.meta.url): HTMLLinkElement[] {
  let url: string;
  try {
    url = new URL(BUILDER_FONTS_STYLESHEET, base).href;
  } catch {
    // Not a URL: nothing to link.
    return [];
  }
  const existing = Array.from(doc.querySelectorAll<HTMLLinkElement>(`link[${BUILDER_FONT_ATTRIBUTE}]`)).find(
    (link) => link.getAttribute(BUILDER_FONT_ATTRIBUTE) === url
  );
  if (existing) {
    return [existing];
  }
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  link.setAttribute(BUILDER_FONT_ATTRIBUTE, url);
  (doc.head ?? doc.documentElement).append(link);
  return [link];
}
