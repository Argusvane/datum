import { describe, expect, it } from "vitest";

import {
  InProcessWasmHostAdapter,
  JsonWasmAbi,
  WasmValidationHost,
  type ComponentNode,
  type FormulaErrorPolicy,
  type Journey,
  type WasmPluginSource
} from "@argusvane/datum-engine";
import { ladderRoot, ladderValues } from "@argusvane/datum-engine/tests/fixtures/feel-ladder";

import { QuickJsWasmHostAdapter } from "../src/index.js";
import { SANDBOX_PREPARED_CHARS, SANDBOX_PREPARED_DEFINITIONS, buildSandboxProgram } from "../src/sandbox-program.js";

// The cache is a closure local of the program; these tests read it through the test-only view.
const viewed = { program: buildSandboxProgram({ exposePrepared: true }) };

/**
 * The prepared-definition cache inside the sandbox: the host reuses one QuickJS context
 * across runs, so the program keeps the cache on its global. A run over a remembered definition
 * must answer byte for byte as the first run did, and as the in-process kernel does.
 */

const abi = new JsonWasmAbi();

function form(tag: string, extra: ComponentNode[] = []): ComponentNode {
  const root = ladderRoot({
    fields: 14,
    ruleShare: 0.4,
    repeating: true,
    extra: [
      { id: "total", type: "number", configuration: {}, rules: { value: "f1 + 1" } } as ComponentNode,
      {
        id: "addr",
        type: "container",
        configuration: { dataKey: "address" },
        children: { content: [{ id: "city", type: "text", configuration: { required: true }, rules: { requiredWhen: 'f0 = "x"' } }] }
      } as ComponentNode,
      ...extra
    ]
  });
  root.id = "form-" + tag;
  return root;
}

const journey = {
  id: "tour",
  pages: [
    { id: "one", components: ["f0", "f1", "f2"], routes: [{ when: 'f0 != "x"', to: "three" }] },
    { id: "two", components: ["f3", "f4", "rows"] },
    { id: "three", components: ["addr", "total"] }
  ]
} as unknown as Journey;

function answers(): Record<string, unknown> {
  return {
    ...ladderValues(14),
    f0: "x",
    total: 99,
    junk: "zzz",
    "rows[0].rowText": "a",
    "rows[0].rowAmount": 5,
    "rows[1].rowText": "b",
    "address.city": ""
  };
}

function payload(root: ComponentNode, extra: { formulaErrors?: FormulaErrorPolicy; riskyPatterns?: "allow" | "refuse"; journey?: Journey; unknownFields?: "strip" | "keep" | "reject" } = {}): string {
  return abi.serializeContext(
    { formId: "prepared", values: answers(), locale: "en", form: root, logLevel: "debug", today: "2026-10-09", ...extra },
    WasmValidationHost.STRICT_POLICY
  );
}

/** The cache's own counters and size, read inside the sandbox. */
function stats(sandbox: Awaited<ReturnType<QuickJsWasmHostAdapter["instantiateSandbox"]>>): { entries: number; hits: number; misses: number; maxChars: number; chars: number } {
  const handle = sandbox.host.evaluateHandle(
    "JSON.stringify({ entries: __datum_prepared.entries.length, hits: __datum_prepared.hits, misses: __datum_prepared.misses, maxChars: __datum_prepared.maxChars, chars: __datum_prepared.entries.reduce(function (sum, entry) { return sum + entry.key.length; }, 0) })"
  );
  try {
    return JSON.parse(sandbox.host.vm.dump(handle) as string) as ReturnType<typeof stats>;
  } finally {
    handle.dispose();
  }
}

