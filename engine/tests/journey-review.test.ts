import { describe, expect, it } from "vitest";

import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { createFormTextResolver } from "../form-engine/core/localization/form-texts.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import { buildReviewModel, journeyReviewComponentIds, REVIEW_MASK, reviewAction, type ReviewCard, type ReviewModel, type ReviewRow } from "../form-engine/render/core/journey-review.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { answerTextOf } from "../form-engine/render/print/model.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { homeDefinition, toCheck } from "./journey-review-fixture.js";
import { definitionOf, runtimeOf } from "./live-chrome-harness.js";

/*
 * A journey's Check answers page as data (render/core/journey-review.ts): a section per
 * step on the path, a row per answer with its state, a card per data grid row; what is never listed.
 */

async function modelOf(runtime: FormRuntime): Promise<ReviewModel> {
  const output = await buildRuntimeRenderOutput(runtime, "interactive", { journeyKit: EagerJourneyRenderKit });
  const view = runtime.journeyView();
  if (!view) {
    throw new Error("no journey view");
  }
  const model = buildReviewModel({ view, components: output.components, locale: runtime.state().locale, sources: { translations: runtime.translations() }, text: createFormTextResolver("en") });
  if (!model) {
    throw new Error("not a review page");
  }
  return model;
}

const rowsOf = (model: ReviewModel): ReviewRow[] => model.sections.flatMap((section) => section.items.filter((item): item is ReviewRow => item.kind === "row"));
const row = (model: ReviewModel, id: string): ReviewRow | undefined => rowsOf(model).find((entry) => entry.componentId === id);

describe("the Check answers list: sections and rows", () => {
  it("lists a section per step on the path, in path order, headed by its title or its first answer's label", async () => {
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    const model = await modelOf(runtime);
    expect(model).toMatchObject({ journeyId: "repair", pageId: "check" });
    expect(model.sections.map((section) => [section.pageId, section.title])).toEqual([
      ["home", "Your home"],
      ["owning", "Owning or renting"],
      ["landlord", "Your landlord"],
      ["work", "Work needed"]
    ]);
    // The step order, a field listed twice under its first step only.
    expect(model.sections.map((section) => section.items.map((item) => (item.kind === "row" ? item.componentId : `${item.componentId}#${item.index}`)))).toEqual([
      ["main", "address", "people#0", "people#1"],
      ["tenure"],
      ["landlord", "agreed"],
      ["work", "cost"]
    ]);
  });

  it("words each answer as print does: an option's label, lines kept, a select's label, the affix with a number", async () => {
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    runtime.setValue("cost", "1250.5");
    const model = await modelOf(runtime);
    expect(row(model, "main")).toMatchObject({ label: "Is this your main home?", value: "Yes", status: "answered", errors: [], pageId: "home", key: "main", valuePath: "main" });
    expect(row(model, "address")?.value).toBe("12 Elm Street\nHalifax");
    expect(row(model, "work")?.value).toBe("Heating");
    expect(row(model, "cost")?.value).toBe("$1250.5");
    // The one answer-as-text function print uses.
    const output = await buildRuntimeRenderOutput(runtime, "interactive", { journeyKit: EagerJourneyRenderKit });
    const work = output.components.find((model) => model.id === "work")!;
    expect(answerTextOf(work, "select", "en")).toEqual({ text: "Heating", empty: false });
  });

  it("marks a required answer not given missing, with an Enter link to its step and no Change", async () => {
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    const landlord = row(await modelOf(runtime), "landlord");
    expect(landlord).toMatchObject({ status: "missing", value: "", pageId: "landlord" });
    expect(landlord?.change).toBeUndefined();
    expect(landlord?.enter).toEqual({ pageId: "landlord", text: "Enter Landlord's name", hidden: "", name: "Enter Landlord's name", reordered: false });
  });

  it("says Not provided for an optional answer left blank, with a Change link whose hidden words name the row", async () => {
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    const cost = row(await modelOf(runtime), "cost");
    expect(cost).toMatchObject({ status: "notProvided", value: "Not provided" });
    expect(cost?.change).toEqual({ pageId: "work", text: "Change", hidden: " Estimated cost", name: "Change Estimated cost", reordered: false });
    expect(row(await modelOf(runtime), "main")?.change?.hidden).toBe(" Is this your main home?");
  });

  it("leaves a blank optional answer out when the page says omit, and draws no Change links when it says so", async () => {
    const runtime = runtimeOf(homeDefinition({ emptyOptional: "omit", change: false }));
    await toCheck(runtime);
    const model = await modelOf(runtime);
    expect(row(model, "cost")).toBeUndefined();
    expect(rowsOf(model).every((entry) => entry.change === undefined)).toBe(true);
    expect(model.sections.flatMap((section) => section.items).filter((item): item is ReviewCard => item.kind === "card").every((card) => card.change === undefined)).toBe(true);
    // The way to a missing answer stays: it is not a Change.
    expect(row(model, "landlord")?.enter?.pageId).toBe("landlord");
  });

  it("words a row by the page's labels, translated, over the field's label", async () => {
    const definition = homeDefinition({ labels: { tenure: "Own or rent" } });
    definition.localization = { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] };
    definition.translations = { fr: { journeys: { repair: { pages: { check: { review: { labels: { tenure: { text: "Propriétaire ou locataire", source: "x" } } } } } } } } } as never;
    const runtime = runtimeOf(definition);
    await toCheck(runtime);
    expect(row(await modelOf(runtime), "tenure")).toMatchObject({ label: "Own or rent", value: "Rent" });
    expect(row(await modelOf(runtime), "tenure")?.change?.name).toBe("Change Own or rent");
    runtime.setLocale("fr");
    expect(row(await modelOf(runtime), "tenure")?.label).toBe("Propriétaire ou locataire");
  });

  it("makes the errors on the answers it lists the page's own: the summary words them as entries, in the list's order", async () => {
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    runtime.setErrors([
      { code: "required", componentId: "landlord", path: "landlord", message: "Enter landlord's name" },
      { code: "format", componentId: "main", path: "main", message: "Select yes or no" },
      { code: "far", componentId: "notes", path: "notes", message: "Off the path" }
    ]);
    const summary = (await buildRuntimeRenderOutput(runtime, "interactive", { journeyKit: EagerJourneyRenderKit })).meta.errorSummary;
    expect(summary.entries.map((entry) => entry.targetPath)).toEqual(["main", "landlord"]);
    // A field the page does not list stays the form's.
    expect(summary.formEntries.map((entry) => entry.message)).toEqual(["Off the path"]);
  });

  it("carries a row's blocking errors, worded", async () => {
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    runtime.setErrors([{ code: "required", componentId: "landlord", path: "landlord", message: "Enter landlord's name" }]);
    expect(row(await modelOf(runtime), "landlord")).toMatchObject({ status: "missing", errors: ["Enter landlord's name"] });
  });
});

