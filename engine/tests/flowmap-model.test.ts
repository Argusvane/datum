import { describe, expect, it } from "vitest";

import { checkJourneyTree, findingsSummary, indexJourneyTree } from "../form-engine/builder/journey-designer/journey-checks.js";
import { indexJourneyForm, pageName } from "../form-engine/builder/journey-designer/journey-components.js";
import { JOURNEY_PAGES_SLOT, JOURNEY_ROUTE_TYPE, JOURNEY_ROUTES_SLOT } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { treeFromJourney } from "../form-engine/builder/journey-designer/journey-tree.js";
import {
  journeyMapEdgeId,
  journeyMapGraph,
  journeyMapLayoutInput,
  journeyMapLitEdges,
  normalizeJourneyMapLayout,
  JOURNEY_MAP_METRICS,
  type JourneyMapEdge,
  type JourneyMapGraph,
  type JourneyMapPage,
  type JourneyMapSource,
  type JourneyMapTerminal,
  type JourneyMapWords
} from "../form-engine/builder/journey-map/journey-map-model.js";
import { estimateTextWidth, layoutFlow } from "../form-engine/builder/journey-map/journey-map-layout.js";
import { journeyMapSvg } from "../form-engine/builder/journey-map/journey-map-svg.js";
import { journeyFlow } from "../form-engine/core/journey/journey-flow.js";
import { conditionTerms, mapSource, mapWords } from "./flowmap-words.js";
import { applyJourney, presentationRoot, publicVariant } from "./fixtures/presentation-form.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The flow map's model: a journey from the designer's tree as the nodes, edges,
 * words and stubs the map draws, tied to the tree's node ids.
 */

function eq(path: string, value: string): Expression {
  return { kind: "binary", operator: "eq", left: { kind: "path", path }, right: { kind: "literal", value } };
}

function neq(path: string, value: string): Expression {
  return { kind: "binary", operator: "neq", left: { kind: "path", path }, right: { kind: "literal", value } };
}

// A condition the sentence cannot word: said as the printed formula.
const CUSTOM: Expression = { kind: "literal", value: true };

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "age", type: "number", configuration: { label: "Age" } },
      { id: "method", type: "radio", configuration: { label: "Contact method" } },
      { id: "name", type: "text", configuration: { label: "Full name" } },
      { id: "email", type: "text", configuration: { label: "Email" } },
      { id: "post", type: "text", configuration: { label: "Postal address" } },
      { id: "extra", type: "text", configuration: { label: "Extra" }, rules: { visibleWhen: eq("method", "post") } },
      { id: "bye", type: "html", configuration: { content: "Sorry" } }
    ]
  }
};

const FORM_INDEX = indexJourneyForm(FORM, "en");

// FORM with two more questions that may hide, for journeys with several pages that may be empty.
const HIDING_FORM: ComponentNode = {
  ...FORM,
  children: {
    content: [
      ...FORM.children!.content!,
      { id: "young", type: "text", configuration: { label: "Guardian" }, rules: { visibleWhen: eq("age", "child") } },
      { id: "old", type: "text", configuration: { label: "Pension number" }, rules: { visibleWhen: eq("age", "old") } }
    ]
  }
};

const WORDS: JourneyMapWords = {
  journeyName: "Apply",
  condition: (expression) => conditionTerms(expression, FORM_INDEX),
  pageName: (entry) => pageName(entry, FORM_INDEX, "en"),
  summary: findingsSummary
};

function viewOf(tree: ComponentNode, journeyId = "apply", form: ComponentNode = FORM): JourneyMapSource {
  return { tree, index: indexJourneyTree(tree), check: checkJourneyTree(form, tree, journeyId) };
}

function graphOf(input: Journey | ComponentNode, previous?: JourneyMapGraph, form: ComponentNode = FORM): { view: JourneyMapSource; graph: JourneyMapGraph } {
  const tree = "pages" in input ? treeFromJourney(input as Journey) : (input as ComponentNode);
  const view = viewOf(tree, "apply", form);
  const flow = view.check.journey !== undefined ? journeyFlow(view.check.journey) : undefined;
  return { view, graph: journeyMapGraph(view, flow, WORDS, previous) };
}

function pages(graph: JourneyMapGraph): JourneyMapPage[] {
  return graph.nodes.filter((node): node is JourneyMapPage => node.kind === "page");
}

function edge(graph: JourneyMapGraph, key: string): JourneyMapEdge {
  const found = graph.edges.find((candidate) => candidate.key === key);
  expect(found, key).toBeDefined();
  return found as JourneyMapEdge;
}

function pageNode(tree: ComponentNode, index: number): ComponentNode {
  return tree.children?.[JOURNEY_PAGES_SLOT]?.[index] as ComponentNode;
}

function routeNodes(tree: ComponentNode, index: number): ComponentNode[] {
  return pageNode(tree, index).children?.[JOURNEY_ROUTES_SLOT] ?? [];
}

const APPLY: Journey = {
  id: "apply",
  pages: [
    { id: "start", title: "Eligibility", components: ["age"], routes: [{ when: neq("age", "child"), to: "about" }] },
    { id: "too-young", kind: "exit", title: "Too young", components: ["bye"] },
    {
      id: "about",
      title: "About you",
      components: ["name", "method"],
      routes: [{ when: eq("method", "post"), to: "address" }, { when: CUSTOM, to: "contact" }]
    },
    { id: "contact", title: "Email", components: ["email"], routes: [{ to: "$end" }] },
    { id: "address", title: "Address", components: ["post"] },
    { id: "more", title: "Anything else", components: ["extra"] }
  ]
};

