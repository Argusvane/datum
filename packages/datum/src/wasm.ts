/**
 * The sandbox module: the QuickJS/WASM validation host as one lazily loaded file.
 *
 * Built as `dist/datum-wasm.js` (a module only — never part of the classic scripts, the line
 * that keeps the sandbox out of them). `<datum-form wasm>` `import()`s it beside its own bundle
 * once the form is ready, or from the URL the attribute names, and wires it with the page's
 * `wasmPlugins`; a page may also import it itself and hand `createWasmValidationHost()`'s
 * result to `wasmValidationHost`. The QuickJS binary is embedded in the module, so there is
 * no asset to fetch beside it.
 */
import type { WasmPluginModule, WasmValidationHost } from "@argusvane/datum-engine";
import { createQuickJsValidationHost, type QuickJsValidationHostOptions } from "@argusvane/datum-quickjs-wasm-host";

// The ABI this module's sandbox speaks: `<datum-form>` compares it with its own before running
// anything in a module it loaded, and refuses a stale one.
export { WASM_ABI_VERSION } from "@argusvane/datum-engine";

export type CreateWasmValidationHostOptions = QuickJsValidationHostOptions;

/**
 * A ready sandbox: the portable kernel — schema constraints and sanitization, always — plus
 * the given plugin modules, each `{ id, version, source }` with `source` an ES2020 program
 * whose value is `{ validators: [(context) => ({ errors })] }`. Wired once, run per submit.
 */
export function createWasmValidationHost(
  plugins: readonly WasmPluginModule[] = [],
  options: CreateWasmValidationHostOptions = {}
): Promise<WasmValidationHost> {
  return createQuickJsValidationHost(plugins, options);
}

// The authoring tools beside the host: prove a module runs in QuickJS before shipping it,
// and derive portable source from a closure-free hosted function.
export { certifyWasmPlugin, toSourcePlugin, type WasmPluginCertification } from "@argusvane/datum-quickjs-wasm-host";
