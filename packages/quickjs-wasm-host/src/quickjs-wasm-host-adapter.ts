import {
  isSourcePlugin,
  WasmValidationHost,
  WASM_ABI_VERSION,
  type WasmAbi,
  type WasmHostAdapter,
  type WasmPluginModule,
  type WasmPluginSource,
  type WasmValidationHostOptions,
  type WasmValidatorInstance
} from "@argusvane/datum-engine";

import {
  QuickJsExecutionError,
  QuickJsProgramHost,
  VALIDATION_PROFILE,
  assertRequestWithinLimits,
  type QuickJsExecutionErrorCode
} from "./program-host.js";
import { HEAP_RECYCLE_BYTES, SandboxRecycler } from "./heap-recycle.js";
import { FREEZE_INTRINSICS_SNIPPET, SANDBOX_ENTRY_POINTS, SANDBOX_PREPARED_CHARS, buildSandboxProgram, toSourcePlugin } from "./sandbox-program.js";

export { QuickJsExecutionError, type QuickJsExecutionErrorCode } from "./program-host.js";

export interface QuickJsWasmHostAdapterOptions {
  /**
   * Wall-clock budget per evaluation before the interrupt handler kills it. A safety net
   * against runaway (trusted but buggy) code, not a security boundary. Set, it is used as
   * given. Left out, the budget scales with the definition: 250 plus 5 per rule read (the
   * `inspect` op's `reads`, summed over every rule) plus 1 per kilobyte of definition text (a
   * large form with no rules still takes time to prepare when cold), capped at 5,000, worked out
   * once per definition and cached by a hash of its text, then 2 per kilobyte of the whole request
   * on every call (the answers and a delivered `document`, which the kernel digests at about a
   * millisecond per kilobyte), capped at 5,000 again. A form of a few rules keeps 250.
   */
  maxEvalMs?: number;
  /**
   * Wall-clock budget for startup (evaluating the kernel program and registering the plugin
   * modules) before the interrupt handler ends it. The program is a few hundred kilobytes
   * and evaluates in a few milliseconds alone, but under a loaded machine (a parallel test
   * run) the per-run budget once proved too short for it; startup has its own. Default 2000.
   */
  maxStartupMs?: number;
  /** QuickJS runtime memory limit in bytes. Default 32 MiB. */
  memoryLimitBytes?: number;
  /**
   * WASM memory the module may have grown to before the sandbox is rebuilt over a fresh one
   * after a run (the heap never shrinks). Default 128 MiB.
   */
  recycleHeapBytes?: number;
  /** QuickJS max stack size in bytes. Default 1 MiB. */
  maxStackSizeBytes?: number;
  /**
   * The sandbox program's source text to evaluate instead of the one built from the engine's
   * source ({@link buildSandboxProgram}). A conformance check of a shipped program file (a
   * published `datum-sandbox-program.js`) hands it here. Left out, the built program runs.
   */
  program?: string;
  /**
   * Prove a `program` handed in as text answers for the ABI this host is instantiated with before
   * it judges anything ({@link proveProgramAbi}; `abi_mismatch` otherwise), under the startup
   * budget ({@link maxStartupMs}), not the run budget. Default true. Set
   * `false` only in a harness that runs programs of other ABIs on purpose and reports on them
   * itself (a conformance run at a lower floor); a host that judges submissions keeps it.
   */
  checkProgramAbi?: boolean;
  /**
   * Freeze the kernel's globals and the language's intrinsics ({@link FREEZE_INTRINSICS_SNIPPET})
   * after the program is evaluated and before any plugin module, so a plugin validator cannot
   * rebind the kernel or patch `Array.prototype` for the runs that follow it. Default true. Set `false` only for a plugin that has to patch a built-in, such as a
   * polyfill; the sandbox then trusts every plugin with the kernel itself.
   */
  freezeIntrinsics?: boolean;
}

/** Startup budget (kernel program + plugin registration); see {@link QuickJsWasmHostAdapterOptions.maxStartupMs}. */
export const DEFAULT_STARTUP_MS = 2_000;

