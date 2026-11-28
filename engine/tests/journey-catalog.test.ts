import { describe, expect, it } from "vitest";

import { sourceHash } from "../form-engine/core/localization/translations.js";
import { readJourneys, type Journey, type JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import { isValidComponentId } from "../form-engine/core/tree/component-id.js";
import {
  addJourney,
  canonicalJourneyConfiguration,
  chooseOpensAs,
  duplicateJourney,
  effectiveDefaultJourneyId,
  journeyIdFromName,
  journeyLabel,
  journeysOf,
  journeyTextAddress,
  journeyTranslatableTexts,
  removeJourney,
  replaceJourney,
  RESERVED_JOURNEY_IDS,
  setDefaultJourney,
  setOpensAs,
  takenJourneyIds,
  uniqueJourneyId,
  unlistedJourneysOf
} from "../form-engine/builder/journey-designer/journey-catalog.js";
import { applyJourney, publicVariant } from "./fixtures/presentation-form.js";

function journey(id: string, name?: Journey["name"]): Journey {
  return { id, ...(name !== undefined ? { name } : {}), pages: [{ id: "one", components: ["name"] }] };
}

const UNREADABLE = { id: "broken", pages: [{ id: "p", routes: [{ when: { kind: "path", path: "x" } }] }] };
const SECOND_INTAKE: Journey = { id: "intake", name: "Another intake", pages: [] };

/** A block with an unreadable journey, a duplicate id, and keys the catalog does not know. */
function mixed(): JourneyConfiguration {
  return {
    "x-owner": "forms-team",
    journeys: [journey("intake", "Step by step"), UNREADABLE, SECOND_INTAKE, journey("short")],
    defaultJourneyId: "short",
    opensAs: "journey",
    "x-review": { by: "someone" }
  } as unknown as JourneyConfiguration;
}

describe("listing", () => {
  it("lists usable journeys, the first with each id, and reports the rest", () => {
    const configuration = mixed();
    expect(journeysOf(configuration).map((entry) => entry.id)).toEqual(["intake", "short"]);
    expect(journeysOf(configuration)[0]).toBe(configuration.journeys?.[0]);
    const unlisted = unlistedJourneysOf(configuration);
    expect(unlisted.map(({ index, reason, id }) => ({ index, reason, id }))).toEqual([
      { index: 1, reason: "unreadable", id: "broken" },
      { index: 2, reason: "duplicate-id", id: "intake" }
    ]);
    expect(unlisted[0]?.problems).toEqual(['journey "broken" page 1 route 1 needs a target']);
    expect(unlisted[1]?.problems).toEqual([]);
    expect(takenJourneyIds(configuration)).toEqual(["intake", "broken", "intake", "short"]);
    expect(journeysOf(undefined)).toEqual([]);
    expect(journeysOf({ journeys: "nonsense" } as unknown as JourneyConfiguration)).toEqual([]);
  });

  it("names a journey by its name in the locale (the map's translation, a host's catalog over it), else its id", () => {
    const configuration = mixed();
    const [intake, short] = journeysOf(configuration) as [Journey, Journey];
    const translations = { fr: { journeys: { intake: { name: { text: "Étape par étape", source: sourceHash("Step by step") } } } } };
    expect(journeyLabel(intake, "fr", { translations })).toBe("Étape par étape");
    // The map's `fr` serves a `fr-CA` form, `en` has no entry: the default string.
    expect(journeyLabel(intake, "fr-CA", { translations })).toBe("Étape par étape");
    expect(journeyLabel(intake, "en", { translations })).toBe("Step by step");
    expect(journeyLabel(intake, "fr")).toBe("Step by step");
    expect(journeyLabel(short, "en")).toBe("short");
    expect(journeyLabel(journey("blank", "  "), "en")).toBe("blank");
    expect(journeyLabel(intake, "fr", { translations, catalog: { fr: { journeys: { intake: { name: "Pas à pas" } } } } })).toBe("Pas à pas");
  });

  it("addresses a journey's texts by journey and page id, never by an index", () => {
    expect(journeyTextAddress("apply", "name")).toEqual({ kind: "journeys", owner: "apply", path: ["name"] });
    expect(journeyTextAddress("apply", "texts.back")).toEqual({ kind: "journeys", owner: "apply", path: ["texts", "back"] });
    expect(journeyTextAddress("apply", "title", "start")).toEqual({ kind: "journeys", owner: "apply", path: ["pages", "start", "title"] });
    expect(journeyTextAddress("apply", "texts.continue", "start")).toEqual({ kind: "journeys", owner: "apply", path: ["pages", "start", "texts", "continue"] });
  });

  it("lists every journey and page text with its default and its address, written or not", () => {
    const apply: Journey = { id: "apply", name: "Apply", pages: [{ id: "start", title: "Start here", components: ["name"] }, { id: "end", components: ["name"] }] };
    const rows = journeyTranslatableTexts([apply], "en");
    const nameRow = rows.find((row) => row.componentId === "journey.apply" && row.propertyPath === "name");
    expect(nameRow).toMatchObject({ default: "Apply", address: { kind: "journeys", owner: "apply", path: ["name"] }, section: "Journey" });
    expect(rows.find((row) => row.componentId === "journey.apply.start" && row.propertyPath === "title")).toMatchObject({
      default: "Start here",
      address: { kind: "journeys", owner: "apply", path: ["pages", "start", "title"] }
    });
    // Unwritten texts are listed with an empty default so a translator can see them.
    expect(rows.find((row) => row.componentId === "journey.apply.end" && row.propertyPath === "description")).toMatchObject({ default: "" });
    // No row carries a locales map or a key: translations are the map's.
    expect(rows.every((row) => !("locales" in row) && !("key" in row) && !("keyDefault" in row))).toBe(true);
  });

  it("resolves the default as findJourney does: the declared one when listed, else the first", () => {
    expect(effectiveDefaultJourneyId(mixed())).toBe("short");
    expect(effectiveDefaultJourneyId({ ...mixed(), defaultJourneyId: "broken" })).toBe("intake");
    expect(effectiveDefaultJourneyId({ journeys: [] })).toBeUndefined();
    expect(effectiveDefaultJourneyId(undefined)).toBeUndefined();
  });
});

describe("ids", () => {
  it("makes an id in the component-id grammar from a name", () => {
    expect(journeyIdFromName("Step by step")).toBe("step-by-step");
    expect(journeyIdFromName("  Été 2026: renewals ")).toBe("ete-2026-renewals");
    expect(journeyIdFromName("2026 intake")).toBe("journey-2026-intake");
    expect(journeyIdFromName("")).toBe("journey");
    expect(journeyIdFromName("!!!")).toBe("journey");
    expect(journeyIdFromName("خطوة")).toBe("journey");
    for (const name of ["Step by step", "2026 intake", "", "Été"]) {
      expect(isValidComponentId(journeyIdFromName(name))).toBe(true);
    }
  });

  it("numbers an id already taken", () => {
    expect(uniqueJourneyId("intake", [])).toBe("intake");
    expect(uniqueJourneyId("intake", ["intake"])).toBe("intake-2");
    expect(uniqueJourneyId("intake", ["intake", "intake-2"])).toBe("intake-3");
  });
});

describe("adding", () => {
  // The first journey is what the form opens as.
  it("makes the form open as the first journey added, and no later one changes it", () => {
    const first = addJourney(undefined, journey("intake"));
    expect(first).toEqual({ journeys: [journey("intake")], opensAs: "journey" });
    // Only readable journeys count: a block of broken ones has no first yet.
    expect(addJourney({ journeys: [UNREADABLE] } as unknown as JourneyConfiguration, journey("intake")).opensAs).toBe("journey");
    // Unset or "form" with no journey listed: the first journey sets it.
    expect(addJourney({ journeys: [], opensAs: "form" }, journey("intake")).opensAs).toBe("journey");
    expect(addJourney({ journeys: [] }, journey("intake")).opensAs).toBe("journey");
    // A second journey leaves the key as it is: the author chose, or the form was saved that way.
    expect(addJourney(first, journey("short")).opensAs).toBe("journey");
    expect(addJourney({ journeys: [journey("intake")], opensAs: "form" }, journey("short")).opensAs).toBe("form");
    expect(addJourney({ journeys: [journey("intake")] }, journey("short")).opensAs).toBeUndefined();
  });

  it("appends after everything declared and keeps every other key in its place", () => {
    const next = addJourney(mixed(), journey("renewal"));
    expect(Object.keys(next)).toEqual(["x-owner", "journeys", "defaultJourneyId", "opensAs", "x-review"]);
    expect(next.journeys?.map((entry) => entry.id)).toEqual(["intake", "broken", "intake", "short", "renewal"]);
    expect(next.journeys?.[1]).toBe(UNREADABLE);
    expect(next.journeys?.[2]).toBe(SECOND_INTAKE);
  });

  it("refuses an id in use, even by a journey it does not list, an id off the grammar, and an unusable journey", () => {
    expect(() => addJourney(mixed(), journey("short"))).toThrow(/already exists/);
    expect(() => addJourney(mixed(), journey("broken"))).toThrow(/already exists/);
    expect(() => addJourney(mixed(), journey("2026"))).toThrow(/cannot be a journey id/);
    expect(() => addJourney(mixed(), { id: "bad", pages: [{ id: "" }] })).toThrow(/not usable/);
  });

  it("takes the words a rule reads as its own as journey ids, and refuses only the prototype names", () => {
    for (const id of ["host", "row", "component", "ancestor"]) {
      expect(uniqueJourneyId(journeyIdFromName(id[0]!.toUpperCase() + id.slice(1)), [])).toBe(id);
      expect(addJourney(undefined, journey(id)).journeys?.map((entry) => entry.id)).toEqual([id]);
    }
    for (const id of ["constructor", "prototype"]) {
      expect(() => addJourney(undefined, journey(id))).toThrow(
        `"${id}" cannot be a journey id: it is a reserved name, and texts kept under it could not be translated (__proto__, constructor and prototype are).`
      );
      expect(() => replaceJourney({ journeys: [journey("intake")] }, "intake", journey(id))).toThrow(/reserved name/);
      expect(() => duplicateJourney({ journeys: [journey("intake")] }, "intake", { id })).toThrow(/reserved name/);
    }
    // A name that slugs to one is numbered past it, as a taken id is.
    expect(uniqueJourneyId(journeyIdFromName("Constructor"), [])).toBe("constructor-2");
    expect(uniqueJourneyId("prototype", ["prototype-2"])).toBe("prototype-3");
  });

  it("never writes a block the runtime reads differently", () => {
    const next = addJourney(mixed(), journey("renewal"));
    expect(readJourneys({ journey: next }).map((entry) => entry.id)).toEqual(["intake", "intake", "short", "renewal"]);
  });
});

describe("replacing, removing and the default", () => {
  it("replaces the listed journey in place; the default follows an id change", () => {
    const configuration = mixed();
    const renamed = replaceJourney(configuration, "short", { ...journey("brief"), name: "Brief" });
    expect(renamed.journeys?.map((entry) => entry.id)).toEqual(["intake", "broken", "intake", "brief"]);
    expect(renamed.defaultJourneyId).toBe("brief");
    expect(Object.keys(renamed)).toEqual(Object.keys(configuration));
    // The first "intake" is the one replaced; the duplicate stays as it was.
    const edited = replaceJourney(configuration, "intake", journey("intake", "Edited"));
    expect(edited.journeys?.[0]?.name).toBe("Edited");
    expect(edited.journeys?.[2]).toBe(SECOND_INTAKE);
    expect(() => replaceJourney(configuration, "broken", journey("broken"))).toThrow(/No journey/);
    expect(() => replaceJourney(configuration, "short", journey("intake"))).toThrow(/already exists/);
  });

  it("removes down to none, clearing a removed default and, at none, what only journeys meant", () => {
    const configuration: JourneyConfiguration = { journeys: [journey("intake"), journey("short")], defaultJourneyId: "short", opensAs: "journey" };
    const one = removeJourney(configuration, "short");
    // The journey the form opened as is gone: the form opens whole rather than as another journey.
    expect(one).toEqual({ journeys: [journey("intake")], opensAs: "form" });
    expect(effectiveDefaultJourneyId(one)).toBe("intake");
    expect(removeJourney(configuration, "intake").defaultJourneyId).toBe("short");
    const none = removeJourney(one, "intake");
    expect(none).toEqual({ journeys: [] });
    expect(canonicalJourneyConfiguration(none)).toBeUndefined();
    expect(() => removeJourney(none, "intake")).toThrow(/No journey/);
  });

  it("keeps unlisted journeys and unknown keys when removing, and lists a duplicate once its first is gone", () => {
    const next = removeJourney(mixed(), "intake");
    expect(next.journeys).toEqual([UNREADABLE, SECOND_INTAKE, journey("short")]);
    expect(journeysOf(next).map((entry) => entry.name ?? entry.id)).toEqual(["Another intake", "short"]);
    expect((next as unknown as Record<string, unknown>)["x-review"]).toEqual({ by: "someone" });
    // With journeys still declared, even unlisted ones, the block keeps saying how it opens.
    const onlyBroken = removeJourney({ journeys: [journey("intake"), UNREADABLE] } as unknown as JourneyConfiguration, "intake");
    expect(onlyBroken).toEqual({ journeys: [UNREADABLE] });
  });

  it("resets what the form opens as when the journey it opens as is removed, and only then", () => {
    const two = (extra: Partial<JourneyConfiguration>): JourneyConfiguration => ({ journeys: [journey("intake"), journey("short")], ...extra });
    // The declared default, the first when none is declared, and a key that is unset (read as a journey).
    expect(removeJourney(two({ defaultJourneyId: "short", opensAs: "journey" }), "short").opensAs).toBe("form");
    expect(removeJourney(two({ opensAs: "journey" }), "intake").opensAs).toBe("form");
    expect(removeJourney(two({}), "intake").opensAs).toBe("form");
    // Another journey going, or a form that opens whole, changes nothing.
    expect(removeJourney(two({ defaultJourneyId: "short", opensAs: "journey" }), "intake").opensAs).toBe("journey");
    expect(removeJourney(two({ defaultJourneyId: "short" }), "intake")).toEqual({ journeys: [journey("short")], defaultJourneyId: "short" });
    expect(removeJourney(two({ opensAs: "form" }), "intake")).toEqual({ journeys: [journey("short")], opensAs: "form" });
    // The default journey of a form that opens whole is removed: still whole, and the default is cleared.
    expect(removeJourney(two({ defaultJourneyId: "short", opensAs: "form" }), "short")).toEqual({ journeys: [journey("intake")], opensAs: "form" });
    // At none the key goes, so the next first journey sets it again.
    expect(removeJourney({ journeys: [journey("intake")], opensAs: "journey" }, "intake")).toEqual({ journeys: [] });
  });

  it("chooses what the form opens as in one edit: the default and the key together", () => {
    const configuration: JourneyConfiguration = { journeys: [journey("intake"), journey("short")], opensAs: "form", "x-owner": "team" } as JourneyConfiguration;
    const chosen = chooseOpensAs(configuration, "short");
    expect(chosen).toMatchObject({ defaultJourneyId: "short", opensAs: "journey" });
    expect(Object.keys(chosen)).toEqual(["journeys", "opensAs", "x-owner", "defaultJourneyId"]);
    // The journey that is the default already is not written as one; an unset key already means a journey.
    expect(chooseOpensAs(configuration, "intake")).toEqual({ journeys: [journey("intake"), journey("short")], opensAs: "journey", "x-owner": "team" });
    expect(chooseOpensAs({ journeys: [journey("intake"), journey("short")] }, "intake")).toEqual({ journeys: [journey("intake"), journey("short")] });
    expect(chooseOpensAs({ journeys: [journey("intake"), journey("short")] }, "short")).toEqual({ journeys: [journey("intake"), journey("short")], defaultJourneyId: "short" });
    // The whole form leaves the default where it was.
    expect(chooseOpensAs({ journeys: [journey("intake")], defaultJourneyId: "intake", opensAs: "journey" }, "form")).toEqual({ journeys: [journey("intake")], defaultJourneyId: "intake", opensAs: "form" });
    expect(() => chooseOpensAs(configuration, "broken")).toThrow(/No journey/);
  });

  it("sets the default only to a listed journey, and what the form opens as", () => {
    expect(setDefaultJourney(mixed(), "intake").defaultJourneyId).toBe("intake");
    expect(() => setDefaultJourney(mixed(), "broken")).toThrow(/No journey/);
    const opensForm = setOpensAs(mixed(), "form");
    expect(opensForm.opensAs).toBe("form");
    expect(Object.keys(opensForm)).toEqual(Object.keys(mixed()));
    expect("opensAs" in setOpensAs(mixed(), undefined)).toBe(false);
  });
});

describe("duplicating", () => {
  it("copies the listed journey under a -copy id and a (copy) name, sharing nothing", () => {
    const configuration = mixed();
    const { configuration: next, journey: copy } = duplicateJourney(configuration, "intake");
    expect(copy.id).toBe("intake-copy");
    expect(copy.name).toBe("Step by step (copy)");
    expect(copy.pages).toEqual(journeysOf(configuration)[0]?.pages);
    expect(copy.pages).not.toBe(journeysOf(configuration)[0]?.pages);
    expect(next.journeys?.map((entry) => entry.id)).toEqual(["intake", "broken", "intake", "short", "intake-copy"]);
    expect(next.defaultJourneyId).toBe("short");
    expect(duplicateJourney(next, "intake").journey.id).toBe("intake-copy-2");
    expect(duplicateJourney(configuration, "short").journey.name).toBe("short (copy)");
    expect(duplicateJourney(configuration, "short", { id: "brief", name: "Brief" }).journey).toMatchObject({ id: "brief", name: "Brief" });
  });

  it("gives a journey whose id is off the grammar a copy whose id is on it", () => {
    const { journey: copy } = duplicateJourney({ journeys: [journey("1")] }, "1");
    expect(copy.id).toBe("journey-1-copy");
    expect(isValidComponentId(copy.id)).toBe(true);
  });
});

describe("canonicalJourneyConfiguration", () => {
  it("drops only a block that says nothing", () => {
    expect(canonicalJourneyConfiguration(undefined)).toBeUndefined();
    expect(canonicalJourneyConfiguration({})).toBeUndefined();
    expect(canonicalJourneyConfiguration({ journeys: [] })).toBeUndefined();
    const opensForm: JourneyConfiguration = { journeys: [], opensAs: "form" };
    expect(canonicalJourneyConfiguration(opensForm)).toBe(opensForm);
    const unknown = { journeys: [], "x-owner": "team" } as unknown as JourneyConfiguration;
    expect(canonicalJourneyConfiguration(unknown)).toBe(unknown);
    const configuration = mixed();
    expect(canonicalJourneyConfiguration(configuration)).toBe(configuration);
  });
});

/**
 * A journey whose pages hold nodes of its own is usable, so the catalog lists it and every action works on it (the designer opens it
 * too). Whatever the catalog does, its pages come back exactly as written.
 */
describe("a journey with page-only fields", () => {
  /** The presentation fixture's two journeys (one of them one page) around a plain journey, with keys the catalog does not know. */
  function presentations(): JourneyConfiguration {
    return {
      "x-owner": "forms-team",
      journeys: [applyJourney(), journey("plain"), publicVariant()],
      defaultJourneyId: "plain"
    } as unknown as JourneyConfiguration;
  }

  it("is listed like any other and never reported as unreadable", () => {
    const configuration = presentations();
    expect(journeysOf(configuration).map((entry) => entry.id)).toEqual(["apply", "plain", "public"]);
    expect(unlistedJourneysOf(configuration)).toEqual([]);
  });

  it("stays byte for byte, the very object, through an edit of another journey", () => {
    const configuration = presentations();
    const before = JSON.stringify(configuration);
    const apply = configuration.journeys?.[0];
    const variant = configuration.journeys?.[2];
    const edited = replaceJourney(configuration, "plain", { ...journey("plain"), pages: [{ id: "one", title: "Edited", components: ["name", "email"] }] });
    expect(edited.journeys?.[0]).toBe(apply);
    expect(edited.journeys?.[2]).toBe(variant);
    expect(JSON.stringify(edited.journeys?.[0])).toBe(JSON.stringify(applyJourney()));
    expect(JSON.stringify(edited.journeys?.[2])).toBe(JSON.stringify(publicVariant()));
    expect(JSON.stringify(configuration)).toBe(before);
  });

  it("can be the default, and keeps its pages when it is", () => {
    const configuration = setDefaultJourney(presentations(), "apply");
    expect(effectiveDefaultJourneyId(configuration)).toBe("apply");
    expect(configuration.journeys?.[0]).toEqual(applyJourney());
    expect(setOpensAs(configuration, "journey").journeys?.[0]).toBe(configuration.journeys?.[0]);
  });

  it("is renamed by replacing its name alone: the pages are the same objects", () => {
    const configuration = presentations();
    const apply = configuration.journeys?.[0] as Journey;
    const renamed = replaceJourney(configuration, "apply", { ...apply, name: "Apply for support" });
    expect(renamed.journeys?.[0]?.name).toBe("Apply for support");
    expect(renamed.journeys?.[0]?.pages).toBe(apply.pages);
    expect(JSON.stringify(renamed.journeys?.[0])).toBe(JSON.stringify({ ...applyJourney(), name: "Apply for support" }));
  });

  it("is copied deep: the copy has every own node, and shares none with the original", () => {
    const configuration = presentations();
    const { configuration: copied, journey: copy } = duplicateJourney(configuration, "apply");
    expect(copy.id).toBe("apply-copy");
    expect(copy.name).toBe("Apply (copy)");
    expect(copied.journeys?.[3]).toBe(copy);
    expect(JSON.stringify(copy.pages)).toBe(JSON.stringify(applyJourney().pages));
    expect(readJourneys({ journey: copied }).map((entry) => entry.id)).toEqual(["apply", "plain", "public", "apply-copy"]);
    // Nothing shared: changing the copy's alias, its worked-out value or a nested reference leaves the original alone.
    const original = configuration.journeys?.[0] as Journey;
    const alias = copy.pages[0]?.components?.[0] as unknown as { configuration: { fills: string } };
    const total = copy.pages[1]?.components?.[3] as unknown as { configuration: { value: string } };
    expect(alias).not.toBe(original.pages[0]?.components?.[0]);
    expect(alias.configuration).not.toBe((original.pages[0]?.components?.[0] as unknown as { configuration: unknown }).configuration);
    alias.configuration.fills = "name";
    total.configuration.value = "0";
    expect(JSON.stringify(original)).toBe(JSON.stringify(applyJourney()));
    expect(copied.journeys?.[0]).toBe(original);

    const variantCopy = duplicateJourney(configuration, "public").journey;
    const columns = variantCopy.pages[0]?.components?.[0] as unknown as { children: { content: Array<{ configuration: { componentId: string } }> } };
    columns.children.content[0]!.configuration.componentId = "changed";
    expect(JSON.stringify(configuration.journeys?.[2])).toBe(JSON.stringify(publicVariant()));
  });

  it("is removed like any other, the rest as they were", () => {
    const configuration = presentations();
    const removed = removeJourney(configuration, "apply");
    expect(journeysOf(removed).map((entry) => entry.id)).toEqual(["plain", "public"]);
    expect(removed.journeys?.[1]).toBe(configuration.journeys?.[2]);
    expect(removed.defaultJourneyId).toBe("plain");
  });

  it("keeps a __proto__ key of the block as a key of it through every catalog action", () => {
    const text = '{"__proto__":{"x-owner":"team"},"journeys":[{"id":"g","pages":[{"id":"p","components":[{"id":"own","type":"text"}]}]},{"id":"h","pages":[]}]}';
    const given = (): JourneyConfiguration => JSON.parse(text) as JourneyConfiguration;
    const kept = (block: JourneyConfiguration): void => {
      expect(Object.prototype.hasOwnProperty.call(block, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(block)).toBe(Object.prototype);
      expect(JSON.stringify(block).startsWith('{"__proto__":{"x-owner":"team"},"journeys":')).toBe(true);
    };
    const made = setDefaultJourney(given(), "h");
    kept(made);
    expect(JSON.stringify(made)).toBe(text.replace(/}$/, ',"defaultJourneyId":"h"}'));
    kept(duplicateJourney(given(), "g").configuration);
    kept(removeJourney(given(), "h"));
    kept(setOpensAs(given(), "journey"));
  });
});

describe("the ids a host names something else by", () => {
  it("never gives a journey the id \"form\" or \"journey\", which a host reads as the whole form and the default journey", () => {
    expect(RESERVED_JOURNEY_IDS).toEqual(["form", "journey"]);
    expect(uniqueJourneyId(journeyIdFromName("Form"), [])).toBe("form-1");
    expect(uniqueJourneyId(journeyIdFromName(""), [])).toBe("journey-1");
    expect(uniqueJourneyId("journey", ["journey-1"])).toBe("journey-2");
    expect(() => addJourney(undefined, journey("form"))).toThrow(/host names the whole form/);
    expect(() => replaceJourney({ journeys: [journey("intake")] }, "intake", journey("journey"))).toThrow(/default journey/);
    expect(() => duplicateJourney({ journeys: [journey("intake")] }, "intake", { id: "form" })).toThrow(/cannot be a journey id/);
    // One a file already declares is listed and edited as it is.
    const declared = { journeys: [journey("form")] };
    expect(journeysOf(declared).map((entry) => entry.id)).toEqual(["form"]);
    expect(replaceJourney(declared, "form", journey("form", "Renamed")).journeys?.[0]?.name).toBe("Renamed");
  });
});
