import type { CustomPredicate } from "../../../predicates.js";

/**
 * Code-defined predicates of the builder profile, registered in `src/customs.ts` so the report
 * and `explain` can print them.
 */
export const BUILDER_CUSTOMS: Record<string, CustomPredicate> = {
  /**
   * BLD-04: after every save the host refused (and every request that was not a save at all), the
   * stored definition and its hash are the ones from before. The builder runner reads the form
   * back around each refused save and hands the comparisons over as an answer
   * `{ checked, violations: string[] }`.
   */
  "atomic-save": {
    describe: () => "after every refused or failed save the stored definition and hash equal the ones before it",
    check: (observation) => {
      if (observation.kind !== "answer" || observation.json === null || typeof observation.json !== "object" || Array.isArray(observation.json)) {
        return { pass: false, reason: `wanted an answer, got ${observation.kind}` };
      }
      const { checked, violations } = observation.json as { checked?: unknown; violations?: unknown };
      if (!Array.isArray(violations) || typeof checked !== "number") {
        return { pass: false, reason: "the run kept no read-back comparisons" };
      }
      if (violations.length > 0) {
        return { pass: false, reason: `${violations.length} refused save(s) changed the stored form: ${violations.slice(0, 3).join("; ")}` };
      }
      return checked > 0 ? { pass: true, reason: `${checked} refused saves left the form as it was` } : { pass: true, warn: true, reason: "no save was refused, so atomicity was not exercised" };
    }
  },
  /** The save did not break the host: an accepted save or a refusal, never a 5xx, a non-JSON body or a 503. */
  "builder-never-5xx": {
    describe: () => "the host answers with an accepted save or a typed refusal (never a 5xx, a 503 or a body that is not JSON)",
    check: (observation) => {
      if (observation.kind === "answer") {
        return { pass: true, reason: "accepted" };
      }
      if (observation.kind === "refusal" && !["server_error", "malformed_response", "unavailable", "budget"].includes(observation.refusal)) {
        return { pass: true, reason: observation.refusal };
      }
      return { pass: false, reason: observation.kind === "refusal" ? `${observation.refusal}: ${observation.detail.slice(0, 200)}` : `got ${observation.kind}` };
    }
  },
  /** A request the host refuses as the client's mistake: any 4xx the web stack or the host chooses. */
  "builder-client-error": {
    describe: () => "refused with a 4xx (the web server or the host), never accepted and never a 5xx",
    check: (observation) => {
      if (observation.kind === "refusal" && observation.http !== undefined && observation.http >= 400 && observation.http < 500) {
        return { pass: true, reason: `HTTP ${observation.http}` };
      }
      return { pass: false, reason: observation.kind === "refusal" ? `${observation.refusal}${observation.http !== undefined ? ` (HTTP ${observation.http})` : ""}: ${observation.detail.slice(0, 160)}` : `got ${observation.kind}: the request was accepted` };
    }
  },
  /**
   * BLD-05: a body over the operator's definition limit is refused 413. A host with no cap, or
   * another one, answers something else that is typed: a WARN (the operator sets the limit); a
   * failure is a server error.
   */
  "definition-limit": {
    describe: () => "a body over the definition limit is refused 413 (an accepted save or another typed refusal: WARN, the limit differs or there is none)",
    check: (observation) => {
      if (observation.kind === "refusal" && observation.refusal === "too_large") {
        return { pass: true, reason: "413" };
      }
      if (observation.kind === "answer" || (observation.kind === "refusal" && !["server_error", "malformed_response", "unavailable", "budget"].includes(observation.refusal))) {
        return { pass: true, warn: true, reason: `the body was not refused as too large (${observation.kind === "answer" ? "accepted" : observation.refusal}): this host's limit differs from --definition-limit, or there is none` };
      }
      return { pass: false, reason: observation.kind === "refusal" ? `${observation.refusal}: ${observation.detail.slice(0, 160)}` : `got ${observation.kind}` };
    }
  }
};
