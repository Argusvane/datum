import type {
  ValidationContext,
  ValidationResult,
  ValidationStage
} from "../../core/schema/contracts.js";

export interface ValidationPipelineResult {
  stageResults: Array<{ stageId: string; result: ValidationResult }>;
  merged: ValidationResult;
  /**
   * The context's `signal` was aborted during the run: the stage running then had its result
   * dropped and no later stage ran, so `merged` holds only what the stages before it found.
   */
  aborted?: true;
}

/** One stage of a run starting or settling, as {@link ValidationRunOptions.onStage} hears it. */
export interface ValidationStageEvent {
  phase: "start" | "settle";
  stageId: string;
  kind: "deterministic" | "async";
  /** What the stage's `paths(context)` declared for this run; absent for a stage that declares none. */
  paths?: readonly string[];
  /** On `settle`: the stage threw. The error is rethrown after this report. */
  failed?: true;
  /** On `settle`: the context's signal was aborted, and the stage's result was dropped. */
  aborted?: true;
}

export interface ValidationRunOptions {
  /**
   * Called as each stage that runs starts and settles (skipped stages report nothing), with the
   * paths it declared: what a runtime marks fields pending by. A stage that throws reports
   * `settle` with `failed` before the error leaves the run.
   */
  onStage?: (event: ValidationStageEvent) => void;
}

interface PlannedStage {
  stage: ValidationStage;
  paths: readonly string[] | undefined;
}

function isDeterministic(stage: ValidationStage): boolean {
  return (stage.kind ?? "deterministic") === "deterministic";
}

function shouldRun(stage: ValidationStage, context: ValidationContext): boolean {
  return stage.runIf ? stage.runIf(context) === true : true;
}

/** Read through a call, so a check after an await is not narrowed away by the one before it. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function declaredPaths(stage: ValidationStage, context: ValidationContext): readonly string[] | undefined {
  return stage.paths ? stage.paths(context) : undefined;
}

/**
 * Appends one by one: spreading a stage's errors into `push` passes each as an argument, and a
 * stage reporting a few hundred thousand (a large posted body) overflows the call stack.
 */
function appendAll<T>(target: T[], entries: readonly T[]): void {
  for (const entry of entries) {
    target.push(entry);
  }
}

/**
 * Staged validation orchestration.
 *
 * Execution order is deterministic: stages run in constructor order, but every
 * `deterministic` stage runs before any `async` stage (a stable partition that preserves
 * relative order within each group). {@link run} is async and awaits every stage;
 * {@link runFor} runs the same deterministic stages and only the async stages that declare one
 * value path; {@link runDeterministic} runs only the pure stages synchronously and is the entry
 * point used by the cross-runtime parity harness.
 *
 * A context carrying an aborted `signal` stops the async runs: the stage running when it is
 * aborted has its result dropped (whether it honoured the signal and rejected, or ignored it
 * and resolved) and no later stage starts.
 */
export class ValidationPipeline {
  constructor(private readonly stages: ValidationStage[]) {}

  /** This pipeline with `extra` stages after its own — what a runtime builds when installed plugins contribute validators. */
  public withStages(extra: readonly ValidationStage[]): ValidationPipeline {
    return extra.length === 0 ? this : new ValidationPipeline([...this.stages, ...extra]);
  }

  private ordered(): ValidationStage[] {
    return [...this.stages.filter(isDeterministic), ...this.stages.filter((stage) => !isDeterministic(stage))];
  }

  // Not `async`: the run's promise is `execute`'s own, so a caller resumes in as few turns as before.
  public run(context: ValidationContext, options: ValidationRunOptions = {}): Promise<ValidationPipelineResult> {
    const planned: PlannedStage[] = [];
    for (const stage of this.ordered()) {
      planned.push({ stage, paths: undefined });
    }
    return this.execute(planned, context, options, true);
  }

  /**
   * The check of one value path (`"items[1].sku"`): every deterministic stage, then the async
   * stages whose `paths(context)` include `path`, compared as written. An async stage that
   * declares no paths is form-wide and does not run. The errors are every stage's, as
   * {@link run} reports them: keeping only `path`'s is the caller's.
   */
  public runFor(context: ValidationContext, path: string, options: ValidationRunOptions = {}): Promise<ValidationPipelineResult> {
    const planned: PlannedStage[] = [];
    for (const stage of this.ordered()) {
      if (isDeterministic(stage)) {
        planned.push({ stage, paths: undefined });
        continue;
      }
      if (!stage.paths || !shouldRun(stage, context)) {
        continue;
      }
      const paths = stage.paths(context);
      if (paths.includes(path)) {
        planned.push({ stage, paths });
      }
    }
    return this.execute(planned, context, options, false);
  }

  private async execute(
    planned: readonly PlannedStage[],
    context: ValidationContext,
    options: ValidationRunOptions,
    checkRunIf: boolean
  ): Promise<ValidationPipelineResult> {
    const stageResults: Array<{ stageId: string; result: ValidationResult }> = [];
    const mergedErrors: ValidationResult["errors"] = [];
    const signal = context.signal;
    const finish = (aborted: boolean): ValidationPipelineResult =>
      aborted ? { stageResults, merged: { errors: mergedErrors }, aborted: true } : { stageResults, merged: { errors: mergedErrors } };

    for (const entry of planned) {
      if (isAborted(signal)) {
        return finish(true);
      }
      const { stage } = entry;
      // runFor already asked an async stage's runIf when it chose it; a deterministic one is asked here.
      if ((checkRunIf || isDeterministic(stage)) && !shouldRun(stage, context)) {
        continue;
      }
      const kind = isDeterministic(stage) ? "deterministic" : "async";
      const paths = entry.paths ?? declaredPaths(stage, context);
      const report = (extra: Pick<ValidationStageEvent, "failed" | "aborted"> = {}): void => {
        options.onStage?.({ phase: "settle", stageId: stage.id, kind, ...(paths !== undefined ? { paths } : {}), ...extra });
      };
      options.onStage?.({ phase: "start", stageId: stage.id, kind, ...(paths !== undefined ? { paths } : {}) });
      let result: ValidationResult;
      try {
        result = await stage.validate(context);
      } catch (error) {
        if (isAborted(signal)) {
          // A stage honouring the signal rejects: that is the run going stale, not a failure.
          report({ aborted: true });
          return finish(true);
        }
        report({ failed: true });
        throw error;
      }
      if (isAborted(signal)) {
        // A stage that ignored the signal: what it found is about answers since replaced.
        report({ aborted: true });
        return finish(true);
      }
      report();
      stageResults.push({ stageId: stage.id, result });
      appendAll(mergedErrors, result.errors);
    }

    return finish(false);
  }

  /** Runs only deterministic stages, synchronously. Throws if a stage returns a promise. */
  public runDeterministic(context: ValidationContext): ValidationPipelineResult {
    const stageResults: Array<{ stageId: string; result: ValidationResult }> = [];
    const mergedErrors: ValidationResult["errors"] = [];

    for (const stage of this.stages) {
      if (!isDeterministic(stage) || !shouldRun(stage, context)) {
        continue;
      }
      const result = stage.validate(context);
      if (result instanceof Promise) {
        throw new Error(`Deterministic stage "${stage.id}" returned a promise`);
      }
      stageResults.push({ stageId: stage.id, result });
      appendAll(mergedErrors, result.errors);
    }

    return { stageResults, merged: { errors: mergedErrors } };
  }
}
