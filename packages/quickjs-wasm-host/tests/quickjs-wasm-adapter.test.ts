import { describe, expect, it } from "vitest";

import {
  JsonWasmAbi,
  WasmValidationHost,
  WASM_ABI_VERSION,
  type ComponentNode
} from "@argusvane/datum-engine";

import {
  certifyWasmPlugin,
  createQuickJsValidationHost,
  QuickJsExecutionError,
  QuickJsWasmHostAdapter,
  toSourceModule
} from "../src/index.js";

const root: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "email", type: "text", configuration: { required: true } },
      { id: "notes", type: "text", configuration: {} }
    ]
  }
};

describe("QuickJsWasmHostAdapter", () => {
  it("instantiates the core kernel and runs string-in/string-out with canonical key order", async () => {
    const adapter = new QuickJsWasmHostAdapter();
    expect(adapter.abiVersion).toBe(WASM_ABI_VERSION);

    const abi = new JsonWasmAbi();
    const instance = await adapter.instantiate([], abi);
    const payload = await instance.run(
      abi.serializeContext(
        { formId: "f1", values: { notes: "hi", email: "a@b.co", zz: 1, Aa: 2 }, locale: "en", form: root },
        WasmValidationHost.STRICT_POLICY
      )
    );

    const outcome = abi.deserializeOutcome(payload);
    expect(outcome.errors).toEqual([]);
    // Sanitized: zz/Aa are not in the schema. Canonical: keys in code-unit order.
    // The value index rides beside the values, in the same key order.
    expect(payload).toBe(
      '{"errors":[],"index":[{"delta":"","path":"email","value":"a@b.co"},{"delta":"","path":"notes","value":"hi"}],"values":{"email":"a@b.co","notes":"hi"}}'
    );
    instance.dispose?.();
  });

  it("enforces core schema constraints with no plugins at all", async () => {
    const host = await createQuickJsValidationHost();
    const outcome = await host.run({
      context: { formId: "f1", values: { notes: "x" }, locale: "en", form: root },
      policy: WasmValidationHost.STRICT_POLICY
    });
    expect(outcome.errors.map((error) => error.code)).toEqual(["required"]);
    expect(outcome.errors[0]?.componentId).toBe("email");
    expect(outcome.errors[0]?.source).toBe("wasm");
    expect(outcome.values).toBeUndefined();
    host.dispose();
  });

  it("registers plugin modules at startup and runs their validators against sanitized values", async () => {
    const host = await createQuickJsValidationHost([
      {
        id: "email-rules",
        version: "1.0.0",
        source: `({
          validators: [
            (context) => ({
              errors:
                typeof context.values.email === "string" && !context.values.email.includes("@")
                  ? [{ code: "format.email", componentId: "email", path: "email", stage: "plugin", source: "custom" }]
                  : []
            })
          ]
        })`
      }
    ]);

    const bad = await host.run({
      context: { formId: "f1", values: { email: "nope" }, locale: "en", form: root },
      policy: WasmValidationHost.STRICT_POLICY
    });
    expect(bad.errors.map((error) => error.code)).toEqual(["format.email"]);

    const good = await host.run({
      context: { formId: "f1", values: { email: "a@b.co", rogue: true }, locale: "en", form: root },
      policy: WasmValidationHost.STRICT_POLICY
    });
    expect(good.errors).toEqual([]);
    expect(good.values).toEqual({ email: "a@b.co" });
    host.dispose();
  });

  it("bridges function-backed validators via toSourceModule", async () => {
    const module = toSourceModule({
      id: "len",
      version: "1.0.0",
      validate: (context) => ({
        errors:
          typeof context.values.notes === "string" && context.values.notes.length > 3
            ? [{ code: "custom.tooLong", componentId: "notes", path: "notes", stage: "plugin", source: "custom" }]
            : []
      })
    });

    const host = await createQuickJsValidationHost([module]);
    const outcome = await host.run({
      context: { formId: "f1", values: { email: "a@b.co", notes: "toolong" }, locale: "en", form: root },
      policy: WasmValidationHost.STRICT_POLICY
    });
    expect(outcome.errors.map((error) => error.code)).toEqual(["custom.tooLong"]);
    host.dispose();
  });

  it("reports typed errors for broken plugin modules", async () => {
    const adapter = new QuickJsWasmHostAdapter();
    const abi = new JsonWasmAbi();

    await expect(
      adapter.instantiate([{ id: "syntax", version: "1.0.0", source: "({ validators: [" }], abi)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof QuickJsExecutionError && error.code === "compile_error"
    );

    await expect(
      adapter.instantiate([{ id: "scalar", version: "1.0.0", source: "42" }], abi)
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof QuickJsExecutionError && error.code === "not_a_module"
    );

    await expect(
      adapter.instantiate(
        [{ id: "bad-shape", version: "1.0.0", source: "({ validators: [1, 2] })" }],
        abi
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof QuickJsExecutionError && error.code === "not_a_module"
    );
  });

  it("certifies plugin modules", async () => {
    const good = await certifyWasmPlugin({
      id: "ok",
      version: "1.0.0",
      source: "({ validators: [(context) => ({ errors: [] }), (context) => ({ errors: [] })] })"
    });
    expect(good).toEqual({ ok: true, validatorCount: 2 });

    const bad = await certifyWasmPlugin({ id: "broken", version: "1.0.0", source: "nope(" });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("compile_error");
  });

  // The default budget scales with the rule reads of the definition.
  const bigForm = (): ComponentNode => {
    const ids = Array.from({ length: 50 }, (_, i) => `f${i}`);
    const sumOf = ids.map((id) => id).join(" + ");
    return {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          ...ids.map((id) => ({ id, type: "number", configuration: {} }) as ComponentNode),
          ...Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, type: "number", configuration: {}, rules: { value: sumOf } }) as ComponentNode)
        ]
      }
    };
  };

  it("runs a 50 by 50 form within the scaled default budget", async () => {
    const abi = new JsonWasmAbi();
    const instance = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const values: Record<string, number> = {};
    for (let i = 0; i < 50; i += 1) {
      values[`f${i}`] = 1;
    }
    const payload = abi.serializeContext({ formId: "f1", values, locale: "en", form: bigForm() }, WasmValidationHost.STRICT_POLICY);
    const outcome = abi.deserializeOutcome(await instance.run(payload));
    expect(outcome.errors).toEqual([]);
    expect((outcome.values as Record<string, number>).t49).toBe(50);
    // The second run of the same definition reuses the remembered budget.
    expect(abi.deserializeOutcome(await instance.run(payload)).errors).toEqual([]);
    instance.dispose?.();
  }, 60_000);

  it("scales the default with the reads, and lets a host-set maxEvalMs win", async () => {
    const abi = new JsonWasmAbi();
    const adapter = new QuickJsWasmHostAdapter();
    const sandbox = await adapter.instantiateSandbox([]);
    const small = abi.serializeContext({ formId: "f1", values: {}, locale: "en", form: root }, WasmValidationHost.STRICT_POLICY);
    adapter.runSandbox(sandbox, small);
    expect(sandbox.host.limits.maxEvalMs).toBe(250);
    adapter.runSandbox(sandbox, abi.serializeContext({ formId: "f1", values: {}, locale: "en", form: bigForm() }, WasmValidationHost.STRICT_POLICY));
    expect(sandbox.host.limits.maxEvalMs).toBe(5000);
    sandbox.host.dispose();

    // Any value but the scaled 5,000 shows the host's wins; 3,000 leaves the big form's run room to
    // finish on a busy machine, where 300 ms could interrupt it.
    const fixed = new QuickJsWasmHostAdapter({ maxEvalMs: 3000 });
    const own = await fixed.instantiateSandbox([]);
    fixed.runSandbox(own, abi.serializeContext({ formId: "f1", values: {}, locale: "en", form: bigForm() }, WasmValidationHost.STRICT_POLICY));
    expect(own.host.limits.maxEvalMs).toBe(3000);
    own.host.dispose();
  }, 60_000);

  it("gives an inspect call 250 ms plus 1 ms per KB of the request, at most 5,000, and lets a host-set maxEvalMs win", async () => {
    const budgetAt = async (adapter: QuickJsWasmHostAdapter, request: string): Promise<number> => {
      const sandbox = await adapter.instantiateSandbox([]);
      const seen: number[] = [];
      const call = sandbox.host.call.bind(sandbox.host);
      sandbox.host.call = (name: string, argument: string): string => {
        seen.push(sandbox.host.limits.maxEvalMs);
        return call(name, argument);
      };
      const before = sandbox.host.limits.maxEvalMs;
      JSON.parse(adapter.inspectSandbox(sandbox, request));
      expect(sandbox.host.limits.maxEvalMs).toBe(before);
      sandbox.host.dispose();
      return seen[0] as number;
    };
    const ask = (padding: number): string =>
      JSON.stringify({ abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: { ...root, configuration: { pad: "x".repeat(padding) } } } });
    const defaults = new QuickJsWasmHostAdapter();
    expect(await budgetAt(defaults, ask(0))).toBe(250);
    const mid = ask(400 * 1024);
    expect(await budgetAt(defaults, mid)).toBe(250 + Math.floor(mid.length / 1024));
    expect(await budgetAt(defaults, ask(6 * 1024 * 1024))).toBe(5000);
    expect(await budgetAt(new QuickJsWasmHostAdapter({ maxEvalMs: 300 }), mid)).toBe(300);
  }, 60_000);

  it("keys the remembered budget on the form, journey and pdf text, and keeps the most recently used", async () => {
    const abi = new JsonWasmAbi();
    const adapter = new QuickJsWasmHostAdapter();
    const sandbox = await adapter.instantiateSandbox([]);
    const small = abi.serializeContext({ formId: "f1", values: {}, locale: "en", form: root }, WasmValidationHost.STRICT_POLICY);
    const big = abi.serializeContext({ formId: "f1", values: {}, locale: "en", form: bigForm() }, WasmValidationHost.STRICT_POLICY);
    adapter.runSandbox(sandbox, small);
    expect(sandbox.host.limits.maxEvalMs).toBe(250);
    adapter.runSandbox(sandbox, big);
    expect(sandbox.host.limits.maxEvalMs).toBe(5000);
    const bigKey = [...(sandbox.budgets?.keys() ?? [])].pop() ?? "";
    // A different value set over the same form hits the same entry.
    adapter.runSandbox(sandbox, abi.serializeContext({ formId: "f1", values: { f0: 1 }, locale: "en", form: bigForm() }, WasmValidationHost.STRICT_POLICY));
    expect(sandbox.host.limits.maxEvalMs).toBe(5000);
    expect(sandbox.budgets?.size).toBe(2);
    // More definitions than the cache holds: the oldest goes, never the whole cache.
    for (let i = 0; i < 20; i += 1) {
      const form: ComponentNode = { id: "form", type: "form", configuration: { n: i }, children: { content: [] } };
      adapter.runSandbox(sandbox, abi.serializeContext({ formId: "f1", values: {}, locale: "en", form }, WasmValidationHost.STRICT_POLICY));
      adapter.runSandbox(sandbox, big);
    }
    expect(sandbox.budgets?.size).toBe(16);
    expect(sandbox.budgets?.has(bigKey)).toBe(true);
    sandbox.host.dispose();
  }, 60_000);

  // The cache remembers a number under a short key, never the definition text.
  it("remembers the budget under a short key, however large the definition is", async () => {
    const abi = new JsonWasmAbi();
    const adapter = new QuickJsWasmHostAdapter();
    const sandbox = await adapter.instantiateSandbox([]);
    const form: ComponentNode = { id: "form", type: "form", configuration: { label: "L".repeat(2 * 1024 * 1024) }, children: { content: [] } };
    adapter.runSandbox(sandbox, abi.serializeContext({ formId: "f1", values: {}, locale: "en", form }, WasmValidationHost.STRICT_POLICY));
    const keys = [...(sandbox.budgets?.keys() ?? [])];
    expect(keys).toHaveLength(1);
    expect(keys.every((key) => key.length < 64)).toBe(true);
    sandbox.host.dispose();
  }, 60_000);

  // A large definition with no rules is not interrupted cold.
  it("adds a millisecond per kilobyte of definition to the default budget, up to the ceiling", async () => {
    const abi = new JsonWasmAbi();
    const adapter = new QuickJsWasmHostAdapter();
    const sandbox = await adapter.instantiateSandbox([]);
    const wide = (count: number): ComponentNode => ({
      id: "form",
      type: "form",
      configuration: {},
      children: { content: Array.from({ length: count }, (_, j) => ({ id: `y${j}`, type: "text", configuration: { label: "L".repeat(50) } }) as ComponentNode) }
    });
    const text = abi.serializeContext({ formId: "f1", values: {}, locale: "en", form: wide(4000) }, WasmValidationHost.STRICT_POLICY);
    try {
      // The budget is set before the run; a slow runner may interrupt it, which is not the point here.
      adapter.runSandbox(sandbox, text);
    } catch {
      // not the point
    }
    expect(sandbox.host.limits.maxEvalMs).toBeGreaterThanOrEqual(250 + 300);
    expect(sandbox.host.limits.maxEvalMs).toBeLessThanOrEqual(5000);
    try {
      // A definition this large may not run in the sandbox at all; the budget is set before it does.
      adapter.runSandbox(sandbox, abi.serializeContext({ formId: "f1", values: {}, locale: "en", form: { id: "form", type: "form", configuration: { label: "L".repeat(6 * 1024 * 1024) }, children: { content: [] } } }, WasmValidationHost.STRICT_POLICY));
    } catch {
      // not the point
    }
    expect(sandbox.host.limits.maxEvalMs).toBe(5000);
    sandbox.host.dispose();
  }, 60_000);
  it("runs a program given as text instead of the one built from source", async () => {
    const abi = new JsonWasmAbi();
    // A stand-in program: the host evaluates exactly the text it is handed.
    const adapter = new QuickJsWasmHostAdapter({
      program: 'globalThis.__datum_run = function () { return \'{"stand":"in"}\'; }; globalThis.__datum_inspect = function () { return "{}"; };'
    });
    const sandbox = await adapter.instantiateSandbox([]);
    const text = abi.serializeContext({ formId: "f1", values: {}, locale: "en", form: root }, WasmValidationHost.STRICT_POLICY);
    expect(adapter.runSandbox(sandbox, text)).toBe('{"stand":"in"}');
    sandbox.host.dispose();
  }, 60_000);

  // A run's outcome is capped at 8 MiB.
  it("refuses a run whose outcome passes 8 MiB (outcome_too_large), and the host answers the next run", async () => {
    const host = await createQuickJsValidationHost(
      [
        {
          id: "big",
          version: "1",
          source: `({ validators: [ (c) => { const big = "x".repeat(8 << 20); return { errors: c.values.notes === "huge" ? [0, 1].map(() => ({ code: "c", stage: "plugin", source: "custom", severity: "error", message: big })) : [] }; } ] })`
        }
      ],
      { maxEvalMs: 5000 }
    );
    try {
      const run = (huge: boolean) =>
        host.run({ context: { formId: "f", values: { email: "a@b.co", notes: huge ? "huge" : "" }, locale: "en", form: root }, policy: WasmValidationHost.STRICT_POLICY });
      await expect(run(true)).rejects.toMatchObject({ code: "outcome_too_large", message: expect.stringContaining("outcome.tooLarge") });
      expect((await run(false)).errors).toEqual([]);
    } finally {
      host.dispose();
    }
  }, 60_000);
});
