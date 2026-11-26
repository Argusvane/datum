import { describe, expect, it } from "vitest";

import { JsonWasmAbi, WASM_ABI_VERSION, WasmValidationHost, type ComponentNode } from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter, buildSandboxProgram, createQuickJsValidationHost } from "../src/index.js";
import { createQuickJsWorkerHost } from "../src/worker-host.js";

/**
 * A program handed to a host as text proves the ABI it speaks before it judges anything: a file
 * left over from an older build (here the conformance kit's stale program, which answers 2.11 and
 * accepts every submission) is refused when the host is made, never consulted on a verdict.
 */

const STALE =
  'globalThis.__datum_register = function () { return 0; };globalThis.__datum_run = function () { return JSON.stringify({ errors: [] }); };globalThis.__datum_inspect = function (r) { var q = JSON.parse(r); var a = q.abi.split(".").map(Number); var p = "2.11.0".split(".").map(Number); return JSON.stringify(a[0] === p[0] && a[1] <= p[1] ? { ok: true, op: q.op } : { ok: false, error: { code: "abi_mismatch", message: "older program" } }); };"sandbox-ready";';
// No inspect entry point at all: a program that answers no inspect call.
const NO_INSPECT = 'globalThis.__datum_register = function () { return 0; }; globalThis.__datum_run = function () { return "{\\"errors\\":[]}"; }; "ready";';

const required = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { required: true } }] } } as unknown as ComponentNode;

describe("a program handed to a host proves its ABI", () => {
  it.each([
    ["an older program", STALE],
    ["a program with no inspect entry point", NO_INSPECT]
  ])("the synchronous host refuses %s (abi_mismatch)", async (_name, program) => {
    await expect(createQuickJsValidationHost([], { program })).rejects.toMatchObject({ code: "abi_mismatch" });
    await expect(new QuickJsWasmHostAdapter({ program }).instantiate([], new JsonWasmAbi())).rejects.toMatchObject({ code: "abi_mismatch" });
  }, 60_000);

  it.each([
    ["an older program", STALE],
    ["a program with no inspect entry point", NO_INSPECT]
  ])("the worker host refuses %s (abi_mismatch)", async (_name, program) => {
    await expect(createQuickJsWorkerHost({ program })).rejects.toMatchObject({ code: "abi_mismatch" });
  }, 60_000);

  it("lets a harness that runs older programs on purpose turn the proof off (checkProgramAbi false), on both hosts", async () => {
    const instance = await new QuickJsWasmHostAdapter({ program: STALE, checkProgramAbi: false }).instantiate([], new JsonWasmAbi());
    const worker = await createQuickJsWorkerHost({ program: STALE, checkProgramAbi: false });
    try {
      expect(await instance.run("{}")).toBe('{"errors":[]}');
      expect(await worker.run("{}")).toBe('{"errors":[]}');
    } finally {
      instance.dispose?.();
      await worker.dispose();
    }
  }, 60_000);

  it("both hosts take the program built from this source when it is handed in as text, and judge with it", async () => {
    const program = buildSandboxProgram();
    const host = await createQuickJsValidationHost([], { program });
    const worker = await createQuickJsWorkerHost({ program });
    try {
      const outcome = await host.run({ context: { formId: "f", values: {}, locale: "en", form: required }, policy: WasmValidationHost.STRICT_POLICY });
      expect(outcome.errors.map((error) => error.code)).toEqual(["required"]);
      const answer = JSON.parse(await worker.run(JSON.stringify({ formId: "f", values: {}, locale: "en", form: required }))) as { errors: { code: string }[] };
      expect(answer.errors.map((error) => error.code)).toEqual(["required"]);
      expect(JSON.parse(await worker.inspect(JSON.stringify({ abi: WASM_ABI_VERSION, op: "public", definition: { root: required } })))).toMatchObject({ ok: true });
    } finally {
      host.dispose();
      await worker.dispose();
    }
  }, 60_000);

  it("answers the probe under the startup budget, so a tight run budget does not refuse a current program that is slow to start", async () => {
    // A current-ABI stand-in whose inspect spends 30 ms (a cold first inspect on a slow machine),
    // handed to a host whose run budget is 10 ms.
    const slowInspect = 'globalThis.__datum_register = function () { return 0; }; globalThis.__datum_run = function () { return "{\\"errors\\":[]}"; }; globalThis.__datum_inspect = function (r) { var end = Date.now() + 30; while (Date.now() < end) {} return JSON.stringify({ ok: true, op: JSON.parse(r).op }); }; "ready";';
    const instance = await new QuickJsWasmHostAdapter({ program: slowInspect, maxEvalMs: 10 }).instantiate([], new JsonWasmAbi());
    try {
      expect(await instance.run("{}")).toBe('{"errors":[]}');
    } finally {
      instance.dispose?.();
    }
  }, 60_000);

  it("reports a probe that runs past the startup budget as interrupted, not as a program to rebuild", async () => {
    const stuck = 'globalThis.__datum_register = function () { return 0; }; globalThis.__datum_run = function () { return "{}"; }; globalThis.__datum_inspect = function () { for (;;) {} }; "ready";';
    await expect(new QuickJsWasmHostAdapter({ program: stuck, maxStartupMs: 50 }).instantiate([], new JsonWasmAbi())).rejects.toMatchObject({ code: "interrupted" });
    await expect(createQuickJsWorkerHost({ program: stuck, maxStartupMs: 50 })).rejects.toMatchObject({ code: "interrupted" });
  }, 60_000);
});
