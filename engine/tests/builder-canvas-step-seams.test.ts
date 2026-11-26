// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController, type BuilderControllerOptions } from "../form-engine/builder/controller/builder-controller.js";
import { JOURNEY_AUTHORING_EN } from "../form-engine/builder/journey-designer/journey-authoring-texts-en.js";
import { createJourneyDesigner } from "../form-engine/builder/journey-designer/journey-designer.js";
import { JOURNEY_CONTENT_SLOT, JOURNEY_FIELD_TYPE, JOURNEY_PAGES_SLOT } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { builderText } from "../form-engine/builder/journey-designer/journey-texts-en.js";
import { createStepCanvas, STEP_DRAWN_TWICE_CODE, type StepCanvas, type StepOwnerWords, type StepTagWords } from "../form-engine/builder/journey-designer/step-canvas-adapter.js";
import { createDatumBinding } from "../form-engine/render/live/datum/options.js";
import type { LiveBinding } from "../form-engine/render/live/contract.js";
import { html } from "../form-engine/render/live/lit.js";
import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";
import type { NestedTreeNodeView } from "../form-engine/builder/tree-editor/nested-tree-view.js";
import { DATUM_BUILDER_CANVAS_TAG, defineBuilderPanels, type DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import type { JourneyView } from "../form-engine/core/journey/journey-types.js";
import type { TextSources } from "../form-engine/core/localization/translations.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";

/**
 * The canvas seams that let the Form canvas draw ONE journey step in edit mode over the
 * journey's controller.
 *
 * - The preview runtime holds the journey page the tree is drawn as
 *   (`setFormRoot(root, { journeyView })`, `journeyView()`), the controller hands it from its
 *   `canvasJourneyView` option, one draw per change of either, none for a repaint over both.
 * - The controller builds the canvas's tree view itself (`canvasTreeView()`, `canvasRootId()`)
 *   over `canvasSnapshot()`, the `canvasView` option only pruning and naming it.
 * - A swap of `canvasRoot`, `canvasView` or `canvasJourneyView` (`canvasRevision()`) is one
 *   draw with the renderer off its runtime meanwhile, and keeps the pan and zoom.
 * - The step adapter draws no id twice and says what it left out; its build is kept until either
 *   controller changes.
 * - The chrome seams: a journey-only field carries its
 *   "Not sent" tag (`canvasTags`); the step owns its heading, counter and buttons, one box per
 *   region, named, inert, selected by a click or the keyboard walk (`canvasRegionOwner`); a
 *   field inside a placed form container is part of the placement's box (`canvasSelectTarget`).
 */

defineBuilderPanels();

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
  return [group("form", { title: "Form" }), leaf("text"), leaf("number"), group("fieldset", { label: "fieldset" })];
}

const FORM_TYPES = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "fieldset", label: "Fieldset" }
];

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        { id: "email", type: "text", configuration: { label: "Email" } },
        {
          id: "section",
          type: "fieldset",
          configuration: { label: "Where you live" },
          children: {
            content: [
              {
                id: "address",
                type: "fieldset",
                configuration: { label: "Address" },
                children: { content: [{ id: "street", type: "text", configuration: { label: "Street" } }, { id: "city", type: "text", configuration: { label: "City" } }] }
              },
              { id: "since", type: "text", configuration: { label: "Living there since" } }
            ]
          }
        },
        { id: "notes", type: "text", configuration: { label: "Notes" } }
      ]
    }
  };
}

function standardJourney(): Journey {
  return {
    id: "intake",
    name: "Step by step",
    progress: "count",
    pages: [
      { id: "about", title: "About you", components: ["fullName", { id: "nickname", type: "text", configuration: { label: "Nickname" } }] },
      { id: "contact", title: "How to reach you", components: ["email", "address"] },
      { id: "finish", title: "Anything else", components: ["notes"] }
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
  /** The chrome seams' options, made once so their identity holds across Step view entries. */
  chrome: Pick<BuilderControllerOptions, "canvasTags" | "canvasRegionOwner" | "canvasSelectTarget">;
}

/** The form's controller and one journey's, set up as the Journeys mode sets them up (the page-only chunk in). */
async function setup(options: { journey?: Journey; locale?: string; sources?: TextSources; form?: ComponentNode } = {}): Promise<Setup> {
  const form = new BuilderController({ initialRoot: options.form ?? formRoot(), componentTypes: FORM_TYPES, componentDefinitions: formDefinitions() });
  const designer = createJourneyDesigner({
    formRoot: () => form.snapshot(),
    locale: () => options.locale ?? "en",
    ...(options.sources ? { sources: () => options.sources } : {}),
    formDefinitions: () => formDefinitions(),
    formTypes: () => form.componentTypes()
  });
  await designer.loadAuthoring();
  const pageIds = new Map<string, string>();
  const references = new Map<string, Record<string, unknown>>();
  const tree = designer.treeFromJourney(options.journey ?? standardJourney(), { pageIds, references, formIds: allIds(form.snapshot()) });
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
    journeyRevision: () => controller.changeRevision()
  });
  const pageNode = (pageId: string): ComponentNode =>
    (controller.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? []).find((node) => (node.configuration as { pageId?: string }).pageId === pageId)!;
  const chrome = {
    canvasTags: (root: ComponentNode) => step.tags(root, TAG_WORDS),
    canvasRegionOwner: (root: ComponentNode) => step.regionOwner(root, OWNER_WORDS),
    canvasSelectTarget: step.selectTargets
  };
  return { form, journey: controller, step, page, pageNode, chrome };
}

/** The words the mode hands the adapter, from the tables that own them. */
const TAG_WORDS: StepTagWords = { notSent: JOURNEY_AUTHORING_EN["journey.designer.own.notSent"] };
const OWNER_WORDS: StepOwnerWords = { step: ({ number, name }) => builderText("journey.designer.page.ref", { number: number ?? "", name }) };

