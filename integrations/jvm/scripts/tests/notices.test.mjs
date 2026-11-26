// The NOTICE each jar carries: its copyright line is the repository LICENSE's, a Maven dependency is told apart from a bundled file,
// and the Liberation fonts are named by their licence. The generator runs into a scratch folder from packages/datum/dist, so
// the test needs `npm run datum:build` and writes nothing under integrations/jvm/target.
// Run: node --test integrations/jvm/scripts/tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const notices = JSON.parse(readFileSync(join(here, "..", "notices.json"), "utf8"));
const rows = Object.entries(notices.modules).flatMap(([module, list]) => list.map((row) => ({ module, ...row })));
const skipNoDist = existsSync(join(repo, "packages", "datum", "dist", "feature-files.json")) ? false : "run `npm run datum:build` first";

test("every row is bundled (no kind) or a declared dependency, and names a licence text that exists", () => {
  for (const row of rows) {
    assert.ok(row.kind === undefined || row.kind === "dependency", `${row.module}: ${row.name} has kind ${row.kind}`);
    if (row.textFile) {
      assert.ok(existsSync(join(repo, row.textFile)), `${row.module}: ${row.name} names ${row.textFile}`);
    }
  }
  assert.deepEqual(
    rows.filter((row) => row.kind === "dependency").map((row) => row.name.split(/[\s(]/)[0]).sort(),
    ["Bouncy", "Bouncy", "Caffeine,", "Endive", "Jackson", "Jimfs", "Jimfs", "jffi", "webauthn4j-core"]
  );
});

test("the Liberation fonts are labelled GPL-2.0 with the font exception, never as an EULA alone", () => {
  const liberation = rows.filter((row) => /Liberation/.test(row.name));
  assert.equal(liberation.length, 1);
  assert.match(liberation[0].license, /^GPL-2\.0-only with the Liberation font exception/);
  assert.match(liberation[0].name, /unmodified/);
  assert.match(readFileSync(join(repo, liberation[0].textFile), "utf8"), /GNU General Public License v\.2 with the exceptions/);
});

test("the generated NOTICE files carry LICENSE's copyright line and separate bundled files from declared dependencies", { skip: skipNoDist }, () => {
  const out = mkdtempSync(join(tmpdir(), "jvm-notices-"));
  after(() => rmSync(out, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [join(here, "..", "build-assets.mjs"), "--out", out, "--allow-stale=true"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const copyright = readFileSync(join(repo, "LICENSE"), "utf8").split("\n").find((line) => line.startsWith("Copyright (c)"));
  assert.match(copyright, /^Copyright \(c\) \d{4} Argusvane$/);
  const read = (module) => readFileSync(join(out, module, "NOTICE"), "utf8");
  for (const module of ["datum-core", "datum-webauthn", "datum-sandbox-endive", "datum-pdf", "datum-ui"]) {
    assert.equal(read(module).split("\n")[1], `${copyright}. Licensed under the MIT License (see LICENSE).`, module);
  }
  assert.match(read("datum-core"), /bundles no third-party components/);
  assert.match(read("datum-webauthn"), /bundles no third-party files; the components below are Maven dependencies it declares/);
  assert.match(read("datum-webauthn"), /^== webauthn4j-core .* — dependency ==$/m);
  const endive = read("datum-sandbox-endive");
  assert.match(endive, /whose heading ends in "— bundled" inside its files; the others are Maven dependencies it declares and does not repackage/);
  assert.match(endive, /^== QuickJS-ng \(qjs-wasi\.wasm\) .* — bundled ==$/m);
  assert.match(endive, /^== Endive .* — dependency ==$/m);
  const pdf = read("datum-pdf");
  assert.match(pdf, /^== pdf\.js standard fonts \(Liberation Sans, four unmodified TrueType faces\).*\(GPL-2\.0-only with the Liberation font exception.*\) — bundled ==$/m);
  assert.match(pdf, /^== Bouncy Castle .* — dependency ==$/m);
});
