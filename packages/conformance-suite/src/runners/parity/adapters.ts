import {
  coreDeterministicValidator,
  coreValidationRoot,
  createInProcessWasmValidationHost,
  createWasmAdapter,
  WasmValidationHost,
  type DeterministicRuntimeAdapter,
  type ValidationContext,
  type WasmPlugin
} from "@argusvane/datum-engine";
import { QuickJsWasmHostAdapter, toSourcePlugin } from "@argusvane/datum-quickjs-wasm-host";

/** The shared core validator as a plugin: a function for the kernel, derived source for the program. */
const CORE_PLUGIN: WasmPlugin = {
  id: "core",
  version: "1.0.0",
  validators: [{ id: "core", version: "1.0.0", validate: coreDeterministicValidator }]
};

export interface ParityAdapters {
  /** `kernel` (in process) first, `program` (the file under test, in QuickJS) second. */
  adapters: DeterministicRuntimeAdapter[];
  dispose(): void;
}

/**
 * A run that throws is an observation, not a crash: the adapter answers with one error whose code
 * carries the message, so two engines that both throw the same thing agree and one that throws
 * alone disagrees.
 */
function guarded(adapter: DeterministicRuntimeAdapter): DeterministicRuntimeAdapter {
  return {
    id: adapter.id,
    run: async (context: ValidationContext) => {
      try {
        return await adapter.run(context);
      } catch (error) {
        return { errors: [{ code: `adapter.threw:${error instanceof Error ? error.message : String(error)}`, stage: "form", source: "client" }] } as never;
      }
    }
  };
}

/**
 * The two adapters the engine's `runParity` compares for PAR-01 and PAR-02: both built by the
 * engine's own `createWasmAdapter` over {@link coreValidationRoot}, one on the in-process kernel
 * and one on the program file. The ids differ (the engine's `id` is open), so they
 * do not collide on "wasm".
 */
export async function openParityAdapters(programText: string): Promise<ParityAdapters> {
  const kernelHost = createInProcessWasmValidationHost([CORE_PLUGIN]);
  // The program under test may be of another ABI: the suite's own checks report that, so the
  // host does not refuse it first.
  const programHost = await WasmValidationHost.create([toSourcePlugin(CORE_PLUGIN)], {
    adapter: new QuickJsWasmHostAdapter({ program: programText, checkProgramAbi: false })
  });
  return {
    adapters: [
      guarded({ ...createWasmAdapter(kernelHost, coreValidationRoot), id: "kernel" }),
      guarded({ ...createWasmAdapter(programHost, coreValidationRoot), id: "program" })
    ],
    dispose: () => {
      kernelHost.dispose();
      programHost.dispose();
    }
  };
}
