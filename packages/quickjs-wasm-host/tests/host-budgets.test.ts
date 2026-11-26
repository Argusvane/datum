import { describe, expect, it } from "vitest";

import { JsonWasmAbi, WASM_ABI_VERSION, WasmValidationHost, type ComponentNode } from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter } from "../src/index.js";
import { SCALED_CAP_MS, inspectBudget, withRequestSize } from "../src/quickjs-wasm-host-adapter.js";
import { createQuickJsWorkerHost } from "../src/worker-host.js";

/**
 * The default budgets, the same on both QuickJS hosts: a run gets its definition's budget plus 2 ms
 * per kilobyte of the request on every call (the answers and a delivered document vary per call
 * and are never remembered with the definition); an inspect request gets 250 ms plus 1 ms per
 * kilobyte, and the cap when its top-level op is `test`.
 */

const form = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "note", type: "textarea", configuration: {} }] } } as unknown as ComponentNode;
const runContext = (noteKb: number): string => JSON.stringify({ formId: "f", values: { note: "n".repeat(noteKb * 1024) }, locale: "en", form });

// A stand-in program that spends a known wall-clock time per call (its own `Date`, no kernel): a run
// takes 600 ms, a `check` or `test` request a second; the host's ABI probe and the budget's own
// `inspect` question are answered at once.
const SLOW_PROGRAM = `
  globalThis.__datum_register = function () { return 0; };
  function spin(ms) { var end = Date.now() + ms; while (Date.now() < end) {} }
  globalThis.__datum_run = function () { spin(600); return '{"errors":[]}'; };
  globalThis.__datum_inspect = function (r) { var q = JSON.parse(r); if (q.op === "test" || q.op === "check") { spin(1000); } return JSON.stringify({ ok: true, op: q.op, rules: [] }); };
  "ready";`;

const checkWithOpInside = JSON.stringify({ abi: WASM_ABI_VERSION, definition: { root: { id: "form", type: "form", configuration: { op: "test" }, children: {} } }, op: "check" });
const testRequest = JSON.stringify({ abi: WASM_ABI_VERSION, op: "test", definition: { root: { id: "form", type: "form", configuration: {}, children: {} } }, tests: "" });

const outcome = (call: () => unknown): Promise<string> =>
  Promise.resolve()
    .then(call)
    .then(
      () => "answered",
      (error: unknown) => String((error as { code?: string }).code)
    );

describe("default sandbox budgets", () => {
  it("adds 2 ms per kilobyte of the request to a run's budget on every call, never into the budget remembered for the definition", async () => {
    const abi = new JsonWasmAbi();
    const adapter = new QuickJsWasmHostAdapter();
    const sandbox = await adapter.instantiateSandbox([]);
    try {
      const big = abi.serializeContext({ formId: "f", values: { note: "n".repeat(400 * 1024) }, locale: "en", form }, WasmValidationHost.STRICT_POLICY);
      adapter.runSandbox(sandbox, big);
      expect(sandbox.host.limits.maxEvalMs).toBe(withRequestSize(250, big));
      expect(sandbox.host.limits.maxEvalMs).toBeGreaterThanOrEqual(250 + 800);
      expect([...(sandbox.budgets?.values() ?? [])]).toEqual([250]);
      // The same form with small answers is back to the definition's own budget.
      adapter.runSandbox(sandbox, abi.serializeContext({ formId: "f", values: {}, locale: "en", form }, WasmValidationHost.STRICT_POLICY));
      expect(sandbox.host.limits.maxEvalMs).toBe(250);
      expect(withRequestSize(4_900, "x".repeat(200 * 1024))).toBe(SCALED_CAP_MS);
    } finally {
      sandbox.host.dispose();
    }
  }, 60_000);

  it("reads an inspect request's op from its top level, never from a value inside the definition", () => {
    expect(inspectBudget(testRequest)).toBe(SCALED_CAP_MS);
    expect(inspectBudget(checkWithOpInside)).toBe(250);
    expect(inspectBudget(JSON.stringify({ abi: WASM_ABI_VERSION, definition: { tests: { op: "test" } }, op: "public" }))).toBe(250);
  });

  it("gives both hosts the same budgets: a run grows with its request, a test request gets the cap, a check holding {op: test} does not", async () => {
    const adapter = new QuickJsWasmHostAdapter({ program: SLOW_PROGRAM });
    const sandbox = await adapter.instantiateSandbox([]);
    const worker = await createQuickJsWorkerHost({ program: SLOW_PROGRAM });
    try {
      const viaAdapter = [
        await outcome(() => adapter.runSandbox(sandbox, runContext(0))),
        await outcome(() => adapter.runSandbox(sandbox, runContext(500))),
        await outcome(() => adapter.inspectSandbox(sandbox, testRequest)),
        await outcome(() => adapter.inspectSandbox(sandbox, checkWithOpInside))
      ];
      const viaWorker = [
        await outcome(() => worker.run(runContext(0))),
        await outcome(() => worker.run(runContext(500))),
        await outcome(() => worker.inspect(testRequest)),
        await outcome(() => worker.inspect(checkWithOpInside))
      ];
      expect(viaAdapter).toEqual(["interrupted", "answered", "answered", "interrupted"]);
      expect(viaWorker).toEqual(viaAdapter);
    } finally {
      sandbox.host.dispose();
      await worker.dispose();
    }
  }, 60_000);

  it("refuses a request past the sandbox's limits before working out its budget", async () => {
    const adapter = new QuickJsWasmHostAdapter();
    const sandbox = await adapter.instantiateSandbox([]);
    try {
      sandbox.host.limits.maxRequestLength = 1_000;
      expect(() => adapter.runSandbox(sandbox, runContext(2))).toThrow(expect.objectContaining({ code: "request_refused" }));
      // No budget was asked for: the definition was never scanned, parsed or inspected.
      expect(sandbox.budgets).toBeUndefined();
    } finally {
      sandbox.host.dispose();
    }
  }, 60_000);
});
