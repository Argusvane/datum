import { CAPABILITY_ORDER, type Capability } from "./capabilities.js";
import { contextFor, type CapabilityModule, type HostCase, type Probe, type ProbeContext, type ProbeOutcome } from "./case.js";
import { MODULES } from "./cases/index.js";
import { CaseFailure, CaseSkipped } from "./expect.js";
import { HostHttp, type Exchange, type RawRequest, type RawResponse } from "./http.js";
import { api, type HostTarget } from "./target.js";

/**
 * Runs the selected cases against a target: the preflight probes of the named capabilities first
 * (a host that is not there, a fixture form that is missing or a switch that is off makes the run
 * INCONCLUSIVE before any case is sent), then each capability as its own group in the fixed order,
 * each group's cases by their Java @Order. The exit rule is HostTck's, with the security suite's
 * codes around it: 0 every selected case passed and every named capability had a case pass; 1 a case
 * failed; 2 a named capability asserted nothing (all its cases skipped, or it has none yet);
 * 3 inconclusive (preflight); 4 is the command's own failure (cli.ts).
 */
export type CaseStatus = "PASS" | "FAIL" | "SKIP";
export type HostVerdict = "PASS" | "FAIL" | "UNEXERCISED" | "INCONCLUSIVE";

export interface CaseResult {
  id: string;
  title: string;
  capability: Capability;
  order: number;
  oracle: string;
  status: CaseStatus;
  expected: string;
  /** What was seen: the failure or skip message, or "as expected". */
  observed: string;
  durationMs: number;
  exchanges: Exchange[];
}

export interface ProbeResult {
  id: string;
  status: ProbeOutcome["status"];
  message: string;
}

export interface CapabilitySummary {
  capability: Capability;
  pass: number;
  fail: number;
  skip: number;
  /** At least one case passed. */
  exercised: boolean;
}

export interface RunOutcome {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  preflight: { ok: boolean; probes: ProbeResult[] };
  results: CaseResult[];
  capabilities: CapabilitySummary[];
  requestsSent: number;
  verdict: HostVerdict;
  reasons: string[];
  exitCode: 0 | 1 | 2 | 3;
}

/** A selection that cannot run as asked: a usage error (exit 2) before anything is sent. */
export class SelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionError";
  }
}

export interface Selection {
  capabilities: Capability[];
  /** By capability, in run order; each list by @Order. */
  cases: Map<Capability, HostCase[]>;
}

/**
 * The cases `--only` / `--skip` leave of the named capabilities. An id that does not exist, or that
 * belongs to a capability `--capabilities` does not name, is a usage error; so is a named capability
 * the filters leave with no case while it has some (it could only "assert nothing").
 */
export function selectCases(capabilities: readonly Capability[], only: readonly string[], skip: readonly string[], modules: readonly CapabilityModule[] = MODULES): Selection {
  if (capabilities.length === 0) throw new SelectionError("name the host's capabilities with --capabilities (e.g. submissions,forms,assets)");
  const all = modules.flatMap((module) => module.cases);
  const normalize = (ids: readonly string[]): string[] => ids.flatMap((id) => id.split(",")).map((id) => id.trim().toUpperCase()).filter((id) => id !== "");
  const onlyIds = normalize(only);
  const skipIds = normalize(skip);
  for (const id of [...onlyIds, ...skipIds]) {
    const found = all.find((entry) => entry.id === id);
    if (found === undefined) throw new SelectionError(`"${id}" is not a case id; "list" shows them`);
    if (!capabilities.includes(found.capability)) throw new SelectionError(`${id} belongs to ${found.capability}, which --capabilities does not name`);
  }
  const ordered = CAPABILITY_ORDER.filter((capability) => capabilities.includes(capability));
  const cases = new Map<Capability, HostCase[]>();
  for (const capability of ordered) {
    const module = modules.find((entry) => entry.capability === capability);
    const own = [...(module?.cases ?? [])].sort((a, b) => a.order - b.order);
    const chosen = own.filter((entry) => (onlyIds.length === 0 || onlyIds.includes(entry.id)) && !skipIds.includes(entry.id));
    if (own.length > 0 && chosen.length === 0) {
      throw new SelectionError(`--only/--skip leave ${capability} with no case: leave it out of --capabilities instead`);
    }
    cases.set(capability, chosen);
  }
  return { capabilities: ordered, cases };
}

export interface RunOptions {
  target: HostTarget;
  selection: Selection;
  modules?: readonly CapabilityModule[];
  /** Replaced in tests (the default speaks node:http). */
  transport?: (request: RawRequest) => Promise<RawResponse>;
  /** Called after each case (the CLI prints progress). */
  onResult?: (result: CaseResult) => void;
  /** Called after the preflight. */
  onPreflight?: (preflight: RunOutcome["preflight"]) => void;
}

