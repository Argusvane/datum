import { randomUUID } from "node:crypto";

import { redactArgv } from "../../report/json.js";
import { decideVerdict, summarize, type Report, type RunnerName } from "../../report/model.js";
import { environment } from "../../run.js";
import { SUITE_NAME, SUITE_VERSION, VECTOR_SET_ID } from "../../version.js";
import { VECTORS } from "../../vectors/index.js";
import type { EndpointRun } from "./endpoint-runner.js";

export interface EndpointReportContext {
  failOn: "fail" | "warn";
  gate: "release" | "full";
  argv: readonly string[];
  startedAt: Date;
  startedMs: number;
  /** The catalogue the run used (the vector count in the report). */
  vectorCount?: number;
}

/**
 * The report of an endpoint run: on its own, or merged into a program (and parity) report so one
 * file carries every runner. The verdict is recomputed over all the results; a preflight that
 * failed, a run that was rate limited out and writes that were refused make it INCONCLUSIVE
 * (and a FAIL still outranks that).
 */
export function withEndpoint(base: Report | undefined, run: EndpointRun, context: EndpointReportContext): Report {
  const results = [...(base?.results ?? []), ...run.results];
  const inconclusive = [
    ...(base?.program?.startupError !== undefined && base.program.startupError !== null ? [`the program did not start: ${base.program.startupError}`] : []),
    ...run.inconclusive
  ];
  const decision = decideVerdict(results, { failOn: context.failOn, inconclusive });
  const finishedAt = new Date();
  const modes: RunnerName[] = [...(base?.run.modes ?? []), "endpoint"];
  return {
    schemaVersion: 1,
    suite: base?.suite ?? { name: SUITE_NAME, version: SUITE_VERSION, vectorSet: VECTOR_SET_ID, vectorCount: context.vectorCount ?? VECTORS.length },
    run: {
      id: base?.run.id ?? randomUUID(),
      startedAt: base?.run.startedAt ?? context.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.round(performance.now() - context.startedMs),
      modes,
      gate: context.gate,
      argv: base?.run.argv ?? redactArgv(context.argv)
    },
    environment: base?.environment ?? environment(),
    ...(base?.program !== undefined ? { program: base.program } : {}),
    endpoint: run.endpoint,
    ...(base?.parity !== undefined ? { parity: base.parity } : {}),
    summary: summarize(results),
    verdict: decision.verdict,
    reasons: decision.reasons,
    results
  };
}
