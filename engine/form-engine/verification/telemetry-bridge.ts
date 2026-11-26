import type { EventBus } from "../core/events/event-bus.js";
import { FormEventType } from "../core/events/event-types.js";
import { TelemetryEmitter, type TelemetryDimensions, type TelemetrySink } from "./telemetry.js";

export interface AttachTelemetryOptions {
  /** Base dimensions; missing required fields are filled with "-" so emits never throw. */
  dimensions: Partial<TelemetryDimensions>;
}

export interface TelemetryBridge {
  detach(): void;
}

const PLACEHOLDER = "-";

function fillDimensions(base: Partial<TelemetryDimensions>): TelemetryDimensions {
  return {
    form_id: base.form_id ?? PLACEHOLDER,
    form_version: base.form_version ?? PLACEHOLDER,
    schema_version: base.schema_version ?? PLACEHOLDER,
    client_runtime_version: base.client_runtime_version ?? PLACEHOLDER,
    server_runtime_version: base.server_runtime_version ?? PLACEHOLDER,
    locale: base.locale ?? PLACEHOLDER,
    plugin_id: base.plugin_id ?? PLACEHOLDER,
    component_type: base.component_type ?? PLACEHOLDER
  };
}

/** Whether a validation event's data names value paths: a check of single paths, not a form-wide run. */
function isPathScoped(data: unknown): boolean {
  return typeof data === "object" && data !== null && Array.isArray((data as { paths?: unknown }).paths);
}

function successRate(succeeded: number, total: number): number {
  return total === 0 ? 1 : succeeded / total;
}

/**
 * Subscribes a {@link TelemetryEmitter} to a runtime event bus and maps domain events to
 * standardized metrics (the names in `TELEMETRY_METRIC_NAMES`). Returns a handle to
 * detach all subscriptions.
 */
export function attachTelemetry(
  events: EventBus,
  sink: TelemetrySink,
  options: AttachTelemetryOptions
): TelemetryBridge {
  const emitter = new TelemetryEmitter(sink);
  const base = fillDimensions(options.dimensions);
  const emit = (metric: Parameters<TelemetryEmitter["emit"]>[0], value: number, overrides: Partial<TelemetryDimensions> = {}) =>
    emitter.emit(metric, value, { ...base, ...overrides });

  let submissionStartedAt: number | undefined;
  let validationStartedAt: number | undefined;

  const unsubscribers = [
    events.subscribe(FormEventType.SUBMISSION_STARTED, () => {
      submissionStartedAt = Date.now();
    }),

    events.subscribe(FormEventType.SUBMISSION_COMPLETED, () => {
      emit("submission.accepted.rate", 1);
      if (submissionStartedAt !== undefined) {
        const latency = Date.now() - submissionStartedAt;
        emit("submission.latency.p50", latency);
        emit("submission.latency.p95", latency);
      }
    }),

    events.subscribe(FormEventType.SUBMISSION_FAILED, () => {
      emit("submission.accepted.rate", 0);
      emit("submission.blocked.validation.rate", 1);
    }),

    // A check of single value paths (`validatePath`, its events carry `paths`) is no form-wide
    // run: it neither restarts the timer of one in flight nor counts in its metrics.
    events.subscribe(FormEventType.VALIDATION_STARTED, (event) => {
      if (isPathScoped(event.data)) {
        return;
      }
      validationStartedAt = Date.now();
    }),

    events.subscribe(FormEventType.PDF_SIGNED, () => {
      emit("pdf.signed.count", 1);
    }),

    events.subscribe(FormEventType.VALIDATION_COMPLETED, (event) => {
      if (isPathScoped(event.data)) {
        return;
      }
      const data = event.data as { errorCount?: number } | undefined;
      emit("validation.error.count.by_stage", data?.errorCount ?? 0);
      if (validationStartedAt !== undefined) {
        const latency = Date.now() - validationStartedAt;
        emit("validation.latency.p50", latency);
        emit("validation.latency.p95", latency);
      }
    }),

    events.subscribe(FormEventType.RECOMPUTE_COMPLETED, (event) => {
      const data = event.data as { latencyMs?: number } | undefined;
      if (typeof data?.latencyMs === "number") {
        emit("renderer.model.build.latency.p95", data.latencyMs);
      }
    }),

    events.subscribe(FormEventType.DRAFT_SAVED, (event) => {
      const data = event.data as { latencyMs?: number } | undefined;
      if (typeof data?.latencyMs === "number") {
        emit("draft.save.latency.p95", data.latencyMs);
      }
    }),

    events.subscribe(FormEventType.DATA_SOURCE_RESOLVE_FAILED, (event) => {
      const data = event.data as { component_type?: string } | undefined;
      emit("runtime.data_source.resolve.error.rate", 1, {
        component_type: data?.component_type ?? PLACEHOLDER
      });
    }),

    events.subscribe(FormEventType.PLUGINS_INITIALIZED, (event) => {
      const data = event.data as {
        installedPluginIds?: string[];
        initializedPluginIds?: string[];
        failedPluginIds?: string[];
        incompatiblePluginIds?: string[];
      } | undefined;
      const installed = data?.installedPluginIds?.length ?? 0;
      const initialized = data?.initializedPluginIds?.length ?? 0;
      const failed = data?.failedPluginIds?.length ?? 0;
      const incompatible = data?.incompatiblePluginIds?.length ?? 0;

      emit("plugin.install.success.rate", successRate(installed, installed + incompatible));
      emit("plugin.initialize.success.rate", successRate(initialized, initialized + failed));
      emit("plugin.failure.isolated.count", failed + incompatible);
      emit("plugin.failure.blocking.count", 0);
    }),

    events.subscribe(FormEventType.PLUGIN_INCOMPATIBLE, (event) => {
      const data = event.data as { pluginId?: string } | undefined;
      emit("plugin.failure.isolated.count", 1, { plugin_id: data?.pluginId ?? PLACEHOLDER });
    })
  ];

  return {
    detach() {
      for (const off of unsubscribers) {
        off();
      }
    }
  };
}
