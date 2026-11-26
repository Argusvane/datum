import { describe, expect, it } from "vitest";
import { JsonWasmAbi, type ComponentNode } from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter } from "../src/index.js";

/**
 * In the sandbox, a validator's answer is copied every level by index and own key: parameters
 * that hold themselves make the answer unusable (a typed runtime error the host fails closed on)
 * and leave the sandbox usable, where the recursive writer used to overflow the host's stack and
 * abandon the runtime; a list subclass's `Symbol.species` cannot swap what was judged.
 */

const ABI = new JsonWasmAbi();
const root = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "flag", type: "text", configuration: {} }] } } as unknown as ComponentNode;
const ctx = (values: Record<string, unknown> = {}): string => JSON.stringify({ formId: "f", values, locale: "en", form: root });
const plugin = (body: string, pre = "") => [{ id: "p", version: "1", source: `(function(){ ${pre} return { validators: [ (c) => { ${body} } ] }; })()` }];

describe("a validator's answer in the sandbox", () => {
  it("cyclic parameters are an unusable answer, and the next run still answers", async () => {
    const adapter = new QuickJsWasmHostAdapter({ maxEvalMs: 5000 });
    const instance = await adapter.instantiate(plugin("if (!c.values.flag) { return { errors: [] }; } var p = {}; p.self = p; return { errors: [{ code: 'x', parameters: p }] };"), ABI);
    try {
      let failure: unknown;
      try {
        instance.run(ctx({ flag: "1" }));
      } catch (error) {
        failure = error;
      }
      expect((failure as { code?: string }).code).toBe("runtime_error");
      expect((failure as Error).message).toMatch(/validator 1 returned errors nested past 32 levels/);
      expect(JSON.parse(String(instance.run(ctx({})))).errors).toEqual([]);
    } finally {
      instance.dispose?.();
    }
  }, 60_000);

  it("a list made through Symbol.species keeps the entries judged", async () => {
    const pre = `
      var reads = 0;
      function makeEntry() { return { get code() { reads += 1; return reads <= 1 ? "plugin.ok" : 42; }, severity: "warning" }; }
      class Evil { constructor() { return new Proxy([], { get: function (t, k) { if (k === "length") { return 1; } if (k === "0") { return makeEntry(); } return Reflect.get(t, k); } }); } }
      class E extends Array { static get [Symbol.species]() { return Evil; } }
    `;
    const adapter = new QuickJsWasmHostAdapter({ maxEvalMs: 5000 });
    const instance = await adapter.instantiate(plugin("var list = new E(); list.push({ code: 'plugin.ok', severity: 'warning' }); return { errors: list };", pre), ABI);
    try {
      expect(JSON.parse(String(instance.run(ctx({})))).errors).toEqual([{ code: "plugin.ok", severity: "warning" }]);
    } finally {
      instance.dispose?.();
    }
  }, 60_000);
});
