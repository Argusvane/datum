import type { Json, Observation } from "../../../observation.js";
import type { Exchange, HttpResponse } from "../http.js";
import { LEAK_MARKERS } from "../wire.js";

/**
 * Normalises the answer of a definition-saving route into the one Observation shape:
 * 200/201 an answer `{ http, body }`; 400 bad_document; 401/403 forbidden; 404 not_found; 405
 * method; 409 outdated; 413 too_large; 415 unsupported_media; 422 definition_refused (the code is
 * the first named problem, the codes all of them); 429 rate_limited; 503 unavailable; any other
 * 5xx, or JSON promised and not delivered, server_error / malformed_response (the never-500
 * rule: always a failure). A 3xx is `other` with the code `redirect`: the runner treats it as
 * "the credentials sent us to a login page", never as an answer.
 */
export function observeBuilder(response: Pick<HttpResponse, "status" | "text" | "json" | "jsonOk">, options: { htmlOk?: boolean } = {}): Observation {
  const { status } = response;
  const detail = `HTTP ${status}${response.text.length > 0 ? `: ${clip(response.text, 2000)}` : ""}`;
  const body = response.jsonOk && isRecord(response.json) ? response.json : undefined;
  const { code, codes } = codesOf(body);
  const refusal = (kind: Extract<Observation, { kind: "refusal" }>["refusal"], extra: { code?: string; codes?: string[] } = {}): Observation => ({
    kind: "refusal",
    refusal: kind,
    http: status,
    ...(extra.code !== undefined ? { code: extra.code } : {}),
    ...(extra.codes !== undefined && extra.codes.length > 0 ? { codes: extra.codes } : {}),
    detail
  });

  if (status === 503) {
    return body !== undefined && typeof body["code"] === "string" ? refusal("unavailable", { code: body["code"] as string }) : refusal("unavailable", code !== undefined ? { code } : {});
  }
  if (status >= 500) {
    return refusal("server_error");
  }
  if (status >= 300 && status < 400) {
    return refusal("other", { code: "redirect" });
  }
  if (status >= 200 && status < 300) {
    if (body === undefined) {
      return refusal("malformed_response");
    }
    return { kind: "answer", json: { http: status, body: body as Json } };
  }
  // 4xx: the status says what it is. Routing and access answers are the web framework's HTML; the rest are promised as JSON.
  switch (status) {
    case 401:
    case 403:
      return refusal("forbidden", code !== undefined ? { code } : {});
    case 404:
      return refusal("not_found", code !== undefined ? { code } : {});
    case 405:
      return refusal("method", code !== undefined ? { code } : {});
    case 413:
      return refusal("too_large", code !== undefined ? { code } : {});
    case 415:
      return refusal("unsupported_media", code !== undefined ? { code } : {});
    case 429:
      return refusal("rate_limited", code !== undefined ? { code } : {});
    default:
      break;
  }
  if (body === undefined && options.htmlOk !== true) {
    return refusal("malformed_response");
  }
  if (status === 400) {
    return refusal("bad_document", { code: code ?? "bad_document" });
  }
  if (status === 409) {
    return refusal("outdated", { code: code ?? "outdated" });
  }
  if (status === 422) {
    return refusal("definition_refused", { code: code ?? "problems", ...(codes.length > 0 ? { codes } : {}) });
  }
  return refusal("other", code !== undefined ? { code } : {});
}

/** The typed codes of an error body: the submissions service's `code` and `errors[]`. */
function codesOf(body: Record<string, unknown> | undefined): { code: string | undefined; codes: string[] } {
  if (body === undefined) {
    return { code: undefined, codes: [] };
  }
  const tokens: string[] = [];
  const kernel = body["kernel"];
  if (Array.isArray(kernel)) {
    for (const entry of kernel) {
      if (isRecord(entry) && typeof entry["code"] === "string") {
        tokens.push(typeof entry["where"] === "string" && entry["where"] !== "" ? `${entry["code"]}@${entry["where"]}` : entry["code"]);
      }
    }
  }
  const errors = body["errors"];
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (isRecord(entry) && typeof entry["code"] === "string") {
        tokens.push(entry["code"]);
      }
    }
  }
  const first = tokens[0];
  const named = typeof body["code"] === "string" ? (body["code"] as string) : undefined;
  return { code: named ?? (first !== undefined ? first.split("@")[0] : undefined), codes: tokens };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** The statuses whose body may be the web framework's HTML page. */
const HTML_OK = new Set([401, 403, 404, 405, 413, 415, 431]);
/**
 * The codes a typed 503 may carry (the same list as the receiving routes' wire.ts): the service is down or busy, a data
 * source is unreachable, or a run gave no verdict (`wasm.execution_error`, `outcome_too_large`, `definition.tooDeep` of the
 * registered form), which a chained check after a save can meet.
 */
const UNAVAILABLE_CODES = new Set(["server.unavailable", "validator_unavailable", "server.busy", "data_source.unavailable", "wasm.execution_error", "outcome_too_large", "definition.tooDeep"]);

/** The builder's SEC-05: the never-500 rule and the leak markers over one JSON-route exchange (page reads are judged by their own rows). */
export function builderWireProblems(exchange: Exchange): string[] {
  if (exchange.label.startsWith("page ")) {
    return [];
  }
  const problems: string[] = [];
  const where = `${exchange.method} ${exchange.path} -> ${exchange.status}`;
  if (exchange.status >= 500) {
    // The builder's own errors carry `code` at the top; the receiving routes (a chained check) carry `errors: [{code}]`.
    const first = isRecord(exchange.json) && Array.isArray(exchange.json["errors"]) && isRecord(exchange.json["errors"][0]) ? exchange.json["errors"][0]["code"] : undefined;
    const code = isRecord(exchange.json) ? (exchange.json["code"] ?? first) : undefined;
    if (!(exchange.status === 503 && typeof code === "string" && UNAVAILABLE_CODES.has(code))) {
      problems.push(`${where}: a server error that is not a typed 503`);
    }
  }
  const redirect = exchange.status >= 300 && exchange.status < 400;
  if (!exchange.jsonOk && !exchange.truncated && !redirect && !HTML_OK.has(exchange.status) && exchange.status !== 204) {
    problems.push(`${where}: the body is not JSON`);
  }
  // A page the web framework drew links to its own assets (`/core/assets/vendor/...`): those two markers only count in a JSON body.
  const pageOnly = new Set(["vendor/", "node_modules"]);
  for (const marker of LEAK_MARKERS) {
    if (marker === "ZZSECRETZZ" || (!exchange.jsonOk && pageOnly.has(marker))) {
      continue;
    }
    if (exchange.text.includes(marker)) {
      problems.push(`${where}: the body holds ${JSON.stringify(marker)}`);
    }
  }
  return problems;
}
