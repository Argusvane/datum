/**
 * Caps and paging for agent-tool results. Chrome caps nothing (a 1 MiB
 * string passed intact), so the registrar measures every envelope after the tool
 * returns and shrinks it in three steps before it can exceed 64 KB. Tools page their own long
 * lists first with `pageOf`; the person-facing `purpose` / `summary` strings are tidied with
 * `cleanText` before the schema check so they are cut, never refused.
 *
 * Pure: no DOM, no engine imports. `TextEncoder` is a global under node and in browsers.
 */

/** The output cap per result: 65 536 bytes of UTF-8 JSON. */
export const RESULT_BYTE_LIMIT = 65_536;

/** Strings longer than this inside an over-cap envelope are cut by step (a). */
export const RESULT_STRING_CAP = 1_024;

const ELLIPSIS = "…";
const encoder = new TextEncoder();

/** Measures a value as the bytes of its UTF-8 JSON text (what the browser sends on): the unit of every cap. */
export function jsonByteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

export interface Page<T> {
  items: T[];
  /** The whole list's length, so the agent knows how far `offset` can go. */
  total: number;
  /** Set when the page stops before the end; `nextOffset` is where to continue. */
  truncated?: true;
  nextOffset?: number;
}

/** Enforces paging over a long list: the `limit` items from `offset`, with `truncated` and `nextOffset` when the list goes on. */
export function pageOf<T>(items: readonly T[], offset: number, limit: number): Page<T> {
  const start = Math.max(0, Math.floor(offset));
  const size = Math.max(0, Math.floor(limit));
  const page = items.slice(start, start + size);
  const end = start + page.length;
  if (end < items.length) {
    return { items: page, total: items.length, truncated: true, nextOffset: end };
  }
  return { items: page, total: items.length };
}

/** Width the ellipsis is charged at: its three UTF-8 bytes, so an ASCII string cut at 1 024 lands at 1 021 + "…" and at most 1 024 bytes. */
const ELLIPSIS_WIDTH = 3;

/** Enforces a string cap: a string over `max` characters is cut to `max - 3` characters plus "…" (so it stays within `max` bytes for ASCII text); shorter strings pass unchanged. */
export function cutString(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let keep = Math.max(0, max - ELLIPSIS_WIDTH);
  // Never split a surrogate pair: the cut text must stay valid UTF-16 (and so valid JSON).
  const last = text.charCodeAt(keep - 1);
  if (keep > 0 && last >= 0xd800 && last <= 0xdbff) {
    keep -= 1;
  }
  return `${text.slice(0, keep)}${ELLIPSIS}`;
}

/**
 * Enforces the person-facing text rule for `purpose` and `summary`:
 * control characters other than "\n" stripped, "\n" turned into a space, surrounding
 * whitespace trimmed, then cut at `max` so the schema check never sees an over-long value.
 */
export function cleanText(text: unknown, max: number): string {
  const source = typeof text === "string" ? text : "";
  const cleaned = source
    .replace(/\n/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
  return cutString(cleaned, max);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Step (a): a copy of the value with every string over the cap cut; reports whether anything changed. */
function cutStrings(value: unknown, changed: { count: number }): unknown {
  if (typeof value === "string") {
    if (value.length > RESULT_STRING_CAP) {
      changed.count += 1;
      return cutString(value, RESULT_STRING_CAP);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cutStrings(item, changed));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = cutStrings(item, changed);
    }
    return out;
  }
  return value;
}

/** The kinds whose `value` is dropped by step (b): rows and file descriptors are the bulky ones . */
const BULKY_KINDS: ReadonlySet<string> = new Set(["collection", "file"]);

/**
 * Step (b): a copy of the value where a field row's inline `options` array becomes
 * `optionCount` and the `value` of a collection or file row is dropped (`valueOmitted: true`);
 * reports whether anything changed. A field row is an object that carries a string `kind`
 * (describe_form / get_answers rows); a listing tool's own paged payload, such
 * as the root `options` of get_options , has no `kind` beside it and is left
 * alone, so an over-cap page falls through to step (c) and the agent is told to lower `limit`.
 */
function dropBulk(value: unknown, changed: { count: number }): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => dropBulk(item, changed));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "options" && Array.isArray(item) && typeof value.kind === "string") {
      changed.count += 1;
      out.optionCount = item.length;
      continue;
    }
    if (key === "value" && typeof value.kind === "string" && BULKY_KINDS.has(value.kind)) {
      changed.count += 1;
      out.valueOmitted = true;
      continue;
    }
    out[key] = dropBulk(item, changed);
  }
  return out;
}

export interface CappedResult {
  result: Record<string, unknown>;
  /** True when any of the three steps changed the envelope. */
  truncated: boolean;
}

