/**
 * The submissions package for a Node server: the sandbox bound the way a production host should
 * bind it, a fresh sandbox for every validation. Not part of the main entry, which the page's Data
 * tab bundles: this one reaches `node:worker_threads`.
 */
import { createQuickJsFreshSandboxHost, type QuickJsFreshSandboxHost } from "@argusvane/datum-quickjs-wasm-host";
import { createQuickJsWorkerHost, type QuickJsWorkerHost, type QuickJsWorkerHostOptions } from "@argusvane/datum-quickjs-wasm-host/worker";

import { createProgramHostValidator, type SubmissionValidator } from "./validation/validator.js";

/** The options of the worker host with no meaning on the calling thread, which has no second clock and no memory ceiling. */
const WORKER_ONLY_OPTIONS = ["killSlackMs", "bootTimeoutMs", "maxWasmHeapBytes", "maxOldGenerationSizeMb"] as const;

export type QuickJsValidatorOptions = QuickJsWorkerHostOptions & {
  /**
   * Run the sandbox on its own worker thread (default true): a runaway call into native code is
   * killed at its deadline and the next call starts a new worker, so one hostile definition
   * cannot hold the server's event loop. `false` runs it on the calling thread: the deadline is
   * then a polled interrupt, which a long native call outlasts: there is no hard stop and no
   * ceiling on the instance's WebAssembly memory, so a server keeps the worker. The worker's own
   * options (`killSlackMs`, `bootTimeoutMs`, `maxWasmHeapBytes`, `maxOldGenerationSizeMb`) exist
   * only there; passing one with `worker: false` throws.
   * Either way every validation, and every question the host asks the program on its behalf,
   * runs in a sandbox of its own (a new WebAssembly instance of the engine) that is thrown away
   * after it.
   */
  worker?: boolean;
};

/** A validator over a QuickJS sandbox; `dispose` stops the worker thread (or lets the calling thread's prepared sandbox go). */
export interface QuickJsSubmissionValidator extends SubmissionValidator {
  dispose(): Promise<void>;
  /** The worker host behind it, when `worker` is on: its kill and start counters. */
  readonly worker?: QuickJsWorkerHost;
}

/**
 * The sandbox program judging submissions in QuickJS, the way a Node server runs it: a fresh
 * sandbox per validation, on a worker thread unless `worker: false`. The same program, kernel and
 * bytes as every other host.
 */
export async function createQuickJsValidator(options: QuickJsValidatorOptions = {}): Promise<QuickJsSubmissionValidator> {
  const { worker = true, ...hostOptions } = options;
  if (!worker) {
    for (const name of WORKER_ONLY_OPTIONS) {
      if (hostOptions[name] !== undefined) {
        throw new Error(`createQuickJsValidator: the option "${name}" exists only on the worker; it cannot be used with worker: false`);
      }
    }
  }
  if (worker) {
    const host = await createQuickJsWorkerHost(hostOptions);
    // The worker host proves a program handed to it as it starts (unless the caller turned that off).
    return { ...createProgramHostValidator(host, "quickjs-worker", { checkProgramAbi: false }), worker: host, dispose: () => host.dispose() };
  }
  const host: QuickJsFreshSandboxHost = await createQuickJsFreshSandboxHost(hostOptions);
  // As the worker host, the fresh-sandbox host proves a program handed to it as it starts.
  return {
    ...createProgramHostValidator(host, "quickjs", { checkProgramAbi: false }),
    async dispose() {
      host.dispose();
    }
  };
}
