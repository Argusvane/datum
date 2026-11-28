import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { checkJourneyTree, findingsSummary, indexJourneyTree } from "../form-engine/builder/journey-designer/journey-checks.js";
import { indexJourneyForm, pageName } from "../form-engine/builder/journey-designer/journey-components.js";
import { treeFromJourney } from "../form-engine/builder/journey-designer/journey-tree.js";
import { layoutFlow, type FlowDirection } from "../form-engine/builder/journey-map/journey-map-layout.js";
import { journeyMapGraph, journeyMapLayoutInput, type JourneyMapGraph, type JourneyMapWords } from "../form-engine/builder/journey-map/journey-map-model.js";
import { JOURNEY_MAP_ROOT_CLASS, JOURNEY_MAP_STYLES } from "../form-engine/builder/journey-map/journey-map-styles.js";
import { journeyMapSvg } from "../form-engine/builder/journey-map/journey-map-svg.js";
import { journeyFlow } from "../form-engine/core/journey/journey-flow.js";
import { studioTokenDeclarations } from "../form-engine/builder/web-component/studio-tokens.js";
import { conditionTerms, mapSource, mapWords } from "./flowmap-words.js";
import { applyJourney, presentationRoot, publicVariant } from "./fixtures/presentation-form.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The flow map's SVG and styles: the markup's structure, its accessibility (items,
 * labels, no nested buttons, no view state), its colours only through the builder's tokens, and
 * the contrast those tokens give in the default palette.
 */

