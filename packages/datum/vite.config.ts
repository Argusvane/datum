import { fileURLToPath } from "node:url";
import MagicString from "magic-string";
import { defineConfig, type Plugin } from "vite";
import { coreChunk, coreModules, libraryBuild } from "./scripts/vite-bundle.js";

/**
 * The builder's and the form's lazy chunks (webauthn, server validator, PDF service, journey
 * diagnostics, the journeys runtime `datum-form-journey-engine-chunk-*.js`) are loaded again after
 * a failed load. A browser
 * keeps a failed `import()` in the page's module map for the page's life: asked for the same URL
 * again, Chrome answers with the same failure at once and fetches nothing, so the builder's
 * retrying loaders (`loadJourneyDesigner`, the designer's `retryingLoad`, `loadJourneyDiagnostics`)
 * retried a failure until the page was reloaded. In the module build each `import()` of a chunk
 * goes through one small function the chunk carries instead: the first load is the import it
 * always was, of the same URL; after n failed loads of a chunk it asks for `<chunk>?retry=<n>`,
 * which the module map has never seen. The classic script has no chunks. A chunk's own static
 * imports cannot be asked for again this way, which is why the chunks the designer loads import
 * nothing of the designer's chunk (it lends them what they read; `check-bundles` holds both).
 *
 * Rolldown (Vite 8) has no `renderDynamicImport` hook, so the rewrite happens on the rendered
 * chunk: every `import()` of a string literal naming a chunk of this build (a relative
 * "./datum-*.js" specifier) goes through the function; an `import()` of a computed URL (an
 * executor a page names) is left as it is. The function is appended, so every line of the
 * chunk keeps its place; MagicString hands the pass's own map back for the chunk's chain.
 */
