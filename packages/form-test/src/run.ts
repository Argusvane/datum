/**
 * One run of a form's tests: every source parsed on its own,
 * every scenario played on the chosen sides, the sides compared, the rules covered, and the
 * whole summed up into a `Report` and a verdict. Pure of the command line: no argv, no stdout,
 * no wall-clock date (the caller passes `startedAt`), so the vitest helper and a host script run
 * the same code the CLI does.
 */
import { createHash } from "node:crypto";

import { WasmValidationHost } from "@argusvane/datum-engine";
import { formulaFunctionSignatures } from "@argusvane/datum-engine/core";
import type { ComponentNode, FormDefinition } from "@argusvane/datum-engine/core";
import { kernelParseFormTests, readFormTests, runFormTestScenarios } from "@argusvane/datum-engine/form-tests";
import type { FormTestDriver, FormTestProblem, FormTestScenarioResult } from "@argusvane/datum-engine/form-tests";

import type { CoveredScenario, FormTestsInput, ProgramInput, RunFormTests, RunFormTestsOptions, RunScenarioOnSides, SideEnvironment, SidesOf, SourcedScenario } from "./api.js";
import { coverageOf } from "./coverage.js";
import { createSideHost, disposeSideHost, makeKernelDriver, makeRuntimeDriver } from "./drivers.js";
import { InputError, titleOf } from "./load.js";
import { compareSides, scenarioStatusOf } from "./parity.js";
import type { FormReport, ProblemReport, Report, RunnerId, ScenarioReport, SourceRef, SourceReport, Summary, Verdict } from "./report/model.js";
import { problemMessage } from "./report/words.js";
import { EXIT, type ExitCode } from "./exit-codes.js";
import { TOOL_NAME, TOOL_VERSION } from "./version.js";

/**
 * A side environment that may carry the kernel host already made. `SideEnvironment` has the
 * optional `host` itself; the name stays for callers that use it.
 */
export type HostedEnvironment = SideEnvironment;

export const sidesOf: SidesOf = (runner) => (runner === "both" ? ["runtime", "kernel"] : [runner]);

export const runScenarioOnSides: RunScenarioOnSides = async (definition, scenario, sides, environment) => {
  const given = environment.host;
  let made: Promise<WasmValidationHost> | undefined;
  const hostOf = (): Promise<WasmValidationHost> => {
    if (given !== undefined) {
      return Promise.resolve(given);
    }
    made ??= createSideHost(environment);
    return made;
  };
  const results: Partial<Record<RunnerId, FormTestScenarioResult>> = {};
  try {
    for (const side of sides) {
      // Each side on a fresh driver, made inside the engine's runner so a factory that throws
      // (a host that does not start, a definition the driver cannot read) is that side's
      // `scenario.driverFailed`, never the whole run's.
      const makeDriver = async (): Promise<FormTestDriver> =>
        side === "runtime" ? makeRuntimeDriver(definition, environment) : makeKernelDriver(definition, await hostOf(), environment);
      const [result] = await runFormTestScenarios([scenario], makeDriver);
      results[side] = result ?? { name: scenario.name, status: "error", reason: "scenario.driverFailed", steps: [] };
    }
  } finally {
    if (made !== undefined) {
      disposeSideHost(await made.catch(() => undefined));
    }
  }
  return results;
};

export function summarize(scenarios: readonly ScenarioReport[], sources: readonly SourceReport[]): Summary {
  const summary: Summary = { scenarios: scenarios.length, passed: 0, failed: 0, skipped: 0, error: 0, parity: 0, problems: 0 };
  for (const scenario of scenarios) {
    summary[scenario.status] += 1;
  }
  summary.problems = sources.filter((source) => source.problems.length > 0).length;
  return summary;
}

/** The run's verdict over everything but itself (see `Report.verdict`). */
export function verdictOf(report: Omit<Report, "verdict">): Verdict {
  const summary = report.summary;
  if (summary.failed > 0 || summary.error > 0 || summary.parity > 0 || summary.problems > 0) {
    return "failed";
  }
  if (report.failOn === "untested" && report.forms.some((form) => (form.coverage?.untested ?? 0) > 0)) {
    return "failed";
  }
  return summary.passed === 0 ? "inconclusive" : "passed";
}

export function exitCodeOf(report: Report): ExitCode {
  return report.verdict === "passed" ? EXIT.passed : report.verdict === "failed" ? EXIT.failed : EXIT.inconclusive;
}

function worded(problem: FormTestProblem): ProblemReport {
  return { ...problem, message: problemMessage(problem) };
}

interface ParsedSources {
  sources: SourceReport[];
  scenarios: SourcedScenario[];
}

/**
 * Every source of one definition parsed alone, as `runFormTestsOnRuntime` reads them: the
 * definition's entries (`readFormTests`), then the files. A source with problems contributes no
 * scenario, so a half-read block never runs. A name an earlier source already used is a
 * `duplicateName` problem on the later source, which still runs: results are keyed by name, and
 * the parser, seeing one source at a time, cannot catch it.
 */
