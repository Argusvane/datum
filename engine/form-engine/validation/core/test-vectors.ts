import type { ValidationContext, ValidationResult } from "../../core/schema/contracts.js";

export interface DeterministicValidationVector {
  id: string;
  context: ValidationContext;
  expectedErrors: ValidationResult["errors"];
}

export interface VectorRunMismatch {
  vectorId: string;
  reason: string;
  expected: ValidationResult["errors"];
  actual: ValidationResult["errors"];
}

export interface VectorRunReport {
  passed: number;
  failed: number;
  mismatches: VectorRunMismatch[];
}

export function stableErrorSignature(error: ValidationResult["errors"][number]): string {
  const sortedParams = error.parameters
    ? Object.keys(error.parameters)
        .sort()
        .map((key) => `${key}:${String(error.parameters?.[key])}`)
        .join(",")
    : "";

  // Convert structured errors into stable comparable signatures so vector
  // checks are order-independent and environment-independent.
  return [
    error.code,
    error.componentId ?? "",
    error.path ?? "",
    error.stage,
    error.source,
    error.severity ?? "error",
    sortedParams
  ].join("|");
}

export function normalizeErrors(errors: ValidationResult["errors"]): string[] {
  // Sorting signatures ensures deterministic equality checks even when
  // validators emit equivalent errors in different orders.
  return errors.map(stableErrorSignature).sort();
}

export function runDeterministicVectors(
  vectors: DeterministicValidationVector[],
  runner: (context: ValidationContext) => ValidationResult
): VectorRunReport {
  const mismatches: VectorRunMismatch[] = [];

  for (const vector of vectors) {
    const actual = runner(vector.context);
    const expectedSig = normalizeErrors(vector.expectedErrors);
    const actualSig = normalizeErrors(actual.errors);

    if (JSON.stringify(expectedSig) !== JSON.stringify(actualSig)) {
      mismatches.push({
        vectorId: vector.id,
        reason: "Deterministic validation output mismatch",
        expected: vector.expectedErrors,
        actual: actual.errors
      });
    }
  }

  return {
    passed: vectors.length - mismatches.length,
    failed: mismatches.length,
    mismatches
  };
}
