/**
 * The package's fixture files, made from the engine's form-tests fixture (the corpus both drivers
 * and the engine's parity suite run over), so the command is tested on the very forms the engine
 * pins. `scripts/write-fixtures.ts` writes them; `tests/fixtures.test.ts` checks the files on disk
 * are what this makes.
 *
 * `main.json` and `clock.json` keep only the scenarios that pass on at least one side and fail or
 * error on neither, so the two forms are a passing run (exit 0, the CI job's first call); the
 * deliberate failure is a file of its own (`failing.datum-test`), the exit-1 path. The engine
 * corpus's error scenarios (an unknown journey, a missing day) and its all-skipped one stay with
 * the engine's tests, which judge them per side.
 */
import { FORM_TESTS_FAILING_SCENARIO, FORM_TESTS_FIXTURE_SCENARIOS, fixtureWithTests } from "../../../../engine/tests/form-tests/fixtures/form-tests-fixture.js";
import type { FormTestsFixtureScenario } from "../../../../engine/tests/form-tests/fixtures/form-tests-fixture.js";

/** The scenario the sidecar copies, under a name of its own. */
export const SIDECAR_SOURCE_SCENARIO = "intro holds until a name is given";
export const SIDECAR_SCENARIO = "the sidecar file runs beside the stored tests";

function passes(entry: FormTestsFixtureScenario): boolean {
  const statuses = [entry.expected.runtime, entry.expected.kernel];
  return statuses.includes("passed") && !statuses.includes("failed") && !statuses.includes("error");
}

function fixtureForm(form: "main" | "clock"): unknown {
  const definition = fixtureWithTests(form);
  const kept = new Set(FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === form && passes(entry)).map((entry) => entry.source));
  // Filtered after `fixtureWithTests` so each kept entry keeps the id the engine's fixture gives it.
  const scenarios = (definition.tests?.scenarios ?? []).filter((entry) => kept.has(entry.source));
  return { ...definition, tests: { scenarios } };
}

function sourceOf(name: string): string {
  const entry = FORM_TESTS_FIXTURE_SCENARIOS.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`the engine's form-tests fixture has no scenario "${name}"`);
  }
  return entry.source;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Every fixture file by its name under `fixtures/`, with its exact text. */
export function fixtureFiles(): Record<string, string> {
  const sidecar = sourceOf(SIDECAR_SOURCE_SCENARIO).replace(`test "${SIDECAR_SOURCE_SCENARIO}"`, `test "${SIDECAR_SCENARIO}"`);
  return {
    "main.json": json(fixtureForm("main")),
    "clock.json": json(fixtureForm("clock")),
    "main.datum-test": `${sidecar}\n`,
    "failing.datum-test": `${sourceOf(FORM_TESTS_FAILING_SCENARIO)}\n`
  };
}
