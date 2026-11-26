import { readFileSync } from "node:fs";

import { transform } from "esbuild";
import type { Plugin, UserConfig } from "vite";

import { stripCssLiteralsPlugin } from "./strip-css-literals.js";

/**
 * The Vite settings every bundle of this repository is built with: the package's own bundles
 * (vite.config.ts) and a plugin package's bundle built by scripts/plugin-build.mjs. One
 * place, so a plugin bundle a package builds on its own is made exactly as the one this
 * package builds.
 */

/**
 * Vite leaves whitespace in a library's ES output (to keep pure annotations for a consumer's
 * own bundler). These bundles are loaded straight from a CDN or a static folder, where every
 * byte is downloaded as-is, so the module build is minified fully, like the classic script.
 *
 * The pass runs last (`order: "post"`). Vite's own esbuild pass (`vite:esbuild-transpile`) is
 * one of the build's final plugins, after every plugin of the config, `enforce: "post"` ones
 * included, and for a library's ES output it minifies names and syntax but prints the result
 * with whitespace (`minifyWhitespace: false`), so a pass ahead of it was undone and
 * `datum-form.js` shipped as indented code, about a sixth of it whitespace. The pass hands its
 * source map back to Rollup, which composes it with the chunk's own, so the shipped map still
 * leads to every module's source.
 */
export function minifyEsOutput(target: string, keepLegalComments = false): Plugin {
  return {
    name: "datum:minify-es-output",
    apply: "build",
    renderChunk: {
      order: "post",
      async handler(code, _chunk, options) {
        if (options.format !== "es") {
          return null;
        }
        // charset utf8, as Vite's own pass prints: esbuild's default escapes every non-ASCII
        // character, which bloats the text a bundle carries (the sandbox's most of all).
        const result = await transform(code, { minify: true, format: "esm", target, legalComments: keepLegalComments ? "inline" : "none", sourcemap: true, charset: "utf8" });
        return { code: result.code, map: result.map };
      }
    }
  };
}

/**
 * The legal comments of the third-party code a bundle carries (the `@license` and `/*!` headers
 * of lit-html, pdf.js and the like) are kept beside the bundle, never inside it: the bundle is
 * measured and downloaded as-is, and a licence header repeated in every chunk is bytes no page
 * runs. Rolldown strips legal comments from a minified build, so the output option below turns them
 * back on for this pass; the pass reads each rendered chunk before the minifiers (they drop every
 * legal comment) and collects what it finds. At the end of the build the collected text is written
 * as `<base>.legal-comments.<format>.txt`, which scripts/bundle-notices.mjs folds into
 * `<base>.LICENSE.txt` together with the licence text of every package the bundle carries.
 * esbuild's own `external` mode does the extraction, so a comment is recognised exactly as
 * esbuild's minifier would have recognised it.
 */
export function legalCommentsSidecar(base: string): Plugin {
  const found = new Set<string>();
  return {
    name: "datum:legal-comments-sidecar",
    apply: "build",
    async renderChunk(code) {
      const result = await transform(code, { loader: "js", legalComments: "external", charset: "utf8" });
      for (const comment of (result.legalComments ?? "").split(/\n(?=\/[*/])/)) {
        // The same header indented by another module's depth is the same comment.
        const text = comment
          .trim()
          .split("\n")
          .map((line, index) => (index > 0 && line.trim().startsWith("*") ? ` ${line.trim()}` : line.trim()))
          .join("\n");
        if (text !== "") found.add(text);
      }
      return null;
    },
    generateBundle(output) {
      this.emitFile({ type: "asset", fileName: `${base}.legal-comments.${output.format}.txt`, source: `${[...found].join("\n\n")}\n` });
    }
  };
}

/**
 * The engine, the packages and this repository's own sources register nothing by being
 * imported: a module of theirs whose bindings nothing reads can go. Rolldown, unlike Rollup,
 * reads no purity into top-level `new Map(...)`, `Object.freeze(...)` and the like, and without
 * this it kept whole unused modules (a plugin bundle grew by half). Third-party code keeps the
 * default: a library may well register on import.
 */
export const moduleSideEffects = (id: string): boolean => id.includes("/node_modules/");

/**
 * The modules a page has as soon as the bundle has loaded, for the `core` chunk group of a
 * module build (`coreChunk` below): what the entry chunk and the chunks it imports statically
 * are made of, read from the source maps of a first build of the same entry
 * (scripts/build-bundles.mjs runs it and passes the list in DATUM_CORE_MODULES). A list from the
 * module graph will not do: it names modules the build then shakes out of the entry, and a group
 * over those pulls them in again. The bundler's own runtime helpers count too. Without the list
 * (a bundle with no lazy chunks, a plugin's) only the runtime helpers are named.
 */
