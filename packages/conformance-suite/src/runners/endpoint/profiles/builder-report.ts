import { randomUUID } from "node:crypto";

import { redactArgv } from "../../../report/json.js";
import { decideVerdict, summarize, type Report, type RunnerName } from "../../../report/model.js";
import { environment } from "../../../run.js";
import { SUITE_NAME, SUITE_VERSION, VECTOR_SET_ID } from "../../../version.js";
import { VECTORS } from "../../../vectors/index.js";
import type { BuilderRun } from "./builder-lifecycle.js";

export interface BuilderReportContext {
  failOn: "fail" | "warn";
  gate: "release" | "full";
  argv: readonly string[];
  startedAt: Date;
  startedMs: number;
  vectorCount?: number;
}

/**
 * The report of a builder run: on its own, or merged into a program / endpoint report so one file
 * carries every runner. The verdict is recomputed over all the results; a form that could not be
 * made, a budget that ran out and a cleanup that is incomplete make it INCONCLUSIVE (a FAIL still
 * outranks that).
 */
export function withBuilder(base: Report | undefined, run: BuilderRun, context: BuilderReportContext): Report {
  const results = [...(base?.results ?? []), ...run.results];
  const inconclusive = [
    ...(base?.program?.startupError !== undefined && base.program.startupError !== null ? [`the program did not start: ${base.program.startupError}`] : []),
    ...run.inconclusive
  ];
  const decision = decideVerdict(results, { failOn: context.failOn, inconclusive });
  const finishedAt = new Date();
  const modes: RunnerName[] = [...(base?.run.modes ?? []), "builder"];
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
    ...(base?.endpoint !== undefined ? { endpoint: base.endpoint } : {}),
    builder: run.builder,
    ...(base?.parity !== undefined ? { parity: base.parity } : {}),
    summary: summarize(results),
    verdict: decision.verdict,
    reasons: decision.reasons,
    results
  };
}
