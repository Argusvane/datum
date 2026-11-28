/**
 * How `<datum-form>` finds the sandbox module (`wasm.ts`, built as `dist/datum-wasm.js`) from
 * the `wasm` attribute: `"auto"` loads it from beside the running bundle, anything else is a
 * URL resolved against the page (the element takes the attribute only on the page's origin or
 * one `allow-origins` lists; the property may name any). The module is fetched once per URL and shared by every
 * element on the page; each element builds a host of its own from it, since the plugins are
 * wired in at instantiation.
 */
import { WASM_ABI_VERSION, type WasmPluginModule, type WasmValidationHost } from "@argusvane/datum-engine";

import { ChunkLoadError, importUrl, noteImportFailure } from "./chunk-load-error.js";
import { IntegrityError, importWithIntegrity } from "./integrity.js";
import type { CreateWasmValidationHostOptions } from "./wasm.js";

interface WasmModule {
  /** The ABI the module's sandbox speaks (`wasm.ts` re-exports the engine's constant). */
  WASM_ABI_VERSION?: unknown;
  createWasmValidationHost?: (
    plugins?: readonly WasmPluginModule[],
    options?: CreateWasmValidationHostOptions
  ) => Promise<WasmValidationHost>;
}

const loads = new Map<string, Promise<WasmModule>>();

/** Where `"auto"` points: the sandbox module beside this bundle (`import.meta.url` is the bundle's own URL). */
export function defaultWasmModuleUrl(): string {
  return new URL(/* @vite-ignore */ "./datum-wasm.js", import.meta.url).href;
}

/** Resolves the `wasm` attribute's value to the module URL. */
export function resolveWasmModuleUrl(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "auto") {
    return defaultWasmModuleUrl();
  }
  return new URL(trimmed, document.baseURI).href;
}

/** What loading the sandbox may be told besides where it is. */
export interface LoadWasmOptions {
  /** Milliseconds the module may take to arrive and build a host before the load fails; `0` or unset, no limit. */
  timeoutMs?: number | undefined;
  /**
   * Subresource Integrity the module is held to (`sha384-...`, as `<script integrity>` takes it).
   * Set, the module is fetched, its bytes are checked, and those bytes are imported from a `blob:`
   * URL; a module that does not match is never run. Unset, the module is imported by its URL.
   */
  integrity?: string | undefined;
}

/**
 * Loads the sandbox module at `spec` (see {@link resolveWasmModuleUrl}) and builds a host over
 * `plugins` from it. The load fails, and the failure is not cached, when the module speaks
 * another ABI than this element (or does not say which: a module built before the ABI export
 * was added is as stale as one built for 2.8) and when it takes longer than `timeoutMs`; a
 * host that arrives after the timeout is disposed, since nothing will hold it.
 */
export function loadWasmValidationHost(
  spec: string,
  plugins: readonly WasmPluginModule[],
  options: LoadWasmOptions = {}
): Promise<WasmValidationHost> {
  const work = loadHost(spec, plugins, options.integrity);
  const ms = options.timeoutMs;
  if (ms === undefined || !(ms > 0)) {
    return work;
  }
  return new Promise<WasmValidationHost>((resolve, reject) => {
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      reject(new Error(`The sandbox module at ${resolveWasmModuleUrl(spec)} did not load within ${ms} ms`));
    }, ms);
    work.then(
      (host) => {
        clearTimeout(timer);
        if (late) {
          host.dispose();
        } else {
          resolve(host);
        }
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function loadHost(spec: string, plugins: readonly WasmPluginModule[], integrity: string | undefined): Promise<WasmValidationHost> {
  const url = resolveWasmModuleUrl(spec);
  const checked = integrity !== undefined && integrity.trim() !== "";
  // A module held to a hash is a load of its own: one imported by URL is not proof of the hash.
  const key = checked ? `${url}\n${integrity.trim()}` : url;
  let load = loads.get(key);
  if (!load) {
    const imported: Promise<WasmModule> = checked ? importWithIntegrity<WasmModule>(url, integrity.trim(), `The sandbox module at ${url}`) : import(/* @vite-ignore */ importUrl(url));
    load = imported.then((module: WasmModule) => {
      // A module that loaded but is unusable is retried through a fresh URL too, so a corrected
      // deployment at the same URL is fetched, not served from the module map.
      if (typeof module.createWasmValidationHost !== "function") {
        noteImportFailure(url);
        throw new Error(`The sandbox module at ${url} does not export createWasmValidationHost()`);
      }
      // Fail closed on a stale sandbox: a program of another ABI would judge
      // submissions by other rules (a 2.8 program checks no choice answer), and never run.
      if (module.WASM_ABI_VERSION !== WASM_ABI_VERSION) {
        noteImportFailure(url);
        const found = typeof module.WASM_ABI_VERSION === "string" ? `ABI ${module.WASM_ABI_VERSION}` : "no ABI version";
        throw new Error(`The sandbox module at ${url} speaks ${found}, this element needs ABI ${WASM_ABI_VERSION}; rebuild or update datum-wasm.js`);
      }
      return module;
    }, (error: unknown): never => {
      if (error instanceof IntegrityError) {
        throw error;
      }
      // A module that is not there (deleted, blocked, a 404) names itself; forgotten below.
      noteImportFailure(url);
      throw new ChunkLoadError(`The sandbox module (${url})`, error);
    });
    load.catch(() => loads.delete(key));
    loads.set(key, load);
  }
  const module = await load;
  return module.createWasmValidationHost!(plugins);
}
