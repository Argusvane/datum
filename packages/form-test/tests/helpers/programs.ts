import { buildSandboxProgram } from "@argusvane/datum-quickjs-wasm-host";

let built: string | undefined;

/**
 * The sandbox program built from the engine's source, as the conformance suite's tests get one
 * (vitest runs the Vite SSR transform `buildSandboxProgram` reads function sources through). The
 * bundled command never builds one: it takes `--program <file>`.
 */
export function builtProgramText(): string {
  built ??= buildSandboxProgram();
  return built;
}
