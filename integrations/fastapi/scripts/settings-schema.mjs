// The settings schema step of the asset build: argusvane-datum-core writes datum-settings.schema.json from its DatumConfig tree
// (`python -m datum_core.config.schema --out PATH`). The module runs in the synced workspace, so the step never fails
// the asset build: when uv or the module is unavailable it prints a note, removes any stale copy and returns "skipped". A build
// that runs before the sync (CI builds the assets first) writes the schema afterwards by running this file, which fails instead:
//
//   node integrations/fastapi/scripts/settings-schema.mjs
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SETTINGS_SCHEMA_FILE = "datum-settings.schema.json";
export const SETTINGS_SCHEMA_DIR = join("packages", "argusvane-datum-core", "src", "datum_core");
// Every top-level property of DatumConfig (datum_core.config.models): the areas plus the four scalar settings; the parse
// check holds the published schema to all of them.
export const SETTINGS_AREAS = [
  "runtime", "host", "submissions", "forms", "web", "builder", "pdf", "bindings", "tsa",
  "enabled", "silenced_checks", "strict_env", "workers_expected"
];

const fastapiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the schema is written: argusvane-datum-core's package directory, which its tests read it from. */
export const SETTINGS_SCHEMA_TARGET = join(fastapiRoot, SETTINGS_SCHEMA_DIR, SETTINGS_SCHEMA_FILE);

/** The command that writes the schema to `out`, run from the Python workspace. */
export const settingsSchemaCommand = (out) => ({
  command: "uv",
  args: ["run", "--frozen", "--no-sync", "--package", "argusvane-datum-core", "python", "-m", "datum_core.config.schema", "--out", out],
  cwd: fastapiRoot
});

/** Parses the schema text and holds it to the top-level areas; throws with the reason when it does not hold. */
export const checkSettingsSchema = (text) => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`settings schema is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const properties = parsed && typeof parsed === "object" && parsed.properties && typeof parsed.properties === "object" ? parsed.properties : {};
  for (const area of SETTINGS_AREAS) {
    if (!(area in properties)) {
      throw new Error(`settings schema does not list the settings area "${area}"`);
    }
  }
  return parsed;
};

const defaultRun = (command, args, options) => spawnSync(command, args, { encoding: "utf8", ...options });

/**
 * Writes the schema to `target`. `run` and `log` are injectable so the test can drive both outcomes.
 * @returns {{status: "written"} | {status: "skipped", reason: string}}
 */
export const writeSettingsSchema = ({ target, run = defaultRun, log = console.log } = {}) => {
  const skip = (reason) => {
    rmSync(target, { force: true });
    log(`fastapi:assets: ${SETTINGS_SCHEMA_FILE} skipped: ${reason}`);
    return { status: "skipped", reason };
  };
  const probe = run("uv", ["--version"], {});
  if (probe.error || probe.status !== 0) {
    return skip("uv is not available");
  }
  const { command, args, cwd } = settingsSchemaCommand(target);
  const result = run(command, args, { cwd });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || "").trim().split("\n").slice(-3).join(" | ");
    return skip(`datum_core.config.schema did not run (${detail || `exit ${result.status}`}); sync the workspace with uv sync --all-packages --frozen`);
  }
  if (!existsSync(target)) {
    return skip("the module exited cleanly but wrote no file");
  }
  try {
    checkSettingsSchema(readFileSync(target, "utf8"));
  } catch (error) {
    return skip(error instanceof Error ? error.message : String(error));
  }
  return { status: "written" };
};

/** Run as a command: writes the schema, and exits 1 when it could not be written. */
export const main = ({ target = SETTINGS_SCHEMA_TARGET, run = defaultRun, log = console.log, error = console.error } = {}) => {
  const outcome = writeSettingsSchema({ target, run, log });
  if (outcome.status !== "written") {
    error(`fastapi: ${SETTINGS_SCHEMA_FILE} was not written: ${outcome.reason}`);
    return 1;
  }
  log(`fastapi: wrote ${target}`);
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
