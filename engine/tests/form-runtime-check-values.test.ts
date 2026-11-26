import { describe, expect, it } from "vitest";

import type { FormEvent } from "../form-engine/core/events/event-bus.js";
import type { FormHooks } from "../form-engine/core/events/hooks.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { SubmissionVersionContext } from "../form-engine/core/submission/canonical-submission.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { defineDataSources } from "../form-engine/data/host/data-source-set.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import type { WasmValidationHost } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { FormulaFunctionRegistry } from "../form-engine/registry/formula-functions/formula-function-registry.js";

// FormRuntime.checkValues: a dry run of the checks a submit of a
// validating mode makes, the sandbox included, that stores, announces and calls nothing.

const DEFINITION = {
  id: "check-values",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name", required: true } },
        {
          id: "color",
          type: "select",
          configuration: { label: "Colour", options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] }
        },
        { id: "city", type: "select", configuration: { label: "City", data: { sourceId: "cities" } } },
        { id: "ref", type: "text", configuration: { label: "Reference" }, rules: { validWhen: { formula: 'ref != "BAD"', run: "server" } } },
        { id: "code", type: "text", configuration: { label: "Code" } }
      ]
    }
  }
} as unknown as FormDefinition;

/** The same form in a journey: `p1` (name, colour, code; "STOP" exits), `p2` (city, reference), the exit `stop`. */
const JOURNEY_DEFINITION = {
  ...DEFINITION,
  id: "check-values-journey",
  journey: {
    journeys: [
      {
        id: "main",
        pages: [
          { id: "p1", components: ["name", "color", "code"], routes: [{ when: 'code = "STOP"', to: "stop" }] },
          { id: "p2", components: ["city", "ref"], routes: [{ to: "$end" }] },
          { id: "stop", kind: "exit", components: [] }
        ]
      }
    ]
  }
} as unknown as FormDefinition;

const VERSION: SubmissionVersionContext = {
  form: { id: "check-values", version: "1.0.0" },
  client: { runtimeVersion: "test", rendererVersion: "test", schemaVersion: "1.0.0" }
};

interface Built {
  runtime: FormRuntime;
  events: FormEvent[];
  hookCalls: string[];
}

function build(
  options: { definition?: FormDefinition; wasm?: boolean; journey?: string; host?: WasmValidationHost; formulaFunctions?: FormulaFunctionRegistry } = {}
): Built {
  const definition = options.definition ?? DEFINITION;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const hookCalls: string[] = [];
  const hooks: FormHooks = {
    beforeValidation: [() => void hookCalls.push("beforeValidation")],
    afterValidation: [() => void hookCalls.push("afterValidation")],
    beforeSubmit: [() => void hookCalls.push("beforeSubmit")],
    afterSubmit: [() => void hookCalls.push("afterSubmit")],
    transformValues: [
      (values) => {
        hookCalls.push("transformValues");
        return values;
      }
    ]
  };
  const runtime = new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
    journeyEngine: EagerJourneyEngine,
    dataSources: defineDataSources({ cities: [{ value: "ott", label: "Ottawa" }, { value: "qc", label: "Québec" }] }),
    hooks,
    ...(options.wasm !== false ? { wasmValidationHost: options.host ?? createInProcessWasmValidationHost([]) } : {}),
    ...(options.formulaFunctions !== undefined ? { formulaFunctions: options.formulaFunctions } : {}),
    ...(options.journey !== undefined ? { journey: options.journey } : {})
  });
  const events: FormEvent[] = [];
  runtime.events().subscribe("*", (event) => events.push(event));
  return { runtime, events, hookCalls };
}

function answer(runtime: FormRuntime, values: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(values)) {
    runtime.setValue(path, value);
    runtime.commitValue(path);
  }
}

/** What a run must leave as it found it: the state (values, submission, validity, journey), the errors. */
function observed(runtime: FormRuntime): string {
  return JSON.stringify({ state: runtime.state(), errors: runtime.errors(), journey: runtime.journeyView() ?? null });
}

