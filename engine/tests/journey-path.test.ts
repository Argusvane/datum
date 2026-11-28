import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { normalizeDataGrids } from "../form-engine/core/schema/data-grid.js";
import type { Journey, JourneyPage, JourneyPageEntry, PresentationNode, PresentationReference } from "../form-engine/core/schema/journey.js";
import type { JourneyOwnership, JourneyTrace } from "../form-engine/core/journey/journey-types.js";
import {
  JOURNEY_PATH_FUNCTIONS,
  journeyFormKeys,
  journeyEntryPlacesForm,
  journeyFrontier,
  journeyOwnNodeRule,
  journeyOwnNodeUsable,
  journeyOwnership,
  journeyPageOfComponent,
  journeyPagesOfKey,
  journeyPath,
  journeyPlacements,
  journeyReachable,
  journeyRuleTree,
  journeyStaticGraph,
  journeyTargetUsable
} from "../form-engine/core/journey/journey-path.js";
import { journeyCollectionPathOf, journeyHoldsOwnAnswer } from "../form-engine/core/journey/journey-shared.js";
import { kernelFoldHoldsOwnAnswer } from "../form-engine/core/state/submittable-fold.js";
import { isValidComponentId } from "../form-engine/core/tree/component-id.js";
import { evaluateExpression } from "../form-engine/rules/evaluator/evaluator.js";
import { kernelIsDataScopeContainer, kernelKnownKeyShapes, kernelTreeIndex } from "../form-engine/validation/wasm/portable-kernel.js";
import { applyJourney, presentationRoot, publicVariant } from "./fixtures/presentation-form.js";

function field(id: string, type = "text"): ComponentNode {
  return { id, type, configuration: { label: id } };
}

function group(id: string, type: string, children: ComponentNode[], extra: Partial<ComponentNode> = {}): ComponentNode {
  return { id, type, configuration: { label: id }, children: { content: children }, ...extra };
}

function eq(path: string, value: string | number | boolean | null): Expression {
  return { kind: "binary", operator: "eq", left: { kind: "path", path }, right: { kind: "literal", value } };
}

const evaluate = (expression: Expression, values: Record<string, unknown>): unknown =>
  evaluateExpression(expression, { values });

/** Five questions, q1..q5, one per page p1..p5, and `u` on no page. */
const flat: ComponentNode = group("form", "form", [field("q1"), field("q2"), field("q3"), field("q4"), field("q5"), field("u")]);

function fivePages(overrides: Record<string, Partial<JourneyPage>> = {}): Journey {
  return {
    id: "flow",
    pages: [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, components: [`q${n}`], ...overrides[`p${n}`] }))
  };
}

function walk(journey: Journey, values: Record<string, unknown> = {}): JourneyTrace {
  const ownership = journeyOwnership(flat, journey);
  return journeyPath(journey, { values, ownership, evaluate });
}

describe("journeyOwnership", () => {
  const tree = group("form", "form", [
    field("intro", "html"),
    field("name"),
    group("pets", "fieldset", [field("pet", "select"), field("dog_name")]),
    group("address", "container", [field("street"), field("city")]),
    field("extra")
  ]);
  const journey: Journey = {
    id: "apply",
    pages: [
      { id: "about", components: ["name", "intro"] },
      { id: "animals", components: ["pets"] },
      { id: "where", components: ["street", "name"] },
      { id: "odd", components: ["ghost", "form", "street", "street"] }
    ]
  };
  const ownership = journeyOwnership(tree, journey);

  it("lists every node in document order, root first", () => {
    expect(ownership.rootId).toBe("form");
    expect(ownership.order).toEqual(["form", "intro", "name", "pets", "pet", "dog_name", "address", "street", "city", "extra"]);
  });

  it("gives a listed component's whole subtree to its page", () => {
    expect(ownership.pagesOf.pets).toEqual(["animals"]);
    expect(ownership.pagesOf.pet).toEqual(["animals"]);
    expect(ownership.pagesOf.dog_name).toEqual(["animals"]);
  });

  it("lists a component on several pages in page order", () => {
    expect(ownership.pagesOf.name).toEqual(["about", "where"]);
    expect(ownership.pagesOf.street).toEqual(["where", "odd"]);
  });

  it("keeps a page's members in its order, once each, and only the form's components below the root", () => {
    expect(ownership.membersOf.about).toEqual(["name", "intro"]);
    expect(ownership.membersOf.odd).toEqual(["street"]);
    expect(ownership.pagesOf.ghost).toBeUndefined();
    expect(ownership.pagesOf.form).toBeUndefined();
  });

  it("marks the unlisted ancestors of listed components structural, and nothing else", () => {
    expect(ownership.structural.address).toBe(true);
    expect(ownership.structural.pets).toBeUndefined();
    expect(ownership.structural.city).toBeUndefined();
    expect(ownership.structural.extra).toBeUndefined();
    expect(ownership.pagesOf.city).toBeUndefined();
    expect(ownership.pagesOf.extra).toBeUndefined();
  });
});

describe("journeyRuleTree", () => {
  it("reads a tree, the object form's expression, and a formula string (compiled away before the walk) as no condition", () => {
    const tree = eq("q1", "far");
    expect(journeyRuleTree(tree)).toBe(tree);
    expect(journeyRuleTree({ expression: tree, run: "both" })).toBe(tree);
    expect(journeyRuleTree('q1 = "far"')).toBeUndefined();
    expect(journeyRuleTree({ formula: 'q1 = "far"' })).toBeUndefined();
    expect(journeyRuleTree(undefined)).toBeUndefined();
    expect(journeyRuleTree([tree])).toBeUndefined();
  });

  it("passes over a route whose when is still text: the condition does not hold", () => {
    const journey = fivePages({
      p1: { routes: [{ when: { expression: eq("q1", "far") }, to: "p4" }, { when: 'q1 = "far"', to: "p3" }] },
      p2: { routes: [{ when: 'q1 = "near"', to: "p4" }] }
    });
    const far = walk(journey, { q1: "far" });
    expect(far.pages).toEqual(["p1", "p4", "p5"]);
    const near = walk(journey, { q1: "near" });
    expect(near.pages).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(near.decisions[1]).toEqual({ kind: "next", pageId: "p2", to: "p3" });
  });
});

