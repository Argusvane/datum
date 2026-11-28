// Writes `integrity.json` at the package root, beside `dist`: the Subresource Integrity (sha384) of
// every file in `dist` a page may load, so a page that serves the files from a CDN can pin each one.
// The npm tarball carries it (package.json "files") and each release attaches it as
// `datum-integrity-<version>.json`; the docs (site/docs/files.md) show how a page uses it:
// `<script integrity crossorigin>` and `<link integrity crossorigin>` for the bundles and the
// stylesheet, an import map's `integrity` for the chunks the bundles import, `wasm-integrity`,
// `pdf-integrity` and `pdf-pages-integrity` for the modules the elements import themselves, and
// `pdf-manifest-integrity` for this file, whose entries the elements then hold the PDF fonts and the
// pdf.js files to. It sits outside `dist` because the hosts copy `dist` file by file into their
// own distributions, and this file describes the folder rather than belonging to it.
//
//   { "algorithm": "sha384", "files": { "datum-form.js": "sha384-...", "fonts/...": "sha384-..." } }
//
// Paths are relative to dist, with `/`, sorted. Source maps and the type declarations (dist/types)
// are left out: no page loads them. It is the last step of the build, and release-assets.mjs writes
// it again after it strips the source-map comments, so the hashes are of the bytes that ship.
//
//   node scripts/integrity-manifest.mjs            writes integrity.json
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST = "integrity.json";

/** Whether a page could load `path` (relative to dist, with `/`). */
function shipped(path) {
  return !path.endsWith(".map") && !path.endsWith(".d.ts") && !path.startsWith("types/");
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

/** Writes the manifest of `dist` to `out` (default `integrity.json` beside `dist`) and returns how many files it lists. */
export function writeIntegrityManifest(dist, out = join(dist, "..", MANIFEST)) {
  const manifest = integrityManifest(dist);
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.keys(manifest.files).length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");
  console.log(`integrity-manifest: ${writeIntegrityManifest(dist)} files of dist in ${MANIFEST}`);
}
