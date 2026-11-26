import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule
} from "quickjs-emscripten-core";

/**
 * A QuickJS runtime that evaluates one portable program and calls into it by global name —
 * the piece both the validation adapter and the PDF provider share.
 *
 * Two resource profiles: the validation one (a submission's checks are
 * milliseconds) and a document one for the PDF program (a font subset and a hundred pages
 * take seconds and real memory). The stack limit is the same in both: the singlefile build's
 * own stack is close to 1 MiB, and asking QuickJS to allow more makes every call fail.
 *
 * A call may return a promise (the PDF program's `save()` is asynchronous). `call` drains the
 * runtime's pending jobs until the promise settles, so a host — a JVM, a .NET process —
 * needs no event loop of its own: the program's timers are microtasks by construction.
 *
 * The request a call carries is bounded before it reaches the runtime (`maxRequestDepth`,
 * `maxRequestLength`). The stack QuickJS checks is not the stack the singlefile build really
 * has: a JSON value nested a few hundred levels deep overflows the WASM stack below QuickJS's
 * own check while the kernel walks it, V8 unwinds through the WASM frames, and the runtime is
 * left with a GC list `JS_FreeRuntime` asserts on. Refusing such a request up front keeps that
 * from ever starting; a host-side error that still escapes a call marks the runtime
 * {@link QuickJsProgramHost.poisoned}, and `dispose` then leaves it allocated rather than abort.
 */
export interface QuickJsProgramLimits {
  /** Wall-clock budget per evaluation or call before the interrupt handler ends it. */
  maxEvalMs: number;
  memoryLimitBytes: number;
  maxStackSizeBytes: number;
  /**
   * How deep the JSON a call carries may nest (`[`/`{` outside strings). A form's values are a
   * few levels; a definition tree spends three per layer of containers, so 320 admits over a
   * hundred layers. Measured on the singlefile build under Node: the kernel's walk
   * overflows the real WASM stack at about 420 to 450 levels for a chain of objects, 600 to 640
   * for arrays, and not before 660 for a component tree, so 320 keeps a margin under the worst
   * shape. A deeper request is refused (`request_refused`) before QuickJS sees it.
   */
  maxRequestDepth: number;
  /**
   * How long (in UTF-16 code units) the argument a call carries may be. Defaults to the memory
   * limit: a string the runtime could not hold beside its parse is refused (`request_refused`)
   * instead of failing inside.
   */
  maxRequestLength: number;
  /**
   * How long (in UTF-16 code units) the string a call returns may be. A run's outcome is the sandbox's own serialisation of what a
   * form's rules and plugins produced, and a plugin (or a hostile rule over a large answer) can
   * make it as big as the memory limit allows; a longer answer is refused (`outcome_too_large`, `outcome.tooLarge`)
   * and nothing of it is kept. Left out, no cap: the PDF program's documents are far larger.
   */
  maxResultLength?: number;
}

export const VALIDATION_PROFILE: QuickJsProgramLimits = {
  maxEvalMs: 250,
  memoryLimitBytes: 32 * 1024 * 1024,
  maxStackSizeBytes: 1024 * 1024,
  maxRequestDepth: 320,
  maxRequestLength: 32 * 1024 * 1024,
  maxResultLength: 8 * 1024 * 1024
};

export const DOCUMENT_PROFILE: QuickJsProgramLimits = {
  maxEvalMs: 15_000,
  memoryLimitBytes: 256 * 1024 * 1024,
  maxStackSizeBytes: 1024 * 1024,
  maxRequestDepth: 320,
  maxRequestLength: 256 * 1024 * 1024
};

export type QuickJsExecutionErrorCode =
  | "compile_error"
  | "not_a_module"
  | "interrupted"
  | "runtime_error"
  | "never_settles"
  /** The call's argument was refused before the runtime saw it: nested or long past the limits. */
  | "request_refused"
  /** The call's answer was longer than the profile's `maxResultLength` (`outcome.tooLarge`): the run is refused and nothing of the answer is kept. */
  | "outcome_too_large"
  /** A program handed to the host did not answer for the ABI the host speaks (an older build): it judges nothing. */
  | "abi_mismatch";

/** A typed sandbox failure: what went wrong, in terms a host can branch on. */
export class QuickJsExecutionError extends Error {
  public readonly code: QuickJsExecutionErrorCode;

  constructor(code: QuickJsExecutionErrorCode, message: string) {
    super(message);
    this.name = "QuickJsExecutionError";
    this.code = code;
  }
}

