import type { ValidationContext, ValidationResult } from "../../core/schema/contracts.js";
import { normalizeErrors } from "../core/test-vectors.js";
import type { DeterministicRuntimeAdapter } from "./runtime-adapter.js";

export interface ParityVector {
  id: string;
  context: ValidationContext;
}

export interface ParityMismatch {
  vectorId: string;
  /** adapter id -> normalized error signature list */
  signatures: Record<string, string[]>;
}

export interface ParityReport {
  checked: number;
  matched: number;
  mismatches: ParityMismatch[];
}

/**
 * Runs every vector through every adapter and diffs the normalized error signatures.
 * A vector passes only when all adapters produce an identical signature list.
 */
export async function runParity(
  vectors: ParityVector[],
  adapters: DeterministicRuntimeAdapter[]
): Promise<ParityReport> {
  const mismatches: ParityMismatch[] = [];

  for (const vector of vectors) {
    const signatures: Record<string, string[]> = {};
    for (const adapter of adapters) {
      const result: ValidationResult = await adapter.run(vector.context);
      signatures[adapter.id] = normalizeErrors(result.errors);
    }

    const reference = JSON.stringify(Object.values(signatures)[0] ?? []);
    const allMatch = Object.values(signatures).every(
      (signature) => JSON.stringify(signature) === reference
    );
    if (!allMatch) {
      mismatches.push({ vectorId: vector.id, signatures });
    }
  }

  return {
    checked: vectors.length,
    matched: vectors.length - mismatches.length,
    mismatches
  };
}
