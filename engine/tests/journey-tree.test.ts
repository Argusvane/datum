import { describe, expect, it, vi } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { validateJourneyShape, type Journey } from "../form-engine/core/schema/journey.js";
import { isValidComponentId } from "../form-engine/core/tree/component-id.js";
import { diagnoseJourney } from "../form-engine/core/journey/journey-diagnostics.js";
import { journeyOwnership } from "../form-engine/core/journey/journey-path.js";
import {
  JOURNEY_CONTENT_SLOT,
  JOURNEY_FIELD_TYPE,
  JOURNEY_PAGE_TYPE,
  JOURNEY_PAGES_SLOT,
  JOURNEY_ROOT_ID,
  JOURNEY_ROOT_TYPE,
  JOURNEY_ROUTE_TYPE,
  JOURNEY_ROUTES_SLOT
} from "../form-engine/builder/journey-designer/journey-mode-model.js";
import {
  emptyJourneyTree,
  journeyFromTree,
  journeyNodeTemplate,
  treeFromJourney
} from "../form-engine/builder/journey-designer/journey-tree.js";
import { applyJourney, presentationForm, presentationRoot, publicVariant } from "./fixtures/presentation-form.js";

function contactMethodIs(value: string): Expression {
  return { kind: "binary", operator: "eq", left: { kind: "path", path: "contactMethod" }, right: { kind: "literal", value } };
}

/** A journey that every piece of a journey appears in once. */
const DEMO_JOURNEY: Journey = {
  id: "intake",
  name: "Step by step",
  progress: "count",
  validation: { end: "server", onUnavailable: "continue" },
  texts: {
    back: "Back",
    continue: "Continue",
    pageOf: "Page {{n}} of {{total}}",
    checking: "Checking your answers…",
    serverUnavailable: "We could not check your answers. Try again."
  },
  pages: [
    { id: "about", title: "About you", components: ["text_1", "birthDate"] },
    {
      id: "contact",
      title: "How to reach you",
      components: ["country", "contactMethod", "contactPrefs"],
      routes: [{ when: contactMethodIs("phone"), to: "details" }]
    },
    { id: "address", title: "Where to send mail", components: ["mailingAddress"] },
    { id: "updates", title: "Newsletter", components: ["newsletter"], validation: { server: true } },
    { id: "details", title: "A few more details", components: ["monthlyBudget", "notes", "supportingDocument"] },
    { id: "finish", title: "Before you send", components: ["satisfaction", "submit_1", "submit_passkey"] }
  ]
};

/** The same journey with a key the builder does not know in every place one can sit. */
const WITH_UNKNOWN_KEYS = {
  ...DEMO_JOURNEY,
  "x-owner": { team: "intake", reviewed: "2026-09-27" },
  validation: { end: "server", onUnavailable: "continue", "x-audit": true },
  texts: { ...DEMO_JOURNEY.texts, gcdsNextStep: "Next step" },
  pages: DEMO_JOURNEY.pages.map((page) =>
    page.id === "contact"
      ? {
          ...page,
          "x-analytics": "contact-page",
          texts: { continue: "Next", themeHint: "Tap to continue" },
          routes: [{ when: contactMethodIs("phone"), to: "details", "x-note": "phone callers skip the newsletter" }]
        }
      : page.id === "updates"
        ? { ...page, validation: { server: true, "x-retry": 2 } }
        : page
  )
} as unknown as Journey;

function slot(node: ComponentNode, slotId: string): ComponentNode[] {
  return node.children?.[slotId] ?? [];
}

function config(node: ComponentNode | undefined): Record<string, unknown> {
  return (node?.configuration ?? {}) as Record<string, unknown>;
}

function pageNode(root: ComponentNode, index: number): ComponentNode {
  return slot(root, JOURNEY_PAGES_SLOT)[index] as ComponentNode;
}

function roundTrip(journey: Journey, options?: Parameters<typeof journeyFromTree>[2]): Journey | undefined {
  return journeyFromTree(treeFromJourney(journey), journey.id, options);
}

