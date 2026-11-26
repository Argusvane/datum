// The offline pack of a design-system binding: the binding's bundle and the design system's own files,
// with nothing in them that asks another host for anything.
//
//   <out>/manifest.json                 per binding: its bundles, stylesheets and scripts (addresses relative
//                                       to the manifest, each with its integrity), what was answered locally
//                                       and what was taken out
//   <out>/<id>/<id>.js, <id>.iife.js    the binding's bundle from bindings/<id>/dist
//   <out>/<id>/files/…                  the design system's files, a NOTICE.txt beside each package
//
// The files are the ones the binding pages publish (site/scripts/binding-assets-spec.mjs: the pinned
// release, with a typeface a licence keeps for the authority's own services and a government's marks left
// out), copied by the same code. On top of that copy, every stylesheet is read for references to another
// host (lib/css.mjs). The binding's own binding-check.json already says what answers each one in the test
// kit: a `routes` entry names the pinned package that holds the file, so here the file is copied into the
// pack and the reference rewritten to it. A reference no route answers cannot be served from the pack (a
// `network` entry gives the reason: the design system publishes the file only on a CDN); it is taken out,
// so the browser asks for nothing, and the manifest lists it under `dropped`.
//
// Scripts are not rewritten: what a script asks for when it runs is found by drawing the pack in a browser
// that can reach nothing else (scripts/offline/check.mjs).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readRouting } from "../../../packages/conformance-suite/binding-check/lib/routes.mjs";
import { resolveDsFile } from "../../../packages/conformance-suite/binding-check/lib/ds-files.mjs";
import { BINDING_ASSETS, REFERENCE_BINDINGS } from "../../../site/scripts/binding-assets-spec.mjs";
import { copyBindingFiles, missingVendor, placeCheckFiles, published, walk } from "../../../site/scripts/binding-files.mjs";
import { scanPublished } from "../../../site/scripts/published-scan.mjs";
import { localizeCss, relocateCss } from "./css.mjs";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export { REFERENCE_BINDINGS };

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const toPosix = (path) => path.split(sep).join("/");
const LICENCE_FILE = /^(?:LICEN[CS]E|COPYING|OFL|copyright)(?:[.-][\w.-]*)?$/i;

/** The `integrity` value of a file: sha384, as a page gives it on a stylesheet or script. */
export const integrityOf = (file) => `sha384-${createHash("sha384").update(readFileSync(file)).digest("base64")}`;

/** The relative address of `to` as written in a stylesheet at `from` (both below the files folder). */
const relativeUrl = (from, to) => {
  const path = posix.relative(posix.dirname(from), to);
  return path.startsWith(".") ? path : `./${path}`;
};

/**
 * Builds the pack of one binding into `<out>/<id>/` and returns its manifest entry. `bindingsDir` is the
 * folder that holds `<id>/` (the repository's bindings/), `spec` the binding's entry of the assets spec.
 * Throws an Error that says what to do when the binding is not installed or built, when a route names a
 * file its pinned package does not hold, or when the copy would hold what is never published.
 */
