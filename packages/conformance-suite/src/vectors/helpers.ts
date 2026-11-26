import type { Applic, Fixture, Vector } from "./schema.js";
import type { Expectation } from "../predicates.js";

export const BASE_FIXTURE: Fixture = { definition: "base" };

export const RUNS: Applic = {};

/** Where the repository's existing tests for a vector live (relative to the checkout root). */
export const TESTS = {
  parity: "packages/quickjs-wasm-host/tests/quickjs-kernel-parity.test.ts",
  isolation: "packages/quickjs-wasm-host/tests/quickjs-sandbox-isolation.test.ts",
  inspect: "packages/quickjs-wasm-host/tests/sandbox-inspect.test.ts",
  quickjsKernel: "packages/quickjs-wasm-host/tests/quickjs-kernel-limits.test.ts",
  kernelLimits: "engine/tests/kernel-limits-and-secrecy.test.ts",
  portableKernel: "engine/tests/portable-kernel.test.ts",
  inspectEngine: "engine/tests/inspect.test.ts"
} as const;

export const accepted = (value: boolean): Expectation => ({ op: "accepted", value });
export const all = (...of: Expectation[]): Expectation => ({ op: "all", of });
export const any = (...of: Expectation[]): Expectation => ({ op: "any", of });

/** A vector's declaration with the defaults a typical program-side vector has. */
export function vector(v: Omit<Vector, "limits" | "applies" | "fixture" | "gate"> & Partial<Pick<Vector, "limits" | "applies" | "fixture" | "gate">>): Vector {
  return {
    limits: {},
    applies: { program: RUNS, endpoint: false, parity: false },
    fixture: BASE_FIXTURE,
    gate: { status: "enforced" },
    ...v
  };
}
