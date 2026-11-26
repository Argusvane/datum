// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { lintFormula, scanFormula } from "../form-engine/builder/formula/formula-editor.js";
import { kernelRiskGuardParser } from "../form-engine/core/expressions/compile.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";

const signatures = formulaFunctionSignatures();
const guarded = kernelRiskGuardParser(kernelParseFormula, "refuse");
const risky = (text: string, riskyPatterns?: "refuse" | "allow") => {
  const parsed = kernelParseFormula(text, signatures);
  return lintFormula(text, scanFormula(text), parsed, {}, undefined, riskyPatterns).filter((problem) => problem.message.includes("(a+)+$"));
};

describe("the editor flags what the compile refuses as a risky pattern", () => {
  for (const text of [
    'matches(name, "(a+)+$")',
    'matches(name, ("(a+)+$"))',
    'matches(name, (("(a+)+$")))',
    'not(matches(name, "(a+)+$"))',
    'matches(name, "x") or matches(name, ("(a+)+$"))'
  ]) {
    it(`agrees with the compile on ${text}`, () => {
      expect(guarded(text, signatures).ok).toBe(false);
      expect(risky(text)).toHaveLength(1);
      expect(risky(text, "allow")).toEqual([]);
    });
  }
  it("underlines the pattern itself when the tokens do not show it, and stays silent for a safe one", () => {
    const text = 'matches(name, ("(a+)+$"))';
    const [found] = risky(text);
    expect(text.slice(found!.start, found!.end)).toBe('"(a+)+$"');
    expect(risky('matches(name, ("[A-Z]+"))')).toEqual([]);
    expect(guarded('matches(name, ("[A-Z]+"))', signatures).ok).toBe(true);
  });
  it("says nothing the compile does not refuse", () => {
    const text = 'matches(name, if true then "(a+)+$" else "x")';
    expect(guarded(text, signatures).ok).toBe(true);
    expect(risky(text)).toEqual([]);
  });
  it("flags once when the token scan already did", () => {
    expect(risky('matches(name, "(a+)+$")')).toHaveLength(1);
  });
  it("flags every risky pattern of a formula, once each", () => {
    const flagged = (text: string) => {
      const parsed = kernelParseFormula(text, signatures);
      return lintFormula(text, scanFormula(text), parsed, {}, undefined, "refuse").filter((problem) => /\([ab]\+\)\+\$/.test(problem.message));
    };
    const both = 'matches(a, "(a+)+$") and matches(b, ("(b+)+$"))';
    expect(flagged(both).map((problem) => both.slice(problem.start, problem.end))).toEqual(['"(a+)+$"', '"(b+)+$"']);
    const parenthesised = 'matches(a, ("(a+)+$")) or matches(b, ("(b+)+$"))';
    expect(flagged(parenthesised).map((problem) => parenthesised.slice(problem.start, problem.end))).toEqual(['"(a+)+$"', '"(b+)+$"']);
    const twice = 'matches(a, "(a+)+$") or matches(b, "(a+)+$")';
    expect(flagged(twice)).toHaveLength(2);
    const mixed = 'matches(a, "ok") and matches(b, ("(b+)+$"))';
    expect(flagged(mixed).map((problem) => mixed.slice(problem.start, problem.end))).toEqual(['"(b+)+$"']);
  });
});
