import { createHash } from "node:crypto";

import { JsonWasmAbi, WasmValidationHost, type WasmPluginModule } from "@argusvane/datum-engine";
import { QuickJsExecutionError, QuickJsWasmHostAdapter, loadQuickJs } from "@argusvane/datum-quickjs-wasm-host";

import type { Json, Observation, ObservedError, ObservedLog, RefusalKind } from "../../observation.js";
import type { PluginSource } from "../../vectors/schema.js";
import type { QjsWasiModule } from "./qjs-wasi.js";
import { QjsWasiHost } from "./qjs-wasi-host.js";

export interface SessionOptions {
  /** The program's source text; the suite never builds one itself. */
  program: string;
  plugins?: PluginSource[];
  /** Fixed evaluation budget; left out, the adapter's scaled default (250 ms and up) applies. */
  maxEvalMs?: number;
  memoryLimitBytes?: number;
  /** The synchronous adapter's heap recycle threshold; the worker host has none (no sandbox there outlives its call). */
  recycleHeapBytes?: number;
  /**
   * `worker`: the Node server's host (`@argusvane/datum-quickjs-wasm-host/worker`, Node only): a fresh
   * sandbox per call, on its own thread, with the host's second clock. Left out: the synchronous
   * adapter and its reused sandbox, which is what a browser stands for.
   */
  host?: "sync" | "worker";
  /** False runs the synchronous adapter without its freeze of the kernel and the intrinsics (a negative control for ISO-04; hosts freeze). Default true. */
  freezeIntrinsics?: boolean;
  /**
   * The server hosts' engine (`qjs-wasi.wasm`, checked against its pin): every call is a guest run of its own, as on
   * the FastAPI and Spring Boot hosts, and `host` and `recycleHeapBytes` do not apply. Left out: quickjs-emscripten,
   * the engine of the browser and Node hosts.
   */
  engine?: QjsWasiModule;
}

/** What every host gives a session: a run and an inspect over text, the worker's and the guest's asynchronously. */
interface HostInstance {
  run(text: string): string | Promise<string>;
  inspect?(text: string): string | Promise<string>;
  dispose?(): void | Promise<void>;
  /** The evaluation time of the last call, when the host measures it apart from its own start (the qjs-wasi guest). */
  readonly lastEvalMs?: number | undefined;
}

interface WorkerModule {
  createQuickJsWorkerHost(options: Record<string, unknown>): Promise<HostInstance>;
}

let workerModule: Promise<WorkerModule | undefined> | undefined;

/**
 * The worker host, or undefined when this build cannot reach it: the bundled command line keeps
 * `@argusvane/datum-quickjs-wasm-host/worker` external (its thread body is a file beside the package, which a
 * single-file bundle does not carry), so it is found only where the repository's packages are installed.
 */
export function loadWorkerModule(): Promise<WorkerModule | undefined> {
  workerModule ??= import("@argusvane/datum-quickjs-wasm-host/worker").then(
    (module) => module as unknown as WorkerModule,
    () => undefined
  );
  return workerModule;
}

export class StartupError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StartupError";
    this.code = code;
  }
}

export interface RunOutput {
  observation: Observation;
  elapsedMs: number;
  /** The outcome text the program returned, when it returned one. */
  text?: string;
}

/**
 * One host over a program file: the synchronous adapter (its scaled budget, heap recycler and
 * typed errors) or the worker host (the same budgets and errors, a fresh sandbox per call), and
 * nothing else. Every result is normalised to an {@link Observation}; a typed sandbox
 * failure becomes a refusal, never an exception, so a hostile vector cannot take the runner down.
 */
export class ProgramSession {
  /** The WASM module this session started over; a heap recycle replaces it (RES-04 reads {@link moduleSwapped}). */
  private readonly moduleAtOpen: unknown = loadQuickJs();

  private constructor(private readonly instance: HostInstance, public readonly abi: JsonWasmAbi) {}

  /** True once the shared QuickJS module was dropped and rebuilt since this session opened (the heap recycler fired). */
  public moduleSwapped(): boolean {
    return loadQuickJs() !== this.moduleAtOpen;
  }

