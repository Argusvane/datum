import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createJourneyBuilderMode, type JourneyBuilderMode } from "../form-engine/builder/journey-designer/journey-builder-mode.js";
import { JOURNEY_PAGES_SLOT } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { journeyTextAddress } from "../form-engine/builder/journey-designer/journey-catalog.js";
import { ownNodeIdsOf, setJourneyDefaults } from "../form-engine/builder/journey-designer/journey-texts.js";
import type { BuilderModeContext } from "../form-engine/builder/web-component/builder-modes.js";
import { addressOf, readTranslation, sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import type { Journey, JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A journey's name and its pages' titles are strings in the form's default language; their
 * translations are the definition's map under `journeys › <journey id> …`. The mode
 * keeps the map with the journeys: a removed journey or page is pruned from every language, a
 * renamed one moved, a copied journey copied, and what a deletion took comes back with its Undo.
 */

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        { id: "notes", type: "text", configuration: { label: "Notes" } },
        { id: "consent", type: "checkbox", configuration: { label: "I agree" } }
      ]
    }
  };
}

function seed(): JourneyConfiguration {
  return {
    journeys: [
      {
        id: "intake",
        name: "Step by step",
        pages: [
          { id: "about", title: "About you", components: ["fullName"], routes: [{ to: "finish" }] },
          { id: "more", title: "More", description: "Anything else", components: ["notes"] },
          { id: "finish", components: ["consent"] }
        ]
      },
      { id: "quick", name: "Quick", pages: [{ id: "all", title: "Everything", components: ["fullName", "notes", "consent"] }] }
    ]
  } as unknown as JourneyConfiguration;
}

const entry = (text: string, source: string): { text: string; source: string } => ({ text, source: sourceHash(source) });

/** French and German for the intake journey and the quick one. */
function translations(): FormTranslations {
  return {
    fr: {
      form: { title: entry("Accueil", "Intake") },
      journeys: {
        intake: {
          name: entry("Pas à pas", "Step by step"),
          pages: {
            about: { title: entry("À propos de vous", "About you") },
            more: { title: entry("Plus", "More"), description: entry("Autre chose", "Anything else") }
          }
        },
        quick: { name: entry("Rapide", "Quick"), pages: { all: { title: entry("Tout", "Everything") } } }
      }
    },
    de: { journeys: { intake: { pages: { more: { title: entry("Mehr", "More") } } } } }
  };
}

function context(): BuilderModeContext {
  return { host: {} as HTMLElement, root: {} as ShadowRoot, showCanvasSurface: () => undefined };
}

async function activated(): Promise<{ form: BuilderController; mode: JourneyBuilderMode }> {
  const form = new BuilderController({ initialRoot: formRoot() });
  form.replaceTranslations(translations(), { silent: true });
  const mode = createJourneyBuilderMode({ form, journey: seed() });
  await mode.activate?.(context());
  return { form, mode };
}

function pages(controller: BuilderController): ComponentNode[] {
  return controller.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? [];
}

const pageEntries = (form: BuilderController, locale: string, journey: string): string[] =>
  Object.keys(form.translations()?.[locale]?.journeys?.[journey]?.pages ?? {});

