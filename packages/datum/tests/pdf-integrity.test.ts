import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The PDF modules held to a hash (`pdf-integrity`, `pdf-pages-integrity`): each is one file, fetched,
 * checked and imported from a `blob:` URL of the bytes checked, on the first load and on every retry.
 * The files they fetch beside themselves are held to the package's integrity manifest, itself held
 * to the hash the page gives (`pdf-manifest-integrity`): the PDF fonts, the pdf.js worker (started
 * from a `blob:` URL) and the data pdf.js asks the page for through its BinaryDataFactory.
 */

// pdf.js under jsdom has no Worker and no canvas: the document side is a stand-in that records what
// the rasteriser asked pdf.js for. The real document side is tests/pdf-pages.test.ts.
const pdfjsCalls = vi.hoisted(() => ({ params: [] as Record<string, unknown>[], workers: [] as { port: unknown; destroyed: boolean }[] }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  class PDFWorker {
    public destroyed = false;
    public readonly port: unknown;
    constructor({ port }: { port: unknown }) {
      this.port = port;
      pdfjsCalls.workers.push(this);
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  return {
    ...actual,
    PDFWorker,
    getDocument: (params: Record<string, unknown>) => {
      pdfjsCalls.params.push(params);
      return { promise: Promise.resolve({ numPages: 0 }), destroy: () => Promise.resolve() };
    }
  };
});

import { ChunkLoadError } from "../src/chunk-load-error.js";
import { IntegrityError, fetchListed, type IntegrityManifest } from "../src/integrity.js";
import { loadPdfPageRasterizer, loadPdfSupport } from "../src/pdf-loader.js";
import { createPdfPageRasterizer } from "../src/pdf-pages.js";
import { createPdfSupport } from "../src/pdf.js";

const sri = (bytes: string | Uint8Array): string => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

/** What the stubbed network serves, by URL; a function answers per request. Every request is logged. */
let served: Record<string, string | (() => Response | Promise<Response>)> = {};
let requested: string[] = [];
/** The bytes of each blob: URL made, by the URL handed out. */
let blobs: Map<string, Blob>;


beforeEach(() => {
  served = {};
  requested = [];
  blobs = new Map();
  pdfjsCalls.params.length = 0;
  pdfjsCalls.workers.length = 0;
  vi.stubGlobal("fetch", async (input: string) => {
    requested.push(input);
    const answer = served[input];
    if (answer === undefined) {
      return new Response("not here", { status: 404, statusText: "Not Found" });
    }
    return typeof answer === "function" ? answer() : new Response(answer, { status: 200 });
  });
  let made = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    made += 1;
    const url = `blob:https://page.example/${made}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Hands `import()` of a blob: URL the text it holds as a data: URL, which the test runner can
 * import; the blob URL the module was imported from is what `createObjectURL` handed out.
 */
function importBlobsAsData(text: string): void {
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.set("data", blob as Blob);
    return `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
  });
}

describe("a PDF module held to a hash", () => {
  // The stand-in module hands back what it was built with, so the test sees the options.
  const PDF_MODULE = "export async function createPdfSupport(options) { return { provider: options }; } export function renderPdf() {}";

  it("imports the bytes it checked from a blob: URL and tells the module where it was fetched from", async () => {
    const url = "https://cdn.example/good/datum-pdf.js";
    served[url] = PDF_MODULE;
    importBlobsAsData(PDF_MODULE);
    const support = await loadPdfSupport(url, { integrity: sri(PDF_MODULE) });
    expect(support.provider).toEqual({ baseUrl: url });
    expect(new TextDecoder().decode(await blobs.get("data")!.arrayBuffer())).toBe(PDF_MODULE);
  });

  it("refuses a module whose bytes do not match, and imports nothing", async () => {
    const url = "https://cdn.example/wrong/datum-pdf.js";
    served[url] = PDF_MODULE;
    const refused = await loadPdfSupport(url, { integrity: sri("another build") }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IntegrityError);
    expect((refused as Error).message).toMatch(/^The PDF module at https:\/\/cdn\.example\/wrong\/datum-pdf\.js was not loaded: its sha384 digest is .* which the integrity it was given does not list$/);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("checks a retried load as it checked the first", async () => {
    const url = "https://cdn.example/retry/datum-pdf.js";
    served[url] = () => Promise.reject(new TypeError("Failed to fetch"));
    const first = await loadPdfSupport(url, { integrity: sri(PDF_MODULE) }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ChunkLoadError);
    await Promise.resolve();
    // The retry asks for a URL no cache has failed on, and the bytes it gets are checked: these are not the module's.
    served[`${url}?retry=1`] = "export const tampered = true;";
    await expect(loadPdfSupport(url, { integrity: sri(PDF_MODULE) })).rejects.toThrow(IntegrityError);
    await Promise.resolve();
    served[`${url}?retry=2`] = PDF_MODULE;
    importBlobsAsData(PDF_MODULE);
    expect((await loadPdfSupport(url, { integrity: sri(PDF_MODULE) })).provider).toEqual({ baseUrl: url });
    expect(requested).toEqual([url, `${url}?retry=1`, `${url}?retry=2`]);
  });

  it("refuses a page imagery module whose bytes do not match", async () => {
    const url = "https://cdn.example/pages/datum-pdf-pages.js";
    served[url] = "export function createPdfPageRasterizer() { return {}; }";
    await expect(loadPdfPageRasterizer(url, { integrity: sri("not it") })).rejects.toThrow(IntegrityError);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("reads the manifest beside the package's folder only when the page pins it, and refuses one that does not match", async () => {
    const url = "https://cdn.example/pkg/dist/datum-pdf.js";
    const manifestUrl = "https://cdn.example/pkg/integrity.json";
    const manifest = JSON.stringify({ algorithm: "sha384", files: { "fonts/DejaVuSans.ttf": sri("font") } });
    served[url] = PDF_MODULE;
    served[manifestUrl] = manifest;
    importBlobsAsData(PDF_MODULE);
    // No manifest hash: the manifest is never read, since an unpinned one proves nothing.
    await loadPdfSupport(url, { integrity: sri(PDF_MODULE), manifest: "auto" });
    expect(requested).toEqual([url]);
    await expect(loadPdfSupport(url, { integrity: sri(PDF_MODULE), manifestIntegrity: sri("another manifest") })).rejects.toThrow(/The integrity manifest at https:\/\/cdn\.example\/pkg\/integrity\.json was not loaded/);
    const support = await loadPdfSupport(url, { integrity: sri(PDF_MODULE), manifestIntegrity: sri(manifest) });
    expect(support.provider).toEqual({ baseUrl: url, manifest: { files: { "fonts/DejaVuSans.ttf": sri("font") } } });
  });
});

describe("the files a PDF module fetches, held to the manifest", () => {
  const manifest = (files: Record<string, string>): IntegrityManifest => ({ files });

  it("refuses a file the manifest does not list, without fetching it", async () => {
    await expect(fetchListed(manifest({}), "fonts/DejaVuSans.ttf", "https://cdn.example/fonts/DejaVuSans.ttf")).rejects.toThrow(/the integrity manifest lists no "fonts\/DejaVuSans\.ttf"/);
    expect(requested).toEqual([]);
  });

  it("holds the PDF fonts to the manifest, beside the URL the module was fetched from", async () => {
    const base = "https://cdn.example/pkg/dist/datum-pdf.js";
    served["https://cdn.example/pkg/dist/fonts/DejaVuSans.ttf"] = "regular";
    served["https://cdn.example/pkg/dist/fonts/DejaVuSans-Bold.ttf"] = "bold";
    const good = manifest({ "fonts/DejaVuSans.ttf": sri("regular"), "fonts/DejaVuSans-Bold.ttf": sri("bold") });
    const support = await createPdfSupport({ baseUrl: base, manifest: good });
    expect(support.fonts).toBeDefined();
    expect(requested).toEqual(["https://cdn.example/pkg/dist/fonts/DejaVuSans.ttf", "https://cdn.example/pkg/dist/fonts/DejaVuSans-Bold.ttf"]);
    await expect(createPdfSupport({ baseUrl: base, manifest: manifest({ "fonts/DejaVuSans.ttf": sri("regular"), "fonts/DejaVuSans-Bold.ttf": sri("other") }) })).rejects.toThrow(IntegrityError);
    await expect(createPdfSupport({ baseUrl: base, manifest: manifest({ "fonts/DejaVuSans.ttf": sri("regular") }) })).rejects.toThrow(/lists no "fonts\/DejaVuSans-Bold\.ttf"/);
  });
});

describe("the pdf.js worker and data, held to the manifest", () => {
  const base = "https://cdn.example/pkg/dist/datum-pdf-pages.js";
  const workerUrl = "https://cdn.example/pkg/dist/pdfjs/pdf.worker.min.mjs";
  const WORKER = "/* the pdf.js worker */";

  /** A Worker that says it is ready (or fails to start) as pdf.js's own does, and records itself. */
  class FakeWorker extends EventTarget {
    static made: FakeWorker[] = [];
    static starts = true;
    public terminated = false;
    constructor(
      public readonly url: string,
      public readonly options: WorkerOptions
    ) {
      super();
      FakeWorker.made.push(this);
      queueMicrotask(() => {
        this.dispatchEvent(FakeWorker.starts ? new MessageEvent("message", { data: { action: "ready" } }) : new Event("error"));
      });
    }
    postMessage(): void {}
    terminate(): void {
      this.terminated = true;
    }
  }

  beforeEach(() => {
    FakeWorker.made = [];
    FakeWorker.starts = true;
    vi.stubGlobal("Worker", FakeWorker);
  });

  it("refuses a worker whose bytes do not match, and starts none", async () => {
    served[workerUrl] = "/* another worker */";
    const rasterizer = createPdfPageRasterizer({ baseUrl: base, manifest: { files: { "pdfjs/pdf.worker.min.mjs": sri(WORKER) } } });
    await expect(rasterizer.open(new Uint8Array([1]))).rejects.toThrow(IntegrityError);
    expect(FakeWorker.made).toEqual([]);
    expect(pdfjsCalls.params).toEqual([]);
  });

  it("refuses a worker the manifest does not list", async () => {
    const rasterizer = createPdfPageRasterizer({ baseUrl: base, manifest: { files: {} } });
    await expect(rasterizer.open(new Uint8Array([1]))).rejects.toThrow(/lists no "pdfjs\/pdf\.worker\.min\.mjs"/);
    expect(requested).toEqual([]);
  });

  it("starts the worker from the bytes checked and hands pdf.js only data it checks against the manifest", async () => {
    served[workerUrl] = WORKER;
    served["https://cdn.example/pkg/dist/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap"] = "cmap";
    served["https://cdn.example/pkg/dist/pdfjs/standard_fonts/FoxitSymbol.pfb"] = "tampered";
    served["https://cdn.example/pkg/dist/pdfjs/wasm/openjpeg.wasm"] = "decoder";
    const rasterizer = createPdfPageRasterizer({
      baseUrl: base,
      manifest: {
        files: {
          "pdfjs/pdf.worker.min.mjs": sri(WORKER),
          "pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap": sri("cmap"),
          "pdfjs/standard_fonts/FoxitSymbol.pfb": sri("the real symbol font"),
          "pdfjs/wasm/openjpeg.wasm": sri("decoder")
        }
      }
    });
    const set = await rasterizer.open(new Uint8Array([1]));
    // The worker: a module worker from a blob: URL of exactly the bytes checked, given to pdf.js as its port.
    expect(FakeWorker.made).toHaveLength(1);
    const [worker] = FakeWorker.made;
    expect(worker!.options).toEqual({ type: "module" });
    expect(new TextDecoder().decode(await blobs.get(worker!.url)!.arrayBuffer())).toBe(WORKER);
    const [params] = pdfjsCalls.params;
    expect(pdfjsCalls.workers[0]!.port).toBe(worker);
    expect(params!["worker"]).toBe(pdfjsCalls.workers[0]);
    // pdf.js fetches nothing itself: no wasm or ICC folder is named to it, and its data come through the factory.
    expect(params!["useWorkerFetch"]).toBe(false);
    expect(params!["wasmUrl"]).toBeUndefined();
    expect(params!["iccUrl"]).toBeUndefined();
    const Factory = params!["BinaryDataFactory"] as new (options: object) => { fetch(request: { kind: string; filename: string }): Promise<Uint8Array> };
    const factory = new Factory({});
    expect(new TextDecoder().decode(await factory.fetch({ kind: "cMapUrl", filename: "Adobe-Japan1-UCS2.bcmap" }))).toBe("cmap");
    expect(new TextDecoder().decode(await factory.fetch({ kind: "wasmUrl", filename: "openjpeg.wasm" }))).toBe("decoder");
    await expect(factory.fetch({ kind: "standardFontDataUrl", filename: "FoxitSymbol.pfb" })).rejects.toThrow(IntegrityError);
    await expect(factory.fetch({ kind: "cMapUrl", filename: "UniGB-UCS2-H.bcmap" })).rejects.toThrow(/lists no "pdfjs\/cmaps\/UniGB-UCS2-H\.bcmap"/);
    await expect(factory.fetch({ kind: "iccUrl", filename: "CGATS001Compat-v2-micro.icc" })).rejects.toThrow(/does not serve/);
    // The worker is this module's own: closing the document ends it.
    set.close();
    await vi.waitFor(() => expect(worker!.terminated).toBe(true));
    expect(pdfjsCalls.workers[0]!.destroyed).toBe(true);
  });

  it("says why when the worker cannot start from a blob: URL", async () => {
    served[workerUrl] = WORKER;
    FakeWorker.starts = false;
    const rasterizer = createPdfPageRasterizer({ baseUrl: base, manifest: { files: { "pdfjs/pdf.worker.min.mjs": sri(WORKER) } } });
    await expect(rasterizer.open(new Uint8Array([1]))).rejects.toThrow(/blob: in worker-src/);
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    expect(pdfjsCalls.params).toEqual([]);
  });

  it("leaves pdf.js to fetch its files as before when no manifest is given", async () => {
    const rasterizer = createPdfPageRasterizer({ baseUrl: base });
    await rasterizer.open(new Uint8Array([1]));
    const [params] = pdfjsCalls.params;
    expect(params!["worker"]).toBeUndefined();
    expect(params!["useWorkerFetch"]).toBeUndefined();
    expect(params!["wasmUrl"]).toBe("https://cdn.example/pkg/dist/pdfjs/wasm/");
    expect(params!["iccUrl"]).toBe("https://cdn.example/pkg/dist/pdfjs/iccs/");
    expect(FakeWorker.made).toEqual([]);
  });
});
