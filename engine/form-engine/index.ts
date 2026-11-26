export * from "./core/index.js";
export * from "./builder/index.js";
export * from "./runtime/index.js";
export { createFormTestRuntimeDriver, runFormTestsOnRuntime } from "./runtime/browser/form-test-runtime-driver.js";
export type {
  FormTestRuntimeDriverOptions,
  FormTestRuntimeFactory,
  FormTestRuntimeGivens,
  FormTestSourceProblems
} from "./runtime/browser/form-test-runtime-driver.js";
export * from "./render/index.js";
// The studio look's dark palette as a builder theme: a small module with no side
// effects, so the renderer bundle can register it without the builder's code or the token list.
export * from "./builder/web-component/studio-dark-theme.js";
// The builder-shell theme type and its registry: a leaf module, for the same reason.
export * from "./builder/web-component/builder-theme-registry.js";
// The size sentence for a definition past its cap, shared by the builder's Open and the elements: pure, so it adds nothing to a bundle.
export { bytesInWords, definitionSizeProblem } from "./builder/web-component/definition-size.js";
// The Submit button a new form starts with, shared by the builder element and Try it: pure, so it adds nothing to a bundle.
export { isStarterSubmitButton, starterSubmitButton } from "./builder/web-component/starter-submit.js";
export * from "./registry/index.js";
export * from "./validation/core/validation-pipeline.js";
export * from "./validation/core/field-constraints.js";
export * from "./validation/core/test-vectors.js";
export * from "./validation/wasm/wasm-validation-host.js";
export * from "./validation/wasm/in-process-host.js";
export * from "./validation/wasm/portable-kernel.js";
// Form tests: the two drivers, named so the root gains no other symbol. Both are pure
// modules; the parser, judge and runner they run on are the `./form-tests` subpath's.
export { createFormTestKernelDriver } from "./validation/wasm/form-test-kernel-driver.js";
export type { FormTestKernelDriverOptions } from "./validation/wasm/form-test-kernel-driver.js";
export * from "./validation/server/server-validation.js";
export * from "./validation/parity/index.js";
export * from "./data/index.js";
export * from "./persistence/index.js";
export * from "./plugins/index.js";
export * from "./verification/release-gates.js";
export * from "./verification/gate-inputs.js";
export * from "./verification/telemetry.js";
export * from "./verification/telemetry-sinks.js";
export * from "./verification/telemetry-bridge.js";