/** The default evaluation budget before it scales: {@link VALIDATION_PROFILE}'s 250 ms. */
export const SCALED_BASE_MS = 250;
/** Added to the base for each rule read in the definition. */
export const SCALED_MS_PER_READ = 5;
/** Added to the base for each kilobyte of the definition's serialized text. */
export const SCALED_MS_PER_KB = 1;
/**
 * Added to a run's budget, on every call, for each kilobyte of the request it carries: the answers
 * and a delivered `document` (hashed in QuickJS at about a millisecond per kilobyte) vary per call,
 * so this term never goes into the budget remembered per definition. Twice the measured cost, for a
 * slower machine than the one it was measured on.
 */
export const SCALED_MS_PER_REQUEST_KB = 2;
/** The most the scaled default reaches. */
export const SCALED_CAP_MS = 5_000;
/** Definitions whose budget a sandbox remembers. */
export const BUDGET_CACHE_SIZE = 16;

/** One sandbox the adapter built: its program host and how many plugin validators it registered. */
export interface SandboxInstance {
  host: QuickJsProgramHost;
  validatorCount: number;
  /** Scaled budgets by a hash of the definition's serialized text (form, journey, pdf); the text itself is not kept. */
  budgets?: Map<string, number>;
}

/**
 * The real QuickJS/WASM sandbox behind the engine's `WasmHostAdapter` contract,
 * built on the shared {@link QuickJsProgramHost}.
 *
 * `instantiate` is the startup wiring point: it evaluates the portable kernel (always) and
 * registers each plugin module, once per host; `run` is string-in/string-out per
 * submission, every run in the same sandbox (its prepared-definition cache warm, replaced by
 * {@link SandboxRecycler} when its heap grew). That is the page's host, where every answer is the
 * filler's own; a server, where each call judges another submission, gives each call a fresh
 * sandbox instead ({@link QuickJsFreshSandboxHost}, and `QuickJsWorkerHost` on its own thread).
 *
 * The sandbox has no ambient authority by construction — QuickJS provides no
 * `fetch`, no filesystem, no `process` — and `Math.random`/`Date` are disabled for
 * determinism. Runs identically in the browser and Node (the singlefile variant embeds the
 * WASM binary, so there is no asset to fetch).
 */
export class QuickJsWasmHostAdapter implements WasmHostAdapter {
  public readonly id = "quickjs-wasm";
  public readonly abiVersion = WASM_ABI_VERSION;

  private readonly maxEvalMs: number | undefined;
  private readonly maxStartupMs: number;
  private readonly memoryLimitBytes: number;
  private readonly recycleHeapBytes: number;
  private readonly maxStackSizeBytes: number;
  private readonly program: string | undefined;
  private readonly checkProgramAbi: boolean;
  private readonly freezeIntrinsics: boolean;

  constructor(options: QuickJsWasmHostAdapterOptions = {}) {
    this.maxEvalMs = options.maxEvalMs;
    this.maxStartupMs = options.maxStartupMs ?? DEFAULT_STARTUP_MS;
    this.memoryLimitBytes = options.memoryLimitBytes ?? VALIDATION_PROFILE.memoryLimitBytes;
    this.recycleHeapBytes = options.recycleHeapBytes ?? HEAP_RECYCLE_BYTES;
    this.maxStackSizeBytes = options.maxStackSizeBytes ?? VALIDATION_PROFILE.maxStackSizeBytes;
    this.program = options.program;
    this.checkProgramAbi = options.checkProgramAbi !== false;
    this.freezeIntrinsics = options.freezeIntrinsics !== false;
  }

  public async instantiate(
    plugins: readonly WasmPluginModule[],
    abi: WasmAbi
  ): Promise<WasmValidatorInstance> {
    const first = await this.instantiateSandbox(plugins);
    if (this.program !== undefined && this.checkProgramAbi) {
      // A program handed in as text may be a file left over from an older build: it answers for
      // the ABI this host speaks before it judges anything (the one built from source always does).
      // The probe is part of starting the sandbox, so it runs under the startup budget, as the
      // worker's does: a tight run budget must not turn a current program that is slow to answer
      // its first inspect into one to rebuild.
      first.host.limits.maxEvalMs = this.maxStartupMs;
      try {
        proveProgramAbi(() => first.host.call("__datum_inspect", abiProbeRequest(abi.version), Infinity), abi.version);
      } catch (error) {
        first.host.dispose();
        throw error;
      }
      first.host.limits.maxEvalMs = this.maxEvalMs ?? VALIDATION_PROFILE.maxEvalMs;
    }
    const recycler = new SandboxRecycler(first, () => this.instantiateSandbox(plugins), this.recycleHeapBytes);
    return {
      abiVersion: abi.version,
      run: (serializedContext: string): string => {
        try {
          return this.runSandbox(recycler.usable(), serializedContext);
        } finally {
          recycler.afterRun();
        }
      },
      // The test op runs plugin validators as a run does, so it can grow the heap as much.
      inspect: (serializedRequest: string): string => {
        try {
          return this.inspectSandbox(recycler.usable(), serializedRequest);
        } finally {
          recycler.afterRun();
        }
      },
      dispose: (): void => {
        recycler.dispose();
      }
    };
  }

