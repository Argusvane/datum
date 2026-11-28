import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuilderController, type BuilderRootSetting } from "../form-engine/builder/controller/builder-controller.js";
import {
  JOURNEY_BUILDER_MODE,
  createJourneyBuilderMode,
  journeyNodeAfterRemoval,
  loadJourneyDesigner,
  type JourneyBuilderMode,
  type JourneyBuilderModeChangeDetail,
  type JourneyMapLayout,
  type JourneyModeView
} from "../form-engine/builder/journey-designer/journey-builder-mode.js";
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
import { journeyPagesFromForm } from "../form-engine/builder/journey-designer/journey-from-form.js";
import { readJourneyMapLayout } from "../form-engine/builder/journey-map/journey-map-preferences.js";
import type { BuilderFormSettingRow, BuilderModeContext, BuilderModeRules } from "../form-engine/builder/web-component/builder-modes.js";
import type { TryPanelView } from "../form-engine/builder/web-component/try-it-types.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { renameJourneyReferences } from "../form-engine/builder/journey-designer/journey-references.js";
import { validateJourneyShape, type Journey, type JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import { applyJourney, presentationRoot, publicVariant } from "./fixtures/presentation-form.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";

/**
 * The Journeys mode under Node: its catalog and documents, the designer it loads on
 * activation, how it reports edits (never an unedited journey), the Form panel's "Opens as"
 * row, "Add unassigned", the page-id problem on the unsaved-changes prompt's Save, and how it
 * follows the form — repainting, never rebuilding, and renaming in place. The DOM parts (the
 * popover, the empty state, the bar's button) are drawn only where there is a DOM.
 */

const DESIGNER_MODULE = "../form-engine/builder/journey-designer/journey-designer.js";
const MAP_MODULE = "../form-engine/builder/journey-map/journey-map.js";
const PREVIEW_MODULE = "../form-engine/builder/journey-designer/journey-preview.js";

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        { id: "contactMethod", type: "select", configuration: { label: "Contact method" } },
        {
          id: "children",
          type: "panel",
          configuration: { label: "Children" },
          collection: { collectionPath: "children", itemFields: ["childName"] },
          children: { content: [{ id: "childName", type: "text", configuration: { label: "Child's name" } }] }
        },
        { id: "consent", type: "checkbox", configuration: { label: "I agree" } },
        { id: "notes", type: "text", configuration: { label: "Notes" } },
        { id: "submit", type: "button", configuration: { label: "Send" } }
      ]
    }
  };
}

function formController(): BuilderController {
  return new BuilderController({ initialRoot: formRoot() });
}

const phone: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "contactMethod" }, right: { kind: "literal", value: "phone" } };

/** Two journeys, unknown keys on the block, a journey and a page, and an unreadable journey kept as written. */
function seed(): JourneyConfiguration {
  return {
    "x-block": { owner: "intake" },
    journeys: [
      {
        id: "intake",
        name: "Step by step",
        "x-owner": "team",
        pages: [
          { id: "about", title: "About you", components: ["fullName", "contactMethod"], routes: [{ when: phone, to: "finish" }] },
          { id: "more", components: ["children"], "x-page": 1 },
          { id: "finish", components: ["consent", "submit"] }
        ]
      },
      { id: "quick", pages: [{ id: "all", components: ["fullName", "contactMethod", "children", "consent", "notes", "submit"] }] },
      { id: "broken" }
    ]
  } as unknown as JourneyConfiguration;
}

function context(): BuilderModeContext & { surfaces: Array<HTMLElement | undefined> } {
  const surfaces: Array<HTMLElement | undefined> = [];
  return {
    host: {} as HTMLElement,
    root: {} as ShadowRoot,
    showCanvasSurface: (surface) => {
      surfaces.push(surface);
    },
    surfaces
  };
}

interface Setup {
  form: BuilderController;
  mode: JourneyBuilderMode;
  changes: JourneyBuilderModeChangeDetail[];
  errors: string[];
}

async function activated(journey: unknown = seed()): Promise<Setup> {
  const form = formController();
  const changes: JourneyBuilderModeChangeDetail[] = [];
  const errors: string[] = [];
  const mode = createJourneyBuilderMode({
    form,
    journey,
    onChange: (detail) => changes.push(detail),
    onError: (message) => errors.push(message)
  });
  await mode.activate?.(context());
  return { form, mode, changes, errors };
}

function pages(controller: BuilderController): ComponentNode[] {
  return controller.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? [];
}

function rules(mode: JourneyBuilderMode): BuilderModeRules {
  return mode.inspector?.rules as BuilderModeRules;
}

describe("the Journeys mode's catalog", () => {
  it("lists the journeys, names its documents and says what its tree offers, before any designer loads", () => {
    const mode = createJourneyBuilderMode({ form: formController(), journey: seed() });
    expect(mode.id).toBe(JOURNEY_BUILDER_MODE);
    expect(mode.label).toBe("Journeys");
    expect(mode.documents?.noun).toBe("journey");
    // One kind on the + menu: "New journey…".
    expect(mode.documents?.addKinds).toEqual([{ id: "journey", noun: "journey" }]);
    // A one-page journey is a journey like any other: no badge, no word of its own.
    expect(mode.documents?.list()).toEqual([
      { id: "intake", label: "Step by step", isDefault: true },
      { id: "quick", label: "quick", isDefault: false }
    ]);
    expect(mode.documents?.selectedId()).toBe("intake");
    expect(mode.ready).toBe(false);
    expect(mode.variables).toBe("conditions");
    expect(mode.inspector?.settingsLabel).toBe("Journey");
    // No Rules tab on a route: its condition is edited in the Logic workspace's Go to rule (stage
    // D), stored in its configuration as ever; nor on a page (it has no condition of its own),
    // the root or a question.
    expect(rules(mode).descriptors(JOURNEY_ROUTE_TYPE)).toEqual([]);
    expect(rules(mode).descriptors(JOURNEY_PAGE_TYPE)).toEqual([]);
    expect(rules(mode).descriptors(JOURNEY_ROOT_TYPE)).toEqual([]);
    expect(rules(mode).descriptors(JOURNEY_FIELD_TYPE)).toEqual([]);
    expect((rules(mode).note as (nodeId: string) => string | undefined)("any")).toContain("row., ancestor. and host.");
    // A condition reads answers outside every repeating section: not the section, not its entries, not a button.
    expect(rules(mode).fieldOptions?.("any").map((choice) => choice.value)).toEqual(["fullName", "contactMethod", "consent", "notes"]);
    // Nothing is drawn without a DOM.
    expect(mode.barActions).toEqual([]);
    expect(mode.overlays).toEqual([]);
  });

  it("loads the designer on activation and builds the journey on the page, leaving the block as given", async () => {
    const block = seed();
    const { mode, changes } = await activated(block);
    expect(mode.ready).toBe(true);
    const controller = mode.controller;
    expect(controller.componentTypes().map((entry) => entry.label)).toEqual(["Step", "Form field", "Route", "Worked-out value"]);
    expect(pages(controller).map((page) => (page.configuration as { pageId: string }).pageId)).toEqual(["about", "more", "finish"]);
    expect(mode.styles).toContain(".jd-add");
    // Opening every journey reports nothing and leaves the block the object it was given.
    await mode.selectJourney("quick");
    expect(mode.ready).toBe(true);
    await mode.selectJourney("intake");
    expect(changes).toEqual([]);
    expect(mode.journeyConfiguration).toBe(block);
  });

  it("hands back a journey value that is not an object as given, until an edit replaces it with a block", async () => {
    for (const given of [null, [], "journeys"]) {
      const mode = createJourneyBuilderMode({ form: formController(), journey: given });
      // Read as no journeys, yet a definition written back carries the value it had.
      expect(mode.documents?.list()).toEqual([]);
      expect(mode.journeyConfiguration).toBe(given);
      mode.reseed({ journeys: [] });
      mode.reseed(given);
      expect(mode.journeyConfiguration).toBe(given);
    }
    const { mode, changes } = await activated([]);
    expect(mode.journeyConfiguration).toEqual([]);
    expect(changes).toEqual([]);
    await mode.newJourney({ from: "sections" });
    expect(mode.journeyConfiguration).toMatchObject({ journeys: [{ id: "journey-1" }], opensAs: "journey" });
  });

  it("names every nameless start a journey, and starts a one-page journey with its page heading hidden", async () => {
    const { mode } = await activated([]);
    const whole = await mode.newJourney({ from: "one-page" });
    // "journey" is what a host names the default journey by, so the id is numbered (RESERVED_JOURNEY_IDS).
    expect(whole).toMatchObject({ id: "journey-1", name: "Journey", heading: "hidden" });
    // The heading sits where the builder's tree writes it, so the journey reads back unchanged.
    expect(Object.keys(whole)).toEqual(["id", "name", "heading", "pages"]);
    const flat = await mode.newJourney({ from: "questions-one-page" });
    expect(flat).toMatchObject({ id: "journey-2", name: "Journey 2", heading: "hidden" });
    const paged = await mode.newJourney({ from: "questions" });
    expect(paged).toMatchObject({ id: "journey-3", name: "Journey 3" });
    expect(paged.heading).toBeUndefined();
    // No badge and no word of its own: every entry is a journey.
    expect(mode.documents?.list().map((entry) => [entry.id, entry.badge, entry.noun])).toEqual([
      ["journey-1", undefined, undefined],
      ["journey-2", undefined, undefined],
      ["journey-3", undefined, undefined]
    ]);
    expect(mode.documents?.addKinds).toEqual([{ id: "journey", noun: "journey" }]);
  });

  it("reports a committed edit, not a draft, and keeps every key it does not know", async () => {
    const { mode, changes } = await activated();
    const controller = mode.controller;
    const about = pages(controller)[0]!.id;
    controller.setDraftProperty(about, "title", "About");
    expect(changes).toEqual([]);
    expect(controller.commitDraft(about)).toBe(true);
    expect(changes.map((change) => change.reason)).toEqual(["edit"]);
    const configuration = mode.journeyConfiguration as Record<string, unknown> & JourneyConfiguration;
    expect(configuration["x-block"]).toEqual({ owner: "intake" });
    const intake = configuration.journeys?.[0] as unknown as Record<string, unknown> & { pages: Array<Record<string, unknown>> };
    expect(intake["x-owner"]).toBe("team");
    expect(intake.pages[0]?.title).toBe("About");
    expect(intake.pages[1]?.["x-page"]).toBe(1);
    // The unreadable journey is kept where it was.
    expect((configuration.journeys as unknown[])[2]).toEqual({ id: "broken" });
  });

  // The first journey made is what the form opens as.
  it("makes journeys from the form, the first one being what the form opens as", async () => {
    const { mode, changes } = await activated(null);
    // With no journey the panels see an empty journey, no palette and nothing to edit.
    expect(mode.controller.componentTypes()).toEqual([]);
    expect(mode.controller.snapshot().type).toBe(JOURNEY_ROOT_TYPE);
    expect(mode.controller.inspectorModel(JOURNEY_ROOT_ID)?.mode).toBe("none");
    expect(mode.formSettings?.rows()).toEqual([]);

    const first = await mode.newJourney({ from: "sections" });
    expect(first).toMatchObject({ id: "journey-1", name: "Journey" });
    // Written in the same change as the journey itself: one report, never a journey without the key.
    expect(mode.journeyConfiguration?.opensAs).toBe("journey");
    expect(mode.opensAs).toBe("journey");
    expect(changes).toHaveLength(1);
    expect(changes.at(-1)).toMatchObject({ reason: "journeys", select: "journey-1", configuration: { opensAs: "journey" } });
    expect(mode.documents?.list()).toEqual([{ id: "journey-1", label: "Journey", isDefault: true }]);
    // Every question of the form is on a page: nothing unassigned.
    expect(mode.ready).toBe(true);
    expect(mode.controller.componentTypes()).toHaveLength(4);

    const second = await mode.newJourney({ name: "All at once", from: "one-page" });
    expect(second.id).toBe("all-at-once");
    expect(second.pages).toHaveLength(1);
    // A one-page start looks like the form: its page is titled as the form, its heading hidden.
    expect(second.pages[0]?.title).toBe("Intake");
    expect(second.heading).toBe("hidden");
    // The second journey leaves it, and the first stays the one the form opens as.
    expect(mode.journeyConfiguration?.opensAs).toBe("journey");
    expect(mode.documents?.list().map((entry) => [entry.id, entry.isDefault])).toEqual([
      ["journey-1", true],
      ["all-at-once", false]
    ]);
    expect(mode.documents?.list().map((entry) => [entry.id, entry.badge])).toEqual([
      ["journey-1", undefined],
      ["all-at-once", undefined]
    ]);
    expect(mode.documents?.selectedId()).toBe("all-at-once");

    const copy = await mode.newJourney({ from: "copy" });
    expect(copy).toMatchObject({ id: "all-at-once-copy", name: "All at once (copy)", heading: "hidden" });

    // A blank name is "Journey n", and every question lands on the one page.
    const flat = await mode.newJourney({ from: "questions-one-page" });
    expect(flat).toMatchObject({ id: "journey-2", name: "Journey 2", heading: "hidden", pages: [{ id: "page-1", title: "Intake" }] });
    expect(flat.pages[0]?.components).toEqual(["fullName", "contactMethod", "children", "consent", "notes", "submit"]);
    expect(mode.documents?.list().at(-1)).toEqual({ id: "journey-2", label: "Journey 2", isDefault: false });
    expect((await mode.newJourney({ from: "questions" })).name).toBe("Journey 3");
  });

  it("renames by name alone, the name pushed into the open tree and reported once", async () => {
    const { mode, changes } = await activated();
    mode.documents?.rename?.("intake", "Intake flow");
    expect(changes.map((change) => change.reason)).toEqual(["journeys"]);
    expect(mode.documents?.list()[0]).toEqual({ id: "intake", label: "Intake flow", isDefault: true });
    expect((mode.controller.snapshot().configuration as { name?: unknown }).name).toBe("Intake flow");
  });

  it("renames the default name and leaves the name's translations in the map", async () => {
    const block = (): unknown => ({ journeys: [{ id: "k", name: "Kay", pages: [{ id: "p", components: ["fullName"] }] }] });
    const { form, mode } = await activated(block());
    form.replaceTranslations({ fr: { journeys: { k: { name: { text: "Ka", source: sourceHash("Kay") } } } } });
    mode.documents?.rename?.("k", "Kay 2");
    expect(mode.journeyConfiguration?.journeys?.[0]?.name).toBe("Kay 2");
    expect((mode.controller.snapshot().configuration as { name?: unknown }).name).toBe("Kay 2");
    // The map is untouched: the entry now answers a wording that changed, which the Languages workspace flags.
    expect(form.translations()?.fr?.journeys?.k).toEqual({ name: { text: "Ka", source: sourceHash("Kay") } });

    // In French the box shows the French name, but what is typed is the default: only it changes.
    form.setOptions({ locale: "fr" });
    expect(mode.documents?.list()[0]?.label).toBe("Ka");
    mode.renameJourney("k", "Kay 3");
    expect(mode.journeyConfiguration?.journeys?.[0]?.name).toBe("Kay 3");
    expect(form.translations()?.fr?.journeys?.k).toEqual({ name: { text: "Ka", source: sourceHash("Kay") } });

    // Cleared, the name goes and its translation stays; a plain name goes the same way.
    mode.renameJourney("k", "");
    expect(mode.journeyConfiguration?.journeys?.[0]).not.toHaveProperty("name");
    expect(form.translations()?.fr?.journeys?.k).toBeDefined();
  });

  it("brings a designer already built along when a host replaces or renames its journey off the page", async () => {
    const { mode, changes } = await activated();
    await mode.selectJourney("quick");
    await mode.selectJourney("intake");
    const quick = mode.journeys.find((entry) => entry.id === "quick")!;
    mode.replaceJourney("quick", {
      ...quick,
      pages: [
        { id: "all", components: ["fullName", "contactMethod", "children"] },
        { id: "rest", components: ["consent", "notes", "submit"] }
      ]
    });
    await mode.selectJourney("quick");
    expect(pages(mode.controller).map((page) => (page.configuration as { pageId: string }).pageId)).toEqual(["all", "rest"]);
    mode.controller.setProperty(pages(mode.controller)[0]!.id, "title", "Everything");
    expect(mode.journey?.pages.map((page) => [page.id, page.title])).toEqual([
      ["all", "Everything"],
      ["rest", undefined]
    ]);

    // A rename alone goes into the built tree, so its next edit keeps it; reported once.
    await mode.selectJourney("intake");
    changes.length = 0;
    mode.renameJourney("quick", "Quick one");
    expect(changes.map((change) => change.reason)).toEqual(["journeys"]);
    await mode.selectJourney("quick");
    expect((mode.controller.snapshot().configuration as { name?: unknown }).name).toBe("Quick one");
    mode.controller.setProperty(pages(mode.controller)[1]!.id, "title", "The rest");
    expect(mode.journey?.name).toBe("Quick one");

    // A catalog action that leaves a built journey as it was keeps its history.
    const history = mode.controller;
    expect(history.canUndo()).toBe(true);
    await mode.selectJourney("intake");
    mode.setDefaultJourney("intake");
    await mode.selectJourney("quick");
    expect(mode.controller).toBe(history);
    expect(mode.controller.canUndo()).toBe(true);
  });

  it("copies, makes the default and removes down to none", async () => {
    const { mode, changes } = await activated();
    mode.documents?.duplicate?.("intake");
    expect(mode.documents?.selectedId()).toBe("intake-copy");
    expect(mode.documents?.list().find((entry) => entry.id === "intake-copy")?.label).toBe("Step by step (copy)");
    mode.documents?.setDefault?.("intake-copy");
    expect(mode.documents?.list().filter((entry) => entry.isDefault).map((entry) => entry.id)).toEqual(["intake-copy"]);
    for (const id of ["intake", "quick", "intake-copy"]) {
      mode.documents?.remove?.(id);
    }
    expect(mode.documents?.list()).toEqual([]);
    // What is left is the block's other keys and the journey nothing could read; opensAs and the default go.
    expect(mode.journeyConfiguration).toEqual({ "x-block": { owner: "intake" }, journeys: [{ id: "broken" }] });
    expect(mode.controller.snapshot().type).toBe(JOURNEY_ROOT_TYPE);
    expect(changes.every((change) => change.reason === "journeys")).toBe(true);
    // A block left saying nothing is none at all.
    const empty = await activated({ journeys: [{ id: "only", pages: [] }] });
    empty.mode.removeJourney("only");
    expect(empty.mode.journeyConfiguration).toBeUndefined();
  });

  it("keeps the journey on the page, and its history, when another becomes the default", async () => {
    const { mode } = await activated();
    const controller = mode.controller;
    controller.setProperty(pages(controller)[0]!.id, "title", "About");
    mode.setDefaultJourney("quick");
    expect(mode.documents?.selectedId()).toBe("intake");
    expect(mode.controller).toBe(controller);
    expect(controller.canUndo()).toBe(true);
    expect(mode.journeyConfiguration?.defaultJourneyId).toBe("quick");
  });

  it("reports a catalog action it refuses rather than throwing into the shell", async () => {
    const { mode, errors } = await activated();
    mode.documents?.setDefault?.("nope");
    expect(errors).toEqual(["The journey could not be made the default"]);
  });
});

