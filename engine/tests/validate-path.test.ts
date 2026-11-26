import { describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { ValidationContext, ValidationResult, ValidationStage } from "../form-engine/core/schema/contracts.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { readValidateOnSetting } from "../form-engine/core/schema/validate-on-setting.js";

/*
 * The leave-field check (`FormRuntime.validatePath`): when it runs (validateOn, an error shown,
 * a go-on attempted), what it replaces (the errors whose own path it is), what it keeps (a
 * standing server error), what it publishes, and the hooks it leaves alone.
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

function field(id: string, configuration: Record<string, unknown> = { required: true }): ComponentNode {
  return { id, type: "text", configuration };
}

function definition(content: ComponentNode[], rootConfiguration: Record<string, unknown> = {}, extra: Partial<FormDefinition> = {}): FormDefinition {
  return {
    id: "f",
    version: "1",
    schemaVersion: "1",
    root: { id: "root", type: "form", configuration: rootConfiguration, children: { content } },
    ...extra
  };
}

function build(shape: FormDefinition, deps: Partial<FormRuntimeDependencies> = {}, extraStages: ValidationStage[] = []): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(shape, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(shape.root), ...extraStages]),
    ...deps
  });
}

const codes = (runtime: FormRuntime): string[] =>
  runtime
    .errors()
    .map((error) => `${error.componentId ?? "-"}:${error.code}`)
    .sort();

describe("validateOn on the form root", () => {
  it("reads submit and commitAfterError; anything else is the default", () => {
    expect(readValidateOnSetting({ validateOn: "submit" })).toBe("submit");
    expect(readValidateOnSetting({ validateOn: "commitAfterError" })).toBe("commitAfterError");
    expect(readValidateOnSetting({})).toBe("commitAfterError");
    expect(readValidateOnSetting({ validateOn: "blur" })).toBe("commitAfterError");
    expect(readValidateOnSetting(undefined)).toBe("commitAfterError");
  });
});

describe("validatePath: when it checks", () => {
  it("does not check a field that shows no error and was not tried (never on first blur)", async () => {
    const runtime = build(definition([field("name"), field("age")]));
    runtime.setValue("name", "");
    await runtime.validatePath("name");
    expect(codes(runtime)).toEqual([]);
  });

  it("checks a field already showing an error, clearing it once fixed and leaving others alone", async () => {
    const runtime = build(definition([field("name"), field("age")]));
    await runtime.validate();
    expect(codes(runtime)).toEqual(["age:required", "name:required"]);
    runtime.setValue("name", "Ada");
    await runtime.validatePath("name");
    expect(codes(runtime)).toEqual(["age:required"]);
    expect(runtime.state().validation.valid).toBe(false);
    runtime.setValue("age", "7");
    await runtime.validatePath("age");
    expect(runtime.state().validation.valid).toBe(true);
  });

  it("checks every field after the first submit attempt, including one that showed no error", async () => {
    const runtime = build(definition([field("name"), field("age")]));
    runtime.setValue("name", "Ada");
    runtime.setValue("age", "7");
    const first = await runtime.submit("submit", VERSION);
    expect(first.accepted).toBe(true);
    runtime.setValue("age", "");
    await runtime.validatePath("age");
    expect(codes(runtime)).toEqual(["age:required"]);
  });

  it("with validateOn submit checks nothing, even a field showing an error", async () => {
    const runtime = build(definition([field("name")], { validateOn: "submit" }));
    await runtime.validate();
    runtime.setValue("name", "Ada");
    await runtime.validatePath("name");
    expect(codes(runtime)).toEqual(["name:required"]);
    await runtime.validate();
    expect(codes(runtime)).toEqual([]);
  });

  it("counts a journey page's Continue as the first attempt for that page's fields only", async () => {
    const journey: Journey = {
      id: "apply",
      validation: { continue: "page" },
      pages: [
        { id: "one", components: ["a", "b"] },
        { id: "two", components: ["c"] }
      ]
    };
    const runtime = build(definition([field("a"), field("b"), field("c")], {}, { journey: { journeys: [journey] } }));
    runtime.startJourney("apply");
    runtime.setValue("a", "x");
    runtime.setValue("b", "y");
    // Before Continue: nothing is tried, so an emptied field is not checked.
    runtime.setValue("b", "");
    await runtime.validatePath("b");
    expect(codes(runtime)).toEqual([]);
    runtime.setValue("b", "y");
    expect((await runtime.nextPage()).ok).toBe(true);
    // Page one was tried: its fields are checked as they are committed, page two's still are not.
    runtime.setValue("b", "");
    await runtime.validatePath("b");
    await runtime.validatePath("c");
    expect(codes(runtime)).toEqual(["b:required"]);
  });
});

describe("validatePath: what it replaces", () => {
  const rows = (): FormDefinition =>
    definition([
      {
        id: "items",
        type: "dataGrid",
        configuration: { label: "Items" },
        collection: { collectionPath: "items" },
        children: { content: [field("sku")] }
      }
    ]);

  it("replaces only the errors on the path: items[1].sku leaves items[0].sku alone", async () => {
    const runtime = build(rows());
    // A data grid opens with one row; one more makes two.
    runtime.addRow("items", {});
    await runtime.validate();
    const before = runtime
      .errors()
      .map((error) => (error.path ? error.path.segments.map((s) => `${s.key}${s.index !== undefined ? `[${s.index}]` : ""}`).join(".") : "-"))
      .sort();
    expect(before).toEqual(["items[0].sku", "items[1].sku"]);
    const rowZero = runtime.errors().find((error) => error.path?.segments[0]?.index === 0);
    runtime.setValue("items[1].sku", "A-1");
    await runtime.validatePath("items[1].sku");
    const after = runtime.errors();
    expect(after).toHaveLength(1);
    expect(after[0]?.path?.segments).toEqual([{ key: "items", index: 0 }, { key: "sku" }]);
    // The first row's error is untouched: the same object, not a re-found copy.
    expect(after[0]).toBe(rowZero);
  });

  it("finds a new error on the path and keeps the other path's errors, not picking by component id", async () => {
    const runtime = build(rows());
    // A data grid opens with one row; one more makes two.
    runtime.addRow("items", {});
    runtime.setValue("items[0].sku", "A-1");
    runtime.setValue("items[1].sku", "B-1");
    await runtime.submit("submit", VERSION);
    runtime.setValue("items[1].sku", "");
    await runtime.validatePath("items[1].sku");
    const found = runtime.errors();
    expect(found.map((error) => error.code)).toEqual(["required"]);
    expect(found[0]?.path?.segments[0]).toEqual({ key: "items", index: 1 });
  });
});

describe("validatePath: server errors", () => {
  it("keeps a server error while its answers stand and drops it on the first commit that changes them", async () => {
    const runtime = build(definition([field("name", {})]));
    runtime.setValue("name", "Ada");
    runtime.setErrors([{ code: "name.taken", componentId: "name" }]);
    await runtime.validatePath("name");
    expect(codes(runtime)).toEqual(["name:name.taken"]);
    runtime.setValue("name", "Grace");
    await runtime.validatePath("name");
    expect(codes(runtime)).toEqual([]);
  });

  it("holds the same rule for an error that names a value path", async () => {
    const runtime = build(definition([field("name", {})]));
    runtime.setValue("name", "Ada");
    runtime.setErrors([{ code: "name.taken", componentId: "name", path: "name" }]);
    await runtime.validatePath("name");
    expect(codes(runtime)).toEqual(["name:name.taken"]);
    runtime.setValue("name", "Grace");
    await runtime.validatePath("name");
    expect(codes(runtime)).toEqual([]);
  });

  it("holds the rule on a journey page as well", async () => {
    const journey: Journey = { id: "apply", validation: { continue: "page" }, pages: [{ id: "one", components: ["name"] }, { id: "two", components: ["other"] }] };
    const runtime = build(definition([field("name", {}), field("other", {})], {}, { journey: { journeys: [journey] } }));
    runtime.startJourney("apply");
    runtime.setValue("name", "Ada");
    runtime.setErrors([{ code: "name.taken", componentId: "name" }]);
    await runtime.validatePath("name");
    expect(codes(runtime)).toEqual(["name:name.taken"]);
    runtime.setValue("name", "Grace");
    await runtime.validatePath("name");
    expect(codes(runtime)).toEqual([]);
  });

  it("leaves a server error on another path alone", async () => {
    const runtime = build(definition([field("name", {}), field("age", {})]));
    runtime.setValue("name", "Ada");
    runtime.setValue("age", "7");
    runtime.setErrors([{ code: "age.bad", componentId: "age" }, { code: "name.bad", componentId: "name" }]);
    runtime.setValue("name", "Hopper");
    await runtime.validatePath("name");
    expect(codes(runtime)).toEqual(["age:age.bad"]);
  });
});

describe("validatePath: events and hooks", () => {
  it("publishes scoped VALIDATION_STARTED and VALIDATION_COMPLETED and runs neither validation hook", async () => {
    const before = vi.fn();
    const after = vi.fn();
    const runtime = build(definition([field("name")]), { hooks: { beforeValidation: [before], afterValidation: [after] } });
    await runtime.validate();
    before.mockClear();
    after.mockClear();
    const seen: Array<{ type: string; data: unknown }> = [];
    for (const type of [FormEventType.VALIDATION_STARTED, FormEventType.VALIDATION_COMPLETED, FormEventType.ERRORS_CHANGED]) {
      runtime.events().subscribe(type, (event) => seen.push({ type: event.type, data: event.data }));
    }
    await runtime.validatePath("name");
    expect(seen).toEqual([
      { type: FormEventType.VALIDATION_STARTED, data: { paths: ["name"] } },
      { type: FormEventType.VALIDATION_COMPLETED, data: { errorCount: 1, paths: ["name"] } },
      { type: FormEventType.ERRORS_CHANGED, data: { errorCount: 1 } }
    ]);
    expect(before).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    // A whole-form run says nothing of paths.
    seen.length = 0;
    await runtime.validate();
    expect(seen[0]).toEqual({ type: FormEventType.VALIDATION_STARTED, data: undefined });
    expect(before).toHaveBeenCalledTimes(1);
  });

  it("does not run a check when none is due", async () => {
    const runtime = build(definition([field("name")]));
    const seen: string[] = [];
    runtime.events().subscribe(FormEventType.VALIDATION_STARTED, () => seen.push("started"));
    await runtime.validatePath("name");
    expect(seen).toEqual([]);
  });
});

describe("validatePath: async stages and stale runs", () => {
  function emailStage(): { stage: ValidationStage; calls: Array<{ context: ValidationContext; answer: ReturnType<typeof deferred<ValidationResult>> }> } {
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
  const taken: ValidationResult = { errors: [{ code: "email.taken", componentId: "email", path: "email", stage: "email-taken", source: "custom" }] };

  it("a newer commit of the path replaces the older check: the older one never writes its errors", async () => {
    const check = emailStage();
    const runtime = build(definition([field("email")]), {}, [check.stage]);
    runtime.setErrors([{ code: "email.shown", componentId: "email", path: "email" }]);
    runtime.setValue("email", "a@x.ca");
    const first = runtime.validatePath("email");
    await flush();
    runtime.setValue("email", "b@x.ca");
    const second = runtime.validatePath("email");
    await flush();
    expect(check.calls).toHaveLength(2);
    expect(check.calls[0]?.context.signal?.aborted).toBe(true);
    expect(runtime.pendingPaths().has("email")).toBe(true);
    // The older answer arrives last, and says "taken": it is dropped.
    check.calls[1]?.answer.resolve({ errors: [] });
    await second;
    check.calls[0]?.answer.resolve(taken);
    await first;
    expect(codes(runtime)).toEqual([]);
    expect(runtime.pendingPaths().size).toBe(0);
  });

  it("the newest check's verdict is written, and submit waits for it", async () => {
    const check = emailStage();
    const runtime = build(definition([field("email", {})]), {}, [check.stage]);
    runtime.setErrors([{ code: "email.shown", componentId: "email", path: "email" }]);
    runtime.setValue("email", "a@x.ca");
    const run = runtime.validatePath("email");
    await flush();
    expect(runtime.pendingPaths().has("email")).toBe(true);
    let submitted = false;
    const submit = runtime.submit("submit", VERSION).then((result) => {
      submitted = true;
      return result;
    });
    await flush();
    expect(submitted).toBe(false);
    check.calls[0]?.answer.resolve(taken);
    await run;
    expect(codes(runtime)).toEqual(["email:email.taken"]);
    // The submission's own whole-form run asks the stage again.
    await flush();
    check.calls[1]?.answer.resolve(taken);
    expect((await submit).accepted).toBe(false);
  });
});