export const RETRY_IMPORT = "__datumImportChunk";
export const RETRY_IMPORT_FUNCTION = `
var __datumChunkFailures;
function ${RETRY_IMPORT}(url) {
  var failures = __datumChunkFailures || (__datumChunkFailures = new Map());
  var tries = failures.get(url) || 0;
  return import(tries > 0 ? url + "?retry=" + tries : url).catch(function (error) {
    if ((failures.get(url) || 0) === tries) failures.set(url, tries + 1);
    throw error;
  });
}
`;
export function retryableChunkImports(): Plugin {
  return {
    name: "datum:retryable-chunk-imports",
    apply: "build",
    // Minified by the pass after this one; a function declaration is hoisted.
    renderChunk(code, _chunk, options) {
      if (options.format !== "es") {
        return null;
      }
      const chunkImport = /\bimport\(\s*(["'`])(\.\/[^"'`]+)\1\s*\)/g;
      const text = new MagicString(code);
      let rewritten = false;
      for (let match = chunkImport.exec(code); match !== null; match = chunkImport.exec(code)) {
        text.overwrite(match.index, match.index + match[0].length, `${RETRY_IMPORT}(${match[1]}${match[2]}${match[1]})`);
        rewritten = true;
      }
      if (!rewritten) {
        return null;
      }
      text.append(`\n${RETRY_IMPORT_FUNCTION}`);
      return { code: text.toString(), map: text.generateMap({ hires: true }) };
    }
  };
}

/**
 * Two bundles from one package, one `vite build --mode <entry>` each. Vite's library mode
 * cannot emit an IIFE from several entries at once, and the classic-`<script>` build is the
 * whole point for a page that does not use modules, so the entry is chosen per run instead.
 *
 * Nothing is externalised: a page loads one file and gets the engine and its own catalogue
 * inside it. What a page wants beyond that is a bundle of its own it loads beside the first,
 * each registering into the page's shared registries on load: a design-system binding's or a
 * plugin package's, each built in its own package with the settings below. The
 * QuickJS WASM sandbox is deliberately not part of these bundles: field-constraint
 * validation runs in-process regardless, and the sandbox is a module of its own that
 * `<datum-form wasm>` fetches. `scripts/build-bundles.mjs` runs one build per entry.
 */
const ENTRIES = {
  form: { entry: "src/form.ts", name: "DatumForm", base: "datum-form", formats: ["es", "iife"] },
  builder: { entry: "src/builder.ts", name: "DatumBuilder", base: "datum-builder", formats: ["es", "iife"] },
  // The PDF kernel and its fonts: a module only, loaded on demand by the elements'
  // `pdf` attribute, never inside the classic scripts — the same line the sandbox draws.
  pdf: { entry: "src/pdf.ts", name: "DatumPdf", base: "datum-pdf", formats: ["es"] },
  // Page imagery for the designer's template areas: pdf.js as a module only,
  // loaded on demand by the builder's `pdf` / `pdf-pages` attributes, never by the renderer.
  // pdf.js is written for current browsers (class fields, static blocks), so this one is
  // left at es2022 rather than lowered.
  "pdf-pages": { entry: "src/pdf-pages.ts", name: "DatumPdfPages", base: "datum-pdf-pages", formats: ["es"], target: "es2022" },
  // The QuickJS/WASM validation sandbox: a module only, loaded on demand by the
  // form's `wasm` attribute; the binary is embedded, so it is one file.
  wasm: { entry: "src/wasm.ts", name: "DatumWasm", base: "datum-wasm", formats: ["es"] },
  // The runtime with no element (src/engine.ts): a module only, one file with no chunks, which
  // Node and a worker import with no DOM. Its own build, so the other bundles are not touched.
  engine: { entry: "src/engine.ts", name: "DatumEngine", base: "datum-engine", formats: ["es"] },
  // The WebAuthn functions with no element (src/webauthn.ts): a module only, one file with no
  // chunks, for a host's own code in a page, a worker or Node. The page-side lazy chunks
  // (`datum-form-webauthn-*.js`) are the form and builder bundles' own and are not this file.
  webauthn: { entry: "src/webauthn.ts", name: "DatumWebAuthn", base: "datum-webauthn", formats: ["es"] }
} satisfies Record<string, { entry: string; name: string; base: string; formats: readonly ("es" | "iife")[]; target?: string }>;

type EntryMode = keyof typeof ENTRIES;

// The modules a page has on load, for the module build's core chunk: scripts/vite-bundle.ts (coreModules).

/**
 * The entry's static closure: the modules a page has as soon as the bundle has loaded. Read once
 * the module graph is complete, for the `core` chunk group below (Rolldown asks a group's `test`
 * while it lays out chunks, after the build phase). The bundler's own runtime helpers count too.
 */
function entryClosure(): { plugin: Plugin; has: (id: string) => boolean } {
  const parsed = new Map<string, { isEntry: boolean; importedIds: readonly string[] }>();
  const closure = new Set<string>();
  const plugin: Plugin = {
    name: "datum:entry-closure",
    apply: "build",
    moduleParsed(info) {
      parsed.set(info.id, { isEntry: info.isEntry, importedIds: info.importedIds });
    },
    buildEnd() {
      const queue = [...parsed].filter(([, info]) => info.isEntry).map(([id]) => id);
      for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
        if (closure.has(id)) continue;
        closure.add(id);
        queue.push(...(parsed.get(id)?.importedIds ?? []));
      }
    }
  };
  return { plugin, has: (id) => closure.has(id) || id.includes("rolldown:runtime") };
}

function isEntryMode(mode: string): mode is EntryMode {
  return Object.prototype.hasOwnProperty.call(ENTRIES, mode);
}

export default defineConfig(({ command, mode }) => {
  // A build config only: tooling that loads it to run a script (vite-node, for the sandbox
  // program) gets nothing to configure.
  if (command !== "build") {
    return {};
  }
  if (!isEntryMode(mode)) {
    throw new Error(`Unknown build mode "${mode}": use --mode ${Object.keys(ENTRIES).join(", --mode ")}`);
  }
  const target = ENTRIES[mode];
  const ecmaTarget = "target" in target ? target.target : "es2020";
  // One format per build (scripts/build-bundles.mjs): the module build's chunk settings below
  // are not options a classic script can take, and Rolldown refuses the combination.
  const wanted = process.env["DATUM_BUNDLE_FORMAT"];
  const formats = wanted === undefined ? [...target.formats] : target.formats.filter((format) => format === wanted);
  if (formats.length === 0) {
    throw new Error(`Entry "${mode}" has no "${wanted}" build: its formats are ${target.formats.join(", ")}`);
  }
  const moduleBuild = formats.length === 1 && formats[0] === "es";
  const core = coreModules();
  // The settings every bundle shares, a plugin package's included: scripts/vite-bundle.ts.
  return libraryBuild({
    entry: fileURLToPath(new URL(target.entry, import.meta.url)),
    name: target.name,
    base: target.base,
    formats,
    target: ecmaTarget,
    outDir: "dist",
    plugins: mode === "builder" || mode === "form" ? [retryableChunkImports()] : [],
    // The sandbox module is one file: the QuickJS host reaches its binary through a
    // dynamic import, which would otherwise become chunks of its own beside it. Elsewhere the
    // module build gets one `core` chunk beside the entry (scripts/vite-bundle.ts, coreChunk).
    // The engine and WebAuthn modules are one file too: a server or a worker copies it alone.
    ...(mode === "wasm" || mode === "engine" || mode === "webauthn" ? { codeSplitting: false as const } : moduleBuild ? { codeSplitting: coreChunk(core) } : {})
  });
});