describe("treeFromJourney", () => {
  it("maps a journey onto the designer's node types, with internal node ids and every slot present", () => {
    const root = treeFromJourney(DEMO_JOURNEY);
    expect(root.id).toBe(JOURNEY_ROOT_ID);
    expect(root.type).toBe(JOURNEY_ROOT_TYPE);
    expect(Object.keys(root.children ?? {})).toEqual([JOURNEY_PAGES_SLOT]);
    expect(config(root)).toEqual({
      name: DEMO_JOURNEY.name,
      progress: "count",
      validation: DEMO_JOURNEY.validation,
      texts: DEMO_JOURNEY.texts
    });

    const pages = slot(root, JOURNEY_PAGES_SLOT);
    expect(pages.map((page) => page.id)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `journey-page_${n}`));
    expect(pages.map((page) => config(page).pageId)).toEqual(["about", "contact", "address", "updates", "details", "finish"]);
    for (const page of pages) {
      expect(page.type).toBe(JOURNEY_PAGE_TYPE);
      expect(Object.keys(page.children ?? {})).toEqual([JOURNEY_CONTENT_SLOT, JOURNEY_ROUTES_SLOT]);
    }
    const about = pageNode(root, 0);
    expect(slot(about, JOURNEY_CONTENT_SLOT).map((field) => [field.id, field.type, config(field).componentId])).toEqual([
      ["journey-field_1", JOURNEY_FIELD_TYPE, "text_1"],
      ["journey-field_2", JOURNEY_FIELD_TYPE, "birthDate"]
    ]);
    expect(slot(about, JOURNEY_ROUTES_SLOT)).toEqual([]);
    expect(config(pageNode(root, 2))).toEqual({ pageId: "address", title: "Where to send mail" });

    // A route points at the page node, not the page id.
    const [route] = slot(pageNode(root, 1), JOURNEY_ROUTES_SLOT);
    expect(route?.id).toBe("journey-route_1");
    expect(route?.type).toBe(JOURNEY_ROUTE_TYPE);
    expect(config(route)).toEqual({ to: "journey-page_5", when: contactMethodIs("phone") });
  });

  it("shares nothing with the journey it was made from", () => {
    const journey = structuredClone(DEMO_JOURNEY);
    const root = treeFromJourney(journey);
    (config(slot(pageNode(root, 1), JOURNEY_ROUTES_SLOT)[0]).when as { operator: string }).operator = "neq";
    (config(root).texts as Record<string, unknown>).back = "Go back";
    expect(journey).toEqual(DEMO_JOURNEY);
  });

  it("opens page ids no node id could be, duplicate page ids, and unknown or backward targets", () => {
    const journey: Journey = {
      id: "odd",
      pages: [
        { id: "1", components: ["a"], routes: [{ to: "nowhere" }] },
        { id: "two words", components: ["b"], routes: [{ when: contactMethodIs("x"), to: "1" }, { to: "$end" }] },
        { id: "1", components: ["c"] }
      ]
    };
    const root = treeFromJourney(journey);
    const pages = slot(root, JOURNEY_PAGES_SLOT);
    expect(pages.every((page) => isValidComponentId(page.id))).toBe(true);
    expect(new Set(pages.map((page) => page.id)).size).toBe(3);
    // An unknown target keeps its value aside; the route has no page to point at.
    expect(config(slot(pages[0] as ComponentNode, JOURNEY_ROUTES_SLOT)[0])).toEqual({ to: "", missingTo: "nowhere" });
    // A backward route stays representable: it points at the earlier page's node (the first "1").
    const [back, end] = slot(pages[1] as ComponentNode, JOURNEY_ROUTES_SLOT);
    expect(config(back).to).toBe("journey-page_1");
    expect(config(end).to).toBe("$end");
    expect(roundTrip(journey)).toEqual(journey);
  });

  it("fills a page-id map for the routes written later", () => {
    const pageIds = new Map<string, string>();
    treeFromJourney(DEMO_JOURNEY, { pageIds });
    expect(pageIds.get("journey-page_5")).toBe("details");
    expect(pageIds.size).toBe(6);
  });
});

