import { randomUUID } from "node:crypto";

import { CASES } from "./cases/index.js";
import type { CaseResult, CapabilitySummary, HostVerdict, ProbeResult, RunOutcome } from "./runner.js";
import type { HostTarget } from "./target.js";
import { CASE_SET_ID, KIT_NAME, KIT_VERSION } from "./version.js";

/**
 * The host check's report: report.json and report.md under --out, shaped as the security suite's
 * (schemaVersion, suite, run, environment, a section for what was tested, summary, verdict, reasons,
 * results). The differences: the
 * section is `host`, each result names its capability and its Java oracle, the statuses are PASS,
 * FAIL and SKIP (the other summary keys stay 0), and the verdict adds UNEXERCISED (exit 2: a named
 * capability asserted nothing). Header values are never written: only their names.
 */
export interface HostCheckReport {
  schemaVersion: 1;
  suite: { name: string; version: string; command: string; caseSet: string; caseCount: number };
  run: { id: string; startedAt: string; finishedAt: string; durationMs: number; modes: ["host"]; argv: string[] };
  environment: { node: string; platform: string; arch: string; ci: boolean };
  host: {
    baseUrl: string;
    capabilities: string[];
    paths: { api: string; assets: string; tsa: string; webAuthn: string };
    builderEnabled: boolean;
    pdfSigning: boolean;
    pdfBindings: boolean;
    signingForm: string | null;
    buildForm: string | null;
    headerNames: { all: string[]; person: string[]; otherPerson: string[] };
    csrf: { cookie: string; header: string } | null;
    timeoutMs: number;
    requestsSent: number;
    preflight: { ok: boolean; probes: ProbeResult[] };
  };
  capabilities: CapabilitySummary[];
  summary: { pass: number; fail: number; warn: number; skip: number; xfail: number; xpass: number; error: number };
  verdict: HostVerdict;
  exitCode: number;
  reasons: string[];
  results: (Omit<CaseResult, "exchanges"> & { runner: "host"; exchanges: CaseResult["exchanges"] })[];
}

export function buildReport(target: HostTarget, outcome: RunOutcome, argv: readonly string[]): HostCheckReport {
  const count = (status: CaseResult["status"]): number => outcome.results.filter((result) => result.status === status).length;
  return {
    schemaVersion: 1,
    suite: { name: "@argusvane/datum-conformance-suite", version: KIT_VERSION, command: KIT_NAME, caseSet: CASE_SET_ID, caseCount: CASES.length },
    run: {
      id: randomUUID(),
      startedAt: outcome.startedAt.toISOString(),
      finishedAt: outcome.finishedAt.toISOString(),
      durationMs: Math.round(outcome.durationMs),
      modes: ["host"],
      argv: redactArgv(argv)
    },
    environment: { node: process.version, platform: process.platform, arch: process.arch, ci: Boolean(process.env["CI"]) },
    host: {
      baseUrl: target.baseUrl,
      capabilities: [...target.capabilities],
      paths: { api: target.apiPath, assets: target.assetsPath, tsa: target.tsaPath, webAuthn: target.webAuthnPath },
      builderEnabled: target.builderEnabled,
      pdfSigning: target.pdfSigning,
      pdfBindings: target.pdfBindings,
      signingForm: target.signingForm ?? null,
      buildForm: target.buildForm ?? null,
      headerNames: { all: Object.keys(target.headers), person: Object.keys(target.personHeaders), otherPerson: Object.keys(target.otherPersonHeaders) },
      csrf: target.csrf ?? null,
      timeoutMs: target.timeoutMs,
      requestsSent: outcome.requestsSent,
      preflight: outcome.preflight
    },
    capabilities: outcome.capabilities,
    summary: { pass: count("PASS"), fail: count("FAIL"), warn: 0, skip: count("SKIP"), xfail: 0, xpass: 0, error: 0 },
    verdict: outcome.verdict,
    exitCode: outcome.exitCode,
    reasons: outcome.reasons,
    results: outcome.results.map((result) => ({ ...result, durationMs: Math.round(result.durationMs), runner: "host" as const }))
  };
}

export function renderReportJson(report: HostCheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Header values never go into a report: `--header Name=secret` keeps the name only, as the suite's redactArgv does. */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  const flags = new Set(["--header", "--person-header", "--other-person-header"]);
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] as string;
    const inline = /^(--(?:header|person-header|other-person-header))=(.*)$/.exec(arg);
    if (inline !== null) {
      out.push(`${inline[1]}=${nameOnly(inline[2] as string)}`);
      continue;
    }
    if (flags.has(arg)) {
      out.push(arg);
      const value = argv[at + 1];
      if (value !== undefined) {
        out.push(nameOnly(value));
        at += 1;
      }
      continue;
    }
    const property = /^(datum\.tck\.(?:header|person\.header|other-person\.header)\.[^=]+)=/.exec(arg);
    if (property !== null) {
      out.push(`${property[1]}=<redacted>`);
      continue;
    }
    out.push(arg);
  }
  return out;
}

