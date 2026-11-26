import type { CustomPredicate } from "../../predicates.js";

/**
 * Code-defined predicates for the endpoint rows, registered in `src/customs.ts` so the report and
 * `explain` can print them.
 */
export const ENDPOINT_CUSTOMS: Record<string, CustomPredicate> = {
  /** Whatever the server answered, it did not break: a verdict or a typed 4xx refusal. */
  "no-server-failure": {
    describe: () => "the server answers with a verdict or a typed refusal (never a 5xx, a non-JSON body or a 503)",
    check: (observation) => {
      if (observation.kind === "verdict") {
        return { pass: true, reason: "a verdict" };
      }
      if (observation.kind === "refusal" && observation.refusal !== "server_error" && observation.refusal !== "malformed_response" && observation.refusal !== "unavailable" && observation.refusal !== "budget") {
        return { pass: true, reason: observation.refusal };
      }
      return { pass: false, reason: observation.kind === "refusal" ? `${observation.refusal}: ${observation.detail}` : `got ${observation.kind}` };
    }
  },
  /**
   * The body-limit vectors: the limit the suite was told (`--body-limit`) must produce a 413. A
   * server that judges the body anyway has another limit or none: a WARN, not a FAIL (the operator
   * sets it), unless it answers with a failure or never answers: a host that stops reading an
   * over-limit body and hangs until the suite's timeout (refusal `budget`) is a FAIL.
   */
  "body-limit": {
    describe: () => "a body over --body-limit is refused 413 bad_document (any other typed answer: WARN, the limit differs; no answer: FAIL)",
    check: (observation) => {
      if (observation.kind === "refusal" && observation.refusal === "too_large") {
        return { pass: true, reason: "413" };
      }
      if (observation.kind === "verdict" || (observation.kind === "refusal" && observation.refusal !== "server_error" && observation.refusal !== "malformed_response" && observation.refusal !== "unavailable" && observation.refusal !== "budget")) {
        return { pass: true, warn: true, reason: `the body was not refused as too large (${observation.kind === "verdict" ? "judged" : observation.refusal}): this server's limit differs from --body-limit, or there is none` };
      }
      return { pass: false, reason: observation.kind === "refusal" ? `${observation.refusal}: ${observation.detail}` : `got ${observation.kind}` };
    }
  }
};
