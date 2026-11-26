/**
 * The Markdown report: what a person reads in a pull request or a job
 * summary. A table per form first (one row per scenario, one column per side), then the
 * details of everything that did not pass, the parse problems per source, and the coverage
 * table with the untested rules first and bold, because those are what the reader should act on.
 *
 * Deterministic: no clock of its own; `startedAt` and the durations are the report's.
 */
import type { CoverageRule, FormReport, Report, ScenarioReport } from "./model.js";
import type { FormTestScenarioResult } from "@argusvane/datum-engine/form-tests";
import { compactJson, findingsOf, oneLine, problemMessage, sourceLabel, statusWord, stepCellWord } from "./words.js";
import type { Finding } from "./words.js";

const CELL_LIMIT = 200;

/** Text that is not Markdown: the characters that would open emphasis, code, links or a table cell are escaped. */
export function escapeMarkdown(text: string): string {
  // Everything escaped here lands inline (a heading, an italic line, a cell): a line break in it
  // would end the heading or the row, so it goes first.
  return oneLine(text).replace(/[\\|*_`<>[\]]/g, (character) => `\\${character}`);
}

/** One table cell: a single line, cut at 200 characters (the JSON report holds the whole), escaped. */
export function cell(text: string): string {
  const flat = oneLine(text);
  return escapeMarkdown(flat.length > CELL_LIMIT ? `${flat.slice(0, CELL_LIMIT - 1)}…` : flat);
}

function duration(milliseconds: number): string {
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)} s` : `${Math.round(milliseconds)} ms`;
}

function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What one side came to, for the scenario table: its status, and the reason when it skipped or errored. */
function sideCell(result: FormTestScenarioResult | undefined): string {
  if (result === undefined) {
    return "-";
  }
  return cell(result.reason === undefined ? result.status : `${result.status} (${result.reason})`);
}

function sidesWord(finding: Finding): string {
  return finding.sides.length > 1 ? "both" : (finding.sides[0] ?? "-");
}

function optionalJson(value: unknown): string {
  return value === undefined ? "-" : cell(compactJson(value));
}

function findingsTable(findings: Finding[]): string[] {
  const lines = ["| Side | Line | Message | Expected | Actual |", "|---|---|---|---|---|"];
  for (const finding of findings) {
    lines.push(
      `| ${sidesWord(finding)} | ${finding.line === undefined ? "-" : finding.line} | ${cell(finding.message)} | ${optionalJson(finding.expected)} | ${optionalJson(finding.actual)} |`
    );
  }
  return lines;
}

function scenarioDetails(scenario: ScenarioReport): string[] {
  const lines = [`#### ${escapeMarkdown(scenario.name)}`, ""];
  lines.push(`**${statusWord(scenario.status)}** (${escapeMarkdown(sourceLabel(scenario.source))}, line ${scenario.line})`, "");
  if (scenario.status === "parity" && scenario.parity !== undefined) {
    if (scenario.parity.lines.length > 0) {
      lines.push("The runtime and the kernel came to different results on these lines.", "");
      lines.push("| Line | Runtime | Kernel |", "|---|---|---|");
      for (const line of scenario.parity.lines) {
        lines.push(`| ${line.line} | ${cell(stepCellWord(line.runtime))} | ${cell(stepCellWord(line.kernel))} |`);
      }
      lines.push("");
    } else if (scenario.parity.scenario !== undefined) {
      const sides = scenario.parity.scenario;
      lines.push(
        `- runtime: ${cell(sides.runtime.reason === undefined ? sides.runtime.status : `${sides.runtime.status} (${sides.runtime.reason})`)}`,
        `- kernel: ${cell(sides.kernel.reason === undefined ? sides.kernel.status : `${sides.kernel.status} (${sides.kernel.reason})`)}`,
        ""
      );
    }
  }
  const failed = findingsOf(scenario, "failed");
  if (failed.length > 0) {
    lines.push(...findingsTable(failed), "");
  }
  const errors = findingsOf(scenario, "error");
  if (errors.length > 0) {
    lines.push(...findingsTable(errors), "");
  }
  if (scenario.status === "skipped") {
    for (const finding of findingsOf(scenario, "skipped")) {
      lines.push(`- ${sidesWord(finding)}: ${cell(finding.message)}`);
    }
    lines.push("");
  }
  return lines;
}

function coverageLines(form: FormReport): string[] {
  const coverage = form.coverage;
  if (coverage === undefined) {
    return [];
  }
  const lines = ["### Coverage", ""];
  lines.push(`${coverage.tested} of ${plural(coverage.tested + coverage.untested, "rule")} tested, ${coverage.untested} untested.`, "");
  // Untested rules first and bold: the reader acts on those. Each group keeps the model's order.
  const untested = coverage.rules.filter((rule) => rule.scenarios.length === 0);
  const tested = coverage.rules.filter((rule) => rule.scenarios.length > 0);
  const row = (rule: CoverageRule, bold: boolean): string => {
    const name = cell(rule.sentence === "" ? `${rule.kind} ${rule.ruleKey}` : rule.sentence);
    const reached = bold ? "**untested**" : cell(rule.scenarios.join(", "));
    return `| ${bold ? `**${name}**` : name} | ${cell(rule.target.label === "" ? rule.target.id : rule.target.label)} | ${cell(rule.formula)} | ${reached} |`;
  };
  lines.push("| Rule | Target | Formula | Scenarios |", "|---|---|---|---|");
  lines.push(...untested.map((rule) => row(rule, true)), ...tested.map((rule) => row(rule, false)), "");
  return lines;
}

function formLines(form: FormReport): string[] {
  const lines = [`## ${escapeMarkdown(form.path)}`, ""];
  if (form.title !== undefined && form.title !== "") {
    lines.push(`_${escapeMarkdown(form.title)}_`, "");
  }
  if (form.scenarios.length === 0) {
    lines.push("No scenarios.", "");
  } else {
    lines.push("| Scenario | Runtime | Kernel | Result |", "|---|---|---|---|");
    for (const scenario of form.scenarios) {
      lines.push(`| ${cell(scenario.name)} | ${sideCell(scenario.sides.runtime)} | ${sideCell(scenario.sides.kernel)} | ${statusWord(scenario.status)} |`);
    }
    lines.push("");
  }
  for (const source of form.sources) {
    if (source.problems.length === 0) {
      continue;
    }
    lines.push(`### Problems in ${escapeMarkdown(sourceLabel(source.source))}`, "", "| Line | Problem |", "|---|---|");
    for (const problem of source.problems) {
      lines.push(`| ${problem.line} | ${cell(problemMessage(problem))} |`);
    }
    lines.push("");
  }
  const notPassed = form.scenarios.filter((scenario) => scenario.status !== "passed");
  if (notPassed.length > 0) {
    lines.push("### Details", "");
    for (const scenario of notPassed) {
      lines.push(...scenarioDetails(scenario));
    }
  }
  lines.push(...coverageLines(form));
  return lines;
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Datum form tests: ${report.verdict}`, "");
  const program =
    report.program === null
      ? "in-process kernel"
      : `${escapeMarkdown(report.program.path)} (${report.program.bytes} B, sha256 ${report.program.sha256.slice(0, 8)})`;
  lines.push(`Runner ${report.runner} | Program ${program} | Started ${report.startedAt} | ${duration(report.durationMs)} | Fail on ${report.failOn}`, "");
  const summary = report.summary;
  lines.push(
    `${plural(summary.scenarios, "scenario")}: ${summary.passed} passed, ${summary.failed} failed, ${summary.parity} parity, ${summary.error} error, ${summary.skipped} skipped. ${plural(summary.problems, "source")} with problems.`,
    ""
  );
  for (const form of report.forms) {
    lines.push(...formLines(form));
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
