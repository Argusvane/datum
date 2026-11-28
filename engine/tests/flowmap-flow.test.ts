import { describe, expect, it } from "vitest";

import type { Expression, RuleSource } from "../form-engine/core/expressions/expression.js";
import { kernelCompileJourney } from "../form-engine/core/expressions/compile.js";
import type { FormulaProblem } from "../form-engine/core/expressions/formula-types.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { Journey, JourneyPage, JourneyRoute } from "../form-engine/core/schema/journey.js";
import { diagnoseJourney } from "../form-engine/core/journey/journey-diagnostics.js";
import { journeyFlow, type JourneyFlow } from "../form-engine/core/journey/journey-flow.js";
import { journeyOwnership, journeyPath, journeyStaticGraph } from "../form-engine/core/journey/journey-path.js";

/**
 * The flow map's graph facts: `journeyFlow` against `diagnoseJourney` (the same walk,
 * so `page.unreachable` and `journey.no-end` agree) and against the path engine itself, every
 * outcome of the conditions tried (so a live edge is one some person can take).
 */

function field(id: string, extra: Partial<ComponentNode> = {}): ComponentNode {
  return { id, type: "text", configuration: { label: id }, ...extra };
}

function formOf(...children: ComponentNode[]): ComponentNode {
  return { id: "form", type: "form", configuration: {}, children: { content: children } };
}

let conditionSerial = 0;
/** A condition of its own: each compiles to a tree of its own, so the brute force treats them as free. */
function cond(path = "x"): RuleSource {
  conditionSerial += 1;
  return `${path} = "v${conditionSerial}"`;
}

function journeyOf(...pages: JourneyPage[]): Journey {
  return { id: "j", pages };
}

const FORM = formOf(
  field("a"),
  field("b"),
  field("c"),
  field("d"),
  field("e"),
  field("hid", { rules: { visibleWhen: cond("a") } }),
  field("hid2", { rules: { visibleWhen: cond("a") } }),
  { id: "note", type: "html", configuration: { content: "Sorry" } },
  // Hidden by its configuration, with no rule to show it: never on screen.
  field("fixed", { configuration: { label: "fixed", hidden: true } }),
  // Hidden by its configuration, but a rule shows it at times.
  field("shown", { configuration: { label: "shown", hidden: true }, rules: { visibleWhen: cond("a") } }),
  // Inside a container hidden by its configuration.
  { id: "box", type: "container", configuration: { hidden: true }, children: { content: [field("inner")] } }
);

