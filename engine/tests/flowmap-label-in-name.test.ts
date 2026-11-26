// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { checkJourneyTree, indexJourneyTree } from "../form-engine/builder/journey-designer/journey-checks.js";
import { indexJourneyForm, pageName } from "../form-engine/builder/journey-designer/journey-components.js";
import { treeFromJourney } from "../form-engine/builder/journey-designer/journey-tree.js";
import { layoutFlow, type FlowDirection } from "../form-engine/builder/journey-map/journey-map-layout.js";
import { journeyMapGraph, journeyMapLayoutInput, type JourneyMapWords } from "../form-engine/builder/journey-map/journey-map-model.js";
import { itemName, journeyMapSvg } from "../form-engine/builder/journey-map/journey-map-svg.js";
import { journeyFlow } from "../form-engine/core/journey/journey-flow.js";
import { findingsSummary } from "../form-engine/builder/journey-designer/journey-checks.js";
import { conditionTerms, mapSource, mapWords } from "./flowmap-words.js";
import { applyJourney, presentationRoot } from "./fixtures/presentation-form.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The flow map's items are named with the words they draw (WCAG 2.5.3, Label in Name): what
 * axe-core's label-content-name-mismatch compares, kept here without a browser. Its own file
 * for the jsdom environment, which the SVG markup tests in flowmap-svg.test.ts do without.
 */

function eq(path: string, value: string): Expression {
  return { kind: "binary", operator: "eq", left: { kind: "path", path }, right: { kind: "literal", value } };
}

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
const WORDS: JourneyMapWords = {
  journeyName: "Apply",
  condition: (expression) => conditionTerms(expression, FORM_INDEX),
  pageName: (entry) => pageName(entry, FORM_INDEX, "en"),
  summary: findingsSummary
};

const APPLY: Journey = {
  id: "apply",
  pages: [
    { id: "start", title: "Eligibility <script>alert(1)</script>", components: ["age"], routes: [{ when: ({ ...eq("age", "child"), operator: "neq" } as Expression), to: "about" }] },
    { id: "too-young", kind: "exit", title: "Too young", components: ["bye"] },
    {
      id: "about",
      title: "About you",
      components: ["name", "method"],
      routes: [{ when: eq("method", "post"), to: "address" }, { to: "contact" }, { to: "start" }, { to: "gone" }, { to: "$end" }, { to: "about" }]
    },
    { id: "contact", title: "Email", components: ["email"] },
    { id: "address", title: "Address", components: ["post"] },
    { id: "more", title: "Anything else", components: ["extra"] }
  ]
};


function svgOf(journey: Journey, direction: FlowDirection): string {
  const tree = treeFromJourney(journey);
  const view = { tree, index: indexJourneyTree(tree), check: checkJourneyTree(FORM, tree, journey.id) };
  const graph = journeyMapGraph(view, journeyFlow(view.check.journey!), WORDS);
  return journeyMapSvg(graph, layoutFlow(journeyMapLayoutInput(graph, { direction })));
}

/** A text as words: lower case, parentheticals and punctuation gone, spaces around (as axe curates both sides). */
const words = (text: string): string =>
  ` ${text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\([^()]*\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;

/** Every role=button of the markup: its drawn text (a <title> is a tooltip, not drawn) and its name. */
function items(svg: string): Array<{ drawn: string; name: string }> {
  const host = document.createElement("div");
  host.innerHTML = svg;
  return [...host.querySelectorAll('[role="button"]')].map((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll("title").forEach((title) => title.remove());
    return { drawn: copy.textContent ?? "", name: element.getAttribute("aria-label")! };
  });
}

describe("the flow map's item names", () => {
  it("hold the words each item draws, in order, in both directions", () => {
    for (const direction of ["down", "right"] as const) {
      const found = items(svgOf(APPLY, direction));
      // Start, six pages, two ways out, the stubs, End.
      expect(found.length).toBeGreaterThan(10);
      for (const { drawn, name } of found) {
        expect(words(name), `${name} holds ${drawn}`).toContain(words(drawn));
      }
    }
  });

  it("hold them for a presentation's own nodes too", () => {
    const form = presentationRoot();
    const { view, flow } = mapSource(form, applyJourney());
    const graph = journeyMapGraph(view, flow!, mapWords(form, "Apply"));
    const found = items(journeyMapSvg(graph, layoutFlow(journeyMapLayoutInput(graph, { direction: "down" }))));
    expect(found.length).toBeGreaterThan(4);
    for (const { drawn, name } of found) {
      expect(words(name), `${name} holds ${drawn}`).toContain(words(drawn));
    }
  });
});

describe("itemName", () => {
  it("leads with the drawn words, and leaves a sentence that already holds them", () => {
    expect(itemName(["End · submits"], "End: the journey submits here.")).toBe("End · submits. End: the journey submits here.");
    expect(itemName(["Start"], "Start: the journey begins at Page 1.")).toBe("Start: the journey begins at Page 1.");
    expect(itemName(["+2 more"], "2 more ignored routes on Page 1.")).toBe("2 more ignored routes on Page 1.");
    expect(itemName([], "A sentence.")).toBe("A sentence.");
    expect(itemName(["1", undefined, " Title "], undefined)).toBeUndefined();
  });
});
