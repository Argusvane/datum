import { describe, expect, it } from "vitest";

import { kernelParseFormTests } from "@argusvane/datum-engine/form-tests";
import { formulaFunctionSignatures } from "@argusvane/datum-engine/core";
import type { FormDefinition } from "@argusvane/datum-engine/core";

import type { FormTestsInput } from "../src/api.js";
import { EXIT } from "../src/exit-codes.js";
import { InputError, loadDefinitionFile, loadTestFile } from "../src/load.js";
import type { Report, ScenarioReport } from "../src/report/model.js";
import { exitCodeOf, runFormTests, runScenarioOnSides, sidesOf, summarize, verdictOf } from "../src/run.js";
import { fixture } from "./helpers/paths.js";
import { builtProgramText } from "./helpers/programs.js";

const STARTED_AT = "2026-10-24T00:00:00.000Z";
const fixedClock = (): (() => number) => {
  let tick = 0;
  return () => (tick += 1);
};

function run(inputs: FormTestsInput[], extra: Partial<Parameters<typeof runFormTests>[0]> = {}): Promise<Report> {
  return runFormTests({ inputs, runner: "both", coverage: false, failOn: "failed", startedAt: STARTED_AT, now: fixedClock(), ...extra });
}

function statuses(report: Report): Record<string, string> {
  return Object.fromEntries(report.forms.flatMap((form) => form.scenarios.map((scenario) => [scenario.name, scenario.status])));
}

function plainForm(tests?: string[]): FormDefinition {
  return {
    id: "plain",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: { label: "Plain form" },
      children: { content: [{ id: "name", type: "text", configuration: { label: "Name", required: true } }] }
    },
    ...(tests !== undefined ? { tests: { scenarios: tests.map((source, index) => ({ id: `t${index + 1}`, source })) } } : {})
  } as unknown as FormDefinition;
}

