// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { JOURNEY_PREVIEW_LENT as LENT, createJourneyDesigner } from "../form-engine/builder/journey-designer/journey-designer.js";
import { JOURNEY_PAGES_SLOT } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { createJourneyPreviewSession, type JourneyPreviewSession, type JourneyPreviewSubject } from "../form-engine/builder/journey-designer/journey-preview.js";
import { tryMapState } from "../form-engine/builder/journey-designer/journey-try-map.js";
import { treeFromJourney } from "../form-engine/builder/journey-designer/journey-tree.js";
import { createJourneyMap, journeyMapEdgeId, type JourneyMap, type JourneyMapSubject } from "../form-engine/builder/journey-map/journey-map.js";
import { mapWords } from "./flowmap-words.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { JourneyDecision } from "../form-engine/core/journey/journey-types.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";

/**
 * What Try it tells the journey map: the current step and the ways
 * taken to it, from the runtime's view and the decisions of its path. The helper is pure and
 * tested alone; the session ties it to a real runtime, and a real map shows the marks the ids
 * name (a spelling that drifted from the map's would mark nothing).
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const pages = (...ids: string[]): Array<{ id: string }> => ids.map((id) => ({ id }));

describe("tryMapState (the pure helper)", () => {
  it("names the ways behind the current step: Start, a route by its written position, a fall-through", () => {
    const decisions: JourneyDecision[] = [
      { kind: "route", pageId: "a", routeIndex: 1, to: "d" },
      { kind: "next", pageId: "b", to: "c" },
      { kind: "next", pageId: "c", to: "d" },
      { kind: "next", pageId: "d", to: "$end" }
    ];
    // Path a > d by a's second route: b and c are not on it (a route past them), d is current.
    const state = tryMapState({ pages: pages("a", "b", "c", "d"), nodes: ["na", "nb", "nc", "nd"], path: ["a", "d"], index: 1, decisions: decisions.slice(0, 1) });
    expect(state).toEqual({ currentNodeId: "nd", takenEdges: ["start", "route:na:1"] });

    // The same path, one step further (nothing taken after the current step, though the path goes on).
    const walked = tryMapState({ pages: pages("a", "b", "c", "d"), nodes: ["na", "nb", "nc", "nd"], path: ["a", "b", "c", "d"], index: 3, decisions: [{ kind: "next", pageId: "a", to: "b" }, decisions[1]!, decisions[2]!, decisions[3]!] });
    expect(walked).toEqual({ currentNodeId: "nd", takenEdges: ["start", "next:na", "next:nb", "next:nc"] });
  });

  it("marks only what is behind the person: the path's forecast stays unmarked, and Back unmarks what it leaves", () => {
    const decisions: JourneyDecision[] = [
      { kind: "next", pageId: "a", to: "b" },
      { kind: "next", pageId: "b", to: "c" },
      { kind: "next", pageId: "c", to: "$end" }
    ];
    const at = (index: number) => tryMapState({ pages: pages("a", "b", "c"), nodes: ["na", "nb", "nc"], path: ["a", "b", "c"], index, decisions });
    expect(at(0)).toEqual({ currentNodeId: "na", takenEdges: ["start"] });
    expect(at(1)).toEqual({ currentNodeId: "nb", takenEdges: ["start", "next:na"] });
    expect(at(2)).toEqual({ currentNodeId: "nc", takenEdges: ["start", "next:na", "next:nb"] });
    expect(at(1).takenEdges).toEqual(["start", "next:na"]);
  });

  it("finds each step by position, so two steps sharing a page id stay two steps", () => {
    const decisions: JourneyDecision[] = [
      { kind: "next", pageId: "twin", to: "twin" },
      { kind: "route", pageId: "twin", routeIndex: 0, to: "end" },
      { kind: "next", pageId: "end", to: "$end" }
    ];
    const state = tryMapState({ pages: pages("twin", "twin", "end"), nodes: ["n1", "n2", "n3"], path: ["twin", "twin", "end"], index: 2, decisions });
    expect(state).toEqual({ currentNodeId: "n3", takenEdges: ["start", "next:n1", "route:n2:0"] });
    expect(tryMapState({ pages: pages("twin", "twin", "end"), nodes: ["n1", "n2", "n3"], path: ["twin", "twin", "end"], index: 1, decisions }).currentNodeId).toBe("n2");
  });

  it("marks the step alone without decisions, and nothing without a step; a page without a node is never named", () => {
    expect(tryMapState({ pages: pages("a", "b"), nodes: ["na", "nb"], path: ["a", "b"], index: 1 })).toEqual({ currentNodeId: "nb", takenEdges: ["start"] });
    expect(tryMapState({ pages: pages("a", "b"), nodes: ["na", "nb"], path: [], index: 0 })).toEqual({ takenEdges: [] });
    expect(tryMapState({ pages: pages("a", "b"), nodes: ["na", "nb"], path: ["a"], index: 4 })).toEqual({ takenEdges: [] });
    const state = tryMapState({ pages: pages("a", "b"), nodes: [undefined, "nb"], path: ["a", "b"], index: 1, decisions: [{ kind: "next", pageId: "a", to: "b" }] });
    expect(state).toEqual({ currentNodeId: "nb", takenEdges: ["start"] });
    // A decision for a page the journey does not have is skipped.
    expect(tryMapState({ pages: pages("a"), nodes: ["na"], path: ["a"], index: 0, decisions: [{ kind: "next", pageId: "zz", to: "$end" }] }).takenEdges).toEqual(["start"]);
  });

  it("spells each way as the map does", () => {
    const state = tryMapState({
      pages: pages("a", "b", "c"),
      nodes: ["na", "nb", "nc"],
      path: ["a", "c"],
      index: 1,
      decisions: [{ kind: "route", pageId: "a", routeIndex: 2, to: "c" }]
    });
    expect(state.takenEdges).toEqual([journeyMapEdgeId({ kind: "start" }), journeyMapEdgeId({ kind: "route", from: "na", routeIndex: 2 })]);
  });
});

// --- the session over a real runtime, and a real map ---------------------------------------------

const methodIs = (value: string): Expression => ({
  kind: "binary",
  operator: "eq",
  left: { kind: "path", path: "contactMethod" },
  right: { kind: "literal", value }
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        {
          id: "contactMethod",
          type: "select",
          configuration: { label: "Contact method", options: [{ value: "mail", label: "Mail" }, { value: "phone", label: "Phone" }] }
        },
        // Shown only to a phone contact: with the answer "mail" the step that asks it shows empty.
        { id: "phoneNumber", type: "text", configuration: { label: "Phone number" }, rules: { visibleWhen: methodIs("phone") } },
        { id: "notes", type: "text", configuration: { label: "Notes" } },
        { id: "consent", type: "checkbox", configuration: { label: "I agree" } }
      ]
    }
  };
}

function journey(): Journey {
  return {
    id: "intake",
    name: "Step by step",
    pages: [
      { id: "about", title: "About you", components: ["fullName", "contactMethod"], routes: [{ when: methodIs("none"), to: "finish" }] },
      { id: "phone", title: "Phone", components: ["phoneNumber"] },
      { id: "more", title: "More", components: ["notes"] },
      { id: "finish", title: "Finish", components: ["consent"] }
    ]
  };
}

interface Rig {
  session: JourneyPreviewSession;
  map: JourneyMap;
  nodes: string[];
  runtime: FormRuntime;
  /** Sets the map's state from the session, as the mode does on every move. */
  sync(): void;
}