describe("journeyFromTree", () => {
  it("round-trips the demo journey exactly, key order included", () => {
    const back = roundTrip(DEMO_JOURNEY);
    expect(back).toEqual(DEMO_JOURNEY);
    expect(JSON.stringify(back)).toBe(JSON.stringify(DEMO_JOURNEY));
  });

  it("keeps every key it does not know: on the journey, a page, a route, texts and validation", () => {
    const back = roundTrip(WITH_UNKNOWN_KEYS);
    expect(back).toEqual(WITH_UNKNOWN_KEYS);
    const contact = back?.pages[1] as unknown as Record<string, unknown>;
    expect(contact["x-analytics"]).toBe("contact-page");
    expect(contact.texts).toEqual({ continue: "Next", themeHint: "Tap to continue" });
    expect((back?.pages[1]?.routes?.[0] as unknown as Record<string, unknown>)["x-note"]).toBe("phone callers skip the newsletter");
    expect((back?.texts as Record<string, unknown>).gcdsNextStep).toBe("Next step");
    expect(back?.pages[3]?.validation).toEqual({ server: true, "x-retry": 2 });
  });

  it("is a fixed point: a second round trip writes the same text as the first", () => {
    for (const journey of [DEMO_JOURNEY, WITH_UNKNOWN_KEYS]) {
      const once = roundTrip(journey) as Journey;
      expect(JSON.stringify(roundTrip(once))).toBe(JSON.stringify(once));
    }
  });

  it("round-trips exit pages, conditions on routes and the end target", () => {
    const journey: Journey = {
      id: "eligibility",
      offPathValues: "clear",
      pages: [
        { id: "start", components: ["eligible"], routes: [{ when: contactMethodIs("no"), to: "stop" }, { to: "$end" }] },
        { id: "stop", kind: "exit", title: "You are not eligible", description: "Sorry.", components: ["bye"] }
      ]
    };
    expect(roundTrip(journey)).toEqual(journey);
  });

  it("writes an absent key for a blank select, booleans for true and false, and drops what says nothing", () => {
    const root = emptyJourneyTree();
    Object.assign(config(root), {
      name: "  ",
      progress: "",
      offPathValues: null,
      validation: { continue: "", server: "false", onUnavailable: "", end: "" },
      texts: { back: "", continue: "  ", submit: "Send" }
    });
    slot(root, JOURNEY_PAGES_SLOT).push({
      id: "journey-page_1",
      type: JOURNEY_PAGE_TYPE,
      configuration: {
        pageId: "first",
        kind: "questions",
        title: "",
        description: "",
        when: undefined,
        validation: { continue: "defer", server: "true", onUnavailable: "" },
        texts: {}
      },
      children: {
        content: [
          { id: "journey-field_1", type: JOURNEY_FIELD_TYPE, configuration: { componentId: "" } },
          { id: "journey-field_2", type: JOURNEY_FIELD_TYPE, configuration: { componentId: "name" } }
        ],
        routes: [{ id: "journey-route_1", type: JOURNEY_ROUTE_TYPE, configuration: { to: "" } }]
      }
    });
    expect(journeyFromTree(root, "plain")).toEqual({
      id: "plain",
      validation: { server: false },
      texts: { submit: "Send" },
      pages: [{ id: "first", components: ["name"], validation: { continue: "defer", server: true } }]
    });
  });

  it("writes the page heading after the count, byte for byte, and a blank select as no key", () => {
    for (const heading of ["hidden", "shown"] as const) {
      const journey: Journey = { id: "j", name: "J", progress: "count", heading, offPathValues: "retain", pages: [{ id: "a", components: ["name"] }] };
      expect(config(treeFromJourney(journey)).heading).toBe(heading);
      expect(JSON.stringify(journeyFromTree(treeFromJourney(journey), "j"))).toBe(JSON.stringify(journey));
    }
    const root = treeFromJourney({ id: "j", heading: "hidden", pages: [{ id: "a", components: ["name"] }] });
    config(root).heading = "";
    expect(journeyFromTree(root, "j")).toEqual({ id: "j", pages: [{ id: "a", components: ["name"] }] });
  });

  it("gives a page with a blank id its node id, made unique among the pages", () => {
    const root = emptyJourneyTree();
    const page = (id: string, pageId: string): ComponentNode => ({
      ...(journeyNodeTemplate(JOURNEY_PAGE_TYPE) as ComponentNode),
      id,
      configuration: { pageId }
    });
    slot(root, JOURNEY_PAGES_SLOT).push(page("journey-page_1", "journey-page_2"), page("journey-page_2", " "), page("journey-page_3", ""));
    slot(pageNode(root, 0), JOURNEY_ROUTES_SLOT).push({ id: "journey-route_1", type: JOURNEY_ROUTE_TYPE, configuration: { to: "journey-page_2" } });
    const journey = journeyFromTree(root, "blank-ids") as Journey;
    expect(journey.pages.map((entry) => entry.id)).toEqual(["journey-page_2", "journey-page_2-2", "journey-page_3"]);
    // The route follows the node, whatever id the page is written with.
    expect(journey.pages[0]?.routes).toEqual([{ to: "journey-page_2-2" }]);
  });

  it("follows a page-id edit: routes point at nodes, so they go where they went", () => {
    const root = treeFromJourney(DEMO_JOURNEY);
    config(pageNode(root, 4)).pageId = "more";
    const journey = journeyFromTree(root, "intake") as Journey;
    expect(journey.pages[1]?.routes?.[0]?.to).toBe("more");
    expect(journey.pages[4]?.id).toBe("more");
  });

  it("keeps a route to a deleted page, as an unknown target, and reopens it that way (delete, save, reopen)", () => {
    const pageIds = new Map<string, string>();
    const root = treeFromJourney(DEMO_JOURNEY, { pageIds });
    // What the mode writes on opening seeds the map as well.
    journeyFromTree(root, "intake", { pageIds });
    const pages = slot(root, JOURNEY_PAGES_SLOT);
    pages.splice(4, 1); // "details", the phone route's target

    const saved = journeyFromTree(root, "intake", { pageIds }) as Journey;
    expect(saved.pages.map((page) => page.id)).toEqual(["about", "contact", "address", "updates", "finish"]);
    expect(saved.pages[1]?.routes).toEqual([{ when: contactMethodIs("phone"), to: "details" }]);
    expect(validateJourneyShape(saved)).toEqual([]);
    const form: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: ["text_1", "birthDate", "country", "contactMethod", "contactPrefs", "mailingAddress", "newsletter", "satisfaction", "submit_1", "submit_passkey"].map(
          (id) => ({ id, type: "text", configuration: { label: id } })
        )
      }
    };
    expect(diagnoseJourney(form, saved).filter((finding) => finding.code === "route.unknown-target")).toMatchObject([
      { pageId: "contact", routeIndex: 0, severity: "error" }
    ]);

    // Reopened, the route keeps its target aside, and saving again changes nothing.
    const reopened = treeFromJourney(saved);
    expect(config(slot(pageNode(reopened, 1), JOURNEY_ROUTES_SLOT)[0])).toMatchObject({ to: "", missingTo: "details" });
    expect(journeyFromTree(reopened, "intake")).toEqual(saved);
  });

  it("links a route to the page later written under the id it names, which it then follows through a rename", () => {
    const pageIds = new Map<string, string>();
    const routeLinks = new Map<string, string>();
    const root = treeFromJourney({ id: "j", pages: [{ id: "p1", components: ["a"], routes: [{ to: "summary" }] }] }, { pageIds });
    const route = slot(pageNode(root, 0), JOURNEY_ROUTES_SLOT)[0] as ComponentNode;
    expect(config(route)).toMatchObject({ to: "", missingTo: "summary" });
    const write = (): Journey => journeyFromTree(root, "j", { pageIds, routeLinks }) as Journey;
    expect(write().pages[0]?.routes).toEqual([{ to: "summary" }]);

    // The author adds the page the route names; it goes there, and follows it through a rename.
    slot(root, JOURNEY_PAGES_SLOT).push({
      id: `${JOURNEY_PAGE_TYPE}_2`,
      type: JOURNEY_PAGE_TYPE,
      configuration: { pageId: "summary" },
      children: { [JOURNEY_CONTENT_SLOT]: [], [JOURNEY_ROUTES_SLOT]: [] }
    });
    expect(write().pages[0]?.routes).toEqual([{ to: "summary" }]);
    config(pageNode(root, 1)).pageId = "summary-page";
    expect(write().pages[0]?.routes).toEqual([{ to: "summary-page" }]);
    expect(write().pages[0]?.routes).toEqual([{ to: "summary-page" }]);

    // A page whose id is blank again (the typing undone) never takes the route: it names the id the file did.
    config(pageNode(root, 1)).pageId = "";
    expect(write().pages[0]?.routes).toEqual([{ to: "summary" }]);
    config(pageNode(root, 1)).pageId = "summary-page";
    // The page gone, the route falls back to the id the file named, an unknown target again.
    slot(root, JOURNEY_PAGES_SLOT).pop();
    expect(write().pages[0]?.routes).toEqual([{ to: "summary" }]);

    // A target chosen since drops the link.
    slot(root, JOURNEY_PAGES_SLOT).push({
      id: `${JOURNEY_PAGE_TYPE}_2`,
      type: JOURNEY_PAGE_TYPE,
      configuration: { pageId: "summary" },
      children: { [JOURNEY_CONTENT_SLOT]: [], [JOURNEY_ROUTES_SLOT]: [] }
    });
    write();
    config(route).to = "$end";
    expect(write().pages[0]?.routes).toEqual([{ to: "$end" }]);
    expect(routeLinks.has(route.id)).toBe(false);
  });

  it("links a route to a deleted page to a page given that page's id later", () => {
    const pageIds = new Map<string, string>();
    const routeLinks = new Map<string, string>();
    const root = treeFromJourney(
      { id: "j", pages: [{ id: "p1", components: ["a"], routes: [{ to: "p2" }] }, { id: "p2", components: ["b"] }] },
      { pageIds }
    );
    const write = (): Journey => journeyFromTree(root, "j", { pageIds, routeLinks }) as Journey;
    write();
    slot(root, JOURNEY_PAGES_SLOT).pop();
    expect(write().pages[0]?.routes).toEqual([{ to: "p2" }]);
    slot(root, JOURNEY_PAGES_SLOT).push({
      id: `${JOURNEY_PAGE_TYPE}_9`,
      type: JOURNEY_PAGE_TYPE,
      configuration: { pageId: "p2" },
      children: { [JOURNEY_CONTENT_SLOT]: [], [JOURNEY_ROUTES_SLOT]: [] }
    });
    expect(write().pages[0]?.routes).toEqual([{ to: "p2" }]);
    config(pageNode(root, 1)).pageId = "second";
    expect(write().pages[0]?.routes).toEqual([{ to: "second" }]);
  });

  it("drops a route to a deleted page only when nothing remembers the page", () => {
    const root = treeFromJourney(DEMO_JOURNEY);
    slot(root, JOURNEY_PAGES_SLOT).splice(4, 1);
    expect(journeyFromTree(root, "intake")?.pages[1]?.routes).toBeUndefined();
  });

  it("writes nothing that fails the shape check, and says why", () => {
    const root = treeFromJourney(DEMO_JOURNEY);
    config(slot(pageNode(root, 1), JOURNEY_ROUTES_SLOT)[0]).when = 7;
    const onError = vi.fn();
    expect(journeyFromTree(root, "intake", { onError })).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(['journey "intake" page 2 route 1 when must be an expression']);
    // A page node carrying a condition of its own (a stale draft): written as it stands, and refused.
    const stale = treeFromJourney(DEMO_JOURNEY);
    config(pageNode(stale, 0)).when = contactMethodIs("mail");
    expect(journeyFromTree(stale, "intake", { onError })).toBeUndefined();
    expect(onError).toHaveBeenLastCalledWith(['journey "intake" page 1 has a when, but a page has no condition of its own; branch with a route on the page before it']);
    expect(journeyFromTree(treeFromJourney(DEMO_JOURNEY), "", { onError })).toBeUndefined();
    expect(onError).toHaveBeenLastCalledWith(["a journey needs an id"]);
  });

  it("refuses a page, a route or a journey inside a page's own layout, however it got there, and says why", () => {
    const root = treeFromJourney(publicVariant());
    const contact = slot(slot(root, JOURNEY_PAGES_SLOT)[0]!, JOURNEY_CONTENT_SLOT)[0]!;
    expect(contact.id).toBe("contact");
    for (const frame of [journeyNodeTemplate(JOURNEY_PAGE_TYPE)!, journeyNodeTemplate(JOURNEY_ROUTE_TYPE)!, emptyJourneyTree()]) {
      const tree = structuredClone(root);
      const layout = slot(slot(tree, JOURNEY_PAGES_SLOT)[0]!, JOURNEY_CONTENT_SLOT)[0]!;
      layout.children!.content!.push({ ...frame, id: "stray" });
      const onError = vi.fn();
      expect(journeyFromTree(tree, "public", { onError })).toBeUndefined();
      expect(onError).toHaveBeenCalledWith([`stray (${frame.type}) is inside contact; pages and routes go on the journey`]);
    }
    expect(journeyFromTree(root, "public")).toEqual(publicVariant());
  });

  it("keeps a __proto__ key on the journey, a page, a route, its texts and its validation through an edit", () => {
    const written =
      '{"id":"j","__proto__":{"a":1},"pages":[{"id":"p","components":["x"],"routes":[{"to":"$end","__proto__":{"e":5}}],"validation":{"__proto__":{"g":7},"continue":"page"},"texts":{"__proto__":{"f":6},"next":"Go"},"__proto__":{"b":2}}]}';
    const root = treeFromJourney(JSON.parse(written) as Journey);
    expect(JSON.stringify(journeyFromTree(root, "j"))).toBe(written);
    config(pageNode(root, 0)).title = "Edited";
    expect(JSON.stringify(journeyFromTree(root, "j"))).toBe(written.replace('"components"', '"title":"Edited","components"'));
  });

  it("gathers pages, questions and routes from whatever slot they landed in", () => {
    const root = emptyJourneyTree();
    root.children = {
      stray: [{ id: "journey-page_2", type: JOURNEY_PAGE_TYPE, configuration: { pageId: "b" } }],
      pages: [
        {
          id: "journey-page_1",
          type: JOURNEY_PAGE_TYPE,
          configuration: { pageId: "a" },
          children: {
            content: [{ id: "journey-route_1", type: JOURNEY_ROUTE_TYPE, configuration: { to: "journey-page_2" } }],
            routes: [{ id: "journey-field_1", type: JOURNEY_FIELD_TYPE, configuration: { componentId: "name" } }]
          }
        }
      ]
    };
    expect(journeyFromTree(root, "loose")).toEqual({ id: "loose", pages: [{ id: "a", components: ["name"], routes: [{ to: "b" }] }, { id: "b" }] });
  });
});

