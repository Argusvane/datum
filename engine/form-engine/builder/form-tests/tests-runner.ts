/**
 * The runner behind the Tests panel. It parses the definition's
 * `tests` block into the panel's entries and runs them on the browser's reading only: the
 * engine's own runtime driver over a fresh headless `FormRuntime` per scenario, wired the way
 * `packages/form-test/src/drivers.ts` wires it for the command line (a `submit` mode that
 * validates, the field-constraints stage, the eager journey engine, the in-process sandbox the
 * runtime checks against at submit, the host's plugin functions), so a scenario the panel judges
 * is judged on the readings the CLI's browser side judges. The kernel side and the parity check
 * are the CLI's: a panel that ran both would double the chunk for a comparison the author does
 * not edit against.
 *
 * Nothing here runs at import and nothing is registered globally: the eager journey engine is
 * handed to each runtime, so loading this chunk changes nothing for the canvas.
 *
 * The form a run reads is what the form is now: the shell's whole definition (journeys, PDF
 * layouts and localization ride along) with its tree replaced by the controller's committed one,
 * drafts excluded, and `tests` removed so a scenario never sees the suite it belongs to.
 */
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import { kernelParseFormTests } from "../../core/form-tests/form-test-parse.js";
import { readFormTests } from "../../core/form-tests/form-test-read.js";
import { runFormTestScenario } from "../../core/form-tests/form-test-run.js";
import type {
  FormTestConfiguration,
  FormTestDriver,
  FormTestProblem,
  FormTestScenario,
  FormTestScenarioResult
} from "../../core/form-tests/form-test-types.js";
import type { DataSourceRuntime } from "../../core/schema/contracts.js";
import type { FormDefinition } from "../../core/schema/types.js";
import { SubmissionModeRegistry } from "../../core/submission/submission-modes.js";
import { FormulaFunctionRegistry } from "../../registry/formula-functions/formula-function-registry.js";
import { FormRuntime } from "../../runtime/browser/form-runtime.js";
import {
  createFormTestRuntimeDriver,
  type FormTestRuntimeFactory,
  type FormTestRuntimeGivens
} from "../../runtime/browser/form-test-runtime-driver.js";
import { EagerJourneyEngine } from "../../runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../../validation/core/field-constraints.js";
import { ValidationPipeline } from "../../validation/core/validation-pipeline.js";
import { createInProcessRunHost } from "../../validation/wasm/in-process-host.js";
import type {
  TestsEntryModel,
  TestsReplay,
  TestsRunner,
  TestsRunnerOptions,
  TestsRunOutcome,
  TestsRunSummary
} from "./tests-model.js";

/** How much of a source's first line names an entry that does not parse. */
const NAME_LENGTH = 60;

/** What an entry is called when nothing in its source can name it: empty, for the panel to word from its catalog. */
const UNTITLED = "";

/** A plugin function as the runtime's registry takes it, from the arity its signature gives. */
function registryOf(functions: Record<string, (args: unknown[]) => unknown>, signatures: readonly FormulaFunctionSignature[]): FormulaFunctionRegistry {
  const registry = new FormulaFunctionRegistry();
  for (const name of Object.keys(functions)) {
    const evaluate = functions[name] as (args: unknown[]) => unknown;
    const signature = signatures.find((entry) => entry.name === name);
    const min = signature?.min ?? 0;
    const max = signature?.max ?? Infinity;
    const variadic = !Number.isFinite(max);
    const count = variadic ? Math.max(min, 1) : max;
    const params = Array.from({ length: count }, (_, index) => (index < min ? `arg${index + 1}` : `arg${index + 1}?`));
    registry.register({ name, params, ...(variadic ? { variadic: true as const, min } : { min }), summary: name, example: `${name}()`, evaluate }, "datum-form-test");
  }
  return registry;
}

/**
 * The scenario's own options (`given options for`) over the builder's sources: a source the
 * givens define answers from them, every other from the builder's, so a form with one list given
 * and another simulated by the builder still has both. A given set that cannot say which ids it
 * holds answers for everything, as a runtime handed it alone would.
 */
function layeredSources(given: DataSourceRuntime | undefined, builder: DataSourceRuntime | undefined): DataSourceRuntime | undefined {
  if (given === undefined || builder === undefined) {
    return given ?? builder;
  }
  const has = (given as { has?: (sourceId: string) => boolean }).has;
  return {
    load: (sourceId, query, context) => (typeof has === "function" && !has.call(given, sourceId) ? builder.load(sourceId, query, context) : given.load(sourceId, query, context))
  };
}

