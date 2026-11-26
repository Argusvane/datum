import { describe, expect, it } from "vitest";

import {
  createFieldConstraintsStage,
  createFormTestKernelDriver,
  createFormTestRuntimeDriver,
  createInProcessWasmValidationHost,
  EagerJourneyEngine,
  FormRuntime,
  ValidationPipeline,
  type FormTestRuntimeFactory,
  type FormTestRuntimeGivens
} from "@argusvane/datum-engine";
import { formulaFunctionSignatures, SubmissionModeRegistry, type FormDefinition } from "@argusvane/datum-engine/core";
import {
  kernelParseFormTests,
  runFormTestScenarios,
  type FormTestScenarioResult,
  type FormTestStepResult,
  type FormTestStepStatus
} from "@argusvane/datum-engine/form-tests";

import {
  FORM_TESTS_CLOCK_FIXTURE,
  FORM_TESTS_FIXTURE,
  FORM_TESTS_FIXTURE_SCENARIOS
} from "../../../engine/tests/form-tests/fixtures/form-tests-fixture.js";
import { compareSides, scenarioStatusOf } from "../src/parity.js";
import type { ParityReport } from "../src/report/model.js";

function step(line: number, status: FormTestStepStatus, extra: Partial<FormTestStepResult> = {}): FormTestStepResult {
  return { line, status, ...extra };
}

function result(status: FormTestScenarioResult["status"], steps: FormTestStepResult[] = [], reason?: string): FormTestScenarioResult {
  return { name: "s", status, steps, ...(reason !== undefined ? { reason } : {}) };
}

