import { describe, expect, it } from "vitest";

import type { Expression } from "../../form-engine/core/expressions/expression.js";
import { formulaFunctionSignatures } from "../../form-engine/core/expressions/function-table.js";
import type { DefinitionInspectResponse } from "../../form-engine/core/expressions/inspect.js";
import { kernelParseFormTests } from "../../form-engine/core/form-tests/form-test-parse.js";
import { runFormTestScenarios } from "../../form-engine/core/form-tests/form-test-run.js";
import type { FormTestOpReport, FormTestScenario, FormTestScenarioResult } from "../../form-engine/core/form-tests/form-test-types.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../../form-engine/runtime/browser/journey-engine-eager.js";
import { createFormTestRuntimeDriver, type FormTestRuntimeFactory } from "../../form-engine/runtime/browser/form-test-runtime-driver.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../../form-engine/validation/wasm/in-process-host.js";
import { createFormTestKernelDriver } from "../../form-engine/validation/wasm/form-test-kernel-driver.js";
import { JsonWasmAbi, WASM_ABI_VERSION, stableStringify } from "../../form-engine/validation/wasm/wasm-validation-host.js";

/*
 * The `change <field>` test line: a Check answers page's Change link. Played on the
 * browser runtime driver, the kernel driver and the sandbox's `test` op, which must come to the
 * very same steps, refusals included.
 */

const path = (name: string): Expression => ({ kind: "path", path: name });
const neq = (name: string, value: string): Expression => ({ kind: "binary", operator: "neq", left: path(name), right: { kind: "literal", value } });

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

/** about (name, kind) -> extra (detail, only when kind is "other") -> check. */
function form(review: Record<string, unknown> = {}): FormDefinition {
  return {
    id: "change-form",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name", required: true } },
          { id: "kind", type: "text", configuration: { label: "Kind", required: true } },
          { id: "detail", type: "text", configuration: { label: "Detail", required: true } }
        ]
      }
    },
    journey: {
      journeys: [
        {
          id: "apply",
          pages: [
            { id: "about", components: ["name", "kind"], routes: [{ when: neq("kind", "other"), to: "check" }] },
            { id: "extra", components: ["detail"] },
            { id: "check", kind: "review", title: "Check your answers", review }
          ]
        }
      ]
    }
  } as unknown as FormDefinition;
}

const kernelAdapter = new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi());

interface Played {
  browser: FormTestScenarioResult;
  driver: FormTestScenarioResult;
  op: FormTestScenarioResult;
}

async function play(definition: FormDefinition, source: string): Promise<Played> {
  const parsed = kernelParseFormTests(source, formulaFunctionSignatures());
  expect(parsed.problems).toEqual([]);
  const scenario = parsed.scenarios[0] as FormTestScenario;
  const [browser] = await runFormTestScenarios([scenario], () => createFormTestRuntimeDriver(definition, { makeRuntime }));
  const [driver] = await runFormTestScenarios([scenario], () => createFormTestKernelDriver(definition, { host: createInProcessWasmValidationHost() }));
  const text = kernelAdapter.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "test", definition, tests: source })) as string;
  const answer = JSON.parse(text) as DefinitionInspectResponse;
  if (!answer.ok || answer.op !== "test") {
    throw new Error("not a test answer: " + text);
  }
  const report: FormTestOpReport = answer.report;
  const { id: _id, line: _line, ...op } = report.scenarios[0]!;
  return { browser: browser!, driver: driver!, op };
}

function expectAgree(played: Played): void {
  const message = JSON.stringify(played);
  expect(played.driver, message).toEqual(played.browser);
  expect(played.op, message).toEqual(played.browser);
}

const FILLED = ['  set name = "Ada"', '  set kind = "plain"', "  continue", "  expect page = check"];