describe("a journey removed or copied", () => {
  it("prunes its translations from every language when the journey is removed, and one form Undo brings the journey and the entries back", async () => {
    const { form, mode } = await activated();
    const before = mode.journeyConfiguration;
    mode.removeJourney("quick");
    expect(form.translations()?.fr?.journeys?.quick).toBeUndefined();
    expect(form.translations()?.fr?.journeys?.intake).toBeDefined();
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["intake"]);
    // The journey and its entries are one step of the form's history: one Undo takes both back.
    form.undo();
    expect(form.translations()).toEqual(translations());
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["intake", "quick"]);
    expect(mode.journeyConfiguration).toEqual(before);
    // And one Redo removes both again.
    form.redo();
    expect(form.translations()?.fr?.journeys?.quick).toBeUndefined();
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["intake"]);
    form.undo();
    // An agent putting the catalog back brings the journey, and what the removal held is written
    // again only where the map lacks it.
    mode.removeJourney("quick");
    mode.applyCatalogForAgent(before, "quick");
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["intake", "quick"]);
    expect(form.translations()).toEqual(translations());
    mode.removeJourney("quick");
    expect(form.translations()?.fr?.journeys?.quick).toBeUndefined();
    mode.applyCatalogForAgent(before, "quick");
    expect(readTranslation(form.translations(), "fr", addressOf.journeyPage("quick", "all", "title"))).toEqual(entry("Tout", "Everything"));
    expect(readTranslation(form.translations(), "fr", addressOf.journey("quick", "name"))).toEqual(entry("Rapide", "Quick"));
  });

  it("is one step of the form's history on a form without translations: removed, copied or renamed, one Undo each", async () => {
    const form = new BuilderController({ initialRoot: formRoot() });
    const mode = createJourneyBuilderMode({ form, journey: seed() });
    await mode.activate?.(context());
    const before = mode.journeyConfiguration;
    mode.removeJourney("quick");
    expect(form.canUndo()).toBe(true);
    form.undo();
    expect(mode.journeyConfiguration).toEqual(before);
    form.redo();
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["intake"]);
    form.undo();
    mode.duplicateJourney("intake");
    mode.renameJourney("quick", "Fast");
    form.undo();
    expect(mode.journeys.find((journey) => journey.id === "quick")?.name).toBe("Quick");
    form.undo();
    expect(mode.journeyConfiguration).toEqual(before);
    // Nothing more was recorded than the actions, and no translation was made up for them.
    expect(form.canUndo()).toBe(false);
    expect(form.translations()).toBeUndefined();
  });

  it("copies the original's translations under the copy's id, the renamed name flagged as changed", async () => {
    const { form, mode } = await activated();
    const copy = mode.duplicateJourney("intake");
    expect(copy.id).toBe("intake-copy");
    const copied = form.translations()?.fr?.journeys?.[copy.id];
    expect(copied?.pages).toEqual(translations().fr?.journeys?.intake?.pages);
    // The copy's name is "Step by step (copy)": the entry it carries answers the original's wording.
    const name = readTranslation(form.translations(), "fr", addressOf.journey(copy.id, "name"));
    expect(name).toEqual(entry("Pas à pas", "Step by step"));
    expect(name?.source).not.toBe(sourceHash(copy.name ?? ""));
    // The original keeps its own.
    expect(form.translations()?.fr?.journeys?.intake).toEqual(translations().fr?.journeys?.intake);
    // The copy and its entries are one step: one Undo takes both away, one Redo makes both again.
    form.undo();
    expect(form.translations()?.fr?.journeys?.[copy.id]).toBeUndefined();
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["intake", "quick"]);
    form.redo();
    expect(form.translations()?.fr?.journeys?.[copy.id]).toBeDefined();
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["intake", "quick", copy.id]);
  });

  it("moves them when a host gives the journey another id, announces the id with its kind, and one Undo moves them back", async () => {
    const { form, mode } = await activated();
    const heard: Array<{ kind: string; from: string; to: string }> = [];
    form.on("change", (event) => heard.push(...(event.renamedIds ?? [])));
    mode.replaceJourney("quick", { ...(mode.journeys.find((journey) => journey.id === "quick") as Journey), id: "fast" });
    expect(form.translations()?.fr?.journeys?.quick).toBeUndefined();
    expect(readTranslation(form.translations(), "fr", addressOf.journeyPage("fast", "all", "title"))).toEqual(entry("Tout", "Everything"));
    expect(heard).toEqual([{ kind: "journeys", from: "quick", to: "fast" }]);
    form.undo();
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["intake", "quick"]);
    expect(form.translations()).toEqual(translations());
  });
});

