import type { ReleaseGateReport } from "./release-gates.js";

export const TELEMETRY_METRIC_NAMES = [
  "submission.accepted.rate",
  "submission.blocked.validation.rate",
  "validation.error.count.by_stage",
  "runtime.data_source.resolve.error.rate",
  "plugin.install.success.rate",
  "plugin.initialize.success.rate",
  "plugin.failure.isolated.count",
  "plugin.failure.blocking.count",
  "submission.latency.p50",
  "submission.latency.p95",
  "submission.latency.p99",
  "validation.latency.p50",
  "validation.latency.p95",
  "renderer.model.build.latency.p95",
  "draft.save.latency.p95",
  "pdf.signed.count"
] as const;

export type TelemetryMetricName = (typeof TELEMETRY_METRIC_NAMES)[number];

export interface TelemetryDimensions {
  form_id: string;
  form_version: string;
  schema_version: string;
  client_runtime_version: string;
  server_runtime_version: string;
  locale: string;
  plugin_id: string;
  component_type: string;
}

export interface TelemetryEvent {
  metric: TelemetryMetricName;
  value: number;
  timestamp: number;
  dimensions: TelemetryDimensions;
}

export interface TelemetrySink {
  record(event: TelemetryEvent): void;
}

export function hasRequiredDimensions(
  dimensions: Partial<TelemetryDimensions>
): dimensions is TelemetryDimensions {
  return Boolean(
    dimensions.form_id &&
      dimensions.form_version &&
      dimensions.schema_version &&
      dimensions.client_runtime_version &&
      dimensions.server_runtime_version &&
      dimensions.locale &&
      dimensions.plugin_id &&
      dimensions.component_type
  );
}

export class TelemetryEmitter {
  constructor(private readonly sink: TelemetrySink) {}

  public emit(
    metric: TelemetryMetricName,
    value: number,
    dimensions: Partial<TelemetryDimensions>
  ): void {
    if (!hasRequiredDimensions(dimensions)) {
      throw new Error("Telemetry event missing required dimensions");
    }

    this.sink.record({
      metric,
      value,
      timestamp: Date.now(),
      dimensions
    });
  }

  public emitReleaseGateReport(
    report: ReleaseGateReport,
    dimensions: Partial<TelemetryDimensions>
  ): void {
    this.emit("submission.accepted.rate", report.passed ? 1 : 0, dimensions);
  }
}