describe("the Form panel's Opens as row", () => {
  it("drafts on the form root and commits with the Form panel's Save", async () => {
    const { form, mode, changes } = await activated();
    const [row] = mode.formSettings?.rows() ?? [];
    expect(row).toMatchObject({ id: "journeys.opensAs", label: "Opens as", note: "Default: Step by step.", open: { document: "intake" } });
    // The whole form, then every journey by name.
    expect(row?.choices).toEqual([
      { value: "form", label: "The whole form" },
      { value: "intake", label: "Step by step" },
      { value: "quick", label: "quick" }
    ]);
    expect(row?.get()).toBe("intake");
    const heard = vi.fn();
    mode.formSettings?.subscribe(heard);

    form.setDraftRootSetting(row as BuilderRootSetting, "form");
    expect(form.hasPendingChanges(form.rootId())).toBe(true);
    expect(mode.journeyConfiguration?.opensAs).toBeUndefined();
    expect(form.commitDraft(form.rootId())).toBe(true);
    expect(mode.journeyConfiguration?.opensAs).toBe("form");
    expect(changes.at(-1)).toMatchObject({ reason: "journeys" });
    expect(changes.at(-1)?.journey).toBeUndefined();
    expect(heard).toHaveBeenCalled();

    // Back to the journey: the key goes, since the block given did not write it.
    mode.setOpensAs("journey");
    expect(mode.journeyConfiguration && "opensAs" in mode.journeyConfiguration).toBe(false);
    // A block that wrote it gets it back.
    const stated = await activated({ ...seed(), opensAs: "journey" });
    stated.mode.setOpensAs("form");
    stated.mode.setOpensAs("journey");
    expect(stated.mode.journeyConfiguration?.opensAs).toBe("journey");
  });

  it("makes the journey chosen the default at once, through the catalog, and drafts only what the form opens as", async () => {
    const { form, mode, changes } = await activated({ ...seed(), opensAs: "form" });
    const row = (): BuilderFormSettingRow => (mode.formSettings?.rows() ?? [])[0]!;
    expect(row().get()).toBe("form");
    // Picking the one-page journey: the default moves now (as the documents menu's Set as default does), reported as a catalog action…
    row().choose?.("quick");
    expect(mode.journeyConfiguration?.defaultJourneyId).toBe("quick");
    // Nothing is marked "Default" while the form opens whole: the mark follows the real value.
    expect(mode.documents?.list().map((entry) => [entry.id, entry.isDefault])).toEqual([
      ["intake", false],
      ["quick", false]
    ]);
    expect(changes.at(-1)).toMatchObject({ reason: "journeys", journey: { id: "quick" } });
    expect(mode.journeyConfiguration?.opensAs).toBe("form");
    expect(row().note).toBe("Default: quick.");
    // …and the choice itself waits for Save, like the rest of the form's settings.
    form.setDraftRootSetting(row() as BuilderRootSetting, "quick");
    expect(mode.opensAs).toBe("form");
    expect(form.commitDraft(form.rootId())).toBe(true);
    expect(mode.opensAs).toBe("journey");
    expect(row().get()).toBe("quick");
    // The whole form again: the default stays where it was put.
    row().choose?.("form");
    row().set("form");
    expect(mode.journeyConfiguration).toMatchObject({ defaultJourneyId: "quick", opensAs: "form" });
    // Save with a choice that never went through choose (a host's own panel) still settles the default.
    row().set("intake");
    expect(mode.journeyConfiguration?.defaultJourneyId).toBe("intake");
    expect(mode.opensAs).toBe("journey");
  });

  it("reads the default live, so choosing another journey while the form already opens as one leaves nothing pending", async () => {
    const { form, mode } = await activated();
    // No `opensAs` on the block: with journeys, the form opens as the default one.
    expect(mode.opensAs).toBe("journey");
    const row = (mode.formSettings?.rows() ?? [])[0]!;
    expect(row.get()).toBe("intake");
    // As the Form panel does it: `choose`, then the draft with the same row object.
    row.choose?.("quick");
    form.setDraftRootSetting(row as BuilderRootSetting, "quick");
    expect(mode.journeyConfiguration?.defaultJourneyId).toBe("quick");
    expect(row.get()).toBe("quick");
    expect(form.hasPendingChanges(form.rootId())).toBe(false);
    expect(form.hasPendingChanges()).toBe(false);
    // The whole form is a change to save.
    form.setDraftRootSetting(row as BuilderRootSetting, "form");
    expect(form.hasPendingChanges(form.rootId())).toBe(true);
  });
});

/**
 * What the form opens as, set where the journey is made: the catalog actions that
 * write it, the "Default" mark that follows it, and the select on the journey's face that
 * reads and writes the property the Form settings row does.
 */
describe("what the form opens as", () => {
  it("resets to the whole form, in the one change, when the journey the form opens as is removed", async () => {
    const { mode, changes } = await activated();
    // No key on the block: the form opens as its default journey, "intake".
    expect(mode.opensAs).toBe("journey");
    changes.length = 0;
    mode.documents?.remove?.("intake");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ reason: "journeys" });
    expect(mode.journeyConfiguration?.opensAs).toBe("form");
    expect(mode.opensAs).toBe("form");
    // Nothing is marked "Default" while the form opens whole.
    expect(mode.documents?.list().map((entry) => [entry.id, entry.isDefault])).toEqual([["quick", false]]);
    // Taking away a journey the form does not open as leaves the key alone.
    const other = await activated({ ...seed(), opensAs: "journey" });
    other.mode.documents?.remove?.("quick");
    expect(other.mode.journeyConfiguration?.opensAs).toBe("journey");
  });

  it("marks Default only the journey the form really opens as, and Set as default makes the form open as it", async () => {
    const { mode, changes } = await activated({ ...seed(), opensAs: "form" });
    expect(mode.documents?.list().map((entry) => [entry.id, entry.isDefault])).toEqual([
      ["intake", false],
      ["quick", false]
    ]);
    changes.length = 0;
    mode.documents?.setDefault?.("quick");
    // The default and the key move together, as one change.
    expect(changes).toHaveLength(1);
    expect(mode.journeyConfiguration).toMatchObject({ defaultJourneyId: "quick", opensAs: "journey" });
    expect(mode.documents?.list().map((entry) => [entry.id, entry.isDefault])).toEqual([
      ["intake", false],
      ["quick", true]
    ]);
    // Choosing what is already chosen writes and reports nothing.
    mode.chooseOpensAs("quick");
    expect(changes).toHaveLength(1);
  });

  it("chooses the whole form, or a journey, with the Form settings row agreeing at once", async () => {
    const { mode } = await activated();
    const row = (): BuilderFormSettingRow => (mode.formSettings?.rows() ?? [])[0]!;
    expect(row().get()).toBe("intake");
    mode.chooseOpensAs("form");
    expect(mode.journeyConfiguration?.opensAs).toBe("form");
    expect(mode.opensAs).toBe("form");
    expect(row().get()).toBe("form");
    mode.chooseOpensAs("quick");
    expect(mode.opensAs).toBe("journey");
    expect(mode.journeyConfiguration?.defaultJourneyId).toBe("quick");
    expect(row().get()).toBe("quick");
    expect(() => mode.chooseOpensAs("nope")).toThrow(/No journey/);
  });

  it("keeps a stored definition as it was: no key means a journey, and a stored whole form stays whole", async () => {
    const unset = await activated();
    expect("opensAs" in (unset.mode.journeyConfiguration ?? {})).toBe(false);
    expect(unset.mode.opensAs).toBe("journey");
    expect(unset.changes).toEqual([]);
    const whole = await activated({ ...seed(), opensAs: "form" });
    expect(whole.mode.opensAs).toBe("form");
    expect(whole.changes).toEqual([]);
    // Adding a second journey to a form stored as whole does not open it as a journey.
    await whole.mode.newJourney({ from: "sections" });
    expect(whole.mode.journeyConfiguration?.opensAs).toBe("form");
  });
});

describe("editing a journey", () => {
  it("asks a left-out field before the page's closing buttons, for Ask it here and Add unassigned alike", async () => {
    const { form, mode } = await activated({ journeys: [{ id: "v", pages: [{ id: "one", components: ["fullName", "contactMethod", "submit"] }] }] });
    form.setProperty("consent", "required", true);
    const controller = mode.controller;
    // Ask it here: before the form's Submit, never below it.
    expect(await mode.askUnassigned("consent")).toBe(true);
    expect(mode.journey?.pages[0]?.components).toEqual(["fullName", "contactMethod", "consent", "submit"]);
    controller.undo();
    // Add unassigned onto the selected page: the rest, in form order, before the button too.
    controller.select(pages(controller)[0]!.id);
    expect(await mode.addUnassigned()).toBe(true);
    expect(mode.journey?.pages[0]?.components).toEqual(["fullName", "contactMethod", "children", "consent", "notes", "submit"]);
  });

  it("puts what Add unassigned makes ahead of the page with the form's Submit, never after the Submit", async () => {
    const { form, mode } = await activated({
      journeys: [
        {
          id: "j",
          pages: [
            { id: "about", components: ["fullName"] },
            { id: "send", components: ["submit", "consent"] },
            { id: "thanks", kind: "exit", components: [] }
          ]
        }
      ]
    });
    form.setProperty("submit", "action", "submit");
    const controller = mode.controller;
    // Nothing selected: a page of their own, before the page with the Submit, not at the end.
    expect(await mode.addUnassigned()).toBe(true);
    expect(mode.journey?.pages.map((page) => [page.id, page.components])).toEqual([
      ["about", ["fullName"]],
      ["step-4", ["contactMethod", "children", "notes"]],
      ["send", ["submit", "consent"]],
      ["thanks", undefined]
    ]);
    controller.undo();
    // Onto the page with the Submit when it is selected: before the Submit, wherever it sits there.
    controller.select(pages(controller)[1]!.id);
    expect(await mode.addUnassigned()).toBe(true);
    expect(mode.journey?.pages[1]?.components).toEqual(["contactMethod", "children", "notes", "submit", "consent"]);
    controller.undo();

    // When the Submit is on the first page, onto it, before the Submit: the journey still starts there.
    const first = await activated({ journeys: [{ id: "j", pages: [{ id: "only", components: ["fullName", "submit"] }, { id: "more", components: ["consent"] }] }] });
    first.form.setProperty("submit", "action", "submit");
    expect(await first.mode.addUnassigned()).toBe(true);
    expect(first.mode.journey?.pages.map((page) => page.components)).toEqual([["fullName", "contactMethod", "children", "notes", "submit"], ["consent"]]);
  });

  it("adds what a one-page journey leaves out onto its one page with nothing selected, before its closing buttons, never as a new page", async () => {
    const { mode } = await activated({ journeys: [{ id: "v", pages: [{ id: "one", components: ["fullName", "contactMethod", "submit"] }] }] });
    const controller = mode.controller;
    // The state right after opening it: nothing selected.
    expect(controller.selectedComponentId()).toBeUndefined();
    expect(await mode.addUnassigned()).toBe(true);
    // Still one page — it stays one page unless the author adds a page — the form's Submit last.
    expect(pages(controller)).toHaveLength(1);
    expect(mode.journey?.pages).toHaveLength(1);
    expect(mode.journey?.pages[0]?.components).toEqual(["fullName", "contactMethod", "children", "consent", "notes", "submit"]);
    // One undo; and the journey's root selected is no page either.
    controller.undo();
    expect(mode.journey?.pages[0]?.components).toEqual(["fullName", "contactMethod", "submit"]);
    controller.select(JOURNEY_ROOT_ID);
    expect(await mode.addUnassigned()).toBe(true);
    expect(mode.journey?.pages.map((page) => page.components)).toEqual([["fullName", "contactMethod", "children", "consent", "notes", "submit"]]);
    controller.undo();

    // Once the author routes from it — a route on its page, its target not chosen yet —
    // nothing selected means a new page again, as for any journey.
    controller.add(JOURNEY_ROUTE_TYPE, pages(controller)[0]!.id, JOURNEY_ROUTES_SLOT);
    controller.select(undefined);
    expect(await mode.addUnassigned()).toBe(true);
    expect(pages(controller)).toHaveLength(2);
    expect(mode.journey?.pages.map((page) => page.components)).toEqual([["fullName", "contactMethod", "submit"], ["children", "consent", "notes"]]);
  });

  it("names a one-page journey alike before and after a route is added to its page", async () => {
    const { mode, changes } = await activated({ journeys: [{ id: "v", name: "Short", pages: [{ id: "one", components: ["fullName", "contactMethod", "submit"] }] }] });
    const controller = mode.controller;
    const named = (): string | undefined => (mode.formSettings?.rows() ?? [])[0]?.choices?.find((choice) => choice.value === "v")?.label;
    expect(mode.documents?.list()).toEqual([{ id: "v", label: "Short", isDefault: true }]);
    expect(named()).toBe("Short");
    // A route with no target is not written: the journey, and what a host hears, stay as they were, and so do its words.
    const before = changes.length;
    controller.add(JOURNEY_ROUTE_TYPE, pages(controller)[0]!.id, JOURNEY_ROUTES_SLOT);
    expect(mode.journey?.pages[0]?.routes).toBeUndefined();
    expect(changes).toHaveLength(before);
    expect(mode.documents?.list()).toEqual([{ id: "v", label: "Short", isDefault: true }]);
    expect(named()).toBe("Short");
  });

  it("adds what the journey asks on no page as one undo: onto the selected page, else a new page", async () => {
    const { mode } = await activated();
    const controller = mode.controller;
    const [about] = pages(controller);
    controller.select(about!.id);
    expect(await mode.addUnassigned()).toBe(true);
    const listed = (about: ComponentNode | undefined): unknown[] =>
      (about?.children?.[JOURNEY_CONTENT_SLOT] ?? []).map((question) => (question.configuration as { componentId: string }).componentId);
    expect(listed(pages(controller)[0])).toEqual(["fullName", "contactMethod", "notes"]);
    expect(mode.journey?.pages[0]?.components).toEqual(["fullName", "contactMethod", "notes"]);
    controller.undo();
    expect(listed(pages(controller)[0])).toEqual(["fullName", "contactMethod"]);

    controller.select(undefined);
    expect(await mode.addUnassigned()).toBe(true);
    const added = pages(controller).at(-1);
    // Named as a blank journey's step is: step-n, titled "Step n".
    expect(added?.configuration).toEqual({ pageId: "step-4", title: "Step 4" });
    expect(listed(added)).toEqual(["notes"]);
    // Nothing left to add.
    expect(await mode.addUnassigned()).toBe(false);
  });

  it("asks a required field left out on the last page that is not an exit step, in one undo", async () => {
    const { form, mode } = await activated({
      journeys: [
        {
          id: "j",
          pages: [
            { id: "about", components: ["fullName", "contactMethod"] },
            { id: "more", components: ["children"] },
            { id: "bye", kind: "exit", components: ["submit"] }
          ]
        }
      ]
    });
    form.setProperty("consent", "required", true);
    const controller = mode.controller;
    // Nothing selected, and the selection would not matter: the last questions page takes it.
    controller.select(pages(controller)[0]!.id);
    expect(await mode.askUnassigned("consent")).toBe(true);
    expect(mode.journey?.pages.map((page) => page.components)).toEqual([["fullName", "contactMethod"], ["children", "consent"], ["submit"]]);
    controller.undo();
    expect(mode.journey?.pages[1]?.components).toEqual(["children"]);
    // A blank id, or a page with nothing built, adds nothing.
    expect(await mode.askUnassigned("")).toBe(false);
  });

  it("opens the form field for Make it optional on the form: selected on the form, the Form tab asked for", async () => {
    const form = formController();
    const heard: unknown[] = [];
    const root = new EventTarget();
    root.addEventListener("builder-open-mode", (event) => heard.push((event as CustomEvent).detail));
    const mode = createJourneyBuilderMode({ form, journey: seed() });
    await mode.activate?.({ ...context(), root: root as unknown as ShadowRoot });
    mode.openFormComponent("consent");
    expect(form.selectedComponentId()).toBe("consent");
    expect(heard).toEqual([{ mode: "form" }]);
    // Nothing on the form was edited for the author.
    expect(form.getProperty("consent", "required")).toBeUndefined();
  });

  it("never adds what is unassigned to a selected exit page, which sends nothing", async () => {
    const { mode } = await activated({
      journeys: [
        {
          id: "j",
          pages: [
            { id: "about", components: ["fullName", "contactMethod", "children", "consent"] },
            { id: "bye", kind: "exit", components: ["submit"] }
          ]
        }
      ]
    });
    const controller = mode.controller;
    const exit = pages(controller)[1]!;
    controller.select(exit.id);
    expect(await mode.addUnassigned()).toBe(true);
    expect(mode.journey?.pages.map((page) => [page.id, page.components])).toEqual([
      ["about", ["fullName", "contactMethod", "children", "consent"]],
      ["bye", ["submit"]],
      ["step-3", ["notes"]]
    ]);
  });

  it("never adds what is unassigned to a selected Check answers page, which places no form field", async () => {
    const { mode } = await activated({
      journeys: [
        {
          id: "j",
          pages: [
            { id: "about", components: ["fullName", "contactMethod", "children", "consent"] },
            { id: "check", kind: "review", components: [] }
          ]
        }
      ]
    });
    const controller = mode.controller;
    controller.select(pages(controller)[1]!.id);
    expect(await mode.addUnassigned()).toBe(true);
    const written = mode.journey?.pages.map((page) => [page.id, page.components ?? []]);
    expect(written?.find(([id]) => id === "check")?.[1]).toEqual([]);
    // The unassigned field went to a page of its own, not onto the review page.
    expect(written?.some(([id, components]) => id !== "check" && (components as string[]).includes("notes"))).toBe(true);
  });

  it("never gives a new page the node id or page id of a deleted one a route still names", async () => {
    const { mode, errors } = await activated({
      journeys: [
        {
          id: "j",
          pages: [
            { id: "first", components: ["fullName"], routes: [{ to: "details" }] },
            { id: "details", components: ["contactMethod"] },
            { id: "last", components: ["consent"] }
          ]
        }
      ]
    });
    const controller = mode.controller;
    const details = pages(controller)[1]!.id;
    controller.remove(details);
    expect(mode.journey?.pages[0]?.routes).toEqual([{ to: "details" }]);
    controller.add(JOURNEY_PAGE_TYPE, JOURNEY_ROOT_ID, JOURNEY_PAGES_SLOT);
    const added = pages(controller).at(-1)!;
    expect(added.id).not.toBe(details);
    // The route still goes to the page it named, which the journey lacks: not to the new page.
    expect(mode.journey?.pages[0]?.routes).toEqual([{ to: "details" }]);
    controller.undo();
    expect(mode.journey?.pages[0]?.routes).toEqual([{ to: "details" }]);
    expect(errors).toEqual([]);

    // "Add unassigned" makes its page under an id no route to a deleted page names either.
    const numbered = await activated({
      journeys: [
        {
          id: "n",
          pages: [
            { id: "step-1", components: ["fullName"], routes: [{ to: "step-3" }] },
            { id: "step-2", components: ["contactMethod"] },
            { id: "step-3", components: ["consent"] }
          ]
        }
      ]
    });
    const third = pages(numbered.mode.controller)[2]!.id;
    numbered.mode.controller.remove(third);
    numbered.mode.controller.select(undefined);
    expect(await numbered.mode.addUnassigned()).toBe(true);
    const made = pages(numbered.mode.controller).at(-1)!;
    expect(made.id).not.toBe(third);
    expect((made.configuration as { pageId: string }).pageId).not.toBe("step-3");
    expect((made.configuration as { pageId: string }).pageId).toMatch(/^step-\d+$/);
    expect(numbered.mode.journey?.pages[0]?.routes).toEqual([{ to: "step-3" }]);
  });

  it("refuses a page id clash on the unsaved-changes prompt's Save, and never for a finding", async () => {
    const { mode, changes } = await activated();
    const controller = mode.controller;
    const [about, more] = pages(controller);
    controller.select(more!.id);
    controller.setDraftProperty(more!.id, "pageId", "about");
    controller.requestSelect(about!.id);
    expect(controller.unsavedChangesPrompt()).toMatchObject({ componentId: more!.id });
    controller.answerUnsavedChangesPrompt("save");
    expect((pages(controller)[1]!.configuration as { pageId: string }).pageId).toBe("more");
    expect(changes).toEqual([]);
    // Findings never hold a Save back: notes is on no page of this journey, and a title saves.
    controller.discardDraft(more!.id);
    controller.setDraftProperty(more!.id, "title", "More");
    expect(controller.commitDraft(more!.id)).toBe(true);
  });

  it("refuses to keep a transient repeated page id through the catalog: reported once, nothing thrown, the last writable journey stays", async () => {
    const { mode, changes, errors } = await activated();
    const controller = mode.controller;
    const more = pages(controller)[1]!;
    const before = JSON.stringify(mode.journey);
    expect(() => controller.setProperty(more.id, "pageId", "about")).not.toThrow();
    expect(JSON.stringify(mode.journey)).toBe(before);
    expect(changes).toEqual([]);
    expect(errors.filter((message) => message.includes("cannot be saved as it stands"))).toHaveLength(1);
    expect(errors.some((message) => message.includes("could not be kept"))).toBe(false);
    // A title edit while the repeat stands says the same reason once more only if it differs.
    controller.setProperty(more.id, "pageId", "more");
    expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "more", "finish"]);
  });

  it("keeps a route to a deleted page as the unknown target it becomes, and undo brings both back", async () => {
    const { mode } = await activated();
    const controller = mode.controller;
    const finish = pages(controller)[2]!;
    controller.remove(finish.id);
    expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "more"]);
    expect(mode.journey?.pages[0]?.routes).toEqual([{ when: phone, to: "finish" }]);
    controller.undo();
    expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "more", "finish"]);
    const route = pages(controller)[0]!.children?.[JOURNEY_ROUTES_SLOT]?.[0];
    expect((route?.configuration as { to: string }).to).toBe(finish.id);
  });

  it("repaints on a form edit and never rebuilds, so the journey's history survives", async () => {
    const { form, mode } = await activated();
    const controller = mode.controller;
    controller.setProperty(pages(controller)[0]!.id, "title", "About");
    const repaint = vi.spyOn(controller, "repaintPreview");
    form.setProperty("fullName", "label", "Your name");
    expect(repaint).toHaveBeenCalled();
    expect(mode.controller).toBe(controller);
    expect(controller.canUndo()).toBe(true);
    expect(rules(mode).fieldOptions?.("any")[0]).toEqual({ value: "fullName", label: "Your name (text)" });
  });

  it("follows a form rename into every journey, the open one in place", async () => {
    const { form, mode, changes } = await activated();
    const controller = mode.controller;
    controller.setProperty(pages(controller)[0]!.id, "title", "About");
    form.renameId("contactMethod", "howToReach");
    expect(changes.at(-1)?.reason).toBe("form-rename");
    const journeys = mode.journeyConfiguration?.journeys ?? [];
    expect(journeys[0]?.pages[0]?.components).toEqual(["fullName", "howToReach"]);
    expect(journeys[0]?.pages[0]?.routes?.[0]?.when).toEqual({ ...phone, left: { kind: "path", path: "howToReach" } });
    expect(journeys[1]?.pages[0]?.components?.[1]).toBe("howToReach");
    // The open tree was rewritten, not rebuilt: its history is there.
    const question = (): unknown => (pages(controller)[0]!.children?.[JOURNEY_CONTENT_SLOT]?.[1]?.configuration as { componentId: string }).componentId;
    const routeWhen = (): unknown => (pages(controller)[0]!.children?.[JOURNEY_ROUTES_SLOT]?.[0]?.configuration as { when: Expression }).when;
    expect(question()).toBe("howToReach");
    expect(mode.controller).toBe(controller);
    // The follow-up is no entry of the tree's: the title is still its last edit.
    const titled = controller.undoMark();
    expect(titled).toBeDefined();

    // The form's rename is the step: its Undo takes the follow-up back whole, never half renamed.
    form.undo();
    expect(question()).toBe("contactMethod");
    expect(routeWhen()).toEqual(phone);
    expect(mode.journey?.pages[0]?.components).toEqual(["fullName", "contactMethod"]);
    expect(mode.journey?.pages[0]?.title).toBe("About");
    form.redo();
    expect(question()).toBe("howToReach");
    expect(routeWhen()).toEqual({ ...phone, left: { kind: "path", path: "howToReach" } });
    expect(controller.undoMark()).toBe(titled);
    // The tree's own Undo takes back its own edit, the title, and leaves the id as the form has it.
    controller.undo();
    expect(mode.journey?.pages[0]?.title).toBe("About you");
    expect(question()).toBe("howToReach");
    expect(controller.canUndo()).toBe(false);
  });

  it("gives the journey the form's locale when it is activated again", async () => {
    const { form, mode } = await activated();
    mode.deactivate?.();
    form.setOptions({ locale: "fr-CA" });
    await mode.activate?.(context());
    expect(mode.controller.currentLocale()).toBe("fr-CA");
  });

  it("reseeds from another definition's block, every designer starting over", async () => {
    const { mode, changes } = await activated();
    const before = mode.controller;
    const other = { journeys: [{ id: "solo", pages: [{ id: "p", components: ["fullName"] }] }] };
    mode.reseed(other);
    expect(mode.documents?.list().map((entry) => entry.id)).toEqual(["solo"]);
    expect(mode.controller).not.toBe(before);
    expect(mode.ready).toBe(true);
    expect(mode.journeyConfiguration).toBe(other);
    expect(changes).toEqual([]);
  });
});

