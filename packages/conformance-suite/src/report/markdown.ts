import { summarizeObservation } from "../observation.js";
import type { Report, ResultStatus, VectorResult } from "./model.js";

const CELL_LIMIT = 200;

/** One table cell: single line, pipes escaped, truncated at 200 characters (the JSON holds the detail). */
export function cell(text: string): string {
  const flat = text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  return flat.length > CELL_LIMIT ? `${flat.slice(0, CELL_LIMIT - 1)}…` : flat;
}

function observedText(result: { observed: VectorResult["observed"]; notes?: string }): string {
  if (result.observed === null) {
    return result.notes ?? "not run";
  }
  return summarizeObservation(result.observed);
}

function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

const ORDER: ResultStatus[] = ["PASS", "FAIL", "WARN", "SKIP", "XFAIL", "XPASS", "ERROR"];

function row(result: VectorResult): string {
  const mark = result.hostSensitive === true ? " (host-sensitive)" : "";
  return `| ${result.id} | ${result.severity} | ${result.attacker} | ${result.runner} | ${result.status}${mark} | ${cell(result.expected)} | ${cell(observedText(result))} | ${Math.round(result.durationMs)} |`;
}

/** The Markdown report. */
export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Datum security check: ${report.verdict}`);
  lines.push(`Suite ${report.suite.version} (vector set ${report.suite.vectorSet}) | ${report.run.startedAt} | ${duration(report.run.durationMs)}`);
  if (report.program !== undefined) {
    const program = report.program;
    const status = program.abiOk ? "OK" : "STALE";
    lines.push(
      `Program: ${program.path} (${program.bytes} B, sha256 ${program.sha256.slice(0, 8)}) ABI detected ${program.detectedAbi ?? "unknown"} / floor ${program.abiFloor} -> ${status}${program.startupError !== null ? ` | startup error: ${cell(program.startupError)}` : ""}`
    );
  }
  if (report.endpoint !== undefined) {
    const endpoint = report.endpoint;
    lines.push(
      `Endpoint: ${endpoint.baseUrl} profile ${endpoint.profile} form ${endpoint.formId} v${endpoint.formVersion} | writes ${endpoint.writes ? "yes" : "no"} | requests ${endpoint.requestsSent}`
    );
  }
  if (report.builder !== undefined) {
    const builder = report.builder;
    lines.push(
      `Builder: ${builder.baseUrl} host ${builder.host} form ${builder.formId} (${builder.mode}) | requests ${builder.requestsSent}, saves ${builder.saves} | cleanup ${builder.cleanup.complete ? "complete" : `INCOMPLETE${builder.cleanup.remedy !== undefined ? ` (${cell(builder.cleanup.remedy)})` : ""}`}`
    );
  }
  if (report.parity !== undefined) {
    const parity = report.parity;
    lines.push(
      `Parity: ${parity.adapters.join(", ")} | corpus ${parity.corpus.core + parity.corpus.adversarial + parity.corpus.suite} | divergences ${parity.divergences.length} (stale ${parity.divergences.filter((entry) => entry.stale).length})`
    );
  }
  if (report.pdf !== undefined) {
    const pdf = report.pdf;
    lines.push(
      `PDF: ${cell(pdf.path)} | ABI ${pdf.abi ?? "unknown"} | ${pdf.pending !== null ? `OUT class PENDING (${cell(pdf.pending)})` : "OUT class ran"} | fonts ${pdf.tools.fonts} | tools pdf.js ${pdf.tools.pdfjs ? "yes" : "NO"}, pdf-lib ${pdf.tools.pdfLib ? "yes" : "NO"}, veraPDF ${pdf.tools.verapdf ? "yes" : "no"}, openssl ${pdf.tools.openssl ? "yes" : "no"}`
    );
  }
  lines.push("");
  if (report.reasons.length > 0) {
    lines.push(`Why: ${report.reasons.join("; ")}`);
    lines.push("");
  }
  lines.push("| Status | Count |");
  lines.push("|---|---|");
  for (const status of ORDER) {
    lines.push(`| ${status} | ${report.summary[status.toLowerCase() as keyof typeof report.summary]} |`);
  }
  lines.push("");

  const header = ["| ID | Sev | Attacker | Runner | Status | Expected | Observed | ms |", "|---|---|---|---|---|---|---|---|"];

  const failures = report.results.filter((result) => result.status === "FAIL" && result.gate === "enforced");
  lines.push("## Failures (enforced)");
  if (failures.length === 0) {
    lines.push("None.");
  } else {
    lines.push(...header, ...failures.map(row));
  }
  lines.push("");

  const warnings = report.results.filter((result) => result.status === "WARN" || result.status === "XPASS" || (result.status === "FAIL" && result.gate !== "enforced"));
  lines.push("## Warnings and promotions (WARN, XPASS)");
  if (warnings.length === 0) {
    lines.push("None.");
  } else {
    lines.push(...header, ...warnings.map((result) => row(result)));
    for (const result of warnings.filter((entry) => entry.status === "XPASS")) {
      lines.push(`- ${result.id} passes although it is blocked by ${result.blockedBy ?? "an open item"}: promote it to enforced.`);
    }
  }
  lines.push("");

  const pending = report.results.filter((result) => result.status === "XFAIL");
  lines.push("## Pending (XFAIL, blocked by open items)");
  if (pending.length === 0) {
    lines.push("None.");
  } else {
    lines.push(...header, ...pending.map(row));
    for (const result of pending) {
      lines.push(`- ${result.id} is blocked by ${result.blockedBy ?? "an open item"}.`);
    }
  }
  lines.push("");

  lines.push("## All results by class");
  const classes = [...new Set(report.results.map((result) => result.class))];
  for (const name of classes) {
    const members = report.results.filter((result) => result.class === name);
    lines.push(`### ${name} (${members.length})`);
    lines.push(...header);
    for (const result of members) {
      lines.push(row(result));
      for (const variant of result.variants ?? []) {
        lines.push(`| ↳ ${variant.id} | | | | ${variant.status} | ${cell(variant.expected)} | ${cell(variant.observed === null ? (variant.notes ?? "") : summarizeObservation(variant.observed))} | |`);
      }
    }
    lines.push("");
  }

  lines.push("## Environment");
  lines.push("```");
  lines.push(`node ${report.environment.node} on ${report.environment.platform}/${report.environment.arch}${report.environment.ci ? " (CI)" : ""}`);
  lines.push(`engine ABI ${report.environment.engine.abi}, commit ${report.environment.engine.commit ?? "unknown"}`);
  lines.push(`quickjs ${report.environment.quickjs.package} (${report.environment.quickjs.variant})`);
  lines.push("```");
  lines.push("");
  return `${lines.join("\n")}`;
}
