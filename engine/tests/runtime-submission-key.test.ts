import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { SubmissionVersionContext } from "../form-engine/core/submission/canonical-submission.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { FormRuntime, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { mintSubmissionKey } from "../form-engine/runtime/browser/submission-key.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { SubmissionHandlerRegistry } from "../form-engine/registry/submission/submission-handler-registry.js";

/*
 * The key a receiving service tells one submission from another by: two people who give the
 * same answers are two records, and a delivery retried with the same key is one.
 */

const VERSION: SubmissionVersionContext = {
  form: { id: "f", version: "1.0.0" },
  client: { runtimeVersion: "test", rendererVersion: "test", schemaVersion: "1.0.0" }
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function build(deps: Partial<FormRuntimeDependencies> = {}): FormRuntime {
  const form = {
    id: "f",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "name", type: "text", configuration: { label: "Name", required: true } }] }
    }
  } as unknown as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
    journeyEngine: EagerJourneyEngine,
    ...deps
  } as FormRuntimeDependencies);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the submission key", () => {
  it("is minted once per submit attempt and handed back with the accepted submission", async () => {
    const runtime = build();
    runtime.setValue("name", "Ada");
    const completed: unknown[] = [];
    runtime.events().subscribe(FormEventType.SUBMISSION_COMPLETED, (event) => completed.push(event.data));

    const first = await runtime.submit("submit", VERSION);
    const second = await runtime.submit("submit", VERSION);

    expect(first.accepted).toBe(true);
    expect(first.submissionKey).toMatch(UUID);
    expect(second.submissionKey).toMatch(UUID);
    // The same answers submitted again are another submission.
    expect(second.submissionKey).not.toBe(first.submissionKey);
    expect(completed).toEqual([
      expect.objectContaining({ submissionKey: first.submissionKey }),
      expect.objectContaining({ submissionKey: second.submissionKey })
    ]);
  });

  it("is handed to every submission handler, so a delivery sends the attempt's key", async () => {
    const seen: Array<{ handler: string; key: string; modeId: string; formId: string }> = [];
    const handlers = new SubmissionHandlerRegistry();
    handlers.register({ id: "post", version: "1.0.0", handle: (_submission, context) => void seen.push({ handler: "post", key: context.submissionKey, modeId: context.modeId, formId: context.formId }) });
    handlers.register({ id: "store", version: "1.0.0", handle: (_submission, context) => void seen.push({ handler: "store", key: context.submissionKey, modeId: context.modeId, formId: context.formId }) });
    const runtime = build({ submissionHandlerRegistry: handlers });
    runtime.setValue("name", "Ada");

    const result = await runtime.submit("submit", VERSION);

    expect(result.submissionKey).toMatch(UUID);
    expect(seen).toEqual([
      { handler: "post", key: result.submissionKey, modeId: "submit", formId: "f" },
      { handler: "store", key: result.submissionKey, modeId: "submit", formId: "f" }
    ]);
  });

  it("is the same for a second call that joins the attempt in flight (a double click)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handlers = new SubmissionHandlerRegistry();
    handlers.register({ id: "post", version: "1.0.0", handle: () => gate });
    const runtime = build({ submissionHandlerRegistry: handlers });
    runtime.setValue("name", "Ada");

    const first = runtime.submit("submit", VERSION);
    const joined = runtime.submit("submit", VERSION);
    release();
    const [a, b] = await Promise.all([first, joined]);

    expect(a.submissionKey).toMatch(UUID);
    expect(b.submissionKey).toBe(a.submissionKey);
  });

  it("is not handed back with a refused attempt, and the next attempt has its own", async () => {
    const runtime = build();
    const refused = await runtime.submit("submit", VERSION);
    expect(refused.accepted).toBe(false);
    expect(refused).not.toHaveProperty("submissionKey");

    runtime.setValue("name", "Ada");
    const accepted = await runtime.submit("submit", VERSION);
    expect(accepted.submissionKey).toMatch(UUID);
  });

  it("is a version 4 UUID with or without crypto.randomUUID (an insecure context has only getRandomValues)", () => {
    expect(mintSubmissionKey()).toMatch(UUID);
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    const keys = new Set([mintSubmissionKey(), mintSubmissionKey(), mintSubmissionKey()]);
    expect(keys.size).toBe(3);
    for (const key of keys) {
      expect(key).toMatch(UUID);
    }
    vi.stubGlobal("crypto", undefined);
    expect(() => mintSubmissionKey()).toThrow(/random/);
  });
});
