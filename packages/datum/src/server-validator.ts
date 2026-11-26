import type {
  CanonicalSubmission,
  ErrorSeverity,
  HostError,
  JourneyServerValidator,
  JourneyValidationRequest,
  JourneyValidationResponse
} from "@argusvane/datum-engine";

import { JourneyValidationHttpError } from "./server-validator-error.js";

/**
 * This module is reached by dynamic import alone (`server-validator-loader.ts`), so
 * the bundler gives it a lazy chunk beside the bundle; nothing may import it statically.
 *
 * The way to a host's server that `<datum-form validate-url>` builds: what a
 * journey asks there — a page on Continue (`validation.server`), the whole journey before its
 * final Submit (`validation.end: "server"`) — posted as the delivery a Datum host's
 * `POST /api/submissions/validate` takes, and the server's errors read back into the form. A
 * page that needs more than a URL (a token in a header, cookies across origins) builds one
 * itself with {@link createFetchJourneyValidator} and assigns it to `serverValidator`, or
 * writes its own `JourneyServerValidator` outright.
 */

export interface FetchJourneyValidatorOptions {
  /** Sent with every check, after the JSON content type: an authorization token, a CSRF header. */
  headers?: Record<string, string>;
  /** The fetch's `credentials`: `"include"` for a server on another origin that reads cookies. */
  credentials?: RequestCredentials;
}

const SEVERITIES: readonly ErrorSeverity[] = ["error", "warning", "info"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One error as a server words it, as the form stores it. The field is `componentId`, or
 * `field` as a Datum host writes it (`null` or absent there for the form as a whole);
 * `undefined` when the entry is no error at all. `note` reads an entry of a reply's `notes`
 * list, which never blocks: its severity is `warning` unless it says `info`.
 */
function toHostError(entry: unknown, note: boolean): HostError | undefined {
  if (!isRecord(entry) || typeof entry.code !== "string" || entry.code === "") {
    return undefined;
  }
  const field = typeof entry.componentId === "string" ? entry.componentId : typeof entry.field === "string" ? entry.field : undefined;
  const given = (SEVERITIES as unknown[]).includes(entry.severity) ? (entry.severity as ErrorSeverity) : undefined;
  const severity = note ? (given === "info" ? "info" : "warning") : given;
  return {
    code: entry.code,
    ...(field !== undefined && field !== "" ? { componentId: field } : {}),
    ...(typeof entry.path === "string" && entry.path !== "" ? { path: entry.path } : {}),
    ...(typeof entry.message === "string" ? { message: entry.message } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(isRecord(entry.parameters) ? { parameters: entry.parameters } : {})
  };
}

/** Whether an error blocks: any severity but `warning` and `info` (the runtime's rule). */
function blocks(error: HostError): boolean {
  return error.severity !== "warning" && error.severity !== "info";
}

/**
 * A `JourneyServerValidator` that posts each check to `url` as a Datum host's
 * `POST /api/submissions/validate` takes it: `{ document, scope, pageId? }`. `document` is the
 * submission envelope the runtime hands over, built as Submit builds `datum-submit`'s, so it
 * carries the answers, the locale and the journey; `scope` is `"page"` or `"journey"`; `pageId`
 * names the page for `"page"`. Posted under the runtime's signal, so a check the person walked
 * away from, or one that timed out, is abandoned. A call with no `document` rejects: there is
 * nothing to post.
 *
 * A 200 or a 422 is a verdict: its body's `errors` array, each entry `{ field | componentId,
 * code, message?, severity? }`, with a `notes` array beside it read as warnings when the
 * server sends one. An `accepted` flag that disagrees with the errors makes the reply
 * untrusted. Any other status rejects with a {@link JourneyValidationHttpError} carrying it; a
 * body that is not JSON or has no `errors` array rejects as malformed; a network failure
 * rejects as the fetch did. Every rejection is the runtime's to class: the person
 * never sees a status code.
 */
export function createFetchJourneyValidator(url: string, options: FetchJourneyValidatorOptions = {}): JourneyServerValidator {
  return async (
    request: JourneyValidationRequest,
    call?: { signal?: AbortSignal; document?: CanonicalSubmission }
  ): Promise<JourneyValidationResponse> => {
    if (call?.document === undefined) {
      throw new Error(`No document to post to ${url}`);
    }
    // JSON leaves an undefined pageId out: a journey's check names no page.
    const delivery = { document: call.document, scope: request.scope, pageId: request.scope === "page" ? request.pageId : undefined };
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(options.headers ?? {}) },
      body: JSON.stringify(delivery),
      ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
      ...(call.signal !== undefined ? { signal: call.signal } : {})
    });
    if (response.status !== 200 && response.status !== 422) {
      throw new JourneyValidationHttpError(response.status, url);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`The journey check at ${url} answered ${response.status} with a body that is not JSON`);
    }
    if (!isRecord(body) || !Array.isArray(body.errors)) {
      throw new Error(`The journey check at ${url} answered ${response.status} without an errors array`);
    }
    const errors: HostError[] = [];
    const read = (list: unknown[], note: boolean): void => {
      for (const entry of list) {
        const error = toHostError(entry, note);
        if (!error) {
          // An error the form cannot read could be the one that blocks: the reply is not trusted.
          throw new Error(`The journey check at ${url} answered with an error that has no code`);
        }
        errors.push(error);
      }
    };
    read(body.errors, false);
    read(Array.isArray(body.notes) ? body.notes : [], true);
    if (body.accepted === errors.some(blocks)) {
      // "Accepted" with a blocking error, or refused with none: no verdict the form can follow.
      throw new Error(`The journey check at ${url} answered an accepted flag its errors contradict`);
    }
    return { errors };
  };
}
