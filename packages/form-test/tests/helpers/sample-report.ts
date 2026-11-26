/**
 * A hand-built report for the renderers' tests: two forms, every scenario status, a
 * source with two parse problems, coverage with tested and untested rules, and characters that
 * XML must escape in a scenario name and in a message. Counts are consistent with the contents
 * (the summaries add up), so a test can compare what a renderer counted with `report.summary`.
 *
 * A function, so each test gets its own copy to change.
 */
import type { FormTestProblem, FormTestScenarioResult, FormTestStepResult } from "@argusvane/datum-engine/form-tests";

import type { CoverageRule, FormReport, ProblemReport, Report, ScenarioReport, SourceReport } from "../../src/report/model.js";
import { problemMessage } from "../../src/report/words.js";

export const SAMPLE_STARTED_AT = "2026-10-24T12:00:00.000Z";

/** The scenario name that needs XML escaping (and Markdown escaping, with its pipe). */
export const AWKWARD_NAME = `a < b & "quoted" 'single' | c`;

/** The message text that needs XML escaping: it reaches the report through an `expect.message` step. */
export const AWKWARD_MESSAGE = `Enter <your> name & "email"`;

function result(name: string, status: FormTestScenarioResult["status"], steps: FormTestStepResult[], reason?: string): FormTestScenarioResult {
  return reason === undefined ? { name, status, steps } : { name, status, reason, steps };
}

function problem(line: number, start: number, code: FormTestProblem["code"], params?: Record<string, string | number>): ProblemReport {
  const base: FormTestProblem = params === undefined ? { code, line, start, end: start + 4 } : { code, line, start, end: start + 4, params };
  return { ...base, message: problemMessage(base) };
}

function rule(id: string, kind: string, target: string, formula: string, sentence: string, scenarios: string[]): CoverageRule {
  return {
    id,
    kind,
    ruleKey: kind === "show" ? "visibleWhen" : "rule",
    target: { id: target, label: target, type: "text" },
    formula,
    sentence,
    scenarios
  };
}

