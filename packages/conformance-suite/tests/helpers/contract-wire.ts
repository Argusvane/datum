import { parseValidateRequest, type ValidateInput } from "@argusvane/datum-submissions";

/**
 * What the reference servers still do for themselves before the `@argusvane/datum-submissions` service sees a check. The
 * contract's own words (a strict `{document, scope, pageId?}` request, the `{accepted, errors, notes?}` verdict, a run
 * that gave no verdict as a 503 with the run's code) are the package's now: `parseValidateRequest`, `validationBody`,
 * `statusOf` and `errorResponse`. What is left is the harness's: the size cap goes first.
 */

/** The service's own body cap (`maxBodyBytes`, 1 MiB): past it the size answers (413) before the request's shape is read. */
const SIZE_CAP_BYTES = 1_048_576;

/**
 * A check's request, read strictly once the size has passed. A host's HTTP layer refuses an over-long body 413 before
 * it reads the shape; the service's own cap does the same for a server with no host in front, so a body past the cap
 * is handed to the service as it is, to be refused 413 there rather than 400 here.
 */
export function checkRequestOf(body: unknown, bytes: number): ValidateInput {
  return bytes > SIZE_CAP_BYTES ? (body as ValidateInput) : parseValidateRequest(body);
}
