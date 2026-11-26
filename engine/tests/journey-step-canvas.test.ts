// @vitest-environment jsdom
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { BUILDER_DRAG_MIME_TYPE } from "../form-engine/builder/drag-drop/html5-drag-drop.js";
import { createJourneyDesigner } from "../form-engine/builder/journey-designer/journey-designer.js";
import { JOURNEY_CONTENT_SLOT, JOURNEY_FIELD_TYPE, JOURNEY_PAGES_SLOT } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { createStepCanvas, followStepSelection, type StepCanvas, type StepOwnerWords, type StepSelectionRoute } from "../form-engine/builder/journey-designer/step-canvas-adapter.js";
import { builderText } from "../form-engine/builder/journey-designer/journey-texts-en.js";
import { CONTROLLER_MARKS, createStepHistory, type StepHistoryMarks } from "../form-engine/builder/journey-designer/step-history.js";
import { JOURNEY_AUTHORING_EN } from "../form-engine/builder/journey-designer/journey-authoring-texts-en.js";
import { DATUM_BUILDER_CANVAS_TAG, defineBuilderPanels, type DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";

/**
 * The Form canvas draws ONE journey step in edit mode,
 * with selection and drops going to the right controller. The real `<datum-builder-canvas>` is
 * mounted over the journey's controller with the step adapter's three options: `canvasRoot`,
 * and the seams `canvasView` and `canvasJourneyView` (their own tests: `builder-canvas-step-seams.test.ts`).
 */

defineBuilderPanels();

/** The adapter's tag words, as the mode will hand them over: the authoring table's English. */
const STEP_WORDS = { notSent: JOURNEY_AUTHORING_EN["journey.designer.own.notSent"] };

/** The step's name on its chrome, as the mode will word it: the designer table's step reference. */
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
  return [group("form", { title: "Form" }), leaf("text"), leaf("number"), group("fieldset", { label: "fieldset" }), { type: "button", version: "1.0.0", createDefault: () => ({ id: "button", type: "button", configuration: { label: "Button" } }), capabilities: [] }];
}

const FORM_TYPES = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
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
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        { id: "email", type: "text", configuration: { label: "Email" } },
        {
          id: "address",
          type: "fieldset",
          configuration: { label: "Address" },
          children: { content: [{ id: "street", type: "text", configuration: { label: "Street" } }, { id: "city", type: "text", configuration: { label: "City" } }] }
        },
        { id: "notes", type: "text", configuration: { label: "Notes" } },
        { id: "score", type: "number", configuration: { label: "Score" } }
      ]
    }
  };
}

