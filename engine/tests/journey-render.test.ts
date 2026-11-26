// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { journeyPageFormIds, type Journey } from "../form-engine/core/schema/journey.js";
import type { JourneyView } from "../form-engine/core/journey/journey-types.js";
import type { EffectiveNodeState } from "../form-engine/core/state/effective-state.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { EventBus } from "../form-engine/core/events/event-bus.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildRenderOutput } from "../form-engine/render/core/render-orchestrator.js";
import { buildRuntimeRenderOutput, type RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import {
  buildJourneyMeta,
  journeyPageComponentIds,
  journeyPageComponents,
  journeyPageErrors
} from "../form-engine/render/core/journey-render.js";
import type { RenderComponentModel } from "../form-engine/render/core/component-model.js";
import { createJourneyPageFeature } from "../form-engine/render/live/journey-page.js";
import { bodyHtml, definitionOf, drawDatum, unmountAll } from "./live-datum-parts-kit.js";

afterEach(unmountAll);
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { FormError } from "../form-engine/core/errors/form-error.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { presentationForm, publicVariant } from "./fixtures/presentation-form.js";
import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

/**
 * A form whose pages pick components out of wherever the tree holds them: a field at the top,
 * one inside a section, a whole grid with its columns, and a button in a panel.
 */
function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "intro", type: "html", configuration: { content: "<p>Welcome</p>" } },
        {
          id: "you",
          type: "fieldset",
          configuration: { label: "You" },
          children: {
            content: [
              { id: "name", type: "text", configuration: { label: "Your name" } },
              { id: "email", type: "text", configuration: { label: "Email" } }
            ]
          }
        },
        {
          id: "where",
          type: "grid",
          configuration: { columns: 2 },
          children: {
            column_1: [{ id: "city", type: "text", configuration: { label: "City" } }],
            column_2: [{ id: "postcode", type: "text", configuration: { label: "Postcode" } }]
          }
        },
        {
          id: "end",
          type: "panel",
          configuration: { label: "Finish" },
          children: { content: [{ id: "send", type: "button", configuration: { label: "Send", action: "submit" } }] }
        }
      ]
    }
  };
}

const JOURNEY: Journey = {
  id: "apply",
  progress: "count",
  texts: { continue: "Next", back: "Previous" },
  pages: [
    { id: "who", components: ["email", "name"] },
    { id: "place", title: "Where you live", description: "Your home address", components: ["where"], texts: { continue: "Save and continue" } },
    { id: "done", components: ["send"] }
  ]
};

/** The French for the fixture, in the definition's map: a component's label and a page's title. */
const FRENCH: FormTranslations = {
  fr: {
    components: { name: { label: { text: "Votre nom", source: sourceHash("Your name") } } },
    journeys: { apply: { pages: { place: { title: { text: "Où vous habitez", source: sourceHash("Where you live") } } } } }
  }
};

function view(pageId: string, overrides: Partial<JourneyView> = {}): JourneyView {
  const index = JOURNEY.pages.findIndex((page) => page.id === pageId);
  const page = JOURNEY.pages[index]!;
  const path = JOURNEY.pages.map((entry) => entry.id);
  return {
    journeyId: JOURNEY.id,
    journey: JOURNEY,
    pageId,
    page,
    kind: page.kind ?? "questions",
    path,
    index,
    total: path.length,
    number: index + 1,
    completed: path.slice(0, index),
    frontierPageId: pageId,
    ...(index > 0 ? { backPageId: path[index - 1]! } : {}),
    final: index === path.length - 1,
    end: "end",
    members: journeyPageFormIds(page),
    pageOf: {},
    validation: { continue: "page", server: false, onUnavailable: "block" },
    ...overrides
  };
}

async function models() {
  const output = await buildRenderOutput({ mode: "interactive", root: form(), state: new FormStateStore("en").snapshot(), resolver });
  return output.components;
}

