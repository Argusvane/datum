import { describe, expect, it } from "vitest";
import { BuilderController, type BuilderChangeEvent } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { renameFormulaPath, renameInRuleSource, renamePathsInFormula, renameValuePathByMove } from "../form-engine/builder/formula/rename.js";

describe("rename leaves scope reads alone", () => {
  it("a field called host, row, ancestor or component is not what the scope words read", () => {
    expect(renamePathsInFormula('host.role = "a"', "host", "h2")).toBe('host.role = "a"');
    expect(renamePathsInFormula("row.amount > 1", "row", "r2")).toBe("row.amount > 1");
    expect(renamePathsInFormula("ancestor.total > 1", "ancestor", "z")).toBe("ancestor.total > 1");
    expect(renamePathsInFormula("component = 1", "component", "c2")).toBe("component = 1");
    expect(renamePathsInFormula("component.length > 1", "component", "c2")).toBe("component.length > 1");
    expect(renameFormulaPath("host.x", "host", "h")).toBe("host.x");
    expect(renameInRuleSource({ kind: "path", path: "ancestor.x" } as never, "ancestor", "z")).toEqual({ kind: "path", path: "ancestor.x" });
  });
  it("the entry and ancestor scopes still follow a rename of the field they read", () => {
    expect(renameFormulaPath("row.amount", "amount", "total")).toBe("row.total");
    expect(renameFormulaPath("ancestor.amount.currency", "amount", "total")).toBe("ancestor.total.currency");
    expect(renameFormulaPath("row.row", "row", "line")).toBe("row.line");
    expect(renamePathsInFormula("amount > 1 and row.amount > 2", "amount", "total")).toBe("total > 1 and row.total > 2");
  });
});

describe("a value path follows the move of the data", () => {
  it("keeps entry indexes, matches whole segments and leaves other data alone", () => {
    expect(renameFormulaPath("items[0].sku", "items", "lines")).toBe("lines[0].sku");
    expect(renameValuePathByMove("items[0].sku", { from: "items", to: "lines" })).toBe("lines[0].sku");
    expect(renameValuePathByMove("items[12].sku", { from: "items[].sku", to: "items[].code" })).toBe("items[12].code");
    expect(renameValuePathByMove("applicant.email", { from: "applicant.email", to: "applicant.mail" })).toBe("applicant.mail");
    expect(renameValuePathByMove("applicant.email.x", { from: "applicant", to: "person" })).toBe("person.email.x");
    expect(renameValuePathByMove("applicants.email", { from: "applicant", to: "person" })).toBe("applicants.email");
    expect(renameValuePathByMove("other.email", { from: "email", to: "mail" })).toBe("other.email");
    expect(renameValuePathByMove("items[0].sku", { from: "orders", to: "lines" })).toBe("items[0].sku");
    expect(renameValuePathByMove("a[0].b[3].c", { from: "a[].b", to: "a[].d" })).toBe("a[0].d[3].c");
  });
});

const DEFS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "container", version: "1.0.0", createDefault: () => ({ id: "container", type: "container", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() }
];
const root = (): ComponentNode => ({
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "applicant", type: "container", configuration: {}, children: { content: [{ id: "email", type: "text", configuration: { label: "e" } }, { id: "tagged", type: "text", configuration: { label: "t", dataKey: "custom" } }] } }
    ]
  }
});

describe("the rename announces where the data went", () => {
  const renamedOf = (c: BuilderController, from: string, to: string) => {
    let seen: BuilderChangeEvent["renamed"];
    c.on("change", (event: BuilderChangeEvent) => {
      seen ??= event.renamed;
    });
    c.renameId(from, to);
    return seen;
  };
  it("a field in a data container carries the move; a container renamed or a field with its own data key does not need to", () => {
    const field = renamedOf(new BuilderController({ initialRoot: root(), componentDefinitions: DEFS }), "email", "mail");
    expect(field?.dataPath).toEqual({ from: "applicant.email", to: "applicant.mail" });
    // The data path is the id itself: `from` and `to` already say it.
    const box = renamedOf(new BuilderController({ initialRoot: root(), componentDefinitions: DEFS }), "applicant", "person");
    expect(box).toMatchObject({ from: "applicant", to: "person" });
    expect(box?.dataPath).toBeUndefined();
    const keyed = renamedOf(new BuilderController({ initialRoot: root(), componentDefinitions: DEFS }), "tagged", "renamedTag");
    expect(keyed?.from).toBe("tagged");
    expect(keyed?.dataPath).toBeUndefined();
  });
});
