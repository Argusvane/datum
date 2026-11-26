// The licences of the third-party rows in notices.json: every row, hand-written or generated, carries a licence on the allow-list
// (packages/datum/scripts/licence-policy.mjs), so a copyleft or unknown package added to a distribution fails here with its name.
// Run: node --test integrations/jvm/scripts/tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { licenceProblem } from "../../../../packages/datum/scripts/licence-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const notices = JSON.parse(readFileSync(join(here, "..", "notices.json"), "utf8"));
const rows = Object.entries(notices.modules).flatMap(([module, list]) => list.map((row) => ({ module, ...row })));

test("every notices row carries a licence on the allow-list", () => {
  assert.ok(rows.length > 0);
  const problems = rows.flatMap((row) => licenceProblem(row.name, row.license, row.version ?? "") ?? []).map((line) => `${line}`);
  assert.deepEqual([...new Set(problems)], []);
});

test("the only copyleft licence is the Liberation fonts', and those are data files, not a dependency", () => {
  const copyleft = rows.filter((row) => /GPL/.test(row.license) && !/^Apache|^MIT/.test(row.license));
  assert.equal(copyleft.length, 1);
  assert.match(copyleft[0].name, /Liberation Sans, four unmodified/);
  assert.notEqual(copyleft[0].kind, "dependency");
});

test("the allow-list refuses a copyleft row added to the file", () => {
  const added = { name: "evil-lib", version: "1.0.0", license: "AGPL-3.0-only" };
  assert.match(licenceProblem(added.name, added.license, added.version), /^evil-lib 1\.0\.0 is under "AGPL-3\.0-only"/);
});
