// The checklist (CHECKLIST.md) and the reporter: a JSON report and a console summary.
//
// Scenario status: `pass`, `fail` (a check or a shared assertion failed, or the scenario threw),
// or `pending` (declared `pending: "<reason>"`: run and reported, never failing the run; a
// pending scenario that passes says so, so the mark can be dropped).
// Feature status, per checklist id: `fail` when a scenario covering it failed, `uncovered` when
// no scenario covers it (it fails the run, so a deleted scenario cannot pass silently), `pending`
// when every covering scenario is declared pending, `not-run` when --only left its scenarios
// out, else `pass`.
import { readFileSync } from "node:fs";

/** The checklist's rows: `| ID | Feature | Covers |`, ids like `VAL-01`. */
export function readChecklist(path) {
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\|\s*([A-Z0-9]+-\d{2})\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (match) rows.push({ id: match[1], title: match[2] });
  }
  return rows;
}

export function scenarioStatus(record) {
  const failed = record.error !== undefined || record.checks.some((c) => !c.ok) || record.shared.some((s) => s.checks.some((c) => !c.ok));
  if (record.pending !== undefined) return { status: "pending", passesNow: !failed };
  return { status: failed ? "fail" : "pass" };
}

/**
 * `scenarios` is every scenario that runs in this host: a feature only scenarios left out by
 * --only cover is `not-run`. `everyScenario` is all of them, so a feature whose scenarios all run
 * in another host (the element's own settings) is left off this host's list, and a feature no
 * scenario covers anywhere is still `uncovered`.
 */
export function featureStatuses(checklist, records, scenarios = records, everyScenario = scenarios) {
  return checklist.filter((row) => scenarios.some((s) => s.features.includes(row.id)) || !everyScenario.some((s) => s.features.includes(row.id))).map((row) => {
    const covering = records.filter((r) => r.features.includes(row.id));
    if (covering.length === 0 && scenarios.some((s) => s.features.includes(row.id))) {
      return { id: row.id, title: row.title, status: "not-run", scenarios: [], reason: "its scenarios were not selected" };
    }
    if (covering.length === 0) return { id: row.id, title: row.title, status: "uncovered", scenarios: [], reason: "no scenario covers it" };
    const statuses = covering.map((r) => r.status);
    const status = statuses.includes("fail") ? "fail" : statuses.every((s) => s === "pending") ? "pending" : "pass";
    return { id: row.id, title: row.title, status, scenarios: covering.map((r) => r.id) };
  });
}

export function summarize(records, features) {
  const count = (list, status) => list.filter((x) => x.status === status).length;
  return {
    scenarios: { pass: count(records, "pass"), fail: count(records, "fail"), pending: count(records, "pending") },
    features: {
      pass: count(features, "pass"),
      fail: count(features, "fail"),
      uncovered: count(features, "uncovered"),
      pending: count(features, "pending"),
      notRun: count(features, "not-run"),
      total: features.length
    }
  };
}

/**
 * Whether the run failed: a scenario failed, or (on a full run) a checklist feature has no
 * scenario at all. A run narrowed by --only reports uncovered features without failing on them.
 */
export function runFailed(summary, { partial = false } = {}) {
  return summary.scenarios.fail > 0 || (!partial && summary.features.uncovered > 0);
}

const failing = (list) => list.filter((c) => !c.ok);

/** Prints the run: one line per scenario, its failures, then the feature tally and the pending list. */
export function printReport(report, { verbose = false } = {}) {
  const lines = [];
  for (const r of report.scenarios) {
    const mark = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "PEND";
    lines.push(`${mark} ${r.id}  ${r.title}  [${r.features.join(", ")}]  ${r.durationMs} ms`);
    if (r.status === "pending") lines.push(`     pending: ${r.pending}${r.passesNow ? " (passes now: drop the mark)" : ""}`);
    if (r.error) lines.push(`     threw: ${r.error}`);
    const show = r.status !== "pass" || verbose;
    if (!show) continue;
    for (const c of failing(r.checks)) lines.push(`     check failed: ${c.name}${c.detail !== undefined ? `  ${JSON.stringify(c.detail)}` : ""}`);
    for (const s of r.shared) {
      for (const c of failing(s.checks)) {
        for (const p of c.problems.slice(0, 8)) lines.push(`     shared ${c.name} @ ${s.label}: ${p.message}${p.at ? `  at ${JSON.stringify(p.at)}` : ""}`);
        if (c.problems.length > 8) lines.push(`     shared ${c.name} @ ${s.label}: ... ${c.problems.length - 8} more`);
      }
    }
  }
  const s = report.summary;
  lines.push("");
  lines.push(`scenarios: ${s.scenarios.pass} pass, ${s.scenarios.fail} fail, ${s.scenarios.pending} pending`);
  lines.push(
    `features:  ${s.features.pass} pass, ${s.features.fail} fail, ${s.features.uncovered} uncovered, ${s.features.pending} pending${s.features.notRun ? `, ${s.features.notRun} not run` : ""} of ${s.features.total} on the checklist`
  );
  const uncovered = report.features.filter((f) => f.status === "uncovered");
  if (uncovered.length > 0) lines.push(`UNCOVERED: ${uncovered.map((f) => f.id).join(" ")} (no scenario covers them)`);
  const pending = report.features.filter((f) => f.status === "pending");
  if (pending.length > 0) lines.push(`pending:   ${pending.map((f) => f.id).join(" ")}`);
  const failed = report.features.filter((f) => f.status === "fail");
  if (failed.length > 0) lines.push(`FAILED:    ${failed.map((f) => f.id).join(" ")}`);
  if (report.reportPath) lines.push(`report:    ${report.reportPath}`);
  console.log(lines.join("\n"));
}
