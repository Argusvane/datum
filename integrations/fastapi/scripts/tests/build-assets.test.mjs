// Checks on build-assets.mjs and what it writes: the dry run changes nothing, each distribution's NOTICE follows notices.json,
// and manifest.json is the same bytes in the four resource distributions. Run: node --test integrations/fastapi/scripts/tests
// The NOTICE and manifest checks read the generated files and skip with a reason when `npm run fastapi:assets` has not run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isBundleLicenceFile, licenceFilesFor } from "../../../../packages/datum/scripts/notices-lib.mjs";
import { DISTRIBUTIONS, allocateDistFiles } from "../allocation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fastapiRoot = join(here, "..", "..");
const script = join(fastapiRoot, "scripts", "build-assets.mjs");
const notices = JSON.parse(readFileSync(join(fastapiRoot, "scripts", "notices.json"), "utf8"));
const generated = DISTRIBUTIONS.every(({ name, pkg }) => existsSync(join(fastapiRoot, "packages", name, "NOTICE")) && existsSync(join(fastapiRoot, "packages", name, "src", pkg, "datum-build.json")));
const skipUnbuilt = generated ? false : "run `npm run fastapi:assets` first";

// Every file under packages/ and build/ with its digest, leaving out the caches a test run itself writes.
const IGNORED = new Set(["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis", ".venv", "node_modules"]);
const treeDigest = () => {
  const lines = [];
  const walk = (dir) => {
    if (!existsSync(dir)) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED.has(entry.name)) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        lines.push(`${relative(fastapiRoot, path)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      }
    }
  };
  walk(join(fastapiRoot, "packages"));
  walk(join(fastapiRoot, "build"));
  return createHash("sha256").update(lines.join("\n")).digest("hex");
};

test("--dry-run prints the allocation and leaves every file of packages/ and build/ as it was", { skip: skipUnbuilt }, () => {
  const before = treeDigest();
  const result = spawnSync(process.execPath, [script, "--dry-run", "--allow-stale"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--dry-run: nothing written/);
  assert.equal(treeDigest(), before);
});

test("each distribution's NOTICE opens with its name, states what it ships and lists the rows of notices.json in order", { skip: skipUnbuilt }, () => {
  assert.deepEqual(Object.keys(notices.modules).filter((name) => !DISTRIBUTIONS.some((entry) => entry.name === name)), []);
  for (const { name } of DISTRIBUTIONS) {
    const text = readFileSync(join(fastapiRoot, "packages", name, "NOTICE"), "utf8");
    const rows = notices.modules[name] ?? [];
    const lines = text.split("\n");
    assert.equal(lines[0], `Datum for FastAPI: ${name}`);
    // The line is the repository LICENSE's own copyright line, year included.
    const copyright = readFileSync(join(fastapiRoot, "..", "..", "LICENSE"), "utf8").split("\n").find((line) => line.startsWith("Copyright (c)"));
    assert.equal(lines[1], `${copyright}. Licensed under the MIT License (see LICENSE).`);
    const vendored = rows.filter((row) => row.kind === "vendored");
    const statement = vendored.length > 0 ? /ships the third-party components marked \(vendored\)/ : rows.length > 0 ? /ships no third-party files/ : /bundles no third-party components/;
    assert.match(lines[3], statement, name);
    const headers = lines.filter((line) => line.startsWith("== ") && line.endsWith(" =="));
    assert.equal(headers.length, rows.length, name);
    rows.forEach((row, index) => {
      assert.ok(headers[index].startsWith(`== ${row.name} ${row.version} (${row.license}) — `), `${name}: ${headers[index]}`);
      assert.ok(headers[index].includes(row.kind === "extra" ? `[${row.extra}] extra` : row.kind), `${name}: ${headers[index]}`);
      assert.ok(text.includes(`Source: ${row.source}`), `${name}: source of ${row.name}`);
      if (row.textFile) {
        const licence = readFileSync(join(fastapiRoot, "..", "..", row.textFile), "utf8").trimEnd();
        assert.ok(text.includes(licence), `${name}: licence text of ${row.name}`);
      }
    });
  }
});

test("manifest.json is the same bytes in the four resource distributions and absent from the other three", { skip: skipUnbuilt }, () => {
  const manifests = DISTRIBUTIONS.filter((entry) => entry.resource).map(({ name, pkg }) => readFileSync(join(fastapiRoot, "packages", name, "src", pkg, "manifest.json")));
  assert.equal(manifests.length, 4);
  for (const manifest of manifests.slice(1)) {
    assert.deepEqual(manifest, manifests[0]);
  }
  for (const { name, pkg } of DISTRIBUTIONS.filter((entry) => !entry.resource)) {
    assert.equal(existsSync(join(fastapiRoot, "packages", name, "src", pkg, "manifest.json")), false, name);
  }
});

test("datum-build.json agrees across the eight distributions on build id and ABIs, and each names its own member version", { skip: skipUnbuilt }, () => {
  const records = DISTRIBUTIONS.map(({ name, pkg }) => ({ name, record: JSON.parse(readFileSync(join(fastapiRoot, "packages", name, "src", pkg, "datum-build.json"), "utf8")) }));
  for (const { name, record } of records) {
    assert.equal(record.buildId, records[0].record.buildId, name);
    assert.equal(record.sandboxAbi, records[0].record.sandboxAbi, name);
    assert.equal(record.pdfAbi, records[0].record.pdfAbi, name);
    const pyproject = readFileSync(join(fastapiRoot, "packages", name, "pyproject.toml"), "utf8");
    assert.equal(record.version, /^version\s*=\s*"([^"]+)"/m.exec(pyproject)[1], name);
  }
});

test("assets/files.json of the UI and PDF distributions lists every shipped file with its sha256 and nothing else", { skip: skipUnbuilt }, () => {
  for (const name of ["argusvane-datum-assets-ui", "argusvane-datum-assets-pdf"]) {
    const assets = join(fastapiRoot, "packages", name, "src", name.replace(/^argusvane-/, "").replaceAll("-", "_"), "assets");
    const listed = JSON.parse(readFileSync(join(assets, "files.json"), "utf8")).files;
    const onDisk = readdirSync(assets, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(assets, join(entry.parentPath, entry.name)).split("\\").join("/"))
      .filter((file) => file !== "files.json")
      .sort();
    assert.deepEqual(Object.keys(listed).sort(), onDisk, name);
    for (const file of onDisk) {
      assert.equal(listed[file], createHash("sha256").update(readFileSync(join(assets, file))).digest("hex"), `${name}: ${file}`);
    }
  }
});

test("--dry-run names both files.json", { skip: skipUnbuilt }, () => {
  const result = spawnSync(process.execPath, [script, "--dry-run", "--allow-stale"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /datum_assets_ui\/assets\/files\.json/);
  assert.match(result.stdout, /datum_assets_pdf\/assets\/files\.json/);
});

test("datum_assets_ui/assets/feature-files.json is the bundle's feature-files.json and files.json lists it", { skip: skipUnbuilt }, () => {
  const assets = join(fastapiRoot, "packages", "argusvane-datum-assets-ui", "src", "datum_assets_ui", "assets");
  const shipped = readFileSync(join(assets, "feature-files.json"));
  const bundle = join(fastapiRoot, "..", "..", "packages", "datum", "dist", "feature-files.json");
  if (existsSync(bundle)) {
    assert.deepEqual(shipped, readFileSync(bundle));
  }
  const document = JSON.parse(shipped.toString("utf8"));
  assert.ok(Object.keys(document.features).length > 0);
  for (const [token, entry] of Object.entries(document.features)) {
    assert.ok(Array.isArray(entry.files), token);
  }
  const listed = JSON.parse(readFileSync(join(assets, "files.json"), "utf8")).files;
  assert.equal(listed["feature-files.json"], createHash("sha256").update(shipped).digest("hex"));
});

test("--dry-run names the feature-files.json it will copy", { skip: skipUnbuilt }, () => {
  const result = spawnSync(process.execPath, [script, "--dry-run", "--allow-stale"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /datum_assets_ui\/assets\/feature-files\.json/);
});

// The licence files each distribution is to ship: the bundles whose licence texts a host copies beside the bundle's main file.
const EXPECTED_LICENCES = {
  "argusvane-datum-assets-ui": ["datum-builder.LICENSE.txt", "datum-form.LICENSE.txt", "datum-wasm.LICENSE.txt"],
  "argusvane-datum-assets-pdf": ["datum-pdf-pages.LICENSE.txt", "datum-pdf.LICENSE.txt"],
  "argusvane-datum-programs": ["datum-pdf-program.LICENSE.txt"]
};
const bundleDist = join(fastapiRoot, "..", "..", "packages", "datum", "dist");
const skipNoDist = existsSync(join(bundleDist, "feature-files.json")) ? false : "run `npm run datum:build` first";

test("the licence files planned for each distribution are its bundles' own, and no distribution lists another's", { skip: skipNoDist }, () => {
  const manifest = JSON.parse(readFileSync(join(bundleDist, "feature-files.json"), "utf8"));
  const pdfFeatureFiles = new Set(["pdf", "pdf-pages"].flatMap((token) => manifest.features[token].files));
  const everyDistFile = readdirSync(bundleDist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(bundleDist, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
  const licenceFiles = everyDistFile.filter(isBundleLicenceFile);
  const { buckets } = allocateDistFiles({ distFiles: everyDistFile.filter((file) => !isBundleLicenceFile(file)), pdfFeatureFiles });
  const planned = Object.fromEntries(Object.keys(EXPECTED_LICENCES).map((name) => {
    const { files, missing } = licenceFilesFor(buckets[name], licenceFiles);
    assert.deepEqual(missing, [], name);
    return [name, files];
  }));
  assert.deepEqual(planned, EXPECTED_LICENCES);
  const all = Object.values(planned).flat();
  assert.equal(new Set(all).size, all.length, "a licence file is in two distributions");
});

test("the staged distributions hold their bundles' licence files, files.json lists them, and none is in two distributions", { skip: skipUnbuilt }, () => {
  const holds = (name, pkg, folder) => {
    const root = join(fastapiRoot, "packages", name, "src", pkg, folder);
    return readdirSync(root, { recursive: true }).map((file) => String(file).split("\\").join("/")).filter((file) => isBundleLicenceFile(file)).sort();
  };
  const staged = {
    "argusvane-datum-assets-ui": holds("argusvane-datum-assets-ui", "datum_assets_ui", "assets"),
    "argusvane-datum-assets-pdf": holds("argusvane-datum-assets-pdf", "datum_assets_pdf", "assets"),
    "argusvane-datum-programs": holds("argusvane-datum-programs", "datum_programs", "resources")
  };
  assert.deepEqual(staged, EXPECTED_LICENCES);
  for (const name of ["argusvane-datum-assets-ui", "argusvane-datum-assets-pdf"]) {
    const assets = join(fastapiRoot, "packages", name, "src", name.replace(/^argusvane-/, "").replaceAll("-", "_"), "assets");
    const listed = Object.keys(JSON.parse(readFileSync(join(assets, "files.json"), "utf8")).files);
    assert.deepEqual(listed.filter(isBundleLicenceFile).sort(), EXPECTED_LICENCES[name], name);
  }
  const all = Object.values(staged).flat();
  assert.equal(new Set(all).size, all.length, "a licence file is in two distributions");
});
