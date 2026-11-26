import type { CanonicalSubmission, SignedSubmissionDocument } from "@argusvane/datum-engine";

/**
 * A submission as text someone hands over — a renderer download, a server's copy, a file
 * from an email — read carefully into one of the shapes the engine knows: the canonical
 * envelope, the signed wrapper around it, or bare answers with no envelope at all.
 * Every refusal says what is wrong in words a person can act on; nothing is guessed.
 */
export type ParsedSubmissionDocument =
  | { kind: "wrapper"; document: SignedSubmissionDocument }
  | { kind: "envelope"; document: CanonicalSubmission }
  | { kind: "bare"; values: Record<string, unknown>; locale?: string };

export function parseSubmissionDocument(text: string): ParsedSubmissionDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`the file is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isRecord(parsed)) {
    throw new Error("the file must hold a submission object");
  }
  if (parsed.payload !== undefined) {
    if (!isRecord(parsed.payload)) {
      throw new Error("payload must be the envelope the signatures cover");
    }
    if (!Array.isArray(parsed.signatures)) {
      throw new Error("a signed document must list its signatures");
    }
    if (!isRecord(parsed.format)) {
      throw new Error("a signed document must say its signing format");
    }
    const document = { format: parsed.format, payload: checkEnvelope(parsed.payload, "payload"), signatures: parsed.signatures } as unknown as SignedSubmissionDocument;
    return { kind: "wrapper", document };
  }
  if (parsed.submission !== undefined || parsed.versionContext !== undefined) {
    return { kind: "envelope", document: checkEnvelope(parsed, "the file") };
  }
  if (!isRecord(parsed.values)) {
    throw new Error("the file must hold a values object keyed by component path");
  }
  if (parsed.locale !== undefined && typeof parsed.locale !== "string") {
    throw new Error("locale must be a locale code");
  }
  return { kind: "bare", values: parsed.values, ...(typeof parsed.locale === "string" ? { locale: parsed.locale } : {}) };
}

function checkEnvelope(value: Record<string, unknown>, where: string): CanonicalSubmission {
  if (!isRecord(value.submission) || !isRecord(value.submission.values)) {
    throw new Error(`${where} must hold submission.values keyed by component path`);
  }
  if (typeof value.submission.locale !== "string") {
    throw new Error(`${where} must say submission.locale`);
  }
  if (!isRecord(value.versionContext) || !isRecord(value.versionContext.form) || typeof value.versionContext.form.id !== "string" || typeof value.versionContext.form.version !== "string") {
    throw new Error(`${where} must name the form in versionContext.form.id and .version`);
  }
  if (!isRecord(value.versionContext.client)) {
    throw new Error(`${where} must carry versionContext.client`);
  }
  if (value.signatures !== undefined && !Array.isArray(value.signatures)) {
    throw new Error(`${where}.signatures must be a list`);
  }
  return value as unknown as CanonicalSubmission;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
