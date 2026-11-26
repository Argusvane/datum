/**
 * The one shape every runner normalises a result into, so one predicate judges
 * a verdict whether it came from a QuickJS run, an HTTP response or the in-process kernel.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type RefusalKind =
  | "too_large"
  | "too_deep"
  | "budget"
  | "bad_document"
  | "outdated"
  | "unavailable"
  | "rate_limited"
  | "not_found"
  | "method"
  | "definition_too_deep"
  | "server_error"
  | "malformed_response"
  /** A definition save or register refused as a definition (HTTP 422). */
  | "definition_refused"
  /** 401 or 403. */
  | "forbidden"
  /** 415. */
  | "unsupported_media"
  | "other";

export interface ObservedError {
  code: string;
  field?: string | null;
  severity?: string;
}

export interface ObservedLog {
  level: string;
  message: string;
}

export type Observation =
  | {
      kind: "verdict";
      accepted: boolean;
      errors: ObservedError[];
      values?: Json;
      logs?: ObservedLog[];
      digest?: string;
      canonical?: string;
      /** The outcome as the program wrote it (program runner only); the whole-observation text checks read it. */
      raw?: Json;
      /** Length and SHA-256 of the outcome text exactly as the program wrote it (program runner only): byte-level checks read this. */
      outcome?: { length: number; sha256: string };
      /** Facts the runner noticed beside the outcome (program runner only), e.g. `moduleRecycled`. */
      meta?: Record<string, Json>;
    }
  | { kind: "refusal"; refusal: RefusalKind; code?: string; /** Every typed code the body carried (a 422's `kernel[]`), in order. */ codes?: string[]; http?: number; detail: string }
  | { kind: "answer"; json: Json };

/** The text the "marker absent" checks scan: the whole observation as JSON. */
export function observationText(observation: Observation): string {
  return JSON.stringify(observation);
}

/** `code@field` for one error, `code` when it names no field. */
export function errorToken(error: ObservedError): string {
  return error.field !== undefined && error.field !== null && error.field !== "" ? `${error.code}@${error.field}` : error.code;
}

/** A one-line description of an observation for a report cell (truncated by the report, not here). */
export function summarizeObservation(observation: Observation): string {
  switch (observation.kind) {
    case "verdict": {
      const tokens = observation.errors.map(errorToken);
      return `${observation.accepted ? "accepted" : "rejected"} [${tokens.join(", ")}]`;
    }
    case "refusal":
      return `refusal ${observation.refusal}${observation.code !== undefined ? ` (${observation.code})` : ""}: ${observation.detail}`;
    case "answer":
      return `answer ${JSON.stringify(observation.json)}`;
  }
}
