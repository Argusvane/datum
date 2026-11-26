import { describe, expect, it } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { SubmissionVersionContext } from "../form-engine/core/submission/canonical-submission.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";

const VERSION: SubmissionVersionContext = {
  form: { id: "f", version: "1.0.0" },
  client: { runtimeVersion: "test", rendererVersion: "test", schemaVersion: "1.0.0" }
};

function definition(pages: unknown[]): FormDefinition {
  return {
    id: "f",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "city", type: "text", configuration: { label: "City" } }
        ]
      }
    },
    journey: { journeys: [{ id: "main", pages }] }
  } as unknown as FormDefinition;
}

const twoPages = [
  { id: "p1", components: ["name"], validation: { continue: "page", server: true }, routes: [{ to: "p2" }] },
  { id: "p2", components: ["city"], routes: [{ to: "$end" }] }
];
const onePage = [{ id: "p1", components: ["name", "city"], validation: { continue: "page", server: true }, routes: [{ to: "$end" }] }];

function build(pages: unknown[], reply: unknown): FormRuntime {
  const form = definition(pages);
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const runtime = new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
    journeyEngine: EagerJourneyEngine,
    wasmValidationHost: createInProcessWasmValidationHost([]),
    journeyServerValidator: async () => reply,
    journey: "main"
  } as FormRuntimeDependencies);
  runtime.setValue("name", "Ada");
  return runtime;
}

const blockedOn = (componentId: string) => ({ errors: [{ code: "server.blocked", componentId, severity: "error" }] });

describe("a page's server check naming a component the form does not have", () => {
  for (const componentId of ["nonexistent_field", "__proto__", "constructor"]) {
    it(`blocks Continue as the form's own error (${componentId})`, async () => {
      const runtime = build(twoPages, blockedOn(componentId));
      const moved = await runtime.nextPage();
      expect(moved.ok).toBe(false);
      const stored = runtime.errors().filter((error) => error.code === "server.blocked");
      expect(stored).toHaveLength(1);
      expect(stored[0]?.componentId).toBeUndefined();
      expect(stored[0]?.parameters).toEqual({ componentId });
    });
  }

  it("clears with the next clean check rather than blocking the page for good", async () => {
    let reply: unknown = blockedOn("nonexistent_field");
    const form = definition(twoPages);
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(form, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
      journeyEngine: EagerJourneyEngine,
      journeyServerValidator: async () => reply,
      journey: "main"
    } as FormRuntimeDependencies);
    runtime.setValue("name", "Ada");
    expect((await runtime.nextPage()).ok).toBe(false);
    reply = { errors: [] };
    runtime.setValue("name", "Grace");
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "p2" });
    expect(runtime.errors().filter((error) => error.code === "server.blocked")).toEqual([]);
  });

  it("still drops another page's error on Continue", async () => {
    const runtime = build(twoPages, blockedOn("city"));
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "p2" });
  });

  it("refuses the final page's submit", async () => {
    const runtime = build(onePage, blockedOn("nonexistent_field"));
    const result = await runtime.submit("submit", VERSION);
    expect(result.accepted).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(["server.blocked"]);
  });
});
