// The settings schema step: the command it runs, the parse check on its output, and the skip path when uv or the
// module is unavailable. Run: node --test integrations/fastapi/scripts/tests
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SETTINGS_AREAS, SETTINGS_SCHEMA_FILE, SETTINGS_SCHEMA_TARGET, checkSettingsSchema, main, settingsSchemaCommand, writeSettingsSchema } from "../settings-schema.mjs";

const fixtureSchema = (areas = SETTINGS_AREAS) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Datum settings",
  type: "object",
  properties: Object.fromEntries(areas.map((area) => [area, { type: "object" }]))
});

test("the command runs argusvane-datum-core's schema module with --out in the workspace", () => {
  const out = "/tmp/out/datum-settings.schema.json";
  const { command, args, cwd } = settingsSchemaCommand(out);
  assert.equal(command, "uv");
  assert.deepEqual(args, ["run", "--frozen", "--no-sync", "--package", "argusvane-datum-core", "python", "-m", "datum_core.config.schema", "--out", out]);
  assert.ok(cwd.endsWith(join("integrations", "fastapi")), cwd);
});

test("the parse check accepts a schema that lists every top-level settings area", () => {
  const parsed = checkSettingsSchema(JSON.stringify(fixtureSchema()));
  assert.equal(parsed.title, "Datum settings");
  for (const area of ["runtime", "host", "submissions", "forms", "web", "builder", "pdf", "bindings", "tsa", "enabled", "silenced_checks", "strict_env", "workers_expected"]) {
    assert.ok(SETTINGS_AREAS.includes(area), area);
  }
});

test("the parse check refuses text that is not JSON and a schema missing an area", () => {
  assert.throws(() => checkSettingsSchema("{not json"), /JSON|parse/i);
  assert.throws(() => checkSettingsSchema(JSON.stringify(fixtureSchema(SETTINGS_AREAS.slice(1)))), new RegExp(SETTINGS_AREAS[0]));
});

test("a successful run writes the schema file, which then parses", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-schema-"));
  try {
    const target = join(dir, SETTINGS_SCHEMA_FILE);
    const calls = [];
    const fakeRun = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "--version") {
        return { status: 0, stdout: "uv 0.13.1", stderr: "" };
      }
      writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify(fixtureSchema()));
      return { status: 0, stdout: `${target}\n`, stderr: "" };
    };
    const result = writeSettingsSchema({ target, run: fakeRun, log: () => {} });
    assert.equal(result.status, "written");
    assert.equal(calls.length, 2);
    assert.equal(checkSettingsSchema(readFileSync(target, "utf8")).title, "Datum settings");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without uv the step skips with a printed note and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-schema-"));
  try {
    const target = join(dir, SETTINGS_SCHEMA_FILE);
    const notes = [];
    const missing = () => ({ status: null, error: Object.assign(new Error("spawnSync uv ENOENT"), { code: "ENOENT" }), stdout: "", stderr: "" });
    const result = writeSettingsSchema({ target, run: missing, log: (line) => notes.push(line) });
    assert.equal(result.status, "skipped");
    assert.match(notes.join("\n"), /skipped/);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a module that fails to run skips the step and removes any stale schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-schema-"));
  try {
    const target = join(dir, SETTINGS_SCHEMA_FILE);
    writeFileSync(target, "{\"stale\": true}");
    const failing = (_command, args) => (args[0] === "--version" ? { status: 0, stdout: "uv", stderr: "" } : { status: 1, stdout: "", stderr: "No module named datum_core" });
    const notes = [];
    const result = writeSettingsSchema({ target, run: failing, log: (line) => notes.push(line) });
    assert.equal(result.status, "skipped");
    assert.match(notes.join("\n"), /No module named datum_core/);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const okProbe = (args, write) => (args[0] === "--version" ? { status: 0, stdout: "uv", stderr: "" } : write(args[args.indexOf("--out") + 1]));

test("a written file that is not valid JSON or misses an area is skipped and removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-schema-"));
  try {
    const target = join(dir, SETTINGS_SCHEMA_FILE);
    for (const [content, pattern] of [["{not json", /not valid JSON/], [JSON.stringify(fixtureSchema(SETTINGS_AREAS.slice(1))), new RegExp(`area "${SETTINGS_AREAS[0]}"`)]]) {
      const notes = [];
      const run = (_command, args) => okProbe(args, (out) => { writeFileSync(out, content); return { status: 0, stdout: "", stderr: "" }; });
      const result = writeSettingsSchema({ target, run, log: (line) => notes.push(line) });
      assert.equal(result.status, "skipped");
      assert.match(result.reason, pattern);
      assert.equal(existsSync(target), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean exit that wrote no file is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-schema-"));
  try {
    const target = join(dir, SETTINGS_SCHEMA_FILE);
    const run = (_command, args) => okProbe(args, () => ({ status: 0, stdout: "", stderr: "" }));
    const result = writeSettingsSchema({ target, run, log: () => {} });
    assert.equal(result.status, "skipped");
    assert.match(result.reason, /wrote no file/);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the parse check accepts the real schema when argusvane-datum-core has written it", () => {
  const real = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "argusvane-datum-core", "src", "datum_core", SETTINGS_SCHEMA_FILE);
  if (existsSync(real)) {
    checkSettingsSchema(readFileSync(real, "utf8"));
  }
});

test("run as a command, it writes argusvane-datum-core's copy and exits 0, or exits 1 naming why it could not", () => {
  assert.ok(SETTINGS_SCHEMA_TARGET.endsWith(join("packages", "argusvane-datum-core", "src", "datum_core", SETTINGS_SCHEMA_FILE)), SETTINGS_SCHEMA_TARGET);
  const dir = mkdtempSync(join(tmpdir(), "settings-schema-"));
  try {
    const target = join(dir, SETTINGS_SCHEMA_FILE);
    const writes = (_command, args) => okProbe(args, (out) => { writeFileSync(out, JSON.stringify(fixtureSchema())); return { status: 0, stdout: "", stderr: "" }; });
    assert.equal(main({ target, run: writes, log: () => {}, error: () => {} }), 0);
    assert.equal(existsSync(target), true);
    const errors = [];
    const unsynced = (_command, args) => okProbe(args, () => ({ status: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'datum_core'" }));
    assert.equal(main({ target, run: unsynced, log: () => {}, error: (line) => errors.push(line) }), 1);
    assert.match(errors.join("\n"), /was not written: .*datum_core/);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