export function buildBindingPack({ id, out, bindingsDir = join(REPO, "bindings"), spec = BINDING_ASSETS[id] }) {
  const dir = join(bindingsDir, id);
  const fix = `run \`npm install\` and \`npm run build\` in bindings/${id}`;
  if (spec === undefined) throw new Error(`${id}: site/scripts/binding-assets-spec.mjs has no entry for it, so nothing says which of the design system's files may be published`);
  if (!existsSync(join(dir, "package.json"))) throw new Error(`${id}: bindings/${id} has no package.json`);
  const manifest = readJson(join(dir, "package.json"));
  const meta = manifest.datumBinding;
  if (meta === undefined) throw new Error(`${id}: bindings/${id}/package.json has no datumBinding block`);
  const name = meta.bundle.replace(/^.*\//, "").replace(/\.js$/, "");
  const bundles = { module: join(dir, "dist", `${name}.js`), script: join(dir, "dist", `${name}.iife.js`) };
  for (const file of Object.values(bundles)) {
    if (!existsSync(file)) throw new Error(`${id}: bindings/${id} has no ${toPosix(relative(dir, file))}; ${fix}`);
  }
  const missing = missingVendor(dir, spec);
  if (missing.length > 0) throw new Error(`${id}: bindings/${id} is missing ${missing.join(", ")}; ${fix}`);
  const check = readJson(join(dir, "binding-check.json"));
  const routing = readRouting(check, `bindings/${id}/binding-check.json`);

  const packDir = join(out, id);
  const filesDir = join(packDir, "files");
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(filesDir, { recursive: true });
  copyFileSync(bundles.module, join(packDir, `${id}.js`));
  copyFileSync(bundles.script, join(packDir, `${id}.iife.js`));
  const files = new Set(copyBindingFiles({ id, dir, spec, filesDir }));

  // Files the localizing adds, and the package folders they came from (for their notices).
  const added = new Map();
  /** Copies the pinned package's file a server path names into the pack; returns its path below files/. */
  const adopt = (serverPath, askedBy) => {
    const source = resolveDsFile([dir], serverPath);
    if (source === undefined) {
      throw new Error(`${id}: ${askedBy} needs ${serverPath}, which bindings/${id} does not hold (is the pinned package installed? ${fix})`);
    }
    const rel = published(toPosix(relative(dir, source)));
    if (!files.has(rel)) {
      mkdirSync(dirname(join(filesDir, rel)), { recursive: true });
      copyFileSync(source, join(filesDir, rel));
      files.add(rel);
    }
    const folder = toPosix(relative(dir, source)).startsWith("node_modules/") ? rel.split("/")[0] : undefined;
    if (folder !== undefined && !(folder in spec.notices)) {
      if (!added.has(folder)) added.set(folder, { root: join(dir, "node_modules", folder), files: new Set(), licences: new Set() });
      const entry = added.get(folder);
      entry.files.add(rel);
      // A licence file in the file's own folder rides along (each typeface folder of a fonts package ships its own).
      for (const sibling of readdirSync(dirname(source))) {
        if (LICENCE_FILE.test(sibling)) entry.licences.add(toPosix(relative(entry.root, join(dirname(source), sibling))));
      }
    }
    return rel;
  };

  const reasonFor = (url) => {
    let host = "";
    try {
      host = new URL(url.startsWith("//") ? `https:${url}` : url).hostname;
    } catch {
      return "not a URL a route could answer";
    }
    const listed = routing.network.find((entry) => entry.host === host);
    return listed ? `only on ${host}: ${listed.reason}` : `nothing in bindings/${id}/binding-check.json answers ${host}`;
  };

  const localized = [];
  const dropped = [];
  const queue = [...files].filter((path) => path.endsWith(".css")).sort();
  const done = new Set();
  let sheets = 0;
  while (queue.length > 0) {
    const cssRel = queue.shift();
    if (done.has(cssRel)) continue;
    done.add(cssRel);
    const file = join(filesDir, cssRel);
    const resolve = (kind, url) => {
      const absolute = url.startsWith("//") ? `https:${url}` : url;
      const route = routing.routes.find((candidate) => absolute.startsWith(candidate.match));
      if (route === undefined) return { drop: reasonFor(url) };
      if (route.files !== undefined) {
        const at = new URL(absolute);
        const target = adopt(route.files + decodeURIComponent(at.pathname).slice(new URL(route.match).pathname.length), `the route ${route.match}`);
        if (target.endsWith(".css")) queue.push(target);
        return { url: `${relativeUrl(cssRel, target)}${kind === "import" ? "" : at.hash}` };
      }
      if (kind !== "import") return { drop: `the route ${route.match} answers with stylesheets, and this is not an @import` };
      // The route's stylesheets, concatenated into one sheet beside the importing one, their own url()s pointing at
      // the package files copied into the pack.
      sheets += 1;
      const target = cssRel.replace(/\.css$/, `.offline-${sheets}.css`);
      const parts = route.stylesheets.map((sheet) => {
        const source = resolveDsFile([dir], sheet.path);
        if (source === undefined) {
          throw new Error(`${id}: the route ${route.match} names ${sheet.path}, which bindings/${id} does not hold (${fix})`);
        }
        return relocateCss(readFileSync(source, "utf8"), (ref) => {
          let from = ref;
          for (const [prefix, to] of Object.entries(sheet.rebase)) {
            if (ref.startsWith(prefix)) {
              from = to + ref.slice(prefix.length);
              break;
            }
          }
          const at = new URL(from, `http://pack${sheet.path}`);
          return `${relativeUrl(target, adopt(decodeURIComponent(at.pathname), `the stylesheet ${sheet.path}`))}${at.hash}`;
        });
      });
      writeFileSync(join(filesDir, target), parts.join("\n"));
      files.add(target);
      queue.push(target);
      return { url: relativeUrl(cssRel, target) };
    };
    const result = localizeCss(readFileSync(file, "utf8"), resolve);
    if (result.replaced.length > 0 || result.dropped.length > 0) writeFileSync(file, result.text);
    for (const entry of result.replaced) localized.push({ file: cssRel, url: entry.url, by: entry.by });
    for (const entry of result.dropped) dropped.push({ file: cssRel, url: entry.url, reason: entry.reason });
  }

  // A notice for each package the localizing brought in: what its package.json states, and its licence files.
  for (const [folder, entry] of [...added].sort(([a], [b]) => a.localeCompare(b))) {
    const pkg = readJson(join(entry.root, "package.json"));
    for (const name of readdirSync(entry.root)) if (LICENCE_FILE.test(name)) entry.licences.add(name);
    for (const licence of entry.licences) {
      mkdirSync(dirname(join(filesDir, folder, licence)), { recursive: true });
      copyFileSync(join(entry.root, licence), join(filesDir, folder, licence));
      files.add(`${folder}/${licence}`);
    }
    const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    const lines = [
      `${pkg.name} ${pkg.version}${repository ? `: ${repository.replace(/^git\+/, "").replace(/\.git$/, "")}` : ""}`,
      "",
      `Licence: ${pkg.license ?? "not declared"}, as the package's package.json declares${entry.licences.size > 0 ? `; the licence files it ships for these files are copied beside them (${[...entry.licences].sort().join(", ")})` : "; the package ships no licence file"}.`,
      `Copied into this pack so that the design system's stylesheet finds them without another host: ${[...entry.files].sort().map((path) => path.slice(folder.length + 1)).join(", ")}.`
    ];
    writeFileSync(join(filesDir, folder, "NOTICE.txt"), `${lines.join("\n")}\n`);
    files.add(`${folder}/NOTICE.txt`);
  }
  for (const folder of Object.keys(spec.notices)) files.add(`${folder}/NOTICE.txt`);

  const placed = placeCheckFiles({ id, check, at: (path) => `./${id}/files/${published(path)}`, has: (path) => files.has(path) });
  const withIntegrity = (entry) => ({ ...entry, integrity: integrityOf(join(out, entry.url)) });
  const unique = (list, key) => [...new Map(list.map((entry) => [key(entry), entry])).values()];
  return {
    designSystem: meta.designSystem ?? check.designSystem,
    release: meta.release,
    global: meta.global,
    module: `./${id}/${id}.js`,
    script: `./${id}/${id}.iife.js`,
    ...placed,
    stylesheets: placed.stylesheets.map(withIntegrity),
    scripts: placed.scripts.map(withIntegrity),
    localized: unique(localized, (entry) => `${entry.file}\n${entry.url}`),
    dropped: unique(dropped, (entry) => `${entry.file}\n${entry.url}`),
    files: walk(filesDir).length
  };
}

/**
 * Builds the packs of `ids` into `out` with their manifest.json, and returns the manifest. Only each
 * pack's own folder (`<out>/<id>`) and the manifest are replaced: nothing else in `out` is touched, so a
 * folder that holds other files is safe to name. Ends with the scan the binding pages run over each pack
 * (never GDS Transport, never a government's marks).
 */
export function buildBindingPacks({ out, ids = REFERENCE_BINDINGS, bindingsDir, specs = BINDING_ASSETS }) {
  mkdirSync(out, { recursive: true });
  const manifest = {};
  for (const id of ids) manifest[id] = buildBindingPack({ id, out, bindingsDir, spec: specs[id] });
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const problems = ids.flatMap((id) => scanPublished(join(out, id)).map((problem) => `${id}/${problem}`));
  if (problems.length > 0) {
    throw new Error(`the packs hold what is never published:\n  ${problems.join("\n  ")}`);
  }
  return manifest;
}

/** Every reference to another host that a stylesheet of the packs `ids` below `out` still makes, as "path: url" lines. */
export function remoteReferences(out, ids) {
  const found = [];
  for (const id of ids) {
    const dir = join(out, id);
    for (const path of walk(dir).filter((name) => name.endsWith(".css"))) {
      localizeCss(readFileSync(join(dir, path), "utf8"), (_kind, url) => {
        found.push(`${id}/${path}: ${url}`);
        return { drop: "" };
      });
    }
  }
  return found;
}