describe("a page deleted or renamed in the designer", () => {
  it("prunes the page's entries in every language as one step of the form's history, which one Undo takes back with the page", async () => {
    const { form, mode } = await activated();
    const more = pages(mode.controller)[1]!;
    mode.controller.remove(more.id);
    expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "finish"]);
    expect(pageEntries(form, "fr", "intake")).toEqual(["about"]);
    // German held only that page: the language's journeys block empties out with it.
    expect(form.translations()?.de).toBeUndefined();
    expect(form.translations()?.fr?.journeys?.quick).toBeDefined();
    // One form Undo brings the page and its entries back together.
    form.undo();
    expect(form.translations()).toEqual(translations());
    expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "more", "finish"]);
    form.redo();
    expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "finish"]);
    expect(pageEntries(form, "fr", "intake")).toEqual(["about"]);
  });

  it("does not double-restore: the designer's Undo after the form's, or the form's after the designer's, ends with the page and its entries once", async () => {
    const { form, mode } = await activated();
    const more = pages(mode.controller)[1]!;
    mode.controller.remove(more.id);
    form.undo();
    // The designer was rebuilt over the restored page; its Undo has nothing of the removal left to do.
    mode.controller.undo();
    expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "more", "finish"]);
    expect(form.translations()).toEqual(translations());
    // The other way round: the designer's Undo restores the page and writes the entries once.
    mode.controller.remove(pages(mode.controller)[1]!.id);
    mode.controller.undo();
    expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "more", "finish"]);
    expect(form.translations()).toEqual(translations());
    // Undoing the form's steps then leaves the page and the entries where they started.
    form.undo();
    form.undo();
    expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "more", "finish"]);
    expect(form.translations()).toEqual(translations());
  });

  it("brings the entries back with the page when the designer's Undo restores it", async () => {
    const { form, mode } = await activated();
    const more = pages(mode.controller)[1]!;
    mode.controller.remove(more.id);
    expect(pageEntries(form, "fr", "intake")).toEqual(["about"]);
    mode.controller.undo();
    expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "more", "finish"]);
    expect(form.translations()).toEqual(translations());
    // Redo removes them again.
    mode.controller.redo();
    expect(pageEntries(form, "fr", "intake")).toEqual(["about"]);
  });

  it("moves the page's entries when its id changes, and announces the page id", async () => {
    const { form, mode } = await activated();
    const heard: Array<{ kind: string; from: string; to: string; owner?: string; within?: string }> = [];
    form.on("change", (event) => heard.push(...(event.renamedIds ?? [])));
    const more = pages(mode.controller)[1]!;
    mode.controller.setProperty(more.id, "pageId", "details");
    expect(heard).toContainEqual({ kind: "journeys", owner: "intake", within: "pages", from: "more", to: "details" });
    expect(pageEntries(form, "fr", "intake")).toEqual(["about", "details"]);
    expect(readTranslation(form.translations(), "fr", addressOf.journeyPage("intake", "details", "description"))).toEqual(entry("Autre chose", "Anything else"));
    expect(readTranslation(form.translations(), "de", addressOf.journeyPage("intake", "details", "title"))).toEqual(entry("Mehr", "More"));
    expect(readTranslation(form.translations(), "fr", addressOf.journeyPage("intake", "more", "title"))).toBeUndefined();
  });

  it("leaves the map alone for an edit that touches no page id", async () => {
    const { form, mode } = await activated();
    const about = pages(mode.controller)[0]!;
    mode.controller.setProperty(about.id, "title", "About");
    expect(form.translations()).toEqual(translations());
    // The French title now answers other wording; it is the Languages workspace that says so.
    expect(readTranslation(form.translations(), "fr", addressOf.journeyPage("intake", "about", "title"))?.source).toBe(sourceHash("About you"));
  });
});

describe("a journey made from the form", () => {
  it("carries the form title's translations to a one-page start's page title", async () => {
    const { form, mode } = await activated();
    const made = await mode.newJourney({ from: "one-page", name: "Whole form" });
    expect(made.pages[0]?.title).toBe("Intake");
    const title = readTranslation(form.translations(), "fr", addressOf.journeyPage(made.id, made.pages[0]!.id, "title"));
    expect(title).toEqual(entry("Accueil", "Intake"));
  });

  it("does not carry a translation that is already source-changed: the copy would claim a currency it lacks", async () => {
    const { form, mode } = await activated();
    form.replaceTranslations({ fr: { form: { title: entry("Accueil", "Old title") } } }, { silent: true });
    const made = await mode.newJourney({ from: "one-page", name: "Whole form" });
    expect(readTranslation(form.translations(), "fr", addressOf.journeyPage(made.id, made.pages[0]!.id, "title"))).toBeUndefined();
  });
});

