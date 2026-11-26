import { describe, expect, it } from "vitest";

import { kernelParseFormTests } from "../form-engine/core/form-tests/form-test-parse.js";
import { runFormTestScenarios } from "../form-engine/core/form-tests/form-test-run.js";
import type { FormTestScenarioResult } from "../form-engine/core/form-tests/form-test-types.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFormTestRuntimeDriver, type FormTestRuntimeFactory } from "../form-engine/runtime/browser/form-test-runtime-driver.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { JsonWasmAbi, WASM_ABI_VERSION, stableStringify } from "../form-engine/validation/wasm/wasm-validation-host.js";

/**
 * Any type may sit in a data grid's row, directly or inside a container:
 * a fieldset, a data-scoping container, steps, a button, a file, another grid. Every check
 * reaches the fields wherever they sit, and the browser's stage and the kernel walk the tree
 * alike: a row field is checked at `grid[n]` + its key within the row, and a grid inside a row
 * keeps its rows at its own collection path, as the runtime keeps them, its fields checked
 * there and its row count held to its bounds.
 */

const grid = (id: string, content: unknown[], configuration: Record<string, unknown> = {}) => ({ id, type: "dataGrid", collection: {}, configuration: { initialRows: 0, ...configuration }, children: { content } });
const box = (id: string, type: string, content: unknown[], configuration: Record<string, unknown> = {}) => ({ id, type, configuration, children: { content } });
const x = { id: "x", type: "text", configuration: { required: true, minLength: 3, pattern: "[a-z]+" } };
const up = { id: "up", type: "file", configuration: { required: true } };
const form = (content: unknown[]) => ({ id: "form", type: "form", configuration: {}, children: { content } }) as unknown as ComponentNode;

const TREES: Record<string, ComponentNode> = {
  fieldset: form([grid("g", [box("fs", "fieldset", [x])])]),
  scoped: form([grid("g", [box("sc", "container", [x], { scopeData: true })])]),
  steps: form([grid("g", [box("st", "steps", [box("s1", "step", [x])])])]),
  button: form([grid("g", [{ id: "b", type: "button", configuration: {} }, x])]),
  file: form([grid("g", [up])]),
  fileInFieldset: form([grid("g", [box("fs", "fieldset", [up])])]),
  nested: form([grid("g", [grid("inner", [x], { minRows: 1, maxRows: 2 })])]),
  nestedInFieldset: form([grid("g", [box("fs", "fieldset", [grid("inner", [x], { minRows: 1, maxRows: 2 })])])])
};

const kernel = (root: ComponentNode, values: Record<string, unknown>) =>
  runKernel({ formId: "f", values, locale: "en", form: root }, [], undefined, formulaFunctionSignatures())
    .errors.map((error) => `${error.code}@${error.path}`)
    .sort();
const stage = (root: ComponentNode, values: Record<string, unknown>) =>
  (createFieldConstraintsStage(root).validate({ formId: "f", locale: "en", values }) as { errors: Array<{ code: string; path: string }> }).errors
    .map((error) => `${error.code}@${error.path}`)
    .sort();

describe("checks reach a grid's fields through any container, and a grid inside a row", () => {
  it.each([
    ["fieldset", { "g[0].x": "" }, ["required@g[0].x"]],
    ["fieldset", { "g[0].x": "A" }, ["minLength@g[0].x"]],
    ["fieldset", { "g[0].x": "abc", "g[1].x": "ABCD" }, ["pattern@g[1].x"]],
    ["scoped", { "g[0].sc.x": "" }, ["required@g[0].sc.x"]],
    ["scoped", { "g[0].sc.x": "A" }, ["minLength@g[0].sc.x"]],
    ["steps", { "g[0].x": "", "g[1].x": "abc" }, ["required@g[0].x"]],
    ["button", { "g[0].x": "Ab" }, ["minLength@g[0].x"]],
    ["file", { "g[0].up": [] }, ["required@g[0].up"]],
    ["fileInFieldset", { "g[0].up": [], "g[1].up": null }, ["required@g[0].up", "required@g[1].up"]],
    ["nested", { g: [{}] }, ["rows.min@inner"]],
    ["nested", { g: [{}], "inner[0].x": "" }, ["required@inner[0].x"]],
    ["nested", { g: [{}], "inner[0].x": "abc", "inner[1].x": "abc", "inner[2].x": "abc" }, ["rows.max@inner"]],
    ["nested", { g: [{}], "inner[0].x": "abc", "inner[1].x": "ABCD" }, ["pattern@inner[1].x"]],
    ["nestedInFieldset", { g: [{}], "inner[0].x": "" }, ["required@inner[0].x"]],
    ["nestedInFieldset", { g: [{}] }, ["rows.min@inner"]]
  ] as const)("%s with %j: %j on both sides", (tree, values, expected) => {
    const root = TREES[tree]!;
    expect(kernel(root, values)).toEqual([...expected].sort());
    expect(stage(root, values)).toEqual([...expected].sort());
  });
});

const makeRuntime: FormTestRuntimeFactory = (definition, givens) => {
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

const sandbox = new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi());

/** One scenario on the browser's runtime driver, and the sandbox's `test` op over the same text. */
async function runBoth(root: ComponentNode, source: string): Promise<{ browser: FormTestScenarioResult; kernel: FormTestScenarioResult }> {
  const definition = { id: "nested", version: "1.0.0", schemaVersion: "1.0.0", root } as unknown as FormDefinition;
  const parsed = kernelParseFormTests(source, formulaFunctionSignatures());
  expect(parsed.problems).toEqual([]);
  const [browser] = await runFormTestScenarios([parsed.scenarios[0]!], () => createFormTestRuntimeDriver(definition, { makeRuntime }));
  const answer = JSON.parse(sandbox.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "test", definition, tests: source })) as string) as {
    report: { scenarios: Array<FormTestScenarioResult & { id?: unknown; line?: unknown }> };
  };
  const { id: _id, line: _line, ...kernelResult } = answer.report.scenarios[0]!;
  return { browser: browser!, kernel: kernelResult };
}

describe("the browser's runtime and the kernel judge a row's nested fields alike", () => {
  it.each([
    ["fieldset", ["add row to g", "submit", "expect refused", "expect error on g[0].x: required", "set g[0].x = \"abc\"", "submit", "expect accepted"]],
    ["scoped", ["add row to g", "set g[0].sc.x = \"A\"", "submit", "expect error on g[0].sc.x: minLength"]],
    ["steps", ["add row to g", "submit", "expect error on g[0].x: required"]],
    ["button", ["add row to g", "set g[0].x = \"abc\"", "submit", "expect accepted"]],
    // The inner grid starts with its minimum of one row.
    ["nested", ["add row to g", "expect rows of inner = 1", "submit", "expect error on inner[0].x: required", "set inner[0].x = \"abc\"", "submit", "expect accepted", "add row to inner", "submit", "expect error on inner[1].x: required", "remove row 1 of inner", "remove row 0 of inner", "submit", "expect error on inner: rows.min"]],
    ["nestedInFieldset", ["add row to g", "submit", "expect error on inner[0].x: required"]]
  ] as const)("%s", async (tree, steps) => {
    const source = [`test "${tree}"`, "  given journey = none", ...steps.map((step) => `  ${step}`)].join("\n");
    const pair = await runBoth(TREES[tree]!, source);
    expect(pair.browser.status, JSON.stringify(pair.browser)).toBe("passed");
    expect(pair.kernel.steps, JSON.stringify(pair)).toEqual(pair.browser.steps);
  });
});
