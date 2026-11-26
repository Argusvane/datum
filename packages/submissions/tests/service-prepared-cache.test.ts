import { afterAll, describe, expect, it, vi } from "vitest";

// A passthrough spy: records the cache createKernelValidator hands runKernel, to read its counters.
// buildSandboxProgram writes `runKernel.name` into the program as the function to call, so the spy
// keeps the original's name: Vitest 5 names a mock "Mock", which the sandbox does not define.
vi.mock("@argusvane/datum-engine", async (original) => {
  const engine = await original<typeof import("@argusvane/datum-engine")>();
  const spy = vi.fn(engine.runKernel);
  Object.defineProperty(spy, "name", { value: engine.runKernel.name });
  return { ...engine, runKernel: spy };
});

import { runKernel, type KernelPreparedCache } from "@argusvane/datum-engine";
import type { CanonicalSubmission, ComponentNode, FormDefinition } from "@argusvane/datum-engine";
import { buildSandboxProgram } from "@argusvane/datum-quickjs-wasm-host";
import { ladderRoot, ladderValues } from "@argusvane/datum-engine/tests/fixtures/feel-ladder";

import { sandboxProgramHost } from "./fixtures/sandbox-host.js";
import { InMemorySubmissionStore, createKernelValidator, createProgramHostValidator, createSubmissionService, type SubmissionValidator } from "../src/index.js";

/**
 * The prepared-definition cache at the server: the service sends the sandbox the compiled
 * copy it registered, the same text every time, so the sandbox's cache finds the definition it
 * prepared for the first judgement. The service passes nothing extra and the verdicts are the
 * ones it always gave, in `validate` and `receive`, whether the sandbox remembers the definition
 * or not.
 */

function definitionOf(index: number): FormDefinition {
  const root: ComponentNode = ladderRoot({
    fields: 10,
    ruleShare: 0.4,
    repeating: true,
    extra: [{ id: "total", type: "number", configuration: {}, rules: { value: "f1 + 1" } } as ComponentNode]
  });
  root.id = "form";
  return { id: `cache-form-${String(index)}`, version: "1", schemaVersion: "1", root };
}

function envelopeOf(definition: FormDefinition, values: Record<string, unknown>): CanonicalSubmission {
  return {
    versionContext: { form: { id: definition.id, version: definition.version }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" } },
    submission: { locale: "en", values }
  };
}

const answers: Record<string, unknown> = { ...ladderValues(10), total: 99, "rows[0].rowText": "a", "rows[0].rowAmount": 5, stray: "x" };

// The cache is a closure local; this test reads it through the test-only view.
const quickJsPromise = sandboxProgramHost(buildSandboxProgram({ exposePrepared: true }));

afterAll(async () => {
  (await quickJsPromise).dispose();
});

async function cacheStats(): Promise<{ entries: number; hits: number; misses: number }> {
  const host = await quickJsPromise;
  const handle = host.evaluateHandle("JSON.stringify({ entries: __datum_prepared.entries.length, hits: __datum_prepared.hits, misses: __datum_prepared.misses })");
  try {
    return JSON.parse(host.vm.dump(handle) as string) as { entries: number; hits: number; misses: number };
  } finally {
    handle.dispose();
  }
}

async function serviceFor(validator: SubmissionValidator) {
  const store = new InMemorySubmissionStore();
  let n = 0;
  return createSubmissionService({ store, validator, ids: () => `rec-${String(++n)}` });
}

describe("SubmissionService over a sandbox that remembers prepared definitions", () => {
  it("judges the same registered form alike every time, and the sandbox finds it prepared after the first", async () => {
    const before = await cacheStats();
    const definition = definitionOf(0);
    const service = await serviceFor(createProgramHostValidator(await quickJsPromise));
    await service.register(definition);
    const kernel = await serviceFor(createKernelValidator());
    await kernel.register(definition);
    const document = envelopeOf(definition, answers);
    const first = await service.validate({ document });
    expect(await kernel.validate({ document })).toEqual(first);
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await service.validate({ document }), `pass ${String(pass)}`).toEqual(first);
    }
    const received = await service.receive({ submissionKey: crypto.randomUUID(), document });
    const receivedAgain = await service.receive({ submissionKey: crypto.randomUUID(), document });
    expect(receivedAgain.record.status).toBe(received.record.status);
    expect(receivedAgain.record.values).toEqual(received.record.values);
    expect(receivedAgain.errors).toEqual(received.errors);
    const after = await cacheStats();
    expect(after.misses - before.misses).toBe(1);
    expect(after.hits - before.hits).toBe(5);
  });

  it("judges more registered forms than the sandbox remembers, each one rightly, in turn and again", async () => {
    const service = await serviceFor(createProgramHostValidator(await quickJsPromise));
    const kernel = await serviceFor(createKernelValidator());
    const definitions = Array.from({ length: 20 }, (_, index) => definitionOf(index + 1));
    // Each has the same tree under another id: the compiled copy differs by `form` id only if the id differs, so vary a label.
    definitions.forEach((definition, index) => {
      const content = (definition.root.children?.content ?? []) as ComponentNode[];
      (content[0] as ComponentNode).configuration = { label: `field ${String(index)}` };
    });
    for (const definition of definitions) {
      await service.register(definition);
      await kernel.register(definition);
    }
    for (let pass = 0; pass < 2; pass += 1) {
      for (const definition of definitions) {
        const document = envelopeOf(definition, answers);
        expect(await service.validate({ document }), `${definition.id} pass ${String(pass)}`).toEqual(await kernel.validate({ document }));
      }
    }
    expect((await cacheStats()).entries).toBeLessThanOrEqual(16);
  });

  it("the in-process validator keeps one cache per instance: the second judgement of a form is a hit", async () => {
    const definition = definitionOf(900);
    const validator = createKernelValidator();
    const service = await serviceFor(validator);
    await service.register(definition);
    const document = envelopeOf(definition, answers);
    vi.mocked(runKernel).mockClear();
    const first = await service.validate({ document });
    const second = await service.validate({ document });
    expect(second).toEqual(first);
    const calls = vi.mocked(runKernel).mock.calls;
    expect(calls.length).toBe(2);
    // Built-in signatures and a cache, the same cache both times.
    expect(Array.isArray(calls[0]?.[3]) && (calls[0]?.[3] as unknown[]).length).toBeGreaterThan(0);
    const cache = calls[0]?.[4] as KernelPreparedCache;
    expect(cache).toBeDefined();
    expect(calls[1]?.[4]).toBe(cache);
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(1);
    // Another validator has its own cache, and judges the same.
    const other = createKernelValidator();
    vi.mocked(runKernel).mockClear();
    const otherService = await serviceFor(other);
    await otherService.register(definition);
    expect(await otherService.validate({ document })).toEqual(first);
    expect(vi.mocked(runKernel).mock.calls[0]?.[4]).not.toBe(cache);
  });
});