export function sampleReport(): Report {
  const adult = "adult sees the licence field";
  const total = "total must be positive";
  const host = "needs a host role";
  const clock = "clock rule without today";

  const passedScenario: ScenarioReport = {
    name: adult,
    source: { kind: "definition", id: "t1" },
    line: 1,
    status: "passed",
    sides: {
      runtime: result(adult, "passed", [{ line: 2, status: "ran" }, { line: 3, status: "passed" }]),
      kernel: result(adult, "passed", [{ line: 2, status: "ran" }, { line: 3, status: "passed" }])
    },
    parity: { status: "agree", lines: [] },
    durationMs: 12.5
  };

  // Two failing steps, alike on both sides, so each is one finding.
  const failingSteps: FormTestStepResult[] = [
    { line: 3, status: "ran" },
    { line: 4, status: "failed", code: "expect.value", expected: 1, actual: 0, params: { path: "total", op: "eq" } },
    { line: 6, status: "ran" },
    { line: 7, status: "failed", code: "expect.message", expected: AWKWARD_MESSAGE, actual: [], params: { path: "email" } }
  ];
  const failedScenario: ScenarioReport = {
    name: total,
    source: { kind: "definition", id: "t2" },
    line: 1,
    status: "failed",
    sides: { runtime: result(total, "failed", failingSteps), kernel: result(total, "failed", failingSteps) },
    parity: { status: "agree", lines: [] },
    durationMs: 8
  };

  const skippedScenario: ScenarioReport = {
    name: host,
    source: { kind: "file", path: "forms/extra.datum-test" },
    line: 1,
    status: "skipped",
    sides: {
      runtime: result(host, "skipped", [], "waiting on a host role"),
      kernel: result(host, "skipped", [], "waiting on a host role")
    },
    parity: { status: "one-sided", lines: [] },
    durationMs: 0
  };

  const errorScenario: ScenarioReport = {
    name: clock,
    source: { kind: "file", path: "forms/extra.datum-test" },
    line: 9,
    status: "error",
    sides: {
      runtime: result(clock, "error", [], "scenario.clockUnset"),
      kernel: result(clock, "error", [], "scenario.clockUnset")
    },
    parity: { status: "agree", lines: [] },
    durationMs: 1.25
  };

  const paritySteps = (second: FormTestStepResult["status"]): FormTestStepResult[] => [
    { line: 3, status: "ran" },
    second === "passed"
      ? { line: 4, status: "passed" }
      : { line: 4, status: "failed", code: "expect.visible", expected: true, actual: false, params: { path: "licence" } },
    second === "passed"
      ? { line: 7, status: "passed" }
      : { line: 7, status: "failed", code: "expect.required", expected: true, actual: false, params: { path: "licence" } }
  ];
  const parityScenario: ScenarioReport = {
    name: AWKWARD_NAME,
    source: { kind: "file", path: "forms/extra.datum-test" },
    line: 14,
    status: "parity",
    sides: { runtime: result(AWKWARD_NAME, "passed", paritySteps("passed")), kernel: result(AWKWARD_NAME, "failed", paritySteps("failed")) },
    parity: {
      status: "differ",
      lines: [
        { line: 4, runtime: { status: "passed" }, kernel: { status: "failed", code: "expect.visible", actual: false } },
        { line: 7, runtime: { status: "passed" }, kernel: { status: "failed", code: "expect.required", actual: false } }
      ]
    },
    durationMs: 30
  };

  const mainSources: SourceReport[] = [
    { source: { kind: "definition", id: "t1" }, scenarioNames: [adult], problems: [] },
    { source: { kind: "definition", id: "t2" }, scenarioNames: [total], problems: [] },
    { source: { kind: "file", path: "forms/extra.datum-test" }, scenarioNames: [host, clock, AWKWARD_NAME], problems: [] },
    {
      source: { kind: "file", path: "forms/broken.datum-test" },
      scenarioNames: [],
      problems: [problem(3, 20, "unknownStatement", { word: "expekt" }), problem(8, 71, "expectedPath", { token: "!" })]
    }
  ];

  const main: FormReport = {
    path: "forms/main.json",
    title: "Main form",
    sources: mainSources,
    scenarios: [passedScenario, failedScenario, skippedScenario, errorScenario, parityScenario],
    // The untested rules sit between the tested ones, so the order a renderer gives them is its own.
    coverage: {
      rules: [
        rule("main:licence:visibleWhen", "show", "licence", "age >= 16", "Show licence when age >= 16", [adult]),
        rule("main:total:validate", "validate", "total", "total > 0", "Total must be above zero", []),
        rule("main:email:required", "require", "email", "country = \"CA\"", "Require email when country = CA", [total, AWKWARD_NAME]),
        rule("main:tax:calculate", "calculate", "tax", "total * 0.13", "Tax is 13% of the total", [])
      ],
      tested: 2,
      untested: 2
    },
    summary: { scenarios: 5, passed: 1, failed: 1, skipped: 1, error: 1, parity: 1, problems: 1 }
  };

  const second: FormReport = {
    path: "forms/second.json",
    sources: [{ source: { kind: "definition", id: "only" }, scenarioNames: ["second form works"], problems: [] }],
    scenarios: [
      {
        name: "second form works",
        source: { kind: "definition", id: "only" },
        line: 1,
        status: "passed",
        sides: {
          runtime: result("second form works", "passed", [{ line: 2, status: "passed" }]),
          kernel: result("second form works", "passed", [{ line: 2, status: "passed" }])
        },
        parity: { status: "agree", lines: [] },
        durationMs: 3
      }
    ],
    summary: { scenarios: 1, passed: 1, failed: 0, skipped: 0, error: 0, parity: 0, problems: 0 }
  };

  return {
    tool: { name: "datum-form-test", version: "0.1.0" },
    startedAt: SAMPLE_STARTED_AT,
    durationMs: 1234,
    runner: "both",
    program: { path: "dist/datum-wasm.js", bytes: 123456, sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
    failOn: "failed",
    forms: [main, second],
    summary: { scenarios: 6, passed: 2, failed: 1, skipped: 1, error: 1, parity: 1, problems: 1 },
    verdict: "failed"
  };
}
