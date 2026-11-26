import { describe, expect, it } from "vitest";

import {
  isSourcePlugin,
  JsonWasmAbi,
  WASM_ABI_VERSION,
  WasmValidationHost,
  type WasmAbi,
  type WasmValidatorInstance
} from "../form-engine/validation/wasm/wasm-validation-host.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";

const root: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "a", type: "text", configuration: {} },
      { id: "b", type: "text", configuration: {} },
      { id: "email", type: "text", configuration: {} }
    ]
  }
};

describe("wasm validation host", () => {
  it("runs with strict policy", async () => {
    const host = createInProcessWasmValidationHost({
      id: "deterministic",
      version: "1.0.0",
      validate: () => ({ errors: [] })
    });

    const result = await host.run({
      context: { formId: "f1", values: {}, form: root },
      policy: WasmValidationHost.STRICT_POLICY
    });

    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({});
  });

  it("rejects policy with extra privileges", async () => {
    const host = createInProcessWasmValidationHost({
      id: "deterministic",
      version: "1.0.0",
      validate: () => ({ errors: [] })
    });

    await expect(
      host.run({
        context: { formId: "f1", values: {}, form: root },
        policy: {
          // @ts-expect-error - deliberately invalid policy to exercise runtime rejection
          allowNetwork: true,
          allowFilesystem: false,
          allowProcess: false,
          allowEnvironment: false
        }
      })
    ).rejects.toThrow(/fully restricted/);
  });

  it("rejects an adapter whose ABI version does not match the ABI", () => {
    expect(
      () =>
        new WasmValidationHost(
          { id: "x", version: "1.0.0", validate: () => ({ errors: [] }) },
          {
            adapter: {
              id: "fake",
              abiVersion: "0.9.0",
              instantiate: () => ({ abiVersion: "0.9.0", run: () => '{"errors":[]}' })
            }
          }
        )
    ).toThrow(/ABI version mismatch/i);
  });

  it("round-trips the context through the serialization boundary with code-unit key order", async () => {
    const seen: string[] = [];
    const host = createInProcessWasmValidationHost({
      id: "echo",
      version: "1.0.0",
      validate: (ctx) => {
        seen.push(JSON.stringify(ctx.values));
        return { errors: [] };
      }
    });

    await host.run({
      context: { formId: "f1", values: { b: 2, a: 1 }, form: root },
      policy: WasmValidationHost.STRICT_POLICY
    });
    // The validator receives a value object rebuilt from the serialized payload; keys sort
    // by code unit ("B" < "a"), never by locale collation.
    expect(seen).toEqual(['{"a":1,"b":2}']);

    const abi = new JsonWasmAbi();
    expect(abi.serializeOutcome({ errors: [], values: { a: 1, B: 2 } })).toBe(
      '{"errors":[],"values":{"B":2,"a":1}}'
    );
  });

  it("drops the browser's requiredComponents from the serialized context: it is not part of the ABI", () => {
    const abi = new JsonWasmAbi();
    // A caller that spreads a `ValidationContext` into the sandbox context still carries the
    // map — TypeScript checks no excess property on a spread — so the serializer takes it out.
    const carried = { formId: "f1", values: { a: "" }, form: root, requiredComponents: { a: true } } as unknown as Parameters<JsonWasmAbi["serializeContext"]>[0];
    const payload = abi.serializeContext(carried, WasmValidationHost.STRICT_POLICY);
    expect(payload).not.toContain("requiredComponents");
    expect(payload).toBe(abi.serializeContext({ formId: "f1", values: { a: "" }, form: root }, WasmValidationHost.STRICT_POLICY));
    expect(abi.deserializeContext(payload)).not.toHaveProperty("requiredComponents");
  });

  it("drops the browser's resolved dataGridRowBounds from the serialized context: the kernel evaluates the bounds itself", () => {
    const abi = new JsonWasmAbi();
    // The field-constraints stage's context spread into the sandbox's: the bounds would change the payload's bytes.
    const carried = {
      formId: "f1",
      values: { a: "" },
      form: root,
      dataGridRowBounds: { items_grid: { minRows: 2, maxRows: 4 } },
      invalidComponents: { a: true }
    } as unknown as Parameters<JsonWasmAbi["serializeContext"]>[0];
    const payload = abi.serializeContext(carried, WasmValidationHost.STRICT_POLICY);
    expect(payload).not.toContain("dataGridRowBounds");
    expect(payload).not.toContain("items_grid");
    expect(payload).toBe(abi.serializeContext({ formId: "f1", values: { a: "" }, form: root }, WasmValidationHost.STRICT_POLICY));
    expect(abi.deserializeContext(payload)).not.toHaveProperty("dataGridRowBounds");
  });

  it("carries the host's translation catalog in the serialized context when set, and omits it when absent", () => {
    const abi = new JsonWasmAbi();
    const catalog = { "fr-CA": { components: { a: { patternMessage: "Catalogue" } } } };
    const withCatalog = abi.serializeContext({ formId: "f1", values: { a: "" }, form: root, catalog }, WasmValidationHost.STRICT_POLICY);
    expect(abi.deserializeContext(withCatalog).catalog).toEqual(catalog);
    const without = abi.serializeContext({ formId: "f1", values: { a: "" }, form: root }, WasmValidationHost.STRICT_POLICY);
    expect(without).not.toContain("catalog");
    expect(abi.deserializeContext(without)).not.toHaveProperty("catalog");
  });

  it("rejects non-allowlisted external data keys", async () => {
    const host = createInProcessWasmValidationHost({
      id: "x",
      version: "1.0.0",
      validate: () => ({ errors: [] })
    });

    await expect(
      host.run({
        context: { formId: "f1", values: {}, form: root, externalData: { secretToken: "abc" } },
        policy: { ...WasmValidationHost.STRICT_POLICY, allowedExternalDataKeys: ["publicRate"] }
      })
    ).rejects.toThrow(/external data key not allowed/i);
  });

  it("returns sanitized values on success and no values when blocked", async () => {
    const host = createInProcessWasmValidationHost({
      id: "gate",
      version: "1.0.0",
      validate: (ctx) => ({
        errors:
          ctx.values.a === "bad"
            ? [{ code: "custom.bad", componentId: "a", path: "a", stage: "plugin", source: "custom" as const }]
            : []
      })
    });

    const ok = await host.run({
      context: { formId: "f1", values: { a: "fine", unknownKey: "dropped" }, form: root },
      policy: WasmValidationHost.STRICT_POLICY
    });
    expect(ok.errors).toEqual([]);
    // The validated data differs from what was sent: schema-unknown keys are stripped.
    expect(ok.values).toEqual({ a: "fine" });

    const blocked = await host.run({
      context: { formId: "f1", values: { a: "bad" }, form: root },
      policy: WasmValidationHost.STRICT_POLICY
    });
    expect(blocked.errors.map((error) => error.code)).toEqual(["custom.bad"]);
    expect(blocked.values).toBeUndefined();
  });

  it("applies the per-run unknownFields mode from the submission context", async () => {
    const host = createInProcessWasmValidationHost({
      id: "clean",
      version: "1.0.0",
      validate: () => ({ errors: [] })
    });

    const kept = await host.run({
      context: {
        formId: "f1",
        values: { a: "fine", unknownKey: "kept" },
        form: root,
        unknownFields: "keep"
      },
      policy: WasmValidationHost.STRICT_POLICY
    });
    expect(kept.errors).toEqual([]);
    expect(kept.values).toEqual({ a: "fine", unknownKey: "kept" });

    const rejected = await host.run({
      context: {
        formId: "f1",
        values: { a: "fine", unknownKey: "blocked" },
        form: root,
        unknownFields: "reject"
      },
      policy: WasmValidationHost.STRICT_POLICY
    });
    expect(rejected.values).toBeUndefined();
    expect(rejected.errors.map((error) => error.code)).toEqual(["unknown_field"]);
    expect(rejected.errors[0]?.parameters).toEqual({ field: "unknownKey" });
  });

  it("distinguishes source plugins and rejects them in-process", () => {
    const source = { id: "p", version: "1.0.0", source: "({ validators: [] })" };
    const fn = { id: "p", version: "1.0.0", validators: [] };
    expect(isSourcePlugin(source)).toBe(true);
    expect(isSourcePlugin(fn)).toBe(false);

    expect(() => new InProcessWasmHostAdapter().instantiate([source], new JsonWasmAbi())).toThrow(
      /never evals strings/i
    );
  });

  it("has no default adapter: an adapter, or an instance, is required", async () => {
    const validator = { id: "v", version: "1.0.0", validate: () => ({ errors: [] }) };
    // What a caller without types could still write: the in-process kernel is never assumed.
    expect(() => new WasmValidationHost(validator, {} as never)).toThrow(/needs an adapter/);
    await expect(WasmValidationHost.create(validator, {} as never)).rejects.toThrow(/needs an adapter/);

    const host = createInProcessWasmValidationHost(validator);
    // `a` is a text field, so its answer is a string (a number there is refused, `text`).
    const outcome = await host.run({ context: { formId: "f1", values: { a: "1" }, form: root }, policy: WasmValidationHost.STRICT_POLICY });
    expect(outcome.values).toEqual({ a: "1" });
  });

  it("takes a given instance before any adapter, which it then never instantiates", async () => {
    const instantiated: string[] = [];
    const adapter = {
      id: "never",
      abiVersion: WASM_ABI_VERSION,
      instantiate: (): WasmValidatorInstance => {
        instantiated.push("never");
        throw new Error("the instance was given");
      }
    };
    const instance: WasmValidatorInstance = { abiVersion: WASM_ABI_VERSION, run: () => '{"errors":[],"values":{"from":"instance"}}' };

    const bare = new WasmValidationHost([], { instance });
    expect((await bare.run({ context: { formId: "f1", values: {}, form: root }, policy: WasmValidationHost.STRICT_POLICY })).values).toEqual({ from: "instance" });
    const both = new WasmValidationHost([], { adapter, instance });
    expect((await both.run({ context: { formId: "f1", values: {}, form: root }, policy: WasmValidationHost.STRICT_POLICY })).values).toEqual({ from: "instance" });
    const created = await WasmValidationHost.create([], { adapter, instance });
    expect((await created.run({ context: { formId: "f1", values: {}, form: root }, policy: WasmValidationHost.STRICT_POLICY })).values).toEqual({ from: "instance" });
    expect(instantiated).toEqual([]);
  });

  it("sync constructor rejects an async adapter; create() awaits it", async () => {
    const abi = new JsonWasmAbi();
    const inner = new InProcessWasmHostAdapter();
    const asyncAdapter = {
      id: "async-fake",
      abiVersion: abi.version,
      instantiate: (plugins: Parameters<InProcessWasmHostAdapter["instantiate"]>[0]): Promise<WasmValidatorInstance> =>
        Promise.resolve(inner.instantiate(plugins, abi))
    };
    const validator = { id: "v", version: "1.0.0", validate: () => ({ errors: [] }) };

    expect(() => new WasmValidationHost(validator, { adapter: asyncAdapter })).toThrow(
      /WasmValidationHost\.create/
    );

    const host = await WasmValidationHost.create(validator, { adapter: asyncAdapter });
    // `a` is a text field, so its answer is a string.
    const outcome = await host.run({
      context: { formId: "f1", values: { a: "1" }, form: root },
      policy: WasmValidationHost.STRICT_POLICY
    });
    expect(outcome.values).toEqual({ a: "1" });
    host.dispose();
  });
});