describe("change <field>: a Check answers page's Change link", () => {
  it("opens the step that asks the answer, and Continue comes back", async () => {
    const played = await play(
      form(),
      ['test "change"', ...FILLED, "  change name", "  expect page = about", '  set name = "Grace"', "  continue", "  expect page = check", "  expect path = (about, check)", "  submit", "  expect accepted"].join("\n")
    );
    expectAgree(played);
    expect(played.browser.status, JSON.stringify(played)).toBe("passed");
  });

  it("goes on to a step the changed answer puts on the path, then back to the review", async () => {
    const played = await play(
      form(),
      [
        'test "adds a step"',
        ...FILLED,
        "  change kind",
        '  set kind = "other"',
        "  continue",
        "  expect page = extra",
        '  set detail = "More"',
        "  continue",
        "  expect page = check",
        "  expect path = (about, extra, check)",
        "  submit",
        "  expect accepted"
      ].join("\n")
    );
    expectAgree(played);
    expect(played.browser.status, JSON.stringify(played)).toBe("passed");
  });

  it("Back from a step completed before the Change leads on as Continue does", async () => {
    const played = await play(form(), ['test "back"', ...FILLED, "  change name", "  expect page = about", "  back", "  expect page = check"].join("\n"));
    expectAgree(played);
    expect(played.browser.status, JSON.stringify(played)).toBe("passed");
  });

  it("a jump gives up the return: Back is the ordinary Back again", async () => {
    const played = await play(
      form(),
      ['test "jump"', ...FILLED, "  change name", "  go to check", "  back", "  expect page = about"].join("\n")
    );
    expectAgree(played);
    expect(played.browser.status, JSON.stringify(played)).toBe("passed");
  });

  const refused = (reason: string, params: Record<string, unknown>) => ({ action: "change", reason, ...params });

  it("is refused off a Check answers step", async () => {
    const played = await play(form(), ['test "early"', "  change name", "  expect page = about"].join("\n"));
    expectAgree(played);
    expect(played.browser.status).toBe("error");
    expect(played.browser.steps[0]).toMatchObject({ code: "action.refused", params: refused("change.notReview", { path: "name" }) });
  });

  it("is refused for an answer the page does not list", async () => {
    const unknown = await play(form(), ['test "unknown"', ...FILLED, "  change nothing"].join("\n"));
    expectAgree(unknown);
    expect(unknown.browser.steps.at(-1)).toMatchObject({ code: "action.refused", params: refused("change.notListed", { path: "nothing" }) });
    // `detail` is asked by a step the answers leave off the path.
    const off = await play(form(), ['test "off the path"', ...FILLED, "  change detail"].join("\n"));
    expectAgree(off);
    expect(off.browser.steps.at(-1)).toMatchObject({ code: "action.refused", params: refused("change.notListed", { path: "detail" }) });
  });

  it("is refused when the page has Change links off", async () => {
    const played = await play(form({ change: false }), ['test "links off"', ...FILLED, "  change name"].join("\n"));
    expectAgree(played);
    expect(played.browser.steps.at(-1)).toMatchObject({ code: "action.refused", params: refused("change.off", { path: "name" }) });
  });

  it("is refused on a form with no journey", async () => {
    const plain = { ...form(), journey: undefined } as unknown as FormDefinition;
    const played = await play(plain, ['test "no journey"', "  change name"].join("\n"));
    expectAgree(played);
    expect(played.browser.steps[0]).toMatchObject({ code: "action.refused", params: refused("change.notReview", { path: "name" }) });
  });

  it("keeps the return through a refused send on the step being changed, as the runtime does (no move to the step shown)", async () => {
    // about (name, required) -> extra (detail) -> check: the send refused on `about` shows
    // `about` again, which is no move, so the next Continue still goes back to Check answers.
    const definition = {
      id: "change-return",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "name", type: "text", configuration: { label: "Name", required: true } },
            { id: "detail", type: "text", configuration: { label: "Detail" } }
          ]
        }
      },
      journey: {
        journeys: [{ id: "apply", pages: [{ id: "about", components: ["name"] }, { id: "extra", components: ["detail"] }, { id: "check", kind: "review", title: "Check" }] }]
      }
    } as unknown as FormDefinition;
    const played = await play(
      definition,
      [
        'test "refused send keeps the return"',
        '  set name = "Ada"',
        "  continue",
        "  continue",
        "  expect page = check",
        "  change name",
        "  expect page = about",
        "  clear name",
        "  submit",
        "  expect page = about",
        '  set name = "Bo"',
        "  continue",
        "  expect page = check"
      ].join("\n")
    );
    expectAgree(played);
    expect(played.browser.status, JSON.stringify(played)).toBe("passed");
  });
});
