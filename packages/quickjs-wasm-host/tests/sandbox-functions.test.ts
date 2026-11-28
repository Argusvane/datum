import { describe, expect, it } from "vitest";

import {
  JsonWasmAbi,
  WasmValidationHost,
  createInProcessWasmValidationHost,
  type ComponentNode,
  type WasmPlugin
} from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter, buildSandboxProgram, toSourcePlugin } from "../src/index.js";

// requiredWhen: double(n) > 10 (a plugin function through the evaluator's call dispatch).
const root: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "n", type: "number", configuration: {} },
      { id: "extra", type: "text", configuration: {}, rules: { requiredWhen: "double(n) > 10" } }
    ]
  }
};

const module = `({ functions: { double: (args) => (typeof args[0] === "number" ? args[0] * 2 : undefined) } })`;

// The rule beside a built-in, under fail: the parser must know the plugin's name, or the call is unknownFunction.
const formulaRoot: ComponentNode = {
  id: "form",
  type: "form",
  configuration: { formulaErrors: "fail" },
  children: {
    content: [
      { id: "n", type: "number", configuration: {} },
      { id: "extra", type: "text", configuration: {}, rules: { requiredWhen: "double(n) > 10 and len(\"ab\") = 2" } }
    ]
  }
};

const doublePlugin: WasmPlugin = {
  id: "calc",
  version: "1.0.0",
  validators: [],
  functions: { double: (args: unknown[]) => (typeof args[0] === "number" ? args[0] * 2 : undefined) }
};

async function codesFor(values: Record<string, unknown>): Promise<string[]> {
  const abi = new JsonWasmAbi();
  const instance = await new QuickJsWasmHostAdapter().instantiate([{ id: "calc", version: "1.0.0", source: module }], abi);
  const payload = await instance.run(
    abi.serializeContext({ formId: "f", values, locale: "en", form: root }, WasmValidationHost.STRICT_POLICY)
  );
  instance.dispose?.();
  return abi.deserializeOutcome(payload).errors.map((error) => `${error.code}:${error.componentId}`);
}

describe("sandbox plugin functions", () => {
  it("evaluates a formula that calls a function a module registered", async () => {
    expect(await codesFor({ n: 6 })).toEqual(["required:extra"]);
    expect(await codesFor({ n: 4 })).toEqual([]);
  });

  it("parses a string formula calling a built-in and a plugin function, under fail, on both hosts", async () => {
    const sandbox = await WasmValidationHost.create([doublePlugin], { adapter: new QuickJsWasmHostAdapter() });
    const inProcess = createInProcessWasmValidationHost([doublePlugin]);
    const policy = WasmValidationHost.STRICT_POLICY;
    for (const host of [sandbox, inProcess]) {
      const required = await host.run({ context: { formId: "f", values: { n: 6 }, locale: "en", form: formulaRoot }, policy });
      expect(required.errors.map((error) => `${error.code}:${error.componentId}`)).toEqual(["required:extra"]);
      const clear = await host.run({ context: { formId: "f", values: { n: 4 }, locale: "en", form: formulaRoot }, policy });
      expect(clear.errors).toEqual([]);
    }
    sandbox.dispose();
    inProcess.dispose();
  });

  it("refuses a built-in name and a duplicate across modules", async () => {
    const abi = new JsonWasmAbi();
    await expect(
      new QuickJsWasmHostAdapter().instantiate([{ id: "bad", version: "1", source: `({ functions: { sum: (a) => 1 } })` }], abi)
    ).rejects.toThrow(/built-in/);
    await expect(
      new QuickJsWasmHostAdapter().instantiate(
        [
          { id: "a", version: "1", source: module },
          { id: "b", version: "1", source: module }
        ],
        abi
      )
    ).rejects.toThrow(/already registered/);
    await expect(
      new QuickJsWasmHostAdapter().instantiate([{ id: "c", version: "1", source: `({ functions: [] })` }], abi)
    ).rejects.toThrow(/object of functions/);
  });

  it("derives functions source from a function-backed plugin", () => {
    const source = toSourcePlugin({
      id: "p",
      version: "1",
      validators: [],
      functions: { double: (args: unknown[]) => (args[0] as number) * 2 }
    });
    expect(source.source).toContain('"double"');
    expect(buildSandboxProgram()).toContain("__datum_functions");
  });
});