  public static async open(options: SessionOptions): Promise<ProgramSession> {
    if (options.engine !== undefined) {
      return ProgramSession.openQjsWasi(options, options.engine);
    }
    if (options.host === "worker") {
      return ProgramSession.openWorker(options);
    }
    // The suite runs stale and mutant programs on purpose and reports on their ABI itself, so
    // the host's own proof that a program speaks its ABI would refuse them before any row ran.
    const adapter = new QuickJsWasmHostAdapter({
      program: options.program,
      checkProgramAbi: false,
      ...(options.maxEvalMs !== undefined ? { maxEvalMs: options.maxEvalMs } : {}),
      ...(options.memoryLimitBytes !== undefined ? { memoryLimitBytes: options.memoryLimitBytes } : {}),
      ...(options.recycleHeapBytes !== undefined ? { recycleHeapBytes: options.recycleHeapBytes } : {}),
      ...(options.freezeIntrinsics === false ? { freezeIntrinsics: false } : {})
    });
    const abi = new JsonWasmAbi();
    try {
      const instance = await adapter.instantiate((options.plugins ?? []) as WasmPluginModule[], abi);
      return new ProgramSession(instance, abi);
    } catch (error) {
      if (error instanceof QuickJsExecutionError) {
        throw new StartupError(error.code, error.message);
      }
      throw new StartupError("runtime_error", error instanceof Error ? error.message : String(error));
    }
  }