/** The Step view's options on the journey's controller (the mode wires these), the chrome seams unless `chrome: false`. */
function enterStep(s: Setup, pageId: string, options: { chrome?: false; binding?: LiveBinding } = {}): void {
  s.page.id = s.pageNode(pageId).id;
  s.journey.setOptions({
    binding: options.binding,
    canvasComponents: undefined,
    canvasRoot: s.step.canvasRoot,
    canvasView: s.step.canvasView,
    canvasJourneyView: s.step.journeyView,
    ...(options.chrome === false ? {} : s.chrome)
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

interface Mounted {
  canvas: DatumBuilderCanvasElement;
  renderer: DatumFormRendererElement;
  shadow: () => ShadowRoot;
}

async function mountCanvas(controller: BuilderController): Promise<Mounted> {
  const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
  canvas.controller = controller;
  document.body.append(canvas);
  const renderer = canvas.shadowRoot!.querySelector("[data-preview]") as DatumFormRendererElement;
  await settled(renderer);
  return { canvas, renderer, shadow: () => renderer.shadowRoot! };
}

/** Draws of the renderer while `act` runs and settles, over whichever mount it ends on. */
async function drawsDuring(renderer: DatumFormRendererElement, act: () => void): Promise<number> {
  await settled(renderer);
  const before = renderer.live!;
  const from = before.draws();
  act();
  await settled(renderer);
  const after = renderer.live!;
  return after === before ? after.draws() - from : before.draws() - from + after.draws();
}

const box = (shadow: ShadowRoot, id: string): HTMLElement | null => shadow.querySelector<HTMLElement>(`.db-node[data-component-id="${id}"]`);
const heading = (shadow: ShadowRoot): string => shadow.querySelector<HTMLElement>("[data-journey-heading]")?.textContent ?? "";
const contentOf = (s: Setup, pageId: string): ComponentNode[] => s.pageNode(pageId).children?.[JOURNEY_CONTENT_SLOT] ?? [];
const placementIds = (s: Setup, pageId: string, componentId: string): string[] =>
  contentOf(s, pageId)
    .filter((entry) => entry.type === JOURNEY_FIELD_TYPE && (entry.configuration as { componentId?: string }).componentId === componentId)
    .map((entry) => entry.id);
function viewNode(view: NestedTreeNodeView, id: string): NestedTreeNodeView | undefined {
  if (view.id === id) {
    return view;
  }
  for (const child of view.slots.flatMap((slot) => slot.children)) {
    const hit = viewNode(child, id);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

function pageView(overrides: Partial<JourneyView> = {}): JourneyView {
  return {
    journeyId: "intake",
    journey: { id: "intake", pages: [] } as unknown as Journey,
    pageId: "contact",
    page: { id: "contact", title: "How to reach you" },
    kind: "questions",
    path: ["about", "contact"],
    index: 1,
    total: 2,
    number: 2,
    completed: [],
    frontierPageId: "contact",
    backPageId: "about",
    final: true,
    end: "end",
    members: ["email"],
    pageOf: {},
    validation: { continue: "defer", server: false, onUnavailable: "block" } as JourneyView["validation"],
    ...overrides
  };
}

describe("the preview runtime holds the journey page the tree is drawn as", () => {
  function counted(runtime: BuilderPreviewRuntime): () => number {
    let count = 0;
    runtime.events().subscribe(FormEventType.FORM_INITIALIZED, () => {
      count += 1;
    });
    return () => count;
  }

  it("keys the repaint guard on the tree and the view together: one publish per change of either, none for a repaint over both", () => {
    const root = formRoot();
    const runtime = new BuilderPreviewRuntime(root);
    const published = counted(runtime);
    expect(runtime.journeyView()).toBeUndefined();
    // The Form canvas's call: no view, the same tree, nothing drawn.
    runtime.setFormRoot(structuredClone(root));
    runtime.setFormRoot(structuredClone(root), { journeyView: undefined });
    expect(published()).toBe(0);
    // A view over the same tree: drawn once.
    runtime.setFormRoot(structuredClone(root), { journeyView: pageView() });
    expect(published()).toBe(1);
    expect(runtime.journeyView()).toEqual(pageView());
    // The same view again, a fresh copy of each: nothing.
    runtime.setFormRoot(structuredClone(root), { journeyView: pageView() });
    expect(published()).toBe(1);
    // The step's title alone (not in the tree): drawn once.
    runtime.setFormRoot(structuredClone(root), { journeyView: pageView({ page: { id: "contact", title: "Ways to reach you" } }) });
    expect(published()).toBe(2);
    // Tree and view both: still one publish.
    const edited = structuredClone(root);
    (edited.children!.content![0]!.configuration as { label: string }).label = "Your name";
    runtime.setFormRoot(edited, { journeyView: pageView({ number: 1, index: 0 }) });
    expect(published()).toBe(3);
    expect(runtime.formRoot()).toBe(edited);
    // Back to the whole form.
    runtime.setFormRoot(structuredClone(edited));
    expect(published()).toBe(4);
    expect(runtime.journeyView()).toBeUndefined();
  });

  it("a tree holding an id twice is taken as it always was (the Form canvas draws on); only a root it cannot read is refused, never thrown", () => {
    const root = formRoot();
    const runtime = new BuilderPreviewRuntime(root);
    runtime.setFormRoot(root, { journeyView: pageView() });
    const published = counted(runtime);
    const twice = structuredClone(root);
    twice.children!.content!.push({ id: "email", type: "text", configuration: { label: "Email again" } });
    expect(() => runtime.setFormRoot(twice, { journeyView: pageView({ number: 1 }) })).not.toThrow();
    expect(published()).toBe(1);
    expect(runtime.formRoot()).toBe(twice);
    expect(runtime.journeyView()).toEqual(pageView({ number: 1 }));
    // A root with no id: the last tree and its view are kept, nothing published or thrown.
    const unreadable = { ...structuredClone(twice), id: "" };
    expect(() => runtime.setFormRoot(unreadable, { journeyView: pageView({ number: 2 }) })).not.toThrow();
    expect(published()).toBe(1);
    expect(runtime.formRoot()).toBe(twice);
    expect(runtime.journeyView()).toEqual(pageView({ number: 1 }));
  });

  it("on the canvas: a step title edit and a step reorder each redraw the heading and counter once; a repaint over the same root and view draws nothing", async () => {
    const s = await setup();
    enterStep(s, "contact");
    const { renderer, shadow } = await mountCanvas(s.journey);
    expect(heading(shadow())).toContain("How to reach you");
    expect(heading(shadow())).toContain("Step 2 of 3");
    expect(shadow().querySelector("[data-journey-back]")).not.toBeNull();
    const contact = s.pageNode("contact").id;
    // The title lives on the page node, not in the drawn root.
    expect(await drawsDuring(renderer, () => s.journey.setProperty(contact, "title", "Ways to reach you"))).toBe(1);
    expect(heading(shadow())).toContain("Ways to reach you");
    expect(heading(shadow())).toContain("Step 2 of 3");
    // The chrome's name follows in that same draw.
    expect(shadow().querySelector("[data-db-region-owner]")!.getAttribute("aria-label")).toBe("Step 2 · Ways to reach you");
    // The step moved first: the counter and Back follow; the drawn root is the same. Selected
    // first, as a move from the selection bar is: a move that also moves the selection draws
    // twice on the Form canvas too (its hooks and its tree, measured there: 2), not a cost of the journey view.
    expect(await drawsDuring(renderer, () => s.journey.select(contact))).toBe(1);
    expect(await drawsDuring(renderer, () => s.journey.moveBy(contact, -1))).toBe(1);
    expect(heading(shadow())).toContain("Step 1 of 3");
    expect(shadow().querySelector("[data-db-region-owner]")!.getAttribute("aria-label")).toBe("Step 1 · Ways to reach you");
    expect(shadow().querySelector("[data-journey-back]")).toBeNull();
    expect(await drawsDuring(renderer, () => s.journey.repaintPreview())).toBe(0);
    // Undo puts both back, in one draw each.
    expect(await drawsDuring(renderer, () => s.journey.undo())).toBe(1);
    expect(heading(shadow())).toContain("Step 2 of 3");
  });
});

describe("the controller builds the canvas's tree view", () => {
  it("the Form controller's canvas reads are its own reads: no hook, no journey view, no revision", () => {
    const form = new BuilderController({ initialRoot: formRoot(), componentTypes: FORM_TYPES, componentDefinitions: formDefinitions() });
    expect(form.canvasTreeView()).toEqual(form.treeView());
    expect(form.canvasRootId()).toBe(form.rootId());
    expect(form.canvasJourneyView()).toBeUndefined();
    const revision = form.canvasRevision();
    const changes = form.changeRevision();
    form.select("email");
    form.setProperty("email", "label", "E-mail");
    form.setOptions({ locale: "fr" });
    expect(form.canvasRevision()).toBe(revision);
    expect(form.changeRevision()).toBeGreaterThan(changes);
    expect(form.canvasTreeView()).toEqual(form.treeView());
  });

  it("the step's view: the root is the page node with its content slot as the page declares it; a journey-only container keeps its slots and allowed types; a placed container has none", async () => {
    const s = await setup();
    const contact = s.pageNode("contact").id;
    s.journey.add("fieldset", contact, JOURNEY_CONTENT_SLOT, { configuration: { label: "Extra" } });
    const own = contentOf(s, "contact").at(-1)!;
    enterStep(s, "contact");
    const view = s.journey.canvasTreeView();
    const journeyView = s.journey.treeView();
    expect(s.journey.canvasRootId()).toBe(contact);
    expect(view.id).toBe(contact);
    // The root's one slot is the page's own content slot: its definition and allowed types, never the form root's or the page's routes.
    const pageContent = viewNode(journeyView, contact)!.slots.find((slot) => slot.slotId === JOURNEY_CONTENT_SLOT)!;
    expect(view.slots.map((slot) => slot.slotId)).toEqual([JOURNEY_CONTENT_SLOT]);
    expect(pageContent.allowedTypes?.length ?? 0).toBeGreaterThan(0);
    expect(view.slots[0]!.allowedTypes).toEqual(pageContent.allowedTypes);
    expect(view.slots[0]!.definition).toEqual(pageContent.definition);
    // The journey-only fieldset: the slots the journey's own view gives it.
    const ownInJourney = viewNode(journeyView, own.id)!;
    const ownOnCanvas = viewNode(view, own.id)!;
    expect(ownInJourney.slots.length).toBeGreaterThan(0);
    expect(ownOnCanvas.slots.map((slot) => [slot.slotId, slot.allowedTypes, slot.multiple])).toEqual(ownInJourney.slots.map((slot) => [slot.slotId, slot.allowedTypes, slot.multiple]));
    expect(ownOnCanvas.slots[0]!.allowedTypes?.length ?? 0).toBeGreaterThan(0);
    // The placed form container: drawn whole, walked never.
    const [addressAt] = placementIds(s, "contact", "address");
    expect(viewNode(view, addressAt!)!.slots).toEqual([]);
    expect(viewNode(view, "street")).toBeUndefined();
    // Every node is named as the journey names the node it stands for.
    const [emailAt] = placementIds(s, "contact", "email");
    expect(viewNode(view, emailAt!)!.label).toBe(viewNode(journeyView, emailAt!)!.label);
    expect(viewNode(view, addressAt!)!.label).toBe(viewNode(journeyView, addressAt!)!.label);
    expect(ownOnCanvas.label).toBe(ownInJourney.label);
    expect(view.label).toBe(viewNode(journeyView, contact)!.label);
  });

  it("names the step's nodes in the builder's language, through the form's translations and the host's catalog", async () => {
    const sources: TextSources = {
      catalog: { fr: { components: { email: { label: "Courriel" }, nickname: { label: "Surnom" }, address: { label: "Adresse" } } } }
    };
    const s = await setup({ locale: "fr", sources });
    enterStep(s, "contact");
    const [emailAt] = placementIds(s, "contact", "email");
    const [addressAt] = placementIds(s, "contact", "address");
    const view = s.journey.canvasTreeView();
    expect(viewNode(view, emailAt!)!.label).toBe("Courriel");
    expect(viewNode(view, addressAt!)!.label).toBe("Adresse");
    s.page.id = s.pageNode("about").id;
    s.journey.repaintPreview();
    expect(viewNode(s.journey.canvasTreeView(), "nickname")!.label).toBe("Surnom");
  });

  it("the canvas reads the step's view: drop zones on the page's content, the selection bar names the placement, the step's root takes no bar", async () => {
    const s = await setup();
    enterStep(s, "contact");
    const { canvas, renderer, shadow } = await mountCanvas(s.journey);
    const contact = s.pageNode("contact").id;
    const rootZone = shadow().querySelector<HTMLElement>("[data-db-root]")!;
    expect(rootZone.getAttribute("data-parent-id")).toBe(contact);
    expect(rootZone.getAttribute("data-slot-id")).toBe(JOURNEY_CONTENT_SLOT);
    expect(shadow().querySelector('[data-dropzone][data-parent-id="address"]')).toBeNull();
    const [emailAt] = placementIds(s, "contact", "email");
    s.journey.select(emailAt);
    await settled(renderer);
    const zone = canvas.shadowRoot!.querySelector<HTMLElement>("[data-selection-zone]")!;
    expect(zone.hidden).toBe(false);
    expect(canvas.shadowRoot!.querySelector("[data-selection-name]")!.textContent).toBe("Email");
    // The step itself is the canvas's root: outlined on its zone, no Move/Duplicate/Delete bar.
    s.journey.select(contact);
    await settled(renderer);
    expect(zone.hidden).toBe(true);
    expect(renderer.hasAttribute("data-db-root-selected")).toBe(true);
  });
});

describe("swapping what the same controller is drawn as", () => {
  it("is one draw on a new mount, the old one drawing nothing more, and keeps the pan, the zoom and the fitted width", async () => {
    const s = await setup();
    const { canvas, renderer, shadow } = await mountCanvas(s.journey);
    canvas.zoomTo(1.5);
    const state = canvas as unknown as { panX: number; panY: number; zoomChosen: boolean; appliedFixedWidth: number | undefined };
    state.panX = 40;
    state.panY = -12;
    await settled(renderer);
    // The author's zoom, and the fluid sheet's (no fixed width to fit).
    expect([state.zoomChosen, state.appliedFixedWidth]).toEqual([true, undefined]);
    const before = renderer.live!;
    const from = before.draws();
    const revision = s.journey.canvasRevision();
    enterStep(s, "contact");
    expect(s.journey.canvasRevision()).toBeGreaterThan(revision);
    await settled(renderer);
    const after = renderer.live!;
    expect(after).not.toBe(before);
    expect(before.draws() - from).toBe(0);
    expect(after.draws()).toBe(1);
    expect(heading(shadow())).toContain("How to reach you");
    expect(canvas.zoom).toBe(1.5);
    expect([state.panX, state.panY, state.zoomChosen, state.appliedFixedWidth]).toEqual([40, -12, true, undefined]);
    // And back to the cards: one draw again, the same pan and zoom.
    const stepMount = renderer.live!;
    const stepDraws = stepMount.draws();
    s.journey.setOptions({ canvasView: undefined, canvasJourneyView: undefined, canvasRoot: undefined });
    await settled(renderer);
    expect(stepMount.draws() - stepDraws).toBe(0);
    expect(renderer.live!.draws()).toBe(1);
    expect(shadow().querySelector("[data-journey-heading]")).toBeNull();
    expect(canvas.zoom).toBe(1.5);
    expect([state.panX, state.panY]).toEqual([40, -12]);
  });

  it("another controller is still a sheet of its own: its pan and zoom start afresh", async () => {
    const s = await setup();
    enterStep(s, "contact");
    const { canvas, renderer } = await mountCanvas(s.journey);
    canvas.zoomTo(1.5);
    (canvas as unknown as { panX: number }).panX = 40;
    canvas.controller = s.form;
    await settled(renderer);
    expect(canvas.zoom).toBe(1);
    expect((canvas as unknown as { panX: number }).panX).toBe(0);
  });

  it("an edit, a selection or the step shown changes no canvas revision: the runtime and its mount are kept", async () => {
    const s = await setup();
    enterStep(s, "contact");
    const { renderer, shadow } = await mountCanvas(s.journey);
    const revision = s.journey.canvasRevision();
    const mount = renderer.live!;
    const [emailAt] = placementIds(s, "contact", "email");
    expect(await drawsDuring(renderer, () => s.journey.select(emailAt))).toBe(1);
    expect(await drawsDuring(renderer, () => s.form.setDraftProperty("email", "label", "E-mail"))).toBe(0);
    // The form's change reaches the journey's canvas as the mode forwards it (a repaint).
    expect(await drawsDuring(renderer, () => s.journey.repaintPreview())).toBe(1);
    // Another step on the same hooks: its tree and its root id (the hooks' key) both move, which
    // the Form canvas also draws twice (a tree change that moves the hooks); the step picker
    // may want it at one.
    expect(await drawsDuring(renderer, () => {
      s.page.id = s.pageNode("finish").id;
      s.journey.repaintPreview();
    })).toBe(2);
    expect(heading(shadow())).toContain("Anything else");
    expect(renderer.live).toBe(mount);
    expect(s.journey.canvasRevision()).toBe(revision);
  });
});

describe("the step adapter", () => {
  /** One step listing a container, then the container around it (or the other way round). */
  function nested(order: "inner-first" | "outer-first"): Journey {
    return {
      id: "intake",
      name: "Nested",
      pages: [{ id: "where", title: "Where you live", components: order === "inner-first" ? ["address", "section"] : ["section", "address"] }]
    } as Journey;
  }

  it("draws no id twice when a container and the container around it are both on one step, and says what the later one was drawn without", async () => {
    const s = await setup({ journey: nested("inner-first") });
    s.page.id = s.pageNode("where").id;
    const tree = s.journey.previewSnapshot();
    const root = s.step.canvasRoot(tree);
    const ids = allIds(root);
    expect(new Set(ids).size).toBe(ids.length);
    const [addressAt] = placementIds(s, "where", "address");
    const [sectionAt] = placementIds(s, "where", "section");
    // The section is drawn with what it holds but the address, which its own placement drew
    // first (under the placement's id): not again as an empty fieldset, nor its fields.
    const section = root.children![JOURNEY_CONTENT_SLOT]!.find((node) => node.id === sectionAt)!;
    expect(allIds(section)).toEqual([sectionAt, "since"]);
    const address = root.children![JOURNEY_CONTENT_SLOT]!.find((node) => node.id === addressAt)!;
    expect(allIds(address)).toEqual([addressAt, "street", "city"]);
    expect(s.step.drawnTwice(tree)).toEqual([{ nodeId: sectionAt, ids: ["address"], drawnBy: { address: addressAt } }]);
    const findings = s.step.findings(tree, (left) => builderText("journey.designer.step.drawnTwice", { ids: left.ids.join(", "), by: left.ids.map((id) => left.drawnBy[id]).join(", ") }));
    expect([...findings]).toEqual([[sectionAt, [{ severity: "warning", code: STEP_DRAWN_TWICE_CODE, message: "address already on this step (" + addressAt + "): not drawn again here. Place it once." }]]]);
  });

  it("a field placed before the container around it: the container is drawn without it, and says so", async () => {
    const s = await setup({
      journey: { id: "intake", name: "Leaf first", pages: [{ id: "where", title: "Where", components: ["street", "address"] }] } as Journey
    });
    s.page.id = s.pageNode("where").id;
    const tree = s.journey.previewSnapshot();
    const root = s.step.canvasRoot(tree);
    const [streetAt] = placementIds(s, "where", "street");
    const [addressAt] = placementIds(s, "where", "address");
    // Street once (as its placement); the address holds City only.
    expect(allIds(root)).toEqual([root.id, streetAt, addressAt, "city"]);
    expect(s.step.drawnTwice(tree)).toEqual([{ nodeId: addressAt, ids: ["street"], drawnBy: { street: streetAt } }]);
    expect([...s.step.findings(tree, (left) => left.ids.join(", "))].map(([nodeId, list]) => [nodeId, list.map((finding) => finding.code)])).toEqual([[addressAt, [STEP_DRAWN_TWICE_CODE]]]);
  });

  it("the other way round: the inner container, drawn already inside the outer, is drawn again without what it holds", async () => {
    const s = await setup({ journey: nested("outer-first") });
    s.page.id = s.pageNode("where").id;
    const tree = s.journey.previewSnapshot();
    const root = s.step.canvasRoot(tree);
    const ids = allIds(root);
    expect(new Set(ids).size).toBe(ids.length);
    const [sectionAt] = placementIds(s, "where", "section");
    const [addressAt] = placementIds(s, "where", "address");
    const address = root.children![JOURNEY_CONTENT_SLOT]!.find((node) => node.id === addressAt)!;
    expect(address.children).toBeUndefined();
    expect(s.step.drawnTwice(tree)).toEqual([{ nodeId: addressAt, ids: ["street", "city"], drawnBy: { street: sectionAt, city: sectionAt } }]);
  });

  it("a node of the journey's own whose id a placed container drew already is left out, never drawn twice", async () => {
    const s = await setup({
      journey: { id: "intake", name: "Clash", pages: [{ id: "where", title: "Where", components: ["address", { id: "own_1", type: "text", configuration: { label: "Own" } }] }] } as Journey
    });
    const where = s.pageNode("where").id;
    // An own node renamed onto a form id the step already draws (the engine says field.id-clash; the canvas must still draw).
    s.journey.setProperty("own_1", "label", "Own");
    const tree = structuredClone(s.journey.previewSnapshot());
    const own = tree.children![JOURNEY_PAGES_SLOT]![0]!.children![JOURNEY_CONTENT_SLOT]!.find((node) => node.id === "own_1")!;
    own.id = "street";
    s.page.id = where;
    // A fresh adapter over the edited tree (the memo is the live journey's).
    const step = createStepCanvas({ formRoot: () => s.form.previewSnapshot(), pageNodeId: () => where, journeyId: () => "intake", formRevision: () => 0, journeyRevision: () => -1 });
    const root = step.canvasRoot(tree);
    const ids = allIds(root);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === "street")).toHaveLength(1);
    expect(step.drawnTwice(tree)).toEqual([{ nodeId: "street", ids: ["street"], drawnBy: { street: placementIds(s, "where", "address")[0] } }]);
  });

  it("a canvas whose root holds an id twice paints on: nothing thrown, and every later edit drawn", async () => {
    const form = new BuilderController({ initialRoot: formRoot(), componentTypes: FORM_TYPES, componentDefinitions: formDefinitions() });
    let twice = false;
    form.setOptions({
      canvasRoot: (root) => (twice ? { ...root, children: { content: [...root.children!.content!, { id: "email", type: "text", configuration: { label: "Again" } }] } } : root)
    });
    const { renderer, shadow } = await mountCanvas(form);
    expect(box(shadow(), "email")).not.toBeNull();
    twice = true;
    expect(() => form.setProperty("notes", "label", "Anything else")).not.toThrow();
    await settled(renderer);
    expect(box(shadow(), "notes")!.textContent).toContain("Anything else");
    expect(() => form.setProperty("fullName", "label", "Your name")).not.toThrow();
    await settled(renderer);
    expect(box(shadow(), "fullName")!.textContent).toContain("Your name");
  });

  it("the Form canvas over a loaded definition holding an id twice draws it as it always did, and goes on drawing its edits and adds", async () => {
    // A definition loaded whole is never checked for a duplicate id (only for nesting depth).
    const loaded = formRoot();
    loaded.children!.content!.push({ id: "email", type: "text", configuration: { label: "Email again" } });
    const form = new BuilderController({ initialRoot: loaded, componentTypes: FORM_TYPES, componentDefinitions: formDefinitions() });
    const { renderer, shadow } = await mountCanvas(form);
    expect(shadow().querySelectorAll('.db-node[data-component-id="email"]')).toHaveLength(2);
    form.setProperty("notes", "label", "Changed notes label");
    await settled(renderer);
    expect(box(shadow(), "notes")!.textContent).toContain("Changed notes label");
    const before = new Set([...shadow().querySelectorAll<HTMLElement>(".db-node[data-component-id]")].map((node) => node.dataset.componentId));
    form.add("text", form.rootId(), "content", { configuration: { label: "Added later" } });
    await settled(renderer);
    const added = [...shadow().querySelectorAll<HTMLElement>(".db-node[data-component-id]")].filter((node) => !before.has(node.dataset.componentId));
    expect(added).toHaveLength(1);
    expect(added[0]!.textContent).toContain("Added later");
  });

  it("keeps its build until either controller changes or another step is shown", async () => {
    const s = await setup();
    enterStep(s, "contact");
    const first = s.step.canvasRoot(s.journey.previewSnapshot());
    expect(s.step.canvasRoot(s.journey.previewSnapshot())).toBe(first);
    expect(s.journey.canvasSnapshot()).toBe(first);
    s.form.setDraftProperty("email", "label", "E-mail");
    const drafted = s.step.canvasRoot(s.journey.previewSnapshot());
    expect(drafted).not.toBe(first);
    expect((drafted.children![JOURNEY_CONTENT_SLOT]![0]!.configuration as { label: string }).label).toBe("E-mail");
    s.journey.select(placementIds(s, "contact", "email")[0]);
    expect(s.step.canvasRoot(s.journey.previewSnapshot())).not.toBe(drafted);
    const selected = s.step.canvasRoot(s.journey.previewSnapshot());
    s.page.id = s.pageNode("about").id;
    expect(s.step.canvasRoot(s.journey.previewSnapshot())).not.toBe(selected);
    expect(s.step.canvasRoot(s.journey.previewSnapshot()).id).toBe(s.pageNode("about").id);
  });

  it("counts a Check answers step as the engine's journey view does: the counter takes questions and review steps, never an exit", async () => {
    const journey = standardJourney();
    journey.pages = [
      journey.pages[0]!,
      { id: "stop", kind: "exit", components: [] },
      { id: "check", kind: "review", components: [] }
    ] as Journey["pages"];
    const s = await setup({ journey });
    const viewOf = (pageId: string): JourneyView => {
      s.page.id = s.pageNode(pageId).id;
      return s.step.journeyView(s.journey.previewSnapshot())!;
    };
    expect(viewOf("about")).toMatchObject({ kind: "questions", total: 2, number: 1 });
    expect(viewOf("check")).toMatchObject({ kind: "review", total: 2, number: 2, final: true });
    expect(viewOf("stop")).toMatchObject({ kind: "exit", total: 2 });
  });
});

describe("the sheet a step is drawn on", () => {
  it("is flush when the form draws its own frame, as the Form canvas's sheet is: read off the drawn root, not the journey's", async () => {
    const framed = formRoot();
    (framed.configuration as Record<string, unknown>).chrome = { frame: "outlined" };
    const s = await setup({ form: framed });
    const surface = (canvas: DatumBuilderCanvasElement): HTMLElement => canvas.shadowRoot!.querySelector<HTMLElement>(".canvas-surface")!;
    const onForm = await mountCanvas(s.form);
    expect(surface(onForm.canvas).classList.contains("canvas-surface--flush")).toBe(true);
    // The journey's Pages cards (no step drawn): the journey tree's root, which draws no frame.
    const onJourney = await mountCanvas(s.journey);
    expect(surface(onJourney.canvas).classList.contains("canvas-surface--flush")).toBe(false);
    enterStep(s, "contact");
    await settled(onJourney.renderer);
    expect(surface(onJourney.canvas).classList.contains("canvas-surface--flush")).toBe(true);
    // A form with no frame of its own: the step's sheet keeps its border, as the form's does.
    const plain = await setup();
    enterStep(plain, "contact");
    const onPlainStep = await mountCanvas(plain.journey);
    expect(surface(onPlainStep.canvas).classList.contains("canvas-surface--flush")).toBe(false);
  });
});

// ── The chrome seams ─────────────────────────────────────────────────────

/** Everything a person could Tab to inside the drawn form: focusable, not under `inert`, not taken out (`tabindex="-1"`). */
function tabStops(shadow: ShadowRoot): HTMLElement[] {
  return [...shadow.querySelectorAll<HTMLElement>("input, select, textarea, button, a[href], summary, [tabindex]")].filter(
    (element) => element.closest("[inert]") === null && element.getAttribute("tabindex") !== "-1" && !(element as HTMLButtonElement).disabled
  );
}

const regionBoxes = (shadow: ShadowRoot): HTMLElement[] => [...shadow.querySelectorAll<HTMLElement>("[data-db-region-owner]")];

/** A key pressed on the canvas's one Tab stop, where its keys are read. */
function press(canvas: DatumBuilderCanvasElement, key: string): void {
  canvas.shadowRoot!.querySelector<HTMLElement>(".canvas-page")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
}

const announced = (canvas: DatumBuilderCanvasElement): string => canvas.shadowRoot!.querySelector("[data-canvas-announce]")!.textContent ?? "";

/** A click as a pointer makes it: `false` when the canvas took it (default prevented). */
function clickOn(element: HTMLElement): boolean {
  return element.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
}

/** The direct children of a box with a class (`:scope` does not reach into shadow trees under jsdom). */
const ownChild = (element: HTMLElement, className: string): HTMLElement | undefined => [...element.children].find((child): child is HTMLElement => child.classList.contains(className));

describe("the step owns its heading, counter and buttons", () => {
  it("draws them in one box per region, both the step's and named for it, with no component box under the page's id, out of the Tab order", async () => {
    const s = await setup();
    enterStep(s, "contact");
    const { canvas, shadow } = await mountCanvas(s.journey);
    const contact = s.pageNode("contact").id;
    const boxes = regionBoxes(shadow());
    expect(boxes.map((element) => [element.dataset.dbRegion, element.dataset.dbRegionOwner, element.getAttribute("role"), element.getAttribute("aria-label")])).toEqual([
      ["page-header", contact, "group", "Step 2 · How to reach you"],
      ["page-actions", contact, "group", "Step 2 · How to reach you"]
    ]);
    expect(boxes[0]!.querySelector("[data-journey-heading]")!.textContent).toContain("How to reach you");
    expect(boxes[1]!.querySelector("[data-journey-continue]")).not.toBeNull();
    expect(boxes[1]!.querySelector("[data-journey-back]")).not.toBeNull();
    // One owner: nothing drawn carries the page node's id as a component's.
    expect(shadow().querySelector(`[data-component-id="${contact}"]`)).toBeNull();
    // Out of the Tab order and inert, as a field's leaf is: the canvas's page is the one Tab stop.
    for (const button of shadow().querySelectorAll<HTMLElement>("[data-journey-continue], [data-journey-back]")) {
      expect(button.getAttribute("tabindex")).toBe("-1");
      expect(button.closest("[inert]")).not.toBeNull();
    }
    expect(tabStops(shadow())).toEqual([]);
    expect(canvas.shadowRoot!.querySelector(".canvas-page")!.getAttribute("tabindex")).toBe("0");
    // No stopgap marks remain.
    expect(shadow().querySelector("[data-db-chrome-inert]")).toBeNull();
  });

  it("a click on the heading, the counter, Back or Continue selects the step on the journey controller: both boxes outlined, no bar, no background", async () => {
    const s = await setup();
    enterStep(s, "contact");
    const { canvas, renderer, shadow } = await mountCanvas(s.journey);
    const contact = s.pageNode("contact").id;
    const [emailAt] = placementIds(s, "contact", "email");
    let background = 0;
    canvas.addEventListener("canvas-background", () => {
      background += 1;
    });
    for (const selector of ["[data-journey-heading]", ".datum-form__journey-progress", "[data-journey-back]", "[data-journey-continue]", ".datum-form__journey-actions"]) {
      s.journey.select(emailAt);
      await settled(renderer);
      expect(clickOn(shadow().querySelector<HTMLElement>(selector)!), selector).toBe(false);
      await settled(renderer);
      expect(s.journey.selectedComponentId(), selector).toBe(contact);
    }
    expect(background).toBe(0);
    expect(renderer.hasAttribute("data-db-root-selected")).toBe(true);
    expect(regionBoxes(shadow()).map((element) => element.classList.contains("db-selected"))).toEqual([true, true]);
    expect(canvas.shadowRoot!.querySelector<HTMLElement>("[data-selection-zone]")!.hidden).toBe(true);
    // Another selection takes the outline off both.
    s.journey.select(emailAt);
    await settled(renderer);
    expect(regionBoxes(shadow()).some((element) => element.classList.contains("db-selected"))).toBe(false);
    // The last step's Submit, and its name.
    s.page.id = s.pageNode("finish").id;
    s.journey.repaintPreview();
    await settled(renderer);
    const submit = shadow().querySelector<HTMLElement>("[data-journey-continue]")!;
    expect(submit.classList.contains("datum-form__journey-submit")).toBe(true);
    expect(clickOn(submit)).toBe(false);
    await settled(renderer);
    expect(s.journey.selectedComponentId()).toBe(s.pageNode("finish").id);
    expect(regionBoxes(shadow())[0]!.getAttribute("aria-label")).toBe("Step 3 · Anything else");
  });

  it("selecting the step by its chrome is one draw, as any selection is", async () => {
    const s = await setup();
    enterStep(s, "contact");
    const { renderer, shadow } = await mountCanvas(s.journey);
    expect(await drawsDuring(renderer, () => shadow().querySelector<HTMLElement>("[data-journey-heading]")!.click())).toBe(1);
    expect(s.journey.selectedComponentId()).toBe(s.pageNode("contact").id);
  });

  it("knows no binding's markup: under a binding whose page chrome has none of Datum's classes or marks, a click anywhere on it selects the step", async () => {
    const binding = createDatumBinding({
      parts: {
        journeyHeading: (part) => html`<header class="acme-page"><h2 class="acme-title">${part.state.title}</h2><p class="acme-count">Two of three</p></header>`,
        journeyActions: (part) => html`<div class="acme-row"><button type="button" class="acme-next">${part.state.nextLabel}</button><span class="acme-gap">or</span></div>`
      }
    });
    const s = await setup();
    enterStep(s, "contact", { binding });
    const { renderer, shadow } = await mountCanvas(s.journey);
    expect(shadow().querySelector(".datum-form__journey-actions, [data-journey-continue], [data-journey-heading]")).toBeNull();
    const contact = s.pageNode("contact").id;
    const [emailAt] = placementIds(s, "contact", "email");
    for (const selector of [".acme-title", ".acme-count", ".acme-page", ".acme-next", ".acme-gap", ".acme-row"]) {
      s.journey.select(emailAt);
      await settled(renderer);
      clickOn(shadow().querySelector<HTMLElement>(selector)!);
      await settled(renderer);
      expect(s.journey.selectedComponentId(), selector).toBe(contact);
    }
    expect(shadow().querySelector(".acme-next")!.getAttribute("tabindex")).toBe("-1");
    expect(tabStops(shadow())).toEqual([]);
  });

  it("is reached by the canvas's keyboard walk: Home selects the step and says its name, the arrows go on into its fields and back", async () => {
    const s = await setup();
    enterStep(s, "contact");
    const { canvas, renderer } = await mountCanvas(s.journey);
    const contact = s.pageNode("contact").id;
    const [emailAt] = placementIds(s, "contact", "email");
    const [addressAt] = placementIds(s, "contact", "address");
    const selected = (): string | undefined => s.journey.selectedComponentId();
    press(canvas, "Home");
    await settled(renderer);
    expect(selected()).toBe(contact);
    expect(announced(canvas)).toContain("Step 2 · How to reach you");
    expect(announced(canvas)).toContain("1 of 3");
    // On through the step, its placed group one stop (the fields inside it are the group's).
    const walk = [selected()];
    for (let i = 0; i < 4; i++) {
      press(canvas, "ArrowDown");
      await settled(renderer);
      walk.push(selected());
    }
    expect(walk).toEqual([contact, emailAt, addressAt, addressAt, addressAt]);
    expect(announced(canvas)).toContain("3 of 3");
    // Out of a field on the step: the step. In from the step: its first field.
    press(canvas, "ArrowLeft");
    await settled(renderer);
    expect(selected()).toBe(contact);
    press(canvas, "ArrowRight");
    await settled(renderer);
    expect(selected()).toBe(emailAt);
    press(canvas, "ArrowUp");
    await settled(renderer);
    expect(selected()).toBe(contact);
    // The step selected: the bar stays down, its chrome outlined.
    expect(canvas.shadowRoot!.querySelector<HTMLElement>("[data-selection-zone]")!.hidden).toBe(true);
    expect(renderer.hasAttribute("data-db-root-selected")).toBe(true);
  });

  it("Preview draws the person's chrome: no box, the buttons live and in the Tab order; editing again boxes them", async () => {
    const s = await setup();
    enterStep(s, "contact");
    const { canvas, renderer, shadow } = await mountCanvas(s.journey);
    const continueButton = (): HTMLElement => shadow().querySelector<HTMLElement>("[data-journey-continue]")!;
    canvas.previewing = true;
    await settled(renderer);
    expect(regionBoxes(shadow())).toEqual([]);
    expect(continueButton().hasAttribute("tabindex")).toBe(false);
    expect(continueButton().closest("[inert]")).toBeNull();
    expect(tabStops(shadow())).toContain(continueButton());
    canvas.previewing = false;
    await settled(renderer);
    expect(regionBoxes(shadow())).toHaveLength(2);
    expect(continueButton().getAttribute("tabindex")).toBe("-1");
    expect(continueButton().closest("[inert]")).not.toBeNull();
  });

  it("the Form canvas has none of it: no box, tag or part, no region hook; a click on its empty sheet still puts everything down", async () => {
    const form = new BuilderController({ initialRoot: formRoot(), componentTypes: FORM_TYPES, componentDefinitions: formDefinitions() });
    const { canvas, renderer, shadow } = await mountCanvas(form);
    expect(renderer.canvasHooks).toBeDefined();
    expect(renderer.canvasHooks!.decorateRegion).toBeUndefined();
    expect(shadow().querySelector("[data-journey-continue], [data-journey-back], [data-journey-heading], [data-db-region], [data-db-part-of], .db-tag--note")).toBeNull();
    // The placed-container case is the step's alone: the Form canvas boxes every component.
    expect(box(shadow(), "street")).not.toBeNull();
    form.select("email");
    await settled(renderer);
    let background = 0;
    canvas.addEventListener("canvas-background", () => {
      background += 1;
    });
    shadow().querySelector<HTMLElement>("form")!.click();
    await settled(renderer);
    expect(background).toBe(1);
    expect(form.selectedComponentId()).toBeUndefined();
  });
});

describe("a journey-only field on the step", () => {
  it("is drawn as the real field with the Not sent tag; a placement carries none, and nor does it once it fills a form field", async () => {
    const s = await setup();
    enterStep(s, "about");
    const { renderer, shadow } = await mountCanvas(s.journey);
    const nickname = box(shadow(), "nickname")!;
    expect(nickname.querySelector(".db-leaf input")).not.toBeNull();
    expect(ownChild(nickname, "db-tag--note")?.textContent).toBe("Not sent");
    const [fullNameAt] = placementIds(s, "about", "fullName");
    expect(box(shadow(), fullNameAt!)!.querySelector(".db-tag--note")).toBeNull();
    // An alias (fills) is sent as the form field it fills: the tag goes.
    s.journey.setProperty("nickname", "fills", "email");
    await settled(renderer);
    expect(ownChild(box(shadow(), "nickname")!, "db-tag--note")).toBeUndefined();
  });
});

describe("a field inside a placed form container", () => {
  it("is part of the placement's box: a click selects the whole group, its box outlined and named on the bar; the field has no box, grip or bar of its own", async () => {
    const s = await setup();
    enterStep(s, "contact");
    const { canvas, renderer, shadow } = await mountCanvas(s.journey);
    const [addressAt] = placementIds(s, "contact", "address");
    for (const id of ["street", "city"]) {
      expect(box(shadow(), id)).toBeNull();
      expect(shadow().querySelector(`[data-db-handle="${id}"]`)).toBeNull();
    }
    const street = shadow().querySelector<HTMLElement>('.datum-live-field[data-component-id="street"] input')!;
    expect(street.closest(`[data-db-part-of="${addressAt}"]`)).not.toBeNull();
    expect(street.closest("[inert]")).not.toBeNull();
    expect(street.getAttribute("tabindex")).toBe("-1");
    clickOn(street);
    await settled(renderer);
    expect(s.journey.selectedComponentId()).toBe(addressAt);
    const group = box(shadow(), addressAt!)!;
    expect(group.classList.contains("db-selected")).toBe(true);
    expect(group.querySelector(`[data-db-handle="${addressAt}"]`)).not.toBeNull();
    expect(canvas.shadowRoot!.querySelector<HTMLElement>("[data-selection-zone]")!.hidden).toBe(false);
    expect(canvas.shadowRoot!.querySelector("[data-selection-name]")!.textContent).toBe("Address");
    // Inspected as the group (the form container), never the field inside it.
    expect(s.step.route("street", s.journey.previewSnapshot()).inspect).toEqual({ controller: "form", componentId: "address", placementId: addressAt });
    expect(s.journey.canvasSelectTargets()).toEqual(new Map([["street", addressAt], ["city", addressAt]]));
  });

  it("an empty container inside the placed one is drawn with no drop zone: its slot is the form's", async () => {
    const withEmpty = formRoot();
    const address = withEmpty.children!.content![2]!.children!.content![0]!;
    address.children!.content!.push({ id: "extra", type: "fieldset", configuration: { label: "Extra" }, children: { content: [] } });
    const s = await setup({ form: withEmpty });
    enterStep(s, "contact");
    const { shadow } = await mountCanvas(s.journey);
    expect(shadow().querySelector('.datum-live-container[data-container-id="extra"]')).not.toBeNull();
    expect(shadow().querySelector('[data-dropzone][data-parent-id="extra"]')).toBeNull();
    expect(box(shadow(), "extra")).toBeNull();
    // The step's own zone is still there.
    expect(shadow().querySelector<HTMLElement>("[data-db-root]")!.getAttribute("data-parent-id")).toBe(s.pageNode("contact").id);
  });
});
