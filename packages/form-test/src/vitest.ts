/**
 * The vitest helper (it lives in this package, not
 * in the engine, because the engine has no vitest dependency). One `formTests(definition)` call
 * in a `*.test.ts` file registers a `describe` with one `it` per scenario the form stores and
 * the `.datum-test` files it names, so a project that already runs vitest gets its form's tests
 * in the same run, reporter and watch mode as its code.
 *
 * Registration is synchronous: the sources are parsed while vitest collects (the parser is
 * synchronous), so `-t`, `--reporter` and the IDE integrations see every scenario by name before
 * anything runs. The kernel's host is made once per `describe` and shared by its scenarios; each
 * scenario still gets a fresh driver on each side.
 *
 * `vitest` is an optional peer dependency: `src/index.ts` never imports this file, and the
 * bundle builds it as its own entry (`dist/vitest.mjs`) with `vitest` external.
 */
import { formulaFunctionSignatures } from "@argusvane/datum-engine/core";
import type { FormDefinition, FormulaFunctionSignature } from "@argusvane/datum-engine/core";
import { kernelParseFormTests, readFormTests } from "@argusvane/datum-engine/form-tests";
import type { FormTestScenario, FormTestScenarioResult, FormTestStepResult } from "@argusvane/datum-engine/form-tests";
import type { WasmValidationHost } from "@argusvane/datum-engine";
import { afterAll, beforeAll, describe, it } from "vitest";

import type { CoveredScenario, SideEnvironment } from "./api.js";
import { coverageOf } from "./coverage.js";
import { compareSides, scenarioStatusOf } from "./parity.js";
import type { ParityReport, RunnerId, ScenarioStatus } from "./report/model.js";
import { problemMessage, scenarioReasonMessage, stepMessage } from "./report/words.js";
import { createSideHost, disposeSideHost } from "./drivers.js";
import { loadDefinitionFile, loadProgramFile, loadTestFile, titleOf } from "./load.js";
import { runScenarioOnSides, sidesOf } from "./run.js";

/**
 * What `formTests` needs to know of a definition, as a structural type: the declarations this
 * entry ships import nothing from the engine, which the tarball neither carries nor declares, so
 * a project that typechecks its tests would otherwise fail to resolve `@argusvane/datum-engine`. The engine's `FormDefinition` is assignable to it. The root export's declarations
 * still name the engine's types; bundling them needs a declaration bundler.
 */
export interface FormDefinitionLike {
  root: object;
  // `any`, not `unknown`: only an `any` index signature accepts an interface such as the engine's
  // `FormDefinition` (which has no implicit index signature), and a literal's other keys.
  [key: string]: any;
}

/** A plugin function's name and the argument count it takes (`max` may be `Infinity`); the engine's `FormulaFunctionSignature`. */
export interface FormulaSignatureLike {
  name: string;
  min: number;
  max: number;
}

export interface FormTestsOptions {
  /** The `describe` title. Default: the form's title, else its file path, else its id. */
  name?: string;
  /** `.datum-test` files to add, as paths, after the sidecar and the scenarios stored in the definition. */
  tests?: string[];
  /** `.datum-test` texts to add, after the files (for a project that builds scenarios in code). */
  sources?: string[];
  /** Which sides play each scenario. Default `"both"`, so a disagreement between them is a failure. */
  runner?: "runtime" | "kernel" | "both";
  /** A sandbox program file the kernel side runs on; absent, the in-process kernel runs. */
  program?: string;
  /** Plugin formula functions the form calls, with their signatures, as the host wires them. */
  signatures?: readonly FormulaSignatureLike[];
  functions?: Record<string, (args: unknown[]) => unknown>;
  /**
   * What an untested rule does: nothing (default), a `console.warn` after
   * the run, or a failing test named "every rule is tested".
   */
  coverage?: false | "warn" | "fail";
}

/** A source of scenarios with the label a failing "parses" test carries. */
interface ParsedSource {
  label: string;
  scenarios: FormTestScenario[];
  problems: string[];
  /** Names an earlier source already used, worded like the command's `duplicateName` problem. */
  repeats: string[];
}

function parse(label: string, text: string, signatures: readonly FormulaFunctionSignature[]): ParsedSource {
  const parsed = kernelParseFormTests(text, signatures);
  return {
    label,
    scenarios: parsed.scenarios,
    problems: parsed.problems.map((problem) => `line ${problem.line}: ${problemMessage(problem)}`),
    repeats: []
  };
}

function failingLines(result: FormTestScenarioResult, prefix: string): string[] {
  const failing = result.steps.filter((step: FormTestStepResult) => step.status === "failed" || step.status === "error");
  if (failing.length === 0) {
    // A start error or a driver that could not be made: no step carries it, the scenario does.
    return [`${prefix}${scenarioReasonMessage(result)}`];
  }
  return failing.map((step) => `${prefix}line ${step.line}: ${stepMessage(step)}`);
}