describe("compareSides", () => {
  it("agrees when every line has the same status on both sides", () => {
    const left = result("passed", [step(2, "ran"), step(3, "passed"), step(4, "passed")]);
    const right = result("passed", [step(2, "ran"), step(3, "passed"), step(4, "passed")]);
    expect(compareSides(left, right)).toEqual({ status: "agree", lines: [] });
  });

  it("agrees when both sides fail the same line (a failure is a finding of the form, not of the sides)", () => {
    const left = result("failed", [step(2, "failed", { code: "expect.visible", actual: false })]);
    const right = result("failed", [step(2, "failed", { code: "expect.visible", actual: true })]);
    expect(compareSides(left, right).status).toBe("agree");
  });

  it("is one-sided when the runtime skipped the scenario as a whole", () => {
    const parity = compareSides(result("skipped", [], "unreplayable.server"), result("passed", [step(3, "passed")]));
    expect(parity).toEqual({ status: "one-sided", lines: [] });
  });

  it("is one-sided when the kernel skipped the scenario as a whole", () => {
    const parity = compareSides(result("passed", [step(3, "passed")]), result("skipped", [], "waiting on the address rules"));
    expect(parity).toEqual({ status: "one-sided", lines: [] });
  });

  it("is one-sided when both sides skipped it", () => {
    expect(compareSides(result("skipped"), result("skipped")).status).toBe("one-sided");
  });

  it("lists the lines two sides judged differently, in source order", () => {
    const left = result("passed", [step(2, "passed"), step(3, "passed", { code: "a", actual: 1 }), step(4, "failed", { code: "b" })]);
    const right = result("failed", [step(2, "passed"), step(3, "failed", { code: "a", actual: 2 }), step(4, "passed")]);
    const parity = compareSides(left, right);
    expect(parity.status).toBe("differ");
    expect(parity.lines).toEqual([
      { line: 3, runtime: { status: "passed", code: "a", actual: 1 }, kernel: { status: "failed", code: "a", actual: 2 } },
      { line: 4, runtime: { status: "failed", code: "b" }, kernel: { status: "passed" } }
    ]);
    expect(parity.scenario).toBeUndefined();
  });

  it("does not compare a line one side skipped (the kernel cannot replay a host. rule)", () => {
    const left = result("passed", [step(2, "passed"), step(3, "passed")]);
    const right = result("passed", [step(2, "passed"), step(3, "skipped", { code: "unreplayable.host" })]);
    expect(compareSides(left, right)).toEqual({ status: "agree", lines: [] });
  });

  it("does not compare a line only one side has a step for (the other stopped earlier)", () => {
    const left = result("passed", [step(2, "passed"), step(3, "passed"), step(4, "passed")]);
    const right = result("failed", [step(2, "passed")]);
    expect(compareSides(left, right)).toEqual({ status: "agree", lines: [] });
  });

  it("reports a scenario with nothing comparable as one-sided instead of claiming agreement", () => {
    const left = result("passed", [step(3, "passed")]);
    const right = result("passed", [step(3, "skipped", { code: "unreplayable.host" })]);
    expect(compareSides(left, right).status).toBe("one-sided");
  });

  it("differs, with the scenario filled and no lines, when one side errored and the other ran", () => {
    const parity = compareSides(result("error", [], "action.failed"), result("passed", [step(2, "passed")]));
    expect(parity).toEqual({
      status: "differ",
      lines: [],
      scenario: { runtime: { status: "error", reason: "action.failed" }, kernel: { status: "passed" } }
    });
    const reverse = compareSides(result("failed", [step(2, "failed")]), result("error", [], "scenario.driverFailed"));
    expect(reverse.status).toBe("differ");
    expect(reverse.scenario).toEqual({ runtime: { status: "failed" }, kernel: { status: "error", reason: "scenario.driverFailed" } });
    expect(reverse.lines).toEqual([]);
  });

  it("agrees when both sides errored the same way", () => {
    const parity = compareSides(result("error", [], "scenario.clockUnset"), result("error", [], "scenario.clockUnset"));
    expect(parity.status).toBe("agree");
  });

  // Equal statuses are not agreement when the two errors are different faults.
  it("differs when both sides errored for different reasons", () => {
    const parity = compareSides(result("error", [], "scenario.clockUnset"), result("error", [], "scenario.driverFailed"));
    expect(parity.status).toBe("differ");
    expect(parity.scenario).toEqual({ runtime: { status: "error", reason: "scenario.clockUnset" }, kernel: { status: "error", reason: "scenario.driverFailed" } });
  });

  it("differs when both sides errored on a line with different codes, and agrees on the same code", () => {
    const refused = result("error", [step(2, "error", { code: "action.refused" })]);
    const failed = result("error", [step(2, "error", { code: "action.failed" })]);
    const parity = compareSides(refused, failed);
    expect(parity.status).toBe("differ");
    expect(parity.lines).toEqual([{ line: 2, runtime: { status: "error", code: "action.refused" }, kernel: { status: "error", code: "action.failed" } }]);
    expect(compareSides(refused, result("error", [step(2, "error", { code: "action.refused" })])).status).toBe("agree");
  });

  it("differs when an action line ran on one side and failed on the other", () => {
    const left = result("passed", [step(2, "ran"), step(3, "passed")]);
    const right = result("failed", [step(2, "failed", { code: "action.failed" }), step(3, "passed")]);
    const parity = compareSides(left, right);
    expect(parity.status).toBe("differ");
    expect(parity.lines).toEqual([{ line: 2, runtime: { status: "ran" }, kernel: { status: "failed", code: "action.failed" } }]);
  });
});

