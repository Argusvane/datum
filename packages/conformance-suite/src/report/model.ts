import type { Observation } from "../observation.js";
import type { Gate, Severity, Attacker, VectorClass } from "../vectors/schema.js";

export type ResultStatus = "PASS" | "FAIL" | "WARN" | "SKIP" | "XFAIL" | "XPASS" | "ERROR";
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";
export type RunnerName = "program" | "endpoint" | "parity" | "builder" | "pdf";

/**
 * The HTTP exchanges behind an endpoint result, summed over its requests: each timed from the
 * open TCP connection (on https the TLS handshake is inside) to the first and to the last byte of
 * the answer. The suite's pacing pause and anything queued in the client are left out; a row's time
 * bound (`limitMs`) is judged on `totalMs`. A request that timed out counts its whole wait in both
 * times. `connectMs` is the DNS and TCP connect before the exchanges (0 where unknown), outside the
 * bound. `requests` counts the requests that went out.
 */
export interface ExchangeTimes {
  requests: number;
  connectMs: number;
  firstByteMs: number;
  totalMs: number;
}

export interface VariantResult {
  id: string;
  status: ResultStatus;
  expected: string;
  observed: Observation | null;
  /** Endpoint rows: the row's HTTP exchanges. */
  exchange?: ExchangeTimes;
  notes?: string;
}

export interface VectorResult {
  id: string;
  title: string;
  class: VectorClass;
  severity: Severity;
  attacker: Attacker;
  runner: RunnerName;
  status: ResultStatus;
  gate: Gate["status"];
  blockedBy: string | null;
  expected: string;
  observed: Observation | null;
  /** Wall time of the whole result; on the endpoint runner it includes the pacing pause between requests. */
  durationMs: number;
  limitMs: number | null;
  /** Endpoint results: the HTTP exchanges themselves, summed over the rows that ran. */
  exchange?: ExchangeTimes;
  variants?: VariantResult[];
  evidence?: { requestSha256?: string; requestBytes?: number; responseExcerpt?: string };
  notes?: string;
  /** True when the vector says nothing about a wasmtime host (ISO-02). */
  hostSensitive?: boolean;
}

export interface ProgramReport {
  source: "file" | "built";
  path: string;
  bytes: number;
  sha256: string;
  bannerAbi: string | null;
  detectedAbi: string | null;
  abiFloor: string;
  abiOk: boolean;
  manifestAbi: string | null;
  budgetProfile: "node" | "browser";
  /** The golden file the run was judged against, or why none applied. */
  golden: { file: string; abi: string; note?: string } | null;
  startupError: string | null;
}

export interface EndpointReport {
  baseUrl: string;
  profile: string;
  formId: string;
  formVersion: string;
  authHeaderName: string | null;
  fixtureVersion: string | null;
  preflight: { ok: boolean; evidence: string[] };
  writes: boolean;
  requestsSent: number;
  rateLimited: boolean;
  recordsCreated: number;
}

/** The builder profile's section: what the run created, sent and cleaned up. */
export interface BuilderReport {
  baseUrl: string;
  host: "submissions";
  /** The suite-owned form (`secsuite_<8 hex>`), or the adopted one. */
  formId: string;
  mode: "create" | "adopt";
  authHeaderName: string | null;
  requestsSent: number;
  /** POSTs of a definition to the save/register route. */
  saves: number;
  /** Request counts per `METHOD /path-template` (the allowlist guard's evidence). */
  requestsByTemplate: Record<string, number>;
  cleanup: { complete: boolean; formId?: string; remedy?: string; detail?: string };
  recordsCreated: number;
  notes?: string[];
}

export interface ParityReport {
  adapters: string[];
  corpus: { core: number; adversarial: number; suite: number };
  divergences: { vector: string; reason: string; stale: boolean }[];
}

/** The PDF output runner's section: which program was inspected and whether the OUT class could run. */
export interface PdfReport {
  path: string;
  bytes: number;
  sha256: string;
  abi: string | null;
  /** Set when the OUT class is pending: the program is not of PDF ABI 1 at the floor or later. */
  pending: string | null;
  /** What the inspection used: fonts, pdf.js, pdf-lib, veraPDF, openssl. */
  tools: { fonts: string; pdfjs: boolean; pdfLib: boolean; verapdf: boolean; openssl: boolean };
}

export interface Summary {
  pass: number;
  fail: number;
  warn: number;
  skip: number;
  xfail: number;
  xpass: number;
  error: number;
}

export interface Report {
  schemaVersion: 1;
  suite: { name: string; version: string; vectorSet: string; vectorCount: number };
  run: { id: string; startedAt: string; finishedAt: string; durationMs: number; modes: RunnerName[]; gate: "release" | "full"; argv: string[] };
  environment: {
    node: string;
    platform: string;
    arch: string;
    ci: boolean;
    engine: { abi: string; commit: string | null };
    quickjs: { package: string; variant: string };
  };
  program?: ProgramReport;
  endpoint?: EndpointReport;
  builder?: BuilderReport;
  parity?: ParityReport;
  pdf?: PdfReport;
  summary: Summary;
  verdict: Verdict;
  /** Why the verdict is not PASS, one line each (empty on PASS). */
  reasons: string[];
  results: VectorResult[];
}

export function summarize(results: readonly { status: ResultStatus }[]): Summary {
  const summary: Summary = { pass: 0, fail: 0, warn: 0, skip: 0, xfail: 0, xpass: 0, error: 0 };
  for (const result of results) {
    summary[result.status.toLowerCase() as keyof Summary] += 1;
  }
  return summary;
}

export interface VerdictOptions {
  failOn: "fail" | "warn";
  /** The endpoint preflight failed or the run was rate limited out. */
  inconclusive?: string[];
}

/**
 * The verdict rule: FAIL if any enforced result is FAIL; INCONCLUSIVE if the
 * preflight failed, the run was rate limited out, or an enforced vector is ERROR; otherwise
 * PASS. WARN, XFAIL and XPASS never fail unless `--fail-on warn` (then WARN and XPASS do).
 * FAIL outranks INCONCLUSIVE: a known failure is never reported as "could not tell".
 */
export function decideVerdict(results: readonly VectorResult[], options: VerdictOptions): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  for (const result of results) {
    if (result.status === "FAIL" && result.gate === "enforced") {
      reasons.push(`${result.id} FAILED`);
    } else if (options.failOn === "warn" && (result.status === "WARN" || result.status === "XPASS")) {
      reasons.push(`${result.id} ${result.status} (--fail-on warn)`);
    }
  }
  if (reasons.length > 0) {
    return { verdict: "FAIL", reasons };
  }
  const inconclusive = [...(options.inconclusive ?? [])];
  for (const result of results) {
    if (result.status === "ERROR" && result.gate === "enforced") {
      inconclusive.push(`${result.id} could not run`);
    }
  }
  return inconclusive.length > 0 ? { verdict: "INCONCLUSIVE", reasons: inconclusive } : { verdict: "PASS", reasons: [] };
}
