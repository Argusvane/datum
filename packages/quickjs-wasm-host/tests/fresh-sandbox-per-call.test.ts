import { describe, expect, it } from "vitest";

import { JsonWasmAbi, WASM_ABI_VERSION, type ComponentNode } from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter, createQuickJsFreshSandboxHost } from "../src/index.js";
import { createQuickJsWorkerHost } from "../src/worker-host.js";
import { SLOW_FACTOR } from "./slow-machine.js";

/**
 * The Node hosts give every call a sandbox of its own (a new WebAssembly instance, runtime and
 * context, the program and the plugins loaded afresh), so nothing one call did reaches the next:
 * the worker host on its thread, and the fresh-sandbox host behind `worker: false`.
 */

const form = (ids: string[]): ComponentNode =>
  ({ id: "form", type: "form", configuration: {}, children: { content: ids.map((id) => ({ id, type: "text", configuration: {} })) } }) as unknown as ComponentNode;
const probes = form(["flag"]);
const context = (values: Record<string, unknown> = {}): string => JSON.stringify({ formId: "f", values, locale: "en", form: probes });
const seen = (answer: string): Record<string, unknown> => (JSON.parse(answer) as { errors: { parameters?: Record<string, unknown> }[] }).errors[0]?.parameters ?? {};

// A plugin module with state of its own (a counter in its closure) that also leaves what it can
// behind when armed: a global, a property on an intrinsic's prototype (with the freeze off, so it
// can), and its module state. Each run reports what it found as it started.
const polluter = [
  {
    id: "polluter",
    version: "1",
    source: `(function () {
      var count = 0;
      var state = { armed: false };
      return { validators: [ function (c) {
        count += 1;
        var found = { count: count, armed: state.armed, global: typeof globalThis.leftBehind, proto: typeof Array.prototype.leftBehind };
        if (c.values.flag) {
          state.armed = true;
          globalThis.leftBehind = "yes";
          Array.prototype.leftBehind = "yes";
        }
        return { errors: [{ code: "seen", severity: "info", parameters: found }] };
      } ] };
    })()`
  }
];
const CLEAN = { count: 1, armed: false, global: "undefined", proto: "undefined" };

// A stand-in program that counts the calls made in its context, so an answer shows whether its
// sandbox ran anything before it: the ABI probe and the scaled budget's inspect question included.
// (The counter is a closure's: the freeze makes a top-level var of the program read-only.)
const COUNTING_PROGRAM = `
  (function () {
    var calls = 0;
    globalThis.__datum_register = function () { return 0; };
    globalThis.__datum_run = function () { calls += 1; return JSON.stringify({ errors: [{ code: "calls", severity: "info", parameters: { calls: calls } }] }); };
    globalThis.__datum_inspect = function (r) { calls += 1; return JSON.stringify({ ok: true, op: JSON.parse(r).op, rules: [], calls: calls }); };
  })();
  "ready";`;

// A stand-in program whose "grow" inspect request builds strings the sandbox's memory has to grow for.
const GROWING_PROGRAM = `
  globalThis.__datum_register = function () { return 0; };
  globalThis.__datum_run = function () { return '{"errors":[]}'; };
  globalThis.__datum_inspect = function (r) {
    if (JSON.parse(r).op === "grow") { var a = []; for (var i = 0; i < 40; i++) { a.push("x".repeat(3e6) + i); } }
    return JSON.stringify({ ok: true, rules: [] });
  };
  "ready";`;