/**
 * Enforces the output cap on a finished envelope, in this order: (a) strings over 1 024
 * characters cut and `truncated: true` set; (b) field rows' inline option arrays reduced to
 * counts and collection / file values dropped; (c) the data replaced with a `too-large { what:
 * "result", limit, got }` refusal that keeps `tool`, `form` / `builder` and `revision`. `got`
 * is the size of the envelope the tool produced, not the size after (a) and (b) shrank it: the
 * agent reads what its call cost. An envelope under the limit comes back unchanged.
 */
export function capResult(envelope: Record<string, unknown>, limit: number = RESULT_BYTE_LIMIT): CappedResult {
  const original = jsonByteLength(envelope);
  if (original <= limit) {
    return { result: envelope, truncated: false };
  }
  let result = envelope;
  const changed = { count: 0 };
  const cut = cutStrings(envelope, changed) as Record<string, unknown>;
  if (changed.count > 0) {
    result = { ...cut, truncated: true };
    if (jsonByteLength(result) <= limit) {
      return { result, truncated: true };
    }
  }
  changed.count = 0;
  const lean = dropBulk(result, changed) as Record<string, unknown>;
  if (changed.count > 0) {
    result = { ...lean, truncated: true };
    if (jsonByteLength(result) <= limit) {
      return { result, truncated: true };
    }
  }
  const refusal: Record<string, unknown> = {
    ok: false,
    tool: envelope.tool,
    code: "too-large",
    message: `The result is ${original} bytes, over the ${limit} byte limit.`,
    hint: "Use offset/limit, a narrower scope, or paths.",
    retryable: false,
    details: { what: "result", limit, got: original }
  };
  if (typeof envelope.form === "string") {
    refusal.form = envelope.form;
  }
  if (typeof envelope.builder === "string") {
    refusal.builder = envelope.builder;
  }
  if (typeof envelope.revision === "number") {
    refusal.revision = envelope.revision;
  }
  return { result: refusal, truncated: true };
}

/** Warnings kept on one envelope, and the characters each keeps: the rest are counted, not listed. */
export const WARNING_CAP = 20;
export const WARNING_CHARS = 200;

/** Problems kept in a `bad-input` refusal's `details.problems`; the rest are counted in `totalProblems`. */
export const PROBLEM_CAP = 50;

/**
 * Enforces the warning cap. A list within it keeps each warning up to `RESULT_STRING_CAP` (the
 * sentence is what the agent acts on: a cut option list or id loses it); past it the first 20 are
 * cut to 200 characters, then one line says how many were left out.
 */
export function capWarnings(warnings: readonly string[]): string[] {
  if (warnings.length <= WARNING_CAP) {
    return warnings.map((warning) => cutString(warning, RESULT_STRING_CAP));
  }
  const kept = warnings.slice(0, WARNING_CAP).map((warning) => cutString(warning, WARNING_CHARS));
  kept.push(`${warnings.length - WARNING_CAP} more warnings were left out.`);
  return kept;
}

/**
 * Keeps a refusal under the output cap without losing what the agent routes on. A
 * refusal is not run through `capResult`: its step (c) would turn a `bad-input` into `too-large`
 * and the agent would lose the code and the problems. The lists are cut instead: `details.problems`
 * keeps its first 50 entries in order (each key and expectation cut) with `truncated` and the
 * `totalProblems`, then, only when the envelope is still over `limit`, every long string is cut
 * and, as a last resort, `details` shrinks to a note. `code`, `hint`, `retryable`, the handle and
 * `revision` always stay.
 */
export function capRefusal(envelope: Record<string, unknown>, limit: number = RESULT_BYTE_LIMIT): Record<string, unknown> {
  let result = envelope;
  const details = envelope.details;
  if (isPlainObject(details) && Array.isArray(details.problems) && details.problems.length > PROBLEM_CAP) {
    const problems = details.problems.slice(0, PROBLEM_CAP).map((problem) => {
      if (!isPlainObject(problem)) {
        return problem;
      }
      return {
        ...problem,
        ...(typeof problem.key === "string" ? { key: cutString(problem.key, WARNING_CHARS) } : {}),
        ...(typeof problem.expected === "string" ? { expected: cutString(problem.expected, WARNING_CHARS) } : {})
      };
    });
    result = {
      ...result,
      details: { ...details, problems, truncated: true, totalProblems: details.problems.length }
    };
  }
  if (jsonByteLength(result) <= limit) {
    return result;
  }
  result = { ...(cutStrings(result, { count: 0 }) as Record<string, unknown>), truncated: true };
  if (jsonByteLength(result) <= limit) {
    return result;
  }
  const { details: _details, ...rest } = result;
  return { ...rest, details: { truncated: true, what: "details", limit } };
}
