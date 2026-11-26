/**
 * How a host on HTTP puts the service on the wire: the routes, what each maps to,
 * and how a service answer becomes a status. Pure data and pure functions — no framework, no
 * request object — so the Data tab can print it as documentation and an Express host can
 * mount it as a table. The endpoints keep the paths the docs site's server examples use.
 */
import { HostContextError, type ReceiveResult, type ValidateInput, type ValidationVerdict } from "./service.js";
import { RUN_FAILED_CODES, SubmissionServiceError } from "./types.js";

export { RUN_FAILED_CODES } from "./types.js";

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface RouteSpec {
  method: HttpMethod;
  /** With `:name` parameters, Express style. */
  path: string;
  /** The `SubmissionService` method the route calls. */
  operation: string;
  summary: string;
  /** What a 2xx carries. */
  responds: string;
}

export const SUBMISSION_ROUTES: readonly RouteSpec[] = [
  { method: "POST", path: "/api/submissions", operation: "receive", summary: "A form delivers its envelope with its submit attempt's key (`{ document, submissionKey }`); validated in the sandbox, stored, answered with a receipt or the errors. A retry with the same key and document is answered with the first record; a body without a key is refused (400).", responds: "200 { id, status, digest, receipt } | 400 | 404 | 409 { code: \"version_superseded\" } or { code: \"submission.keyConflict\" } | 413 | 422 { errors: [{ field, code }] } | 503" },
  {
    method: "POST",
    path: "/api/submissions/validate",
    operation: "validate",
    summary:
      "The same checks and verdict as a delivery — the sandbox, then the server's hooks — with nothing stored: what a journey asks on Continue (`{ document, scope: \"page\", pageId }`) and before its final Submit (`{ document, scope: \"journey\" }`). `scope` is required; `parseValidateRequest` reads the body strictly.",
    responds: "200 { accepted, errors: [{ field?, code, message? }], notes?: [{ field?, code, severity, message? }] } | 400 | 404 | 409 { code: \"version_superseded\" } | 413 | 503"
  },
  { method: "GET", path: "/api/forms", operation: "listCatalog", summary: "The forms the server accepts submissions for, with their counts, each as its public copy (the `server-secret` rules removed from `definition` and `compiled`, no text of one in `formulaProblems`, no registered option rows). The registering host reads the whole entries through `listCatalogFull`, never through a route.", responds: "200 [{ key, formId, formVersion, title, definition, counts, settings }]" },
  { method: "POST", path: "/api/forms", operation: "register", summary: "Registers a form definition (its id and version key it) with optional settings; formulas that do not parse are listed (`formulaProblems`) or, under the `fail` policy, refuse it.", responds: "201 { key, formulaProblems? } | 422 { code }" },
  {
    method: "GET",
    path: "/api/forms/:key/definition",
    operation: "publicDefinition",
    summary:
      "The definition a host serves to a browser: the form as registered without its `server-secret` rules (the rule and its `run` entry; the field stays). The server still judges with the full one.",
    responds: "200 FormDefinition | 404"
  },
  {
    method: "GET",
    path: "/api/forms/:key/inspect",
    operation: "inspect",
    summary:
      "Operator only, never to a browser: the sandbox's answer about the registered definition; `?op=public|check|inspect` (default `inspect`): the public copy, the compile's problems with the policy and verdict (a problem on a `server-secret` rule names where and code, never the text), or the rules inventory (scope, reads, functions, plugins needed), which names secret rules.",
    responds: "200 { ok: true, op, ... } | 400 | 404"
  },
  { method: "DELETE", path: "/api/forms/:key", operation: "deleteEntry", summary: "Removes a form; `?cascade=true` removes its records too.", responds: "204" },
  { method: "POST", path: "/api/forms/:key/settings", operation: "updateSettings", summary: "Changes what happens on receipt: unknown fields, PDF, signing, receipt text.", responds: "200 { settings }" },
  { method: "GET", path: "/api/forms/:key/submissions", operation: "listRecords", summary: "The records for a form, newest first; `?status=&cursor=&limit=`.", responds: "200 { items, total, cursor? }" },
  { method: "GET", path: "/api/forms/:key/stats", operation: "aggregate", summary: "Counts per day, per-field distributions and numeric summaries, by locale and version.", responds: "200 AggregateResult" },
  { method: "GET", path: "/api/forms/:key/export", operation: "exportRecords", summary: "Every accepted record as CSV or JSON; `?format=csv|json`.", responds: "200 text/csv | application/json" },
  { method: "GET", path: "/api/submissions/:id", operation: "getRecord", summary: "One record: the delivered document, the verdict, the log, the PDF's summary.", responds: "200 SubmissionRecord | 404" },
  { method: "DELETE", path: "/api/submissions/:id", operation: "deleteRecord", summary: "Removes a record and its PDF.", responds: "204" },
  { method: "GET", path: "/api/submissions/:id/pdf", operation: "getPdf", summary: "The server's PDF for the record.", responds: "200 application/pdf | 404" },
  { method: "GET", path: "/api/submissions/:id/signatures", operation: "inspectRecord", summary: "Every signature on the record, envelope and PDF, check by check.", responds: "200 { envelope, pdf? }" },
  { method: "POST", path: "/api/inspect", operation: "inspectDocument", summary: "A submission JSON or a PDF, inspected without being stored.", responds: "200 { envelope, pdf? } | 400" },
  { method: "POST", path: "/api/pdf/import", operation: "importPdf", summary: "A server PDF back into a record: its `submission.json`, or its template fields.", responds: "201 { id } | 422 { code }" },
  { method: "GET", path: "/api/server/certificate", operation: "serverKey", summary: "The server's signing certificate, PEM, so a verifier can trust it.", responds: "200 application/x-pem-file" }
];