describe("runFormTests over the fixture forms", () => {
  it("passes every scenario of the two fixture forms on both sides", async () => {
    const report = await run([loadDefinitionFile(fixture("main.json")), loadDefinitionFile(fixture("clock.json"))]);
    const all = report.forms.flatMap((form) => form.scenarios);
    expect(all.length).toBeGreaterThan(10);
    for (const scenario of all) {
      expect(scenario.status, `${scenario.name}: ${JSON.stringify(scenario.sides)} ${JSON.stringify(scenario.parity)}`).toBe("passed");
      expect(Object.keys(scenario.sides).sort()).toEqual(["kernel", "runtime"]);
      expect(scenario.parity?.status).toMatch(/^(agree|one-sided)$/);
    }
    expect(report.verdict).toBe("passed");
    expect(exitCodeOf(report)).toBe(EXIT.passed);
    expect(report).toMatchObject({ tool: { name: "datum-form-test", version: "0.1.0" }, startedAt: STARTED_AT, runner: "both", program: null, failOn: "failed" });
    expect(report.forms.map((form) => form.title)).toEqual(["Form tests fixture", undefined]);
    // The sidecar beside main.json ran after the stored scenarios, as a file source.
    const sidecar = report.forms[0]?.scenarios.at(-1) as ScenarioReport;
    expect(sidecar.source).toEqual({ kind: "file", path: fixture("main.datum-test") });
    expect(sidecar.line).toBe(1);
    expect(report.forms[0]?.sources.map((source) => source.source.kind)).toEqual([...Array(report.forms[0]!.sources.length - 1).fill("definition"), "file"]);
    expect(report.summary).toEqual(summarize(all, report.forms.flatMap((form) => form.sources)));
    expect(report.summary.passed).toBe(all.length);
    // The fixed clock: every duration is a whole number of ticks.
    expect(all.every((scenario) => scenario.durationMs > 0 && Number.isInteger(scenario.durationMs))).toBe(true);
  });

  it("fails a run with the deliberate failure: one scenario failed, verdict failed, exit 1", async () => {
    const input = loadDefinitionFile(fixture("main.json"));
    input.sources.push(loadTestFile(fixture("failing.datum-test")));
    const report = await run([input]);
    const failed = report.forms[0]!.scenarios.filter((scenario) => scenario.status === "failed");
    expect(failed.map((scenario) => scenario.name)).toEqual(["a deliberate failure: the name is not optional"]);
    expect(failed[0]?.sides.runtime?.status).toBe("failed");
    expect(failed[0]?.sides.kernel?.status).toBe("failed");
    expect(failed[0]?.parity?.status).toBe("agree");
    expect(report.summary.failed).toBe(1);
    expect(report.verdict).toBe("failed");
    expect(exitCodeOf(report)).toBe(EXIT.failed);
  });

  it("runs the kernel side alone with --runner kernel", async () => {
    const report = await run([loadDefinitionFile(fixture("clock.json"))], { runner: "kernel" });
    const scenarios = report.forms[0]!.scenarios;
    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) {
      expect(Object.keys(scenario.sides)).toEqual(["kernel"]);
      expect(scenario.parity).toBeUndefined();
      expect(scenario.status).toBe("passed");
    }
    expect(report.runner).toBe("kernel");
    expect(report.verdict).toBe("passed");
  });

  it("is inconclusive when a form has no tests, exit 3", async () => {
    const report = await run([{ definition: plainForm(), path: "plain.json", sources: [] }]);
    expect(report.forms[0]).toMatchObject({ path: "plain.json", title: "Plain form", sources: [], scenarios: [] });
    expect(report.verdict).toBe("inconclusive");
    expect(exitCodeOf(report)).toBe(EXIT.inconclusive);
  });

  it("is inconclusive when every scenario is skipped", async () => {
    const report = await run([{ definition: plainForm(['test "later"\n  skip "not yet"\n  expect name visible']), path: "plain.json", sources: [] }]);
    expect(statuses(report)).toEqual({ later: "skipped" });
    expect(report.verdict).toBe("inconclusive");
  });

  it("fails a run whose source does not parse, with the problem worded, and runs nothing from that source", async () => {
    const report = await run([
      {
        definition: plainForm(['test "fine"\n  expect name visible']),
        path: "plain.json",
        sources: [{ path: "broken.datum-test", text: 'test "broken"\n  expect name sideways' }]
      }
    ]);
    const form = report.forms[0]!;
    expect(statuses(report)).toEqual({ fine: "passed" });
    const broken = form.sources.find((source) => source.source.kind === "file")!;
    expect(broken.scenarioNames).toEqual([]);
    expect(broken.problems.length).toBeGreaterThan(0);
    expect(broken.problems[0]).toMatchObject({ line: 2 });
    expect(broken.problems[0]?.message).toBeTypeOf("string");
    expect(broken.problems[0]?.message.length).toBeGreaterThan(5);
    expect(report.summary.problems).toBe(1);
    expect(report.verdict).toBe("failed");
    expect(exitCodeOf(report)).toBe(EXIT.failed);
  });

  it("reports a name the definition already used as duplicateName on the file, and still runs both", async () => {
    const report = await run([
      {
        definition: plainForm(['test "same"\n  expect name visible']),
        path: "plain.json",
        sources: [{ path: "more.datum-test", text: '# a comment first\ntest "same"\n  expect name required' }]
      }
    ]);
    const form = report.forms[0]!;
    expect(form.scenarios.map((scenario) => [scenario.name, scenario.status, scenario.source.kind])).toEqual([
      ["same", "passed", "definition"],
      ["same", "passed", "file"]
    ]);
    expect(form.scenarios[1]?.line).toBe(2);
    const file = form.sources.find((source) => source.source.kind === "file")!;
    expect(file.scenarioNames).toEqual(["same"]);
    expect(file.problems).toMatchObject([{ code: "duplicateName", line: 2, params: { name: "same" } }]);
    expect(file.problems[0]?.message).toBeTypeOf("string");
    expect(report.verdict).toBe("failed");
  });

  it("computes coverage when asked, and fails on an untested rule under failOn untested", async () => {
    const definition = plainForm(['test "fine"\n  expect name visible']);
    (definition.root.children as unknown as { content: unknown[] }).content.push({ id: "extra", type: "text", configuration: { label: "Extra" }, rules: { visibleWhen: "name = \"x\"" } });
    const input: FormTestsInput = { definition, path: "plain.json", sources: [] };
    const listed = await run([input], { coverage: true });
    expect(listed.forms[0]?.coverage?.untested).toBeGreaterThan(0);
    expect(listed.verdict).toBe("passed");
    const strict = await run([input], { failOn: "untested" });
    expect(strict.forms[0]?.coverage).toBeDefined();
    expect(strict.verdict).toBe("failed");
    const none = await run([input]);
    expect(none.forms[0]?.coverage).toBeUndefined();
  });

  // The kernel driver takes `signatures` as the whole table, so a list given
  // alone (the vitest helper always gives one) would hide today() and age() from the kernel only.
  it("keeps the built-in functions on the kernel side when signatures are given", async () => {
    const clock = loadDefinitionFile(fixture("clock.json"));
    for (const extra of [{ signatures: [] }, { signatures: [{ name: "double", min: 1, max: 1 }], functions: { double: (args: unknown[]) => Number(args[0]) * 2 } }]) {
      const report = await run([clock], extra);
      for (const scenario of report.forms[0]!.scenarios) {
        expect(scenario.status, `${scenario.name}: ${JSON.stringify(scenario.sides)}`).toBe("passed");
      }
      expect(report.verdict).toBe("passed");
    }
  });

  // A script that evaluates but is not a validation program (the PDF kernel's
  // file, say) is the input's fault, not a parity finding on every scenario.
  it("refuses a program that has no sandbox entry point as an input error", async () => {
    const input = loadDefinitionFile(fixture("main.json"));
    await expect(run([input], { program: { path: "noop.js", text: "var x = 1;" } })).rejects.toThrow(InputError);
    await expect(run([input], { program: { path: "noop.js", text: "var x = 1;" } })).rejects.toThrow(/noop\.js is not a validation program/);
    const accepted = await run([input], { program: { path: "program.js", text: builtProgramText() }, runner: "kernel" });
    expect(accepted.verdict).toBe("passed");
  }, 60_000);

  // The runtime side never loads a program, so the report must not claim one.
  it("records no program when the kernel side did not run", async () => {
    const report = await run([loadDefinitionFile(fixture("main.json"))], { runner: "runtime", program: { path: "never-loaded.js", text: "var x = 1;" } });
    expect(report.program).toBeNull();
    expect(report.verdict).toBe("passed");
  });

  // The Logic model reads the whole tree and throws on what the loader let by.
  it("reads a definition the Logic model cannot read as an input error under coverage", async () => {
    const definition = plainForm(['test "fine"\n  expect name visible']);
    (definition.root.children as unknown as { content: unknown[] }).content.push(null);
    const input: FormTestsInput = { definition, path: "weird.json", sources: [] };
    await expect(run([input], { coverage: true })).rejects.toThrow(InputError);
    await expect(run([input], { coverage: true })).rejects.toThrow(/weird\.json/);
  });
});

