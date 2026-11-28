import { describe, expect, it } from "vitest";

import type { UnlistedJourney } from "../form-engine/builder/journey-designer/journey-catalog.js";
import {
  checkJourneyTree,
  findingsSummary,
  indexJourneyTree,
  placeJourneyFindings,
  type JourneyNodePlacement
} from "../form-engine/builder/journey-designer/journey-checks.js";
import {
  JOURNEY_CONTENT_SLOT,
  JOURNEY_PAGES_SLOT,
  JOURNEY_ROOT_TYPE,
  JOURNEY_ROUTE_TYPE,
  JOURNEY_ROUTES_SLOT
} from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { journeyNodeTemplate, treeFromJourney } from "../form-engine/builder/journey-designer/journey-tree.js";
import { journeyFieldRows, journeyFindingEntries } from "../form-engine/builder/journey-designer/journey-findings.js";
import { unassignedMembers } from "../form-engine/builder/journey-designer/journey-from-form.js";
import { indexJourneyForm, journeyNotes, type JourneyDesignView, type JourneyFacesContext } from "../form-engine/builder/journey-designer/journey-components.js";
import type { JourneyDiagnostic, JourneyDiagnosticCode } from "../form-engine/core/journey/journey-diagnostics.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * Where the Journeys designer draws a journey's findings: each `diagnoseJourney`
 * code on the node it concerns, found through the node marks the journey is written with, so
 * repeated page ids and routes with no target yet do not misplace them.
 */

function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        { id: "email", type: "text", configuration: { label: "Email" } },
        { id: "notes", type: "text", configuration: { label: "Notes" } }
      ]
    }
  };
}

function page(tree: ComponentNode, index: number): ComponentNode {
  return tree.children?.[JOURNEY_PAGES_SLOT]?.[index] as ComponentNode;
}

function routeNode(tree: ComponentNode, pageIndex: number, routeIndex: number): ComponentNode {
  return page(tree, pageIndex).children?.[JOURNEY_ROUTES_SLOT]?.[routeIndex] as ComponentNode;
}

function questionNode(tree: ComponentNode, pageIndex: number, questionIndex: number): ComponentNode {
  return page(tree, pageIndex).children?.[JOURNEY_CONTENT_SLOT]?.[questionIndex] as ComponentNode;
}

/** Two pages, the second listing fullName again, with routes on the first. */
const TREE = treeFromJourney({
  id: "j",
  pages: [
    { id: "a", components: ["fullName", "email"], routes: [{ to: "b" }, { to: "$end" }] },
    { id: "b", components: ["fullName", "notes"] }
  ]
});

const PLACEMENT: JourneyNodePlacement = {
  tree: TREE,
  pages: [
    { nodeId: page(TREE, 0).id, pageId: "a", routes: [routeNode(TREE, 0, 0).id, routeNode(TREE, 0, 1).id] },
    { nodeId: page(TREE, 1).id, pageId: "b", routes: [] }
  ]
};

function diagnostic(code: JourneyDiagnosticCode, place: Partial<JourneyDiagnostic> = {}): JourneyDiagnostic {
  return { severity: "error", code, journeyId: "j", message: code, ...place };
}

/** Where each code lands: `root`, `tray:<componentId>`, or node ids (every node that carries it). */
function landing(entry: JourneyDiagnostic): string[] {
  const placed = placeJourneyFindings([entry], PLACEMENT);
  const out: string[] = [];
  if (placed.root.length > 0) {
    out.push("root");
  }
  for (const [componentId] of placed.unassigned) {
    out.push(`tray:${componentId}`);
  }
  for (const [nodeId] of placed.byNode) {
    out.push(nodeId);
  }
  return out;
}