describe("node templates", () => {
  it("start every node with its slots and blank values", () => {
    expect(emptyJourneyTree()).toEqual({ id: JOURNEY_ROOT_ID, type: JOURNEY_ROOT_TYPE, configuration: {}, children: { pages: [] } });
    expect(journeyNodeTemplate(JOURNEY_ROOT_TYPE)).toEqual(emptyJourneyTree());
    expect(journeyNodeTemplate(JOURNEY_PAGE_TYPE)).toMatchObject({ type: JOURNEY_PAGE_TYPE, configuration: { pageId: "" }, children: { content: [], routes: [] } });
    expect(journeyNodeTemplate(JOURNEY_FIELD_TYPE)).toMatchObject({ configuration: { componentId: "" } });
    expect(journeyNodeTemplate(JOURNEY_ROUTE_TYPE)).toMatchObject({ configuration: { to: "" } });
    expect(journeyNodeTemplate("text")).toBeUndefined();
    // An empty designer writes an empty, usable journey.
    expect(journeyFromTree(emptyJourneyTree(), "fresh")).toEqual({ id: "fresh", pages: [] });
  });

  it("write every output in a shape the runtime reads", () => {
    const outputs = [DEMO_JOURNEY, WITH_UNKNOWN_KEYS].map((journey) => roundTrip(journey));
    for (const output of outputs) {
      expect(output).toBeDefined();
      expect(validateJourneyShape(output)).toEqual([]);
    }
  });
});


