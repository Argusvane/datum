/**
 * Parity between the two sides: the browser runtime and the validation
 * kernel read one scenario text and must come to the same status on every line both judged. The
 * design exists to catch the day they do not, so the comparison is deliberately narrow: what a
 * side could not replay (a skip) is never a disagreement, and a line one side never reached is
 * not compared. Everything else that differs is a finding, never a row to allow.
 */
import type { FormTestScenarioResult, FormTestStepResult } from "@argusvane/datum-engine/form-tests";

import type { CompareSides, ScenarioStatusOf } from "./api.js";
import type { ParityLine, ParityReport, StepCell } from "./report/model.js";

function cellOf(step: FormTestStepResult | undefined): StepCell {
  if (step === undefined) {
    return null;
  }
  const cell: { status: FormTestStepResult["status"]; code?: string; actual?: unknown } = { status: step.status };
  if (step.code !== undefined) {
    cell.code = step.code;
  }
  if (step.actual !== undefined) {
    cell.actual = step.actual;
  }
  return cell;
}

/** The first step on a line: a statement is one line, so a line holds one step. */
function stepOnLine(result: FormTestScenarioResult, line: number): FormTestStepResult | undefined {
  return result.steps.find((step) => step.line === line);
}

/**
 * Compares the two results of one scenario. `one-sided` when either side skipped the scenario,
 * or when nothing at all could be compared because every shared line was a skip on a side;
 * `differ` when one side errored where the other ran, both errored for different reasons, or a
 * line both sides ran came to different statuses (or to errors with different codes); else `agree`.
 */
export const compareSides: CompareSides = (runtime, kernel): ParityReport => {
  if (runtime.status === "skipped" || kernel.status === "skipped") {
    return { status: "one-sided", lines: [] };
  }
  // One side errored where the other ran, or both errored and for different reasons: the same
  // status hides two different faults, which is the finding the design exists to surface.
  const reasonsDiffer = runtime.status === "error" && kernel.status === "error" && runtime.reason !== kernel.reason;
  if ((runtime.status === "error") !== (kernel.status === "error") || reasonsDiffer) {
    return {
      status: "differ",
      lines: [],
      scenario: {
        runtime: { status: runtime.status, ...(runtime.reason !== undefined ? { reason: runtime.reason } : {}) },
        kernel: { status: kernel.status, ...(kernel.reason !== undefined ? { reason: kernel.reason } : {}) }
      }
    };
  }

  const lineNumbers = [...new Set([...runtime.steps, ...kernel.steps].map((step) => step.line))].sort((left, right) => left - right);
  const lines: ParityLine[] = [];
  let compared = 0;
  let skippedLines = 0;
  for (const line of lineNumbers) {
    const left = stepOnLine(runtime, line);
    const right = stepOnLine(kernel, line);
    if (left === undefined || right === undefined) {
      // The other side stopped earlier (an action it refused, a start error): no counterpart.
      continue;
    }
    if (left.status === "skipped" || right.status === "skipped") {
      skippedLines += 1;
      continue;
    }
    compared += 1;
    // Two errors on one line are the same only when they carry the same code (`action.refused`
    // against `action.failed` is a disagreement, though both statuses read "error").
    if (left.status !== right.status || (left.status === "error" && left.code !== right.code)) {
      lines.push({ line, runtime: cellOf(left), kernel: cellOf(right) });
    }
  }
  if (lines.length > 0) {
    return { status: "differ", lines };
  }
  // A scenario whose every shared line was a skip on one side compared nothing: say so instead of
  // claiming agreement the sides never showed.
  if (compared === 0 && skippedLines > 0) {
    return { status: "one-sided", lines: [] };
  }
  return { status: "agree", lines: [] };
};

/**
 * The scenario's status over the sides that ran: `parity` first (a disagreement outranks either
 * side's own word), then `failed`, `error`, `passed`, else `skipped`. A single-side record is
 * read by the same order with no parity.
 */
export const scenarioStatusOf: ScenarioStatusOf = (sides, parity) => {
  if (parity?.status === "differ") {
    return "parity";
  }
  const statuses = [sides.runtime?.status, sides.kernel?.status];
  if (statuses.includes("failed")) {
    return "failed";
  }
  if (statuses.includes("error")) {
    return "error";
  }
  if (statuses.includes("passed")) {
    return "passed";
  }
  return "skipped";
};
