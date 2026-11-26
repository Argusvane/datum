// Splits a build made with DATUM_SOURCE_MAPS=1 into what a release publishes, and leaves `dist` as
// the npm tarball carries it:
//
//   <out>/datum-sourcemaps-<version>.tar.gz   every `<file>.map` of dist (the tarball has none), with the
//                                             repository LICENSE, a NOTICE and every dist/*.LICENSE.txt
//   <out>/datum-bundles-<version>.tar.gz      dist without maps and declarations: the files a page
//                                             copies to a static server, for a user who has no npm, with
//                                             the repository LICENSE and a NOTICE at its root
//   <out>/SHA256SUMS                          the checksum of each archive
//
// The maps stay out of the tarball because they are most of its weight (about 77 MB of 105 MB
// unpacked) and nobody reads them unless a stack trace sends them to a debugger; a release asset
// serves that reader. The scripts end in a `//# sourceMappingURL=` comment that points at their map, so
// the strip step (scripts/strip-source-maps.mjs, the step a build without the switch ends with)
// runs here, after the maps are archived, and feature-files.mjs measures the finished folder again,
// so the manifest counts the bytes that ship. The maps embed `sourcesContent`, so they carry the third-party
// sources the bundles were built from: both archives therefore travel with the licence texts. Their NOTICE is the
// npm tarball's text (scripts/npm/prepack.mjs) with the paths written for an archive root: the maps archive lists no font
// or data licence, because it holds none of those files.
//
//   DATUM_SOURCE_MAPS=1 npm run build && node scripts/release-assets.mjs --out ../../release-assets
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { noticeText } from "../../../scripts/npm/prepack.mjs";
import { stripSourceMaps } from "./strip-source-maps.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");

const tar = (archive, args) => execFileSync("tar", ["-czf", archive, ...args], { stdio: "inherit" });

/** The names of the source maps in `dist`, sorted. */
export const mapsOf = (dist) => readdirSync(dist).filter((name) => name.endsWith(".map")).sort();

/**
 * Writes the repository LICENSE and the package's NOTICE into `into`: the two files every archive carries at its root.
 * The archives hold the contents of dist at their root, so the NOTICE names its files without the `dist/` prefix, and
 * `assets` says whether the archive carries the fonts and data folders whose licence files the NOTICE lists.
 */
export function stageLegal({ packageRoot, repoRoot, into, assets }) {
  copyFileSync(join(repoRoot, "LICENSE"), join(into, "LICENSE"));
  writeFileSync(join(into, "NOTICE"), noticeText(packageRoot, { prefix: "", assets }));
}

/** `<out>/datum-sourcemaps-<version>.tar.gz`: the maps, the licence texts of the bundles they describe, LICENSE and NOTICE. */
export function archiveMaps({ packageRoot, repoRoot, out, version }) {
  const dist = join(packageRoot, "dist");
  const maps = mapsOf(dist);
  const licences = readdirSync(dist).filter((name) => name.endsWith(".LICENSE.txt")).sort();
  const scratch = mkdtempSync(join(tmpdir(), "datum-release-assets-"));
  try {
    // The maps archive holds the maps and the bundles' licence texts only: no font or data file, so none of their licences.
    stageLegal({ packageRoot, repoRoot, into: scratch, assets: false });
    // LICENSE and NOTICE come from the scratch folder and sit at the archive root; the names after the second -C are files of dist.
    tar(join(out, `datum-sourcemaps-${version}.tar.gz`), ["-C", scratch, "LICENSE", "NOTICE", "-C", dist, ...maps, ...licences]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `<out>/datum-bundles-<version>.tar.gz`: dist without its declarations, with LICENSE and NOTICE at the root. */
export function archiveBundles({ packageRoot, repoRoot, out, version }) {
  const scratch = mkdtempSync(join(tmpdir(), "datum-release-assets-"));
  try {
    stageLegal({ packageRoot, repoRoot, into: scratch, assets: true });
    tar(join(out, `datum-bundles-${version}.tar.gz`), ["-C", join(packageRoot, "dist"), "--exclude=./types", ".", "-C", scratch, "LICENSE", "NOTICE"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function fail(message) {
  console.error(`release-assets: ${message}`);
  process.exit(1);
}

function main() {
  const dist = join(root, "dist");
  const flag = process.argv.indexOf("--out");
  if (flag === -1 || !process.argv[flag + 1]) {
    fail("usage: node scripts/release-assets.mjs --out <folder>");
  }
  const out = resolve(process.argv[flag + 1]);
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!existsSync(dist)) {
    fail("dist is missing: run npm run build first");
  }
  if (mapsOf(dist).length === 0) {
    fail("dist holds no source maps: build with DATUM_SOURCE_MAPS=1");
  }

  mkdirSync(out, { recursive: true });
  archiveMaps({ packageRoot: root, repoRoot: repo, out, version });

  const stripped = stripSourceMaps(dist);
  console.log(`release-assets: ${stripped.maps} source maps archived, then removed, and ${stripped.scripts} mapping comments removed from dist`);
  execFileSync(process.execPath, [join(root, "scripts", "feature-files.mjs")], { stdio: "inherit" });

  archiveBundles({ packageRoot: root, repoRoot: repo, out, version });

  const sums = readdirSync(out)
    .filter((name) => name.endsWith(".tar.gz"))
    .sort()
    .map((name) => `${createHash("sha256").update(readFileSync(join(out, name))).digest("hex")}  ${name}`);
  writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
  console.log(`release-assets: wrote ${sums.length} archives to ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
