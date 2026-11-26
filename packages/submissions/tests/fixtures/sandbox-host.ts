import { VALIDATION_PROFILE, buildSandboxProgram, createQuickJsProgramHost, type QuickJsProgramHost } from "@argusvane/datum-quickjs-wasm-host";

/**
 * A QuickJS host with the sandbox program loaded, as a server sample runs it: the program is
 * evaluated under the startup budget and the judgements under the per-run one, the way the host
 * adapter does (`instantiateSandbox`). Loading the program under the per-run budget fails on a
 * busy machine, the program being some 600 KB of source.
 */
export async function sandboxProgramHost(program: string = buildSandboxProgram()): Promise<QuickJsProgramHost> {
  const host = await createQuickJsProgramHost({ hardening: false, limits: { maxEvalMs: 2_000 } });
  try {
    host.evaluate(program, "datum-sandbox-program.js");
  } catch (error) {
    host.dispose();
    throw error;
  }
  host.limits.maxEvalMs = VALIDATION_PROFILE.maxEvalMs;
  return host;
}
