export interface SubmissionVersionContext {
  form: {
    id: string;
    version: string;
  };
  client: {
    runtimeVersion: string;
    rendererVersion: string;
    schemaVersion: string;
    components?: Record<string, string>;
    plugins?: Record<string, string>;
  };
  server?: {
    runtimeVersion?: string;
    validatorVersion?: string;
    components?: Record<string, string>;
    plugins?: Record<string, string>;
  };
}

import { canonicalizeJcs } from "./jcs.js";
import {
  readSigningFormat,
  signingStatementOf,
  type SignatureResult,
  type SignedSubmissionDocument,
  type SubmissionSigningFormat,
  type SubmissionSigningScope
} from "./signing.js";

export interface CanonicalSubmission {
  versionContext: SubmissionVersionContext;
  submission: {
    locale: string;
    values: Record<string, unknown>;
    /**
     * The journey the answers were given through — its id only: a server works the
     * path out again from the values and never takes one from the client. Absent when the form
     * was filled on one page.
     */
    journey?: { id: string };
  };
  /** Present when the submission mode requested signing (`sign === true`). */
  signatures?: SignatureResult[];
}

function stableObject(input: unknown): unknown {
  if (Array.isArray(input)) {
    // Preserve array order; only object keys are canonicalized.
    return input.map(stableObject);
  }

  if (input && typeof input === "object") {
    // Keys sort by UTF-16 code unit, so insertion order never changes the bytes. The order is
    // the sandbox kernel's (`kernelSortKeys`): the browser, the sandbox program, the PHP port
    // and the Data tab must all digest the same bytes, and ICU collation (`localeCompare`)
    // orders upper and lower case, punctuation and astral-plane keys differently from it.
    const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );

    return Object.fromEntries(entries.map(([key, value]) => [key, stableObject(value)]));
  }

  return input;
}

export function canonicalizeSubmission(
  submission: CanonicalSubmission
): CanonicalSubmission {
  return stableObject(submission) as CanonicalSubmission;
}

export function serializeCanonicalSubmission(submission: CanonicalSubmission): string {
  const canonical = canonicalizeSubmission(submission);
  return JSON.stringify(canonical);
}

/**
 * The text a signature covers: the envelope without its `signatures`, its
 * `submission` block, or its `values` — the same for the signer at submit and for a verifier
 * holding the delivered document, whichever placement it came in. `signatures` never enters
 * the signed string, so the delivered envelope's key order (the runtime appends `signatures`
 * last) does not matter.
 *
 * Written in RFC 8785 (`"jcs"`). With a signing statement (a non-empty string), the text is the
 * canonical `{ "document": <the scoped part>, "statement": <the statement> }` — the words the
 * signer agreed to are signed with the answers.
 */
export function signedCanonicalOf(
  document: CanonicalSubmission | SignedSubmissionDocument,
  scope: SubmissionSigningScope = "envelope",
  statement?: string
): string {
  const envelope = "payload" in document ? document.payload : document;
  const { signatures: _signatures, ...unsigned } = envelope;
  const part = scope === "values" ? unsigned.submission.values : scope === "submission" ? unsigned.submission : unsigned;
  const words = signingStatementOf(statement);
  return canonicalizeJcs(words === undefined ? part : { document: part, statement: words });
}

/**
 * The format a delivered signature was made under: its own, else the wrapper document's, read
 * with {@link readSigningFormat}. Nothing when neither is a format this engine signs under: such
 * a signature is invalid, since no verifier can rebuild what it covers.
 */
export function signatureFormatOf(document: CanonicalSubmission | SignedSubmissionDocument, signature: Pick<SignatureResult, "format"> | undefined): SubmissionSigningFormat | undefined {
  return readSigningFormat(signature?.format ?? ("payload" in document ? document.format : undefined));
}

/**
 * The exact text one delivered signature covers: its own format's scope, and its own
 * statement. Nothing when its format is unreadable ({@link signatureFormatOf}).
 */
export function signedCanonicalForSignature(document: CanonicalSubmission | SignedSubmissionDocument, signature: Pick<SignatureResult, "format" | "statement">): string | undefined {
  const format = signatureFormatOf(document, signature);
  return format === undefined ? undefined : signedCanonicalOf(document, format.scope, signature.statement);
}