describe("journeyMapGraph", () => {
  it("lists Start, each step, then End, keyed by tree node ids: no diamond", () => {
    const { view, graph } = graphOf(APPLY);
    expect(graph.nodes.map((node) => node.key)).toEqual([
      "$start",
      "page:journey-page_1",
      "page:journey-page_2",
      "page:journey-page_3",
      "page:journey-page_4",
      "page:journey-page_5",
      "page:journey-page_6",
      "$end"
    ]);
    // List order is a topological order: every edge goes forward.
    const order = new Map(graph.nodes.map((node) => [node.key, node.order]));
    for (const candidate of graph.edges) {
      expect(order.get(candidate.from)!, candidate.key).toBeLessThan(order.get(candidate.to)!);
    }
    expect(pages(graph).map((page) => [page.item, page.select, page.number, page.pageId])).toEqual(
      view.index.pages.map((entry) => [entry.nodeId, entry.nodeId, entry.number, entry.pageId])
    );
    const [start, end] = [graph.nodes[0] as JourneyMapTerminal, graph.nodes[graph.nodes.length - 1] as JourneyMapTerminal];
    expect([start.select, start.item, end.select, end.item]).toEqual([view.tree.id, "$start", view.tree.id, "$end"]);
    // Route chips carry the route's node id; every way out leaves its step's box and goes to its
    // target's box. No step is passed over: no step has a line of its own for that.
    const routeEdge = edge(graph, "route:journey-page_3:0");
    expect(routeEdge).toMatchObject({ from: "page:journey-page_3", to: "page:journey-page_5", select: routeNodes(view.tree, 2)[0]!.id });
    expect(routeEdge.label?.item).toBe(routeNodes(view.tree, 2)[0]!.id);
    expect(edge(graph, "next:journey-page_1")).toMatchObject({ from: "page:journey-page_1", to: "page:journey-page_2" });
    expect(edge(graph, "next:journey-page_5").to).toBe("page:journey-page_6");
    // The last step's question may hide; it still goes on to End by its fall-through, as any step.
    expect(edge(graph, "next:journey-page_6")).toMatchObject({ from: "page:journey-page_6", to: "$end", kind: "next" });
    expect(graph.edges.every((candidate) => !candidate.key.startsWith("pass:"))).toBe(true);
  });

  it("names its ways by the step they leave and how: the edge ids", () => {
    const { graph } = graphOf(APPLY);
    expect(graph.edges.map((candidate) => candidate.key)).toEqual([
      "start",
      "route:journey-page_1:0",
      "next:journey-page_1",
      "route:journey-page_3:0",
      "route:journey-page_3:1",
      "next:journey-page_3",
      "route:journey-page_4:0",
      "next:journey-page_5",
      "next:journey-page_6"
    ]);
    expect(journeyMapEdgeId({ kind: "start" })).toBe("start");
    expect(journeyMapEdgeId({ kind: "route", from: "journey-page_3", routeIndex: 1 })).toBe("route:journey-page_3:1");
    expect(journeyMapEdgeId({ kind: "next", from: "journey-page_1" })).toBe("next:journey-page_1");
    // The same ids however the titles or conditions read: they follow the node ids alone.
    const renamed = structuredClone(APPLY);
    renamed.pages[0]!.title = "Who can apply";
    renamed.pages[2]!.routes![0]!.when = eq("method", "mail");
    expect(graphOf(renamed).graph.edges.map((candidate) => candidate.key)).toEqual(graph.edges.map((candidate) => candidate.key));
  });

  it("names a route by its written position, not its node: reordered, the same id names the other route", () => {
    // The ids are positional, as the runtime's decisions are, so a state
    // set by id is set again when the journey changes.
    const tree = treeFromJourney({
      id: "apply",
      pages: [
        { id: "ask", title: "Ask", components: ["method"], routes: [{ when: eq("method", "phone"), to: "c" }, { when: eq("method", "post"), to: "d" }] },
        { id: "b", title: "B", components: ["name"] },
        { id: "c", title: "C", components: ["email"] },
        { id: "d", title: "D", components: ["age"] }
      ]
    });
    const [first, second] = routeNodes(tree, 0).map((route) => route.id);
    const before = graphOf(tree).graph;
    expect([edge(before, "route:journey-page_1:0").label?.item, edge(before, "route:journey-page_1:0").to]).toEqual([first, "page:journey-page_3"]);
    // The two routes swapped in the tree, their node ids kept.
    pageNode(tree, 0).children![JOURNEY_ROUTES_SLOT]!.reverse();
    const after = graphOf(tree).graph;
    expect([edge(after, "route:journey-page_1:0").label?.item, edge(after, "route:journey-page_1:0").to]).toEqual([second, "page:journey-page_4"]);
    expect([edge(after, "route:journey-page_1:1").label?.item, edge(after, "route:journey-page_1:1").to]).toEqual([first, "page:journey-page_3"]);
  });

  it("words a read-only map's label and its '+n more' rows with nothing to select", () => {
    // A map to look at offers no Enter and no selection.
    const tree = treeFromJourney({
      id: "apply",
      pages: [
        { id: "one", components: ["age"] },
        { id: "two", components: ["name"], routes: [{ to: "two" }, { to: "one" }, { when: eq("age", "x"), to: "gone" }, { to: "three" }, { to: "$end" }] },
        { id: "three", components: ["email"] }
      ]
    });
    const view = viewOf(tree);
    const flow = journeyFlow(view.check.journey!);
    const editing = journeyMapGraph(view, flow, WORDS);
    const looking = journeyMapGraph(view, flow, { ...WORDS, readOnly: true });
    expect(editing.readOnly).toBeUndefined();
    expect(editing.label).toContain("Enter selects.");
    expect(looking.readOnly).toBe(true);
    expect(looking.label).toBe("Journey map of “Apply”: 3 steps. Tab to a step; arrow keys move between steps and their ways out.");
    const more = (graph: JourneyMapGraph): string | undefined => pages(graph)[1]!.more?.ariaLabel;
    expect(more(editing)).toMatch(/^1 more ignored route on Step 2 · [^:]+: select the step to see it\.$/);
    expect(more(looking)).toBe(more(editing)!.replace(": select the step to see it.", "."));
    // Everything else is the same map.
    expect({ ...looking, label: "", readOnly: undefined, nodes: [] }).toEqual({ ...editing, label: "", readOnly: undefined, nodes: [] });
  });

  it("words each way out as the cards do", () => {
    const { graph } = graphOf(APPLY);
    const text = (key: string): string | undefined => edge(graph, key).label?.text;
    expect(text("route:journey-page_1:0")).toBe("1 · If Age does not equal “child”");
    expect(text("next:journey-page_1")).toBe("Otherwise");
    expect(text("route:journey-page_3:0")).toBe("1 · If Contact method equals “post”");
    expect(text("route:journey-page_3:1")).toBe("2 · If true");
    expect(text("next:journey-page_3")).toBe("Otherwise");
    // A single way out: Always for a route, nothing for a fall-through.
    expect(text("route:journey-page_4:0")).toBe("Always");
    expect(text("next:journey-page_5")).toBeUndefined();
    // The fall-through of a step with no route is unlabelled.
    expect(text("next:journey-page_6")).toBeUndefined();
    expect(edge(graph, "route:journey-page_3:0").label?.ariaLabel).toBe(
      "Route 1 of Step 3 · About you: if Contact method equals “post”, goes to Step 5 · Address."
    );
    // Labels fit their chips.
    for (const candidate of graph.edges) {
      if (candidate.label) {
        const m = JOURNEY_MAP_METRICS.chip;
        expect(candidate.label.width).toBeLessThanOrEqual(m.maxWidth);
        for (const line of candidate.label.lines) {
          expect(estimateTextWidth(line, m.px)).toBeLessThanOrEqual(candidate.label.width - 2 * m.padX);
        }
      }
    }
  });

  it("draws a step with no fields as any other step, saying No fields yet, with a plain line onward", () => {
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "one", components: ["age"] },
        { id: "nothing" },
        { id: "last", components: ["name"] }
      ]
    });
    expect(graph.edges.map((candidate) => candidate.key)).toEqual(["start", "next:journey-page_1", "next:journey-page_2", "next:journey-page_3"]);
    expect(edge(graph, "next:journey-page_2")).toMatchObject({ kind: "next", to: "page:journey-page_3", live: true, spine: true, otherwise: false });
    expect(edge(graph, "next:journey-page_2").label).toBeUndefined();
    const nothing = pages(graph)[1]!;
    expect(nothing).toMatchObject({ unreachable: false, notes: ["No fields yet"] });
    expect("empty" in nothing || "mayPass" in nothing).toBe(false);
    expect(nothing.description).toMatch(/^Step 2 of 3, nothing, id nothing, 0 questions\. It has no fields yet, so it shows only its buttons\. Then to Step 3 · Full name\./);
    // Only a step with nothing on it says so; no card speaks of being passed over.
    expect(pages(graph).map((page) => page.notes)).toEqual([[], ["No fields yet"], []]);
    expect(pages(graph).some((page) => /passed over/i.test(page.description))).toBe(false);
    // Drawn as any other step: no dashed outline, no pass-by line.
    const svg = journeyMapSvg(graph, layoutFlow(journeyMapLayoutInput(graph, normalizeJourneyMapLayout(undefined))));
    expect(svg).not.toContain("is-empty");
    expect(svg).not.toContain("jm-edge--pass");
    expect(svg).not.toContain("If nothing on it shows");
  });

  it("draws a step whose fields may all hide as any other: one line onward, never a second", () => {
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "one", components: ["age"] },
        { id: "both", components: ["extra"] },
        { id: "last", components: ["name"] }
      ]
    });
    expect(graph.edges.map((candidate) => candidate.key)).toEqual(["start", "next:journey-page_1", "next:journey-page_2", "next:journey-page_3"]);
    expect(pages(graph)[1]).toMatchObject({ notes: [] });
    expect(pages(graph)[1]!.description).toBe("Step 2 of 3, Extra, id both, 1 question. Then to Step 3 · Full name.");
    expect(graph.edges.some((candidate) => "alsoPass" in candidate)).toBe(false);
    // A conditional route before its fall-through: Otherwise, and nothing more.
    const { graph: routed } = graphOf({
      id: "apply",
      pages: [
        { id: "one", components: ["age"] },
        { id: "both", components: ["extra"], routes: [{ when: eq("extra", "x"), to: "last" }] },
        { id: "mid", components: ["email"] },
        { id: "last", components: ["name"] }
      ]
    });
    expect(routed.edges.filter((candidate) => candidate.from === "page:journey-page_2").map((candidate) => candidate.key)).toEqual(["route:journey-page_2:0", "next:journey-page_2"]);
    expect(edge(routed, "next:journey-page_2")).toMatchObject({ to: "page:journey-page_3", otherwise: true });
  });

  it("draws a lone rule with no condition as a small handle with no words", () => {
    const { graph } = graphOf({ id: "apply", pages: [{ id: "one", components: ["age"], routes: [{ to: "two" }] }, { id: "two", components: ["name"] }] });
    const lone = edge(graph, "route:journey-page_1:0");
    expect(lone.label).toMatchObject({ lines: [], width: JOURNEY_MAP_METRICS.chip.handle, height: JOURNEY_MAP_METRICS.chip.handle, text: "Always" });
    // Still the route's item: a click on it opens the rule.
    expect(lone.label?.item).toBeDefined();
    expect(lone.label?.ariaLabel).toContain("always");
    // A step whose fields may all hide is no different; a step with a second way keeps its words.
    const { graph: may } = graphOf({ id: "apply", pages: [{ id: "one", components: ["extra"], routes: [{ to: "two" }] }, { id: "two", components: ["name"] }] });
    expect(edge(may, "route:journey-page_1:0").label).toMatchObject({ lines: [], text: "Always" });
    const { graph: numbered } = graphOf({ id: "apply", pages: [{ id: "one", components: ["age"], routes: [{ when: eq("age", "x"), to: "two" }, { to: "two" }] }, { id: "two", components: ["name"] }] });
    expect(edge(numbered, "route:journey-page_1:1").label?.lines.length).toBeGreaterThan(0);
  });

  it("flags the main line: the fall-through, else the route that always matches, through a step with no fields too", () => {
    const { graph } = graphOf(APPLY);
    const spine = graph.edges.filter((candidate) => candidate.spine).map((candidate) => candidate.key);
    expect(spine).toEqual(["start", "next:journey-page_1", "next:journey-page_3", "route:journey-page_4:0", "next:journey-page_5", "next:journey-page_6"]);
    // A step with no fields: its own way on, as any step.
    const { graph: never } = graphOf({ id: "apply", pages: [{ id: "one", components: ["age"] }, { id: "nothing" }, { id: "last", components: ["name"] }] });
    expect(never.edges.filter((candidate) => candidate.spine).map((candidate) => candidate.key)).toEqual(["start", "next:journey-page_1", "next:journey-page_2", "next:journey-page_3"]);
  });

  it("numbers routes as written, so a route with no target yet has no number and the findings agree", () => {
    const tree = treeFromJourney({
      id: "apply",
      pages: [
        { id: "one", components: ["method"], routes: [{ when: eq("method", "post"), to: "three" }, { to: "four" }, { to: "two" }] },
        { id: "two", components: ["name"] },
        { id: "three", components: ["post"] },
        { id: "four", components: ["email"] }
      ]
    });
    // A route with no target between the conditional route and the one that always matches.
    const routes = pageNode(tree, 0).children![JOURNEY_ROUTES_SLOT]!;
    routes.splice(1, 0, { id: "journey-route_9", type: JOURNEY_ROUTE_TYPE, configuration: { to: "" } });
    const { view, graph } = graphOf(tree);
    expect(edge(graph, "route:journey-page_1:0").label?.text).toBe("1 · If Contact method equals “post”");
    expect(edge(graph, "route:journey-page_1:1").label?.text).toBe("2 · Otherwise");
    const one = pages(graph)[0]!;
    expect(one.stubs.map((stub) => [stub.item, stub.reason, stub.number, stub.text])).toEqual([
      ["journey-route_9", "no-target", undefined, "⊘ no target yet"],
      [routes[3]!.id, "shadowed", 3, "⊘ 3 · never tried: 2 always wins"]
    ]);
    // The finding on the shadowed route names the same numbers.
    expect(view.check.findings.byNode.get(routes[3]!.id)?.map((finding) => finding.message)).toEqual([
      'Route 3 of page "one" can never be taken: route 2 before it always matches.'
    ]);
  });

  it("draws every route the walk never takes as a stub, three at most, then one that selects the page", () => {
    const tree = treeFromJourney({
      id: "apply",
      pages: [
        { id: "one", components: ["age"] },
        {
          id: "two",
          components: ["name"],
          routes: [{ to: "two" }, { to: "one" }, { when: eq("age", "x"), to: "gone" }, { to: "three" }, { to: "$end" }]
        },
        { id: "three", kind: "exit", components: ["bye"], routes: [{ to: "$end" }] }
      ]
    });
    const two = routeNodes(tree, 1).map((route) => route.id);
    const three = routeNodes(tree, 2).map((route) => route.id);
    const { graph } = graphOf(tree);
    const [, twoPage, threePage] = pages(graph);
    expect(twoPage!.stubs.map((stub) => [stub.item, stub.reason, stub.severity, stub.fullText])).toEqual([
      [two[0], "self", "error", "⊘ 1 · to this step: ignored"],
      [two[1], "backward", "error", "⊘ 2 · back to Step 1: ignored"],
      [two[2], "unknown-target", "error", "⊘ 3 · missing step “gone”"],
      [two[4], "shadowed", "warning", "⊘ 5 · never tried: 4 always wins"]
    ]);
    expect(twoPage!.rows.stubs).toHaveLength(4);
    expect(twoPage!.more).toMatchObject({ item: "more:journey-page_2", text: "+1 more" });
    expect(threePage!.stubs.map((stub) => [stub.item, stub.reason, stub.fullText])).toEqual([[three[0], "exit", "⊘ 1 · ignored on an exit step"]]);
    expect(threePage!.more).toBeUndefined();
    // Its only drawn way out still says its number: the stub below says "4 always wins".
    expect(edge(graph, "route:journey-page_2:3").label).toMatchObject({ text: "4 · Always", item: two[3] });
    // Reading order: each page, its route chips, the stubs it shows, then its "+n more".
    expect(graph.readingOrder).toEqual([
      "$start",
      "journey-page_1",
      "journey-page_2",
      two[3],
      two[0],
      two[1],
      two[2],
      "more:journey-page_2",
      "journey-page_3",
      three[0],
      "$end"
    ]);
    // The card grows by a row for each stub it shows.
    const m = JOURNEY_MAP_METRICS.card;
    expect(twoPage!.height).toBe(m.top + m.titleLine + m.metaLine + m.stubGap + 4 * m.stubLine + m.bottom);
    for (const stub of twoPage!.stubs) {
      expect(stub.text).toBe(stub.fullText);
    }
  });

  it("rolls a page's questions' findings up into its badge", () => {
    const { view, graph } = graphOf({
      id: "apply",
      pages: [
        { id: "one", title: "One", components: ["age", "gone"] },
        { id: "two", title: "Two", components: ["age"] }
      ]
    });
    const [one, two] = pages(graph);
    // page.unknown-component on the first page's second question; component.multiple-pages on both questions listing age.
    expect(one!.findings).toEqual({ errors: 1, warnings: 1 });
    expect(one).toMatchObject({ badge: "▲ 2", badgeSeverity: "error" });
    expect(two).toMatchObject({ findings: { errors: 0, warnings: 1 }, badge: "▲ 1", badgeSeverity: "warning" });
    expect(one!.description).toContain("1 error, 1 warning.");
    expect(graph.counts).toMatchObject({ errors: view.check.findings.errors, warnings: view.check.findings.warnings });
  });

  it("rolls the findings on a page's own nodes up into its badge, however deep in a layout of its own", () => {
    const { view, graph } = graphOf({
      id: "apply",
      pages: [
        {
          id: "one",
          title: "One",
          components: [
            "age",
            { id: "box", type: "fieldset", configuration: { label: "Box" }, children: { content: [{ id: "inner", type: "fieldset", children: { content: [{ type: "journey-field", configuration: { componentId: "gone" } }] } }] } }
          ]
        },
        { id: "two", title: "Two", components: ["name"] }
      ]
    } as unknown as Journey);
    const [one, two] = pages(graph);
    // The reference naming no component is said on the layout holding it, and counted for its page:
    // the badge counts every finding on the page and on anything in it.
    const onOwn = [...view.check.findings.byNode].filter(([nodeId]) => nodeId === "box" || nodeId === "inner").flatMap(([, list]) => list);
    expect(onOwn.length).toBeGreaterThan(0);
    const onPage = [...view.check.findings.byNode].filter(([nodeId]) => view.index.pageOf.get(nodeId)?.number === 1).flatMap(([, list]) => list);
    expect(one!.findings).toEqual({
      errors: onPage.filter((finding) => finding.severity === "error").length,
      warnings: onPage.filter((finding) => finding.severity === "warning").length
    });
    expect(onPage).toEqual(expect.arrayContaining(onOwn));
    expect(two!.findings).toEqual({ errors: 0, warnings: 0 });
  });

  it("describes each page in sentences: how it leaves, what is ignored", () => {
    const { graph } = graphOf(APPLY);
    const [start, tooYoung, about, contact] = pages(graph);
    expect(start!.description).toBe(
      "Step 1 of 6, Eligibility, id start, 1 question. Leaves by: 1, if Age does not equal “child”, to Step 3 · About you; otherwise to Step 2 · Too young."
    );
    expect(tooYoung!.description).toBe("Step 2 of 6, Too young, id too-young, an exit step. The journey stops here.");
    expect(about!.description).toBe(
      "Step 3 of 6, About you, id about, 2 questions. Leaves by: 1, if Contact method equals “post”, to Step 5 · Address; 2, if true, to Step 4 · Email; otherwise to Step 4 · Email."
    );
    expect(contact!.description).toBe("Step 4 of 6, Email, id contact, 1 question. Leaves by: 1, always, to the end, which submits.");
    expect(tooYoung).toMatchObject({ exit: true, notes: ["Exit · stops here"], meta: "too-young · exit step" });
    // Steps 1 and 3 each decide something: two branch points.
    expect(graph.status).toBe("6 steps · 1 exit · 2 branch points");
    expect(graph.label).toBe(
      "Journey map of “Apply”: 6 steps, 1 exit. Tab to a step; arrow keys move between steps and their ways out; Enter selects."
    );
  });

  it("marks a page no path reaches, and End when no path submits", () => {
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "one", components: ["age"], routes: [{ to: "stop" }] },
        { id: "lost", components: ["name"] },
        { id: "stop", kind: "exit", components: ["bye"] }
      ]
    });
    expect(pages(graph)[1]).toMatchObject({ unreachable: true, notes: ["No path reaches this step"] });
    expect(edge(graph, "next:journey-page_2").live).toBe(false);
    const end = graph.nodes[graph.nodes.length - 1] as JourneyMapTerminal;
    expect(end).toMatchObject({ failing: true, text: "No path submits", width: JOURNEY_MAP_METRICS.pill.wideWidth });
  });

  it("keeps two pages sharing an id apart", () => {
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "A", components: ["age"], routes: [{ to: "C" }] },
        { id: "B", components: ["name"] },
        { id: "A", components: ["email"] },
        { id: "C", components: ["post"] }
      ]
    });
    expect(pages(graph).map((page) => [page.key, page.pageId, page.unreachable])).toEqual([
      ["page:journey-page_1", "A", false],
      ["page:journey-page_2", "B", true],
      ["page:journey-page_3", "A", true],
      ["page:journey-page_4", "C", false]
    ]);
    expect(edge(graph, "route:journey-page_1:0").to).toBe("page:journey-page_4");
  });

  it("draws a page written from outside the pages slot, but cannot select it", () => {
    const tree = treeFromJourney({ id: "apply", pages: [{ id: "one", components: ["age"] }] });
    const stray: ComponentNode = { id: "journey-page_9", type: "journey-page", configuration: { pageId: "stray" }, children: { content: [], routes: [] } };
    tree.children = { ...tree.children, other: [stray] };
    const { graph } = graphOf(tree);
    const straying = pages(graph)[1]!;
    expect(straying).toMatchObject({ key: "page:#2", pageId: "stray", name: "stray", number: 2 });
    expect(straying.item).toBeUndefined();
    expect(straying.select).toBeUndefined();
    expect(graph.readingOrder).not.toContain("page:#2");
  });

  it("draws Start straight to a failing End for a journey with no pages", () => {
    const { graph } = graphOf({ id: "apply", pages: [] });
    expect(graph.nodes.map((node) => node.key)).toEqual(["$start", "$end"]);
    expect(graph.edges).toEqual([
      { key: "start", from: "$start", to: "$end", kind: "start", order: 0, weight: 3, spine: true, live: false, conditional: false, otherwise: false }
    ]);
    expect(graph.nodes[1]).toMatchObject({ failing: true, text: "No path submits" });
    expect(graph.status).toMatch(/^0 steps · 1 error, \d+ warnings$/);
  });

  it("keeps the last graph while the tree cannot be written, without the nodes it has lost", () => {
    const { view, graph: before } = graphOf(APPLY);
    const tree = structuredClone(view.tree);
    // The third page is deleted and the first is given a condition of its own, which no page may
    // have: the tree cannot be written.
    tree.children![JOURNEY_PAGES_SLOT]!.splice(2, 1);
    (pageNode(tree, 0).configuration as Record<string, unknown>).when = 7;
    const { graph } = graphOf(tree, before);
    expect(graph.stale).toBe(true);
    expect(graph.problem).toContain("cannot be saved as it stands");
    expect(graph.nodes.map((node) => node.key)).toEqual(before.nodes.map((node) => node.key));
    const lost = pages(graph)[2]!;
    expect(lost.select).toBeUndefined();
    expect(lost.item).toBeUndefined();
    expect(edge(graph, "route:journey-page_3:0").select).toBeUndefined();
    expect(edge(graph, "route:journey-page_3:0").label?.item).toBeUndefined();
    // Its fall-through is still drawn, and selects nothing either; a step still there keeps its fall-through's.
    expect(edge(graph, "next:journey-page_3")).toMatchObject({ from: "page:journey-page_3" });
    expect(edge(graph, "next:journey-page_3").select).toBeUndefined();
    expect(edge(graph, "next:journey-page_6").select).toBe("journey-page_6");
    expect(graph.readingOrder).not.toContain("journey-page_3");
    expect(pages(graph)[0]!.select).toBe("journey-page_1");
    // With no graph before it: the pages alone, no edges.
    const { graph: first } = graphOf(tree);
    expect(first).toMatchObject({ stale: true, edges: [] });
    expect(pages(first).map((page) => page.key)).toEqual(["page:journey-page_1", "page:journey-page_2", "page:journey-page_4", "page:journey-page_5", "page:journey-page_6"]);
  });

  it("numbers a lone route only when the page has more than one", () => {
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "one", components: ["age"], routes: [{ to: "three" }] },
        { id: "two", components: ["name"] },
        { id: "three", components: ["email"], routes: [{ to: "$end" }, { to: "two" }] }
      ]
    });
    expect(edge(graph, "route:journey-page_1:0").label?.text).toBe("Always");
    expect(edge(graph, "route:journey-page_3:0").label?.text).toBe("1 · Always");
  });

  it("cuts a chip's question labels rather than the answer that takes the way", () => {
    const form: ComponentNode = {
      ...FORM,
      children: {
        content: [
          ...(FORM.children!.content ?? []),
          { id: "home", type: "radio", configuration: { label: "Do you live in this home most of the year?" } },
          { id: "tenure", type: "radio", configuration: { label: "Do you own the home or rent it, or something else again?" } },
          { id: "maybe", type: "text", configuration: { label: "Maybe" }, rules: { visibleWhen: eq("home", "yes") } }
        ]
      }
    };
    const formIndex = indexJourneyForm(form, "en");
    const words: JourneyMapWords = { ...WORDS, condition: (expression) => conditionTerms(expression, formIndex) };
    const tree = treeFromJourney({
      id: "apply",
      pages: [
        // The energy rebate's first page (site/src/demo-forms.ts): not the home they live in, straight to the exit.
        {
          id: "home",
          components: ["home"],
          routes: [
            { when: eq("home", "no"), to: "ineligible" },
            { when: { kind: "logical", operator: "and", left: eq("home", "yes"), right: eq("tenure", "rent") }, to: "long" }
          ]
        },
        { id: "both", components: ["maybe"] },
        {
          id: "long",
          components: ["name"],
          routes: [
            { when: eq("home", "a really long value that nobody would ever type into a field"), to: "ineligible" },
            { when: eq("home", "a value so long that no chip could ever hold it, however short its question, however many lines it took"), to: "work" }
          ]
        },
        { id: "work", components: ["email"], routes: [{ to: "$end" }] },
        { id: "ineligible", kind: "exit", components: ["bye"] }
      ]
    });
    const view = { tree, index: indexJourneyTree(tree), check: checkJourneyTree(form, tree, "apply") };
    const graph = journeyMapGraph(view, journeyFlow(view.check.journey!), words);
    const m = JOURNEY_MAP_METRICS.chip;
    const home = edge(graph, "route:journey-page_1:0").label!;
    expect(home.text).toBe("1 · If Do you live in this home most of the year? equals “no”");
    expect(home.lines).toHaveLength(2);
    expect(home.lines.join(" ")).toMatch(/^1 · If Do you live in this home[^“]*… equals “no”$/);
    // Both terms of a route's condition keep their tests, whatever the labels are cut to.
    const both = edge(graph, "route:journey-page_1:1").label!;
    expect(both.lines.length).toBeLessThanOrEqual(3);
    expect(both.lines.join(" ")).toMatch(/^2 · If Do.*… equals “yes” and Do.*… equals “rent”$/);
    // A long value keeps every word, on a third line.
    const long = edge(graph, "route:journey-page_3:0").label!;
    expect(long.lines.join(" ")).toMatch(/… equals “a really long value that nobody would ever type into a field”$/);
    // One too long for three lines even so: then, and only then, the end goes.
    const longest = edge(graph, "route:journey-page_3:1").label!;
    expect(longest.lines).toHaveLength(3);
    expect(longest.lines[2]!.endsWith("…")).toBe(true);
    for (const label of [home, both, long, longest]) {
      expect(label.width).toBeLessThanOrEqual(m.maxWidth);
      for (const line of label.lines) {
        expect(estimateTextWidth(line, m.px)).toBeLessThanOrEqual(label.width - 2 * m.padX);
      }
    }
    // The words in full stay in the sentences.
    expect(pages(graph)[0]!.description).toContain("1, if Do you live in this home most of the year? equals “no”, to Step 5");
  });

  it("says why a page sharing its id shows what it shows", () => {
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "A", components: ["age"] },
        { id: "A" },
        { id: "C", components: ["name"] }
      ]
    });
    const [first, second] = pages(graph);
    // The runtime shows both with the questions of the last page with the id: none. Both are shown.
    expect(first).toMatchObject({ notes: ["Shows Step 2's questions"] });
    expect(first!.description).toContain("It shares its id with Step 2 · A, so it shows that step's questions.");
    expect(second).toMatchObject({ notes: ["No fields yet"] });
    expect(edge(graph, "next:journey-page_1")).toMatchObject({ spine: true, live: true, to: "page:journey-page_2" });
    expect(edge(graph, "next:journey-page_2")).toMatchObject({ spine: true, live: true, to: "page:journey-page_3" });
    expect(graph.edges.every((candidate) => !candidate.key.startsWith("pass:"))).toBe(true);
  });

  it("counts no branch point for a step with nothing on it, or fields that may all hide", () => {
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "one", components: ["age"], routes: [{ to: "four" }] },
        { id: "nothing" },
        { id: "lost", components: ["extra"] },
        { id: "four", components: ["email"] }
      ]
    });
    // Step 1 always goes to step 4: steps 2 and 3 are off the path, their one line each dead.
    expect(graph.edges.every((candidate) => !candidate.key.startsWith("pass:"))).toBe(true);
    expect(pages(graph).map((page) => page.unreachable)).toEqual([false, true, true, false]);
    expect(graph.counts.branchPoints).toBe(0);
    expect(graph.status).toMatch(/^4 steps · /);
    expect(graph.status).not.toContain("branch point");
  });

  it("words a route on a Check answers step as its own reason, not as one that is shadowed", () => {
    const tree = treeFromJourney({
      id: "apply",
      pages: [
        { id: "one", components: ["age"] },
        { id: "check", kind: "review", components: [], routes: [{ to: "$end" }] }
      ]
    });
    const { graph } = graphOf(tree);
    const [, check] = pages(graph);
    expect(check!.stubs.map((stub) => [stub.reason, stub.severity, stub.fullText])).toEqual([["review", "note", "⊘ 1 · ignored on a Check answers step"]]);
    expect(check!.stubs[0]!.ariaLabel).toContain("a Check answers step leaves only for the end");
  });

  it("says a Check answers step is one and how many answers it lists, from the words the designer lends", () => {
    const tree = treeFromJourney({
      id: "apply",
      pages: [
        { id: "one", components: ["age"] },
        { id: "check", kind: "review", components: [] }
      ]
    });
    const view = viewOf(tree);
    const flow = view.check.journey !== undefined ? journeyFlow(view.check.journey) : undefined;
    const withCount = journeyMapGraph(view, flow, { ...WORDS, listed: () => 7 });
    const [one, check] = pages(withCount);
    // The card's line is cut to the card; its sentence (the aria-label) says it whole.
    expect(check!.meta).toContain("Check answers");
    expect(check!.description).toContain("a Check answers step listing 7 answers");
    // A step that asks questions says nothing of the sort, whatever the words lend.
    expect(one!.meta).not.toContain("Check answers");
    // One answer reads in the singular; with no count lent the card says only what the step is.
    expect(pages(journeyMapGraph(view, flow, { ...WORDS, listed: () => 1 }))[1]!.description).toContain("a Check answers step listing 1 answer");
    const plain = pages(journeyMapGraph(view, flow, WORDS))[1]!;
    expect(plain.meta).toContain("Check answers");
    expect(plain.description).not.toContain("listed");
    expect(plain.description).toContain("a Check answers step");
  });

  it("wraps a card's caption under the title rather than cutting it with an ellipsis, and the card grows by the lines it takes", () => {
    const tree = treeFromJourney({
      id: "apply",
      pages: [
        { id: "one", components: ["age"] },
        { id: "check", kind: "review", components: [] }
      ]
    });
    const view = viewOf(tree);
    const flow = view.check.journey !== undefined ? journeyFlow(view.check.journey) : undefined;
    const graph = journeyMapGraph(view, flow, { ...WORDS, listed: () => 7 });
    const [one, check] = pages(graph);
    const card = JOURNEY_MAP_METRICS.card;
    // "check · Check answers · 7 listed" is wider than the card: two lines, every word kept.
    expect(check!.metaLines.length).toBeGreaterThan(1);
    expect(check!.metaLines.join(" ")).toBe(check!.meta);
    expect(check!.metaLines.join("")).not.toContain("…");
    expect(check!.height).toBe(
      Math.max(card.minHeight, card.top + check!.titleLines.length * card.titleLine + check!.metaLines.length * card.metaLine + check!.notes.length * card.noteLine + card.bottom)
    );
    expect(check!.rows.notes.every((baseline) => baseline > check!.rows.meta + (check!.metaLines.length - 1) * card.metaLine)).toBe(true);
    // A caption that fits is one line, the whole of it.
    expect(one!.metaLines).toEqual([one!.meta]);
    // The picture draws each line where the rows put it; one line stays one text, as it always was.
    const svg = journeyMapSvg(graph, layoutFlow(journeyMapLayoutInput(graph, { direction: "down" })));
    for (const line of check!.metaLines) {
      expect(svg).toContain(`>${line}</tspan>`);
    }
    expect(svg).toContain(`<text class="jm-node__meta" x="${card.titleX}" y="${one!.rows.meta}">${one!.meta}</text>`);
  });

  it("mutes the stubs no finding speaks of: a route on an exit step, a route with no target yet", () => {
    const tree = treeFromJourney({
      id: "apply",
      pages: [
        { id: "one", components: ["age"] },
        { id: "stop", kind: "exit", components: ["bye"], routes: [{ to: "$end" }, { to: "$end" }] }
      ]
    });
    (pageNode(tree, 0).children![JOURNEY_ROUTES_SLOT] ??= []).push({ id: "journey-route_9", type: JOURNEY_ROUTE_TYPE, configuration: { to: "" } });
    const { view, graph } = graphOf(tree);
    const [one, stop] = pages(graph);
    expect(one!.stubs.map((stub) => [stub.reason, stub.severity])).toEqual([["no-target", "note"]]);
    // On an exit step, the second route is shadowed too, which a finding says.
    expect(stop!.stubs.map((stub) => [stub.reason, stub.severity])).toEqual([
      ["exit", "note"],
      ["exit", "warning"]
    ]);
    const routes = routeNodes(tree, 1).map((route) => route.id);
    expect(view.check.findings.byNode.get(routes[0]!)).toBeUndefined();
    expect(view.check.findings.byNode.get(routes[1]!)?.map((finding) => finding.code)).toEqual(["route.shadowed"]);
  });

  it("hands the layout the graph's sizes, orders, weights and main line", () => {
    const { graph } = graphOf(APPLY);
    const input = journeyMapLayoutInput(graph, { direction: "right" });
    expect(input).toMatchObject({ direction: "right" });
    expect(Object.keys(input).sort()).toEqual(["direction", "edges", "nodes"]);
    expect(input.nodes.map((node) => node.shape)).toEqual(["pill", "box", "box", "box", "box", "box", "box", "pill"]);
    expect(input.edges.filter((candidate) => candidate.spine)).toHaveLength(6);
    expect(input.edges.find((candidate) => candidate.key === "route:journey-page_3:0")?.label).toEqual({
      width: edge(graph, "route:journey-page_3:0").label!.width,
      height: edge(graph, "route:journey-page_3:0").label!.height
    });
  });

  it("reads any stored layout as down unless it says otherwise", () => {
    expect(normalizeJourneyMapLayout(undefined)).toEqual({ direction: "down" });
    expect(normalizeJourneyMapLayout({ direction: "right", arrange: "list" })).toEqual({ direction: "right" });
    expect(normalizeJourneyMapLayout({ direction: "up", arrange: 3 })).toEqual({ direction: "down" });
  });
});

