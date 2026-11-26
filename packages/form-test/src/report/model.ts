/**
 * The report model: what one run of `datum-form-test` found, as data.
 * The renderers (`json.ts`, `junit.ts`, `markdown.ts`) and the vitest helper read it; nothing
 * here is worded, every message is made from codes by `report/words.ts`.
 *
 * The model is a stable contract: new fields are optional, and none is renamed or removed.
 */
import type { FormTestProblem, FormTestScenarioResult, FormTestStepStatus } from "@argusvane/datum-engine/form-tests";
import type { CoverageReport, CoverageRule } from "@argusvane/datum-engine/logic";

/** One side of the two-sided design: the browser's runtime, or the server's validation kernel. */
export type RunnerId = "runtime" | "kernel";
export type RunnerChoice = RunnerId | "both";

/** Where a scenario's text came from: an entry stored with the definition, or a `.datum-test` file. */
export type SourceRef = { kind: "definition"; id: string } | { kind: "file"; path: string };

export interface ProblemReport extends FormTestProblem {
  /** The problem worded (`kernelFormTestMessage`), for a human reader; the code is what a tool reads. */
  message: string;
}

export interface SourceReport {
  source: SourceRef;
  /**
   * The names of the `test` blocks the source parsed to. None when the source did not parse; a
   * source that parsed but only repeats a name an earlier source used (`duplicateName`) lists its
   * names and still runs them, the run failing on the problem.
   */
  scenarioNames: string[];
  problems: ProblemReport[];
}

/** What one step came to on one side; `null` when that side has no step on the line (it stopped earlier). */
export type StepCell = { status: FormTestStepStatus; code?: string; actual?: unknown } | null;

export interface ParityLine {
  line: number;
  runtime: StepCell;
  kernel: StepCell;
}

/**
 * How the two sides compare on one scenario (only under `both`):
 * - `agree`: every judged line came to the same status on both sides;
 * - `one-sided`: one side skipped the scenario (or every judged line), so nothing is compared;
 * - `differ`: a line both sides judged (passed or failed) came to different statuses, or one side
 *   errored where the other ran.
 */
export interface ParityReport {
  status: "agree" | "one-sided" | "differ";
  /** The differing lines, in source order; empty unless `differ`. */
  lines: ParityLine[];
  /** Under `differ` at the scenario level: each side's status and reason. */
  scenario?: { runtime: { status: string; reason?: string }; kernel: { status: string; reason?: string } };
}

export type ScenarioStatus = "passed" | "failed" | "skipped" | "error" | "parity";

export interface ScenarioReport {
  name: string;
  source: SourceRef;
  /** The `test` header's line in its source (1-based). */
  line: number;
  /**
   * The scenario's status over the sides that ran: `parity` when the sides differ; else `failed`
   * when any side failed; else `error` when any side errored; else `passed` when any side passed;
   * else `skipped`.
   */
  status: ScenarioStatus;
  /** The engine's own result per side, untouched. */
  sides: Partial<Record<RunnerId, FormTestScenarioResult>>;
  parity?: ParityReport;
  /** Wall-clock for the scenario on all its sides. */
  durationMs: number;
}

/**
 * Coverage lives in the engine (`builder/logic/coverage.ts`) so the builder's
 * Tests panel and this report read one module; the report types are re-exported from there.
 */
export type { CoverageReport, CoverageRule };

export interface Summary {
  scenarios: number;
  passed: number;
  failed: number;
  skipped: number;
  error: number;
  parity: number;
  /** Sources with parse problems. */
  problems: number;
}

export interface FormReport {
  /** The definition file as given on the command line (or the vitest helper's label). */
  path: string;
  /** The definition's title, when it has one. */
  title?: string;
  sources: SourceReport[];
  scenarios: ScenarioReport[];
  coverage?: CoverageReport;
  summary: Summary;
}

export type Verdict = "passed" | "failed" | "inconclusive";

export interface Report {
  tool: { name: "datum-form-test"; version: string };
  /** ISO timestamp the run started at (the caller's clock; tests pass a fixed one). */
  startedAt: string;
  durationMs: number;
  runner: RunnerChoice;
  /** The sandbox program the kernel side ran on; `null` when the in-process kernel ran. */
  program: { path: string; bytes: number; sha256: string } | null;
  failOn: "failed" | "untested";
  forms: FormReport[];
  summary: Summary;
  /**
   * `failed` when any scenario is failed, error or parity, any source has problems, or a rule is
   * untested under `failOn: "untested"`; else `inconclusive` when no scenario passed (none found,
   * or every one skipped); else `passed`.
   */
  verdict: Verdict;
}
