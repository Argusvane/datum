import { describe, expect, it } from "vitest";

import { InProcessWasmHostAdapter, JsonWasmAbi, WasmValidationHost, type ComponentNode } from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter } from "../src/index.js";

/**
 * The server's host context (`context.hostContext`) behind the real sandbox:
 * the program built from the engine's kernel judges `host.` rules against it byte for byte as
 * the in-process kernel does, and with none judges as it always did.
 */

const root: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "name", type: "text", configuration: { required: true } },
      { id: "admin_note", type: "text", configuration: { required: true }, rules: { visibleWhen: 'host.role = "admin"' } },
      { id: "level", type: "text", configuration: {}, rules: { requiredWhen: "host.strict = true" } },
      { id: "code", type: "text", configuration: {}, rules: { validWhen: "code = host.user.code" } },
      { id: "region", type: "text", configuration: {}, rules: { value: 'coalesce(host.region, "none")' } }
    ]
  }
} as ComponentNode;

const CONTEXTS: Array<Record<string, unknown> | undefined> = [
  undefined,
  { role: "admin" },
  { role: "user" },
  {},
  { strict: true, region: "QC", user: { code: "A1" } },
  { role: "admin", user: { code: "B2" }, list: [1, "two", null, { three: 3 }] }
];

const ANSWERS: Array<Record<string, unknown>> = [{}, { name: "N" }, { name: "N", admin_note: "x", level: "L", code: "A1", region: "forged" }];

describe("QuickJS: a host context the server supplies", () => {
  it("judges every run as the in-process kernel, and differently with a context than without", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    try {
      for (const hostContext of CONTEXTS) {
        for (const values of ANSWERS) {
          const label = `${JSON.stringify(hostContext)} ${JSON.stringify(values)}`;
          const payload = abi.serializeContext(
            { formId: "f", values, locale: "en", form: root, reportFold: true, ...(hostContext !== undefined ? { hostContext } : {}) },
            WasmValidationHost.STRICT_POLICY
          );
          expect(await quickJs.run(payload), label).toBe(inProcess.run(payload));
        }
      }
      const verdict = async (hostContext?: Record<string, unknown>) =>
        abi.deserializeOutcome(
          await quickJs.run(abi.serializeContext({ formId: "f", values: { name: "N" }, locale: "en", form: root, ...(hostContext !== undefined ? { hostContext } : {}) }, WasmValidationHost.STRICT_POLICY))
        );
      expect((await verdict({ role: "admin" })).errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["admin_note:required"]);
      expect((await verdict({ role: "user" })).errors).toEqual([]);
      const none = await verdict();
      expect(none.errors).toEqual([]);
      expect(none.visibilitySkipped).toEqual(["admin_note"]);
    } finally {
      quickJs.dispose?.();
    }
  });
});