describe("placeJourneyFindings", () => {
  const pageA = page(TREE, 0).id;
  const pageB = page(TREE, 1).id;
  const cases: Array<[string, JourneyDiagnostic, string[]]> = [
    ["journey.no-end on the root", diagnostic("journey.no-end"), ["root"]],
    ["journey.duplicate-id on the root", diagnostic("journey.duplicate-id"), ["root"]],
    ["page.id-is-component-id on its page", diagnostic("page.id-is-component-id", { pageId: "b" }), [pageB]],
    ["page.unreachable on its page", diagnostic("page.unreachable", { pageId: "b", severity: "warning" }), [pageB]],
    ["page.no-title on its page", diagnostic("page.no-title", { pageId: "a", severity: "warning" }), [pageA]],
    ["page.validation-server-deferred on its page", diagnostic("page.validation-server-deferred", { pageId: "a", severity: "warning" }), [pageA]],
    ["page.validation-on-exit on its page", diagnostic("page.validation-on-exit", { pageId: "b", severity: "warning" }), [pageB]],
    ["page.unknown-component on the question", diagnostic("page.unknown-component", { pageId: "a", componentId: "email" }), [questionNode(TREE, 0, 1).id]],
    ["page.entry-field on the question", diagnostic("page.entry-field", { pageId: "b", componentId: "notes", severity: "warning" }), [questionNode(TREE, 1, 1).id]],
    ["page.root-component on the question", diagnostic("page.root-component", { pageId: "a", componentId: "fullName" }), [questionNode(TREE, 0, 0).id]],
    ["route.unknown-target on the route", diagnostic("route.unknown-target", { pageId: "a", routeIndex: 1 }), [routeNode(TREE, 0, 1).id]],
    ["route.backward on the route", diagnostic("route.backward", { pageId: "a", routeIndex: 0 }), [routeNode(TREE, 0, 0).id]],
    ["route.shadowed on the route", diagnostic("route.shadowed", { pageId: "a", routeIndex: 1, severity: "warning" }), [routeNode(TREE, 0, 1).id]],
    ["a page's condition.scope on the page", diagnostic("condition.scope", { pageId: "b" }), [pageB]],
    ["a page's condition.invalid on the page", diagnostic("condition.invalid", { pageId: "b" }), [pageB]],
    ["a route's condition.unknown-field on the route", diagnostic("condition.unknown-field", { pageId: "a", routeIndex: 0, severity: "warning" }), [routeNode(TREE, 0, 0).id]],
    [
      "a page's condition.reads-later-page on the page, not the question",
      diagnostic("condition.reads-later-page", { pageId: "a", componentId: "notes", severity: "warning" }),
      [pageA]
    ],
    ["component.unassigned in the tray", diagnostic("component.unassigned", { componentId: "notes", severity: "warning" }), ["tray:notes"]],
    ["a required component.unassigned in the tray too", diagnostic("component.unassigned", { componentId: "notes", required: true }), ["tray:notes"]],
    ["component.hidden-required in the tray, where its fix-it is", diagnostic("component.hidden-required", { componentId: "notes", required: true, requiredField: "notes", hidden: true }), ["tray:notes"]],
    ["calc.input-left-out in the tray, under the input a page can ask", diagnostic("calc.input-left-out", { componentId: "notes", required: true, requiredField: "email" }), ["tray:notes"]],
    // The journey-wide count says again what each field's own warning says; the card lists those, once, so it is not placed.
    ["presentation.fields-left-out nowhere", diagnostic("presentation.fields-left-out", { severity: "warning" }), []],
    [
      "component.multiple-pages on every question listing it",
      diagnostic("component.multiple-pages", { componentId: "fullName", severity: "warning" }),
      [questionNode(TREE, 0, 0).id, questionNode(TREE, 1, 0).id]
    ],
    ["calc.reads-branch on the root", diagnostic("calc.reads-branch", { componentId: "email", severity: "warning" }), ["root"]],
    ["rule.reads-host on the root", diagnostic("rule.reads-host", { componentId: "email", severity: "warning" }), ["root"]],
    // A condition or a form rule reading a field the journey's pages own, and an entry a usability rule ignores.
    ["a page's condition.reads-presentation-field on the page", diagnostic("condition.reads-presentation-field", { pageId: "b", pageIndex: 1 }), [pageB]],
    [
      "a route's condition.reads-presentation-field on the route",
      diagnostic("condition.reads-presentation-field", { pageId: "a", pageIndex: 0, routeIndex: 1 }),
      [routeNode(TREE, 0, 1).id]
    ],
    ["rule.reads-presentation-field on the root", diagnostic("rule.reads-presentation-field", { componentId: "email" }), ["root"]],
    [
      "presentation.entry-unusable on its page",
      diagnostic("presentation.entry-unusable", { pageId: "b", pageIndex: 1, entryId: "extra", rule: "A", severity: "warning" }),
      [pageB]
    ]
  ];

  it.each(cases)("puts %s", (_name, entry, expected) => {
    expect(landing(entry)).toEqual(expected);
  });

  it("carries whether the form requires a field left out, and whether only the host decides it, so the tray can say so", () => {
    const placed = placeJourneyFindings(
      [
        diagnostic("component.unassigned", { componentId: "notes", required: true, requiredField: "notes" }),
        diagnostic("component.unassigned", { componentId: "email", severity: "warning", required: false, hostBound: true }),
        diagnostic("component.unassigned", { componentId: "fullName", severity: "warning", required: false })
      ],
      PLACEMENT
    );
    expect(placed.unassigned.get("notes")).toEqual([{ severity: "error", code: "component.unassigned", message: "component.unassigned", required: true, requiredField: "notes" }]);
    expect(placed.unassigned.get("email")?.[0]).toEqual({ severity: "warning", code: "component.unassigned", message: "component.unassigned", required: false, hostBound: true });
    expect(placed.unassigned.get("fullName")?.[0]).not.toHaveProperty("hostBound");
    expect([placed.errors, placed.warnings]).toEqual([1, 2]);
  });

  it("carries that no page can ask a hidden required field, and the calculation an input on no page feeds, beside the input's own finding", () => {
    const placed = placeJourneyFindings(
      [
        diagnostic("component.unassigned", { componentId: "notes", required: true, requiredField: "email", hidden: true }),
        diagnostic("component.hidden-required", { componentId: "email", required: true, requiredField: "email", hidden: true }),
        diagnostic("component.unassigned", { componentId: "fullName", severity: "warning", required: false }),
        diagnostic("calc.input-left-out", { componentId: "fullName", required: true, requiredField: "notes" })
      ],
      PLACEMENT
    );
    expect(placed.unassigned.get("notes")?.[0]).toMatchObject({ required: true, requiredField: "email", hidden: true });
    expect(placed.unassigned.get("email")).toEqual([{ severity: "error", code: "component.hidden-required", message: "component.hidden-required", required: true, requiredField: "email", hidden: true }]);
    // The input keeps its own finding; the calculation's error sits beside it, naming the calculated field.
    expect(placed.unassigned.get("fullName")?.map((finding) => [finding.code, finding.severity, finding.requiredField])).toEqual([
      ["component.unassigned", "warning", undefined],
      ["calc.input-left-out", "error", "notes"]
    ]);
    expect(placed.unassigned.get("fullName")?.[1]).not.toHaveProperty("hidden");
    expect(placed.root).toEqual([]);
    expect([placed.errors, placed.warnings]).toEqual([3, 1]);
  });

  it("counts the fields left out once, by their own warnings, not again by the journey's count of them", () => {
    const placed = placeJourneyFindings(
      [
        diagnostic("component.unassigned", { componentId: "notes", severity: "warning", required: false }),
        diagnostic("component.unassigned", { componentId: "email", severity: "warning", required: false }),
        diagnostic("presentation.fields-left-out", { severity: "warning" })
      ],
      PLACEMENT
    );
    expect([placed.errors, placed.warnings]).toEqual([0, 2]);
    expect(placed.root).toEqual([]);
  });

  it("places a page's findings on the page, and counts by severity", () => {
    const placed = placeJourneyFindings(
      [diagnostic("condition.invalid", { pageId: "a" }), diagnostic("page.no-title", { pageId: "a", severity: "warning" })],
      PLACEMENT
    );
    expect(placed.byNode.get(pageA)?.map((finding) => finding.code)).toEqual(["condition.invalid", "page.no-title"]);
    expect(placed.byNode.get(pageA)?.some((finding) => "condition" in finding)).toBe(false);
    expect([placed.errors, placed.warnings]).toEqual([1, 1]);
    expect(findingsSummary(placed)).toBe("1 error, 1 warning");
    expect(findingsSummary({ errors: 0, warnings: 0 })).toBeUndefined();
  });
});