export async function runHostCheck(options: RunOptions): Promise<RunOutcome> {
  const { target, selection } = options;
  const modules = options.modules ?? MODULES;
  const startedAt = new Date();
  const started = performance.now();
  let current: Exchange[] = [];
  const http = new HostHttp(target, { onExchange: (exchange) => current.push(exchange) }, options.transport);
  try {
    // 1. The preflight: each probe once, in the capabilities' order, until one finds the set-up missing.
    http.label = "preflight";
    const probes: Probe[] = [];
    const assumed = new Map<Capability, string>();
    for (const capability of selection.capabilities) {
      const module = modules.find((entry) => entry.capability === capability);
      const reason = module?.assumption?.(target);
      if (reason !== undefined) {
        assumed.set(capability, reason);
        continue;
      }
      for (const probe of module?.probes ?? []) {
        if (!probes.some((seen) => seen.id === probe.id)) probes.push(probe);
      }
    }
    const probeContext: ProbeContext = {
      target,
      api: (path) => api(target, path),
      probe: (method, url, sendOptions = {}) => http.probe(method, url, sendOptions),
      csrfToken: (who = "visitor") => http.csrfToken(who)
    };
    const probeResults: ProbeResult[] = [];
    for (const probe of probes) {
      const outcome = await probe.run(probeContext);
      probeResults.push({ id: probe.id, ...outcome });
      if (outcome.status === "missing") break;
    }
    const preflight = { ok: probeResults.every((probe) => probe.status !== "missing"), probes: probeResults };
    options.onPreflight?.(preflight);
    const results: CaseResult[] = [];
    if (preflight.ok) {
      // 2. The capabilities, one group each, in the fixed order.
      const context = contextFor(target, http);
      for (const capability of selection.capabilities) {
        for (const entry of selection.cases.get(capability) ?? []) {
          current = [];
          http.label = entry.id;
          const caseStarted = performance.now();
          let status: CaseStatus = "PASS";
          let observed = "as expected";
          try {
            const reason = assumed.get(capability);
            if (reason !== undefined) throw new CaseSkipped(reason);
            await entry.run(context);
          } catch (error) {
            if (error instanceof CaseSkipped) {
              status = "SKIP";
              observed = `skipped: ${error.message}`;
            } else {
              // An assertion, a transport failure, or anything a case threw on an answer it could not read: a failure, as JUnit has it.
              status = "FAIL";
              observed = error instanceof CaseFailure ? error.message : `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
            }
          }
          const result: CaseResult = {
            id: entry.id,
            title: entry.title,
            capability,
            order: entry.order,
            oracle: entry.oracle,
            status,
            expected: entry.expects,
            observed,
            durationMs: performance.now() - caseStarted,
            exchanges: current
          };
          results.push(result);
          options.onResult?.(result);
        }
      }
    }
    const capabilities = selection.capabilities.map((capability): CapabilitySummary => {
      const own = results.filter((result) => result.capability === capability);
      const count = (status: CaseStatus): number => own.filter((result) => result.status === status).length;
      return { capability, pass: count("PASS"), fail: count("FAIL"), skip: count("SKIP"), exercised: count("PASS") > 0 };
    });
    const { verdict, reasons, exitCode } = decide(preflight, results, capabilities);
    const finishedAt = new Date();
    return { startedAt, finishedAt, durationMs: performance.now() - started, preflight, results, capabilities, requestsSent: http.requestsSent, verdict, reasons, exitCode };
  } finally {
    http.close();
  }
}

/** The exit rule (HostTck.Outcome.exitCode, with the preflight's 3 in front). */
export function decide(
  preflight: RunOutcome["preflight"],
  results: readonly Pick<CaseResult, "id" | "status">[],
  capabilities: readonly CapabilitySummary[]
): Pick<RunOutcome, "verdict" | "reasons" | "exitCode"> {
  if (!preflight.ok) {
    return { verdict: "INCONCLUSIVE", reasons: preflight.probes.filter((probe) => probe.status === "missing").map((probe) => `preflight ${probe.id}: ${probe.message}`), exitCode: 3 };
  }
  const failed = results.filter((result) => result.status === "FAIL");
  if (failed.length > 0) {
    return { verdict: "FAIL", reasons: failed.map((result) => `${result.id} FAILED`), exitCode: 1 };
  }
  const unexercised = capabilities.filter((summary) => !summary.exercised);
  if (capabilities.length === 0 || unexercised.length > 0) {
    return {
      verdict: "UNEXERCISED",
      reasons: unexercised.map((summary) =>
        summary.skip > 0
          ? `${summary.capability} asserted nothing: every case was skipped (see the options its cases need: explain <id>)`
          : `${summary.capability} asserted nothing: the kit has no case for it yet`
      ),
      exitCode: 2
    };
  }
  return { verdict: "PASS", reasons: [], exitCode: 0 };
}
