/**
 * Fonts for the kernel: the package's default pack (DejaVu Sans, which covers Latin, Greek,
 * Cyrillic, Arabic and Hebrew under a permissive licence) and a `PdfFontProvider` over any
 * set of resources. Loading reads files in Node and fetches them in the browser; the
 * resources themselves are plain base64 and cross any boundary.
 */
import type { PdfFontNeed, PdfFontProvider, PdfFontResource } from "@argusvane/datum-engine/render";
import { bytesToBase64 } from "@argusvane/datum-engine/render";
import { toSfnt } from "./woff-to-sfnt.js";

export interface FontPackEntry {
  id: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
  file: string;
  coverage: string[];
}

/** DejaVu Sans, as the package ships it in `node_modules/dejavu-fonts-ttf/ttf/`. */
export const DEFAULT_FONT_PACK: FontPackEntry[] = [
  { id: "dejavu-sans", family: "sans-serif", weight: 400, style: "normal", file: "DejaVuSans.ttf", coverage: ["Latn", "Grek", "Cyrl", "Arab", "Hebr"] },
  { id: "dejavu-sans-bold", family: "sans-serif", weight: 700, style: "normal", file: "DejaVuSans-Bold.ttf", coverage: ["Latn", "Grek", "Cyrl", "Arab", "Hebr"] },
  { id: "dejavu-sans-oblique", family: "sans-serif", weight: 400, style: "italic", file: "DejaVuSans-Oblique.ttf", coverage: ["Latn", "Grek", "Cyrl"] },
  { id: "dejavu-serif", family: "serif", weight: 400, style: "normal", file: "DejaVuSerif.ttf", coverage: ["Latn", "Grek", "Cyrl"] },
  { id: "dejavu-serif-bold", family: "serif", weight: 700, style: "normal", file: "DejaVuSerif-Bold.ttf", coverage: ["Latn", "Grek", "Cyrl"] },
  { id: "dejavu-mono", family: "monospace", weight: 400, style: "normal", file: "DejaVuSansMono.ttf", coverage: ["Latn", "Grek", "Cyrl"] },
  { id: "dejavu-mono-bold", family: "monospace", weight: 700, style: "normal", file: "DejaVuSansMono-Bold.ttf", coverage: ["Latn", "Grek", "Cyrl"] }
];

export interface LoadFontPackOptions {
  /** Where the font files are: a directory (Node) or a URL prefix (browser). Default: the package's copy. */
  baseUrl?: string;
  /** Which entries to load; default all. */
  entries?: FontPackEntry[];
  /** How to read one file; default reads the file system in Node and fetches elsewhere. */
  read?: (location: string) => Promise<Uint8Array>;
}

function isNode(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof proc?.versions?.node === "string";
}