/** A dry run with every side effect watched: it must change and fire nothing. */
async function dryRun(built: Built, options: Parameters<FormRuntime["checkValues"]>[0] = {}) {
  const before = observed(built.runtime);
  built.events.length = 0;
  const result = await built.runtime.checkValues(options);
  expect(observed(built.runtime)).toBe(before);
  // The fold worked out again over the answers as stored (as `validate` and `submit` do first)
  // is the one event: no validation, error, submission, sandbox or journey event.
  expect(built.events.map((event) => event.type).filter((type) => type !== "RECOMPUTE_COMPLETED")).toEqual([]);
  expect(built.hookCalls).toEqual([]);
  return result;
}

describe("FormRuntime.checkValues: what a submit would find, nothing changed", () => {
  it("refuses an answer outside a choice's inline options, by the sandbox, with the errors the submit then raises", async () => {
    const built = build();
    answer(built.runtime, { name: "Ada", color: "green" });
    const result = await dryRun(built);
    expect(result.refused).toBe(true);
    expect(result.refusedBy).toBe("wasm");
    expect(result.errors.some((error) => error.componentId === "color")).toBe(true);

    const submitted = await built.runtime.submit("submit", VERSION);
    expect(submitted.accepted).toBe(false);
    expect(submitted.errors).toEqual(result.errors);
  });

  it("refuses by the pipeline first, with the errors a submit's validation stores", async () => {
    const built = build();
    answer(built.runtime, { color: "green" });
    const result = await dryRun(built);
    expect(result).toMatchObject({ refused: true, refusedBy: "validation" });
    expect(result.errors.map((error) => [error.componentId, error.code])).toEqual([["name", "required"]]);

    const submitted = await built.runtime.submit("submit", VERSION);
    expect(submitted.errors).toEqual(result.errors);
  });

  it("refuses an answer a data source does not offer, and a server rule that does not hold, as the sandbox does at a submit", async () => {
    for (const [values, refused] of [
      [{ name: "Ada", city: "tor" }, true],
      [{ name: "Ada", city: "ott" }, false],
      [{ name: "Ada", ref: "BAD" }, true],
      [{ name: "Ada", ref: "OK" }, false]
    ] as const) {
      const built = build();
      answer(built.runtime, values);
      const result = await dryRun(built);
      expect(result.refused, JSON.stringify(values)).toBe(refused);
      const submitted = await built.runtime.submit("submit", VERSION);
      expect(submitted.accepted, JSON.stringify(values)).toBe(!refused);
      if (refused) {
        expect(result.refusedBy).toBe("wasm");
        expect(submitted.errors).toEqual(result.errors);
      }
    }
  });

  it("accepts answers a submit accepts, with no error that blocks", async () => {
    const built = build();
    answer(built.runtime, { name: "Ada", color: "red", city: "qc" });
    const result = await dryRun(built);
    expect(result.refused).toBe(false);
    expect(result.refusedBy).toBeUndefined();
    expect(result.errors.filter((error) => error.severity !== "warning" && error.severity !== "info")).toEqual([]);
    expect((await built.runtime.submit("submit", VERSION)).accepted).toBe(true);
  });

  it("leaves the errors a validation stored where they are", async () => {
    const built = build();
    await built.runtime.validate();
    expect(built.runtime.errors().map((error) => error.code)).toEqual(["required"]);
    answer(built.runtime, { name: "Ada", color: "green" });
    const stored = built.runtime.errors();
    built.hookCalls.length = 0;
    const result = await dryRun(built);
    expect(result.refused).toBe(true);
    expect(built.runtime.errors()).toEqual(stored);
  });

  it("without a sandbox, runs the pipeline alone (as such a submit does)", async () => {
    const built = build({ wasm: false });
    answer(built.runtime, { name: "Ada", color: "green" });
    const result = await dryRun(built);
    expect(result).toEqual({ refused: false, errors: [] });
  });
});

