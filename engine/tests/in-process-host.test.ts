import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import {
  InProcessRunHostAdapter,
  InProcessWasmHostAdapter,
  createInProcessRunHost,
  createInProcessWasmValidationHost
} from "../form-engine/validation/wasm/in-process-host.js";
import { JsonWasmAbi, WasmValidationHost, type WasmPlugin } from "../form-engine/validation/wasm/wasm-validation-host.js";

/**
 * The two in-process factories: the full host answers
 * `__datum_inspect`'s ops, the run-only host runs the same submissions with no inspect entry.
 * The Tests panel's runner takes the run-only one, so that nothing in a builder chunk names
 * `runInspect` and the `test` op, the form-test parser and the judge stay out of the builder's
 * eager entry (guard 14 checks the bundle; this file checks the source and the behaviour).
 */

const engine = fileURLToPath(new URL("../form-engine/", import.meta.url));

const root: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "name", type: "text", configuration: { required: true } },
      { id: "n", type: "number", configuration: {} },
      { id: "twice", type: "number", configuration: {}, rules: { value: "double(n)" } }
    ]
  }
};

const plugin = {
  id: "probe",
  version: "1",
  functions: { double: (args: unknown[]) => (typeof args[0] === "number" ? args[0] * 2 : null) },
  validators: [
    {
      id: "no-bob",
      version: "1",
      validate: (context: { values?: Record<string, unknown> }) => ({
        valid: context.values?.name !== "Bob",
        errors: context.values?.name === "Bob" ? [{ code: "noBob", componentId: "name", path: "name", stage: "custom", severity: "error" }] : []
      })
    }
  ]
} as unknown as WasmPlugin;

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path));
    } else if (name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

describe("in-process hosts: the full host and the run-only host", () => {
  it("the run-only instance has no inspect entry, and its host says so", async () => {
    const abi = new JsonWasmAbi();
    expect(new InProcessRunHostAdapter().instantiate([], abi).inspect).toBeUndefined();
    expect(typeof new InProcessWasmHostAdapter().instantiate([], abi).inspect).toBe("function");
    await expect(createInProcessRunHost().inspect({ op: "inspect", definition: { id: "f", version: "1", schemaVersion: "1", root } })).rejects.toThrow(
      /no inspect entry point/
    );
    const full = await createInProcessWasmValidationHost().inspect({ op: "inspect", definition: { id: "f", version: "1", schemaVersion: "1", root } });
    expect(full).toMatchObject({ ok: true, op: "inspect" });
  });

  it("runs answer the same bytes on both, with the plugins' functions and validators wired", async () => {
    const abi = new JsonWasmAbi();
    const full = new InProcessWasmHostAdapter().instantiate([plugin], abi);
    const runOnly = new InProcessRunHostAdapter().instantiate([plugin], abi);
    for (const values of [{}, { name: "Ann", n: 4 }, { name: "Bob", n: 2 }]) {
      const serialized = abi.serializeContext({ formId: "f", values, form: root }, WasmValidationHost.STRICT_POLICY);
      const answered = runOnly.run(serialized) as string;
      expect(answered).toBe(full.run(serialized) as string);
      // The run answered twice from the prepared cache is the same bytes as the first.
      expect(runOnly.run(serialized)).toBe(answered);
    }
    const outcome = await createInProcessRunHost([plugin]).run({ context: { formId: "f", values: { name: "Bob", n: 3 }, form: root }, policy: WasmValidationHost.STRICT_POLICY });
    expect(outcome.errors.map((error) => error.code)).toContain("noBob");
  });

  it("refuses what the full host refuses: a source plugin, a built-in's name, a function registered twice", () => {
    const abi = new JsonWasmAbi();
    const source = { id: "src", version: "1", source: "export default {}" } as unknown as WasmPlugin;
    const builtin = { id: "b", version: "1", functions: { sum: () => 0 }, validators: [] } as unknown as WasmPlugin;
    for (const plugins of [[source], [builtin], [plugin, plugin]]) {
      const expected = (() => {
        try {
          new InProcessWasmHostAdapter().instantiate(plugins, abi);
          return "no error";
        } catch (error) {
          return (error as Error).message;
        }
      })();
      expect(expected).not.toBe("no error");
      expect(() => new InProcessRunHostAdapter().instantiate(plugins, abi)).toThrow(expected);
    }
  });

  it("only the full adapter names runInspect in the source, and the Tests runner takes the run-only factory", () => {
    const host = readFileSync(join(engine, "validation/wasm/in-process-host.ts"), "utf8");
    const runOnly = host.slice(host.indexOf("export class InProcessRunHostAdapter"), host.indexOf("export function createInProcessWasmValidationHost"));
    const full = host.slice(host.indexOf("export class InProcessWasmHostAdapter"), host.indexOf("export class InProcessRunHostAdapter"));
    expect(full).toContain("runInspect(");
    expect(runOnly).not.toMatch(/runInspect|kernelRunInspect|InProcessWasmHostAdapter\(/);
    // The helpers both adapters share sit before the full adapter and never introspect.
    expect(host.slice(0, host.indexOf("export class InProcessWasmHostAdapter")).replace(/^import[\s\S]*?;\n/gm, "")).not.toContain("runInspect(");
    const runner = readFileSync(join(engine, "builder/form-tests/tests-runner.ts"), "utf8");
    expect(runner).toContain("createInProcessRunHost(");
    expect(runner).not.toContain("createInProcessWasmValidationHost");
  });

  it("nothing under builder/ names the introspection entry, the full in-process host or the test op", () => {
    const offenders: string[] = [];
    for (const path of filesUnder(join(engine, "builder"))) {
      // Code only: a comment may name what the code must not reach.
      const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/\b(?:runInspect|kernelRunInspect|kernelInspectDefinition|kernelFormTestOp\w*|createInProcessWasmValidationHost|InProcessWasmHostAdapter)\b/.test(text)) {
        offenders.push(path.slice(engine.length));
      }
    }
    expect(offenders).toEqual([]);
  });
});
