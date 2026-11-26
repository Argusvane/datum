// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createJourneyDesigner } from "../form-engine/builder/journey-designer/journey-designer.js";
import { JOURNEY_CONTENT_SLOT, JOURNEY_FIELD_TYPE, JOURNEY_PAGES_SLOT } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { createStepCanvas, type StepCanvas, type StepOwnerWords } from "../form-engine/builder/journey-designer/step-canvas-adapter.js";
import { builderText } from "../form-engine/builder/journey-designer/journey-texts-en.js";
import { journeyReviewListing, reviewListedIds, reviewPageOf, reviewRowComponent } from "../form-engine/builder/journey-designer/step-review.js";
import { JOURNEY_AUTHORING_EN } from "../form-engine/builder/journey-designer/journey-authoring-texts-en.js";
import { journeyReviewListed } from "../form-engine/render/core/journey-review.js";
import { DATUM_BUILDER_CANVAS_TAG, defineBuilderPanels, type DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";

/**
 * A Check answers step in the builder, below the mode: what the
 * step lists (`step-review.ts`, held to the engine's own rule), and the step drawn on the Form
 * canvas through the real review drawing with a placeholder answer in each row. The mode's side
 * of it (the Kind box, the inspector, the findings' fixes, the map) is in
 * `journey-builder-mode.test.ts`.
 */

defineBuilderPanels();

const STEP_WORDS = { notSent: JOURNEY_AUTHORING_EN["journey.designer.own.notSent"] };
const OWNER_WORDS: StepOwnerWords = { step: ({ number, name }) => builderText("journey.designer.page.ref", { number: number ?? "", name }) };

function formDefinitions(): ComponentDefinition[] {
  const leaf = (type: string): ComponentDefinition => ({
    type,
    version: "1.0.0",
    createDefault: () => ({ id: type, type, configuration: { label: `${type} field` } }),
    capabilities: standardFieldCapabilities({ placeholder: true })
  });
  const group = (type: string, configuration: Record<string, unknown>): ComponentDefinition => ({
    type,
    version: "1.0.0",
    createDefault: () => ({ id: type, type, configuration, children: { content: [] } }),
    capabilities: [],
    children: { slots: [{ id: "content", multiple: true }] },
    propertyEditor: { mode: "replace", fields: [{ id: "label", type: "localized-text", propertyPath: "label", label: "Label" }] }
  });
  return [group("form", { title: "Form" }), leaf("text"), leaf("number"), leaf("select"), leaf("checkbox"), group("fieldset", { label: "fieldset" }), { type: "button", version: "1.0.0", createDefault: () => ({ id: "button", type: "button", configuration: { label: "Button" } }), capabilities: [] }];
}

const FORM_TYPES = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "select", label: "Select" },
  { type: "checkbox", label: "Checkbox" },
  { type: "fieldset", label: "Fieldset" },
  { type: "button", label: "Button" }
];

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
        { id: "email", type: "text", configuration: { label: "Email" } },
        {
          id: "address",
          type: "fieldset",
          configuration: { label: "Address" },
          children: { content: [{ id: "street", type: "text", configuration: { label: "Street" } }, { id: "city", type: "text", configuration: { label: "City" } }] }
        },
        { id: "score", type: "number", configuration: { label: "Score" } },
        { id: "tenure", type: "select", configuration: { label: "Own or rent", options: [{ value: "own", label: "Own" }, { value: "rent", label: "Rent" }] } },
        { id: "agreed", type: "checkbox", configuration: { label: "I agree" } },
        { id: "notes", type: "text", configuration: { label: "Notes" } }
      ]
    }
  };
}

function journey(review: Record<string, unknown> | undefined = undefined): Journey {
  return {
    id: "intake",
    name: "Step by step",
    progress: "count",
    pages: [
      { id: "about", title: "About you", components: ["fullName", "email"] },
      { id: "home", title: "Your home", components: ["address", "tenure", "score"] },
      {
        id: "check",
        kind: "review",
        title: "Check your answers",
        ...(review ? { review } : {}),
        components: [{ id: "declaration", type: "text", configuration: { label: "Declaration" } }]
      }
    ]
  } as Journey;
}

function allIds(node: ComponentNode, into: string[] = []): string[] {
  into.push(node.id);
  for (const child of Object.values(node.children ?? {}).flat()) {
    allIds(child, into);
  }
  return into;
}

