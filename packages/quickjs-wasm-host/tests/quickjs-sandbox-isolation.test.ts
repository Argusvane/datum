import { describe, expect, it } from "vitest";

import { WasmValidationHost, type ComponentNode } from "@argusvane/datum-engine";

import { createQuickJsValidationHost, INTRINSIC_ALIASES, QuickJsExecutionError, QuickJsWasmHostAdapter } from "../src/index.js";
import { QuickJsProgramHost } from "../src/program-host.js";

const root: ComponentNode = { id: "form", type: "form", configuration: {}, children: {} };

/** Runs a probe validator inside the sandbox and returns what it reported. */
async function probe(bodySource: string, options?: { maxEvalMs?: number; memoryLimitBytes?: number }) {
  const host = await createQuickJsValidationHost(
    [
      {
        id: "probe",
        version: "1.0.0",
        source: `({ validators: [ (context) => { ${bodySource} } ] })`
      }
    ],
    options
  );
  try {
    return await host.run({
      context: { formId: "probe", values: {}, locale: "en", form: root },
      policy: WasmValidationHost.STRICT_POLICY
    });
  } finally {
    host.dispose();
  }
}

describe("QuickJS sandbox isolation (the determinism guarantee: no ambient authority)", () => {
  it("has no host capabilities: network, DOM, process, module loading are absent", async () => {
    const outcome = await probe(`
      var absent = [
        typeof fetch, typeof XMLHttpRequest, typeof WebSocket,
        typeof require, typeof process, typeof window, typeof document,
        typeof setTimeout, typeof queueMicrotask
      ];
      return { errors: [{ code: "probe", stage: "probe", source: "custom", severity: "info",
        parameters: { absent: absent.join(",") } }] };
    `);
    expect(outcome.errors[0]?.parameters?.absent).toBe(
      "undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined"
    );
  });

  it("disables nondeterministic APIs: Math.random and Date throw inside the sandbox", async () => {
    const outcome = await probe(`
      var report = [];
      try { Math.random(); report.push("random-ok"); } catch (e) { report.push("random-throws"); }
      try { Date.now(); report.push("now-ok"); } catch (e) { report.push("now-throws"); }
      try { new Date(); report.push("date-ok"); } catch (e) { report.push("date-throws"); }
      return { errors: [{ code: "probe", stage: "probe", source: "custom", severity: "info",
        parameters: { report: report.join(",") } }] };
    `);
    expect(outcome.errors[0]?.parameters?.report).toBe("random-throws,now-throws,date-throws");
  });

  it("interrupts runaway evaluation at the deadline", async () => {
    await expect(probe("while (true) {}", { maxEvalMs: 100 })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof QuickJsExecutionError && error.code === "interrupted"
    );
  });

  it("stops an allocation bomb at the memory limit", async () => {
    await expect(
      probe(
        `
        var hog = [];
        for (var i = 0; i < 1e9; i += 1) { hog.push(new Array(1024).fill("x").join("")); }
        return { errors: [] };
        `,
        { memoryLimitBytes: 8 * 1024 * 1024, maxEvalMs: 5000 }
      )
    ).rejects.toSatisfy((error: unknown) => error instanceof QuickJsExecutionError);
    // This bomb is string data, which the object limit does not count, so it ends at the 5 s wall
    // clock above. The test's own budget must outlast that deadline: Vitest 5 holds a test to its
    // timeout by the clock even while the sandbox blocks the thread, where Vitest 2's timer could not fire.
  }, 30_000);

  it("still rejects a widened policy before anything reaches the sandbox", async () => {
    const host = await createQuickJsValidationHost();
    await expect(
      host.run({
        context: { formId: "f", values: {}, form: root },
        // @ts-expect-error deliberately widened policy
        policy: { allowNetwork: true, allowFilesystem: false, allowProcess: false, allowEnvironment: false }
      })
    ).rejects.toThrow(/fully restricted/);
    host.dispose();
  });

  // The sandbox instance is reused across runs and forms.
  describe("a plugin cannot rebind the kernel or patch the language for the runs after it", () => {
    const requiredForm: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "name", type: "text", configuration: { label: "Name", required: true } }] }
    };
    const poison = (statement: string) => `({ validators: [ (context) => {
      if (context.values.name === "arm") { try { ${statement} } catch (e) { return { errors: [{ code: "blocked", stage: "probe", source: "custom", severity: "info" }] }; } }
      return { errors: [] };
    } ] })`;
    const codesAfterArming = async (statement: string, options: { freezeIntrinsics?: boolean } = {}) => {
      const host = await createQuickJsValidationHost([{ id: "poison", version: "1", source: poison(statement) }], options);
      try {
        const run = (name: string) => host.run({ context: { formId: "f", values: { name }, locale: "en", form: requiredForm }, policy: WasmValidationHost.STRICT_POLICY });
        const armed = await run("arm");
        const after = await run("");
        return { armed: armed.errors.map((error) => error.code), after: after.errors.map((error) => error.code) };
      } finally {
        host.dispose();
      }
    };

    it("keeps required after a plugin rebinds a kernel function", async () => {
      expect(await codesAfterArming("globalThis.kernelIsEmptyValue = function () { return false; };")).toEqual({ armed: [], after: ["required"] });
    });

    // The kernel reads no global, so its answer holds whether or not a redefinition goes through
    // (with the freeze, none does; host-freeze-global-descriptors covers the plugin modules).
    it("keeps required after a plugin redefines a global with defineProperty", async () => {
      const redefine = (name: string, value: string) => `Object.defineProperty(globalThis, ${JSON.stringify(name)}, { value: ${value}, configurable: true, writable: true });`;
      for (const [name, value] of [
        ["kernelStableStringify", "function () { return '{\"errors\":[]}'; }"],
        ["kernelIsEmptyValue", "function () { return false; }"],
        ["runKernel", "function () { return {}; }"],
        ["__datum_run", "function () { return '{\"errors\":[]}'; }"],
        ["__datum_inspect", "function () { return '{}'; }"],
        ["__datum_register", "function () { return 0; }"],
        ["__datum_validators", "[]"],
        ["__datum_prepared", "{}"],
        ["Object", "{}"],
        ["JSON", "{}"],
        ["Array", "{}"],
        ["String", "{}"],
        ["Math", "{}"],
        ["Reflect", "{}"]
      ] as const) {
        expect((await codesAfterArming(redefine(name, value))).after, name).toEqual(["required"]);
      }
    });

    it("keeps the program's state out of the global scope", async () => {
      const host = await createQuickJsValidationHost([
        {
          id: "look",
          version: "1",
          source: `({ validators: [ () => ({ errors: [{ code: "seen", stage: "probe", source: "custom", severity: "info", parameters: { globals: Object.getOwnPropertyNames(globalThis).filter(function (n) { return n.indexOf("__datum") === 0 || n.indexOf("kernel") === 0 || n === "runKernel" || n === "runInspect"; }).sort().join(",") } }] }) ] })`
        }
      ]);
      try {
        const outcome = await host.run({ context: { formId: "f", values: {}, locale: "en", form: requiredForm }, policy: WasmValidationHost.STRICT_POLICY });
        expect(outcome.errors.find((error) => error.code === "seen")?.parameters?.globals).toBe("__datum_inspect,__datum_register,__datum_run");
      } finally {
        host.dispose();
      }
    });

    it("keeps the entry points fixed: the host calls the ones it took hold of at startup", async () => {
      expect((await codesAfterArming("globalThis.__datum_run = function () { return '{}'; };")).after).toEqual(["required"]);
      expect((await codesAfterArming("globalThis.__datum_validators = [];")).after).toEqual(["required"]);
      expect((await codesAfterArming("Object.defineProperty(globalThis, '__datum_run', { value: function () { return '{\"errors\":[]}'; } });")).after).toEqual(["required"]);
    });

    // The registries are closure state, frozen once the first run starts.
    it("keeps another plugin's validators when a plugin touches the registries, at the top of its module or in a run", async () => {
      expect((await codesAfterArming("__datum_validators.length = 0;")).after).toEqual(["required"]);
      expect((await codesAfterArming("__datum_validators.splice(0, 1);")).after).toEqual(["required"]);
      expect((await codesAfterArming("__datum_functions.injected = function () { return 1; };")).after).toEqual(["required"]);
      expect((await codesAfterArming("__datum_signatures.length = 0;")).after).toEqual(["required"]);
      const first = `({ validators: [ () => ({ errors: [{ code: "first.rule", stage: "p", source: "custom", severity: "error" }] }) ] })`;
      const second = `(function () { try { globalThis.__datum_validators.length = 0; } catch (e) {} try { Object.defineProperty(globalThis, '__datum_validators', { value: [] }); } catch (e) {} return { validators: [] }; })()`;
      const host = await createQuickJsValidationHost([{ id: "first", version: "1", source: first }, { id: "second", version: "1", source: second }]);
      try {
        const outcome = await host.run({ context: { formId: "f", values: { name: "Ann" }, locale: "en", form: requiredForm }, policy: WasmValidationHost.STRICT_POLICY });
        expect(outcome.errors.map((error) => error.code)).toContain("first.rule");
      } finally {
        host.dispose();
      }
    });

    it("keeps required after a plugin patches a prototype the kernel uses", async () => {
      expect((await codesAfterArming("Array.prototype.filter = function () { return []; };")).after).toEqual(["required"]);
      expect((await codesAfterArming("String.prototype.trim = function () { return 'x'; };")).after).toEqual(["required"]);
      expect((await codesAfterArming("Object.prototype.polluted = true;")).after).toEqual(["required"]);
      expect((await codesAfterArming("JSON.parse = function () { return {}; };")).after).toEqual(["required"]);
    });

    // The methods are frozen too, so defineProperty cannot shadow call/apply/bind.
    it("keeps required after a plugin redefines a method of an intrinsic or its call/apply/bind", async () => {
      for (const statement of [
        "Object.defineProperty(Object.prototype.hasOwnProperty, 'call', { value: function () { return false; } });",
        "Object.defineProperty(Function.prototype, 'call', { value: function () { return false; } });",
        "Object.defineProperty(Array.isArray, 'call', { value: function () { return false; } });",
        "Object.defineProperty(Array.prototype, 'some', { value: function () { return true; } });",
        "Object.defineProperty(Object.getPrototypeOf(Int8Array.prototype), 'fill', { value: function () {} });",
        "Object.defineProperty(Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())), 'next', { value: function () {} });",
        "Object.defineProperty(Array.prototype[Symbol.unscopables], 'x', { value: true });"
      ]) {
        const result = await codesAfterArming(statement);
        expect(result.after, statement).toEqual(["required"]);
        expect(result.armed, statement).toEqual(["blocked"]);
      }
    });

    it("freezes every object reachable from the intrinsics", async () => {
      const host = await createQuickJsValidationHost([
        {
          id: "walk",
          version: "1",
          source: `({ validators: [ () => {
            var seen = new Set(), queue = [], loose = [];
            function visit(o) { if (o === null || o === undefined || o === globalThis || (typeof o !== "object" && typeof o !== "function") || seen.has(o)) { return; } seen.add(o); queue.push(o); }
            function visitDescriptor(d) { if (d === undefined) { return; } if ("value" in d) { visit(d.value); } else { visit(d.get); visit(d.set); } }
            Object.getOwnPropertyNames(globalThis).forEach(function (n) { visitDescriptor(Object.getOwnPropertyDescriptor(globalThis, n)); });
            for (var i = 0; i < queue.length; i += 1) {
              var o = queue[i];
              if (!Object.isFrozen(o)) { loose.push(typeof o === "function" ? "fn:" + o.name : "obj"); }
              visit(Object.getPrototypeOf(o));
              Object.getOwnPropertyNames(o).concat(Object.getOwnPropertySymbols(o)).forEach(function (k) { visitDescriptor(Object.getOwnPropertyDescriptor(o, k)); });
            }
            return { errors: [{ code: "walked", stage: "probe", source: "custom", severity: "info", parameters: { reached: queue.length, loose: loose.slice(0, 10).join(",") } }] };
          } ] })`
        }
      ]);
      try {
        const outcome = await host.run({ context: { formId: "f", values: {}, locale: "en", form: requiredForm }, policy: WasmValidationHost.STRICT_POLICY });
        const walked = outcome.errors.find((error) => error.code === "walked");
        expect(walked?.parameters?.loose).toBe("");
        expect(Number(walked?.parameters?.reached)).toBeGreaterThan(500);
      } finally {
        host.dispose();
      }
    });

    // The frozen prototypes do not break ordinary plugin code.
    it("lets a plugin subclass Error, set name and message, and give its own objects a toString", async () => {
      const source = `({ validators: [ (c) => {
        var out = [];
        class MyErr extends Error { constructor(m) { super(m); this.name = "MyErr"; } }
        var e = new MyErr("x");
        e.message = "late";
        out.push(e.name, e.message, String(e), e instanceof Error, new Error("plain").name, new TypeError("t").name);
        var o = {}; o.toString = function () { return "z"; }; out.push(String(o));
        function Money(n) { this.n = n; } Money.prototype.toString = function () { return "$" + this.n; }; out.push(String(new Money(5)));
        var p = { valueOf: 1 }; p.valueOf = function () { return 7; }; out.push(p + 1);
        var k = {}; k.constructor = 5; out.push(k.constructor, ({}).constructor === Object, [].constructor === Array);
        var j = {}; j.toJSON = function () { return "J"; }; out.push(JSON.stringify(j));
        try { Error.prototype.name = "Hacked"; out.push("assigned"); } catch (error) { out.push("refused"); }
        try { Object.prototype.toString = function () { return "hacked"; }; out.push("assigned"); } catch (error) { out.push("refused"); }
        out.push(new Error("after").name, String({}), Object.prototype.toString.call([]));
        return { errors: [{ code: "mine", stage: "probe", source: "custom", severity: "info", parameters: { out: out.join("|") } }] };
      } ] })`;
      const host = await createQuickJsValidationHost([{ id: "mine", version: "1", source }]);
      try {
        const outcome = await host.run({ context: { formId: "f", values: {}, locale: "en", form: requiredForm }, policy: WasmValidationHost.STRICT_POLICY });
        expect(outcome.errors.find((error) => error.code === "mine")?.parameters?.out).toBe(
          "MyErr|late|MyErr: late|true|Error|TypeError|z|$5|8|5|true|true|\"J\"|refused|refused|Error|[object Object]|[object Array]"
        );
      } finally {
        host.dispose();
      }
    });

    it("binds every language global to a local the kernel reads", async () => {
      const host = await QuickJsProgramHost.create();
      try {
        const fresh = JSON.parse(host.vm.dump(host.evaluateHandle("JSON.stringify(Object.getOwnPropertyNames(globalThis).filter(function (n) { return n !== 'globalThis'; }))")) as string) as string[];
        // What the engine has that the kernel cannot be reading by name: values, not objects it calls.
        const notNamed = new Set(["undefined", "NaN", "Infinity", "eval", "queueMicrotask", "setTimeout", "clearTimeout", "print", "console", "scriptArgs", "std", "os", "bjson", "gc"]);
        const missing = fresh.filter((name) => !INTRINSIC_ALIASES.includes(name) && !notNamed.has(name));
        expect(missing).toEqual([]);
      } finally {
        host.dispose();
      }
    });

    it("freezes an object held on a __datum_ global like any other", async () => {
      const program = `globalThis.__datum_state = { runs: 0 };
        globalThis.__datum_register = function () { return 0; };
        globalThis.__datum_inspect = function () { return "{}"; };
        globalThis.__datum_run = function () {
          "use strict";
          try { __datum_state.runs += 1; } catch (e) { return JSON.stringify({ errors: [], refused: true, frozen: Object.isFrozen(__datum_state) }); }
          return JSON.stringify({ errors: [], refused: false });
        };
        "ready";`;
      const adapter = new QuickJsWasmHostAdapter({ program });
      const sandbox = await adapter.instantiateSandbox([]);
      try {
        expect(JSON.parse(adapter.runSandbox(sandbox, "{}"))).toEqual({ errors: [], refused: true, frozen: true });
      } finally {
        sandbox.host.dispose();
      }
    });

    it("lets a plugin that has to patch a built-in opt out (freezeIntrinsics false), and only then", async () => {
      // The marker one run leaves on a built-in is seen by the next run only without the freeze.
      const leaves = `({ validators: [ (c) => {
        var seen = Array.prototype.marker === 1;
        try { Array.prototype.marker = 1; } catch (e) {}
        return { errors: seen ? [{ code: "marker", stage: "probe", source: "custom", severity: "info" }] : [] };
      } ] })`;
      for (const [freezeIntrinsics, expected] of [[true, false], [false, true]] as const) {
        const host = await createQuickJsValidationHost([{ id: "leaves", version: "1", source: leaves }], { freezeIntrinsics });
        try {
          const run = () => host.run({ context: { formId: "f", values: { name: "x" }, locale: "en", form: requiredForm }, policy: WasmValidationHost.STRICT_POLICY });
          await run();
          expect((await run()).errors.some((error) => error.code === "marker"), `freeze ${String(freezeIntrinsics)}`).toBe(expected);
        } finally {
          host.dispose();
        }
      }
    });

    it("judges keys named like Object.prototype members as data, with the intrinsics frozen", async () => {
      const host = await createQuickJsValidationHost([]);
      try {
        const keyed: ComponentNode = {
          id: "form",
          type: "form",
          configuration: {},
          children: { content: ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"].map((id) => ({ id, type: "text", configuration: { required: true } })) }
        };
        const values = JSON.parse('{"constructor":"a","toString":"b","hasOwnProperty":"c","valueOf":"d","__proto__":"e"}') as Record<string, unknown>;
        const outcome = await host.run({ context: { formId: "f", values, locale: "en", form: keyed }, policy: WasmValidationHost.STRICT_POLICY });
        expect(outcome.errors.map((error) => error.code)).not.toContain("required");
      } finally {
        host.dispose();
      }
    });
  });
});