describe("scenarioStatusOf", () => {
  const agree: ParityReport = { status: "agree", lines: [] };
  const differ: ParityReport = { status: "differ", lines: [] };
  const oneSided: ParityReport = { status: "one-sided", lines: [] };

  it("is parity when the sides differ, whatever each side said", () => {
    expect(scenarioStatusOf({ runtime: result("passed"), kernel: result("failed") }, differ)).toBe("parity");
    expect(scenarioStatusOf({ runtime: result("error"), kernel: result("passed") }, differ)).toBe("parity");
  });

  it("is failed when any side failed", () => {
    expect(scenarioStatusOf({ runtime: result("passed"), kernel: result("failed") }, agree)).toBe("failed");
    expect(scenarioStatusOf({ runtime: result("failed"), kernel: result("error") }, agree)).toBe("failed");
  });

  it("is error when a side errored and none failed", () => {
    expect(scenarioStatusOf({ runtime: result("error"), kernel: result("error") }, agree)).toBe("error");
    expect(scenarioStatusOf({ runtime: result("passed"), kernel: result("error") }, oneSided)).toBe("error");
  });

  it("is passed when any side passed and none failed or errored (the other may have skipped)", () => {
    expect(scenarioStatusOf({ runtime: result("passed"), kernel: result("skipped") }, oneSided)).toBe("passed");
    expect(scenarioStatusOf({ runtime: result("passed"), kernel: result("passed") }, agree)).toBe("passed");
  });

  it("is skipped when every side skipped", () => {
    expect(scenarioStatusOf({ runtime: result("skipped"), kernel: result("skipped") }, oneSided)).toBe("skipped");
  });

  it("reads a single-side record by the same order, with or without a parity", () => {
    expect(scenarioStatusOf({ runtime: result("passed") }, undefined)).toBe("passed");
    expect(scenarioStatusOf({ kernel: result("failed") }, undefined)).toBe("failed");
    expect(scenarioStatusOf({ kernel: result("error") }, undefined)).toBe("error");
    expect(scenarioStatusOf({ runtime: result("skipped") }, undefined)).toBe("skipped");
    expect(scenarioStatusOf({}, undefined)).toBe("skipped");
  });
});

// The engine's own parity suite (engine/tests/form-tests/parity.test.ts) holds a table of the
// differences the design allows. This is the same corpus read through the package's comparison:
// every scenario the two sides disagree on beyond that table would be `differ`, and every row of
// the table must come out `one-sided`, so the package's reading is never stricter or looser than
// the engine's.
const makeRuntime: FormTestRuntimeFactory = (definition: FormDefinition, givens: FormTestRuntimeGivens) => {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
    journeyEngine: EagerJourneyEngine,
    wasmValidationHost: createInProcessWasmValidationHost([]),
    ...givens
  });
};

const kernelHost = createInProcessWasmValidationHost();

// The engine's table of allowed differences. A scenario that skips itself (`skip "reason"`) is
// one-sided by the same rule, though it is no difference: both sides said nothing.
const ALLOWED_NAMES = [
  "a server-only check is not the browser's to judge"
];

describe("the engine's fixture corpus, read through compareSides", () => {
  it("the allowed names exist in the corpus", () => {
    const names = new Set(FORM_TESTS_FIXTURE_SCENARIOS.map((entry) => entry.name));
    for (const name of ALLOWED_NAMES) {
      expect(names.has(name), name).toBe(true);
    }
  });

  for (const entry of FORM_TESTS_FIXTURE_SCENARIOS) {
    it(entry.name, async () => {
      const definition = entry.form === "main" ? FORM_TESTS_FIXTURE : FORM_TESTS_CLOCK_FIXTURE;
      const parsed = kernelParseFormTests(entry.source, formulaFunctionSignatures());
      expect(parsed.problems).toEqual([]);
      const scenario = parsed.scenarios[0]!;
      const [runtime] = await runFormTestScenarios([scenario], () => createFormTestRuntimeDriver(definition, { makeRuntime }));
      const [kernel] = await runFormTestScenarios([scenario], () => createFormTestKernelDriver(definition, { host: kernelHost }));
      const parity = compareSides(runtime!, kernel!);
      const table = JSON.stringify(parity.lines);

      expect(parity.status, `${entry.name}: ${table}`).not.toBe("differ");
      if (ALLOWED_NAMES.includes(entry.name) || entry.expected.runtime === "skipped" || entry.expected.kernel === "skipped") {
        expect(parity.status, entry.name).toBe("one-sided");
      } else {
        expect(parity.status, `${entry.name}: ${table}`).toBe("agree");
      }
      const status = scenarioStatusOf({ runtime: runtime!, kernel: kernel! }, parity);
      expect(status).not.toBe("parity");
    });
  }
});
