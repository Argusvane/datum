import { describe, expect, it } from "vitest";

import { WASM_ABI_VERSION, type ComponentNode } from "@argusvane/datum-engine";

import { QuickJsExecutionError, createQuickJsValidationHost } from "../src/index.js";
import { createQuickJsWorkerHost, type QuickJsWorkerHost } from "../src/worker-host.js";
import { SLOW_FACTOR } from "./slow-machine.js";

/**
 * The sandbox on its own thread: a call into native code the interrupt handler cannot reach is
 * ended by terminating the worker and the next call starts a new one; every call runs in a
 * sandbox of its own, so memory one call grew is gone for the next, on the same thread.
 */

const form = (children: unknown[] = []): ComponentNode =>
  ({ id: "form", type: "form", configuration: {}, children: { content: children } }) as unknown as ComponentNode;
const required = form([{ id: "name", type: "text", configuration: { required: true } }]);
// A form with answers a plugin reads (an unknown key would be stripped before it).
const probes = form(["flag", "size"].map((id) => ({ id, type: "text", configuration: {} })));
const context = (values: Record<string, unknown> = {}, root: ComponentNode = required): string => JSON.stringify({ formId: "f", values, locale: "en", form: root });
const plugin = (body: string) => [{ id: "p", version: "1", source: `({ validators: [ (c) => { ${body} } ] })` }];
const codes = (answer: string): string[] => (JSON.parse(answer) as { errors: { code: string }[] }).errors.map((error) => error.code);

async function withHost<T>(host: QuickJsWorkerHost, body: (host: QuickJsWorkerHost) => Promise<T>): Promise<T> {
  try {
    return await body(host);
  } finally {
    await host.dispose();
  }
}