/**
 * The hardening prelude: no ambient authority exists in QuickJS by construction, and what it
 * does provide that determinism forbids is disabled here. Evaluated before the program.
 */
export const HARDENING_PRELUDE = [
  '"use strict";',
  "(function () {",
  '  Math.random = function () { throw new Error("Math.random is disabled in the sandbox"); };',
  '  var ThrowingDate = function () { throw new Error("Date is disabled in the sandbox"); };',
  '  ThrowingDate.now = function () { throw new Error("Date.now is disabled in the sandbox"); };',
  "  globalThis.Date = ThrowingDate;",
  "})();"
].join("\n");

/** The QuickJS module is one WASM binary per process: loaded once, shared by every runtime. */
let quickJsModule: Promise<QuickJSWASMModule> | undefined;

export function loadQuickJs(): Promise<QuickJSWASMModule> {
  quickJsModule ??= loadOwnQuickJs();
  return quickJsModule;
}

/**
 * A new WebAssembly instance of the engine, shared with nothing: each call runs the variant's
 * Emscripten loader again, which creates its own `WebAssembly.Memory`.
 */
export function loadOwnQuickJs(): Promise<QuickJSWASMModule> {
  return newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-singlefile-mjs-release-sync"));
}

/** The module promise each host was created over, so a recycle drops the shared one only if it is still that one. */
const hostModules = new WeakMap<QuickJsProgramHost, Promise<QuickJSWASMModule>>();

export function toExecutionError(detail: unknown, fallbackCode: QuickJsExecutionErrorCode): QuickJsExecutionError {
  const dumped = detail as { name?: unknown; message?: unknown } | undefined;
  const name = typeof dumped?.name === "string" ? dumped.name : "";
  const message = typeof dumped?.message === "string" ? dumped.message : String(detail);
  if (/interrupt/i.test(message) || /interrupt/i.test(name)) {
    return new QuickJsExecutionError("interrupted", `Sandbox evaluation interrupted: ${message}`);
  }
  if (name === "SyntaxError") {
    return new QuickJsExecutionError("compile_error", `${name}: ${message}`);
  }
  return new QuickJsExecutionError(fallbackCode, name ? `${name}: ${message}` : message);
}

/**
 * The bound on a call's argument, read without parsing it: its length, then one pass counting
 * `[` and `{` outside string literals (a `\` skips the next character, so an escaped quote does
 * not end a string). Linear in the argument, a few milliseconds per megabyte; the kernel's own
 * `JSON.parse` would cost that anyway. Throws `request_refused` past either limit.
 */
export function assertRequestWithinLimits(argument: string, limits: Pick<QuickJsProgramLimits, "maxRequestDepth" | "maxRequestLength">): void {
  if (argument.length > limits.maxRequestLength) {
    throw new QuickJsExecutionError(
      "request_refused",
      `The request is ${argument.length} characters long; the sandbox accepts at most ${limits.maxRequestLength}`
    );
  }
  let depth = 0;
  let inString = false;
  for (let index = 0; index < argument.length; index += 1) {
    const code = argument.charCodeAt(index);
    if (inString) {
      if (code === 92) {
        index += 1;
      } else if (code === 34) {
        inString = false;
      }
      continue;
    }
    if (code === 34) {
      inString = true;
    } else if (code === 91 || code === 123) {
      depth += 1;
      if (depth > limits.maxRequestDepth) {
        throw new QuickJsExecutionError(
          "request_refused",
          `The request nests deeper than ${limits.maxRequestDepth} levels; the sandbox refuses it before parsing`
        );
      }
    } else if (code === 93 || code === 125) {
      depth -= 1;
    }
  }
}

export interface QuickJsProgramHostOptions {
  limits?: Partial<QuickJsProgramLimits> | undefined;
  /** Evaluate {@link HARDENING_PRELUDE} first. Default true; a program that hardens itself may opt out. */
  hardening?: boolean | undefined;
  /**
   * Instantiate a WebAssembly instance of the engine for this host alone (its own linear memory),
   * instead of creating the runtime in the one module the process shares ({@link loadQuickJs}).
   * A host that gives every call a sandbox of its own sets it, so no two calls share a memory;
   * the instance goes when the host is dropped. Default false.
   */
  ownModule?: boolean | undefined;
}