function edgesOf(flow: JourneyFlow): string[] {
  return flow.edges.map((edge) => `${edge.kind}:${edge.from}>${edge.to}${edge.routeIndex !== undefined ? `#${edge.routeIndex}` : ""}${edge.otherwise ? " otherwise" : ""}${edge.live ? "" : " dead"}`);
}

/** Every outcome the path engine can give, conditions free, over the journey's compiled copy. */
function everyOutcome(root: ComponentNode, written: Journey): { shown: Set<string>; ends: boolean; taken: Set<string> } {
  const problems: FormulaProblem[] = [];
  const journey = (kernelCompileJourney({ journeys: [written] }, kernelParseFormula, formulaFunctionSignatures(), problems) as { journeys: Journey[] }).journeys[0]!;
  expect(problems).toEqual([]);
  const conditions: Expression[] = [];
  const see = (expression: Expression | undefined): void => {
    if (expression !== undefined && !conditions.includes(expression)) {
      conditions.push(expression);
    }
  };
  for (const page of journey.pages) {
    for (const route of page.routes ?? []) {
      see(route.when as Expression | undefined);
    }
  }
  const bits = conditions.length;
  expect(bits).toBeLessThanOrEqual(12);
  const ownership = journeyOwnership(root, journey);
  const shown = new Set<string>();
  const taken = new Set<string>();
  let ends = false;
  for (let mask = 0; mask < 1 << bits; mask += 1) {
    const truth = new Map(conditions.map((expression, index) => [expression, (mask & (1 << index)) !== 0]));
    const trace = journeyPath(journey, { values: {}, ownership, evaluate: (expression) => truth.get(expression) === true });
    for (const pageId of trace.pages) {
      shown.add(pageId);
    }
    for (const decision of trace.decisions) {
      taken.add(decision.kind === "route" ? `route:${decision.pageId}#${decision.routeIndex}` : `next:${decision.pageId}`);
    }
    if (trace.end === "end") {
      ends = true;
    }
  }
  return { shown, ends, taken };
}

/** The flow's facts said as the brute force says them (unique page ids only). */
function flowFacts(journey: Journey, flow: JourneyFlow): { shown: Set<string>; ends: boolean; taken: Set<string> } {
  const id = (index: number): string => journey.pages[index]!.id;
  return {
    shown: new Set(flow.pages.filter((page) => page.onPath).map((page) => page.pageId)),
    ends: flow.ends,
    taken: new Set(
      flow.edges
        .filter((edge) => edge.live)
        .map((edge) => (edge.kind === "route" ? `route:${id(edge.from)}#${edge.routeIndex}` : `${edge.kind}:${id(edge.from)}`))
    )
  };
}

/** A small seeded generator, so the corpus is the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CORPUS_FORM = formOf(
  field("q1"),
  field("q2"),
  field("q3"),
  field("q4"),
  field("q5"),
  field("hid", { rules: { visibleWhen: cond("q1") } }),
  field("hid2", { rules: { visibleWhen: cond("q1") } }),
  field("hid3", { rules: { visibleWhen: cond("q1") } }),
  field("hid4", { rules: { visibleWhen: cond("q1") } })
);

/**
 * A random journey: exits, conditions, hideable and empty pages, every kind of bad route; with
 * `repeatIds`, pages that share an id too.
 */
function randomJourney(seed: number, repeatIds = false): Journey {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  for (;;) {
    const count = 1 + Math.floor(next() * 7);
    const components = ["q1", "q2", "q3", "q4", "q5", "hid", "hid2", "hid3", "hid4"];
    const pages: JourneyPage[] = [];
    for (let index = 0; index < count; index += 1) {
      const page: JourneyPage = { id: repeatIds && index > 0 && next() < 0.4 ? `p${Math.floor(next() * index)}` : `p${index}` };
      if (next() < 0.2) {
        page.kind = "exit";
      }
      const listed: string[] = [];
      const wanted = next() < 0.15 ? 0 : 1 + Math.floor(next() * 2);
      for (let n = 0; n < wanted && components.length > 0; n += 1) {
        listed.push(components.splice(Math.floor(next() * components.length), 1)[0] as string);
      }
      if (listed.length > 0) {
        page.components = listed;
      }
      const routes: JourneyRoute[] = [];
      const routeCount = Math.floor(next() * 3.4);
      for (let n = 0; n < routeCount; n += 1) {
        const roll = next();
        const to = roll < 0.12 ? "$end" : roll < 0.2 ? "missing" : pick(Array.from({ length: count }, (_value, at) => `p${at}`));
        routes.push(next() < 0.6 ? { when: cond(), to } : { to });
      }
      if (routes.length > 0) {
        page.routes = routes;
      }
      pages.push(page);
    }
    const journey = journeyOf(...pages);
    const conditions = pages.reduce((sum, page) => sum + (page.routes ?? []).filter((route) => route.when).length, 0);
    if (conditions <= 11) {
      return journey;
    }
  }
}

describe("journeyFlow", () => {
  it("draws a linear journey as next edges to the end", () => {
    const flow = journeyFlow(journeyOf({ id: "one", components: ["a"] }, { id: "two", components: ["b"] }));
    expect(edgesOf(flow)).toEqual(["next:0>1", "next:1>2"]);
    expect(flow.pages.map((page) => page.onPath)).toEqual([true, true]);
    expect(flow.ends).toBe(true);
    expect(flow.ignored).toEqual([]);
  });

  it("says a fall-through after conditional routes is the otherwise, and an unconditional route removes it", () => {
    const flow = journeyFlow(journeyOf(
        { id: "ask", components: ["a"], routes: [{ when: cond(), to: "three" }, { when: cond(), to: "four" }] },
        { id: "two", components: ["b"], routes: [{ when: cond(), to: "four" }, { to: "three" }] },
        { id: "three", components: ["c"], routes: [{ to: "$end" }] },
        { id: "four", components: ["d"] }
      )
    );
    expect(edgesOf(flow)).toEqual([
      "route:0>2#0",
      "route:0>3#1",
      "next:0>1 otherwise",
      "route:1>3#0",
      "route:1>2#1 otherwise",
      "route:2>4#0",
      "next:3>4"
    ]);
    expect(flow.edges.filter((edge) => edge.kind === "route").map((edge) => edge.conditional)).toEqual([true, true, true, false, false]);
  });

  it("says otherwise only after a conditional route that is drawn", () => {
    const flow = journeyFlow(journeyOf(
        { id: "one", components: ["a"] },
        { id: "two", components: ["b"], routes: [{ when: cond(), to: "one" }, { when: cond(), to: "missing" }] },
        { id: "three", components: ["c"], routes: [{ when: cond(), to: "one" }, { to: "$end" }] },
        { id: "four", components: ["d"], routes: [{ to: "$end" }] }
      )
    );
    const two = flow.edges.find((edge) => edge.from === 1)!;
    expect(two).toMatchObject({ kind: "next", otherwise: false });
    const three = flow.edges.find((edge) => edge.from === 2)!;
    expect(three).toMatchObject({ kind: "route", routeIndex: 1, conditional: false, otherwise: false });
    expect(flow.ignored.map((route) => [route.from, route.routeIndex, route.reason])).toEqual([
      [1, 0, "backward"],
      [1, 1, "unknown-target"],
      [2, 0, "backward"]
    ]);
  });

  it("puts every page the walk arrives at on the path, one with nothing on it or with questions that may all hide included", () => {
    const flow = journeyFlow(journeyOf(
        { id: "one", components: ["a"] },
        { id: "empty" },
        { id: "hideable", components: ["hid", "hid2"] },
        { id: "both", components: ["hid"] },
        { id: "last", components: ["b"] }
      )
    );
    expect(flow.pages.map((page) => [page.pageId, page.onPath])).toEqual([
      ["one", true],
      ["empty", true],
      ["hideable", true],
      ["both", true],
      ["last", true]
    ]);
    // No way passes a page by: each leaves by its own fall-through, live.
    expect(edgesOf(flow)).toEqual(["next:0>1", "next:1>2", "next:2>3", "next:3>4", "next:4>5"]);
  });

  it("ranks the reasons a route is ignored, errors first", () => {
    const flow = journeyFlow(journeyOf(
        { id: "one", components: ["a"] },
        { id: "two", components: ["b"], routes: [{ to: "two" }, { to: "three" }, { to: "one" }, { when: cond(), to: "missing" }, { to: "three" }] },
        { id: "three", kind: "exit", components: ["note"], routes: [{ to: "nowhere" }, { to: "$end" }, { to: "one" }] }
      )
    );
    expect(flow.ignored).toEqual([
      { from: 1, routeIndex: 0, reason: "self", reasons: ["self"], to: 1 },
      { from: 1, routeIndex: 2, reason: "backward", reasons: ["backward", "shadowed"], to: 0, shadowedBy: 1 },
      { from: 1, routeIndex: 3, reason: "unknown-target", reasons: ["unknown-target", "shadowed"], shadowedBy: 1 },
      { from: 1, routeIndex: 4, reason: "shadowed", reasons: ["shadowed"], to: 2, shadowedBy: 1 },
      { from: 2, routeIndex: 0, reason: "unknown-target", reasons: ["unknown-target", "exit"] },
      { from: 2, routeIndex: 1, reason: "exit", reasons: ["exit"], to: 3 },
      { from: 2, routeIndex: 2, reason: "backward", reasons: ["backward", "exit", "shadowed"], to: 0, shadowedBy: 1 }
    ]);
    expect(edgesOf(flow)).toEqual(["next:0>1", "route:1>2#1"]);
    expect(flow.ends).toBe(false);
  });

  it("keeps two pages sharing an id apart, as the path engine does, and the diagnostics with it", () => {
    // A (always to C), B, A again, C: the runtime never shows B or the second A. Each page
    // leaves by its own ways out, so neither A takes the other's fall-through.
    const journey = journeyOf(
      { id: "A", components: ["a"], routes: [{ to: "C" }] },
      { id: "B", components: ["b"] },
      { id: "A", components: ["c"] },
      { id: "C", components: ["d"] }
    );
    const flow = journeyFlow(journey);
    expect(flow.pages.map((page) => page.onPath)).toEqual([true, false, false, true]);
    expect(edgesOf(flow)).toEqual(["route:0>3#0", "next:1>2 dead", "next:2>3 dead", "next:3>4"]);
    const runtime = everyOutcome(FORM, journey);
    expect([...runtime.shown].sort()).toEqual(["A", "C"]);
    expect(runtime.shown.has("B")).toBe(false);
    // One finding for each page the map draws unreachable: B, and the second A.
    expect(diagnoseJourney(FORM, journey).filter((d) => d.code === "page.unreachable").map((d) => d.pageId)).toEqual(["B", "A"]);

    // A (always to the exit), the exit, A again (always to the end): the runtime always stops
    // at the exit, so the journey can never be submitted — the map and the diagnostics agree.
    const stops = journeyOf(
      { id: "A", components: ["a"], routes: [{ to: "E" }] },
      { id: "E", kind: "exit", components: ["note"] },
      { id: "A", components: ["b"], routes: [{ to: "$end" }] }
    );
    expect(journeyFlow(stops).ends).toBe(false);
    expect(everyOutcome(FORM, stops).ends).toBe(false);
    expect(diagnoseJourney(FORM, stops).map((d) => d.code)).toEqual(expect.arrayContaining(["journey.no-end", "page.unreachable"]));
  });

  it("shows a page holding only what its configuration hides, as the runtime does", () => {
    const journey = journeyOf(
      { id: "one", components: ["a"] },
      { id: "fixed", components: ["fixed"], routes: [{ to: "$end" }] },
      { id: "boxed", components: ["inner"] },
      { id: "shown", components: ["shown"] },
      { id: "last", components: ["b"] }
    );
    const flow = journeyFlow(journey);
    // Hidden with no rule to show it, itself or by its container: shown all the same, and its route taken.
    expect(flow.pages.map((page) => page.onPath)).toEqual([true, true, false, false, false]);
    expect(edgesOf(flow)).toEqual(["next:0>1", "route:1>5#0", "next:2>3 dead", "next:3>4 dead", "next:4>5 dead"]);
    expect(everyOutcome(FORM, journey).shown).toEqual(new Set(["one", "fixed"]));
    const diagnostics = diagnoseJourney(FORM, journey);
    expect(diagnostics.filter((d) => d.code === "page.unreachable").map((d) => d.pageId)).toEqual(["boxed", "shown", "last"]);
  });

  it("marks what follows an unreachable page dead", () => {
    const flow = journeyFlow(journeyOf(
        { id: "one", components: ["a"], routes: [{ to: "three" }] },
        { id: "lost", components: ["hid"], routes: [{ when: cond(), to: "$end" }] },
        { id: "three", components: ["c"] }
      )
    );
    expect(flow.pages[1]).toMatchObject({ onPath: false });
    expect(edgesOf(flow)).toEqual(["route:0>2#0", "route:1>3#0 dead", "next:1>2 otherwise dead", "next:2>3"]);
  });

  it("does not end when every walk stops at an exit, nor with no pages", () => {
    expect(journeyFlow(journeyOf({ id: "one", components: ["a"] }, { id: "stop", kind: "exit", components: ["note"] })).ends).toBe(false);
    expect(journeyFlow(journeyOf())).toEqual({ pages: [], edges: [], ignored: [], ends: false });
  });

  it("leaves the journey as it was, and diagnoseJourney as it was", () => {
    const journey = journeyOf(
      { id: "one", components: ["a"], routes: [{ when: cond(), to: "stop" }] },
      { id: "two", components: ["hid"] },
      { id: "stop", kind: "exit", components: ["note"], routes: [{ to: "one" }] }
    );
    const before = structuredClone(journey);
    const diagnosed = diagnoseJourney(FORM, journey);
    journeyFlow(journey);
    expect(journey).toEqual(before);
    expect(diagnoseJourney(FORM, journey)).toEqual(diagnosed);
  });

  describe("agrees over a corpus of 160 journeys", () => {
    const corpus = Array.from({ length: 160 }, (_value, seed) => randomJourney(seed + 1));

    it("with diagnoseJourney: page.unreachable and journey.no-end", () => {
      let unreachable = 0;
      let noEnd = 0;
      for (const journey of corpus) {
        const flow = journeyFlow(journey);
        const diagnostics = diagnoseJourney(CORPUS_FORM, journey);
        const reported = new Set(diagnostics.filter((d) => d.code === "page.unreachable").map((d) => d.pageId));
        const drawn = new Set(flow.pages.filter((page) => !page.onPath).map((page) => page.pageId));
        expect([...drawn].sort(), JSON.stringify(journey)).toEqual([...reported].sort());
        expect(!flow.ends, JSON.stringify(journey)).toBe(diagnostics.some((d) => d.code === "journey.no-end"));
        unreachable += drawn.size;
        noEnd += flow.ends ? 0 : 1;
      }
      // The corpus exercises both findings, not only the easy cases.
      expect(unreachable).toBeGreaterThan(10);
      expect(noEnd).toBeGreaterThan(10);
    });

    it("with diagnoseJourney where pages share ids too: page.unreachable, page by page, and journey.no-end", () => {
      let repeated = 0;
      for (let seed = 1; seed <= 200; seed += 1) {
        const journey = randomJourney(seed, true);
        const flow = journeyFlow(journey);
        const diagnostics = diagnoseJourney(CORPUS_FORM, journey);
        const context = JSON.stringify(journey);
        // In page order: diagnoseJourney reports page by page.
        expect(
          flow.pages.filter((page) => !page.onPath).map((page) => page.pageId),
          context
        ).toEqual(diagnostics.filter((d) => d.code === "page.unreachable").map((d) => d.pageId));
        expect(!flow.ends, context).toBe(diagnostics.some((d) => d.code === "journey.no-end"));
        repeated += diagnostics.some((d) => d.code === "page.duplicate-id") ? 1 : 0;
      }
      expect(repeated).toBeGreaterThan(50);
    });

    it("with journeyStaticGraph: the route and next edges", () => {
      for (const journey of corpus) {
        const flow = journeyFlow(journey);
        const graph = journeyStaticGraph(journey);
        const indexOf = new Map(journey.pages.map((page, at) => [page.id, at]));
        const expected = graph.edges.map((edge) => ({
          from: indexOf.get(edge.from),
          to: edge.to === "$end" ? journey.pages.length : indexOf.get(edge.to),
          kind: edge.kind,
          routeIndex: edge.routeIndex,
          conditional: edge.conditional
        }));
        const drawn = flow.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind, routeIndex: edge.routeIndex, conditional: edge.conditional }));
        expect(drawn, JSON.stringify(journey)).toEqual(expected);
      }
    });

    it("with the path engine, every outcome tried: shown, ended, and each edge taken", () => {
      let dead = 0;
      for (const journey of corpus) {
        const flow = journeyFlow(journey);
        const expected = everyOutcome(CORPUS_FORM, journey);
        const actual = flowFacts(journey, flow);
        const context = JSON.stringify(journey);
        expect([...actual.shown].sort(), context).toEqual([...expected.shown].sort());
        expect(actual.ends, context).toBe(expected.ends);
        expect([...actual.taken].sort(), context).toEqual([...expected.taken].sort());
        dead += flow.edges.filter((edge) => !edge.live).length;
      }
      expect(dead).toBeGreaterThan(10);
    });
  });
});

describe("journeyFlow: a review page", () => {
  it("leaves only for the end, and draws none of its routes", () => {
    const journey = journeyOf(
      { id: "p1", components: ["a"], routes: [{ when: cond("a"), to: "stop" }] },
      { id: "p2", components: ["hid"] },
      { id: "check", kind: "review", routes: [{ to: "stop" }, { when: cond("a"), to: "$end" }] },
      { id: "stop", kind: "exit", components: ["note"] }
    );
    const flow = journeyFlow(journey);
    expect(flow.pages[2]).toEqual({ pageId: "check", exit: false, review: true, onPath: true });
    expect(flow.pages[1]!.review).toBeUndefined();
    expect(edgesOf(flow)).toEqual(["route:0>3#0", "next:0>1 otherwise", "next:1>2", "next:2>4"]);
    expect(flow.ignored.map((entry) => [entry.from, entry.routeIndex, entry.reason])).toEqual([
      [2, 0, "review"],
      [2, 1, "review"]
    ]);
    expect(flow.ends).toBe(true);
  });
});