describe("journeyPageComponents", () => {
  it("draws the root, then the page's components in the page's order, re-parented to the root's first slot", async () => {
    const page = journeyPageComponents(await models(), view("who"));
    expect(page.map((model) => model.id)).toEqual(["root", "email", "name"]);
    for (const model of page.slice(1)) {
      expect(model.parentId).toBe("root");
      expect(model.slotId).toBe("content");
      expect(model.depth).toBe(1);
    }
    // The section they sit in is not drawn, nor is anything the page does not list.
    expect(page.some((model) => model.id === "you" || model.id === "intro" || model.id === "city")).toBe(false);
  });

  it("brings each component's subtree, in the tree's order, under it", async () => {
    const page = journeyPageComponents(await models(), view("place"));
    expect(page.map((model) => [model.id, model.parentId, model.slotId, model.depth])).toEqual([
      ["root", undefined, undefined, 0],
      ["where", "root", "content", 1],
      ["city", "where", "column_1", 2],
      ["postcode", "where", "column_2", 2]
    ]);
    // A cell's layout path keeps the grid it sits in: the grid is drawn.
    expect(page.find((model) => model.id === "city")?.containerPath).toEqual(["where"]);
  });

  it("lifts a component out of the layout it sits in, and forgets that layout", async () => {
    const all = await models();
    expect(all.find((model) => model.id === "city")?.containerPath).toEqual(["where"]);
    const page = journeyPageComponents(all, { members: ["postcode"] });
    const postcode = page.find((model) => model.id === "postcode");
    expect(postcode).toMatchObject({ parentId: "root", slotId: "content", depth: 1, containerPath: [] });
    // The models it was handed are left as they were.
    expect(all.find((model) => model.id === "postcode")).toMatchObject({ parentId: "where", slotId: "column_2", depth: 2 });
  });

  it("draws a component once when the page lists it twice, or lists it beside a container holding it", async () => {
    const all = await models();
    expect(journeyPageComponents(all, { members: ["name", "name"] }).map((model) => model.id)).toEqual(["root", "name"]);
    expect(journeyPageComponents(all, { members: ["you", "name"] }).map((model) => model.id)).toEqual(["root", "you", "name", "email"]);
    expect(journeyPageComponents(all, { members: ["name", "you"] }).map((model) => model.id)).toEqual(["root", "name", "you", "email"]);
    // An id the form does not have is passed over.
    expect(journeyPageComponents(all, { members: ["nope", "email"] }).map((model) => model.id)).toEqual(["root", "email"]);
  });

  it("files the page under content when the root declares no slot", () => {
    const root = { id: "r", type: "form", configuration: {} } as ComponentNode;
    const bare = [
      { id: "r", parentId: undefined, depth: 0, containerPath: [], node: root },
      { id: "x", parentId: "r", slotId: "content", depth: 1, containerPath: [], node: { id: "x", type: "text" } }
    ] as unknown as Parameters<typeof journeyPageComponents>[0];
    expect(journeyPageComponents(bare, { members: ["x"] })[1]).toMatchObject({ parentId: "r", slotId: "content" });
    expect(journeyPageComponents([], { members: ["x"] })).toEqual([]);
  });
});

describe("journeyPageComponentIds", () => {
  it("is the root, the page's components and everything under them", () => {
    expect([...journeyPageComponentIds(form(), ["where", "email"])].sort()).toEqual(["city", "email", "postcode", "root", "where"]);
    expect([...journeyPageComponentIds(form(), ["missing"])]).toEqual(["root"]);
  });
});