/**
 * A presentation's own nodes are the stored shape: an object entry is copied into the
 * page's content slot under its own id, a reference inside a layout of its own is a question
 * node with an internal id, and the tree written back unedited is the journey read, byte for byte.
 */
describe("a presentation's own nodes", () => {
  /** Reads `journey` and writes it straight back, with the entry's memories as the mode keeps them. */
  function reopened(journey: Journey, formIds?: Iterable<string>): { root: ComponentNode; written: Journey | undefined; references: Map<string, Record<string, unknown>> } {
    const pageIds = new Map<string, string>();
    const references = new Map<string, Record<string, unknown>>();
    const root = treeFromJourney(journey, { pageIds, references, ...(formIds ? { formIds } : {}) });
    return { root, written: journeyFromTree(root, journey.id, { pageIds, references }), references };
  }

  it("round-trips the shared fixture's journey and variant byte for byte, with the memories and without them", () => {
    for (const journey of presentationForm().journey!.journeys!) {
      const given = JSON.stringify(journey);
      const { written } = reopened(journey, ["form", "email", "name", "money", "annual_income", "approved_amount"]);
      expect(JSON.stringify(written)).toBe(given);
      // The fixture writes its references as the designer does, so no memory is needed either.
      expect(JSON.stringify(roundTrip(journey))).toBe(given);
      // Read, not changed.
      expect(JSON.stringify(journey)).toBe(given);
    }
  });

  it("copies an object entry into the content slot under its own id, its references as questions with internal ids", () => {
    const references = new Map<string, Record<string, unknown>>();
    const root = treeFromJourney(publicVariant(), { references });
    const [page] = slot(root, JOURNEY_PAGES_SLOT);
    expect(slot(page!, JOURNEY_CONTENT_SLOT)).toEqual([
      {
        id: "contact",
        type: "grid",
        configuration: { columns: 2 },
        children: {
          content: [
            { id: "journey-field_1", type: JOURNEY_FIELD_TYPE, configuration: { componentId: "email" } },
            { id: "journey-field_2", type: JOURNEY_FIELD_TYPE, configuration: { componentId: "name" } }
          ]
        }
      },
      { id: "public_note", type: "html", configuration: { tag: "p", content: "We only use your email to reply to you." } }
    ]);
    expect([...references]).toEqual([
      ["journey-field_1", { type: "journey-field", configuration: { componentId: "email" } }],
      ["journey-field_2", { type: "journey-field", configuration: { componentId: "name" } }]
    ]);

    // An alias, own fields and a worked-out value: each its own node, rules and all, beside a question.
    const apply = treeFromJourney(applyJourney());
    const income = slot(apply, JOURNEY_PAGES_SLOT)[1]!;
    expect(slot(income, JOURNEY_CONTENT_SLOT).map((node) => [node.id, node.type])).toEqual([
      ["m1", "number"],
      ["m2", "number"],
      ["m3", "number"],
      ["income_total", "journey-value"]
    ]);
    expect(slot(income, JOURNEY_CONTENT_SLOT)[3]).toEqual(applyJourney().pages[1]!.components![3]);
    const assist = slot(apply, JOURNEY_PAGES_SLOT)[2]!;
    expect(slot(assist, JOURNEY_CONTENT_SLOT)).toEqual([{ id: "journey-field_1", type: JOURNEY_FIELD_TYPE, configuration: { componentId: "approved_amount" } }]);
    // The tree shares nothing with the journey.
    (slot(slot(apply, JOURNEY_PAGES_SLOT)[0]!, JOURNEY_CONTENT_SLOT)[0]!.configuration as { fills: string }).fills = "name";
    expect(JSON.stringify(applyJourney())).toContain('"fills":"email"');
  });

  it("numbers its own node ids around every id taken: a hand-written journey-field_1 keeps its node, and so do form ids and page ids", () => {
    const journey = JSON.parse(
      JSON.stringify({
        id: "j",
        pages: [
          { id: "journey-page_1", components: [{ id: "journey-field_1", type: "text", configuration: { label: "Own" } }, "name", "email"] },
          { id: "second", components: [{ id: "journey-route_1", type: "html", configuration: { content: "Hi" } }, "journey-field_3"], routes: [{ to: "$end" }] },
          { id: "journey-page_2", components: ["notes"] }
        ]
      })
    ) as Journey;
    const given = JSON.stringify(journey);
    const { root, written } = reopened(journey, ["journey-field_3", "name", "email", "notes"]);
    const pages = slot(root, JOURNEY_PAGES_SLOT);
    // A page may take its own page id as its node id; never another page's.
    expect(pages.map((page) => page.id)).toEqual(["journey-page_1", "journey-page_3", "journey-page_2"]);
    expect(slot(pages[0]!, JOURNEY_CONTENT_SLOT).map((node) => [node.id, node.type])).toEqual([
      ["journey-field_1", "text"],
      ["journey-field_2", JOURNEY_FIELD_TYPE],
      ["journey-field_4", JOURNEY_FIELD_TYPE]
    ]);
    expect(slot(pages[1]!, JOURNEY_CONTENT_SLOT).map((node) => node.id)).toEqual(["journey-route_1", "journey-field_5"]);
    expect(slot(pages[1]!, JOURNEY_ROUTES_SLOT).map((node) => node.id)).toEqual(["journey-route_2"]);
    const ids = JSON.stringify(root).match(/"id":"[^"]+"/g) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(written)).toBe(given);
  });

  it("round-trips nested layouts with references three deep, numbering the questions in document order", () => {
    const journey = JSON.parse(
      JSON.stringify({
        id: "deep",
        pages: [
          {
            id: "p",
            title: "Deep",
            components: [
              "name",
              {
                id: "outer",
                type: "fieldset",
                configuration: { label: "Outer" },
                rules: { visibleWhen: { kind: "path", path: "name" } },
                children: {
                  content: [
                    {
                      id: "middle",
                      type: "grid",
                      configuration: { columns: 2 },
                      children: {
                        content: [
                          { id: "inner", type: "fieldset", configuration: { label: "Inner" }, children: { content: [{ type: "journey-field", configuration: { componentId: "email" } }] } },
                          { type: "journey-field", configuration: { componentId: "notes" } }
                        ]
                      }
                    },
                    { type: "journey-field", configuration: { componentId: "country" } }
                  ]
                }
              }
            ]
          }
        ]
      })
    ) as Journey;
    const given = JSON.stringify(journey);
    const { root, written } = reopened(journey);
    const outer = slot(slot(root, JOURNEY_PAGES_SLOT)[0]!, JOURNEY_CONTENT_SLOT)[1]!;
    const middle = slot(outer, "content")[0]!;
    const inner = slot(middle, "content")[0]!;
    expect(slot(inner, "content")[0]).toEqual({ id: "journey-field_2", type: JOURNEY_FIELD_TYPE, configuration: { componentId: "email" } });
    expect(slot(middle, "content")[1]?.id).toBe("journey-field_3");
    expect(slot(outer, "content")[1]?.id).toBe("journey-field_4");
    expect(outer.rules).toEqual({ visibleWhen: { kind: "path", path: "name" } });
    expect(JSON.stringify(written)).toBe(given);
    expect(validateJourneyShape(written)).toEqual([]);
  });

  it("keeps a __proto__ key a key — in an own node's configuration, on the node, as a slot — written back as it was", () => {
    const text =
      '{"id":"j","pages":[{"id":"p","components":[' +
      '{"id":"own","type":"text","configuration":{"label":"Own","__proto__":{"polluted":true},"x":1}},' +
      '{"id":"lay","type":"fieldset","__proto__":{"polluted":true},"children":{"__proto__":[{"type":"journey-field","configuration":{"componentId":"name"}}]}}' +
      "]}]}";
    const journey = JSON.parse(text) as Journey;
    expect(validateJourneyShape(journey)).toEqual([]);
    const { root, written } = reopened(journey);
    const [own, lay] = slot(slot(root, JOURNEY_PAGES_SLOT)[0]!, JOURNEY_CONTENT_SLOT);
    expect(Object.keys(own!.configuration as object)).toEqual(["label", "__proto__", "x"]);
    expect(Object.getPrototypeOf(own!.configuration)).toBe(Object.prototype);
    expect(Object.keys(lay!)).toEqual(["id", "type", "__proto__", "children"]);
    expect(Object.getPrototypeOf(lay)).toBe(Object.prototype);
    expect(Object.keys(lay!.children!)).toEqual(["__proto__"]);
    expect(lay!.children!["__proto__"]![0]).toEqual({ id: "journey-field_1", type: JOURNEY_FIELD_TYPE, configuration: { componentId: "name" } });
    expect(JSON.stringify(written)).toBe(text);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("writes a reference back as it was written — at the top of a page, with an id or a key no reader knows — and a question it does not remember as the designer writes one", () => {
    const journey = JSON.parse(
      JSON.stringify({
        id: "refs",
        pages: [
          {
            id: "p",
            components: [
              { type: "journey-field", configuration: { componentId: "name" } },
              "email",
              { id: "box", type: "fieldset", configuration: { label: "Box" }, children: { content: [{ id: "r1", type: "journey-field", configuration: { componentId: "notes", "x-hint": 1 }, "x-note": "kept" }] } }
            ]
          }
        ]
      })
    ) as Journey;
    const given = JSON.stringify(journey);
    const { root, written, references } = reopened(journey);
    expect(JSON.stringify(written)).toBe(given);
    // The ids written are no node's: the questions take internal ones.
    const [top, email, box] = slot(slot(root, JOURNEY_PAGES_SLOT)[0]!, JOURNEY_CONTENT_SLOT);
    expect([top?.id, email?.id, slot(box!, "content")[0]?.id]).toEqual(["journey-field_1", "journey-field_2", "journey-field_3"]);
    expect([...references.keys()]).toEqual(["journey-field_1", "journey-field_3"]);
    // Without the memory, a reference at the top is the id it means, and one inside a layout the designer's shape.
    expect(journeyFromTree(root, "refs")?.pages[0]?.components).toEqual([
      "name",
      "email",
      { id: "box", type: "fieldset", configuration: { label: "Box" }, children: { content: [{ type: "journey-field", configuration: { componentId: "notes", "x-hint": 1 } }] } }
    ]);
  });

  it("writes edits inside an own layout: a question chosen again, one not chosen yet left out, one moved in or out", () => {
    const { root, references } = reopened(publicVariant());
    const pageIds = new Map<string, string>();
    const contact = slot(slot(root, JOURNEY_PAGES_SLOT)[0]!, JOURNEY_CONTENT_SLOT)[0]!;
    const [email, name] = slot(contact, "content");
    (email!.configuration as Record<string, unknown>).componentId = "approved_amount";
    (name!.configuration as Record<string, unknown>).componentId = "";
    // A question from the top moved into the layout, and one of its own moved out to the top.
    slot(contact, "content").push({ id: "journey-field_9", type: JOURNEY_FIELD_TYPE, configuration: { componentId: "annual_income" } });
    slot(slot(root, JOURNEY_PAGES_SLOT)[0]!, JOURNEY_CONTENT_SLOT).push({ id: "journey-field_8", type: JOURNEY_FIELD_TYPE, configuration: { componentId: "money" } });
    const written = journeyFromTree(root, "public", { pageIds, references });
    expect(written?.pages[0]?.components).toEqual([
      {
        id: "contact",
        type: "grid",
        configuration: { columns: 2 },
        children: {
          content: [
            { type: "journey-field", configuration: { componentId: "approved_amount" } },
            { type: "journey-field", configuration: { componentId: "annual_income" } }
          ]
        }
      },
      publicVariant().pages[0]!.components![1],
      "money"
    ]);
    expect(validateJourneyShape(written)).toEqual([]);
  });

  it("keeps entries the runtime ignores in the tree as written, and writes them back untouched", () => {
    const journey = JSON.parse(
      JSON.stringify({
        id: "ignored",
        pages: [
          {
            id: "p",
            components: [
              { id: "email", type: "text", configuration: { label: "A form id" } },
              { id: "twice", type: "text", configuration: { label: "First" } },
              { id: "twice", type: "text", configuration: { label: "Again" } },
              { id: "9lives", type: "text", configuration: { label: "Not an id" } },
              { id: "rows", type: "repeatingSection", configuration: { label: "Rows" }, children: { content: [{ id: "row_name", type: "text" }] } },
              { id: "bound", type: "text", configuration: { label: "Bound", dataKey: "elsewhere" } },
              { id: "alias", type: "text", configuration: { label: "Fills the form", fills: "money" } },
              { id: "worked", type: "journey-value", configuration: { to: "ghost", value: { kind: "literal", value: 1 } } }
            ]
          }
        ]
      })
    ) as Journey;
    const given = JSON.stringify(journey);
    const { root, written } = reopened(journey, ["form", "email", "name", "money", "annual_income", "approved_amount"]);
    expect(slot(slot(root, JOURNEY_PAGES_SLOT)[0]!, JOURNEY_CONTENT_SLOT).map((node) => node.id)).toEqual([
      "email",
      "twice",
      "twice",
      "9lives",
      "rows",
      "bound",
      "alias",
      "worked"
    ]);
    expect(JSON.stringify(written)).toBe(given);
    // The runtime uses none of them but the alias, which it reads as a field filling nothing;
    // the checks say why (journey-diagnostics), and the tree just keeps them all.
    expect(Object.keys(journeyOwnership(presentationRoot(), journey).ownNodes ?? {})).toEqual(["twice", "alias"]);
  });
});

describe("worked-out values written as formula text", () => {
  function written(value: unknown): Journey | undefined {
    const root = treeFromJourney(applyJourney());
    const income = slot(root, JOURNEY_PAGES_SLOT)[1]!;
    const node = slot(income, JOURNEY_CONTENT_SLOT).find((n) => n.id === "income_total")!;
    (node.configuration as Record<string, unknown>).value = value;
    return journeyFromTree(root, "apply");
  }
  const total = (journey: Journey | undefined) => JSON.stringify(journey).includes("income_total");

  it("keeps a worked-out value whose formula is a string, and holds back an empty one", () => {
    expect(total(written("m1 + m2"))).toBe(true);
    expect(total(written("  "))).toBe(false);
    expect(total(written(""))).toBe(false);
  });
});
