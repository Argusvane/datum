import { describe, expect, it } from "vitest";

import { parseArgs, UsageError, USAGE } from "../src/args.js";

describe("argument parsing", () => {
  it.each<[string[], Record<string, unknown>]>([
    [["a.json"], { command: "run", definitions: ["a.json"], tests: [], runner: "both", reports: ["md"], coverage: false, failOn: "failed" }],
    [["a.json", "b.json"], { definitions: ["a.json", "b.json"] }],
    [["a.json", "--tests", "x.datum-test", "--tests=y.datum-test"], { tests: ["x.datum-test", "y.datum-test"] }],
    [["a.json", "--runner", "kernel"], { runner: "kernel" }],
    [["a.json", "--runner=runtime"], { runner: "runtime" }],
    [["a.json", "--program", "p.js"], { program: "p.js" }],
    [["a.json", "--runner", "kernel", "--program", "p.js"], { runner: "kernel", program: "p.js" }],
    [["a.json", "--report", "json,junit"], { reports: ["json", "junit"] }],
    [["a.json", "--report", "junit", "--report=json", "--report", "junit"], { reports: ["junit", "json"] }],
    [["a.json", "--out", "out"], { out: "out" }],
    [["a.json", "--coverage"], { coverage: true, failOn: "failed" }],
    [["a.json", "--fail-on", "untested"], { coverage: true, failOn: "untested" }],
    [["a.json", "--fail-on=failed"], { coverage: false, failOn: "failed" }],
    [["--help"], { command: "help" }],
    [["-h"], { command: "help" }],
    [["--version"], { command: "version" }],
    [["a.json", "--help"], { command: "help", definitions: ["a.json"] }]
  ])("reads %j", (argv, expected) => {
    expect(parseArgs(argv)).toMatchObject(expected);
  });

  it.each<[string[], RegExp]>([
    [[], /at least one definition/],
    [["--coverage"], /at least one definition/],
    [["a.json", "--nope"], /unknown option --nope/],
    [["a.json", "-x"], /unknown option -x/],
    [["a.json", "--out"], /--out needs a value/],
    [["a.json", "--out="], /--out needs a value/],
    [["a.json", "--out", "--coverage"], /--out needs a value/],
    [["a.json", "--runner", "server"], /--runner is runtime, kernel or both/],
    [["a.json", "--report", "pdf"], /--report is json, junit or md, not "pdf"/],
    [["a.json", "--report", "json,html"], /not "html"/],
    [["a.json", "--report", ","], /--report needs a value/],
    [["a.json", "--fail-on", "warn"], /--fail-on is failed or untested/],
    [["a.json", "--coverage=yes"], /--coverage takes no value/],
    [["--tests", "x.datum-test"], /at least one definition/],
    [["a.json", "b.json", "--tests", "x.datum-test"], /--tests needs exactly one definition, not 2/],
    [["a.json", "--runner", "runtime", "--program", "p.js"], /--program is the kernel side's program/]
  ])("refuses %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it("documents every flag and the exit codes in the usage text", () => {
    for (const flag of ["--tests", "--runner", "--program", "--report", "--out", "--coverage", "--fail-on", "--help", "--version"]) {
      expect(USAGE).toContain(flag);
    }
    expect(USAGE).toContain("Exit codes");
  });
});