describe("buildJourneyMeta", () => {
  it("heads the page with its title in the locale, and carries where it sits on the path", () => {
    const meta = buildJourneyMeta(form(), view("place"), { locale: "fr", translations: FRENCH });
    expect(meta).toMatchObject({
      journeyId: "apply",
      pageId: "place",
      kind: "questions",
      title: "Où vous habitez",
      description: "Your home address",
      index: 1,
      number: 2,
      total: 3,
      progress: "count",
      backPageId: "who",
      final: false,
      hasOwnSubmit: false,
      pending: undefined,
      members: ["where"]
    });
  });

  it("words the journey's and the page's own texts from the map, the page's over the journey's", () => {
    const translations: FormTranslations = {
      fr: {
        journeys: {
          apply: {
            texts: { continue: { text: "Suivant", source: sourceHash("Next") }, back: { text: "Précédent", source: sourceHash("Previous") } },
            pages: { place: { texts: { continue: { text: "Enregistrer et continuer", source: sourceHash("Save and continue") } } } }
          }
        }
      }
    };
    expect(buildJourneyMeta(form(), view("place"), { locale: "fr", translations }).texts).toEqual({ continue: "Enregistrer et continuer", back: "Précédent" });
    expect(buildJourneyMeta(form(), view("who"), { locale: "fr", translations }).texts).toEqual({ continue: "Suivant", back: "Précédent" });
    // The host's catalog wins over the map; the default language reads as written.
    const catalog = { fr: { journeys: { apply: { texts: { back: "Retour (hôte)" } } } } };
    expect(buildJourneyMeta(form(), view("who"), { locale: "fr", translations, translationCatalog: catalog }).texts).toEqual({ continue: "Suivant", back: "Retour (hôte)" });
    expect(buildJourneyMeta(form(), view("who"), { locale: "en", translations }).texts).toEqual({ continue: "Next", back: "Previous" });
  });

  it("heads a page without a title with its first component's label, the first that shows", () => {
    expect(buildJourneyMeta(form(), view("who"), { locale: "en" }).title).toBe("Email");
    const hidden = new Map<string, EffectiveNodeState>([["email", { visible: false } as EffectiveNodeState]]);
    expect(buildJourneyMeta(form(), view("who"), { locale: "fr", translations: FRENCH, effectiveStates: hidden }).title).toBe("Votre nom");
    // Nothing labelled at all: no heading, never the page's id.
    expect(buildJourneyMeta(form(), view("who", { members: ["intro"] }), { locale: "en" }).title).toBe("");
  });

  it("words a worked-out copy's inherited label at the target's address, and an own label at the copy's own", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "income", type: "number", configuration: { label: "Annual income" } },
          { id: "inherits", type: "number", configuration: { label: "Annual income", presentation: { kind: "worked-out", to: "income", inheritsLabel: true } } },
          { id: "own", type: "number", configuration: { label: "Total", presentation: { kind: "worked-out", to: "income" } } }
        ]
      }
    };
    const translations: FormTranslations = {
      fr: {
        components: {
          income: { label: { text: "Revenu annuel", source: sourceHash("Annual income") } },
          own: { label: { text: "Total (copie)", source: sourceHash("Total") } }
        }
      }
    };
    const titled = (member: string): string => buildJourneyMeta(root, view("who", { members: [member] }), { locale: "fr", translations }).title;
    // The copy that took the target's label is worded as the target is; the copy's own label at its own id.
    expect(titled("inherits")).toBe("Revenu annuel");
    expect(titled("own")).toBe("Total (copie)");
    expect(titled("income")).toBe("Revenu annuel");
    expect(buildJourneyMeta(root, view("who", { members: ["inherits"] }), { locale: "en", translations }).title).toBe("Annual income");
  });

  it("lays the page's texts over the journey's", () => {
    expect(buildJourneyMeta(form(), view("place"), { locale: "en" }).texts).toEqual({ continue: "Save and continue", back: "Previous" });
    expect(buildJourneyMeta(form(), view("who"), { locale: "en" }).texts).toEqual({ continue: "Next", back: "Previous" });
    const { texts: _texts, ...plain } = JOURNEY;
    expect(buildJourneyMeta(form(), view("who", { journey: plain }), { locale: "en" }).texts).toBeUndefined();
  });

  it("knows a page that brings its own submit or download button, one that shows", () => {
    expect(buildJourneyMeta(form(), view("done"), { locale: "en" })).toMatchObject({ final: true, hasOwnSubmit: true, backPageId: "place" });
    const hidden = new Map<string, EffectiveNodeState>([["send", { visible: false } as EffectiveNodeState]]);
    expect(buildJourneyMeta(form(), view("done"), { locale: "en", effectiveStates: hidden }).hasOwnSubmit).toBe(false);
    const download = form();
    const panel = download.children!.content![3]!;
    panel.children!.content![0]!.configuration = { label: "Send", action: "download" };
    expect(buildJourneyMeta(download, view("done"), { locale: "en" }).hasOwnSubmit).toBe(true);
    panel.children!.content![0]!.configuration = { label: "PDF", action: "pdf" };
    expect(buildJourneyMeta(download, view("done"), { locale: "en" }).hasOwnSubmit).toBe(false);
  });

  it("passes a pending check and the progress setting through", () => {
    expect(buildJourneyMeta(form(), view("who", { pending: "page" }), { locale: "en" }).pending).toBe("page");
    const uncounted: Journey = { ...JOURNEY, progress: "none" };
    expect(buildJourneyMeta(form(), view("who", { journey: uncounted }), { locale: "en" }).progress).toBe("none");
  });

  it("passes the page heading setting through: hidden only when said, anything else shown", () => {
    expect(buildJourneyMeta(form(), view("who"), { locale: "en" }).heading).toBe("shown");
    expect(buildJourneyMeta(form(), view("who", { journey: { ...JOURNEY, heading: "hidden" } }), { locale: "en" }).heading).toBe("hidden");
    expect(buildJourneyMeta(form(), view("who", { journey: { ...JOURNEY, heading: "shown" } }), { locale: "en" }).heading).toBe("shown");
    const odd = { ...JOURNEY, heading: "none" } as unknown as Journey;
    expect(buildJourneyMeta(form(), view("who", { journey: odd }), { locale: "en" }).heading).toBe("shown");
  });
});