describe("the journeys' texts for the Languages workspace", () => {
  it("lists every journey's texts before any designer loads, each with its default and the address its translations live at", () => {
    const mode = createJourneyBuilderMode({ form: formController(), journey: seed() });
    const texts = mode.translatableTexts();
    // Two listed journeys (the unreadable one is not): seven texts each, and five a page.
    expect(texts).toHaveLength(7 + 3 * 5 + 7 + 5);
    expect(texts[0]).toEqual({
      componentId: "journey.intake",
      componentLabel: "Journey “Step by step”",
      propertyPath: "name",
      label: "Journey name",
      section: "Journey",
      default: "Step by step",
      address: { kind: "journeys", owner: "intake", path: ["name"] }
    });
    const title = texts.find((text) => text.componentId === "journey.intake.about" && text.propertyPath === "title");
    expect(title).toMatchObject({
      componentLabel: "Step by step · Step 1 · About you",
      default: "About you",
      section: "Step",
      address: { kind: "journeys", owner: "intake", path: ["pages", "about", "title"] }
    });
    // A page with no title goes by its id; a journey with no name by its id.
    expect(texts.find((text) => text.componentId === "journey.intake.more")?.componentLabel).toBe("Step by step · Step 2 · more");
    expect(texts.find((text) => text.componentId === "journey.quick")?.componentLabel).toBe("Journey “quick”");
    // No two rows share an address.
    expect(new Set(texts.map((text) => JSON.stringify(text.address))).size).toBe(texts.length);
  });

  it("names a journey and a page by their translations in the builder's locale", async () => {
    const form = formController();
    form.replaceTranslations({
      fr: {
        journeys: {
          intake: { name: { text: "Pas à pas", source: sourceHash("Step by step") }, pages: { about: { title: { text: "À propos de vous", source: sourceHash("About you") } } } }
        }
      }
    });
    form.setOptions({ locale: "fr" });
    const mode = createJourneyBuilderMode({ form, journey: seed() });
    expect(mode.documents?.list()[0]?.label).toBe("Pas à pas");
    const texts = mode.translatableTexts();
    expect(texts[0]?.componentLabel).toBe("Journey “Pas à pas”");
    expect(texts.find((text) => text.componentId === "journey.intake.about" && text.propertyPath === "title")).toMatchObject({
      componentLabel: "Pas à pas · Step 1 · À propos de vous",
      default: "About you"
    });
  });

  it("names each text the way the journey's own designer does, and follows a committed edit", async () => {
    const { mode } = await activated();
    const controller = mode.controller;
    const shape = (text: { propertyPath: string; label: string; section?: string; default: string }) => ({
      propertyPath: text.propertyPath,
      label: text.label,
      section: text.section,
      default: text.default
    });
    // The journey's and the pages' wording (`texts.*`) is translatable like any other text
    // and sits in the same list, once each. A page's wording is the designer's controller's too,
    // so those rows are compared with it, address included; the journey's own six (`back`,
    // `continue`, `submit`, `pageOf`, `checking`, `serverUnavailable`) are the Languages
    // workspace's alone, since the journey's panel has no box for them.
    const ours = mode.translatableTexts().filter((text) => text.componentId === "journey.intake" || text.componentId.startsWith("journey.intake."));
    const journeyWording = ours.filter((text) => text.componentId === "journey.intake" && text.propertyPath.startsWith("texts."));
    expect(journeyWording.map((text) => text.propertyPath)).toEqual(["texts.back", "texts.continue", "texts.submit", "texts.pageOf", "texts.checking", "texts.serverUnavailable"]);
    expect(journeyWording.map((text) => text.address)).toEqual(
      ["back", "continue", "submit", "pageOf", "checking", "serverUnavailable"].map((key) => ({ kind: "journeys", owner: "intake", path: ["texts", key] }))
    );
    const own = ours.filter((text) => !journeyWording.includes(text));
    expect(own.map(shape)).toEqual(controller.translatableTexts().map(shape));
    // The designer's controller addresses a text inside its own tree; the mode's rows carry the
    // address the map keys them by (`journeys › intake › pages › about › texts › continue`).
    expect(own.find((text) => text.propertyPath === "texts.continue" && text.componentId === "journey.intake.about")?.address).toEqual({
      kind: "journeys",
      owner: "intake",
      path: ["pages", "about", "texts", "continue"]
    });
    const keys = ours.map((text) => JSON.stringify(text.address));
    expect(new Set(keys).size).toBe(keys.length);

    controller.setProperty(pages(controller)[1]!.id, "title", "More");
    const more = mode.translatableTexts().find((text) => text.componentId === "journey.intake.more" && text.propertyPath === "title");
    expect(more).toMatchObject({ default: "More", componentLabel: "Step by step · Step 2 · More" });
  });

  it("lends the form's history a document: the texts it holds, and a writer for new defaults", async () => {
    const { mode } = await activated();
    const document = mode.localeDocument();
    expect(document.id).toBe("journeys");
    const texts = document.texts();
    expect(texts).toContainEqual({ address: { kind: "journeys", owner: "intake", path: ["pages", "about", "title"] }, default: "About you" });
    const next = document.setDefaults(document.read(), [
      { address: { kind: "journeys", owner: "intake", path: ["pages", "about", "title"] }, default: "À propos de vous" },
      { address: { kind: "journeys", owner: "intake", path: ["name"] }, default: "Pas à pas" }
    ]) as JourneyConfiguration;
    expect(next.journeys?.[0]?.name).toBe("Pas à pas");
    expect(next.journeys?.[0]?.pages[0]?.title).toBe("À propos de vous");
    // The block read is untouched, and a text that is gone lands nowhere.
    expect(mode.journeyConfiguration?.journeys?.[0]?.name).toBe("Step by step");
    const same = document.read();
    expect(document.setDefaults(same, [{ address: { kind: "journeys", owner: "gone", path: ["name"] }, default: "x" }])).toBe(same);
    document.write(next);
    expect(mode.journey?.name).toBe("Pas à pas");
  });
});

describe("Remove missing", () => {
  it("takes the questions whose component the form no longer has off the journey, in one undo", async () => {
    const { form, mode, changes } = await activated();
    const controller = mode.controller;
    // Nothing is missing yet.
    expect(await mode.removeMissing()).toBe(false);
    form.remove("consent");
    changes.length = 0;
    expect(await mode.removeMissing()).toBe(true);
    expect(mode.journey?.pages[2]?.components).toEqual(["submit"]);
    expect(changes.map((change) => change.reason)).toEqual(["remove"]);
    controller.undo();
    expect(mode.journey?.pages[2]?.components).toEqual(["consent", "submit"]);
    controller.redo();
    expect(await mode.removeMissing()).toBe(false);
  });

  it("waits for the unsaved-changes prompt, and removes what is missing once it is answered", async () => {
    const { mode } = await activated();
    const controller = mode.controller;
    const question = pages(controller)[0]!.children?.[JOURNEY_CONTENT_SLOT]?.[0] as ComponentNode;
    controller.select(question.id);
    controller.setDraftProperty(question.id, "componentId", "ghost");
    expect(await mode.removeMissing()).toBe(false);
    expect(controller.unsavedChangesPrompt()).toMatchObject({ componentId: question.id, action: "remove" });
    controller.answerUnsavedChangesPrompt("save");
    expect(mode.journey?.pages[0]?.components).toEqual(["contactMethod"]);
  });
});

describe("the designer's chunk", () => {
  afterEach(() => {
    vi.doUnmock(DESIGNER_MODULE);
    vi.resetModules();
  });

  it("is one load per page", async () => {
    expect(loadJourneyDesigner()).toBe(loadJourneyDesigner());
    expect(typeof (await loadJourneyDesigner()).createJourneyDesigner).toBe("function");
  });

  it("reports a failed load, refuses the activation, and loads on the next try", async () => {
    vi.resetModules();
    vi.doMock(DESIGNER_MODULE, () => {
      throw new Error("chunk missing");
    });
    const fresh = await import("../form-engine/builder/journey-designer/journey-builder-mode.js");
    const errors: string[] = [];
    const mode = fresh.createJourneyBuilderMode({ form: formController(), journey: seed(), onError: (message) => errors.push(message) });
    await expect(mode.activate?.(context())).rejects.toThrow();
    expect(errors).toEqual(["The Journeys designer could not load"]);
    // The dropdown still lists the journeys.
    expect(mode.documents?.list()).toHaveLength(2);

    vi.doUnmock(DESIGNER_MODULE);
    await mode.activate?.(context());
    expect(mode.ready).toBe(true);
  });
});

describe("the page-only fields' chunk", () => {
  const AUTHORING_MODULE = "../form-engine/builder/journey-designer/journey-authoring.js";

  afterEach(() => {
    vi.doUnmock(AUTHORING_MODULE);
    vi.resetModules();
  });

  /** A mode over a form that defines `text`, its page-only fields' chunk failing to load once. */
  async function failingOnce(): Promise<{ mode: JourneyBuilderMode; errors: string[] }> {
    vi.resetModules();
    vi.doMock(AUTHORING_MODULE, () => {
      throw new Error("chunk missing");
    });
    const fresh = await import("../form-engine/builder/journey-designer/journey-builder-mode.js");
    const text = { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: [] };
    const form = new BuilderController({ initialRoot: formRoot(), componentTypes: [{ type: "text", label: "Text" }], componentDefinitions: [text] });
    const errors: string[] = [];
    const mode = fresh.createJourneyBuilderMode({
      form,
      journey: { journeys: [{ id: "a", pages: [{ id: "one", components: ["fullName"] }] }, { id: "b", pages: [{ id: "two", components: ["notes"] }] }] },
      formDefinitions: () => [text],
      onError: (message) => errors.push(message)
    });
    await mode.activate?.(context());
    expect(errors).toEqual(["The page-only fields could not load"]);
    // The journey opens all the same, with no page-only field to offer.
    expect(mode.ready).toBe(true);
    expect(mode.controller.componentTypes().map((entry) => entry.type)).not.toContain("text");
    vi.doUnmock(AUTHORING_MODULE);
    return { mode, errors };
  }

  it("is tried again on the next activation after a failed load: the journeys built then offer the page-only fields", async () => {
    const { mode, errors } = await failingOnce();
    mode.deactivate?.();
    await mode.activate?.(context());
    await mode.selectJourney("b");
    expect(mode.controller.componentTypes().map((entry) => entry.type)).toContain("text");
    expect(errors).toEqual(["The page-only fields could not load"]);
  });

  it("is tried again when another journey is opened, which is built once it is in", async () => {
    const { mode, errors } = await failingOnce();
    await mode.selectJourney("b");
    expect(mode.ready).toBe(true);
    expect(mode.controller.componentTypes().map((entry) => entry.type)).toContain("text");
    expect(errors).toEqual(["The page-only fields could not load"]);
  });
});

describe("the Map view", () => {
  it("opens on the map, keeps Step as the one other view, and reads anything else, the retired \"preview\" and \"pages\" too, as the map", async () => {
    const { mode } = await activated();
    expect(mode.view).toBe("map");
    mode.view = "step";
    expect(mode.view).toBe("step");
    mode.view = "pages" as unknown as JourneyModeView;
    expect(mode.view).toBe("map");
    mode.view = "preview" as unknown as JourneyModeView;
    expect(mode.view).toBe("map");
    mode.view = "cards" as unknown as JourneyModeView;
    expect(mode.view).toBe("map");
  });

  it("puts the map back while the form has no journey", async () => {
    const { mode } = await activated({ journeys: [] });
    mode.view = "step";
    expect(mode.view).toBe("map");
  });

  it("normalises the map's layout, keeps what a partial assignment leaves out, and hands out a copy", async () => {
    const { mode, changes } = await activated();
    expect(mode.mapLayout).toEqual({ direction: "down" });
    mode.mapLayout = { direction: "right" } as JourneyMapLayout;
    expect(mode.mapLayout).toEqual({ direction: "right" });
    // An arrangement is no longer the map's: it is dropped, and the direction kept.
    mode.mapLayout = { arrange: "list" } as unknown as JourneyMapLayout;
    expect(mode.mapLayout).toEqual({ direction: "right" });
    mode.mapLayout = { direction: "up" } as unknown as JourneyMapLayout;
    expect(mode.mapLayout).toEqual({ direction: "down" });
    mode.mapLayout = { direction: "right" };
    const copy = mode.mapLayout;
    copy.direction = "down";
    expect(mode.mapLayout.direction).toBe("right");
    // A viewer's preference, never the definition's: nothing is reported.
    expect(changes).toEqual([]);
  });

  it("remembers the layout per viewer under the shell's persist-panels key, and nowhere without one", async () => {
    const form = formController();
    const host = { persistPanels: "mode-map-1" } as unknown as HTMLElement;
    const first = createJourneyBuilderMode({ form, journey: seed() });
    await first.activate?.({ ...context(), host });
    first.mapLayout = { direction: "right" };

    const again = createJourneyBuilderMode({ form, journey: seed() });
    expect(again.mapLayout).toEqual({ direction: "down" });
    await again.activate?.({ ...context(), host });
    expect(again.mapLayout).toEqual({ direction: "right" });

    const otherKey = createJourneyBuilderMode({ form, journey: seed() });
    await otherKey.activate?.({ ...context(), host: { persistPanels: "mode-map-2" } as unknown as HTMLElement });
    expect(otherKey.mapLayout).toEqual({ direction: "down" });

    const unkeyed = createJourneyBuilderMode({ form, journey: seed() });
    await unkeyed.activate?.(context());
    unkeyed.mapLayout = { direction: "right" };
    const fresh = createJourneyBuilderMode({ form, journey: seed() });
    await fresh.activate?.(context());
    expect(fresh.mapLayout).toEqual({ direction: "down" });
  });

  it("writes the layout under the key the host gives now: nowhere once it drops persist-panels, under the new key once it changes it", async () => {
    const host: { persistPanels?: string } = { persistPanels: "mode-map-drop" };
    const mode = createJourneyBuilderMode({ form: formController(), journey: seed() });
    await mode.activate?.({ ...context(), host: host as unknown as HTMLElement });
    mode.mapLayout = { direction: "right" };
    expect(readJourneyMapLayout("mode-map-drop")).toEqual({ direction: "right" });

    // No key, nothing remembered: the old key keeps what it had.
    delete host.persistPanels;
    mode.mapLayout = { direction: "down" };
    expect(readJourneyMapLayout("mode-map-drop")).toEqual({ direction: "right" });

    host.persistPanels = "mode-map-moved";
    mode.mapLayout = { direction: "right" };
    expect(readJourneyMapLayout("mode-map-moved")).toEqual({ direction: "right" });
    expect(readJourneyMapLayout("mode-map-drop")).toEqual({ direction: "right" });
  });
});

describe("the flow map's chunk", () => {
  afterEach(() => {
    vi.doUnmock(MAP_MODULE);
    vi.resetModules();
  });

  it("is one load per page, loaded by the designer's chunk", async () => {
    const designer = await loadJourneyDesigner();
    expect(designer.loadJourneyMap()).toBe(designer.loadJourneyMap());
    expect(typeof (await designer.loadJourneyMap()).createJourneyMap).toBe("function");
  });

  it("is loaded again after a failed load, never remembered broken", async () => {
    vi.resetModules();
    vi.doMock(MAP_MODULE, () => {
      throw new Error("chunk missing");
    });
    const fresh = await import("../form-engine/builder/journey-designer/journey-designer.js");
    await expect(fresh.loadJourneyMap()).rejects.toThrow();
    vi.doUnmock(MAP_MODULE);
    expect(typeof (await fresh.loadJourneyMap()).createJourneyMap).toBe("function");
  });
});

/** A canvas panel as Try it reaches it: trying, its store's answers, its redraws counted. */
function tryCanvas(values: Record<string, unknown> = {}, typed?: string[]) {
  // Every value typed unless `typed` says which: the store's dirty set.
  const store = { state: () => ({ values, dirty: new Set(typed ?? Object.keys(values)) }) };
  const canvas = {
    previewing: true,
    refreshed: 0,
    tryRefresh() {
      canvas.refreshed += 1;
    },
    previewRuntime: () => store
  };
  const root = {
    querySelector: (selector: string) => (selector === "datum-builder-canvas" ? canvas : null),
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  } as unknown as ShadowRoot;
  return { canvas, context: { ...context(), root } };
}

/** The pre-warm's idle turn, then the chunk's load, then the mode's handler of it. */
async function warmed(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await (await loadJourneyDesigner()).loadJourneyPreview();
  await Promise.resolve();
}

