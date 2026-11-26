export interface PerformanceBudgetGate {
  name: string;
  observedMs: number;
  budgetMs: number;
}

export interface SecurityGateSet {
  wasmSandboxIsolation: boolean;
  pluginFailureIsolation: boolean;
}

/** The PDF determinism check: one request rendered twice must give one byte sequence. */
export interface PdfDeterminismGate {
  /** `false` when no PDF provider was wired: the gate passes as not applicable. */
  applicable: boolean;
  passed: boolean;
  providerId?: string;
}

export interface ReleaseGateInput {
  deterministicVectorParityPassed: boolean;
  performanceBudgets: PerformanceBudgetGate[];
  security: SecurityGateSet;
  pdfRenderDeterminism?: PdfDeterminismGate;
}

export interface ReleaseGateResult {
  name: string;
  passed: boolean;
  reason?: string;
}

export interface ReleaseGateReport {
  passed: boolean;
  checks: ReleaseGateResult[];
}

function gate(name: string, passed: boolean, failReason: string): ReleaseGateResult {
  return passed ? { name, passed } : { name, passed, reason: failReason };
}

export function evaluateReleaseGates(input: ReleaseGateInput): ReleaseGateReport {
  const checks: ReleaseGateResult[] = [];

  checks.push(
    gate(
      "deterministic-vector-parity",
      input.deterministicVectorParityPassed,
      "Deterministic validation vectors are not in parity across runtimes"
    )
  );

  for (const budget of input.performanceBudgets) {
    checks.push(
      gate(
        `performance:${budget.name}`,
        budget.observedMs <= budget.budgetMs,
        `Observed ${budget.observedMs}ms exceeds budget ${budget.budgetMs}ms`
      )
    );
  }

  checks.push(
    gate(
      "security:wasm-sandbox-isolation",
      input.security.wasmSandboxIsolation,
      "WASM sandbox isolation check failed"
    )
  );

  checks.push(
    gate(
      "security:plugin-failure-isolation",
      input.security.pluginFailureIsolation,
      "Plugin failure isolation check failed"
    )
  );

  const pdf = input.pdfRenderDeterminism;
  checks.push(
    gate(
      "pdf-render-determinism",
      !pdf || !pdf.applicable || pdf.passed,
      `PDF provider ${pdf?.providerId ?? "?"} rendered one request into two different byte sequences`
    )
  );

  return {
    passed: checks.every((check) => check.passed),
    checks
  };
}
