import { describe, expect, it } from "vitest";

import { FORM_TEST_PARSE_FUNCTIONS, kernelParseFormTests } from "../../form-engine/core/form-tests/form-test-parse.js";
import { FORM_TEST_RUN_FUNCTIONS, runFormTestScenarios } from "../../form-engine/core/form-tests/form-test-run.js";
import type { FormTestScenario, FormTestScenarioResult } from "../../form-engine/core/form-tests/form-test-types.js";
import { formulaFunctionSignatures } from "../../form-engine/core/expressions/function-table.js";
import { kernelPublicDefinition } from "../../form-engine/core/expressions/inspect.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../../form-engine/runtime/browser/journey-engine-eager.js";
import {
  createFormTestRuntimeDriver,
  type FormTestRuntimeFactory,
  type FormTestRuntimeGivens
} from "../../form-engine/runtime/browser/form-test-runtime-driver.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { createFormTestKernelDriver } from "../../form-engine/validation/wasm/form-test-kernel-driver.js";
import { FORM_TEST_KERNEL_DRIVER_FUNCTIONS } from "../../form-engine/validation/wasm/portable-kernel.js";
import { createInProcessWasmValidationHost } from "../../form-engine/validation/wasm/in-process-host.js";
import { FORM_TESTS_CLOCK_FIXTURE, FORM_TESTS_FIXTURE } from "./fixtures/form-tests-fixture.js";

// Regressions found while building the form-test runner, each reproduced here. A case that
// shows only on one side is still played on both, so the pair is what the test names: the browser runtime's driver and the
// validation kernel's read one scenario text and must come to the same step statuses and codes.

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

function scenarioOf(source: string): FormTestScenario {
  const parsed = kernelParseFormTests(source, formulaFunctionSignatures());
  expect(parsed.problems).toEqual([]);
  expect(parsed.scenarios).toHaveLength(1);
  return parsed.scenarios[0]!;
}

interface Pair {
  browser: FormTestScenarioResult;
  kernel: FormTestScenarioResult;
}

async function runBoth(definition: FormDefinition, lines: string[]): Promise<Pair> {
  const scenario = scenarioOf(["test \"t\"", ...lines.map((line) => `  ${line}`)].join("\n"));
  const [browser] = await runFormTestScenarios([scenario], () => createFormTestRuntimeDriver(definition, { makeRuntime }));
  const [kernel] = await runFormTestScenarios([scenario], () => createFormTestKernelDriver(definition, { host: kernelHost }));
  return { browser: browser!, kernel: kernel! };
}

function describePair(pair: Pair): string {
  return JSON.stringify(pair);
}

/** A form with a repeating section whose quantity must be at least 1. */
const ROWS_FORM = {
  id: "rows-form",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "items",
          type: "repeatingSection",
          configuration: { label: "Items" },
          collection: { itemFields: ["qty"] },
          children: { content: [{ id: "qty", type: "number", configuration: { label: "Quantity", min: 1 } }] }
        }
      ]
    }
  }
} as unknown as FormDefinition;

/** A form with a rule that reads `host.` and one the author scoped to the browser. */
const HOST_FORM = {
  id: "host-form",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "x", type: "text", configuration: { label: "X" }, rules: { requiredWhen: 'host.role = "admin"' } },
        { id: "y", type: "text", configuration: { label: "Y" } },
        { id: "z", type: "text", configuration: { label: "Z" }, rules: { requiredWhen: { formula: 'y = "a"', run: "browser" } } }
      ]
    }
  }
} as unknown as FormDefinition;

