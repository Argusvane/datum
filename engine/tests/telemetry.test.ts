import { describe, expect, it } from "vitest";

import { TelemetryEmitter, hasRequiredDimensions } from "../form-engine/verification/telemetry.js";

describe("telemetry emitter", () => {
  function dimensions() {
    return {
      form_id: "f1",
      form_version: "1",
      schema_version: "1",
      client_runtime_version: "1.0.0",
      server_runtime_version: "2.0.0",
      locale: "en-CA",
      plugin_id: "base-plugin",
      component_type: "text"
    };
  }

  it("validates required dimensions", () => {
    expect(hasRequiredDimensions(dimensions())).toBe(true);
    expect(
      hasRequiredDimensions({
        form_id: "f1"
      })
    ).toBe(false);
  });

  it("emits typed telemetry events", () => {
    const events: Array<{ metric: string; value: number }> = [];
    const emitter = new TelemetryEmitter({
      record: (event) => {
        events.push({ metric: event.metric, value: event.value });
      }
    });

    emitter.emit("submission.accepted.rate", 1, dimensions());
    expect(events).toEqual([{ metric: "submission.accepted.rate", value: 1 }]);
  });

  it("throws when required dimensions are missing", () => {
    const emitter = new TelemetryEmitter({
      record: () => undefined
    });

    expect(() => emitter.emit("submission.accepted.rate", 1, { form_id: "f1" })).toThrow(
      /missing required dimensions/
    );
  });

  it("maps a release-gate report to telemetry", () => {
    const events: string[] = [];
    const emitter = new TelemetryEmitter({
      record: (event) => {
        events.push(event.metric);
      }
    });

    emitter.emitReleaseGateReport(
      {
        passed: false,
        checks: [{ name: "deterministic-vector-parity", passed: false }]
      },
      dimensions()
    );

    expect(events).toEqual(["submission.accepted.rate"]);
  });
});
