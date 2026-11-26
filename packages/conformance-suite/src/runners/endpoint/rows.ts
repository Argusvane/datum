import type { Expectation } from "../../predicates.js";
import type { Gate } from "../../vectors/schema.js";
import type { ProfileName } from "./http.js";
import type { CheckParts } from "./profiles/types.js";

/** What a body builder may need to know about the run. */
export interface RowContext {
  bodyLimit: number;
  profile: ProfileName;
  /** The profile's check body for these parts (valid fixture answers where a part is left out). */
  checkBody(parts?: CheckParts): string;
  /** The profile's submission body; `deliver` turns the envelope into the delivered document (a signed wrapper). */
  submitBody(parts?: CheckParts, deliver?: (envelope: Record<string, unknown>) => unknown): string;
}

/** One HTTP request a row sends. */
export type RequestSpec =
  /** A check on the validate route, shaped by the profile. */
  | ({ kind: "check" } & CheckParts)
  /** A submission on the receive route (needs `--allow-writes`, even when the server is expected to refuse it). */
  | ({ kind: "submit" } & CheckParts)
  /** Bytes as given. `method: "GET"` is the probe REC-10 needs; it is on the allowlist. */
  | {
      kind: "raw";
      route: "validate" | "submit";
      method?: "POST" | "GET";
      body?: string | Uint8Array | ((context: RowContext) => string | Uint8Array);
      /** `null`: send no content-type header. */
      contentType?: string | null;
    }
  /** A GET of a read-only document: the form's public definition (`definition`). Observed as an `answer` {status, body}. */
  | { kind: "get"; what: "definition" };

/** A row: one expectation over the last request of `requests`. A series sends them in order on one run. */
export interface EndpointRow {
  id: string;
  requests: RequestSpec[];
  expect: Expectation;
  /** A different expectation for one profile (the wire differs between hosts). */
  profileExpect?: Partial<Record<ProfileName, Expectation>>;
  /** Run for these profiles only; other profiles skip the row with `skipNote`. */
  profiles?: ProfileName[];
  skipNote?: string;
  /** The row's digest check: the golden document "sent" is the delivered document, serialized by the independent reference. */
  digestOfSent?: boolean;
  /** A wall-clock bound for the row (a hang is a FAIL); defaults to the vector's `limits.endpointMs`, else the request timeout. */
  limitMs?: number;
  /** A row no run can send (it needs a session or a load the suite will not create): always skipped, with this reason. It documents the check. */
  manual?: string;
  /** A run of requests that is not plain send-and-observe (REC-13 counts records around a check). */
  procedure?: "validate-stores-nothing" | "replay-same-record";
}

export interface EndpointSpec {
  rows: EndpointRow[];
  /** Needs a request the default (read-only) mode must not send, beyond what the rows' kinds say. */
  heavy?: boolean;
  note?: string;
}

/** Whether any request of a row writes (it uses the receive route). */
export function rowNeedsWrites(row: EndpointRow): boolean {
  if (row.manual !== undefined) {
    return false;
  }
  return row.requests.some((request) => request.kind === "submit" || (request.kind === "raw" && request.route === "submit"));
}
