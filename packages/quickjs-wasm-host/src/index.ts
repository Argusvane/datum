export {
  QuickJsWasmHostAdapter,
  QuickJsExecutionError,
  createQuickJsValidationHost,
  certifyWasmPlugin,
  abiProbeRequest,
  inspectBudget,
  proveProgramAbi,
  withRequestSize,
  SCALED_MS_PER_REQUEST_KB,
  type QuickJsWasmHostAdapterOptions,
  type QuickJsValidationHostOptions,
  type QuickJsExecutionErrorCode,
  type WasmPluginCertification
} from "./quickjs-wasm-host-adapter.js";
export { FREEZE_INTRINSICS_SNIPPET, INTRINSIC_ALIASES, SANDBOX_ENTRY_POINTS, buildSandboxProgram, toSourceModule, toSourcePlugin, type SandboxProgramOptions } from "./sandbox-program.js";
export {
  QuickJsProgramHost,
  assertRequestWithinLimits,
  createQuickJsProgramHost,
  loadQuickJs,
  DOCUMENT_PROFILE,
  HARDENING_PRELUDE,
  VALIDATION_PROFILE,
  type QuickJsProgramHostOptions,
  type QuickJsProgramLimits
} from "./program-host.js";
export { QuickJsFreshSandboxHost, createQuickJsFreshSandboxHost, type QuickJsFreshSandboxHostOptions } from "./fresh-sandbox-host.js";
