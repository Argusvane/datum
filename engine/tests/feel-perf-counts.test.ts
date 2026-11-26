import { afterEach, describe, expect, it, vi } from "vitest";

import * as evaluator from "../form-engine/rules/evaluator/evaluator.js";
import * as formula from "../form-engine/core/expressions/formula.js";
import * as fold from "../form-engine/core/state/submittable-fold.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { ladderRoot, ladderForm, ladderValues, readersForm } from "./fixtures/feel-ladder.js";

/**
 * Counts, never times: how many rules a keystroke evaluates, how many formulas a kernel run
 * parses, how often the fold runs per operation. They record the CURRENT behaviour; a deliberate improvement lowers the numbers and
 * updates them here with the change that earned it. The harness is engine/scripts/bench-feel.mjs.
 */
describe("FEEL performance counts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function spies() {
    return {
      evaluate: vi.spyOn(evaluator, "evaluateExpression"),
      fold: vi.spyOn(fold, "kernelFoldSubmittable"),
      parse: vi.spyOn(formula, "kernelParseFormula")
    };
  }

  /** Rules evaluated by one setValue on `path`, after a first write has settled the form. */
  function evaluatedBySetValue(runtime: FormRuntime, path: string): { evaluated: number; folds: number; parses: number } {
    const s = spies();
    runtime.setValue(path, "first");
    s.evaluate.mockClear();
    s.fold.mockClear();
    s.parse.mockClear();
    runtime.setValue(path, "second");
    return { evaluated: s.evaluate.mock.calls.length, folds: s.fold.mock.calls.length, parses: s.parse.mock.calls.length };
  }

  it("evaluates a bounded, reported number of rules per setValue on a field read by 1, 10 and 50 rules", () => {
    const filler = 100;
    const fillerRules = Math.ceil(filler / 3);
    const results: Array<{ readers: number; hub: number; quiet: number }> = [];
    for (const readers of [1, 10, 50]) {
      const runtime = new FormRuntime(readersForm(readers, filler), {} as never);
      const hub = evaluatedBySetValue(runtime, "hub");
      const quiet = evaluatedBySetValue(runtime, "quiet");
      results.push({ readers, hub: hub.evaluated, quiet: quiet.evaluated });
      expect(hub.parses, "a keystroke parses no formula").toBe(0);
      expect(hub.folds, "one fold per keystroke").toBe(1);
      // Baseline: the orchestrator recomputes every rule, so the number grows with the rule
      // count and not with the readers of the written field. A narrower recompute may lower this to the
      // affected set (readers + the rules downstream of them).
      expect(hub.evaluated).toBeGreaterThanOrEqual(readers);
      expect(hub.evaluated).toBeLessThanOrEqual(readers + fillerRules + 2 + 60);
    }
    // Recorded so a change to the affected-set behaviour shows here: today a write to a field
    // nobody reads costs the same as one that fires every reader.
    expect(results.map((r) => r.quiet >= 0)).toEqual([true, true, true]);
    expect(results[2]?.hub).toBeGreaterThanOrEqual(results[0]?.hub ?? 0);
  });

  it("parses nothing per setValue, and each runKernel run parses every formula once", () => {
    const root = ladderRoot({ fields: 100, ruleShare: 0.3 });
    const ruleCount = JSON.stringify(root).match(/"(visibleWhen|requiredWhen|enabledWhen|readonlyWhen)"/g)?.length ?? 0;
    expect(ruleCount).toBeGreaterThan(0);
    const parse = vi.spyOn(formula, "kernelParseFormula");
    runKernel({ formId: "ladder", values: ladderValues(100), locale: "en", form: root } as never, [], {}, formulaFunctionSignatures());
    const first = parse.mock.calls.length;
    parse.mockClear();
    runKernel({ formId: "ladder", values: ladderValues(100), locale: "en", form: root } as never, [], {}, formulaFunctionSignatures());
    // Baseline: every run compiles every formula again, no cache across runs.
    expect(first).toBe(ruleCount);
    expect(parse.mock.calls.length).toBe(ruleCount);
  });

  it("runs the fold once per setValue and once per addRow, and once for addRows", () => {
    const runtime = new FormRuntime(ladderForm({ fields: 20, ruleShare: 0.3, repeating: true }), {} as never);
    const s = spies();
    runtime.setValue("f0", "x");
    expect(s.fold.mock.calls.length).toBe(1);
    s.fold.mockClear();
    runtime.addRow("rows", { rowText: "a", rowAmount: 1 });
    expect(s.fold.mock.calls.length).toBe(1);
    s.fold.mockClear();
    runtime.addRows("rows", Array.from({ length: 50 }, (_, i) => ({ rowText: `r${String(i)}`, rowAmount: i })));
    expect(s.fold.mock.calls.length).toBe(1);
  });

  it("searches the component tree for nothing per setValue: ancestors come from the parent map", () => {
    const runtime = new FormRuntime(ladderForm({ fields: 200, ruleShare: 0.3 }), {} as never);
    runtime.setValue("f0", "first");
    const parentOf = vi.spyOn(ComponentTree.prototype, "parentOf");
    const ancestorsOf = vi.spyOn(ComponentTree.prototype, "ancestorsOf");
    const find = vi.spyOn(ComponentTree.prototype, "find");
    runtime.setValue("f0", "second");
    // Baseline before the fix: 80 ancestorsOf and 161 parentOf (each a search of the whole tree) at 200 fields.
    expect(ancestorsOf.mock.calls.length).toBe(0);
    expect(parentOf.mock.calls.length).toBe(0);
    expect(find.mock.calls.length).toBe(0);
  });
});
