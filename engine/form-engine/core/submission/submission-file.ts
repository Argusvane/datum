import { canonicalizeSubmission, type CanonicalSubmission } from "./canonical-submission.js";
import type { SignedSubmissionDocument } from "./signing.js";

/**
 * The canonical submission as a file a person keeps.
 *
 * A form with no server behind it still has to put its answers somewhere: a `button` with
 * `action: "download"` submits, and hands the accepted envelope to the browser as a file
 * (see `downloadSubmission` in the render layer). What is in that file is decided here, DOM
 * free, so a host or a test can produce the same bytes without a browser.
 *
 * The content is the {@link CanonicalSubmission} itself — no wrapper, no digest — so a file
 * opened by the form owner reads as the envelope every other delivery route carries, and a
 * host that already accepts `datum-submit` payloads accepts the file unchanged.
 */

export const SUBMISSION_FILE_MIME_TYPE = "application/json";

export const SUBMISSION_FILE_EXTENSION = ".json";

/**
 * The file's text: the envelope in canonical key order, pretty-printed. Stable ordering
 * keeps two downloads of the same answers byte-identical (diffable, hashable); the indent is
 * for the person who opens it, since unlike the wire form this one is meant to be read.
 */
export function serializeSubmissionFile(submission: SubmissionFileDocument): string {
  return JSON.stringify(canonicalizeSubmission(submission as CanonicalSubmission), null, 2);
}

/** What a submission file holds: the envelope, or — under the wrapper signing placement — the signed document around it. */
export type SubmissionFileDocument = CanonicalSubmission | SignedSubmissionDocument;

/** The envelope inside a submission file document, whichever placement it came in. */
export function submissionEnvelopeOf(document: SubmissionFileDocument): CanonicalSubmission {
  return "payload" in document ? document.payload : document;
}

/**
 * `<form id>-submission-<YYYYMMDD-HHMMSS>.json` — the form the answers belong to, then when
 * they were saved, so a folder of them sorts by form and then by time. The form id is
 * reduced to `[A-Za-z0-9_-]` (anything else becomes `-`), since an id is free text and a
 * file name is not; an id with nothing left is called `form`. The stamp is local time, which
 * is the clock the person saving the file is looking at.
 */
export function submissionFileName(submission: SubmissionFileDocument, at: Date = new Date()): string {
  const formId = submissionEnvelopeOf(submission).versionContext.form.id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${formId || "form"}-submission-${timestampSlug(at)}${SUBMISSION_FILE_EXTENSION}`;
}

function timestampSlug(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${date}-${time}`;
}