describe("QuickJsWorkerHost", () => {
  it("answers a run byte for byte as the synchronous host does", async () => {
    const sync = await createQuickJsValidationHost([]);
    const worker = await createQuickJsWorkerHost();
    try {
      for (const values of [{}, { name: "Ada" }, { name: "" }]) {
        const viaWorker = JSON.parse(await worker.run(context(values))) as { errors: { code: string }[]; values?: unknown };
        const viaSync = await sync.run({ context: { formId: "f", values, locale: "en", form: required }, policy: { allowNetwork: false, allowFilesystem: false, allowProcess: false, allowEnvironment: false } });
        expect(viaWorker.errors.map((error) => error.code)).toEqual(viaSync.errors.map((error) => error.code));
        expect(viaWorker.values).toEqual(viaSync.values);
      }
      const inspected = JSON.parse(await worker.inspect(JSON.stringify({ abi: WASM_ABI_VERSION, op: "inspect", definition: { root: required } }))) as { ok: boolean };
      expect(inspected.ok).toBe(true);
    } finally {
      sync.dispose();
      await worker.dispose();
    }
  }, 60_000);

  it("kills a runaway native call near its budget, and keeps answering on a fresh worker", async () => {
    // 150 splits of a megabyte string run for seconds in native code the interrupt handler never reaches.
    const host = await createQuickJsWorkerHost({
      plugins: plugin("const s='x'.repeat(1e6); let n=0; for(let i=0;i<150&&c.values.flag;i++){ n+=s.split('').length; } return {errors:[]};"),
      maxEvalMs: 250,
      killSlackMs: 250
    });
    await withHost(host, async () => {
      const started = Date.now();
      await expect(host.run(context({ flag: "1" }, probes))).rejects.toMatchObject({ code: "interrupted" });
      const took = Date.now() - started;
      // Budget + slack, with room for a loaded machine; the synchronous host took over five seconds.
      expect(took).toBeLessThan(3000 * SLOW_FACTOR);
      expect(host.kills).toBe(1);
      // The service keeps answering: a new worker, the same program and plugins.
      expect(codes(await host.run(context({}, probes)))).toEqual([]);
      expect(host.starts).toBe(2);
      expect(codes(await host.run(context({ flag: "" }, probes)))).toEqual([]);
      expect(host.starts).toBe(2);
    });
  }, 60_000);

  it("ends an interruptible runaway through the worker's own deadline, with no kill", async () => {
    const host = await createQuickJsWorkerHost({ plugins: plugin("while (true) {}"), maxEvalMs: 200 });
    await withHost(host, async () => {
      await expect(host.run(context({}, probes))).rejects.toMatchObject({ code: "interrupted" });
      expect(host.kills).toBe(0);
      expect(host.starts).toBe(1);
    });
  }, 60_000);

  it("runs every call in a WebAssembly memory of its own: memory one call grew is gone for the next, on the same thread", async () => {
    const host = await createQuickJsWorkerHost({
      plugins: plugin("const a=[]; for(let i=0;i<200&&c.values.flag;i++) a.push('x'.repeat(1e6)); return {errors:[]};"),
      memoryLimitBytes: 4 * 1024 * 1024,
      maxEvalMs: 20_000
    });
    await withHost(host, async () => {
      // 200 MiB of string data outlives the 4 MiB limit (QuickJS does not count it), and a WASM memory never shrinks.
      expect(codes(await host.run(context({ flag: "1" }, probes)))).toEqual([]);
      const grown = host.heapBytes ?? 0;
      expect(grown).toBeGreaterThan(128 * 1024 * 1024);
      // The next call ran in another memory, small again, and no thread was replaced for it.
      expect(codes(await host.run(context({}, probes)))).toEqual([]);
      expect(host.heapBytes ?? Infinity).toBeLessThan(64 * 1024 * 1024);
      expect(host.starts).toBe(1);
    });
  }, 120_000);

  it("refuses an outcome past maxResultLength, a hostile request, and a call after dispose", async () => {
    const host = await createQuickJsWorkerHost({ plugins: plugin("return {errors:[{code:'c',stage:'plugin',source:'custom',severity:'error',message:'x'.repeat(Number(c.values.size||0))}]};"), maxResultLength: 1000, maxEvalMs: 5000 });
    await withHost(host, async () => {
      expect(codes(await host.run(context({ size: "10" }, probes)))).toEqual(["c"]);
      await expect(host.run(context({ size: "5000" }, probes))).rejects.toMatchObject({ code: "outcome_too_large" });
      await expect(host.run(`${"[".repeat(400)}${"]".repeat(400)}`)).rejects.toMatchObject({ code: "request_refused" });
      expect(codes(await host.run(context({ size: "10" }, probes)))).toEqual(["c"]);
    });
    await expect(host.run(context())).rejects.toBeInstanceOf(QuickJsExecutionError);
  }, 60_000);

  it("fails to start, typed, when a plugin does not load; and freezes the kernel against a plugin by default", async () => {
    await expect(createQuickJsWorkerHost({ plugins: [{ id: "broken", version: "1", source: "({ validators: [" }] })).rejects.toMatchObject({ code: "compile_error", message: expect.stringContaining('Plugin "broken"') });
    const host = await createQuickJsWorkerHost({ plugins: plugin("if (c.values.name === 'arm') { try { globalThis.kernelIsEmptyValue = function () { return false; }; } catch (e) {} } return {errors:[]};") });
    await withHost(host, async () => {
      await host.run(context({ name: "arm" }));
      expect(codes(await host.run(context({ name: "" })))).toEqual(["required"]);
    });
  }, 60_000);

  it("takes hold of the entry points at startup: a plugin that redefines the global names changes nothing", async () => {
    const host = await createQuickJsWorkerHost({
      plugins: plugin("if (c.values.name === 'arm') { try { Object.defineProperty(globalThis, '__datum_run', { value: function () { return '{\"errors\":[]}'; } }); Object.defineProperty(globalThis, 'kernelIsEmptyValue', { value: function () { return false; } }); } catch (e) {} } return {errors:[]};")
    });
    await withHost(host, async () => {
      await host.run(context({ name: "arm" }));
      expect(codes(await host.run(context({ name: "" })))).toEqual(["required"]);
    });
  }, 60_000);

  // A stand-in program that holds a worker busy long enough to kill it (and answers the host's ABI probe).
  const busyProgram = `globalThis.__datum_run = function () { var s = 'x'.repeat(1e6); for (var i = 0; i < 150; i++) { s.split('').length; } return '{"errors":[]}'; }; globalThis.__datum_inspect = function () { return '{"ok":true}'; }; globalThis.__datum_register = function () { return 0; }; 'ready';`;

  it("settles at once when it is disposed while a replacement worker boots, not after the boot timeout", async () => {
    const host = await createQuickJsWorkerHost({ program: busyProgram, maxEvalMs: 200, killSlackMs: 200 });
    await host.run('{"x":1}').catch(() => undefined); // killed: the next call boots a fresh worker
    const pending = host.run('{"x":2}').then(() => "ok", (error: { code?: string; message?: string }) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = Date.now();
    await host.dispose();
    expect(Date.now() - started).toBeLessThan(3000 * SLOW_FACTOR);
    expect(await pending).toMatch(/disposed/);
  }, 60_000);

  it("interrupts a call whose WASM memory passes maxWasmHeapBytes, and answers the next one on the same thread", async () => {
    const host = await createQuickJsWorkerHost({
      plugins: plugin("const a=[]; for(let i=0;i<3000&&c.values.flag;i++) a.push('x'.repeat(1e6)); return {errors:[]};"),
      memoryLimitBytes: 4 * 1024 * 1024,
      maxWasmHeapBytes: 160 * 1024 * 1024,
      maxEvalMs: 30_000
    });
    await withHost(host, async () => {
      const started = Date.now();
      await expect(host.run(context({ flag: "1" }, probes))).rejects.toMatchObject({ code: "interrupted", message: expect.stringContaining("memory") });
      // Before the 30 s budget: the ceiling, not the clock, ended it. Filling 160 MB takes as long as
      // the machine is busy, so the bound sits just under the budget rather than at the quiet-machine time.
      expect(Date.now() - started).toBeLessThan(27_000);
      expect(codes(await host.run(context({}, probes)))).toEqual([]);
      expect(host.heapBytes ?? Infinity).toBeLessThan(64 * 1024 * 1024);
      expect(host.starts).toBe(1);
    });
  }, 120_000);
});
