import {
  kernelCreatePreparedCache,
  kernelStableStringify,
  runInspect,
  runKernel,
  type KernelOutcome,
  type KernelPreparedCache,
  type KernelValidator
} from "./portable-kernel.js";
import { FORMULA_FUNCTION_NAMES, formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import {
  WASM_ABI_VERSION,
  WasmValidationHost,
  isSourcePlugin,
  type WasmAbi,
  type WasmHostAdapter,
  type WasmHostInput,
  type WasmPluginModule,
  type WasmValidatorInstance
} from "./wasm-validation-host.js";

/**
 * The in-process reference path: the portable kernel run directly in this process,
 * behind the same serialization boundary a real sandbox has.
 *
 * It lives apart from `WasmValidationHost` so that constructing a host never reaches the
 * kernel. The host has no default adapter; a bundle that only ever hands it a sandbox instance
 * (`<datum-form>`, which defers to the QuickJS sandbox in `datum-wasm.js`) therefore leaves the
 * whole kernel out. The engine's release gates, the tests and a server that validates in-process
 * ask for this path by name.
 */

/** Definitions an in-process instance remembers prepared: the compile and its indexes, least recently used dropped. */
export const IN_PROCESS_PREPARED_DEFINITIONS = 16;
/** The most key text, in characters, over those definitions: a bound on the memory the cache holds (about 30 forms of 1,000 fields). */
export const IN_PROCESS_PREPARED_CHARS = 4_000_000;

/** What an in-process instance holds for its runs: the plugins' validators and functions, the parser's signatures, the prepared cache. */
interface InProcessInstanceParts {
  validators: KernelValidator[];
  functions: Record<string, (args: unknown[]) => unknown>;
  signatures: FormulaFunctionSignature[];
  prepared: KernelPreparedCache;
}

/**
 * The plugins as an in-process instance runs them, shared by both adapters below so a run is the
 * same run whichever factory built the host. It never evaluates source: a `WasmPluginSource` is
 * rejected here and belongs in a real sandbox adapter.
 *
 * The kernel cannot read the function table, so the parser's signatures come from here: the
 * built-ins' from the table, and one per plugin function (its name, any argument count), the
 * same list the QuickJS sandbox program builds at generation time and in `__datum_register`.
 */
function inProcessInstanceParts(plugins: readonly WasmPluginModule[]): InProcessInstanceParts {
  const validators: KernelValidator[] = [];
  const functions: Record<string, (args: unknown[]) => unknown> = {};
  const signatures: FormulaFunctionSignature[] = formulaFunctionSignatures();
  // The prepared definitions this instance remembers between runs: a form judged again
  // is not compiled again. Per instance, so nothing is shared between hosts or plugin sets, and
  // invisible to the outcome (a hit is byte-identical to a miss).
  const prepared: KernelPreparedCache = kernelCreatePreparedCache(IN_PROCESS_PREPARED_DEFINITIONS, IN_PROCESS_PREPARED_CHARS);
  for (const plugin of plugins) {
    if (isSourcePlugin(plugin)) {
      throw new Error(
        `In-process adapter cannot evaluate source plugin "${plugin.id}": the engine never ` +
          "evals strings. Use a sandbox adapter (e.g. @argusvane/datum-quickjs-wasm-host) for source modules."
      );
    }
    for (const [name, fn] of Object.entries(plugin.functions ?? {})) {
      if (FORMULA_FUNCTION_NAMES.has(name)) {
        throw new Error(`Plugin "${plugin.id}" function "${name}" is a built-in formula function`);
      }
      if (Object.prototype.hasOwnProperty.call(functions, name)) {
        throw new Error(`Plugin "${plugin.id}" function "${name}" is already registered`);
      }
      functions[name] = fn;
      signatures.push({ name, min: 0, max: Number.POSITIVE_INFINITY });
    }
    for (const validator of plugin.validators) {
      validators.push((context) => validator.validate(context));
    }
  }
  return { validators, functions, signatures, prepared };
}

/** The per-submission run over an instance's parts, behind the serialization boundary. */
function inProcessRun(parts: InProcessInstanceParts, abi: WasmAbi): (serializedContext: string) => string {
  return (serializedContext: string): string => {
    const context = abi.deserializeContext(serializedContext);
    const outcome: KernelOutcome = runKernel(context, parts.validators, parts.functions, parts.signatures, parts.prepared);
    return abi.serializeOutcome(outcome);
  };
}

/**
 * The reference adapter: runs the portable kernel directly in-process, behind the
 * serialization boundary, with function-backed plugins, and answers `__datum_inspect`'s ops as
 * the sandbox program does.
 */
export class InProcessWasmHostAdapter implements WasmHostAdapter {
  public readonly id = "in-process";
  public readonly abiVersion = WASM_ABI_VERSION;

  public instantiate(plugins: readonly WasmPluginModule[], abi: WasmAbi): WasmValidatorInstance {
    const parts = inProcessInstanceParts(plugins);
    return {
      abiVersion: abi.version,
      run: inProcessRun(parts, abi),
      // The introspection entry, as the sandbox program's `__datum_inspect`: the same
      // signatures the run parses with, and the built-ins' names so the inventory can tell a
      // plugin function from a built-in; canonical JSON out. The `test` op runs the form's
      // scenarios over the kernel's run, so it gets the plugins' functions and validators as a
      // run does.
      inspect: (serializedRequest: string): string =>
        kernelStableStringify(runInspect(JSON.parse(serializedRequest), parts.signatures, [...FORMULA_FUNCTION_NAMES], parts.functions, parts.validators))
    };
  }
}

/**
 * The run-only twin of {@link InProcessWasmHostAdapter}: the same instance with no `inspect`
 * entry, so the host it backs says it has none. Why a second adapter:
 * `runInspect` is the door to `public`, `check`, `inspect` and the `test` op with the form-test parser and judge behind it. A
 * builder chunk that only runs submissions (the Tests panel's runner never introspects) and
 * names the full adapter makes the bundler keep all of that in the builder's eager entry, since
 * the entry already imports the kernel module. This adapter never names `runInspect`, so a
 * bundle that reaches only it leaves the op out.
 */
export class InProcessRunHostAdapter implements WasmHostAdapter {
  public readonly id = "in-process";
  public readonly abiVersion = WASM_ABI_VERSION;

  public instantiate(plugins: readonly WasmPluginModule[], abi: WasmAbi): WasmValidatorInstance {
    return { abiVersion: abi.version, run: inProcessRun(inProcessInstanceParts(plugins), abi) };
  }
}

/**
 * A host over the in-process reference adapter: the portable kernel plus the given
 * function-backed validators or plugin modules, synchronously ready.
 */
export function createInProcessWasmValidationHost(
  input: WasmHostInput = [],
  options: { abi?: WasmAbi } = {}
): WasmValidationHost {
  return new WasmValidationHost(input, { ...options, adapter: new InProcessWasmHostAdapter() });
}

/**
 * {@link createInProcessWasmValidationHost} without the introspection entry: the same runs, and
 * `inspect` answers that the instance has none. Two factories exist so a caller that never
 * introspects (the builder's Tests runner) can say so and keep the `test` op, the
 * form-test parser and the judge out of the bundle it ships in; a caller that asks `public`,
 * `check`, `inspect` or `test` of a definition uses the full one.
 */
export function createInProcessRunHost(input: WasmHostInput = [], options: { abi?: WasmAbi } = {}): WasmValidationHost {
  return new WasmValidationHost(input, { ...options, adapter: new InProcessRunHostAdapter() });
}
