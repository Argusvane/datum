import { describe, expect, it } from "vitest";

import { WasmValidationHost, type ComponentNode } from "@argusvane/datum-engine";

import { createQuickJsValidationHost } from "../src/index.js";

/**
 * The intrinsic freeze reaches the prototypes only an operation makes, as well as those reachable
 * from the global object: the iterator helpers' (`[].values().map(f)`) and the one `Iterator.from`
 * wraps with. A plugin that patched their `next` would change every other plugin's iteration.
 */

const form = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: {} }] } } as unknown as ComponentNode;

describe("the intrinsic freeze", () => {
  it("freezes %IteratorHelperPrototype% and %WrapForValidIteratorPrototype%, and a plugin cannot patch their next", async () => {
    const source = `({ validators: [function () {
      var out = {};
      function check(name, make) {
        var proto = make();
        if (proto === undefined) { out[name] = "absent"; return; }
        try { proto.next = function () { return { done: true }; }; } catch (e) {}
        out[name] = Object.isFrozen(proto) ? "frozen" : "open";
      }
      check("helper", function () { return typeof [].values().map === "function" ? Object.getPrototypeOf([].values().map(function (x) { return x; })) : undefined; });
      check("wrap", function () { return typeof Iterator !== "undefined" && typeof Iterator.from === "function" ? Object.getPrototypeOf(Iterator.from({ next: function () { return { done: true }; } })) : undefined; });
      var mapped = [1, 2].values().map(function (x) { return x * 2; });
      out.mapped = String(Array.from(mapped));
      return { errors: [{ code: "report", severity: "info", parameters: out }] };
    }] })`;
    const host = await createQuickJsValidationHost([{ id: "probe", version: "1", source }]);
    try {
      const outcome = await host.run({ context: { formId: "f", values: {}, locale: "en", form }, policy: WasmValidationHost.STRICT_POLICY });
      const report = outcome.errors.find((error) => error.code === "report")?.parameters as Record<string, string> | undefined;
      expect(report).toEqual({ helper: "frozen", wrap: "frozen", mapped: "2,4" });
    } finally {
      host.dispose();
    }
  }, 60_000);
});