function nameOnly(value: string): string {
  const at = value.search(/[=:]/);
  return at > 0 ? `${value.slice(0, at)}=<redacted>` : "<redacted>";
}

const CELL_LIMIT = 200;

function cell(text: string): string {
  const flat = text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  return flat.length > CELL_LIMIT ? `${flat.slice(0, CELL_LIMIT - 1)}…` : flat;
}

function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

const HEADER = ["| ID | Title | Status | Expected | Observed | ms |", "|---|---|---|---|---|---|"];

function row(result: HostCheckReport["results"][number]): string {
  return `| ${result.id} | ${cell(result.title)} | ${result.status} | ${cell(result.expected)} | ${cell(result.observed)} | ${result.durationMs} |`;
}

/** The Markdown report. */
export function renderReportMarkdown(report: HostCheckReport): string {
  const lines: string[] = [];
  lines.push(`# Datum host check: ${report.verdict}`);
  lines.push(`Kit ${report.suite.version} (case set ${report.suite.caseSet}) | ${report.run.startedAt} | ${duration(report.run.durationMs)} | exit ${report.exitCode}`);
  const host = report.host;
  lines.push(
    `Host: ${host.baseUrl} | capabilities ${host.capabilities.join(", ")} | api ${host.paths.api}, assets ${host.paths.assets} | builder ${host.builderEnabled ? "on" : "off"} | pdf signing ${host.pdfSigning ? "yes" : "no"} | csrf ${host.csrf !== null ? `${host.csrf.cookie} -> ${host.csrf.header}` : "none"} | requests ${host.requestsSent}`
  );
  lines.push("");
  if (report.reasons.length > 0) {
    lines.push(`Why: ${report.reasons.join("; ")}`);
    lines.push("");
  }
  lines.push("## Preflight");
  if (host.preflight.probes.length === 0) lines.push("No probe ran.");
  for (const probe of host.preflight.probes) lines.push(`- ${probe.id}: ${probe.status.toUpperCase()} ${probe.message}`);
  lines.push("");
  lines.push("| Status | Count |");
  lines.push("|---|---|");
  for (const status of ["PASS", "FAIL", "SKIP"] as const) {
    lines.push(`| ${status} | ${report.summary[status.toLowerCase() as "pass" | "fail" | "skip"]} |`);
  }
  lines.push("");
  lines.push("## Capabilities");
  lines.push("| Capability | Pass | Fail | Skip | Exercised |");
  lines.push("|---|---|---|---|---|");
  for (const summary of report.capabilities) {
    lines.push(`| ${summary.capability} | ${summary.pass} | ${summary.fail} | ${summary.skip} | ${summary.exercised ? "yes" : "NO"} |`);
  }
  lines.push("");
  const failures = report.results.filter((result) => result.status === "FAIL");
  lines.push("## Failures");
  if (failures.length === 0) {
    lines.push("None.");
  } else {
    lines.push(...HEADER, ...failures.map(row));
    for (const failure of failures) {
      lines.push("");
      lines.push(`### ${failure.id} ${failure.title}`);
      lines.push(`Oracle: ${failure.oracle}`);
      lines.push("```");
      lines.push(failure.observed);
      for (const exchange of failure.exchanges) {
        lines.push(`${exchange.method} ${exchange.path} (${exchange.who}) -> ${exchange.status} ${exchange.contentType} ${Math.round(exchange.elapsedMs)} ms${exchange.problems.length > 0 ? ` [${exchange.problems.join("; ")}]` : ""}`);
        if (exchange.excerpt !== "") lines.push(`  ${exchange.excerpt}`);
      }
      lines.push("```");
    }
  }
  lines.push("");
  const skipped = report.results.filter((result) => result.status === "SKIP");
  lines.push("## Skipped (assumptions)");
  lines.push(skipped.length === 0 ? "None." : skipped.map((result) => `- ${result.id} ${result.title}: ${result.observed}`).join("\n"));
  lines.push("");
  lines.push("## All results by capability");
  for (const summary of report.capabilities) {
    const members = report.results.filter((result) => result.capability === summary.capability);
    lines.push(`### ${summary.capability} (${members.length})`);
    if (members.length === 0) {
      lines.push(host.preflight.ok ? "No case ran (the kit has no case for it yet, or the filters left none)." : "Not run: the preflight stopped the run.");
    } else {
      lines.push(...HEADER, ...members.map(row));
    }
    lines.push("");
  }
  lines.push("## Environment");
  lines.push("```");
  lines.push(`node ${report.environment.node} on ${report.environment.platform}/${report.environment.arch}${report.environment.ci ? " (CI)" : ""}`);
  lines.push(`argv ${report.run.argv.join(" ")}`);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