function journey(): Journey {
  return {
    id: "intake",
    name: "Step by step",
    progress: "count",
    pages: [
      { id: "about", title: "About you", components: ["fullName", { id: "nickname", type: "text", configuration: { label: "Nickname" } }] },
      {
        id: "contact",
        title: "How to reach you",
        components: ["email", "fullName", "address", { id: "confirmEmail", type: "text", configuration: { label: "Confirm email", fills: "email" } }]
      },
      { id: "finish", title: "Anything else", components: ["notes", { id: "worked-out_1", type: "journey-value", configuration: { to: "score", label: "Your score" } }] }
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
  /** The page node on the canvas: settable, as the Step picker would. */
  page: { id: string | undefined };
  pageNode(pageId: string): ComponentNode;
}

/** The form's controller and one journey's, set up the way the Journeys mode sets them up, the page-only chunk in; then the Step view's options on the journey's. */
async function setup(): Promise<Setup> {
  const form = new BuilderController({ initialRoot: formRoot(), componentTypes: FORM_TYPES, componentDefinitions: formDefinitions() });
  const designer = createJourneyDesigner({ formRoot: () => form.snapshot(), locale: () => "en", formDefinitions: () => formDefinitions(), formTypes: () => form.componentTypes() });
  await designer.loadAuthoring();
  const pageIds = new Map<string, string>();
  const references = new Map<string, Record<string, unknown>>();
  const tree = designer.treeFromJourney(journey(), { pageIds, references, formIds: allIds(form.snapshot()) });
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
  return { form, journey: controller, step, page, pageNode };
}

/**
 * What the journey's controller is told as the Step view comes up: the form's look, no cards,
 * the step root, its view and the page it is drawn as, all without touching its
 * history. `journeyView: false` leaves the page off.
 */
function enterStepView(s: Setup, pageId: string, options: { journeyView?: false } = {}): void {
  s.page.id = s.pageNode(pageId).id;
  s.journey.setOptions({
    binding: undefined,
    canvasComponents: undefined,
    canvasRoot: s.step.canvasRoot,
    canvasView: s.step.canvasView,
    ...(options.journeyView === false ? {} : { canvasJourneyView: s.step.journeyView }),
    // The chrome seams: tags, the step owning its heading and buttons, a placed group as one box.
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

async function mountCanvas(controller: BuilderController): Promise<{ canvas: DatumBuilderCanvasElement; renderer: DatumFormRendererElement; form: ShadowRoot }> {
  const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
  canvas.controller = controller;
  document.body.append(canvas);
  const renderer = canvas.shadowRoot!.querySelector("[data-preview]") as DatumFormRendererElement;
  await settled(renderer);
  return { canvas, renderer, form: renderer.shadowRoot! };
}

async function mountStep(s: Setup, pageId: string): Promise<{ canvas: DatumBuilderCanvasElement; renderer: DatumFormRendererElement; form: ShadowRoot }> {
  enterStepView(s, pageId);
  return mountCanvas(s.journey);
}

const node = (form: ShadowRoot, id: string): HTMLElement | null => form.querySelector<HTMLElement>(`.db-node[data-component-id="${id}"]`);
const contentOf = (s: Setup, pageId: string): ComponentNode[] => s.pageNode(pageId).children?.[JOURNEY_CONTENT_SLOT] ?? [];
const placementIds = (s: Setup, pageId: string, componentId: string): string[] =>
  contentOf(s, pageId)
    .filter((entry) => entry.type === JOURNEY_FIELD_TYPE && (entry.configuration as { componentId?: string }).componentId === componentId)
    .map((entry) => entry.id);

function drop(target: HTMLElement, payload: unknown): void {
  const transfer = {
    types: [BUILDER_DRAG_MIME_TYPE],
    effectAllowed: "copy",
    dropEffect: "none",
    getData: (type: string) => (type === BUILDER_DRAG_MIME_TYPE ? JSON.stringify(payload) : ""),
    setData: () => undefined
  };
  const event = (type: string): Event => Object.assign(new Event(type, { bubbles: true, composed: true, cancelable: true }), { dataTransfer: transfer, clientX: 0, clientY: 0 });
  target.dispatchEvent(event("dragover"));
  target.dispatchEvent(event("drop"));
}

/** The undo marks: the controllers' own `undoMark()` / `redoMark()`. */
const MARKS: StepHistoryMarks = CONTROLLER_MARKS;

describe("the id map", () => {
  it("draws a placement under its journey node id with the form field's type; reads the form id back; a field on two steps is two placements", async () => {
    const s = await setup();
    s.page.id = s.pageNode("contact").id;
    const tree = s.journey.previewSnapshot();
    const root = s.step.canvasRoot(tree);
    const [emailAt] = placementIds(s, "contact", "email");
    const [fullNameHere] = placementIds(s, "contact", "fullName");
    const [fullNameFirst] = placementIds(s, "about", "fullName");
    // The drawn root is the page node, in the form's type, with the page's slot.
    expect(root.id).toBe(s.pageNode("contact").id);
    expect(root.type).toBe("form");
    const drawn = root.children![JOURNEY_CONTENT_SLOT]!;
    expect(drawn.map((entry) => entry.id)).toEqual([emailAt, fullNameHere, placementIds(s, "contact", "address")[0], "confirmEmail"]);
    expect(drawn.map((entry) => entry.type)).toEqual(["text", "text", "fieldset", "text"]);
    expect((drawn[0]!.configuration as { label: string }).label).toBe("Email");
    // Ids both ways.
    const roles = s.step.roles(tree);
    expect(roles.get(emailAt!)).toEqual({ role: "placement", nodeId: emailAt, componentId: "email", repeat: 0 });
    expect(s.step.placementsOf("fullName", tree)).toEqual([
      { pageNodeId: s.pageNode("about").id, nodeId: fullNameFirst },
      { pageNodeId: s.pageNode("contact").id, nodeId: fullNameHere }
    ]);
    // A placed container's children are drawn under their form ids, owned by the placement.
    expect(roles.get("street")).toEqual({ role: "placed", componentId: "street", placementId: placementIds(s, "contact", "address")[0] });
    // An alias is the journey's own node, and says which form field it fills; no "Not sent" tag.
    expect(roles.get("confirmEmail")).toEqual({ role: "own", nodeId: "confirmEmail", fills: "email" });
    expect(s.step.tags(tree, STEP_WORDS).has("confirmEmail")).toBe(false);
    // The placed container's slots are left out of the canvas's view: no drop zone, no walk inside.
    enterStepView(s, "contact");
    const view = s.journey.canvasTreeView();
    expect(view.slots.map((slot) => slot.slotId)).toEqual([JOURNEY_CONTENT_SLOT]);
    expect(view.slots[0]!.children.find((entry) => entry.type === "fieldset")!.slots).toEqual([]);
  });

  it("draws a worked-out value as the form field it works out, under its own id and label; a journey-only field is tagged Not sent", async () => {
    const s = await setup();
    s.page.id = s.pageNode("finish").id;
    const tree = s.journey.previewSnapshot();
    const drawn = s.step.canvasRoot(tree).children![JOURNEY_CONTENT_SLOT]!;
    const worked = drawn.find((entry) => entry.id === "worked-out_1")!;
    expect(worked.type).toBe("number");
    expect((worked.configuration as { label: string }).label).toBe("Your score");
    expect(s.step.roles(tree).get("worked-out_1")).toEqual({ role: "worked-out", nodeId: "worked-out_1", to: "score" });
    s.page.id = s.pageNode("about").id;
    expect([...s.step.tags(s.journey.previewSnapshot(), STEP_WORDS)]).toEqual([["nickname", "Not sent"]]);
  });

  it("draws a field placed twice on one step twice, the second without its subtree, so no id is drawn twice", async () => {
    const s = await setup();
    const pageId = s.pageNode("contact").id;
    s.journey.add(JOURNEY_FIELD_TYPE, pageId, JOURNEY_CONTENT_SLOT, { configuration: { componentId: "address" } });
    s.page.id = pageId;
    const tree = s.journey.previewSnapshot();
    const root = s.step.canvasRoot(tree);
    const ids = allIds(root);
    expect(new Set(ids).size).toBe(ids.length);
    const [first, second] = placementIds(s, "contact", "address");
    expect(s.step.roles(tree).get(second!)).toMatchObject({ role: "placement", componentId: "address", repeat: 1 });
    expect(root.children![JOURNEY_CONTENT_SLOT]!.find((entry) => entry.id === second)!.children).toBeUndefined();
    expect(root.children![JOURNEY_CONTENT_SLOT]!.find((entry) => entry.id === first)!.children).toBeDefined();
  });
});

describe("one step on the edit canvas", () => {
  it("draws the step's fields as the real fields, with edit chrome, and the renderer's own Back, counter, heading and Continue", async () => {
    const s = await setup();
    const { form, renderer } = await mountStep(s, "contact");
    const [emailAt] = placementIds(s, "contact", "email");
    // Edit chrome: the placement is a canvas node with its grip and an inert leaf holding the real input.
    const box = node(form, emailAt!)!;
    expect(box).not.toBeNull();
    expect(box.querySelector(`[data-db-handle="${emailAt}"]`)).not.toBeNull();
    const leaf = box.querySelector<HTMLElement>(".db-leaf")!;
    expect(leaf.hasAttribute("inert")).toBe(true);
    const input = leaf.querySelector<HTMLInputElement>("input")!;
    expect(form.getElementById(input.getAttribute("aria-labelledby")!)!.textContent).toBe("Email");
    // A journey-only field (an alias here) draws as the real field too.
    expect(node(form, "confirmEmail")!.querySelector(".db-leaf input")).not.toBeNull();
    // The step's root is the drop zone of the page's content slot.
    const rootZone = form.querySelector<HTMLElement>("[data-db-root]")!;
    expect(rootZone.getAttribute("data-parent-id")).toBe(s.pageNode("contact").id);
    expect(rootZone.getAttribute("data-slot-id")).toBe(JOURNEY_CONTENT_SLOT);
    // No drop zone inside the placed fieldset: its children are the form's.
    expect(form.querySelector(`[data-dropzone][data-parent-id="address"]`)).toBeNull();
    // The renderer's page chrome, drawn by the binding, with the hooks on.
    expect(renderer.canvasHooks).toBeDefined();
    const heading = form.querySelector<HTMLElement>("[data-journey-heading]")!;
    expect(heading.textContent).toContain("How to reach you");
    expect(heading.querySelector(".datum-form__journey-progress")!.textContent).toContain("Step 2 of 3");
    expect(form.querySelector("[data-journey-continue]")!.textContent!.trim()).toBe("Continue");
    expect(form.querySelector("[data-journey-back]")).not.toBeNull();
  });

  it("draws Submit on the last step and no Back on the first", async () => {
    const s = await setup();
    const last = await mountStep(s, "finish");
    expect(last.form.querySelector("[data-journey-continue]")!.classList.contains("datum-form__journey-submit")).toBe(true);
    document.body.innerHTML = "";
    const first = await mountStep(await setup(), "about");
    expect(first.form.querySelector("[data-journey-back]")).toBeNull();
    expect(first.form.querySelector("[data-journey-heading]")!.textContent).toContain("Step 1 of 3");
  });

  it("without the page view the same root draws the fields and no page chrome at all", async () => {
    const s = await setup();
    enterStepView(s, "contact", { journeyView: false });
    const { form } = await mountCanvas(s.journey);
    expect(node(form, placementIds(s, "contact", "email")[0]!)).not.toBeNull();
    expect(form.querySelector("[data-journey-heading], [data-journey-continue], [data-journey-back]")).toBeNull();
  });
});

describe("selection goes to the right controller", () => {
  it("a click on a placement selects it on the journey controller and inspects the form field on the form controller", async () => {
    const s = await setup();
    const routes: StepSelectionRoute[] = [];
    followStepSelection(s.journey, s.step, (route) => {
      routes.push(route);
      // The inspector on the form controller, the field selected there.
      if (route.inspect?.controller === "form") {
        s.form.select(route.inspect.componentId);
      }
    });
    const { form, renderer } = await mountStep(s, "contact");
    const [emailAt] = placementIds(s, "contact", "email");
    node(form, emailAt!)!.click();
    await settled(renderer);
    expect(s.journey.selectedComponentId()).toBe(emailAt);
    expect(s.form.selectedComponentId()).toBe("email");
    expect(routes.at(-1)).toEqual({ journeyNodeId: emailAt, inspect: { controller: "form", componentId: "email", placementId: emailAt } });
    expect(node(form, emailAt!)!.classList.contains("db-selected")).toBe(true);
    // A journey-only node stays on the journey controller.
    node(form, "confirmEmail")!.click();
    await settled(renderer);
    expect(s.journey.selectedComponentId()).toBe("confirmEmail");
    expect(routes.at(-1)!.inspect).toEqual({ controller: "journey", nodeId: "confirmEmail" });
  });

  it("a click on Continue, Back or the heading selects the step (the page node) on the journey controller", async () => {
    const s = await setup();
    const { form, renderer } = await mountStep(s, "contact");
    const contact = s.pageNode("contact").id;
    const [emailAt] = placementIds(s, "contact", "email");
    for (const selector of ["[data-journey-continue]", "[data-journey-back]", "[data-journey-heading]", ".datum-form__journey-progress"]) {
      s.journey.select(emailAt);
      await settled(renderer);
      form.querySelector<HTMLElement>(selector)!.click();
      await settled(renderer);
      expect(s.journey.selectedComponentId(), selector).toBe(contact);
    }
    // The step's route: inspected on the journey controller.
    expect(s.step.route(contact, s.journey.previewSnapshot())).toEqual({ journeyNodeId: contact, inspect: { controller: "journey", nodeId: contact } });
    // One owner: no component box carries the page node's id.
    expect(form.querySelector(`.db-node[data-component-id="${contact}"]`)).toBeNull();
  });

  it("a click on a field inside a placed container selects the whole placed group", async () => {
    const s = await setup();
    const { form, renderer } = await mountStep(s, "contact");
    const [addressAt] = placementIds(s, "contact", "address");
    // The inner field is part of the placement's box: no box, grip or tag of its own.
    expect(node(form, "street")).toBeNull();
    expect(form.querySelector('[data-db-handle="street"]')).toBeNull();
    const street = form.querySelector<HTMLElement>('.datum-live-field[data-component-id="street"]')!;
    const part = street.querySelector<HTMLElement>("[data-db-part-of]")!;
    expect(part.getAttribute("data-db-part-of")).toBe(addressAt);
    expect(part.hasAttribute("inert")).toBe(true);
    street.querySelector<HTMLInputElement>("input")!.click();
    await settled(renderer);
    expect(s.journey.selectedComponentId()).toBe(addressAt);
    expect(node(form, addressAt!)!.classList.contains("db-selected")).toBe(true);
    // Inspected as the placed group: the form container, never the field inside it.
    expect(s.step.route("street", s.journey.previewSnapshot())).toEqual({
      journeyNodeId: addressAt,
      inspect: { controller: "form", componentId: "address", placementId: addressAt }
    });
  });

  it("Take it off this step removes the placement alone, in one undo, the form field and its other step untouched", async () => {
    const s = await setup();
    const [here] = placementIds(s, "contact", "fullName");
    expect(s.step.takeOff(s.journey, here!)).toBe(true);
    expect(placementIds(s, "contact", "fullName")).toEqual([]);
    expect(placementIds(s, "about", "fullName")).toHaveLength(1);
    expect(s.form.snapshot().children!.content!.some((entry) => entry.id === "fullName")).toBe(true);
    s.journey.undo();
    expect(placementIds(s, "contact", "fullName")).toEqual([here]);
  });
});

describe("drops on the step go to the journey controller, one undo each", () => {
  it("a palette drop makes a journey-only field on the step", async () => {
    const s = await setup();
    const { form, renderer } = await mountStep(s, "contact");
    const before = contentOf(s, "contact").length;
    drop(node(form, "confirmEmail")!, { kind: "template-component", component: { id: "x", type: "text", configuration: { label: "Pet's name" } } });
    await settled(renderer);
    const after = contentOf(s, "contact");
    expect(after).toHaveLength(before + 1);
    const added = after.at(-1)!;
    expect(added.type).toBe("text");
    expect((added.configuration as { label: string }).label).toBe("Pet's name");
    // Drawn as the real field, tagged Not sent by the adapter.
    expect(node(form, added.id)!.querySelector(".db-leaf input")).not.toBeNull();
    expect(s.step.tags(s.journey.previewSnapshot(), STEP_WORDS).get(added.id)).toBe("Not sent");
    s.journey.undo();
    expect(contentOf(s, "contact")).toHaveLength(before);
  });

  it("a Form fields panel drop places a form field on the step (a journey-field template)", async () => {
    const s = await setup();
    const { form, renderer } = await mountStep(s, "contact");
    drop(node(form, "confirmEmail")!, { kind: "template-component", component: { type: JOURNEY_FIELD_TYPE, configuration: { componentId: "notes" } } });
    await settled(renderer);
    const [placed] = placementIds(s, "contact", "notes");
    expect(placed).toBeDefined();
    expect(node(form, placed!)!.querySelector(".db-leaf input")).not.toBeNull();
    // "notes" is now on two steps.
    expect(s.step.placementsOf("notes", s.journey.previewSnapshot())).toHaveLength(2);
    s.journey.undo();
    expect(placementIds(s, "contact", "notes")).toEqual([]);
  });

  it("a drag within the step reorders it", async () => {
    const s = await setup();
    const { form, renderer } = await mountStep(s, "contact");
    const [emailAt] = placementIds(s, "contact", "email");
    const order = contentOf(s, "contact").map((entry) => entry.id);
    drop(node(form, "confirmEmail")!, { kind: "existing-component", componentId: emailAt });
    await settled(renderer);
    // jsdom lays nothing out: the pointer is past every field, so the field goes last.
    expect(contentOf(s, "contact").map((entry) => entry.id)).toEqual([...order.slice(1), emailAt]);
    s.journey.undo();
    expect(contentOf(s, "contact").map((entry) => entry.id)).toEqual(order);
  });
});

describe("undo across the two controllers", () => {
  it("today: the canvas's Undo (the journey controller's) skips a form field edit made from the Step view", async () => {
    const s = await setup();
    s.journey.add("text", s.pageNode("contact").id, JOURNEY_CONTENT_SLOT, { configuration: { label: "Pet" } });
    s.form.setProperty("email", "label", "Email address");
    // What Cmd+Z on the canvas or the bar's Undo does in the Journeys workspace:
    s.journey.undo();
    // The label edit, the last thing done, is still there; the drop before it is gone.
    expect((s.form.snapshot().children!.content!.find((entry) => entry.id === "email")!.configuration as { label: string }).label).toBe("Email address");
    expect(contentOf(s, "contact").some((entry) => (entry.configuration as { label?: string }).label === "Pet")).toBe(false);
  });

  it("with the step history: one Undo takes back the last change, whichever controller holds it (the inspector's draft path)", async () => {
    const s = await setup();
    const history = createStepHistory([s.form, s.journey], MARKS);
    const pageId = s.pageNode("contact").id;
    const order = contentOf(s, "contact").map((entry) => entry.id);
    const label = (): string => (s.form.snapshot().children!.content!.find((entry) => entry.id === "email")!.configuration as { label: string }).label;
    // (b) a palette drop, (a) a property edit of a form field as the inspector makes it, (c) a move within the step.
    s.journey.add("text", pageId, JOURNEY_CONTENT_SLOT, { configuration: { label: "Pet" } });
    await Promise.resolve();
    // Keystrokes are drafts: no step of their own, until Save commits them as one.
    s.form.setDraftProperty("email", "label", "Em");
    s.form.setDraftProperty("email", "label", "Email address");
    await Promise.resolve();
    expect(history.entries()).toEqual([[s.journey]]);
    expect(s.form.commitDraft("email")).toBe(true);
    await Promise.resolve();
    s.journey.moveBy(order[0]!, 1);
    await Promise.resolve();
    expect(history.entries()).toEqual([[s.journey], [s.form], [s.journey]]);
    expect(history.undo()).toBe(true); // (c)
    expect(contentOf(s, "contact").slice(0, order.length).map((entry) => entry.id)).toEqual(order);
    expect(label()).toBe("Email address");
    expect(history.undo()).toBe(true); // (a)
    expect(label()).toBe("Email");
    expect(contentOf(s, "contact")).toHaveLength(order.length + 1);
    expect(history.undo()).toBe(true); // (b)
    expect(contentOf(s, "contact")).toHaveLength(order.length);
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(true);
    expect(history.redo()).toBe(true);
    expect(label()).toBe("Email address");
    history.dispose();
  });

  it("drops an entry whose controller's history moved on outside it, never undoing it blind", async () => {
    const s = await setup();
    const history = createStepHistory([s.form, s.journey], MARKS);
    const pageId = s.pageNode("contact").id;
    const before = contentOf(s, "contact").length;
    s.journey.add("text", pageId, JOURNEY_CONTENT_SLOT, { configuration: { label: "Pet" } });
    await Promise.resolve();
    s.form.setDraftProperty("email", "label", "Email address");
    s.form.commitDraft("email");
    await Promise.resolve();
    expect(history.entries()).toEqual([[s.journey], [s.form]]);
    // The form's own Undo (another workspace's bar), not the step history's: the form entry is stale now.
    s.form.undo();
    const label = (): string => (s.form.snapshot().children!.content!.find((entry) => entry.id === "email")!.configuration as { label: string }).label;
    expect(label()).toBe("Email");
    // The stale entry is skipped; the one under it (the journey's drop) is what Undo takes back.
    expect(history.undo()).toBe(true);
    expect(contentOf(s, "contact")).toHaveLength(before);
    expect(label()).toBe("Email");
    // Nothing of the step history's own is left: the caller falls back to the journey's own Undo.
    expect(history.canUndo()).toBe(false);
    expect(history.undo()).toBe(false);
    history.dispose();
  });

  it("a rename made from the Step view and the journey's follow-up are one entry, kept in the order made, so one Undo and one Redo each leave the journey reading the form's ids", async () => {
    const s = await setup();
    const [emailAt] = placementIds(s, "contact", "email");
    // The mode's own follow-up (journey-builder-mode.ts followRename), registered before any step
    // history exists, as the mode's form listener is: a rename, or an Undo or Redo of one,
    // rewrites the journey's references in a step of its own.
    const follow = (from: string, to: string): void => {
      for (const page of s.journey.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? []) {
        for (const entry of page.children?.[JOURNEY_CONTENT_SLOT] ?? []) {
          if (entry.type === JOURNEY_FIELD_TYPE && (entry.configuration as { componentId?: string }).componentId === from) {
            s.journey.setProperty(entry.id, "componentId", to);
          }
        }
      }
    };
    s.form.on("change", (event) => {
      const renamed = event.renamed ?? event.renameStepped;
      if (renamed) {
        follow(renamed.from, renamed.to);
      }
    });
    const history = createStepHistory([s.form, s.journey], MARKS);
    const reads = (): string | undefined => (s.journey.snapshot().children![JOURNEY_PAGES_SLOT]!.flatMap((page) => page.children?.[JOURNEY_CONTENT_SLOT] ?? []).find((entry) => entry.id === emailAt)!.configuration as { componentId?: string }).componentId;
    s.form.setDraftId("email", "emailAddress");
    expect(s.form.commitDraft("email")).toBe(true);
    await Promise.resolve();
    expect(reads()).toBe("emailAddress");
    // One turn, one entry, in the order the steps were made (each controller's mutation, not the
    // order the change events arrive in: the follower's listener runs first and writes the
    // journey inside the form's change).
    expect(history.entries()).toEqual([[s.form, s.journey]]);
    expect(history.undo()).toBe(true);
    // The follow-up goes back first, then the rename; the follower, hearing the rename's Undo,
    // finds nothing left to follow.
    expect(s.form.snapshot().children!.content!.some((entry) => entry.id === "email")).toBe(true);
    expect(reads()).toBe("email");
    expect(history.redo()).toBe(true);
    expect(s.form.snapshot().children!.content!.some((entry) => entry.id === "emailAddress")).toBe(true);
    expect(reads()).toBe("emailAddress");
    history.dispose();
  });
});

describe("what a switch on the same controller does", () => {
  it("a canvas mounted on the journey's controller to the Step view on one mounted canvas: the runtime is kept (same controller), so the drawings arrive one input at a time", async () => {
    const s = await setup();
    const { renderer, form } = await mountCanvas(s.journey);
    // The designer brings no faces of its own (the Pages cards are gone): nothing of a card is up before the Step view.
    expect(form.querySelector("[data-journey-page], .datum-journey-card, [data-journey-own]")).toBeNull();
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const before = renderer.live!;
      const from = before.draws();
      enterStepView(s, "contact");
      s.journey.repaintPreview();
      await settled(renderer);
      const live = renderer.live!;
      // Recorded for inspection: how many draws and warnings the swap cost (no assertion on the count).
      (globalThis as { __stepSwap?: unknown }).__stepSwap = {
        remounted: live !== before,
        drawsOnOldMount: before.draws() - from,
        drawsOnNewMount: live !== before ? live.draws() : 0,
        warnings: warnings.map((args) => String(args[0]))
      };
    } finally {
      console.warn = warn;
    }
    expect(form.querySelector("[data-journey-heading]")!.textContent).toContain("How to reach you");
    expect(node(form, placementIds(s, "contact", "email")[0]!)).not.toBeNull();
    // DATUM_STEP_SWAP_PROBE=<file> writes the swap's cost.
    if (process.env.DATUM_STEP_SWAP_PROBE) {
      writeFileSync(process.env.DATUM_STEP_SWAP_PROBE, JSON.stringify((globalThis as { __stepSwap?: unknown }).__stepSwap, null, 2));
    }
  });
});

describe("paint cost", () => {
  /** Draws of the renderer while `act` runs and settles. */
  async function drawsDuring(renderer: DatumFormRendererElement, act: () => void): Promise<number> {
    await settled(renderer);
    const from = renderer.live!.draws();
    act();
    await settled(renderer);
    return renderer.live!.draws() - from;
  }

  it("Form canvas baseline: one draw per selection change and per keystroke in the inspector", async () => {
    const form = new BuilderController({ initialRoot: formRoot(), componentTypes: FORM_TYPES, componentDefinitions: formDefinitions() });
    const { renderer } = await mountCanvas(form);
    expect(await drawsDuring(renderer, () => form.select("email"))).toBe(1);
    expect(await drawsDuring(renderer, () => form.setDraftProperty("email", "label", "E"))).toBe(1);
    expect(await drawsDuring(renderer, () => form.setDraftProperty("email", "label", "Em"))).toBe(1);
  });

  it("Step canvas: one draw per selection change and per keystroke of a form field's inspector, the form change forwarded as the mode does", async () => {
    const s = await setup();
    // `onFormChange` in journey-builder-mode.ts: anything but a selection repaints the journey's canvas.
    s.form.on("change", (event) => {
      if (event.reason !== "select") {
        s.journey.repaintPreview();
      }
    });
    followStepSelection(s.journey, s.step, (route) => {
      if (route.inspect?.controller === "form") {
        s.form.select(route.inspect.componentId);
      }
    });
    const { renderer, form } = await mountStep(s, "contact");
    const [emailAt] = placementIds(s, "contact", "email");
    expect(await drawsDuring(renderer, () => s.journey.select(emailAt))).toBe(1);
    expect(s.form.selectedComponentId()).toBe("email");
    expect(await drawsDuring(renderer, () => s.form.setDraftProperty("email", "label", "E"))).toBe(1);
    expect(await drawsDuring(renderer, () => s.form.setDraftProperty("email", "label", "Em"))).toBe(1);
    // The draft shows on the step at once.
    const input = node(form, emailAt!)!.querySelector<HTMLInputElement>("input")!;
    expect(form.getElementById(input.getAttribute("aria-labelledby")!)!.textContent).toBe("Em");
    // A repaint over the same tree draws nothing.
    expect(await drawsDuring(renderer, () => s.journey.repaintPreview())).toBe(0);
  });
});
