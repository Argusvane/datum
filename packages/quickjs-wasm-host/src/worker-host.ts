import { Worker } from "node:worker_threads";
import { isSourcePlugin, WASM_ABI_VERSION, type WasmPluginModule } from "@argusvane/datum-engine";

import { DEFAULT_STARTUP_MS, DefinitionBudgets, abiProbeRequest, inspectBudget, proveProgramAbi, withRequestSize } from "./quickjs-wasm-host-adapter.js";
import { QuickJsExecutionError, VALIDATION_PROFILE, assertRequestWithinLimits, toExecutionError, type QuickJsExecutionErrorCode, type QuickJsProgramLimits } from "./program-host.js";
import { FREEZE_INTRINSICS_SNIPPET, SANDBOX_ENTRY_POINTS, buildSandboxProgram, toSourcePlugin } from "./sandbox-program.js";

/**
 * The sandbox for a Node server: every call in a fresh sandbox, on a thread of its own.
 *
 * **A sandbox per call.** A sandbox is a new WebAssembly instance of the engine (its own linear
 * memory), a QuickJS runtime and context in it, the sandbox program evaluated, its entry points
 * captured before the freeze and before any plugin, and the plugin modules registered. It serves
 * exactly one call, a run or an inspect alike (the scaled budget's `inspect` question and the
 * ABI probe at `create` included), and is then thrown away. Nothing one submission's run did
 * (a global it defined, state a plugin module kept, memory it grew) can reach the next one, which
 * is the property the other server hosts give each run with a fresh instance. The worker marks
 * every memory a call was handed and refuses to run a call in one it has seen; the host sends a
 * call only after the worker said a fresh sandbox is ready, and forgets that readiness as it sends.
 *
 * **Built ahead.** Evaluating the program is most of a sandbox's cost (about 75 ms for the
 * 600 KB program; the new WebAssembly instance about 8 ms more). So a lone request does not pay
 * it, the worker builds the next sandbox as soon as a call's answer is posted and says `ready`;
 * calls back to back wait for each build in turn. A build that fails (a startup budget passed on
 * a loaded machine, say) fails the call that was waiting for it, typed as a startup failure is,
 * and the thread is replaced, so the call after it gets a new worker.
 *
 * **On its own thread.** The deadline inside the sandbox is a QuickJS interrupt handler, polled
 * every few thousand VM operations, so a call into native code that runs long (a `split` of a
 * megabyte string, a `repeat`) is not interrupted until it returns. Here the host keeps a second
 * clock: past `maxEvalMs` plus `killSlackMs` the worker is terminated (V8 stops WebAssembly at the
 * next loop edge), the caller gets `interrupted`, and the next call starts a new worker. A new
 * thread costs about 230 ms before its first sandbox is ready, which is why the thread is kept
 * and only the sandbox is per call. The browser keeps the synchronous adapter and its reused
 * sandbox; this is Node only, which is why it is its own entry point
 * (`@argusvane/datum-quickjs-wasm-host/worker`) and not part of the package's main one.
 *
 * **One worker, one queue.** Calls run one at a time, first in first out, for every form: a slow
 * call delays the ones behind it, and a call that has to be killed costs about 0.75 s plus a new
 * thread before the next one runs. A filler who can make a call run into the kill (a
 * native-heavy answer) therefore slows the whole service while they keep sending. The queue is
 * unbounded and each queued call holds its request string (up to `maxRequestLength`), so a host
 * puts its own admission limit (a request rate, a queue depth) in front of it.
 *
 * **Memory.** A call's WASM memory is bounded three ways: `memoryLimitBytes` (QuickJS objects, not
 * string data), `maxWasmHeapBytes` (the instance's whole memory, checked at every interrupt poll,
 * which ends the call as `interrupted`) and `maxOldGenerationSizeMb` (the V8 heap of the thread,
 * past which Node terminates the worker). Whatever a call grew is let go with its instance.
 */