describe("checkJourneyTree", () => {
  it("finds a route's node though a route before it has no target yet", () => {
    const tree = treeFromJourney({
      id: "j",
      pages: [
        { id: "a", components: ["fullName", "email", "notes"], routes: [{ to: "a" }] },
        { id: "b", components: [] }
      ]
    });
    // A route with no target leads the list: it is not written, so the backward one is route 0 of the journey.
    const pending = { ...(journeyNodeTemplate(JOURNEY_ROUTE_TYPE) as ComponentNode), id: "journey-route_9" };
    page(tree, 0).children![JOURNEY_ROUTES_SLOT]!.unshift(pending);
    const check = checkJourneyTree(form(), tree, "j");
    expect(check.journey?.pages[0]?.routes).toEqual([{ to: "a" }]);
    expect(check.findings.byNode.get(routeNode(tree, 0, 1).id)?.map((finding) => finding.code)).toEqual(["route.backward"]);
    expect(check.findings.byNode.get(pending.id)).toBeUndefined();
    // The written journey carries no trace of the marks.
    expect(JSON.stringify(check.journey)).not.toContain("__datumJourneyNode");
  });

  it("marks a route condition that reads a field of a journey's own as the route's error", () => {
    const ownKey = (key: string): string => `\`${key}\` = "x"`;
    const tree = treeFromJourney({
      id: "j",
      pages: [
        { id: "a", components: ["fullName", "email"], routes: [{ when: ownKey("@j.extra"), to: "b" }] },
        { id: "b", components: ["notes"], routes: [{ when: ownKey("@other.extra"), to: "$end" }] }
      ]
    });
    const check = checkJourneyTree(form(), tree, "j");
    expect(check.findings.byNode.get(routeNode(tree, 0, 0).id)).toEqual([
      expect.objectContaining({ severity: "error", code: "condition.reads-presentation-field" })
    ]);
    expect(check.findings.byNode.get(routeNode(tree, 1, 0).id)).toEqual([
      expect.objectContaining({ severity: "error", code: "condition.reads-presentation-field" })
    ]);
    expect(check.findings.errors).toBe(2);
  });

  it("puts a repeated page id's finding on the page that repeats it", () => {
    const tree = treeFromJourney({
      id: "j",
      pages: [
        { id: "a", components: ["fullName", "email"] },
        { id: "a", components: ["notes"] }
      ]
    });
    const check = checkJourneyTree(form(), tree, "j");
    expect(check.findings.byNode.get(page(tree, 1).id)?.map((finding) => finding.code)).toContain("page.duplicate-id");
    expect(check.findings.byNode.get(page(tree, 0).id)?.map((finding) => finding.code) ?? []).not.toContain("page.duplicate-id");
  });

  it("puts a page's findings on the page at their position, not the first sharing its id", () => {
    // B always goes to C, so the second A is never shown; it and the first A share an id.
    const tree = treeFromJourney({
      id: "j",
      pages: [
        { id: "a", components: ["fullName"] },
        { id: "b", components: ["email"], routes: [{ to: "c" }] },
        { id: "a", title: "Again", components: ["notes"] },
        { id: "c", components: ["notes"], routes: [{ to: "b" }] }
      ]
    });
    const check = checkJourneyTree(form(), tree, "j");
    const codes = (index: number): string[] => (check.findings.byNode.get(page(tree, index).id) ?? []).map((finding) => finding.code);
    // The first A is on every path: no finding about the second lands on it.
    expect(codes(0)).toEqual([]);
    // Each finding about the second A is its own: the repeated id, and no path reaching it.
    expect(codes(2)).toEqual(["page.duplicate-id", "page.unreachable"]);
    // A route's findings by position too: C's route back to B.
    expect((check.findings.byNode.get(routeNode(tree, 3, 0).id) ?? []).map((finding) => finding.code)).toEqual(["route.backward"]);
  });

  it("falls back to the first page with the id for a finding that names no position", () => {
    const placement: JourneyNodePlacement = {
      tree: TREE,
      pages: [...PLACEMENT.pages, { nodeId: "later-a", pageId: "a", routes: [] }]
    };
    const placedAt = (entry: JourneyDiagnostic): string[] => [...placeJourneyFindings([entry], placement).byNode.keys()];
    expect(placedAt(diagnostic("page.no-title", { pageId: "a", severity: "warning" }))).toEqual([page(TREE, 0).id]);
    expect(placedAt(diagnostic("page.no-title", { pageId: "a", pageIndex: 2, severity: "warning" }))).toEqual(["later-a"]);
    // A position that names another page is not trusted.
    expect(placedAt(diagnostic("page.no-title", { pageId: "a", pageIndex: 1, severity: "warning" }))).toEqual([page(TREE, 0).id]);
    // The repeated id: on the repeat the finding names, else on every repeat.
    expect(placedAt(diagnostic("page.duplicate-id", { pageId: "a", pageIndex: 2 }))).toEqual(["later-a"]);
    expect(placedAt(diagnostic("page.duplicate-id", { pageId: "a" }))).toEqual(["later-a"]);
  });

  it("keeps a route to a deleted page as the unknown target it now is", () => {
    const pageIds = new Map<string, string>();
    const tree = treeFromJourney(
      {
        id: "j",
        pages: [
          { id: "a", components: ["fullName"], routes: [{ to: "b" }] },
          { id: "b", components: ["email"] },
          { id: "c", components: ["notes"] }
        ]
      },
      { pageIds }
    );
    tree.children![JOURNEY_PAGES_SLOT]!.splice(1, 1);
    const check = checkJourneyTree(form(), tree, "j", { pageIds });
    expect(check.journey?.pages[0]?.routes).toEqual([{ to: "b" }]);
    expect(check.findings.byNode.get(routeNode(tree, 0, 0).id)?.map((finding) => finding.code)).toEqual(["route.unknown-target"]);
    // The memory is read, not written.
    expect([...pageIds.values()]).toEqual(["a", "b", "c"]);
  });

  it("says on the root why a tree cannot be written, and keeps no journey", () => {
    const tree = treeFromJourney({ id: "j", pages: [{ id: "a", components: ["fullName"] }] });
    (page(tree, 0).configuration as Record<string, unknown>).when = 7;
    const check = checkJourneyTree(form(), tree, "j");
    expect(check.journey).toBeUndefined();
    expect(check.problems).toEqual(['journey "j" page 1 has a when, but a page has no condition of its own; branch with a route on the page before it']);
    expect(check.findings.root[0]?.code).toBe("journey.unwritable");
    expect(check.findings.errors).toBe(1);
  });

  it("reports the journeys the catalog keeps without listing on the root", () => {
    const tree = treeFromJourney({ id: "j", pages: [{ id: "a", components: ["fullName", "email", "notes"] }] });
    const unlisted: UnlistedJourney[] = [
      { index: 1, reason: "duplicate-id", id: "j", problems: [] },
      { index: 2, reason: "duplicate-id", id: "other", problems: [] },
      { index: 3, reason: "unreadable", problems: ['journey "x" needs a pages list'] }
    ];
    const check = checkJourneyTree(form(), tree, "j", { unlisted });
    expect(check.findings.root.map((finding) => [finding.code, finding.severity])).toEqual([
      ["journey.duplicate-id", "error"],
      ["journey.unreadable", "warning"]
    ]);
    expect(check.findings.root[0]?.message).toContain('also has the id "j"; only this one can be opened');
    expect(check.findings.root[1]?.message).toContain('(journey "x" needs a pages list)');
    expect(check.findings.errors).toBe(1);
  });
});

