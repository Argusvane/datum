import { randomUUID } from "node:crypto";

import { redactArgv } from "../../report/json.js";
import { decideVerdict, summarize, type Report, type RunnerName } from "../../report/model.js";
import { environment } from "../../run.js";
import { SUITE_NAME, SUITE_VERSION, VECTOR_SET_ID } from "../../version.js";
import { VECTORS } from "../../vectors/index.js";
import type { PdfRunOutput } from "./pdf-runner.js";

export interface PdfReportContext {
  failOn: "fail" | "warn";
  gate: "release" | "full";
  argv: readonly string[];
  startedAt: Date;
  startedMs: number;
  vectorCount?: number;
}

/** The report of a PDF run: on its own, or merged into another runner's report (the verdict is recomputed over all results). */
export function withPdf(base: Report | undefined, run: PdfRunOutput, context: PdfReportContext): Report {
  const results = [...(base?.results ?? []), ...run.results];
  const inconclusive = [
    ...(base?.program?.startupError !== undefined && base.program.startupError !== null ? [`the program did not start: ${base.program.startupError}`] : []),
    ...(run.results.some((result) => result.status === "ERROR") ? ["the PDF program did not start"] : [])
  ];
  const decision = decideVerdict(results, { failOn: context.failOn, inconclusive });
  const modes: RunnerName[] = [...(base?.run.modes ?? []), "pdf"];
  return {
    schemaVersion: 1,
    suite: base?.suite ?? { name: SUITE_NAME, version: SUITE_VERSION, vectorSet: VECTOR_SET_ID, vectorCount: context.vectorCount ?? VECTORS.length },
    run: {
      id: base?.run.id ?? randomUUID(),
      startedAt: base?.run.startedAt ?? context.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - context.startedMs),
      modes,
      gate: context.gate,
      argv: base?.run.argv ?? redactArgv(context.argv)
    },
    environment: base?.environment ?? environment(),
    ...(base?.program !== undefined ? { program: base.program } : {}),
    ...(base?.endpoint !== undefined ? { endpoint: base.endpoint } : {}),
    ...(base?.builder !== undefined ? { builder: base.builder } : {}),
    ...(base?.parity !== undefined ? { parity: base.parity } : {}),
    pdf: run.report,
    summary: summarize(results),
    verdict: decision.verdict,
    reasons: decision.reasons,
    results
  };
}