function rig(value: Journey = journey()): Rig {
  const form = new BuilderController({ initialRoot: formRoot(), locale: "en" });
  const designer = createJourneyDesigner({ formRoot: () => form.snapshot(), locale: () => form.currentLocale() });
  const pageIds = new Map<string, string>();
  const tree = treeFromJourney(value, { pageIds });
  const controller = new BuilderController({ componentTypes: [], initialRoot: tree });
  const design = designer.entry({ journeyId: () => value.id, tree: () => controller.previewSnapshot(), pageIds });
  controller.setOptions({ ...design.builderOptions, initialRoot: tree, locale: "en" });
  const subject: JourneyPreviewSubject = { journeyId: value.id, tree: () => controller.previewSnapshot(), pageIds };
  const mapSubject: JourneyMapSubject = { journeyId: value.id, name: () => value.id, view: () => design.view(), selected: () => undefined };
  const nodes = (controller.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? []).map((node) => node.id);

  const scroller = document.createElement("div");
  document.body.append(scroller);
  const map = createJourneyMap({ layout: { direction: "down" }, words: (name) => mapWords(form.snapshot(), name), readOnly: true, scroller });
  scroller.append(map.element);
  map.show(mapSubject);

  const state: { session?: JourneyPreviewSession } = {};
  const session = createJourneyPreviewSession({ form, lent: LENT, formIndex: () => designer.form(), onPath: () => state.session && map.setState(state.session.mapState()) });
  state.session = session;
  session.show(subject);
  return { session, map, nodes, runtime: session.runtime as unknown as FormRuntime, sync: () => map.setState(session.mapState()) };
}

function groups(map: JourneyMap, ...classes: string[]): string[] {
  return [...map.element.querySelectorAll(".jm-page")].filter((group) => classes.every((name) => group.classList.contains(name))).map((group) => group.getAttribute("data-map-node")!.replace("page:", ""));
}

function takenLines(map: JourneyMap): string[] {
  return [...new Set([...map.element.querySelectorAll(".jm-edge.is-taken")].map((line) => line.getAttribute("data-edge")!))];
}