describe("an error on one row is not an error on every row", () => {
  it("names the row an error stands on", async () => {
    const pair = await runBoth(ROWS_FORM, [
      "given journey = none",
      "add row to items with qty = 5",
      "add row to items with qty = 0",
      "submit",
      "expect refused",
      "expect no error on items[0].qty",
      "expect error on items[1].qty: number.min"
    ]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });

  it("an error expected on the row that has none fails, so the pass above is not empty", async () => {
    const pair = await runBoth(ROWS_FORM, [
      "given journey = none",
      "add row to items with qty = 5",
      "add row to items with qty = 0",
      "submit",
      "expect error on items[0].qty"
    ]);
    expect(pair.browser.status, describePair(pair)).toBe("failed");
    expect(pair.kernel.status, describePair(pair)).toBe("failed");
    expect(pair.kernel.steps.at(-1)).toMatchObject({ code: "expect.error", actual: [] });
    expect(pair.browser.steps.at(-1)).toMatchObject({ code: "expect.error", actual: [] });
  });
});

describe("the kernel does not judge what it cannot replay", () => {
  it("a scenario with a host given is replayed on the kernel with that host context, and both sides judge it", async () => {
    const pair = await runBoth(HOST_FORM, ['given host.role = "admin"', "submit", "expect refused", "expect error on x: required"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
    // `z`'s browser-scoped rule still keeps the verdict from the kernel; the field it is about does not.
    const other = await runBoth(HOST_FORM, ['given host.role = "clerk"', "submit", "expect no error on x", "expect x optional"]);
    expect(other.browser.status, describePair(other)).toBe("passed");
    expect(other.kernel.status, describePair(other)).toBe("passed");
  });

  it("with no host given the kernel leaves the host rule unjudged: the verdict it could decide skips unreplayable.host", async () => {
    const pair = await runBoth(HOST_FORM, ["submit", "expect accepted"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel).toMatchObject({ status: "skipped", reason: "unreplayable.host" });
    expect(pair.kernel.steps.at(-1)).toMatchObject({ status: "skipped", code: "unreplayable.host" });
  });

  it("a formula over host. reads the given on both sides, and a wrong one fails on both", async () => {
    const pair = await runBoth(HOST_FORM, ['given host.role = "admin"', 'expect "admin" = host.role']);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
    const wrong = await runBoth(HOST_FORM, ['given host.role = "admin"', 'expect "clerk" = host.role']);
    expect(wrong.browser.status, describePair(wrong)).toBe("failed");
    expect(wrong.kernel.status, describePair(wrong)).toBe("failed");
  });

  it("a verdict a browser-scoped rule decides is not the kernel's to expect", async () => {
    const pair = await runBoth(HOST_FORM, ['set y = "a"', "submit", "expect refused", "expect error on z: required"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("skipped");
    expect(pair.kernel.steps.filter((step) => step.status === "skipped").map((step) => step.line)).toEqual([4, 5]);
  });

  it("a host given that comes after an unknown journey still reports the journey", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, ["given journey = elsewhere", 'given host.role = "admin"']);
    expect(pair.browser).toMatchObject({ status: "error", reason: "scenario.unknownJourney" });
    expect(pair.kernel).toMatchObject({ status: "error", reason: "scenario.unknownJourney" });
  });
});

describe("check and continue leave the outcome as the runtime leaves it", () => {
  it("a check forgets the last submission", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, [
      "given journey = none",
      'set applicant_name = "Ada"',
      "set age = 30",
      "submit",
      "expect accepted",
      "set age = 31",
      "check",
      "expect submitted age = 30"
    ]);
    expect(pair.browser.steps.at(-1), describePair(pair)).toMatchObject({ status: "failed", code: "expect.notSubmitted" });
    expect(pair.kernel.steps.at(-1), describePair(pair)).toMatchObject({ status: "failed", code: "expect.notSubmitted" });
  });

  it("a continue works out no withheld answers", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, [
      'set phone = "1"',
      'set applicant_name = "A"',
      "set age = 30",
      "continue",
      "expect phone withheld"
    ]);
    expect(pair.browser.steps.at(-1), describePair(pair)).toMatchObject({ status: "failed", code: "expect.notSubmitted" });
    expect(pair.kernel.steps.at(-1), describePair(pair)).toMatchObject({ status: "failed", code: "expect.notSubmitted" });
  });
});

describe("a form that opens as a form still has its default journey for a test", () => {
  it("both sides start on the first page", async () => {
    const journey = (FORM_TESTS_FIXTURE as unknown as { journey: Record<string, unknown> }).journey;
    const opensAsForm = { ...FORM_TESTS_FIXTURE, journey: { ...journey, opensAs: "form" } } as unknown as FormDefinition;
    const pair = await runBoth(opensAsForm, ["expect page = intro"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });
});

describe("a row key the form lacks is an unknown field", () => {
  it("on both sides", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, ["given journey = none", "add row to items", "expect items[0].typo empty"]);
    expect(pair.browser.steps.at(-1), describePair(pair)).toMatchObject({ status: "failed", code: "expect.unknownField" });
    expect(pair.kernel.steps.at(-1), describePair(pair)).toMatchObject({ status: "failed", code: "expect.unknownField" });
  });
});

describe("a locale the form does not offer is a bad given, and the result says which", () => {
  it("on both sides, with the given named", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, ['given locale = "de"', "expect applicant_name visible"]);
    expect(pair.browser).toMatchObject({ status: "error", reason: "scenario.badGiven", params: { given: "locale", locale: "de" } });
    expect(pair.kernel).toMatchObject({ status: "error", reason: "scenario.badGiven", params: { given: "locale", locale: "de" } });
  });

  it("a bad options given names the path", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, ['given options for applicant_name = ("a")']);
    expect(pair.browser).toMatchObject({ status: "error", reason: "scenario.badGiven", params: { given: "options", path: "applicant_name" } });
    expect(pair.kernel).toMatchObject({ status: "error", reason: "scenario.badGiven", params: { path: "applicant_name" } });
  });
});

