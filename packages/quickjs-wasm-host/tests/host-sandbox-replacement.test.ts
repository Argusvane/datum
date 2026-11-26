import { describe, expect, it } from "vitest";

import { WASM_ABI_VERSION, stableStringify, type ComponentNode, type WasmAbi } from "@argusvane/datum-engine";

import { SandboxRecycler } from "../src/heap-recycle.js";
import { QuickJsWasmHostAdapter, loadQuickJs } from "../src/index.js";
import { createQuickJsWorkerHost } from "../src/worker-host.js";

/**
 * A sandbox that cannot be trusted to run again is replaced, never reused: on the synchronous
 * adapter, one a host-side error poisoned (its runtime abandoned) and one an inspect's `test` op
 * grew past the heap threshold; on the worker host, where no sandbox outlives its call, a call
 * that passed the heap ceiling leaves nothing for the next.
 */

const ABI = { version: WASM_ABI_VERSION } as unknown as WasmAbi;
const form = (ids: string[]): ComponentNode =>
  ({ id: "form", type: "form", configuration: {}, children: { content: ids.map((id) => ({ id, type: "text", configuration: {} })) } }) as unknown as ComponentNode;
const probes = form(["flag", "size"]);
const context = (values: Record<string, unknown> = {}): string => JSON.stringify({ formId: "f", values, locale: "en", form: probes });
const plugin = (body: string, pre = "") => [{ id: "p", version: "1", source: `(function(){ ${pre} return { validators: [ (c) => { ${body} } ] }; })()` }];

describe("replacing a sandbox that cannot run again", () => {
  it("replaces a poisoned sandbox over a fresh module: runs are refused until the swap, then go to the new runtime", async () => {
    // A plugin recursion deep enough to overflow the real WASM stack before QuickJS's own check
    // poisons the host; the counter tells a fresh sandbox (1) from the old one (2 and up).
    const plugins = plugin(
      "count += 1; if (c.values.flag) { var r = function (n) { return n === 0 ? 0 : r(n - 1) + 1; }; r(200000); } return { errors: [{ code: 'seen', parameters: { count: count } }] };",
      "var count = 0;"
    );
    const instance = await new QuickJsWasmHostAdapter({ maxEvalMs: 5000 }).instantiate(plugins, ABI);
    try {
      const module = loadQuickJs();
      expect(() => instance.run(context({ flag: "1" }))).toThrow(/abandoned/);
      expect(loadQuickJs()).not.toBe(module);
      expect(() => instance.run(context())).toThrow(expect.objectContaining({ code: "runtime_error", message: expect.stringContaining("being replaced") }));
      let answer: string | undefined;
      for (let attempt = 0; attempt < 200 && answer === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        try {
          answer = instance.run(context()) as string;
        } catch {
          // still being replaced
        }
      }
      expect((JSON.parse(answer as string) as { errors: { parameters?: { count?: number } }[] }).errors[0]?.parameters?.count).toBe(1);
    } finally {
      instance.dispose?.();
    }
  }, 60_000);

  it("retries a failed replacement of a poisoned sandbox on the next run", async () => {
    const fake = (poisoned: boolean) => ({ host: { poisoned, disposed: 0, discarded: 0, moduleHeapBytes: () => 1, discardModule() { this.discarded += 1; }, dispose() { this.disposed += 1; } } });
    const old = fake(true);
    const next = fake(false);
    let attempts = 0;
    const errors: unknown[] = [];
    const recycler = new SandboxRecycler(old as never, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("boom");
      }
      return next as never;
    }, 100, (error) => errors.push(error));
    recycler.afterRun();
    await recycler.settled;
    expect(errors).toHaveLength(1);
    expect(() => recycler.usable()).toThrow(/being replaced/);
    await recycler.settled;
    expect(recycler.usable()).toBe(next);
    expect(old.host.discarded).toBe(2);
  });

  it("recycles the sandbox after an inspect whose test op grew the module's heap, as after a run", async () => {
    const hog = plugin("if (c.values.flag) { var a = []; for (var i = 0; i < 40; i++) { a.push('x'.repeat(3e6) + i); } } return { errors: [] };");
    const instance = await new QuickJsWasmHostAdapter({ maxEvalMs: 20_000, recycleHeapBytes: 64 * 1024 * 1024, memoryLimitBytes: 4 * 1024 * 1024 }).instantiate(hog, ABI);
    try {
      const module = loadQuickJs();
      const definition = { id: "t", version: "1", schemaVersion: "1.0.0", root: probes };
      const tests = ['test "grow"', '  set flag = "1"', "  submit", "  expect accepted"].join("\n");
      const answer = JSON.parse(await instance.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "test", definition, tests }))) as { ok: boolean };
      expect(answer.ok).toBe(true);
      // The shared module was dropped, so the next sandbox gets a new WASM memory.
      expect(loadQuickJs()).not.toBe(module);
    } finally {
      instance.dispose?.();
    }
  }, 60_000);

  it("answers the call after one whose heap passed maxWasmHeapBytes, in a small memory of its own", async () => {
    const host = await createQuickJsWorkerHost({
      // Small steps, so the ceiling (checked at each interrupt poll) ends the call near it.
      plugins: plugin("if (c.values.flag) { const a = []; for (let i = 0; i < 2000000; i++) a.push('x'.repeat(2000) + i); } return { errors: [] };"),
      memoryLimitBytes: 1024 * 1024 * 1024,
      maxWasmHeapBytes: 96 * 1024 * 1024,
      maxEvalMs: 30_000
    });
    try {
      await expect(host.run(context({ flag: "1" }))).rejects.toMatchObject({ code: "interrupted", message: expect.stringContaining("memory") });
      expect((JSON.parse(await host.run(context())) as { errors: unknown[] }).errors).toEqual([]);
      expect(host.heapBytes ?? Infinity).toBeLessThan(64 * 1024 * 1024);
      expect(host.starts).toBe(1);
    } finally {
      await host.dispose();
    }
  }, 120_000);
});
