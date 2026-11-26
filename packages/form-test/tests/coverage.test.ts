import { describe, expect, it } from "vitest";

import { formulaFunctionSignatures } from "@argusvane/datum-engine/core";
import { kernelParseFormTests } from "@argusvane/datum-engine/form-tests";

import { COVERABLE_KINDS, coverageOf } from "../src/coverage.js";
import { FORM_TESTS_FIXTURE } from "../../../engine/tests/form-tests/fixtures/form-tests-fixture.js";

// The coverage logic and its tests live in the engine
// (engine/tests/builder-form-tests/coverage.test.ts). This test pins what the package still
// owns: that its name carries the command line's reading (scenarios that ran) over the engine's.
describe("the package's coverageOf", () => {
  const parsed = kernelParseFormTests('test "shows"\n  expect pet_name visible', formulaFunctionSignatures());

  it("is the engine's coverage, reading the scenarios that ran", () => {
    expect(parsed.problems).toEqual([]);
    const scenario = parsed.scenarios[0]!;
    const ran = coverageOf(FORM_TESTS_FIXTURE, [{ scenario, status: "passed" }]);
    const skipped = coverageOf(FORM_TESTS_FIXTURE, [{ scenario, status: "skipped" }]);
    expect(ran.rules.length).toBe(ran.tested + ran.untested);
    expect(skipped.tested).toBe(0);
    expect(COVERABLE_KINDS).toContain("show");
  });
});