describe("FormRuntime.checkValues on a journey page", () => {
  it("keeps to the page: its own errors, the pipeline's and the sandbox's, not another page's", async () => {
    const built = build({ definition: JOURNEY_DEFINITION, journey: "main" });
    expect(built.runtime.journeyView()?.pageId).toBe("p1");
    answer(built.runtime, { name: "Ada", color: "green", city: "tor" });

    const p1 = await dryRun(built, { page: "p1" });
    expect(p1).toMatchObject({ refused: true, refusedBy: "wasm" });
    expect(p1.errors.map((error) => error.componentId)).toEqual(["color"]);

    const p2 = await dryRun(built, { page: "p2" });
    expect(p2).toMatchObject({ refused: true, refusedBy: "wasm" });
    expect(p2.errors.map((error) => error.componentId)).toEqual(["city"]);

    answer(built.runtime, { color: "red", name: undefined });
    built.hookCalls.length = 0;
    const p2Only = await dryRun(built, { page: "p2" });
    // The name the first page lacks is not the second page's to refuse.
    expect(p2Only.errors.some((error) => error.componentId === "name")).toBe(false);
    const p1Pipeline = await dryRun(built, { page: "p1" });
    expect(p1Pipeline).toMatchObject({ refused: true, refusedBy: "validation" });
  });

  it("refuses a whole-form check of a path that ends at the exit, but not the page that leads there", async () => {
    const built = build({ definition: JOURNEY_DEFINITION, journey: "main" });
    answer(built.runtime, { name: "Ada", color: "red", code: "STOP" });
    const whole = await dryRun(built);
    expect(whole).toMatchObject({ refused: true, refusedBy: "journey" });
    expect(whole.errors.map((error) => error.code)).toEqual(["journey.exit"]);
    const page = await dryRun(built, { page: "p1" });
    expect(page.refused).toBe(false);
  });

  it("does not move the person, nor complete the page", async () => {
    const built = build({ definition: JOURNEY_DEFINITION, journey: "main" });
    answer(built.runtime, { name: "Ada", color: "red" });
    const before = built.runtime.journeyView();
    await dryRun(built, { page: "p1" });
    expect(built.runtime.journeyView()).toEqual(before);
    expect(built.runtime.journeyView()?.completed ?? []).toEqual([]);
  });
});

// Two refusals no other test held: a sandbox that fails
// outright, and a rule whose plugin function throws under `formulaErrors: "fail"`.
describe("FormRuntime.checkValues: a sandbox that fails and a rule that cannot be read", () => {
  /** A host whose run throws, as a sandbox that crashed or timed out does. */
  const failingHost = { run: async () => { throw new Error("sandbox gone"); } } as unknown as WasmValidationHost;

  it("refuses by the sandbox when its run throws, whole form and page alike (fail closed)", async () => {
    const built = build({ definition: JOURNEY_DEFINITION, journey: "main", host: failingHost });
    // Answers the pipeline accepts, so only the sandbox can refuse.
    answer(built.runtime, { name: "Ada", color: "red" });
    const page = await dryRun(built, { page: "p1" });
    expect(page).toMatchObject({ refused: true, refusedBy: "wasm" });
    // The error names no component: a page keeps it all the same (it is the page's own check
    // that could not run), so Continue stays put.
    expect(page.errors.map((error) => error.code)).toEqual(["wasm.execution_error"]);
    expect(page.errors[0]?.parameters).toMatchObject({ message: "sandbox gone" });

    const whole = await dryRun(built);
    expect(whole).toMatchObject({ refused: true, refusedBy: "wasm" });
    expect(whole.errors.map((error) => error.code)).toEqual(["wasm.execution_error"]);
  });

  it("refuses by validation when a plugin function throws under formulaErrors fail, naming the rule", async () => {
    const registry = new FormulaFunctionRegistry();
    registry.register(
      {
        name: "boom",
        params: ["text"],
        summary: "",
        example: "",
        evaluate: () => {
          throw new Error("boom");
        }
      },
      "p"
    );
    const content = (DEFINITION.root.children as unknown as { content: Array<Record<string, unknown>> }).content;
    const definition = {
      ...DEFINITION,
      root: {
        ...DEFINITION.root,
        configuration: { formulaErrors: "fail" },
        children: { content: content.map((node) => (node.id === "code" ? { ...node, rules: { visibleWhen: "boom(name)" } } : node)) }
      }
    } as unknown as FormDefinition;
    const built = build({ definition, formulaFunctions: registry });
    answer(built.runtime, { name: "Ada", color: "red" });
    const result = await dryRun(built);
    expect(result).toMatchObject({ refused: true, refusedBy: "validation" });
    const refused = result.errors.filter((error) => error.code === "formula.invalid");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ stage: "definition", parameters: { where: "rules:code", function: "boom" } });
    // A submit finds the same.
    const submitted = await built.runtime.submit("submit", VERSION);
    expect(submitted.accepted).toBe(false);
    expect(submitted.errors.some((error) => error.code === "formula.invalid")).toBe(true);
  });
});
