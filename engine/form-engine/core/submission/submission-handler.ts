import type { CanonicalSubmission } from "./canonical-submission.js";
import type { SignedSubmissionDocument } from "./signing.js";

export interface SubmissionHandlerContext {
  modeId: string;
  formId: string;
  /**
   * The attempt's key: a version 4 UUID minted when the submit began, the same one
   * the accepted result carries. A handler that delivers to a receiving service sends it beside
   * the document, and sends it again unchanged when it retries, so the service keeps one record
   * per attempt.
   */
  submissionKey: string;
  /** Under the `"wrapper"` signing placement: the document to deliver, the envelope untouched inside it. */
  signed?: SignedSubmissionDocument;
}

/**
 * A post-acceptance side effect over the canonical submission (delivery, receipt storage,
 * webhook, …). Contributed by plugins. May throw / reject to signal a delivery failure;
 * the runtime surfaces that without un-accepting the submission.
 */
export interface SubmissionHandlerDefinition {
  id: string;
  version: string;
  handle(submission: CanonicalSubmission, context: SubmissionHandlerContext): void | Promise<void>;
}
