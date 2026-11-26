import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import { DependencyGraph } from "../form-engine/rules/dependencies/dependency-graph.js";

const path = (p: string): Expression => ({ kind: "path", path: p });

describe("DependencyGraph", () => {
  it("maps changed form paths to dependent components (direct + transitive)", () => {
    const graph = new DependencyGraph();
    // total = price * qty   (calculation)
    graph.registerRule(
      "total",
      { kind: "arithmetic", operator: "multiply", left: path("price"), right: path("qty") },
      true
    );
    // shippingVisible when total > 100
    graph.registerRule("shipping", {
      kind: "binary",
      operator: "gt",
      left: path("total"),
      right: { kind: "literal", value: 100 }
    });

    expect(graph.affectedBy(["price"]).sort()).toEqual(["shipping", "total"]);
    expect(graph.affectedBy(["qty"]).sort()).toEqual(["shipping", "total"]);
    expect(graph.affectedBy(["unrelated"])).toEqual([]);
  });

  it("ignores contextual (row/ancestor/component/host) scopes", () => {
    const graph = new DependencyGraph();
    graph.registerRule("field", {
      kind: "logical",
      operator: "and",
      left: path("row.status"),
      right: path("ancestor.section.mode")
    });
    expect(graph.affectedBy(["status"])).toEqual([]);
    expect(graph.dependenciesOf("field")).toEqual([]);
  });

  it("registers reads in an untaken if branch", () => {
    const graph = new DependencyGraph();
    graph.registerRule(
      "fee",
      {
        kind: "if",
        cases: [{ when: path("member"), then: { kind: "literal", value: 0 } }],
        else: path("standardFee")
      },
      true
    );

    expect(graph.affectedBy(["standardFee"])).toEqual(["fee"]);
    expect(graph.affectedBy(["member"])).toEqual(["fee"]);
  });

  it("detects calculation cycles", () => {
    const graph = new DependencyGraph();
    graph.registerRule("a", path("b"), true);
    graph.registerRule("b", path("a"), true);
    expect(graph.findCalculationCycle()).toBeDefined();
  });

  it("returns undefined when calculations are acyclic", () => {
    const graph = new DependencyGraph();
    graph.registerRule("a", path("input"), true);
    graph.registerRule("b", path("a"), true);
    expect(graph.findCalculationCycle()).toBeUndefined();
  });

  it("names the cycle, from where the walk entered it", () => {
    const graph = new DependencyGraph();
    graph.registerRule("x", path("a"), true);
    graph.registerRule("a", path("b"), true);
    graph.registerRule("b", path("c"), true);
    graph.registerRule("c", path("a"), true);
    expect(graph.findCalculationCycle()).toEqual(["a", "b", "c", "a"]);
    const self = new DependencyGraph();
    self.registerRule("s", { kind: "arithmetic", operator: "add", left: path("s"), right: { kind: "literal", value: 1 } }, true);
    expect(self.findCalculationCycle()).toEqual(["s", "s"]);
  });

  it("checks a chain of 20,000 calculations, with or without a cycle at its end, without recursing", () => {
    const graph = new DependencyGraph();
    for (let i = 0; i < 20000; i += 1) {
      graph.registerRule(`c${i}`, path(i === 0 ? "input" : `c${i - 1}`), true);
    }
    expect(graph.findCalculationCycle()).toBeUndefined();
    graph.registerRule("c0", path("c19999"), true);
    const cycle = graph.findCalculationCycle();
    expect(cycle).toHaveLength(20001);
    expect(cycle?.[0]).toBe(cycle?.[20000]);
  });
});