describe("indexJourneyTree", () => {
  it("numbers the pages, knows the page of each question and route, and where each component is listed", () => {
    const index = indexJourneyTree(TREE);
    expect(index.pages.map((entry) => [entry.number, entry.pageId])).toEqual([
      [1, "a"],
      [2, "b"]
    ]);
    expect(index.pageOf.get(routeNode(TREE, 0, 1).id)?.number).toBe(1);
    expect(index.pageOf.get(questionNode(TREE, 1, 1).id)?.number).toBe(2);
    expect(index.pagesListing.get("fullName")).toEqual([1, 2]);
    // A page with no id is written under its node id, and so named.
    const blank = treeFromJourney({ id: "j", pages: [{ id: "a" }] } as Journey);
    (page(blank, 0).configuration as Record<string, unknown>).pageId = "";
    expect(indexJourneyTree(blank).pages[0]?.pageId).toBe(page(blank, 0).id);
  });
});

/**
 * Findings about a presentation's own nodes land on those nodes in the tree: by the
 * `ownNodeId` the diagnostics name, else — for
 * `presentation.entry-unusable` — by its `entryId`; and they count like any other.
 */
describe("findings about a journey's own nodes", () => {
  function presentationForm(): ComponentNode {
    return {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "email", type: "text", configuration: { label: "Email", required: true } },
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "income", type: "number", configuration: { label: "Income" } },
          { id: "notes", type: "text", configuration: { label: "Notes" } }
        ]
      }
    };
  }

  /** Page `who`: an alias and an own layout two deep holding references; page `money`: own fields and a worked-out value. */
  function ownJourney(): Journey {
    return JSON.parse(
      JSON.stringify({
        id: "own",
        pages: [
          {
            id: "who",
            components: [
              { id: "work_email", type: "text", configuration: { label: "Work email", fills: "email" } },
              {
                id: "box",
                type: "fieldset",
                configuration: { label: "Box" },
                children: {
                  content: [
                    { id: "inner", type: "grid", configuration: { columns: 2 }, children: { content: [{ type: "journey-field", configuration: { componentId: "name" } }] } },
                    { type: "journey-field", configuration: { componentId: "notes" } }
                  ]
                }
              },
              "notes"
            ],
            routes: [{ to: "money" }]
          },
          { id: "money", components: [{ id: "m1", type: "number" }, { id: "total", type: "journey-value", configuration: { to: "income", value: "m1" } }] }
        ]
      })
    ) as Journey;
  }

  const tree = treeFromJourney(ownJourney());
  const who = page(tree, 0);
  const placement: JourneyNodePlacement = {
    tree,
    pages: [
      { nodeId: who.id, pageId: "who", routes: [routeNode(tree, 0, 0).id] },
      { nodeId: page(tree, 1).id, pageId: "money", routes: [] }
    ]
  };
  const box = questionNode(tree, 0, 1);
  const inner = box.children!.content![0]!;
  const nestedName = inner.children!.content![0]!;
  const nestedNotes = box.children!.content![1]!;
  const topNotes = questionNode(tree, 0, 2);
  const lands = (entry: JourneyDiagnostic): string[] => {
    const placed = placeJourneyFindings([entry], placement);
    return [...(placed.root.length > 0 ? ["root"] : []), ...[...placed.unassigned.keys()].map((id) => `tray:${id}`), ...placed.byNode.keys()];
  };

  it.each<[string, JourneyDiagnostic, string[]]>([
    ["an alias's finding on the alias", diagnostic("presentation.entry-unusable", { pageId: "who", pageIndex: 0, ownNodeId: "work_email", rule: "E" }), ["work_email"]],
    ["a layout's finding on the layout, however deep", diagnostic("presentation.entry-unusable", { pageId: "who", pageIndex: 0, ownNodeId: "inner" }), ["inner"]],
    ["a nested reference's finding on the layout holding it", diagnostic("page.unknown-component", { pageId: "who", pageIndex: 0, ownNodeId: "inner", componentId: "name" }), ["inner"]],
    ["a worked-out value's finding on it, the page found by its id alone", diagnostic("presentation.entry-unusable", { pageId: "money", ownNodeId: "total" }), ["total"]],
    ["a finding naming no page on the node wherever it is", diagnostic("component.multiple-pages", { componentId: "email", ownNodeId: "work_email" }), ["work_email"]],
    ["entry-unusable without ownNodeId on its entry, by entryId", diagnostic("presentation.entry-unusable", { pageId: "who", pageIndex: 0, entryId: "box", rule: "D" }), [box.id]],
    ["an id the tree does not hold on the page instead", diagnostic("presentation.entry-unusable", { pageId: "who", pageIndex: 0, ownNodeId: "gone", entryId: "gone" }), [who.id]],
    ["an id held on another page only on the finding's page", diagnostic("presentation.entry-unusable", { pageId: "money", pageIndex: 1, ownNodeId: "work_email" }), [page(tree, 1).id]],
    ["a route's finding on the route though it names an own node", diagnostic("condition.reads-presentation-field", { pageId: "who", pageIndex: 0, routeIndex: 0, ownNodeId: "m1" }), [routeNode(tree, 0, 0).id]],
    ["a page condition's finding on the page though it names an own node", diagnostic("condition.reads-presentation-field", { pageId: "who", pageIndex: 0, ownNodeId: "m1" }), [who.id]],
    ["a question's finding on the question inside a layout too", diagnostic("page.entry-field", { pageId: "who", pageIndex: 0, componentId: "name" }), [nestedName.id]],
    ["component.multiple-pages on every question asking it, inside a layout too", diagnostic("component.multiple-pages", { componentId: "notes", severity: "warning" }), [nestedNotes.id, topNotes.id]]
  ])("puts %s", (_name, entry, expected) => {
    expect(lands(entry)).toEqual(expected);
  });

  it("counts findings on own nodes in the totals, and places what the diagnostics find on them", () => {
    const check = checkJourneyTree(presentationForm(), tree, "own");
    const total = check.findings.errors + check.findings.warnings;
    const placedCount =
      check.findings.root.length +
      [...check.findings.byNode.values()].reduce((sum, list) => sum + list.length, 0) +
      [...check.findings.unassigned.values()].reduce((sum, list) => sum + list.length, 0);
    expect(placedCount).toBe(total);
    // The index knows the page of every node in it, however deep, and where each component is asked.
    const index = indexJourneyTree(tree);
    for (const id of ["work_email", "box", "inner", nestedName.id, nestedNotes.id, topNotes.id]) {
      expect(index.pageOf.get(id)?.number).toBe(1);
    }
    expect(index.pageOf.get("total")?.number).toBe(2);
    expect(index.pagesListing.get("name")).toEqual([1]);
    expect(index.pagesListing.get("notes")).toEqual([1]);
    // A reference naming no form component (rule D) is said on the layout that holds it, never on the page.
    const ghost = ownJourney();
    ((ghost.pages[0]!.components![1] as unknown as { children: { content: Array<{ configuration: { componentId: string } }> } }).children.content[1]!.configuration).componentId = "ghost";
    const ghostTree = treeFromJourney(ghost);
    const ghostCheck = checkJourneyTree(presentationForm(), ghostTree, "own");
    const about = (nodeId: string): string[] => (ghostCheck.findings.byNode.get(nodeId) ?? []).map((finding) => finding.message).filter((message) => message.includes("ghost"));
    expect(about(page(ghostTree, 0).id)).toEqual([]);
    expect(about("box")).toHaveLength(1);
  });

  it("leaves a form field an own node places out of the tray: only what no page asks, fills or works out is counted there", () => {
    const check = checkJourneyTree(presentationForm(), tree, "own");
    expect([...check.findings.unassigned.keys()]).toEqual([]);
    const lessTree = treeFromJourney({ ...ownJourney(), pages: [ownJourney().pages[1]!] });
    const less = checkJourneyTree(presentationForm(), lessTree, "own");
    expect([...less.findings.unassigned.keys()].sort()).toEqual(["email", "name", "notes"]);
  });

  it("marks a finding about a later own node sharing an id on its page with its place, keeps the shared ownership, and passes the mode's isValueless on", () => {
    const journey = {
      id: "own",
      pages: [
        {
          id: "who",
          components: [
            { id: "nick", type: "text", configuration: { label: "Nick" } },
            { id: "nick", type: "text", configuration: { label: "Nick again" } },
            { id: "help_link", type: "gcds-link", configuration: { text: "Help" } },
            "email",
            "name",
            "income",
            "notes"
          ]
        }
      ]
    } as unknown as Journey;
    const repeatTree = treeFromJourney(journey);
    const check = checkJourneyTree(presentationForm(), repeatTree, "own");
    expect(check.findings.byNode.get("nick")?.map((finding) => [finding.code, finding.repeat])).toEqual([
      ["field.goes-nowhere", undefined],
      ["field.id-clash", 1]
    ]);
    expect(check.ownership?.membersOf.who).toEqual(["nick", "help_link", "email", "name", "income", "notes"]);
    expect(check.findings.byNode.get("help_link")?.map((finding) => finding.code)).toEqual(["field.goes-nowhere"]);
    const valueless = checkJourneyTree(presentationForm(), repeatTree, "own", { isValueless: (node) => node.type === "gcds-link" });
    expect(valueless.findings.byNode.get("help_link")).toBeUndefined();
    // A tree that cannot be written has no ownership.
    const unwritable = checkJourneyTree(presentationForm(), { ...repeatTree, children: { pages: [{ id: "p", type: "journey-page", configuration: { when: 7 } }] } }, "own");
    expect([unwritable.journey, unwritable.ownership]).toEqual([undefined, undefined]);
  });
});