describe("a clock-reading form with no day is a start error on both sides", () => {
  it("scenario.clockUnset, no step run", async () => {
    const pair = await runBoth(FORM_TESTS_CLOCK_FIXTURE, ['set event_date = "2026-04-01"', "expect event_date visible"]);
    expect(pair.browser).toMatchObject({ status: "error", reason: "scenario.clockUnset", steps: [] });
    expect(pair.kernel).toMatchObject({ status: "error", reason: "scenario.clockUnset", steps: [] });
  });

  it("with a day it runs", async () => {
    const pair = await runBoth(FORM_TESTS_CLOCK_FIXTURE, ['given today = @"2026-03-01"', "expect event_date visible"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });
});

describe("the helpers of the parser and the judge do not share a name", () => {
  it("no two functions of the lists a sandbox program would splice have the same name", () => {
    const names = [...FORM_TEST_PARSE_FUNCTIONS, ...FORM_TEST_RUN_FUNCTIONS, ...FORM_TEST_KERNEL_DRIVER_FUNCTIONS].map((fn) => fn.name);
    const seen = new Set<string>();
    const duplicates = names.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
    expect(duplicates).toEqual([]);
  });
});

describe("a byte-order mark and a no-break space are blanks", () => {
  it("a leading BOM does not spoil the first header", () => {
    const parsed = kernelParseFormTests('﻿test "a"\n  expect x visible', formulaFunctionSignatures());
    expect(parsed.problems).toEqual([]);
    expect(parsed.scenarios.map((scenario) => scenario.name)).toEqual(["a"]);
    expect(parsed.scenarios[0]?.steps).toHaveLength(1);
  });

  it("spans stay offsets into the whole source, BOM included", () => {
    const parsed = kernelParseFormTests('﻿test "a"\n  expect x visible', formulaFunctionSignatures());
    const ref = parsed.scenarios[0]?.refs[0];
    expect(ref).toBeDefined();
    expect('﻿test "a"\n  expect x visible'.slice(ref!.span.start, ref!.span.end)).toBe("x");
  });

  it("a no-break-space indent is an indent", () => {
    const parsed = kernelParseFormTests('test "a"\n  expect x visible', formulaFunctionSignatures());
    expect(parsed.problems).toEqual([]);
    expect(parsed.scenarios[0]?.steps).toHaveLength(1);
  });
});

describe("a scope name leads a formula, not a field path", () => {
  for (const line of ['expect host.role = "admin"', "expect row.qty = 1", "expect ancestor.total > 2"]) {
    it(line, () => {
      const parsed = kernelParseFormTests(`test "a"\n  ${line}`, formulaFunctionSignatures());
      expect(parsed.problems).toEqual([]);
      expect(parsed.scenarios[0]?.steps[0]?.kind).toBe("expectFormula");
    });
  }

  it("a field that merely starts with the word is still a field", () => {
    const parsed = kernelParseFormTests('test "a"\n  expect hostname = "x"\n  expect row_count = 1', formulaFunctionSignatures());
    expect(parsed.problems).toEqual([]);
    expect(parsed.scenarios[0]?.steps.map((step) => step.kind)).toEqual(["expectValue", "expectValue"]);
  });
});

describe("an error code may carry an underscore or a hyphen", () => {
  for (const code of ["server_code", "cross-field.x", "number.min"]) {
    it(code, () => {
      const parsed = kernelParseFormTests(`test "a"\n  expect error on x: ${code}`, formulaFunctionSignatures());
      expect(parsed.problems).toEqual([]);
      expect(parsed.scenarios[0]?.steps[0]).toMatchObject({ kind: "expectError", code });
    });
  }

  it("a code with a space or a symbol is still refused", () => {
    const parsed = kernelParseFormTests('test "a"\n  expect error on x: bad!code', formulaFunctionSignatures());
    expect(parsed.problems.map((problem) => problem.code)).toEqual(["badCode"]);
  });
});

describe("a test needs a name, and a name once", () => {
  it("an empty name is a problem", () => {
    const parsed = kernelParseFormTests('test ""\n  expect x visible', formulaFunctionSignatures());
    expect(parsed.problems.map((problem) => problem.code)).toEqual(["expectedName"]);
  });

  it("two tests with one name are a problem on the second header", () => {
    const parsed = kernelParseFormTests('test "a"\n  expect x visible\ntest "a"\n  expect y visible', formulaFunctionSignatures());
    expect(parsed.problems.map((problem) => [problem.code, problem.line])).toEqual([["duplicateName", 3]]);
  });

  it("different names are fine", () => {
    const parsed = kernelParseFormTests('test "a"\ntest "b"', formulaFunctionSignatures());
    expect(parsed.problems).toEqual([]);
  });
});

describe("the public copy a host serves to a browser carries no tests", () => {
  const withTests = {
    ...FORM_TESTS_FIXTURE,
    tests: { scenarios: [{ id: "s1", source: 'test "a"\n  given host.role = "admin"' }] }
  } as unknown as FormDefinition;

  // The twin of the `delete copy.tests;` in `publicDefinition` (compile.ts), in the kernel's
  // `kernelPublicDefinition`: every sandbox host serves what this returns.
  it("kernelPublicDefinition strips tests", () => {
    expect("tests" in kernelPublicDefinition(withTests)).toBe(false);
  });
});

// --- Cases for the judge and the drivers, each played on both sides ---

function formOf(content: unknown[], extra: Record<string, unknown> = {}): FormDefinition {
  return {
    id: "apply-form",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: { id: "form", type: "form", configuration: {}, children: { content } },
    ...extra
  } as unknown as FormDefinition;
}

function skippedLines(result: FormTestScenarioResult): number[] {
  return result.steps.filter((step) => step.status === "skipped").map((step) => step.line);
}

describe("a verdict that a rule the kernel left unevaluated decides is not the kernel's", () => {
  const required = formOf([
    { id: "y", type: "text", configuration: { label: "Y" } },
    { id: "x", type: "text", configuration: { label: "X", required: true }, rules: { visibleWhen: { formula: 'y = "a"', run: "browser" } } }
  ]);

  it("a browser-scoped visibleWhen on a required field: refused is the browser's to say", async () => {
    const pair = await runBoth(required, ['set y = "a"', "submit", "expect refused", "expect error on x: required"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("skipped");
    expect(skippedLines(pair.kernel)).toEqual([4, 5]);
  });

  it("and so is accepted, when the rule hides the field", async () => {
    const pair = await runBoth(required, ['set y = "b"', "submit", "expect accepted"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(skippedLines(pair.kernel), describePair(pair)).toEqual([4]);
  });

  it("a verdict about a form nothing requires stays judged: the rule changes no verdict", async () => {
    const optional = formOf([
      { id: "y", type: "text", configuration: { label: "Y" } },
      { id: "x", type: "text", configuration: { label: "X" }, rules: { visibleWhen: { formula: 'y = "a"', run: "browser" } } }
    ]);
    const pair = await runBoth(optional, ['set y = "a"', "submit", "expect accepted"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });

  it("a requiredWhen that reads a calculation the browser works out: refused is the browser's", async () => {
    const definition = formOf([
      { id: "y", type: "text", configuration: { label: "Y" } },
      { id: "c", type: "text", configuration: { label: "C" }, rules: { value: { formula: "y", run: "browser" } } },
      { id: "w", type: "text", configuration: { label: "W" }, rules: { requiredWhen: 'c = "a"' } }
    ]);
    const pair = await runBoth(definition, ['set y = "a"', "submit", "expect refused"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("skipped");
  });
});

describe("what reads a calculation the kernel did not work out is not the kernel's either", () => {
  const derived = formOf([
    { id: "n", type: "number", configuration: { label: "N" } },
    { id: "big", type: "checkbox", configuration: { label: "Big" }, rules: { value: { formula: "n > 2", run: "browser" } } },
    { id: "z", type: "text", configuration: { label: "Z" }, rules: { requiredWhen: "big = true" } }
  ]);

  it("the requiredness, the verdict and the error of a component whose rule reads it skip", async () => {
    const pair = await runBoth(derived, ["set n = 3", "expect z required", "submit", "expect refused", "expect error on z: required"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("skipped");
    expect(skippedLines(pair.kernel)).toEqual([3, 5, 6]);
  });

  it("a component that reads nothing it could not replay is still judged", async () => {
    const pair = await runBoth(derived, ["set n = 3", "expect n = 3"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });

  const paged = formOf(
    [
      { id: "n", type: "number", configuration: { label: "N" } },
      { id: "big", type: "checkbox", configuration: { label: "Big" }, rules: { value: { formula: "n > 2", run: "browser" } } },
      { id: "extra", type: "text", configuration: { label: "Extra" } },
      { id: "last", type: "text", configuration: { label: "Last" } }
    ],
    {
      journey: {
        journeys: [
          {
            id: "main",
            pages: [
              { id: "one", components: ["n", "big"], routes: [{ when: "big != true", to: "three" }] },
              { id: "two", components: ["extra"] },
              { id: "three", components: ["last"] }
            ]
          }
        ]
      }
    }
  );

  it("a route whose when reads it: the path, the page and what was submitted skip", async () => {
    const pair = await runBoth(paged, [
      "set n = 3",
      "expect two on path",
      "expect path = (one, two, three)",
      'set extra = "e"',
      "continue",
      "expect page = two",
      "submit",
      'expect submitted extra = "e"'
    ]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("skipped");
    expect(skippedLines(pair.kernel)).toEqual([3, 4, 7, 9]);
  });

  it("a component on the route's own page is still judged, one on a page after the route is skipped", async () => {
    const pair = await runBoth(paged, ["set n = 3", "expect n = 3", "expect last visible", "expect extra visible"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.steps.map((step) => step.status), describePair(pair)).toEqual(["ran", "passed", "skipped", "skipped"]);
  });
});

describe("an expect <formula> over a calculation the kernel did not work out skips", () => {
  const definition = formOf([
    { id: "n", type: "number", configuration: { label: "N" } },
    { id: "doubled", type: "number", configuration: { label: "D" }, rules: { value: { formula: "n * 2", run: "browser" } } }
  ]);

  it("on the kernel only, and the browser judges it", async () => {
    const pair = await runBoth(definition, ["set n = 3", "expect doubled > 5", "expect doubled + 0 = 6", "expect n > 2"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.steps.map((step) => step.status), describePair(pair)).toEqual(["ran", "skipped", "skipped", "passed"]);
    expect(pair.kernel.steps[1]).toMatchObject({ code: "unreplayable.browser" });
  });
});

describe("a checkbox group nobody touched equals ()", () => {
  const group = formOf([
    { id: "t", type: "checkboxes", configuration: { label: "T", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } }
  ]);

  it("untouched, and ticked then cleared, on both sides", async () => {
    const pair = await runBoth(group, ["expect t = ()", 'set t = ("a")', "expect t != ()", "set t = ()", "expect t = ()"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });
});

describe("a data grid opens with its starting rows and holds its most", () => {
  const grid = (configuration: Record<string, unknown>, cellRequired = false) =>
    formOf([
      {
        id: "deps",
        type: "dataGrid",
        configuration: { label: "Deps", ...configuration },
        collection: { collectionPath: "deps" },
        children: { content: [{ id: "dep_name", type: "text", configuration: { label: "Name", required: cellRequired } }] }
      }
    ]);

  it("one empty row by default, and its required cell refuses the submit", async () => {
    const pair = await runBoth(grid({}, true), ["given journey = none", "expect rows of deps = 1", "submit", "expect refused"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });

  it("raised to the minimum rows", async () => {
    const pair = await runBoth(grid({ initialRows: 0, minRows: 1 }), ["given journey = none", "expect rows of deps = 1", "submit", "expect accepted"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });

  it("as many as initialRows says, none when it says 0", async () => {
    const two = await runBoth(grid({ initialRows: 2 }), ["given journey = none", "expect rows of deps = 2"]);
    expect(two.browser.status, describePair(two)).toBe("passed");
    expect(two.kernel.status, describePair(two)).toBe("passed");
    const none = await runBoth(grid({ initialRows: 0 }), ["given journey = none", "expect rows of deps = 0"]);
    expect(none.browser.status, describePair(none)).toBe("passed");
    expect(none.kernel.status, describePair(none)).toBe("passed");
  });

  it("a row past the most a grid may hold ends the scenario in an action error on both sides", async () => {
    const pair = await runBoth(grid({ initialRows: 0, maxRows: 1 }), ["given journey = none", "add row to deps", "add row to deps", "expect rows of deps = 2"]);
    // A coded refusal, the same on both sides.
    const refused = { status: "error", code: "action.refused", params: { action: "addRow", reason: "rows.max", path: "deps", max: 1 } };
    expect(pair.browser.steps.at(-1), describePair(pair)).toEqual({ line: 4, ...refused });
    expect(pair.kernel.steps.at(-1), describePair(pair)).toEqual({ line: 4, ...refused });
    expect(pair.kernel.steps.map((step) => step.line)).toEqual(pair.browser.steps.map((step) => step.line));
  });
});

describe("a refused submit takes the journey to the first page holding an error", () => {
  const twoPages = formOf(
    [
      { id: "a", type: "text", configuration: { label: "A", required: true } },
      { id: "b", type: "text", configuration: { label: "B", required: true } }
    ],
    {
      journey: {
        journeys: [
          {
            id: "main",
            pages: [
              { id: "p1", components: ["a"] },
              { id: "p2", components: ["b"] }
            ]
          }
        ]
      }
    }
  );

  it("from the first page to the second, where the only error stands", async () => {
    const pair = await runBoth(twoPages, ['set a = "1"', "submit", "expect refused", "expect page = p2"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });

  it("back to the earliest page, from a later one", async () => {
    const pair = await runBoth(twoPages, ['set a = "1"', "continue", "expect page = p2", "clear a", "submit", "expect refused", "expect page = p1"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });

  it("an accepted submit moves nothing", async () => {
    const pair = await runBoth(twoPages, ['set a = "1"', 'set b = "2"', "submit", "expect accepted", "expect page = p1"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });
});

describe("a journey that is no journey is not the default and cannot be named", () => {
  const broken = formOf(
    [
      { id: "a", type: "text", configuration: { label: "A", required: true } },
      { id: "b", type: "text", configuration: { label: "B" } }
    ],
    {
      journey: {
        journeys: [
          { id: "broken", pages: "nope" },
          {
            id: "good",
            validation: { continue: "page" },
            pages: [
              { id: "p1", components: ["a"] },
              { id: "p2", components: ["b"] }
            ]
          }
        ]
      }
    }
  );

  it("the first usable journey opens", async () => {
    const pair = await runBoth(broken, ["expect page = p1", "continue", "expect page = p1", "expect error on a: required"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });

  it("naming the broken one is an unknown journey", async () => {
    const pair = await runBoth(broken, ["given journey = broken", "expect a visible"]);
    expect(pair.browser).toMatchObject({ status: "error", reason: "scenario.unknownJourney" });
    expect(pair.kernel).toMatchObject({ status: "error", reason: "scenario.unknownJourney" });
  });
});

describe("the browser skips a verdict a server-only rule that fires may change", () => {
  it("a bad reference number: refused is the server's to say, the kernel judges it", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, [
      "given journey = none",
      'set applicant_name = "Ada"',
      "set age = 30",
      'set ref_number = "BAD"',
      "check",
      "expect refused"
    ]);
    expect(pair.browser.steps.at(-1), describePair(pair)).toMatchObject({ status: "skipped", code: "unreplayable.server" });
    expect(pair.kernel.steps.at(-1), describePair(pair)).toMatchObject({ status: "passed" });
  });

  it("a reference number the rule accepts leaves the verdict judged", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, [
      "given journey = none",
      'set applicant_name = "Ada"',
      "set age = 30",
      'set ref_number = "OK"',
      "check",
      "expect accepted"
    ]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });
});

describe("the two sides keep the same answers", () => {
  it("an answer at a row field's bare key is no answer, and naming the key is an unknown field on both", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, ["given journey = none", "set qty = 3", "expect qty = null", "expect qty empty"]);
    for (const result of [pair.browser, pair.kernel]) {
      expect(result.steps.map((step) => [step.status, step.code]), describePair(pair)).toEqual([
        ["ran", undefined],
        ["failed", "expect.unknownField"],
        ["failed", "expect.unknownField"]
      ]);
    }
  });

  it("an answer at a key no component owns reads back as nothing on both", async () => {
    // A key the form does not define at all is not an expectation target either; the answer is
    // simply never kept. Played through a field with its own data key, which is a real path.
    const keyed = formOf([{ id: "street", type: "text", configuration: { label: "Street", dataKey: "addr" } }]);
    const pair = await runBoth(keyed, ["set stray = 3", 'set addr = "Main"', 'expect addr = "Main"']);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });

  it("clearing a row that does not exist adds none", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, [
      "given journey = none",
      "add row to items with qty = 2",
      "clear items[0].qty",
      "clear items[3].qty",
      "expect rows of items = 1"
    ]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });

  it("the submitted record lists the rows at their paths and holds no list beside them", async () => {
    const pair = await runBoth(ROWS_FORM, [
      "given journey = none",
      "add row to items with qty = 2",
      "submit",
      "expect accepted",
      "expect submitted items[0].qty = 2",
      "expect submitted items = null"
    ]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });
});

// Known gaps, each pinned as it stands so the day it is closed this goes red and the pin
// comes out.
describe("the browser's check and Continue run the sandbox too (FormRuntime.checkValues)", () => {
  const ANSWERED = ['set applicant_name = "Ada"', "set age = 30"];

  it("an answer outside the given options is refused by a check on both sides, one inside them accepted", async () => {
    for (const [answer, verdict] of [
      ['"XX"', "refused"],
      ['"ON"', "accepted"]
    ] as const) {
      const pair = await runBoth(FORM_TESTS_FIXTURE, [
        "given journey = none",
        'given options for province = ("ON", "QC")',
        ...ANSWERED,
        `set province = ${answer}`,
        "check",
        `expect ${verdict}`
      ]);
      expect(pair.browser.status, describePair(pair)).toBe("passed");
      expect(pair.kernel.status, describePair(pair)).toBe("passed");
    }
  });

  it("an answer outside a choice's inline options, or a checkbox group's, is refused by a check on both sides", async () => {
    for (const line of ['set contact_method = "fax"', 'set topics = ("zzz")']) {
      const pair = await runBoth(FORM_TESTS_FIXTURE, ["given journey = none", ...ANSWERED, line, "check", "expect refused"]);
      expect(pair.browser.status, `${line}: ${describePair(pair)}`).toBe("passed");
      expect(pair.kernel.status, `${line}: ${describePair(pair)}`).toBe("passed");
    }
  });

  it("a journey page's check refuses it too, and Continue stays on the page on both sides", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, [
      'given options for province = ("ON", "QC")',
      ...ANSWERED,
      "continue",
      "expect page = contact",
      'set contact_method = "phone"',
      'set province = "XX"',
      "check",
      "expect refused",
      "continue",
      "expect page = contact",
      'set province = "QC"',
      "check",
      "expect accepted",
      "continue",
      "expect page = review"
    ]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });
});

describe("left open: FormRuntime drops an answer stored at the key __proto__", () => {
  it("the browser loses it, the kernel keeps it", async () => {
    const definition = formOf([{ id: "__proto__", type: "text", configuration: { label: "P" } }]);
    const pair = await runBoth(definition, ['set __proto__ = "a"', 'expect __proto__ = "a"']);
    expect(pair.browser.steps.at(-1), describePair(pair)).toMatchObject({ status: "failed", code: "expect.value" });
    expect(pair.kernel.steps.at(-1), describePair(pair)).toMatchObject({ status: "passed" });
  });
});

// --- Further cases for the judge and the drivers, each played on both sides ---

describe("a formula over a field the form lacks fails, and TRUE is the literal", () => {
  const flags = formOf([
    { id: "w", type: "checkbox", configuration: { label: "W" } },
    { id: "t", type: "text", configuration: { label: "T" } }
  ]);

  it("`expect w = TRUE` is a value check on both sides", async () => {
    const pair = await runBoth(flags, ["set w = true", "expect w = TRUE", "set w = false", "expect w = TRUE"]);
    expect(pair.browser.steps.map((step) => step.status), describePair(pair)).toEqual(["ran", "passed", "ran", "failed"]);
    expect(pair.kernel.steps.map((step) => step.status), describePair(pair)).toEqual(["ran", "passed", "ran", "failed"]);
    expect(pair.browser.steps.at(-1)).toMatchObject({ code: "expect.value", expected: true });
    expect(pair.kernel.steps.at(-1)).toMatchObject({ code: "expect.value", expected: true });
  });

  it("`expect t = nosuchfield` fails expect.unknownField, naming the field, on both sides", async () => {
    const pair = await runBoth(flags, ["expect t = nosuchfield"]);
    const failed = { line: 2, status: "failed", code: "expect.unknownField", params: { path: "nosuchfield" } };
    expect(pair.browser.steps[0], describePair(pair)).toEqual(failed);
    expect(pair.kernel.steps[0], describePair(pair)).toEqual(failed);
    expect(pair.browser.status).toBe("failed");
    expect(pair.kernel.status).toBe("failed");
  });

  it("a formula over fields the form has is still judged", async () => {
    const pair = await runBoth(flags, ['set t = "a"', 'expect t = "a" and w != true']);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });
});

describe("a definition whose formulas do not compile ends the scenario at start on both sides", () => {
  const broken = formOf([
    { id: "born", type: "number", configuration: { label: "Born" } },
    { id: "x", type: "number", configuration: { label: "X" }, rules: { value: "nosuch(born)" } }
  ]);

  it("scenario.formulaInvalid with the first problems as code and where, no step run", async () => {
    const pair = await runBoth(broken, ["set born = 1990", "expect x empty"]);
    for (const result of [pair.browser, pair.kernel]) {
      expect(result, describePair(pair)).toMatchObject({ status: "error", reason: "scenario.formulaInvalid", steps: [] });
      const problems = (result.params as { problems: Array<{ code: string; where: string }> }).problems;
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.length).toBeLessThanOrEqual(5);
      expect(problems[0]).toEqual({ code: expect.any(String), where: "rules:x:value" });
    }
    expect(pair.kernel.params).toEqual(pair.browser.params);
  });

  it("keeps only the first five problems of many", async () => {
    const many = formOf(
      [{ id: "born", type: "number", configuration: { label: "Born" } }].concat(
        Array.from({ length: 8 }, (_, at) => ({ id: `x${at}`, type: "number", configuration: { label: "X" }, rules: { value: "nosuch(born)" } }) as never)
      )
    );
    const pair = await runBoth(many, ["expect born empty"]);
    expect((pair.browser.params as { problems: unknown[] }).problems).toHaveLength(5);
    expect((pair.kernel.params as { problems: unknown[] }).problems).toHaveLength(5);
    expect(pair.kernel.params).toEqual(pair.browser.params);
  });

  it("a definition that compiles starts as usual", async () => {
    const pair = await runBoth(formOf([{ id: "born", type: "number", configuration: { label: "Born" } }]), ["set born = 1", "expect born = 1"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });
});

describe("the first bad given in source order is the one reported", () => {
  const journeyForm = formOf(
    [
      { id: "age", type: "number", configuration: { label: "Age", data: { sourceId: "ages" } } },
      { id: "plain", type: "text", configuration: { label: "Plain" } }
    ],
    { journey: { journeys: [{ id: "main", validation: { continue: "page" }, pages: [{ id: "p1", components: ["age", "plain"] }] }] } }
  );

  it("a bad options given before a bad journey reports the options on both sides", async () => {
    const pair = await runBoth(journeyForm, ['given options for plain = ("1")', "given journey = elsewhere", "expect plain visible"]);
    for (const result of [pair.browser, pair.kernel]) {
      expect(result, describePair(pair)).toMatchObject({ status: "error", reason: "scenario.badGiven", params: { given: "options", path: "plain", reason: "noSource" } });
    }
  });

  it("a bad journey before a bad options given reports the journey on both sides", async () => {
    const pair = await runBoth(journeyForm, ["given journey = elsewhere", 'given options for plain = ("1")', "expect plain visible"]);
    for (const result of [pair.browser, pair.kernel]) {
      expect(result, describePair(pair)).toMatchObject({ status: "error", reason: "scenario.unknownJourney", params: { journey: "elsewhere" } });
    }
  });

  it("a locale the form does not offer is a given like the others", async () => {
    const localized = formOf([{ id: "plain", type: "text", configuration: { label: "Plain" } }], {
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] }
    });
    const first = await runBoth(localized, ['given locale = "de"', "given journey = elsewhere", "expect plain visible"]);
    for (const result of [first.browser, first.kernel]) {
      expect(result, describePair(first)).toMatchObject({ status: "error", reason: "scenario.badGiven", params: { given: "locale", locale: "de" } });
    }
    const second = await runBoth(localized, ["given journey = elsewhere", 'given locale = "de"', "expect plain visible"]);
    for (const result of [second.browser, second.kernel]) {
      expect(result, describePair(second)).toMatchObject({ status: "error", reason: "scenario.unknownJourney" });
    }
  });
});

describe("a refused row action is a coded refusal with one reason on both sides", () => {
  const grid = (configuration: Record<string, unknown>) =>
    formOf([
      {
        id: "deps",
        type: "dataGrid",
        configuration: { label: "Deps", ...configuration },
        collection: { collectionPath: "deps" },
        children: { content: [{ id: "dep_name", type: "text", configuration: { label: "Name" } }] }
      },
      { id: "plain", type: "text", configuration: { label: "Plain" } }
    ]);

  async function refusal(definition: FormDefinition, line: string) {
    const pair = await runBoth(definition, ["given journey = none", line, "expect plain visible"]);
    // The givens are no steps: the refusal is the only one, and it ends the walk.
    const browser = pair.browser.steps[0];
    const kernel = pair.kernel.steps[0];
    expect(pair.browser.status, describePair(pair)).toBe("error");
    expect(pair.kernel.status, describePair(pair)).toBe("error");
    expect(pair.browser.steps, describePair(pair)).toHaveLength(1);
    expect(pair.kernel.steps, describePair(pair)).toHaveLength(1);
    expect(kernel, describePair(pair)).toEqual(browser);
    return browser;
  }

  it("rows.max", async () => {
    const step = await refusal(grid({ initialRows: 1, maxRows: 1 }), "add row to deps");
    expect(step).toEqual({ line: 3, status: "error", code: "action.refused", params: { action: "addRow", reason: "rows.max", path: "deps", max: 1 } });
  });

  it("operations.add", async () => {
    const step = await refusal(grid({ canAdd: false }), "add row to deps");
    expect(step).toEqual({ line: 3, status: "error", code: "action.refused", params: { action: "addRow", reason: "operations.add", path: "deps" } });
  });

  it("operations.remove", async () => {
    const step = await refusal(grid({ canRemove: false }), "remove row 0 of deps");
    expect(step).toEqual({ line: 3, status: "error", code: "action.refused", params: { action: "removeRow", reason: "operations.remove", path: "deps" } });
  });

  it("rowOutOfRange", async () => {
    const step = await refusal(grid({ initialRows: 1 }), "remove row 5 of deps");
    expect(step).toEqual({
      line: 3,
      status: "error",
      code: "action.refused",
      params: { action: "removeRow", reason: "rowOutOfRange", path: "deps", index: 5, count: 1 }
    });
  });

  it("unknownCollection, for a path that is no collection and one the form lacks", async () => {
    const field = await refusal(grid({}), "add row to plain");
    expect(field).toMatchObject({ code: "action.refused", params: { action: "addRow", reason: "unknownCollection", path: "plain" } });
    const absent = await refusal(grid({}), "remove row 0 of nowhere");
    expect(absent).toMatchObject({ code: "action.refused", params: { action: "removeRow", reason: "unknownCollection", path: "nowhere" } });
  });

  it("a removal below the minimum rows is not a refusal on either side (the check at submit says rows.min)", async () => {
    const pair = await runBoth(grid({ initialRows: 1, minRows: 1 }), ["given journey = none", "remove row 0 of deps", "expect rows of deps = 0", "submit", "expect refused"]);
    expect(pair.browser.status, describePair(pair)).toBe("passed");
    expect(pair.kernel.status, describePair(pair)).toBe("passed");
  });
});

describe("a page the journey lacks and a row the form lacks fail the expectation", () => {
  const paged = formOf(
    [
      { id: "a", type: "text", configuration: { label: "A" } },
      { id: "b", type: "text", configuration: { label: "B" }, rules: { visibleWhen: 'a = "x"' } },
      {
        id: "items",
        type: "repeatingSection",
        configuration: { label: "Items" },
        collection: { itemFields: ["qty"] },
        children: { content: [{ id: "qty", type: "number", configuration: { label: "Qty" } }] }
      }
    ],
    { journey: { journeys: [{ id: "main", pages: [{ id: "p1", components: ["a"], routes: [{ when: 'a != "x"', to: "p3" }] }, { id: "p2", components: ["b"] }, { id: "p3", components: ["items"] }] }] } }
  );

  it("`expect <page> off path` for a page the journey has but the path skips passes; for a typo it fails", async () => {
    const pair = await runBoth(paged, ["expect p2 off path", "expect pp2 off path", "expect pp2 on path"]);
    for (const result of [pair.browser, pair.kernel]) {
      expect(result.steps.map((step) => step.status), describePair(pair)).toEqual(["passed", "failed", "failed"]);
      expect(result.steps[1], describePair(pair)).toEqual({ line: 3, status: "failed", code: "expect.unknownPage", params: { page: "pp2" } });
    }
  });

  it("a state, value or error expectation on a row past the row count fails with rowOutOfRange", async () => {
    const pair = await runBoth(paged, [
      "given journey = none",
      "add row to items with qty = 1",
      "expect items[0].qty = 1",
      "expect no error on items[0].qty",
      "expect items[1].qty empty",
      "expect no error on items[1].qty",
      "expect items[2].qty = null"
    ]);
    for (const result of [pair.browser, pair.kernel]) {
      expect(result.steps.map((step) => step.status), describePair(pair)).toEqual(["ran", "passed", "passed", "failed", "failed", "failed"]);
      expect(result.steps[3], describePair(pair)).toEqual({
        line: 6,
        status: "failed",
        code: "expect.unknownField",
        params: { path: "items[1].qty", reason: "rowOutOfRange" }
      });
    }
  });
});

// Expectations that must not pass on nothing, each played on both sides: the pair is what the
// test names.
describe("expectations that must not pass on nothing", () => {
  const keyed = formOf([{ id: "street", type: "text", configuration: { label: "Street", dataKey: "addr" } }]);

  it("an expect formula reads ids; a value path that is no id fails with the id as the hint", async () => {
    const pair = await runBoth(keyed, [
      'set addr = "Main"',
      'expect addr = "Main"',
      'expect "Main" = street',
      'expect "Main" != addr',
      "expect null = addr"
    ]);
    for (const result of [pair.browser, pair.kernel]) {
      expect(result.steps.map((step) => step.status), describePair(pair)).toEqual(["ran", "passed", "passed", "failed", "failed"]);
      expect(result.steps[3], describePair(pair)).toEqual({
        line: 5,
        status: "failed",
        code: "expect.unknownField",
        params: { path: "addr", id: "street" }
      });
      expect(result.steps[4]).toMatchObject({ code: "expect.unknownField", params: { path: "addr", id: "street" } });
    }
  });

  it("a row. or ancestor. read in an expect formula fails with noRowScope", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, [
      "given journey = none",
      "add row to items with qty = 5",
      "expect row.qty = null",
      "expect row.typo = null",
      "expect ancestor.typo = null"
    ]);
    for (const result of [pair.browser, pair.kernel]) {
      expect(result.steps.map((step) => step.status), describePair(pair)).toEqual(["ran", "failed", "failed", "failed"]);
      expect(result.steps[1], describePair(pair)).toEqual({
        line: 4,
        status: "failed",
        code: "expect.unknownField",
        params: { path: "row.qty", reason: "noRowScope" }
      });
      expect(result.steps[3]).toMatchObject({ params: { path: "ancestor.typo", reason: "noRowScope" } });
    }
    expect(pair.kernel.steps).toEqual(pair.browser.steps);
  });

  it("a row field named without its index is no field (expect.unknownField), on both sides", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, [
      "given journey = none",
      'set applicant_name = "A"',
      "set age = 30",
      'add row to items with qty = "abc"',
      "submit",
      "expect refused",
      "expect error on items[0].qty: number",
      "expect no error on qty",
      "expect qty empty",
      "expect qty = null",
      "expect qty visible"
    ]);
    for (const result of [pair.browser, pair.kernel]) {
      expect(result.steps.map((step) => step.status), describePair(pair)).toEqual([
        "ran", "ran", "ran", "ran", "passed", "passed", "failed", "failed", "failed", "failed"
      ]);
      expect(result.steps[6], describePair(pair)).toEqual({ line: 9, status: "failed", code: "expect.unknownField", params: { path: "qty" } });
    }
    expect(pair.kernel.steps).toEqual(pair.browser.steps);
  });

  it("expect submitted and expect withheld on a row past the count fail with rowOutOfRange", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, [
      "given journey = none",
      'set applicant_name = "A"',
      "set age = 30",
      "add row to items with qty = 5",
      "submit",
      "expect accepted",
      "expect submitted items[0].qty = 5",
      "expect submitted items[3].qty = null",
      "expect items[3].qty withheld"
    ]);
    for (const result of [pair.browser, pair.kernel]) {
      expect(result.steps.map((step) => step.status), describePair(pair)).toEqual([
        "ran", "ran", "ran", "ran", "passed", "passed", "failed", "failed"
      ]);
      expect(result.steps[6], describePair(pair)).toEqual({
        line: 9,
        status: "failed",
        code: "expect.unknownField",
        params: { path: "items[3].qty", reason: "rowOutOfRange" }
      });
      expect(result.steps[7]).toMatchObject({ code: "expect.unknownField", params: { reason: "rowOutOfRange" } });
    }
  });
});
