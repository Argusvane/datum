import { describe, expect, it } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { SubmissionVersionContext } from "../form-engine/core/submission/canonical-submission.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { FormRuntime, SubmitBusyError, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import type { WasmValidationHost } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { SubmissionHandlerRegistry } from "../form-engine/registry/submission/submission-handler-registry.js";

type Hooks = NonNullable<FormRuntimeDependencies["hooks"]>;

const VERSION: SubmissionVersionContext = {
  form: { id: "f", version: "1.0.0" },
  client: { runtimeVersion: "test", rendererVersion: "test", schemaVersion: "1.0.0" }
};

function definition(): FormDefinition {
  return {
    id: "f",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] }
    }
  } as unknown as FormDefinition;
}

function build(deps: Partial<FormRuntimeDependencies> = {}): FormRuntime {
  const form = definition();
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  modes.register({ id: "server", validate: true, sign: false, serverValidation: true });
  const runtime = new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
    journeyEngine: EagerJourneyEngine,
    wasmValidationHost: createInProcessWasmValidationHost([]),
    ...deps
  } as FormRuntimeDependencies);
  runtime.setValue("name", "Ada");
  return runtime;
}

function failures(runtime: FormRuntime): unknown[] {
  const seen: unknown[] = [];
  runtime.events().subscribe(FormEventType.SUBMISSION_FAILED, (event) => {
    seen.push(event.data);
  });
  return seen;
}

function hostReturning(outcome: unknown): WasmValidationHost {
  return { run: async () => outcome, dispose() {} } as unknown as WasmValidationHost;
}

const boom = (): never => {
  throw new Error("boom");
};

describe("a submit that throws part way", () => {
  const sites: Array<[string, () => Partial<FormRuntimeDependencies>, string]> = [
    ["a beforeValidation hook", () => ({ hooks: { beforeValidation: [boom] } as Hooks }), "submit"],
    ["an afterValidation hook", () => ({ hooks: { afterValidation: [boom] } as Hooks }), "submit"],
    [
      "a pipeline stage",
      () => ({ validationPipeline: new ValidationPipeline([{ id: "bad", version: "1.0.0", validate: boom }]) }),
      "submit"
    ],
    [
      "a server validation runner",
      () => ({ serverValidationRunner: { run: async () => boom() } as unknown as NonNullable<FormRuntimeDependencies["serverValidationRunner"]> }),
      "server"
    ]
  ];

  for (const [label, deps, modeId] of sites) {
    it(`settles back to idle and reports one failure when ${label} throws`, async () => {
      const runtime = build(deps());
      const seen = failures(runtime);
      await expect(runtime.submit(modeId, VERSION)).rejects.toThrow("boom");
      expect(runtime.state().submission.status).toBe("idle");
      expect(seen).toEqual([{ modeId, stage: "host" }]);
    });
  }

  it("keeps the throwing beforeSubmit hook's single host failure", async () => {
    const runtime = build({ hooks: { beforeSubmit: [boom] } as Hooks });
    const seen = failures(runtime);
    await expect(runtime.submit("submit", VERSION)).rejects.toThrow("boom");
    expect(runtime.state().submission.status).toBe("idle");
    expect(seen).toEqual([{ modeId: "submit", stage: "host" }]);
  });

  it("leaves an accepted submission submitted when an afterSubmit hook throws", async () => {
    const runtime = build({ hooks: { afterSubmit: [boom] } as Hooks });
    const seen = failures(runtime);
    await expect(runtime.submit("submit", VERSION)).rejects.toThrow("boom");
    expect(runtime.state().submission.status).toBe("submitted");
    expect(seen).toEqual([]);
  });

  it("can be sent again after a failed attempt", async () => {
    let calls = 0;
    const runtime = build({
      hooks: {
        beforeValidation: [
          () => {
            if (calls++ === 0) {
              throw new Error("once");
            }
          }
        ]
      } as Hooks
    });
    await expect(runtime.submit("submit", VERSION)).rejects.toThrow("once");
    const result = await runtime.submit("submit", VERSION);
    expect(result.accepted).toBe(true);
    expect(runtime.state().submission.status).toBe("submitted");
  });
});

