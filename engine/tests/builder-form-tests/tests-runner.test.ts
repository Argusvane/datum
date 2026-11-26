import { describe, expect, it } from "vitest";

import { createTestsRunner } from "../../form-engine/builder/form-tests/tests-runner.js";
import type { TestsEntryModel, TestsRunner } from "../../form-engine/builder/form-tests/tests-model.js";
import type { FormTestConfiguration, FormTestScenarioResult } from "../../form-engine/core/form-tests/form-test-types.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { defineDataSources } from "../../form-engine/data/host/data-source-set.js";
import {
  FORM_TESTS_CLOCK_FIXTURE,
  FORM_TESTS_FIXTURE,
  FORM_TESTS_FIXTURE_SCENARIOS,
  fixtureWithTests
} from "../form-tests/fixtures/form-tests-fixture.js";

// The runner behind the Tests panel: parsing a `tests` block
// into entries, running them on the browser's runtime one fresh runtime per scenario, cancelling,
// and replaying a scenario up to a step for Show me.

function runnerOver(definition: FormDefinition, extra: Partial<Parameters<typeof createTestsRunner>[0]> = {}): TestsRunner {
  return createTestsRunner({ definition: () => definition, root: () => definition.root, ...extra });
}

function block(...lines: string[]): string {
  return lines.join("\n");
}

function blockOf(entries: Array<[string, string]>): FormTestConfiguration {
  return { scenarios: entries.map(([id, source]) => ({ id, source })) };
}

function mainEntries(): TestsEntryModel[] {
  return runnerOver(FORM_TESTS_FIXTURE).parse(fixtureWithTests("main").tests);
}

describe("parse", () => {
  it("lists every fixture scenario in order, unrun, named by the scenario", () => {
    const entries = mainEntries();
    const expected = FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === "main");
    expect(entries.map((entry) => entry.name)).toEqual(expected.map((entry) => entry.name));
    expect(entries.every((entry) => entry.status === "unrun" && entry.scenario !== undefined && entry.problems.length === 0)).toBe(true);
    expect(entries[0]!.id).toBe("main-1");
  });

  it("is an empty list for an absent block", () => {
    expect(runnerOver(FORM_TESTS_FIXTURE).parse(undefined)).toEqual([]);
  });

  it("marks a source that does not parse invalid, with the parser's problem codes and a name cut from its first line", () => {
    const long = `test "${"a long name ".repeat(10)}" nonsense here`;
    const entries = runnerOver(FORM_TESTS_FIXTURE).parse(
      blockOf([
        ["bad", block('test "broken"', "  frobnicate the thing")],
        ["long", long],
        ["nameless", block("", "  ", "   set x = 1")]
      ])
    );
    expect(entries.map((entry) => entry.status)).toEqual(["invalid", "invalid", "invalid"]);
    expect(entries[0]!.problems.map((problem) => problem.code)).toEqual(["unknownStatement"]);
    expect(entries[0]!.scenario).toBeUndefined();
    expect(entries[0]!.name).toBe('test "broken"');
    expect(entries[1]!.name.length).toBeLessThanOrEqual(60);
    expect(entries[2]!.name).toBe("set x = 1");
  });

  it("answers an empty source with a problem of its own and an empty name, for the panel to word", () => {
    const [entry] = runnerOver(FORM_TESTS_FIXTURE).parse(blockOf([["empty", "  \n  "]]));
    expect(entry!.status).toBe("invalid");
    expect(entry!.problems).toHaveLength(1);
    // No English from the runner: the panel says "Untitled" from its catalog.
    expect(entry!.name).toBe("");
  });

  it("reports a name an earlier entry used on the later entry only, which still runs", () => {
    const entries = runnerOver(FORM_TESTS_FIXTURE).parse(
      blockOf([
        ["a", block('test "same"', "  expect applicant_name visible")],
        ["b", block('test "same"', "  expect applicant_name visible")]
      ])
    );
    expect(entries[0]!.problems).toEqual([]);
    expect(entries[1]!.problems.map((problem) => problem.code)).toEqual(["duplicateName"]);
    expect(entries[1]!.status).toBe("unrun");
    expect(entries[1]!.scenario).toBeDefined();
  });

  it("marks a source of two blocks invalid with a stepOutsideTest on the second header", () => {
    const source = block('test "one"', "  expect applicant_name visible", 'test "two"', "  expect age visible");
    const [entry] = runnerOver(FORM_TESTS_FIXTURE).parse(blockOf([["two-blocks", source]]));
    expect(entry!.status).toBe("invalid");
    expect(entry!.scenario).toBeUndefined();
    const problem = entry!.problems.find((item) => item.code === "stepOutsideTest");
    expect(problem).toBeDefined();
    expect(problem!.line).toBe(3);
    expect(source.slice(problem!.start, problem!.end)).toContain("test");
  });

  it("reads a plugin function's signature, so a formula that calls it parses", () => {
    const source = block('test "plugin"', "  expect shout(applicant_name) = 1");
    const without = runnerOver(FORM_TESTS_FIXTURE).parse(blockOf([["p", source]]));
    expect(without[0]!.status).toBe("invalid");
    const withIt = runnerOver(FORM_TESTS_FIXTURE, { signatures: () => [{ name: "shout", min: 1, max: 1 }] }).parse(blockOf([["p", source]]));
    expect(withIt[0]!.status).toBe("unrun");
  });
});