  private static async openWorker(options: SessionOptions): Promise<ProgramSession> {
    const module = await loadWorkerModule();
    if (module === undefined) {
      throw new StartupError("worker_unavailable", "the Node worker host (@argusvane/datum-quickjs-wasm-host/worker) is not available in this build");
    }
    try {
      const host = await module.createQuickJsWorkerHost({
        program: options.program,
        checkProgramAbi: false,
        plugins: options.plugins ?? [],
        ...(options.maxEvalMs !== undefined ? { maxEvalMs: options.maxEvalMs } : {}),
        ...(options.memoryLimitBytes !== undefined ? { memoryLimitBytes: options.memoryLimitBytes } : {}),
        ...(options.freezeIntrinsics === false ? { freezeIntrinsics: false } : {})
      });
      return new ProgramSession(host, new JsonWasmAbi());
    } catch (error) {
      if (error instanceof QuickJsExecutionError) {
        throw new StartupError(error.code, error.message);
      }
      throw new StartupError("runtime_error", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The server hosts' engine: one guest per call. Building the host proves the program loads and every module registers,
   * so a module that is not one stops the sandbox from starting here too.
   */
  private static async openQjsWasi(options: SessionOptions, engine: QjsWasiModule): Promise<ProgramSession> {
    try {
      const host = await QjsWasiHost.create({
        module: engine,
        program: options.program,
        plugins: options.plugins ?? [],
        ...(options.maxEvalMs !== undefined ? { maxEvalMs: options.maxEvalMs } : {}),
        ...(options.memoryLimitBytes !== undefined ? { memoryLimitBytes: options.memoryLimitBytes } : {}),
        ...(options.freezeIntrinsics === false ? { freezeIntrinsics: false } : {})
      });
      return new ProgramSession(host, new JsonWasmAbi());
    } catch (error) {
      if (error instanceof QuickJsExecutionError) {
        throw new StartupError(error.code, error.message);
      }
      throw new StartupError("runtime_error", error instanceof Error ? error.message : String(error));
    }
  }

  /** A call's time: the evaluation alone when the host measures it, else the whole call. */
  private elapsedSince(started: number): number {
    return this.instance.lastEvalMs ?? performance.now() - started;
  }

  /** Serializes a context the way every host does (stable keys, extras dropped). */
  public serialize(context: Record<string, unknown>): string {
    return this.abi.serializeContext(context as never, WasmValidationHost.STRICT_POLICY);
  }

  /** One `__datum_run` over serialized context text. */
  public async run(text: string): Promise<RunOutput> {
    const started = performance.now();
    try {
      const outcome = await this.instance.run(text);
      const observation = verdictFrom(outcome);
      if (observation.kind === "verdict") {
        observation.outcome = { length: outcome.length, sha256: createHash("sha256").update(outcome, "utf8").digest("hex") };
      }
      return { observation, elapsedMs: this.elapsedSince(started), text: outcome };
    } catch (error) {
      return { observation: refusalFrom(error), elapsedMs: this.elapsedSince(started) };
    }
  }

  /** One `__datum_inspect` over request text. */
  public async inspect(text: string): Promise<RunOutput> {
    const started = performance.now();
    try {
      if (this.instance.inspect === undefined) {
        return { observation: { kind: "refusal", refusal: "other", code: "no_inspect", detail: "the program has no inspect entry point" }, elapsedMs: this.elapsedSince(started) };
      }
      const answer = await this.instance.inspect(text);
      let json: Json;
      try {
        json = JSON.parse(answer) as Json;
      } catch {
        return { observation: { kind: "refusal", refusal: "malformed_response", detail: "the inspect answer is not JSON" }, elapsedMs: this.elapsedSince(started), text: answer };
      }
      return { observation: { kind: "answer", json }, elapsedMs: this.elapsedSince(started), text: answer };
    } catch (error) {
      return { observation: refusalFrom(error), elapsedMs: this.elapsedSince(started) };
    }
  }

  public dispose(): void {
    try {
      const done = this.instance.dispose?.();
      if (done instanceof Promise) {
        done.catch(() => undefined);
      }
    } catch {
      // A poisoned runtime is left allocated by design; nothing to do.
    }
  }
}

/** Maps what `__datum_run` returned to a verdict. */
export function verdictFrom(text: string): Observation {
  let outcome: unknown;
  try {
    outcome = JSON.parse(text);
  } catch {
    return { kind: "refusal", refusal: "malformed_response", detail: "the program's outcome is not JSON" };
  }
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
    return { kind: "refusal", refusal: "malformed_response", detail: "the program's outcome is not an object" };
  }
  const record = outcome as Record<string, unknown>;
  if (!Array.isArray(record["errors"])) {
    return { kind: "refusal", refusal: "malformed_response", detail: "the program's outcome has no errors list" };
  }
  const errors: ObservedError[] = [];
  for (const entry of record["errors"]) {
    if (entry === null || typeof entry !== "object" || typeof (entry as Record<string, unknown>)["code"] !== "string") {
      return { kind: "refusal", refusal: "malformed_response", detail: "an error entry has no string code" };
    }
    const error = entry as Record<string, unknown>;
    const field = fieldOf(error);
    errors.push({
      code: error["code"] as string,
      ...(field !== undefined ? { field } : {}),
      ...(typeof error["severity"] === "string" ? { severity: error["severity"] } : {})
    });
  }
  const logs: ObservedLog[] = [];
  if (Array.isArray(record["logs"])) {
    for (const entry of record["logs"]) {
      const log = entry as Record<string, unknown>;
      logs.push({ level: typeof log["level"] === "string" ? log["level"] : "", message: typeof log["message"] === "string" ? log["message"] : String(log["message"]) });
    }
  }
  // The host's rule: a run is accepted when nothing found has severity "error" (none means error).
  const accepted = !errors.some((error) => error.severity === undefined || error.severity === "error" || !["warning", "info"].includes(error.severity));
  return {
    kind: "verdict",
    accepted,
    errors,
    ...(record["values"] !== undefined ? { values: record["values"] as Json } : {}),
    ...(logs.length > 0 ? { logs } : {}),
    ...(typeof record["digest"] === "string" ? { digest: record["digest"] } : {}),
    ...(typeof record["canonical"] === "string" ? { canonical: record["canonical"] } : {}),
    raw: outcome as Json
  };
}

/** The field an error names: the key path the receiver's table uses (`path` for a repeating entry, else the component id). */
function fieldOf(error: Record<string, unknown>): string | undefined {
  if (typeof error["path"] === "string" && error["path"] !== "") {
    return error["path"];
  }
  if (typeof error["componentId"] === "string" && error["componentId"] !== "") {
    return error["componentId"];
  }
  return undefined;
}

/** Maps a typed sandbox failure to a refusal. */
export function refusalFrom(error: unknown): Observation {
  if (error instanceof QuickJsExecutionError) {
    const message = error.message;
    let refusal: RefusalKind = "other";
    if (error.code === "interrupted") {
      refusal = "budget";
    } else if (error.code === "request_refused") {
      refusal = /nest|deep|depth/i.test(message) ? "too_deep" : "too_large";
    } else if (error.code === "runtime_error" && /out of memory|memory/i.test(message)) {
      refusal = "budget";
    } else if (error.code === "outcome_too_large") {
      // The host's cap on what a run may write back (8 MiB): a size refusal, not a failure to answer.
      refusal = "too_large";
    }
    return { kind: "refusal", refusal, code: error.code, detail: message };
  }
  return { kind: "refusal", refusal: "other", detail: error instanceof Error ? error.message : String(error) };
}
