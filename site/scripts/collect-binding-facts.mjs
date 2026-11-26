// Writes src/binding-facts.json: the numbers the binding pages print, read from what `kit:check` wrote.
//
//   for each binding:  node ../packages/datum/binding-kit/check.mjs --binding <id> --report <dir>/report-<id>
//   (Datum's own:      node ../packages/datum/binding-kit/check.mjs --binding datum --report <dir>/report-datum)
//   node scripts/collect-binding-facts.mjs <dir>
//
// Per binding: the release and the size budget from its package.json and dist/sizes.json, the equality
// cases (tier 1 against the design system's own markup, tier 2 against the binding's own signed-off
// pictures), the behaviour cases and the datum-binding-check totals. A case the binding declares known (a defect
// of the design system itself, `known` in its binding-check.json) is counted apart as `known`, and listed with its
// reason under `knownDefects`; both keys are left out when there is none. A report that is missing stops the
// script: a page never prints a number nobody measured. test/binding-pages.test.ts holds the file to the
// packages (release, budget) so it cannot drift from them.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REFERENCE_BINDINGS } from "./binding-assets-spec.mjs";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(site, "..");
const reports = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
if (reports === undefined) {
  console.error("usage: node scripts/collect-binding-facts.mjs <folder with report-<id>/ per binding>");
  process.exit(2);
}

const read = (file) => {
  if (!existsSync(file)) {
    console.error(`collect-binding-facts: ${file} is missing; run kit:check with --report first`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(file, "utf8"));
};
const count = (cases, status) => cases.filter((entry) => entry.status === status).length;

function reportOf(id) {
  const dir = join(reports, `report-${id}`);
  const conformance = read(join(dir, "conformance", "report.json"));
  const behaviour = read(join(dir, "behaviour.json")).cases;
  const total = conformance.summary.total;
  const knownBehaviour = count(behaviour, "known");
  const knownConformance = total.known ?? 0;
  const facts = {
    behaviour: { pass: count(behaviour, "pass"), fail: count(behaviour, "fail"), skip: count(behaviour, "skip"), ...(knownBehaviour > 0 ? { known: knownBehaviour } : {}) },
    conformance: { pass: total.pass, fail: total.fail, skip: total.skip, pending: total.pending, ...(knownConformance > 0 ? { known: knownConformance } : {}) },
    browser: String(conformance.browser).split(" ")[0],
    measuredOn: String(conformance.startedAt).slice(0, 10)
  };
  const knownDefects = [
    ...behaviour.filter((entry) => entry.status === "known").map((entry) => ({ suite: "behaviour", case: entry.id, reason: entry.known })),
    ...conformance.cases.filter((entry) => entry.status === "known").map((entry) => ({ suite: "conformance", case: entry.id, reason: entry.known }))
  ];
  if (knownDefects.length > 0) facts.knownDefects = knownDefects;
  if (id !== "datum") {
    const equality = read(join(dir, "equality.json")).cases;
    facts.equality = {
      tier1: equality.filter((entry) => entry.tier === 1).length,
      tier1Pass: equality.filter((entry) => entry.tier === 1 && entry.status === "pass").length,
      tier2: equality.filter((entry) => entry.tier === 2).length,
      pass: count(equality, "pass"),
      fail: count(equality, "fail")
    };
  }
  return facts;
}

const out = {};
for (const id of ["datum", ...REFERENCE_BINDINGS]) {
  const facts = reportOf(id);
  if (id !== "datum") {
    const meta = JSON.parse(readFileSync(join(root, "bindings", id, "package.json"), "utf8")).datumBinding;
    const sizes = JSON.parse(readFileSync(join(root, "bindings", id, "dist", "sizes.json"), "utf8"));
    const esm = sizes.find((entry) => entry.file === meta.bundle.replace(/^.*\//, ""));
    out[id] = { release: meta.release, budgetKb: meta.budgetKb, gzipKb: Math.round((esm.gzip / 1024) * 10) / 10, ...facts };
  } else out[id] = facts;
}
writeFileSync(join(site, "src", "binding-facts.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`collect-binding-facts: src/binding-facts.json (${Object.keys(out).join(", ")})`);
