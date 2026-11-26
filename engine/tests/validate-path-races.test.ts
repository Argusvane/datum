import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { ValidationContext, ValidationResult, ValidationStage } from "../form-engine/core/schema/contracts.js";
import type { FormDraft } from "../form-engine/persistence/core/draft-store.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { EventBus } from "../form-engine/core/events/event-bus.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { attachTelemetry } from "../form-engine/verification/telemetry-bridge.js";
import { InMemoryTelemetrySink } from "../form-engine/verification/telemetry-sinks.js";

/*
 * Checks of one field (`validatePath`) racing the other ways answers change and the form is
 * judged: a submit, a draft load, row moves, a host's write, a journey's Continue and Back, and
 * the telemetry bridge's view of the events.
 */

const VERSION = { form: { id: "f", version: "1" }, client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" } };

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function field(id: string, configuration: Record<string, unknown> = {}): ComponentNode {
  return { id, type: "text", configuration };
}

function definition(content: ComponentNode[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return { id: "f", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration: {}, children: { content } }, ...extra };
}

function build(shape: FormDefinition, stages: ValidationStage[]): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(shape, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(shape.root), ...stages])
  });
}

/** An async stage declaring `paths`, answered by hand: each call is kept with the values it was asked about. */
function asyncStage(paths: string[]) {
  const calls: Array<{ values: Record<string, unknown>; answer: ReturnType<typeof deferred<ValidationResult>> }> = [];
  const stage: ValidationStage = {
    id: "remote",
    version: "1",
    kind: "async",
    paths: () => paths,
    validate: (context: ValidationContext) => {
      const answer = deferred<ValidationResult>();
      calls.push({ values: { ...context.values }, answer });
      return answer.promise;
    }
  };
  return { calls, stage };
}

const taken = (code: string, componentId: string, path: string): ValidationResult => ({
  errors: [{ code, componentId, path, stage: "remote", source: "custom" }]
});
const clean: ValidationResult = { errors: [] };

const codes = (runtime: FormRuntime): string[] =>
  runtime
    .errors()
    .map((error) => `${error.code}@${error.path ? error.path.segments.map((s) => `${s.key}${s.index !== undefined ? `[${s.index}]` : ""}`).join(".") : "-"}`)
    .sort();

const journeyShape = (): FormDefinition =>
  definition([field("a"), field("email"), field("c")], {
    journey: { journeys: [{ id: "apply", validation: { continue: "page" }, pages: [{ id: "one", components: ["a"] }, { id: "two", components: ["email"] }, { id: "three", components: ["c"] }] }] }
  } as Partial<FormDefinition>);

describe("a submit reads the answers after the field checks it waited for", () => {
  it("sends the answer typed during the wait, and validates that same answer", async () => {
    const check = asyncStage(["email"]);
    const runtime = build(definition([field("name", { required: true }), field("email")]), [check.stage]);
    runtime.setErrors([{ code: "email.shown", componentId: "email", path: "email" }]);
    runtime.setValue("email", "e@x.ca");
    const pathCheck = runtime.validatePath("email");
    await flush();
    const submit = runtime.submit("submit", VERSION);
    await flush();
    // The person fills the required name in while the submission waits for the email check.
    runtime.setValue("name", "Ada");
    check.calls[0]?.answer.resolve(clean);
    await pathCheck;
    await flush();
    // The submission's own run asks the stage about the answers it sends.
    expect(check.calls[1]?.values).toMatchObject({ name: "Ada", email: "e@x.ca" });
    check.calls[1]?.answer.resolve(clean);
    const outcome = await submit;
    expect(outcome.accepted).toBe(true);
    expect(outcome.canonicalSubmission?.submission.values).toMatchObject({ name: "Ada", email: "e@x.ca" });
  });

  it("refuses when the answer that would be sent is missing", async () => {
    const check = asyncStage(["email"]);
    const runtime = build(definition([field("name", { required: true }), field("email")]), [check.stage]);
    runtime.setErrors([{ code: "email.shown", componentId: "email", path: "email" }]);
    runtime.setValue("email", "e@x.ca");
    const pathCheck = runtime.validatePath("email");
    await flush();
    const submit = runtime.submit("submit", VERSION);
    await flush();
    check.calls[0]?.answer.resolve(clean);
    await pathCheck;
    await flush();
    check.calls[1]?.answer.resolve(clean);
    const outcome = await submit;
    expect(outcome.accepted).toBe(false);
    expect(outcome.errors.map((error) => error.componentId)).toContain("name");
  });
});

