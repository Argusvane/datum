import { describe, expect, it } from "vitest";

import { InProcessWasmHostAdapter, JsonWasmAbi, WasmValidationHost, createFieldConstraintsStage, type ComponentNode } from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter, buildSandboxProgram } from "../src/index.js";

/**
 * The definition's `kinds` map behind the real sandbox: a design-system type mapped
 * to `date` is judged as a date by the program built from the engine's kernel, with no binding
 * code in it, byte for byte as the in-process kernel and by code as the browser's stage.
 */

const KINDS = { "gcds-date": "date", "acme-amount": "number" };

const root: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "born", type: "gcds-date", configuration: { required: true, min: "1900-01-01" } },
      { id: "amount", type: "acme-amount", configuration: {} }
    ]
  }
};

const ANSWERS: Array<Record<string, unknown>> = [
  {},
  { born: "2026-02-30" },
  { born: "1899-12-31" },
  { born: "2024-02-29", amount: "12" },
  { born: "2024-02-29", amount: "12 kg" },
  { born: 20240229 }
];

describe("QuickJS: a kinds-mapped type validates as its base", () => {
  it("splices the kind functions into the program", () => {
    expect(buildSandboxProgram()).toContain("function kernelKindBase(");
  });

  it("judges every answer as the in-process kernel, and as the browser's stage by code", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const stage = createFieldConstraintsStage(root, { kinds: KINDS });
    try {
      for (const values of ANSWERS) {
        const payload = abi.serializeContext({ formId: "f", values, locale: "en", form: root, kinds: KINDS }, WasmValidationHost.STRICT_POLICY);
        const sandboxed = await quickJs.run(payload);
        expect(sandboxed, JSON.stringify(values)).toBe(inProcess.run(payload));
        const outcome = abi.deserializeOutcome(sandboxed);
        const client = (await stage.validate({ formId: "f", values, locale: "en" })) as { errors: Array<{ componentId?: string; code: string }> };
        expect(outcome.errors.map((error) => `${error.componentId}:${error.code}`), JSON.stringify(values)).toEqual(
          client.errors.map((error) => `${error.componentId}:${error.code}`)
        );
      }
      const refused = abi.deserializeOutcome(
        await quickJs.run(abi.serializeContext({ formId: "f", values: { born: "2026-02-30", amount: "12 kg" }, locale: "en", form: root, kinds: KINDS }, WasmValidationHost.STRICT_POLICY))
      );
      expect(refused.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["born:date", "amount:number"]);
      // Without the map the program has no idea what the types are, and checks neither.
      const unmapped = abi.deserializeOutcome(
        await quickJs.run(abi.serializeContext({ formId: "f", values: { born: "2026-02-30", amount: "12 kg" }, locale: "en", form: root }, WasmValidationHost.STRICT_POLICY))
      );
      expect(unmapped.errors).toEqual([]);
    } finally {
      quickJs.dispose?.();
    }
  });
});
