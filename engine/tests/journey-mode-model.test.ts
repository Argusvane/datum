import { describe, expect, it } from "vitest";

import type { Journey, JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import { addJourney, removeJourney, replaceJourney, setDefaultJourney, setOpensAs } from "../form-engine/builder/journey-designer/journey-catalog.js";
import {
  JOURNEY_FIELD_TYPE,
  JOURNEY_PAGE_TYPE,
  JOURNEY_ROOT_ID,
  JOURNEY_ROOT_TYPE,
  JOURNEY_ROUTE_TYPE,
  JourneyModeModel,
  journeyHasOnePage
} from "../form-engine/builder/journey-designer/journey-mode-model.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

function journey(id: string, name?: string, components: string[] = ["name"]): Journey {
  return { id, ...(name !== undefined ? { name } : {}), pages: [{ id: "one", components }] };
}

const UNREADABLE = { id: "broken", pages: "none" };

function seed(): JourneyConfiguration {
  return {
    journeys: [journey("intake", "Intake"), UNREADABLE, journey("intake", "Second"), journey("short")],
    defaultJourneyId: "short",
    "x-owner": "forms-team"
  } as unknown as JourneyConfiguration;
}

describe("JourneyModeModel", () => {
  it("holds the seed as given until something is edited", () => {
    const configuration = seed();
    const model = new JourneyModeModel(configuration);
    expect(model.configuration).toBe(configuration);
    expect(model.journeys.map((entry) => entry.name ?? entry.id)).toEqual(["Intake", "short"]);
    expect(model.unlisted.map((entry) => entry.reason)).toEqual(["unreadable", "duplicate-id"]);
    expect(new JourneyModeModel(undefined).configuration).toBeUndefined();
    expect(new JourneyModeModel("nonsense").configuration).toBeUndefined();
    expect(new JourneyModeModel(undefined).journeys).toEqual([]);
  });

  it("puts the chosen journey on the page, else the default, else the first, else none", () => {
    const model = new JourneyModeModel(seed());
    expect(model.defaultId).toBe("short");
    expect(model.selected()?.id).toBe("short");
    model.journeyId = "intake";
    expect(model.selected()?.name).toBe("Intake");
    model.journeyId = "broken";
    expect(model.selected()?.id).toBe("short");
    expect(() => model.require("broken")).toThrow(/No journey/);
    expect(new JourneyModeModel({ journeys: [] }).selected()).toBeUndefined();
  });

  it("says what a change means for the designer on the page", () => {
    const model = new JourneyModeModel(seed(), "intake");
    const configuration = model.configuration;

    // Opens-as and the default are the catalog's business: the designer stays as it is.
    const opens = model.apply(setOpensAs(configuration, "form"));
    expect(opens).toMatchObject({ rebuild: false, renamed: false });

    const renamed = model.apply(replaceJourney(model.configuration, "intake", journey("intake", "Renamed")));
    expect(renamed).toMatchObject({ rebuild: false, renamed: true });
    expect(renamed.after?.name).toBe("Renamed");

    const restructured = model.apply(replaceJourney(model.configuration, "intake", journey("intake", "Renamed", ["name", "email"])));
    expect(restructured).toMatchObject({ rebuild: true, renamed: false });

    const moved = model.apply(setDefaultJourney(model.configuration, "short"), "short");
    expect(moved.before?.id).toBe("intake");
    expect(moved.after?.id).toBe("short");
    expect(moved.rebuild).toBe(true);
    expect(model.journeyId).toBe("short");

    const emptied = new JourneyModeModel({ journeys: [journey("only")] });
    const gone = emptied.apply(removeJourney(emptied.configuration, "only"));
    expect(gone).toMatchObject({ after: undefined, rebuild: true, renamed: false });
  });

  it("keeps the designer's own edits quietly, with unlisted journeys and unknown keys where they were", () => {
    const model = new JourneyModeModel(seed());
    model.replaceQuietly("short", journey("short", "Short", ["name", "email"]));
    const configuration = model.configuration as unknown as Record<string, unknown>;
    expect(configuration["x-owner"]).toBe("forms-team");
    expect((configuration.journeys as unknown[])[1]).toBe(UNREADABLE);
    expect(model.selected()?.pages[0]?.components).toEqual(["name", "email"]);
  });

  it("reseeds on another definition's block and reports what it keeps without listing", () => {
    const model = new JourneyModeModel(undefined);
    const added = addJourney(model.configuration, journey("intake"));
    model.apply(added, "intake");
    expect(model.configuration).toEqual({ journeys: [journey("intake")], opensAs: "journey" });
    const unlisted = model.reseed(seed());
    expect(unlisted.map((entry) => entry.index)).toEqual([1, 2]);
    expect(model.journeys.map((entry) => entry.id)).toEqual(["intake", "short"]);
    expect(model.reseed(undefined)).toEqual([]);
    expect(model.configuration).toBeUndefined();
  });

  it("follows a form rename into every journey, and says whether it changed anything", () => {
    const configuration = seed();
    const model = new JourneyModeModel(configuration);
    expect(model.renameComponent("email", "mail")).toBe(false);
    expect(model.configuration).toBe(configuration);
    expect(model.renameComponent("name", "fullName")).toBe(true);
    expect(model.journeys.map((entry) => entry.pages[0]?.components)).toEqual([["fullName"], ["fullName"]]);
    expect((model.configuration?.journeys as unknown[])[1]).toBe(UNREADABLE);
    expect((model.configuration as unknown as Record<string, unknown>)["x-owner"]).toBe("forms-team");
  });

  it("names the designer's node types for the mode's chrome", () => {
    expect([JOURNEY_ROOT_TYPE, JOURNEY_ROOT_ID, JOURNEY_PAGE_TYPE, JOURNEY_FIELD_TYPE, JOURNEY_ROUTE_TYPE]).toEqual([
      "journey",
      "journey",
      "journey-page",
      "journey-field",
      "journey-route"
    ]);
  });
});

describe("journeyHasOnePage: the shape the Map button and Add unassigned read", () => {
  const tree = (routes: ComponentNode[], pages = 1): ComponentNode => ({
    id: JOURNEY_ROOT_ID,
    type: JOURNEY_ROOT_TYPE,
    configuration: {},
    children: {
      pages: Array.from({ length: pages }, (_unused, at) => ({
        id: `page_${at + 1}`,
        type: JOURNEY_PAGE_TYPE,
        configuration: {},
        children: { content: [{ id: `q_${at + 1}`, type: JOURNEY_FIELD_TYPE, configuration: { componentId: "name" } }], routes: at === 0 ? routes : [] }
      }))
    }
  });
  const route = (to?: string): ComponentNode => ({ id: "route_1", type: JOURNEY_ROUTE_TYPE, configuration: to !== undefined ? { to } : {} });

  it("reads the written shape alone when no tree is given: one questions page, no routes", () => {
    expect(journeyHasOnePage(journey("v"))).toBe(true);
    expect(journeyHasOnePage({ id: "two", pages: [{ id: "a" }, { id: "b" }] })).toBe(false);
    expect(journeyHasOnePage({ id: "r", pages: [{ id: "a", routes: [{ to: "$end" }] }] })).toBe(false);
    expect(journeyHasOnePage({ id: "x", pages: [{ id: "a", kind: "exit" }] })).toBe(false);
    // A tree that cannot be written has no journey: not one page.
    expect(journeyHasOnePage(undefined)).toBe(false);
    expect(journeyHasOnePage(undefined, tree([]))).toBe(false);
  });

  it("is a journey as soon as a page of the tree holds any route node, targeted or not, though the written journey is still one page", () => {
    // A route with no target is not written, so the journey written from this tree is still one page with no routes…
    const written = journey("v");
    expect(journeyHasOnePage(written, tree([]))).toBe(true);
    // …but the tree holds a route: the Map comes at once.
    expect(journeyHasOnePage(written, tree([route()]))).toBe(false);
    expect(journeyHasOnePage(written, tree([route("$end")]))).toBe(false);
    // A tree with no pages slot at all reads as the written shape.
    expect(journeyHasOnePage(written, { id: JOURNEY_ROOT_ID, type: JOURNEY_ROOT_TYPE, configuration: {} })).toBe(true);
  });
});
