// Copies what the home page's live demo loads from the built bundles into public/demo/, where
// Vite serves it as-is under the site's base path: the engine's files from
// packages/datum/dist, and the Font Awesome plugin bundle from
// plugins/icons-fontawesome/dist. An allowlist, not the whole dist: the builder module (which defines both
// elements) with its lazy chunks (the PDF executor the designer's preview and test fill run,
// the pdf.js page imagery for template areas, the Journeys mode and the journey engine, with feature-files.json), its companion sheet, the renderer module (the demo form's browser-assistant tools, requested only where the browser has WebMCP) with its lazy chunks, the PDF module the form's
// Preview PDF loads beside it, the fonts that module embeds, the pdf.js data the page imagery
// reads, and the one opt-in bundle the demo adds: Font Awesome for the builder's chrome, loaded
// before the builder. The licence file of each bundle published here (<bundle>.LICENSE.txt, the third-party packages and licence
// texts it carries; the pdf.js data folder's LICENSE rides inside the pdfjs folder) and the Font Awesome plugin's licence files are copied beside the bundles they cover, and a
// missing one stops the copy. The binding pages' files (the design systems' own, the bindings' bundles) are
// copy-binding-assets.mjs's, in public/demo/bindings/, run after this one. Every lazy resource resolves against the
// module's own URL, so the folder works under any SITE_BASE. The target is gitignored.
//
//   node scripts/copy-demo-assets.mjs               fail when the bundles are missing
//   node scripts/copy-demo-assets.mjs --if-present  keep what is there and say so (npm run build)
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(site, "..");
const source = join(root, "packages", "datum", "dist");
const target = join(site, "public", "demo");
const ifPresent = process.argv.includes("--if-present");

/** The plugin bundles the demo adds, from plugins/<id>/dist: the Font Awesome icons. */
export const PLUGIN_PACKAGES = ["icons-fontawesome"];
const readPlugin = (id) => JSON.parse(readFileSync(join(root, "plugins", id, "package.json"), "utf8")).datumPlugin;

/** Engine files, copied by name from packages/datum/dist. */
export const FILES = ["datum-form.js", "datum-form.css", "datum-builder.js", "datum-builder.css", "datum-pdf.js", "datum-wasm.js", "feature-files.json"];
/**
 * The licence file of each bundle whose main file the demo publishes (FILES), copied by name from packages/datum/dist. The page
 * imagery module (datum-pdf-pages.js) is not published, so its licence file is not copied; the pdf.js data folder's own LICENSE
 * travels inside the pdfjs folder copy (FOLDERS).
 */
export const LICENCE_FILES = ["datum-form", "datum-builder", "datum-pdf", "datum-wasm"].map((bundle) => `${bundle}.LICENSE.txt`);
/** Engine folders copied whole. */
export const FOLDERS = ["fonts", "pdfjs", "builder-fonts"];
/**
 * The builder module's and the renderer module's lazy chunks (hashed names): the PDF executor,
 * the page imagery, the small browser stubs, and the form's agent chunk with the chunks it
 * imports (the demo form's browser-assistant tools). Not the IIFE builds, the maps, the server
 * programs or the sandbox.
 */
export function isChunk(name) {
  return /^datum-(builder|form|pdf)-[\w-]+\.js$/.test(name) && !name.endsWith(".iife.js") && !name.endsWith("-program.js") && name !== "datum-pdf-pages.js";
}

const hint = "build them with `npm run build` in packages/datum (or `npm run datum:build` at the root)";

if (!existsSync(join(source, "datum-builder.js"))) {
  if (ifPresent) {
    const kept = existsSync(join(target, "datum-builder.js")) ? "keeping the copy already in public/demo/" : "the demo section will show its fallback";
    console.log(`copy-demo-assets: no bundles at ${source}; ${kept}. To ship the live demo, ${hint}.`);
    process.exit(0);
  }
  console.error(`copy-demo-assets: no bundles at ${source}; ${hint}.`);
  process.exit(1);
}

const missing = [...FILES, ...LICENCE_FILES, ...FOLDERS].filter((name) => !existsSync(join(source, name)));
const chunks = readdirSync(source).filter(isChunk);
for (const part of ["datum-builder-pdf-", "datum-form-agent-"]) {
  if (!chunks.some((name) => name.startsWith(part))) missing.push(`${part}*.js`);
}
// The demo's builder opens Journeys and PDF on demand: their lazy chunks and the
// journey engine chunk must ride along, or those modes would show the error card with Retry.
for (const part of ["datum-builder-journey-builder-mode-", "datum-builder-journey-engine-chunk-"]) {
  if (!chunks.some((name) => name.startsWith(part))) missing.push(`${part}*.js`);
}
if (missing.length > 0) {
  console.error(`copy-demo-assets: ${source} is missing ${missing.join(", ")} (a partial build?); ${hint}.`);
  process.exit(1);
}

// Plugins come from their own packages' dist, built there. This script builds nothing.
// A package that is not built stops the copy: under --if-present what is in public/demo/ stays as it is.
const unbuilt = (what, fix) => {
  if (ifPresent) {
    const kept = existsSync(join(target, "datum-builder.js")) ? "keeping the copy already in public/demo/" : "the demo section will show its fallback";
    console.log(`copy-demo-assets: ${what}; ${kept}. To ship the live demo, ${fix}.`);
    process.exit(0);
  }
  console.error(`copy-demo-assets: ${what}; ${fix}.`);
  process.exit(1);
};
const sources = [];
for (const id of PLUGIN_PACKAGES) {
  const name = `${readPlugin(id).bundle}.js`;
  const dist = join(root, "plugins", id, "dist");
  if (!existsSync(join(dist, name))) unbuilt(`plugins/${id} has no ${name} in ${dist}`, `run \`npm run build\` in plugins/${id}`);
  sources.push({ from: join(dist, name), name, label: `plugins/${id}/dist/${name}` });
  // The plugin's own licence file and the licence texts of the packages it carries (LICENSE.<package>.txt).
  const licences = [`${readPlugin(id).bundle}.LICENSE.txt`, ...readdirSync(dist).filter((file) => /^LICENSE\..+\.txt$/.test(file))];
  for (const licence of licences) {
    if (!existsSync(join(dist, licence))) unbuilt(`plugins/${id} has no ${licence} in ${dist}`, `run \`npm run build\` in plugins/${id}`);
    sources.push({ from: join(dist, licence), name: licence, label: `plugins/${id}/dist/${licence}` });
  }
}

// Everything but bindings/, which copy-binding-assets.mjs owns and fills after this script.
mkdirSync(target, { recursive: true });
for (const name of readdirSync(target)) if (name !== "bindings") rmSync(join(target, name), { recursive: true, force: true });
for (const name of [...FILES, ...LICENCE_FILES, ...chunks]) {
  copyFileSync(join(source, name), join(target, name));
  console.log(`copy-demo-assets: public/demo/${name}`);
}
for (const name of FOLDERS) {
  cpSync(join(source, name), join(target, name), { recursive: true });
  console.log(`copy-demo-assets: public/demo/${name}/`);
}
for (const { from, name, label } of sources) {
  cpSync(from, join(target, name), { recursive: true });
  console.log(`copy-demo-assets: public/demo/${name}${statSync(from).isDirectory() ? "/" : ""}  (${label})`);
}
