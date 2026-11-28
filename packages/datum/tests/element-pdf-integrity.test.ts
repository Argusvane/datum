import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The elements' integrity attributes reach the loaders: `<datum-form>`'s pdf-integrity, pdf-manifest
 * and pdf-manifest-integrity; `<datum-form-builder>`'s same three, pdf-pages-integrity and
 * wasm-integrity. A builder whose PDF module is held to a hash loads datum-pdf.js by URL in place of
 * its own chunk, since only a module fetched by the element can be checked by it.
 */
const loads = vi.hoisted(() => ({
  pdf: [] as { url: string; pin: unknown }[],
  pages: [] as { url: string; pin: unknown }[],
  wasm: [] as { spec: string; integrity: string | undefined }[]
}));
vi.mock("../src/pdf-loader.ts", async (importActual) => {
  const actual = await importActual<typeof import("../src/pdf-loader.js")>();
  return {
    ...actual,
    loadPdfSupport: (spec: string, pin: unknown = {}) => {
      loads.pdf.push({ url: actual.resolvePdfModuleUrl(spec), pin });
      return Promise.resolve({ provider: {} });
    },
    loadPdfPageRasterizer: (url: string, pin: unknown = {}) => {
      loads.pages.push({ url, pin });
      return Promise.resolve({ open: () => Promise.reject(new Error("no pages in this test")) });
    }
  };
});
vi.mock("../src/wasm-loader.ts", async (importActual) => {
  const actual = await importActual<typeof import("../src/wasm-loader.js")>();
  return {
    ...actual,
    loadWasmValidationHost: (spec: string, _plugins: unknown, options: { integrity?: string } = {}) => {
      loads.wasm.push({ spec, integrity: options.integrity });
      return new Promise(() => undefined);
    }
  };
});

import "../src/form.js";
import "../src/builder.js";
import type { DatumFormElement } from "../src/form.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { defaultPdfModuleUrl } from "../src/pdf-loader.js";
import { sampleDefinition } from "./helpers.js";

const PDF = "sha384-pdfmodulehash";
const PAGES = "sha384-pagesmodulehash";
const MANIFEST = "sha384-manifesthash";

beforeEach(() => {
  loads.pdf.length = 0;
  loads.pages.length = 0;
  loads.wasm.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("<datum-form>'s PDF integrity attributes", () => {
  it("hand the PDF loader the module's hash and the manifest's, trimmed, with the manifest URL resolved once", async () => {
    const el = document.createElement("datum-form") as DatumFormElement;
    el.setAttribute("pdf", "auto");
    el.setAttribute("pdf-integrity", `  ${PDF}  `);
    el.setAttribute("pdf-manifest", "./vendor/integrity.json");
    el.setAttribute("pdf-manifest-integrity", MANIFEST);
    expect(el.pdfIntegrity).toBe(PDF);
    expect(el.pdfManifest).toBe(new URL("./vendor/integrity.json", document.baseURI).href);
    expect(el.pdfManifestIntegrity).toBe(MANIFEST);
    el.definition = sampleDefinition();
    document.body.append(el);
    await el.renderPdf().catch(() => undefined);
    expect(loads.pdf).toEqual([{ url: defaultPdfModuleUrl(), pin: { integrity: PDF, manifest: new URL("./vendor/integrity.json", document.baseURI).href, manifestIntegrity: MANIFEST } }]);
    el.removeAttribute("pdf-integrity");
    el.pdfManifestIntegrity = "  ";
    expect(el.pdfIntegrity).toBeUndefined();
    expect(el.pdfManifestIntegrity).toBeUndefined();
  });
});

describe("<datum-form-builder>'s integrity attributes", () => {
  function builder(attributes: Record<string, string>): DatumFormBuilderElement {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    for (const [name, value] of Object.entries(attributes)) {
      el.setAttribute(name, value);
    }
    return el;
  }
  const executor = (el: DatumFormBuilderElement): Promise<{ pages?: unknown }> => (el as unknown as { executorLoader(): () => Promise<{ pages?: unknown }> }).executorLoader()();

  it("load datum-pdf.js and datum-pdf-pages.js by URL, held to their hashes, in place of the bundle's own chunks", async () => {
    const el = builder({ "pdf-integrity": PDF, "pdf-pages-integrity": PAGES, "pdf-manifest-integrity": MANIFEST });
    expect([el.pdfIntegrity, el.pdfPagesIntegrity, el.pdfManifestIntegrity, el.pdfManifest]).toEqual([PDF, PAGES, MANIFEST, undefined]);
    const support = await executor(el);
    expect(support.pages).toBeDefined();
    const pin = { manifest: undefined, manifestIntegrity: MANIFEST };
    expect(loads.pdf).toEqual([{ url: defaultPdfModuleUrl(), pin: { integrity: PDF, ...pin } }]);
    expect(loads.pages).toEqual([{ url: new URL("./datum-pdf-pages.js", defaultPdfModuleUrl()).href, pin: { integrity: PAGES, ...pin } }]);
  });

  it("hold the page imagery module beside a named PDF module to its own hash", async () => {
    const el = builder({ pdf: "./modules/datum-pdf.js", "pdf-pages-integrity": PAGES });
    await executor(el);
    const pdfUrl = new URL("./modules/datum-pdf.js", document.baseURI).href;
    expect(loads.pdf).toEqual([{ url: pdfUrl, pin: { integrity: undefined, manifest: undefined, manifestIntegrity: undefined } }]);
    expect(loads.pages).toEqual([{ url: new URL("./datum-pdf-pages.js", pdfUrl).href, pin: { integrity: PAGES, manifest: undefined, manifestIntegrity: undefined } }]);
  });

  it("hand the sandbox loader the wasm-integrity Try it's module is held to", async () => {
    const el = builder({ wasm: "auto", "wasm-integrity": "  sha384-AAAA  " });
    expect(el.wasmIntegrity).toBe("sha384-AAAA");
    const source = (el as unknown as { wasmChecks(): () => Promise<unknown> }).wasmChecks();
    void source();
    expect(loads.wasm).toEqual([{ spec: "auto", integrity: "sha384-AAAA" }]);
    el.removeAttribute("wasm-integrity");
    expect(el.wasmIntegrity).toBeUndefined();
    // A new integrity is a new loader: the one held to the old hash is not reused.
    expect((el as unknown as { wasmChecks(): () => Promise<unknown> }).wasmChecks()).not.toBe(source);
  });
});