/** The first non-blank line of a source, cut, for an entry whose source names no scenario. */
function nameFromSource(source: string): string {
  for (const line of source.split(/\r\n|\r|\n/)) {
    const text = line.trim();
    if (text !== "") {
      return text.length > NAME_LENGTH ? text.slice(0, NAME_LENGTH) : text;
    }
  }
  return UNTITLED;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The macrotask between two scenarios, so the panel paints what finished. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function emptySummary(total: number): TestsRunSummary {
  return { total, passed: 0, failed: 0, skipped: 0, error: 0, invalid: 0 };
}

export function createTestsRunner(options: TestsRunnerOptions): TestsRunner {
  // One token per run: a second run or `cancel()` moves it, and the loop in flight ends after the
  // scenario it is in the middle of (a scenario is never torn down half-way).
  let token = 0;

  const signaturesOf = (): FormulaFunctionSignature[] => [...formulaFunctionSignatures(), ...(options.signatures?.() ?? [])];

  /** The form as it is now, for one run or one replay. */
  const definitionOf = (): FormDefinition => {
    const whole = options.definition();
    const root = options.root();
    if (whole === undefined) {
      return { id: "builder-tests", version: "0.0.0", schemaVersion: "1", root };
    }
    const copy: FormDefinition = { ...whole, root };
    delete copy.tests;
    return copy;
  };

  /**
   * The runtime factory, wired as the CLI's `runtimeFactoryOf` wires it, plus the builder's data
   * sources. The givens are spread last so a scenario's own word always wins. The last error the
   * factory threw is kept, because the runner's driver turns it into a bare `action.failed` and
   * the panel wants the message.
   */
  const factoryOf = (failure: { error?: unknown }): FormTestRuntimeFactory => {
    const functions = options.functions?.();
    const signatures = options.signatures?.() ?? [];
    const builderSources = options.dataSources?.();
    return (definition: FormDefinition, givens: FormTestRuntimeGivens) => {
      try {
        const modes = new SubmissionModeRegistry();
        modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
        const { dataSources: givenSources, ...rest } = givens;
        const sources = layeredSources(givenSources, builderSources);
        return new FormRuntime(definition, {
          submissionModes: modes,
          validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
          journeyEngine: EagerJourneyEngine,
          // Run-only: the runtime checks a submission against the kernel and never
          // introspects, and the full in-process host would pull the `test` op, the parser and
          // the judge into the builder's eager entry.
          wasmValidationHost: createInProcessRunHost([]),
          ...(functions !== undefined && Object.keys(functions).length > 0 ? { formulaFunctions: registryOf(functions, signatures) } : {}),
          ...(sources !== undefined ? { dataSources: sources } : {}),
          ...rest
        });
      } catch (error) {
        failure.error = error;
        throw error;
      }
    };
  };

  const driverOf = (definition: FormDefinition, failure: { error?: unknown }): FormTestDriver => {
    const functions = options.functions?.();
    const signatures = options.signatures?.();
    return createFormTestRuntimeDriver(definition, {
      makeRuntime: factoryOf(failure),
      ...(functions !== undefined ? { functions } : {}),
      ...(signatures !== undefined ? { signatures } : {})
    });
  };

  const failedResult = (name: string, error: unknown): FormTestScenarioResult => ({
    name,
    status: "error",
    reason: "scenario.driverFailed",
    params: { message: messageOf(error) },
    steps: []
  });

  /** One scenario on a driver of its own; never throws. */
  const runOne = async (scenario: FormTestScenario, definition: FormDefinition): Promise<FormTestScenarioResult> => {
    const failure: { error?: unknown } = {};
    let driver: FormTestDriver;
    try {
      driver = driverOf(definition, failure);
    } catch (error) {
      return failedResult(scenario.name, error);
    }
    try {
      const result = await runFormTestScenario(scenario, driver);
      // A factory that threw ends the scenario as a bare `action.failed` with no step; the
      // message is the panel's to show, and it is a runtime that could not be built.
      if (failure.error !== undefined && result.status === "error" && result.steps.length === 0) {
        return failedResult(scenario.name, failure.error);
      }
      return result;
    } catch (error) {
      return failedResult(scenario.name, error);
    }
  };

  const parse = (tests: FormTestConfiguration | undefined): TestsEntryModel[] => {
    const known = signaturesOf();
    const taken = new Set<string>();
    return readFormTests({ tests }).map((stored): TestsEntryModel => {
      const parsed = kernelParseFormTests(stored.source, known);
      const problems: FormTestProblem[] = [...parsed.problems];
      // An empty source (or comments alone) parses to nothing and to no problem; the list still
      // has to say why it will not run.
      if (parsed.scenarios.length === 0 && problems.length === 0) {
        problems.push({ code: "expectedName", line: 1, start: 0, end: 0 });
      }
      // An entry is one block: the second header is a statement outside
      // any test of its own.
      const second = parsed.scenarios[1];
      if (second !== undefined) {
        problems.push({ code: "stepOutsideTest", line: second.line, start: second.span.start, end: second.nameSpan.end });
      }
      const scenario = parsed.scenarios[0];
      if (scenario === undefined || problems.length > 0) {
        return { id: stored.id, source: stored.source, problems, name: nameFromSource(stored.source), status: "invalid" };
      }
      // Each source is parsed alone, so a name two entries share is found here: the later one is
      // reported and still runs (its scenario is fine; the name is the author's to change).
      if (taken.has(scenario.name)) {
        problems.push({
          code: "duplicateName",
          line: scenario.nameSpan.line,
          start: scenario.nameSpan.start,
          end: scenario.nameSpan.end,
          params: { name: scenario.name }
        });
      }
      taken.add(scenario.name);
      const name = scenario.name !== "" ? scenario.name : nameFromSource(stored.source);
      return { id: stored.id, source: stored.source, scenario, problems, name, status: "unrun" };
    });
  };

  const run: TestsRunner["run"] = async (entries, runOptions) => {
    token += 1;
    const mine = token;
    const startedAt = Date.now();
    const results = new Map<string, FormTestScenarioResult>();
    const summary = emptySummary(entries.length);
    let cancelled = false;
    let definition: FormDefinition | undefined;
    let definitionFailure: unknown;
    try {
      definition = definitionOf();
    } catch (error) {
      definitionFailure = error;
    }
    for (const entry of entries) {
      if (entry.scenario === undefined) {
        summary.invalid += 1;
        continue;
      }
      if (token !== mine) {
        cancelled = true;
        break;
      }
      const result = definition === undefined ? failedResult(entry.scenario.name, definitionFailure) : await runOne(entry.scenario, definition);
      // A cancel that landed while this scenario ran ends the run here: what it found is not reported.
      if (token !== mine) {
        cancelled = true;
        break;
      }
      results.set(entry.id, result);
      summary[result.status] += 1;
      try {
        runOptions?.onProgress?.(entry, result);
      } catch {
        /* a progress listener that fails must not end the run */
      }
      await yieldToEventLoop();
    }
    // A cancel that lands while the last scenario's macrotask waits changes nothing: every
    // entry ran, so the loop never saw the moved token and the run is whole.
    const outcome: TestsRunOutcome = { cancelled, results, summary };
    if (!cancelled) {
      summary.ranAt = Date.now();
      summary.durationMs = summary.ranAt - startedAt;
    }
    return outcome;
  };

  const replay: TestsRunner["replay"] = async (scenario, through) => {
    const failure: { error?: unknown } = {};
    let driver: FormTestDriver;
    try {
      driver = driverOf(definitionOf(), failure);
    } catch (error) {
      return { values: {}, steps: [], reached: -1, error: { reason: "scenario.driverFailed", params: { message: messageOf(error) } } };
    }
    // `runFormTestScenario` disposes its driver, which drops the runtime; the state to show is
    // read between the run and the real disposal, so the run is handed a driver that lets go
    // later.
    const held: FormTestDriver = { ...driver, dispose: () => undefined };
    try {
      const sliced: FormTestScenario = { ...scenario, steps: scenario.steps.slice(0, Math.max(0, through + 1)) };
      const result = await runFormTestScenario(sliced, held);
      let reached = -1;
      for (const step of result.steps) {
        if (step.status === "error") {
          break;
        }
        reached += 1;
      }
      const out: TestsReplay = { values: {}, steps: result.steps, reached };
      if (result.status === "error" && failure.error !== undefined && result.steps.length === 0) {
        out.error = { reason: "scenario.driverFailed", params: { message: messageOf(failure.error) } };
        return out;
      }
      if (result.status === "error" && result.steps.length === 0) {
        out.error = { reason: result.reason ?? "action.failed", ...(result.params !== undefined ? { params: result.params } : {}) };
        return out;
      }
      try {
        const snapshot = await driver.snapshot();
        for (const key of Object.keys(snapshot.values)) {
          out.values[key] = snapshot.values[key];
        }
        if (snapshot.page !== undefined) {
          out.page = snapshot.page;
        }
        // An added row with no answer yet has no key in the values: the canvas is told the counts.
        if (snapshot.rows !== undefined && Object.keys(snapshot.rows).length > 0) {
          out.rows = { ...snapshot.rows };
        }
      } catch {
        // A scenario that settled before it started (skipped, over the step bound) has no
        // runtime to read: nothing to show, and no error either.
      }
      return out;
    } catch (error) {
      return { values: {}, steps: [], reached: -1, error: { reason: "scenario.driverFailed", params: { message: messageOf(error) } } };
    } finally {
      try {
        await driver.dispose?.();
      } catch {
        /* nothing to add */
      }
    }
  };

  const cancel = (): void => {
    token += 1;
  };

  return { parse, run, replay, cancel };
}
