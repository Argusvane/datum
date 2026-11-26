import { describe, expect, it } from "vitest";

import {
  DOCUMENT_PROFILE,
  QuickJsExecutionError,
  QuickJsWasmHostAdapter,
  VALIDATION_PROFILE,
  assertRequestWithinLimits,
  buildSandboxProgram,
  createQuickJsProgramHost
} from "../src/index.js";

describe("QuickJsProgramHost", () => {
  it("evaluates a program and calls into it, settling a returned promise by draining jobs", async () => {
    const host = await createQuickJsProgramHost();
    try {
      host.evaluate(`
        globalThis.__echo = function (s) { return s + "!"; };
        globalThis.__later = function (s) {
          return new Promise(function (resolve) {
            Promise.resolve().then(function () { resolve(s.toUpperCase()); });
          });
        };
        globalThis.__chain = async function (s) { await null; await null; return s + s; };
      `);
      expect(host.call("__echo", "x")).toBe("x!");
      expect(host.call("__later", "abc")).toBe("ABC");
      expect(host.call("__chain", "ab")).toBe("abab");
    } finally {
      host.dispose();
    }
  });

  it("disposes cleanly after a job that grew the WASM heap (a detached view once made a stray JSContext)", async () => {
    // quickjs-emscripten's own executePendingJobs reads the job's context pointer through a view
    // the growth detaches, creates a second context for the bogus pointer and never frees it, so
    // JS_FreeRuntime fails list_empty(&rt->gc_obj_list) on dispose. The job here must grow the
    // heap whatever earlier tests left it at: it allocates past the heap's size as it stands.
    const host = await createQuickJsProgramHost({ limits: DOCUMENT_PROFILE });
    try {
      const wasm = (host.runtime as unknown as { module: { HEAPU8: Uint8Array } }).module;
      const before = wasm.HEAPU8.byteLength;
      const want = before + 8 * 1024 * 1024;
      expect(want).toBeLessThan(DOCUMENT_PROFILE.memoryLimitBytes - 16 * 1024 * 1024);
      host.evaluate(`globalThis.__grow = function () { return Promise.resolve().then(function () { globalThis.__held = new ArrayBuffer(${want}); return "grown"; }); };`);
      expect(host.call("__grow", "")).toBe("grown");
      expect(wasm.HEAPU8.byteLength).toBeGreaterThan(before);
      // Nothing else was created for the job: the runtime still knows only its own context.
      expect((host.runtime as unknown as { contextMap: Map<number, unknown> }).contextMap.size).toBe(1);
    } finally {
      host.dispose();
    }
  });

  it("reports a promise that can never settle instead of hanging", async () => {
    const host = await createQuickJsProgramHost();
    try {
      host.evaluate("globalThis.__stuck = function () { return new Promise(function () {}); };");
      expect(() => host.call("__stuck", "")).toThrow(QuickJsExecutionError);
      try {
        host.call("__stuck", "");
      } catch (error) {
        expect((error as QuickJsExecutionError).code).toBe("never_settles");
      }
    } finally {
      host.dispose();
    }
  });

  it("labels a deadline that cuts a job short as interrupted, not never_settles", async () => {
    const host = await createQuickJsProgramHost({ limits: { maxEvalMs: 100 } });
    try {
      host.evaluate("globalThis.__spin = function () { return Promise.resolve().then(function () { for (;;) {} }); };");
      let code = "";
      try {
        host.call("__spin", "");
      } catch (error) {
        code = (error as QuickJsExecutionError).code;
      }
      expect(code).toBe("interrupted");
    } finally {
      host.dispose();
    }
  });

  it("maps a rejection, a throw, a missing entry and a non-string result to typed errors", async () => {
    const host = await createQuickJsProgramHost();
    try {
      host.evaluate(`
        globalThis.__reject = function () { return Promise.reject(new TypeError("no")); };
        globalThis.__throw = function () { throw new RangeError("out"); };
        globalThis.__number = function () { return 42; };
      `);
      const codeOf = (entry: string): string => {
        try {
          host.call(entry, "");
          return "none";
        } catch (error) {
          return error instanceof QuickJsExecutionError ? `${error.code}:${error.message}` : "other";
        }
      };
      expect(codeOf("__reject")).toBe("runtime_error:TypeError: no");
      expect(codeOf("__throw")).toBe("runtime_error:RangeError: out");
      expect(codeOf("__missing")).toContain('runtime_error:The program defines no function "__missing"');
      expect(codeOf("__number")).toContain("returned a number");
      expect(() => host.evaluate("this is not javascript")).toThrow(/compile_error|SyntaxError/);
    } finally {
      host.dispose();
    }
  });

  it("hardens the runtime by default: no clock, no randomness, no timers, no DOM", async () => {
    const host = await createQuickJsProgramHost();
    try {
      host.evaluate(`
        globalThis.__probe = function () {
          var out = [];
          try { Date.now(); out.push("date:ok"); } catch (e) { out.push("date:" + e.message); }
          try { Math.random(); out.push("random:ok"); } catch (e) { out.push("random:" + e.message); }
          out.push("timers:" + typeof setTimeout, "fetch:" + typeof fetch, "document:" + typeof document);
          return out.join("|");
        };
      `);
      expect(host.call("__probe", "")).toBe(
        "date:Date.now is disabled in the sandbox|random:Math.random is disabled in the sandbox|timers:undefined|fetch:undefined|document:undefined"
      );
    } finally {
      host.dispose();
    }
  });

  it("interrupts a call past its budget, and the document profile allows far more than the validation one", async () => {
    expect(DOCUMENT_PROFILE.maxEvalMs).toBeGreaterThan(VALIDATION_PROFILE.maxEvalMs * 10);
    expect(DOCUMENT_PROFILE.memoryLimitBytes).toBeGreaterThan(VALIDATION_PROFILE.memoryLimitBytes);
    // The stack is the singlefile build's own; asking for more breaks every call.
    expect(DOCUMENT_PROFILE.maxStackSizeBytes).toBe(VALIDATION_PROFILE.maxStackSizeBytes);

    const host = await createQuickJsProgramHost({ limits: { maxEvalMs: 50 } });
    try {
      host.evaluate("globalThis.__spin = function () { for (;;) {} };");
      try {
        host.call("__spin", "");
        expect.fail("expected an interrupt");
      } catch (error) {
        expect((error as QuickJsExecutionError).code).toBe("interrupted");
      }
    } finally {
      host.dispose();
    }
  });
});