export interface QuickJsWorkerHostOptions {
  /** The plugin modules registered in every sandbox, as the synchronous adapter takes them. */
  plugins?: readonly WasmPluginModule[];
  /** The sandbox program's text; left out, the one built from the engine's source. */
  program?: string;
  /** Prove a `program` handed in answers for this host's ABI before it judges anything, as the synchronous adapter does. Default true. */
  checkProgramAbi?: boolean;
  /**
   * Wall-clock budget per call. Set, it is used as given; left out, a run's budget scales with the
   * definition and the request exactly as the synchronous adapter's does (250 ms, 5 per rule read,
   * 1 per KB of definition, 2 per KB of the request, at most 5,000), and an inspect request's too.
   */
  maxEvalMs?: number;
  /** Budget for building a sandbox (the program and the plugin modules), and for the scaled budget's inspect question and the ABI probe. Default 2000. */
  maxStartupMs?: number;
  /** QuickJS runtime memory limit in bytes. Default 32 MiB. */
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  /** The most characters an answer may hold (`outcome.tooLarge`). Default 8 MiB. */
  maxResultLength?: number;
  /** How the request may nest and how long it may be, as for the program host. */
  maxRequestDepth?: number;
  maxRequestLength?: number;
  /**
   * How long past `maxEvalMs` the worker may run before it is terminated. The interrupt handler
   * ends most runs at the budget; this is for a native call that does not poll. Default 500.
   */
  killSlackMs?: number;
  /** How long the host waits for a sandbox to be ready (a new worker's first one included) before it gives the worker up. Default 15,000. */
  bootTimeoutMs?: number;
  /**
   * WASM memory past which a running call is interrupted (`interrupted`): checked at every
   * interrupt poll, so it stops growth made of many small steps, not one huge native allocation.
   * Default 512 MiB.
   */
  maxWasmHeapBytes?: number;
  /**
   * The V8 old-generation heap of the worker thread, in MiB (`resourceLimits`): past it Node
   * terminates the worker, which the host replaces, instead of the process growing. Default 512.
   */
  maxOldGenerationSizeMb?: number;
  /** Freeze the kernel's globals and the intrinsics before the plugins load, as the synchronous adapter does. Default true. */
  freezeIntrinsics?: boolean;
}

interface Pending {
  id: number;
  resolve(value: string): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

/** The sandbox the worker is building: settles when it says `ready`, or with the error that ended the wait. */
interface Building {
  promise: Promise<void>;
  settle(error?: unknown): void;
}

interface WorkerFailure {
  code?: QuickJsExecutionErrorCode;
  message?: string;
  detail?: { name: string; message: string };
  plugin?: string;
}

/** The default for {@link QuickJsWorkerHostOptions.maxWasmHeapBytes}: 512 MiB. */
export const DEFAULT_MAX_WASM_HEAP_BYTES = 512 * 1024 * 1024;
/** The default for {@link QuickJsWorkerHostOptions.maxOldGenerationSizeMb}. */
export const DEFAULT_MAX_OLD_GENERATION_MB = 512;

const WORKER_FILE = new URL("./worker/quickjs-worker.mjs", import.meta.url);

/** An error from a worker's failure message, typed the way the synchronous host types it. */
function failureError(failure: WorkerFailure, fallback: QuickJsExecutionErrorCode): QuickJsExecutionError {
  const typed =
    failure.detail !== undefined
      ? toExecutionError(failure.detail, failure.code ?? fallback)
      : new QuickJsExecutionError(failure.code ?? fallback, failure.message ?? "The sandbox worker failed");
  return failure.plugin !== undefined ? new QuickJsExecutionError(typed.code, `Plugin "${failure.plugin}": ${typed.message}`) : typed;
}

export class QuickJsWorkerHost {
  public readonly limits: QuickJsProgramLimits;

  private readonly program: string;
  private readonly plugins: Array<{ id: string; source: string }>;
  private readonly maxEvalMs: number | undefined;
  private readonly maxStartupMs: number;
  private readonly killSlackMs: number;
  private readonly bootTimeoutMs: number;
  private readonly freezeIntrinsics: boolean;
  private readonly maxWasmHeapBytes: number;
  private readonly maxOldGenerationSizeMb: number;

  private worker: Worker | undefined;
  /** The worker holds a sandbox no call has run in. Set by its `ready`, cleared as a call is sent. */
  private sandboxReady = false;
  /** The wait for the worker's next sandbox, while it builds one. */
  private building: Building | undefined;
  private pending: Pending | undefined;
  private lastHeapBytes: number | undefined;
  private nextId = 1;
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private killCount = 0;
  private startCount = 0;
  private readonly budgets = new DefinitionBudgets();