describe("the try session's chunk", () => {
  afterEach(() => {
    vi.doUnmock(PREVIEW_MODULE);
    vi.resetModules();
  });

  it("is one load per page, loaded by the designer's chunk, which imports none of its values", async () => {
    const designer = await loadJourneyDesigner();
    expect(designer.loadJourneyPreview()).toBe(designer.loadJourneyPreview());
    expect(typeof (await designer.loadJourneyPreview()).createJourneyPreviewSession).toBe("function");
    // The designer's module hands out the session's types alone: its values stay in its chunk.
    expect("createJourneyPreviewSession" in designer).toBe(false);
    expect("previewJourney" in designer).toBe(false);
    expect(typeof (await designer.createJourneyDesigner({ formRoot, locale: () => "en" }).prepareTry())).toBe("function");
  });

  it("is loaded again after a failed load, never remembered broken; the designer's prepareTry rejects meanwhile", async () => {
    vi.resetModules();
    vi.doMock(PREVIEW_MODULE, () => {
      throw new Error("chunk missing");
    });
    const fresh = await import("../form-engine/builder/journey-designer/journey-designer.js");
    await expect(fresh.loadJourneyPreview()).rejects.toThrow();
    const designer = fresh.createJourneyDesigner({ formRoot, locale: () => "en" });
    // Vitest wraps the mock's throw in a message of its own: the rejection is what matters.
    await expect(designer.prepareTry()).rejects.toThrow();
    vi.doUnmock(PREVIEW_MODULE);
    expect(typeof (await fresh.loadJourneyPreview()).createJourneyPreviewSession).toBe("function");
    expect(typeof (await designer.prepareTry())).toBe("function");
  });

  it("is loaded ahead once a journey is on the page, so Try it starts on the journey at once, from the canvas's answers", async () => {
    const { mode } = await activated();
    await warmed();
    // Not before Try it, and nothing of it in the mode's styles: the card wears the Try panel's.
    expect(mode.previewRuntime).toBeUndefined();
    expect(mode.styles).not.toContain("data-journey-try-session");
    const session = mode.tryIt.session!({ fullName: "Ada", contactMethod: "phone" });
    const runtime = mode.previewRuntime!;
    expect(session.runtime).toBe(runtime);
    expect(runtime.state().values).toMatchObject({ fullName: "Ada", contactMethod: "phone" });
    // The route to Finish applies: More is off the path.
    const [about, , finish] = pages(mode.controller).map((page) => page.id);
    expect(runtime.journeyView()!.path).toEqual([about, finish]);
    expect(session.answers()).toMatchObject({ fullName: "Ada", contactMethod: "phone" });
    session.dispose();
    expect(mode.previewRuntime).toBeUndefined();
  });

  it("runs the form over the canvas's preview while the chunk loads, and the journey takes over from that store when it comes", async () => {
    vi.resetModules();
    const fresh = await import("../form-engine/builder/journey-designer/journey-builder-mode.js");
    const values: Record<string, unknown> = { fullName: "Grace" };
    const { canvas, context: withCanvas } = tryCanvas(values);
    const mode = fresh.createJourneyBuilderMode({ form: formController(), journey: seed() });
    await mode.activate?.(withCanvas);
    // Pressed before the page was idle: the chunk is still to come.
    const session = mode.tryIt.session!({ fullName: "Grace" });
    expect(mode.previewRuntime).toBeUndefined();
    expect(session.runtime).toBe(canvas.previewRuntime());
    expect(session.answers()).toEqual({ fullName: "Grace" });
    expect(mode.tryIt.cards!({} as TryPanelView)).toContain("Starting the journey");
    // Typed into the form drawn over the canvas's store while the chunk is coming.
    values.fullName = "Hopper";

    await (await fresh.loadJourneyDesigner()).loadJourneyPreview();
    await vi.waitFor(() => expect(mode.previewRuntime).toBeDefined());
    expect(session.runtime).toBe(mode.previewRuntime);
    expect(mode.previewRuntime!.state().values.fullName).toBe("Hopper");
    expect(canvas.refreshed).toBeGreaterThan(0);
    expect(mode.tryIt.cards!({} as TryPanelView)).toContain("1 About you · step 1 of 3");
    session.dispose();
  });

  it("says a chunk that cannot load once and ends Try it; the next Try it loads it again", async () => {
    vi.resetModules();
    vi.doMock(PREVIEW_MODULE, () => {
      throw new Error("chunk missing");
    });
    const fresh = await import("../form-engine/builder/journey-designer/journey-builder-mode.js");
    const errors: string[] = [];
    const { canvas, context: withCanvas } = tryCanvas();
    const mode = fresh.createJourneyBuilderMode({ form: formController(), journey: seed(), onError: (message) => errors.push(message) });
    await mode.activate?.(withCanvas);
    // The load ahead fails quietly; the Try it that meets the failure says it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = mode.tryIt.session!({});
    await vi.waitFor(() => expect(canvas.previewing).toBe(false));
    expect(errors).toEqual(["The journey preview could not be loaded"]);
    first.dispose();

    vi.doUnmock(PREVIEW_MODULE);
    canvas.previewing = true;
    const second = mode.tryIt.session!({});
    await vi.waitFor(() => expect(mode.previewRuntime).toBeDefined());
    expect(errors).toHaveLength(1);
    second.dispose();
  });
});

describe("the Journey card and its actions", () => {
  it("leads the Try panel with the path, and routes Restart and Open this step", async () => {
    const { canvas, context: withCanvas } = tryCanvas();
    const mode = createJourneyBuilderMode({ form: formController(), journey: seed() });
    await mode.activate?.(withCanvas);
    await warmed();
    const session = mode.tryIt.session!({});
    const cards = (): string => mode.tryIt.cards!({} as TryPanelView);
    expect(cards()).toContain("data-try-journey ");
    expect(cards()).toContain("1 About you · step 1 of 3");
    const runtime = mode.previewRuntime!;
    runtime.setValue("fullName", "Ada");
    runtime.setValue("contactMethod", "mail");
    expect((await runtime.nextPage!()).ok).toBe(true);
    expect(cards()).toContain("1 About you › 2 Children · step 2 of 3");
    const [, more] = pages(mode.controller).map((page) => page.id);

    // Restart: a new runtime, no answers, the first page; the canvas is told.
    const before = canvas.refreshed;
    mode.tryIt.onTryClick!("restart");
    expect(mode.previewRuntime).not.toBe(runtime);
    expect(mode.previewRuntime!.state().values.fullName).toBeUndefined();
    expect(canvas.refreshed).toBeGreaterThan(before);

    // Open this step: Try it ends, the step the person was on opened in the Step view, selected.
    const restarted = mode.previewRuntime!;
    restarted.setValue("fullName", "Ada");
    restarted.setValue("contactMethod", "mail");
    await restarted.nextPage!();
    mode.tryIt.onTryClick!("open-step");
    expect(canvas.previewing).toBe(false);
    // Opened after the exit paint, not during it, so the canvas reveals the selection.
    expect(mode.controller.selectedComponentId()).not.toBe(more);
    await vi.waitFor(() => expect(mode.view).toBe("step"));
    await vi.waitFor(() => expect(mode.controller.selectedComponentId()).toBe(more));
    session.dispose();
    // Outside Try it the mode adds no card.
    expect(cards()).toBe("");
  });

  it("refreshes the running journey on an edit to its tree, and on a form edit, never rebuilding the journey's controller", async () => {
    const { context: withCanvas } = tryCanvas();
    const form = formController();
    const mode = createJourneyBuilderMode({ form, journey: seed() });
    await mode.activate?.(withCanvas);
    await warmed();
    const controller = mode.controller;
    const session = mode.tryIt.session!({});
    const [about] = pages(controller).map((page) => page.id);
    controller.setProperty(about!, "title", "Who you are");
    expect(mode.previewRuntime!.journeyView()!.page.title).toBe("Who you are");
    const runtime = mode.previewRuntime;
    form.setProperty("notes", "label", "Anything else");
    // A new form tree: a new runtime, the journey's controller the same.
    expect(mode.previewRuntime).not.toBe(runtime);
    expect(mode.controller).toBe(controller);
    session.dispose();
  });

  it("drops the run on another definition, so nothing of the old form is handed back, and ends Try it", async () => {
    const { canvas, context: withCanvas } = tryCanvas({ fullName: "Ada" });
    const mode = createJourneyBuilderMode({ form: formController(), journey: seed() });
    await mode.activate?.(withCanvas);
    await warmed();
    const session = mode.tryIt.session!({ fullName: "Ada" });
    const runtime = mode.previewRuntime!;
    expect(runtime.state().values.fullName).toBe("Ada");
    runtime.setValue("contactMethod", "phone");
    mode.reseed(seed());
    expect(canvas.previewing).toBe(false);
    expect(mode.previewRuntime).toBeUndefined();
    // What the canvas copies back is its own store's, not the dropped journey's.
    expect(session.runtime).toBe(canvas.previewRuntime());
    expect(session.answers()).toEqual({ fullName: "Ada" });
  });

  it("replays only what was typed into the canvas's store: a worked-out value is not an answer tried", async () => {
    const { context: withCanvas } = tryCanvas({ fullName: "Ada", notes: "Worked out" }, ["fullName"]);
    const mode = createJourneyBuilderMode({ form: formController(), journey: seed() });
    await mode.activate?.(withCanvas);
    await warmed();
    const session = mode.tryIt.session!({ fullName: "Ada", notes: "Worked out" });
    expect(mode.previewRuntime!.state().values.fullName).toBe("Ada");
    expect(mode.previewRuntime!.state().values.notes).toBeUndefined();
    session.dispose();
  });

  it("follows the journey's designer built again during Try it, the answers typed carried over", async () => {
    const { context: withCanvas } = tryCanvas();
    const mode = createJourneyBuilderMode({ form: formController(), journey: seed() });
    await mode.activate?.(withCanvas);
    await warmed();
    const session = mode.tryIt.session!({});
    const runtime = mode.previewRuntime!;
    runtime.setValue("fullName", "Ada");
    // A host replaces the journey on the page: its designer is built afresh, its pages new nodes.
    const changed = { ...mode.journey!, pages: [{ id: "about", title: "Who you are", components: ["fullName", "contactMethod"] }, { id: "finish", components: ["consent"] }] };
    mode.replaceJourney("intake", changed as Journey);
    expect(mode.previewRuntime).toBeDefined();
    expect(mode.previewRuntime).not.toBe(runtime);
    expect(mode.previewRuntime!.journeyView()!.page.title).toBe("Who you are");
    expect(mode.previewRuntime!.journeyView()!.path).toEqual(pages(mode.controller).map((page) => page.id));
    expect(mode.previewRuntime!.state().values.fullName).toBe("Ada");
    session.dispose();
  });

  it("starts the journey once its designer is built, for a Try it pressed while it builds", async () => {
    const { context: withCanvas } = tryCanvas({ fullName: "Ada" });
    const mode = createJourneyBuilderMode({ form: formController(), journey: seed() });
    // Nothing built yet: the form runs over the canvas's store, the Journey card says it is coming.
    const session = mode.tryIt.session!({ fullName: "Ada" });
    expect(mode.previewRuntime).toBeUndefined();
    expect(mode.tryIt.cards!({} as TryPanelView)).toContain("Starting the journey");
    await mode.activate?.(withCanvas);
    await vi.waitFor(() => expect(mode.previewRuntime).toBeDefined());
    expect(mode.previewRuntime!.state().values.fullName).toBe("Ada");
    expect(session.runtime).toBe(mode.previewRuntime);
    session.dispose();
  });

  it("tells the canvas only when the Journey card or the runtime changed, not on every recompute", async () => {
    const { canvas, context: withCanvas } = tryCanvas();
    const mode = createJourneyBuilderMode({ form: formController(), journey: seed() });
    await mode.activate?.(withCanvas);
    await warmed();
    const session = mode.tryIt.session!({});
    const runtime = mode.previewRuntime!;
    const before = canvas.refreshed;
    // Answers that leave the path as it was: the card says the same, nothing is redrawn.
    runtime.setValue("fullName", "Ada");
    runtime.setValue("contactMethod", "mail");
    expect(canvas.refreshed).toBe(before);
    // Moving on changes the card's path.
    await runtime.nextPage!();
    expect(canvas.refreshed).toBe(before + 1);
    session.dispose();
  });
});

describe("where focus goes after a deletion", () => {
  const q = (id: string): ComponentNode => ({ id, type: "journey-field", configuration: { componentId: id } });
  const page = (id: string, ...questions: string[]): ComponentNode => ({ id, type: "journey-page", configuration: {}, children: { content: questions.map(q), routes: [] } });
  const tree = (...pages: ComponentNode[]): ComponentNode => ({ id: "journey", type: "journey", configuration: {}, children: { pages } });

  it("is the card now in its place, else the one before it, else its page or the journey", () => {
    const before = tree(page("p1", "a", "b", "c"), page("p2", "d"));
    expect(journeyNodeAfterRemoval(before, tree(page("p1", "a", "c"), page("p2", "d")))).toBe("c");
    expect(journeyNodeAfterRemoval(before, tree(page("p1", "a", "b"), page("p2", "d")))).toBe("b");
    expect(journeyNodeAfterRemoval(before, tree(page("p1", "a", "b", "c"), page("p2")))).toBe("p2");
    // A page: the page now in its place, else the one before it, else the journey.
    expect(journeyNodeAfterRemoval(before, tree(page("p2", "d")))).toBe("p2");
    expect(journeyNodeAfterRemoval(before, tree(page("p1", "a", "b", "c")))).toBe("p1");
    expect(journeyNodeAfterRemoval(tree(page("p1")), tree())).toBe("journey");
    // Nothing deleted, or another tree altogether: nowhere.
    expect(journeyNodeAfterRemoval(before, before)).toBeUndefined();
    expect(journeyNodeAfterRemoval(before, { id: "other", type: "journey", configuration: {} })).toBeUndefined();
  });
});

describe("the chunks the designer loads", () => {
  /** The modules of the designer's own chunk. */
  const DESIGNER_CHUNK = /\/journey-(designer|tree|checks|components|from-form|designer-panels|designer-styles)\.js$/;

  it("import nothing of the designer's chunk but types: what they read of it is lent", () => {
    // A browser keeps a failed load of a module for the page's life, and a static import of the
    // designer's chunk would name its first URL: a designer fetched again after a failed load
    // (under another URL) would leave the preview and the page-only fields unable to load.
    for (const name of ["journey-preview.ts", "journey-authoring.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`../form-engine/builder/journey-designer/${name}`, import.meta.url)), "utf8");
      const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)];
      expect(imports.length, name).toBeGreaterThan(0);
      for (const [, typeOnly, from] of imports) {
        if (DESIGNER_CHUNK.test(from!)) {
          expect(typeOnly, `${name} imports values from ${from}`).toBeDefined();
        }
      }
    }
  });

  it("are lent what they read by the designer", async () => {
    const designer = await loadJourneyDesigner();
    expect(Object.keys(designer.JOURNEY_PREVIEW_LENT).sort()).toEqual(["indexJourneyTree", "journeyFromTreePlaced", "pageName"]);
    expect(Object.keys(designer.JOURNEY_AUTHORING_LENT)).toEqual(["journeyComponentDefinitions"]);
    expect(typeof designer.JOURNEY_AUTHORING_LENT.journeyComponentDefinitions).toBe("function");
  });
});

/**
 * A journey whose pages hold nodes of its own opens like any other: its
 * tree holds those nodes as written, it is saved byte for byte until it is edited, renames are
 * followed into them in one step, and their ids are claimed for the form as the tree stands.
 */
