// The prepack step of every package that publishes to npm: puts the files a tarball must carry
// beside package.json, and refuses to pack a tree that was not built.
//
//   LICENSE   the repository's licence, copied (npm takes it from the package folder only);
//   NOTICE    written here from what the build wrote into dist/: the third-party packages
//             the bundles carry (each package's `dist/*.LICENSE.txt`, the files the build writes) and the
//             licence files of the fonts and data folders copied beside them;
//   README.md the package's own, checked for.
//
// Both LICENSE and NOTICE are generated, so they are not tracked (.gitignore). The build is not run
// here: the datum package builds under a lock and takes minutes, and a pack that quietly rebuilt would
// hide a stale tree. A missing file the package.json points at stops the pack with the command to run.
//
//   node ../../scripts/npm/prepack.mjs        from a package folder (npm runs it as `prepack`)
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isBundleLicenceFile, parseLicenceFile } from "../../packages/datum/scripts/notices-lib.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LABEL = "npm prepack";
// The copyright line is the repository LICENSE's own, so the notice never drifts from it and never carries a build date.
const copyright = readFileSync(join(repo, "LICENSE"), "utf8").split(/\r?\n/).find((line) => line.startsWith("Copyright (c)"));
if (copyright === undefined) {
  console.error(`${LABEL}: LICENSE has no "Copyright (c)" line.`);
  process.exit(1);
}

/** Every file path a manifest's entry points name (`main`, `types`, `bin`, every leaf of `exports`), relative to the package. */
export function entryTargets(manifest) {
  const targets = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      if (value.startsWith("./") && !value.includes("*")) {
        targets.add(value.slice(2));
      }
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(manifest.main);
  visit(manifest.types);
  visit(manifest.bin);
  visit(manifest.exports);
  return [...targets].sort();
}

/** The licence files of the assets copied into `dist` (fonts, data folders): LICENSE, COPYING, OFL texts, found in the tree. */
function assetLicences(dist) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/^(licen[cs]e|copying|ofl)([-._].*)?(\.txt|\.md)?$/i.test(name) && !isBundleLicenceFile(name)) {
        found.push(relative(dist, path).split(sep).join("/"));
      }
    }
  };
  walk(dist);
  return found.sort();
}

/**
 * The text of NOTICE for the package at `folder`: Datum's own licence line, then the packages each
 * `dist/*.LICENSE.txt` lists (name, version, licence, and the file that carries the text), then the licence
 * files of the bundled assets.
 *
 * The paths the text names are where the NOTICE sits: `prefix` is "dist/" in the npm tarball, where the build
 * folder is a folder of the package, and "" in a release archive, which holds the contents of dist at its root.
 * `assets: false` leaves the asset section out, for an archive that does not carry the font and data files.
 */
export function noticeText(folder, { prefix = "dist/", assets: withAssets = true } = {}) {
  const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  const dist = join(folder, "dist");
  const files = existsSync(dist) ? readdirSync(dist).filter((name) => name.endsWith(".LICENSE.txt")).sort() : [];
  const packages = new Map();
  for (const file of files) {
    for (const entry of parseLicenceFile(readFileSync(join(dist, file), "utf8"))) {
      const key = `${entry.name}@${entry.version}`;
      const known = packages.get(key) ?? { ...entry, files: [] };
      known.files.push(file);
      packages.set(key, known);
    }
  }
  const lines = [
    manifest.name,
    `${copyright}. Licensed under the MIT License (see LICENSE).`,
    ""
  ];
  if (packages.size === 0 && files.length === 0) {
    lines.push("This package bundles no third-party code.", "");
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `${prefix === "" ? "The files in this archive" : `The files under ${prefix}`} carry third-party code. Each package keeps the licence its authors gave it;`,
    `the full text of every licence is in the ${prefix}*.LICENSE.txt file named beside the package.`,
    "",
    "Packages bundled into the scripts:",
    ""
  );
  for (const entry of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
    lines.push(`  ${entry.name} ${entry.version} (${entry.license}): ${entry.files.map((file) => `${prefix}${file}`).join(", ")}`);
  }
  const assets = withAssets && existsSync(dist) ? assetLicences(dist) : [];
  if (assets.length > 0) {
    lines.push("", "Fonts and data files copied beside the scripts keep their own licences, in these files:", "");
    for (const file of assets) {
      lines.push(`  ${prefix}${file}`);
    }
    // The one copyleft licence among them is named, because a licence file called LICENSE_LIBERATION does not say it.
    const liberation = assets.find((file) => file.endsWith("standard_fonts/LICENSE_LIBERATION"));
    if (liberation !== undefined) {
      lines.push(
        "",
        `The four Liberation Sans faces in ${prefix}${posix.dirname(liberation)}/ are pdf.js's standard fonts, copied unmodified. Their licence is the GNU General`,
        "Public License, version 2, with the Liberation font exception: a document that embeds the font is not by itself covered by the GPL.",
        `The text, with the GPL 2.0 it refers to, is ${prefix}${liberation}. The fonts are separate files distributed alongside Datum's MIT code.`
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main() {
  const folder = process.cwd();
  const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  const missing = entryTargets(manifest).filter((target) => !existsSync(join(folder, target)));
  if (missing.length > 0) {
    console.error(`${LABEL}: ${manifest.name} is not built: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""} missing (npm run build first)`);
    process.exit(1);
  }
  if (!existsSync(join(folder, "README.md"))) {
    console.error(`${LABEL}: ${manifest.name} has no README.md`);
    process.exit(1);
  }
  copyFileSync(join(repo, "LICENSE"), join(folder, "LICENSE"));
  writeFileSync(join(folder, "NOTICE"), noticeText(folder));
  console.log(`${LABEL}: ${manifest.name}: LICENSE and NOTICE written`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