describe("a check whose answer was replaced some other way writes nothing", () => {
  it("a draft loaded during the check: the old answer's verdict never lands on the draft's", async () => {
    const check = asyncStage(["email"]);
    const runtime = build(definition([field("email")]), [check.stage]);
    runtime.setErrors([{ code: "email.shown", componentId: "email", path: "email" }]);
    runtime.setValue("email", "taken@x.ca");
    const first = runtime.validatePath("email");
    await flush();
    expect(runtime.pendingPaths().has("email")).toBe(true);
    const draft: FormDraft = {
      id: "d1",
      formId: "f",
      formVersion: "1",
      runtime: { schemaVersion: "1", rendererVersion: "0.1.0" },
      locale: "en",
      values: { email: "free@x.ca" },
      state: { touched: [], dirty: [] },
      updatedAt: 0
    };
    const loading = runtime.hydrateFromDraft(draft);
    await flush();
    check.calls[1]?.answer.resolve(clean);
    await loading;
    expect(codes(runtime)).toEqual([]);
    check.calls[0]?.answer.resolve(taken("email.taken", "email", "email"));
    await first;
    expect(runtime.state().values.email).toBe("free@x.ca");
    expect(codes(runtime)).toEqual([]);
    expect(runtime.pendingPaths().size).toBe(0);
  });

  it("a row removed during a check of items[1].sku: no verdict on the entry that moved up", async () => {
    const check = asyncStage(["items[1].sku"]);
    const shape = definition([
      { id: "items", type: "dataGrid", configuration: { label: "Items" }, collection: { collectionPath: "items" }, children: { content: [field("sku")] } } as ComponentNode
    ]);
    const runtime = build(shape, [check.stage]);
    runtime.addRow("items", {});
    runtime.addRow("items", {});
    runtime.setValue("items[0].sku", "A");
    runtime.setValue("items[1].sku", "B-dup");
    runtime.setValue("items[2].sku", "C-fine");
    runtime.setErrors([{ code: "sku.shown", componentId: "sku", path: "items[1].sku" }]);
    const first = runtime.validatePath("items[1].sku");
    await flush();
    expect(runtime.pendingPaths().has("items[1].sku")).toBe(true);
    runtime.removeRow("items", 0);
    // Called off at once: nothing pending, and a submit would not wait for it.
    expect(runtime.pendingPaths().has("items[1].sku")).toBe(false);
    check.calls[0]?.answer.resolve(taken("sku.taken", "sku", "items[1].sku"));
    await first;
    expect(codes(runtime)).not.toContain("sku.taken@items[1].sku");
  });

  it("a row moved during the check, the same answer in both rows: the entry key tells them apart", async () => {
    const check = asyncStage(["items[1].sku"]);
    const shape = definition([
      { id: "items", type: "dataGrid", configuration: { label: "Items" }, collection: { collectionPath: "items" }, children: { content: [field("sku")] } } as ComponentNode
    ]);
    (shape.root.children!.content![0]!.configuration as Record<string, unknown>).canReorder = true;
    const runtime = build(shape, [check.stage]);
    runtime.addRow("items", {});
    runtime.setValue("items[0].sku", "same");
    runtime.setValue("items[1].sku", "same");
    runtime.setErrors([{ code: "sku.shown", componentId: "sku", path: "items[1].sku" }]);
    const first = runtime.validatePath("items[1].sku");
    await flush();
    runtime.reorderRow("items", 1, 0);
    check.calls[0]?.answer.resolve(taken("sku.taken", "sku", "items[1].sku"));
    await first;
    expect(codes(runtime)).not.toContain("sku.taken@items[1].sku");
  });

  it("a host's setValue during the check (no check of its own): the verdict is dropped", async () => {
    const check = asyncStage(["email"]);
    const runtime = build(definition([field("email")]), [check.stage]);
    runtime.setErrors([{ code: "email.shown", componentId: "email", path: "email" }]);
    runtime.setValue("email", "taken@x.ca");
    const completed: unknown[] = [];
    runtime.events().subscribe(FormEventType.VALIDATION_COMPLETED, (event) => completed.push(event.data));
    const first = runtime.validatePath("email");
    await flush();
    runtime.setValue("email", "free@x.ca");
    check.calls[0]?.answer.resolve(taken("email.taken", "email", "email"));
    await first;
    expect(codes(runtime)).toEqual(["email.shown@email"]);
    expect(completed).toEqual([]);
    expect(runtime.pendingPaths().size).toBe(0);
  });

  it("the answer unchanged: the verdict is written as before", async () => {
    const check = asyncStage(["email"]);
    const runtime = build(definition([field("email"), field("other")]), [check.stage]);
    runtime.setErrors([{ code: "email.shown", componentId: "email", path: "email" }]);
    runtime.setValue("email", "taken@x.ca");
    const first = runtime.validatePath("email");
    await flush();
    // A write elsewhere does not touch this check.
    runtime.setValue("other", "x");
    check.calls[0]?.answer.resolve(taken("email.taken", "email", "email"));
    await first;
    expect(codes(runtime)).toEqual(["email.taken@email"]);
  });
});

