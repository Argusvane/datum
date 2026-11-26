import type { Json, Observation, ObservedError } from "../../observation.js";
import type { Exchange, HttpResponse } from "./http.js";

/**
 * Normalises an HTTP answer into the one Observation shape every vector is judged on.
 * The rule underneath: only a 5xx or an answer that is not what the contract says
 * (not JSON where JSON is promised, a body of an unknown shape) is `server_error` or
 * `malformed_response`, and those two are failures whatever the vector expected (the never-500 rule).
 */
export function observe(response: Pick<HttpResponse, "status" | "text" | "json" | "jsonOk">): Observation {
  const { status } = response;
  const detailOf = (): string => `HTTP ${status}${response.text.length > 0 ? `: ${clip(response.text, 160)}` : ""}`;
  const errors = errorsOf(response);
  const firstCode = errors !== undefined ? errors[0]?.code : undefined;

  if (status === 429) {
    return refusal("rate_limited", status, firstCode, detailOf());
  }
  if (status === 503) {
    // A run the sandbox could not finish gave no verdict, so the host answers it 503 with the run's own
    // code: a 422 would read as a judgement of the answers. These are typed apart from "the service is
    // down or busy" (`unavailable`), which a retry may cure; a run that failed will fail again.
    if (firstCode !== undefined && RUN_FAILED_CODES.has(firstCode)) {
      return refusal("other", status, firstCode, detailOf());
    }
    // The registered form itself is nested too deep: the same refusal the 422 path types, now a 503
    // because the form is the host's, not the sender's.
    if (firstCode === "definition.tooDeep") {
      return refusal("definition_too_deep", status, firstCode, detailOf());
    }
    return refusal("unavailable", status, firstCode, detailOf());
  }
  if (status >= 500) {
    return refusal("server_error", status, firstCode, detailOf());
  }
  if (status >= 300 && status < 400) {
    return refusal("other", status, "redirect", `HTTP ${status}: the suite never follows a redirect`);
  }
  if (status === 413) {
    return refusal("too_large", status, firstCode ?? "bad_document", detailOf());
  }
  if (status === 404) {
    return refusal("not_found", status, firstCode, detailOf());
  }
  if (status === 405) {
    return refusal("method", status, firstCode, detailOf());
  }
  if (!response.jsonOk) {
    if (status === 415) {
      // A framework's HTML 415: typed apart from a JSON refusal.
      return refusal("other", status, "unsupported_media_type.html", detailOf());
    }
    return refusal("malformed_response", status, undefined, `HTTP ${status} with a body that is not JSON: ${clip(response.text, 160)}`);
  }
  const body = response.json;
  if (status === 200 || status === 201) {
    if (isRecord(body) && typeof body["accepted"] === "boolean" && Array.isArray(body["errors"])) {
      if (errors === undefined) {
        return refusal("malformed_response", status, undefined, "a verdict whose errors are not {field, code} entries");
      }
      // Still no verdict, but no longer a thing a healthy host does: it answers 503 for a failed run, so
      // wireProblems (SEC-05) names this answer as a defect of the host.
      const execution = errors.length > 0 && errors.every((error) => error.code === "wasm.execution_error");
      if (execution) {
        return refusal("other", status, "wasm.execution_error", "the server could not run the sandbox");
      }
      return { kind: "verdict", accepted: body["accepted"], errors };
    }
    if (isRecord(body) && typeof body["status"] === "string" && (typeof body["id"] === "string" || typeof body["id"] === "number" || typeof body["digest"] === "string")) {
      const warnings = Array.isArray(body["warnings"]) ? (errorsFrom(body["warnings"]) ?? []) : [];
      return {
        kind: "verdict",
        accepted: body["status"] === "accepted",
        errors: warnings,
        ...(typeof body["digest"] === "string" ? { digest: body["digest"] } : {})
      };
    }
    return refusal("malformed_response", status, undefined, `HTTP ${status} with a body that is neither a verdict nor a receipt: ${clip(response.text, 160)}`);
  }
  if (errors === undefined) {
    return refusal("malformed_response", status, undefined, `HTTP ${status} with a body that holds no {errors: [{field, code}]}: ${clip(response.text, 160)}`);
  }
  if (status === 422) {
    if (firstCode === "definition.tooDeep") {
      return refusal("definition_too_deep", status, firstCode, detailOf());
    }
    return { kind: "verdict", accepted: false, errors };
  }
  if (status === 400) {
    return refusal(firstCode === "bad_document" ? "bad_document" : "other", status, firstCode, detailOf());
  }
  if (status === 409) {
    return refusal("outdated", status, firstCode, detailOf());
  }
  return refusal("other", status, firstCode, detailOf());
}