describe("the render bridge and journeys", () => {
  function runtime(current: JourneyView | undefined): RenderableRuntime {
    const root = form();
    const state = new FormStateStore("en");
    return {
      formRoot: () => root,
      state: () => state.snapshot(),
      errors: () => [],
      effectiveStatesMap: () => new Map(),
      requiredMap: () => new Map(),
      componentTree: () => new ComponentTree(root),
      resolveDataSource: async () => undefined,
      events: () => new EventBus(),
      journeyView: () => current
    };
  }

  it("draws the journey's page in a live form, and the whole form for a review, a print or with no journey", async () => {
    const live = await buildRuntimeRenderOutput(runtime(view("place")), "interactive");
    expect(live.meta.journey).toMatchObject({ pageId: "place", title: "Where you live" });
    const review = await buildRuntimeRenderOutput(runtime(view("place")), "readonly");
    expect(review.meta.journey).toBeUndefined();
    expect("journey" in review.meta).toBe(false);
    const whole = await buildRuntimeRenderOutput(runtime(undefined), "interactive");
    expect("journey" in whole.meta).toBe(false);
  });
});

// --- Presentations: pages holding nodes of their own -----------------------------

function presentationRuntime(journeyId?: string, definition: FormDefinition = presentationForm()): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const runtime = new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)])
  });
  if (journeyId !== undefined) {
    runtime.startJourney(journeyId);
  }
  return runtime;
}

/** The fixture with its journey `apply`'s pages changed by `edit`. */
function withApply(edit: (journey: Journey) => void): FormDefinition {
  const definition = presentationForm();
  edit(definition.journey!.journeys![0]!);
  return definition;
}

/** The runtime drawn by the Datum binding with the journey page module, as its markup (whitespace collapsed). */
async function drawn(runtime: FormRuntime): Promise<string> {
  unmountAll();
  const m = await drawDatum(definitionOf([]), {}, { runtime, extraFeatures: [createJourneyPageFeature()] });
  return bodyHtml(m).replace(/\s+/g, " ");
}

async function livePage(runtime: FormRuntime): Promise<{ page: RenderComponentModel[]; html: string }> {
  const output = await buildRuntimeRenderOutput(runtime, "interactive");
  const page = journeyPageComponents(output.components, output.meta.journey!);
  return { page, html: await drawn(runtime) };
}

const placed = (models: readonly RenderComponentModel[]) => models.map((model) => [model.id, model.parentId, model.slotId, model.depth, model.containerPath]);

