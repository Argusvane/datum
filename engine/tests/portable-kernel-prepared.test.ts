import { describe, expect, it } from "vitest";

import {
  kernelCreatePreparedCache,
  kernelPrepareDefinition,
  kernelPreparedKey,
  kernelPreparedLookup,
  kernelPreparedStore,
  kernelStableStringify,
  runKernel,
  PORTABLE_KERNEL_FUNCTIONS,
  type KernelPrepared,
  type KernelPreparedCache,
  type KernelValidator
} from "../form-engine/validation/wasm/portable-kernel.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import { ladderRoot, ladderValues } from "./fixtures/feel-ladder.js";

/**
 * The prepared-definition cache: a hit is the object a miss would have built, so a run
 * over a remembered definition answers byte for byte as the same run over none. The kernel keeps
 * no state of its own between runs; these tests hold a cache the way a host does.
 */

const signatures = formulaFunctionSignatures();

/** A form with rules of every reading the indexes serve: a section with a calculation, a data-keyed container, a choice. */
function richForm(tag: string, extra: ComponentNode[] = []): ComponentNode {
  const root = ladderRoot({
    fields: 12,
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

function richJourney(): Journey {
  return {
    id: "tour",
    pages: [
      { id: "one", components: ["f0", "f1", "f2"], routes: [{ when: 'f0 != "x"', to: "three" }] },
      { id: "two", components: ["f3", "f4", "rows"] },
      { id: "three", components: ["addr", "total"] }
    ]
  } as unknown as Journey;
}

function answers(): Record<string, unknown> {
  return {
    ...ladderValues(12),
    f0: "x",
    total: 99,
    junk: "zzz",
    "rows[0].rowText": "a",
    "rows[0].rowAmount": 5,
    "rows[1].rowText": "b",
    "address.city": ""
  };
}

type Mode = "strip" | "keep" | "reject";

interface Run {
  form?: ComponentNode;
  values?: Record<string, unknown>;
  mode?: Mode;
  journey?: Journey;
  formulaErrors?: "fail" | "warn";
  riskyPatterns?: string;
  today?: string;
}

function contextOf(run: Run) {
  return {
    formId: "prepared",
    locale: "en",
    form: run.form ?? richForm("a"),
    values: run.values ?? answers(),
    unknownFields: run.mode ?? "strip",
    logLevel: "debug" as const,
    today: run.today ?? "2026-10-09",
    ...(run.journey !== undefined ? { journey: run.journey } : {}),
    ...(run.formulaErrors !== undefined ? { formulaErrors: run.formulaErrors } : {}),
    ...(run.riskyPatterns !== undefined ? { riskyPatterns: run.riskyPatterns } : {})
  };
}

/** One run as the host sees it: a context that came through JSON, the outcome as canonical text. */
function judge(run: Run, cache?: KernelPreparedCache, validators: KernelValidator[] = []): string {
  const context = JSON.parse(JSON.stringify(contextOf(run))) as ReturnType<typeof contextOf>;
  return kernelStableStringify(runKernel(context, validators, {}, signatures, cache));
}

function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  Object.freeze(value);
}

describe("the prepared-definition cache: a hit answers as a miss and as no cache", () => {
  const modes: Mode[] = ["strip", "keep", "reject"];

  it("is byte-identical over every mode, with and without a journey, a page, and a day", () => {
    const cache = kernelCreatePreparedCache(16, 4_000_000);
    let compared = 0;
    for (const mode of modes) {
      for (const journey of [undefined, richJourney()]) {
        for (const today of ["2026-10-09", "2027-01-01"]) {
          const run: Run = { mode, today, ...(journey !== undefined ? { journey } : {}) };
          const bare = judge(run);
          const miss = judge(run, cache);
          const hit = judge(run, cache);
          const again = judge(run, cache);
          expect(miss, `${mode} ${String(journey?.id)} ${today} miss`).toBe(bare);
          expect(hit, `${mode} ${String(journey?.id)} ${today} hit`).toBe(bare);
          expect(again).toBe(bare);
          compared += 1;
        }
      }
    }
    expect(compared).toBe(12);
    // Two definitions (with and without the journey) under the one policy word: two entries; the rest were hits.
    expect(cache.entries.length).toBe(2);
    expect(cache.misses).toBe(2);
    expect(cache.hits).toBe(12 * 3 - 2);
  });

  it("answers different answers over the same remembered definition as it would with none", () => {
    const cache = kernelCreatePreparedCache(16, 4_000_000);
    judge({}, cache);
    const variants: Array<Record<string, unknown>> = [
      {},
      { f0: "y" },
      { f0: "x", "address.city": "Paris" },
      { "rows[0].rowText": "", "rows[2].rowText": "c", "rows[2].rowAmount": 9 },
      { rows: [{ rowText: "posted", rowAmount: 1 }] },
      { total: 1, extra_unknown: 1 }
    ];
    for (const [index, variant] of variants.entries()) {
      for (const mode of modes) {
        const run: Run = { mode, values: { ...answers(), ...variant } };
        expect(judge(run, cache), `${mode} variant ${index}`).toBe(judge(run));
      }
    }
    expect(cache.entries.length).toBe(1);
  });

  it("reads a remembered definition without writing to it: frozen after the first run, every run still answers alike", () => {
    const cache = kernelCreatePreparedCache(16, 4_000_000);
    const journey = richJourney();
    const first = judge({ journey }, cache);
    expect(first).toBe(judge({ journey }));
    // Every slot a run fills has been filled by now; a reader that wrote to the shared tree or to an index
    // would throw on a frozen one (this module is strict).
    for (const entry of cache.entries) {
      deepFreeze(entry.prepared);
    }
    for (const mode of modes) {
      for (const run of [{ mode, journey }, { mode }]) {
        const frozen = judge(run, cache);
        // `{ mode }` is another definition (no journey): prepared and filled afresh, then frozen and read again.
        for (const entry of cache.entries) {
          deepFreeze(entry.prepared);
        }
        expect(frozen, `${mode} ${run.journey === undefined ? "form" : "journey"}`).toBe(judge(run));
        expect(judge(run, cache), `${mode} ${run.journey === undefined ? "form" : "journey"} again`).toBe(judge(run));
      }
    }
  });

  it("reads a definition cut loose for validators (a private frozen copy) alike in every mode, with and without a journey", () => {
    const quiet: KernelValidator = () => ({ errors: [] });
    const cache = kernelCreatePreparedCache(16, 4_000_000);
    for (const mode of modes) {
      for (const journey of [undefined, richJourney()]) {
        const run: Run = { mode, ...(journey !== undefined ? { journey } : {}) };
        const reference = judge(run, undefined, [quiet]);
        for (let pass = 0; pass < 3; pass += 1) {
          expect(judge(run, cache, [quiet]), `${mode} ${String(journey?.id)} pass ${pass}`).toBe(reference);
        }
      }
    }
    expect(cache.entries.length).toBe(2);
    for (const entry of cache.entries) {
      expect(Object.isFrozen(entry.prepared.root)).toBe(true);
    }
  });

  it("logs and judges what the compile found on every run, a hit included", () => {
    const cache = kernelCreatePreparedCache(16, 4_000_000);
    const typo = richForm("typo", [{ id: "oops", type: "text", configuration: {}, rules: { value: "roundTo(f1 * 2, 2" } } as ComponentNode]);
    for (const formulaErrors of ["fail", "warn"] as const) {
      const run: Run = { form: typo, formulaErrors };
      const bare = judge(run);
      for (let pass = 0; pass < 3; pass += 1) {
        expect(judge(run, cache), `${formulaErrors} pass ${pass}`).toBe(bare);
      }
    }
    // The refusal under `fail` and the logged problem under `warn` are not the same text.
    expect(judge({ form: typo, formulaErrors: "fail" }, cache)).not.toBe(judge({ form: typo, formulaErrors: "warn" }, cache));
    // One definition, two policy words: two entries, no cross-talk.
    expect(cache.entries.length).toBe(2);
  });

  it("keeps a policy word and a risky-pattern word to their own entries", () => {
    const cache = kernelCreatePreparedCache(16, 4_000_000);
    const risky = richForm("risky", [
      { id: "code", type: "text", configuration: {}, rules: { visibleWhen: 'matches(f0, "(a+)+b")' } } as ComponentNode
    ]);
    const runs: Run[] = [
      { form: risky },
      { form: risky, riskyPatterns: "allow" },
      { form: risky, formulaErrors: "warn" },
      { form: risky, formulaErrors: "warn", riskyPatterns: "allow" }
    ];
    // Interleaved, so one entry's answer would show in another's if the key blurred them.
    for (let pass = 0; pass < 3; pass += 1) {
      for (const run of runs) {
        expect(judge(run, cache), `pass ${pass} ${JSON.stringify([run.formulaErrors, run.riskyPatterns])}`).toBe(judge(run));
      }
    }
    expect(cache.entries.length).toBe(4);
    expect(cache.misses).toBe(4);
    expect(cache.hits).toBe(8);
    // The words really change the verdict here, or the test would prove nothing.
    expect(new Set(runs.map((run) => judge(run))).size).toBeGreaterThan(1);
  });

  it("keeps the least recently used sixteen across more definitions than that, answering alike throughout", () => {
    const cache = kernelCreatePreparedCache(16, 4_000_000);
    const runs: Run[] = Array.from({ length: 40 }, (_, index) => ({ form: richForm("e" + String(index)) }));
    const bare = runs.map((run) => judge(run));
    for (let pass = 0; pass < 2; pass += 1) {
      runs.forEach((run, index) => {
        expect(judge(run, cache), `pass ${pass} definition ${index}`).toBe(bare[index]);
        expect(cache.entries.length).toBeLessThanOrEqual(16);
      });
    }
    // Forty definitions cycled through sixteen places never hit: each came back after thirty-nine others.
    expect(cache.entries.length).toBe(16);
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(80);
  });

  it("drops the oldest first, and a hit makes an entry the newest", () => {
    const cache = kernelCreatePreparedCache(3, 4_000_000);
    const run = (name: string): Run => ({ form: richForm(name) });
    judge(run("a"), cache);
    judge(run("b"), cache);
    judge(run("c"), cache);
    judge(run("a"), cache); // a is the newest now; b the oldest
    expect(cache.hits).toBe(1);
    judge(run("d"), cache); // b goes
    judge(run("a"), cache);
    judge(run("c"), cache);
    judge(run("d"), cache);
    expect(cache.hits).toBe(4);
    const before = cache.misses;
    judge(run("b"), cache);
    expect(cache.misses).toBe(before + 1);
  });

  it("keeps no more key text than its bound, and none at all of a definition longer than the bound", () => {
    const one = JSON.stringify(richForm("a")).length;
    const cache = kernelCreatePreparedCache(16, Math.floor(one * 2.5));
    for (let index = 0; index < 6; index += 1) {
      const run: Run = { form: richForm("b" + String(index)) };
      expect(judge(run, cache)).toBe(judge(run));
      const chars = cache.entries.reduce((sum, entry) => sum + entry.key.length, 0);
      expect(chars).toBeLessThanOrEqual(cache.maxChars);
    }
    expect(cache.entries.length).toBeLessThanOrEqual(2);
    const tiny = kernelCreatePreparedCache(16, 10);
    const run: Run = {};
    expect(judge(run, tiny)).toBe(judge(run));
    expect(judge(run, tiny)).toBe(judge(run));
    expect(tiny.entries.length).toBe(0);
    expect(tiny.hits).toBe(0);
    const none = kernelCreatePreparedCache(0, 4_000_000);
    expect(judge(run, none)).toBe(judge(run));
    expect(none.entries.length).toBe(0);
  });

  it("is not reached by a validator that writes to the form it is handed", () => {
    const vandal: KernelValidator = (context) => {
      const visit = (node: ComponentNode): void => {
        if (node.configuration !== undefined) {
          (node.configuration as Record<string, unknown>).required = false;
        }
        delete (node as { rules?: unknown }).rules;
        for (const group of Object.values(node.children ?? {})) {
          group.forEach(visit);
        }
      };
      try {
        if (context.form !== undefined) {
          visit(context.form);
        }
      } catch {
        // a frozen form would throw; this one is not frozen, and the point is what the next run reads
      }
      return { errors: [] };
    };
    const strict = richForm("req", [{ id: "must", type: "text", configuration: { required: true }, rules: { visibleWhen: 'f0 = "x"' } } as ComponentNode]);
    const run: Run = { form: strict, values: { ...answers(), must: undefined } };
    // Each run gets its own parsed context, so with no cache the vandal reaches nothing a later run reads.
    const plain = judge(run);
    const reference = judge(run, undefined, [vandal]);
    expect(plain).toContain('"code":"required"');
    expect(reference).toContain('"code":"required"');
    const cache = kernelCreatePreparedCache(16, 4_000_000);
    for (let pass = 0; pass < 3; pass += 1) {
      expect(judge(run, cache, [vandal]), `pass ${pass}`).toBe(reference);
    }
    // A run with the vandal after a run without one, and the other way round.
    const other = kernelCreatePreparedCache(16, 4_000_000);
    expect(judge(run, other)).toBe(plain);
    expect(judge(run, other, [vandal])).toBe(reference);
    expect(judge(run, other)).toBe(plain);
    const reverse = kernelCreatePreparedCache(16, 4_000_000);
    expect(judge(run, reverse, [vandal])).toBe(reference);
    expect(judge(run, reverse)).toBe(plain);
  });
});

describe("the prepared-definition key and store", () => {
  const form = richForm("k");
  const journey = richJourney();
  const keyOf = (overrides: { form?: unknown; journey?: unknown; pdf?: unknown; policy?: string; risky?: unknown; signatures?: typeof signatures } = {}): string | undefined =>
    kernelPreparedKey(
      kernelCreatePreparedCache(16, 4_000_000),
      overrides.form ?? form,
      "journey" in overrides ? overrides.journey : journey,
      overrides.pdf,
      overrides.policy ?? "fail",
      overrides.risky,
      overrides.signatures ?? signatures
    );

  it("names the same inputs by the same key, and each input apart", () => {
    const key = keyOf();
    expect(key).toBeDefined();
    expect(keyOf()).toBe(key);
    expect(keyOf({ form: JSON.parse(JSON.stringify(form)) })).toBe(key);
    const distinct = [
      keyOf({ policy: "warn" }),
      keyOf({ risky: "allow" }),
      keyOf({ risky: "refuse" }),
      keyOf({ journey: undefined }),
      keyOf({ journey: { ...journey, id: "other" } }),
      keyOf({ pdf: { layouts: [] } }),
      keyOf({ form: richForm("other") }),
      keyOf({ signatures: [...signatures, { name: "plugin", min: 0, max: Number.POSITIVE_INFINITY }] }),
      keyOf({ signatures: signatures.map((row) => (row.name === "len" ? { ...row, max: row.max + 1 } : row)) })
    ];
    expect(new Set([key, ...distinct]).size).toBe(distinct.length + 1);
  });

  it("does not depend on the order the signatures are listed in", () => {
    expect(keyOf({ signatures: [...signatures].reverse() })).toBe(keyOf());
  });

  it("builds no key for a definition longer than the cache's whole bound", () => {
    const cache = kernelCreatePreparedCache(16, 100);
    expect(kernelPreparedKey(cache, form, undefined, undefined, "fail", undefined, signatures)).toBeUndefined();
    const small = { id: "form", type: "form", configuration: {}, children: {} };
    expect(kernelPreparedKey(kernelCreatePreparedCache(16, 100_000), small, undefined, undefined, "fail", undefined, signatures)).toBeDefined();
  });

  it("follows a signature list that grows after the first key", () => {
    const cache = kernelCreatePreparedCache(16, 4_000_000);
    const list = [...signatures];
    const before = kernelPreparedKey(cache, form, undefined, undefined, "fail", undefined, list);
    list.push({ name: "later", min: 0, max: Number.POSITIVE_INFINITY });
    const after = kernelPreparedKey(cache, form, undefined, undefined, "fail", undefined, list);
    expect(after).not.toBe(before);
  });

  it("gives no key to a definition that cannot be written as JSON text", () => {
    const cyclic: Record<string, unknown> = { id: "form", type: "form" };
    cyclic.self = cyclic;
    expect(keyOf({ form: cyclic })).toBeUndefined();
    expect(keyOf({ form: { id: "form", big: BigInt(1) } })).toBeUndefined();
    expect(keyOf({ form: () => 1 })).toBeUndefined();
    // And a run over one just prepares its own, cache or not.
    const cache = kernelCreatePreparedCache(16, 4_000_000);
    const context = { formId: "p", locale: "en", values: {}, form: { id: "form", type: "form", configuration: { big: BigInt(1) }, children: {} } } as never;
    expect(() => runKernel(context, [], {}, signatures, cache)).not.toThrow();
    expect(cache.entries.length).toBe(0);
  });

  it("stores what it is given and returns it, counting hits and misses", () => {
    const cache = kernelCreatePreparedCache(2, 1_000_000);
    const prepared = (name: string): KernelPrepared => kernelPrepareDefinition(richForm(name), undefined, undefined, "fail", undefined, signatures);
    const a = prepared("a");
    const b = prepared("b");
    const c = prepared("c");
    expect(kernelPreparedLookup(cache, "a")).toBeUndefined();
    kernelPreparedStore(cache, "a", a);
    kernelPreparedStore(cache, "b", b);
    expect(kernelPreparedLookup(cache, "a")).toBe(a);
    kernelPreparedStore(cache, "c", c);
    expect(kernelPreparedLookup(cache, "b")).toBeUndefined();
    expect(kernelPreparedLookup(cache, "a")).toBe(a);
    expect(kernelPreparedLookup(cache, "c")).toBe(c);
    expect(cache.hits).toBe(3);
    expect(cache.misses).toBe(2);
  });

  it("leaves the definition and the journey it prepares as written", () => {
    const authored = richForm("w", [{ id: "oops", type: "text", configuration: {}, rules: { value: "len(f0" } } as ComponentNode]);
    const before = JSON.stringify([authored, journey]);
    const prepared = kernelPrepareDefinition(authored, journey, undefined, "fail", undefined, signatures);
    expect(JSON.stringify([authored, journey])).toBe(before);
    expect(prepared.problems.length).toBeGreaterThan(0);
    expect(prepared.unparsedCalculations).toEqual(["oops"]);
    expect(prepared.root).not.toBe(authored);
  });

  it("lists every function the cache needs among the spliced kernel functions", () => {
    const names = new Set(PORTABLE_KERNEL_FUNCTIONS.map((fn) => fn.name));
    for (const name of [
      "kernelCreatePreparedCache",
      "kernelPrepareDefinition",
      "kernelPreparedKey",
      "kernelPreparedLookup",
      "kernelPreparedStore",
      "kernelPreparedGet",
      "kernelPreparedIsolate",
      "kernelKeyShapeOnce"
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });
});

describe("the option questions are remembered with the prepared definition (OPTIONS-1)", () => {
  const choices = (): ComponentNode[] => [
    { id: "color", type: "select", configuration: { options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] } } as ComponentNode,
    { id: "town", type: "select", configuration: { options: [], data: { sourceId: "towns" } } } as ComponentNode,
    { id: "free", type: "select", configuration: { options: [], data: { sourceId: "towns", answersFree: true } } } as ComponentNode,
    { id: "gone", type: "radio", configuration: { options: [], data: { sourceId: "lost" } } } as ComponentNode,
    { id: "tags", type: "checkboxes", configuration: { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } } as ComponentNode
  ];
  const picks = (): Record<string, unknown> => ({ ...answers(), color: "green", town: "Nowhere", free: "Anywhere", gone: "x", tags: { a: true, z: true } });

  it("a hit equals a miss and no cache byte for byte: snapshot present, absent, and answersFree", () => {
    const form = richForm("opt", choices());
    const snapshots: Array<Record<string, unknown> | undefined> = [
      undefined,
      {},
      { towns: [{ value: "Paris", label: "Paris" }] },
      { towns: [{ value: "Nowhere" }], lost: [] }
    ];
    const cache = kernelCreatePreparedCache(16, 4_000_000);
    let refusals = 0;
    for (const [index, optionSnapshot] of snapshots.entries()) {
      const context = { ...contextOf({ form, values: picks() }), ...(optionSnapshot !== undefined ? { optionSnapshot } : {}) };
      const run = (kept?: KernelPreparedCache): string =>
        kernelStableStringify(runKernel(JSON.parse(JSON.stringify(context)), [], {}, signatures, kept));
      const bare = run();
      const miss = run(cache);
      const hit = run(cache);
      expect(miss, `snapshot ${String(index)} miss`).toBe(bare);
      expect(hit, `snapshot ${String(index)} hit`).toBe(bare);
      const codes = (JSON.parse(bare) as { errors: Array<{ code: string }> }).errors.map((error) => error.code);
      refusals += codes.filter((code) => code.startsWith("option.")).length;
    }
    expect(refusals).toBeGreaterThan(4);
    // One definition, four snapshots: the questions are the definition's, whatever the snapshot.
    expect(cache.entries.length).toBe(1);
    expect(cache.hits).toBeGreaterThanOrEqual(7);
  });

  it("builds the questions once per cached definition, not once per run", () => {
    const form = richForm("once", choices());
    const cache = kernelCreatePreparedCache(16, 4_000_000);
    const text = JSON.stringify(contextOf({ form, values: picks() }));
    runKernel(JSON.parse(text), [], {}, signatures, cache);
    const entry = cache.entries[0] as unknown as { prepared: KernelPrepared };
    const first = entry.prepared.derived["optionQuestions"];
    expect(first).toBeDefined();
    runKernel(JSON.parse(text), [], {}, signatures, cache);
    expect(entry.prepared.derived["optionQuestions"]).toBe(first);
  });
});

// the verdict on a field pattern is worked out once per prepared definition.
describe("the risky-pattern verdict is remembered with the prepared definition", () => {
  it("fills the riskyPatterns slot on the first run and answers the same on the next", () => {
    const form = {
      id: "form",
      type: "form",
      configuration: { formulaErrors: "fail" },
      children: { content: [{ id: "t", type: "text", configuration: { pattern: "^(a+)+$" } }, { id: "u", type: "text", configuration: { pattern: "^[a-z]+$" } }] }
    } as unknown as ComponentNode;
    const cache = kernelCreatePreparedCache(4, 1_000_000);
    const run = (values: Record<string, unknown>) => runKernel({ formId: "p", locale: "en", values, form } as never, [], {}, signatures, cache);
    const first = run({ t: "aaa!", u: "abc" });
    const slot = cache.entries[0]?.prepared.derived.riskyPatterns as Record<string, boolean> | undefined;
    expect(slot).toEqual({ "^(a+)+$": true, "^[a-z]+$": false });
    const second = run({ t: "aaa!", u: "abc" });
    expect(JSON.stringify(second.errors)).toBe(JSON.stringify(first.errors));
    expect(first.errors.map((error) => error.componentId)).toEqual(["t"]);
  });
});