function cellText(cell: { status: string; code?: string } | null): string {
  return cell === null ? "(no step)" : cell.code !== undefined ? `${cell.status} ${cell.code}` : cell.status;
}

/** The disagreement as the lines a reader compares side by side (the parity table of the report). */
function parityLines(parity: ParityReport, results: Partial<Record<RunnerId, FormTestScenarioResult>>): string[] {
  const lines = ["The runtime and the kernel disagree:"];
  if (parity.scenario !== undefined) {
    const side = (value: { status: string; reason?: string }): string => (value.reason !== undefined ? `${value.status} (${value.reason})` : value.status);
    lines.push(`  scenario: runtime ${side(parity.scenario.runtime)} | kernel ${side(parity.scenario.kernel)}`);
    // The side that errored often has no scenario reason: the cause sits on a step (an action
    // that failed), so without it the message is just "kernel error".
    for (const id of ["runtime", "kernel"] as const) {
      const result = results[id];
      if (result !== undefined && result.status === "error") lines.push(...failingLines(result, `  [${id}] `));
    }
  }
  for (const line of parity.lines) {
    lines.push(`  line ${line.line}: runtime ${cellText(line.runtime)} | kernel ${cellText(line.kernel)}`);
  }
  return lines;
}

/**
 * Register a form's tests with vitest. `definition` is a `FormDefinition` or the path of a
 * definition file (its `<stem>.datum-test` sidecar is read too). A definition that cannot be
 * loaded throws here, so the file fails at collection with the reason instead of registering
 * nothing and passing.
 */
