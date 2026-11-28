import { describe, expect, it } from "vitest";

import { WasmValidationHost, type ComponentNode } from "@argusvane/datum-engine";

import { FREEZE_INTRINSICS_SNIPPET, createQuickJsFreshSandboxHost, createQuickJsValidationHost } from "../src/index.js";
import { QuickJsProgramHost } from "../src/program-host.js";
import { createQuickJsWorkerHost } from "../src/worker-host.js";

/**
 * After the freeze a global's binding is non-writable and non-configurable on every engine a host
 * runs: a descriptor handed to `Object.defineProperty`, `Object.defineProperties` or
 * `Reflect.defineProperty` (directly or through a proxy of the global object) cannot replace it,
 * so one rule module cannot change what another module's `RegExp`, `JSON` or `undefined` is.
 */

const form = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: {} }] } } as unknown as ComponentNode;

const fakeRegExp = "function () { return { test: function () { return true; } }; }";
const REDEFINITIONS = [
  `Object.defineProperty(globalThis, "RegExp", { value: ${fakeRegExp} });`,
  `Object.defineProperty(globalThis, "RegExp", { value: ${fakeRegExp}, writable: false, enumerable: false, configurable: false });`,
  `Object.defineProperties(globalThis, { RegExp: { value: ${fakeRegExp} } });`,
  `Reflect.defineProperty(globalThis, "RegExp", { value: ${fakeRegExp} });`,
  `Object.defineProperty(new Proxy(globalThis, {}), "RegExp", { value: ${fakeRegExp} });`,
  `Reflect.defineProperty(Proxy.revocable(globalThis, {}).proxy, "RegExp", { value: ${fakeRegExp} });`,
  // A descriptor whose value reads differently the second time.
  `var reads = 0; Object.defineProperty(globalThis, "RegExp", { get value() { reads += 1; return reads === 1 ? RegExp : (${fakeRegExp}); } });`
];

// The first module tries the redefinition as it loads; the second checks digits with RegExp.
const modules = (statement: string) => [
  { id: "redefine", version: "1", source: `(function () { try { ${statement} } catch (e) {} return { validators: [] }; })()` },
  {
    id: "digits",
    version: "1",
    source: `({ validators: [ (c) => new RegExp("^[0-9]+$").test(String(c.values.name)) ? { errors: [] } : { errors: [{ code: "digits", stage: "probe", source: "custom", severity: "error" }] } ] })`
  }
];
const contextJson = JSON.stringify({ formId: "f", values: { name: "abc" }, locale: "en", form });
const codes = (answer: string): string[] => (JSON.parse(answer) as { errors: { code: string }[] }).errors.map((error) => error.code);

describe("the freeze holds a global against a redefining descriptor", () => {
  it("on the page's adapter: another module's RegExp is the language's own", async () => {
    for (const statement of REDEFINITIONS) {
      const host = await createQuickJsValidationHost(modules(statement));
      try {
        const outcome = await host.run({ context: { formId: "f", values: { name: "abc" }, locale: "en", form }, policy: WasmValidationHost.STRICT_POLICY });
        expect(outcome.errors.map((error) => error.code), statement).toEqual(["digits"]);
      } finally {
        host.dispose();
      }
    }
  }, 60_000);

  it.each([
    ["the worker host", (statement: string) => createQuickJsWorkerHost({ plugins: modules(statement) })],
    ["the fresh-sandbox host (worker: false)", (statement: string) => createQuickJsFreshSandboxHost({ plugins: modules(statement) })]
  ])("on %s: another module's RegExp is the language's own", async (_name, make) => {
    for (const statement of REDEFINITIONS) {
      const host = await make(statement);
      try {
        expect(codes(await host.run(contextJson)), statement).toEqual(["digits"]);
      } finally {
        await host.dispose();
      }
    }
  }, 120_000);

  it("refuses each route as the language does for a non-configurable property, and leaves ordinary defines alone", async () => {
    const host = await QuickJsProgramHost.create();
    try {
      host.evaluate(FREEZE_INTRINSICS_SNIPPET, "sandbox-freeze");
      const report = host.evaluateHandle(
        `(function () {
          var out = {};
          var json = JSON;
          function attempt(name, f) { try { out[name] = String(f()); } catch (e) { out[name] = e instanceof TypeError ? "TypeError" : "other"; } }
          attempt("defineProperty", function () { Object.defineProperty(globalThis, "JSON", { value: 7 }); });
          attempt("defineProperties", function () { Object.defineProperties(globalThis, { JSON: { value: 7 } }); });
          attempt("reflect", function () { return Reflect.defineProperty(globalThis, "JSON", { value: 7 }); });
          attempt("accessor", function () { Object.defineProperty(globalThis, "JSON", { get: function () { return 7; } }); });
          attempt("configurable", function () { return Reflect.defineProperty(globalThis, "JSON", { configurable: true }); });
          attempt("undefined", function () { Object.defineProperty(globalThis, "undefined", { value: 7 }); });
          attempt("NaN", function () { Object.defineProperty(globalThis, "NaN", { value: 7 }); });
          attempt("Infinity", function () { return Reflect.defineProperty(globalThis, "Infinity", { value: 7 }); });
          attempt("proxy", function () { return new Proxy(globalThis, {}); });
          attempt("revocable", function () { return Proxy.revocable(globalThis, {}); });
          out.intact = JSON === json && String(undefined) === "undefined" && String(NaN) === "NaN" && Infinity > 1e308;
          attempt("sameValue", function () { return Object.defineProperty(globalThis, "JSON", { value: json }) === globalThis && Reflect.defineProperty(globalThis, "JSON", { value: json, writable: false }); });
          attempt("ownGlobal", function () { Object.defineProperty(globalThis, "mine", { value: 1, writable: true }); Object.defineProperty(globalThis, "mine", { value: 2 }); Object.defineProperties(globalThis, { more: { value: 3, enumerable: true } }); return mine + more; });
          attempt("ordinary", function () { var o = {}; Object.defineProperties(o, { a: { value: 1, configurable: true } }); Object.defineProperty(o, "a", { value: 2 }); return o.a + (Reflect.defineProperty(Object.freeze({ b: 1 }), "b", { value: 2 }) ? 1 : 0); });
          attempt("otherProxy", function () { var p = new Proxy({}, {}); p.x = 3; return p.x + Proxy.revocable({ y: 4 }, {}).proxy.y; });
          attempt("shape", function () { return [Object.defineProperty.length, Object.defineProperties.length, Reflect.defineProperty.length, Proxy.length, Object.isFrozen(Object), Object.isFrozen(Reflect), Object.isFrozen(Proxy)].join(","); });
          return out;
        })()`,
        "probe"
      );
      try {
        expect(host.vm.dump(report)).toEqual({
          defineProperty: "TypeError",
          defineProperties: "TypeError",
          reflect: "false",
          accessor: "TypeError",
          configurable: "false",
          undefined: "TypeError",
          NaN: "TypeError",
          Infinity: "false",
          proxy: "TypeError",
          revocable: "TypeError",
          intact: true,
          sameValue: "true",
          ownGlobal: "5",
          ordinary: "2",
          otherProxy: "7",
          shape: "3,2,3,2,true,true,true"
        });
      } finally {
        report.dispose();
      }
    } finally {
      host.dispose();
    }
  }, 60_000);
});
