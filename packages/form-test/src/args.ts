/**
 * The command line's arguments, read into options or refused with a
 * `UsageError` (exit 2). Every flag takes `--flag value` and `--flag=value`, as the conformance
 * suite's do, so a CI step can be written either way.
 */
import type { RunnerChoice } from "./report/model.js";
import { TOOL_NAME } from "./version.js";

export type ReportFormat = "json" | "junit" | "md";

export interface CliOptions {
  command: "help" | "version" | "run";
  /** The definition files, in the order given. */
  definitions: string[];
  /** `.datum-test` files added after the sidecar; only with exactly one definition. */
  tests: string[];
  runner: RunnerChoice;
  /** A sandbox program file the kernel side runs on; absent, the in-process kernel runs. */
  program?: string;
  /** The reports to write, in the order given, each once. */
  reports: ReportFormat[];
  out?: string;
  coverage: boolean;
  failOn: "failed" | "untested";
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const VALUE_FLAGS = new Set(["--tests", "--runner", "--program", "--report", "--out", "--fail-on"]);
const BOOLEAN_FLAGS = new Set(["--coverage", "--help", "-h", "--version"]);
const REPORT_FORMATS: readonly ReportFormat[] = ["json", "junit", "md"];

export const USAGE = `${TOOL_NAME}: runs a Datum form's tests on the browser runtime and the validation kernel

Usage
  ${TOOL_NAME} <definition.json>... [options]

  Each definition's own tests (its "tests" key) run, then the sidecar <stem>.datum-test beside
  it when there is one, then any --tests files.

Options
  --tests <file.datum-test>       more scenarios for the one definition given (repeatable)
  --runner runtime|kernel|both    which side plays each scenario (default both: a scenario the two
                                  sides judge differently is a parity finding)
  --program <file>                the sandbox program the kernel side runs on (default: the
                                  in-process kernel; not with --runner runtime)
  --report json|junit|md          the report formats (repeatable or comma-separated; default md)
  --out <dir>                     write form-tests.json / form-tests.xml / form-tests.md there and
                                  print one line per scenario; without it the reports print
  --coverage                      list every rule and the scenarios that exercise it
  --fail-on failed|untested       untested: an untested rule fails the run too (implies --coverage)
  --help, -h                      this text
  --version                       the version

Exit codes
  0 passed   1 a scenario failed, errored or differed between the sides, a test file did not
  parse, or (with --fail-on untested) a rule is untested   2 usage or input error
  3 inconclusive (no scenario passed: none found, or every one skipped)   4 internal error
`;

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    command: "run",
    definitions: [],
    tests: [],
    runner: "both",
    reports: [],
    coverage: false,
    failOn: "failed"
  };
  let help = false;
  let version = false;
  for (let at = 0; at < argv.length; at += 1) {
    const raw = argv[at] as string;
    if (!raw.startsWith("-") || raw === "-") {
      options.definitions.push(raw);
      continue;
    }
    let flag = raw;
    let inline: string | undefined;
    const equals = raw.startsWith("--") ? raw.indexOf("=") : -1;
    if (equals > 0) {
      flag = raw.slice(0, equals);
      inline = raw.slice(equals + 1);
    }
    if (!VALUE_FLAGS.has(flag) && !BOOLEAN_FLAGS.has(flag)) {
      throw new UsageError(`unknown option ${flag}`);
    }
    let value = "";
    if (VALUE_FLAGS.has(flag)) {
      const next = inline ?? argv[at + 1];
      // A following flag is never taken as a value: `--out --coverage` is a missing value, not a folder.
      if (next === undefined || next === "" || (inline === undefined && next.startsWith("--"))) {
        throw new UsageError(`${flag} needs a value`);
      }
      if (inline === undefined) {
        at += 1;
      }
      value = next;
    } else if (inline !== undefined) {
      throw new UsageError(`${flag} takes no value`);
    }
    switch (flag) {
      case "--tests":
        options.tests.push(value);
        break;
      case "--runner":
        if (value !== "runtime" && value !== "kernel" && value !== "both") {
          throw new UsageError(`--runner is runtime, kernel or both, not "${value}"`);
        }
        options.runner = value;
        break;
      case "--program":
        options.program = value;
        break;
      case "--report": {
        const formats = value.split(",").map((part) => part.trim()).filter((part) => part !== "");
        for (const format of formats) {
          if (!(REPORT_FORMATS as readonly string[]).includes(format)) {
            throw new UsageError(`--report is json, junit or md, not "${format}"`);
          }
          if (!options.reports.includes(format as ReportFormat)) {
            options.reports.push(format as ReportFormat);
          }
        }
        if (formats.length === 0) {
          throw new UsageError("--report needs a value");
        }
        break;
      }
      case "--out":
        options.out = value;
        break;
      case "--fail-on":
        if (value !== "failed" && value !== "untested") {
          throw new UsageError(`--fail-on is failed or untested, not "${value}"`);
        }
        options.failOn = value;
        break;
      case "--coverage":
        options.coverage = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--version":
        version = true;
        break;
      default:
        break;
    }
  }
  if (options.reports.length === 0) {
    options.reports.push("md");
  }
  if (options.failOn === "untested") {
    // An untested rule cannot fail a run that did not look for one.
    options.coverage = true;
  }
  if (help) {
    options.command = "help";
    return options;
  }
  if (version) {
    options.command = "version";
    return options;
  }
  if (options.definitions.length === 0) {
    throw new UsageError("give at least one definition file (a form's JSON)");
  }
  if (options.tests.length > 0 && options.definitions.length !== 1) {
    // A test file names one form's fields; with several definitions it would be read against the wrong ones.
    throw new UsageError(`--tests needs exactly one definition, not ${options.definitions.length}`);
  }
  if (options.program !== undefined && options.runner === "runtime") {
    // The runtime side never loads a sandbox program, so a broken one would pass unseen and the
    // report would name a program nothing ran on.
    throw new UsageError("--program is the kernel side's program; --runner runtime does not run it (use kernel or both)");
  }
  return options;
}