/** The slice of quickjs-emscripten 0.32.0's runtime {@link QuickJsProgramHost.runJobs} reaches into (all `protected` there). */
interface JobRunnerInternals {
  module: { _malloc(bytes: number): number; _free(pointer: number): void; HEAPU8: Uint8Array };
  ffi: { QTS_ExecutePendingJob(runtime: number, maxJobs: number, contextOut: number): number; QTS_FreeValuePointerRuntime(runtime: number, value: number): void };
  rt: { value: number };
}

/** What a poisoned call's message ends with, for a caller that keeps the host. A host that builds a sandbox per call leaves it off: it already drops that sandbox. */
export const ABANDONED_ADVICE = " (the sandbox runtime is abandoned; dispose and create a new host)";

export class QuickJsProgramHost {
  public readonly limits: QuickJsProgramLimits;

  /** Set when a host-side error (not QuickJS's own) escaped a call: see {@link poisoned}. */
  private abandoned = false;

  /** Set when the deadline's interrupt fired in the current call: a job it cut short leaves the promise pending. */
  private deadlineHit = false;

  /** The entry points held since startup (see {@link captureEntries}), by global name. */
  private readonly captured = new Map<string, QuickJSHandle>();

  private constructor(
    public readonly runtime: QuickJSRuntime,
    public readonly vm: QuickJSContext,
    limits: QuickJsProgramLimits
  ) {
    this.limits = limits;
  }

  public static async create(options: QuickJsProgramHostOptions = {}): Promise<QuickJsProgramHost> {
    const limits: QuickJsProgramLimits = { ...VALIDATION_PROFILE, ...(options.limits ?? {}) };
    const modulePromise = options.ownModule === true ? loadOwnQuickJs() : loadQuickJs();
    const quickJs = await modulePromise;
    const runtime = quickJs.newRuntime();
    runtime.setMemoryLimit(limits.memoryLimitBytes);
    runtime.setMaxStackSize(limits.maxStackSizeBytes);
    const vm = runtime.newContext();
    const host = new QuickJsProgramHost(runtime, vm, limits);
    if (options.ownModule !== true) {
      hostModules.set(host, modulePromise);
    }
    try {
      if (options.hardening !== false) {
        host.evaluate(HARDENING_PRELUDE, "hardening");
      }
      return host;
    } catch (error) {
      host.dispose();
      throw error;
    }
  }

  private withDeadline<T>(work: () => T): T {
    const overDeadline = shouldInterruptAfterDeadline(Date.now() + this.limits.maxEvalMs);
    this.deadlineHit = false;
    this.runtime.setInterruptHandler(() => {
      const stop = overDeadline(this.runtime);
      if (stop) {
        this.deadlineHit = true;
      }
      return stop;
    });
    try {
      return work();
    } finally {
      this.runtime.removeInterruptHandler();
    }
  }

  /** Evaluates a program and keeps its completion value as a handle the caller disposes. */
  public evaluateHandle(code: string, label = "program", failureCode: QuickJsExecutionErrorCode = "compile_error"): QuickJSHandle {
    return this.withDeadline(() => {
      const result = this.vm.evalCode(code, label);
      if ("error" in result && result.error) {
        const detail = this.vm.dump(result.error);
        result.error.dispose();
        throw toExecutionError(detail, failureCode);
      }
      return result.value;
    });
  }

  /** Evaluates a program for its side effects (a global it defines). */
  public evaluate(code: string, label = "program"): void {
    this.evaluateHandle(code, label).dispose();
  }

  /**
   * Takes hold of the program's entry points by name, once, right after it is evaluated and
   * before any plugin module runs. A global of a QuickJS context can be redefined by any code in
   * it (`Object.defineProperty(globalThis, name, { value })` works whatever the property's
   * attributes), so a host that looked the name up on every call would call whatever a plugin
   * left there; the handles taken here are the program's own functions. Names the program does
   * not define as functions are left to the per-call lookup (and its error).
   */
  public captureEntries(names: readonly string[]): void {
    for (const name of names) {
      if (this.captured.has(name)) {
        continue;
      }
      const handle = this.vm.getProp(this.vm.global, name);
      if (this.vm.typeof(handle) === "function") {
        this.captured.set(name, handle);
      } else {
        handle.dispose();
      }
    }
  }

  /** The entry point {@link captureEntries} took hold of, for a host that calls it with other arguments than a string; not to be disposed by the caller. */
  public capturedEntry(name: string): QuickJSHandle | undefined {
    return this.captured.get(name);
  }

