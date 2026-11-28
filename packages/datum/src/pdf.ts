/**
 * The PDF module: the portable kernel and its fonts, as one lazily loaded file.
 *
 * Built as `dist/datum-pdf.js` (a module only — it is never part of the classic scripts, the
 * way the QuickJS sandbox never is). `<datum-form pdf>` and `<datum-form-builder pdf>`
 * `import()` it beside their own bundle on first use, or from the URL the attribute names; a
 * page may also import it itself and hand `createPdfSupport()`'s result to `pdfSupport`. It is one
 * file with no chunks, so `pdf-integrity` can fetch it, check it and import it from a `blob:` URL.
 *
 * The fonts (DejaVu Sans, regular and bold) are fetched from `fonts/` beside this file — the
 * build copies them there — so every script the pack covers prints with embedded glyphs. A
 * theme's own faces (`assets.fonts`) come first: the engine names them in the font
 * need, and they are fetched relative to the bundle — `acme-fonts/pdf/…` beside this file —
 * the first time a document asks for their family.
 */
import {
  createFetchImageResolver,
  renderFormPdf,
  type PdfBindingSuggestion,
  type PdfFontProvider,
  type PdfImageResolver,
  type PdfPageRasterizer,
  type PdfRenderProvider,
  type PdfTemplateResolver,
  type PdfThemeDefinition,
  type PdfThemeSource,
  type RenderableRuntime,
  type RenderFormPdfOptions,
  type RenderFormPdfResult
} from "@argusvane/datum-engine";
import {
  DEFAULT_FONT_PACK,
  composeFontProviders,
  createFaceFontProvider,
  createFontProvider,
  createInProcessPdfProvider,
  loadFontPack,
  type FaceFontProviderOptions
} from "@argusvane/datum-pdf-kernel";

import type { IntegrityManifest } from "./integrity.js";
import { pdfServiceDependencies } from "./pdf-render.js";
import { themes, type PdfThemeInput } from "./themes.js";

/**
 * What an element needs to render PDFs: where the bytes come from, the fonts, how image URLs
 * are fetched, and — optionally — the PDF theme. An element's `pdf-theme` attribute wins over
 * `theme` here; `themes` (a registry or a lookup) is where a layout's `theme` id is found,
 * and defaults to the package's own themes.
 */
export interface DatumPdfSupport {
  provider: PdfRenderProvider;
  fonts?: PdfFontProvider | undefined;
  images?: PdfImageResolver | undefined;
  theme?: PdfThemeDefinition | undefined;
  themes?: PdfThemeSource | undefined;
  /** Page imagery for the designer's area editor (`datum-pdf-pages.js`); the builder adds it when it can. */
  pages?: PdfPageRasterizer | undefined;
}

export interface CreatePdfSupportOptions {
  /** Where the font files are served from (a URL prefix). Default: `fonts/` beside this module. */
  fontsUrl?: string | undefined;
  /** Which of the pack's fonts to load. Default: DejaVu Sans regular and bold. */
  fontIds?: readonly string[] | undefined;
  /**
   * What a theme's face files are relative to (`assets.fonts[].file`): the bundles' own URL by
   * default. A function answers per PDF theme id, because each design system's fonts are served
   * from a place of their own (a GCDS theme names `@gcds-core/fonts` WOFF files relative to the
   * folder the host serves for the live form). Faces may be WOFF 1.0, TTF or OTF; a face that
   * cannot be loaded is one `font.faceFailed` warning and the default font stands in.
   */
  bundleUrl?: FaceFontProviderOptions["baseUrl"] | undefined;
  /**
   * Where this module was served from, which the defaults of `fontsUrl` and `bundleUrl` are found
   * beside. Default: the module's own URL. A page that imported the module from a `blob:` URL, after
   * checking its bytes, names the URL it fetched it from (the elements do, for `pdf-integrity`).
   */
  baseUrl?: string | undefined;
  /**
   * The package's integrity manifest (`integrity.json`, which the page checked against a hash of its
   * own). Set, each font file of the pack is held to the hash the manifest lists for `fonts/<file>`,
   * and a font it does not list or whose bytes differ is refused. A theme's own faces (`bundleUrl`)
   * belong to another package and are not checked.
   */
  manifest?: IntegrityManifest | undefined;
}

const DEFAULT_FONT_IDS = ["dejavu-sans", "dejavu-sans-bold"];

/**
 * How the font files are read where this module runs under Node (a server, a worker thread, a
 * test): from the file system, since Node's fetch reads no file: URL. This browser build stands a
 * stub in for every `node:` import, the font pack's own included, so the module is asked of the
 * process instead. A browser has no process: nothing here, and the pack fetches.
 */