describe("runScenarioOnSides", () => {
  const scenario = kernelParseFormTests('test "one"\n  expect name required', formulaFunctionSignatures()).scenarios[0]!;

  it("plays the scenario on each side asked for", async () => {
    expect(sidesOf("both")).toEqual(["runtime", "kernel"]);
    expect(sidesOf("runtime")).toEqual(["runtime"]);
    const results = await runScenarioOnSides(plainForm(), scenario, sidesOf("both"), {});
    expect(results.runtime?.status).toBe("passed");
    expect(results.kernel?.status).toBe("passed");
  });

  it("reports a side whose driver cannot be made as scenario.driverFailed", async () => {
    // A definition the drivers cannot read at all: no root to index.
    const results = await runScenarioOnSides({ id: "x" } as unknown as FormDefinition, scenario, sidesOf("both"), {});
    for (const side of ["runtime", "kernel"] as const) {
      expect(results[side]).toMatchObject({ name: "one", status: "error", reason: "scenario.driverFailed", steps: [] });
    }
  });
});

describe("verdictOf and exitCodeOf", () => {
  const base = (summary: Partial<Report["summary"]>): Omit<Report, "verdict"> => ({
    tool: { name: "datum-form-test", version: "0.1.0" },
    startedAt: STARTED_AT,
    durationMs: 0,
    runner: "both",
    program: null,
    failOn: "failed",
    forms: [],
    summary: { scenarios: 0, passed: 0, failed: 0, skipped: 0, error: 0, parity: 0, problems: 0, ...summary }
  });

  it.each<[Partial<Report["summary"]>, Report["verdict"], number]>([
    [{ scenarios: 1, passed: 1 }, "passed", 0],
    [{ scenarios: 2, passed: 1, skipped: 1 }, "passed", 0],
    [{ scenarios: 2, passed: 1, failed: 1 }, "failed", 1],
    [{ scenarios: 2, passed: 1, error: 1 }, "failed", 1],
    [{ scenarios: 2, passed: 1, parity: 1 }, "failed", 1],
    [{ scenarios: 1, passed: 1, problems: 1 }, "failed", 1],
    [{ scenarios: 0 }, "inconclusive", 3],
    [{ scenarios: 2, skipped: 2 }, "inconclusive", 3],
    [{ problems: 1 }, "failed", 1]
  ])("%j is %s (exit %d)", (summary, verdict, exit) => {
    const report = base(summary);
    expect(verdictOf(report)).toBe(verdict);
    expect(exitCodeOf({ ...report, verdict: verdictOf(report) })).toBe(exit);
  });
});
