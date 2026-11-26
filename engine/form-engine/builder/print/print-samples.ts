/**
 * The Print workspace's sample answers and sample receipt: what the preview is
 * drawn with for this session only. Nothing here is written into the definition or the history.
 *
 * A pasted submission is read in any of the shapes the form's own pipeline hands around: the
 * answers alone (`{ "fullName": "Ada" }`), the canonical envelope the browser submits
 * (`{ versionContext, submission: { values } }`), the signed wrapper around it
 * (`{ format, payload: { submission: { values } }, signatures }`), and the submissions service's
 * record (`record.json`: `{ values, document }`, its `values` the answers the server judged, else
 * the document's). Reading never throws: anything else is an error code for one line of words.
 */

/** Where the preview's answers come from. */
export type PrintSampleSource =
  | { kind: "none" }
  | { kind: "try" }
  | { kind: "scenario"; id: string }
  | { kind: "pasted" };

/** A sample source as the picker's option value: `none`, `try`, `pasted`, `scenario:<id>`. */
export function sampleSourceValue(source: PrintSampleSource): string {
  return source.kind === "scenario" ? `scenario:${source.id}` : source.kind;
}

/** The picker's option value read back; an unknown value is no sample. */
export function readSampleSourceValue(value: string): PrintSampleSource {
  if (value === "try" || value === "pasted" || value === "none") {
    return { kind: value };
  }
  if (value.startsWith("scenario:") && value.length > "scenario:".length) {
    return { kind: "scenario", id: value.slice("scenario:".length) };
  }
  return { kind: "none" };
}

/** What a pasted box holds: nothing yet, a value read from it, or why it could not be read. */
export type PastedReading<T> = { empty: true } | { value: T } | { error: "json" | "shape" };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The `submission.values` of an envelope, or of a signed wrapper's payload. */
function envelopeValues(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = isRecord(value.submission) && isRecord(value.submission.values) ? value.submission.values : undefined;
  if (direct) {
    return direct;
  }
  return isRecord(value.payload) ? envelopeValues(value.payload) : undefined;
}

/**
 * The answers in a pasted submission: a record's judged `values`, else its document's; an
 * envelope's or a signed wrapper's `submission.values`; else the object itself as the answers.
 */
export function submissionValuesOf(parsed: unknown): Record<string, unknown> | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }
  // A record (record.json): the answers the server judged, else the delivered document's.
  if ("document" in parsed && ("values" in parsed || "digest" in parsed || "receivedAt" in parsed)) {
    if (isRecord(parsed.values)) {
      return parsed.values;
    }
    return envelopeValues(parsed.document);
  }
  return envelopeValues(parsed) ?? parsed;
}

function parse(text: string): { value: unknown } | { error: "json" } {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { error: "json" };
  }
}

/** The answers in a pasted submission's text. */
export function readPastedAnswers(text: string): PastedReading<Record<string, unknown>> {
  if (typeof text !== "string" || text.trim() === "") {
    return { empty: true };
  }
  const parsed = parse(text);
  if ("error" in parsed) {
    return parsed;
  }
  const values = submissionValuesOf(parsed.value);
  return values === undefined ? { error: "shape" } : { value: plainCopy(values) };
}

/** The sample receipt's data (`FormNotice.data`, read as `{{receipt.<path>}}`): a JSON object. */
export function readReceiptData(text: string): PastedReading<Record<string, unknown>> {
  if (typeof text !== "string" || text.trim() === "") {
    return { empty: true };
  }
  const parsed = parse(text);
  if ("error" in parsed) {
    return parsed;
  }
  return isRecord(parsed.value) ? { value: plainCopy(parsed.value) } : { error: "shape" };
}

/** A copy that shares nothing with what was parsed, and carries no prototype key as an answer. */
function plainCopy(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    out[key] = entry;
  }
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}
