import { describe, expect, it } from "vitest";

import { evaluateExpression } from "../form-engine/rules/evaluator/evaluator.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { validateJourneyShape, type Journey, type JourneyPage, type JourneyPageEntry } from "../form-engine/core/schema/journey.js";
import { diagnoseJourney, exploreJourneyWalks, journeyWalkGraph } from "../form-engine/core/journey/journey-diagnostics.js";
import { journeyFlow, type JourneyFlow } from "../form-engine/core/journey/journey-flow.js";
import { journeyOwnership, journeyPath } from "../form-engine/core/journey/journey-path.js";
import { applyJourney, presentationRoot, publicVariant } from "./fixtures/presentation-form.js";

/**
 * The flow facts over presentations: pages holding nodes of their own beside the
 * component ids. `journeyFlow` reads no entry: every page the walk arrives at is on the path,
 * whatever it holds or hides, as the path engine walks it, and nothing a page holds makes it
 * throw. The facts for journeys of component ids alone are `flowmap-flow.test.ts`'s.
 */

const visibleWhen: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "name" }, right: { kind: "literal", value: "show" } };

/** The fixture's form, plus a field a rule may hide, one hidden for good, and one inside a repeating section. */
function form(): ComponentNode {
  const root = presentationRoot();
  root.children!.content!.push(
    { id: "sometimes", type: "text", configuration: { label: "Sometimes" }, rules: { visibleWhen } },
    { id: "never", type: "text", configuration: { label: "Never", hidden: true } },
    {
      id: "people",
      type: "panel",
      configuration: { label: "People" },
      collection: { collectionPath: "people", itemFields: ["person"] },
      children: { content: [{ id: "person", type: "text", configuration: { label: "Person" } }] }
    }
  );
  return root;
}

const reference = (componentId: string): JourneyPageEntry => ({ type: "journey-field", configuration: { componentId } });
const own = (id: string, type = "text", configuration: Record<string, unknown> = { label: id }, extra: Record<string, unknown> = {}): JourneyPageEntry =>
  ({ id, type, configuration, ...extra }) as unknown as JourneyPageEntry;
const alias = (id: string, fills: string): JourneyPageEntry => own(id, "text", { label: id, fills });
const paragraph = (id: string): JourneyPageEntry => own(id, "html", { content: "<p>Read this.</p>" });
const layout = (id: string, ...children: JourneyPageEntry[]): JourneyPageEntry => own(id, "fieldset", { label: id }, { children: { content: children } });

/** A first page every path shows, the page under test, and a last page. */
function around(page: JourneyPage): Journey {
  const journey: Journey = {
    id: "j",
    pages: [{ id: "first", title: "First", components: ["name"] }, page, { id: "last", title: "Last", components: ["approved_amount"] }]
  };
  expect(validateJourneyShape(journey)).toEqual([]);
  return journey;
}

function pageFacts(flow: JourneyFlow, at: number): Record<string, unknown> {
  const { pageId: _pageId, exit: _exit, ...facts } = flow.pages[at]!;
  return facts;
}

const ON_PATH = { onPath: true };

