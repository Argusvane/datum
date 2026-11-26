/**
 * The two sides a scenario plays on: the browser's runtime, headless, and
 * the validation kernel, in process or inside a sandbox program file. Both are wired here the way
 * the engine's own parity test wires them (`engine/tests/form-tests/parity.test.ts`), so a
 * scenario the CLI judges is judged on the same readings the engine's suite pins.
 *
 * No global registration and no renderer: the eager journey engine is handed to each runtime, so importing this
 * module changes nothing for anything else in the process.
 */
import { createFormTestKernelDriver, createFormTestRuntimeDriver, createFieldConstraintsStage, createInProcessWasmValidationHost, ValidationPipeline } from "@argusvane/datum-engine";
import type { FormTestRuntimeFactory, WasmValidationHost } from "@argusvane/datum-engine";
import { formulaFunctionSignatures, SubmissionModeRegistry } from "@argusvane/datum-engine/core";
import type { FormDefinition, FormulaFunctionSignature } from "@argusvane/datum-engine/core";
import type { FormTestDriver } from "@argusvane/datum-engine/form-tests";
import { FormulaFunctionRegistry } from "@argusvane/datum-engine/registry";
import { EagerJourneyEngine, FormRuntime } from "@argusvane/datum-engine/runtime";
import { createQuickJsValidationHost } from "@argusvane/datum-quickjs-wasm-host";

import type { SideEnvironment } from "./api.js";

/**
 * The kernel side's host, made once per run and shared by every scenario (each scenario still
 * gets a fresh driver): QuickJS over the given program file, else the in-process kernel, which
 * is in the bundle, so `--runner both` never needs a file.
 */
export async function createSideHost(environment: SideEnvironment): Promise<WasmValidationHost> {
  if (environment.program !== undefined) {
    return createQuickJsValidationHost([], { program: environment.program.text });
  }
  return createInProcessWasmValidationHost();
}

/** Lets go of a host that holds a QuickJS instance; the in-process one holds nothing but answers the same call. */
export function disposeSideHost(host: WasmValidationHost | undefined): void {
  const disposable = host as { dispose?: () => void } | undefined;
  if (typeof disposable?.dispose === "function") {
    try {
      disposable.dispose();
    } catch {
      /* a host that fails to let go must not change the run's result */
    }
  }
}

/** A plugin function as the runtime's registry takes it, from the arity its signature gives. */
function registryOf(functions: Record<string, (args: unknown[]) => unknown>, signatures: readonly FormulaFunctionSignature[]): FormulaFunctionRegistry {
  const registry = new FormulaFunctionRegistry();
  for (const name of Object.keys(functions)) {
    const evaluate = functions[name] as (args: unknown[]) => unknown;
    const signature = signatures.find((entry) => entry.name === name);
    const min = signature?.min ?? 0;
    const max = signature?.max ?? Infinity;
    const variadic = !Number.isFinite(max);
    const count = variadic ? Math.max(min, 1) : max;
    const params = Array.from({ length: count }, (_, index) => (index < min ? `arg${index + 1}` : `arg${index + 1}?`));
    registry.register(
      { name, params, ...(variadic ? { variadic: true as const, min } : { min }), summary: name, example: `${name}()`, evaluate },
      "datum-form-test"
    );
  }
  return registry;
}

/**
 * The runtime factory over an environment: the parity test's wiring (a `submit` mode that
 * validates, the field constraints stage, the eager journey engine, the in-process sandbox the
 * runtime checks against at submit), plus the environment's plugin functions when it has some,
 * with the scenario's givens spread last so a given always wins.
 */
export function runtimeFactoryOf(environment: SideEnvironment): FormTestRuntimeFactory {
  const functions = environment.functions;
  return (definition: FormDefinition, givens) => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    return new FormRuntime(definition, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
      journeyEngine: EagerJourneyEngine,
      wasmValidationHost: createInProcessWasmValidationHost([]),
      ...(functions !== undefined && Object.keys(functions).length > 0 ? { formulaFunctions: registryOf(functions, environment.signatures ?? []) } : {}),
      ...givens
    });
  };
}

/** The factory with no plugin functions: what the command line runs. */
export const makeRuntime: FormTestRuntimeFactory = runtimeFactoryOf({});

export function makeRuntimeDriver(definition: FormDefinition, environment: SideEnvironment): FormTestDriver {
  return createFormTestRuntimeDriver(definition, {
    makeRuntime: runtimeFactoryOf(environment),
    ...(environment.functions !== undefined ? { functions: environment.functions } : {}),
    ...(environment.signatures !== undefined ? { signatures: environment.signatures } : {})
  });
}

export function makeKernelDriver(definition: FormDefinition, host: WasmValidationHost, environment: SideEnvironment): FormTestDriver {
  return createFormTestKernelDriver(definition, {
    host,
    ...(environment.functions !== undefined ? { functions: environment.functions } : {}),
    // The kernel driver takes `signatures` as the whole table, while the runtime driver adds the
    // given ones to the built-ins. Given alone they would make `today()` and `age()` unknown on
    // the kernel side only, and every such form a false parity difference.
    ...(environment.signatures !== undefined ? { signatures: [...formulaFunctionSignatures(), ...environment.signatures] } : {})
  });
}
