import { describe, expect, it } from "vitest";

import { JsonWasmAbi, type ComponentNode } from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter, createQuickJsFreshSandboxHost } from "../src/index.js";
import { QuickJsProgramHost, toExecutionError } from "../src/program-host.js";
import { createQuickJsWorkerHost } from "../src/worker-host.js";
import { SLOW_FACTOR } from "./slow-machine.js";

/**
 * A call is `interrupted` only when the host's own interrupt handler ended it at the deadline:
 * a guest error that calls itself "interrupted" is typed as any other guest error. A plugin's
 * registration (its getters, and the reading of an error it throws) runs under the startup
 * deadline like the rest of startup.
 */

const form = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: {} }] } } as unknown as ComponentNode;
const contextJson = JSON.stringify({ formId: "f", values: { name: "x" }, locale: "en", form });
const throwing = (statement: string) => [{ id: "p", version: "1", source: `({ validators: [ function () { ${statement} } ] })` }];
// A stand-in program whose run throws what it is given (the kernel would catch a validator's throw); it answers the ABI probe.
const throwingProgram = (statement: string) =>
  `globalThis.__datum_register = function () { return 0; }; globalThis.__datum_run = function () { ${statement} }; globalThis.__datum_inspect = function (r) { return JSON.stringify({ ok: true, op: JSON.parse(r).op, rules: [] }); }; "ready";`;

const STARTUP_MS = 100;
const loopingGetter = [{ id: "slow", version: "1", source: "({ get validators() { for (;;) {} } })" }];
const loopingErrorMessage = [{ id: "slow", version: "1", source: "({ get validators() { throw { get message() { for (;;) {} } }; } })" }];

const codeOf = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "answered",
    (error: unknown) => String((error as { code?: string }).code)
  );

describe("a run is interrupted by the host's deadline, never by a guest error's words", () => {
  const GUEST_ERRORS = [
    'throw new Error("interrupted");',
    'throw new InternalError("interrupted");',
    'var e = new Error("Sandbox evaluation interrupted"); e.name = "InterruptError"; throw e;',
    'throw { name: "InternalError", message: "interrupted" };'
  ];

  it.each([
    [
      "the page's adapter",
      async (statement: string) => {
        const instance = await new QuickJsWasmHostAdapter({ program: throwingProgram(statement) }).instantiate([], new JsonWasmAbi());
        return { run: async (context: string) => String(await instance.run(context)), dispose: () => instance.dispose?.() };
      }
    ],
    ["the worker host", (statement: string) => createQuickJsWorkerHost({ program: throwingProgram(statement) })],
    ["the fresh-sandbox host (worker: false)", (statement: string) => createQuickJsFreshSandboxHost({ program: throwingProgram(statement) })]
  ])("types a guest error named or worded interrupted as runtime_error on %s", async (_name, make) => {
    for (const statement of GUEST_ERRORS) {
      const host = await make(statement);
      try {
        expect(await codeOf(Promise.resolve().then(() => host.run(contextJson))), statement).toBe("runtime_error");
      } finally {
        await host.dispose();
      }
    }
  }, 60_000);

  it("types a module that throws interrupted as it registers as not_a_module, and a real timeout still as interrupted", async () => {
    const adapter = new QuickJsWasmHostAdapter();
    expect(await codeOf(adapter.instantiateSandbox([{ id: "p", version: "1", source: '({ get validators() { throw new Error("interrupted"); } })' }]))).toBe("not_a_module");
    expect(await codeOf(createQuickJsWorkerHost({ plugins: [{ id: "p", version: "1", source: '({ get validators() { throw new Error("interrupted"); } })' }] }))).toBe("not_a_module");
    for (const host of [await createQuickJsWorkerHost({ plugins: throwing("for (;;) {}"), maxEvalMs: 100 }), await createQuickJsFreshSandboxHost({ plugins: throwing("for (;;) {}"), maxEvalMs: 100 })]) {
      try {
        expect(await codeOf(host.run(contextJson))).toBe("interrupted");
      } finally {
        await host.dispose();
      }
    }
  }, 60_000);

  it("reads the host's flag, not the text, in toExecutionError", () => {
    expect(toExecutionError({ name: "InternalError", message: "interrupted" }, "runtime_error").code).toBe("runtime_error");
    expect(toExecutionError({ name: "InternalError", message: "interrupted" }, "runtime_error", true).code).toBe("interrupted");
    expect(toExecutionError({ name: "SyntaxError", message: "unexpected token" }, "runtime_error").code).toBe("compile_error");
  });
});

describe("a plugin's registration runs under the startup deadline", () => {
  const bound = STARTUP_MS + 1_000 * SLOW_FACTOR;

  it.each([
    ["a validators getter that never returns", loopingGetter],
    ["an error whose message getter never returns", loopingErrorMessage]
  ])("ends %s at the startup budget on the page's adapter, the fresh-sandbox host and the worker host", async (_name, plugins) => {
    for (const make of [
      () => new QuickJsWasmHostAdapter({ maxStartupMs: STARTUP_MS }).instantiateSandbox(plugins),
      () => createQuickJsFreshSandboxHost({ plugins, maxStartupMs: STARTUP_MS }),
      () => createQuickJsWorkerHost({ plugins, maxStartupMs: STARTUP_MS })
    ]) {
      const started = Date.now();
      expect(await codeOf(make())).toBe("interrupted");
      expect(Date.now() - started).toBeLessThan(bound);
    }
  }, 60_000);

  it("calls a function handle under the deadline in callHandle", async () => {
    const host = await QuickJsProgramHost.create({ limits: { maxEvalMs: STARTUP_MS } });
    try {
      const spin = host.evaluateHandle("(function () { for (;;) {} })", "spin");
      try {
        const started = Date.now();
        expect(() => host.callHandle(spin, [])).toThrow(expect.objectContaining({ code: "interrupted" }) as unknown as Error);
        expect(Date.now() - started).toBeLessThan(bound);
      } finally {
        spin.dispose();
      }
    } finally {
      host.dispose();
    }
  }, 30_000);
});