describe("journeyFlow over pages holding nodes of their own", () => {
  it("draws the fixture's journey and variant: every page shown, every way live", () => {
    const flow = journeyFlow(applyJourney());
    expect(flow.pages).toEqual([
      { pageId: "details", exit: false, ...ON_PATH },
      { pageId: "income", exit: false, ...ON_PATH },
      { pageId: "assist", exit: false, ...ON_PATH }
    ]);
    expect(flow.edges.map((edge) => `${edge.kind}:${edge.from}>${edge.to}${edge.live ? "" : " dead"}`)).toEqual(["next:0>1", "route:1>2", "route:1>3", "next:2>3"]);
    expect(flow.ignored).toEqual([]);
    expect(flow.ends).toBe(true);

    const variant = journeyFlow(publicVariant());
    expect(variant.pages).toEqual([{ pageId: "all", exit: false, ...ON_PATH }]);
    expect(variant.edges.map((edge) => `${edge.kind}:${edge.from}>${edge.to}`)).toEqual(["next:0>1"]);
    expect(variant.ends).toBe(true);
  });

  const cases: Array<[string, JourneyPageEntry[]]> = [
    ["a field of the page's own", [own("extra")]],
    ["a paragraph of the page's own", [paragraph("words")]],
    ["an alias of a field that always shows", [alias("mail", "email")]],
    ["an alias of a field a rule may hide", [alias("alt", "sometimes")]],
    ["an alias of a field hidden for good", [alias("alt", "never")]],
    ["a layout of references to a field a rule may hide", [layout("box", reference("sometimes"))]],
    ["a reference at the top of a page to a field a rule may hide", [reference("sometimes")]],
    ["a worked-out value alone, of a field a rule may hide", [own("sum", "journey-value", { to: "sometimes", value: { kind: "literal", value: 1 } })]],
    ["only entries a usability rule drops", [own("upload", "file"), own("email")]],
    ["a layout whose only reference names nothing", [layout("box", reference("ghost"))]]
  ];

  it.each(cases)("keeps a page holding %s on the path, whatever the form hides", (_name, entries) => {
    const root = form();
    const journey = around({ id: "own", title: "Own", components: entries });
    const flow = journeyFlow(journey);
    expect(pageFacts(flow, 1)).toEqual(ON_PATH);
    expect(flow.ends).toBe(true);

    // The same as the diagnostics say it, and as the path engine walks it, whatever shows.
    const messages = diagnoseJourney(root, journey).filter((diagnostic) => diagnostic.code === "page.unreachable");
    expect(messages).toEqual([]);
    const ownership = journeyOwnership(root, journey);
    for (const name of ["show", "hide"]) {
      const pages = journeyPath(journey, { values: { name }, ownership, evaluate: (expression, values) => evaluateExpression(expression, { values }) }).pages;
      expect(pages).toEqual(["first", "own", "last"]);
    }
  });

  it("gives a page of references at its top the facts of the same page written with ids", () => {
    const asIds = around({ id: "own", title: "Own", components: ["sometimes", "email"], routes: [{ when: visibleWhen, to: "$end" }] });
    const asReferences = around({ id: "own", title: "Own", components: [reference("sometimes"), reference("email")], routes: [{ when: visibleWhen, to: "$end" }] });
    expect(journeyFlow(asReferences)).toEqual(journeyFlow(asIds));
  });

  it("never throws, whatever a hand-written page holds, and agrees with the walk it is built on", () => {
    let deep: Record<string, unknown> = { id: "leaf", type: "text" };
    for (let depth = 0; depth < 3000; depth += 1) {
      deep = { id: `level${depth}`, type: "fieldset", children: { content: [deep] } };
    }
    const odd = [null, 7, {}, { type: 5 }, { id: 7, type: "text" }, { id: "kids", type: "fieldset", children: { content: [null, { type: "journey-field" }] } }, { id: "val", type: "journey-value" }, deep];
    const journey: Journey = {
      id: "j",
      pages: [
        { id: "odd", components: odd as unknown as JourneyPageEntry[], routes: [{ to: "end" }] },
        { id: "skipped", components: [{ id: 3, type: "text" }] as unknown as JourneyPageEntry[] },
        { id: "end", kind: "exit", components: [paragraph("bye")] },
        { id: "after", components: ["name"] }
      ]
    };
    let flow: JourneyFlow | undefined;
    expect(() => {
      flow = journeyFlow(journey);
    }).not.toThrow();
    const graph = journeyWalkGraph(journey);
    const walk = exploreJourneyWalks(graph);
    expect(flow?.pages.map((page) => [page.pageId, page.onPath])).toEqual([
      ["odd", true],
      ["skipped", false],
      ["end", true],
      ["after", false]
    ]);
    expect(flow?.pages.map((page) => page.onPath)).toEqual(walk.onPath);
    expect(flow?.ends).toBe(false);
  });
});