  /**
   * One sandbox: the program evaluated, the entry points captured, the freeze, the plugin modules.
   * Shared by {@link instantiate}, {@link certifyWasmPlugin} (which needs the count) and
   * {@link QuickJsFreshSandboxHost}, which builds one per call: `ownModule` gives the sandbox a
   * WebAssembly instance of the engine of its own instead of the one the process shares, and
   * `preparedCache: false` sizes the program's prepared-definition cache to nothing, since a
   * sandbox that serves one call never sees a definition twice.
   */
  public async instantiateSandbox(plugins: readonly WasmPluginModule[], options: { ownModule?: boolean; preparedCache?: boolean } = {}): Promise<SandboxInstance> {
    // The sandbox program carries its own hardening; the host's prelude would only repeat it.
    // Startup runs under its own budget; the per-run budget takes over once the sandbox is
    // ready (the host reads its limits on every evaluation, so the swap is one assignment).
    const host = await QuickJsProgramHost.create({
      hardening: false,
      ownModule: options.ownModule === true,
      limits: {
        maxEvalMs: this.maxStartupMs,
        memoryLimitBytes: this.memoryLimitBytes,
        maxStackSizeBytes: this.maxStackSizeBytes
      }
    });
    try {
      // The prepared-definition cache lives inside the sandbox's memory: bound the key text
      // it keeps by the limit this host was given (a prepared definition is about seven times its
      // key in memory), so a small limit gets a small cache, never an out-of-memory run. The program
      // reads the number once as it starts (the cache is no global).
      const cacheChars = options.preparedCache === false ? "0" : String(Math.min(SANDBOX_PREPARED_CHARS, Math.floor(this.memoryLimitBytes / 16)));
      host.evaluate(`globalThis.__datum_cache_chars = ${cacheChars};`, "sandbox-cache-bound");
      host.evaluate(this.program ?? buildSandboxProgram(), "sandbox-program");
      // The entry points are taken hold of now, before the freeze and any plugin, and called by
      // these handles from here on: a plugin can redefine the global names, not these.
      host.captureEntries(SANDBOX_ENTRY_POINTS);
      if (this.freezeIntrinsics) {
        host.evaluate(FREEZE_INTRINSICS_SNIPPET, "sandbox-freeze");
      }
      let validatorCount = 0;
      for (const plugin of plugins) {
        const source = isSourcePlugin(plugin) ? plugin : toSourcePlugin(plugin);
        validatorCount += this.registerPlugin(host, source);
      }
      host.limits.maxEvalMs = this.maxEvalMs ?? VALIDATION_PROFILE.maxEvalMs;
      return { host, validatorCount };
    } catch (error) {
      host.dispose();
      throw error;
    }
  }

  private registerPlugin(host: QuickJsProgramHost, plugin: WasmPluginSource): number {
    const { vm } = host;
    let moduleHandle;
    try {
      moduleHandle = host.evaluateHandle(plugin.source, plugin.id, "compile_error");
    } catch (error) {
      if (error instanceof QuickJsExecutionError) {
        throw new QuickJsExecutionError(error.code, `Plugin "${plugin.id}": ${error.message}`);
      }
      throw error;
    }
    const registerHandle = host.capturedEntry("__datum_register") ?? vm.getProp(vm.global, "__datum_register");
    try {
      // Registration reads the module's properties (a getter is guest code), and reading an error
      // it throws can run guest code too: both run under the startup deadline.
      let countHandle;
      try {
        countHandle = host.callHandle(registerHandle, [moduleHandle], "not_a_module");
      } catch (error) {
        if (error instanceof QuickJsExecutionError) {
          throw new QuickJsExecutionError(error.code, `Plugin "${plugin.id}": ${error.message}`);
        }
        throw error;
      }
      const count = vm.getNumber(countHandle);
      countHandle.dispose();
      return count;
    } finally {
      if (registerHandle !== host.capturedEntry("__datum_register")) {
        registerHandle.dispose();
      }
      moduleHandle.dispose();
    }
  }

