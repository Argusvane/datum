// The worker thread behind QuickJsWorkerHost. Every call runs in a sandbox of its own: a new
// WebAssembly instance of the engine (its own linear memory), one QuickJS runtime and context in
// it, the steps the host hands in evaluated, the entry points captured, the plugin modules
// registered. The call runs, its answer is posted, the sandbox is thrown away, and the next one is
// built straight away so the next call does not wait for it; `ready` says it is there. Nothing a
// call does (a global it defines, state a plugin module keeps, memory it grows) can reach another
// call, because no two calls ever share an instance.
//
// Plain JavaScript on purpose: a worker thread loads a file Node can run, and the package's
// TypeScript is not one. It does only what the thread must: the host (worker-host.ts) owns the
// limits' policy, the scaled budgets, the kill and the replacement of the thread.
import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";

const { steps, plugins, limits, entryPoints = [] } = workerData;

/** The engine's variant, imported once: each sandbox instantiates its WebAssembly afresh from it. */
const variant = import("@jitl/quickjs-singlefile-mjs-release-sync");

/** The one sandbox no call has run in yet, or undefined while it is built (or after its build failed). */
let prepared;

/** The memories of every sandbox a call was handed: a sandbox whose memory is here has run a call and never runs another. */
const spent = new WeakSet();

class Failure extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** The error a QuickJS handle holds, as plain data the host maps to a typed error. */
function detailOf(sandbox, handle) {
  const dumped = sandbox.vm.dump(handle);
  handle.dispose();
  const name = dumped !== null && typeof dumped === "object" && typeof dumped.name === "string" ? dumped.name : "";
  const message = dumped !== null && typeof dumped === "object" && typeof dumped.message === "string" ? dumped.message : String(dumped);
  return { name, message };
}

function heapBytes(sandbox) {
  const size = sandbox?.memory?.buffer?.byteLength;
  return typeof size === "number" ? size : undefined;
}

/**
 * Runs `work` under a wall-clock deadline and a ceiling on the sandbox's WASM memory, both checked
 * at every interrupt poll: growth made of many small steps (a loop pushing strings, which the
 * QuickJS memory limit does not count) ends the call here, as `interrupted`, before the process
 * grows with it. One huge native allocation is not caught; the host's kill and the thread's V8
 * limit are the nets for that.
 */
function withDeadline(sandbox, ms, work) {
  const overDeadline = shouldInterruptAfterDeadline(Date.now() + ms);
  let heapHit = false;
  sandbox.runtime.setInterruptHandler((rt) => {
    if (typeof limits.maxWasmHeapBytes === "number" && (heapBytes(sandbox) ?? 0) > limits.maxWasmHeapBytes) {
      heapHit = true;
      return true;
    }
    return overDeadline(rt);
  });
  try {
    return work();
  } catch (error) {
    if (heapHit) {
      throw new Failure("interrupted", `Sandbox evaluation interrupted: the sandbox's memory passed ${limits.maxWasmHeapBytes} bytes`);
    }
    throw error;
  } finally {
    sandbox.runtime.removeInterruptHandler();
  }
}

/** Evaluates a program and keeps its completion value as a handle the caller disposes. */
function evaluateHandle(sandbox, code, label) {
  const result = sandbox.vm.evalCode(code, label);
  if ("error" in result && result.error) {
    throw new Failure(undefined, "", detailOf(sandbox, result.error));
  }
  return result.value;
}

/** Takes hold of the program's entry points; a name the program does not define as a function is left to the per-call lookup. */
function captureEntries(sandbox) {
  for (const name of entryPoints) {
    const handle = sandbox.vm.getProp(sandbox.vm.global, name);
    if (sandbox.vm.typeof(handle) === "function") {
      sandbox.entries.set(name, handle);
    } else {
      handle.dispose();
    }
  }
}

function registerPlugins(sandbox) {
  const { vm } = sandbox;
  let validatorCount = 0;
  for (const plugin of plugins) {
    let moduleHandle;
    try {
      moduleHandle = evaluateHandle(sandbox, plugin.source, plugin.id);
    } catch (error) {
      if (error instanceof Failure) {
        error.code = "compile_error";
        error.plugin = plugin.id;
      }
      throw error;
    }
    const held = sandbox.entries.get("__datum_register");
    const register = held ?? vm.getProp(vm.global, "__datum_register");
    try {
      const result = vm.callFunction(register, vm.undefined, moduleHandle);
      if ("error" in result && result.error) {
        throw new Failure("not_a_module", "", detailOf(sandbox, result.error));
      }
      validatorCount += vm.getNumber(result.value);
      result.value.dispose();
    } catch (error) {
      if (error instanceof Failure) {
        error.plugin = plugin.id;
      }
      throw error;
    } finally {
      if (held === undefined) {
        register.dispose();
      }
      moduleHandle.dispose();
    }
  }
  return validatorCount;
}

/**
 * A new sandbox: a new WebAssembly instance (each call of `newQuickJSWASMModuleFromVariant` runs
 * the variant's Emscripten loader again, which creates its own `WebAssembly.Memory`), a runtime and
 * a context in it, the steps evaluated, the entry points captured straight after the program and
 * before the freeze and any plugin (a plugin can redefine a global's name, not these handles), then
 * the plugin modules registered.
 */