function nodeFileRead(): ((location: string) => Promise<Uint8Array>) | undefined {
  const process = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs = process?.getBuiltinModule?.("node:fs/promises") as { readFile(path: string | URL): Promise<Uint8Array> } | undefined;
  if (!fs) {
    return undefined;
  }
  return async (location) => {
    if (/^https?:/.test(location)) {
      const response = await fetch(location);
      if (!response.ok) {
        throw new Error(`Cannot read font "${location}": ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    }
    return new Uint8Array(await fs.readFile(location.startsWith("file:") ? new URL(location) : location));
  };
}

/** The in-process kernel with the default font pack loaded, and a theme's faces fetched as documents name them. */
export async function createPdfSupport(options: CreatePdfSupportOptions = {}): Promise<DatumPdfSupport> {
  const wanted = new Set(options.fontIds ?? DEFAULT_FONT_IDS);
  const entries = DEFAULT_FONT_PACK.filter((entry) => wanted.has(entry.id));
  const base = options.baseUrl ?? import.meta.url;
  const manifest = options.manifest;
  let read = nodeFileRead();
  if (manifest) {
    // The check is a chunk of its own in the builder's bundle; this module's build carries it inline.
    const { fetchListed } = await import("./integrity.js");
    read = (location) => fetchListed(manifest, `fonts/${location.slice(location.lastIndexOf("/") + 1)}`, location);
  }
  const resources = await loadFontPack({
    baseUrl: options.fontsUrl ?? new URL(/* @vite-ignore */ "./fonts/", base).href,
    entries,
    ...(read ? { read } : {})
  });
  const bundleUrl = options.bundleUrl ?? new URL(/* @vite-ignore */ "./", base).href;
  return {
    provider: createInProcessPdfProvider(),
    fonts: composeFontProviders(createFaceFontProvider({ baseUrl: bundleUrl }), createFontProvider(resources)),
    images: createFetchImageResolver()
  };
}

/** What `renderPdf` takes beside the runtime: the element's render options, and what the element keeps as properties. */
export interface RenderPdfOptions extends RenderFormPdfOptions {
  /** The kernel, fonts and images to draw with, as `<datum-form>`'s `pdfSupport`. Default: this module's own, `createPdfSupport()`, made once. */
  support?: DatumPdfSupport | undefined;
  /** The default PDF theme, as `<datum-form>`'s `pdf-theme`: a registered id or a theme. A layout's own `theme` and the call's `themeId` win over it. */
  theme?: PdfThemeInput;
  /** Where a template layout's file comes from, as `<datum-form>`'s `pdfTemplates`. */
  templates?: PdfTemplateResolver | undefined;
  /** The binding the form is drawn by, when it suggests a PDF theme (`<datum-form>` passes its own). */
  binding?: PdfBindingSuggestion | undefined;
}

let ownSupport: Promise<DatumPdfSupport> | undefined;

/** This module's own support, made on the first call that needs it; a failed load is forgotten. */
function defaultSupport(): Promise<DatumPdfSupport> {
  if (!ownSupport) {
    const load = createPdfSupport();
    load.catch(() => {
      if (ownSupport === load) {
        ownSupport = undefined;
      }
    });
    ownSupport = load;
  }
  return ownSupport;
}

/**
 * A runtime's form as a PDF: what `<datum-form>`'s `renderPdf()` makes for the same form, answers,
 * locale, layout, theme and options, with no element. The runtime may come from `createFormRuntime`
 * in `datum-form.js` or `datum-engine.js`, or be an element's `form.runtime`. The theme names are
 * looked up in the page's `pdfThemes`. The host context is not passed unless the call names one
 * (`hostContext`), as the element passes none. The element's own PDF settings (`pdf-unknown-components`,
 * `pdfSigner`, `formula-errors`) are options here: `unknownComponents`, `signature`, `formulaErrors`.
 */
export async function renderPdf(runtime: RenderableRuntime, options: RenderPdfOptions = {}): Promise<RenderFormPdfResult> {
  const { support: given, theme, templates, binding, ...render } = options;
  const support = given ?? (await defaultSupport());
  const resolved = theme === undefined || theme === null ? undefined : themes.resolvePdf(theme);
  const deps = pdfServiceDependencies(support, { theme: resolved, themes: themes.pdfLookup, templates, binding });
  return renderFormPdf(runtime, { ...deps, provider: support.provider }, render);
}

export { DEFAULT_FONT_PACK, composeFontProviders, createFaceFontProvider, createFontProvider, createInProcessPdfProvider, loadFontPack } from "@argusvane/datum-pdf-kernel";
