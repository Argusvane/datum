import type { ValidationContext, ValidationResult } from "../../core/schema/contracts.js";

/**
 * A runtime that can execute deterministic validation vectors. The parity harness runs the
 * same vectors through every adapter and diffs the results.
 */
export interface DeterministicRuntimeAdapter {
  id: "browser" | "wasm" | "server" | (string & {});
  run(context: ValidationContext): ValidationResult | Promise<ValidationResult>;
}
