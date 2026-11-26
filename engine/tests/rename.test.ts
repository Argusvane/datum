import { describe, expect, it } from "vitest";

import type { Expression, RuleObject } from "../form-engine/core/expressions/expression.js";
import {
  formulaMentionsField,
  formulaReadsField,
  pathNamesField,
  renameFormulaPath,
  renameInRuleSource,
  renamePathsInFormula,
  unparsedFormulaNaming
} from "../form-engine/builder/formula/rename.js";

describe("renameFormulaPath", () => {
  it("renames the field segment in every form a rule reads it", () => {
    expect(renameFormulaPath("amount", "amount", "total")).toBe("total");
    expect(renameFormulaPath("address.city", "address", "home")).toBe("home.city");
    expect(renameFormulaPath("row.amount", "amount", "total")).toBe("row.total");
    expect(renameFormulaPath("ancestor.amount.sub", "amount", "total")).toBe("ancestor.total.sub");
  });

  it("leaves other fields, host and component paths alone", () => {
    expect(renameFormulaPath("amounts", "amount", "total")).toBe("amounts");
    expect(renameFormulaPath("host.amount", "amount", "total")).toBe("host.amount");
    expect(renameFormulaPath("component.amount", "amount", "total")).toBe("component.amount");
    expect(renameFormulaPath("x.amount", "amount", "total")).toBe("x.amount");
    expect(renameFormulaPath("amount", "", "total")).toBe("amount");
    expect(renameFormulaPath("amount", "amount", "amount")).toBe("amount");
  });
});

describe("renamePathsInFormula", () => {
  it("rewrites a bare path and keeps the author's spacing", () => {
    expect(renamePathsInFormula("amount   >  10 and   not(empty( amount ))", "amount", "total")).toBe("total   >  10 and   not(empty( total ))");
  });

  it("rewrites dotted and scoped paths", () => {
    expect(renamePathsInFormula("address.city = row.address.city", "address", "home")).toBe("home.city = row.home.city");
  });

  it("rewrites a backticked path, dropping the backticks when the new id can go bare", () => {
    expect(renamePathsInFormula("`my field` = 1", "my field", "myField")).toBe("myField = 1");
    expect(renamePathsInFormula("`my field` = 1 or ` my field ` = 2", "my field", "my other field")).toBe("`my other field` = 1 or `my other field` = 2");
  });

  it("backticks a new id the grammar cannot take bare", () => {
    expect(renamePathsInFormula("amount > 0", "amount", "2nd amount")).toBe("`2nd amount` > 0");
    expect(renamePathsInFormula("amount > 0", "amount", "if")).toBe("`if` > 0");
  });

  it("rewrites inside an in list, a between and an if ladder", () => {
    expect(renamePathsInFormula('s in ("a", s, "b") and s between 1 and 2', "s", "status")).toBe('status in ("a", status, "b") and status between 1 and 2');
    expect(renamePathsInFormula("if s = 1 then s\nelse if t then 2 else s", "s", "status")).toBe("if status = 1 then status\nelse if t then 2 else status");
  });

  it("never touches a string that only looks like the id", () => {
    expect(renamePathsInFormula('label = "amount" and amount > 0', "amount", "total")).toBe('label = "amount" and total > 0');
  });

  it("returns a formula that does not parse as it is", () => {
    expect(renamePathsInFormula("amount > ", "amount", "total")).toBe("amount > ");
    expect(renamePathsInFormula("", "amount", "total")).toBe("");
  });

  it("reaches a formula that calls a function it was not told about", () => {
    expect(renamePathsInFormula("customFn(amount, 2) > other(amount)", "amount", "total")).toBe("customFn(total, 2) > other(total)");
    const signatures = [{ name: "customFn", min: 2, max: 2 }];
    expect(renamePathsInFormula("customFn(amount, 2)", "amount", "total", signatures)).toBe("customFn(total, 2)");
    // A real arity error is not an unknown function: the text stays as it is.
    expect(renamePathsInFormula("customFn(amount)", "amount", "total", signatures)).toBe("customFn(amount)");
  });

  it("returns the same text when nothing names the field", () => {
    const text = "other > 1";
    expect(renamePathsInFormula(text, "amount", "total")).toBe(text);
  });
});

