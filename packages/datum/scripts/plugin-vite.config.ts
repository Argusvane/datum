import { defineConfig } from "vite";

import { coreChunk, coreModules, libraryBuild } from "./vite-bundle.js";

/**
 * The Vite config of a plugin package's bundle (plugins/<package>), run by scripts/plugin-build.mjs
 * from the package folder, one build per format: the settings this package builds its own bundles
 * with (scripts/vite-bundle.ts), at es2020, nothing externalised. plugin-build.mjs says what to
 * build through the environment: the entry (an absolute path), the global, the file stem, the
 * output folder and the one format.
 */
export default defineConfig(({ command }) => {
  if (command !== "build") {
    return {};
  }
  const env = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`scripts/plugin-vite.config.ts: ${name} is not set (run scripts/plugin-build.mjs)`);
    return value;
  };
  const format = env("DATUM_BUNDLE_FORMAT");
  if (format !== "es" && format !== "iife") {
    throw new Error(`scripts/plugin-vite.config.ts: DATUM_BUNDLE_FORMAT is "${format}", not es or iife`);
  }
  return libraryBuild({
    entry: env("DATUM_PLUGIN_ENTRY"),
    name: env("DATUM_PLUGIN_GLOBAL"),
    base: env("DATUM_PLUGIN_BUNDLE"),
    formats: [format],
    target: "es2020",
    outDir: env("DATUM_PLUGIN_OUT_DIR"),
    // An icon set's licence asks for its notice to travel with the code: the banner stays in the bundle as well as beside it.
    keepLegalComments: true,
    // A module build lays its chunks out as this package's own bundles do (scripts/vite-bundle.ts).
    ...(format === "es" ? { codeSplitting: coreChunk(coreModules()) } : {})
  });
});
