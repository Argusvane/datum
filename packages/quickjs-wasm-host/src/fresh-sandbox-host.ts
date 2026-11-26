import { WASM_ABI_VERSION, type WasmPluginModule } from "@argusvane/datum-engine";

import { ABANDONED_ADVICE, QuickJsExecutionError, VALIDATION_PROFILE, assertRequestWithinLimits, type QuickJsProgramLimits } from "./program-host.js";
import {
  DEFAULT_STARTUP_MS,
  DefinitionBudgets,
  QuickJsWasmHostAdapter,
  abiProbeRequest,
  inspectBudget,
  proveProgramAbi,
  withRequestSize,
  type QuickJsWasmHostAdapterOptions,
  type SandboxInstance
} from "./quickjs-wasm-host-adapter.js";

export interface QuickJsFreshSandboxHostOptions extends Omit<QuickJsWasmHostAdapterOptions, "recycleHeapBytes"> {
  /** The plugin modules registered in every sandbox. */
  plugins?: readonly WasmPluginModule[];
  /** The most characters a run's answer may hold (`outcome.tooLarge`). Default 8 MiB. */
  maxResultLength?: number;
  /** How the request may nest and how long it may be, as for the program host. */
  maxRequestDepth?: number;
  maxRequestLength?: number;
}

/**
 * The sandbox on the calling thread, a fresh one for every call: what a Node server gets from
 * `createQuickJsValidator({ worker: false })`. Each call (a run, an inspect, the scaled budget's
 * `inspect` question, the ABI probe) is given a sandbox built for it over a WebAssembly instance
 * of the engine of its own, and the sandbox is disposed when the call ends. Nothing one call did
 * can reach the next, as on the worker host; what this host lacks is the worker's second clock, so
 * a long native call holds the thread until it returns. Calls do not queue: each builds its own
 * sandbox, and the synchronous part of a call cannot interleave with another's.
 *
 * A job a call left queued is not dropped with its sandbox here, as the worker drops it: the
 * program host settles queued jobs under the call's own deadline, and `dispose` runs what is left
 * for up to 250 ms more before freeing the runtime. A plugin that queues a spinning job therefore
 * holds the calling thread for the whole budget and that grace, which only the worker avoids. A
 * runtime a host-side error poisoned is the one dropped whole, here as there, since freeing it
 * aborts the instance; that call fails as `runtime_error` with the error's own text.
 *
 * `create` builds one sandbox to prove the program and the plugin modules load, and that sandbox
 * serves the first call (the ABI probe, when there is one); every later call builds its own, about
 * 60 ms of the calling thread for the 600 KB program. The scaled budgets are remembered here by a
 * hash of the definition, so only the first run of a definition asks its own `inspect` question.
 */
export class QuickJsFreshSandboxHost {
  public readonly limits: QuickJsProgramLimits;

  private readonly adapter: QuickJsWasmHostAdapter;
  private readonly maxEvalMs: number | undefined;
  private readonly maxStartupMs: number;
  private readonly budgets = new DefinitionBudgets();
  /** The sandbox `create` built and no call has run in yet; taken (and cleared) by the first call. */
  private prepared: SandboxInstance | undefined;
  private disposed = false;
  private lastHeapBytes: number | undefined;

  private constructor(
    private readonly plugins: readonly WasmPluginModule[],
    options: QuickJsFreshSandboxHostOptions
  ) {
    const { maxResultLength, maxRequestDepth, maxRequestLength } = options;
    // The adapter reads its own options and ignores the rest.
    this.adapter = new QuickJsWasmHostAdapter(options);
    this.maxEvalMs = options.maxEvalMs;
    this.maxStartupMs = options.maxStartupMs ?? DEFAULT_STARTUP_MS;
    this.limits = {
      ...VALIDATION_PROFILE,
      ...(options.maxEvalMs !== undefined ? { maxEvalMs: options.maxEvalMs } : {}),
      ...(options.memoryLimitBytes !== undefined ? { memoryLimitBytes: options.memoryLimitBytes } : {}),
      ...(options.maxStackSizeBytes !== undefined ? { maxStackSizeBytes: options.maxStackSizeBytes } : {}),
      ...(maxResultLength !== undefined ? { maxResultLength } : {}),
      ...(maxRequestDepth !== undefined ? { maxRequestDepth } : {}),
      ...(maxRequestLength !== undefined ? { maxRequestLength } : {})
    };
  }