  /**
   * Calls a global function with one string argument and returns its string result. A
   * returned promise is settled by draining the runtime's jobs; a promise that stays pending
   * with no jobs left is reported as `never_settles` rather than hanging the host. An answer
   * longer than `resultCap` (default the limits' `maxResultLength`) is refused as `outcome_too_large`.
   */
  public call(entry: string, argument: string, resultCap: number | undefined = this.limits.maxResultLength): string {
    // Refused before any handle exists: a request the runtime could not walk never enters it.
    assertRequestWithinLimits(argument, this.limits);
    const held = this.captured.get(entry);
    const fn = held ?? this.vm.getProp(this.vm.global, entry);
    const arg = this.vm.newString(argument);
    try {
      if (this.vm.typeof(fn) !== "function") {
        throw new QuickJsExecutionError("runtime_error", `The program defines no function "${entry}"`);
      }
      return this.withDeadline(() => {
        try {
          const callResult = this.vm.callFunction(fn, this.vm.undefined, arg);
          if ("error" in callResult && callResult.error) {
            const detail = this.vm.dump(callResult.error);
            callResult.error.dispose();
            throw toExecutionError(detail, "runtime_error");
          }
          return this.capped(this.settle(callResult.value), resultCap);
        } catch (error) {
          if (error instanceof QuickJsExecutionError) {
            throw error;
          }
          // Not QuickJS's verdict but the host's own (V8 unwinding through the WASM frames on a
          // stack overflow, a lifetime error): the runtime's state is unknown, so it is never
          // freed, and the caller gets a typed refusal rather than an untyped throw.
          this.abandoned = true;
          const name = error instanceof Error ? error.name : typeof error;
          const message = error instanceof Error ? error.message : String(error);
          throw new QuickJsExecutionError("runtime_error", `${name}: ${message}${ABANDONED_ADVICE}`);
        }
      });
    } finally {
      arg.dispose();
      if (held === undefined) {
        fn.dispose();
      }
    }
  }

  /** The answer itself, or `outcome_too_large` when it is longer than the cap. */
  private capped(answer: string, cap: number | undefined): string {
    if (cap !== undefined && answer.length > cap) {
      throw new QuickJsExecutionError(
        "outcome_too_large",
        `outcome.tooLarge: the sandbox answered with ${answer.length} characters; a run's outcome is at most ${cap}`
      );
    }
    return answer;
  }

  /**
   * True once a host-side error escaped a call (one QuickJS did not raise itself). The runtime
   * may hold objects its GC list no longer accounts for, and `JS_FreeRuntime` would abort the
   * whole module on them, so {@link dispose} leaves such a runtime allocated. A host that sees
   * this replaces the program host; its memory is reclaimed with the process.
   */
  public get poisoned(): boolean {
    return this.abandoned;
  }

  /**
   * Runs the pending jobs; returns how many ran and throws what a job threw.
   *
   * This is `runtime.executePendingJobs()` with one repair. That method allocates a pointer
   * out-parameter on the WASM heap, keeps a typed-array view of it across the call, and reads
   * the job's context pointer through the view afterwards. A job that grows the WASM memory
   * (anything allocating past the heap it has, which a PDF render does constantly) detaches
   * that view, so the pointer reads as `undefined`, the method takes it for an unknown context
   * and makes a second, real `JSContext` for it — one nobody ever disposes. The runtime then
   * fails `list_empty(&rt->gc_obj_list)` in `JS_FreeRuntime` on `dispose()`, aborting the whole
   * module. Reading the pointer through a fresh view after the call avoids it. quickjs-emscripten
   * 0.32.0 (the latest; singlefile and quickjs-ng builds alike); the pin is exact, and the
   * internals used here are checked at runtime so a bump fails loudly rather than quietly.
   */
  private runJobs(): number {
    const internals = this.runtime as unknown as JobRunnerInternals;
    const { module, ffi, rt } = internals;
    if (typeof module?._malloc !== "function" || typeof module?._free !== "function" || typeof ffi?.QTS_ExecutePendingJob !== "function" || typeof rt?.value !== "number") {
      throw new QuickJsExecutionError("runtime_error", "The quickjs-emscripten runtime no longer exposes the job runner's internals; update QuickJsProgramHost.runJobs for this version");
    }
    const contextOut = module._malloc(4);
    if (contextOut === 0) {
      throw new QuickJsExecutionError("runtime_error", "The sandbox could not allocate a job context out-parameter");
    }
    let valuePtr: number;
    let contextPtr: number;
    try {
      valuePtr = ffi.QTS_ExecutePendingJob(rt.value, -1, contextOut);
      // A fresh view over the heap as it is now: the job may have grown (and so replaced) the buffer.
      contextPtr = new Uint32Array(module.HEAPU8.buffer, contextOut, 1)[0] ?? 0;
    } finally {
      module._free(contextOut);
    }
    if (contextPtr === 0) {
      // No job was pending.
      ffi.QTS_FreeValuePointerRuntime(rt.value, valuePtr);
      return 0;
    }
    // A program has the one context, `vm`; nothing else can enqueue a job in this runtime.
    const result = this.vm.getMemory(rt.value as never).heapValueHandle(valuePtr as never);
    try {
      if (this.vm.typeof(result) === "number") {
        return this.vm.getNumber(result);
      }
      throw toExecutionError(this.vm.dump(result), "runtime_error");
    } finally {
      result.dispose();
    }
  }

