import { sha256Hex } from "../crypto/sha256.js";
import type { ErrorSeverity, HostError } from "../errors/form-error.js";
import { parseComponentPath } from "../tree/component-path.js";
import type { JourneyCheckOutcome, JourneyCheckUnavailableReason } from "../events/event-types.js";
import type { JourneyValidationRequest } from "./journey-types.js";

/**
 * The pure half of a journey's checks against the host's server: the key a request
 * is remembered by, what a server's reply is read as, how much of it a page keeps, and what a
 * validator's rejection means. The runtime does the asking; these decide nothing on their own,
 * so a host, a server or a test can read a reply exactly as the browser does.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON with every object's keys in code-unit order, so equal requests always serialize alike.
 * Never `localeCompare`: collation differs between engines (the validation ABI's rule too).
 */
export function journeyStableJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(sort);
    }
    if (isRecord(input)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        out[key] = sort(input[key]);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(sort(value)) ?? "";
}

/**
 * A request's key: the SHA-256 of the whole request — scope, journey, page, every submittable
 * value, the locale. A page's clean check is remembered by it, so the cache answers only for
 * exactly the request the server passed.
 */
export function journeyCheckKey(request: JourneyValidationRequest): string {
  return sha256Hex(journeyStableJson(request));
}

/** A value path's component, when the form has one there (the runtime's `componentIdForPath`, rows included). */
export type JourneyPathResolver = (path: string) => string | undefined;

const SEVERITIES: readonly ErrorSeverity[] = ["error", "warning", "info"];

/** Whether `path` is a value path the form can place: dot segments, each with an optional `[n]`. */
function isComponentPath(path: string): boolean {
  try {
    parseComponentPath(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A server's reply read as the errors it reports, or `undefined` when it is not a verdict —
 * not an object with an `errors` array, an entry that is not an object with a `code`, or an
 * entry whose `path` is not a value path (a JSON Pointer such as `/notes`, say) — which a
 * journey counts as the server being unavailable ("malformed"): a broken backend never lets
 * answers through as clean, and never leaves a check it cannot read pending.
 *
 * Tolerant of how a custom backend names a field: `componentId`, else `field` (the README's
 * `{ field, code }` servers), else a value `path` the resolver maps to its component
 * (`order.items[0].sku` to the entry's field, a data key or a data-scoping container to the
 * component stored there). An entry naming none of these is the form's as a whole. Every entry
 * comes back with `source: "server"`: it is the server's word, whatever the reply says.
 */
export function normalizeValidationReply(reply: unknown, resolve?: JourneyPathResolver): HostError[] | undefined {
  if (!isRecord(reply) || !Array.isArray(reply.errors)) {
    return undefined;
  }
  const out: HostError[] = [];
  for (const entry of reply.errors) {
    if (!isRecord(entry) || typeof entry.code !== "string" || entry.code === "") {
      return undefined;
    }
    const error: HostError = { code: entry.code, source: "server" };
    if (typeof entry.message === "string") {
      error.message = entry.message;
    }
    if (typeof entry.path === "string" && entry.path.trim() !== "") {
      // Read the one way the runtime stores it, so a server host and the browser read a reply
      // alike: a path the form cannot parse names no answer anyone can place or fix.
      if (!isComponentPath(entry.path)) {
        return undefined;
      }
      error.path = entry.path;
    }
    const named =
      typeof entry.componentId === "string" && entry.componentId !== ""
        ? entry.componentId
        : typeof entry.field === "string" && entry.field !== ""
          ? entry.field
          : undefined;
    const componentId = named ?? (error.path !== undefined ? resolve?.(error.path) : undefined);
    if (componentId !== undefined) {
      error.componentId = componentId;
    }
    if (SEVERITIES.includes(entry.severity as ErrorSeverity)) {
      error.severity = entry.severity as ErrorSeverity;
    }
    if (isRecord(entry.parameters)) {
      error.parameters = { ...entry.parameters };
    }
    out.push(error);
  }
  return out;
}

/**
 * A page's share of a reply: the entries on the page's components (`members`: the components
 * it lists and their subtrees), and the entries naming no component — the form's as a whole,
 * which the page then owns until the page changes. A backend that judged the whole form does
 * not block Continue with another page's errors; one that reported against a field it could
 * not name still blocks.
 *
 * An entry naming a component the form does not have (`isComponent` false: a renamed field, a
 * typo in a hook, a server judging another version) is no other page's: it blocks as the form's
 * own, its id moved into `parameters`. Kept on the unknown id it would block for good, since
 * nothing the person answers ever clears an error on a field no page shows.
 */
export function scopeReplyToPage(
  errors: readonly HostError[],
  members: ReadonlySet<string>,
  isComponent: (componentId: string) => boolean
): HostError[] {
  const kept: HostError[] = [];
  for (const error of errors) {
    const componentId = error.componentId;
    if (componentId === undefined || members.has(componentId)) {
      kept.push(error);
    } else if (!isComponent(componentId)) {
      const { componentId: _unknown, ...formLevel } = error;
      kept.push({ ...formLevel, parameters: { componentId, ...formLevel.parameters } });
    }
  }
  return kept;
}

/** Whether a reply's entry blocks: severity `"error"`, the default. */
export function journeyErrorBlocks(error: { severity?: ErrorSeverity | undefined }): boolean {
  return (error.severity ?? "error") === "error";
}

/** What a reply's (kept) entries make of a check. */
export function journeyReplyOutcome(errors: readonly { severity?: ErrorSeverity | undefined }[]): Extract<JourneyCheckOutcome, "clean" | "invalid" | "warnings"> {
  if (errors.some(journeyErrorBlocks)) {
    return "invalid";
  }
  return errors.length > 0 ? "warnings" : "clean";
}

/** What a validator's rejection means: never a verdict, so the check is unavailable. */
export type JourneyCheckFailure = { outcome: "unavailable"; reason: JourneyCheckUnavailableReason; status?: number };

/**
 * A validator's rejection classified. A timeout is `"timeout"` whatever the error says. An
 * error carrying a numeric `status` (an HTTP status, which `createFetchJourneyValidator`
 * attaches) is a server error, a 4xx included: a lapsed session (401, 403), a moved route (404)
 * or an unknown form is no verdict on the answers, so the page is held as it is in an outage and
 * `onUnavailable` decides, rather than going on unchecked. One without a status never reached
 * the server.
 */
export function classifyValidatorFailure(error: unknown, timedOut: boolean): JourneyCheckFailure {
  const raw = isRecord(error) ? error.status : undefined;
  const status = typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  if (timedOut) {
    return status !== undefined ? { outcome: "unavailable", reason: "timeout", status } : { outcome: "unavailable", reason: "timeout" };
  }
  if (status === undefined) {
    return { outcome: "unavailable", reason: "network" };
  }
  return { outcome: "unavailable", reason: "server-error", status };
}