  /**
   * Builds the first sandbox, so a program or plugin that does not load fails here; a program
   * handed in as text then answers the ABI probe (`abi_mismatch` otherwise), in that sandbox.
   */
  public static async create(options: QuickJsFreshSandboxHostOptions = {}): Promise<QuickJsFreshSandboxHost> {
    const host = new QuickJsFreshSandboxHost(options.plugins ?? [], options);
    host.prepared = await host.build();
    if (options.program !== undefined && options.checkProgramAbi !== false) {
      let reply: { text: string } | { error: unknown };
      try {
        reply = { text: await host.once("__datum_inspect", abiProbeRequest(WASM_ABI_VERSION), host.maxStartupMs, Infinity) };
      } catch (error) {
        reply = { error };
      }
      try {
        proveProgramAbi(() => {
          if ("error" in reply) {
            throw reply.error;
          }
          return reply.text;
        }, WASM_ABI_VERSION);
      } catch (error) {
        host.dispose();
        throw error;
      }
    }
    return host;
  }

  /**
   * The WASM memory of the sandbox that ran the last call, as it stood when the call ended
   * (undefined before one, or when it does not show it), as {@link QuickJsWorkerHost.heapBytes}.
   * Every call's own instance starts at the engine's initial size, so a value far above it after a
   * call that grew memory, followed by the initial size after the next, shows no memory is shared.
   */
  public get heapBytes(): number | undefined {
    return this.lastHeapBytes;
  }

  /** One evaluation in a fresh sandbox: serialized context in, payload out. */
  public run(serializedContext: string): Promise<string> {
    return this.call("__datum_run", serializedContext);
  }

  /** One question about a definition in a fresh sandbox: serialized request in, canonical JSON answer out. */
  public inspect(serializedRequest: string): Promise<string> {
    return this.call("__datum_inspect", serializedRequest);
  }

  /** Calls a global of the sandbox program with one string, in a sandbox built for this call; budgets as the worker host's. */
  public async call(entry: string, argument: string): Promise<string> {
    if (this.disposed) {
      throw new QuickJsExecutionError("runtime_error", "The sandbox host was disposed");
    }
    // Refused before a sandbox is built for it.
    assertRequestWithinLimits(argument, this.limits);
    const resultCap = entry === "__datum_inspect" ? Infinity : this.limits.maxResultLength ?? Infinity;
    const budget =
      this.maxEvalMs ??
      (entry === "__datum_run"
        ? withRequestSize(await this.budgets.forRun(argument, (request) => this.once("__datum_inspect", request, this.maxStartupMs, Infinity)), argument)
        : entry === "__datum_inspect"
          ? inspectBudget(argument)
          : VALIDATION_PROFILE.maxEvalMs);
    return this.once(entry, argument, budget, resultCap);
  }

  public dispose(): void {
    this.disposed = true;
    const prepared = this.prepared;
    this.prepared = undefined;
    prepared?.host.dispose();
  }

  private build(): Promise<SandboxInstance> {
    return this.adapter.instantiateSandbox(this.plugins, { ownModule: true, preparedCache: false });
  }

  /** One call in one sandbox: the prepared one if no call has taken it yet, else one built now; disposed when the call ends. */
  private async once(entry: string, argument: string, maxEvalMs: number, resultCap: number): Promise<string> {
    let sandbox = this.prepared;
    this.prepared = undefined;
    sandbox ??= await this.build();
    try {
      if (this.disposed) {
        throw new QuickJsExecutionError("runtime_error", "The sandbox host was disposed");
      }
      const { limits } = sandbox.host;
      limits.maxEvalMs = maxEvalMs;
      limits.maxRequestDepth = this.limits.maxRequestDepth;
      limits.maxRequestLength = this.limits.maxRequestLength;
      try {
        return sandbox.host.call(entry, argument, resultCap);
      } finally {
        this.lastHeapBytes = sandbox.host.moduleHeapBytes();
      }
    } catch (error) {
      // The sandbox of a poisoned call is dropped below, so the advice to replace the host does not apply here.
      if (error instanceof QuickJsExecutionError && error.message.endsWith(ABANDONED_ADVICE)) {
        throw new QuickJsExecutionError(error.code, error.message.slice(0, -ABANDONED_ADVICE.length));
      }
      throw error;
    } finally {
      // A poisoned runtime is left allocated by `dispose` and goes with its instance; one that will
      // not free cleanly is dropped as it is, and never changes the call's answer.
      try {
        sandbox.host.dispose();
      } catch {
        // dropped
      }
    }
  }
}

/** Starts a {@link QuickJsFreshSandboxHost}: a fresh sandbox per call, on the calling thread. */
export function createQuickJsFreshSandboxHost(options: QuickJsFreshSandboxHostOptions = {}): Promise<QuickJsFreshSandboxHost> {
  return QuickJsFreshSandboxHost.create(options);
}
