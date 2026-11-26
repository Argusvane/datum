#!/usr/bin/env node
// Prints the binding x group matrix (pass/fail/skip/pending) from report directories:
//   node matrix.mjs <runDir>   (each subfolder holds a report.json)   or   node matrix.mjs a/report.json b/report.json
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const files = [];
for (const arg of process.argv.slice(2)) {
  if (statSync(arg).isDirectory()) {
    if (existsSync(join(arg, "report.json"))) files.push(join(arg, "report.json"));
    else for (const d of readdirSync(arg).sort()) if (existsSync(join(arg, d, "report.json"))) files.push(join(arg, d, "report.json"));
  } else files.push(arg);
}
const reports = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
const groups = [...new Set(reports.flatMap((r) => r.cases.map((c) => c.group)))];
const cell = (r, g) => { const n = { pass: 0, fail: 0, skip: 0, pending: 0 }; for (const c of r.cases) if (c.group === g) n[c.status] += 1; return `${n.pass}/${n.fail}/${n.skip}/${n.pending}`; };
const w = 13;
console.log("pass/fail/skip/pending".padEnd(24) + groups.map((g) => g.padEnd(8)).join("") + "TOTAL");
for (const r of reports) {
  const t = r.summary.total;
  console.log(r.binding.name.padEnd(24) + groups.map((g) => cell(r, g).padEnd(8)).join("") + `${t.pass}/${t.fail}/${t.skip}/${t.pending}`);
}