describe("the sandbox outcome's shape", () => {
  const outcomes: Record<string, unknown> = {
    "values as a string": { errors: [], values: "oops" },
    "values as a list": { errors: [], values: [] },
    "values as null": { errors: [], values: null },
    "errors as a string": { errors: "x", values: {} },
    "an error entry that is not a record": { errors: [null], values: {} },
    "logs as a string": { errors: [], values: { name: "Ada" }, logs: "x" },
    "no outcome at all": null
  };

  for (const [label, outcome] of Object.entries(outcomes)) {
    it(`refuses the submission on ${label}`, async () => {
      const runtime = build({ wasmValidationHost: hostReturning(outcome) });
      const result = await runtime.submit("submit", VERSION);
      expect(result.accepted).toBe(false);
      expect(result.errors.map((error) => error.code)).toEqual(["wasm.execution_error"]);
      expect(result.canonicalSubmission).toBeUndefined();
      expect(runtime.state().submission.status).toBe("rejected");
    });
  }

  it("publishes no response for an outcome it refused", async () => {
    const runtime = build({ wasmValidationHost: hostReturning({ errors: [], values: "oops" }) });
    const published: Array<Record<string, unknown>> = [];
    runtime.events().subscribe(FormEventType.WASM_VALIDATION_COMPLETED, (event) => {
      published.push(event.data as Record<string, unknown>);
    });
    await runtime.submit("submit", VERSION);
    expect(published).toHaveLength(1);
    expect(published[0]).not.toHaveProperty("response");
    expect(published[0]?.executionError).toMatch(/not \{ errors/);
  });

  it("still accepts a well-formed outcome, logs included", async () => {
    const logs = [{ level: "info", message: "ran" }];
    const runtime = build({ wasmValidationHost: hostReturning({ errors: [], values: { name: "Ada" }, logs }) });
    const published: Array<Record<string, unknown>> = [];
    runtime.events().subscribe(FormEventType.WASM_VALIDATION_COMPLETED, (event) => {
      published.push(event.data as Record<string, unknown>);
    });
    const result = await runtime.submit("submit", VERSION);
    expect(result.accepted).toBe(true);
    expect((published[0]?.response as { logs?: unknown }).logs).toEqual(logs);
  });

  it("still accepts a well-formed outcome", async () => {
    const runtime = build({ wasmValidationHost: hostReturning({ errors: [], values: { name: "Ada" } }) });
    const result = await runtime.submit("submit", VERSION);
    expect(result.accepted).toBe(true);
    expect(result.canonicalSubmission?.submission.values).toEqual({ name: "Ada" });
  });
});

describe("a second submit while one is in flight", () => {
  function heldRuntime(): { runtime: FormRuntime; release: () => void; delivered: () => number } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let delivered = 0;
    const handlers = new SubmissionHandlerRegistry();
    handlers.register({
      id: "count",
      version: "1.0.0",
      handle: async () => {
        delivered += 1;
      }
    } as Parameters<SubmissionHandlerRegistry["register"]>[0]);
    const runtime = build({
      hooks: { beforeValidation: [async () => held] } as Hooks,
      submissionHandlerRegistry: handlers
    });
    return { runtime, release, delivered: () => delivered };
  }

  it("joins the first when it asks for the same thing", async () => {
    const { runtime, release, delivered } = heldRuntime();
    const first = runtime.submit("submit", VERSION, { trigger: { componentId: "send" } });
    const second = runtime.submit("submit", { ...VERSION, form: { ...VERSION.form } }, { trigger: { componentId: "send" } });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    expect(a.accepted).toBe(true);
    expect(delivered()).toBe(1);
  });

  it("is refused with a busy error when it asks for something else", async () => {
    const { runtime, release, delivered } = heldRuntime();
    const first = runtime.submit("submit", VERSION);
    const other = runtime.submit("submit", VERSION, { journeyEndCheck: "skip" });
    await expect(other).rejects.toBeInstanceOf(SubmitBusyError);
    await expect(runtime.submit("server", VERSION)).rejects.toMatchObject({ code: "submission.busy" });
    release();
    expect((await first).accepted).toBe(true);
    expect(delivered()).toBe(1);
  });

  it("starts afresh once the first has settled", async () => {
    const { runtime, release, delivered } = heldRuntime();
    release();
    const first = await runtime.submit("submit", VERSION);
    const second = await runtime.submit("submit", VERSION);
    expect(second).not.toBe(first);
    expect(delivered()).toBe(2);
  });
});

describe("a submit asked from inside the run it would join", () => {
  const within = <T,>(promise: Promise<T>, ms: number): Promise<T | "TIMEOUT"> =>
    Promise.race([promise, new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), ms))]);

  for (const hook of ["beforeSubmit", "transformValues", "beforeValidation", "afterValidation", "afterSubmit"] as const) {
    it(`is refused from a ${hook} hook, and the run still ends`, async () => {
      let runtime!: FormRuntime;
      let nested: unknown = "not called";
      const call = async (values?: unknown): Promise<unknown> => {
        // After a turn, so the run's promise is already held: a join would wait on itself.
        await Promise.resolve();
        nested = await runtime.submit("submit", VERSION).then(
          () => "joined",
          (error: unknown) => error
        );
        return values;
      };
      runtime = build({ hooks: { [hook]: [call] } as unknown as Hooks });
      const first = await within(runtime.submit("submit", VERSION), 2000);
      expect(first).not.toBe("TIMEOUT");
      expect(nested).toBeInstanceOf(SubmitBusyError);
      expect(runtime.state().submission.status).not.toBe("submitting");
      // Released: the next identical submit runs afresh.
      expect(await within(runtime.submit("submit", VERSION), 2000)).not.toBe("TIMEOUT");
    });
  }
});

describe("the sandbox's external data", () => {
  it("is waited on no longer than a data source is, then refuses the submission", async () => {
    const runtime = build({
      dataSourceTimeoutMs: 20,
      wasmExternalDataProvider: () => new Promise<Record<string, unknown>>(() => undefined)
    });
    const result = await runtime.submit("submit", VERSION);
    expect(result.accepted).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(["wasm.execution_error"]);
    expect(runtime.state().submission.status).toBe("rejected");
  });
});
