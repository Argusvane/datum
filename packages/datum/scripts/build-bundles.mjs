// Builds every bundle: one `vite build --mode <entry>` per entry and format, since Vite's library
// mode emits one classic script per build and the module build's chunk settings are not options a
// classic script takes (see vite.config.ts). The first build empties dist. A plugin
// package's bundle is built in its own package (scripts/plugin-build.mjs), never here.
//
// The module build of an entry with lazy chunks runs twice. Rolldown gives every module the entry
// and a lazy chunk share a common chunk of its own, so the first build (to a scratch folder) only
// says which modules the entry chunk and the chunks it imports statically are made of: what a page
// has as soon as the bundle has loaded. The second build gathers the shared ones among those into
// the one `core` chunk beside the entry (vite.config.ts, coreModules).
//
// Every build here writes source maps: the checks that follow read them. They are removed from the
// finished folder by scripts/strip-source-maps.mjs, the step after check-bundles, unless the build
// runs with DATUM_SOURCE_MAPS=1.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MODES = ["form", "builder", "pdf", "pdf-pages", "wasm", "engine", "webauthn"];
/** The entries that are a module only (vite.config.ts ENTRIES: no classic script). */
const MODULE_ONLY = new Set(["pdf", "pdf-pages", "wasm", "engine", "webauthn"]);
/** The entries with lazy chunks, whose module build gets a core chunk (vite.config.ts ENTRIES base names). */
const CHUNKED = { form: "datum-form", builder: "datum-builder" };
const vite = join(root, "node_modules", "vite", "bin", "vite.js");

function build(mode, format, extra, env) {
  execFileSync(process.execPath, [vite, "build", "--mode", mode, ...extra], { cwd: root, stdio: "inherit", env: { ...process.env, DATUM_BUNDLE_FORMAT: format, ...env } });
}

/** The modules of `dist/<base>.js` and of every chunk it imports statically, by their source maps. */
function loadedOnLoad(dist, base) {
  const modules = new Set();
  const seen = new Set();
  const queue = [`${base}.js`];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(join(dist, file), "utf8");
    for (const match of code.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) queue.push(match[1]);
    // The bundler's own helper chunk has no map; its module is named in vite.config.ts.
    if (!existsSync(join(dist, `${file}.map`))) continue;
    const map = JSON.parse(readFileSync(join(dist, `${file}.map`), "utf8"));
    for (const source of map.sources) modules.add(resolve(dist, source));
  }
  return [...modules].sort();
}

let first = true;
for (const mode of MODES) {
  for (const format of MODULE_ONLY.has(mode) ? ["es"] : ["es", "iife"]) {
    const env = {};
    if (format === "es" && mode in CHUNKED) {
      const probe = mkdtempSync(join(tmpdir(), `datum-${mode}-probe-`));
      console.log(`build-bundles: ${mode} (${format}, first pass)`);
      build(mode, format, ["--outDir", probe, "--emptyOutDir"], {});
      const list = join(probe, "core-modules.json");
      writeFileSync(list, JSON.stringify(loadedOnLoad(probe, CHUNKED[mode])));
      env.DATUM_CORE_MODULES = list;
      process.on("exit", () => rmSync(probe, { recursive: true, force: true }));
    }
    console.log(`build-bundles: ${mode} (${format})`);
    build(mode, format, first ? ["--emptyOutDir"] : [], env);
    first = false;
  }
}