describe("renameInRuleSource", () => {
  it("renames a string rule", () => {
    expect(renameInRuleSource("amount > 1", "amount", "total")).toBe("total > 1");
  });

  it("renames a tree along the changed branches only and returns the same reference when nothing changed", () => {
    const tree: Expression = {
      kind: "logical",
      operator: "and",
      left: { kind: "binary", operator: "gt", left: { kind: "path", path: "amount" }, right: { kind: "literal", value: 1 } },
      right: { kind: "path", path: "other" }
    };
    const renamed = renameInRuleSource(tree, "amount", "total");
    expect(renamed).toEqual({
      kind: "logical",
      operator: "and",
      left: { kind: "binary", operator: "gt", left: { kind: "path", path: "total" }, right: { kind: "literal", value: 1 } },
      right: { kind: "path", path: "other" }
    });
    expect(renamed).not.toBe(tree);
    expect((renamed as { right: unknown }).right).toBe(tree.right);
    expect(tree.left.kind === "binary" && tree.left.left.kind === "path" ? tree.left.left.path : "").toBe("amount");
    expect(renameInRuleSource(tree, "missing", "x")).toBe(tree);
  });

  it("renames an if tree through every branch", () => {
    const tree: Expression = {
      kind: "if",
      cases: [{ when: { kind: "path", path: "amount" }, then: { kind: "path", path: "row.amount" } }],
      else: { kind: "path", path: "amount.sub" }
    };
    expect(renameInRuleSource(tree, "amount", "total")).toEqual({
      kind: "if",
      cases: [{ when: { kind: "path", path: "total" }, then: { kind: "path", path: "row.total" } }],
      else: { kind: "path", path: "total.sub" }
    });
  });

  it("renames both halves of the object form and keeps the run scope", () => {
    const rule: RuleObject = { formula: "amount > 1", expression: { kind: "path", path: "amount" }, run: "server" };
    expect(renameInRuleSource(rule, "amount", "total")).toEqual({ formula: "total > 1", expression: { kind: "path", path: "total" }, run: "server" });
    const untouched: RuleObject = { formula: "other > 1", run: "both" };
    expect(renameInRuleSource(untouched, "amount", "total")).toBe(untouched);
  });

  it("passes other shapes through", () => {
    expect(renameInRuleSource(42, "a", "b")).toBe(42);
    expect(renameInRuleSource(undefined, "a", "b")).toBeUndefined();
    expect(renameInRuleSource(null, "a", "b")).toBeNull();
  });
});

describe("what a rename can tell about a rule (the controller's follow-up)", () => {
  it("knows which paths name a field, in every form a rule reads it", () => {
    expect(pathNamesField("amount", "amount")).toBe(true);
    expect(pathNamesField("amount.city", "amount")).toBe(true);
    expect(pathNamesField("row.amount", "amount")).toBe(true);
    expect(pathNamesField("ancestor.amount.sub", "amount")).toBe(true);
    expect(pathNamesField("amounts", "amount")).toBe(false);
    expect(pathNamesField("host.amount", "amount")).toBe(false);
    expect(pathNamesField("amount", "")).toBe(false);
  });

  it("knows whether a formula reads a field, through a plugin call too, and not through a string", () => {
    expect(formulaReadsField("amount > 1", "amount")).toBe(true);
    expect(formulaReadsField("customFn(`my id`)", "my id")).toBe(true);
    expect(formulaReadsField('other = "amount"', "amount")).toBe(false);
    expect(formulaReadsField("amount > ", "amount")).toBe(false);
    expect(formulaReadsField("", "amount")).toBe(false);
  });

  it("spots the id spelled as a word in text that does not parse", () => {
    expect(formulaMentionsField("amount > ", "amount")).toBe(true);
    expect(formulaMentionsField("`my id` > ", "my id")).toBe(true);
    expect(formulaMentionsField("amounts > ", "amount")).toBe(false);
    expect(formulaMentionsField("x.amount > ", "amount")).toBe(true);
    expect(formulaMentionsField("total_amount > ", "amount")).toBe(false);
  });

  it("names the unparsed formula of a rule that spells the field, and nothing else", () => {
    expect(unparsedFormulaNaming("amount > ", "amount")).toBe("amount > ");
    expect(unparsedFormulaNaming({ formula: "amount > ", run: "server" }, "amount")).toBe("amount > ");
    expect(unparsedFormulaNaming("amount > 1", "amount")).toBeUndefined();
    expect(unparsedFormulaNaming("other > ", "amount")).toBeUndefined();
    expect(unparsedFormulaNaming({ kind: "path", path: "amount" }, "amount")).toBeUndefined();
    expect(unparsedFormulaNaming(undefined, "amount")).toBeUndefined();
  });
});