describe("journey pages with nodes of their own", () => {
  it("grafts a reference in an own layout: the form component it names, in the placeholder's parent and slot, at its depth, inside its layouts", async () => {
    const runtime = presentationRuntime("public");
    const { page, html } = await livePage(runtime);
    expect(placed(page)).toEqual([
      ["form", undefined, undefined, 0, []],
      ["contact", "form", "content", 1, []],
      ["email", "contact", "content", 2, ["contact"]],
      ["name", "contact", "content", 2, ["contact"]],
      ["public_note", "form", "content", 1, []]
    ]);
    // No placeholder, and not the presentation's container, is ever drawn.
    expect(page.some((model) => model.id.startsWith("@") || model.type === "journey-field")).toBe(false);
    // The form's fields keep their own value paths and draw inside the own columns layout.
    expect(page.find((model) => model.id === "email")?.valuePath).toBe("email");
    const at = (marker: string): number => html.indexOf(marker);
    expect(at('datum-form__layout--grid')).toBeGreaterThan(-1);
    expect(at('datum-form__layout--grid')).toBeLessThan(at('data-component-id="email"'));
    expect(at('data-component-id="email"')).toBeLessThan(at('data-component-id="name"'));
    expect(at('data-component-id="name"')).toBeLessThan(at("We only use your email"));
    expect(html).not.toContain("journey-field");
    expect(html).not.toContain('data-component-id="@');
  });

  it("draws a referenced component once, whether a member or an earlier reference drew it first", async () => {
    const twice = presentationForm();
    const variant = twice.journey!.journeys![1]!;
    variant.pages[0]!.components = ["name", ...variant.pages[0]!.components!, { type: "journey-field", configuration: { componentId: "money" } }];
    const { page } = await livePage(presentationRuntime("public", twice));
    expect(page.map((model) => model.id)).toEqual(["form", "name", "contact", "email", "public_note", "money", "annual_income"]);
    expect(placed(page).slice(-2)).toEqual([
      ["money", "form", "content", 1, []],
      ["annual_income", "money", "content", 2, []]
    ]);
  });

  it("the page's component ids hold what the graft draws, in its order", () => {
    const runtime = presentationRuntime("public");
    const combined = runtime.journeyRenderRoot()!;
    expect([...journeyPageComponentIds(combined.root, ["contact", "public_note"])]).toEqual(["form", "contact", "email", "name", "public_note"]);
  });

  it("binds an alias to the form field it fills: the field's value, written at its path, under the alias's own label, help and Required marker", async () => {
    const definition = withApply((journey) => {
      const alias = journey.pages[0]!.components![0] as { configuration: Record<string, unknown> };
      alias.configuration.description = "The address you check at work";
    });
    definition.root.children!.content![0]!.configuration = { label: "Email" };
    const runtime = presentationRuntime("apply", definition);
    runtime.setValue("email", "ada@example.org");
    const { page, html } = await livePage(runtime);
    const alias = page.find((model) => model.id === "work_email")!;
    expect(alias).toMatchObject({ valuePath: "email", value: "ada@example.org", label: "Work email", description: "The address you check at work", readOnly: false });
    // Its own Required, though the form field is optional here.
    expect(alias.accessibility.required).toBe(true);
    expect(html).toContain('data-component-id="work_email" data-value-path="email"');
    expect(html).toContain('<span id="work_email__label" class="datum-form__label">Work email <span class="datum-form__required" aria-hidden="true">*</span></span>');
    expect(html).toContain('<span class="datum-form__description" id="work_email__description">The address you check at work</span>');
    expect(html).toContain('aria-describedby="work_email__description" aria-required="true"');
    expect(html).not.toContain('data-component-id="email"');
  });

  it("gives an alias the form field's hidden, disabled and read-only state, asked by the alias's own id", async () => {
    const locked = presentationForm();
    locked.root.children!.content![0]!.configuration = { label: "Email", required: true, readOnly: true, disabled: true };
    const { page } = await livePage(presentationRuntime("apply", locked));
    expect(page.find((model) => model.id === "work_email")).toMatchObject({ readOnly: true, disabled: true, visible: true });

    // A page of the alias alone would be skipped with its field hidden (it has nothing to show):
    // this one has a paragraph of its own too.
    const hidden = withApply((journey) => {
      journey.pages[0]!.components!.push({ id: "intro", type: "html", configuration: { content: "<p>About you</p>" } });
    });
    hidden.root.children!.content![0]!.configuration = { label: "Email", required: true, hidden: true };
    const runtime = presentationRuntime("apply", hidden);
    expect(runtime.journeyView()?.pageId).toBe("details");
    const { page: hiddenPage, html } = await livePage(runtime);
    expect(runtime.effectiveState("work_email")?.visible).toBe(false);
    expect(hiddenPage.find((model) => model.id === "work_email")?.visible).toBe(false);
    expect(html).not.toContain('data-component-id="work_email"');
  });

  it("draws a worked-out value as a read-only copy of its form field, with the line saying it is worked out", async () => {
    const runtime = presentationRuntime("apply");
    runtime.setValue("email", "ada@example.org");
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    runtime.setValue("@apply.m1", 1000);
    runtime.setValue("@apply.m2", 2500);
    const { page, html } = await livePage(runtime);
    const copy = page.find((model) => model.id === "income_total")!;
    expect(copy).toMatchObject({ type: "number", valuePath: "annual_income", value: 3500, label: "Annual income", readOnly: true, workedOut: true });
    expect(copy.accessibility.ariaDescribedBy).toEqual(["income_total__worked-out"]);
    // An own field of the page is stored at its `@` key, and says so to the control that writes it.
    expect(page.find((model) => model.id === "m1")).toMatchObject({ valuePath: "@apply.m1", value: 1000, readOnly: false });
    expect(html).toContain('data-component-id="m1" data-value-path="@apply.m1"');
    expect(html).toMatch(/data-component-id="income_total" data-value-path="annual_income"[^>]*data-readonly/);
    // The binding draws the worked-out line as its own element, under the id the control is described by.
    expect(html).toContain('<span class="datum-form__description datum-form__worked-out" data-worked-out="" id="income_total__worked-out">Worked out from your answers</span>');
    expect(html).toContain('aria-describedby="income_total__worked-out"');
    // Worded by the page's texts like its neighbours.
    const output = await buildRuntimeRenderOutput(runtime, "interactive");
    unmountAll();
    const reworded = await drawDatum(definitionOf([]), {}, { runtime, texts: { workedOut: "Added up for you" }, extraFeatures: [createJourneyPageFeature()] });
    expect(bodyHtml(reworded)).toContain(">Added up for you</span>");
  });

  it("heads the copy with the form field's label unless the node sets its own, and never lets the person change it", async () => {
    const unlabelled = withApply((journey) => {
      const total = journey.pages[1]!.components![3] as { configuration: Record<string, unknown> };
      delete total.configuration.label;
    });
    unlabelled.root.children!.content![2]!.children!.content![0]!.configuration = { label: "Yearly income", required: true, readOnly: false, description: "Before tax" };
    const runtime = presentationRuntime("apply", unlabelled);
    runtime.setValue("email", "ada@example.org");
    await runtime.nextPage();
    const { page, html } = await livePage(runtime);
    const copy = page.find((model) => model.id === "income_total")!;
    expect(copy).toMatchObject({ label: "Yearly income", description: "Before tax", readOnly: true });
    // After its help, the worked-out line; the form field's Required marks the copy.
    expect(copy.accessibility.ariaDescribedBy).toEqual(["income_total__description", "income_total__worked-out"]);
    expect(copy.accessibility.required).toBe(true);
    expect(html).toContain(
      '<span class="datum-form__description" id="income_total__description">Before tax</span><span class="datum-form__description datum-form__worked-out" data-worked-out="" id="income_total__worked-out">Worked out from your answers</span>'
    );
    expect(html).toContain('aria-describedby="income_total__description income_total__worked-out"');
  });

  it("finds a submit button of the presentation's own, or one a reference in its layout names, and draws no Submit beside it", async () => {
    const own = presentationForm();
    const variant = own.journey!.journeys![1]!;
    variant.pages[0]!.components!.push({ id: "send_public", type: "button", configuration: { label: "Send", action: "submit" } });
    const ownRun = presentationRuntime("public", own);
    const ownOutput = await buildRuntimeRenderOutput(ownRun, "interactive");
    expect(ownOutput.meta.journey).toMatchObject({ final: true, hasOwnSubmit: true, backPageId: undefined });
    expect(await drawn(ownRun)).not.toContain("datum-form__journey-submit");

    const referenced = presentationForm();
    referenced.root.children!.content!.push({ id: "send", type: "button", configuration: { label: "Send", action: "submit" } });
    const layout = referenced.journey!.journeys![1]!.pages[0]!.components![0] as unknown as { children: { content: unknown[] } };
    layout.children.content.push({ type: "journey-field", configuration: { componentId: "send" } });
    const refOutput = await buildRuntimeRenderOutput(presentationRuntime("public", referenced), "interactive");
    expect(refOutput.meta.journey?.hasOwnSubmit).toBe(true);
  });

  it("a variant's one page: no Back, a Submit, and no caption repeating the heading", async () => {
    const titled = presentationForm();
    titled.journey!.journeys![1]!.pages[0]!.title = "Income support";
    const titledRuntime = presentationRuntime("public", titled);
    const output = await buildRuntimeRenderOutput(titledRuntime, "interactive");
    const html = await drawn(titledRuntime);
    expect(output.meta.journey).toMatchObject({ index: 0, final: true, hasOwnSubmit: false, backPageId: undefined });
    expect(html).not.toContain("data-journey-back");
    expect(html).toContain("datum-form__journey-submit");
    expect(html).not.toContain("datum-form__journey-title");
    // The page heads itself at the form's own level: it stands for the form.
    expect(html).toContain(">Income support</h1>");
  });

  it("draws a journey of component ids alone exactly as before: the form's root, no combined root, no overrides", async () => {
    const plain = presentationForm();
    plain.journey = { journeys: [{ id: "plain", pages: [{ id: "only", title: "Everything", components: ["email", "money", "name"] }] }] };
    const runtime = presentationRuntime("plain", plain);
    runtime.setValue("email", "ada@example.org");
    expect(runtime.journeyRenderRoot()).toBeUndefined();
    const bridged = await buildRuntimeRenderOutput(runtime, "interactive");
    const direct = await buildRenderOutput({
      mode: "interactive",
      root: runtime.formRoot(),
      state: runtime.state(),
      resolver: runtime,
      errors: runtime.errors(),
      effectiveStates: runtime.effectiveStatesMap(),
      requiredByComponent: runtime.requiredMap(),
      componentTree: runtime.componentTree(),
      journey: runtime.journeyView()
    });
    expect(bridged.components).toEqual(direct.components);
    expect(bridged.components.every((model) => model.workedOut === undefined)).toBe(true);
  });

  it("v1 limits: an own field naming a data source draws its inline options, an entry binding data is not drawn, and nothing throws", async () => {
    const limited = presentationForm();
    limited.journey!.journeys![1]!.pages[0]!.components!.push(
      { id: "topic", type: "select", configuration: { label: "Topic", data: { sourceId: "topics" }, options: [{ value: "a", label: "Alpha" }] } },
      {
        id: "bound",
        type: "fieldset",
        configuration: { label: "Bound", dataKey: "bound" },
        children: { content: [{ type: "journey-field", configuration: { componentId: "approved_amount" } }] }
      }
    );
    const runtime = presentationRuntime("public", limited);
    const { page, html } = await livePage(runtime);
    expect(page.find((model) => model.id === "topic")?.optionState).toMatchObject({ status: "ready", items: [{ value: "a", label: "Alpha" }] });
    expect(page.some((model) => model.id === "bound" || model.id === "approved_amount")).toBe(false);
    expect(html).not.toContain("approved_amount");
  });
});