  /** One evaluation against an instantiated sandbox: serialized context in, payload out. */
  public runSandbox(sandbox: SandboxInstance, serializedContext: string): string {
    // Refused before the budget is worked out: that scans and may parse the text, which a request
    // the sandbox would refuse anyway must not cost the host.
    assertRequestWithinLimits(serializedContext, sandbox.host.limits);
    if (this.maxEvalMs === undefined) {
      sandbox.host.limits.maxEvalMs = withRequestSize(this.scaledBudget(sandbox, serializedContext), serializedContext);
    }
    return sandbox.host.call("__datum_run", serializedContext);
  }

  /**
   * The default budget for the definition a context carries: 250 ms plus 5 ms per rule read
   * plus 1 ms per kilobyte of definition text, at most 5,000 (the request's own size is added per
   * call, by {@link withRequestSize}). The reads come from the sandbox's own `inspect` op, asked once per
   * definition (remembered by its serialized text) under the startup budget; a context or an
   * answer that cannot be read keeps the base.
   */
  private scaledBudget(sandbox: SandboxInstance, serializedContext: string): number {
    // The cache key comes from the request text itself: the form, journey and pdf segments
    // found by one scan, with no parse and no re-stringify. Text that cannot be scanned falls
    // back to parsing it.
    let key = scaledBudgetKey(serializedContext);
    let definition: Record<string, unknown> | undefined;
    if (key === undefined) {
      try {
        const context = JSON.parse(serializedContext) as Record<string, unknown>;
        definition = definitionOf(context);
        key = JSON.stringify(definition);
      } catch {
        return VALIDATION_PROFILE.maxEvalMs;
      }
    }
    // Only the number is remembered, under a hash and the length of the text: 16 whole definition
    // texts of a few MiB each would sit on the host heap otherwise.
    const size = key.length;
    key = hashedKey(key);
    const budgets = (sandbox.budgets ??= new Map<string, number>());
    const known = budgets.get(key);
    if (known !== undefined) {
      // Least recently used stays: re-insert so the oldest entry is the one dropped.
      budgets.delete(key);
      budgets.set(key, known);
      return known;
    }
    if (definition === undefined) {
      try {
        definition = definitionOf(JSON.parse(serializedContext) as Record<string, unknown>);
      } catch {
        return VALIDATION_PROFILE.maxEvalMs;
      }
    }
    let budget = SCALED_BASE_MS;
    const before = sandbox.host.limits.maxEvalMs;
    try {
      sandbox.host.limits.maxEvalMs = this.maxStartupMs;
      const answer = JSON.parse(
        sandbox.host.call("__datum_inspect", JSON.stringify({ abi: this.abiVersion, op: "inspect", definition }), Infinity)
      ) as { ok?: boolean; rules?: { reads?: unknown[] }[] };
      if (answer.ok === true && Array.isArray(answer.rules)) {
        let reads = 0;
        for (const rule of answer.rules) {
          reads += Array.isArray(rule.reads) ? rule.reads.length : 0;
        }
        budget = SCALED_BASE_MS + SCALED_MS_PER_READ * reads;
      }
    } catch {
      // An inspect that fails keeps the base budget; the run then speaks for itself.
    } finally {
      sandbox.host.limits.maxEvalMs = before;
    }
    budget = Math.min(SCALED_CAP_MS, budget + SCALED_MS_PER_KB * Math.floor(size / 1024));
    if (budgets.size >= BUDGET_CACHE_SIZE) {
      const oldest = budgets.keys().next();
      if (oldest.done !== true) {
        budgets.delete(oldest.value);
      }
    }
    budgets.set(key, budget);
    return budget;
  }