/** A node's ways out in try order: each line's key and what its chip says. */
function waysOut(graph: JourneyMapGraph, from: string): Array<[string, string | undefined]> {
  return graph.edges
    .filter((candidate) => candidate.from === from)
    .sort((a, b) => a.order - b.order)
    .map((candidate) => [candidate.key, candidate.label?.text]);
}

/** The main line from Start: at each node, its first way out flagged `spine`. */
function mainLine(graph: JourneyMapGraph): string[] {
  const keys: string[] = [];
  let at = "$start";
  for (;;) {
    const on = graph.edges.filter((candidate) => candidate.from === at && candidate.spine).sort((a, b) => a.order - b.order)[0];
    if (!on) {
      return keys;
    }
    keys.push(on.key);
    at = on.to;
  }
}

/**
 * What holds of every map: there is no diamond, every line runs forward between two nodes that
 * are drawn, a step's ways out are numbered 0, 1, 2, … in try order and are its routes and its
 * fall-through only (no step is passed over), and every line has an id of its own.
 */
function expectNoDiamonds(graph: JourneyMapGraph): void {
  const order = new Map(graph.nodes.map((node) => [node.key, node.order]));
  expect(graph.nodes.every((node) => node.kind === "start" || node.kind === "page" || node.kind === "end")).toBe(true);
  for (const candidate of graph.edges) {
    expect(order.has(candidate.from), `${candidate.key} leaves ${candidate.from}`).toBe(true);
    expect(order.has(candidate.to), `${candidate.key} goes to ${candidate.to}`).toBe(true);
    expect(order.get(candidate.from)!, candidate.key).toBeLessThan(order.get(candidate.to)!);
  }
  for (const page of pages(graph)) {
    const out = graph.edges.filter((candidate) => candidate.from === page.key).sort((a, b) => a.order - b.order);
    expect(out.map((candidate) => candidate.order), page.key).toEqual(out.map((_candidate, index) => index));
    expect(out.every((candidate) => candidate.kind === "route" || candidate.kind === "next"), page.key).toBe(true);
    expect(out.filter((candidate) => candidate.kind === "next").length, page.key).toBeLessThanOrEqual(1);
  }
  expect(new Set(graph.edges.map((candidate) => candidate.key)).size).toBe(graph.edges.length);
}

