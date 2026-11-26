// THIRD_PARTY_NOTICES.md keeps pace with notices.json: every module has a row in the FastAPI section and every notices row is named there.
// Run: node --test integrations/fastapi/scripts/tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const notices = JSON.parse(readFileSync(join(root, "integrations", "fastapi", "scripts", "notices.json"), "utf8"));
const markdown = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const start = markdown.indexOf("## Shipped in the FastAPI host's distributions");
const end = markdown.indexOf("\n## ", start + 1);
const section = start < 0 ? "" : markdown.slice(start, end < 0 ? undefined : end);
const lower = section.toLowerCase();

// The searchable name of a row: its name up to the first space or parenthesis, without a "@scope/" prefix.
const key = (name) => name.split(/[\s(]/)[0].replace(/^@[^/]+\//, "").toLowerCase();

test("the FastAPI section exists", () => {
  assert.ok(start >= 0, "THIRD_PARTY_NOTICES.md has no FastAPI section");
});

test("every module of notices.json has a row in the FastAPI section", () => {
  for (const module of Object.keys(notices.modules)) {
    assert.ok(section.includes(`\`${module}\``), `no row names ${module}`);
  }
});

test("every row name of notices.json appears in the FastAPI section", () => {
  for (const [module, rows] of Object.entries(notices.modules)) {
    for (const row of rows) {
      assert.ok(lower.includes(key(row.name)), `${module}: "${row.name}" is not named in the FastAPI section`);
    }
  }
});

test("the Liberation fonts are labelled GPL-2.0 with the font exception, and the testing extra's opentelemetry-sdk has a row", () => {
  const rows = Object.values(notices.modules).flat();
  const liberation = rows.filter((row) => /Liberation/.test(row.name));
  assert.equal(liberation.length, 1);
  assert.match(liberation[0].license, /^GPL-2\.0-only with the Liberation font exception/);
  assert.match(liberation[0].name, /unmodified/);
  const sdk = notices.modules["argusvane-datum-core"].find((row) => row.name === "opentelemetry-sdk");
  assert.deepEqual([sdk?.kind, sdk?.extra, sdk?.license], ["extra", "testing", "Apache-2.0"]);
  assert.ok(!/Font Awesome/.test(section), "no distribution vendors Font Awesome");
  assert.ok(section.includes("opentelemetry-sdk"), "the FastAPI section names opentelemetry-sdk");
});