export function formTests(definitionOrPath: FormDefinitionLike | string, options: FormTestsOptions = {}): void {
  const definition = definitionOrPath as FormDefinition | string;
  const signatures = [...formulaFunctionSignatures(), ...(options.signatures ?? [])];
  const runner = options.runner ?? "both";
  const sides: RunnerId[] = sidesOf(runner);
  const coverage = options.coverage ?? false;

  let form: FormDefinition;
  let path: string | undefined;
  const parsedSources: ParsedSource[] = [];
  const texts: Array<{ label: string; text: string }> = [];
  if (typeof definition === "string") {
    const loaded = loadDefinitionFile(definition);
    form = loaded.definition;
    path = loaded.path;
    for (const source of loaded.sources) texts.push({ label: source.path, text: source.text });
  } else {
    form = definition;
  }
  // The scenarios stored with the definition come first, one source per entry, as the builder
  // keeps them; files and inline texts follow in the order given.
  const stored = readFormTests(form).map((entry) => parse(`test ${entry.id}`, entry.source, signatures));
  for (const file of options.tests ?? []) {
    const loaded = loadTestFile(file);
    texts.push({ label: loaded.path, text: loaded.text });
  }
  (options.sources ?? []).forEach((text, index) => texts.push({ label: `sources[${index}]`, text }));
  parsedSources.push(...stored, ...texts.map((entry) => parse(entry.label, entry.text, signatures)));
  // Results are keyed by name, so a name repeated across sources fails the run in the command
  // (run.ts); the helper must give the same verdict on the same inputs.
  const taken = new Set<string>();
  for (const source of parsedSources) {
    if (source.problems.length > 0) continue;
    for (const scenario of source.scenarios) {
      if (taken.has(scenario.name)) {
        const span = scenario.nameSpan;
        source.repeats.push(`line ${span.line}: ${problemMessage({ code: "duplicateName", line: span.line, start: span.start, end: span.end, params: { name: scenario.name } })}`);
      }
    }
    for (const scenario of source.scenarios) taken.add(scenario.name);
  }

  const environment: SideEnvironment = {
    // Absent stays absent: an empty list would reach the kernel driver as "the whole table" and
    // leave it without the built-in functions. Given ones are added to them.
    ...(options.signatures !== undefined ? { signatures: options.signatures } : {}),
    ...(options.functions !== undefined ? { functions: options.functions } : {}),
    ...(options.program !== undefined ? { program: loadProgramFile(options.program) } : {})
  };
  let host: WasmValidationHost | undefined;
  // A program that does not start, or starts and is not a validation program, fails at bind. Held
  // here so each scenario fails with the reason: thrown from beforeAll alone, vitest would report
  // every test of the file as skipped and the reason nowhere near them.
  let bindFailure: Error | undefined;

  /**
   * One play per scenario, shared by its `it` and by the coverage reading. A concurrent run (vitest
   * `--sequence.concurrent`) starts "every rule is tested" before the scenarios have finished, so
   * it cannot read what they recorded; it plays the ones not yet played and awaits the rest, which
   * also makes a `-t` filter count every scenario the file registers.
   */
  interface Played {
    results: Partial<Record<RunnerId, FormTestScenarioResult>>;
    parity: ParityReport | undefined;
    status: ScenarioStatus;
  }
  const played = new Map<FormTestScenario, Promise<Played>>();
  const registered: FormTestScenario[] = [];
  function play(scenario: FormTestScenario): Promise<Played> {
    if (bindFailure !== undefined) return Promise.reject(bindFailure);
    let existing = played.get(scenario);
    if (existing === undefined) {
      existing = runScenarioOnSides(form, scenario, sides, host !== undefined ? { ...environment, host } : environment).then((results) => {
        const runtime = results.runtime;
        const kernel = results.kernel;
        const parity = runtime !== undefined && kernel !== undefined ? compareSides(runtime, kernel) : undefined;
        return { results, parity, status: scenarioStatusOf(results, parity) };
      });
      played.set(scenario, existing);
    }
    return existing;
  }
  /** The scenarios that came to a status, from `scenarios` (a play that threw proved nothing). */
  async function coveredOf(scenarios: readonly FormTestScenario[]): Promise<CoveredScenario[]> {
    const settled = await Promise.allSettled(scenarios.map((scenario) => play(scenario)));
    const covered: CoveredScenario[] = [];
    settled.forEach((entry, index) => {
      if (entry.status === "fulfilled") covered.push({ scenario: scenarios[index] as FormTestScenario, status: entry.value.status });
    });
    return covered;
  }
  const untestedMessage = async (scenarios: readonly FormTestScenario[]): Promise<string | undefined> => {
    // Nothing ran when the host did not bind: the reason is the failure, not a list of rules that
    // no scenario reached.
    if (bindFailure !== undefined) throw bindFailure;
    const untested = coverageOf(form, await coveredOf(scenarios)).rules.filter((rule) => rule.scenarios.length === 0);
    return untested.length === 0
      ? undefined
      : `${untested.length} rule${untested.length === 1 ? " is" : "s are"} not tested by the scenarios that ran:\n` + untested.map((rule) => `  ${rule.sentence}`).join("\n");
  };

  describe(options.name ?? titleOf(form) ?? path ?? form.id, () => {
    beforeAll(async () => {
      // One kernel host per describe: a QuickJS context costs far more than a scenario.
      if (sides.includes("kernel")) {
        try {
          host = await createSideHost(environment);
        } catch (error) {
          const said = error instanceof Error ? error.message : String(error);
          const program = environment.program !== undefined ? `the sandbox program ${environment.program.path}` : "the kernel side";
          bindFailure = new Error(
            (error as { code?: unknown } | null)?.code === "abi_mismatch" ? `${program} is not a validation program: ${said}` : `${program} did not start: ${said}`
          );
        }
      }
    });
    afterAll(async () => {
      if (coverage === "warn" && bindFailure === undefined) {
        // Only what vitest started: a filtered-out scenario is not played just to be counted.
        const message = await untestedMessage([...played.keys()]);
        if (message !== undefined) console.warn(message);
      }
      disposeSideHost(host);
      host = undefined;
    });

    for (const source of parsedSources) {
      if (source.problems.length > 0) {
        it(`${source.label} parses`, () => {
          throw new Error(source.problems.join("\n"));
        });
        // As the command does (run.ts, `SourceReport.scenarioNames`): a source with problems runs
        // none of its scenarios, since a scenario missing the line that did not parse could pass
        // for want of the expectation it lost.
        continue;
      }
      if (source.repeats.length > 0) {
        // A name an earlier source used is the run's failure (results are keyed by
        // name), as in `run.ts`; the scenario itself still runs, so the other failures show too.
        it(`${source.label} parses`, () => {
          throw new Error(source.repeats.join("\n"));
        });
      }
      for (const scenario of source.scenarios) {
        registered.push(scenario);
        it(scenario.name, async (context) => {
          const { results, parity, status } = await play(scenario);

          if (status === "skipped") {
            const first = Object.values(results)[0];
            // `skip(note)` shows the reason where the vitest version supports it (3.x); older
            // versions ignore the argument and report the scenario as skipped all the same.
            (context.skip as (note?: string) => void)(first === undefined ? undefined : scenarioReasonMessage(first));
            return;
          }
          if (status === "parity" && parity !== undefined) {
            throw new Error(parityLines(parity, results).join("\n"));
          }
          if (status === "failed" || status === "error") {
            const both = Object.keys(results).length > 1;
            const lines: string[] = [];
            for (const side of sides) {
              const result = results[side];
              if (result === undefined || (result.status !== "failed" && result.status !== "error")) continue;
              lines.push(...failingLines(result, both ? `[${side}] ` : ""));
            }
            throw new Error(lines.join("\n"));
          }
        });
      }
    }

    if (coverage === "fail") {
      it("every rule is tested", async () => {
        const message = await untestedMessage(registered);
        if (message !== undefined) throw new Error(message);
      });
    }
  });
}