/** A demo journey's shape: a route, then a page whose one question may hide. */
const DEMO: Journey = {
  id: "apply",
  pages: [
    { id: "about", title: "About you", components: ["name"] },
    { id: "contact", title: "Contact", components: ["method"], routes: [{ when: eq("method", "phone"), to: "details" }] },
    { id: "address", title: "Address", components: ["extra"] },
    { id: "updates", title: "Updates", components: ["email"] },
    { id: "details", title: "Details", components: ["age"] }
  ]
};

describe("journeyMapGraph: every way leaves its step's box (no diamonds)", () => {
  it("draws a route and the fall-through as ways out of their own steps", () => {
    const { view, graph } = graphOf(DEMO);
    expectNoDiamonds(graph);
    expect(graph.nodes.map((node) => node.key)).toEqual([
      "$start",
      "page:journey-page_1",
      "page:journey-page_2",
      "page:journey-page_3",
      "page:journey-page_4",
      "page:journey-page_5",
      "$end"
    ]);
    // Step 2's two ways leave its box: the route, numbered, then Otherwise into step 3.
    expect(waysOut(graph, "page:journey-page_2")).toEqual([
      ["route:journey-page_2:0", "1 · If Contact method equals “phone”"],
      ["next:journey-page_2", "Otherwise"]
    ]);
    const route = routeNodes(view.tree, 1)[0]!.id;
    expect(edge(graph, "route:journey-page_2:0")).toMatchObject({ to: "page:journey-page_5", kind: "route", conditional: true, spine: false, routeIndex: 0, select: route });
    expect(edge(graph, "route:journey-page_2:0").label).toMatchObject({ item: route });
    expect(edge(graph, "next:journey-page_2")).toMatchObject({ to: "page:journey-page_3", kind: "next", otherwise: true, spine: true, live: true, select: "journey-page_2" });
    // Step 3's question may hide; it is shown all the same, and goes on by its one unlabelled line.
    expect(waysOut(graph, "page:journey-page_3")).toEqual([["next:journey-page_3", undefined]]);
    expect(graph.edges.every((candidate) => !candidate.key.startsWith("pass:"))).toBe(true);
    // The main line runs from box to box.
    expect(mainLine(graph)).toEqual(["start", "next:journey-page_1", "next:journey-page_2", "next:journey-page_3", "next:journey-page_4", "next:journey-page_5"]);
    // One decision: step 2's route. Whether anything on step 3 shows decides nothing: it goes on to step 4 either way.
    expect(graph.counts.branchPoints).toBe(1);
    expect(graph.status).toMatch(/^5 steps · 1 branch point( ·|$)/);
    const [, contact, address] = pages(graph);
    expect(contact!.description).toBe(
      "Step 2 of 5, Contact, id contact, 1 question. Leaves by: 1, if Contact method equals “phone”, to Step 5 · Details; otherwise to Step 3 · Address."
    );
    expect(address!.description).toBe("Step 3 of 5, Address, id address, 1 question. Then to Step 4 · Updates.");
    // The reading order is the cards, the route's chip, End.
    expect(graph.readingOrder).toEqual(["$start", "journey-page_1", "journey-page_2", route, "journey-page_3", "journey-page_4", "journey-page_5", "$end"]);
  });

  it("gives a step with three routes and a fall-through four ways out of its box, numbered as written", () => {
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "ask", title: "Ask", components: ["method"], routes: [{ when: eq("method", "phone"), to: "c" }, { when: eq("method", "post"), to: "d" }, { when: CUSTOM, to: "$end" }] },
        { id: "b", title: "B", components: ["name"] },
        { id: "c", title: "C", components: ["email"] },
        { id: "d", title: "D", components: ["post"] }
      ]
    });
    expectNoDiamonds(graph);
    expect(waysOut(graph, "page:journey-page_1")).toEqual([
      ["route:journey-page_1:0", "1 · If Contact method equals “phone”"],
      ["route:journey-page_1:1", "2 · If Contact method equals “post”"],
      ["route:journey-page_1:2", "3 · If true"],
      ["next:journey-page_1", "Otherwise"]
    ]);
    expect(edge(graph, "next:journey-page_1")).toMatchObject({ to: "page:journey-page_2", kind: "next", spine: true, otherwise: true });
    expect(edge(graph, "route:journey-page_1:2").to).toBe("$end");
    expect(graph.counts.branchPoints).toBe(1);
    expect(pages(graph)[0]!.description).toBe(
      "Step 1 of 4, Ask, id ask, 1 question. Leaves by: 1, if Contact method equals “phone”, to Step 3 · C; 2, if Contact method equals “post”, to Step 4 · D; 3, if true, to the end, which submits; otherwise to Step 2 · B."
    );
  });

  it("draws a step whose question may hide the same however many ways lead into it", () => {
    // An earlier step routes to the step whose question may hide, as well as the fall-through before it.
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "start", title: "Start", components: ["name"], routes: [{ when: eq("name", "x"), to: "address" }] },
        { id: "contact", title: "Contact", components: ["method"], routes: [{ when: eq("method", "phone"), to: "details" }] },
        { id: "address", title: "Address", components: ["extra"] },
        { id: "updates", title: "Updates", components: ["email"] },
        { id: "details", title: "Details", components: ["age"] }
      ]
    });
    expectNoDiamonds(graph);
    expect(waysOut(graph, "page:journey-page_2")).toEqual([
      ["route:journey-page_2:0", "1 · If Contact method equals “phone”"],
      ["next:journey-page_2", "Otherwise"]
    ]);
    expect(edge(graph, "next:journey-page_2").to).toBe("page:journey-page_3");
    expect(edge(graph, "route:journey-page_1:0").to).toBe("page:journey-page_3");
    // Its way out: an unlabelled fall-through.
    expect(waysOut(graph, "page:journey-page_3")).toEqual([["next:journey-page_3", undefined]]);
    expect(pages(graph)[1]!.description).toContain("Leaves by: 1, if Contact method equals “phone”, to Step 5 · Details; otherwise to Step 3 · Address.");
    // Each a decision: the first step's route and the second's.
    expect(graph.counts.branchPoints).toBe(2);

    // The same with the step's own second route as the other way in: one branch point.
    const own = graphOf({
      id: "apply",
      pages: [
        { id: "contact", title: "Contact", components: ["method"], routes: [{ when: eq("method", "phone"), to: "details" }, { when: CUSTOM, to: "address" }] },
        { id: "address", title: "Address", components: ["extra"] },
        { id: "updates", title: "Updates", components: ["email"] },
        { id: "details", title: "Details", components: ["age"] }
      ]
    }).graph;
    expectNoDiamonds(own);
    expect(waysOut(own, "page:journey-page_1").map(([key]) => key)).toEqual(["route:journey-page_1:0", "route:journey-page_1:1", "next:journey-page_1"]);
    expect(waysOut(own, "page:journey-page_2").map(([key]) => key)).toEqual(["next:journey-page_2"]);
    expect(own.counts.branchPoints).toBe(1);
  });

  it("draws an unconditional route into a step whose question may hide as that step's way in, on the main line", () => {
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "start", title: "Start", components: ["method"], routes: [{ when: eq("method", "phone"), to: "news" }, { to: "plain" }] },
        { id: "plain", title: "Plain", components: ["extra"] },
        { id: "news", title: "News", components: ["email"] }
      ]
    });
    expectNoDiamonds(graph);
    expect(waysOut(graph, "page:journey-page_1")).toEqual([
      ["route:journey-page_1:0", "1 · If Contact method equals “phone”"],
      ["route:journey-page_1:1", "2 · Otherwise"]
    ]);
    expect(edge(graph, "route:journey-page_1:1")).toMatchObject({ to: "page:journey-page_2", spine: true });
    // "Plain" goes on to News by its one line.
    expect(graph.edges.every((candidate) => !candidate.key.startsWith("pass:"))).toBe(true);
    expect(edge(graph, "next:journey-page_2")).toMatchObject({ to: "page:journey-page_3" });
  });

  it("draws a step with one way out leading straight to the next step, and a lone route as a handle with no words", () => {
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "one", title: "One", components: ["method"] },
        { id: "two", title: "Two", components: ["extra"] },
        { id: "three", title: "Three", components: ["name"], routes: [{ to: "$end" }] }
      ]
    });
    expectNoDiamonds(graph);
    expect(waysOut(graph, "page:journey-page_1")).toEqual([["next:journey-page_1", undefined]]);
    expect(edge(graph, "next:journey-page_1")).toMatchObject({ from: "page:journey-page_1", to: "page:journey-page_2", kind: "next" });
    // Step 2's question may hide: the one line still.
    expect(waysOut(graph, "page:journey-page_2")).toEqual([["next:journey-page_2", undefined]]);
    // A lone route still leaves its card, as a small handle: its words ("Always") are only its tooltip.
    expect(waysOut(graph, "page:journey-page_3")).toEqual([["route:journey-page_3:0", "Always"]]);
    expect(edge(graph, "route:journey-page_3:0").label).toMatchObject({ lines: [], width: JOURNEY_MAP_METRICS.chip.handle });
    expect(graph.counts.branchPoints).toBe(0);
  });

  it("never passes over a step whose questions may all hide: its lone route is Always, and the step after it is off the path", () => {
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "start", title: "Start", components: ["age", "method"] },
        { id: "b", title: "B", components: ["young"], routes: [{ to: "d" }] },
        { id: "c", title: "C", components: ["extra"] },
        { id: "d", title: "D", components: ["name"] }
      ]
    }, undefined, HIDING_FORM);
    expectNoDiamonds(graph);
    expect(graph.edges.every((candidate) => !candidate.key.startsWith("pass:"))).toBe(true);
    expect(waysOut(graph, "page:journey-page_1")).toEqual([["next:journey-page_1", undefined]]);
    expect(waysOut(graph, "page:journey-page_2")).toEqual([["route:journey-page_2:0", "Always"]]);
    expect(edge(graph, "route:journey-page_2:0").label).toMatchObject({ lines: [], width: JOURNEY_MAP_METRICS.chip.handle });
    // Nothing reaches step 3 but its line in: step 2 always goes to step 4.
    expect(pages(graph).map((page) => page.unreachable)).toEqual([false, false, true, false]);
    expect(edge(graph, "next:journey-page_3")).toMatchObject({ live: false });
    expect(pages(graph)[1]!.description).toBe("Step 2 of 4, B, id b, 1 question. Leaves by: 1, always, to Step 4 · D.");
    expect(graph.counts.branchPoints).toBe(0);
    expect(mainLine(graph)).toEqual(["start", "next:journey-page_1", "route:journey-page_2:0", "next:journey-page_4"]);
  });

  it("draws a chain of steps whose questions may hide, each with its own route, as routes alone", () => {
    const { graph } = graphOf({
      id: "apply",
      pages: [
        { id: "ask", title: "Ask", components: ["age", "method"], routes: [{ when: eq("method", "none"), to: "finish" }] },
        { id: "young", title: "Guardian", components: ["young"], routes: [{ to: "finish" }] },
        { id: "old", title: "Pension", components: ["old"], routes: [{ to: "finish" }] },
        { id: "address", title: "Address", components: ["extra"] },
        { id: "finish", title: "Finish", components: ["name"] }
      ]
    }, undefined, HIDING_FORM);
    expectNoDiamonds(graph);
    expect(graph.edges.every((candidate) => !candidate.key.startsWith("pass:"))).toBe(true);
    expect(waysOut(graph, "page:journey-page_1")).toEqual([
      ["route:journey-page_1:0", "1 · If Contact method equals “none”"],
      ["next:journey-page_1", "Otherwise"]
    ]);
    expect(waysOut(graph, "page:journey-page_2")).toEqual([["route:journey-page_2:0", "Always"]]);
    // Guardian always goes to Finish: Pension and Address are off the path.
    expect(pages(graph).map((page) => page.unreachable)).toEqual([false, false, true, true, false]);
    expect(graph.counts).toMatchObject({ branchPoints: 1 });
    expect(mainLine(graph)).toEqual(["start", "next:journey-page_1", "route:journey-page_2:0", "next:journey-page_5"]);
    expect(pages(graph)[0]!.description).toContain("Leaves by: 1, if Contact method equals “none”, to Step 5 · Finish; otherwise to Step 2 · Guardian.");
  });

  it("leaves the stubs as they were, and numbers the ways out as the routes are written", () => {
    const tree = treeFromJourney({
      id: "apply",
      pages: [
        { id: "zero", title: "Zero", components: ["name"] },
        {
          id: "one",
          title: "One",
          components: ["method"],
          routes: [{ when: eq("method", "phone"), to: "four" }, { to: "zero" }, { when: eq("method", "none"), to: "$end" }]
        },
        { id: "two", title: "Two", components: ["extra"] },
        { id: "three", title: "Three", components: ["email"], routes: [{ when: eq("email", "x"), to: "$end" }, { to: "four" }, { when: CUSTOM, to: "$end" }] },
        { id: "four", title: "Four", components: ["age"] }
      ]
    });
    const one = routeNodes(tree, 1).map((route) => route.id);
    const three = routeNodes(tree, 3).map((route) => route.id);
    const { graph } = graphOf(tree);
    expectNoDiamonds(graph);
    // Route 2 goes back, so it is a stub and the numbers have a gap; Otherwise into step 3.
    expect(waysOut(graph, "page:journey-page_2")).toEqual([
      ["route:journey-page_2:0", "1 · If Contact method equals “phone”"],
      ["route:journey-page_2:2", "3 · If Contact method equals “none”"],
      ["next:journey-page_2", "Otherwise"]
    ]);
    // Step 3's question may hide: its one line onward.
    expect(waysOut(graph, "page:journey-page_3")).toEqual([["next:journey-page_3", undefined]]);
    expect(pages(graph)[1]!.stubs.map((stub) => [stub.item, stub.reason, stub.number, stub.fullText])).toEqual([[one[1], "backward", 2, "⊘ 2 · back to Step 1: ignored"]]);
    expect(pages(graph)[1]!.description).toContain(
      "Leaves by: 1, if Contact method equals “phone”, to Step 5 · Four; 3, if Contact method equals “none”, to the end, which submits; otherwise to Step 3 · Two. 1 route ignored."
    );
    // A route after one that always matches is a stub still; nothing falls through.
    expect(waysOut(graph, "page:journey-page_4")).toEqual([
      ["route:journey-page_4:0", "1 · If Email equals “x”"],
      ["route:journey-page_4:1", "2 · Otherwise"]
    ]);
    expect(pages(graph)[3]!.stubs.map((stub) => [stub.item, stub.reason, stub.number, stub.fullText])).toEqual([[three[2], "shadowed", 3, "⊘ 3 · never tried: 2 always wins"]]);
    expect(edge(graph, "route:journey-page_4:1").to).toBe("page:journey-page_5");
    // Reading order: each page, its route chips, its stubs.
    expect(graph.readingOrder).toEqual(["$start", "journey-page_1", "journey-page_2", one[0], one[2], one[1], "journey-page_3", "journey-page_4", three[0], three[1], three[2], "journey-page_5", "$end"]);
  });

  it("keeps the meaning of an exit step, a step with no fields and a page no path reaches", () => {
    // A step with no fields: shown like any other, its own way on is the way on.
    const never = graphOf({
      id: "apply",
      pages: [
        { id: "a", title: "A", components: ["method"], routes: [{ when: eq("method", "phone"), to: "d" }] },
        { id: "nothing", title: "Nothing" },
        { id: "c", title: "C", components: ["extra"] },
        { id: "d", title: "D", components: ["name"] }
      ]
    }).graph;
    expectNoDiamonds(never);
    expect(waysOut(never, "page:journey-page_1")).toEqual([
      ["route:journey-page_1:0", "1 · If Contact method equals “phone”"],
      ["next:journey-page_1", "Otherwise"]
    ]);
    expect(waysOut(never, "page:journey-page_2")).toEqual([["next:journey-page_2", undefined]]);
    expect(edge(never, "next:journey-page_2")).toMatchObject({ from: "page:journey-page_2", live: true, spine: true, to: "page:journey-page_3" });
    expect(pages(never)[1]).toMatchObject({ notes: ["No fields yet"], unreachable: false });
    expect(waysOut(never, "page:journey-page_3").map(([, text]) => text)).toEqual([undefined]);
    expect(never.counts.branchPoints).toBe(1);
    // With a route of its own, a step with no fields leaves by its route: Always, and the step after it is off the path.
    const between = graphOf({
      id: "apply",
      pages: [
        { id: "a", title: "A", components: ["method"], routes: [{ when: eq("method", "phone"), to: "d" }] },
        { id: "nothing", title: "Nothing", routes: [{ to: "d" }] },
        { id: "c", title: "C", components: ["extra"] },
        { id: "d", title: "D", components: ["name"] }
      ]
    }).graph;
    expectNoDiamonds(between);
    expect(waysOut(between, "page:journey-page_2")).toEqual([["route:journey-page_2:0", "Always"]]);
    expect(edge(between, "route:journey-page_2:0")).toMatchObject({ live: true, spine: true, to: "page:journey-page_4" });
    expect(pages(between)[2]).toMatchObject({ unreachable: true });
    expect(between.counts.branchPoints).toBe(1);

    // An exit step has no way out; the step after it is reached only by the routes around it.
    const exit = graphOf({
      id: "apply",
      pages: [
        { id: "a", title: "A", components: ["age"], routes: [{ when: eq("age", "old"), to: "c" }, { when: neq("age", "child"), to: "c" }] },
        { id: "stop", kind: "exit", title: "Stop", components: ["bye"], routes: [{ to: "$end" }] },
        { id: "c", title: "C", components: ["name"] }
      ]
    }).graph;
    expectNoDiamonds(exit);
    expect(waysOut(exit, "page:journey-page_1")).toEqual([
      ["route:journey-page_1:0", "1 · If Age equals “old”"],
      ["route:journey-page_1:1", "2 · If Age does not equal “child”"],
      ["next:journey-page_1", "Otherwise"]
    ]);
    expect(waysOut(exit, "page:journey-page_2")).toEqual([]);
    expect(pages(exit)[1]).toMatchObject({ exit: true, notes: ["Exit · stops here"] });
    expect(pages(exit)[1]!.stubs.map((stub) => stub.reason)).toEqual(["exit"]);
    // The fall-through into the exit is the main line, as any fall-through is.
    expect(edge(exit, "next:journey-page_1")).toMatchObject({ spine: true, to: "page:journey-page_2" });
    expect(exit.counts).toMatchObject({ exits: 1, branchPoints: 1 });

    // A page no path reaches still has its ways out, drawn dead and not counted.
    const lost = graphOf({
      id: "apply",
      pages: [
        { id: "one", title: "One", components: ["age"], routes: [{ to: "stop" }] },
        { id: "lost", title: "Lost", components: ["method"], routes: [{ when: eq("method", "phone"), to: "$end" }] },
        { id: "stop", kind: "exit", title: "Stop", components: ["bye"] }
      ]
    }).graph;
    expectNoDiamonds(lost);
    expect(pages(lost)[1]).toMatchObject({ unreachable: true, notes: ["No path reaches this step"] });
    expect(lost.edges.filter((candidate) => candidate.from === "page:journey-page_2").map((candidate) => [candidate.key, candidate.live])).toEqual([
      ["route:journey-page_2:0", false],
      ["next:journey-page_2", false]
    ]);
    expect(lost.counts.branchPoints).toBe(0);
  });

  it("lights a step's own lines: every line into and out of its box", () => {
    const { view, graph } = graphOf(DEMO);
    const lit = (key: string): string[] => [...journeyMapLitEdges(graph, key)].sort();
    // Step 3: the fall-through into it and its own way on.
    expect(lit("journey-page_3")).toEqual(["next:journey-page_2", "next:journey-page_3"]);
    // Step 2: the line into it, its route and its fall-through.
    expect(lit("journey-page_2")).toEqual(["next:journey-page_1", "next:journey-page_2", "route:journey-page_2:0"]);
    // Step 4 is where step 3 arrives; step 5 where the route does.
    expect(lit("journey-page_4")).toEqual(["next:journey-page_3", "next:journey-page_4"]);
    expect(lit("journey-page_5")).toEqual(["next:journey-page_4", "next:journey-page_5", "route:journey-page_2:0"]);
    // A route's chip lights its own line; a line its own; Start and End theirs.
    expect(lit(routeNodes(view.tree, 1)[0]!.id)).toEqual(["route:journey-page_2:0"]);
    expect(lit("edge:next:journey-page_3")).toEqual(["next:journey-page_3"]);
    expect(lit("$start")).toEqual(["start"]);
    expect(lit("$end")).toEqual(["next:journey-page_5"]);
    expect(lit("nothing-by-this-key")).toEqual([]);
    const apply = graphOf(APPLY).graph;
    expect([...journeyMapLitEdges(apply, "journey-page_6")].sort()).toEqual(["next:journey-page_5", "next:journey-page_6"]);
    // In a chain, a step reached only by the fall-through before it lights that line and its own way on.
    const chain = graphOf({
      id: "apply",
      pages: [
        { id: "start", title: "Start", components: ["age", "method"] },
        { id: "b", title: "B", components: ["young"], routes: [{ to: "d" }] },
        { id: "c", title: "C", components: ["extra"] },
        { id: "d", title: "D", components: ["name"] }
      ]
    }, undefined, HIDING_FORM).graph;
    expect([...journeyMapLitEdges(chain, "journey-page_3")].sort()).toEqual(["next:journey-page_3"]);
    expect([...journeyMapLitEdges(chain, "journey-page_2")].sort()).toEqual(["next:journey-page_1", "route:journey-page_2:0"]);
  });
});