describe("Back while Continue waits on a field check calls the Continue off", () => {
  async function onPageTwo() {
    const check = asyncStage(["email"]);
    const runtime = build(journeyShape(), [check.stage]);
    runtime.startJourney("apply");
    const toTwo = runtime.nextPage();
    await flush();
    check.calls[0]?.answer.resolve(clean);
    expect((await toTwo).ok).toBe(true);
    expect(runtime.journeyView()?.pageId).toBe("two");
    runtime.setErrors([{ code: "email.shown", componentId: "email", path: "email" }]);
    runtime.setValue("email", "x@x.ca");
    const pathCheck = runtime.validatePath("email");
    await flush();
    return { check, runtime, pathCheck };
  }

  it("refuses with cancelled and stays on the page Back went to", async () => {
    const { check, runtime, pathCheck } = await onPageTwo();
    const cont = runtime.nextPage();
    const back = await runtime.previousPage();
    expect(back.ok).toBe(true);
    expect(runtime.journeyView()?.pageId).toBe("one");
    check.calls[1]?.answer.resolve(clean);
    await pathCheck;
    const result = await cont;
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.reason : undefined).toBe("cancelled");
    expect(runtime.journeyView()?.pageId).toBe("one");
    // The Continue never judged page one.
    expect(check.calls).toHaveLength(2);
  });

  it("a second Continue during the wait is refused as pending, and the first goes on", async () => {
    const { check, runtime, pathCheck } = await onPageTwo();
    const cont = runtime.nextPage();
    const second = await runtime.nextPage();
    expect(second.ok === false ? second.reason : undefined).toBe("pending");
    check.calls[1]?.answer.resolve(clean);
    await pathCheck;
    await flush();
    check.calls[2]?.answer.resolve(clean);
    expect((await cont).ok).toBe(true);
    expect(runtime.journeyView()?.pageId).toBe("three");
  });
});

describe("a whole-form run leaves a newer field verdict in place", () => {
  it("during a submit, the re-check of a changed answer stands; the submission decides on what it sent", async () => {
    const check = asyncStage(["email"]);
    const runtime = build(definition([field("email")]), [check.stage]);
    runtime.setValue("email", "taken@x.ca");
    const submit = runtime.submit("submit", VERSION);
    await flush();
    expect(check.calls).toHaveLength(1);
    runtime.setValue("email", "free@x.ca");
    const path = runtime.validatePath("email");
    await flush();
    check.calls[1]?.answer.resolve(clean);
    await path;
    check.calls[0]?.answer.resolve(taken("email.taken", "email", "email"));
    const outcome = await submit;
    // The submission validated and would have sent taken@: refused on that.
    expect(outcome.accepted).toBe(false);
    expect(outcome.errors.map((error) => error.code)).toContain("email.taken");
    // What shows is the verdict on the answer there now.
    expect(runtime.state().values.email).toBe("free@x.ca");
    expect(codes(runtime)).toEqual([]);
  });

  it("a page's Continue leaves the newer verdict too", async () => {
    const check = asyncStage(["email"]);
    const runtime = build(journeyShape(), [check.stage]);
    runtime.startJourney("apply");
    const toTwo = runtime.nextPage();
    await flush();
    check.calls[0]?.answer.resolve(clean);
    await toTwo;
    runtime.setValue("email", "taken@x.ca");
    const cont = runtime.nextPage();
    await flush();
    expect(check.calls).toHaveLength(2);
    runtime.setValue("email", "free@x.ca");
    const path = runtime.validatePath("email");
    await flush();
    check.calls[2]?.answer.resolve(clean);
    await path;
    check.calls[1]?.answer.resolve(taken("email.taken", "email", "email"));
    await cont;
    expect(codes(runtime)).toEqual([]);
  });
});