describe("QuickJS prepared-definition cache", () => {
  it("answers a remembered definition byte for byte as its first run and as the in-process kernel", async () => {
    const adapter = new QuickJsWasmHostAdapter({ maxEvalMs: 60_000, ...viewed });
    const sandbox = await adapter.instantiateSandbox([]);
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    try {
      for (const unknownFields of ["strip", "keep", "reject"] as const) {
        for (const withJourney of [false, true]) {
          const sent = payload(form("a"), { unknownFields, ...(withJourney ? { journey } : {}) });
          const before = stats(sandbox);
          const miss = adapter.runSandbox(sandbox, sent);
          const hit = adapter.runSandbox(sandbox, sent);
          const hitAgain = adapter.runSandbox(sandbox, sent);
          const label = `${unknownFields} ${withJourney ? "journey" : "form"}`;
          expect(hit, `${label} hit`).toBe(miss);
          expect(hitAgain, `${label} hit again`).toBe(miss);
          expect(miss, `${label} in-process`).toBe(inProcess.run(sent));
          const after = stats(sandbox);
          // The first mode builds the definition; the other modes find it already prepared.
          const built = unknownFields === "strip" ? 1 : 0;
          expect(after.misses - before.misses, label).toBe(built);
          expect(after.hits - before.hits, label).toBe(3 - built);
        }
      }
      // Two definitions in all (with and without the journey); the modes share them.
      expect(stats(sandbox).entries).toBe(2);
    } finally {
      sandbox.host.dispose();
    }
  }, 120_000);

  it("keeps a policy word to its own entry: no cross-talk between runs that differ only in it", async () => {
    const adapter = new QuickJsWasmHostAdapter({ maxEvalMs: 60_000, ...viewed });
    const sandbox = await adapter.instantiateSandbox([]);
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const typo = form("typo", [{ id: "oops", type: "text", configuration: {}, rules: { value: "roundTo(f1 * 2, 2" } } as ComponentNode]);
    const risky = form("risky", [{ id: "code", type: "text", configuration: {}, rules: { visibleWhen: 'matches(f0, "(a+)+b")' } } as ComponentNode]);
    try {
      const runs = [
        payload(typo, { formulaErrors: "fail" }),
        payload(typo, { formulaErrors: "warn" }),
        payload(risky),
        payload(risky, { riskyPatterns: "allow" })
      ];
      const first: string[] = [];
      for (const [index, sent] of runs.entries()) {
        first.push(adapter.runSandbox(sandbox, sent));
        expect(first[index], `run ${index} in-process`).toBe(inProcess.run(sent));
      }
      expect(new Set(first).size).toBe(4);
      for (let pass = 0; pass < 2; pass += 1) {
        for (const [index, sent] of runs.entries()) {
          expect(adapter.runSandbox(sandbox, sent), `pass ${pass} run ${index}`).toBe(first[index]);
        }
      }
      const seen = stats(sandbox);
      expect(seen.entries).toBe(4);
      expect(seen.misses).toBe(4);
      expect(seen.hits).toBe(8);
    } finally {
      sandbox.host.dispose();
    }
  }, 120_000);

  it("keeps the least recently used sixteen across more definitions than that, and still answers each rightly", async () => {
    expect(SANDBOX_PREPARED_DEFINITIONS).toBe(16);
    const adapter = new QuickJsWasmHostAdapter({ maxEvalMs: 60_000, ...viewed });
    const sandbox = await adapter.instantiateSandbox([]);
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    try {
      const runs = Array.from({ length: 20 }, (_, index) => payload(form("e" + String(index))));
      const expected = runs.map((sent) => inProcess.run(sent));
      for (let pass = 0; pass < 2; pass += 1) {
        for (const [index, sent] of runs.entries()) {
          expect(adapter.runSandbox(sandbox, sent), `pass ${pass} definition ${index}`).toBe(expected[index]);
          expect(stats(sandbox).entries).toBeLessThanOrEqual(16);
        }
      }
      const full = stats(sandbox);
      expect(full.entries).toBe(16);
      // Twenty definitions cycled through sixteen places: every run was a miss.
      expect(full.misses).toBe(40);
      expect(full.hits).toBe(0);
      // The newest sixteen are held: the last of them hits, the oldest of the twenty was dropped.
      expect(adapter.runSandbox(sandbox, runs[19] as string)).toBe(expected[19]);
      expect(stats(sandbox).hits).toBe(1);
      expect(adapter.runSandbox(sandbox, runs[0] as string)).toBe(expected[0]);
      expect(stats(sandbox).misses).toBe(41);
    } finally {
      sandbox.host.dispose();
    }
  }, 120_000);

  it("bounds the key text it keeps by the memory the sandbox was given", async () => {
    const roomy = await new QuickJsWasmHostAdapter({ ...viewed }).instantiateSandbox([]);
    const small = await new QuickJsWasmHostAdapter({ memoryLimitBytes: 4 * 1024 * 1024, ...viewed }).instantiateSandbox([]);
    try {
      expect(stats(roomy).maxChars).toBe(SANDBOX_PREPARED_CHARS);
      expect(stats(small).maxChars).toBe(Math.floor((4 * 1024 * 1024) / 16));
      expect(stats(small).maxChars).toBeLessThan(SANDBOX_PREPARED_CHARS);
    } finally {
      roomy.host.dispose();
      small.host.dispose();
    }
  });

  it("holds only what the bound allows, and a definition longer than the bound is judged and not kept", async () => {
    const adapter = new QuickJsWasmHostAdapter({ maxEvalMs: 60_000, memoryLimitBytes: 1024 * 1024, ...viewed });
    const sandbox = await adapter.instantiateSandbox([]);
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    try {
      const bound = stats(sandbox).maxChars;
      expect(bound).toBe(65_536);
      const big = payload(form("big"));
      const small = payload(ladderRoot({ fields: 3, ruleShare: 0 }));
      for (let pass = 0; pass < 2; pass += 1) {
        expect(adapter.runSandbox(sandbox, big)).toBe(inProcess.run(big));
        expect(adapter.runSandbox(sandbox, small)).toBe(inProcess.run(small));
        expect(stats(sandbox).chars).toBeLessThanOrEqual(bound);
      }
    } finally {
      sandbox.host.dispose();
    }
  }, 120_000);

  it("is not reached by a plugin validator that writes to the definition it is handed", async () => {
    const vandal: WasmPluginSource = {
      id: "vandal",
      version: "1.0.0",
      source: `({ validators: [function (context) {
        function visit(node) {
          if (node.configuration) { node.configuration.required = false; }
          delete node.rules;
          var groups = Object.keys(node.children || {});
          for (var g = 0; g < groups.length; g += 1) {
            for (var c = 0; c < node.children[groups[g]].length; c += 1) { visit(node.children[groups[g]][c]); }
          }
        }
        if (context.form) { visit(context.form); }
        return { errors: [] };
      }] })`
    };
    const adapter = new QuickJsWasmHostAdapter({ maxEvalMs: 60_000, ...viewed });
    const quick = await adapter.instantiate([vandal], abi);
    const reference = await new QuickJsWasmHostAdapter({ maxEvalMs: 60_000, ...viewed }).instantiate([vandal], abi);
    try {
      const strict = form("req", [{ id: "must", type: "text", configuration: { required: true }, rules: { visibleWhen: 'f0 = "x"' } } as ComponentNode]);
      const sent = payload(strict);
      // The first run of a fresh sandbox is the reference: nothing was remembered before it.
      const first = await reference.run(sent);
      expect(first).toContain('"code":"required"');
      for (let pass = 0; pass < 3; pass += 1) {
        expect(await quick.run(sent), `pass ${pass}`).toBe(first);
      }
    } finally {
      quick.dispose?.();
      reference.dispose?.();
    }
  }, 120_000);
  it("remembers the option questions: a hit with a snapshot, none, and a free source equals the miss and the in-process kernel", async () => {
    const adapter = new QuickJsWasmHostAdapter({ maxEvalMs: 60_000, ...viewed });
    const sandbox = await adapter.instantiateSandbox([]);
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const choices = form("choices", [
      { id: "color", type: "select", configuration: { options: [{ value: "red", label: "Red" }] } } as ComponentNode,
      { id: "town", type: "select", configuration: { options: [], data: { sourceId: "towns" } } } as ComponentNode,
      { id: "free", type: "select", configuration: { options: [], data: { sourceId: "towns", answersFree: true } } } as ComponentNode,
      { id: "gone", type: "radio", configuration: { options: [], data: { sourceId: "lost" } } } as ComponentNode
    ]);
    const picked = { ...answers(), color: "green", town: "Nowhere", free: "Anywhere", gone: "x" };
    try {
      for (const optionSnapshot of [undefined, {}, { towns: [{ value: "Paris" }] }, { towns: [{ value: "Nowhere" }], lost: [] }]) {
        const sent = abi.serializeContext(
          { formId: "prepared", values: picked, locale: "en", form: choices, logLevel: "debug", today: "2026-10-09", ...(optionSnapshot !== undefined ? { optionSnapshot } : {}) },
          WasmValidationHost.STRICT_POLICY
        );
        const miss = adapter.runSandbox(sandbox, sent);
        const hit = adapter.runSandbox(sandbox, sent);
        expect(hit).toBe(miss);
        expect(miss).toBe(inProcess.run(sent));
        expect(miss).toContain("option.");
      }
      const handle = sandbox.host.evaluateHandle("JSON.stringify(__datum_prepared.entries.map(function (entry) { return typeof entry.prepared.derived.optionQuestions; }))");
      try {
        expect(JSON.parse(sandbox.host.vm.dump(handle) as string)).toEqual(["object"]);
      } finally {
        handle.dispose();
      }
    } finally {
      sandbox.host.dispose();
    }
  }, 120_000);
});