describe("journeyMapGraph: presentations' own nodes", () => {
  const FIXTURE = presentationRoot();

  function ownGraph(journey: Journey, field = true): { view: JourneyMapSource; graph: JourneyMapGraph } {
    const { view, flow } = mapSource(FIXTURE, journey);
    return { view, graph: journeyMapGraph(view, flow, mapWords(FIXTURE, journey.id, field)) };
  }

  it("counts an alias among a page's questions and a worked-out value apart, and says what each page fills and works out", () => {
    const { graph } = ownGraph(applyJourney());
    const [details, income, assist] = pages(graph);
    expect(details).toMatchObject({ meta: "details · 1 question", notes: ["Fills Email"] });
    expect(details!.description).toBe("Step 1 of 3, Your details, id details, 1 question. It fills Email. Then to Step 2 · Your income.");
    // m1…m3 are the page's questions; the worked-out value is not one, and its card says what it sets.
    expect(income).toMatchObject({ meta: "income · 3 questions", notes: ["Works out Annual income"] });
    expect(income!.description).toBe(
      "Step 2 of 3, Your income, id income, 3 questions. It works out Annual income. Leaves by: 1, if Annual income is at least “50000”, to Step 3 · Assistance; 2, otherwise, to the end, which submits."
    );
    expect(assist).toMatchObject({ meta: "assist · 1 question", notes: [] });
    expect(assist!.description).toBe("Step 3 of 3, Assistance, id assist, 1 question. Then to the end, which submits.");
    // The note is a row of the card, which grows by it.
    expect(details!.rows.notes).toHaveLength(1);
    const card = JOURNEY_MAP_METRICS.card;
    expect(details!.height).toBe(card.top + card.titleLine + card.metaLine + card.noteLine + card.bottom);
    expect(assist!.height).toBe(card.minHeight);
    // The route reading the worked-out value is drawn as any route is; its warning is on its chip.
    expect(edge(graph, "route:journey-page_2:0").label).toMatchObject({ text: "1 · If Annual income is at least “50000”", badge: "▲ 1", badgeSeverity: "warning" });
    expect(graph.status).toMatch(/^3 steps · 1 branch point/);
  });

  it("counts the references in a layout of the page's own, never the layout or a paragraph", () => {
    const { graph } = ownGraph(publicVariant());
    const [all] = pages(graph);
    expect(all).toMatchObject({ meta: "all · 2 questions", notes: [], findings: { errors: 0, warnings: 0 } });
    expect(all!.description).toBe("Step 1 of 1, Tell us about you, id all, 2 questions. Then to the end, which submits.");
    expect(graph.nodes.map((node) => node.key)).toEqual(["$start", "page:journey-page_1", "$end"]);
  });

  it("counts own fields however deep, names each field filled once in the page's order, and cuts the row, never the sentence", () => {
    const { graph } = ownGraph({
      id: "mixed",
      pages: [
        {
          id: "a",
          title: "A",
          components: [
            { id: "w1", type: "text", configuration: { label: "W1", fills: "email" } },
            {
              id: "box",
              type: "fieldset",
              configuration: { label: "Box" },
              children: {
                content: [
                  { id: "n1", type: "text", configuration: { label: "N1", fills: "name" } },
                  { type: "journey-field", configuration: { componentId: "approved_amount" } },
                  { id: "go", type: "button", configuration: { label: "Go" } }
                ]
              }
            },
            // A second alias of Email, as on exclusive branches: Email is said once.
            { id: "w2", type: "text", configuration: { label: "W2", fills: "email" } },
            { id: "words", type: "html", configuration: { content: "Hello" } }
          ]
        },
        {
          id: "b",
          title: "B",
          components: [
            { id: "x1", type: "number", configuration: { label: "X1", fills: "approved_amount" } },
            { id: "x2", type: "text", configuration: { label: "X2", fills: "name" } },
            { id: "x3", type: "text", configuration: { label: "X3", fills: "email" } }
          ]
        },
        { id: "c", title: "C", components: [{ id: "note", type: "html", configuration: { content: "Only words" } }] }
      ]
    } as unknown as Journey);
    const [a, b, c] = pages(graph);
    // w1, n1, the reference to approved_amount and w2; not the layout, the button or the paragraph.
    expect(a).toMatchObject({ meta: "a · 4 questions", notes: ["Fills Email and Name"] });
    expect(a!.description).toMatch(/^Step 1 of 3, A, id a, 4 questions\. It fills Email and Name\. Then to Step 2 · B\./);
    expect(b!.meta).toBe("b · 3 questions");
    expect(b!.notes).toHaveLength(1);
    expect(b!.notes[0]!.endsWith("…")).toBe(true);
    expect(estimateTextWidth(b!.notes[0]!, JOURNEY_MAP_METRICS.card.metaPx)).toBeLessThanOrEqual(JOURNEY_MAP_METRICS.card.titleWidth);
    expect(b!.description).toContain("3 questions. It fills Approved amount, Name and Email.");
    // Something on it, though no question: not "No fields yet".
    expect(c).toMatchObject({ meta: "c · 0 questions", notes: [] });
    expect(c!.description).toBe("Step 3 of 3, C, id c, 0 questions. Then to the end, which submits.");
  });

  it("shows a page whose only question, in a layout of its own, is hidden for good, as any other step: never passed over", () => {
    const form = presentationRoot();
    form.children!.content!.push({ id: "secret", type: "text", configuration: { label: "Secret", hidden: true } });
    const journey = {
      id: "hidden",
      pages: [
        { id: "a", title: "A", components: ["email"] },
        { id: "b", title: "B", components: [{ id: "box", type: "fieldset", configuration: { label: "Box" }, children: { content: [{ type: "journey-field", configuration: { componentId: "secret" } }] } }] },
        { id: "c", title: "C", components: ["name"] }
      ]
    } as unknown as Journey;
    const { view, flow } = mapSource(form, journey);
    const graph = journeyMapGraph(view, flow, mapWords(form, "Hidden"));
    expect(pages(graph)[1]).toMatchObject({ meta: "b · 1 question", notes: [] });
    expect(pages(graph)[1]!.description).toBe("Step 2 of 3, B, id b, 1 question. Then to Step 3 · C.");
    expect(edge(graph, "next:journey-page_2")).toMatchObject({ spine: true, live: true, to: "page:journey-page_3" });
    expect(graph.edges.every((candidate) => !candidate.key.startsWith("pass:"))).toBe(true);
  });

  it("counts the findings on a page's own nodes on its card", () => {
    const journey = applyJourney();
    // An alias of a field the form does not have: map.unknown-target, an error on that node.
    journey.pages[0]!.components!.push({ id: "bad", type: "text", configuration: { label: "Bad", fills: "nope" } });
    const { view, graph } = ownGraph(journey);
    const onBad = view.check.findings.byNode.get("bad") ?? [];
    expect(onBad.map((finding) => [finding.severity, finding.code])).toContainEqual(["error", "map.unknown-target"]);
    const onPage = [...view.check.findings.byNode].filter(([nodeId]) => view.index.pageOf.get(nodeId)?.number === 1).flatMap(([, list]) => list);
    const [details] = pages(graph);
    expect(details!.findings).toEqual({
      errors: onPage.filter((finding) => finding.severity === "error").length,
      warnings: onPage.filter((finding) => finding.severity === "warning").length
    });
    // Still a question (an own field kept in the browser), but it fills nothing, so nothing is said of it.
    expect(details).toMatchObject({ meta: "details · 2 questions", notes: ["Fills Email"], badgeSeverity: "error" });
    expect(details!.description).toContain(`. ${findingsSummary(details!.findings)}.`);
  });

  it("names only what the shared ownership fills or works out, and counts only the entries it uses", () => {
    const form = presentationRoot();
    form.children!.content!.push({ id: "calc", type: "number", configuration: { label: "Calculated" }, rules: { value: { kind: "literal", value: 1 } } } as ComponentNode);
    const firstCard = (first: unknown[], rest = ["email", "name", "money", "approved_amount"]): { card: JourneyMapPage; view: JourneyMapSource } => {
      const journey = { id: "apply", pages: [{ id: "first", title: "First", components: first }, { id: "rest", title: "Rest", components: rest }] } as unknown as Journey;
      const { view, flow } = mapSource(form, journey);
      return { card: pages(journeyMapGraph(view, flow, mapWords(form, "Apply")))[0]!, view };
    };
    // An alias whose entry is dropped (its id is a form component's, rule A): no question, nothing filled.
    const dropped = firstCard([{ id: "name", type: "text", configuration: { label: "Work email", fills: "email" } }], ["email", "money", "approved_amount"]);
    expect(dropped.view.check.ownership?.membersOf.first).toEqual([]);
    expect(dropped.card).toMatchObject({ meta: "first · 0 questions", notes: [] });
    // An alias of a calculated field (rule E): still a question, kept in the browser, but it fills nothing.
    const calculated = firstCard([{ id: "calc_alias", type: "number", configuration: { label: "Calc", fills: "calc" } }]);
    expect(Object.keys(calculated.view.check.ownership?.aliasOf ?? {})).toEqual([]);
    expect(calculated.card).toMatchObject({ meta: "first · 1 question", notes: [] });
    // A worked-out value whose field another page lists (rule G): ignored, so nothing is worked out.
    const ignored = firstCard([
      { id: "m1", type: "number", configuration: { label: "Month" } },
      { id: "total", type: "journey-value", configuration: { to: "annual_income", value: { kind: "path", path: "m1" } } }
    ]);
    expect(Object.keys(ignored.view.check.ownership?.workedOutOf ?? {})).toEqual([]);
    expect(ignored.card).toMatchObject({ meta: "first · 1 question", notes: [] });
    expect(ignored.card.description).not.toContain("works out");
    // A dropped layout's reference is no question either.
    const droppedLayout = firstCard([{ id: "email", type: "fieldset", configuration: { label: "Box" }, children: { content: [{ type: "journey-field", configuration: { componentId: "name" } }] } }], ["email", "money", "approved_amount"]);
    expect(droppedLayout.card.meta).toBe("first · 0 questions");
  });

  it("counts each node's findings once on its card where own nodes share an id, and marks the later one's for it", () => {
    const { view, graph } = ownGraph({
      id: "apply",
      pages: [
        { id: "first", title: "First", components: [{ id: "nick", type: "text", configuration: { label: "Nick" } }, { id: "nick", type: "text", configuration: { label: "Nick again" } }, "email"] },
        { id: "rest", title: "Rest", components: ["name", "money", "approved_amount"] }
      ]
    } as unknown as Journey);
    expect(view.check.findings.byNode.get("nick")?.map((finding) => [finding.severity, finding.code, finding.repeat])).toEqual([
      ["warning", "field.goes-nowhere", undefined],
      ["error", "field.id-clash", 1]
    ]);
    // The first nick and email are the page's questions; the second nick is dropped.
    expect(pages(graph)[0]).toMatchObject({ meta: "first · 2 questions", findings: { errors: 1, warnings: 1 }, badge: "▲ 2" });
  });

  it("never counts a type the designer says holds no answer as a question", () => {
    const journey = {
      id: "apply",
      pages: [
        { id: "first", title: "First", components: ["email", { id: "help_link", type: "gcds-link", configuration: { text: "Help", href: "/help" } }] },
        { id: "rest", title: "Rest", components: ["name", "money", "approved_amount"] }
      ]
    } as unknown as Journey;
    const { view, flow } = mapSource(FIXTURE, journey);
    expect(pages(journeyMapGraph(view, flow, mapWords(FIXTURE, "Apply")))[0]!.meta).toBe("first · 2 questions");
    expect(pages(journeyMapGraph(view, flow, { ...mapWords(FIXTURE, "Apply"), isValueless: (node) => node.type === "gcds-link" }))[0]!.meta).toBe("first · 1 question");
  });

  it("names what is filled by its id when the designer lends no labels", () => {
    const { graph } = ownGraph(applyJourney(), false);
    const [details, income] = pages(graph);
    expect(details!.notes).toEqual(["Fills email"]);
    expect(income!.notes).toEqual(["Works out annual_income"]);
    expect(income!.description).toContain("3 questions. It works out annual_income. Leaves by:");
  });

  it("counts the same on the pages alone while the tree cannot be written, and names nothing: with no journey written there is no ownership to say what is filled", () => {
    const { view } = mapSource(FIXTURE, applyJourney());
    const tree = structuredClone(view.tree);
    (pageNode(tree, 0).configuration as Record<string, unknown>).when = 7;
    const broken: JourneyMapSource = { tree, index: indexJourneyTree(tree), check: checkJourneyTree(FIXTURE, tree, "apply") };
    expect(broken.check.journey).toBeUndefined();
    const graph = journeyMapGraph(broken, undefined, mapWords(FIXTURE, "Apply"));
    expect(graph).toMatchObject({ stale: true, edges: [] });
    expect(broken.check.ownership).toBeUndefined();
    expect(pages(graph).map((page) => [page.meta, page.notes, page.description])).toEqual([
      ["details · 1 question", [], "Step 1 of 3, Your details, id details, 1 question."],
      ["income · 3 questions", [], "Step 2 of 3, Your income, id income, 3 questions."],
      ["assist · 1 question", [], "Step 3 of 3, Assistance, id assist, 1 question."]
    ]);
  });

  it("draws a journey of component ids alone as before: no labels asked for, nothing added", () => {
    const asking: JourneyMapWords = {
      ...WORDS,
      field: (componentId) => {
        throw new Error(`asked for ${componentId}`);
      }
    };
    for (const journey of [APPLY, { id: "one", pages: [{ id: "only", components: ["name", "bye"] }, { id: "none", components: [] }] }]) {
      const tree = treeFromJourney(journey);
      const view = viewOf(tree);
      const flow = journeyFlow(view.check.journey!);
      const graph = journeyMapGraph(view, flow, asking);
      expect(graph).toEqual(journeyMapGraph(view, flow, WORDS));
      for (const page of pages(graph)) {
        expect(page.notes.some((note) => /^(Fills|Works out) /.test(note)), page.key).toBe(false);
        expect(page.description).not.toMatch(/ It (fills|works out) /);
      }
    }
    // An empty page still says "No fields yet", and goes on by its plain line.
    const { graph } = graphOf({ id: "apply", pages: [{ id: "a", components: ["age"] }, { id: "none", components: [] }, { id: "b", components: ["name"] }] });
    expect(pages(graph)[1]).toMatchObject({ notes: ["No fields yet"] });
    expect(edge(graph, "next:journey-page_2")).toMatchObject({ spine: true, live: true });
    expect(edge(graph, "next:journey-page_2").label).toBeUndefined();
  });
});
