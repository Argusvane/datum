import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JsonWasmAbi, WASM_ABI_VERSION, type WasmValidatorInstance } from "@argusvane/datum-engine";

import { f1Flat, f2Fields, f3Journey, f9DeepProblems, f10LongPaths } from "../scripts/bench-check-fixtures.js";
import { QuickJsWasmHostAdapter } from "../src/index.js";
import { SLOW_FACTOR } from "./slow-machine.js";

/**
 * A regression alarm for the `check` op's cost in the real program, not a
 * benchmark: each limit is about ten times the warm time measured on the development machine
 * (`scripts/bench-check.ts`: the 4,000-field form 0.08 s, the 10,000-component journey 0.12 s,
 * the 12,000-component flat form 1.4 s), under the default scaled budget a
 * host gets (250 ms plus 1 ms per KB of request).
 */

describe("check stays cheap in the sandbox", () => {
  let instance: WasmValidatorInstance;

  beforeAll(async () => {
    instance = await new QuickJsWasmHostAdapter({ maxEvalMs: 10_000 }).instantiate([], new JsonWasmAbi());
  });
  afterAll(() => {
    instance.dispose?.();
  });

  const ask = async (definition: unknown): Promise<{ ms: number; answer: { ok: boolean; verdict?: string; structure?: Array<{ code: string }> } }> => {
    const text = JSON.stringify({ abi: WASM_ABI_VERSION, op: "check", definition });
    const start = performance.now();
    const raw = await instance.inspect!(text);
    return { ms: performance.now() - start, answer: JSON.parse(raw) };
  };

  it("the 4,000-field form with rules is checked well inside a second", async () => {
    const { ms, answer } = await ask(f2Fields());
    expect(answer).toMatchObject({ ok: true, verdict: "ok", structure: [] });
    expect(ms).toBeLessThan(1000 * SLOW_FACTOR);
  }, 30_000);

  it("10,000 components with 1,000 pages and 64 routes are checked well inside two seconds", async () => {
    const { ms, answer } = await ask(f3Journey());
    expect(answer).toMatchObject({ ok: true, structure: [] });
    expect(ms).toBeLessThan(2000 * SLOW_FACTOR);
  }, 30_000);

  // Problems at depth 32 were interrupted (a path built per problem, past the cap).
  it.each(["duplicate", "invalid"] as const)("a form at depth 32 with a %s id on every field is answered with the capped problem list, not an interruption", async (kind) => {
    const { ms, answer } = await ask(f9DeepProblems(kind));
    expect(answer).toMatchObject({ ok: true, verdict: "fail" });
    expect(answer.structure!.length).toBe(201);
    expect(answer.structure![200]).toMatchObject({ code: "definition.problemsTruncated" });
    expect(ms).toBeLessThan(2500 * SLOW_FACTOR);
  }, 30_000);

  it("1,000 sections with 500-character dotted paths hit the paths cap instead of the time budget", async () => {
    const { ms, answer } = await ask(f10LongPaths());
    expect(answer).toMatchObject({ ok: true, verdict: "fail", structure: [{ code: "definition.paths.tooLong" }] });
    expect(ms).toBeLessThan(2500 * SLOW_FACTOR);
  }, 30_000);

  it("a definition past the component cap (12,000 flat components) is answered by the size gate, within the budget it is given", async () => {
    const { ms, answer } = await ask(f1Flat(12_000));
    expect(answer).toMatchObject({ ok: true, verdict: "fail", structure: [{ code: "definition.tooManyComponents" }] });
    expect(ms).toBeLessThan(2500 * SLOW_FACTOR);
  }, 30_000);
});
