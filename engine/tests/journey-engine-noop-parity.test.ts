import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { InMemoryDraftStore } from "../form-engine/persistence/local-storage/in-memory-draft-store.js";
import { FormRuntime, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { defaultJourneyEngine } from "../form-engine/runtime/browser/journey-engine.js";

/*
 * A plain form on the Noop journey engine, taken from the default slot with NOTHING registered.
 * The setup file registers the eager engine for the whole suite, which hid a
 * Noop-only throw (setErrors reached the engine's stableJson). This file clears the slot, so
 * every runtime here is the Noop one a single-page host gets; the expectations are the
 * plain-form answers themselves.
 */

const SLOT = Symbol.for("datum.journeyEngine.default");

const root: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "name", type: "text", configuration: { required: true } },
      { id: "age", type: "text", configuration: {} }
    ]
  }
};
const plain: FormDefinition = { id: "plain", version: "1", schemaVersion: "1", root };

function build(deps: Partial<FormRuntimeDependencies> = {}): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(plain, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(plain.root)]),
    ...deps
  });
}

const envelope = {
  form: { id: "plain", version: "1" },
  client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" }
};

describe("a plain form on the default (Noop) journey engine", () => {
  let saved: unknown;
  beforeAll(() => {
    const holder = globalThis as unknown as Record<symbol, unknown>;
    saved = holder[SLOT];
    delete holder[SLOT];
    return () => {
      holder[SLOT] = saved;
    };
  });

  it("really runs on the Noop engine", () => {
    expect(defaultJourneyEngine().kind).toBe("none");
  });

  it("stores and replaces host-supplied errors without touching the engine", async () => {
    const runtime = build();
    runtime.setErrors([{ code: "x", componentId: "age" }]);
    expect(runtime.errors().map((error) => [error.code, error.componentId])).toEqual([["x", "age"]]);
    // The same errors again (the held-vs-next compare) and a different set.
    runtime.setErrors([{ code: "x", componentId: "age" }]);
    runtime.setErrors([{ code: "y", componentId: "name" }]);
    expect(runtime.errors().map((error) => error.code)).toEqual(["y"]);
    const invalid = await runtime.validate();
    expect(invalid.map((error) => error.componentId)).toContain("name");
    expect(runtime.errors().map((error) => error.code)).not.toContain("y");
  });

  it("validates, submits and drafts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new InMemoryDraftStore();
    const versionContext = { formVersion: "1.0.0", schemaVersion: "1.0.0", rendererVersion: "1" };
    const runtime = build({ draftStore: store, versionContext });
    runtime.setValue("age", "7");
    expect((await runtime.validate()).map((error) => error.componentId)).toContain("name");
    runtime.setErrors([{ code: "server", componentId: "name" }]);
    runtime.setValue("name", "Ada");
    const result = await runtime.submit("submit", envelope);
    expect(result.accepted).toBe(true);
    expect(runtime.formValues()).toEqual({ name: "Ada", age: "7" });
    await runtime.saveDraft("d");
    const draft = await store.load("d");
    const again = build({ draftStore: store, versionContext });
    await again.hydrateFromDraft(draft);
    expect(again.formValues()).toEqual({ name: "Ada", age: "7" });
    expect(again.journeyView()).toBeUndefined();
  });
});