  private constructor(options: QuickJsWorkerHostOptions) {
    this.limits = {
      ...VALIDATION_PROFILE,
      ...(options.maxEvalMs !== undefined ? { maxEvalMs: options.maxEvalMs } : {}),
      ...(options.memoryLimitBytes !== undefined ? { memoryLimitBytes: options.memoryLimitBytes } : {}),
      ...(options.maxStackSizeBytes !== undefined ? { maxStackSizeBytes: options.maxStackSizeBytes } : {}),
      ...(options.maxResultLength !== undefined ? { maxResultLength: options.maxResultLength } : {}),
      ...(options.maxRequestDepth !== undefined ? { maxRequestDepth: options.maxRequestDepth } : {}),
      ...(options.maxRequestLength !== undefined ? { maxRequestLength: options.maxRequestLength } : {})
    };
    this.program = options.program ?? buildSandboxProgram();
    this.plugins = (options.plugins ?? []).map((plugin) => {
      const source = isSourcePlugin(plugin) ? plugin : toSourcePlugin(plugin);
      return { id: source.id, source: source.source };
    });
    this.maxEvalMs = options.maxEvalMs;
    this.maxStartupMs = options.maxStartupMs ?? DEFAULT_STARTUP_MS;
    this.killSlackMs = options.killSlackMs ?? 500;
    this.bootTimeoutMs = options.bootTimeoutMs ?? 15_000;
    this.freezeIntrinsics = options.freezeIntrinsics !== false;
    this.maxWasmHeapBytes = options.maxWasmHeapBytes ?? DEFAULT_MAX_WASM_HEAP_BYTES;
    this.maxOldGenerationSizeMb = options.maxOldGenerationSizeMb ?? DEFAULT_MAX_OLD_GENERATION_MB;
  }

  /**
   * Starts the worker and waits for its first sandbox, so a program or plugin that does not load
   * fails here, not on the first call. A program handed in as text answers for the ABI this host
   * speaks before it judges anything (`abi_mismatch` otherwise): it may be a file left over from
   * an older build. The probe runs in a sandbox of its own, like every call.
   */
  public static async create(options: QuickJsWorkerHostOptions = {}): Promise<QuickJsWorkerHost> {
    const host = new QuickJsWorkerHost(options);
    try {
      await host.ensureSandbox();
      if (options.program !== undefined && options.checkProgramAbi !== false) {
        let reply: { text: string } | { error: unknown };
        try {
          reply = { text: await host.send("__datum_inspect", abiProbeRequest(WASM_ABI_VERSION), host.maxStartupMs, Infinity) };
        } catch (error) {
          reply = { error };
        }
        proveProgramAbi(() => {
          if ("error" in reply) {
            throw reply.error;
          }
          return reply.text;
        }, WASM_ABI_VERSION);
      }
    } catch (error) {
      await host.dispose();
      throw error;
    }
    return host;
  }

  /** How many workers were terminated for passing their deadline. */
  public get kills(): number {
    return this.killCount;
  }

  /** How many worker threads were started, the first included. */
  public get starts(): number {
    return this.startCount;
  }

  /** The WASM memory of the sandbox that ran the last call, as it stood when the call ended (undefined before one, or when it does not show it). */
  public get heapBytes(): number | undefined {
    return this.lastHeapBytes;
  }

  /**
   * One evaluation: serialized context in, payload out. Calls queue; one runs at a time. With no
   * `maxEvalMs` set, the budget scales with the definition the context carries.
   */
  public run(serializedContext: string): Promise<string> {
    return this.call("__datum_run", serializedContext);
  }

  /** One question about a definition: serialized request in, canonical JSON answer out. */
  public inspect(serializedRequest: string): Promise<string> {
    return this.call("__datum_inspect", serializedRequest);
  }