  /**
   * Runs whatever jobs are still queued once a result is in hand. A runtime freed with jobs
   * still queued fails QuickJS's own assertion, so nothing is left behind.
   */
  private drainJobs(): void {
    while (this.runtime.hasPendingJob()) {
      if (this.runJobs() === 0) {
        break;
      }
    }
  }

  /** The string a (possibly promised) result resolves to; disposes the handle. */
  private settle(handle: QuickJSHandle): string {
    try {
      for (;;) {
        const state = this.vm.getPromiseState(handle);
        if (state.type === "fulfilled") {
          const value = this.vm.dump(state.value);
          if (!state.notAPromise) {
            state.value.dispose();
          }
          this.drainJobs();
          if (typeof value !== "string") {
            throw new QuickJsExecutionError("runtime_error", `The program returned a ${typeof value}, not a string`);
          }
          return value;
        }
        if (state.type === "rejected") {
          const detail = this.vm.dump(state.error);
          state.error.dispose();
          this.drainJobs();
          throw toExecutionError(detail, "runtime_error");
        }
        if (this.runJobs() === 0 && !this.runtime.hasPendingJob()) {
          if (this.deadlineHit) {
            throw new QuickJsExecutionError("interrupted", "Sandbox evaluation interrupted: the deadline passed while the program's jobs ran");
          }
          throw new QuickJsExecutionError("never_settles", "The program's promise stays pending with no jobs left to run; it awaits something the sandbox cannot provide");
        }
      }
    } finally {
      handle.dispose();
    }
  }

  /**
   * The size of the WASM memory the module this host runs in holds, in bytes. A WASM memory only
   * grows: a run that built a big string once leaves the module (and the process's resident set)
   * that large for as long as the module lives, whatever `memoryLimitBytes` said. Undefined when
   * the module does not show it.
   */
  public moduleHeapBytes(): number | undefined {
    const module = (this.runtime as unknown as { module?: { HEAPU8?: { byteLength?: unknown } } }).module;
    const size = module?.HEAPU8?.byteLength;
    return typeof size === "number" ? size : undefined;
  }

  /**
   * Forgets the shared module when it is the one this host runs in, so the next {@link create}
   * instantiates a fresh WASM memory. Hosts already on the old module keep working; the old
   * module is freed once the last of them is disposed.
   */
  public discardModule(): void {
    if (quickJsModule !== undefined && quickJsModule === hostModules.get(this)) {
      quickJsModule = undefined;
    }
  }

  public dispose(): void {
    if (this.abandoned) {
      // Freeing a runtime a host-side error unwound through fails QuickJS's own assertion
      // (`list_empty(&rt->gc_obj_list)` in `JS_FreeRuntime`), which aborts the module. The
      // runtime stays allocated instead; the handles the caller holds are already gone.
      return;
    }
    // Jobs a failed or interrupted call left queued are run off under a short deadline first;
    // whatever they do now cannot matter, but a runtime cannot be freed around them.
    try {
      this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 250));
      this.drainJobs();
    } catch {
      // A job that fails or spins here is abandoned with the runtime.
    } finally {
      this.runtime.removeInterruptHandler();
    }
    for (const handle of this.captured.values()) {
      handle.dispose();
    }
    this.captured.clear();
    this.vm.dispose();
    this.runtime.dispose();
  }
}

export function createQuickJsProgramHost(options: QuickJsProgramHostOptions = {}): Promise<QuickJsProgramHost> {
  return QuickJsProgramHost.create(options);
}