describe("run", () => {
  it("matches the fixture's expected browser statuses and calls onProgress once per entry", async () => {
    const runner = runnerOver(fixtureWithTests("main"));
    const entries = runner.parse(fixtureWithTests("main").tests);
    const progress: string[] = [];
    const outcome = await runner.run(entries, { onProgress: (entry) => progress.push(entry.id) });
    const expected = FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === "main");
    expect(outcome.cancelled).toBe(false);
    expect(progress).toEqual(entries.map((entry) => entry.id));
    entries.forEach((entry, index) => {
      expect(outcome.results.get(entry.id)?.status, expected[index]!.name).toBe(expected[index]!.expected.runtime);
    });
    const count = (status: string): number => expected.filter((entry) => entry.expected.runtime === status).length;
    expect(outcome.summary).toMatchObject({
      total: entries.length,
      passed: count("passed"),
      failed: count("failed"),
      skipped: count("skipped"),
      error: count("error"),
      invalid: 0
    });
    expect(typeof outcome.summary.ranAt).toBe("number");
    expect(typeof outcome.summary.durationMs).toBe("number");
  }, 60_000);

  it("runs the clock fixture's scenarios, the clock given included", async () => {
    const definition = fixtureWithTests("clock");
    const runner = runnerOver(definition);
    const entries = runner.parse(definition.tests);
    const outcome = await runner.run(entries);
    const expected = FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === "clock");
    entries.forEach((entry, index) => {
      expect(outcome.results.get(entry.id)?.status).toBe(expected[index]!.expected.runtime);
    });
  });

  it("counts an entry with no scenario as invalid and runs the rest", async () => {
    const runner = runnerOver(FORM_TESTS_FIXTURE);
    const entries = runner.parse(
      blockOf([
        ["bad", "nonsense"],
        ["ok", block('test "fine"', "  expect applicant_name visible")]
      ])
    );
    const progress: string[] = [];
    const outcome = await runner.run(entries, { onProgress: (entry) => progress.push(entry.id) });
    expect(outcome.summary).toMatchObject({ total: 2, passed: 1, invalid: 1 });
    expect([...outcome.results.keys()]).toEqual(["ok"]);
    expect(progress).toEqual(["ok"]);
  });

  it("runs a journey scenario: continue moves the page and expect page reads it", async () => {
    const runner = runnerOver(FORM_TESTS_FIXTURE);
    const entries = runner.parse(
      blockOf([
        [
          "j",
          block('test "journey"', "  expect page = intro", '  set applicant_name = "Ada"', "  set age = 30", "  continue", "  expect page = contact")
        ],
        ["held", block('test "held"', "  continue", "  expect page = contact")]
      ])
    );
    const outcome = await runner.run(entries);
    expect(outcome.results.get("j")?.status).toBe("passed");
    // The required name is empty, so Continue stays: the expectation fails, on its own line.
    const held = outcome.results.get("held") as FormTestScenarioResult;
    expect(held.status).toBe("failed");
    expect(held.steps.map((step) => step.status)).toEqual(["ran", "failed"]);
  });

  it("reads the whole definition's tree from root(), not from the definition, and drops tests", async () => {
    const definition = fixtureWithTests("main");
    const narrowed = { ...definition.root, children: { content: (definition.root.children?.content ?? []).filter((node) => node.id !== "age") } };
    const runner = createTestsRunner({ definition: () => definition, root: () => narrowed });
    const entries = runner.parse(blockOf([["a", block('test "age gone"', "  given journey = none", "  expect age visible")]]));
    const outcome = await runner.run(entries);
    // The committed tree has no `age`: the run is on that tree, so the expectation names nothing.
    expect(outcome.results.get("a")?.status).not.toBe("passed");
  });

  it("builds a definition from the tree alone when the shell lends none", async () => {
    const runner = createTestsRunner({ definition: () => undefined, root: () => FORM_TESTS_FIXTURE.root });
    const entries = runner.parse(blockOf([["a", block('test "alone"', "  expect applicant_name required")]]));
    const outcome = await runner.run(entries);
    expect(outcome.results.get("a")?.status).toBe("passed");
  });

  it("ends the first run when a second starts: cancelled, fewer results, and the second whole", async () => {
    const runner = runnerOver(fixtureWithTests("main"));
    const entries = runner.parse(fixtureWithTests("main").tests);
    const first = runner.run(entries);
    const second = runner.run(entries);
    const [a, b] = await Promise.all([first, second]);
    expect(a.cancelled).toBe(true);
    expect(a.results.size).toBeLessThan(entries.length);
    expect(a.summary.ranAt).toBeUndefined();
    expect(b.cancelled).toBe(false);
    expect(b.results.size).toBe(entries.length);
  }, 60_000);

  it("stops after the scenario in flight when cancel() is called mid-run", async () => {
    const runner = runnerOver(fixtureWithTests("main"));
    const entries = runner.parse(fixtureWithTests("main").tests);
    let seen = 0;
    const outcome = await runner.run(entries, {
      onProgress: () => {
        seen += 1;
        if (seen === 2) {
          runner.cancel();
        }
      }
    });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.results.size).toBe(2);
    expect(seen).toBe(2);
  });

  it("reports nothing of the scenario in flight when cancelled during it, even the last one", async () => {
    const runner = runnerOver(FORM_TESTS_FIXTURE);
    const entries = runner.parse(blockOf([["only", block('test "only"', "  expect applicant_name visible")]]));
    let seen = 0;
    const run = runner.run(entries, { onProgress: () => (seen += 1) });
    // The run is inside its one scenario now (the loop awaits it): this cancel lands mid-scenario.
    runner.cancel();
    const outcome = await run;
    expect(outcome.cancelled).toBe(true);
    expect(outcome.results.size).toBe(0);
    expect(seen).toBe(0);
    expect(outcome.summary.ranAt).toBeUndefined();
  });

  it("makes an entry whose runtime cannot be built an error with the message, and carries on", async () => {
    // A plugin function that spells a built-in cannot be registered: the factory throws.
    const runner = runnerOver(FORM_TESTS_FIXTURE, { functions: () => ({ today: () => 1 }) });
    const entries = runner.parse(
      blockOf([
        ["a", block('test "one"', "  expect applicant_name visible")],
        ["b", block('test "two"', "  expect applicant_name visible")]
      ])
    );
    const outcome = await runner.run(entries);
    for (const id of ["a", "b"]) {
      const result = outcome.results.get(id)!;
      expect(result.status).toBe("error");
      expect(result.reason).toBe("scenario.driverFailed");
      expect(typeof result.params?.message).toBe("string");
      expect(result.steps).toEqual([]);
    }
    expect(outcome.summary.error).toBe(2);
  });

  it("calls a plugin function from an expect formula", async () => {
    const runner = runnerOver(FORM_TESTS_FIXTURE, {
      functions: () => ({ shout: (args: unknown[]) => String(args[0]).toUpperCase() }),
      signatures: () => [{ name: "shout", min: 1, max: 1 }]
    });
    const entries = runner.parse(blockOf([["a", block('test "plugin"', "  given journey = none", '  set applicant_name = "ada"', '  expect shout(applicant_name) = "ADA"')]]));
    const outcome = await runner.run(entries);
    expect(outcome.results.get("a")?.status).toBe("passed");
  });

  it("a scenario's `given options for` gives a data-source-backed select its options", async () => {
    const runner = runnerOver(FORM_TESTS_FIXTURE);
    const entries = runner.parse(
      blockOf([
        [
          "a",
          block(
            'test "given"',
            "  given journey = none",
            '  given options for province = ("ON", "QC")',
            '  set applicant_name = "Ada"',
            "  set age = 30",
            '  set province = "QC"',
            "  submit",
            "  expect accepted"
          )
        ]
      ])
    );
    expect((await runner.run(entries)).results.get("a")?.status).toBe("passed");
  });

  it("the builder's data sources give the options when no given does, and a given still wins for its source", async () => {
    const sources = defineDataSources({ provinces: [{ value: "QC", label: "Quebec" }] });
    const without = runnerOver(FORM_TESTS_FIXTURE);
    const withSources = runnerOver(FORM_TESTS_FIXTURE, { dataSources: () => sources });
    const submitQc = blockOf([
      [
        "a",
        block('test "builder list"', "  given journey = none", '  set applicant_name = "Ada"', "  set age = 30", '  set province = "QC"', "  submit", "  expect accepted")
      ],
      [
        "b",
        block(
          'test "given list wins"',
          "  given journey = none",
          '  given options for province = ("ON")',
          '  set applicant_name = "Ada"',
          "  set age = 30",
          '  set province = "QC"',
          "  submit",
          "  expect refused"
        )
      ]
    ]);
    const absent = await without.run(without.parse(submitQc));
    expect(absent.results.get("a")?.status).not.toBe("passed");
    const present = await withSources.run(withSources.parse(submitQc));
    expect(present.results.get("a")?.status).toBe("passed");
    expect(present.results.get("b")?.status).toBe("passed");
  });
});

