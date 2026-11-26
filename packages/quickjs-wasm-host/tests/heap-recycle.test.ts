import { describe, expect, it } from "vitest";
import { WasmValidationHost, type ComponentNode } from "@argusvane/datum-engine";

import { SandboxRecycler } from "../src/heap-recycle.js";
import { createQuickJsValidationHost, loadQuickJs } from "../src/index.js";

const form = (): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content: [] } }) as unknown as ComponentNode;
const run = (host: { run(request: never): Promise<{ errors: { code: string }[] }> | { errors: { code: string }[] } }) =>
  host.run({ context: { formId: "f", values: {}, locale: "en", form: form() }, policy: WasmValidationHost.STRICT_POLICY } as never);
// Strings built inside the sandbox are not counted by memoryLimitBytes.
const hog = [{ id: "p", version: "1", source: `({ validators: [ (c) => { const a = []; for (let i = 0; i < 40; i++) a.push('x'.repeat(3e6) + i); return { errors: [] }; } ] })` }];

describe("heap recycle", () => {
  it("replaces the sandbox over a fresh module after a run left the module's heap past the threshold", async () => {
    const before = loadQuickJs();
    const host = await createQuickJsValidationHost(hog, { memoryLimitBytes: 4 * 1024 * 1024, maxEvalMs: 30000, recycleHeapBytes: 64 * 1024 * 1024 });
    expect(loadQuickJs()).toBe(before);
    await run(host as never);
    // the shared module was dropped, so the next sandbox gets a new WASM memory
    expect(loadQuickJs()).not.toBe(before);
    expect((await run(host as never)).errors).toEqual([]); // the same host still answers
    host.dispose();
  }, 60000);

  it("leaves the module alone while the heap stays under the threshold", async () => {
    const host = await createQuickJsValidationHost([], { maxEvalMs: 5000 });
    const before = loadQuickJs();
    await run(host as never);
    expect(loadQuickJs()).toBe(before);
    host.dispose();
  });

  const fake = (heap: number | undefined, poisoned = false) => {
    const host = { disposed: 0, discarded: 0, poisoned, moduleHeapBytes: () => heap, discardModule() { this.discarded += 1; }, dispose() { this.disposed += 1; } };
    return { host };
  };

  it("swaps in the rebuilt sandbox and disposes the old one", async () => {
    const old = fake(200);
    const next = fake(1);
    const recycler = new SandboxRecycler(old as never, async () => next as never, 100);
    recycler.afterRun();
    expect(recycler.sandbox).toBe(old); // runs meanwhile use the old sandbox
    await recycler.settled;
    expect(recycler.sandbox).toBe(next);
    expect(old.host.discarded).toBe(1);
    expect(old.host.disposed).toBe(1);
  });

  it("reports a failed rebuild, keeps the old sandbox and retries after the next run", async () => {
    const old = fake(200);
    const next = fake(1);
    const errors: unknown[] = [];
    let attempts = 0;
    const recycler = new SandboxRecycler(old as never, async () => { attempts += 1; if (attempts === 1) throw new Error("boom"); return next as never; }, 100, (e) => errors.push(e));
    recycler.afterRun();
    await recycler.settled;
    expect(errors).toHaveLength(1);
    expect(recycler.sandbox).toBe(old);
    expect(old.host.disposed).toBe(0);
    recycler.afterRun();
    await recycler.settled;
    expect(recycler.sandbox).toBe(next);
  });

  it("does not leave an unhandled rejection when the old host throws on dispose", async () => {
    const old = fake(200);
    old.host.dispose = () => { throw new Error("abort"); };
    const next = fake(1);
    const errors: unknown[] = [];
    const recycler = new SandboxRecycler(old as never, async () => next as never, 100, (e) => errors.push(e));
    recycler.afterRun();
    await recycler.settled;
    expect(recycler.sandbox).toBe(next);
    expect(errors).toHaveLength(1);
  });
});
