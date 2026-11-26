/**
 * The `datum-form-test` command as a function: arguments in, an exit
 * code out, never a throw, so the bundle's entry is one line and a test runs the whole command in
 * process. The run itself is `runFormTests`; this file reads the inputs, picks the reports and
 * says where they went.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { FormTestsInput, ProgramInput } from "./api.js";
import { parseArgs, UsageError, USAGE, type CliOptions, type ReportFormat } from "./args.js";
import { EXIT, type ExitCode } from "./exit-codes.js";
import { InputError, loadDefinitionFile, loadProgramFile, loadTestFile } from "./load.js";
import { renderJson } from "./report/json.js";
import { renderJunit } from "./report/junit.js";
import { renderMarkdown } from "./report/markdown.js";
import type { Report, RunnerId, ScenarioReport } from "./report/model.js";
import { oneLine, problemMessage, sourceLabel, statusWord } from "./report/words.js";
import { exitCodeOf, runFormTests, sidesOf } from "./run.js";
import { TOOL_NAME, TOOL_VERSION } from "./version.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processIo: CliIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text)
};

const FILE_NAMES: Record<ReportFormat, string> = { json: "form-tests.json", junit: "form-tests.xml", md: "form-tests.md" };

function render(format: ReportFormat, report: Report): string {
  return format === "json" ? renderJson(report) : format === "junit" ? renderJunit(report) : renderMarkdown(report);
}

/** The whole command line. Never throws: a usage or input error is exit 2, anything else exit 4 with the stack. */
export async function runCli(argv: readonly string[], io: CliIo = processIo): Promise<ExitCode> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${TOOL_NAME}: ${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    if (error instanceof InputError) {
      io.stderr(`${TOOL_NAME}: ${error.message}\n`);
      return EXIT.usage;
    }
    io.stderr(`${TOOL_NAME}: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return EXIT.internal;
  }
}

async function dispatch(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  const options = parseArgs(argv);
  switch (options.command) {
    case "help":
      io.stdout(USAGE);
      return EXIT.passed;
    case "version":
      io.stdout(`${TOOL_NAME} ${TOOL_VERSION}\n`);
      return EXIT.passed;
    case "run":
      return run(options, io);
  }
}

/** Every input read before anything runs, so a missing file is exit 2 with no half-run report. */
function inputsOf(options: CliOptions): { inputs: FormTestsInput[]; program?: ProgramInput } {
  const inputs = options.definitions.map((path) => loadDefinitionFile(path));
  if (options.tests.length > 0) {
    // parseArgs allows --tests with exactly one definition; they follow its sidecar.
    const first = inputs[0] as FormTestsInput;
    // Naming the sidecar again would read it twice and fail the run on every scenario's name.
    const read = new Set(first.sources.map((source) => resolve(source.path)));
    for (const path of options.tests) {
      if (!read.has(resolve(path))) {
        read.add(resolve(path));
        first.sources.push(loadTestFile(path));
      }
    }
  }
  if (options.out !== undefined) {
    // Found here, before any scenario runs, so an unwritable folder costs no run.
    makeOutFolder(options.out);
  }
  return options.program === undefined ? { inputs } : { inputs, program: loadProgramFile(options.program) };
}

async function run(options: CliOptions, io: CliIo): Promise<ExitCode> {
  const { inputs, program } = inputsOf(options);
  // The one wall-clock date of a run: run.ts takes it as given, so its output is reproducible in tests.
  const startedAt = new Date().toISOString();
  const report = await runFormTests({
    inputs,
    runner: options.runner,
    coverage: options.coverage,
    failOn: options.failOn,
    startedAt,
    ...(program !== undefined ? { program } : {})
  });
  if (options.out === undefined) {
    for (const format of options.reports) {
      io.stdout(render(format, report));
    }
    return exitCodeOf(report);
  }
  const written = writeReports(options.out, options.reports, report);
  io.stdout(summaryLines(report).join("\n") + "\n");
  io.stdout(`reports: ${written.join(", ")}\n`);
  return exitCodeOf(report);
}

function makeOutFolder(out: string): void {
  try {
    mkdirSync(out, { recursive: true });
  } catch (error) {
    throw new InputError(`cannot write the reports to ${out}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeReports(out: string, formats: readonly ReportFormat[], report: Report): string[] {
  const written: string[] = [];
  try {
    mkdirSync(out, { recursive: true });
    for (const format of formats) {
      const path = join(out, FILE_NAMES[format]);
      writeFileSync(path, render(format, report));
      written.push(path);
    }
  } catch (error) {
    throw new InputError(`cannot write the reports to ${out}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return written;
}

function sideCell(scenario: ScenarioReport, side: RunnerId): string {
  const result = scenario.sides[side];
  if (result === undefined) {
    return `${side}: not run`;
  }
  return result.reason === undefined ? `${side}: ${result.status}` : `${side}: ${result.status} ${result.reason}`;
}

/** One line per scenario and per source that did not parse, then the totals: what a CI log shows when the reports go to files. */
export function summaryLines(report: Report): string[] {
  const sides = sidesOf(report.runner);
  const lines: string[] = [];
  for (const form of report.forms) {
    for (const source of form.sources) {
      for (const problem of source.problems) {
        lines.push(oneLine(`PROBLEM  ${form.path} › ${sourceLabel(source.source)}:${problem.line} ${problemMessage(problem)}`));
      }
    }
    for (const scenario of form.scenarios) {
      const cells = sides.map((side) => sideCell(scenario, side)).join(", ");
      lines.push(oneLine(`${statusWord(scenario.status)}  ${form.path} › ${scenario.name} (${cells})`));
    }
  }
  const summary = report.summary;
  const counted = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`;
  // An untested rule fails the run under --fail-on untested while every scenario line reads PASS,
  // so the totals say why.
  const untested = report.failOn === "untested" ? report.forms.reduce((total, form) => total + (form.coverage?.untested ?? 0), 0) : 0;
  lines.push(
    `${report.verdict.toUpperCase()}: ${counted(summary.scenarios, "scenario")}, ${summary.passed} passed, ${summary.failed} failed, ${summary.parity} parity, ${summary.error} error, ${summary.skipped} skipped; ${counted(summary.problems, "source")} with problems${untested > 0 ? `; ${counted(untested, "untested rule")}` : ""}`
  );
  return lines;
}