/**
 * The HTTP status a service refusal maps to. A sandbox run that gave no verdict (`wasm.execution_error`,
 * `outcome_too_large`, `definition.tooDeep`) is a 503 with the run's own code, like an unavailable
 * validator or host context: no verdict was reached, and a 422 would tell the filler to fix answers
 * that were not the trouble. No status here asks for a `Retry-After`: the same run fails the same way.
 */
export function statusOf(error: { code: string }): number {
  if (RUN_FAILED_CODES.has(error.code)) {
    return 503;
  }
  switch (error.code) {
    case "unknown_form":
    case "unknown_record":
      return 404;
    case "bad_document":
      return 400;
    case "payload_too_large":
      return 413;
    case "version_superseded":
    case "submission.keyConflict":
      return 409;
    case "not_extractable":
    case "invalid_definition":
      return 422;
    case "pdf_unavailable":
    case "keys_unavailable":
    case "validator_unavailable":
    case "server.unavailable":
      return 503;
    default:
      return 500;
  }
}

/** A status and the JSON body a route answers with. */
export interface WireResponse {
  status: number;
  body: unknown;
}

/**
 * What a route answers when the service threw: a {@link SubmissionServiceError} under its status
 * and code (`{ errors: [{ code }] }`, the run's own code for a failed run), and a host context the
 * host got wrong ({@link HostContextError}, a programming error the service throws as a `TypeError`)
 * as 503 `server.unavailable`, never a 500. Anything else is no refusal the service knows: a 500 the
 * host should log, and the caller is given `undefined` so it can rethrow or log the cause itself.
 */
export function errorResponse(error: unknown): WireResponse | undefined {
  if (error instanceof SubmissionServiceError) {
    return { status: statusOf(error), body: { errors: [{ code: error.code }] } };
  }
  if (error instanceof HostContextError) {
    return { status: statusOf(error), body: { errors: [{ code: error.code }] } };
  }
  return undefined;
}

/** A 422's body from a rejected record's errors: codes and fields, never text; `field` is left out when the error names no component. */
export function errorsBody(errors: readonly { code: string; componentId?: string | undefined }[]): { errors: Array<{ field?: string; code: string }> } {
  return { errors: errors.map((error) => (error.componentId === undefined ? { code: error.code } : { field: error.componentId, code: error.code })) };
}

/**
 * What a delivery answers: `200 { id, status, digest, receipt }` for an accepted record, else
 * `422` with the record's errors ({@link errorsBody}). A failed sandbox run never gets here: the
 * service refuses it (a {@link SubmissionServiceError}), so {@link errorResponse} answers it 503.
 */