describe("QuickJsProgramHost: the request bound and a poisoned runtime", () => {
  const FORM = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { required: true } }] } };
  const nested = (depth: number): string => "[".repeat(depth) + "]".repeat(depth);
  const codeOf = (work: () => unknown): string => {
    try {
      work();
      return "none";
    } catch (error) {
      return error instanceof QuickJsExecutionError ? error.code : `untyped ${error instanceof Error ? error.name : typeof error}`;
    }
  };

  it("the profiles bound a request: 320 levels deep, as long as the memory limit", () => {
    expect(VALIDATION_PROFILE.maxRequestDepth).toBe(320);
    expect(VALIDATION_PROFILE.maxRequestLength).toBe(VALIDATION_PROFILE.memoryLimitBytes);
    expect(DOCUMENT_PROFILE.maxRequestDepth).toBe(320);
    expect(DOCUMENT_PROFILE.maxRequestLength).toBe(DOCUMENT_PROFILE.memoryLimitBytes);
  });

  it("refuses a request nested past maxRequestDepth before the program sees it, and the host lives on", async () => {
    const host = await createQuickJsProgramHost();
    try {
      host.evaluate(`
        globalThis.__calls = 0;
        globalThis.__depth = function (s) { globalThis.__calls += 1; var d = 0; var v = JSON.parse(s); while (Array.isArray(v)) { d += 1; v = v[0]; } return String(d); };
        globalThis.__count = function () { return String(globalThis.__calls); };
      `);
      expect(host.call("__depth", nested(320))).toBe("320");
      for (const depth of [321, 1000, 5000, 200_000]) {
        expect(codeOf(() => host.call("__depth", nested(depth))), `depth ${depth}`).toBe("request_refused");
      }
      // The program was never entered for a refused request, and the host still answers.
      expect(host.call("__count", "")).toBe("1");
      expect(host.call("__depth", nested(3))).toBe("3");
      expect(host.poisoned).toBe(false);
    } finally {
      expect(() => host.dispose()).not.toThrow();
    }
  });

  it("counts brackets outside string literals only, and refuses a request longer than maxRequestLength", async () => {
    const limits = { maxRequestDepth: 4, maxRequestLength: 64 };
    const text = JSON.stringify({ a: '[[[[[[{{{{ " ]]]] [[[[[[ \\ ' });
    expect(() => assertRequestWithinLimits(text, limits)).not.toThrow();
    expect(() => assertRequestWithinLimits("[[[[]]]]", limits)).not.toThrow();
    expect(() => assertRequestWithinLimits('{"a":{"b":{"c":[[]]}}}', limits)).toThrow(/deeper than 4 levels/);
    expect(() => assertRequestWithinLimits("[[[[[]]]]]", limits)).toThrow(/deeper than 4 levels/);
    expect(() => assertRequestWithinLimits("x".repeat(64), limits)).not.toThrow();
    expect(() => assertRequestWithinLimits("x".repeat(65), limits)).toThrow(/at most 64/);
    const host = await createQuickJsProgramHost({ limits });
    try {
      host.evaluate("globalThis.__len = function (s) { return String(s.length); };");
      expect(host.call("__len", text)).toBe(String(text.length));
      expect(codeOf(() => host.call("__len", "x".repeat(65)))).toBe("request_refused");
      expect(codeOf(() => host.call("__len", "[[[[[]]]]]"))).toBe("request_refused");
    } finally {
      host.dispose();
    }
  });

  it("through the adapter: a deeply nested submission is a typed refusal, honest runs beside it are judged, and the sandbox disposes cleanly", async () => {
    const adapter = new QuickJsWasmHostAdapter({ memoryLimitBytes: 4 * 1024 * 1024 });
    const sandbox = await adapter.instantiateSandbox([]);
    const root = JSON.stringify(FORM);
    const hostile = `{"formId":"c19","values":{"name":${nested(1000)}},"locale":"en","form":${root}}`;
    const honest = JSON.stringify({ formId: "c19", values: { name: "x" }, locale: "en", form: FORM });
    try {
      for (let round = 0; round < 50; round += 1) {
        expect(codeOf(() => adapter.runSandbox(sandbox, hostile))).toBe("request_refused");
        expect(JSON.parse(adapter.runSandbox(sandbox, honest))).toMatchObject({ errors: [], values: { name: "x" } });
      }
      expect(sandbox.host.poisoned).toBe(false);
    } finally {
      expect(() => sandbox.host.dispose()).not.toThrow();
    }
  });

  it("a host-side stack overflow that still escapes a call (the bound lifted) is a typed error, marks the host poisoned, and dispose does not abort", async () => {
    const host = await createQuickJsProgramHost({ hardening: false, limits: { maxRequestDepth: 1_000_000 } });
    host.evaluate(buildSandboxProgram(), "sandbox-program");
    const context = JSON.stringify({ formId: "p", values: { name: "DEEP" }, locale: "en", form: FORM }).replace('"DEEP"', nested(5000));
    let caught: unknown;
    try {
      host.call("__datum_run", context);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QuickJsExecutionError);
    expect((caught as QuickJsExecutionError).code).toBe("runtime_error");
    expect((caught as QuickJsExecutionError).message).toMatch(/RangeError.*abandoned/);
    expect(host.poisoned).toBe(true);
    // Freeing such a runtime would fail QuickJS's own assertion and abort; it is left allocated.
    expect(() => host.dispose()).not.toThrow();
    // Another host on the same module is unaffected.
    const next = await createQuickJsProgramHost();
    try {
      next.evaluate("globalThis.__id = function (s) { return s; };");
      expect(next.call("__id", "fine")).toBe("fine");
    } finally {
      next.dispose();
    }
  });

  // A run's outcome is capped so one answer cannot exhaust the host's memory.
  it("refuses an answer longer than maxResultLength as outcome_too_large, and caps a validation run at 8 MiB", async () => {
    expect(VALIDATION_PROFILE.maxResultLength).toBe(8 * 1024 * 1024);
    expect(DOCUMENT_PROFILE.maxResultLength).toBeUndefined();
    const host = await createQuickJsProgramHost({ limits: { maxResultLength: 100 } });
    try {
      host.evaluate('globalThis.__out = function (n) { return "x".repeat(Number(n)); };');
      expect(host.call("__out", "100")).toHaveLength(100);
      let refused: unknown;
      try {
        host.call("__out", "101");
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(QuickJsExecutionError);
      expect((refused as QuickJsExecutionError).code).toBe("outcome_too_large");
      expect((refused as QuickJsExecutionError).message).toContain("outcome.tooLarge");
      // An explicit cap for one call (the adapter's inspect) wins; the host still works.
      expect(host.call("__out", "101", Infinity)).toHaveLength(101);
      expect(host.call("__out", "5")).toBe("xxxxx");
    } finally {
      host.dispose();
    }
  });
});