describe("a journey with nodes of its own", () => {
  /** The presentation fixture's two journeys (one of them one page) around a journey of component ids alone. */
  function presentations(): JourneyConfiguration {
    return {
      "x-block": { owner: "income" },
      journeys: [
        applyJourney(),
        { id: "plain", name: "Plain", pages: [{ id: "one", title: "One", components: ["email", "name"] }, { id: "two", components: ["money", "approved_amount"] }] },
        publicVariant()
      ]
    } as unknown as JourneyConfiguration;
  }

  async function opened(journey: unknown = presentations()): Promise<Setup & { surfaces: Array<HTMLElement | undefined> }> {
    const form = new BuilderController({ initialRoot: presentationRoot() });
    const changes: JourneyBuilderModeChangeDetail[] = [];
    const errors: string[] = [];
    const mode = createJourneyBuilderMode({
      form,
      journey,
      onChange: (detail) => changes.push(detail),
      onError: (message) => errors.push(message)
    });
    const shell = context();
    await mode.activate?.(shell);
    return { form, mode, changes, errors, surfaces: shell.surfaces };
  }

  function content(controller: BuilderController, page: number): ComponentNode[] {
    return pages(controller)[page]?.children?.[JOURNEY_CONTENT_SLOT] ?? [];
  }

  it("lists it like any other before any designer loads, the one-page journey with no badge", () => {
    const mode = createJourneyBuilderMode({ form: new BuilderController({ initialRoot: presentationRoot() }), journey: presentations() });
    expect(mode.documents?.list()).toEqual([
      { id: "apply", label: "Apply", isDefault: true },
      { id: "plain", label: "Plain", isDefault: false },
      { id: "public", label: "Public", isDefault: false }
    ]);
    expect(mode.journeyId).toBe("apply");
    expect(mode.ready).toBe(false);
    expect("notice" in mode).toBe(false);
  });

  it("opens it: its own nodes are nodes of the tree, its references questions, and the block is the very one given", async () => {
    const given = presentations();
    const { mode, changes, errors, surfaces } = await opened(given);
    expect(mode.journey?.id).toBe("apply");
    expect(mode.ready).toBe(true);
    const apply = mode.controller;
    expect(pages(apply).map((page) => (page.configuration as { pageId: string }).pageId)).toEqual(["details", "income", "assist"]);
    expect(content(apply, 0)).toEqual([applyJourney().pages[0]!.components![0]]);
    expect(content(apply, 1).map((node) => [node.id, node.type])).toEqual([
      ["m1", "number"],
      ["m2", "number"],
      ["m3", "number"],
      ["income_total", "journey-value"]
    ]);
    expect(content(apply, 2).map((node) => [node.type, (node.configuration as { componentId?: string }).componentId])).toEqual([[JOURNEY_FIELD_TYPE, "approved_amount"]]);
    // The canvas shows the cards: no note stands in their place.
    expect(surfaces.at(-1)).toBeUndefined();

    await mode.selectJourney("public");
    const [contact, note] = content(mode.controller, 0);
    expect([contact?.id, contact?.type, note?.id]).toEqual(["contact", "grid", "public_note"]);
    expect(contact?.children?.content?.map((reference) => [reference.type, (reference.configuration as { componentId: string }).componentId])).toEqual([
      [JOURNEY_FIELD_TYPE, "email"],
      [JOURNEY_FIELD_TYPE, "name"]
    ]);
    expect(mode.documents?.list()[2]).toEqual({ id: "public", label: "Public", isDefault: false });

    // Opened, nothing was edited, reported or refused: the block is the very one given.
    expect(mode.journeyConfiguration).toBe(given);
    expect(changes).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("writes its own nodes back as written through an edit of the journey, and keeps it the very object through an edit of another", async () => {
    const given = presentations();
    const { mode, changes, errors } = await opened(given);
    const apply = mode.controller;
    apply.setProperty(pages(apply)[2]!.id, "title", "Help");
    expect(changes).toHaveLength(1);
    const saved = mode.journeyConfiguration as JourneyConfiguration;
    expect(JSON.stringify(saved.journeys?.[0])).toBe(JSON.stringify(applyJourney()).replace('"title":"Assistance"', '"title":"Help"'));
    // The one-page journey, never opened, is the object given.
    expect(saved.journeys?.[2]).toBe(given.journeys?.[2]);

    // Opened and edited too: its layout of references and its paragraph come back as written.
    await mode.selectJourney("public");
    const onePage = mode.controller;
    onePage.setProperty(pages(onePage)[0]!.id, "title", "About you");
    expect(JSON.stringify(mode.journeyConfiguration?.journeys?.[2])).toBe(JSON.stringify(publicVariant()).replace('"title":"Tell us about you"', '"title":"About you"'));
    // Undone, it is the journey given, byte for byte.
    onePage.undo();
    expect(JSON.stringify(mode.journeyConfiguration?.journeys?.[2])).toBe(JSON.stringify(publicVariant()));
    expect(Object.keys(mode.journeyConfiguration as object)).toEqual(["x-block", "journeys"]);
    expect(errors).toEqual([]);
  });

  it("opens a journey whose own entries are all ignored at run time, and keeps them as written", async () => {
    const ignored = JSON.parse(
      JSON.stringify({
        id: "ignored",
        pages: [
          {
            id: "p",
            title: "Ignored",
            components: [
              { id: "email", type: "text", configuration: { label: "A form id" } },
              { id: "9lives", type: "text", configuration: { label: "Not an id" } },
              { id: "rows", type: "repeatingSection", configuration: { label: "Rows" }, children: { content: [{ id: "row_name", type: "text" }] } },
              { id: "bound", type: "text", configuration: { label: "Bound", dataKey: "elsewhere" } }
            ]
          }
        ]
      })
    ) as Journey;
    const given = { journeys: [ignored] } as JourneyConfiguration;
    const { mode, changes, errors } = await opened(given);
    expect(mode.ready).toBe(true);
    expect(content(mode.controller, 0).map((node) => node.id)).toEqual(["email", "9lives", "rows", "bound"]);
    mode.controller.setProperty(pages(mode.controller)[0]!.id, "title", "Still ignored");
    expect(changes).toHaveLength(1);
    expect(JSON.stringify(mode.journeyConfiguration?.journeys?.[0])).toBe(JSON.stringify(ignored).replace('"title":"Ignored"', '"title":"Still ignored"'));
    expect(errors).toEqual([]);
  });

  it("offers it under Opens as, and renames, copies, makes the default and removes it with its nodes as written", async () => {
    const { mode, changes, errors } = await opened({ ...presentations(), defaultJourneyId: "plain", opensAs: "form" });
    const row = (): BuilderFormSettingRow => (mode.formSettings?.rows() ?? [])[0]!;
    expect(row().choices).toEqual([
      { value: "form", label: "The whole form" },
      { value: "apply", label: "Apply" },
      { value: "plain", label: "Plain" },
      { value: "public", label: "Public" }
    ]);
    row().set("apply");
    expect(mode.journeyConfiguration?.defaultJourneyId).toBe("apply");
    expect(mode.opensAs).toBe("journey");
    await mode.selectJourney("apply");
    mode.documents?.rename?.("apply", "Apply for support");
    expect(mode.documents?.list()[0]).toEqual({ id: "apply", label: "Apply for support", isDefault: true });
    expect(JSON.stringify(mode.journey)).toBe(JSON.stringify({ ...applyJourney(), name: "Apply for support" }));
    // The open tree took the name; its history is the catalog's no more than before.
    expect(mode.ready).toBe(true);

    mode.documents?.duplicate?.("apply");
    expect(mode.documents?.selectedId()).toBe("apply-copy");
    expect(mode.ready).toBe(true);
    const copy = mode.journeyConfiguration?.journeys?.[3];
    expect(JSON.stringify(copy?.pages)).toBe(JSON.stringify(applyJourney().pages));
    expect(content(mode.controller, 0)[0]?.id).toBe("work_email");

    mode.documents?.remove?.("apply-copy");
    mode.documents?.remove?.("apply");
    expect(mode.documents?.list().map((entry) => entry.id)).toEqual(["plain", "public"]);
    expect(JSON.stringify(mode.journeyConfiguration?.journeys?.[1])).toBe(JSON.stringify(publicVariant()));
    expect(changes.every((change) => change.reason === "journeys")).toBe(true);
    expect(errors).toEqual([]);
  });

  it("puts what it leaves out on a page with Add unassigned, its own nodes untouched", async () => {
    const { mode, errors } = await opened();
    expect(await mode.addUnassigned()).toBe(true);
    const apply = mode.journeyConfiguration?.journeys?.[0] as Journey;
    // Where every path that can be submitted reaches it: "income" routes on to "assist" or the
    // end, so a page after "assist" would be skipped by the way to the end — and the form's
    // Required with it. Between "details" and "income" it never is.
    expect(apply.pages.map((page) => page.id)).toEqual(["details", "step-4", "income", "assist"]);
    expect(apply.pages[1]?.components).toEqual(["name"]);
    expect(JSON.stringify([apply.pages[0], ...apply.pages.slice(2)])).toBe(JSON.stringify(applyJourney().pages));
    expect(errors).toEqual([]);
  });

  it("follows a form rename into the open tree's own nodes — fills, to, references and their rules — with no entry of the tree's, each rename's Undo taking its part back", async () => {
    const withRules = JSON.parse(JSON.stringify(applyJourney())) as Journey;
    // An own field shown and required as the form's answers say.
    withRules.pages[1]!.components!.splice(1, 0, {
      id: "m1_note",
      type: "text",
      configuration: { label: "Why so low?" },
      rules: { visibleWhen: { kind: "path", path: "email" }, requiredWhen: { kind: "path", path: "name" } }
    });
    const { form, mode, changes } = await opened({ journeys: [withRules, publicVariant()] });
    const apply = mode.controller;
    const note = (): ComponentNode => content(apply, 1)[1]!;
    const fills = (): string => (content(apply, 0)[0]!.configuration as { fills: string }).fills;
    form.renameId("email", "contact_email");
    form.renameId("annual_income", "income");
    form.renameId("name", "full_name");
    expect(changes.map((change) => change.reason)).toEqual(["form-rename", "form-rename", "form-rename"]);
    // The open tree wrote exactly what the catalog's own rename wrote.
    const expected = renameJourneyReferences(renameJourneyReferences(renameJourneyReferences(withRules, "email", "contact_email"), "annual_income", "income"), "name", "full_name");
    expect(JSON.stringify(mode.journeyConfiguration?.journeys?.[0])).toBe(JSON.stringify(expected));
    expect(note().rules).toEqual({ visibleWhen: { kind: "path", path: "contact_email" }, requiredWhen: { kind: "path", path: "full_name" } });
    expect((content(apply, 1)[4]!.configuration as { to: string }).to).toBe("income");
    expect(fills()).toBe("contact_email");
    // The one-page journey follows too.
    expect(JSON.stringify(mode.journeyConfiguration?.journeys?.[1])).toContain('"componentId":"contact_email"');

    // The follow-ups are no entries of the tree's: each rename of the form's is the step.
    expect(apply.canUndo()).toBe(false);
    // The last Undo takes back the rule the third rename moved, alone.
    form.undo();
    expect(note().rules).toEqual({ visibleWhen: { kind: "path", path: "contact_email" }, requiredWhen: { kind: "path", path: "name" } });
    form.undo();
    expect((content(apply, 1)[4]!.configuration as { to: string }).to).toBe("annual_income");
    // The first rename moved a configuration and a rule; one undo takes both back.
    expect(fills()).toBe("contact_email");
    form.undo();
    expect(fills()).toBe("email");
    expect(note().rules).toEqual({ visibleWhen: { kind: "path", path: "email" }, requiredWhen: { kind: "path", path: "name" } });
    expect(JSON.stringify(mode.journeyConfiguration?.journeys?.[0])).toBe(JSON.stringify(withRules));
    expect(apply.canUndo()).toBe(false);
  });

  it("follows an Undo and a Redo of a form rename, so no journey names an id the form no longer has", async () => {
    const { form, mode, changes } = await opened({ journeys: [applyJourney(), publicVariant()] });
    const written = (): string => JSON.stringify(mode.journeyConfiguration?.journeys);
    const original = written();
    form.renameId("email", "contact_email");
    const renamed = written();
    expect(renamed).not.toBe(original);
    expect(renamed).not.toMatch(/"email"/);
    form.undo();
    expect(form.snapshot().children?.content?.some((node) => node.id === "email")).toBe(true);
    expect(written()).toBe(original);
    form.redo();
    expect(written()).toBe(renamed);
    expect(changes.map((change) => change.reason)).toEqual(["form-rename", "form-rename", "form-rename"]);
  });

  it("follows an own node renamed in its tree into the journey's own rules and worked-out values, in one step, reported once", async () => {
    const withRules = JSON.parse(JSON.stringify(applyJourney())) as Journey;
    (withRules.pages[1]!.components![1] as { rules?: unknown }).rules = { visibleWhen: { kind: "path", path: "m1" } };
    const { form, mode, changes, errors } = await opened({ journeys: [withRules] });
    const apply = mode.controller;
    apply.renameId("m1", "month_1");
    expect(apply.idError).toBeUndefined();
    expect(changes).toHaveLength(1);
    const written = JSON.stringify(mode.journeyConfiguration?.journeys?.[0]);
    expect(written).toBe(JSON.stringify(withRules).replace('"id":"m1"', '"id":"month_1"').replace(/"path":"m1"/g, '"path":"month_1"'));
    expect(changes[0]?.journey).toEqual(JSON.parse(written));
    // The form's own components and the pages' conditions read form values; nothing there moved.
    expect(written).toContain('"path":"annual_income"');

    // The rename and its follow-up are one step of the journey's history: Undo puts the id and
    // the reads back together.
    apply.undo();
    expect(JSON.stringify(mode.journeyConfiguration?.journeys?.[0])).toBe(JSON.stringify(withRules));
    expect(apply.canUndo()).toBe(false);

    // The form may now take the new id, and not m1.
    form.renameId("name", "m1");
    expect(form.idError).toBe('ID "m1" is already used by a page-only field of a journey.');
    form.renameId("name", "month_1");
    expect(form.idError).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it("follows the renamed one of two own entries sharing a hand-written id: Undo brings the other back as written", async () => {
    const dupA = { id: "dup", type: "text", configuration: { label: "Dup A" } };
    const dupB = { id: "dup", type: "text", configuration: { label: "Dup B" } };
    const { mode, errors } = await opened({ journeys: [{ id: "hand", pages: [{ id: "p1", components: [dupA, "name", dupB] }] }] });
    const apply = mode.controller;
    const written = (): unknown => mode.journeyConfiguration?.journeys?.[0]?.pages[0]?.components;
    // The first goes; the one left is renamed.
    apply.remove("dup");
    apply.renameId("dup", "solo");
    expect(written()).toEqual(["name", { ...dupB, id: "solo" }]);
    apply.undo();
    expect(written()).toEqual(["name", dupB]);
    apply.undo();
    expect(written()).toEqual([dupA, "name", dupB]);
    expect(apply.dropError).toBeUndefined();
    apply.redo();
    apply.redo();
    expect(written()).toEqual(["name", { ...dupB, id: "solo" }]);
    expect(errors).toEqual([]);
  });

  it("claims its own ids for the form as the open tree stands: added, renamed and removed", async () => {
    const { form, mode } = await opened();
    const apply = mode.controller;
    const claimed = (id: string): boolean => {
      form.setDraftId("name", id);
      const refused = form.idError !== undefined;
      form.setDraftId("name", "name");
      return refused;
    };
    expect(claimed("m3")).toBe(true);
    apply.remove("m3");
    expect(claimed("m3")).toBe(false);
    apply.undo();
    expect(claimed("m3")).toBe(true);
    apply.renameId("m3", "march");
    expect(claimed("m3")).toBe(false);
    expect(claimed("march")).toBe(true);
    // While the tree cannot be written (a page given a condition of its own), what it holds is claimed all the same.
    apply.setProperty(pages(apply)[1]!.id, "when", "not an expression");
    expect(mode.journeyConfiguration?.journeys?.[0]?.pages[1]?.components?.[2]).toMatchObject({ id: "march" });
    apply.renameId("march", "third");
    expect(claimed("third")).toBe(true);
  });

  it("takes off references and worked-out values whose form component is gone, with the questions, in one undo step", async () => {
    const mixed = JSON.parse(
      JSON.stringify({
        id: "mixed",
        pages: [
          {
            id: "who",
            components: [
              { id: "box", type: "grid", configuration: { columns: 2 }, children: { content: [{ type: "journey-field", configuration: { componentId: "email" } }, { type: "journey-field", configuration: { componentId: "name" } }] } },
              "approved_amount"
            ]
          },
          { id: "income", components: [{ id: "m1", type: "number", configuration: { label: "Month 1" } }, { id: "total", type: "journey-value", configuration: { to: "annual_income", value: { kind: "path", path: "m1" } } }] }
        ]
      })
    ) as Journey;
    const { form, mode, changes } = await opened({ journeys: [mixed] });
    const controller = mode.controller;
    expect(await mode.removeMissing()).toBe(false);
    form.remove("name");
    form.remove("annual_income");
    form.remove("approved_amount");
    expect(await mode.removeMissing()).toBe(true);
    const written = mode.journeyConfiguration?.journeys?.[0] as Journey;
    expect(written.pages[0]?.components).toEqual([{ id: "box", type: "grid", configuration: { columns: 2 }, children: { content: [{ type: "journey-field", configuration: { componentId: "email" } }] } }]);
    expect(written.pages[1]?.components).toEqual([{ id: "m1", type: "number", configuration: { label: "Month 1" } }]);
    expect(changes.at(-1)?.reason).toBe("remove");
    controller.undo();
    expect(JSON.stringify(mode.journeyConfiguration?.journeys?.[0])).toBe(JSON.stringify(mixed));
  });

  it("holds a route's and a worked-out value's formula back from Save while it does not parse, as the controller's own problem", async () => {
    const { mode, changes, errors } = await opened();
    const controller = mode.controller;
    const income = pages(controller)[1]!;
    const route = income.children?.[JOURNEY_ROUTES_SLOT]?.[0];
    const total = content(controller, 1).find((node) => node.type === "journey-value")!;
    expect(route).toBeDefined();
    const unparseable = "m1 >";
    for (const [nodeId, path] of [
      [route!.id, "when"],
      [total.id, "value"]
    ] as const) {
      controller.select(nodeId);
      controller.setDraftProperty(nodeId, path, unparseable);
      // Named under its box as a rule problem, and commitDraft refuses it directly (no panel in between).
      expect(controller.problemsOf(nodeId).map((problem) => problem.target)).toEqual([`rules:${path}`]);
      expect(controller.commitDraft(nodeId)).toBe(false);
      expect(controller.hasPendingChanges(nodeId)).toBe(true);
      // Parseable text commits as written.
      controller.setDraftProperty(nodeId, path, "m1 > 10");
      expect(controller.problemsOf(nodeId)).toEqual([]);
      expect(controller.commitDraft(nodeId)).toBe(true);
      expect(controller.getProperty(nodeId, path)).toBe("m1 > 10");
    }
    const written = mode.journeyConfiguration?.journeys?.[0] as Journey;
    expect(written.pages[1]?.routes?.[0]?.when).toBe("m1 > 10");
    // The worked-out value's string formula is held by the tree (its draft committed); whether
    // the journey written carries it is journey-tree.ts's `unfinishedWorkedOut`, which leaves a worked-out
    // value out until it names a form field (`to`) and has a non-empty formula or an object form.
    expect(controller.getProperty(total.id, "value")).toBe("m1 > 10");
    expect(changes.filter((change) => change.reason === "edit")).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it("builds the designer again over a journey a host replaces with one holding nodes of its own", async () => {
    const { mode, errors } = await opened();
    await mode.selectJourney("plain");
    const built = mode.controller;
    const replacement = { ...applyJourney(), id: "plain", name: "Plain" };
    mode.replaceJourney("plain", replacement);
    expect(mode.ready).toBe(true);
    expect(mode.controller).toBe(built);
    expect(content(built, 1).map((node) => node.id)).toEqual(["m1", "m2", "m3", "income_total"]);
    expect(mode.journeyConfiguration?.journeys?.[1]).toBe(replacement);
    expect(errors).toEqual([]);
  });

  it("keeps the ids its own nodes carry: the form renames nothing onto one and makes no new component with one", async () => {
    const guarded = presentations();
    // The one-page journey also owns text_1, the id the palette would give the form's next text field.
    guarded.journeys![2]!.pages[0]!.components!.push({ id: "text_1", type: "text", configuration: { label: "Own text" } });
    const { form, mode, changes } = await opened(guarded);
    const formIds = (): string[] => JSON.stringify(form.snapshot()).match(/"id":"[^"]+"/g) ?? [];
    const before = JSON.stringify(mode.journeyConfiguration);
    const shape = JSON.stringify(form.snapshot());

    // Onto an alias's id, an own field's, a one-page journey's own node's: refused, with nothing moved.
    for (const [from, to] of [
      ["email", "work_email"],
      ["name", "m1"],
      ["approved_amount", "text_1"]
    ] as const) {
      form.renameId(from, to);
      expect(form.idError).toBe(`ID "${to}" is already used by a page-only field of a journey.`);
    }
    expect(JSON.stringify(form.snapshot())).toBe(shape);
    expect(JSON.stringify(mode.journeyConfiguration)).toBe(before);
    expect(changes.some((change) => change.reason === "form-rename")).toBe(false);
    form.setDraftId("name", "contact");
    expect(form.idError).toBe('ID "contact" is already used by a page-only field of a journey.');
    form.setDraftId("name", "name");

    // A new component skips every claimed id.
    form.add("text", form.rootId(), "content");
    expect(formIds()).not.toContain('"id":"text_1"');
    expect(formIds()).toContain('"id":"text_2"');

    // Disposed, the mode gives its claims back.
    mode.dispose?.();
    form.renameId("name", "m1");
    expect(form.idError).toBeUndefined();
  });

  it("numbers its designer's node ids around the form's", async () => {
    const root = presentationRoot();
    (root.children!.content as ComponentNode[]).push({ id: "journey-field_1", type: "text", configuration: { label: "Odd" } });
    const form = new BuilderController({ initialRoot: root });
    const mode = createJourneyBuilderMode({ form, journey: presentations() });
    await mode.activate?.(context());
    expect(content(mode.controller, 2)[0]?.id).toBe("journey-field_2");
  });
});

describe("journey designer regressions", () => {
  const not = (path: string): Expression => ({ kind: "unary", operator: "not", operand: { kind: "path", path } }) as Expression;
  /** What the kernel refuses a submission through `journey` for, by field. */
  const refused = (form: BuilderController, journey: Journey, values: Record<string, unknown>): Array<string | undefined> =>
    runKernel({ formId: "f", values, locale: "en", form: form.snapshot(), journey } as never, []).errors.map((error: { componentId?: string }) => error.componentId);

  it("Add unassigned never puts a page after a closing exit page or past an Always → End route, where the form's Required would lapse", async () => {
    const { form, mode } = await activated({
      journeys: [
        {
          id: "j",
          pages: [
            { id: "p1", components: ["fullName", "consent"], routes: [{ when: not("consent"), to: "stop" }, { to: "$end" }] },
            { id: "stop", kind: "exit", title: "Not eligible" }
          ]
        }
      ]
    });
    form.setProperty("notes", "required", true);
    const values = { fullName: "A", consent: true };
    expect(refused(form, mode.journey!, values)).toContain("notes");
    mode.controller.select(undefined);
    expect(await mode.addUnassigned()).toBe(true);
    // Where every path that can be submitted reaches it: before "p1", whose routes pass anything after it.
    expect(mode.journey?.pages.map((page) => [page.id, page.kind ?? "questions"])).toEqual([
      ["step-3", "questions"],
      ["p1", "questions"],
      ["stop", "exit"]
    ]);
    expect(mode.journey?.pages[0]?.components).toEqual(["contactMethod", "children", "notes"]);
    // Still required on the server.
    expect(refused(form, mode.journey!, values)).toContain("notes");
  });

  it("Ask it here and Add unassigned never use a page some path skips, so the field stays required", async () => {
    const { form, mode } = await activated({
      journeys: [
        {
          id: "j",
          pages: [
            { id: "p1", components: ["fullName", "consent"], routes: [{ when: { kind: "unary", operator: "not", operand: { kind: "path", path: "consent" } } as Expression, to: "$end" }] },
            { id: "partner", components: ["contactMethod"] }
          ]
        }
      ]
    });
    form.setProperty("notes", "required", true);
    const controller = mode.controller;
    // A route may pass the last page: the last page every path takes asks it instead.
    expect(await mode.askUnassigned("notes")).toBe(true);
    expect(mode.journey?.pages.map((page) => page.components)).toEqual([["fullName", "consent", "notes"], ["contactMethod"]]);
    expect(refused(form, mode.journey!, { fullName: "A", consent: false })).toContain("notes");
    controller.undo();
    // The page a route may pass selected: a page of its own where every path reaches it, not the
    // selected one — first, since the first page's route passes everything after it.
    controller.select(pages(controller)[1]!.id);
    expect(await mode.addUnassigned()).toBe(true);
    expect(mode.journey?.pages.map((page) => page.id)).toEqual(["step-3", "p1", "partner"]);
    expect(mode.journey?.pages[2]?.components).toEqual(["contactMethod"]);
    expect(refused(form, mode.journey!, { fullName: "A", consent: false })).toContain("notes");
  });

  it("follows a form rename into a route not written yet, though nothing written named the old id", async () => {
    const { form, mode, changes } = await activated({ journeys: [{ id: "j", pages: [{ id: "p1", components: ["fullName"] }, { id: "p2", components: ["submit"] }] }] });
    const controller = mode.controller;
    controller.add(JOURNEY_ROUTE_TYPE, pages(controller)[0]!.id, JOURNEY_ROUTES_SLOT);
    const routeId = pages(controller)[0]!.children![JOURNEY_ROUTES_SLOT]![0]!.id;
    const reads = (path: string): Expression => ({ kind: "binary", operator: "eq", left: { kind: "path", path }, right: { kind: "literal", value: "x" } }) as Expression;
    controller.setProperty(routeId, "when", reads("notes"));
    const heard = changes.length;
    form.renameId("notes", "remarks");
    // Nothing written changed, so a host hears nothing; the tree follows all the same.
    expect(changes).toHaveLength(heard);
    expect((pages(controller)[0]!.children![JOURNEY_ROUTES_SLOT]![0]!.configuration as { when?: unknown }).when).toEqual(reads("remarks"));
    controller.setProperty(routeId, "to", "$end");
    expect(mode.journeyConfiguration?.journeys?.[0]?.pages[0]?.routes?.[0]?.when).toEqual(reads("remarks"));
  });

  it("keeps a journey a file names \"form\" apart from the whole form in the Opens as row", async () => {
    const { mode } = await activated({ opensAs: "journey", journeys: [{ id: "form", name: "Form", pages: [{ id: "p", components: ["fullName"] }] }, { id: "other", pages: [{ id: "q", components: ["fullName"] }] }] });
    const row = (): BuilderFormSettingRow => mode.formSettings!.rows()[0]!;
    const values = row().choices!.map((choice) => choice.value);
    expect(new Set(values).size).toBe(values.length);
    const whole = row().choices!.find((choice) => choice.label === "The whole form")!.value;
    expect(whole).not.toBe("form");
    // Opening as the journey "form" reads as the journey, not the whole form.
    expect(row().get()).toBe("form");
    row().set("other");
    expect(mode.journeyConfiguration?.defaultJourneyId).toBe("other");
    expect(mode.opensAs).toBe("journey");
    row().set(whole);
    expect(mode.opensAs).toBe("form");
    // A new journey named "Form" never takes the id.
    expect((await mode.newJourney({ name: "Form", from: "one-page" })).id).toBe("form-1");
  });

  it("a rename from the documents menu is no undo step: the next Undo takes back the author's own last edit", async () => {
    const { mode } = await activated({
      journeys: [{ id: "j", name: "Old", pages: [{ id: "p1", title: "T1", components: ["fullName"] }] }]
    });
    const page = pages(mode.controller)[0]!.id;
    mode.controller.setProperty(page, "title", "T2");
    mode.renameJourney("j", "New");
    expect((mode.controller.snapshot().configuration as { name?: unknown }).name).toBe("New");
    mode.controller.undo();
    expect(mode.journey?.pages[0]?.title).toBe("T1");
    expect(mode.journey?.name).toBe("New");
    expect((mode.controller.snapshot().configuration as { name?: unknown }).name).toBe("New");
  });
});

describe("a data grid in a journey made from the form", () => {
  it("keeps the grid whole on one page by its collection binding alone, whatever its type", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          {
            id: "lines",
            type: "dataGrid",
            configuration: { label: "Lines" },
            collection: { collectionPath: "lines" },
            children: { content: [{ id: "sku", type: "text", configuration: {} }, { id: "qty", type: "number", configuration: {} }] }
          },
          { id: "empty", type: "dataGrid", configuration: {}, collection: { collectionPath: "empty" }, children: { content: [] } },
          { id: "send", type: "button", configuration: { label: "Send" } }
        ]
      }
    };
    const pages = journeyPagesFromForm(root, { shape: "questions" });
    const asked = pages.flatMap((page) => page.components);
    // The grid's fields are not pages of their own: one page stands for the whole list, and an
    // empty grid is still a list a person fills, so it is not dropped as an empty group.
    expect(asked).toEqual(expect.arrayContaining(["name", "lines", "empty"]));
    expect(asked).not.toContain("sku");
    expect(asked).not.toContain("qty");
  });
});

describe("an agent's way in", () => {
  afterEach(() => {
    vi.doUnmock(PREVIEW_MODULE);
    vi.doUnmock(DESIGNER_MODULE);
    vi.resetModules();
  });

  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  /** An import held until `release()`: the real module, handed over when the test says. */
  function held(path: string): { release(): void } {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    vi.doMock(path, async () => {
      await gate;
      return vi.importActual(path);
    });
    return { release: open };
  }

  it("the run's ready() resolves once the journey has started, after its chunk came", async () => {
    vi.resetModules();
    const chunk = held(PREVIEW_MODULE);
    const fresh = await import("../form-engine/builder/journey-designer/journey-builder-mode.js");
    const { canvas, context: withCanvas } = tryCanvas({ fullName: "Grace" });
    const mode = fresh.createJourneyBuilderMode({ form: formController(), journey: seed() });
    await mode.activate?.(withCanvas);
    const session = mode.tryIt.session!({ fullName: "Grace" });
    let ready = false;
    const waiting = session.ready!().then(() => {
      ready = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The chunk is still coming: the form runs over the canvas's preview, and ready() waits.
    expect(ready).toBe(false);
    expect(mode.previewRuntime).toBeUndefined();
    expect(session.runtime).toBe(canvas.previewRuntime());

    chunk.release();
    await waiting;
    expect(mode.previewRuntime).toBeDefined();
    expect(session.runtime).toBe(mode.previewRuntime);
    expect(mode.previewRuntime!.state().values.fullName).toBe("Grace");
    // Once started, at once.
    await session.ready!();
    session.dispose();
  });

  it("names a page's node from its page id and back, as Show me and Record do", async () => {
    const { mode } = await activated();
    await warmed();
    const session = mode.tryIt.session!({});
    await session.ready!();
    const nodes = pages(mode.controller).map((page) => page.id);
    expect(nodes).toHaveLength(3);
    for (const [index, pageId] of ["about", "more", "finish"].entries()) {
      const nodeId = session.nodeIdOf!(pageId);
      expect(nodeId).toBe(nodes[index]);
      expect(session.pageIdOf!(nodeId!)).toBe(pageId);
    }
    // The runtime runs the pages under those nodes.
    expect(session.runtime.journeyView?.()?.pageId).toBe(session.nodeIdOf!("about"));
    expect(session.nodeIdOf!("nowhere")).toBeUndefined();
    expect(session.pageIdOf!("nowhere")).toBeUndefined();
    session.dispose();
  });

  it("applyCatalogForAgent() puts a catalog back with every designer's history kept, where the public setter starts them over", async () => {
    const { mode, changes } = await activated();
    const controller = mode.controller;
    controller.setProperty(pages(controller)[0]!.id, "title", "About");
    expect(controller.canUndo()).toBe(true);
    const before = clone(mode.journeyConfiguration);
    // An agent made Quick the default; its undo computes the catalog without that and writes it back.
    mode.setDefaultJourney("quick");
    const next = clone(mode.journeyConfiguration) as JourneyConfiguration & { defaultJourneyId?: string };
    delete next.defaultJourneyId;
    changes.length = 0;
    mode.applyCatalogForAgent(next, "quick");
    expect(mode.journeyConfiguration).toEqual(before);
    expect(changes).toEqual([expect.objectContaining({ reason: "journeys", journey: expect.objectContaining({ id: "quick" }) })]);
    // The page keeps its journey, and the person's step on it is still theirs to undo.
    expect(mode.journeyId).toBe("intake");
    expect(mode.controller).toBe(controller);
    expect(controller.canUndo()).toBe(true);
    // What was handed in is copied, never kept: a later change to it reaches nothing.
    next.journeys![0]!.name = "Changed afterwards";
    expect(mode.journeys[0]!.name).toBe("Step by step");

    // The public setter is a reseed: the designer starts over, its history gone.
    mode.journeyConfiguration = clone(before);
    expect(mode.controller).not.toBe(controller);
    expect(mode.controller.canUndo()).toBe(false);
  });

  it("applyCatalogForAgent() puts a removed journey back at its place, the open designer's history kept", async () => {
    const { mode } = await activated();
    const controller = mode.controller;
    controller.setProperty(pages(controller)[0]!.id, "title", "About");
    const before = clone(mode.journeyConfiguration)!;
    const stored = clone(before.journeys![1]!);
    mode.removeJourney("quick");
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["intake"]);
    const next = clone(mode.journeyConfiguration)!;
    next.journeys!.splice(1, 0, stored);
    mode.applyCatalogForAgent(next, "quick");
    expect(mode.journeyConfiguration).toEqual(before);
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["intake", "quick"]);
    expect(mode.controller).toBe(controller);
    expect(controller.canUndo()).toBe(true);
  });

  it("removeJourney() takes the Step view of the journey shown with it: none of its listeners stay on the form", async () => {
    const { form, mode } = await activated();
    let live = 0;
    const on = form.on.bind(form);
    vi.spyOn(form, "on").mockImplementation(((type: never, listener: never) => {
      live += 1;
      const off = on(type, listener);
      return () => {
        live -= 1;
        off();
      };
    }) as typeof form.on);
    mode.view = "step";
    const withStep = live;
    expect(withStep).toBeGreaterThan(0);
    mode.removeJourney("intake");
    expect(mode.journeyId).toBe("quick");
    expect(mode.view).toBe("step");
    // The page's Step view moved to "quick": one Step view's listeners, not two.
    expect(live).toBe(withStep);
    mode.dispose?.();
    expect(live).toBe(0);
  });

  it("applyCatalogForAgent() moves the page to the first journey left when the catalog no longer lists the one shown", async () => {
    const { mode } = await activated();
    expect(mode.journeyId).toBe("intake");
    const next = clone(mode.journeyConfiguration)!;
    next.journeys = next.journeys!.filter((journey) => journey.id !== "intake");
    mode.applyCatalogForAgent(next, undefined);
    expect(mode.journeyId).toBe("quick");
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["quick"]);
  });

  it("applyCatalogForAgent() chooses the journey it moves the page to: kept there when the one gone comes back, its designer's history kept", async () => {
    const { mode, changes } = await activated();
    // The person opened Quick, edited it, and went back to Intake.
    await mode.selectJourney("quick");
    const quick = mode.controller;
    quick.setProperty(pages(quick)[0]!.id, "title", "All of it");
    expect(quick.canUndo()).toBe(true);
    await mode.selectJourney("intake");
    expect(mode.controller).not.toBe(quick);
    const before = clone(mode.journeyConfiguration)!;

    const without = clone(before);
    without.journeys = without.journeys!.filter((journey) => journey.id !== "intake");
    changes.length = 0;
    mode.applyCatalogForAgent(without, undefined);
    expect(mode.journeyId).toBe("quick");
    // The move is the agent's choice, said as one: Quick's designer is the one built before, not started over.
    expect(changes).toEqual([expect.objectContaining({ reason: "journeys", select: "quick" })]);
    expect(mode.controller).toBe(quick);
    expect(quick.canUndo()).toBe(true);

    // The journey gone comes back (the undo of that undo): the page stays where it was moved to.
    mode.applyCatalogForAgent(before, undefined);
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["intake", "quick"]);
    expect(mode.journeyId).toBe("quick");
    expect(mode.controller).toBe(quick);
  });

  it("newJourney({ around }) writes the catalog in exactly one around step, after the designer's await and never across it", async () => {
    vi.resetModules();
    const designer = held(DESIGNER_MODULE);
    const fresh = await import("../form-engine/builder/journey-designer/journey-builder-mode.js");
    const log: string[] = [];
    const mode = fresh.createJourneyBuilderMode({ form: formController(), journey: seed(), onChange: (detail) => log.push(`change:${detail.reason}`) });
    const around = vi.fn((step: () => void) => {
      log.push("in");
      step();
      log.push("out");
    });
    const pending = mode.newJourney({ from: "sections", name: "Short version", select: false, around });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The designer is still loading: nothing written, no step taken.
    expect(log).toEqual([]);
    expect(around).not.toHaveBeenCalled();
    designer.release();
    const made = await pending;
    expect(around).toHaveBeenCalledTimes(1);
    expect(log).toEqual(["in", "change:journeys", "out"]);
    expect(mode.journeys.map((journey) => journey.id)).toContain(made.id);
    expect(made.name).toBe("Short version");

    // A copy of the journey on the page: its one write through around too.
    log.length = 0;
    const copy = await mode.newJourney({ from: "copy", name: "Copy", select: false, around });
    expect(around).toHaveBeenCalledTimes(2);
    expect(log).toEqual(["in", "change:journeys", "out"]);
    expect(mode.journeys.map((journey) => journey.id)).toContain(copy.id);

    // Without around, as before: the write runs as is.
    log.length = 0;
    await mode.newJourney({ from: "questions", select: false });
    expect(log).toEqual(["change:journeys"]);
    expect(around).toHaveBeenCalledTimes(2);
  });
});