export function receiveResponse(result: ReceiveResult): WireResponse {
  if (result.record.status === "accepted") {
    return { status: 200, body: { id: result.record.id, status: result.record.status, digest: result.record.digest, receipt: result.receipt ?? null } };
  }
  return { status: 422, body: errorsBody(result.errors) };
}

/** One finding on the wire: `field` only when it names a component, `message` only when the sandbox or a hook gave one. */
export interface WireFinding {
  field?: string;
  code: string;
  message?: string;
}

/** A finding that does not block: a warning or an info, with its severity. */
export interface WireNote extends WireFinding {
  severity: "warning" | "info";
}

/** A check's 200 body (`validate`): `errors` holds what blocks, `notes` the rest. */
export interface WireVerdict {
  accepted: boolean;
  errors: WireFinding[];
  notes?: WireNote[];
}

/**
 * A check's 200 body (`validate`): `{ accepted, errors, notes? }`. `errors` holds the
 * blocking findings only (a severity of `error`, or none), each `{ field?, code, message? }`: no
 * `severity`, no `field` when the finding names no component, and a `message` when the sandbox
 * or a hook supplied one. `notes` holds the warnings and info as `{ field?, code, severity,
 * message? }`, and is left out when there are none, never `[]`. Parameters never go: a check
 * stores nothing, and a hook's parameters are its own. The path the server worked out
 * (`verdict.journey`) is diagnostics for an in-process caller, not part of the wire.
 *
 * A run that failed is no verdict, so there is none to word here: the service refuses it
 * (see {@link statusOf}).
 */
export function validationBody(verdict: {
  accepted: boolean;
  errors: readonly { code: string; componentId?: string | undefined; severity?: string | undefined; message?: string | undefined }[];
}): WireVerdict {
  const errors: WireFinding[] = [];
  const notes: WireNote[] = [];
  for (const entry of verdict.errors) {
    const finding: WireFinding = {
      ...(entry.componentId !== undefined && entry.componentId !== "" ? { field: entry.componentId } : {}),
      code: entry.code,
      ...(typeof entry.message === "string" && entry.message !== "" ? { message: entry.message } : {})
    };
    if (entry.severity === "warning" || entry.severity === "info") {
      notes.push({ ...finding, severity: entry.severity });
    } else {
      errors.push(finding);
    }
  }
  return { accepted: verdict.accepted, errors, ...(notes.length > 0 ? { notes } : {}) };
}

/** What a check answers: `200` with {@link validationBody}. A verdict that refuses the answers is still a 200 (`accepted: false`). */
export function validateResponse(verdict: ValidationVerdict): WireResponse {
  return { status: 200, body: validationBody(verdict) };
}

/**
 * A check's request body as the wire has it, read strictly: `{ document, scope, pageId? }`, with
 * `document` an object (the submission envelope), `scope` required and either `"journey"` (which
 * names no page) or `"page"` (which names one, a non-empty string). Anything else is `bad_document`
 * (400). The service's own `validate` takes more (the bare form of values, an absent scope that
 * judges the whole submission) for a host that calls it in-process; this is the shape a browser's
 * `<datum-form validate-url>` and the other hosts take, so it is the one a route reads.
 */
export function parseValidateRequest(body: unknown): ValidateInput {
  const refuse = (why: string): never => {
    throw new SubmissionServiceError("bad_document", why);
  };
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return refuse("A check is a JSON object: { document, scope, pageId? }.");
  }
  const { document, scope, pageId } = body as Record<string, unknown>;
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return refuse("A check wraps the submission envelope as { document }.");
  }
  if (scope === "journey") {
    if (pageId !== undefined) {
      return refuse('A pageId goes with scope "page" only.');
    }
    return { document: document as never, scope };
  }
  if (scope === "page") {
    if (typeof pageId !== "string" || pageId === "") {
      return refuse('A check with scope "page" names the page it checks (pageId).');
    }
    return { document: document as never, scope, pageId };
  }
  return refuse('A check names its scope, "page" or "journey".');
}