  /**
   * One question about a definition: serialized request in, canonical JSON answer out.
   * Left to the default budget, the call gets 250 ms plus 1 ms per kilobyte of the request, at most
   * 5,000: `check` reads the whole definition (the structure pass and the compile), so a
   * large form needs the room a run's scaled budget gives it. An explicit `maxEvalMs` is used as given.
   * The `test` op runs scenarios and gets the cap whatever the size.
   */
  public inspectSandbox(sandbox: SandboxInstance, serializedRequest: string): string {
    // An inspect answer (`public` returns the whole definition) is bounded by the request and the
    // memory limit, not by the outcome cap of a run.
    if (this.maxEvalMs !== undefined) {
      return sandbox.host.call("__datum_inspect", serializedRequest, Infinity);
    }
    assertRequestWithinLimits(serializedRequest, sandbox.host.limits);
    const before = sandbox.host.limits.maxEvalMs;
    try {
      sandbox.host.limits.maxEvalMs = inspectBudget(serializedRequest);
      return sandbox.host.call("__datum_inspect", serializedRequest, Infinity);
    } finally {
      sandbox.host.limits.maxEvalMs = before;
    }
  }
}

export interface QuickJsValidationHostOptions extends QuickJsWasmHostAdapterOptions {
  abi?: WasmAbi;
}

/**
 * A ready `WasmValidationHost` over the QuickJS sandbox: the core kernel plus the given
 * plugin modules, wired at startup. Function-backed plugins are bridged to source via
 * `toSourcePlugin` (their validators must be closure-free).
 */
export function createQuickJsValidationHost(
  plugins: readonly WasmPluginModule[] = [],
  options: QuickJsValidationHostOptions = {}
): Promise<WasmValidationHost> {
  const { abi, ...adapterOptions } = options;
  const hostOptions: WasmValidationHostOptions = {
    adapter: new QuickJsWasmHostAdapter(adapterOptions),
    ...(abi !== undefined ? { abi } : {})
  };
  return WasmValidationHost.create([...plugins], hostOptions);
}

export interface WasmPluginCertification {
  ok: boolean;
  validatorCount: number;
  code?: QuickJsExecutionErrorCode;
  message?: string;
}

/**
 * The portable-authoring check (plugin certification): proves a plugin module actually
 * evaluates in QuickJS, yields a module object with function validators, and survives a
 * probe run. Run it before shipping a `wasmPlugin` contribution.
 */