describe("a fresh sandbox per call", () => {
  it.each([
    ["the worker host", () => createQuickJsWorkerHost({ plugins: polluter, freezeIntrinsics: false, maxEvalMs: 5000 })],
    ["the fresh-sandbox host (worker: false)", () => createQuickJsFreshSandboxHost({ plugins: polluter, freezeIntrinsics: false, maxEvalMs: 5000 })]
  ])("%s: a plugin's counter, a global, a patched prototype and module state left by one call are gone for the next", async (_name, make) => {
    const host = await make();
    try {
      for (let index = 0; index < 4; index += 1) {
        expect(seen(await host.run(context({ flag: "1" })))).toEqual(CLEAN);
      }
      expect(seen(await host.run(context()))).toEqual(CLEAN);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("control: the page's synchronous adapter reuses its sandbox, and the same plugin sees what the call before it left", async () => {
    const instance = await new QuickJsWasmHostAdapter({ freezeIntrinsics: false, maxEvalMs: 5000 }).instantiate(polluter, new JsonWasmAbi());
    try {
      expect(seen(instance.run(context({ flag: "1" })) as string)).toEqual(CLEAN);
      expect(seen(instance.run(context()) as string)).toEqual({ count: 2, armed: true, global: "string", proto: "string" });
    } finally {
      instance.dispose?.();
    }
  }, 60_000);

  it.each([
    ["the worker host", () => createQuickJsWorkerHost({ program: COUNTING_PROGRAM })],
    ["the fresh-sandbox host (worker: false)", () => createQuickJsFreshSandboxHost({ program: COUNTING_PROGRAM })]
  ])("%s: the ABI probe, the budget's inspect question, a run and an inspect each run in a sandbox no call ran in", async (_name, make) => {
    // The program is handed in, so the host probed its ABI at create; no maxEvalMs, so the first
    // run of the definition asks its own inspect question first.
    const host = await make();
    try {
      for (let index = 0; index < 3; index += 1) {
        expect(seen(await host.run(context({ flag: String(index) })))).toEqual({ calls: 1 });
        expect((JSON.parse(await host.inspect(JSON.stringify({ abi: WASM_ABI_VERSION, op: "public", definition: { root: probes } }))) as { calls: number }).calls).toBe(1);
      }
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("the fresh-sandbox host refuses an older program at create and a hostile request before building a sandbox for it", async () => {
    const stale = 'globalThis.__datum_register = function () { return 0; }; globalThis.__datum_run = function () { return "{\\"errors\\":[]}"; }; globalThis.__datum_inspect = function () { return JSON.stringify({ ok: false, error: { code: "abi_mismatch", message: "older" } }); }; "ready";';
    await expect(createQuickJsFreshSandboxHost({ program: stale })).rejects.toMatchObject({ code: "abi_mismatch" });
    const host = await createQuickJsFreshSandboxHost({ maxRequestDepth: 50 });
    try {
      await expect(host.run(`${"[".repeat(60)}${"]".repeat(60)}`)).rejects.toMatchObject({ code: "request_refused" });
      expect((JSON.parse(await host.run(context())) as { errors: unknown[] }).errors).toEqual([]);
    } finally {
      host.dispose();
    }
    await expect(host.run(context())).rejects.toMatchObject({ code: "runtime_error" });
  }, 60_000);

  it.each([
    ["the worker host", () => createQuickJsWorkerHost({ program: GROWING_PROGRAM, maxEvalMs: 5000 })],
    ["the fresh-sandbox host (worker: false)", () => createQuickJsFreshSandboxHost({ program: GROWING_PROGRAM, maxEvalMs: 5000 })]
  ])("%s: each call runs in a WebAssembly memory of its own, back at its initial size after a call that grew one", async (_name, make) => {
    const host = await make();
    try {
      await host.run(context());
      const initial = host.heapBytes as number;
      expect(initial).toBeGreaterThan(0);
      await host.inspect(JSON.stringify({ abi: WASM_ABI_VERSION, op: "grow" }));
      const grown = host.heapBytes as number;
      expect(grown).toBeGreaterThan(initial + 32 * 1024 * 1024);
      // Were the instance shared, the memory would still stand at its grown size here.
      await host.run(context());
      expect(host.heapBytes).toBe(initial);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("the worker host: a call the worker has no sandbox for fails typed and the thread is replaced, so the next call is answered", async () => {
    const host = await createQuickJsWorkerHost({ program: COUNTING_PROGRAM, maxEvalMs: 5000 });
    try {
      expect(await host.run(context())).toContain("calls");
      // The worker is building the next sandbox; a call posted now (the host's own readiness
      // bookkeeping bypassed) finds none to take.
      const inner = host as unknown as { sandboxReady: boolean; send(entry: string, argument: string, maxEvalMs: number, cap: number): Promise<string> };
      inner.sandboxReady = true;
      const started = Date.now();
      await expect(inner.send("__datum_run", context(), 5000, Infinity)).rejects.toMatchObject({ code: "runtime_error", message: expect.stringContaining("No fresh sandbox") });
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await host.run(context())).toContain("calls");
      expect(host.starts).toBe(2);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("the worker host: a sandbox that fails to build after a call fails the call waiting for it, typed, and the call after that is answered on a new thread", async () => {
    // A stand-in program that will not load inside one window of time: the sandbox built at boot
    // is ready before the window opens, the one built after the first call falls inside it, and
    // the next thread's comes after it closes.
    const opens = Date.now() + 2500 * SLOW_FACTOR;
    const closes = opens + 1500 * SLOW_FACTOR;
    const program = `
      var now = Date.now();
      if (now >= ${opens} && now < ${closes}) { throw new Error("no sandbox in this window"); }
      globalThis.__datum_register = function () { return 0; };
      globalThis.__datum_run = function () { return '{"errors":[]}'; };
      globalThis.__datum_inspect = function () { return '{"ok":true}'; };
      "ready";`;
    const host = await createQuickJsWorkerHost({ program, maxEvalMs: 1000 });
    try {
      expect(Date.now()).toBeLessThan(opens);
      await new Promise((resolve) => setTimeout(resolve, opens - Date.now() + 20));
      expect(await host.run("{}")).toBe('{"errors":[]}');
      await expect(host.run("{}")).rejects.toMatchObject({ code: "compile_error", message: expect.stringContaining("no sandbox in this window") });
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, closes - Date.now() + 20)));
      expect(await host.run("{}")).toBe('{"errors":[]}');
      expect(host.starts).toBe(2);
    } finally {
      await host.dispose();
    }
  }, 60_000);
});
