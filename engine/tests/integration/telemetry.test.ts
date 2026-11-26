import { describe, expect, it } from "vitest";

import type { FormDefinition, ComponentNode } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { attachTelemetry } from "../../form-engine/verification/telemetry-bridge.js";
import { InMemoryTelemetrySink } from "../../form-engine/verification/telemetry-sinks.js";
import { InMemoryDraftStore } from "../../form-engine/persistence/local-storage/in-memory-draft-store.js";

function form(): FormDefinition {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: { content: [{ id: "name", type: "text", configuration: { required: true } }] }
  };
  return { id: "f1", version: "2", schemaVersion: "1", root, localization: { defaultLocale: "en-CA" } };
}

describe("telemetry integration", () => {
  it("emits standardized metrics with all required dimensions across a real submit", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        {
          id: "required",
          version: "1.0.0",
          validate: (ctx) =>
            ctx.values.name
              ? { errors: [] }
              : { errors: [{ code: "required", componentId: "name", path: "name", stage: "required", source: "client" }] }
        }
      ])
    });

    const sink = new InMemoryTelemetrySink();
    attachTelemetry(runtime.events(), sink, {
      dimensions: {
        form_id: "f1",
        form_version: "2",
        schema_version: "1",
        client_runtime_version: "1.0.0",
        server_runtime_version: "1.0.0",
        locale: "en-CA",
        plugin_id: "-",
        component_type: "-"
      }
    });

    // Blocked submit (empty required field).
    const blocked = await runtime.submit("m", {
      form: { id: "f1", version: "2" },
      client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" }
    });
    expect(blocked.accepted).toBe(false);

    // Accepted submit.
    runtime.setValue("name", "Ada");
    const accepted = await runtime.submit("m", {
      form: { id: "f1", version: "2" },
      client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" }
    });
    expect(accepted.accepted).toBe(true);

    expect(sink.metricValues("submission.blocked.validation.rate")).toEqual([1]);
    expect(sink.metricValues("submission.accepted.rate")).toEqual([0, 1]);
    expect(sink.metricValues("validation.error.count.by_stage")).toContain(1);
    expect(sink.metricValues("submission.latency.p95").length).toBeGreaterThanOrEqual(1);

    for (const event of sink.events) {
      expect(Object.values(event.dimensions).every((v) => typeof v === "string" && v.length > 0)).toBe(true);
    }
  });

  it("emits draft-save and renderer-model-build latency from real runtime activity", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: false, sign: false, serverValidation: false });
    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([]),
      draftStore: new InMemoryDraftStore(),
      versionContext: { formVersion: "2", schemaVersion: "1", rendererVersion: "1.0.0" }
    });

    const sink = new InMemoryTelemetrySink();
    attachTelemetry(runtime.events(), sink, {
      dimensions: { form_id: "f1", form_version: "2", schema_version: "1" }
    });

    runtime.setValue("name", "Ada"); // triggers a recompute
    await runtime.saveDraft("d1");

    expect(sink.metricValues("renderer.model.build.latency.p95").length).toBeGreaterThanOrEqual(1);
    expect(sink.metricValues("draft.save.latency.p95")).toHaveLength(1);
    for (const value of sink.metricValues("draft.save.latency.p95")) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
