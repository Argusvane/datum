/**
 * Regression tests for what a shared definition's
 * journey conditions and regular expressions can do to the author who opens it.
 */
import { describe, expect, it } from "vitest";

import { kernelRegexRisky } from "../form-engine/core/expressions/compile.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";

function journeyRuntime(riskyPatterns?: "allow" | "refuse") {
  // The pattern is put together as the condition runs, so no literal of it is there to check.
  const when = 'matches(t, concat("(a+", ")+$"))';
  const root: any = {
    id: "form",
    type: "form",
    configuration: {},
    children: { content: [{ id: "t", type: "text", configuration: {} }, { id: "u", type: "text", configuration: {} }] }
  };
  const journey: any = { id: "j", pages: [{ id: "p1", components: ["t"], routes: [{ when, to: "$end" }] }, { id: "p2", components: ["u"] }] };
  const definition: any = { id: "f", version: "1", schemaVersion: "1", root, journey: { journeys: [journey] } };
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(root)]),
    journeyEngine: EagerJourneyEngine,
    wasmValidationHost: createInProcessWasmValidationHost([]),
    ...(riskyPatterns ? { riskyPatterns } : {})
  } as any);
}

describe("a journey route condition refuses a risky pattern built at run time", () => {
  it("does not run the joined pattern (before: 7 s at 26 characters, 29 s at 28)", () => {
    const runtime = journeyRuntime();
    const started = performance.now();
    runtime.setValue("t", "a".repeat(30) + "!");
    expect(performance.now() - started).toBeLessThan(1500);
    expect(runtime.journeyView()?.path).toBeDefined();
  });
});

describe("nullable groups, nested and adjacent repeats and wide optionals are risky", () => {
  it.each([
    "(a?){25}a{25}c",
    "(.?){40}.{40}c",
    "((a?b?){3}){7}c",
    "((a?){4}){4}a{16}",
    "((a?b?){3})*c",
    "(a?b?){7}(a?b?){7}(a?b?){7}c",
    "(a?b?){4}(a?b?){4}(a?b?){4}(a?b?){4}c",
    "(a{0,2}){7}(a{0,2}){7}b",
    "a{0,9}".repeat(11) + "c",
    "a{0,50}".repeat(4) + "c",
    "\\d{0,3}".repeat(11) + "x"
  ])("flags %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(true);
  });

  it.each([
    "^\\d{0,3}-\\d{0,3}-\\d{0,4}$",
    "^(\\d{1,3}(,\\d{3})*)(\\.\\d+)?$",
    "^((\\d?\\d?)-){3}x$",
    "^[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2}$",
    "^(\\d{4})-(\\d{2})-(\\d{2})(T\\d{2}:\\d{2}(:\\d{2})?)?$",
    "^([a-z0-9-]+\\.){1,5}[a-z]{2,}$",
    "(a?b?){7}c",
    "(a{0,2}){7}b",
    "a{0,9}a{0,9}c",
    "^(?:\\+?1[-. ]?)?\\(?\\d{3}\\)?[-. ]?\\d{3}[-. ]?\\d{4}$"
  ])("passes %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(false);
  });
});
