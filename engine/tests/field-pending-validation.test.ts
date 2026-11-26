import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { ValidationContext, ValidationResult, ValidationStage } from "../form-engine/core/schema/contracts.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline, type ValidationStageEvent } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { PathValidationRuns } from "../form-engine/runtime/browser/path-validation-runs.js";
import { FormEventType, type ValidationCompletedEventData, type ValidationPendingChangedEventData } from "../form-engine/core/events/event-types.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { JsonWasmAbi } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { agentSetup } from "./fixtures/agent-form.js";

/** A promise with its resolve handed out, for a stage the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets every queued continuation run: a macrotask turn drains the whole microtask queue first. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const NO_ERRORS: ValidationResult = { errors: [] };

/**
 * An async stage declaring `email`, answering each call with the next promise the test queued:
 * the contexts it was handed are kept, so a test can read their signals.
 */
function emailCheck(): { stage: ValidationStage; calls: Array<{ context: ValidationContext; answer: ReturnType<typeof deferred<ValidationResult>> }> } {
  const calls: Array<{ context: ValidationContext; answer: ReturnType<typeof deferred<ValidationResult>> }> = [];
  return {
    calls,
    stage: {
      id: "email-taken",
      version: "1",
      kind: "async",
      paths: () => ["email"],
      validate: (context) => {
        const answer = deferred<ValidationResult>();
        calls.push({ context, answer });
        return answer.promise;
      }
    }
  };
}

function takenError(): ValidationResult {
  return { errors: [{ code: "email.taken", componentId: "email", path: "email", stage: "email-taken", source: "custom" }] };
}

function form(): FormDefinition {
  const root: ComponentNode = {
    id: "root",
    type: "container",
    configuration: {},
    children: {
      children: [
        { id: "email", type: "text", configuration: { label: "Email" } },
        { id: "name", type: "text", configuration: { label: "Name" } }
      ]
    }
  };
  return { id: "f", version: "1", schemaVersion: "1", root, localization: { defaultLocale: "en" } };
}

function runtimeWith(stages: ValidationStage[], definition: FormDefinition = form()): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline(stages) });
}

/**
 * The runtime's per-path check, through the public `validatePath`. The default `validateOn`
 * ("commitAfterError") checks a field only once it shows an error, so the field is first given
 * one the way a host's server would (`setErrors`); the check then replaces what it finds.
 */
function checkPath(runtime: FormRuntime, path: string, onCompleted: (errorCount: number) => void = () => {}, answerAfterError?: string): Promise<unknown> {
  runtime.setErrors([{ code: "shown.before", componentId: path, path }]);
  if (answerAfterError !== undefined) {
    // The error stands while its answers do; a newer answer lets the check take it back.
    runtime.setValue(path, answerAfterError);
  }
  const unsubscribe = runtime.events().subscribe(FormEventType.VALIDATION_COMPLETED, (event) => {
    const data = event.data as ValidationCompletedEventData;
    if (data.paths?.[0] === path) {
      onCompleted(data.errorCount);
    }
  });
  return runtime.validatePath(path).finally(() => unsubscribe());
}

/** The codes of the errors the runtime shows now, the setup's "shown.before" left out. */
const shownCodes = (runtime: FormRuntime): string[] => runtime.errors().map((error) => error.code).filter((code) => code !== "shown.before");