describe("wasm validation host: formulas, the day and the run scopes cross the ABI", () => {
  it("is 4.1.0 and carries today and formulaErrors in the context, clockDependent and serverRules in the outcome", async () => {
    expect(WASM_ABI_VERSION).toBe("4.1.0");
    const dated: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "start", type: "date", configuration: {} },
          {
            id: "late",
            type: "text",
            configuration: {},
            rules: {
              // Trees, since the in-process adapter hands the kernel no parser signatures (its
              // owner's request); the keys cross the ABI the same way for a formula.
              visibleWhen: { kind: "binary", operator: "gt", left: { kind: "call", name: "today", args: [] }, right: { kind: "path", path: "start" } },
              requiredWhen: { expression: { kind: "literal", value: true }, run: "server" }
            }
          }
        ]
      }
    };
    const abi = new JsonWasmAbi();
    const serialized = abi.serializeContext(
      { formId: "f1", values: { start: "2026-01-01" }, form: dated, today: "2026-10-07", formulaErrors: "fail" },
      WasmValidationHost.STRICT_POLICY
    );
    const crossed = JSON.parse(serialized) as Record<string, unknown>;
    expect(crossed.today).toBe("2026-10-07");
    expect(crossed.formulaErrors).toBe("fail");
    expect(abi.deserializeContext(serialized)).toMatchObject({ today: "2026-10-07", formulaErrors: "fail" });

    const host = createInProcessWasmValidationHost([]);
    const outcome = await host.run({
      context: { formId: "f1", values: { start: "2026-01-01" }, form: dated, today: "2026-10-07" },
      policy: WasmValidationHost.STRICT_POLICY
    });
    expect(outcome.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["late:required"]);
    expect(outcome.clockDependent).toEqual(["late"]);
    expect(outcome.serverRules).toEqual(["late"]);
    const again = abi.deserializeOutcome(abi.serializeOutcome(outcome));
    expect(again).toEqual(outcome);
    expect(abi.serializeOutcome(again)).toBe(abi.serializeOutcome(outcome));

    // Neither key for a form without such rules.
    const plain = await host.run({ context: { formId: "f1", values: {}, form: root }, policy: WasmValidationHost.STRICT_POLICY });
    expect(plain).not.toHaveProperty("clockDependent");
    expect(plain).not.toHaveProperty("serverRules");
  });
});