function refusal(kind: Extract<Observation, { kind: "refusal" }>["refusal"], http: number, code: string | undefined, detail: string): Observation {
  return { kind: "refusal", refusal: kind, http, ...(code !== undefined ? { code } : {}), detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function errorsOf(response: Pick<HttpResponse, "json" | "jsonOk">): ObservedError[] | undefined {
  if (!response.jsonOk || !isRecord(response.json) || !Array.isArray(response.json["errors"])) {
    return undefined;
  }
  return errorsFrom(response.json["errors"]);
}

function errorsFrom(list: unknown[]): ObservedError[] | undefined {
  const out: ObservedError[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry["code"] !== "string") {
      return undefined;
    }
    const field = entry["field"];
    out.push({
      code: entry["code"],
      ...(typeof field === "string" ? { field } : field === null ? { field: null } : {}),
      ...(typeof entry["severity"] === "string" ? { severity: entry["severity"] } : {})
    });
  }
  return out;
}

/** The codes of a run that gave no verdict: always a 503 (never a 422, a 200 or a 500), with no `Retry-After`. */
const RUN_FAILED_CODES: ReadonlySet<string> = new Set(["wasm.execution_error", "outcome_too_large"]);

/** The two refusals that mean "the server broke", whatever a vector expected. */
export function violatesNever500(observation: Observation): boolean {
  return observation.kind === "refusal" && (observation.refusal === "server_error" || observation.refusal === "malformed_response");
}

/** Whether an observation says the fixture form or the account is not set up as the suite needs. */
export function isFixtureProblem(observation: Observation): string | undefined {
  if (observation.kind !== "refusal" || observation.refusal !== "other") {
    return undefined;
  }
  const code = observation.code ?? "";
  if (observation.http === 401 || observation.http === 403) {
    if (code === "form.closed" || code === "form.limit_reached" || code.startsWith("form.")) {
      return `the fixture form refuses submissions (${code}): open it and lift its limits`;
    }
    return `the server refused the suite's credentials (HTTP ${observation.http}${code !== "" ? ` ${code}` : ""}): pass --auth-header, --cookie or DATUM_SC_AUTH for an account that may submit to the fixture form`;
  }
  if (code.startsWith("spam.")) {
    return `the form's anti-spam check fired (${code}): switch it off on the fixture form`;
  }
  return undefined;
}

/** A leak the wire must never show (SEC-05): stack traces, host paths, framework names, PHP and Node noise. */
export const LEAK_MARKERS = ["Stack trace", "Exception", "/var/www", "vendor/", "Warning:", "<br />", "Fatal error", "Traceback", "node_modules", "ZZSECRETZZ"] as const;

/** The allowed answers of a healthy server that are not JSON: routing and proxy answers. */
const NON_JSON_OK = new Set([404, 405, 413]);
/**
 * The codes a typed 503 may carry: the service is down or busy, a data source is unreachable, or a run gave no
 * verdict (`wasm.execution_error`, `outcome_too_large`, and `definition.tooDeep` of the registered form).
 */
const SERVICE_UNAVAILABLE_CODES = new Set(["server.unavailable", "validator_unavailable", "server.busy", "data_source.unavailable", "wasm.execution_error", "outcome_too_large", "definition.tooDeep"]);
const ERROR_ENTRY_KEYS = new Set(["field", "code", "severity", "message"]);
/** `notes` is the verdict's non-blocking findings (warnings and info), left out when there are none. */
const VERDICT_KEYS = new Set(["accepted", "errors", "notes", "journey"]);
/** The routes that judge a document: a failed run on them is a 503, never a verdict. */
const JUDGING_ROUTE = /\/submissions(?:\/validate|\/test)?$/;

/** The SEC-05 / never-500 rule over one exchange; a list of problems (empty: clean). */
export function wireProblems(exchange: Exchange, profile: "submissions"): string[] {
  const problems: string[] = [];
  const where = `${exchange.method} ${exchange.path} -> ${exchange.status}`;
  if (exchange.status >= 500) {
    const code = isRecord(exchange.json) && Array.isArray(exchange.json["errors"]) && isRecord(exchange.json["errors"][0]) ? exchange.json["errors"][0]["code"] : undefined;
    if (!(exchange.status === 503 && typeof code === "string" && SERVICE_UNAVAILABLE_CODES.has(code))) {
      problems.push(`${where}: a server error that is not a typed 503 (${profile})`);
    }
  }
  if (!exchange.jsonOk && !NON_JSON_OK.has(exchange.status) && !exchange.truncated && !isDefinitionRead(exchange)) {
    problems.push(`${where}: the body is not JSON`);
  }
  if (exchange.jsonOk && isRecord(exchange.json) && !isDefinitionRead(exchange)) {
    const body = exchange.json;
    const keys = Object.keys(body);
    const isVerdictOrError = exchange.status >= 400 || "accepted" in body || "errors" in body;
    if (isVerdictOrError && !("id" in body) && exchange.method === "POST") {
      // The 415 of the media-type refusal also carries `code` and `message` (the module's own subscriber).
      const stray = keys.filter((key) => !VERDICT_KEYS.has(key) && !(exchange.status === 415 && (key === "code" || key === "message")));
      if (stray.length > 0) {
        problems.push(`${where}: the body holds ${stray.map((key) => JSON.stringify(key)).join(", ")} beside errors/accepted/journey`);
      }
      for (const list of ["errors", "notes"] as const) {
        if (!Array.isArray(body[list])) {
          continue;
        }
        for (const entry of body[list]) {
          if (!isRecord(entry)) {
            problems.push(`${where}: ${list === "errors" ? "an errors" : "a notes"} entry that is not an object`);
            break;
          }
          const extra = Object.keys(entry).filter((key) => !ERROR_ENTRY_KEYS.has(key));
          if (extra.length > 0) {
            problems.push(`${where}: ${list === "errors" ? "an errors" : "a notes"} entry holds ${extra.map((key) => JSON.stringify(key)).join(", ")} beside field, code, severity, message`);
            break;
          }
        }
      }
      // A run that failed answers 503. A 200 or 422 that carries the run's code is a host that reads a failure as a
      // judgement of the answers (the verdict an author or a visitor would act on). definition.tooDeep keeps its 422
      // where a builder save refuses a definition, so only the judging routes are held to it.
      if ((exchange.status === 200 || exchange.status === 422) && JUDGING_ROUTE.test(exchange.path.split("?")[0] ?? "") && Array.isArray(body["errors"])) {
        const failed = body["errors"].map((entry) => (isRecord(entry) ? entry["code"] : undefined)).find((code) => typeof code === "string" && (RUN_FAILED_CODES.has(code) || code === "definition.tooDeep"));
        if (failed !== undefined) {
          problems.push(`${where}: the run gave no verdict (${String(failed)}) and is answered as one: a failed run is a 503 with its code, never a ${exchange.status}`);
        }
      }
    }
  }
  if (holdsHostPath(exchange) && !LEAK_MARKERS.some((marker) => exchange.text.includes(marker) && markerCounts(marker, exchange))) {
    problems.push(`${where}: the body holds a host filesystem path`);
  }
  for (const marker of LEAK_MARKERS) {
    if (exchange.text.includes(marker) && markerCounts(marker, exchange)) {
      problems.push(`${where}: the body holds ${JSON.stringify(marker)}`);
    }
  }
  return problems;
}

/** A filesystem path (not a public URL): a Unix or Windows root directory, a PHP file and line, or a stack frame. */
const FILESYSTEM_PATH = /(?:\/(?:var|home|opt|usr|srv|root|Users)\/|\b[A-Za-z]:\\)\S|\.php:\d+|^#\d+ \S+\(\d+\)/m;
/** `vendor/` or `node_modules` as a path of the host's tree: after a filesystem root, or as a bare relative path, never inside a URL such as `/core/assets/vendor/`. */
const HOST_TREE_PATH = /(?:(?:\/(?:var|home|opt|usr|srv|root|Users)\/|\b[A-Za-z]:\\)\S*?|(?:^|[\s"'(]))(?:vendor\/|node_modules\b)/m;

/** Whether a marker found in a body is a leak: `vendor/` and `node_modules` only as host paths in a JSON body (a themed HTML 404/405 page links its own `/core/assets/vendor/` scripts). */
function markerCounts(marker: string, exchange: Exchange): boolean {
  if (marker === "vendor/" || marker === "node_modules") {
    return exchange.jsonOk && HOST_TREE_PATH.test(exchange.text);
  }
  return true;
}

/** Whether a JSON body holds a host filesystem path (SEC-05); public asset URLs never count. */
export function holdsHostPath(exchange: Exchange): boolean {
  return exchange.jsonOk && FILESYSTEM_PATH.test(exchange.text);
}

function isDefinitionRead(exchange: Exchange): boolean {
  return exchange.method === "GET" && exchange.label.startsWith("definition");
}

export function jsonOf(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}