async function build() {
  const quickJs = await newQuickJSWASMModuleFromVariant(variant);
  const memory = quickJs.getWasmMemory();
  if (spent.has(memory)) {
    // The property every call relies on; a loader that handed back an instance it had already made would break it.
    throw new Failure("runtime_error", "The engine handed back a WebAssembly memory a call already ran in; refusing to reuse it");
  }
  const runtime = quickJs.newRuntime();
  runtime.setMemoryLimit(limits.memoryLimitBytes);
  runtime.setMaxStackSize(limits.maxStackSizeBytes);
  const sandbox = { memory, runtime, vm: runtime.newContext(), entries: new Map(), validatorCount: 0, poisoned: false };
  try {
    withDeadline(sandbox, limits.maxStartupMs, () => {
      for (const step of steps) {
        evaluateHandle(sandbox, step.code, step.label).dispose();
        if (step.label === "sandbox-program") {
          captureEntries(sandbox);
        }
      }
      sandbox.validatorCount = registerPlugins(sandbox);
    });
  } catch (error) {
    if (!(error instanceof Failure)) {
      sandbox.poisoned = true;
    }
    discard(sandbox);
    throw error;
  }
  return sandbox;
}

/**
 * The sandbox for this call, taken and cleared in one step: once a call holds it, `prepared` no
 * longer does, and its memory is marked spent, so no later call can be handed it.
 */
function take() {
  const sandbox = prepared;
  prepared = undefined;
  if (sandbox === undefined) {
    throw new Failure("runtime_error", "No fresh sandbox is ready for this call");
  }
  if (spent.has(sandbox.memory)) {
    throw new Failure("runtime_error", "The sandbox offered for this call already ran one");
  }
  spent.add(sandbox.memory);
  return sandbox;
}

/**
 * Lets a sandbox go. One a host-side error unwound through (poisoned), or one with jobs still
 * queued, is dropped whole without freeing its runtime: `JS_FreeRuntime` asserts on what such a
 * runtime holds and aborts the instance, and the instance's memory goes with the last reference
 * to it either way. Any other is disposed first, handles, context, runtime.
 */
function discard(sandbox) {
  if (sandbox.poisoned) {
    return;
  }
  try {
    if (sandbox.runtime.hasPendingJob()) {
      return;
    }
    for (const handle of sandbox.entries.values()) {
      handle.dispose();
    }
    sandbox.entries.clear();
    sandbox.vm.dispose();
    sandbox.runtime.dispose();
  } catch {
    // An instance that will not free cleanly is dropped as it is.
  }
}

/** One call in the sandbox it was handed. Jobs a call leaves queued never run: they cannot change its answer, and they die with the instance. */
function call(sandbox, entry, argument, maxEvalMs, resultCap) {
  const { vm } = sandbox;
  const held = sandbox.entries.get(entry);
  const fn = held ?? vm.getProp(vm.global, entry);
  const arg = vm.newString(argument);
  try {
    if (vm.typeof(fn) !== "function") {
      throw new Failure("runtime_error", `The program defines no function "${entry}"`);
    }
    return withDeadline(sandbox, maxEvalMs, () => {
      const result = vm.callFunction(fn, vm.undefined, arg);
      if ("error" in result && result.error) {
        throw new Failure("runtime_error", "", detailOf(sandbox, result.error));
      }
      const value = vm.dump(result.value);
      result.value.dispose();
      if (typeof value !== "string") {
        throw new Failure("runtime_error", `The program returned a ${typeof value}, not a string`);
      }
      if (value.length > resultCap) {
        throw new Failure("outcome_too_large", `outcome.tooLarge: the sandbox answered with ${value.length} characters; a run's outcome is at most ${resultCap}`);
      }
      return value;
    });
  } finally {
    arg.dispose();
    if (held === undefined) {
      fn.dispose();
    }
  }
}

function failureMessage(type, id, error, heap) {
  if (error instanceof Failure) {
    return { type, id, code: error.code, message: error.message, detail: error.detail, plugin: error.plugin, heapBytes: heap };
  }
  // Not QuickJS's verdict but the thread's own (V8 unwinding through the WASM frames): the instance's state is unknown, and it is dropped.
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return { type, id, code: "runtime_error", message: `${name}: ${message}`, heapBytes: heap };
}

/** Builds the next sandbox and says so; a build that fails is reported as a boot failure is, and the host replaces the thread. */
function prepare() {
  build().then(
    (sandbox) => {
      prepared = sandbox;
      parentPort.postMessage({ type: "ready", validatorCount: sandbox.validatorCount, heapBytes: heapBytes(sandbox) });
    },
    (error) => {
      parentPort.postMessage(failureMessage("failed", undefined, error, undefined));
    }
  );
}

parentPort.on("message", (message) => {
  if (message.type !== "call") {
    return;
  }
  let sandbox;
  try {
    sandbox = take();
    const value = call(sandbox, message.entry, message.argument, message.maxEvalMs, message.resultCap);
    parentPort.postMessage({ type: "result", id: message.id, value, heapBytes: heapBytes(sandbox) });
  } catch (error) {
    if (sandbox !== undefined && !(error instanceof Failure)) {
      sandbox.poisoned = true;
    }
    // No sandbox to run in: nothing is being built after this, so the host replaces the thread.
    parentPort.postMessage({ ...failureMessage("error", message.id, error, heapBytes(sandbox)), replace: sandbox === undefined });
  }
  if (sandbox !== undefined) {
    discard(sandbox);
    prepare();
  }
});

prepare();