describe("the telemetry bridge leaves checks of single paths out of the form-wide metrics", () => {
  it("counts only unscoped runs, and a scoped start does not reset a run's timer", () => {
    const bus = new EventBus();
    const sink = new InMemoryTelemetrySink();
    attachTelemetry(bus, sink, { dimensions: { form_id: "f" } });
    const event = (type: string, data?: unknown) => ({ id: type, type, timestamp: Date.now(), source: "validation" as const, formId: "f", data });
    bus.publish(event(FormEventType.VALIDATION_STARTED, { paths: ["email"] }));
    bus.publish(event(FormEventType.VALIDATION_COMPLETED, { errorCount: 3, paths: ["email"] }));
    expect(sink.metricValues("validation.error.count.by_stage")).toEqual([]);
    expect(sink.metricValues("validation.latency.p50")).toEqual([]);
    bus.publish(event(FormEventType.VALIDATION_STARTED));
    bus.publish(event(FormEventType.VALIDATION_COMPLETED, { errorCount: 2 }));
    expect(sink.metricValues("validation.error.count.by_stage")).toEqual([2]);
    expect(sink.metricValues("validation.latency.p50")).toHaveLength(1);
  });
});

describe("go-on attempts belong to the answers they were made on", () => {
  it("a draft load forgets the previous session's submit attempt", async () => {
    let calls = 0;
    const counting: ValidationStage = { id: "count", version: "1", kind: "async", paths: () => ["email"], validate: async () => ((calls += 1), clean) };
    const runtime = build(definition([field("name", { required: true }), field("email")]), [counting]);
    expect((await runtime.submit("submit", VERSION)).accepted).toBe(false);
    await runtime.hydrateFromDraft({
      id: "d1",
      formId: "f",
      formVersion: "1",
      runtime: { schemaVersion: "1", rendererVersion: "0.1.0" },
      locale: "en",
      values: { name: "Ada" },
      state: { touched: [], dirty: [] },
      updatedAt: 0
    });
    const before = calls;
    runtime.setValue("email", "e@x.ca");
    await runtime.validatePath("email");
    // No error on email, no attempt in this session: the first blur checks nothing.
    expect(calls).toBe(before);
  });

  it("a journey draft's completed pages count as continued from", async () => {
    const calls = { a: 0, email: 0 };
    const counting = (path: "a" | "email"): ValidationStage => ({
      id: `count-${path}`,
      version: "1",
      kind: "async",
      paths: () => [path],
      validate: async () => ((calls[path] += 1), clean)
    });
    const runtime = build(journeyShape(), [counting("a"), counting("email")]);
    runtime.startJourney("apply");
    await runtime.hydrateFromDraft({
      id: "d1",
      formId: "f",
      formVersion: "1",
      runtime: { schemaVersion: "1", rendererVersion: "0.1.0" },
      locale: "en",
      values: { a: "1" },
      state: { touched: [], dirty: [], journey: { id: "apply", page: "two", completed: ["one"] } },
      updatedAt: 0
    });
    expect(runtime.journeyView()?.pageId).toBe("two");
    const before = { ...calls };
    runtime.setValue("a", "2");
    await runtime.validatePath("a");
    expect(calls.a).toBe(before.a + 1);
    // The page resumed on was not continued from: its field waits for an error or a Continue.
    runtime.setValue("email", "e@x.ca");
    await runtime.validatePath("email");
    expect(calls.email).toBe(before.email);
  });
});
