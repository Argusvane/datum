// Reports: report.json, junit.xml, report.html (+ a screenshot per failing case), and the
// baseline diff.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GROUPS } from "./cases.mjs";

export const STATUSES = ["pass", "fail", "skip", "pending", "known"];

export function summarize(cases) {
  const total = { pass: 0, fail: 0, skip: 0, pending: 0, known: 0 };
  const byGroup = {};
  for (const c of cases) {
    total[c.status] += 1;
    byGroup[c.group] ??= { pass: 0, fail: 0, skip: 0, pending: 0, known: 0 };
    byGroup[c.group][c.status] += 1;
  }
  return { total, byGroup };
}

const esc = (text) => String(text ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

export function junit(report) {
  const { total } = report.summary;
  const lines = [`<?xml version="1.0" encoding="UTF-8"?>`, `<testsuites>`, `  <testsuite name="datum-binding-check:${esc(report.binding.name)}" tests="${report.cases.length}" failures="${total.fail}" skipped="${total.skip + total.pending + total.known}">`];
  for (const c of report.cases) {
    lines.push(`    <testcase classname="${esc(c.group)}" name="${esc(c.id + " " + c.title)}" time="${(c.ms / 1000).toFixed(3)}">`);
    if (c.status === "fail") lines.push(`      <failure message="${esc(c.message)}"/>`);
    else if (c.status === "skip" || c.status === "pending" || c.status === "known") lines.push(`      <skipped message="${esc(c.status + ": " + c.message)}"/>`);
    lines.push(`    </testcase>`);
  }
  lines.push(`  </testsuite>`, `</testsuites>`, "");
  return lines.join("\n");
}

export function html(report) {
  const rows = report.cases
    .map((c) => `<tr class="${c.status}"><td>${esc(c.id)}</td><td>${esc(c.title)}</td><td>${c.status}</td><td>${esc(c.message)}${c.shot ? `<br><a href="${c.shot}"><img src="${c.shot}" width="360" alt="screenshot ${esc(c.id)}"></a>` : ""}</td><td>${c.ms}</td></tr>`)
    .join("\n");
  const matrix = Object.entries(report.summary.byGroup)
    .map(([g, n]) => `<tr><td>${g}</td><td>${esc(GROUPS[g] ?? "")}</td><td>${n.pass}</td><td>${n.fail}</td><td>${n.skip}</td><td>${n.pending}</td><td>${n.known}</td></tr>`)
    .join("\n");
  const effects = (report.binding.sideEffects ?? []).map((e) => `<li><code>${esc(e.target)}</code>: ${esc(e.effect)}</li>`).join("");
  const con = (report.console ?? []).map((l) => `<li>${esc(l.type)}: ${esc(l.text)} <small>(${esc(l.cases.join(", "))})</small></li>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>datum-binding-check ${esc(report.binding.name)}</title>
<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #ccc;padding:4px 8px;vertical-align:top}tr.fail{background:#fde8e8}tr.pass{background:#eefaf0}tr.skip,tr.pending{background:#f4f4f4;color:#555}tr.known{background:#fff6e0}</style>
<h1>datum-binding-check: ${esc(report.binding.name)}</h1>
<p>${esc(report.binding.designSystem ?? "")} &middot; ${esc(report.browser)} &middot; ${esc(report.startedAt)}</p>
<p>pass ${report.summary.total.pass} &middot; fail ${report.summary.total.fail} &middot; skip ${report.summary.total.skip} &middot; pending ${report.summary.total.pending}${report.summary.total.known > 0 ? ` &middot; known ${report.summary.total.known}` : ""}</p>
<table><tr><th>Group</th><th>What</th><th>pass</th><th>fail</th><th>skip</th><th>pending</th><th>known</th></tr>${matrix}</table>
<table><tr><th>Case</th><th>What</th><th>Status</th><th>Message</th><th>ms</th></tr>${rows}</table>
<h2>Side effects outside the form (declared by the binding)</h2><ul>${effects || "<li>none declared</li>"}</ul>
<h2>Design-system console output</h2><ul>${con || "<li>none</li>"}</ul>`;
}

export function writeReports(dir, report, shots) {
  mkdirSync(join(dir, "shots"), { recursive: true });
  for (const [id, data] of Object.entries(shots)) writeFileSync(join(dir, "shots", `${id}.png`), Buffer.from(data, "base64"));
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "junit.xml"), junit(report));
  writeFileSync(join(dir, "report.html"), html(report));
}

/** Case status changes between two reports, as lines for the console. */
export function diffBaseline(previous, current, { partial = false } = {}) {
  const before = new Map(previous.cases.map((c) => [c.id, c]));
  const after = new Map(current.cases.map((c) => [c.id, c]));
  const changes = [];
  for (const [id, c] of after) {
    const old = before.get(id);
    if (!old) changes.push({ id, from: "(new)", to: c.status, message: c.message });
    else if (old.status !== c.status) changes.push({ id, from: old.status, to: c.status, message: c.message });
  }
  for (const [id, c] of before) if (!after.has(id) && !partial) changes.push({ id, from: c.status, to: "(gone)", message: "" });
  return changes;
}