function eq(path: string, value: string): string {
  return `${path} = ${JSON.stringify(value)}`;
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
    { id: "start", title: "Eligibility <script>alert(1)</script>", components: ["age"], routes: [{ when: 'age != "child"', to: "about" }] },
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

function graphOf(journey: Journey, words: JourneyMapWords = WORDS): JourneyMapGraph {
  const tree = treeFromJourney(journey);
  const view = { tree, index: indexJourneyTree(tree), check: checkJourneyTree(FORM, tree, journey.id) };
  return journeyMapGraph(view, journeyFlow(view.check.journey!), words);
}

function svgOf(graph: JourneyMapGraph, direction: FlowDirection): string {
  return journeyMapSvg(graph, layoutFlow(journeyMapLayoutInput(graph, { direction })));
}

function all(svg: string, pattern: RegExp): string[] {
  return [...svg.matchAll(pattern)].map((match) => match[1] as string);
}

/** Every element's opening tag with its ancestors' tags, from a plain tag walk (the markup has no comments or CDATA). */
function elements(markup: string): Array<{ tag: string; ancestors: string[] }> {
  const out: Array<{ tag: string; ancestors: string[] }> = [];
  const stack: string[] = [];
  for (const match of markup.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
    const [whole, closing, , , selfClosing] = match;
    if (closing) {
      stack.pop();
      continue;
    }
    out.push({ tag: whole, ancestors: [...stack] });
    if (!selfClosing) {
      stack.push(whole);
    }
  }
  return out;
}

describe("journeyMapSvg", () => {
  it("draws one-page journeys exactly so", () => {
    const tree = treeFromJourney({ id: "one", pages: [{ id: "only", title: "Only page", components: ["name"] }] });
    const view = { tree, index: indexJourneyTree(tree), check: checkJourneyTree(FORM, tree, "one") };
    const graph = journeyMapGraph(view, journeyFlow(view.check.journey!), {
      journeyName: "One",
      condition: () => undefined,
      pageName: (entry) => entry.pageId,
      summary: () => undefined
    });
    expect(svgOf(graph, "down")).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" class="jm-svg" viewBox="0 0 240 216" role="group" aria-roledescription="journey map" aria-label="Journey map of “One”: 1 step. Tab to a step; arrow keys move between steps and their ways out; Enter selects." data-direction="down">' +
        '<g class="jm-edges">' +
        '<g class="jm-edge jm-edge--start is-spine" data-edge="start" data-from="$start" data-to="page:journey-page_1"><path class="jm-edge__hit" d="M120 46 L120 75"/><path class="jm-edge__line" d="M120 46 L120 75"/><path class="jm-edge__head" d="M116 75 L120 82 L124 75 Z"/></g>' +
        '<g class="jm-edge jm-edge--next is-spine" data-edge="next:journey-page_1" data-from="page:journey-page_1" data-to="$end" data-select="journey-page_1"><path class="jm-edge__hit" d="M120 134 L120 163"/><path class="jm-edge__line" d="M120 134 L120 163"/><path class="jm-edge__head" d="M116 163 L120 170 L124 163 Z"/></g>' +
        '</g><g class="jm-labels" aria-hidden="true"></g><g class="jm-nodes">' +
        '<g class="jm-item jm-terminal jm-terminal--start" data-map-node="$start" data-select="journey" data-map-item="$start" role="button" tabindex="-1" aria-label="Start: the journey begins at Step 1 · only." transform="translate(68 16)"><g aria-hidden="true"><rect class="jm-ring" x="-4" y="-4" width="112" height="38" rx="19"/><rect class="jm-terminal__box" width="104" height="30" rx="15"/><text class="jm-terminal__text" x="52" y="19.5">Start</text><title>Start: the journey begins at Step 1 · only.</title></g></g>' +
        '<g class="jm-page" data-map-node="page:journey-page_1" transform="translate(16 82)"><g class="jm-item jm-node" data-select="journey-page_1" data-map-item="journey-page_1" role="button" tabindex="-1" aria-label="1 only only · 1 question. Step 1 of 1, only, id only, 1 question. Then to the end, which submits."><g aria-hidden="true"><rect class="jm-ring" x="-4" y="-4" width="216" height="60" rx="11"/><rect class="jm-node__box" width="208" height="52" rx="7"/><circle class="jm-node__disc" cx="22" cy="21" r="11"/><text class="jm-node__number" x="22" y="25">1</text> <text class="jm-node__title"><tspan x="40" y="22">only</tspan></text> <text class="jm-node__meta" x="40" y="38">only · 1 question</text><title>Step 1 of 1, only, id only, 1 question. Then to the end, which submits.</title></g></g></g>' +
        '<g class="jm-item jm-terminal jm-terminal--end" data-map-node="$end" data-select="journey" data-map-item="$end" role="button" tabindex="-1" aria-label="End · submits. End: the journey submits here." transform="translate(68 170)"><g aria-hidden="true"><rect class="jm-ring" x="-4" y="-4" width="112" height="38" rx="19"/><rect class="jm-terminal__box" width="104" height="30" rx="15"/><text class="jm-terminal__text" x="52" y="19.5">End · submits</text><title>End: the journey submits here.</title></g></g>' +
        "</g></svg>"
    );
  });

  for (const direction of ["down", "right"] as const) {
    it(`draws every node, edge and chip, and no diamond, ${direction}`, () => {
      const graph = graphOf(APPLY);
      const svg = svgOf(graph, direction);
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" class="jm-svg" viewBox="0 0 ')).toBe(true);
      expect(svg).toContain(`data-direction="${direction}">`);
      expect(svg).not.toContain("data-arrange");
      expect(all(svg, /<g class="jm-page[^"]*" data-map-node="([^"]+)"/g)).toEqual(graph.nodes.filter((node) => node.kind === "page").map((node) => node.key));
      // No diamond: every way leaves its step's card.
      expect(svg).not.toContain("jm-gate");
      expect(svg).not.toMatch(/data-(from|to)="(gate|fork):/);
      expect(svg).toContain('data-edge="route:journey-page_3:0" data-from="page:journey-page_3" data-to="page:journey-page_5"');
      expect(all(svg, /<g class="jm-edge [^"]*" data-edge="[^"]+" data-from="([^"]+)"/g).filter((from) => from === "page:journey-page_3")).toHaveLength(2);
      expect(all(svg, /<g class="jm-edge [^"]*" data-edge="([^"]+)"/g).sort()).toEqual(graph.edges.map((edge) => edge.key).sort());
      expect(all(svg, /<g class="[^"]*jm-label [^"]*" data-edge="([^"]+)"/g).sort()).toEqual(graph.edges.filter((edge) => edge.label).map((edge) => edge.key).sort());
      // Every focusable item is drawn in the reading order — so a screen reader's browse order
      // is the arrows' (a step, its ways out, its stubs) — and every item of it is drawn.
      expect(all(svg, /data-map-item="([^"]+)"/g)).toEqual(graph.readingOrder);
      // The stubs: backward, missing, shadowed and self, three shown and one more.
      expect(all(svg, /data-stub="([^"]+)"/g)).toEqual(["backward", "unknown-target", "shadowed"]);
      expect(svg).toContain('<text class="jm-more__text" x="12"');
      expect(svg).toContain(">+1 more<");
      expect(svg).toContain('class="jm-item jm-stub jm-stub--error"');
      expect(svg).toContain('class="jm-item jm-stub jm-stub--warning"');
      // Clickable things say what they select; route chips select their route node.
      const chip = graph.edges.find((edge) => edge.key === "route:journey-page_3:0")!;
      expect(svg).toContain(`data-edge="route:journey-page_3:0" data-select="${chip.select}" data-map-item="${chip.select}" role="button" tabindex="-1" aria-label="1 · If Contact method equals “post”. Route 1 of Step 3 · About you: if Contact method equals “post”, goes to Step 5 · Address."`);
      // No step is passed over: no pass-by is drawn anywhere.
      expect(svg).not.toContain('data-edge="pass:');
      expect(svg).not.toContain("jm-edge--pass");
      expect(svg).not.toContain("If nothing on it shows");
    });
  }

  it("draws a lone rule with no condition on a step that always shows as a small handle with no words, still an item", () => {
    const graph = graphOf({ id: "apply", pages: [{ id: "one", components: ["age"], routes: [{ to: "two" }] }, { id: "two", components: ["name"] }] });
    for (const direction of ["down", "right"] as const) {
      const svg = svgOf(graph, direction);
      const chip = graph.edges.find((edge) => edge.key === "route:journey-page_1:0")!;
      expect(svg).toMatch(new RegExp(`<g class="jm-item jm-label jm-label--route is-handle" data-edge="route:journey-page_1:0" data-select="${chip.select}" data-map-item="${chip.select}" role="button"`));
      expect(svg).not.toContain(">Always</tspan>");
      // Its words are the tooltip; the box is the handle's own size.
      expect(svg).toContain("<title>Always</title>");
      expect(svg).toContain('width="14" height="14" rx="4"');
      // And a transparent square of the least target size (24 px, WCAG 2.5.8) about it, drawn first so the box stays on top.
      expect(svg).toMatch(/<rect class="jm-label__hit" x="-5" y="-5" width="24" height="24"\/><rect class="jm-ring"/);
    }
  });

  it("draws a route and the next step's fall-through leaving their own steps' boxes, the fall-through's chip hidden with the other chips that are not items", () => {
    // The demo journey's shape: step 2 has a route, step 3's question may hide, and it goes on to step 4.
    const graph = graphOf({
      id: "apply",
      pages: [
        { id: "about", title: "About you", components: ["name"] },
        { id: "contact", title: "Contact", components: ["method"], routes: [{ when: eq("method", "phone"), to: "details" }] },
        { id: "address", title: "Address", components: ["extra"] },
        { id: "updates", title: "Updates", components: ["email"] },
        { id: "details", title: "Details", components: ["age"] }
      ]
    });
    for (const direction of ["down", "right"] as const) {
      const svg = svgOf(graph, direction);
      expect(svg).not.toContain("jm-gate");
      // Two lines out of step 2's card, one out of step 3's.
      const from = all(svg, /<g class="jm-edge [^"]*" data-edge="[^"]+" data-from="([^"]+)"/g);
      expect(from.filter((key) => key === "page:journey-page_2")).toHaveLength(2);
      expect(from.filter((key) => key === "page:journey-page_3")).toHaveLength(1);
      expect(svg).toContain('<g class="jm-edge jm-edge--route is-conditional" data-edge="route:journey-page_2:0" data-from="page:journey-page_2" data-to="page:journey-page_5"');
      expect(svg).toContain(
        '<g class="jm-edge jm-edge--next is-otherwise is-spine" data-edge="next:journey-page_2" data-from="page:journey-page_2" data-to="page:journey-page_3" data-select="journey-page_2">'
      );
      expect(svg).not.toContain('data-edge="pass:');
      // Its chip is no item: hidden from assistive technology, its words in the card's label.
      const tags = elements(svg);
      for (const key of ["next:journey-page_2"]) {
        const chip = tags.find((element) => element.tag.includes("jm-label ") && element.tag.includes(`data-edge="${key}"`))!;
        expect(chip.tag).not.toContain("data-map-item");
        expect(chip.ancestors.at(-1)).toBe('<g class="jm-labels" aria-hidden="true">');
      }
      expect(svg).not.toContain(">If nothing on it shows</tspan>");
      expect(svg).toContain(
        'aria-label="2 Contact contact · 1 question. Step 2 of 5, Contact, id contact, 1 question. Leaves by: 1, if Contact method equals “phone”, to Step 5 · Details; otherwise to Step 3 · Address."'
      );
      expect(svg).toContain('aria-label="3 Address address · 1 question. Step 3 of 5, Address, id address, 1 question. Then to Step 4 · Updates."');
      expect(all(svg, /data-map-item="([^"]+)"/g)).toEqual(graph.readingOrder);
    }
    // The card's own sentence says the same.
    expect(graph.nodes.some((node) => node.kind === "page" && node.description === "Step 3 of 5, Address, id address, 1 question. Then to Step 4 · Updates.")).toBe(true);
  });

  it("escapes what the author wrote", () => {
    const svg = svgOf(graphOf(APPLY), "down");
    expect(svg).not.toContain("<script");
    expect(svg).toContain("Eligibility &lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("carries no view state: every item is out of the tab order until the surface picks one, and no way is marked taken", () => {
    for (const direction of ["down", "right"] as const) {
      const svg = svgOf(graphOf(APPLY), direction);
      expect(svg).not.toContain('tabindex="0"');
      expect(svg).not.toContain("aria-current");
      expect(svg).not.toContain("is-selected");
      expect(svg).not.toContain("is-lit");
      expect(svg).not.toMatch(/is-(current|taken)|has-path/);
      expect(svg).not.toMatch(/<svg[^>]* (width|height)=/);
      const buttons = svg.match(/role="button"/g) ?? [];
      expect(svg.match(/tabindex="-1"/g)).toHaveLength(buttons.length);
    }
  });

  it("nests no button inside another, and gives every button a name", () => {
    const svg = svgOf(graphOf(APPLY), "down");
    const buttons = elements(svg).filter((element) => element.tag.includes('role="button"'));
    expect(buttons.length).toBeGreaterThan(8);
    for (const button of buttons) {
      expect(button.ancestors.some((ancestor) => ancestor.includes('role="button"')), button.tag).toBe(false);
      expect(button.tag).toMatch(/aria-label="[^"]+"/);
    }
    // Named once: a <title> of the button's own would be its description too (SVG-AAM), the
    // name read twice. Its tooltip sits in a group of its picture hidden from assistive technology.
    const titles = elements(svg).filter((element) => element.tag === "<title>");
    expect(titles.length).toBeGreaterThan(buttons.length);
    for (const title of titles) {
      expect(title.ancestors.at(-1), title.ancestors.at(-1)).not.toContain('role="button"');
      if (title.ancestors.some((ancestor) => ancestor.includes('role="button"'))) {
        expect(title.ancestors.at(-1)).toBe('<g aria-hidden="true">');
      }
    }
  });

  it("draws a read-only map's items as named images, never buttons, and is otherwise the same picture", () => {
    // A map to look at promises no action.
    const editing = svgOf(graphOf(APPLY), "down");
    const looking = svgOf(graphOf(APPLY, { ...WORDS, readOnly: true }), "down");
    const roles = (svg: string): string[] => elements(svg).flatMap((element) => (/ data-map-item="/.test(element.tag) ? [/ role="([^"]+)"/.exec(element.tag)?.[1] ?? ""] : []));
    expect(roles(editing).length).toBeGreaterThan(8);
    expect(new Set(roles(editing))).toEqual(new Set(["button"]));
    expect(roles(looking)).toEqual(roles(editing).map(() => "img"));
    expect(looking).not.toContain('role="button"');
    // The same names but the map's label and a "+n more" row's, which offer nothing to select.
    const label = (svg: string): string => /^<svg[^>]* aria-label="([^"]*)"/.exec(svg)![1]!;
    expect(label(looking)).not.toMatch(/Enter|Pages/);
    expect(looking).not.toMatch(/select the step/);
    expect(editing).toMatch(/: select the step to see it\./);
    const restored = looking.replace(/ role="img"/g, ' role="button"').replace(label(looking), label(editing));
    expect(restored).toBe(editing.replace(/: select the step to see (it|them)\./g, "."));
  });

  it("hides the chips that are not items from assistive technology, and draws a route chip in its step's group where the layout put it", () => {
    const offset = (tag: string): number[] => /translate\(([-\d.]+) ([-\d.]+)\)/.exec(tag)!.slice(1).map(Number);
    for (const direction of ["down", "right"] as const) {
      const graph = graphOf(APPLY);
      const layout = layoutFlow(journeyMapLayoutInput(graph, { direction }));
      const tags = elements(journeyMapSvg(graph, layout));
      const hidden = (element: { ancestors: string[] }): boolean => element.ancestors.some((ancestor) => ancestor.includes('aria-hidden="true"'));
      const chips = tags.filter((element) => /class="[^"]*jm-label[ "]/.test(element.tag));
      expect(chips.filter((chip) => !chip.tag.includes("data-map-item")).length).toBeGreaterThan(0);
      for (const chip of chips) {
        expect(hidden(chip), chip.tag).toBe(!chip.tag.includes("data-map-item"));
      }
      const routes = graph.edges.filter((edge) => edge.label?.item !== undefined);
      expect(routes.length).toBeGreaterThan(1);
      for (const edge of routes) {
        const chip = chips.find((element) => element.tag.includes(`data-edge="${edge.key}"`))!;
        // In its step's group, which its line leaves.
        const page = chip.ancestors.at(-1)!;
        expect(edge.from).toMatch(/^page:/);
        expect(page).toContain(`class="jm-page`);
        expect(page).toContain(`data-map-node="${edge.from}"`);
        const [pageX, pageY] = offset(page);
        const [chipX, chipY] = offset(chip.tag);
        const box = layout.edges[edge.key]!.label!;
        expect(pageX! + chipX!).toBe(Math.round(box.x * 2) / 2);
        expect(pageY! + chipY!).toBe(Math.round(box.y * 2) / 2);
      }
    }
  });

  it("paints through classes only: no colour attributes, no markers, no ids", () => {
    for (const direction of ["down", "right"] as const) {
      const svg = svgOf(graphOf(APPLY), direction);
      expect(svg).not.toMatch(/\s(fill|stroke|color|style|stop-color)=/);
      expect(svg).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
      expect(svg).not.toMatch(/rgba?\(/);
      expect(svg).not.toContain("<marker");
      expect(svg).not.toMatch(/\sid=/);
    }
  });

  it("says the map in its items' names, a sentence per step, and draws no list of words beside the picture", () => {
    // The map's text alternative is its items (each step, way out and stub is named with its full sentence, in reading
    // order); the disclosure that listed the same sentences again under the map is gone.
    const graph = graphOf(APPLY);
    const svg = svgOf(graph, "down");
    const pages = graph.nodes.filter((node) => node.kind === "page");
    for (const page of pages) {
      expect(svg).toContain(page.description.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    }
    expect(svg).toContain("Route 4 of Step 3 · About you, ignored: it goes to “gone”, which is not a step of the journey.");
    expect(svg).not.toContain("jm-alt");
    expect(svg).not.toContain("The journey in words");
  });

  it("draws a journey of component ids alone byte for byte as before presentations' own nodes", () => {
    // The markup and the words in both directions, as drawn before own nodes were counted.
    // A change here is a change to every journey's map: make it on purpose.
    const graph = graphOf(APPLY);
    const drawn: string[] = [];
    for (const direction of ["down", "right"] as const) {
      drawn.push(svgOf(graph, direction));
    }
    expect(createHash("sha256").update(drawn.join("\n")).digest("hex")).toBe("425106e58e000352c58701cd4eeb3eef3c03d30ae58a38a743372b8c3fb2d092");
  });

  it("draws a presentation's own nodes: a row for what a page fills and works out, and its label and line in words saying so", () => {
    const form = presentationRoot();
    const { view, flow } = mapSource(form, applyJourney());
    const graph = journeyMapGraph(view, flow!, mapWords(form, "Apply"));
    for (const direction of ["down", "right"] as const) {
      const svg = svgOf(graph, direction);
      // Each a row under the meta line, as the other notes are.
      expect(svg).toContain('<text class="jm-node__meta" x="40" y="38">details · 1 question</text> <text class="jm-node__note" x="40" y="53">Fills Email</text>');
      expect(svg).toContain('<text class="jm-node__meta" x="40" y="38">income · 3 questions</text> <text class="jm-node__note" x="40" y="53">Works out Annual income</text>');
      expect(svg).toContain('aria-label="1 Your details details · 1 question Fills Email. Step 1 of 3, Your details, id details, 1 question. It fills Email. Then to Step 2 · Your income."');
      expect(svg).toContain("<title>Step 2 of 3, Your income, id income, 3 questions. It works out Annual income. Leaves by: ");
      expect(all(svg, /data-map-item="([^"]+)"/g)).toEqual(graph.readingOrder);
    }
    expect(svgOf(graph, "down")).toContain("Step 1 of 3, Your details, id details, 1 question. It fills Email. Then to Step 2 · Your income.");
    // A variant of one page: references in a layout of its own, and a paragraph.
    const variant = mapSource(form, publicVariant());
    const one = journeyMapGraph(variant.view, variant.flow!, mapWords(form, "Public"));
    expect(svgOf(one, "down")).toContain(
      '<text class="jm-node__meta" x="40" y="38">all · 2 questions</text><title>Step 1 of 1, Tell us about you, id all, 2 questions. Then to the end, which submits.</title>'
    );
  });

  it("escapes the labels of what a page fills", () => {
    const form = presentationRoot();
    (form.children!.content![0]!.configuration as Record<string, unknown>).label = "<b>Email</b> & co";
    const { view, flow } = mapSource(form, applyJourney());
    const svg = svgOf(journeyMapGraph(view, flow!, mapWords(form, "Apply")), "down");
    expect(svg).toContain(">Fills &lt;b&gt;Email&lt;/b&gt; &amp; co</text>");
    expect(svg).toContain("It fills &lt;b&gt;Email&lt;/b&gt; &amp; co.");
    expect(svg).not.toContain("<b>");
  });
});

// --- styles -----------------------------------------------------------------------------------

/** The builder's own token block, as source. */
/** The builder's declared tokens, as every builder root prints them (studio-tokens.ts). */
function builderTokensSource(): string {
  return studioTokenDeclarations();
}

/** The default palette, read from the builder's own token block. */
function defaultPalette(): Record<string, string> {
  const block = builderTokensSource();
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/--(db-[a-z-]+):\s*(#[0-9a-f]{6}|var\(--(db-[a-z-]+)\));/g)) {
    if (!(match[1]! in out)) {
      out[match[1]!] = match[2]!.startsWith("#") ? match[2]! : out[match[3]!]!;
    }
  }
  return out;
}

function luminance(hex: string): number {
  const channel = (index: number): number => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

describe("JOURNEY_MAP_STYLES", () => {
  it("reads only builder tokens the builder declares, and names the chunk's sentinel", () => {
    const read = new Set([...JOURNEY_MAP_STYLES.matchAll(/var\(--(db-[a-z0-9-]+)\s*[,)]/g)].map((match) => match[1]!));
    expect(read.size).toBeGreaterThan(8);
    const declared = new Set([...builderTokensSource().matchAll(/--(db-[a-z0-9-]+):/g)].map((match) => match[1]!));
    // A fill a theme may declare, read with each rule's own fallback; and the
    // shell's geometry, no theme's: how far the side drawer and the inspector reach over the page,
    // and the gap the canvas keeps its bars from the edge by.
    const undeclared = new Set(["db-btn-bg", "db-side-w", "db-props-w", "db-gap"]);
    expect([...read].filter((name) => !declared.has(name) && !undeclared.has(name))).toEqual([]);
    expect(JOURNEY_MAP_STYLES).toContain(`.${JOURNEY_MAP_ROOT_CLASS}`);
    expect(JOURNEY_MAP_ROOT_CLASS).toBe("datum-journey-map");
    // The designer's card sentinel belongs to the designer's chunk alone.
    expect(JOURNEY_MAP_STYLES).not.toContain("datum-journey-card");
  });

  it("reaches nothing outside the map, so a second root may adopt it whole: every selector is a class of the map's or under its root", () => {
    const css = JOURNEY_MAP_STYLES.replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .map((match) => match[1]!.trim())
      .filter((selector) => !selector.startsWith("@"))
      .flatMap((selector) => selector.split(",").map((part) => part.replace(/^@media[^{]*\{/, "").trim()));
    expect(selectors.length).toBeGreaterThan(40);
    for (const selector of selectors) {
      expect(selector, selector).toMatch(/^(\.datum-journey-map\b|\.jm-)/);
    }
  });

  it("marks the way taken in classes the surface lays on: the current step on the wash, the ways taken in accent, never a fade", () => {
    const css = JOURNEY_MAP_STYLES.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.jm-page\.is-current \.jm-node__box \{[^}]*fill: var\(--jm-accent-soft\);[^}]*stroke: var\(--jm-accent\);/);
    expect(css).toMatch(/\.jm-page\.is-taken \.jm-node__box \{[^}]*stroke: var\(--jm-accent\);/);
    expect(css).not.toContain("is-passed");
    expect(css).toMatch(/\.datum-journey-map \.jm-edge\.is-taken \.jm-edge__line \{[^}]*stroke: var\(--jm-accent\);/);
    expect(css).toMatch(/\.datum-journey-map\.has-path \.jm-edge:not\(\.is-taken\) \.jm-edge__line \{ stroke: var\(--jm-muted\); \}/);
    // A read-only map offers no pointer to what it will not select.
    expect(css).toContain(".datum-journey-map[data-read-only] [data-select] { cursor: default; }");
  });

  it("writes no colour but as a token's fallback, and no backtick", () => {
    expect(JOURNEY_MAP_STYLES).not.toContain("`");
    const withoutFallbacks = JOURNEY_MAP_STYLES.replace(/var\(--db-[a-z0-9-]+,\s*#[0-9a-f]{6}\)/g, "");
    expect(withoutFallbacks).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(withoutFallbacks).not.toMatch(/rgba?\(/);
  });

  it("draws a step with no fields as any other step: no dashed outline, no pass-by line, and a dead line dotted still", () => {
    const css = JOURNEY_MAP_STYLES.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toContain("jm-edge--pass");
    expect(css).not.toContain("is-empty");
    expect(css).toMatch(/\.jm-edge\.is-dead \.jm-edge__line \{[^}]*stroke-dasharray:/);
    const svg = svgOf(graphOf({ id: "apply", pages: [{ id: "one", components: ["age"] }, { id: "nothing" }, { id: "last", components: ["name"] }] }), "down");
    expect(svg).toContain('<g class="jm-edge jm-edge--next is-spine" data-edge="next:journey-page_2"');
    expect(svg).not.toContain("is-empty");
    expect(svg).toContain(">No fields yet<");
  });

  it("never fades the picture's text: only lines dim, and a tool of the bar that is off", () => {
    const rules = JOURNEY_MAP_STYLES.replace(/\/\*[\s\S]*?\*\//g, "").split("}").filter((rule) => /opacity\s*:/.test(rule.slice(rule.indexOf("{"))));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const selectors = rule.slice(0, rule.indexOf("{")).split(",").map((selector) => selector.trim());
      for (const selector of selectors) {
        // The picture's lines dim; so does a tool of the bar that is off (a disabled button, as in every bar).
        expect(selector, selector).toMatch(/\.jm-edge__(line|head)$|^\.jm-btn\[aria-disabled="true"\]$/);
      }
    }
  });

  it("re-points every colour alias to a system colour in forced colours, where the state rules would outrank any rule of its own", () => {
    const css = JOURNEY_MAP_STYLES.replace(/\/\*[\s\S]*?\*\//g, "");
    const root = /\.datum-journey-map \{([^}]*)\}/.exec(css)![1]!;
    const aliases = [...root.matchAll(/(--jm-[a-z-]+):\s*var\(--db-/g)].map((match) => match[1]!);
    expect(aliases.length).toBeGreaterThan(8);
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    const block = /\.datum-journey-map \{([^}]*)\}/.exec(forced)![1]!;
    for (const alias of aliases) {
      expect(block, alias).toMatch(new RegExp(`${alias}:\\s*(Canvas|CanvasText|GrayText|Highlight)\\s*;`));
    }
    // A disabled button (New rule with nothing selected, a zoom at its end) keeps looking disabled.
    expect(forced).toMatch(/\.jm-btn\[aria-disabled="true"\] \{ color: GrayText; opacity: 1; \}/);
  });

  it("keeps a stale map's lines at full strength, and lands an item scrolled into view below the sticky head and clear of the side drawer", () => {
    const css = JOURNEY_MAP_STYLES.replace(/\/\*[\s\S]*?\*\//g, "");
    const stale = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((match) => match[1]!.includes("is-stale"));
    expect(stale.length).toBeGreaterThan(0);
    for (const rule of stale) {
      expect(rule[2], rule[1]).not.toMatch(/opacity/);
    }
    expect(css).toMatch(/\.jm-item, \.jm-page \{ scroll-margin-top: var\(--jm-head-room, \d+px\); scroll-margin-left: calc\(var\(--jm-cover, 0px\) \+ 16px\); \}/);
    // The head sticks clear of the side drawer: inside the canvas, the shell's
    // --db-side-w is how far the drawer reaches, nothing while it is folded. (The foot that held the
    // journey in words is gone: the items' names say it.)
    expect(css).toContain("--jm-cover: min(var(--db-side-w, 0px), max(0px, calc(var(--jm-view-w, 100%) - 160px)));");
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    for (const selector of [".jm-head"]) {
      const body = rules.find((rule) => rule[1]!.trim() === selector)?.[2] ?? "";
      expect(body, selector).toMatch(/position: sticky;[^;]*;? ?(top: 0; )?left: var\(--jm-cover, 0px\);/);
      expect(body, selector).toContain("max-width: calc(var(--jm-view-w, 100%) - var(--jm-cover, 0px));");
    }
    // The shell's half: the drawer folded, it reaches over nothing.
    const shell = readFileSync(fileURLToPath(new URL("../form-engine/builder/web-component/default-builder-element.ts", import.meta.url)), "utf8");
    expect(shell).toContain(".wrap[data-side-collapsed] datum-builder-canvas { --db-side-w: 0px; }");
  });

  it("clears the contrast floors in the default palette", () => {
    const t = defaultPalette();
    for (const token of ["db-backdrop", "db-surface", "db-ink", "db-ink-muted", "db-accent", "db-accent-soft", "db-danger", "db-danger-soft", "db-warn", "db-line-card"]) {
      expect(t[token], token).toMatch(/^#[0-9a-f]{6}$/);
    }
    // Lines and arrowheads on the backdrop: 3:1 (WCAG 1.4.11). A way no path takes is a dotted
    // muted line; a way taken an accent one.
    for (const line of ["db-ink", "db-ink-muted", "db-accent"]) {
      expect(contrast(t[line]!, t["db-backdrop"]!), `${line} on the backdrop`).toBeGreaterThanOrEqual(3);
    }
    // Text on the card and chip fill: 4.5:1, dead chips and ignored routes included.
    for (const text of ["db-ink", "db-ink-muted", "db-accent", "db-danger", "db-warn"]) {
      expect(contrast(t[text]!, t["db-surface"]!), `${text} on the panel`).toBeGreaterThanOrEqual(4.5);
    }
    // Start, End, the page number and the current step's card sit on the accent wash; End that never submits on the danger wash.
    expect(contrast(t["db-ink"]!, t["db-accent-soft"]!)).toBeGreaterThanOrEqual(4.5);
    // The current step's card keeps its own words on the wash: its meta and notes (muted), and its
    // badge (danger or warning), as on the panel.
    for (const text of ["db-ink-muted", "db-danger", "db-warn"]) {
      expect(contrast(t[text]!, t["db-accent-soft"]!), `${text} on the accent wash`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t["db-danger"]!, t["db-danger-soft"]!)).toBeGreaterThanOrEqual(4.5);
    // A card stands on the backdrop by its fill (HDR floor 1.15:1) or, where the fill is too
    // close (a flat theme), by its outline.
    const byFill = contrast(t["db-surface"]!, t["db-backdrop"]!) >= 1.15;
    const byOutline = contrast(t["db-line-card"]!, t["db-backdrop"]!) >= 3;
    expect(byFill || byOutline).toBe(true);
  });
});

describe("the map's modules", () => {
  it("load no designer faces, checks or preview, and do nothing at import", () => {
    for (const name of ["journey-map-model.ts", "journey-map-layout.ts", "journey-map-svg.ts", "journey-map-styles.ts", "journey-map-preferences.ts", "journey-map.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`../form-engine/builder/journey-map/${name}`, import.meta.url)), "utf8");
      for (const match of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)) {
        const [, typeOnly, from] = match;
        expect(from, `${name} imports ${from}`).not.toMatch(/journey-components|journey-preview|journey-designer\.js|journey-builder-mode/);
        if (/journey-checks|journey-diagnostics|journey-tree/.test(from!)) {
          expect(typeOnly, `${name} may import only types from ${from}`).toBeDefined();
        }
      }
      // No statement at the top level but declarations, imports and exports of them.
      for (const line of source.split("\n")) {
        if (/^[a-zA-Z]/.test(line)) {
          expect(line, `${name}: ${line}`).toMatch(/^(import|export (type |interface |function |const |class )|export \{|type |interface |function |const |let |\/\*\*| \*)/);
        }
      }
    }
  });
});
