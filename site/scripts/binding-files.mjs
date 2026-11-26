// The copy both publishers of a design system's files make: the binding pages
// (copy-binding-assets.mjs, into public/demo/bindings/) and the offline packs
// (scripts/offline/lib/packs.mjs, into a bundle an air-gapped deployment serves). One entry of
// binding-assets-spec.mjs says what is copied, redacted and noticed; this module does it, so the two
// publish the same files with the same redactions.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";

/** Every file below a folder, as paths relative to it ('/'-separated). */
export function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [relative(base, full).split(sep).join("/")];
  });
}

/** The published path of a file below bindings/<id>: node_modules/ is dropped. */
export const published = (path) => path.replace(/^\/?node_modules\//, "").replace(/^\//, "");

/** The `vendor` sources of a spec entry that `dir` (bindings/<id>) does not hold. */
export const missingVendor = (dir, spec) => spec.vendor.filter((item) => !existsSync(join(dir, item.from))).map((item) => item.from);

/**
 * Copies what `spec.vendor` lists from `dir` (bindings/<id>) into `filesDir`, applies `spec.redact` and
 * writes each package's NOTICE.txt. Returns the copied paths below `filesDir`. Throws when a redaction
 * matches another number of times than it expects: the library changed, so what it draws must be read
 * again before it is published.
 */
export function copyBindingFiles({ id, dir, spec, filesDir }) {
  mkdirSync(filesDir, { recursive: true });
  const copied = [];
  for (const item of spec.vendor) {
    const from = join(dir, item.from);
    const to = join(filesDir, published(item.from));
    if (statSync(from).isDirectory()) {
      for (const rel of walk(from)) {
        const name = rel.split("/").pop();
        if (item.only && !item.only(name)) continue;
        if (item.skip && item.skip(rel)) continue;
        mkdirSync(dirname(join(to, rel)), { recursive: true });
        copyFileSync(join(from, rel), join(to, rel));
        copied.push(posix.join(published(item.from), rel));
      }
    } else {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(published(item.from));
    }
  }

  for (const [filePattern, pattern, replacement, expected] of spec.redact ?? []) {
    let matches = 0;
    for (const rel of walk(filesDir).filter((name) => filePattern.test(name))) {
      const file = join(filesDir, rel);
      const text = readFileSync(file, "utf8");
      const next = text.replace(pattern, (...args) => {
        matches += 1;
        return replacement.replace(/\$(\d)/g, (_, n) => (typeof args[Number(n)] === "string" ? args[Number(n)] : ""));
      });
      if (next !== text) writeFileSync(file, next);
    }
    if (matches !== expected) {
      throw new Error(`${id}: redacting ${filePattern} matched ${matches} times, expected ${expected}; the library changed, so check what it draws before publishing it`);
    }
  }

  for (const [folder, text] of Object.entries(spec.notices)) {
    mkdirSync(join(filesDir, folder), { recursive: true });
    writeFileSync(join(filesDir, folder, "NOTICE.txt"), `${text.trim()}\n`);
  }
  return copied;
}

/**
 * The files a binding's binding-check.json names, at the addresses `at(path)` gives them: `{ stylesheets,
 * scripts, bodyClass?, lang? }`. Throws when the check file names a file the copy did not make (`has(path)`
 * answers for a published path below the files folder).
 */
export function placeCheckFiles({ id, check, at, has }) {
  const listed = (item) => (typeof item === "string" ? { url: item } : item);
  const place = (item) => {
    const entry = listed(item);
    if (!has(published(entry.url))) {
      throw new Error(`${id}: binding-check.json names ${entry.url}, which the spec does not copy`);
    }
    return {
      url: at(entry.url),
      ...(entry.classic ? { classic: true } : {}),
      ...(entry.attributes ? { attributes: Object.fromEntries(Object.entries(entry.attributes).map(([key, value]) => [key, value.startsWith("/") ? at(value) : value])) } : {})
    };
  };
  return {
    stylesheets: (check.stylesheets ?? []).map(place),
    scripts: (check.scripts ?? []).map(place),
    ...(check.bodyClass ? { bodyClass: check.bodyClass } : {}),
    ...(check.lang ? { lang: check.lang } : {})
  };
}