export function coreModules(): (id: string) => boolean {
  const listed = process.env["DATUM_CORE_MODULES"];
  const ids = new Set<string>(listed === undefined ? [] : (JSON.parse(readFileSync(listed, "utf8")) as string[]));
  return (id) => ids.has(id) || id.includes("rolldown:runtime");
}

type RolldownOutput = Exclude<NonNullable<NonNullable<NonNullable<UserConfig["build"]>["rolldownOptions"]>["output"]>, readonly unknown[]>;

/**
 * A module build's chunk layout: one `core` chunk beside the entry. Rollup kept every module the
 * entry and a lazy chunk share inside the entry, since the entry is loaded first; Rolldown gives
 * each such sharing set a common chunk of its own (fifty-odd files the entry imported on load) and
 * its merge pass does not fold them back into an entry with lazy chunks. Its inlining mode would,
 * but only with `preserveEntrySignatures: false`, which drops the named exports. So the modules
 * the entry has on load that a lazy chunk shares go to one chunk the entry imports statically: a
 * page loads the entry and `datum-<bundle>-core-<hash>.js`, and the lazy chunks stay lazy. What
 * only lazy chunks share keeps the bundler's own common chunks. check-bundles and feature-files
 * treat the entry and its core chunk as one. The list comes from a first build (coreModules).
 */
export function coreChunk(core: (id: string) => boolean): RolldownOutput["codeSplitting"] {
  return { groups: [{ name: "core", test: core, minShareCount: 2 }] };
}

export interface LibraryBuild {
  /** The entry module, an absolute path. */
  entry: string;
  /** The global a classic script is assigned to. */
  name: string;
  /** The file name without its extension: `<base>.js`, `<base>.iife.js`. */
  base: string;
  formats: ("es" | "iife")[];
  /** The ECMAScript level the bundle is lowered to. */
  target: string;
  outDir: string;
  /** Plugins that run between the CSS strip (first) and the ES minify pass (last). */
  plugins?: Plugin[];
  /** Rolldown's codeSplitting output option, when the bundle sets one. */
  codeSplitting?: RolldownOutput["codeSplitting"];
  /**
   * Keep the third-party legal comments inside the bundle as well as beside it. A bundle whose
   * licence asks for the notice to travel with the code (a plugin that draws an icon set) sets it;
   * the package bundles, which are measured against a size budget, leave it off.
   */
  keepLegalComments?: boolean;
}

/** The library build of one bundle in the formats asked for. */
export function libraryBuild(options: LibraryBuild): UserConfig {
  const keepLegal = options.keepLegalComments === true;
  return {
    // Vite's own esbuild pass drops legal comments unless told otherwise.
    ...(keepLegal ? { esbuild: { legalComments: "inline" as const } } : {}),
    // The CSS strip runs on every bundle: the engine CSS reaches the form, the builder, the PDF
    // designer and the component bundles (scripts/strip-css-literals.ts).
    plugins: [stripCssLiteralsPlugin(), ...(options.plugins ?? []), legalCommentsSidecar(options.base), minifyEsOutput(options.target, keepLegal)],
    build: {
      lib: {
        entry: options.entry,
        name: options.name,
        formats: options.formats,
        fileName: (format) => (format === "es" ? `${options.base}.js` : `${options.base}.iife.js`)
      },
      outDir: options.outDir,
      // The second build must not wipe the first; the build script passes --emptyOutDir once.
      emptyOutDir: false,
      // Always built with maps: the first pass of a chunked entry reads them to find its core
      // modules (coreModules) and check-bundles reads them to say which sources each file holds.
      // The finished folder ships none unless DATUM_SOURCE_MAPS=1 (scripts/strip-source-maps.mjs).
      sourcemap: true,
      target: options.target,
      minify: "esbuild",
      rolldownOptions: {
        // The lazy chunks import engine code from the bundle that loads them. With the default
        // "exports-only" signatures the bundler would keep the bundle's exports exact by moving
        // its body into a chunk and leaving a facade; letting the bundle gain extra exports
        // keeps its code where a page loads it (the named exports a page imports stay).
        preserveEntrySignatures: "allow-extension",
        treeshake: { moduleSideEffects },
        output: {
          // Vite switches legal comments off in a minified build; the sidecar plugin above reads
          // them from the chunk and the minifiers then remove them from the bundle.
          comments: { legal: true },
          // The lazy chunks — the PDF pipeline behind the renderer, the PDF executor
          // behind the builder — named after the bundle they belong to, so a page deploys
          // `datum-form-*.js` beside `datum-form.js` and the bundle check can tell them apart.
          chunkFileNames: `${options.base}-[name]-[hash].js`,
          ...(options.codeSplitting === undefined ? {} : { codeSplitting: options.codeSplitting })
        }
      }
    }
  };
}
