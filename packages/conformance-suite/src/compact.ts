import type { Json, Observation } from "./observation.js";

const MAX_ERRORS = 40;
const MAX_LOGS = 40;
const MAX_TEXT = 2000;
const MAX_JSON = 8192;

const sizeOf = (value: unknown): number => JSON.stringify(value ?? null)?.length ?? 0;

/**
 * An observation as the report keeps it. A vector may legitimately provoke a 70,000-entry error
 * list or a 16 MiB outcome; the judgement ran on the whole observation, but the report holds a
 * bounded view of it (counts replace what was cut). Small observations pass through untouched.
 */
export function compactObservation(observation: Observation | null): Observation | null {
  if (observation === null || observation.kind !== "verdict") {
    return observation;
  }
  const cut: Record<string, Json> = {};
  const errors = observation.errors.length > MAX_ERRORS ? observation.errors.slice(0, MAX_ERRORS) : observation.errors;
  if (errors !== observation.errors) {
    cut["errorCount"] = observation.errors.length;
  }
  const logs = observation.logs !== undefined && observation.logs.length > MAX_LOGS ? observation.logs.slice(0, MAX_LOGS) : observation.logs;
  if (logs !== observation.logs && observation.logs !== undefined) {
    cut["logCount"] = observation.logs.length;
  }
  const trimmedLogs = logs?.map((entry) => (entry.message.length > MAX_TEXT ? { ...entry, message: `${entry.message.slice(0, MAX_TEXT)}... [report cut ${entry.message.length - MAX_TEXT} characters]` } : entry));
  const values = observation.values !== undefined && sizeOf(observation.values) > MAX_JSON ? ({ "(report)": `values cut, ${sizeOf(observation.values)} characters` } as Json) : observation.values;
  const raw = observation.raw !== undefined && sizeOf(observation.raw) > MAX_JSON ? ({ "(report)": `outcome cut, ${sizeOf(observation.raw)} characters` } as Json) : observation.raw;
  if (values !== observation.values) {
    cut["valuesCut"] = true;
  }
  if (raw !== observation.raw) {
    cut["outcomeCut"] = true;
  }
  const canonical = observation.canonical !== undefined && observation.canonical.length > MAX_TEXT ? `${observation.canonical.slice(0, MAX_TEXT)}... [report cut ${observation.canonical.length - MAX_TEXT} characters]` : observation.canonical;
  if (Object.keys(cut).length === 0 && trimmedLogs === observation.logs && canonical === observation.canonical) {
    return observation;
  }
  const { values: _values, raw: _raw, logs: _logs, canonical: _canonical, meta, ...rest } = observation;
  return {
    ...rest,
    errors,
    ...(values !== undefined ? { values } : {}),
    ...(trimmedLogs !== undefined ? { logs: trimmedLogs } : {}),
    ...(canonical !== undefined ? { canonical } : {}),
    ...(raw !== undefined ? { raw } : {}),
    meta: { ...(meta ?? {}), ...cut }
  };
}
