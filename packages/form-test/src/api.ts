/**
 * The package's programmatic contract: what the command line, the vitest
 * helper and a host script call. Implemented in `run.ts` (the run), `drivers.ts` (the two
 * sides), `parity.ts` and `coverage.ts`. Fields added here are optional, so existing callers keep
 * working.
 */
import type { WasmValidationHost } from "@argusvane/datum-engine";
import type { FormDefinition, FormulaFunctionSignature } from "@argusvane/datum-engine/core";
import type { FormTestScenario, FormTestScenarioResult } from "@argusvane/datum-engine/form-tests";

import type { CoverageReport, ParityReport, Report, RunnerChoice, RunnerId, ScenarioStatus, SourceRef } from "./report/model.js";

/** A test source beside the definition's own: a `.datum-test` file's text. */
export interface FormTestSource {
  path: string;
  text: string;
}

export interface FormTestsInput {
  definition: FormDefinition;
  /** The label the report shows (the file's path). */
  path: string;
  /** `.datum-test` files: the sidecar with the definition's stem, then `--tests` files, in order. */
  sources: FormTestSource[];
}

/** The sandbox program the kernel side runs on (`--program`); absent, the in-process kernel runs. */
export interface ProgramInput {
  path: string;
  text: string;
}

/** What both sides need beyond the definition: plugin functions and their signatures (none from the CLI yet). */
export interface SideEnvironment {
  signatures?: readonly FormulaFunctionSignature[];
  functions?: Record<string, (args: unknown[]) => unknown>;
  program?: ProgramInput;
  /**
   * The kernel side's host, already made: a run or a vitest `describe` makes
   * one and shares it across scenarios, since a QuickJS host costs a program evaluation to
   * start. Absent, `runScenarioOnSides` makes its own and disposes it. A host given here is the
   * caller's to dispose.
   */
  host?: WasmValidationHost;
}

export interface RunFormTestsOptions extends SideEnvironment {
  inputs: FormTestsInput[];
  runner: RunnerChoice;
  coverage: boolean;
  failOn: "failed" | "untested";
  /** The report's `startedAt`; tests pass a fixed one. */
  startedAt: string;
  /** A clock for `durationMs`; tests pass a fixed one. Default `performance.now`. */
  now?: () => number;
}

/** The whole run: parse every source, play every scenario on the chosen sides, compare, cover, summarise. */
export type RunFormTests = (options: RunFormTestsOptions) => Promise<Report>;

/** The sides `runner` names, in report order. */
export type SidesOf = (runner: RunnerChoice) => RunnerId[];

/**
 * One scenario on the given sides, each on a fresh driver over the definition (the vitest helper
 * calls this per `it`). A side whose driver cannot be made reports `error` / `scenario.driverFailed`.
 */
export type RunScenarioOnSides = (
  definition: FormDefinition,
  scenario: FormTestScenario,
  sides: readonly RunnerId[],
  environment: SideEnvironment
) => Promise<Partial<Record<RunnerId, FormTestScenarioResult>>>;

/** The parity reading of one scenario's two results (see `ParityReport`). */
export type CompareSides = (runtime: FormTestScenarioResult, kernel: FormTestScenarioResult) => ParityReport;

/** The scenario's status over its sides (see `ScenarioReport.status`). */
export type ScenarioStatusOf = (sides: Partial<Record<RunnerId, FormTestScenarioResult>>, parity: ParityReport | undefined) => ScenarioStatus;

/** A scenario with the status it came to, as coverage reads it. */
export interface CoveredScenario {
  scenario: FormTestScenario;
  status: ScenarioStatus;
}

/** Coverage of the form's rules by the scenarios: from the Logic model. */
export type CoverageOf = (definition: FormDefinition, scenarios: readonly CoveredScenario[]) => CoverageReport;

/** A parsed scenario with where it came from. */
export interface SourcedScenario {
  scenario: FormTestScenario;
  source: SourceRef;
}