describe("the Check answers list: what it never lists", () => {
  it("lists no hidden field, no field off the path, no field on no step and no journey-only field", async () => {
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    const ids = rowsOf(await modelOf(runtime)).map((entry) => entry.componentId);
    // `secret` is hidden (Heating), `notes` is on a step after the Check answers page, `unplaced` on none.
    expect(ids).not.toContain("secret");
    expect(ids).not.toContain("notes");
    expect(ids).not.toContain("unplaced");
    expect(ids).not.toContain("declare");
    // Shown once the rule shows it.
    runtime.setValue("work", "roof");
    expect(rowsOf(await modelOf(runtime)).map((entry) => entry.componentId)).toContain("secret");
  });

  it("drops a step the answers take off the path", async () => {
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    runtime.setValue("tenure", "own");
    const model = await modelOf(runtime);
    expect(model.sections.map((section) => section.pageId)).toEqual(["home", "owning", "work"]);
    expect(row(model, "landlord")).toBeUndefined();
  });

  it("lists no journey-only field, even one holding an answer on a step of the path", async () => {
    const definition = homeDefinition();
    const work = definition.journey!.journeys![0]!.pages.find((page) => page.id === "work")!;
    work.components = [...(work.components ?? []), { id: "aside", type: "text", configuration: { label: "A note for us" } }];
    const runtime = runtimeOf(definition);
    await toCheck(runtime);
    const output = await buildRuntimeRenderOutput(runtime, "interactive", { journeyKit: EagerJourneyRenderKit });
    const aside = output.components.find((model) => model.id === "aside")!;
    runtime.setValue(aside.valuePath, "Use the back door");
    const again = await buildRuntimeRenderOutput(runtime, "interactive", { journeyKit: EagerJourneyRenderKit });
    // It holds an answer, on the work step the path takes.
    expect(again.components.find((model) => model.id === "aside")?.value).toBe("Use the back door");
    const model = await modelOf(runtime);
    expect(rowsOf(model).map((entry) => entry.componentId)).not.toContain("aside");
    expect(rowsOf(model).some((entry) => entry.value === "Use the back door")).toBe(false);
  });

  it("lists the form field an alias fills as the alias asked it: its label, its Required, its errors", async () => {
    const fields: ComponentNode[] = [
      { id: "income", type: "number", configuration: { label: "Annual income" } },
      { id: "name", type: "text", configuration: { label: "Name", required: true } }
    ];
    const journey: Journey = {
      id: "apply",
      pages: [
        {
          id: "one",
          title: "You",
          components: ["name", { id: "pay", type: "number", configuration: { label: "Pay each year", required: true, fills: "income" } }, { id: "aside", type: "text", configuration: { label: "A note for us" } }]
        },
        { id: "check", kind: "review", title: "Check", components: [] }
      ]
    } as Journey;
    const runtime = runtimeOf(definitionOf(fields, { journey: { journeys: [journey] } }));
    runtime.startJourney("apply");
    runtime.setValue("name", "Ada");
    runtime.setValue("income", "52000");
    expect((await runtime.nextPage()).pageId).toBe("check");
    const model = await modelOf(runtime);
    expect(rowsOf(model).map((entry) => [entry.componentId, entry.valuePath, entry.label, entry.value, entry.status])).toEqual([
      ["name", "name", "Name", "Ada", "answered"],
      ["pay", "income", "Pay each year", "52000", "answered"]
    ]);
    expect(row(model, "pay")?.change?.name).toBe("Change Pay each year");
    expect(journeyReviewComponentIds(runtime.journeyView()!)).toEqual(["name", "income", "pay"]);

    // Left blank: the alias's Required makes it missing, and a refused send links its error to the row.
    runtime.setValue("income", "");
    const result = await runtime.submit("submit", { form: { id: "f", version: "1" }, client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" } });
    expect(result.accepted).toBe(false);
    expect(runtime.journeyView()?.pageId).toBe("check");
    const refused = await modelOf(runtime);
    expect(row(refused, "pay")).toMatchObject({ label: "Pay each year", status: "missing", value: "" });
    expect(row(refused, "pay")?.enter?.name).toBe("Enter Pay each year");
    expect(row(refused, "pay")?.errors.length).toBeGreaterThan(0);
    const summary = (await buildRuntimeRenderOutput(runtime, "interactive", { journeyKit: EagerJourneyRenderKit })).meta.errorSummary;
    expect(summary.entries.map((entry) => [entry.componentId, entry.targetPath])).toEqual([["pay", "income"]]);
    expect(summary.formEntries).toEqual([]);
  });

  it("shows a password as a mask, never its answer", async () => {
    const fields: ComponentNode[] = [{ id: "pw", type: "password", configuration: { label: "Password" } }];
    const journey: Journey = {
      id: "apply",
      pages: [
        { id: "one", title: "Sign in", components: ["pw"] },
        { id: "check", kind: "review", title: "Check", components: [] }
      ]
    } as Journey;
    const runtime = runtimeOf(definitionOf(fields, { journey: { journeys: [journey] } }));
    runtime.startJourney("apply");
    runtime.setValue("pw", "hunter2");
    expect((await runtime.nextPage()).pageId).toBe("check");
    const pw = row(await modelOf(runtime), "pw");
    expect(pw).toMatchObject({ status: "answered", value: REVIEW_MASK });
    expect(JSON.stringify(await modelOf(runtime))).not.toContain("hunter2");
  });

  it("builds nothing on a page that is not a Check answers page", async () => {
    const runtime = runtimeOf(homeDefinition());
    runtime.startJourney("repair");
    const output = await buildRuntimeRenderOutput(runtime, "interactive", { journeyKit: EagerJourneyRenderKit });
    expect(buildReviewModel({ view: runtime.journeyView()!, components: output.components, locale: "en", sources: {}, text: createFormTextResolver("en") })).toBeUndefined();
  });
});

describe("the Check answers list: a data grid's rows as cards", () => {
  it("draws a card per row, titled by its row heading, its fields as rows with no Change, one Change on the card", async () => {
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    const cards = (await modelOf(runtime)).sections[0]!.items.filter((item): item is ReviewCard => item.kind === "card");
    expect(cards.map((card) => [card.key, card.title, card.pageId])).toEqual([
      ["people[0]", "Person 1", "home"],
      ["people[1]", "Person 2", "home"]
    ]);
    expect(cards[0]!.rows.map((entry) => [entry.key, entry.label, entry.value])).toEqual([
      ["people[0].name", "Name", "Ana Silva"],
      ["people[0].dob", "Date of birth", "March 4, 1988"]
    ]);
    expect(cards[0]!.rows.every((entry) => entry.change === undefined)).toBe(true);
    expect(cards[1]!.change).toEqual({ pageId: "home", text: "Change", hidden: " Person 2", name: "Change Person 2", reordered: false });
  });

  it("lists a grid with no rows as one row of its own", async () => {
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    runtime.setValues({ people: [] });
    const people = row(await modelOf(runtime), "people");
    expect(people).toMatchObject({ label: "People living there", status: "notProvided", value: "Not provided" });
  });
});

describe("a Change link's words", () => {
  it("shows the visible words and hides the rest; a wording that does not start with them is hidden whole", () => {
    expect(reviewAction("p", "Change", "Change Name")).toEqual({ pageId: "p", text: "Change", hidden: " Name", name: "Change Name", reordered: false });
    expect(reviewAction("p", "ändern", "Name ändern")).toEqual({ pageId: "p", text: "ändern", hidden: "Name ändern", name: "Name ändern", reordered: true });
    expect(reviewAction("p", "Enter Name", "Enter Name")).toMatchObject({ hidden: "", reordered: false });
  });
});