describe("replay", () => {
  const scenarioOf = (source: string) => {
    const [entry] = runnerOver(FORM_TESTS_FIXTURE).parse(blockOf([["r", source]]));
    expect(entry!.problems).toEqual([]);
    return entry!.scenario!;
  };

  it("gives the answers by component id after a set", async () => {
    const scenario = scenarioOf(block('test "r"', "  given journey = none", '  set applicant_name = "Ada"', "  set age = 30", "  expect age_next_year = 31"));
    const runner = runnerOver(FORM_TESTS_FIXTURE);
    // Statements count from 0 and the given is not one: set name, set age, expect.
    const afterName = await runner.replay(scenario, 0);
    expect(afterName.values.applicant_name).toBe("Ada");
    expect(afterName.values.age).toBeUndefined();
    expect(afterName.reached).toBe(0);
    expect(afterName.steps.map((step) => step.status)).toEqual(["ran"]);
    const afterAge = await runner.replay(scenario, 2);
    expect(afterAge.values).toMatchObject({ applicant_name: "Ada", age: 30, age_next_year: 31 });
    expect(afterAge.reached).toBe(2);
    expect(afterAge.steps[2]!.status).toBe("passed");
    expect(afterAge.error).toBeUndefined();
  });

  it("gives the page after a continue", async () => {
    const scenario = scenarioOf(block('test "r"', '  set applicant_name = "Ada"', "  set age = 30", "  continue", "  expect page = contact"));
    const runner = runnerOver(FORM_TESTS_FIXTURE);
    expect((await runner.replay(scenario, 1)).page).toBe("intro");
    const moved = await runner.replay(scenario, 2);
    expect(moved.page).toBe("contact");
    expect(moved.reached).toBe(2);
  });

  it("starts from the first step on a negative through and slices nothing past the end", async () => {
    const scenario = scenarioOf(block('test "r"', "  given journey = none", '  set applicant_name = "Ada"'));
    const runner = runnerOver(FORM_TESTS_FIXTURE);
    const before = await runner.replay(scenario, -1);
    expect(before.steps).toEqual([]);
    expect(before.reached).toBe(-1);
    expect(before.values.applicant_name).toBeUndefined();
    const past = await runner.replay(scenario, 40);
    expect(past.values.applicant_name).toBe("Ada");
    expect(past.reached).toBe(0);
  });

  it("gives the row counts, so a row added empty is drawn too", async () => {
    const scenario = scenarioOf(block('test "r"', "  given journey = none", "  add row to items with qty = 2", "  add row to items"));
    const replayed = await runnerOver(FORM_TESTS_FIXTURE).replay(scenario, 1);
    expect(replayed.values["items[0].qty"]).toBe(2);
    expect(Object.keys(replayed.values).some((key) => key.startsWith("items[1]"))).toBe(false);
    expect(replayed.rows?.items).toBe(2);
  });

  it("stops where a row action is refused: reached is the last step that ran", async () => {
    const scenario = scenarioOf(
      block('test "r"', "  given journey = none", "  add row to items", "  remove row 3 of items", "  expect rows of items = 1")
    );
    const runner = runnerOver(FORM_TESTS_FIXTURE);
    const replayed = await runner.replay(scenario, 2);
    expect(replayed.steps.map((step) => step.status)).toEqual(["ran", "error"]);
    expect(replayed.steps[1]!.code).toBe("action.refused");
    expect(replayed.reached).toBe(0);
    expect(replayed.error).toBeUndefined();
  });

  it("says why a scenario that cannot start shows nothing", async () => {
    const scenario = scenarioOf(block('test "r"', "  given journey = elsewhere", "  expect applicant_name visible"));
    const replayed = await runner().replay(scenario, 0);
    expect(replayed.error?.reason).toBe("scenario.unknownJourney");
    expect(replayed.values).toEqual({});
    expect(replayed.reached).toBe(-1);

    function runner(): TestsRunner {
      return runnerOver(FORM_TESTS_FIXTURE);
    }
  });

  it("shows nothing and no error for a skipped scenario", async () => {
    const scenario = scenarioOf(block('test "r"', '  skip "later"', "  expect applicant_name visible"));
    const replayed = await runnerOver(FORM_TESTS_FIXTURE).replay(scenario, 0);
    expect(replayed.error).toBeUndefined();
    expect(replayed.values).toEqual({});
    expect(replayed.steps).toEqual([]);
  });

  it("uses the builder's data sources and a given still wins", async () => {
    const sources = defineDataSources({ provinces: [{ value: "QC", label: "Quebec" }] });
    const runner = runnerOver(FORM_TESTS_FIXTURE, { dataSources: () => sources });
    const scenario = scenarioOf(block('test "r"', "  given journey = none", '  set applicant_name = "Ada"', "  set age = 30", '  set province = "QC"', "  submit", "  expect accepted"));
    const replayed = await runner.replay(scenario, 5);
    expect(replayed.reached).toBe(4);
    expect(replayed.values.province).toBe("QC");
    expect(replayed.steps[replayed.steps.length - 1]!.status).toBe("passed");
  });

  it("reads the clock fixture's required given as an error with the code", async () => {
    const definition = FORM_TESTS_CLOCK_FIXTURE;
    const [entry] = createTestsRunner({ definition: () => definition, root: () => definition.root }).parse(blockOf([["c", block('test "c"', '  set event_date = "2026-04-01"')]]));
    const replayed = await createTestsRunner({ definition: () => definition, root: () => definition.root }).replay(entry!.scenario!, 0);
    expect(replayed.error?.reason).toBe("scenario.clockUnset");
  });
});