export async function certifyWasmPlugin(
  plugin: WasmPluginModule,
  options: QuickJsWasmHostAdapterOptions = {}
): Promise<WasmPluginCertification> {
  const adapter = new QuickJsWasmHostAdapter(options);
  try {
    const sandbox = await adapter.instantiateSandbox([plugin]);
    try {
      const payload = adapter.runSandbox(
        sandbox,
        JSON.stringify({
          formId: "certification-probe",
          values: {},
          locale: "en",
          form: { id: "form", type: "form", configuration: {}, children: {} }
        })
      );
      JSON.parse(payload);
      return { ok: true, validatorCount: sandbox.validatorCount };
    } finally {
      sandbox.host.dispose();
    }
  } catch (error) {
    if (error instanceof QuickJsExecutionError) {
      return { ok: false, validatorCount: 0, code: error.code, message: error.message };
    }
    return {
      ok: false,
      validatorCount: 0,
      code: "runtime_error",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * The scaled run budgets of a host whose sandboxes do not outlive a call (the worker host, the
 * fresh-sandbox host), remembered on the host's side by a hash of the definition: 250 ms plus 5 ms
 * per rule read plus 1 ms per kilobyte of definition text, at most 5,000, the same arithmetic as
 * {@link QuickJsWasmHostAdapter}'s. The reads come from one `inspect` question, which `ask` puts to
 * the program in a sandbox of its own, under the startup budget; a context or an answer that
 * cannot be read keeps the base. The request's own size is added per call ({@link withRequestSize}).
 */
export class DefinitionBudgets {
  private readonly budgets = new Map<string, number>();

  constructor(private readonly abiVersion: string = WASM_ABI_VERSION) {}

  public async forRun(serializedContext: string, ask: (inspectRequest: string) => Promise<string>): Promise<number> {
    let key = scaledBudgetKey(serializedContext);
    let definition: Record<string, unknown> | undefined;
    if (key === undefined) {
      try {
        definition = definitionOf(JSON.parse(serializedContext) as Record<string, unknown>);
        key = JSON.stringify(definition);
      } catch {
        return VALIDATION_PROFILE.maxEvalMs;
      }
    }
    const size = key.length;
    key = hashedKey(key);
    const known = this.budgets.get(key);
    if (known !== undefined) {
      // Least recently used stays: re-insert so the oldest entry is the one dropped.
      this.budgets.delete(key);
      this.budgets.set(key, known);
      return known;
    }
    if (definition === undefined) {
      try {
        definition = definitionOf(JSON.parse(serializedContext) as Record<string, unknown>);
      } catch {
        return VALIDATION_PROFILE.maxEvalMs;
      }
    }
    let budget = SCALED_BASE_MS;
    // Only an answer remembers a budget: a probe that could not be asked (its sandbox did not
    // build, the worker went) or that was refused says nothing about the definition, so this call
    // runs on the base budget and the next one asks again.
    let answered = false;
    try {
      const answer = JSON.parse(await ask(JSON.stringify({ abi: this.abiVersion, op: "inspect", definition }))) as { ok?: boolean; rules?: { reads?: unknown[] }[] };
      if (answer.ok === true && Array.isArray(answer.rules)) {
        let reads = 0;
        for (const rule of answer.rules) {
          reads += Array.isArray(rule.reads) ? rule.reads.length : 0;
        }
        budget = SCALED_BASE_MS + SCALED_MS_PER_READ * reads;
        answered = true;
      }
    } catch {
      // An inspect that fails keeps the base budget for this call; the run then speaks for itself.
    }
    budget = Math.min(SCALED_CAP_MS, budget + SCALED_MS_PER_KB * Math.floor(size / 1024));
    if (!answered) {
      return budget;
    }
    if (this.budgets.size >= BUDGET_CACHE_SIZE) {
      const oldest = this.budgets.keys().next();
      if (oldest.done !== true) {
        this.budgets.delete(oldest.value);
      }
    }
    this.budgets.set(key, budget);
    return budget;
  }
}

/**
 * A cache key for a definition's text: its length and a 53-bit hash of it (cyrb53), so the cache
 * holds a short text however large the definition is. The budget is a safety net, not a security
 * boundary; a collision would only lend one definition another's budget.
 */
export function hashedKey(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return text.length + ":" + (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}

/**
 * A run's budget once the request's own size is counted: {@link SCALED_MS_PER_REQUEST_KB} per
 * kilobyte of it on top of the budget the definition was given, at most {@link SCALED_CAP_MS}.
 */
export function withRequestSize(definitionBudget: number, serializedContext: string): number {
  return Math.min(SCALED_CAP_MS, definitionBudget + SCALED_MS_PER_REQUEST_KB * Math.floor(serializedContext.length / 1024));
}

/**
 * The default budget of an inspect request, the same for every host: 250 ms plus 1 ms per kilobyte
 * of the request, at most 5,000 (`check` reads the whole definition, so a large form needs the
 * room). A `test` request runs every scenario of the form, about 13 ms each in QuickJS (200
 * scenarios are about 2.6 s), which its size says nothing about: it gets the
 * cap. The op is read from the request's top level, never from a string inside the definition.
 */
export function inspectBudget(serializedRequest: string): number {
  if (topLevelValues(serializedRequest, ["op"])?.op === '"test"') {
    return SCALED_CAP_MS;
  }
  return Math.min(SCALED_CAP_MS, SCALED_BASE_MS + SCALED_MS_PER_KB * Math.floor(serializedRequest.length / 1024));
}

/** What a host asks a program handed in as text, to prove it: the `public` question over the smallest definition. */
export function abiProbeRequest(abiVersion: string): string {
  return JSON.stringify({ abi: abiVersion, op: "public", definition: { root: { id: "form", type: "form" } } });
}

/**
 * Proves a program speaks `abiVersion` from its answer to {@link abiProbeRequest} (`answer` reads
 * it, or throws what the call threw). Anything but an `ok: true` answer (an `abi_mismatch`, an
 * answer of another shape, no answer, no inspect entry point at all) is refused as `abi_mismatch`,
 * so a host never judges with an older program's rules. A probe that was interrupted is rethrown
 * as it is (`interrupted`): running out of time proves nothing about the ABI.
 */
export function proveProgramAbi(answer: () => string, abiVersion: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer());
  } catch (error) {
    // A probe that ran out of time says nothing about the ABI: the program may be current and
    // slow, so it is reported as the interrupt it was, not as a file to rebuild.
    if (error instanceof QuickJsExecutionError && error.code === "interrupted") {
      throw error;
    }
    throw new QuickJsExecutionError("abi_mismatch", `The sandbox program did not answer the ABI ${abiVersion} probe: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = parsed !== null && typeof parsed === "object" ? (parsed as { ok?: unknown; error?: { code?: unknown; message?: unknown } }) : undefined;
  if (record?.ok !== true) {
    const said = typeof record?.error?.code === "string" ? `${record.error.code}${typeof record.error.message === "string" ? `: ${record.error.message}` : ""}` : "an answer of another shape";
    throw new QuickJsExecutionError("abi_mismatch", `The sandbox program does not speak ABI ${abiVersion} (${said}); rebuild it`);
  }
}

/** The definition a request carries, as the inspect op takes it. */
export function definitionOf(context: Record<string, unknown>): Record<string, unknown> {
  const definition: Record<string, unknown> = { root: context.form };
  if (context.journey !== undefined) {
    definition.journey = context.journey;
  }
  if (context.pdf !== undefined) {
    definition.pdf = context.pdf;
  }
  return definition;
}

/**
 * The text of the request's top-level `form`, `journey` and `pdf` values, joined, found by one
 * string-aware scan of the text. `undefined` when the text is not an object this scan can read,
 * so the caller parses it instead.
 */
export function scaledBudgetKey(text: string): string | undefined {
  const found = topLevelValues(text, ["form", "journey", "pdf"]);
  if (found?.form === undefined) {
    return undefined;
  }
  return found.form + "\u0000" + (found.journey ?? "") + "\u0000" + (found.pdf ?? "");
}

/**
 * The raw text of the named top-level values of a JSON object, found by one string-aware scan
 * with no parse (a key spelled twice keeps the last, as `JSON.parse` does). `undefined` when the
 * text is not an object this scan can read.
 */
export function topLevelValues(text: string, names: readonly string[]): Record<string, string> | undefined {
  const length = text.length;
  let at = 0;
  while (at < length && text.charCodeAt(at) <= 32) {
    at += 1;
  }
  if (text.charCodeAt(at) !== 123) {
    return undefined;
  }
  at += 1;
  const found: Record<string, string> = {};
  let depth = 1;
  let expectKey = true;
  let keyName = "";
  let valueStart = -1;
  while (at < length) {
    const code = text.charCodeAt(at);
    if (code === 34) {
      let end = at + 1;
      for (;;) {
        const quote = text.indexOf('"', end);
        if (quote < 0) {
          return undefined;
        }
        let slashes = 0;
        while (text.charCodeAt(quote - 1 - slashes) === 92) {
          slashes += 1;
        }
        if (slashes % 2 === 0) {
          end = quote;
          break;
        }
        end = quote + 1;
      }
      if (depth === 1 && expectKey) {
        keyName = text.slice(at + 1, end);
        expectKey = false;
      } else if (depth === 1 && valueStart < 0) {
        valueStart = at;
      }
      at = end + 1;
      continue;
    }
    if (code === 123 || code === 91) {
      if (depth === 1 && valueStart < 0) {
        valueStart = at;
      }
      depth += 1;
    } else if (code === 125 || code === 93) {
      depth -= 1;
      if (depth === 0) {
        if (valueStart >= 0 && names.includes(keyName)) {
          found[keyName] = text.slice(valueStart, at).trim();
        }
        valueStart = -1;
        break;
      }
    } else if (depth === 1) {
      if (code === 44) {
        if (valueStart >= 0 && names.includes(keyName)) {
          found[keyName] = text.slice(valueStart, at).trim();
        }
        valueStart = -1;
        expectKey = true;
      } else if (code === 58 || code <= 32) {
        // separators
      } else if (valueStart < 0) {
        valueStart = at;
      }
    }
    // A closed container at depth 1 ends the value only at the next comma or the final brace.
    at += 1;
  }
  if (depth !== 0) {
    return undefined;
  }
  return found;
}