describe("the Step view's inspection", () => {
  const WORDS = { takeOff: "Take it off this step", takeOffBar: "Take off this step" };

  /** The adapter's inspection over the mode's controllers, as the Step view hands it to the mode. */
  async function stepped(pageId = "about") {
    const setup = await activated();
    const adapter = await import("../form-engine/builder/journey-designer/step-canvas-adapter.js");
    const journey = setup.mode.controller;
    const pageNode = (id: string): ComponentNode => pages(journey).find((node) => (node.configuration as { pageId?: string }).pageId === id)!;
    const page = { id: pageNode(pageId).id as string | undefined };
    let on = true;
    const canvas = adapter.createStepCanvas({
      formRoot: () => setup.form.previewSnapshot(),
      pageNodeId: () => page.id,
      journeyId: () => "intake",
      formRevision: () => setup.form.changeRevision(),
      journeyRevision: () => journey.changeRevision()
    });
    const inspection = adapter.createStepInspection({ journey: () => setup.mode.controller, form: setup.form, canvas, words: () => WORDS, active: () => on });
    const placement = (id: string, componentId: string): string =>
      (pageNode(id).children?.[JOURNEY_CONTENT_SLOT] ?? []).find(
        (node) => node.type === JOURNEY_FIELD_TYPE && (node.configuration as { componentId?: string }).componentId === componentId
      )!.id;
    return { ...setup, journey, canvas, inspection, page, pageNode, placement, off: () => (on = false), adapter };
  }

  it("inspects a placement on the form's controller under its form id, and anything else on the journey's", async () => {
    const s = await stepped();
    const fullNameAt = s.placement("about", "fullName");
    s.journey.select(fullNameAt);
    expect(s.inspection.inspection()).toEqual({ controller: s.form, componentId: "fullName" });
    // The step itself is the journey's.
    s.journey.select(s.pageNode("about").id);
    expect(s.inspection.inspection()).toBeUndefined();
    expect(s.inspection.inspectorActions()).toEqual([]);
    // Nothing selected, or the Step view down: the journey's, as before.
    s.journey.select(undefined);
    expect(s.inspection.inspection()).toBeUndefined();
    s.journey.select(fullNameAt);
    s.off();
    expect(s.inspection.inspection()).toBeUndefined();
    expect(s.inspection.inspectorActions()).toEqual([]);
  });

  it("inspects a placed group as the group: a field inside it is the container's", async () => {
    const s = await stepped("more");
    const childrenAt = s.placement("more", "children");
    s.journey.select(childrenAt);
    expect(s.inspection.inspection()).toEqual({ controller: s.form, componentId: "children" });
    // A click on the field inside routes to the group, never the inner field.
    expect(s.canvas.route("childName", s.journey.previewSnapshot()).inspect).toEqual({ controller: "form", componentId: "children", placementId: childrenAt });
  });

  it("offers Take it off this step, one undo step on the journey's controller, the form field untouched", async () => {
    const s = await stepped();
    const fullNameAt = s.placement("about", "fullName");
    s.journey.select(fullNameAt);
    const [action, ...rest] = s.inspection.inspectorActions();
    expect(rest).toEqual([]);
    expect(action).toMatchObject({ id: s.adapter.STEP_TAKE_OFF_ACTION, label: "Take it off this step", deleteLabel: "Take off this step" });
    const formBefore = JSON.stringify(s.form.snapshot());
    action!.run();
    expect((s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT] ?? []).map((node) => node.id)).not.toContain(fullNameAt);
    expect(s.mode.journey?.pages[0]?.components).toEqual(["contactMethod"]);
    expect(JSON.stringify(s.form.snapshot())).toBe(formBefore);
    expect(s.form.canUndo()).toBe(false);
    s.journey.undo();
    expect(s.mode.journey?.pages[0]?.components).toEqual(["fullName", "contactMethod"]);
    expect(s.journey.canUndo()).toBe(false);
  });

  it("tells the shell through notify, and stops once unsubscribed", async () => {
    const s = await stepped();
    let heard = 0;
    const off = s.inspection.subscribeInspection(() => (heard += 1));
    s.inspection.notify();
    expect(heard).toBe(1);
    off();
    s.inspection.notify();
    expect(heard).toBe(1);
  });
});

