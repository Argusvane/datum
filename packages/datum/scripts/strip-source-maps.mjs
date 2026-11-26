// Takes the source maps out of a finished bundle folder, unless the build was asked to keep them
// (DATUM_SOURCE_MAPS=1). Every bundle is built with maps, since check-bundles and the guards under
// scripts/guards/ read them to say which sources each file holds; this step runs right after those
// checks (and before feature-files.mjs measures the files, so feature-files.json counts the
// bytes that ship). The folder is what a page copies to a static server: its maps were about
// three quarters of it, and a page that never opens developer tools downloads none of them.
//
// Two things go, together: every `<file>.map`, and the `//# sourceMappingURL=<file>.map` line the
// bundler ends each script with. A comment left behind would point developer tools at a map that
// is gone and log a 404 for every script. File names stay as built: a chunk's hash comes from its
// code at the time it was built, and nothing that loads a chunk (the `import()` strings, the
// feature manifest) knows another name, so a rename would break them for no gain.
//
//   npm run datum:build                         no maps in packages/datum/dist
//   DATUM_SOURCE_MAPS=1 npm run datum:build     maps kept, comments intact
//
// Run directly (node scripts/strip-source-maps.mjs [<dist>]) it works on packages/datum/dist.
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The name of the switch that keeps the maps in a finished build. */
export const SOURCE_MAPS_SWITCH = "DATUM_SOURCE_MAPS";

/** True when the build is asked to keep its source maps (`DATUM_SOURCE_MAPS=1`; "true" works too). */
export function keepsSourceMaps(env = process.env) {
  const value = (env[SOURCE_MAPS_SWITCH] ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

/** The trailing mapping comment of a script, with the blank lines before it. */
const MAPPING_COMMENT = /\s*\/\/# sourceMappingURL=[^\s]+\.map\s*$/;

/**
 * Removes the maps and the mapping comments from the scripts beside them in `dist` (the bundler
 * writes both flat: no sub-folder holds a map of the build's own). Returns how many of each.
 */
export function stripSourceMaps(dist) {
  let maps = 0;
  let scripts = 0;
  for (const name of readdirSync(dist)) {
    const file = join(dist, name);
    if (name.endsWith(".map")) {
      rmSync(file);
      maps += 1;
    } else if (name.endsWith(".js") || name.endsWith(".css")) {
      const text = readFileSync(file, "utf8");
      const stripped = text.replace(MAPPING_COMMENT, "\n");
      if (stripped !== text) {
        writeFileSync(file, stripped);
        scripts += 1;
      }
    }
  }
  return { maps, scripts };
}

/** What a build step logs for `dist`: strips unless the switch keeps the maps. */
export function stripUnlessKept(dist, label = "strip-source-maps", env = process.env) {
  if (keepsSourceMaps(env)) {
    console.log(`${label}: ${SOURCE_MAPS_SWITCH}=1, source maps kept in ${dist}`);
    return;
  }
  const { maps, scripts } = stripSourceMaps(dist);
  console.log(`${label}: ${maps} source maps and ${scripts} mapping comments removed from ${dist} (${SOURCE_MAPS_SWITCH}=1 keeps them)`);
}

function main() {
  const dist = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
  if (!existsSync(dist)) {
    console.error(`strip-source-maps: ${dist} is missing: run npm run datum:build`);
    process.exit(2);
  }
  stripUnlessKept(dist);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