  /**
   * Calls a global of the sandbox program with one string and answers its string result;
   * `QuickJsProgramHost.call`'s contract, asynchronously, in a fresh sandbox. Rejects with a
   * {@link QuickJsExecutionError}: `interrupted` past the deadline (the worker was terminated if it
   * did not stop itself), `request_refused` before the request is sent, `outcome_too_large` for an
   * answer past the cap.
   */
  public call(entry: string, argument: string): Promise<string> {
    const run = this.tail.then(() => this.dispatch(entry, argument));
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Stops the worker. Calls in flight and queued reject; the host cannot be used again. */
  public async dispose(): Promise<void> {
    this.disposed = true;
    this.stopWorker(new QuickJsExecutionError("runtime_error", "The sandbox worker host was disposed"));
    await this.tail.catch(() => undefined);
  }

  private async dispatch(entry: string, argument: string): Promise<string> {
    if (this.disposed) {
      throw new QuickJsExecutionError("runtime_error", "The sandbox worker host was disposed");
    }
    assertRequestWithinLimits(argument, this.limits);
    const resultCap = entry === "__datum_inspect" ? Infinity : this.limits.maxResultLength ?? Infinity;
    const budget =
      this.maxEvalMs ??
      (entry === "__datum_run"
        ? withRequestSize(await this.budgets.forRun(argument, (request) => this.send("__datum_inspect", request, this.maxStartupMs, Infinity)), argument)
        : entry === "__datum_inspect"
          ? inspectBudget(argument)
          : VALIDATION_PROFILE.maxEvalMs);
    return this.send(entry, argument, budget, resultCap);
  }

  /**
   * Waits for a fresh sandbox, then posts one call to the worker and waits for its answer, with the
   * host's own clock beside the worker's. The sandbox is spent as the call is sent.
   */
  private async send(entry: string, argument: string, maxEvalMs: number, resultCap: number): Promise<string> {
    await this.ensureSandbox();
    const worker = this.worker;
    if (worker === undefined || !this.sandboxReady) {
      throw new QuickJsExecutionError("runtime_error", "The sandbox worker has no fresh sandbox ready");
    }
    this.sandboxReady = false;
    return new Promise<string>((resolve, reject) => {
      const id = this.nextId++;
      worker.ref();
      const timer = setTimeout(() => {
        this.killCount += 1;
        this.stopWorker(
          new QuickJsExecutionError("interrupted", `Sandbox evaluation interrupted: the worker passed its ${maxEvalMs} ms deadline by ${this.killSlackMs} ms (a native call the interrupt handler cannot reach) and was terminated`)
        );
      }, maxEvalMs + this.killSlackMs);
      this.pending = { id, resolve, reject, timer };
      worker.postMessage({ type: "call", id, entry, argument, maxEvalMs, resultCap });
    });
  }

  /** Resolves once the worker holds a fresh sandbox: starts a worker when none runs, and otherwise waits for the one it is building. */
  private async ensureSandbox(): Promise<void> {
    if (this.disposed) {
      throw new QuickJsExecutionError("runtime_error", "The sandbox worker host was disposed");
    }
    if (this.worker === undefined) {
      this.startWorker();
    }
    if (this.sandboxReady) {
      return;
    }
    const building = this.building;
    if (building === undefined) {
      throw new QuickJsExecutionError("runtime_error", "The sandbox worker is building no sandbox");
    }
    // Held while a call waits, so the process does not exit under it; let go again once the sandbox is there.
    const worker = this.worker;
    worker?.ref();
    try {
      await building.promise;
    } finally {
      if (this.pending === undefined) {
        worker?.unref();
      }
    }
  }

  /**
   * The wait for the worker's next sandbox, with the boot timeout as its clock. Nothing may be
   * awaiting it (a build after a call, before the next call comes), so its rejection is marked
   * handled here and seen by the next {@link ensureSandbox}.
   */
  private expectSandbox(worker: Worker): void {
    let settle!: (error?: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settle(new QuickJsExecutionError("interrupted", `The sandbox worker did not have a sandbox ready within ${this.bootTimeoutMs} ms`));
        this.stopWorker(undefined);
      }, this.bootTimeoutMs);
      timer.unref();
      settle = (error?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (this.building?.settle === settle) {
          this.building = undefined;
        }
        if (error !== undefined) {
          reject(error);
        } else {
          resolve();
        }
      };
    });
    promise.catch(() => undefined);
    if (worker === this.worker) {
      this.building = { promise, settle };
    }
  }

  /** Starts a worker; it builds its first sandbox at once and says `ready`. */
  private startWorker(): void {
    const steps = [
      // A sandbox serves one call and never sees a definition twice, so the program's
      // prepared-definition cache is sized to nothing (it reads the number as it starts; a program
      // that keeps the cache on its global, a shipped older one, is bounded after it loads).
      { label: "sandbox-cache-bound", code: "globalThis.__datum_cache_chars = 0;" },
      { label: "sandbox-program", code: this.program },
      { label: "sandbox-cache-bound", code: 'if (typeof __datum_prepared !== "undefined") { __datum_prepared.maxChars = 0; }' },
      ...(this.freezeIntrinsics ? [{ label: "sandbox-freeze", code: FREEZE_INTRINSICS_SNIPPET }] : [])
    ];
    const worker = new Worker(WORKER_FILE, {
      workerData: {
        steps,
        entryPoints: SANDBOX_ENTRY_POINTS,
        plugins: this.plugins,
        limits: { memoryLimitBytes: this.limits.memoryLimitBytes, maxStackSizeBytes: this.limits.maxStackSizeBytes, maxStartupMs: this.maxStartupMs, maxWasmHeapBytes: this.maxWasmHeapBytes }
      },
      resourceLimits: { maxOldGenerationSizeMb: this.maxOldGenerationSizeMb },
      execArgv: []
    });
    this.startCount += 1;
    this.worker = worker;
    this.sandboxReady = false;
    this.lastHeapBytes = undefined;
    this.expectSandbox(worker);
    worker.on("message", (message: { type: string; id?: number; value?: string; heapBytes?: number; replace?: boolean } & WorkerFailure) => {
      if (worker !== this.worker) {
        return;
      }
      if (message.type === "ready") {
        this.sandboxReady = true;
        this.building?.settle();
        return;
      }
      if (message.type === "failed") {
        // A sandbox that would not build, at boot or after a call: the thread goes, and the next call starts a new one.
        this.building?.settle(failureError(message, "compile_error"));
        this.stopWorker(undefined);
        return;
      }
      const pending = this.pending;
      if (pending === undefined || pending.id !== message.id) {
        return;
      }
      this.pending = undefined;
      clearTimeout(pending.timer);
      worker.unref();
      this.lastHeapBytes = message.heapBytes;
      if (message.replace === true) {
        // The worker had no fresh sandbox for the call and builds none next: the thread goes, and the next call starts a new one.
        pending.reject(failureError(message, "runtime_error"));
        this.stopWorker(undefined);
        return;
      }
      // The worker is now building the next sandbox.
      this.expectSandbox(worker);
      if (message.type === "result") {
        pending.resolve(message.value as string);
        return;
      }
      pending.reject(failureError(message, "runtime_error"));
    });
    worker.on("error", (error) => {
      if (worker !== this.worker) {
        return;
      }
      this.stopWorker(new QuickJsExecutionError("runtime_error", `The sandbox worker failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    worker.on("exit", () => {
      if (worker !== this.worker) {
        return;
      }
      this.stopWorker(new QuickJsExecutionError("runtime_error", "The sandbox worker exited"));
    });
  }

  /** Ends the current worker (a new one starts on the next call) and fails the call it was running, and any wait for its sandbox, with `reason`. */
  private stopWorker(reason: QuickJsExecutionError | undefined): void {
    const worker = this.worker;
    this.worker = undefined;
    this.sandboxReady = false;
    const fallback = reason ?? new QuickJsExecutionError("runtime_error", "The sandbox worker was replaced");
    const building = this.building;
    this.building = undefined;
    building?.settle(fallback);
    const pending = this.pending;
    this.pending = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(fallback);
    }
    if (worker !== undefined) {
      void worker.terminate();
    }
  }
}

/** Starts a {@link QuickJsWorkerHost}: a fresh sandbox per call, on its own thread, killable at its deadline. */
export function createQuickJsWorkerHost(options: QuickJsWorkerHostOptions = {}): Promise<QuickJsWorkerHost> {
  return QuickJsWorkerHost.create(options);
}