describe("the findings card's entries and the Form fields panel's rows", () => {
  function requiredForm(): ComponentNode {
    const root = form();
    (root.children!.content![0]!.configuration as Record<string, unknown>).required = true;
    (root.children!.content![1]!.configuration as Record<string, unknown>).required = true;
    return root;
  }

  function viewOf(journey: Journey, root: ComponentNode) {
    const tree = treeFromJourney(journey);
    const check = checkJourneyTree(root, tree, journey.id);
    const unassigned = unassignedMembers(root, check.journey!);
    return { tree, index: indexJourneyTree(tree), check, unassigned } as JourneyDesignView;
  }

  it("lists errors before warnings, each required field with Ask it here and Make it optional, and a gone field with Remove", () => {
    const root = requiredForm();
    const view = viewOf({ id: "j", pages: [{ id: "a", components: ["ghost"] }] }, root);
    const entries = journeyFindingEntries(view, indexJourneyForm(root, "en"), new Set([questionNode(view.tree, 0, 0).id]));
    const severities = entries.map((entry) => entry.severity);
    expect(severities).toEqual([...severities].sort((a, b) => (a === b ? 0 : a === "error" ? -1 : 1)));
    const email = entries.find((entry) => entry.message.startsWith("Email is required"));
    expect(email).toMatchObject({ severity: "error", message: "Email is required and is not asked in this journey. A submission is refused." });
    expect(email?.fixes).toEqual([
      { kind: "ask", label: "Ask it here", componentId: "email" },
      { kind: "optional", label: "Make it optional on the form", componentId: "email" }
    ]);
    // Not required: said as a warning, with no fix; the words are the card's, not the diagnostics'.
    expect(entries.find((entry) => entry.message === "Notes is not asked in this journey.")).toMatchObject({ severity: "warning", fixes: [] });
    // The question whose form field is gone: selected by its node, taken off by Remove.
    const gone = entries.find((entry) => entry.code === "page.unknown-component");
    expect(gone?.nodeId).toBe(questionNode(view.tree, 0, 0).id);
    expect(gone?.fixes).toEqual([{ kind: "remove", label: "Remove", nodeId: questionNode(view.tree, 0, 0).id }]);
  });

  it("offers Remove this worked-out value on a worked-out value whose field the journey asks, and Fill a form field on a field whose answer goes nowhere", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "income", type: "number", configuration: { label: "Income" } },
          { id: "notes", type: "text", configuration: { label: "Notes" } }
        ]
      }
    };
    const journey = JSON.parse(
      JSON.stringify({
        id: "j",
        pages: [
          {
            id: "a",
            components: [
              { id: "m1", type: "number" },
              { id: "one", type: "journey-value", configuration: { to: "income", value: "m1" } },
              { id: "typed", type: "number", configuration: { label: "Income", fills: "income" } },
              { id: "nick", type: "text", configuration: { label: "Nick" } },
              "notes"
            ]
          }
        ]
      })
    ) as Journey;
    const view = viewOf(journey, root);
    const entries = journeyFindingEntries(view, indexJourneyForm(root, "en"), new Set());
    const conflict = entries.find((entry) => entry.code === "map.target-conflict");
    expect(conflict?.nodeId).toBe("one");
    expect(conflict?.fixes).toEqual([{ kind: "remove", label: "Remove this worked-out value", nodeId: "one" }]);
    const nowhere = entries.find((entry) => entry.code === "field.goes-nowhere" && entry.nodeId === "nick");
    expect(nowhere?.fixes).toEqual([{ kind: "fill", label: "Fill a form field…", nodeId: "nick" }]);
  });

  it("says a finding about a field on two steps once, though it is placed on both", () => {
    const root = form();
    const view = viewOf(
      {
        id: "j",
        pages: [
          { id: "a", title: "First", components: ["fullName", "email"] },
          { id: "b", title: "Second", components: ["fullName", "notes"] }
        ]
      },
      root
    );
    // Placed on the question of each step, one object.
    const placed = [...view.check.findings.byNode.values()].flat().filter((finding) => finding.code === "component.multiple-pages");
    expect(placed).toHaveLength(2);
    expect(placed[0]).toBe(placed[1]);
    const entries = journeyFindingEntries(view, indexJourneyForm(root, "en"), new Set());
    expect(entries.filter((entry) => entry.code === "component.multiple-pages")).toHaveLength(1);
    // The one finding is counted once: the count is the card's.
    expect([view.check.findings.errors, view.check.findings.warnings]).toEqual([0, entries.length]);
  });

  it("counts a blank journey as its card lists it: the fields not asked once each, no journey-wide count of them beside", () => {
    const root = requiredForm();
    const view = viewOf({ id: "j", pages: [{ id: "step-1", title: "Step 1", components: [] }] }, root);
    const entries = journeyFindingEntries(view, indexJourneyForm(root, "en"), new Set());
    expect(entries.map((entry) => entry.code)).not.toContain("presentation.fields-left-out");
    expect(entries.filter((entry) => entry.severity === "error")).toHaveLength(view.check.findings.errors);
    expect(entries.filter((entry) => entry.severity === "warning")).toHaveLength(view.check.findings.warnings);
    expect(view.check.findings.errors).toBe(2);
    // The empty step is shown as it is, with nothing said of it; each field not asked says so once.
    expect(entries.filter((entry) => entry.code.startsWith("page."))).toEqual([]);
    expect(entries.filter((entry) => entry.code === "component.unassigned").map((entry) => entry.message)).toEqual([
      "Full name is required and is not asked in this journey. A submission is refused.",
      "Email is required and is not asked in this journey. A submission is refused.",
      "Notes is not asked in this journey."
    ]);
  });

  it("says the findings in steps and labels when the check is told the names, and by the diagnostics' own words when it is not", () => {
    const root = form();
    const journey = { id: "j", pages: [{ id: "start", components: ["fullName", "email"] }, { id: "empty", components: [] }, { id: "orphan", title: "Last", components: ["fullName"] }] } as Journey;
    const tree = treeFromJourney(journey);
    const names = {
      step: (pageId: string) => ({ start: "Start", empty: "Empty step", orphan: "Last" })[pageId],
      field: (componentId: string) => indexJourneyForm(root, "en").components.get(componentId)?.label
    };
    const messages = (found: ReturnType<typeof checkJourneyTree>): string[] => [...found.findings.byNode.values(), ...found.findings.unassigned.values()].flat().map((finding) => finding.message);
    const worded = messages(checkJourneyTree(root, tree, "j", { names }));
    expect(worded.some((message) => message.startsWith("Step “Empty step” has no title"))).toBe(true);
    expect(worded.some((message) => message.startsWith("Full name is on steps “Start” and “Last”."))).toBe(true);
    // No quoted id, no field's code name, and no "page" is left in any message the author reads.
    for (const message of worded) {
      expect(message, message).not.toMatch(/\b[Pp]ages?\b|"(start|empty|orphan|fullName|email|notes)"|\bfullName\b/);
    }
    // Without the names: as `diagnoseJourney` says them.
    expect(messages(checkJourneyTree(root, tree, "j"))).toContain('Page "empty" has no title and no component to borrow one from, so it is shown without a heading. Give the page a title.');
  });

  it("keeps a note under the Journey panel's ID box only for a finding that belongs to the ID, the card saying the rest once", () => {
    const root = form();
    const view = viewOf({ id: "j", pages: [{ id: "a", components: ["fullName"] }] }, root);
    // Everything about the journey as a whole the card lists: a count of fields, a missing end, a later journey with this id.
    view.check.findings.root.push(
      { severity: "warning", code: "journey.no-end", message: "no end" },
      { severity: "error", code: "journey.duplicate-id", message: "a later journey has this id" }
    );
    const context = { view: () => view } as unknown as JourneyFacesContext;
    const rootNode = { id: "root", type: JOURNEY_ROOT_TYPE } as ComponentNode;
    expect(journeyNotes(context, rootNode, rootNode.id)).toEqual([{ message: "a later journey has this id", severity: "error" }]);
    expect(journeyFindingEntries(view, indexJourneyForm(root, "en"), new Set()).map((entry) => entry.message)).toEqual(expect.arrayContaining(["no end", "a later journey has this id"]));
    // A step's own inspector still says all of what is about it: no card stands in its place.
    const first = page(view.tree, 0);
    view.check.findings.byNode.set(first.id, [{ severity: "warning", code: "page.no-title", message: "no title" }, { severity: "warning", code: "page.unreachable", message: "unreachable" }]);
    expect(journeyNotes(context, first, first.id).map((note) => note.message)).toEqual(["no title", "unreachable"]);
  });

  it("gives every finding of a journey with nothing wrong no card: no entries", () => {
    const root = form();
    const view = viewOf({ id: "j", pages: [{ id: "a", components: ["fullName", "email", "notes"] }] }, root);
    expect(journeyFindingEntries(view, indexJourneyForm(root, "en"), new Set())).toEqual([]);
  });

  it("lists the form's fields in form order with where each is asked: none, here or other, with the steps' names", () => {
    const root = requiredForm();
    const view = viewOf(
      {
        id: "j",
        pages: [
          { id: "a", title: "About you", components: ["fullName"] },
          { id: "b", title: "More", components: ["email"] }
        ]
      },
      root
    );
    const rows = journeyFieldRows({
      view,
      form: indexJourneyForm(root, "en"),
      shown: page(view.tree, 0).id,
      formRoot: root,
      pageName: (nodeId) => (nodeId === page(view.tree, 0).id ? "About you" : "More")
    });
    expect(rows).toEqual([
      { id: "fullName", label: "Full name", type: "text", required: true, where: "here", steps: ["About you"] },
      { id: "email", label: "Email", type: "text", required: true, where: "other", steps: ["More"] },
      { id: "notes", label: "Notes", type: "text", required: false, where: "none", steps: [] }
    ]);
  });
});