const VERSION = { form: { id: "f", version: "1" }, client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" } };

describe("ValidationPipeline per-stage reports and runFor", () => {
  const sync = (id: string, code: string): ValidationStage => ({
    id,
    version: "1",
    validate: () => ({ errors: [{ code, stage: id, source: "client" }] })
  });

  it("reports start and settle per stage with the paths it declares", async () => {
    const events: ValidationStageEvent[] = [];
    const pipeline = new ValidationPipeline([
      { id: "remote", version: "1", kind: "async", paths: () => ["email"], validate: async () => NO_ERRORS },
      sync("fields", "a"),
      { id: "skipped", version: "1", runIf: () => false, validate: () => NO_ERRORS }
    ]);
    const result = await pipeline.run({ formId: "f", values: {} }, { onStage: (event) => events.push(event) });
    expect(result.merged.errors.map((error) => error.code)).toEqual(["a"]);
    expect(result.aborted).toBeUndefined();
    expect(events).toEqual([
      { phase: "start", stageId: "fields", kind: "deterministic" },
      { phase: "settle", stageId: "fields", kind: "deterministic" },
      { phase: "start", stageId: "remote", kind: "async", paths: ["email"] },
      { phase: "settle", stageId: "remote", kind: "async", paths: ["email"] }
    ]);
  });

  it("runFor runs every deterministic stage and only the async stages declaring the path", async () => {
    const ran: string[] = [];
    const asyncStage = (id: string, paths?: string[]): ValidationStage => ({
      id,
      version: "1",
      kind: "async",
      ...(paths !== undefined ? { paths: () => paths } : {}),
      validate: async () => {
        ran.push(id);
        return NO_ERRORS;
      }
    });
    const pipeline = new ValidationPipeline([
      asyncStage("email-check", ["email"]),
      asyncStage("name-check", ["name"]),
      asyncStage("form-wide"),
      { id: "fields", version: "1", validate: () => (ran.push("fields"), NO_ERRORS) }
    ]);
    await pipeline.runFor({ formId: "f", values: {} }, "email");
    expect(ran).toEqual(["fields", "email-check"]);
    ran.length = 0;
    await pipeline.run({ formId: "f", values: {} });
    expect(ran).toEqual(["fields", "email-check", "name-check", "form-wide"]);
  });

  it("drops the result of a stage whose signal aborts, honoured or ignored, and starts no later stage", async () => {
    const controller = new AbortController();
    const ignoring = deferred<ValidationResult>();
    const later: string[] = [];
    const pipeline = new ValidationPipeline([
      { id: "ignores", version: "1", kind: "async", paths: () => ["email"], validate: () => ignoring.promise },
      { id: "later", version: "1", kind: "async", paths: () => ["email"], validate: async () => (later.push("ran"), NO_ERRORS) }
    ]);
    const events: ValidationStageEvent[] = [];
    const running = pipeline.runFor({ formId: "f", values: {}, signal: controller.signal }, "email", { onStage: (event) => events.push(event) });
    await flush();
    controller.abort();
    ignoring.resolve(takenError());
    const result = await running;
    expect(result).toMatchObject({ aborted: true, merged: { errors: [] } });
    expect(later).toEqual([]);
    expect(events.at(-1)).toMatchObject({ phase: "settle", stageId: "ignores", aborted: true });

    // A stage honouring the signal rejects: that is the run going stale, not a failure.
    const second = new AbortController();
    const honouring = new ValidationPipeline([
      {
        id: "honours",
        version: "1",
        kind: "async",
        paths: () => ["email"],
        validate: (context) =>
          new Promise<ValidationResult>((_resolve, reject) => {
            context.signal?.addEventListener("abort", () => reject(new DOMException("stale", "AbortError")));
          })
      }
    ]);
    const out = honouring.runFor({ formId: "f", values: {}, signal: second.signal }, "email");
    await flush();
    second.abort();
    await expect(out).resolves.toMatchObject({ aborted: true });
  });

  it("reports a stage that throws as settled and failed before the error leaves the run", async () => {
    const events: ValidationStageEvent[] = [];
    const pipeline = new ValidationPipeline([
      { id: "broken", version: "1", kind: "async", paths: () => ["email"], validate: async () => Promise.reject(new Error("down")) }
    ]);
    await expect(pipeline.run({ formId: "f", values: {} }, { onStage: (event) => events.push(event) })).rejects.toThrow("down");
    expect(events.at(-1)).toMatchObject({ phase: "settle", stageId: "broken", failed: true });
  });
});

describe("PathValidationRuns tokens", () => {
  it("a stale run A never clears run B's pending and never commits", async () => {
    const flips: Array<[string, boolean]> = [];
    const runs = new PathValidationRuns((path, pending) => flips.push([path, pending]));
    const a = deferred<string>();
    const b = deferred<string>();
    const committed: string[] = [];
    const start = (answer: Promise<string>) =>
      runs.run(
        "email",
        async (run) => {
          run.onStage({ phase: "start", stageId: "s", kind: "async", paths: ["email"] });
          const value = await answer;
          run.onStage({ phase: "settle", stageId: "s", kind: "async", paths: ["email"] });
          return value;
        },
        (value) => committed.push(value)
      );
    const runA = start(a.promise);
    await flush();
    const runB = start(b.promise);
    await flush();
    expect(runs.isPending("email")).toBe(true);

    a.resolve("A");
    await expect(runA).resolves.toEqual({ current: false });
    expect(runs.isPending("email")).toBe(true);
    expect(committed).toEqual([]);

    b.resolve("B");
    await expect(runB).resolves.toEqual({ current: true, result: "B" });
    expect(runs.isPending("email")).toBe(false);
    expect(committed).toEqual(["B"]);
    expect(flips).toEqual([
      ["email", true],
      ["email", false]
    ]);
  });

  it("aborts the replaced run's signal and swallows its rejection", async () => {
    const runs = new PathValidationRuns(() => {});
    let firstSignal: AbortSignal | undefined;
    const first = runs.run(
      "email",
      (run) =>
        new Promise<string>((_resolve, reject) => {
          firstSignal = run.signal;
          run.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      () => {}
    );
    await flush();
    expect(firstSignal?.aborted).toBe(false);
    const second = runs.run("email", async () => "fresh", () => {});
    expect(firstSignal?.aborted).toBe(true);
    await expect(first).resolves.toEqual({ current: false });
    await expect(second).resolves.toEqual({ current: true, result: "fresh" });
  });

  it("keeps a whole-form run's pending apart from the path tokens", () => {
    const runs = new PathValidationRuns(() => {});
    const formRun = runs.formRun();
    formRun.onStage({ phase: "start", stageId: "s", kind: "async", paths: ["email", "name"] });
    expect(runs.isPending("email")).toBe(true);
    expect(runs.isPending("name")).toBe(true);
    formRun.onStage({ phase: "settle", stageId: "s", kind: "async", paths: ["email", "name"] });
    expect(runs.isPending("email")).toBe(false);
    // A run that ends while a stage is out (it threw) releases what it still counted.
    formRun.onStage({ phase: "start", stageId: "t", kind: "async", paths: ["email"] });
    formRun.end();
    expect(runs.isPending("email")).toBe(false);
  });
});

describe("FormRuntime per-field pending state", () => {
  it("marks the checked path pending in the state, the events and the field model, and clears it on settle", async () => {
    const check = emailCheck();
    const runtime = runtimeWith([check.stage]);
    const changes: ValidationPendingChangedEventData[] = [];
    runtime.events().subscribe(FormEventType.VALIDATION_PENDING_CHANGED, (event) => changes.push(event.data as ValidationPendingChangedEventData));
    runtime.setValue("email", "ada@example.org");

    const out = checkPath(runtime, "email");
    await flush();
    expect([...(runtime.state().validation.pending ?? [])]).toEqual(["email"]);
    expect([...runtime.pendingPaths()]).toEqual(["email"]);
    const output = await buildRuntimeRenderOutput(runtime, "interactive");
    expect(output.components.find((model) => model.id === "email")?.pending).toBe(true);
    expect(output.components.find((model) => model.id === "name")?.pending).toBeUndefined();

    check.calls[0]!.answer.resolve(takenError());
    await out;
    expect(shownCodes(runtime)).toEqual(["email.taken"]);
    expect(runtime.state().validation.pending?.size).toBe(0);
    expect(changes).toEqual([
      { path: "email", pending: true, paths: ["email"] },
      { path: "email", pending: false, paths: [] }
    ]);
  });

  it("stale run A leaves run B's pending, is aborted, and never commits", async () => {
    const check = emailCheck();
    const runtime = runtimeWith([check.stage]);
    const completed: number[] = [];
    const runA = checkPath(runtime, "email", (count) => completed.push(count));
    await flush();
    const runB = checkPath(runtime, "email", (count) => completed.push(count));
    await flush();
    expect(check.calls).toHaveLength(2);
    expect(check.calls[0]!.context.signal?.aborted).toBe(true);
    expect(check.calls[1]!.context.signal?.aborted).toBe(false);

    check.calls[0]!.answer.resolve(takenError());
    await runA;
    expect(runtime.pendingPaths().has("email")).toBe(true);
    expect(shownCodes(runtime)).toEqual([]);

    check.calls[1]!.answer.resolve(NO_ERRORS);
    await runB;
    expect(runtime.pendingPaths().has("email")).toBe(false);
    // Only B committed: A's verdict ("email.taken") was dropped, and exactly one check completed.
    expect(shownCodes(runtime)).toEqual([]);
    expect(completed).toEqual([0]);
  });

  it("submit() waits for a check still out before its own validation", async () => {
    const check = emailCheck();
    const runtime = runtimeWith([check.stage]);
    const order: string[] = [];
    const out = checkPath(runtime, "email", () => order.push("check committed"));
    await flush();
    const submitting = runtime.submit("submit", VERSION).then((result) => {
      order.push("submit settled");
      return result;
    });
    await flush();
    // The submission has not started its own pipeline run: the stage was asked once, by the check.
    expect(check.calls).toHaveLength(1);
    check.calls[0]!.answer.resolve(NO_ERRORS);
    await out;
    await flush();
    // Now the submission's own run asks the stage, with no abort signal of its own.
    expect(check.calls).toHaveLength(2);
    expect(check.calls[1]!.context.signal).toBeUndefined();
    expect(runtime.pendingPaths().has("email")).toBe(true);
    check.calls[1]!.answer.resolve(NO_ERRORS);
    await expect(submitting).resolves.toMatchObject({ accepted: true });
    expect(order).toEqual(["check committed", "submit settled"]);
    expect(runtime.pendingPaths().size).toBe(0);
  });

  it("a journey's Continue waits for a check still out", async () => {
    const check = emailCheck();
    const definition = form();
    definition.journey = {
      journeys: [
        {
          id: "apply",
          validation: { continue: "page" },
          pages: [
            { id: "one", title: "One", components: ["email"] },
            { id: "two", title: "Two", components: ["name"] }
          ]
        }
      ]
    };
    const runtime = runtimeWith([check.stage], definition);
    runtime.startJourney("apply");
    const out = checkPath(runtime, "email", () => {}, "ada@example.org");
    await flush();
    let moved = false;
    const continuing = runtime.nextPage().then((result) => {
      moved = true;
      return result;
    });
    await flush();
    expect(moved).toBe(false);
    expect(check.calls).toHaveLength(1);
    check.calls[0]!.answer.resolve(NO_ERRORS);
    await out;
    await flush();
    // The page's own validation runs the stage again, after the check settled.
    expect(check.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of check.calls.slice(1)) {
      call.answer.resolve(NO_ERRORS);
    }
    await expect(continuing).resolves.toMatchObject({ ok: true, pageId: "two" });
  });
});

describe("agent describe_form", () => {
  it("reports a field whose answer an async check is judging as pending, and drops it once settled", async () => {
    const check = emailCheck();
    const setup = agentSetup(form(), { deps: { validationPipeline: new ValidationPipeline([check.stage]) } });
    const pendingOf = async (): Promise<Record<string, unknown>> => {
      const result = await setup.ok("describe_form");
      const fields = result.fields as Array<Record<string, unknown>>;
      return Object.fromEntries(fields.map((field) => [field.path, field.pending]));
    };
    const out = checkPath(setup.runtime, "email");
    await flush();
    expect(await pendingOf()).toEqual({ email: true, name: undefined });
    check.calls[0]!.answer.resolve(NO_ERRORS);
    await out;
    expect(await pendingOf()).toEqual({ email: undefined, name: undefined });
  });
});

describe("pending state plumbing", () => {
  it("snapshots copy the pending set", () => {
    const store = new FormStateStore();
    expect(store.setPending("email", true)).toBe(true);
    expect(store.setPending("email", true)).toBe(false);
    const snapshot = store.snapshot();
    store.setPending("email", false);
    expect([...(snapshot.validation.pending ?? [])]).toEqual(["email"]);
    expect(store.snapshot().validation.pending?.size).toBe(0);
  });

  it("keeps the abort signal off the sandbox ABI", () => {
    const abi = new JsonWasmAbi();
    const context = { formId: "f", values: {}, form: form().root, signal: new AbortController().signal };
    const serialized = abi.serializeContext(context as never, { allowedExternalDataKeys: [] } as never);
    expect(serialized).not.toContain("signal");
  });
});
