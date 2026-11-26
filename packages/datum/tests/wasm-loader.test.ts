// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { WASM_ABI_VERSION } from "@argusvane/datum-engine";

import { importUrl } from "../src/chunk-load-error.js";
import { loadWasmValidationHost } from "../src/wasm-loader.js";

const mod = (body: string) => `data:text/javascript,${encodeURIComponent(body)}`;
const fnExport = "export async function createWasmValidationHost(){ return { run: async () => ({errors: []}), dispose(){} }; }";

describe("wasm loader", () => {
  it("refuses a module of another ABI, with none, or without the export", async () => {
    const wrong = mod(`export const WASM_ABI_VERSION="0.0.1";${fnExport}`);
    const none = mod(fnExport);
    const noFn = mod(`export const WASM_ABI_VERSION=${JSON.stringify(WASM_ABI_VERSION)};`);
    for (const url of [wrong, none, noFn]) {
      await expect(loadWasmValidationHost(url, [])).rejects.toThrow(/ABI|createWasmValidationHost/);
    }
  });

  // The retry must ask for a URL the browser's module map has never seen.
  it("marks an ABI-mismatched or export-less URL for a fresh import on the next try", async () => {
    const wrong = mod(`export const WASM_ABI_VERSION="0.0.2";${fnExport}`);
    const noFn = mod(`export const WASM_ABI_VERSION=${JSON.stringify(WASM_ABI_VERSION)};/*retry*/`);
    for (const url of [wrong, noFn]) {
      expect(importUrl(url)).toBe(url);
      await expect(loadWasmValidationHost(url, [])).rejects.toThrow();
      expect(importUrl(url)).not.toBe(url);
    }
  });
});
