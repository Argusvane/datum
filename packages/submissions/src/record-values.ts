import { submissionEnvelopeOf } from "@argusvane/datum-engine";

import type { SubmissionRecord } from "./types.js";

/**
 * The answers a record stands for: the values its verdict judged — the kernel's
 * submittable values, hidden answers the fold withheld left out and calculations as the server
 * worked them out — else, for a record refused before anything was judged (`journey.unknown`),
 * the delivered document's values. What the server's PDF, the exports and the statistics read. The delivered
 * document itself stays as it came, since its digest and signatures cover it.
 */
export function recordValuesOf(record: SubmissionRecord): Record<string, unknown> {
  return record.values ?? submissionEnvelopeOf(record.document).submission.values;
}
