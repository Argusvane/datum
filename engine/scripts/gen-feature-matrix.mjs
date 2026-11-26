import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Renders docs/reference/feature-matrix.md from engine/traceability/feature-matrix.json.
//   node scripts/gen-feature-matrix.mjs           write the document
//   node scripts/gen-feature-matrix.mjs --check   verify the rules and that the committed
//                                                 document is the render (exit 1 otherwise)
// Rules: every evidence path exists (repository-relative); an engine value is one of
// wired / partial / contract-only, and "wired" cites at least one engine test file.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const dataPath = join(repoRoot, "engine", "traceability", "feature-matrix.json");
const outPath = join(repoRoot, "docs", "reference", "feature-matrix.md");
const check = process.argv.includes("--check");

const ENGINE = ["wired", "partial", "contract-only"];
const ENGINE_LABEL = { wired: "wired", partial: "partial", "contract-only": "contract only" };
const TEST_FILE = /(^|\/)(tests?|__tests__)\/.*\.test\.[cm]?[jt]sx?$|\.test\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$/;

const data = JSON.parse(readFileSync(dataPath, "utf8"));
const errors = [];
const seen = new Set();

function checkPaths(label, paths) {
  if (!Array.isArray(paths)) {
    errors.push(`${label}: evidence must be an array`);
    return [];
  }
  for (const p of paths) {
    if (typeof p !== "string" || p.startsWith("/") || p.includes("..")) {
      errors.push(`${label}: evidence path "${p}" must be repository-relative`);
    } else if (!existsSync(join(repoRoot, p))) {
      errors.push(`${label}: evidence path "${p}" does not exist`);
    }
  }
  return paths;
}

for (const row of data.features ?? []) {
  const label = `row "${String(row.feature ?? "?").slice(0, 60)}"`;
  for (const k of ["feature", "note"]) {
    if (typeof row[k] !== "string" || row[k].trim() === "") errors.push(`${label}: ${k} must be a non-empty string`);
  }
  if (seen.has(row.feature)) errors.push(`${label}: duplicate feature`);
  seen.add(row.feature);
  if (!ENGINE.includes(row.engine)) errors.push(`${label}: engine "${row.engine}" is not one of ${ENGINE.join(", ")}`);
  const engineEvidence = checkPaths(`${label} engineEvidence`, row.engineEvidence);
  if (row.engine === "wired" && !engineEvidence.some((p) => TEST_FILE.test(p))) {
    errors.push(`${label}: engine "wired" needs at least one test file in engineEvidence`);
  }
}
for (const [i, d] of (data.deferred ?? []).entries()) {
  for (const k of ["what", "why"]) {
    if (typeof d[k] !== "string" || d[k].trim() === "") errors.push(`deferred[${i}]: ${k} must be a non-empty string`);
  }
}

const cell = (s) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const link = (p) => {
  const name = p.split("/").pop() || p;
  return `[${name}](../../${p})`;
};
const evidenceCell = (row) => row.engineEvidence.map(link).join("<br>");

function render() {
  const lines = [
    "# Feature matrix",
    "",
    "<!-- Generated from engine/traceability/feature-matrix.json by `npm run check:traceability` in engine/ (write mode: `node scripts/gen-feature-matrix.mjs`). Do not edit by hand. -->",
    "",
    "What the engine implements, each row with its evidence. Generated from",
    "[`engine/traceability/feature-matrix.json`](../../engine/traceability/feature-matrix.json) by",
    "`engine/scripts/gen-feature-matrix.mjs`; CI runs it with `--check` (`npm run check:traceability`), which",
    "fails when an evidence path does not exist, a rule below is broken, or this file is not the render. Do not",
    "edit this file by hand: change the JSON and run `node scripts/gen-feature-matrix.mjs` in `engine/`.",
    "",
    "Engine column:",
    "",
    "- **wired**: reachable from the runtime or host path, and proved by at least one engine test.",
    "- **partial**: the core exists and is unit-tested, but key behaviour is not wired.",
    "- **contract only**: exported and unit-tested, never invoked outside tests.",
    "",
    "Every non-PDF subsystem is enforced in CI (`npm run ci` and `npm run gates` in `engine/`).",
    "",
    "| Feature | Engine | Evidence | Notes |",
    "|---|---|---|---|"
  ];
  for (const row of data.features) {
    lines.push(`| ${cell(row.feature)} | ${ENGINE_LABEL[row.engine]} | ${evidenceCell(row)} | ${cell(row.note)} |`);
  }
  lines.push("", "## Not yet wired", "", "What remains, all deliberate:", "", "| Deferred | Why |", "|---|---|");
  for (const d of data.deferred) lines.push(`| ${cell(d.what)} | ${cell(d.why)} |`);
  return lines.join("\n") + "\n";
}

let rendered = "";
if (errors.length === 0) rendered = render();

if (check) {
  if (errors.length === 0) {
    const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
    if (current !== rendered) {
      const have = new Set(current.split("\n"));
      const stale = rendered.split("\n").filter((l) => l.startsWith("| ") && !have.has(l));
      errors.push("docs/reference/feature-matrix.md differs from the render; run `node scripts/gen-feature-matrix.mjs` in engine/");
      for (const l of stale) errors.push(`  stale or missing row: ${l.slice(2, 80)}`);
      if (stale.length === 0) errors.push("  (the difference is outside the table rows)");
    }
  }
  if (errors.length > 0) {
    console.error("Feature matrix check failed:");
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }
  const by = (k, v) => data.features.filter((r) => r[k] === v).length;
  console.log(`Feature matrix check passed (${data.features.length} features, ${by("engine", "wired")} wired, ${data.deferred.length} deferred).`);
} else {
  if (errors.length > 0) {
    console.error("Feature matrix rules failed; nothing written:");
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }
  writeFileSync(outPath, rendered);
  console.log(`Wrote docs/reference/feature-matrix.md (${data.features.length} features, ${data.deferred.length} deferred).`);
}