describe("the session's map state over a real runtime", () => {
  it("marks the step shown and the ways taken as the person goes on and comes back", async () => {
    const { session, map, nodes, runtime } = rig();
    expect(session.mapState()).toEqual({ currentNodeId: nodes[0], takenEdges: ["start"] });
    expect(groups(map, "is-current")).toEqual([nodes[0]]);

    runtime.setValue("contactMethod", "mail");
    // The phone step asks only a phone contact: with mail nothing on it shows, and it is shown all the same.
    expect((await runtime.nextPage()).ok).toBe(true);
    expect(session.mapState()).toEqual({ currentNodeId: nodes[1], takenEdges: ["start", `next:${nodes[0]}`] });
    expect(groups(map, "is-current")).toEqual([nodes[1]]);
    expect(groups(map, "is-taken")).toEqual([nodes[0]]);
    // Every id the helper named is a line the map draws.
    expect(takenLines(map)).toEqual(expect.arrayContaining([`next:${nodes[0]}`]));

    // Back unmarks what it leaves.
    expect((await runtime.previousPage()).ok).toBe(true);
    expect(session.mapState()).toEqual({ currentNodeId: nodes[0], takenEdges: ["start"] });
    expect(groups(map, "is-current")).toEqual([nodes[0]]);
    expect(groups(map, "is-taken")).toEqual([]);
    expect(takenLines(map).filter((id) => id !== "start")).toEqual([]);
  });

  it("marks a route taken by its written position, and the steps it goes past are not marked", async () => {
    const { session, map, nodes, runtime } = rig();
    runtime.setValue("contactMethod", "none");
    expect((await runtime.nextPage()).ok).toBe(true);
    expect(session.mapState()).toEqual({ currentNodeId: nodes[3], takenEdges: ["start", `route:${nodes[0]}:0`] });
    expect(takenLines(map)).toContain(`route:${nodes[0]}:0`);
    expect(groups(map, "is-current")).toEqual([nodes[3]]);
    expect(groups(map, "is-taken")).toEqual([nodes[0]]);
  });

  it("is told on every move, with the card's words unchanged or not", async () => {
    const heard: string[] = [];
    const form = new BuilderController({ initialRoot: formRoot(), locale: "en" });
    const designer = createJourneyDesigner({ formRoot: () => form.snapshot(), locale: () => form.currentLocale() });
    const pageIds = new Map<string, string>();
    const tree = treeFromJourney(journey(), { pageIds });
    const controller = new BuilderController({ componentTypes: [], initialRoot: tree });
    const design = designer.entry({ journeyId: () => "intake", tree: () => controller.previewSnapshot(), pageIds });
    controller.setOptions({ ...design.builderOptions, initialRoot: tree, locale: "en" });
    const session = createJourneyPreviewSession({ form, lent: LENT, formIndex: () => designer.form(), onPath: () => heard.push("path") });
    session.show({ journeyId: "intake", tree: () => controller.previewSnapshot(), pageIds });
    const runtime = session.runtime as unknown as FormRuntime;
    heard.length = 0;
    // A keystroke in a field moves neither the page nor the card, and the map is still asked.
    runtime.setValue("fullName", "Ada");
    expect(heard.length).toBeGreaterThan(0);
  });

  it("has no state without a step, and only the step with a runtime that cannot say its decisions", async () => {
    const empty = rig({ id: "intake", pages: [] });
    expect(empty.session.mapState()).toBeUndefined();

    const { session, nodes, runtime } = rig();
    runtime.setValue("contactMethod", "mail");
    expect((await runtime.nextPage()).ok).toBe(true);
    // A host's runtime that has no `journeyTrace`: the step is marked, no way is.
    (runtime as unknown as { journeyTrace: undefined }).journeyTrace = undefined;
    expect(session.mapState()).toEqual({ currentNodeId: nodes[1], takenEdges: ["start"] });
  });
});

describe("a step reached by Change", () => {
  const withCheck = (): Journey => ({
    id: "intake",
    pages: [
      { id: "about", title: "About you", components: ["fullName", "contactMethod"] },
      { id: "more", title: "More", components: ["notes"] },
      { id: "check", title: "Check your answers", kind: "review" }
    ]
  });

  it("says Continue returns to the check step, and says nothing otherwise", async () => {
    const { session, nodes, runtime } = rig(withCheck());
    const note = (): string => /data-try-journey-returning>([^<]*)</.exec(session.card())?.[1] ?? "";
    runtime.setValue("fullName", "Ada");
    expect((await runtime.nextPage()).ok).toBe(true);
    expect((await runtime.nextPage()).ok).toBe(true);
    expect(runtime.journeyView()!.pageId).toBe(nodes[2]);
    expect(note()).toBe("");

    expect((await runtime.goToPage!(nodes[0]!, { direction: "change" })).ok).toBe(true);
    expect(runtime.journeyView()!.returning).toBeDefined();
    expect(note()).toBe("1 About you · changing an answer. Continue returns to 3 Check your answers.");
    // The map is on the step being changed, the check step ahead of it unmarked.
    expect(session.mapState()!.currentNodeId).toBe(nodes[0]);

    // Continue goes straight back to the check step (everything between is done), and the note is gone.
    expect((await runtime.nextPage()).ok).toBe(true);
    expect(runtime.journeyView()!.pageId).toBe(nodes[2]);
    expect(note()).toBe("");
  });
});
