// scripts/changelog-promote.mjs: the release step that turns [Unreleased] into the version's section. Run: node --test integrations/jvm/scripts/tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { promote } from "../../../../scripts/changelog-promote.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "changelog-promote.mjs");
const changelog = "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n### Added\n\n- A thing.\n\n## [0.0.9] - 2026-01-01\n\n- Older.\n";

test("the Unreleased notes move under the version and a fresh Unreleased heading is left above", () => {
  const text = promote(changelog, "0.1.0", "2026-12-01");
  assert.equal(
    text,
    "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [0.1.0] - 2026-12-01\n\n### Added\n\n- A thing.\n\n## [0.0.9] - 2026-01-01\n\n- Older.\n"
  );
});

test("a prerelease version is promoted the same way", () => {
  assert.match(promote(changelog, "0.2.0-rc.1", "2026-12-01"), /^## \[0\.2\.0-rc\.1\] - 2026-12-01$/m);
});

test("it refuses what it cannot promote and changes nothing", () => {
  assert.throws(() => promote(changelog, "0.1", "2026-12-01"), /not a version/);
  assert.throws(() => promote(changelog, "0.1.0", "1 Dec"), /not a date/);
  assert.throws(() => promote(changelog, "0.0.9", "2026-12-01"), /already has a section for 0\.0\.9/);
  assert.throws(() => promote("# Changelog\n", "0.1.0", "2026-12-01"), /found 0/);
  assert.throws(() => promote(`${changelog}\n## [Unreleased]\n`, "0.1.0", "2026-12-01"), /found 2/);
  assert.throws(() => promote("# C\n\n## [Unreleased]\n\n## [0.0.9] - 2026-01-01\n", "0.1.0", "2026-12-01"), /empty/);
});

test("the command writes the file, and leaves it alone when it refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "changelog-promote-"));
  try {
    const file = join(dir, "CHANGELOG.md");
    writeFileSync(file, changelog);
    const ok = spawnSync(process.execPath, [script, "--version", "0.1.0", "--date", "2026-12-01", "--file", file], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(readFileSync(file, "utf8"), /^## \[0\.1\.0\] - 2026-12-01$/m);
    const again = spawnSync(process.execPath, [script, "--version", "0.1.0", "--file", file], { encoding: "utf8" });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already has a section/);
    assert.equal(spawnSync(process.execPath, [script, "--file", file], { encoding: "utf8" }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
