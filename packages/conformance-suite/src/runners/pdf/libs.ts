import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bytesToBase64, type PdfFontResource } from "@argusvane/datum-engine/render";

/**
 * The PDF runner inspects output bytes with pdf.js and pdf-lib. Neither is a dependency of the
 * suite's tarball (the bundle stays free of them): they are found at run time, next to the suite,
 * next to @argusvane/datum-pdf-kernel when the suite runs from a checkout, or from the working directory.
 * A library that cannot be found makes the vectors that need it SKIP with that reason; the
 * runner never fails a program for a missing inspection tool.
 */
export class MissingLibrary extends Error {
  constructor(readonly library: string) {
    super(`${library} was not found (install it next to the suite, or run from a checkout where packages/pdf-kernel has it)`);
    this.name = "MissingLibrary";
  }
}

/** Folders a package may be installed under: the suite's own node_modules chain, the working directory's, and the PDF kernel's (a checkout link). */
function searchRoots(): string[] {
  const roots: string[] = [];
  const addChain = (from: string): void => {
    for (let dir = from, i = 0; i < 12; i += 1) {
      const candidate = join(dir, "node_modules");
      if (!roots.includes(candidate)) {
        roots.push(candidate);
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  };
  addChain(dirname(fileURLToPath(import.meta.url)));
  addChain(process.cwd());
  // From a checkout, @argusvane/datum-pdf-kernel is a link whose real folder has the libraries.
  for (const root of [...roots]) {
    const link = join(root, "@argusvane", "datum-pdf-kernel");
    if (existsSync(join(link, "package.json"))) {
      addChain(realpathSync(link));
    }
  }
  return roots;
}

/** The folder of an installed package. */
export function packageDir(name: string): string | undefined {
  for (const root of searchRoots()) {
    const dir = join(root, name);
    if (existsSync(join(dir, "package.json"))) {
      return realpathSync(dir);
    }
  }
  return undefined;
}

function resolveFrom(specifier: string): string | undefined {
  const [scopeOrName, maybeName, ...rest] = specifier.split("/");
  const name = scopeOrName!.startsWith("@") ? `${scopeOrName}/${maybeName}` : scopeOrName!;
  const dir = packageDir(name);
  if (dir === undefined) {
    return undefined;
  }
  try {
    return createRequire(join(dir, "package.json")).resolve(rest.length > 0 || !scopeOrName!.startsWith("@") ? `${name}${specifier.slice(name.length)}` : name);
  } catch {
    return undefined;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let pdfjsPromise: Promise<any> | undefined;
export function loadPdfjs(): Promise<any> {
  pdfjsPromise ??= (async () => {
    const path = resolveFrom("pdfjs-dist/legacy/build/pdf.mjs");
    if (path === undefined) {
      throw new MissingLibrary("pdfjs-dist");
    }
    return import(/* @vite-ignore */ pathToFileURL(path).href);
  })();
  return pdfjsPromise;
}

let pdfLibPromise: Promise<any> | undefined;
/**
 * pdf-lib's exports. `resolveFrom` resolves with require conditions, so the path is the package's CommonJS entry, and
 * it is loaded with require. Imported instead, its namespace holds only the names Node's CommonJS lexer finds: Node 22's
 * misses the getter re-exports (`PDFDocument` among them, so every check that loads a document read undefined), while
 * Node 24's finds them.
 */
export function loadPdfLib(): Promise<any> {
  pdfLibPromise ??= (async () => {
    const path = resolveFrom("@cantoo/pdf-lib");
    if (path === undefined) {
      throw new MissingLibrary("@cantoo/pdf-lib");
    }
    return createRequire(path)(path);
  })();
  return pdfLibPromise;
}

/** A document opened in pdf.js, closed by `done`. */
export async function openPdfjs(bytes: Uint8Array): Promise<{ doc: any; done: () => Promise<void> }> {
  const pdfjs = await loadPdfjs();
  const dir = packageDir("pdfjs-dist");
  const standardFontDataUrl = dir !== undefined ? `${join(dir, "standard_fonts")}/` : undefined;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, useSystemFonts: false, disableFontFace: true, ...(standardFontDataUrl !== undefined ? { standardFontDataUrl } : {}) });
  const doc = await task.promise;
  return { doc, done: async () => void (await task.destroy()) };
}

let fontsPromise: Promise<PdfFontResource[]> | undefined;
/** DejaVu Sans regular and bold as the kernel's font resources, or none when the package is not installed (the kernel then falls back to the standard-14 fonts). */
export function loadFonts(): Promise<PdfFontResource[]> {
  fontsPromise ??= (async () => {
    const dir = packageDir("dejavu-fonts-ttf");
    if (dir === undefined) {
      return [];
    }
    const coverage = ["Latn", "Grek", "Cyrl", "Arab", "Hebr"];
    const read = (file: string): string => bytesToBase64(new Uint8Array(readFileSync(join(dir, "ttf", file))));
    try {
      return [
        { id: "dejavu-sans", family: "sans-serif", weight: 400, style: "normal", data: read("DejaVuSans.ttf"), coverage },
        { id: "dejavu-sans-bold", family: "sans-serif", weight: 700, style: "normal", data: read("DejaVuSans-Bold.ttf"), coverage }
      ];
    } catch {
      return [];
    }
  })();
  return fontsPromise;
}
