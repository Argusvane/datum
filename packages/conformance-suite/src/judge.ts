import { describe, evaluate, type CustomPredicate, type Expectation, type PredicateEnv } from "./predicates.js";
import type { Observation } from "./observation.js";
import type { ResultStatus } from "./report/model.js";
import type { Gate } from "./vectors/schema.js";

export interface Judgement {
  pass: boolean;
  warn: boolean;
  reason: string;
}

/** One expectation against one observation, plus the wall-clock bound (a hang is a FAIL). */
export function judge(expect: Expectation, observation: Observation, env: PredicateEnv, limitMs: number | null): Judgement {
  const result = evaluate(expect, observation, env);
  if (!result.pass) {
    return { pass: false, warn: false, reason: result.reason };
  }
  if (limitMs !== null && env.elapsedMs !== undefined && env.elapsedMs > limitMs) {
    return { pass: false, warn: false, reason: `took ${Math.round(env.elapsedMs)} ms, over the ${limitMs} ms bound` };
  }
  return { pass: true, warn: result.warn === true, reason: result.reason };
}

/** The gate semantics: enforced FAILs fail; advisory FAILs warn; pending FAILs are XFAIL and passes XPASS. */
export function statusFor(judgement: Pick<Judgement, "pass" | "warn">, gate: Gate): ResultStatus {
  switch (gate.status) {
    case "enforced":
      return judgement.pass ? (judgement.warn ? "WARN" : "PASS") : "FAIL";
    case "advisory":
      return judgement.pass ? (judgement.warn ? "WARN" : "PASS") : "WARN";
    case "pending":
      return judgement.pass ? "XPASS" : "XFAIL";
  }
}

export function expectedText(expect: Expectation, customs: Record<string, CustomPredicate>): string {
  return describe(expect, customs);
}
