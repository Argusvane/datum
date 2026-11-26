import type { TelemetryEvent, TelemetrySink } from "./telemetry.js";

/** Writes each telemetry event to the console. */
export class ConsoleTelemetrySink implements TelemetrySink {
  constructor(private readonly log: (message: string) => void = console.log) {}

  public record(event: TelemetryEvent): void {
    this.log(
      `[telemetry] ${event.metric}=${event.value} ${JSON.stringify(event.dimensions)}`
    );
  }
}

/** Collects events in memory; useful for tests and local inspection. */
export class InMemoryTelemetrySink implements TelemetrySink {
  public readonly events: TelemetryEvent[] = [];

  public record(event: TelemetryEvent): void {
    this.events.push(event);
  }

  public metricValues(metric: string): number[] {
    return this.events.filter((event) => event.metric === metric).map((event) => event.value);
  }
}