interface Setup {
  form: BuilderController;
  journey: BuilderController;
  step: StepCanvas;
  page: { id: string | undefined };
  pageNode(pageId: string): ComponentNode;
}

async function setup(written: Journey = journey()): Promise<Setup> {
  const form = new BuilderController({ initialRoot: formRoot(), componentTypes: FORM_TYPES, componentDefinitions: formDefinitions() });
  const designer = createJourneyDesigner({ formRoot: () => form.snapshot(), locale: () => "en", formDefinitions: () => formDefinitions(), formTypes: () => form.componentTypes() });
  await designer.loadAuthoring();
  const pageIds = new Map<string, string>();
  const references = new Map<string, Record<string, unknown>>();
  const tree = designer.treeFromJourney(written, { pageIds, references, formIds: allIds(form.snapshot()) });
  const controller = new BuilderController({ componentTypes: [], initialRoot: tree });
  const design = designer.entry({ journeyId: () => "intake", tree: () => controller.previewSnapshot(), pageIds, references, root: tree });
  controller.setOptions({ ...design.builderOptions, initialRoot: tree, locale: "en" });
  controller.on("change", () => design.invalidate());
  const page: { id: string | undefined } = { id: undefined };
  const step = createStepCanvas({
    formRoot: () => form.previewSnapshot(),
    pageNodeId: () => page.id,
    journeyId: () => "intake",
    formRevision: () => form.changeRevision(),
    journeyRevision: () => controller.changeRevision(),
    answerWord: () => builderText("journey.step.review.answer")
  });
  const pageNode = (pageId: string): ComponentNode => (controller.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? []).find((node) => (node.configuration as { pageId?: string }).pageId === pageId)!;
  return { form, journey: controller, step, page, pageNode };
}