async function defaultRead(location: string): Promise<Uint8Array> {
  if (isNode() && !/^https?:/.test(location)) {
    const fs = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = location.startsWith("file:") ? fileURLToPath(location) : location;
    return new Uint8Array(await fs.readFile(path));
  }
  const fetchImpl = (globalThis as { fetch?: typeof fetch }).fetch;
  if (!fetchImpl) {
    throw new Error(`Cannot read font "${location}": no file system and no fetch`);
  }
  const response = await fetchImpl(location);
  if (!response.ok) {
    throw new Error(`Cannot read font "${location}": ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function defaultBase(): Promise<string> {
  if (isNode()) {
    const { createRequire } = await import("node:module");
    const { dirname, join } = await import("node:path");
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf");
  }
  return new URL("./fonts/", import.meta.url).href;
}

function joinLocation(base: string, file: string): string {
  if (/^https?:|^file:|^\//.test(file)) {
    return file;
  }
  if (/^https?:|^file:/.test(base)) {
    return `${base.endsWith("/") ? base : `${base}/`}${file}`;
  }
  return `${base.replace(/[\\/]+$/, "")}/${file}`;
}

/** Loads the pack's resources, ready to send in a request. */
export async function loadFontPack(options: LoadFontPackOptions = {}): Promise<PdfFontResource[]> {
  const base = options.baseUrl ?? (await defaultBase());
  const read = options.read ?? defaultRead;
  const out: PdfFontResource[] = [];
  for (const entry of options.entries ?? DEFAULT_FONT_PACK) {
    const bytes = await read(joinLocation(base, entry.file));
    out.push({ id: entry.id, family: entry.family, weight: entry.weight, style: entry.style, data: bytesToBase64(bytes), coverage: [...entry.coverage] });
  }
  return out;
}

/**
 * A provider over a fixed set of resources: what the document's families and scripts need,
 * from what is loaded. A family the set lacks is left to the kernel's standard-font fallback.
 */
export function createFontProvider(resources: readonly PdfFontResource[]): PdfFontProvider {
  return {
    resolve: async (need) => {
      const families = new Set(need.families.map((family) => family.toLowerCase()));
      const picked = resources.filter((resource) => families.has(resource.family.toLowerCase()));
      // Scripts outside the picked families' coverage: add any resource that covers them, so a
      // theme fallback family named for the script is available.
      const covered = new Set(picked.flatMap((resource) => resource.coverage ?? []));
      for (const script of need.scripts) {
        if (covered.has(script)) {
          continue;
        }
        const extra = resources.find((resource) => resource.coverage?.includes(script) && !picked.includes(resource));
        if (extra) {
          picked.push(extra);
          for (const tag of extra.coverage ?? []) {
            covered.add(tag);
          }
        }
      }
      return picked;
    }
  };
}

export interface FaceFontProviderOptions {
  /**
   * What a face's `file` is relative to: the folder the host serves the design system's fonts
   * from (a URL in a page, a directory in Node). A function answers per PDF theme (the need's
   * `themeId`), because each design system's fonts are served from a place of their own; one
   * that returns `undefined` has no fonts for that theme, and its faces are reported and left
   * to the default pack.
   */
  baseUrl: string | ((themeId: string | undefined) => string | undefined);
  /** How to read one file; default reads the file system in Node and fetches elsewhere. */
  read?: (location: string) => Promise<Uint8Array>;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A provider over the faces a theme ships (`assets.fonts`), as the engine forwards
 * them in the need: a face whose family the document names is loaded — once, cached by where it
 * was read from — and returned as a resource; families the need brings no face for are left to
 * the next provider. A need without faces (a theme that ships none) loads nothing.
 *
 * Design systems ship their faces as WOFF 1.0; the kernel embeds TTF and OTF only, so each file
 * is converted on load (`woffToSfnt`, lossless, in the browser and in Node alike). One face that
 * cannot be read or converted is one warning (`font.faceFailed`, on the need's `warn`), not a
 * failed document: the family has no resource, and the kernel draws it in the default pack
 * behind this provider (DejaVu). A failed read is not cached, so a host that serves the file
 * later gets it on the next render.
 */
export function createFaceFontProvider(options: FaceFontProviderOptions): PdfFontProvider {
  const read = options.read ?? defaultRead;
  const cache = new Map<string, Promise<PdfFontResource>>();
  const baseFor = (themeId: string | undefined): string | undefined => (typeof options.baseUrl === "function" ? options.baseUrl(themeId) : options.baseUrl);
  const load = (face: NonNullable<PdfFontNeed["faces"]>[number], location: string): Promise<PdfFontResource> => {
    let pending = cache.get(location);
    if (!pending) {
      pending = read(location)
        .then(toSfnt)
        .then((bytes) => ({
          id: location,
          family: face.family,
          weight: face.weight ?? 400,
          style: face.style ?? "normal",
          data: bytesToBase64(bytes),
          coverage: face.coverage ? [...face.coverage] : ["Latn"]
        }));
      cache.set(location, pending);
      pending.catch(() => {
        if (cache.get(location) === pending) {
          cache.delete(location);
        }
      });
    }
    return pending;
  };
  return {
    resolve: async (need) => {
      const families = new Set(need.families.map((family) => family.toLowerCase()));
      const wanted = (need.faces ?? []).filter((face) => families.has(face.family.toLowerCase()));
      const base = wanted.length > 0 ? baseFor(need.themeId) : undefined;
      const settled = await Promise.all(
        wanted.map(async (face): Promise<PdfFontResource | undefined> => {
          if (base === undefined) {
            need.warn?.({ code: "font.faceFailed", message: `No font folder is configured for the PDF theme "${need.themeId ?? ""}", so "${face.file}" (${face.family}) was not loaded; the default font was used.` });
            return undefined;
          }
          const location = joinLocation(base, face.file);
          try {
            return await load(face, location);
          } catch (error) {
            need.warn?.({ code: "font.faceFailed", message: `The font file "${face.file}" for "${face.family}" could not be loaded (${reasonOf(error)}); the default font was used.` });
            return undefined;
          }
        })
      );
      return settled.filter((resource): resource is PdfFontResource => resource !== undefined);
    }
  };
}

/** Several providers as one: what each answers, in order, a resource id answering once. */
export function composeFontProviders(...providers: readonly PdfFontProvider[]): PdfFontProvider {
  return {
    resolve: async (need) => {
      const out: PdfFontResource[] = [];
      const seen = new Set<string>();
      for (const provider of providers) {
        for (const resource of await provider.resolve(need)) {
          if (!seen.has(resource.id)) {
            seen.add(resource.id);
            out.push(resource);
          }
        }
      }
      return out;
    }
  };
}

/** The default pack as a provider, loaded once and reused. */
export function createDefaultFontProvider(options: LoadFontPackOptions = {}): PdfFontProvider {
  let loading: Promise<PdfFontProvider> | undefined;
  return {
    resolve: (need) => {
      loading ??= loadFontPack(options).then(createFontProvider);
      return loading.then((provider) => provider.resolve(need));
    }
  };
}