describe("journeyPageErrors", () => {
  const err = (componentId: string, code: string, stage = "field-constraints"): FormError =>
    ({ id: `${componentId}:${code}:${stage}`, componentId, code, stage, source: "client" }) as FormError;

  it("moves a form field's errors onto the node standing for it, and shows one code once there", () => {
    const errors = [err("email", "required"), err("email", "pattern"), err("work_email", "required", "presentation-fields"), err("name", "required"), err("name", "required", "server")];
    const hosted = journeyPageErrors(errors, { email: "work_email" });
    expect(hosted.map((error) => `${error.componentId}:${error.code}:${error.stage}`)).toEqual([
      "work_email:required:field-constraints",
      "work_email:pattern:field-constraints",
      // A component no host stands for keeps every error it has.
      "name:required:field-constraints",
      "name:required:server"
    ]);
    // The errors handed in are left as they were.
    expect(errors[0]!.componentId).toBe("email");
  });

  it("leaves errors alone without hosts", () => {
    const errors = [err("email", "required")];
    expect(journeyPageErrors(errors, undefined)).toBe(errors);
    expect(journeyPageErrors(errors, Object.create(null) as Record<string, string>)).toBe(errors);
  });

  it("keeps two messages that share a code on the host, and drops a repeat of one", () => {
    const said = (componentId: string, code: string, message: string, stage = "plugin"): FormError =>
      ({ ...err(componentId, code, stage), message }) as FormError;
    const errors = [
      said("work_email", "pattern", "Use lower-case letters", "presentation-fields"),
      said("email", "pattern", "Use a government address", "field-constraints"),
      said("email", "custom", "Blocked domain"),
      said("email", "custom", "Address already registered"),
      said("email", "custom", "Blocked domain", "server"),
      err("work_email", "required", "presentation-fields"),
      err("email", "required")
    ];
    const hosted = journeyPageErrors(errors, { email: "work_email" });
    expect(hosted.map((error) => `${error.componentId}:${error.code}:${error.message ?? "-"}`)).toEqual([
      "work_email:pattern:Use lower-case letters",
      "work_email:pattern:Use a government address",
      "work_email:custom:Blocked domain",
      "work_email:custom:Address already registered",
      // The same code with the same message, and the two Required with none: one each.
      "work_email:required:-"
    ]);
  });
});
