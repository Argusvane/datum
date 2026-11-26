import { WASM_ABI_VERSION, formulaFunctionSignatures, kernelCreatePreparedCache, runKernel, type KernelValidator, type WasmSubmissionContext, type WasmSubmissionOutcome } from "@argusvane/datum-engine";

/**
 * How the server judges a submission: the sandbox program's verdict,
 * over the definition's schema, exactly what every server example on the docs site runs
 * in its QuickJS. Two ways to get it — the portable kernel called in-process (tests, and the
 * page before its QuickJS is up) and a program host that evaluated `datum-sandbox-program.js`
 * (the page's Data tab, a Node server's `qjs.mjs`). Same kernel, same bytes, same verdict.
 */
export interface SubmissionValidator {
  /** Which way this is: `"kernel"` in-process, `"quickjs"` through a program host, or the host's own name. */
  id: string;
  validate(context: WasmSubmissionContext): Promise<WasmSubmissionOutcome>;
}

/**
 * The kernel in this process: `runKernel` over the context, plus any validator modules a host adds.
 * For development and tests: nothing sandboxes the form's rules (the service logs one warning
 * when it is used). A production server binds a QuickJS host (`createProgramHostValidator`, or
 * `createQuickJsValidator` from `@argusvane/datum-submissions/node`).
 */
export function createKernelValidator(validators: readonly KernelValidator[] = []): SubmissionValidator {
  // The prepared definitions this validator remembers between judgements: a form judged
  // again is not compiled again, and its option questions are not found again. Per validator, so
  // nothing is shared between services; a hit answers byte for byte as a miss.
  const prepared = kernelCreatePreparedCache(16, 4000000);
  const signatures = formulaFunctionSignatures();
  return {
    id: "kernel",
    async validate(context) {
      return runKernel(context, validators, undefined, signatures, prepared) as WasmSubmissionOutcome;
    }
  };
}

/**
 * What a program host offers: `call(fn, jsonArgument)` returns the JSON the function returned —
 * `QuickJsProgramHost` fits, and so do `QuickJsWorkerHost` and `QuickJsFreshSandboxHost`, which
 * answer promises (a fresh sandbox per call).
 */
export interface ProgramHostLike {
  call(fn: string, argument: string): string | Promise<string>;
}

/**
 * Whether a sandbox's answer has the shape of a verdict: an object whose `errors` is a list of
 * error records (each an object with a string `code`), whose `values`, when present, is a plain
 * object. Anything else (a `null`, `{}`, a string, `errors: "none"`, a stale or broken program's
 * answer) is no verdict, and the service treats it as the sandbox being unavailable rather than
 * reading fields off it.
 */
export function isSubmissionOutcome(value: unknown): value is WasmSubmissionOutcome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as { errors?: unknown; values?: unknown };
  if (!Array.isArray(record.errors)) {
    return false;
  }
  for (const error of record.errors) {
    if (error === null || typeof error !== "object" || typeof (error as { code?: unknown }).code !== "string") {
      return false;
    }
  }
  return record.values === undefined || (record.values !== null && typeof record.values === "object" && !Array.isArray(record.values));
}

export interface ProgramHostValidatorOptions {
  /**
   * Prove the program speaks this engine's ABI before its first verdict (default true): a file
   * left over from an older build may still answer `__datum_run` with a verdict, by older rules.
   * `false` is for a host that already proved it (the QuickJS hosts do when handed a program).
   */
  checkProgramAbi?: boolean;
}

/**
 * `__datum_run(contextJson)` inside a program host that evaluated the sandbox program — the server
 * samples' line, in TypeScript. The program answers the same ABI probe the QuickJS hosts send (the
 * `public` question at this engine's ABI) once, before it judges: until it answers `ok: true`
 * every validation throws, so the service refuses as unavailable rather than accept by stale rules.
 */
export function createProgramHostValidator(host: ProgramHostLike, id = "quickjs", options: ProgramHostValidatorOptions = {}): SubmissionValidator {
  let proven: Promise<void> | undefined = options.checkProgramAbi === false ? Promise.resolve() : undefined;
  const prove = async (): Promise<void> => {
    const answer = await host.call("__datum_inspect", JSON.stringify({ abi: WASM_ABI_VERSION, op: "public", definition: { root: { id: "form", type: "form" } } }));
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer);
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== "object" || (parsed as { ok?: unknown }).ok !== true) {
      throw Object.assign(new Error(`The sandbox program does not speak ABI ${WASM_ABI_VERSION}; rebuild it`), { code: "abi_mismatch" });
    }
  };
  return {
    id,
    async validate(context) {
      // Only a proof is remembered: a probe that failed (a stale file, or a call that threw for
      // another reason) is asked again on the next validation.
      proven ??= prove().catch((error: unknown) => {
        proven = undefined;
        throw error;
      });
      await proven;
      const answer: unknown = JSON.parse(await host.call("__datum_run", JSON.stringify(context)));
      if (!isSubmissionOutcome(answer)) {
        throw new Error(`The sandbox program answered ${describeAnswer(answer)}, not a verdict`);
      }
      return answer;
    }
  };
}

function describeAnswer(answer: unknown): string {
  if (answer === null) {
    return "null";
  }
  if (Array.isArray(answer)) {
    return "a list";
  }
  if (typeof answer === "object") {
    return `an object with keys ${JSON.stringify(Object.keys(answer as object).slice(0, 8))}`;
  }
  return `a ${typeof answer}`;
}