describe("the Step view in the mode", () => {
  /** The `intake` journey with the mode's Step view up on a step, the way the bar's Step button puts it. */
  async function stepView(pageId = "about") {
    const definition = (type: string): ComponentDefinition => ({ type, version: "1.0.0", createDefault: () => ({ id: type, type, configuration: { label: type } }), capabilities: [] });
    const types = ["text", "number", "file", "dataGrid", "container"];
    const form = new BuilderController({
      initialRoot: formRoot(),
      componentTypes: types.map((type) => ({ type, label: type === "text" ? "Text" : type })),
      componentDefinitions: types.map(definition)
    });
    const changes: JourneyBuilderModeChangeDetail[] = [];
    const errors: string[] = [];
    const mode = createJourneyBuilderMode({
      form,
      journey: seed(),
      formDefinitions: () => types.map(definition),
      onChange: (detail) => changes.push(detail),
      onError: (message) => errors.push(message)
    });
    await mode.activate?.(context());
    const setup = { form, mode, changes, errors };
    const journey = setup.mode.controller;
    const pageNode = (id: string): ComponentNode => pages(journey).find((node) => (node.configuration as { pageId?: string }).pageId === id)!;
    setup.mode.view = "step";
    if (pageId !== "about") {
      journey.select(pageNode(pageId).id);
    }
    const placement = (id: string, componentId: string): string =>
      (pageNode(id).children?.[JOURNEY_CONTENT_SLOT] ?? []).find(
        (node) => node.type === JOURNEY_FIELD_TYPE && (node.configuration as { componentId?: string }).componentId === componentId
      )!.id;
    return { ...setup, journey, pageNode, placement };
  }

  it("opens on the map, and brings the Step view up on the first step and puts it away again", async () => {
    const setup = await activated();
    const journey = setup.mode.controller;
    expect(setup.mode.view).toBe("map");
    expect(journey.canvasStepper()).toBeUndefined();
    expect(journey.canvasRootId()).toBe(journey.rootId());
    expect(setup.mode.inspection?.()).toBeUndefined();
    expect(setup.mode.history?.()).toBeUndefined();
    const revision = journey.canvasRevision();

    setup.mode.view = "step";
    const first = pages(journey)[0]!;
    expect(journey.canvasRootId()).toBe(first.id);
    expect(journey.canvasJourneyView()).toMatchObject({ pageId: "about", number: 1, total: 3 });
    expect(journey.canvasStepper()).toMatchObject({ index: 0, total: 3, label: "About you" });
    // The form's binding, no faces, the chrome the canvas needs.
    expect(journey.canvasComponents()).toBeUndefined();
    expect(journey.canvasRegionOwner()?.id).toBe(first.id);
    expect(journey.canvasRevision()).toBeGreaterThan(revision);
    expect(setup.mode.history?.()).toBeDefined();

    setup.mode.view = "map";
    expect(journey.canvasStepper()).toBeUndefined();
    expect(journey.canvasRootId()).toBe(journey.rootId());
    expect(journey.canvasJourneyView()).toBeUndefined();
    expect(journey.canvasRegionOwner()).toBeUndefined();
    // The designer brings no faces of its own: what the controller was built with is back, which draws nothing the map hides.
    expect(journey.canvasComponents()).toBeUndefined();
    expect(setup.mode.history?.()).toBeUndefined();
  });

  it("steps with the picker: Step 2 of 3 and its name, the step selected, one draw's worth of options", async () => {
    const s = await stepView();
    const [about, more, finish] = pages(s.journey);
    const picker = s.journey.canvasStepper()!;
    expect(picker).toMatchObject({ index: 0, total: 3 });
    picker.go(1);
    expect(s.journey.canvasRootId()).toBe(more!.id);
    expect(s.journey.selectedComponentId()).toBe(more!.id);
    expect(s.journey.canvasStepper()).toMatchObject({ index: 1, total: 3 });
    expect(s.journey.canvasJourneyView()).toMatchObject({ pageId: "more", number: 2 });
    s.journey.canvasStepper()!.go(1);
    expect(s.journey.canvasRootId()).toBe(finish!.id);
    // The last step has no next; going past it does nothing.
    s.journey.canvasStepper()!.go(1);
    expect(s.journey.canvasStepper()).toMatchObject({ index: 2 });
    s.journey.canvasStepper()!.go(-1);
    s.journey.canvasStepper()!.go(-1);
    expect(s.journey.canvasRootId()).toBe(about!.id);
    // Moving between steps is no edit: nothing to undo, nothing reported.
    expect(s.journey.canUndo()).toBe(false);
    expect(s.changes).toEqual([]);
  });

  it("follows a selection on another step: the Step view moves there", async () => {
    const s = await stepView();
    const consentAt = s.placement("finish", "consent");
    s.journey.select(consentAt);
    expect(s.journey.canvasRootId()).toBe(s.pageNode("finish").id);
    expect(s.journey.canvasStepper()).toMatchObject({ index: 2 });
    // A selection on the step shown moves nothing; neither does none.
    s.journey.select(s.placement("finish", "submit"));
    expect(s.journey.canvasRootId()).toBe(s.pageNode("finish").id);
    s.journey.select(undefined);
    expect(s.journey.canvasRootId()).toBe(s.pageNode("finish").id);
    // A route is a node of its step.
    const route = (s.pageNode("about").children?.[JOURNEY_ROUTES_SLOT] ?? [])[0]!;
    s.journey.select(route.id);
    expect(s.journey.canvasRootId()).toBe(s.pageNode("about").id);
  });

  it("answers the shell for a form field placed on the step: the form's inspector and Take it off this step", async () => {
    const s = await stepView();
    let heard = 0;
    s.mode.subscribeInspection?.(() => (heard += 1));
    const fullNameAt = s.placement("about", "fullName");
    s.journey.select(fullNameAt);
    expect(s.mode.inspection?.()).toEqual({ controller: s.form, componentId: "fullName" });
    const [action] = s.mode.inspectorActions?.() ?? [];
    expect(action).toMatchObject({ label: "Take it off this step", deleteLabel: "Take off this step" });
    // The step itself is the journey's own.
    s.journey.select(s.pageNode("about").id);
    expect(s.mode.inspection?.()).toBeUndefined();
    // A move to another step is told to the shell.
    const before = heard;
    s.journey.canvasStepper()!.go(1);
    expect(heard).toBeGreaterThan(before);
    // The Map and Pages views inspect on the journey's own controller.
    s.journey.select(fullNameAt);
    s.mode.view = "map";
    expect(s.mode.inspection?.()).toBeUndefined();
    expect(s.mode.inspectorActions?.()).toEqual([]);
  });

  it("offers Ask differently here on a value field placed on the step, which replaces it with a field of the journey's own in one undo", async () => {
    const s = await stepView();
    const fullNameAt = s.placement("about", "fullName");
    s.journey.select(fullNameAt);
    const actions = s.mode.inspectorActions?.() ?? [];
    expect(actions.map((action) => [action.id, action.label])).toEqual([
      ["take-off", "Take it off this step"],
      ["ask-differently", "Ask differently here…"]
    ]);
    actions[1]!.run();
    await vi.waitFor(() => expect(s.journey.selectedComponentId()).not.toBe(fullNameAt));
    const own = s.journey.selectedComponentId()!;
    const node = (s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT] ?? []).find((entry) => entry.id === own)!;
    expect(node).toMatchObject({ type: "text", configuration: { fills: "fullName" } });
    expect((s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT] ?? []).some((entry) => entry.id === fullNameAt)).toBe(false);
    // The field of the journey's own offers no Ask differently: it is inspected on the journey's controller.
    expect((s.mode.inspectorActions?.() ?? []).some((action) => action.id === "ask-differently")).toBe(false);
    s.journey.undo();
    expect((s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT] ?? []).some((entry) => entry.id === fullNameAt)).toBe(true);
  });

  it("holds one Undo over the form and the journey while the Step view is up", async () => {
    const s = await stepView();
    let heard = 0;
    s.mode.subscribeHistory?.(() => (heard += 1));
    s.form.setProperty("fullName", "label", "Your full name");
    expect(heard).toBeGreaterThan(0);
    const history = s.mode.history!()!;
    expect(history.canUndo()).toBe(true);
    // One turn is one entry: the journey's step is made in another.
    await Promise.resolve();
    s.journey.requestAdd("text", s.pageNode("about").id, JOURNEY_CONTENT_SLOT);
    expect(history.undo()).toBe(true);
    expect(pages(s.journey)[0]?.children?.[JOURNEY_CONTENT_SLOT]).toHaveLength(2);
    expect(history.undo()).toBe(true);
    expect((s.form.snapshot().children?.content ?? []).find((node) => node.id === "fullName")?.configuration).toMatchObject({ label: "Full name" });
  });

  it("opens the Wording section when the step's buttons are pressed, not its heading, and folds it again on another selection", async () => {
    const s = await stepView();
    const about = s.pageNode("about");
    s.journey.select(about.id);
    const wording = (): boolean => s.journey.inspectorModel()?.sections.find((section) => section.id === "wording")?.folded === true;
    expect(wording()).toBe(true);
    s.journey.canvasRegionOwner()!.onPress!("heading");
    expect(wording()).toBe(true);
    s.journey.canvasRegionOwner()!.onPress!("buttons");
    expect(wording()).toBe(false);
    s.journey.select(s.placement("about", "fullName"));
    s.journey.select(about.id);
    expect(wording()).toBe(true);
  });

  it("places the palette's content on an ending, where the Form fields panel refuses a form field", async () => {
    const s = await stepView();
    const about = s.pageNode("about");
    s.journey.setProperty(about.id, "kind", "exit");
    expect(s.mode.formFields!.refusal?.()).toBe("An ending sends nothing, so a form field on it would never be checked.");
    expect(s.mode.formFields!.add("notes")).toBe(false);
    const before = (s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT] ?? []).length;
    s.journey.requestAdd("text", about.id, JOURNEY_CONTENT_SLOT);
    expect(s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT]).toHaveLength(before + 1);
    expect(s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT]?.at(-1)?.type).toBe("text");
    s.journey.undo();
    expect(s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT]).toHaveLength(before);
  });

  it("lists in the Step view's palette the journey-only fields and the worked-out value, not Step, Form field or Route, and still takes a form field", async () => {
    const s = await stepView();
    const listed = (): string[] => s.journey.offeredTypes().map((entry) => `${entry.group} / ${entry.label}`);
    expect(listed()).toContain("Fields / Text");
    expect(listed().join("|")).not.toContain("Journey-only");
    expect(listed()).toContain("Journey / Worked-out value");
    for (const hidden of ["Journey / Step", "Journey / Form field", "Journey / Route"]) {
      expect(listed()).not.toContain(hidden);
    }
    // Not listed yet still offered: a form field is placed on the step, as the Form fields panel does.
    expect(s.journey.componentTypes().map((entry) => entry.type)).toContain(JOURNEY_FIELD_TYPE);
    const aboutNode = s.pageNode("about");
    const before = (aboutNode.children?.[JOURNEY_CONTENT_SLOT] ?? []).length;
    s.journey.requestAdd(JOURNEY_FIELD_TYPE, aboutNode.id, JOURNEY_CONTENT_SLOT, { configuration: { componentId: "notes" } });
    expect(s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT]).toHaveLength(before + 1);
    s.journey.undo();
    expect(s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT]).toHaveLength(before);
    // A palette click with nothing selected adds to the step shown, never the last place in the tree.
    s.journey.select(undefined);
    s.journey.requestAddAfter("number");
    expect(s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT]?.at(-1)?.type).toBe("number");
    expect(s.pageNode("finish").children?.[JOURNEY_CONTENT_SLOT]?.map((node) => node.type)).not.toContain("number");
    s.journey.undo();
    // A palette entry makes a journey-only field on the step: one undo.
    s.journey.requestAdd("text", aboutNode.id, JOURNEY_CONTENT_SLOT);
    const added = s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT]?.at(-1);
    expect(added?.type).toBe("text");
    s.journey.undo();
    expect(s.pageNode("about").children?.[JOURNEY_CONTENT_SLOT]).toHaveLength(before);
    // Out of the Step view the palette is whole again.
    s.mode.view = "map";
    expect(listed()).toContain("Journey / Step");
    expect(listed()).toContain("Journey / Form field");
    expect(listed()).toContain("Journey / Route");
  });

  it("offers no type the engine forbids as journey-only", async () => {
    const s = await stepView();
    const forbidden = ["repeatingSection", "dataGrid", "file", "signature", "steps", "step", "container", "wizard"];
    const offered = s.journey.offeredTypes().map((entry) => entry.type);
    expect(offered.filter((type) => forbidden.includes(type))).toEqual([]);
  });

  it("does the form-change work for a commit but, for a draft's keystroke, only redraws the step the draft is drawn on", async () => {
    const s = await stepView();
    const repaint = vi.spyOn(s.journey, "repaintPreview");
    s.form.select("fullName");
    // A draft: the journeys read the committed form, so only the Step view, which draws the draft, draws again.
    s.form.setDraftProperty("fullName", "label", "Draft label");
    expect(repaint).toHaveBeenCalledTimes(1);
    expect(s.form.previewSnapshot().children?.content?.[0]?.configuration).toMatchObject({ label: "Draft label" });
    // The Map view draws nothing of the form's draft: not even a repaint.
    s.mode.view = "map";
    repaint.mockClear();
    s.form.setDraftProperty("fullName", "label", "Another draft");
    expect(repaint).not.toHaveBeenCalled();
    // The commit is worked on whole.
    s.form.commitDraft("fullName");
    expect(repaint).toHaveBeenCalled();
  });

  it("draws the step with the form's binding and colour scheme, and follows a binding picked or the builder's scheme switched while it is up", async () => {
    const s = await stepView();
    expect(s.journey.canvasColorScheme()).toBe("light");
    // The shell gives the builder's scheme to the form's controller only: the step is drawn in the form's.
    s.form.setPreviewScheme("dark");
    expect(s.form.canvasColorScheme()).toBe("dark");
    expect(s.journey.canvasColorScheme()).toBe("dark");
    s.form.setPreviewScheme("light");
    expect(s.journey.canvasColorScheme()).toBe("light");
    // A binding picked with the view up reaches the step.
    s.form.setOptions({ binding: "govuk" });
    expect(s.form.canvasBinding()).toBe("govuk");
    expect(s.journey.canvasBinding()).toBe("govuk");
    expect(s.journey.canvasColorScheme()).toBe(s.form.canvasColorScheme());
    // And across a round trip through another workspace.
    s.mode.deactivate?.();
    s.form.setOptions({ binding: undefined });
    s.form.setPreviewScheme("dark");
    await s.mode.activate?.(context());
    expect(s.journey.canvasBinding()).toBeUndefined();
    expect(s.journey.canvasColorScheme()).toBe("dark");
    // Out of the Step view the journey's controller keeps nothing of the form's: the map draws with none.
    s.form.setOptions({ binding: "govuk" });
    expect(s.journey.canvasBinding()).toBe("govuk");
    s.mode.view = "map";
    expect(s.journey.canvasColorScheme()).toBe("light");
    expect(s.journey.canvasBinding()).toBeUndefined();
  });

  it("leaves the Step view through the inspector's guard: Map waits on a form field's unsaved edit", async () => {
    const s = await stepView();
    const held: Array<() => void> = [];
    const guarded = { ...context(), holdForInspector: (run: () => void): boolean => (held.push(run), false) };
    s.mode.deactivate?.();
    await s.mode.activate?.(guarded);
    expect(s.mode.view).toBe("step");
    s.mode.view = "map";
    // Held: still the Step view until the author answers.
    expect(held).toHaveLength(1);
    expect(s.mode.view).toBe("step");
    expect(s.mode.history?.()).toBeDefined();
    held[0]!();
    expect(s.mode.view).toBe("map");
    expect(s.mode.history?.()).toBeUndefined();
    // Out of the Step view nothing is held: the Step view comes up at once.
    s.mode.view = "step";
    expect(held).toHaveLength(1);
    expect(s.mode.view).toBe("step");
  });

  it("moves to another step in one change: the step shown is the new one when the selection lands; a held selection leaves the step where it was", async () => {
    const s = await stepView();
    const [about, more] = pages(s.journey);
    const roots: string[] = [];
    const off = s.journey.on("change", () => roots.push(s.journey.canvasRootId()));
    s.journey.canvasStepper()!.go(1);
    off();
    expect(roots).toEqual([more!.id]);
    expect(s.journey.selectedComponentId()).toBe(more!.id);
    // An unsaved edit on the journey holds the move: the author answers, the step stays.
    s.journey.setDraftProperty(more!.id, "title", "More about you");
    s.journey.canvasStepper()!.go(-1);
    expect(s.journey.canvasRootId()).toBe(more!.id);
    expect(s.journey.selectedComponentId()).toBe(more!.id);
    expect(about).toBeDefined();
  });

  it("says in the inspector what the step's drawing left out: a field placed before the container around it", async () => {
    const s = await stepView();
    const root = formRoot();
    root.children!.content!.push({ id: "address", type: "panel", configuration: { label: "Address" }, children: { content: [{ id: "street", type: "text", configuration: { label: "Street" } }] } });
    s.form.setOptions({ initialRoot: root });
    s.mode.replaceJourney("intake", {
      id: "intake",
      name: "Step by step",
      pages: [
        { id: "about", components: ["fullName"] },
        { id: "more", components: ["street", "address"] }
      ]
    } as Journey);
    s.journey.select(s.pageNode("more").id);
    const placements = (s.pageNode("more").children?.[JOURNEY_CONTENT_SLOT] ?? []).map((node) => node.id);
    const notes = placements.flatMap((id) => s.journey.notesOf(id).map((note) => note.message));
    expect(notes.some((message) => message.includes("Street") && message.includes("not drawn again here"))).toBe(true);
    // It is one of the journey's findings, so it stands out of the Step view too, and the findings card and the map's counts carry it.
    s.mode.view = "map";
    expect(placements.flatMap((id) => s.journey.notesOf(id).map((note) => note.message)).some((message) => message.includes("not drawn again here"))).toBe(true);
    const twice = s.mode.findings?.().filter((found) => found.message.includes("not drawn again here")) ?? [];
    expect(twice).toHaveLength(1);
    expect(twice[0]?.severity).toBe("warning");
    expect(twice[0]?.select).toBeDefined();
  });

  it("starts the Step view over when its designer is built again", async () => {
    const s = await stepView();
    s.journey.canvasStepper()!.go(1);
    const replacement = { ...(seed().journeys![0] as Journey), name: "Step by step", pages: [{ id: "solo", components: ["fullName"] }, { id: "duo", components: ["notes"] }] } as Journey;
    s.mode.replaceJourney("intake", replacement);
    expect(s.journey.canvasStepper()).toMatchObject({ index: 0, total: 2 });
    expect(s.journey.canvasRootId()).toBe(pages(s.journey)[0]!.id);
  });
});

