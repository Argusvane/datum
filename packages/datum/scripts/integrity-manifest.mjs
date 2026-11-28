// Writes `dist/integrity.json`: the Subresource Integrity (sha384) of every file a page may load from
// the package, so a page that serves the files from a CDN can pin each one. The npm tarball and the
// release's bundles archive carry it; the docs (site/docs/files.md) show how a page uses it:
// `<script integrity crossorigin>` and `<link integrity crossorigin>` for the bundles and the
// stylesheet, an import map's `integrity` for the chunks the bundles import, and `wasm-integrity` for
// the sandbox module.
//
//   { "algorithm": "sha384", "files": { "datum-form.js": "sha384-...", "fonts/...": "sha384-..." } }
//
// Paths are relative to dist, with `/`, sorted. Source maps, the type declarations (dist/types) and the
// manifest itself are left out: no page loads them. It is the last step of the build, and
// release-assets.mjs writes it again after it strips the source-map comments, so the hashes are of
// the bytes that ship.
//
//   node scripts/integrity-manifest.mjs            writes dist/integrity.json
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST = "integrity.json";

/** Whether a page could load `path` (relative to dist, with `/`). */
function shipped(path) {
  return path !== MANIFEST && !path.endsWith(".map") && !path.endsWith(".d.ts") && !path.startsWith("types/");
}

function filesOf(dist, folder = dist) {
  const out = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = join(folder, entry.name);
    if (entry.isDirectory()) {
      out.push(...filesOf(dist, full));
    } else if (entry.isFile() || statSync(full).isFile()) {
      out.push(relative(dist, full).split(sep).join("/"));
    }
  }
  return out;
}

/** The sha384 Subresource Integrity of `bytes`: what `integrity="..."` takes. */
export function sri(bytes) {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

/** The manifest of `dist`, as an object. */
export function integrityManifest(dist) {
  const files = {};
  for (const path of filesOf(dist).filter(shipped).sort()) {
    files[path] = sri(readFileSync(join(dist, path)));
  }
  return { algorithm: "sha384", files };
}

/** Writes `dist/integrity.json` and returns how many files it lists. */
export function writeIntegrityManifest(dist) {
  const manifest = integrityManifest(dist);
  writeFileSync(join(dist, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.keys(manifest.files).length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");
  console.log(`integrity-manifest: ${writeIntegrityManifest(dist)} files in dist/${MANIFEST}`);
}
