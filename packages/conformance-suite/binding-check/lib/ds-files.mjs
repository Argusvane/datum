// Where a design system's own files come from when the tester serves a binding's assets: the
// binding's package folder, which holds its own node_modules and stands in for the host's CDN.
// A binding pins its design system by npm alias carrying the release
// (`"govuk-frontend-6.6.0": "npm:govuk-frontend@6.6.0"`), so the files sit at
// node_modules/govuk-frontend-6.6.0/. An assets file addresses a design system the way a host's CDN
// does, by the package's own name (`/node_modules/govuk-frontend/dist/...`, or with the release in
// the segment, `/node_modules/@abgov/web-components@3.2.0/index.css`); this module finds the file
// for either spelling (through the pinned alias, and only the alias of that release when the address
// carries one) and for the alias path itself.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

export const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".webp": "image/webp"
};

/** The first root holding `pathname` as a file, as an absolute path; undefined when none does. */
export function resolveFile(roots, pathname) {
  for (const base of roots) {
    const file = normalize(join(base, pathname));
    if (file.startsWith(base + sep) && existsSync(file) && statSync(file).isFile()) return file;
  }
  return undefined;
}

/** Every `<bindingsDir>/<id>` folder that holds a package.json, as an absolute path. */
export function bindingRoots(bindingsDir) {
  if (!existsSync(bindingsDir)) return [];
  return readdirSync(bindingsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(bindingsDir, entry.name, "package.json")))
    .map((entry) => join(bindingsDir, entry.name))
    .sort();
}

const aliasCache = new Map();

/** The npm aliases a package pins: `{ "@abgov/web-components": [{ alias: "abgov-web-components-3.2.0", version: "3.2.0" }], ... }`. */
function aliasesOf(root) {
  if (aliasCache.has(root)) return aliasCache.get(root);
  const out = {};
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const [alias, spec] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (typeof spec !== "string" || !spec.startsWith("npm:")) continue;
      const at = spec.lastIndexOf("@");
      if (at <= 4) continue;
      (out[spec.slice(4, at)] ??= []).push({ alias, version: spec.slice(at + 1) });
    }
  } catch {
    // no package.json: no aliases
  }
  aliasCache.set(root, out);
  return out;
}

/**
 * The package a `/node_modules/...` path names: `{ pkg, version, rest }`, `version` being the release in
 * the package segment (`@3.2.0`) or undefined. Undefined for a path outside /node_modules/.
 */
function packageOf(pathname) {
  const match = /^\/node_modules\/((?:@[^/@]+\/)?[^/@]+)(?:@(\d+\.\d+\.\d+[^/]*))?(\/.*)?$/.exec(pathname);
  return match ? { pkg: match[1], version: match[2], rest: match[3] ?? "/" } : undefined;
}

/**
 * The first root holding `pathname`. A path that names a package by its own name goes through the alias a
 * root pins it under, first: with a release in the segment (`/node_modules/@abgov/web-components@3.2.0/...`),
 * only an alias pinning exactly that release answers, so a path never gets another release's file; without
 * one, the pinned alias answers before any unaliased copy (a transitive dependency's) the root also holds.
 * Every other path (an alias path itself, a page, a vendored file) is served as written. Undefined when none does.
 */
export function resolveDsFile(roots, pathname) {
  const named = packageOf(pathname);
  if (named) {
    for (const root of roots) {
      for (const { alias, version } of aliasesOf(root)[named.pkg] ?? []) {
        if (named.version !== undefined && version !== named.version) continue;
        const file = resolveFile([root], `/node_modules/${alias}${named.rest}`);
        if (file) return file;
      }
    }
    if (named.version !== undefined) return undefined;
  }
  return resolveFile(roots, pathname);
}
