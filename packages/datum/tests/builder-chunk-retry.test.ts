// @vitest-environment node
// (vite.config.ts loads esbuild, which refuses jsdom's TextEncoder; nothing here needs a DOM.)
import { describe, expect, it } from "vitest";

import { RETRY_IMPORT, RETRY_IMPORT_FUNCTION, retryableChunkImports } from "../vite.config.js";

/*
 * A builder chunk that failed to load loads again. A browser keeps a failed
 * import() of a URL for the page's life, so the module build asks for each chunk through the
 * function vite.config.ts appends: the same URL the first time, `<chunk>?retry=<n>` after n
 * failed loads. No test environment has a browser's module map; the function is run here over a
 * stand-in for import(), and real Chrome proves the rest. The loaders' own retrying memos are
 * held by the failed-load cases in builder-journeys and builder-journey-map.
 */

type Loader = (url: string) => Promise<unknown>;

/** The appended function, with `import(` read as a call of `load`: what it asks for, in order. */
function chunkImporter(answer: (url: string) => Promise<unknown>): { importChunk: Loader; asked: string[] } {
  const asked: string[] = [];
  const load: Loader = (url) => {
    asked.push(url);
    return answer(url);
  };
  expect(RETRY_IMPORT_FUNCTION.match(/\bimport\(/g)).toHaveLength(1);
  const source = `${RETRY_IMPORT_FUNCTION.replace(/\bimport\(/, "load(")}\nreturn ${RETRY_IMPORT};`;
  const importChunk = new Function("load", source)(load) as Loader;
  return { importChunk, asked };
}

/** A hook of the plugin, as Rollup calls it. */
function hook<T>(value: unknown): T {
  return (typeof value === "function" ? value : (value as { handler: T }).handler) as T;
}

describe("the builder's lazy chunks after a failed load", () => {
  it("asks for the chunk's own URL first, then a URL the module map has not seen after each failure", async () => {
    const down = new Set(["./datum-builder-journey-preview-x.js"]);
    const { importChunk, asked } = chunkImporter((url) => (down.has(url.split("?")[0]!) ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve({ url })));

    await expect(importChunk("./datum-builder-journey-preview-x.js")).rejects.toThrow("Failed to fetch");
    await expect(importChunk("./datum-builder-journey-preview-x.js")).rejects.toThrow("Failed to fetch");
    down.clear();
    await expect(importChunk("./datum-builder-journey-preview-x.js")).resolves.toEqual({ url: "./datum-builder-journey-preview-x.js?retry=2" });
    expect(asked).toEqual(["./datum-builder-journey-preview-x.js", "./datum-builder-journey-preview-x.js?retry=1", "./datum-builder-journey-preview-x.js?retry=2"]);

    // Another chunk keeps its own count: its first load is the import it always was.
    await expect(importChunk("./datum-builder-journey-map-y.js")).resolves.toEqual({ url: "./datum-builder-journey-map-y.js" });
  });

  it("counts loads that fail together as one failure", async () => {
    let fail = true;
    const { importChunk, asked } = chunkImporter((url) => (fail ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(url)));
    await Promise.allSettled([importChunk("./a.js"), importChunk("./a.js")]);
    fail = false;
    await expect(importChunk("./a.js")).resolves.toBe("./a.js?retry=1");
    expect(asked).toEqual(["./a.js", "./a.js", "./a.js?retry=1"]);
  });

  it("goes round every import() of a chunk of the module build, and nothing else", () => {
    const plugin = retryableChunkImports();
    const renderChunk = hook<(code: string, chunk: unknown, options: { format: string }) => { code: string; map: unknown } | null>(plugin.renderChunk);
    // Rolldown has no renderDynamicImport hook: the rendered chunk's import() calls of a chunk of
    // this build (a relative "./datum-*.js" literal) are rewritten, and the function is appended.
    const code = `const a = () => import("./datum-builder-journey-designer-x.js");\nconst b = () => import('./datum-builder-pdf-y.js');\nconst c = (url) => import(url);\nconst d = import.meta.url;`;
    const out = renderChunk(code, {}, { format: "es" });
    expect(out?.code).toBe(
      `const a = () => ${RETRY_IMPORT}("./datum-builder-journey-designer-x.js");\nconst b = () => ${RETRY_IMPORT}('./datum-builder-pdf-y.js');\nconst c = (url) => import(url);\nconst d = import.meta.url;\n${RETRY_IMPORT_FUNCTION}`
    );
    expect(out?.map).toBeDefined();
    // A URL the code works out (an executor a page names) is left alone, so is the classic script.
    expect(renderChunk("const c = (url) => import(url); const m = 1;", {}, { format: "es" })).toBeNull();
    expect(renderChunk(code, {}, { format: "iife" })).toBeNull();
  });
});
