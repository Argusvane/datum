import { describe, expect, it } from "vitest";

import { EventBus } from "../form-engine/core/events/event-bus.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { attachTelemetry } from "../form-engine/verification/telemetry-bridge.js";
import { InMemoryTelemetrySink } from "../form-engine/verification/telemetry-sinks.js";

const dimensions = {
  form_id: "f1",
  form_version: "1",
  schema_version: "1",
  client_runtime_version: "1.0.0",
  locale: "en"
};

function setup() {
  const bus = new EventBus();
  const sink = new InMemoryTelemetrySink();
  const bridge = attachTelemetry(bus, sink, { dimensions });
  return { bus, sink, bridge };
}

const evt = (type: string, data?: unknown) => ({
  id: type,
  type,
  timestamp: Date.now(),
  source: "runtime" as const,
  formId: "f1",
  data
});

describe("attachTelemetry", () => {
  it("emits accepted-rate and latency on a completed submission", () => {
    const { bus, sink } = setup();
    bus.publish(evt(FormEventType.SUBMISSION_STARTED));
    bus.publish(evt(FormEventType.SUBMISSION_COMPLETED));

    expect(sink.metricValues("submission.accepted.rate")).toEqual([1]);
    expect(sink.metricValues("submission.latency.p95")).toHaveLength(1);
    // Placeholder-filled required dimensions never throw.
    expect(sink.events[0]?.dimensions.plugin_id).toBe("-");
    expect(sink.events[0]?.dimensions.form_id).toBe("f1");
  });

  it("maps a blocked submission to the right rate metrics", () => {
    const { bus, sink } = setup();
    bus.publish(evt(FormEventType.SUBMISSION_FAILED));

    expect(sink.metricValues("submission.blocked.validation.rate")).toEqual([1]);
    expect(sink.metricValues("submission.accepted.rate")).toEqual([0]);
  });

  it("emits validation error count from VALIDATION_COMPLETED", () => {
    const { bus, sink } = setup();
    bus.publish(evt(FormEventType.VALIDATION_STARTED));
    bus.publish(evt(FormEventType.VALIDATION_COMPLETED, { errorCount: 3 }));
    expect(sink.metricValues("validation.error.count.by_stage")).toEqual([3]);
  });

  it("derives plugin install / initialize success rates and isolated failure counts", () => {
    const { bus, sink } = setup();
    bus.publish(
      evt(FormEventType.PLUGINS_INITIALIZED, {
        installedPluginIds: ["a", "b"],
        initializedPluginIds: ["a"],
        failedPluginIds: ["b"],
        incompatiblePluginIds: ["c"]
      })
    );
    expect(sink.metricValues("plugin.install.success.rate")[0]).toBeCloseTo(2 / 3);
    expect(sink.metricValues("plugin.initialize.success.rate")[0]).toBeCloseTo(1 / 2);
    expect(sink.metricValues("plugin.failure.isolated.count")).toEqual([2]);
    expect(sink.metricValues("plugin.failure.blocking.count")).toEqual([0]);
  });

  it("tags a PLUGIN_INCOMPATIBLE event with its plugin id", () => {
    const { bus, sink } = setup();
    bus.publish(evt(FormEventType.PLUGIN_INCOMPATIBLE, { pluginId: "legacy" }));
    const event = sink.events.find((e) => e.metric === "plugin.failure.isolated.count");
    expect(event?.dimensions.plugin_id).toBe("legacy");
  });

  it("emits draft save latency from DRAFT_SAVED", () => {
    const { bus, sink } = setup();
    bus.publish(evt(FormEventType.DRAFT_SAVED, { draftId: "d1", latencyMs: 12 }));
    expect(sink.metricValues("draft.save.latency.p95")).toEqual([12]);
  });

  it("emits a data-source resolve error rate from DATA_SOURCE_RESOLVE_FAILED", () => {
    const { bus, sink } = setup();
    bus.publish(
      evt(FormEventType.DATA_SOURCE_RESOLVE_FAILED, {
        componentId: "country",
        sourceId: "geo",
        error: "network down"
      })
    );
    expect(sink.metricValues("runtime.data_source.resolve.error.rate")).toEqual([1]);
  });

  it("emits renderer model build latency from RECOMPUTE_COMPLETED", () => {
    const { bus, sink } = setup();
    bus.publish(evt(FormEventType.RECOMPUTE_COMPLETED, { nodeCount: 5, latencyMs: 3 }));
    expect(sink.metricValues("renderer.model.build.latency.p95")).toEqual([3]);
  });

  it("stops emitting after detach", () => {
    const { bus, sink, bridge } = setup();
    bridge.detach();
    bus.publish(evt(FormEventType.SUBMISSION_COMPLETED));
    expect(sink.events).toEqual([]);
  });
});