describe("a blank journey, its findings card and the Form fields panel", () => {
  /** A form with its required fields, and a journey made blank: the shape a new journey starts as. */
  async function blank() {
    const form = formController();
    form.setProperty("consent", "required", true);
    form.setProperty("fullName", "required", true);
    const errors: string[] = [];
    const mode = createJourneyBuilderMode({ form, journey: undefined, onError: (message) => errors.push(message) });
    await mode.activate?.(context());
    const made = await mode.newJourney({ name: "Quick", from: "blank" });
    return { form, mode, made, errors, journey: mode.controller };
  }

  it("makes a new journey as one empty questions step titled Step 1, on the map, with no field from the form", async () => {
    const { mode, made, journey } = await blank();
    expect(made.pages).toEqual([{ id: "step-1", title: "Step 1", components: [] }]);
    expect(mode.journeyId).toBe("quick");
    expect(mode.view).toBe("map");
    expect(mode.journey?.pages).toHaveLength(1);
    expect(pages(journey)).toHaveLength(1);
    // The step id is the first the form does not use.
    const taken = formController();
    taken.setProperty("notes", "label", "x");
    const again = await mode.newJourney({ name: "Another", from: "blank" });
    expect(again.pages[0]?.id).toBe("step-1");
  });

  it("starts with the form's required fields as errors, errors before warnings, each with its fixes", async () => {
    const { mode } = await blank();
    const found = mode.findings?.() ?? [];
    const severities = found.map((entry) => entry.severity);
    expect(severities).toEqual([...severities].sort((a, b) => (a === b ? 0 : a === "error" ? -1 : 1)));
    const consent = found.find((entry) => entry.message.includes("I agree") && entry.severity === "error")!;
    expect(consent.message).toBe("I agree is required and is not asked in this journey. A submission is refused.");
    expect(consent.fixes.map((fix) => fix.label)).toEqual(["Ask it here", "Make it optional on the form"]);
    // A field that is not required is a warning with no fix.
    const notes = found.find((entry) => entry.message.includes("Notes"))!;
    expect(notes.severity).toBe("warning");
    expect(notes.fixes).toEqual([]);
    expect(found.filter((entry) => entry.severity === "error").length).toBeGreaterThanOrEqual(2);
  });

  it("asks a required field on the step from its finding, in one undo, and the finding goes", async () => {
    const { mode, journey } = await blank();
    const before = mode.findings?.().length ?? 0;
    const consent = mode.findings?.().find((entry) => entry.message.includes("I agree") && entry.severity === "error")!;
    consent.fixes.find((fix) => fix.label === "Ask it here")!.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mode.journey?.pages[0]?.components).toEqual(["consent"]);
    expect(mode.findings?.().some((entry) => entry.message.includes("I agree") && entry.severity === "error")).toBe(false);
    // The finding goes, and the count with it.
    expect(mode.findings?.().length).toBeLessThan(before);
    journey.undo();
    expect(mode.journey?.pages[0]?.components ?? []).toEqual([]);
  });

  it("opens the form field from Make it optional on the form, and selects a finding's node", async () => {
    const form = formController();
    form.setProperty("consent", "required", true);
    const mode = createJourneyBuilderMode({ form, journey: { journeys: [{ id: "j", pages: [{ id: "about", components: ["fullName", "ghost"] }] }] } });
    await mode.activate?.(context());
    const journey = mode.controller;
    const found = mode.findings?.() ?? [];
    found.find((entry) => entry.message.includes("I agree"))!.fixes.find((fix) => fix.id === "optional")!.run();
    expect(form.selectedComponentId()).toBe("consent");
    // A placement whose form field is gone: Remove takes it off, in one undo, and selecting it selects the node.
    const ghost = found.find((entry) => entry.fixes.some((fix) => fix.id === "remove"))!;
    expect(ghost.select).toBeDefined();
    ghost.select!();
    const question = (pages(journey)[0]!.children?.[JOURNEY_CONTENT_SLOT] ?? [])[1]!;
    expect(journey.selectedComponentId()).toBe(question.id);
    ghost.fixes.find((fix) => fix.id === "remove")!.run();
    expect(mode.journey?.pages[0]?.components).toEqual(["fullName"]);
    expect(mode.findings?.().some((entry) => entry.fixes.some((fix) => fix.id === "remove"))).toBe(false);
    journey.undo();
    expect(mode.journey?.pages[0]?.components).toEqual(["fullName", "ghost"]);
  });

  it("tells the findings listeners only when the findings changed", async () => {
    const { mode, form } = await blank();
    let heard = 0;
    const off = mode.subscribeFindings?.(() => (heard += 1));
    form.setProperty("notes", "label", "Notes, again");
    const after = heard;
    // A form edit that changes no finding's words says nothing; one that does says it once.
    form.setProperty("consent", "required", false);
    expect(heard).toBeGreaterThan(after);
    const settled = heard;
    form.setProperty("consent", "required", false);
    expect(heard).toBe(settled);
    off?.();
  });

  it("offers the Form fields panel only while the Step view is up, in form order, not on a step first", async () => {
    const { mode, form } = await blank();
    const fields = mode.formFields!;
    expect(fields.offered()).toBe(false);
    expect(fields.rows()).toEqual([]);
    const offers: boolean[] = [];
    const off = fields.subscribe(() => offers.push(fields.offered()));
    mode.view = "step";
    expect(fields.offered()).toBe(true);
    expect(offers.at(-1)).toBe(true);
    const rows = fields.rows();
    expect(rows.map((row) => row.id)).toEqual(["fullName", "contactMethod", "children", "consent", "notes"]);
    expect(rows.every((row) => row.where === "none" && row.steps.length === 0)).toBe(true);
    expect(rows.find((row) => row.id === "fullName")).toMatchObject({ label: "Full name", required: true });
    expect(form.getProperty("fullName", "required")).toBe(true);
    mode.view = "map";
    expect(offers.at(-1)).toBe(false);
    expect(fields.offered()).toBe(false);
    off();
  });

  it("places a field on the step shown from the panel in one undo, shows it as on this step, and never offers it twice", async () => {
    const { mode, journey } = await blank();
    mode.view = "step";
    const fields = mode.formFields!;
    expect(fields.add("notes")).toBe(true);
    expect(mode.journey?.pages[0]?.components).toEqual(["notes"]);
    expect(fields.rows().find((row) => row.id === "notes")).toMatchObject({ where: "here", steps: ["Step 1"] });
    // Already on this step: nothing is placed again.
    expect(fields.add("notes")).toBe(false);
    expect(mode.journey?.pages[0]?.components).toEqual(["notes"]);
    // One Undo takes the placement back; the step view's history is the journey's, and the field is on no step again.
    mode.history?.()?.undo();
    expect(mode.journey?.pages[0]?.components ?? []).toEqual([]);
    expect(fields.rows().find((row) => row.id === "notes")?.where).toBe("none");
    expect(journey.canUndo()).toBe(false);
    expect(fields.add("")).toBe(false);
    expect(fields.drag("notes")).toEqual({ type: JOURNEY_FIELD_TYPE, configuration: { componentId: "notes" } });
  });

  it("marks a field on another step with that step's name, and still offers it", async () => {
    const { mode } = await activated();
    mode.view = "step";
    const fields = mode.formFields!;
    const rows = fields.rows();
    // A step with no title of its own is named by its first question, as the map and the cards name it.
    expect(rows.find((row) => row.id === "consent")).toMatchObject({ where: "other", steps: ["I agree"] });
    expect(rows.find((row) => row.id === "fullName")).toMatchObject({ where: "here", steps: ["About you"] });
    // Placed where it is already asked elsewhere: allowed, and the journey says so as it does for any such field.
    expect(fields.add("consent")).toBe(true);
    expect(fields.rows().find((row) => row.id === "consent")).toMatchObject({ where: "here" });
  });

  it("runs the fix-its of the journey's own fields from the findings: Fill a form field selects the field, Remove this worked-out value takes it off in one undo", async () => {
    const { mode } = await activated({
      journeys: [
        {
          id: "own",
          pages: [
            {
              id: "a",
              components: [
                "fullName",
                { id: "nick", type: "text", configuration: { label: "Nick" } },
                { id: "again", type: "journey-value", configuration: { to: "fullName", value: { kind: "path", path: "nick" } } },
                // Read by nothing and filling nothing: its answer goes nowhere.
                { id: "lonely", type: "text", configuration: { label: "Lonely" } }
              ]
            }
          ]
        }
      ]
    });
    const found = mode.findings?.() ?? [];
    const fill = found.flatMap((entry) => entry.fixes).find((fix) => fix.id === "fill");
    const remove = found.flatMap((entry) => entry.fixes).find((fix) => fix.label === "Remove this worked-out value");
    expect(fill?.label, JSON.stringify(found.map((entry) => [entry.message, entry.fixes.map((fix) => fix.id)]))).toBe("Fill a form field…");
    expect(remove).toBeDefined();
    fill!.run();
    expect(mode.controller.selectedComponentId()).toBe("lonely");
    remove!.run();
    expect(mode.journey?.pages[0]?.components?.map((entry) => (typeof entry === "string" ? entry : entry.id))).toEqual(["fullName", "nick", "lonely"]);
    mode.controller.undo();
    expect(mode.journey?.pages[0]?.components?.map((entry) => (typeof entry === "string" ? entry : entry.id))).toEqual(["fullName", "nick", "again", "lonely"]);
  });

  it("places no form field on a Check answers step or an ending from the panel, by click or drag, and says why", async () => {
    const { mode } = await activated({
      journeys: [
        {
          id: "intake",
          pages: [
            { id: "about", title: "About you", components: ["fullName"], routes: [{ when: { kind: "path", path: "consent" }, to: "bye" }] },
            { id: "check", kind: "review", title: "Check your answers", components: [] },
            { id: "bye", kind: "exit", title: "Goodbye", components: [] }
          ]
        }
      ]
    });
    const fields = mode.formFields!;
    mode.view = "step";
    expect(fields.refusal?.()).toBeUndefined();
    expect(fields.drag("notes")).toBeDefined();
    for (const words of ["A Check answers step lists the answers. It asks no form field.", "An ending sends nothing, so a form field on it would never be checked."]) {
      // The picker's next: the Check answers step, then the ending.
      mode.controller.canvasStepper()!.go(1);
      expect(fields.refusal?.()).toBe(words);
      expect(fields.add("notes")).toBe(false);
      expect(fields.drag("notes")).toBeUndefined();
    }
    expect(mode.journey?.pages.map((page) => page.components ?? [])).toEqual([["fullName"], [], []]);
    // A step's Logic tab: its Go to rules then Otherwise; a Check answers step and an ending try none and offer no New rule.
    const ways = (at: number) => {
      const found = rules(mode).ways!(pages(mode.controller)[at]!.id)!;
      return { note: found.note, rows: found.rows.map((row) => [row.title, row.reads, typeof row.open]), newRule: found.newRule?.label };
    };
    expect(ways(0)).toEqual({
      note: "Tried in order: the first rule that holds is taken. Each opens in the Logic editor.",
      rows: [
        ["1 · Go to Goodbye", expect.stringMatching(/^Go to Goodbye when I agree /), "function"],
        ["Otherwise · Go to Check your answers", undefined, "undefined"]
      ],
      newRule: "New rule"
    });
    const never = "Its rules are never tried: an ending stops the journey, and a Check answers step goes on to the end.";
    expect(ways(1)).toEqual({ note: never, rows: [], newRule: undefined });
    expect(ways(2)).toEqual({ note: never, rows: [], newRule: undefined });
    expect(rules(mode).ways!(pages(mode.controller)[0]!.children!.routes![0]!.id)).toBeUndefined();
    // A questions step takes them again.
    mode.controller.canvasStepper()!.go(-1);
    mode.controller.canvasStepper()!.go(-1);
    expect(fields.refusal?.()).toBeUndefined();
    expect(fields.add("notes")).toBe(true);
  });

  it("keeps Otherwise on a step's Logic tab when its rule with no condition goes nowhere later, as the walk falls through", async () => {
    const { mode } = await activated({
      journeys: [
        {
          id: "intake",
          pages: [
            { id: "about", title: "About you", components: ["fullName"], routes: [{ to: "gone" }] },
            { id: "more", title: "More", components: ["contactMethod"], routes: [{ to: "about" }] },
            { id: "last", title: "Last", components: ["notes"], routes: [{ to: "$end" }] }
          ]
        }
      ]
    });
    const ways = (at: number) => rules(mode).ways!(pages(mode.controller)[at]!.id)!.rows.map((row) => [row.title, row.reads]);
    // To an unknown step and back to an earlier one: the walk ignores both and goes on to the next step.
    expect(ways(0)).toEqual([
      ["1 · Go to “gone”", "Go to “gone” always"],
      ["Otherwise · Go to More", undefined]
    ]);
    expect(ways(1)).toEqual([
      ["1 · Go to About you", "Go to About you always"],
      ["Otherwise · Go to Last", undefined]
    ]);
    // To the end: it always holds, so nothing falls through.
    expect(ways(2)).toEqual([["1 · Go to the end", "Go to the end always"]]);
  });
});

describe("a Check answers step in the mode", () => {
  /** `intake`'s two question steps and a Check answers step after them, over this file's form. */
  function reviewed(review?: Record<string, unknown>, extra: Array<Record<string, unknown>> = []): JourneyConfiguration {
    return {
      journeys: [
        {
          id: "intake",
          name: "Step by step",
          pages: [
            { id: "about", title: "About you", components: ["fullName", "contactMethod"] },
            { id: "more", title: "More", components: ["consent", "notes"] },
            { id: "check", kind: "review", title: "Check your answers", ...(review ? { review } : {}), components: [] },
            ...extra
          ]
        }
      ]
    } as unknown as JourneyConfiguration;
  }

  const sectionIds = (controller: BuilderController, pageNodeId: string): string[] => (controller.inspectorModel(pageNodeId)?.sections ?? []).map((section) => section.id);
  const fieldOf = (controller: BuilderController, pageNodeId: string, path: string) =>
    controller
      .inspectorModel(pageNodeId)
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.propertyPath === path);

  it("offers Check answers in the Kind box, and its own section only on such a step", async () => {
    const { mode } = await activated(reviewed());
    const controller = mode.controller;
    const [about, , check] = pages(controller);
    const kind = fieldOf(controller, about!.id, "kind")!;
    expect(kind.choices.map((choice) => choice.label)).toEqual(["Questions", "Exit: content only, the journey stops here", "Check answers"]);
    expect(sectionIds(controller, about!.id)).toEqual(["page", "validation", "wording"]);
    expect(sectionIds(controller, check!.id)).toEqual(["page", "review", "validation", "wording"]);
    expect(fieldOf(controller, check!.id, "kind")!.value).toBe("review");
  });

  it("lists, under Answers listed, the count and what each step brings, read-only", async () => {
    const { mode } = await activated(reviewed({ labels: { contactMethod: "How should we reach you?" } }));
    const controller = mode.controller;
    const check = pages(controller)[2]!;
    const listed = fieldOf(controller, check.id, "review.listed")!;
    expect(listed.control).toBe("custom");
    expect(listed.choices).toEqual([
      { value: "", label: "4 answers listed" },
      { value: "fullName", label: "Full name", group: "About you" },
      { value: "contactMethod", label: "How should we reach you?", group: "About you" },
      { value: "consent", label: "I agree", group: "More" },
      { value: "notes", label: "Notes", group: "More" }
    ]);
    // Read-only: no box carries it.
    expect(fieldOf(controller, check.id, "review.emptyOptional")).toMatchObject({ control: "select", value: undefined });
    expect(fieldOf(controller, check.id, "review.emptyOptional")!.choices.map((choice) => choice.label)).toEqual(["Show “Not provided”", "Leave it out"]);
    expect(fieldOf(controller, check.id, "review.change")).toMatchObject({ control: "checkbox", value: true, label: "Show Change links" });
  });

  it("says so when there is nothing to list yet", async () => {
    const { mode } = await activated({ journeys: [{ id: "j", pages: [{ id: "check", kind: "review", components: [] }] }] } as unknown as JourneyConfiguration);
    const check = pages(mode.controller)[0]!;
    expect(fieldOf(mode.controller, check.id, "review.listed")!.choices).toEqual([{ value: "", label: "Nothing to list yet: ask a question on an earlier step." }]);
  });

  it("writes the step's settings as the engine reads them, and nothing for what is the default", async () => {
    const { mode } = await activated(reviewed());
    const controller = mode.controller;
    const check = pages(controller)[2]!;
    const written = (): unknown => mode.journey?.pages.find((page) => page.id === "check")?.review;
    controller.select(check.id);
    controller.setDraftProperty(check.id, "review.emptyOptional", "omit");
    controller.setDraftProperty(check.id, "review.change", false);
    expect(controller.commitDraft(check.id)).toBe(true);
    expect(written()).toEqual({ emptyOptional: "omit", change: false });
    // A select set back to its blank choice leaves no key; Change links off stays as written.
    controller.setDraftProperty(check.id, "review.emptyOptional", "");
    expect(controller.commitDraft(check.id)).toBe(true);
    expect(written()).toEqual({ change: false });
    controller.setDraftProperty(check.id, "review.change", true);
    expect(controller.commitDraft(check.id)).toBe(true);
    expect(written()).toEqual({ change: true });
    // Everything written is a usable journey.
    expect(validateJourneyShape(mode.journey)).toEqual([]);
  });

  it("refuses the Kind box on a step that asks form fields, in the check's own words, and says nothing of one already there", async () => {
    const { mode } = await activated(reviewed());
    const controller = mode.controller;
    const [about] = pages(controller);
    controller.select(about!.id);
    controller.setDraftProperty(about!.id, "kind", "review");
    const problems = controller.problemsOf(about!.id);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ target: "kind" });
    expect(problems[0]!.message).toContain("Step “About you” is a Check answers step and lists Full name");
    expect(problems[0]!.message).toContain("Ask it on an earlier step.");
    expect(controller.commitDraft(about!.id)).toBe(false);
    expect(mode.journey?.pages[0]?.kind).toBeUndefined();
    // Taken off first, it is a Check answers step.
    controller.discardDraft(about!.id);
    controller.setDraftProperty(about!.id, "kind", "questions");
    expect(controller.problemsOf(about!.id)).toEqual([]);
  });

  it("lets a step with nothing of the form on it become a Check answers step, own content kept", async () => {
    const { mode } = await activated({ journeys: [{ id: "j", pages: [{ id: "about", components: ["fullName"] }, { id: "declare", components: [{ id: "note", type: "text", configuration: { label: "Declaration" } }] }] }] } as unknown as JourneyConfiguration);
    const declare = pages(mode.controller)[1]!;
    mode.controller.select(declare.id);
    mode.controller.setDraftProperty(declare.id, "kind", "review");
    expect(mode.controller.problemsOf(declare.id)).toEqual([]);
    expect(mode.controller.commitDraft(declare.id)).toBe(true);
    expect(mode.journey?.pages[1]?.kind).toBe("review");
  });

  describe("on the step's canvas", () => {
    it("opens a Wording box for the row pressed, in the Wording section, writing the step's wording for that field", async () => {
      const { mode } = await activated(reviewed());
      const controller = mode.controller;
      const check = pages(controller)[2]!;
      mode.view = "step";
      controller.select(check.id);
      const wording = () => controller.inspectorModel(check.id)?.sections.find((section) => section.id === "wording");
      expect(wording()?.fields.map((field) => field.propertyPath)).toEqual(["texts.continue", "texts.submit", "texts.back"]);
      expect(wording()?.folded).toBe(true);
      // The step's own rows are named by the drawing's ids: `<step>__review-<value path>`.
      controller.canvasRegionOwner()!.onPress!("heading", "check__review-contactMethod");
      expect(wording()?.folded).toBeFalsy();
      const box = wording()!.fields[0]!;
      expect(box).toMatchObject({ propertyPath: "review.labels.contactMethod", control: "localized-text", label: "Wording of Contact method" });
      controller.setDraftProperty(check.id, "review.labels.contactMethod", "How should we reach you?");
      expect(controller.commitDraft(check.id)).toBe(true);
      expect(mode.journey?.pages[2]?.review).toEqual({ labels: { contactMethod: "How should we reach you?" } });
      // Blank is the field's own label again, and no key.
      controller.setDraftProperty(check.id, "review.labels.contactMethod", "");
      expect(controller.commitDraft(check.id)).toBe(true);
      expect(mode.journey?.pages[2]?.review).toBeUndefined();
      // A press on the heading puts the row's box away; another selection folds the section.
      controller.canvasRegionOwner()!.onPress!("heading");
      expect(wording()?.fields.map((field) => field.propertyPath)).toEqual(["texts.continue", "texts.submit", "texts.back"]);
    });

    it("opens no row's box for a press that lands on no row", async () => {
      const { mode } = await activated(reviewed());
      const controller = mode.controller;
      const check = pages(controller)[2]!;
      mode.view = "step";
      controller.select(check.id);
      controller.canvasRegionOwner()!.onPress!("heading", "check__review-section-about");
      controller.canvasRegionOwner()!.onPress!("heading", "elsewhere");
      const wording = controller.inspectorModel(check.id)?.sections.find((section) => section.id === "wording");
      expect(wording?.folded).toBe(true);
      expect(wording?.fields.map((field) => field.propertyPath)).toEqual(["texts.continue", "texts.submit", "texts.back"]);
    });

    it("draws the step as a Check answers step: the whole journey, the path, and the step submits", async () => {
      const { mode } = await activated(reviewed());
      const controller = mode.controller;
      mode.view = "step";
      controller.select(pages(controller)[2]!.id);
      const view = controller.canvasJourneyView()!;
      expect(view).toMatchObject({ kind: "review", pageId: "check", final: true, number: 3, total: 3, path: ["about", "more", "check"] });
      expect(view.journey.pages.map((page) => page.id)).toEqual(["about", "more", "check"]);
      expect(view.pageOf).toMatchObject({ fullName: "about", contactMethod: "about", consent: "more", notes: "more" });
      // The form rides in a slot the canvas never offers a drop on.
      expect(controller.canvasTreeView().slots.map((slot) => slot.slotId)).toEqual([JOURNEY_CONTENT_SLOT]);
    });
  });

  describe("its findings in the Journey panel", () => {
    const fixOf = (found: ReturnType<NonNullable<JourneyBuilderMode["findings"]>>, code: string, label: string) =>
      found.find((entry) => entry.message.includes(code))?.fixes.find((fix) => fix.label === label);

    it("offers Move to the end for a Check answers step with a step after it, in one undo", async () => {
      const { mode } = await activated(reviewed(undefined, [{ id: "extra", title: "Extra", components: ["children"] }]));
      const found = mode.findings?.() ?? [];
      const entry = found.find((candidate) => candidate.message.includes("last page") || candidate.message.includes("Check answers"));
      expect(entry).toBeDefined();
      const move = entry!.fixes.find((fix) => fix.label === "Move to the end");
      expect(move).toBeDefined();
      move!.run();
      expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "more", "extra", "check"]);
      expect((mode.findings?.() ?? []).some((candidate) => candidate.fixes.some((fix) => fix.label === "Move to the end"))).toBe(false);
      mode.controller.undo();
      expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "more", "check", "extra"]);
    });

    it("offers Take it off this step for a form field listed on it, and Remove for a route out of it", async () => {
      const { mode } = await activated({
        journeys: [
          {
            id: "j",
            pages: [
              { id: "about", components: ["fullName"] },
              { id: "check", kind: "review", components: ["notes"], routes: [{ to: "about" }] }
            ]
          }
        ]
      } as unknown as JourneyConfiguration);
      const found = mode.findings?.() ?? [];
      const take = fixOf(found, "lists Notes", "Take it off this step");
      expect(take).toBeDefined();
      const route = found.find((entry) => entry.fixes.some((fix) => fix.label === "Remove" && entry.message.includes("Route 1")));
      expect(route).toBeDefined();
      take!.run();
      expect(mode.journey?.pages[1]?.components ?? []).toEqual([]);
      (mode.findings?.() ?? []).find((entry) => entry.message.includes("Route 1"))!.fixes.find((fix) => fix.label === "Remove")!.run();
      expect(mode.journey?.pages[1]?.routes ?? []).toEqual([]);
    });

    it("makes a second Check answers step a questions step again, and says a route that bypasses the first with no fix of its own", async () => {
      const { mode } = await activated({
        journeys: [
          {
            id: "j",
            pages: [
              { id: "about", components: ["fullName"], routes: [{ when: 'fullName = "x"', to: "$end" }] },
              { id: "check", kind: "review", components: [] },
              { id: "check2", kind: "review", components: [] }
            ]
          }
        ]
      } as unknown as JourneyConfiguration);
      const found = mode.findings?.() ?? [];
      const repeated = found.find((entry) => entry.message.includes("is a second Check answers step"));
      expect(repeated).toMatchObject({ severity: "error" });
      expect(repeated!.fixes.map((fix) => fix.label)).toEqual(["Make it a questions step"]);
      const bypassed = found.find((entry) => entry.message.includes("submits without passing the Check answers step"));
      expect(bypassed).toMatchObject({ severity: "warning" });
      expect(bypassed!.fixes).toEqual([]);
      repeated!.fixes[0]!.run();
      expect(mode.journey?.pages.map((page) => page.kind)).toEqual([undefined, "review", undefined]);
      expect((mode.findings?.() ?? []).some((entry) => entry.message.includes("is a second Check answers step"))).toBe(false);
    });
  });

  it("follows a form field renamed into the step's row wording", async () => {
    const { mode, form } = await activated(reviewed({ labels: { contactMethod: "How should we reach you?" } }));
    form.renameId("contactMethod", "contact");
    expect(mode.journey?.pages[2]?.review).toEqual({ labels: { contact: "How should we reach you?" } });
    expect(mode.journey?.pages[0]?.components).toEqual(["fullName", "contact"]);
  });
});