describe("the journeys' default strings", () => {
  const journey: Journey = {
    id: "apply",
    name: "Apply",
    pages: [
      {
        id: "start",
        title: "Start",
        components: [
          "fullName",
          { id: "extra", type: "select", configuration: { label: "Extra", options: [{ value: "a", label: "A" }], messages: { required: "Pick one" } } },
          { id: "box", type: "panel", children: { content: [{ id: "inner", type: "text", configuration: { label: "Inner" } }] } },
          { id: "@ref", type: "journey-field", configuration: { componentId: "notes" } }
        ]
      }
    ]
  } as unknown as Journey;

  it("lists the page-only nodes by id at any depth, and no reference", () => {
    expect([...ownNodeIdsOf(journey)].sort()).toEqual(["box", "extra", "inner"]);
    expect(ownNodeIdsOf(undefined).size).toBe(0);
  });

  it("writes new defaults at their addresses: the journey, a page, and a page-only node's property, option and message", () => {
    const next = setJourneyDefaults({ journeys: [journey] }, [
      { address: addressOf.journey("apply", "name"), default: "Demander" },
      { address: addressOf.journeyPage("apply", "start", "title"), default: "Début" },
      { address: addressOf.component("extra", "label"), default: "Autre" },
      { address: addressOf.option("extra", "a", "label"), default: "Un" },
      { address: addressOf.message("extra", "required"), default: "Choisir" },
      { address: addressOf.component("inner", "label"), default: "Dedans" }
    ]);
    const written = next?.journeys?.[0] as unknown as { name: string; pages: Array<{ title: string; components: Array<{ id: string; configuration?: Record<string, unknown>; children?: Record<string, Array<{ configuration: Record<string, unknown> }>> }> }> };
    expect(written.name).toBe("Demander");
    expect(written.pages[0]?.title).toBe("Début");
    const extra = written.pages[0]?.components[1]?.configuration;
    expect(extra).toMatchObject({ label: "Autre", options: [{ value: "a", label: "Un" }], messages: { required: "Choisir" } });
    expect(written.pages[0]?.components[2]?.children?.content?.[0]?.configuration.label).toBe("Dedans");
    // The input is untouched.
    expect(journey.name).toBe("Apply");
  });

  it("writes the journey's and a page's wording (texts.*) at the addresses the catalog lists them under", () => {
    const next = setJourneyDefaults({ journeys: [journey] }, [
      { address: journeyTextAddress("apply", "texts.back"), default: "Retour" },
      { address: journeyTextAddress("apply", "texts.continue", "start"), default: "Suivant" }
    ]);
    const written = next?.journeys?.[0] as unknown as { texts: Record<string, string>; pages: Array<{ texts: Record<string, string> }> };
    expect(written.texts).toEqual({ back: "Retour" });
    expect(written.pages[0]?.texts).toEqual({ continue: "Suivant" });
  });

  it("refuses an address that is not a text the designer edits, and returns the block itself when nothing lands", () => {
    const block: JourneyConfiguration = { journeys: [journey] };
    expect(setJourneyDefaults(block, [])).toBe(block);
    expect(setJourneyDefaults(block, [{ address: { kind: "journeys", owner: "apply", path: ["id"] }, default: "x" }])).toBe(block);
    expect(setJourneyDefaults(block, [{ address: { kind: "journeys", owner: "apply", path: ["pages", "start", "components"] }, default: "x" }])).toBe(block);
    expect(setJourneyDefaults(block, [{ address: { kind: "journeys", owner: "ghost", path: ["name"] }, default: "x" }])).toBe(block);
    expect(setJourneyDefaults(undefined, [{ address: addressOf.journey("apply", "name"), default: "x" }])).toBeUndefined();
  });
});