describe("journeyPath", () => {
  it("takes every page in order when nothing routes or skips", () => {
    const trace = walk(fivePages());
    expect(trace.pages).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(trace.end).toBe("end");
    expect(trace.decisions).toEqual([
      { kind: "next", pageId: "p1", to: "p2" },
      { kind: "next", pageId: "p2", to: "p3" },
      { kind: "next", pageId: "p3", to: "p4" },
      { kind: "next", pageId: "p4", to: "p5" },
      { kind: "next", pageId: "p5", to: "$end" }
    ]);
  });

  it("takes the first route that matches, and falls through when none does", () => {
    const journey = fivePages({
      p1: {
        routes: [
          { when: eq("q1", "far"), to: "p4" },
          { when: eq("q1", "far"), to: "p3" },
          { when: eq("q1", "near"), to: "p3" }
        ]
      }
    });
    const far = walk(journey, { q1: "far" });
    expect(far.pages).toEqual(["p1", "p4", "p5"]);
    expect(far.decisions[0]).toEqual({ kind: "route", pageId: "p1", routeIndex: 0, to: "p4" });

    const near = walk(journey, { q1: "near" });
    expect(near.pages).toEqual(["p1", "p3", "p4", "p5"]);
    expect(near.decisions[0]).toEqual({ kind: "route", pageId: "p1", routeIndex: 2, to: "p3" });

    const neither = walk(journey, { q1: "other" });
    expect(neither.pages).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(neither.decisions[0]).toEqual({ kind: "next", pageId: "p1", to: "p2" });
  });

  it("goes past a page by a route on the page before it, and never skips one on a condition", () => {
    const journey = fivePages({ p1: { routes: [{ when: eq("q1", "hide"), to: "p3" }] } });
    const hidden = walk(journey, { q1: "hide" });
    expect(hidden.pages).toEqual(["p1", "p3", "p4", "p5"]);
    expect(hidden.decisions).toContainEqual({ kind: "route", pageId: "p1", routeIndex: 0, to: "p3" });
    expect(walk(journey, { q1: "show" }).pages).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("ignores the routes of a page it passes over", () => {
    const routedPast = fivePages({ p1: { routes: [{ to: "p3" }] }, p2: { routes: [{ to: "$end" }] } });
    expect(walk(routedPast).pages).toEqual(["p1", "p3", "p4", "p5"]);

    // A page with nothing on it is still on the path, and its routes are tried.
    const blank: Journey = { id: "flow", pages: [{ id: "p1", components: ["q1"] }, { id: "p2", routes: [{ to: "$end" }] }, { id: "p3", components: ["q3"] }] };
    expect(walk(blank).pages).toEqual(["p1", "p2"]);
  });

  it("shows a condition only the answers of pages already on the path, and of components on no page", () => {
    // A later page's answer cannot steer an earlier decision...
    const later = fivePages({ p1: { routes: [{ when: eq("q4", "yes"), to: "p5" }, { when: eq("q3", "yes"), to: "p4" }] } });
    expect(walk(later, { q3: "yes", q4: "yes" }).pages).toEqual(["p1", "p2", "p3", "p4", "p5"]);

    // ...an answer left on a page the path skips reads as unanswered...
    const stale = fivePages({ p1: { routes: [{ when: eq("q1", "no"), to: "p3" }] }, p3: { routes: [{ when: eq("q2", "stale"), to: "p5" }] } });
    expect(walk(stale, { q1: "no", q2: "stale" }).pages).toEqual(["p1", "p3", "p4", "p5"]);
    expect(walk(stale, { q1: "yes", q2: "stale" }).pages).toEqual(["p1", "p2", "p3", "p5"]);

    // ...a route reads its own page's answers, and a component on no page is there from the start.
    const both = { kind: "logical", operator: "and", left: eq("u", "go"), right: eq("q1", "skip") } as Expression;
    const own = fivePages({ p1: { routes: [{ when: both, to: "p3" }] } });
    expect(walk(own, { u: "go", q1: "skip" }).pages).toEqual(["p1", "p3", "p4", "p5"]);
    expect(walk(own, { u: "stop", q1: "skip" }).pages).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("reveals an entry's value keys with the page that owns their section", () => {
    const tree = group("form", "form", [field("q1"), group("items", "repeatingSection", [field("sku")], { collection: {} }), field("q3")]);
    const journey: Journey = {
      id: "orders",
      pages: [
        { id: "p1", components: ["q1"], routes: [{ when: eq("items[0].sku", "A"), to: "p3" }] },
        { id: "p2", components: ["q3"] },
        { id: "p3", components: ["items"], routes: [{ when: eq("items[0].sku", "A"), to: "$end" }] },
        { id: "p4", components: ["q3"] }
      ]
    };
    const trace = journeyPath(journey, { values: { q1: "x", "items[0].sku": "A" }, ownership: journeyOwnership(tree, journey), evaluate });
    expect(trace.pages).toEqual(["p1", "p2", "p3"]);
    expect(trace.decisions).toContainEqual({ kind: "next", pageId: "p1", to: "p2" });
    expect(trace.decisions).toContainEqual({ kind: "route", pageId: "p3", routeIndex: 0, to: "$end" });
  });

  it("reveals an entry kept at the section's own collection path with the section's page, not before", () => {
    const tree = group("form", "form", [
      field("q1"),
      group("items", "repeatingSection", [field("sku")], { collection: { collectionPath: "order_lines" } }),
      group("order", "container", [group("order_items", "repeatingSection", [field("code")], { collection: { collectionPath: "order.items" } })]),
      field("q3")
    ]);
    const journey: Journey = {
      id: "orders",
      pages: [
        {
          id: "p1",
          components: ["q1"],
          routes: [{ when: { kind: "logical", operator: "or", left: eq("order_lines[0].sku", "A"), right: eq("order.items[0].code", "B") }, to: "p3" }]
        },
        { id: "p2", components: ["q3"] },
        { id: "p3", components: ["items", "order_items"] }
      ]
    };
    const ownership = journeyOwnership(tree, journey);
    expect({ ...ownership.collectionOwners }).toStrictEqual({ order_lines: "items", "order.items": "order_items" });
    // Neither entry is on no page: both wait for p3, so neither can steer p1's route.
    const trace = journeyPath(journey, { values: { q1: "x", "order_lines[0].sku": "A", "order.items[0].code": "B" }, ownership, evaluate });
    expect(trace.pages).toEqual(["p1", "p2", "p3"]);
    expect(trace.decisions).toContainEqual({ kind: "next", pageId: "p1", to: "p2" });
    expect(journeyPagesOfKey(ownership, "order_lines")).toEqual(["p3"]);
    expect(journeyPagesOfKey(ownership, "order.items[2].code")).toEqual(["p3"]);
  });

  it("reveals a component on several pages once any of them is on the path", () => {
    const tree = group("form", "form", [field("a"), field("b"), field("c")]);
    const journey: Journey = {
      id: "twice",
      pages: [
        { id: "first", components: ["a"], routes: [{ when: eq("a", "right"), to: "right" }] },
        { id: "left", components: ["b"] },
        { id: "right", components: ["b"], routes: [{ when: eq("b", "yes"), to: "end" }, { to: "$end" }] },
        { id: "end", components: ["c"] }
      ]
    };
    const ownership = journeyOwnership(tree, journey);
    expect(journeyPath(journey, { values: { a: "right", b: "yes" }, ownership, evaluate }).pages).toEqual(["first", "right", "end"]);
  });

  it("stops at an exit page", () => {
    const journey = fivePages({ p1: { routes: [{ when: eq("q1", "eligible"), to: "p3" }] }, p2: { kind: "exit" }, p4: { kind: "exit" } });
    const out = walk(journey, { q1: "ineligible" });
    expect(out.pages).toEqual(["p1", "p2"]);
    expect(out.end).toBe("exit");
    expect(out.decisions).toEqual([{ kind: "next", pageId: "p1", to: "p2" }]);

    const past = walk(journey, { q1: "eligible" });
    expect(past.pages).toEqual(["p1", "p3", "p4"]);
    expect(past.end).toBe("exit");
  });

  it("passes over routes that go back, to the page itself, or nowhere", () => {
    const journey = fivePages({
      p3: { routes: [{ to: "p1" }, { to: "p3" }, { to: "nowhere" }, { to: "p5" }] },
      p4: { routes: [{ to: "p2" }] }
    });
    const trace = walk(journey);
    expect(trace.pages).toEqual(["p1", "p2", "p3", "p5"]);
    expect(trace.decisions).toContainEqual({ kind: "route", pageId: "p3", routeIndex: 3, to: "p5" });

    const onlyBackward = fivePages({ p4: { routes: [{ to: "p2" }, { to: "gone" }] } });
    expect(walk(onlyBackward).pages).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("ends the journey on a route to $end", () => {
    const trace = walk(fivePages({ p2: { routes: [{ to: "$end" }] } }));
    expect(trace.pages).toEqual(["p1", "p2"]);
    expect(trace.end).toBe("end");
    expect(trace.decisions[1]).toEqual({ kind: "route", pageId: "p2", routeIndex: 0, to: "$end" });
  });

  it("shows every page it reaches, a page with nothing on it included: it never skips one", () => {
    const journey: Journey = {
      id: "flow",
      pages: [
        { id: "p1", components: ["q1"] },
        { id: "p2", components: ["q2", "q3"] },
        { id: "blank", components: ["ghost"] },
        { id: "none" },
        { id: "p4", components: ["q4"] },
        { id: "bye", kind: "exit" }
      ]
    };
    const trace = walk(journey);
    expect(trace.pages).toEqual(["p1", "p2", "blank", "none", "p4", "bye"]);
    expect(trace.decisions).toEqual([
      { kind: "next", pageId: "p1", to: "p2" },
      { kind: "next", pageId: "p2", to: "blank" },
      { kind: "next", pageId: "blank", to: "none" },
      { kind: "next", pageId: "none", to: "p4" },
      { kind: "next", pageId: "p4", to: "bye" }
    ]);
    expect(trace.end).toBe("exit");
  });

  it("always ends, only ever moving forward, whatever the routes and answers", () => {
    // A small deterministic generator: journeys whose routes go anywhere, conditions that hold
    // at random, and a walk that must still visit strictly later pages and stop.
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 200; run += 1) {
      const count = 1 + Math.floor(random() * 8);
      const ids = Array.from({ length: count }, (_, n) => `p${n + 1}`);
      const journey: Journey = {
        id: "random",
        pages: ids.map((id, n) => ({
          id,
          components: [`q${(n % 5) + 1}`],
          ...(random() < 0.2 ? { kind: "exit" as const } : {}),
          routes: Array.from({ length: Math.floor(random() * 3) }, () => ({
            to: random() < 0.15 ? "$end" : ids[Math.floor(random() * count)] ?? "$end",
            ...(random() < 0.5 ? { when: { kind: "literal" as const, value: random() < 0.5 } } : {})
          }))
        }))
      };
      const trace = walk(journey);
      const positions = trace.pages.map((id) => ids.indexOf(id));
      expect(positions.every((position, n) => n === 0 || position > (positions[n - 1] as number))).toBe(true);
      expect(trace.pages.length).toBeLessThanOrEqual(count);
    }
  });
});

describe("journeyPlacements and journeyPageOfComponent", () => {
  it("places each component on, off or unassigned, leaving out the root and structural ancestors", () => {
    const tree = group("form", "form", [group("box", "container", [field("a")]), field("b"), field("c"), field("loose")]);
    const journey: Journey = {
      id: "flow",
      pages: [
        { id: "one", components: ["a"], routes: [{ to: "three" }] },
        { id: "two", components: ["b"] },
        { id: "three", components: ["c", "b"] }
      ]
    };
    const ownership = journeyOwnership(tree, journey);
    const trace = journeyPath(journey, { values: {}, ownership, evaluate });
    expect(trace.pages).toEqual(["one", "three"]);
    expect(journeyPlacements(ownership, trace)).toEqual({ a: "on", b: "on", c: "on", loose: "unassigned" });

    const onlyFirst: JourneyTrace = { pages: ["one"], end: "end", decisions: [] };
    expect(journeyPlacements(ownership, onlyFirst)).toEqual({ a: "on", b: "off", c: "off", loose: "unassigned" });
  });

  it("names the earliest page on the path holding each component", () => {
    const journey: Journey = {
      id: "flow",
      pages: [
        { id: "p1", components: ["q1", "q3"] },
        { id: "p2", components: ["q2"] },
        { id: "p3", components: ["q3"] }
      ]
    };
    const ownership = journeyOwnership(flat, journey);
    expect(journeyPageOfComponent(ownership, { pages: ["p1", "p2", "p3"], end: "end", decisions: [] })).toEqual({
      q1: "p1",
      q2: "p2",
      q3: "p1"
    });
    expect(journeyPageOfComponent(ownership, { pages: ["p2", "p3"], end: "end", decisions: [] })).toEqual({ q2: "p2", q3: "p3" });
  });
});

describe("journeyFrontier and journeyReachable", () => {
  const trace: JourneyTrace = { pages: ["a", "b", "c"], end: "end", decisions: [] };

  it("finds the first page not completed, else the last", () => {
    expect(journeyFrontier(trace, [])).toBe("a");
    expect(journeyFrontier(trace, ["a"])).toBe("b");
    expect(journeyFrontier(trace, ["b"])).toBe("a");
    expect(journeyFrontier(trace, ["a", "b", "c"])).toBe("c");
    expect(journeyFrontier(trace, ["a", "gone"])).toBe("b");
    expect(journeyFrontier({ pages: [], end: "end", decisions: [] }, [])).toBeUndefined();
  });

  it("reaches pages on the path at or before the frontier only", () => {
    expect(journeyReachable(trace, ["a"], "a")).toBe(true);
    expect(journeyReachable(trace, ["a"], "b")).toBe(true);
    expect(journeyReachable(trace, ["a"], "c")).toBe(false);
    expect(journeyReachable(trace, ["a", "b", "c"], "c")).toBe(true);
    expect(journeyReachable(trace, ["a", "b", "c"], "elsewhere")).toBe(false);
    expect(journeyReachable({ pages: [], end: "end", decisions: [] }, [], "a")).toBe(false);
  });
});

describe("journeyStaticGraph", () => {
  it("lists every forward way out of every page, conditions aside", () => {
    const journey = fivePages({
      p1: { routes: [{ when: eq("q1", "x"), to: "p3" }, { to: "p4" }, { to: "p5" }] },
      p2: { kind: "exit" },
      p3: { routes: [{ to: "p1" }, { to: "nowhere" }] },
      p4: { routes: [{ when: eq("q4", "done"), to: "$end" }] }
    });
    const graph = journeyStaticGraph(journey);
    expect(graph.pages).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(graph.edges).toEqual([
      { from: "p1", to: "p3", kind: "route", routeIndex: 0, conditional: true },
      { from: "p1", to: "p4", kind: "route", routeIndex: 1, conditional: false },
      { from: "p3", to: "p4", kind: "next", conditional: false },
      { from: "p4", to: "$end", kind: "route", routeIndex: 0, conditional: true },
      { from: "p4", to: "p5", kind: "next", conditional: false },
      { from: "p5", to: "$end", kind: "next", conditional: false }
    ]);
  });
});

describe("ids and keys named after Object.prototype members", () => {
  // Page ids, component ids and submitted keys come from authors and from submissions: one
  // called `constructor`, `toString` or `__proto__` is an id like any other, never an
  // inherited member of a record.
  it("ignores a page listing a component the form does not have, even one called toString", () => {
    const journey: Journey = { id: "flow", pages: [{ id: "p1", components: ["toString", "q1", "constructor"] }, { id: "p2", components: ["q2"] }] };
    const ownership = journeyOwnership(flat, journey);
    expect(ownership.membersOf.p1).toEqual(["q1"]);
    expect(Object.keys(ownership.pagesOf)).not.toContain("toString");
    expect(ownership.pagesOf.toString).toBeUndefined();
    expect(ownership.structural.constructor).toBeUndefined();
    const trace = journeyPath(journey, { values: { q1: "a" }, ownership, evaluate });
    expect(trace.pages).toEqual(["p1", "p2"]);
    const placements = journeyPlacements(ownership, trace);
    expect(Object.keys(placements)).toEqual(["q1", "q2", "q3", "q4", "q5", "u"]);
  });

  it("routes to, skips and places pages and components with those names", () => {
    const tree = group("form", "form", [field("valueOf"), field("toString"), field("constructor"), field("hasOwnProperty")]);
    const journey: Journey = {
      id: "flow",
      pages: [
        { id: "__proto__", components: ["valueOf"], routes: [{ when: eq("valueOf", "skip"), to: "constructor" }] },
        { id: "toString", components: ["toString"] },
        { id: "constructor", components: ["constructor"], routes: [{ to: "hasOwnProperty" }, { to: "valueOf" }] }
      ]
    };
    const ownership = journeyOwnership(tree, journey);
    expect(ownership.membersOf.__proto__).toEqual(["valueOf"]);
    expect(Object.keys(ownership.membersOf)).toEqual(["__proto__", "toString", "constructor"]);

    // Routes to pages the journey does not have — `hasOwnProperty`, `valueOf` — are passed over.
    const skipped = journeyPath(journey, { values: { valueOf: "skip", hasOwnProperty: "h" }, ownership, evaluate });
    expect(skipped.pages).toEqual(["__proto__", "constructor"]);
    expect(skipped.decisions).toEqual([
      { kind: "route", pageId: "__proto__", routeIndex: 0, to: "constructor" },
      { kind: "next", pageId: "constructor", to: "$end" }
    ]);
    const placements = journeyPlacements(ownership, skipped);
    expect({ ...placements }).toEqual({ valueOf: "on", toString: "off", constructor: "on", hasOwnProperty: "unassigned" });
    expect({ ...journeyPageOfComponent(ownership, skipped) }).toEqual({ valueOf: "__proto__", constructor: "constructor" });
    expect(journeyReachable(skipped, ["__proto__"], "constructor")).toBe(true);
    expect(journeyStaticGraph(journey).edges.filter((edge) => edge.from === "constructor")).toEqual([
      { from: "constructor", to: "$end", kind: "next", conditional: false }
    ]);

    expect(journeyPath(journey, { values: { valueOf: "stay" }, ownership, evaluate }).pages).toEqual(["__proto__", "toString", "constructor"]);
  });

  it("gives a condition an unanswered constructor as undefined, and a submitted __proto__ key as an answer", () => {
    const tree = group("form", "form", [field("constructor"), field("q2")]);
    const journey: Journey = {
      id: "flow",
      pages: [
        { id: "p1", components: ["constructor"], routes: [{ when: { kind: "unary", operator: "not", operand: { kind: "path", path: "constructor" } }, to: "p2" }] },
        { id: "p2", components: ["q2"], routes: [{ when: eq("__proto__", "x"), to: "$end" }] },
        { id: "p3", components: ["q2"] }
      ]
    };
    const ownership = journeyOwnership(tree, journey);
    const values = JSON.parse('{"__proto__": "x"}') as Record<string, unknown>;
    const trace = journeyPath(journey, { values, ownership, evaluate });
    expect(trace.pages).toEqual(["p1", "p2"]);
    expect(trace.decisions).toEqual([
      { kind: "route", pageId: "p1", routeIndex: 0, to: "p2" },
      { kind: "route", pageId: "p2", routeIndex: 0, to: "$end" }
    ]);
  });

  it("reads an ownership that crossed a JSON boundary, where its records have Object.prototype again", () => {
    const tree = group("form", "form", [field("q1"), field("constructor"), field("toString")]);
    const journey: Journey = { id: "flow", pages: [{ id: "p1", components: ["q1"], routes: [{ when: eq("q1", "no"), to: "$end" }] }, { id: "p2", components: ["toString"] }] };
    const ownership = JSON.parse(JSON.stringify(journeyOwnership(tree, journey))) as ReturnType<typeof journeyOwnership>;
    const trace = journeyPath(journey, { values: { q1: "no", constructor: "c" }, ownership, evaluate });
    expect(trace.pages).toEqual(["p1"]);
    expect({ ...journeyPlacements(ownership, trace) }).toEqual({ q1: "on", constructor: "unassigned", toString: "off" });
  });
});

describe("JOURNEY_PATH_FUNCTIONS", () => {
  it("lists every exported function of the path engine and of the shared helpers it calls, each a top-level declaration", async () => {
    const path = (await import("../form-engine/core/journey/journey-path.js")) as Record<string, unknown>;
    const shared = (await import("../form-engine/core/journey/journey-shared.js")) as Record<string, unknown>;
    const exported = [...Object.entries(path), ...Object.entries(shared)]
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(JOURNEY_PATH_FUNCTIONS.map((fn) => fn.name).sort()).toEqual(exported);
    for (const fn of JOURNEY_PATH_FUNCTIONS) {
      expect(fn.toString().startsWith(`function ${fn.name}(`)).toBe(true);
    }
  });
});

// --- Presentations: nodes a page owns, and what they place ------------------------

/** A form with every kind of node the usability rules tell apart. */
const presentationTree: ComponentNode = group("form", "form", [
  field("email"),
  field("name"),
  group("money", "fieldset", [field("annual_income", "number")]),
  field("approved_amount", "number"),
  group("address", "container", [field("street"), field("city")]),
  group("items", "repeatingSection", [field("sku")], { collection: {} }),
  { id: "orders_grid", type: "dataGrid", configuration: {}, collection: { collectionPath: "orders" }, children: { content: [field("grid_cell")] } },
  { ...field("total", "number"), rules: { value: { kind: "literal", value: 1 } } },
  field("logo", "image"),
  field("send", "button"),
  group("visual", "container", [field("loose")], { configuration: { label: "visual", scopeData: false } })
]);

function ownField(id: string, configuration: Record<string, unknown> = {}, type = "text"): PresentationNode {
  return { id, type, configuration };
}

function alias(id: string, fills: string, type = "text"): PresentationNode {
  return { id, type, configuration: { fills } };
}

function workedOut(id: string, to: string): PresentationNode {
  return { id, type: "journey-value", configuration: { to, value: { kind: "path", path: "m1" } } };
}

function ref(componentId: string): PresentationReference {
  return { type: "journey-field", configuration: { componentId } };
}

function box(id: string, children: Array<PresentationNode | PresentationReference>, type = "fieldset"): PresentationNode {
  return { id, type, children: { content: children } };
}

/** A presentation over {@link presentationTree}: one page per list of entries, `p1`, `p2`, … */
function presentation(...pages: JourneyPageEntry[][]): Journey {
  return { id: "own", pages: pages.map((components, index) => ({ id: `p${index + 1}`, components })) };
}

function owned(...pages: JourneyPageEntry[][]): JourneyOwnership {
  return journeyOwnership(presentationTree, presentation(...pages));
}

/** A record with no prototype as an ordinary object, for a strict comparison with a literal. */
const plain = <T,>(record: Record<string, T> | undefined): Record<string, T> => ({ ...(record ?? {}) });

/** No form keys: rule I has nothing to meet. */
const NO_KEYS = Object.create(null) as Record<string, true>;

describe("presentations: rule A — an own node's id", () => {
  it("uses an own entry whose id is on the grammar, not a form component's, and new to the presentation", () => {
    const ownership = owned([ownField("own_1"), ownField("Own-2"), ownField("a")]);
    expect(ownership.membersOf.p1).toEqual(["own_1", "Own-2", "a"]);
    expect(plain(ownership.ownNodes)).toEqual({ own_1: true, "Own-2": true, a: true });
    expect(plain(ownership.pagesOf)).toEqual({ own_1: ["p1"], "Own-2": ["p1"], a: ["p1"] });
  });

  it("drops an entry whose id is off the grammar, a form component's, or the root's", () => {
    for (const id of ["9lives", "has space", "a.b", "@own", "own[0]", "_x", "-x", "é", "form", "email", "money", "orders_grid"]) {
      const ownership = owned([ownField(id), ownField("kept")]);
      expect(ownership.membersOf.p1, id).toEqual(["kept"]);
      expect(plain(ownership.ownNodes), id).toEqual({ kept: true });
      // Nothing of the form is placed by an entry that is dropped: `email` stays on no page.
      expect(Object.keys(ownership.pagesOf), id).toEqual(["kept"]);
    }
    // An id that is not text at all (the shape check refuses it; the rule does not crash on it).
    expect(owned([{ id: 7, type: "text" } as unknown as PresentationNode]).membersOf.p1).toEqual([]);
  });

  it("drops an entry that repeats an earlier own id — on the page, on a later page, or inside itself — and keeps the first", () => {
    const ownership = owned([ownField("twice", { label: "first" }), ownField("twice", { label: "again" })], [ownField("twice"), box("later", [ownField("twice")]), ownField("fresh")]);
    expect(ownership.membersOf.p1).toEqual(["twice"]);
    expect(ownership.membersOf.p2).toEqual(["fresh"]);
    expect(plain(ownership.pagesOf)).toEqual({ twice: ["p1"], fresh: ["p2"] });
    expect(owned([box("outer", [ownField("dup"), ownField("dup")])]).membersOf.p1).toEqual([]);
    expect(owned([box("outer", [ownField("outer")])]).membersOf.p1).toEqual([]);
  });

  it("gives an id to the first node that carries it, even one in an entry that is dropped", () => {
    // `broken` is dropped (a file, rule B); `inner` inside it is still the first `inner`.
    const ownership = owned([box("broken", [ownField("inner"), ownField("upload", {}, "file")]), ownField("inner"), ownField("broken"), ownField("after")]);
    expect(ownership.membersOf.p1).toEqual(["after"]);
    expect(plain(ownership.ownNodes)).toEqual({ after: true });
  });

  it("never reads a reference's id: it is no node of the presentation's own", () => {
    const named = (id: string): PresentationReference => ({ ...ref("email"), id });
    const ownership = owned([box("contact", [named("email"), named("contact"), { ...ref("name"), id: "9 lives" }]), ownField("note")]);
    expect(ownership.membersOf.p1).toEqual(["contact", "note"]);
    expect(plain(ownership.pagesOf)).toEqual({ contact: ["p1"], email: ["p1"], name: ["p1"], note: ["p1"] });
    expect(plain(ownership.ownNodes)).toEqual({ contact: true, note: true });
  });

  it("reads the grammar as the component-id grammar does", () => {
    for (const id of ["a", "A1", "own_1", "own-1", "9a", "", " ", "a b", "a.b", "a[0]", "@a", "_a", "-a", "é", "constructor", "__proto__", "toString"]) {
      const verdict = journeyOwnNodeRule(ownField(id), Object.create(null) as Record<string, unknown>, Object.create(null) as Record<string, true>, "own", NO_KEYS);
      expect(verdict === "", id).toBe(isValidComponentId(id));
    }
  });

  it("says which rule a node breaks first, and records its id either way", () => {
    const formIds = kernelTreeIndex(presentationTree).nodeById;
    const seen = Object.create(null) as Record<string, true>;
    expect(journeyOwnNodeRule(ownField("fine"), formIds, seen, "own", NO_KEYS)).toBe("");
    expect(journeyOwnNodeRule(ownField("fine"), formIds, seen, "own", NO_KEYS)).toBe("A");
    expect(journeyOwnNodeRule(ownField("email"), formIds, seen, "own", NO_KEYS)).toBe("A");
    expect(journeyOwnNodeRule(ownField("upload", {}, "file"), formIds, seen, "own", NO_KEYS)).toBe("B");
    expect(journeyOwnNodeRule(ownField("keyed", { dataKey: "k" }), formIds, seen, "own", NO_KEYS)).toBe("C");
    // A broken id is reported before anything else about the node.
    expect(journeyOwnNodeRule(ownField("upload", {}, "file"), formIds, seen, "own", NO_KEYS)).toBe("A");
    expect(Object.keys(seen)).toEqual(["fine", "email", "upload", "keyed"]);
    // Asked entry by entry in the presentation's order, with one `seen`, it is what the ownership decided.
    const replay = Object.create(null) as Record<string, true>;
    const entries = [ownField("a"), box("b", [ownField("a")]), ownField("c"), ownField("b")];
    expect(entries.map((entry) => journeyOwnNodeUsable(entry, formIds, replay, "own", journeyFormKeys(presentationTree)))).toEqual([true, false, true, false]);
    expect(owned(entries).membersOf.p1).toEqual(["a", "c"]);
  });
});

describe("presentations: rule B — types a presentation cannot hold", () => {
  it("drops the whole entry for a repeating section, a data grid, a file, a signature, a steps container or a step, anywhere in it", () => {
    for (const type of ["repeatingSection", "dataGrid", "file", "signature", "steps", "step", "wizard", "wizardStep"]) {
      expect(owned([ownField("alone", {}, type), ownField("kept")]).membersOf.p1, type).toEqual(["kept"]);
      const nested = owned([box("outer", [ref("email"), alias("work_email", "name"), box("inner", [ownField("deep", {}, type)])]), ownField("kept")]);
      expect(nested.membersOf.p1, type).toEqual(["kept"]);
      // What the entry referenced and filled is not placed either.
      expect(plain(nested.pagesOf), type).toEqual({ kept: ["p1"] });
      expect(plain(nested.aliasOf), type).toEqual({});
    }
  });

  it("uses fields, texts, buttons and layouts", () => {
    const types = ["text", "number", "checkbox", "select", "textarea", "date", "radio", "checkboxes", "html", "image", "button", "custom-widget"];
    const ownership = owned(types.map((type, index) => ownField(`own_${index}`, {}, type)), [box("fs", [box("cols", [box("g", [], "grid")], "columns")]), box("tabs", [box("tab", [], "tab")], "tabs"), box("panel", [], "panel")]);
    expect(ownership.membersOf.p1).toEqual(types.map((_type, index) => `own_${index}`));
    expect(ownership.membersOf.p2).toEqual(["fs", "tabs", "panel"]);
    expect(Object.keys(plain(ownership.ownNodes))).toEqual([...types.map((_type, index) => `own_${index}`), "fs", "cols", "g", "tabs", "tab", "panel"]);
  });
});

describe("presentations: rule C — no data binding of its own", () => {
  it("drops an entry holding a collection, a data key or a data-scoping container", () => {
    const bound: PresentationNode[] = [
      { ...ownField("rows"), collection: { itemFields: [] } } as PresentationNode,
      ownField("keyed", { dataKey: "k" }),
      ownField("keyed_empty", { dataKey: "" }),
      ownField("keyed_null", { dataKey: null }),
      box("scope", [ownField("inside")], "container"),
      { id: "scope_bare", type: "container" },
      { id: "scope_true", type: "container", configuration: { scopeData: true } }
    ];
    for (const node of bound) {
      expect(owned([node, ownField("kept")]).membersOf.p1, node.id).toEqual(["kept"]);
      expect(owned([box("outer", [ref("email"), node]), ownField("kept")]).membersOf.p1, node.id).toEqual(["kept"]);
    }
  });

  it("uses a container that says it scopes no data, and reads a key holding undefined as absent", () => {
    const ownership = owned([{ id: "visual_box", type: "container", configuration: { scopeData: false }, children: { content: [ref("email")] } }, ownField("sparse", { dataKey: undefined })]);
    expect(ownership.membersOf.p1).toEqual(["visual_box", "sparse"]);
    expect(ownership.pagesOf.email).toEqual(["p1"]);
  });

  it("reads a data-scoping container as the kernel does", () => {
    const formIds = Object.create(null) as Record<string, unknown>;
    for (const configuration of [undefined, null, {}, { scopeData: false }, { scopeData: true }, { scopeData: "false" }, { scopeData: 0 }, [], "scope"]) {
      for (const type of ["container", "fieldset", "text"]) {
        const node = { id: "candidate", type, configuration } as unknown as PresentationNode;
        const verdict = journeyOwnNodeRule(node, formIds, Object.create(null) as Record<string, true>, "own", NO_KEYS);
        expect(verdict === "C", `${type} ${JSON.stringify(configuration)}`).toBe(kernelIsDataScopeContainer(node as unknown as ComponentNode));
      }
    }
  });
});

describe("presentations: rule D — a reference names a form component", () => {
  it("puts the component it names, with its subtree, on the page", () => {
    const ownership = owned([box("contact", [ref("email"), ref("address")], "columns")]);
    expect(ownership.membersOf.p1).toEqual(["contact"]);
    expect(plain(ownership.pagesOf)).toEqual({ contact: ["p1"], email: ["p1"], address: ["p1"], city: ["p1"], street: ["p1"] });
    // Placed like a listed component: nothing above it is folded for being on no page.
    expect(ownership.structural.form).toBe(true);
  });

  it("skips a reference to a component the form does not have, or to the root, by itself", () => {
    const ownership = owned([box("contact", [ref("ghost"), ref("form"), ref("name"), ref("toString")])]);
    expect(ownership.membersOf.p1).toEqual(["contact"]);
    expect(plain(ownership.pagesOf)).toEqual({ contact: ["p1"], name: ["p1"] });
    // A reference holding nothing usable: the shape check would refuse it; the placement skips it.
    const bare = { type: "journey-field" } as unknown as PresentationReference;
    expect(plain(owned([box("contact", [bare, ref("name")])]).pagesOf)).toEqual({ contact: ["p1"], name: ["p1"] });
  });

  it("reads a reference at the top of a page as the component's id written as a string", () => {
    const asReferences = owned([ref("email"), ref("address"), ref("email"), ref("ghost"), ref("form")], [ref("name")]);
    const asStrings = owned(["email", "address", "email", "ghost", "form"], ["name"]);
    expect(asReferences.membersOf).toEqual(asStrings.membersOf);
    expect(asReferences.pagesOf).toEqual(asStrings.pagesOf);
    expect(asReferences.structural).toEqual(asStrings.structural);
    // Only the records of a presentation tell them apart: an object entry brings them, empty here.
    expect(plain(asReferences.ownNodes)).toEqual({});
    expect(asStrings.ownNodes).toBeUndefined();
  });
});

describe("presentations: rule E — a target is a value leaf of the form", () => {
  const index = kernelTreeIndex(presentationTree);
  const usable = (id: string): boolean => journeyTargetUsable(id, index.nodeById, index.parentOf, presentationTree.id);

  it("takes a field that holds an answer of its own, in a fieldset or a container alike", () => {
    for (const id of ["email", "name", "annual_income", "approved_amount", "street", "loose"]) {
      expect(usable(id), id).toBe(true);
    }
  });

  it("takes no group, section, grid, container or valueless component, nothing inside a section or a grid, nothing calculated, nothing unknown", () => {
    for (const id of ["form", "money", "address", "visual", "items", "sku", "orders_grid", "grid_cell", "total", "logo", "send", "ghost", "constructor", "__proto__", ""]) {
      expect(usable(id), id).toBe(false);
    }
    // A hand-written null rules block is no rule.
    const loose = group("form", "form", [{ ...field("free"), rules: null } as unknown as ComponentNode, { ...field("ruled"), rules: { value: null } } as unknown as ComponentNode]);
    const looseIndex = kernelTreeIndex(loose);
    expect(journeyTargetUsable("free", looseIndex.nodeById, looseIndex.parentOf, "form")).toBe(true);
    expect(journeyTargetUsable("ruled", looseIndex.nodeById, looseIndex.parentOf, "form")).toBe(true);
  });

  it("makes an alias of an unusable target a plain own field, and ignores a worked-out value of one", () => {
    for (const target of ["money", "address", "items", "sku", "orders_grid", "total", "logo", "ghost", "form"]) {
      const ownership = owned([alias("filling", target), workedOut("working", target), ownField("kept")]);
      // The alias stays, as a field of the presentation's own; the worked-out value is not drawn.
      expect(ownership.membersOf.p1, target).toEqual(["filling", "kept"]);
      expect(plain(ownership.aliasOf), target).toEqual({});
      expect(plain(ownership.workedOutOf), target).toEqual({});
      expect(plain(ownership.ownNodes), target).toEqual({ filling: true, kept: true });
      expect(plain(ownership.pagesOf), target).toEqual({ filling: ["p1"], kept: ["p1"] });
    }
    const usableOnes = owned([alias("filling", "street"), workedOut("working", "annual_income")]);
    expect(plain(usableOnes.aliasOf)).toEqual({ filling: "street" });
    expect(plain(usableOnes.workedOutOf)).toEqual({ working: "annual_income" });
  });

  it("holds its copy of the fold's reading of an own answer to the fold's", () => {
    const groupTypes = ["form", "fieldset", "panel", "grid", "tabs", "tab", "steps", "step", "repeatingSection", "dataGrid", "container"];
    const valueless = ["button", "html", "image", "signature"];
    const fields = ["text", "number", "select", "radio", "checkbox", "checkboxes", "file", "date", "textarea", "custom-widget", "journey-value", "journey-field"];
    const nodes: ComponentNode[] = [
      ...groupTypes.map((type): ComponentNode => ({ id: `group-${type}`, type, configuration: {} })),
      { id: "visual", type: "container", configuration: { scopeData: false } },
      { id: "withChildren", type: "custom-group", configuration: {}, children: { content: [] } },
      { id: "emptyChildren", type: "text", configuration: {}, children: {} },
      { id: "items", type: "text", configuration: {}, collection: { itemFields: [] } },
      { id: "rows", type: "dataGrid", configuration: {}, collection: { collectionPath: "rows" }, children: { content: [] } },
      ...valueless.map((type): ComponentNode => ({ id: type, type, configuration: {} })),
      ...fields.map((type): ComponentNode => ({ id: type, type, configuration: {} }))
    ];
    for (const node of nodes) {
      expect(journeyHoldsOwnAnswer(node), node.id).toBe(kernelFoldHoldsOwnAnswer(node));
    }
    expect(nodes.filter(journeyHoldsOwnAnswer).map((node) => node.id)).toEqual(fields);
  });
});

describe("presentations: rule F — an alias holds a value itself", () => {
  it("fills from a field, never from a text, a button, a layout or a worked-out value", () => {
    const ownership = owned([
      alias("text_alias", "email"),
      alias("number_alias", "annual_income", "number"),
      alias("paragraph", "name", "html"),
      alias("picture", "name", "image"),
      alias("press", "name", "button"),
      alias("childless_layout", "name", "fieldset"),
      { ...box("layout", [ownField("inside")]), configuration: { fills: "name" } },
      { id: "sum", type: "journey-value", configuration: { to: "approved_amount", value: { kind: "path", path: "m1" }, fills: "name" } }
    ]);
    expect(plain(ownership.aliasOf)).toEqual({ text_alias: "email", number_alias: "annual_income" });
    // `name` is filled by nothing: every `fills` on a node with no value of its own is ignored.
    expect(ownership.pagesOf.name).toBeUndefined();
    expect(plain(ownership.workedOutOf)).toEqual({ sum: "approved_amount" });
    expect(ownership.membersOf.p1).toEqual(["text_alias", "number_alias", "paragraph", "picture", "press", "childless_layout", "layout", "sum"]);
  });

  it("ignores a fills that is not text", () => {
    const ownership = owned([ownField("odd", { fills: 7 }), ownField("blank", { fills: "" }), ownField("none", { fills: null })]);
    expect(plain(ownership.aliasOf)).toEqual({});
    expect(ownership.membersOf.p1).toEqual(["odd", "blank", "none"]);
  });

  it("lets several aliases fill one field, each placing it on its own page", () => {
    const ownership = owned([alias("home_email", "email")], [alias("work_email", "email"), alias("other_email", "email")], ["name"]);
    expect(plain(ownership.aliasOf)).toEqual({ home_email: "email", work_email: "email", other_email: "email" });
    expect(ownership.pagesOf.email).toEqual(["p1", "p2"]);
  });
});

describe("presentations: rule G — a worked-out value has its target to itself", () => {
  it("places the target on the node's page when nothing else in the presentation places it", () => {
    const ownership = owned(["email"], [ownField("m1", {}, "number"), workedOut("sum", "annual_income")]);
    expect(plain(ownership.workedOutOf)).toEqual({ sum: "annual_income" });
    expect(ownership.pagesOf.annual_income).toEqual(["p2"]);
    expect(ownership.pagesOf.sum).toEqual(["p2"]);
    expect(ownership.membersOf.p2).toEqual(["m1", "sum"]);
    // The fieldset the target sits in is on no page: structural, so the target is not folded with it.
    expect(ownership.structural.money).toBe(true);
  });

  it("ignores the node when the target is listed, inside something listed, referenced or filled — on its page, an earlier one or a later one", () => {
    const elsewhere: JourneyPageEntry[][] = [
      ["annual_income"],
      ["money"],
      [ref("annual_income")],
      [box("layout", [ref("money")])],
      [alias("typed_income", "annual_income", "number")]
    ];
    for (const placing of elsewhere) {
      for (const pages of [
        [placing, [workedOut("sum", "annual_income"), ownField("kept")]],
        [[workedOut("sum", "annual_income"), ownField("kept")], placing],
        [[...placing, workedOut("sum", "annual_income"), ownField("kept")]]
      ]) {
        const ownership = owned(...pages);
        const label = JSON.stringify(pages);
        expect(plain(ownership.workedOutOf), label).toEqual({});
        expect(ownership.ownNodes?.sum, label).toBeUndefined();
        expect(ownership.pagesOf.sum, label).toBeUndefined();
        expect(Object.values(ownership.membersOf).flat(), label).not.toContain("sum");
        // The target stands only where the other entry put it.
        const without = owned(...pages.map((page) => page.filter((entry) => typeof entry === "string" || entry.id !== "sum")));
        expect(ownership.pagesOf.annual_income, label).toEqual(without.pagesOf.annual_income);
      }
    }
  });

  it("takes the first worked-out value for a field, in page order, and ignores the rest", () => {
    const ownership = owned([workedOut("first", "annual_income"), workedOut("second", "annual_income")], [box("later", [workedOut("third", "annual_income"), ownField("own_note", {}, "html")]), workedOut("other", "approved_amount")]);
    expect(plain(ownership.workedOutOf)).toEqual({ first: "annual_income", other: "approved_amount" });
    expect(ownership.pagesOf.annual_income).toEqual(["p1"]);
    expect(ownership.membersOf).toEqual({ p1: ["first"], p2: ["later", "other"] });
    // Inside a layout the ignored node goes, and the layout stays with what else it holds.
    expect(plain(ownership.ownNodes)).toEqual({ later: true, own_note: true, first: true, other: true });
  });

  it("keeps an ignored node's id taken: the id belongs to the first node that carries it", () => {
    const ownership = owned(["annual_income", workedOut("sum", "annual_income"), ownField("sum")]);
    expect(ownership.membersOf.p1).toEqual(["annual_income"]);
    expect(plain(ownership.ownNodes)).toEqual({});
  });
});

describe("presentations: rule H — a presentation holding nodes of its own has an id a component could have", () => {
  const page = (): JourneyPageEntry[] => ["name", ownField("note"), alias("work_email", "email"), box("contact", [ref("city")]), ref("approved_amount"), workedOut("sum", "annual_income")];

  it("drops every own entry of a journey whose id is outside the component-id grammar, and keeps what it lists or references at the top", () => {
    for (const id of ["a.b", "staff view", "9lives", "@own", "a[0]", "é", "-a"]) {
      const ownership = journeyOwnership(presentationTree, { id, pages: [{ id: "p1", components: page() }] });
      expect(ownership.membersOf.p1, id).toEqual(["name", "approved_amount"]);
      expect(plain(ownership.pagesOf), id).toEqual({ name: ["p1"], approved_amount: ["p1"] });
      expect(plain(ownership.ownNodes), id).toEqual({});
      expect(plain(ownership.aliasOf), id).toEqual({});
      expect(plain(ownership.workedOutOf), id).toEqual({});
    }
    // Ids a component could have: every entry in use.
    for (const id of ["a", "own_1", "Own-2", "a_b", "a-b"]) {
      const ownership = journeyOwnership(presentationTree, { id, pages: [{ id: "p1", components: page() }] });
      expect(ownership.membersOf.p1, id).toEqual(["name", "note", "work_email", "contact", "approved_amount", "sum"]);
    }
  });

  it("places a journey of component ids alone the same whatever its id", () => {
    const pages: JourneyPage[] = [{ id: "p1", components: ["email", "name"] }, { id: "p2", components: ["money"] }];
    for (const id of ["a.b", "staff view"]) {
      expect(journeyOwnership(presentationTree, { id, pages }), id).toEqual(journeyOwnership(presentationTree, { id: "plain", pages }));
      expect(journeyOwnership(presentationRoot(), { id, pages }), id).toEqual(journeyOwnership(presentationRoot(), { id: "plain", pages }));
    }
  });

  it("is said after A, B and C, for every node of such a journey, and records the id either way", () => {
    const formIds = kernelTreeIndex(presentationTree).nodeById;
    const seen = Object.create(null) as Record<string, true>;
    expect(journeyOwnNodeRule(ownField("fine"), formIds, seen, "staff view", NO_KEYS)).toBe("H");
    expect(journeyOwnNodeRule(ownField("email"), formIds, seen, "staff view", NO_KEYS)).toBe("A");
    expect(journeyOwnNodeRule(ownField("upload", {}, "file"), formIds, seen, "a.b", NO_KEYS)).toBe("B");
    expect(journeyOwnNodeRule(box("layout", []), formIds, seen, "a.b", NO_KEYS)).toBe("H");
    expect(Object.keys(seen)).toEqual(["fine", "email", "upload", "layout"]);
  });
});

describe("presentations: rule I — an own answer is not kept under a key the form defines", () => {
  /** A hand-written form whose data uses `@own.…` keys: a section's and a grid's collection paths, a container and a field named with `@`. */
  const atForm: ComponentNode = group("form", "form", [
    field("email"),
    group("rows", "repeatingSection", [{ id: "sku_field", type: "text", configuration: { dataKey: "sku" } }], { collection: { collectionPath: "@own.items" } }),
    { id: "grid", type: "dataGrid", configuration: {}, collection: { collectionPath: "@own.orders" } },
    group("@own", "container", [{ id: "memo_field", type: "text", configuration: { dataKey: "memo" } }]),
    field("@own.flat")
  ]);
  const keyed = (...pages: JourneyPageEntry[][]): JourneyOwnership => journeyOwnership(atForm, { id: "own", pages: pages.map((components, index) => ({ id: `p${index + 1}`, components })) });

  it("drops an entry whose field — plain, an alias, anywhere in it — would be stored at a key the form defines", () => {
    for (const clash of [ownField("items"), ownField("orders"), ownField("memo"), alias("flat", "email"), box("outer", [ref("email"), ownField("memo", {}, "number")])]) {
      const ownership = keyed([clash, ownField("kept")]);
      expect(ownership.membersOf.p1, JSON.stringify(clash)).toEqual(["kept"]);
      expect(plain(ownership.aliasOf), JSON.stringify(clash)).toEqual({});
      expect(ownership.pagesOf.email, JSON.stringify(clash)).toBeUndefined();
    }
    const formIds = kernelTreeIndex(atForm).nodeById;
    expect(journeyOwnNodeRule(ownField("items"), formIds, Object.create(null) as Record<string, true>, "own", journeyFormKeys(atForm))).toBe("I");
    // The same ids under another journey's key, or a key only an entry index reaches: no clash.
    expect(journeyOwnership(atForm, { id: "other", pages: [{ id: "p1", components: [ownField("items"), ownField("memo")] }] }).membersOf.p1).toEqual(["items", "memo"]);
    expect(keyed([ownField("qty"), ownField("sku")]).membersOf.p1).toEqual(["qty", "sku"]);
  });

  it("uses a node that holds no answer under such an id: a layout, static content, a worked-out value", () => {
    const ownership = keyed([box("items", [ownField("inside")]), ownField("orders", {}, "html"), workedOut("memo", "email")]);
    expect(ownership.membersOf.p1).toEqual(["items", "orders", "memo"]);
    expect(plain(ownership.workedOutOf)).toEqual({ memo: "email" });
  });
});

describe("journeyFormKeys: the form's keys that hold no entry index", () => {
  /** The kernel's allowlist without the shapes holding an index. */
  const kernelKeys = (root: ComponentNode): Record<string, true> =>
    Object.fromEntries(
      Object.keys(kernelKnownKeyShapes(root))
        .filter((key) => !/[[\]]/.test(key))
        .map((key) => [key, true as const])
    );

  it("is the kernel's allowlist without the entry shapes, form by form", () => {
    const roots: ComponentNode[] = [
      presentationTree,
      presentationRoot(),
      group("form", "form", [
        group("outer", "container", [group("inner", "container", [field("deep")], { configuration: { dataKey: "in" } }), group("flat", "fieldset", [field("loose")])]),
        group("keyed", "container", [field("k")], { configuration: { dataKey: "9" } }),
        group("visual", "container", [field("v")], { configuration: { scopeData: false } }),
        group("sec", "repeatingSection", [field("row")], { collection: { collectionPath: "a[0]" } }),
        group("sec2", "repeatingSection", [group("nested", "repeatingSection", [field("x")], { collection: { collectionPath: "lines" } })], { collection: { collectionPath: "order.items" } }),
        group("sec3", "repeatingSection", [{ id: "g3", type: "dataGrid", configuration: {}, collection: { collectionPath: "inner_rows" } }, group("bad", "repeatingSection", [group("under_bad", "repeatingSection", [], { collection: { collectionPath: "hidden_away" } })], { collection: { collectionPath: "x]" } })], { collection: {} }),
        { id: "nulled", type: "text", configuration: {}, collection: null } as unknown as ComponentNode,
        { id: "g1", type: "dataGrid", configuration: {}, collection: { collectionPath: "rows[1]" } },
        { id: "g2", type: "dataGrid", configuration: [] as unknown as Record<string, unknown> },
        { id: "arr", type: "text", configuration: ["x"] as unknown as Record<string, unknown> },
        field("b[0]"),
        field("send", "button"),
        field("sig", "signature"),
        group("tabs", "tabs", [group("tab1", "tab", [field("in_tab")])]),
        { id: "odd", type: "container", configuration: null as unknown as Record<string, unknown>, children: { content: [field("under_odd")] } }
      ])
    ];
    for (const root of roots) {
      expect(plain(journeyFormKeys(root)), root.id).toEqual(kernelKeys(root));
      // And over the tree as the run reads it, grids normalized.
      const read = normalizeDataGrids(root);
      expect(plain(journeyFormKeys(read)), root.id).toEqual(kernelKeys(read));
    }
  });
});

describe("presentations: what the ownership records", () => {
  const root = presentationRoot();

  it("places the fixture's journey: the alias's and the worked-out value's targets on their nodes' pages", () => {
    const ownership = journeyOwnership(root, applyJourney());
    expect(ownership.order).toEqual(["form", "email", "name", "money", "annual_income", "approved_amount"]);
    expect(ownership.membersOf).toEqual({ details: ["work_email"], income: ["m1", "m2", "m3", "income_total"], assist: ["approved_amount"] });
    expect(plain(ownership.pagesOf)).toEqual({
      work_email: ["details"],
      email: ["details"],
      m1: ["income"],
      m2: ["income"],
      m3: ["income"],
      approved_amount: ["assist"],
      income_total: ["income"],
      annual_income: ["income"]
    });
    expect(plain(ownership.ownNodes)).toEqual({ work_email: true, m1: true, m2: true, m3: true, income_total: true });
    expect(plain(ownership.aliasOf)).toEqual({ work_email: "email" });
    expect(plain(ownership.workedOutOf)).toEqual({ income_total: "annual_income" });
    // `money` holds a placed field and is on no page itself; `name` is on no page at all.
    expect(plain(ownership.structural)).toEqual({ form: true, money: true });
    expect(ownership.pagesOf.name).toBeUndefined();
  });

  it("places the fixture's variant: the referenced fields on its one page, through the own layout", () => {
    const ownership = journeyOwnership(root, publicVariant());
    expect(ownership.membersOf).toEqual({ all: ["contact", "public_note"] });
    expect(plain(ownership.pagesOf)).toEqual({ contact: ["all"], email: ["all"], name: ["all"], public_note: ["all"] });
    expect(plain(ownership.ownNodes)).toEqual({ contact: true, public_note: true });
    expect(plain(ownership.aliasOf)).toEqual({});
    expect(plain(ownership.workedOutOf)).toEqual({});
    // The required field the variant leaves out is on no page: the fold judges it as the whole form does.
    expect(ownership.pagesOf.annual_income).toBeUndefined();
    expect(ownership.structural.money).toBeUndefined();
  });

  it("keeps the form's order and the placements free of own nodes", () => {
    const journey = applyJourney();
    const ownership = journeyOwnership(root, journey);
    const trace: JourneyTrace = { pages: ["details", "income"], end: "end", decisions: [] };
    expect({ ...journeyPlacements(ownership, trace) }).toEqual({ email: "on", name: "unassigned", annual_income: "on", approved_amount: "off" });
    // The page of each id on the path — own nodes too, for a runtime that shows where an error is.
    expect({ ...journeyPageOfComponent(ownership, trace) }).toEqual({
      work_email: "details",
      email: "details",
      m1: "income",
      m2: "income",
      m3: "income",
      income_total: "income",
      annual_income: "income"
    });
  });

  it("walks the fixture's path by the worked-out field, never by an own field", () => {
    const journey = applyJourney();
    const ownership = journeyOwnership(root, journey);
    const below = journeyPath(journey, { values: { email: "a@b.co", annual_income: 36000, approved_amount: 5 }, ownership, evaluate });
    expect(below.pages).toEqual(["details", "income"]);
    expect(below.decisions).toEqual([
      { kind: "next", pageId: "details", to: "income" },
      { kind: "route", pageId: "income", routeIndex: 1, to: "$end" }
    ]);
    const above = journeyPath(journey, { values: { email: "a@b.co", annual_income: 50000 }, ownership, evaluate });
    expect(above.pages).toEqual(["details", "income", "assist"]);
    // A value spelled like an own field steers nothing: the route reads the form field.
    expect(journeyPath(journey, { values: { m1: 99999, m2: 99999, annual_income: 1 }, ownership, evaluate }).pages).toEqual(["details", "income"]);
  });

  it("brings the presentation records only with an object entry: a journey of ids has none of them", () => {
    const ids: Journey = { id: "ids", pages: [{ id: "one", components: ["email", "money"] }, { id: "two", components: ["approved_amount"] }] };
    expect(Object.keys(journeyOwnership(root, ids))).toEqual(["rootId", "order", "pagesOf", "membersOf", "structural", "collectionOwners"]);
    const withOne: Journey = { id: "ids", pages: [{ id: "one", components: ["email", ownField("note", {}, "html")] }] };
    expect(Object.keys(journeyOwnership(root, withOne))).toEqual(["rootId", "order", "pagesOf", "membersOf", "structural", "collectionOwners", "ownNodes", "aliasOf", "workedOutOf"]);
    // An entry that is dropped is still an object entry: the records come, empty.
    const dropped = journeyOwnership(root, { id: "ids", pages: [{ id: "one", components: ["email", ownField("email")] }] });
    expect(plain(dropped.ownNodes)).toEqual({});
    expect(dropped.membersOf.one).toEqual(["email"]);
  });

  it("survives a JSON boundary, where its records have Object.prototype again", () => {
    const journey = applyJourney();
    const crossed = JSON.parse(JSON.stringify(journeyOwnership(root, journey))) as JourneyOwnership;
    expect(journeyPath(journey, { values: { annual_income: 60000 }, ownership: crossed, evaluate }).pages).toEqual(["details", "income", "assist"]);
    expect(journeyPagesOfKey(crossed, "annual_income")).toEqual(["income"]);
    expect(journeyPagesOfKey(crossed, "m1")).toBeUndefined();
    expect(journeyPagesOfKey(crossed, "constructor")).toBeUndefined();
  });

  it("places own nodes named after Object.prototype members like any other", () => {
    const ownership = owned([ownField("isPrototypeOf"), alias("toString", "email"), box("valueOf", [ref("name")]), workedOut("hasOwnProperty", "annual_income")]);
    expect(ownership.membersOf.p1).toEqual(["isPrototypeOf", "toString", "valueOf", "hasOwnProperty"]);
    expect(Object.keys(plain(ownership.ownNodes))).toEqual(["isPrototypeOf", "toString", "valueOf", "hasOwnProperty"]);
    expect(plain(ownership.aliasOf)).toEqual({ toString: "email" });
    expect(plain(ownership.workedOutOf)).toEqual({ hasOwnProperty: "annual_income" });
    // `__proto__` is off the grammar, so it is dropped like any other bad id — and sets no prototype.
    const proto = JSON.parse('{"id": "__proto__", "type": "text"}') as PresentationNode;
    const dropped = owned([proto, ownField("kept")]);
    expect(dropped.membersOf.p1).toEqual(["kept"]);
    expect(Object.getPrototypeOf(dropped.ownNodes)).toBeNull();
    // `constructor` and `prototype` are reserved by the component-id grammar, so they are dropped too.
    expect(owned([ownField("constructor"), ownField("prototype"), ownField("kept")]).membersOf.p1).toEqual(["kept"]);
  });
});

describe("presentations: every page the walk reaches is shown", () => {
  it("keeps a page holding only an alias, a layout of references or own fields, whatever the form hides", () => {
    for (const entries of [[alias("work_email", "email")], [box("contact", [ref("email"), ref("name")], "columns")], [ownField("m1", {}, "number")]]) {
      const journey = presentation(entries, ["approved_amount"]);
      const ownership = journeyOwnership(presentationTree, journey);
      const trace = journeyPath(journey, { values: {}, ownership, evaluate });
      expect(trace.pages).toEqual(["p1", "p2"]);
      expect(trace.decisions).toEqual([
        { kind: "next", pageId: "p1", to: "p2" },
        { kind: "next", pageId: "p2", to: "$end" }
      ]);
    }
  });

  it("keeps a page whose own entries were all dropped or ignored, as one listing nothing", () => {
    const journey = presentation([ownField("email"), workedOut("sum", "ghost"), ref("ghost")], ["name"]);
    const ownership = journeyOwnership(presentationTree, journey);
    expect(ownership.membersOf.p1).toEqual([]);
    expect(journeyPath(journey, { values: {}, ownership, evaluate }).pages).toEqual(["p1", "p2"]);
  });
});

describe("presentations: who owns a value key", () => {
  /** Grids bound at a collection path, and unbound grids: every reader binds those at their id. */
  const gridded = normalizeDataGrids(
    group("form", "form", [
      field("kind"),
      { id: "orders_grid", type: "dataGrid", configuration: {}, collection: { collectionPath: "orders" }, children: { content: [field("qty")] } },
      { id: "same", type: "dataGrid", configuration: {} },
      group("lines", "repeatingSection", [field("sku")], { collection: { collectionPath: "order_lines" } }),
      { id: "late_grid", type: "dataGrid", configuration: {}, collection: { collectionPath: "order_lines" } },
      { id: "no_path", type: "dataGrid", configuration: {} },
      field("after")
    ])
  );

  it("gives a data grid's rows, at its collection path as written, to the grid", () => {
    const journey: Journey = { id: "grids", pages: [{ id: "first", components: ["kind"] }, { id: "second", components: ["orders_grid", "same", "lines"] }, { id: "third", components: ["late_grid", "no_path"] }] };
    const ownership = journeyOwnership(gridded, journey);
    // First in document order wins a path two components claim: the section, not the later grid.
    expect({ ...ownership.collectionOwners }).toStrictEqual({ orders: "orders_grid", same: "same", order_lines: "lines", no_path: "no_path" });
    expect(journeyPagesOfKey(ownership, "orders[0].qty")).toEqual(["second"]);
    expect(journeyPagesOfKey(ownership, "orders")).toEqual(["second"]);
    expect(journeyPagesOfKey(ownership, "same[3].x")).toEqual(["second"]);
    expect(journeyPagesOfKey(ownership, "order_lines[0].sku")).toEqual(["second"]);
    expect(journeyPagesOfKey(ownership, "no_path[0].x")).toEqual(["third"]);
    expect(journeyPagesOfKey(ownership, "elsewhere[0].x")).toBeUndefined();
    // So a row cannot steer a route before the grid's own page is on the path.
    const steering: Journey = {
      id: "grids",
      pages: [
        { id: "first", components: ["kind"], routes: [{ when: eq("orders[0].qty", 9), to: "second" }] },
        { id: "early", components: ["after"] },
        { id: "second", components: ["orders_grid"], routes: [{ when: eq("orders[0].qty", 9), to: "$end" }] },
        { id: "late", components: ["after"] }
      ]
    };
    const trace = journeyPath(steering, { values: { "orders[0].qty": 9 }, ownership: journeyOwnership(gridded, steering), evaluate });
    expect(trace.pages).toEqual(["first", "early", "second"]);
  });

  it("reads where a grid's rows live as any section's: its collection path, else its id once normalized", () => {
    expect(journeyCollectionPathOf({ id: "g", type: "dataGrid", configuration: {}, collection: { collectionPath: "lines" } })).toBe("lines");
    expect(journeyCollectionPathOf({ id: "g", type: "dataGrid", configuration: {}, collection: { collectionPath: "order.rows" } })).toBe("order.rows");
    for (const configuration of [{}, []]) {
      const grid = normalizeDataGrids({ id: "form", type: "form", configuration: {}, children: { content: [{ id: "g", type: "dataGrid", configuration } as ComponentNode] } }).children!.content![0]!;
      expect(journeyCollectionPathOf(grid), JSON.stringify(configuration)).toBe("g");
    }
    expect(journeyCollectionPathOf({ id: "g", type: "text", configuration: {} })).toBeUndefined();
  });

  it("never places a key by an own node's id: own answers are not form values", () => {
    // Own nodes spelled like a grid's data path, a section's collection path and a leading segment.
    const journey: Journey = {
      id: "own",
      pages: [
        { id: "first", components: [ownField("orders"), ownField("order_lines"), ownField("extra"), ownField("plain")] },
        { id: "second", components: ["orders_grid", "lines"] }
      ]
    };
    const ownership = journeyOwnership(gridded, journey);
    expect(ownership.pagesOf.orders).toEqual(["first"]);
    expect(journeyPagesOfKey(ownership, "orders")).toEqual(["second"]);
    expect(journeyPagesOfKey(ownership, "orders[0].qty")).toEqual(["second"]);
    expect(journeyPagesOfKey(ownership, "order_lines")).toEqual(["second"]);
    expect(journeyPagesOfKey(ownership, "extra[0].x")).toBeUndefined();
    expect(journeyPagesOfKey(ownership, "extra.x")).toBeUndefined();
    expect(journeyPagesOfKey(ownership, "plain")).toBeUndefined();
    // A form component's id still places its key, as ever.
    expect(journeyPagesOfKey(ownership, "orders_grid")).toEqual(["second"]);
    expect(journeyPagesOfKey(ownership, "kind")).toBeUndefined();
  });
});

describe("the path engine's own list", () => {
  it("calls nothing outside it: no function reads an imported binding but a shared helper the list holds", () => {
    // Under vitest the engine's sources go through Vite's SSR transform, which spells a call to
    // an imported function as a read on the import's namespace. The path engine imports types
    // only, bar the shared helpers of `journey-shared.ts` that this
    // list holds; so a function may read one of those four and nothing else, and the helpers read none.
    // What it needs from elsewhere it keeps a copy of.
    const shared = new Set(["journeyOwn", "journeyLeadingSegment", "journeyCollectionPathOf", "journeyHoldsOwnAnswer"]);
    const listed = new Set(JOURNEY_PATH_FUNCTIONS.map((fn) => fn.name));
    for (const name of shared) {
      expect(listed.has(name), name).toBe(true);
    }
    for (const fn of JOURNEY_PATH_FUNCTIONS) {
      const source = fn.toString();
      const reads = source.match(/__vi(?:te)?_(?:ssr_)?import_\d+__(?:\.[A-Za-z_$][\w$]*)?/g) ?? [];
      if (shared.has(fn.name)) {
        expect(reads, fn.name).toEqual([]);
      }
      for (const read of reads) {
        const name = read.slice(read.indexOf(".") + 1);
        expect(read.includes(".") && shared.has(name), `${fn.name} reads ${read}`).toBe(true);
      }
    }
  });

  it("lists the functions presentations added", () => {
    expect(JOURNEY_PATH_FUNCTIONS.map((fn) => fn.name)).toEqual(
      expect.arrayContaining(["journeyHoldsOwnAnswer", "journeyOwnNodeRule", "journeyOwnNodeUsable", "journeyTargetUsable", "journeyOwnership"])
    );
  });
});

// A route condition holds only for the boolean true.
describe("journeyPath: strict truthiness of a route condition", () => {
  const read = (path: string): Expression => ({ kind: "path", path });
  const NOT_TRUE: Array<[string, unknown]> = [["the text yes", "yes"], ["the text false", "false"], ["the number 1", 1], ["a list", ["a"]], ["an empty list", []], ["an object", { a: true }], ["null", null], ["nothing", undefined]];

  it.each(NOT_TRUE)("takes no route whose condition comes to %s", (_label, answer) => {
    const journey = fivePages({ p1: { routes: [{ when: read("q1"), to: "p4" }] } });
    expect(walk(journey, { q1: answer }).pages).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(walk(journey, { q1: true }).pages).toEqual(["p1", "p4", "p5"]);
  });
});

// --- Check answers: a review page ----------------------------------------------

describe("journeyPath: a review page", () => {
  /** p1..p3 ask q1..q3; `check` is the review page; `stop` an exit page listed after it. */
  function withReview(review: Partial<JourneyPage> = {}, after: JourneyPage[] = []): Journey {
    return {
      id: "flow",
      pages: [
        { id: "p1", components: ["q1"], routes: [{ when: eq("q1", "no"), to: "stop" }] },
        { id: "p2", components: ["q2"] },
        { id: "p3", components: ["q3"] },
        { id: "check", kind: "review", ...review },
        ...after,
        { id: "stop", kind: "exit", components: ["u"] }
      ]
    };
  }

  it("is on the path, holding nothing of its own", () => {
    const trace = walk(withReview());
    expect(trace.pages).toEqual(["p1", "p2", "p3", "check"]);
    expect(trace.end).toBe("end");
    expect(trace.decisions[trace.decisions.length - 1]).toEqual({ kind: "next", pageId: "check", to: "$end" });
  });

  it("ends the walk with a submit: the exit page listed after it is never taken by falling through", () => {
    const trace = walk(withReview());
    expect(trace.decisions).toEqual([
      { kind: "next", pageId: "p1", to: "p2" },
      { kind: "next", pageId: "p2", to: "p3" },
      { kind: "next", pageId: "p3", to: "check" },
      { kind: "next", pageId: "check", to: "$end" }
    ]);
    // A route to the exit page before it still stops there.
    expect(walk(withReview(), { q1: "no" })).toMatchObject({ pages: ["p1", "stop"], end: "exit" });
  });

  it("follows none of its own routes, and takes no page listed after it", () => {
    const journey = withReview({ routes: [{ to: "later" }, { when: eq("q1", "x"), to: "stop" }] }, [{ id: "later", components: ["q4"] }]);
    const trace = walk(journey, { q1: "x" });
    expect(trace.pages).toEqual(["p1", "p2", "p3", "check"]);
    expect(trace.end).toBe("end");
  });

  it("places no form component: listed ids, references and entries that place a field are not its own", () => {
    const tree = group("form", "form", [field("q1"), field("q2"), field("decl", "checkbox"), field("note", "html")]);
    const declaration: PresentationNode = { id: "declare", type: "checkbox", configuration: { label: "I confirm" } };
    const words: PresentationNode = { id: "words", type: "html", configuration: { content: "Now send" } };
    const alias: PresentationNode = { id: "again", type: "text", configuration: { fills: "q2" } };
    const box: PresentationNode = { id: "box", type: "fieldset", children: { content: [{ type: "journey-field", configuration: { componentId: "q2" } } as PresentationReference] } };
    const journey: Journey = {
      id: "flow",
      pages: [
        { id: "p1", components: ["q1"] },
        {
          id: "check",
          kind: "review",
          components: ["q2", { type: "journey-field", configuration: { componentId: "q1" } } as PresentationReference, alias, box, declaration, words]
        }
      ]
    };
    const ownership = journeyOwnership(tree, journey);
    expect(ownership.membersOf.check).toEqual(["declare", "words"]);
    expect(ownership.pagesOf.q2).toBeUndefined();
    expect(ownership.pagesOf.q1).toEqual(["p1"]);
    expect(ownership.pagesOf.declare).toEqual(["check"]);
    expect(ownership.pagesOf.again).toBeUndefined();
    expect(ownership.pagesOf.box).toBeUndefined();
    expect({ ...ownership.aliasOf }).toEqual({});
    // The same placements on a questions page put q2 and q1 there.
    const asked = journeyOwnership(tree, { ...journey, pages: [journey.pages[0]!, (({ kind: _kind, ...rest }) => rest)(journey.pages[1]!)] });
    expect(asked.pagesOf.q2).toEqual(["check"]);
    expect(asked.pagesOf.q1).toEqual(["p1", "check"]);
  });

  it("reads which entries place a form field from their shape alone", () => {
    expect(journeyEntryPlacesForm({ id: "a", type: "checkbox" })).toBe(false);
    expect(journeyEntryPlacesForm({ id: "a", type: "text", configuration: { fills: "q1" } })).toBe(true);
    expect(journeyEntryPlacesForm({ id: "a", type: "text", configuration: { fills: "" } })).toBe(false);
    expect(journeyEntryPlacesForm({ id: "a", type: "journey-value", configuration: { to: "q1", value: "1" } })).toBe(true);
    expect(journeyEntryPlacesForm({ id: "a", type: "fieldset", children: { content: [{ id: "b", type: "html" }] } })).toBe(false);
    expect(
      journeyEntryPlacesForm({ id: "a", type: "fieldset", children: { content: [{ id: "b", type: "fieldset", children: { content: [{ type: "journey-field", configuration: { componentId: "q1" } } as PresentationReference] } }] } })
    ).toBe(true);
  });

  it("has one way out in the static graph: the end", () => {
    const graph = journeyStaticGraph(withReview({ routes: [{ to: "stop" }] }));
    expect(graph.edges.filter((edge) => edge.from === "check")).toEqual([{ from: "check", to: "$end", kind: "next", conditional: false }]);
  });
});