function enterStepView(s: Setup, pageId: string): void {
  s.page.id = s.pageNode(pageId).id;
  s.journey.setOptions({
    binding: undefined,
    canvasComponents: undefined,
    canvasRoot: s.step.canvasRoot,
    canvasView: s.step.canvasView,
    canvasJourneyView: s.step.journeyView,
    canvasTags: (tree) => s.step.tags(tree, STEP_WORDS),
    canvasRegionOwner: (tree) => s.step.regionOwner(tree, OWNER_WORDS),
    canvasSelectTarget: s.step.selectTargets
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

async function settled(renderer: DatumFormRendererElement): Promise<void> {
  await renderer.painted();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await renderer.painted();
}

async function mountStep(s: Setup, pageId: string): Promise<{ canvas: DatumBuilderCanvasElement; renderer: DatumFormRendererElement; form: ShadowRoot }> {
  enterStepView(s, pageId);
  const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
  canvas.controller = s.journey;
  document.body.append(canvas);
  const renderer = canvas.shadowRoot!.querySelector("[data-preview]") as DatumFormRendererElement;
  await settled(renderer);
  return { canvas, renderer, form: renderer.shadowRoot! };
}

describe("what a Check answers step lists", () => {
  it("is the engine's own rule: each questions step's answers, under the earliest step that asks them", async () => {
    const s = await setup();
    const written = s.journey.snapshot();
    const designer = createJourneyDesigner({ formRoot: () => s.form.snapshot(), locale: () => "en" });
    const real = designer.journeyFromTree(written, "intake")!;
    const pageOf = reviewPageOf(s.form.snapshot(), real);
    expect(pageOf).toMatchObject({ fullName: "about", email: "about", address: "home", street: "home", tenure: "home", score: "home" });
    const mine = reviewListedIds(real, pageOf);
    const engine = journeyReviewListed({ path: real.pages.map((page) => page.id), journey: real, pageOf }).map(({ pageId, ids }) => ({ pageId, ids }));
    expect(mine).toEqual(engine);
    expect(mine).toEqual([
      { pageId: "about", ids: ["fullName", "email"] },
      { pageId: "home", ids: ["address", "tenure", "score"] }
    ]);
  });

  it("counts the answer-holding leaves, a group bringing what is in it", async () => {
    const s = await setup();
    const designer = createJourneyDesigner({ formRoot: () => s.form.snapshot(), locale: () => "en" });
    const real = designer.journeyFromTree(s.journey.snapshot(), "intake")!;
    const listing = journeyReviewListing(s.form.snapshot(), real);
    expect(listing.steps).toEqual([
      { pageId: "about", answers: ["fullName", "email"] },
      { pageId: "home", answers: ["street", "city", "tenure", "score"] }
    ]);
    expect(listing.count).toBe(6);
    expect(journeyReviewListing(s.form.snapshot(), undefined)).toEqual({ steps: [], count: 0 });
  });

  it("finds the form field a drawn row stands for from its value path", () => {
    const root = formRoot();
    expect(reviewRowComponent(root, "fullName")).toBe("fullName");
    expect(reviewRowComponent(root, "street")).toBe("street");
    expect(reviewRowComponent(root, "nothing")).toBeUndefined();
  });
});

describe("the Check answers step on the Form canvas", () => {
  it("draws the engine's review with a placeholder in each row, by step, under the heading, and no field of the form", async () => {
    const s = await setup();
    const { form } = await mountStep(s, "check");
    const review = form.querySelector<HTMLElement>("[data-journey-review]");
    expect(review).not.toBeNull();
    const headings = [...review!.querySelectorAll("h2")].map((heading) => heading.textContent!.trim());
    expect(headings).toEqual(["About you", "Your home"]);
    const keys = [...review!.querySelectorAll<HTMLElement>(".datum-form__review-list dt")].map((dt) => dt.textContent!.trim());
    expect(keys).toEqual(["Full name", "Email", "Street", "City", "Own or rent", "Score"]);
    const values = [...review!.querySelectorAll<HTMLElement>(".datum-form__review-value")].map((dd) => dd.textContent!.trim());
    expect(values).toEqual(["Answer", "Answer", "Answer", "Answer", "Own", "123"]);
    // No field of the form is on the step: only the step's own declaration.
    expect(form.querySelector('.db-node[data-component-id="fullName"]')).toBeNull();
    expect(form.querySelector('input[type="text"]')).not.toBeNull();
    expect(form.querySelector('.db-node[data-component-id="declaration"]')).not.toBeNull();
    // The counter counts the step, and it submits.
    expect(form.querySelector("[data-journey-heading]")!.textContent).toContain("Step 3 of 3");
    expect(form.querySelector("[data-journey-continue]")!.classList.contains("datum-form__journey-submit")).toBe(true);
  });

  it("words a row with the step's own wording and leaves the Change links out when they are off", async () => {
    const s = await setup(journey({ labels: { tenure: "Do you own or rent?" }, change: false }));
    const { form } = await mountStep(s, "check");
    const keys = [...form.querySelectorAll<HTMLElement>("[data-journey-review] dt")].map((dt) => dt.textContent!.trim());
    expect(keys).toContain("Do you own or rent?");
    expect(form.querySelectorAll("[data-journey-review] .datum-form__review-actions a").length).toBe(0);
  });

  it("is a step of rows nobody can drag: the canvas lists no member and no drop zone for them", async () => {
    const s = await setup();
    enterStepView(s, "check");
    const view = s.journey.canvasTreeView();
    // Only the step's own content is a place to drop: the form riding in the root is never in the view.
    expect(view.slots.map((slot) => slot.slotId)).toEqual([JOURNEY_CONTENT_SLOT]);
    expect(view.slots[0]!.children.map((child) => child.id)).toEqual(["declaration"]);
    const { form } = await mountStep(s, "check");
    expect(form.querySelector("[data-journey-review] [data-db-handle]")).toBeNull();
  });

  it("draws a form field placed on it nowhere (the engine drops it) and takes the review's own rows from the form", async () => {
    const s = await setup();
    const check = s.pageNode("check").id;
    s.journey.add(JOURNEY_FIELD_TYPE, check, JOURNEY_CONTENT_SLOT, { configuration: { componentId: "notes" } });
    const root = s.step.canvasRoot((s.page.id = check, s.journey.previewSnapshot()));
    expect(root.children![JOURNEY_CONTENT_SLOT]!.map((child) => child.id)).toEqual(["declaration"]);
    const ids = allIds(root);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names the form field a pressed row stands for from the id the drawing gave it", async () => {
    const s = await setup();
    const { form } = await mountStep(s, "check");
    const tree = s.journey.previewSnapshot();
    const row = form.querySelector<HTMLElement>('[id$="__review-tenure"]')!;
    expect(row).not.toBeNull();
    expect(s.step.reviewRow(tree, row.id)).toBe("tenure");
    expect(s.step.reviewRow(tree, "elsewhere")).toBeUndefined();
    expect(s.step.reviewRow(tree, `${row.id}__error`)).toBeUndefined();
  });
});