describe("wasm validation host: inspect, the introspection entry point", () => {
  const secret: FormDefinition = {
    id: "apply",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "employed", type: "checkbox", configuration: {} },
          { id: "reason", type: "text", configuration: {}, rules: { requiredWhen: { formula: "employed = true", run: "server-secret" }, visibleWhen: "regionOk(employed)" } },
          { id: "bad", type: "text", configuration: {}, rules: { value: "len(employed" } }
        ]
      }
    }
  };

  it("answers the three ops through the in-process adapter with the host's ABI filled in", async () => {
    const host = createInProcessWasmValidationHost([]);
    const before = JSON.stringify(secret);

    const served = await host.inspect({ op: "public", definition: secret });
    expect(served).toMatchObject({ ok: true, op: "public" });
    if (!served.ok || served.op !== "public") {
      throw new Error("not a public answer");
    }
    expect(JSON.stringify(served.definition)).not.toContain("server-secret");
    expect((served.definition.root.children?.content ?? [])[1]?.rules).toEqual({ visibleWhen: "regionOk(employed)" });

    const checked = await host.inspect({ op: "check", definition: secret, formulaErrors: "fail" });
    expect(checked).toMatchObject({ ok: true, op: "check", policy: "fail", verdict: "fail" });
    if (!checked.ok || checked.op !== "check") {
      throw new Error("not a check answer");
    }
    expect(checked.problems.map((problem) => `${problem.where}:${problem.code}`)).toEqual(["rules:reason:visibleWhen:unknownFunction", "rules:bad:value:unclosedParen"]);

    const inventory = await host.inspect({ op: "inspect", definition: secret });
    expect(inventory).toEqual({
      ok: true,
      op: "inspect",
      rules: [
        { componentId: "reason", key: "requiredWhen", run: "server-secret", reads: ["employed"], readsHost: false, readsClock: false, functions: [] },
        { componentId: "reason", key: "visibleWhen", run: "both", reads: ["employed"], readsHost: false, readsClock: false, functions: ["regionOk"] }
      ],
      functionsUsed: ["regionOk"],
      pluginsNeeded: ["regionOk"],
      // Every value path the kernel reads.
      paths: [
        { path: "employed", componentId: "employed", type: "checkbox", holdsData: true },
        { path: "reason", componentId: "reason", type: "text", holdsData: true },
        { path: "bad", componentId: "bad", type: "text", holdsData: true }
      ]
    });
    expect(JSON.stringify(secret)).toBe(before);

    // A wired plugin function parses in `check`, and is still no built-in in `inspect`.
    const wired = createInProcessWasmValidationHost([{ id: "p", version: "1.0.0", validators: [], functions: { regionOk: () => true } }]);
    const wiredCheck = await wired.inspect({ op: "check", definition: secret });
    if (!wiredCheck.ok || wiredCheck.op !== "check") {
      throw new Error("not a check answer");
    }
    expect(wiredCheck.problems.map((problem) => problem.where)).toEqual(["rules:bad:value"]);
    expect(await wired.inspect({ op: "inspect", definition: secret })).toMatchObject({ pluginsNeeded: ["regionOk"] });
  });

  it("returns the sandbox's refusals rather than throwing: a caller's wrong ABI, an op of no shape", async () => {
    const host = createInProcessWasmValidationHost([]);
    expect(await host.inspect({ op: "public", definition: secret, abi: "5.0.0" })).toMatchObject({ ok: false, error: { code: "abi_mismatch" } });
    expect(await host.inspect({ op: "nope" as "public", definition: secret })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("rejects when the instance has no inspect entry point", async () => {
    // The instance passes the ABI check (another abiVersion is refused by the constructor, see
    // "a pre-instantiated sandbox" below) but offers no `inspect`.
    const instance: WasmValidatorInstance = { abiVersion: WASM_ABI_VERSION, run: () => '{"errors":[]}' };
    const host = new WasmValidationHost([], { instance });
    await expect(host.inspect({ op: "public", definition: secret })).rejects.toThrow(/no inspect entry point/);
  });
});

describe("wasm validation host: the instance's ABI and nested external data", () => {
  it("refuses a pre-instantiated sandbox whose ABI is not the host's before it runs anything", async () => {
    let ran = false;
    const stale: WasmValidatorInstance = {
      abiVersion: "3.0.0",
      run: () => {
        ran = true;
        return '{"errors":[],"values":{}}';
      }
    };
    expect(() => new WasmValidationHost([], { instance: stale })).toThrow(/ABI version mismatch: instance 3\.0\.0 != abi/);
    await expect(WasmValidationHost.create([], { instance: stale })).rejects.toThrow(/ABI version mismatch/);
    for (const version of ["5.0.0", "4.2.0", "", "4.0", "4.1.0 "]) {
      expect(() => new WasmValidationHost([], { instance: { ...stale, abiVersion: version } }), JSON.stringify(version)).toThrow(/ABI version mismatch/);
    }
    expect(ran).toBe(false);

    // The abi handed in names the version the instance must match, exactly as for an adapter.
    const json = new JsonWasmAbi();
    const other: WasmAbi = {
      version: "3.0.0",
      serializeContext: (context, policy) => json.serializeContext(context, policy),
      deserializeContext: (payload) => json.deserializeContext(payload),
      serializeOutcome: (outcome) => json.serializeOutcome(outcome),
      deserializeOutcome: (payload) => json.deserializeOutcome(payload)
    };
    expect(() => new WasmValidationHost([], { abi: other, instance: { abiVersion: WASM_ABI_VERSION, run: () => "{}" } })).toThrow(/ABI version mismatch/);
    expect(new WasmValidationHost([], { abi: other, instance: { abiVersion: "3.0.0", run: () => "{}" } })).toBeInstanceOf(WasmValidationHost);
  });

  const ranWith = (externalData: Record<string, unknown>) =>
    createInProcessWasmValidationHost([]).run({ context: { formId: "f", values: { a: "x" }, form: root, externalData }, policy: WasmValidationHost.STRICT_POLICY });

  it("refuses external data that JSON would reshape, at any depth, naming the path to it", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class Snapshot {
      public m(): number {
        return 1;
      }
    }
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["a nested function", { k: { inner: () => 1 } }, /"k\.inner" is not serializable: a function/],
      ["a nested symbol", { k: [Symbol("x")] }, /"k\[0\]" is not serializable: a symbol/],
      ["a nested bigint", { k: { inner: [1n] } }, /"k\.inner\[0\]" is not serializable: a bigint/],
      ["a Map", { k: new Map([["a", 1]]) }, /"k" is not serializable: .*Map/],
      ["a Set", { k: new Set([1]) }, /"k" is not serializable: .*Set/],
      ["a Date", { k: { when: new Date(0) } }, /"k\.when" is not serializable: .*Date/],
      ["a class instance", { k: new Snapshot() }, /"k" is not serializable: .*Snapshot/],
      ["NaN", { k: { rate: Number.NaN } }, /"k\.rate" is not serializable: a number JSON cannot carry/],
      ["an infinity", { k: [Number.POSITIVE_INFINITY] }, /"k\[0\]" is not serializable: a number JSON cannot carry/],
      ["a cycle", { k: cyclic }, /nested deeper than 64 levels/]
    ];
    for (const [name, externalData, pattern] of cases) {
      await expect(ranWith(externalData), name).rejects.toThrow(pattern);
    }
    // The top-level refusals keep their wording.
    await expect(ranWith({ k: () => 1 })).rejects.toThrow(/key "k" is not serializable/);
    await expect(ranWith({ k: 1n })).rejects.toThrow(/key "k" is not serializable/);
  });

  it("bounds the walk in depth and in size, so a hostile value is refused rather than walked for ever", async () => {
    const nest = (depth: number): unknown => {
      let value: unknown = "leaf";
      for (let level = 0; level < depth; level += 1) {
        value = [value];
      }
      return value;
    };
    await expect(ranWith({ k: nest(60) })).resolves.toBeDefined();
    await expect(ranWith({ k: nest(70) })).rejects.toThrow(/"k(\[0\])+" is not serializable: nested deeper than 64 levels/);
    await expect(ranWith({ big: new Array(1_000_001).fill(0) })).rejects.toThrow(/more than 1000000 values/);
  });

  it("lets plain JSON through at any depth, a null-prototype object included, and drops an undefined entry", async () => {
    const seen: unknown[] = [];
    const host = createInProcessWasmValidationHost({
      id: "peek",
      version: "1.0.0",
      validate: (context) => {
        seen.push(context.externalData);
        return { errors: [] };
      }
    });
    const bare = Object.create(null) as Record<string, unknown>;
    bare.rate = 2;
    const data = {
      rows: [{ value: "a", label: "A", flag: true, n: 1.5, nothing: null }],
      nested: { deep: [[["ok"]]] },
      bare,
      skipped: undefined
    };
    await expect(host.run({ context: { formId: "f", values: {}, form: root, externalData: data }, policy: WasmValidationHost.STRICT_POLICY })).resolves.toBeDefined();
    expect(seen[0]).toEqual({ rows: [{ value: "a", label: "A", flag: true, n: 1.5, nothing: null }], nested: { deep: [[["ok"]]] }, bare: { rate: 2 } });
  });
});
