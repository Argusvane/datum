import { fileURLToPath } from "node:url";

import { build, type Plugin } from "vite";
import { describe, expect, it } from "vitest";

/**
 * `WasmValidationHost` has no default adapter, so a bundle that builds a host over a sandbox
 * instance — `<datum-form>`'s, which defers to the QuickJS sandbox in `datum-wasm.js` — leaves
 * the portable kernel out. A default in-process adapter put all of it (the fold, the journey
 * path engine, the evaluator) in `datum-form.js` through the constructor's reference alone.
 * Built with Vite's production bundler, as the web components are.
 */

const ENGINE = fileURLToPath(new URL("../form-engine/index.ts", import.meta.url));

async function bundle(source: string): Promise<string> {
  const entry: Plugin = {
    name: "probe-entry",
    // Library mode resolves its entry against the root first.
    resolveId: (id) => (id === "probe-entry" || id.endsWith("/probe-entry") ? "\0probe-entry" : undefined),
    load: (id) => (id === "\0probe-entry" ? source : undefined)
  };
  const output = await build({
    logLevel: "silent",
    configFile: false,
    plugins: [entry],
    build: { write: false, minify: false, lib: { entry: "probe-entry", formats: ["es"], fileName: "probe" } }
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !("output" in result)) {
    throw new Error("the probe build returned no output");
  }
  return result.output[0].code;
}

describe("wasm validation host: bundle weight", () => {
  it("leaves the portable kernel out of a bundle that hands the host an instance", async () => {
    const code = await bundle(
      `import { WasmValidationHost, WASM_ABI_VERSION } from ${JSON.stringify(ENGINE)};\n` +
        `export const host = new WasmValidationHost([], { instance: { abiVersion: WASM_ABI_VERSION, run: () => "{}" } });\n`
    );
    // The host itself is there (its policy check), the kernel is not.
    expect(code).toContain("policy must remain fully restricted");
    expect(code).not.toContain("function runKernel");
    expect(code).not.toContain("function kernelFoldSubmittable");
    expect(code).not.toContain("journey.invalid");
  }, 60_000);

  it("carries the kernel only where the in-process path is asked for by name", async () => {
    const code = await bundle(
      `import { createInProcessWasmValidationHost } from ${JSON.stringify(ENGINE)};\n` +
        `export const host = createInProcessWasmValidationHost();\n`
    );
    expect(code).toContain("function runKernel");
  }, 60_000);
});
