/**
 * Timing of the `check` op over the fixtures of `bench-check-fixtures.ts` (kernel structural
 * check). Not CI: `cd packages/quickjs-wasm-host && npx vite-node scripts/bench-check.ts`.
 * For each fixture: request bytes, JSON.parse, in-process `check`, QuickJS `check` (cold and warm),
 * answer bytes, verdict and the structure/problem counts (or the sandbox error).
 */
import os from "node:os";
import { FORMULA_FUNCTION_NAMES, InProcessWasmHostAdapter, JsonWasmAbi, WASM_ABI_VERSION } from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter } from "../src/index.js";
import { BENCH_FIXTURES } from "./bench-check-fixtures.js";

function ms(start: number): string {
  return (performance.now() - start).toFixed(0).padStart(6);
}

async function main(): Promise<void> {
  void FORMULA_FUNCTION_NAMES;
  const only = process.argv[2];
  const abi = new JsonWasmAbi();
  const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
  console.log(`ABI ${WASM_ABI_VERSION}; load average ${os.loadavg().map((load) => load.toFixed(1)).join(" ")}; warm = best of 5`);
  console.log("fixture".padEnd(36), "req MiB", "parse", " inproc", "  qjs-cold", " qjs-warm", "answer B", "verdict / note");
  for (const fixture of BENCH_FIXTURES) {
    if (only !== undefined && !fixture.name.startsWith(only)) {
      continue;
    }
    const text = JSON.stringify({ abi: WASM_ABI_VERSION, op: "check", definition: fixture.make() });
    const bytes = Buffer.byteLength(text);
    let t = performance.now();
    JSON.parse(text);
    const parse = ms(t);
    t = performance.now();
    let answer = "";
    let inproc = "";
    try {
      answer = await inProcess.inspect!(text);
      inproc = ms(t);
    } catch (error) {
      inproc = "ERR";
      answer = String(error);
    }
    let cold = "";
    let warm = "";
    let note = "";
    const quick = await new QuickJsWasmHostAdapter({ maxEvalMs: 5_000 }).instantiate([], abi);
    try {
      t = performance.now();
      const fromSandbox = await quick.inspect!(text);
      cold = ms(t);
      // Warm: the best of five, the machine being shared with other work.
      let best = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 5; round += 1) {
        t = performance.now();
        await quick.inspect!(text);
        best = Math.min(best, performance.now() - t);
      }
      warm = best.toFixed(0).padStart(6);
      if (fromSandbox !== answer) {
        note = " MISMATCH in-process vs QuickJS;";
      }
    } catch (error) {
      cold = "ERR";
      warm = "ERR";
      note = ` ${(error as Error).message.slice(0, 80)};`;
    } finally {
      quick.dispose?.();
    }
    let summary = "";
    try {
      const parsed = JSON.parse(answer) as { ok?: boolean; verdict?: string; structure?: unknown[]; problems?: unknown[]; error?: { code?: string } };
      summary = parsed.ok === true ? `${parsed.verdict} structure=${parsed.structure?.length ?? "-"} problems=${parsed.problems?.length ?? 0}` : `error ${parsed.error?.code}`;
    } catch {
      summary = "unparsable";
    }
    console.log(fixture.name.padEnd(36), (bytes / 1048576).toFixed(2).padStart(7), parse, inproc, cold.padStart(10), warm.padStart(9), String(Buffer.byteLength(answer)).padStart(8), summary + note);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