function parseSources(input: FormTestsInput, environment: SideEnvironment): ParsedSources {
  const known = [...formulaFunctionSignatures(), ...(environment.signatures ?? [])];
  const all: Array<{ source: SourceRef; text: string }> = [
    ...readFormTests(input.definition).map((entry) => ({ source: { kind: "definition" as const, id: entry.id }, text: entry.source })),
    ...input.sources.map((file) => ({ source: { kind: "file" as const, path: file.path }, text: file.text }))
  ];
  const sources: SourceReport[] = [];
  const scenarios: SourcedScenario[] = [];
  const taken = new Set<string>();
  for (const { source, text } of all) {
    const parsed = kernelParseFormTests(text, known);
    if (parsed.problems.length > 0) {
      sources.push({ source, scenarioNames: [], problems: parsed.problems.map(worded) });
      continue;
    }
    const repeated: ProblemReport[] = [];
    for (const scenario of parsed.scenarios) {
      if (taken.has(scenario.name)) {
        repeated.push(
          worded({
            code: "duplicateName",
            line: scenario.nameSpan.line,
            start: scenario.nameSpan.start,
            end: scenario.nameSpan.end,
            params: { name: scenario.name }
          })
        );
      }
    }
    for (const scenario of parsed.scenarios) {
      taken.add(scenario.name);
      scenarios.push({ scenario, source });
    }
    sources.push({ source, scenarioNames: parsed.scenarios.map((scenario) => scenario.name), problems: repeated });
  }
  return { sources, scenarios };
}

async function runForm(
  input: FormTestsInput,
  options: RunFormTestsOptions,
  sides: readonly RunnerId[],
  environment: HostedEnvironment,
  now: () => number
): Promise<FormReport> {
  const definition: FormDefinition = input.definition;
  const parsed = parseSources(input, environment);
  const scenarios: ScenarioReport[] = [];
  for (const { scenario, source } of parsed.scenarios) {
    const started = now();
    const results = await runScenarioOnSides(definition, scenario, sides, environment);
    const parity = results.runtime !== undefined && results.kernel !== undefined ? compareSides(results.runtime, results.kernel) : undefined;
    const report: ScenarioReport = {
      name: scenario.name,
      source,
      line: scenario.nameSpan.line,
      status: scenarioStatusOf(results, parity),
      sides: results,
      durationMs: now() - started
    };
    if (parity !== undefined) {
      report.parity = parity;
    }
    scenarios.push(report);
  }
  const form: FormReport = { path: input.path, sources: parsed.sources, scenarios, summary: summarize(scenarios, parsed.sources) };
  const title = titleOf(definition);
  if (title !== undefined) {
    form.title = title;
  }
  if (options.coverage || options.failOn === "untested") {
    const covered: CoveredScenario[] = parsed.scenarios.map((entry, index) => ({ scenario: entry.scenario, status: (scenarios[index] as ScenarioReport).status }));
    try {
      form.coverage = coverageOf(definition, covered);
    } catch (error) {
      // The Logic model reads the whole tree; a definition the loader let through but the model
      // cannot read is the input's fault (exit 2), not an internal error.
      throw new InputError(`the definition ${input.path} cannot be read for coverage: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return form;
}

function environmentOf(options: RunFormTestsOptions): SideEnvironment {
  const environment: SideEnvironment = {};
  if (options.signatures !== undefined) {
    environment.signatures = options.signatures;
  }
  if (options.functions !== undefined) {
    environment.functions = options.functions;
  }
  if (options.program !== undefined) {
    environment.program = options.program;
  }
  return environment;
}

/**
 * A program that evaluates is not yet a validation program: the PDF kernel's file, or any other
 * script, starts fine and then fails every scenario with "defines no function __datum_run", which
 * would read as a parity difference to fix in the engine. One empty validation tells them apart
 * (exit 2, the input's fault) before any scenario runs.
 */
async function assertValidationProgram(host: WasmValidationHost, program: ProgramInput): Promise<void> {
  const root = { id: "probe", type: "form", configuration: {}, children: { content: [] } } as unknown as ComponentNode;
  try {
    await host.run({ context: { form: root, values: {}, formId: "probe", locale: "en" }, policy: WasmValidationHost.STRICT_POLICY });
  } catch (error) {
    throw new InputError(`the sandbox program ${program.path} is not a validation program: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const runFormTests: RunFormTests = async (options) => {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const sides = sidesOf(options.runner);
  const environment: HostedEnvironment = environmentOf(options);
  // A host the caller made is theirs: used for every scenario, never disposed here.
  let host: WasmValidationHost | undefined;
  if (options.host !== undefined) {
    environment.host = options.host;
  } else if (sides.includes("kernel")) {
    try {
      host = await createSideHost(environment);
    } catch (error) {
      // A program file that does not start is the input's fault, not a scenario's (exit 2). One
      // that starts but does not answer the host's ABI probe is not a validation program of this
      // engine (any script, the PDF kernel's file, a stale build), which names what to fix.
      if (options.program !== undefined && (error as { code?: unknown } | null)?.code === "abi_mismatch") {
        throw new InputError(`the sandbox program ${options.program.path} is not a validation program: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (options.program !== undefined) {
        throw new InputError(`the sandbox program ${options.program.path} did not start: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
    environment.host = host;
    if (options.program !== undefined) {
      try {
        await assertValidationProgram(host, options.program);
      } catch (error) {
        disposeSideHost(host);
        throw error;
      }
    }
  }
  const forms: FormReport[] = [];
  try {
    for (const input of options.inputs) {
      forms.push(await runForm(input, options, sides, environment, now));
    }
  } finally {
    disposeSideHost(host);
  }
  // The report names the program only when the kernel side ran on it (a program the run never
  // loaded would be recorded as if it had been checked).
  const program = options.program === undefined || !sides.includes("kernel")
    ? null
    : {
        path: options.program.path,
        bytes: Buffer.byteLength(options.program.text, "utf8"),
        sha256: createHash("sha256").update(options.program.text, "utf8").digest("hex")
      };
  const withoutVerdict: Omit<Report, "verdict"> = {
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    startedAt: options.startedAt,
    durationMs: now() - started,
    runner: options.runner,
    program,
    failOn: options.failOn,
    forms,
    summary: summarize(
      forms.flatMap((form) => form.scenarios),
      forms.flatMap((form) => form.sources)
    )
  };
  return { ...withoutVerdict, verdict: verdictOf(withoutVerdict) };
};
