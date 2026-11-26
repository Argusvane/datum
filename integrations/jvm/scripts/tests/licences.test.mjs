// The licence files each JVM module ships: a bundle's licence file travels beside the bundle's main file, in the one module that
// ships it. The plan is computed from packages/datum/dist with the build's own allocation (allocation.mjs, feature-files.json), so the
// test needs no staging; the staged output under target/datum-assets is checked too when `npm run jvm:assets` has run.
// Run: node --test integrations/jvm/scripts/tests
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isBundleLicenceFile, licenceFilesFor } from "../../../../packages/datum/scripts/notices-lib.mjs";
import { allocateDistFiles } from "../allocation.mjs";

const jvmRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundleDist = join(jvmRoot, "..", "..", "packages", "datum", "dist");
const staged = join(jvmRoot, "target", "datum-assets");

const EXPECTED = {
  "datum-ui": ["datum-builder.LICENSE.txt", "datum-form.LICENSE.txt", "datum-wasm.LICENSE.txt"],
  "datum-pdf": ["datum-pdf-pages.LICENSE.txt", "datum-pdf.LICENSE.txt"],
  "datum-programs": ["datum-pdf-program.LICENSE.txt"]
};
const skipNoDist = existsSync(join(bundleDist, "feature-files.json")) ? false : "run `npm run datum:build` first";
const skipNoStaging = Object.keys(EXPECTED).every((module) => existsSync(join(staged, module))) ? false : "run `npm run jvm:assets` first";

test("the licence files planned for datum-ui, datum-pdf and datum-programs are their bundles' own, and no module lists another's", { skip: skipNoDist }, () => {
  const manifest = JSON.parse(readFileSync(join(bundleDist, "feature-files.json"), "utf8"));
  const pdfFeatureFiles = new Set(["pdf", "pdf-pages"].flatMap((token) => manifest.features[token].files));
  const everyDistFile = readdirSync(bundleDist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(bundleDist, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
  const licenceFiles = everyDistFile.filter(isBundleLicenceFile);
  const { buckets } = allocateDistFiles({ distFiles: everyDistFile.filter((file) => !isBundleLicenceFile(file)), pdfFeatureFiles });
  const planned = Object.fromEntries(Object.keys(EXPECTED).map((module) => {
    const { files, missing } = licenceFilesFor(buckets[module], licenceFiles);
    assert.deepEqual(missing, [], module);
    return [module, files];
  }));
  assert.deepEqual(planned, EXPECTED);
  const all = Object.values(planned).flat();
  assert.equal(new Set(all).size, all.length, "a licence file is in two modules");
});

test("the staged modules hold their bundles' licence files and none is in two modules", { skip: skipNoStaging }, () => {
  const held = Object.fromEntries(Object.keys(EXPECTED).map((module) => [
    module,
    readdirSync(join(staged, module), { recursive: true }).map((file) => basename(String(file))).filter((name) => isBundleLicenceFile(name)).sort()
  ]));
  assert.deepEqual(held, EXPECTED);
  const all = Object.values(held).flat();
  assert.equal(new Set(all).size, all.length, "a licence file is in two modules");
});
