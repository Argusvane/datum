// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { JOURNEY_PREVIEW_LENT, createJourneyDesigner, type JourneyDesigner, type JourneyEntryDesign } from "../form-engine/builder/journey-designer/journey-designer.js";
import { JOURNEY_KEPT_IN_BROWSER_NOTE } from "../form-engine/builder/journey-designer/journey-authoring.js";
import { createJourneyBuilderMode, type JourneyBuilderMode } from "../form-engine/builder/journey-designer/journey-builder-mode.js";
import { createJourneyPreviewSession, type JourneyPreviewSubject } from "../form-engine/builder/journey-designer/journey-preview.js";
import {
  JOURNEY_CONTENT_SLOT,
  JOURNEY_FIELD_TYPE,
  JOURNEY_PAGE_TYPE,
  JOURNEY_PAGES_SLOT
} from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { journeyFromTree, treeFromJourney } from "../form-engine/builder/journey-designer/journey-tree.js";
import type { BuilderModeContext, BuilderModeRules } from "../form-engine/builder/web-component/builder-modes.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import { createDataSourceCapability } from "../form-engine/core/schema/data-source-capability.js";
import { createInlineOptionsCapability } from "../form-engine/core/schema/inline-options.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { Journey, JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { FIELD_CAPABILITIES, standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { applyJourney, presentationRoot, publicVariant } from "./fixtures/presentation-form.js";

/**
 * Authoring a presentation's own nodes in the Journeys designer: the palette's
 * page-only fields and the worked-out value, "Fills form field" first in the inspector with only the targets
 * that fit, "Ask differently here…" as one undo step, the Rules tab's worked-out expression and
 * fields, the translations catalog, the findings card's entries and the preview's index and
 * answers. The Pages view draws no cards for these nodes: the Step view
 * draws the real fields. The shared fixture's `apply` and `public` stand in for any presentation.
 */

const read = (path: string): Expression => ({ kind: "path", path });

/** A form's definitions as a host registers them: fields, choices, a file, groups, a data-scoping container, steps. */
function formDefinitions(): ComponentDefinition[] {
  const leaf = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition => ({
    type,
    version: "1.0.0",
    createDefault: () => ({ id: type, type, configuration: { label: `${type.toUpperCase()} field` } }),
    capabilities: standardFieldCapabilities({ placeholder: type !== "checkbox" }),
    ...extra
  });
  const group = (type: string, slots: NonNullable<ComponentDefinition["children"]>, configuration: Record<string, unknown> = { label: type }): ComponentDefinition => ({
    type,
    version: "1.0.0",
    createDefault: () => ({ id: type, type, configuration, children: Object.fromEntries(slots.slots.map((slot) => [slot.id, []])) }),
    capabilities: [],
    children: slots,
    propertyEditor: { mode: "replace", fields: [{ id: "label", type: "localized-text", propertyPath: "label", label: "Label" }] }
  });
  return [
    group("form", { slots: [{ id: "content", multiple: true }] }, { title: "Form" }),
    leaf("text"),
    leaf("number"),
    leaf("checkbox"),
    leaf("select", { capabilities: [...standardFieldCapabilities(), createDataSourceCapability(), createInlineOptionsCapability()] }),
    leaf("file", { capabilities: standardFieldCapabilities({ placeholder: false, attachFiles: true }) }),
    { type: "html", version: "1.0.0", createDefault: () => ({ id: "html", type: "html", configuration: { tag: "p", content: "Text" } }), capabilities: [FIELD_CAPABILITIES.get("cssClass")!] },
    { type: "button", version: "1.0.0", createDefault: () => ({ id: "button", type: "button", configuration: { label: "Button" } }), capabilities: [] },
    group("fieldset", { slots: [{ id: "content", multiple: true }] }),
    group("button-group", { slots: [{ id: "buttons", multiple: true, allowedTypes: ["button"] }] }),
    group("container", { slots: [{ id: "content", multiple: true }] }),
    group("steps", { slots: [{ id: "steps", multiple: true, allowedTypes: ["step"] }] }),
    group("step", { slots: [{ id: "content", multiple: true }] })
  ];
}

/** The form's palette, as its builder lists it. */
const FORM_TYPES = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "checkbox", label: "Checkbox" },
  { type: "select", label: "Select" },
  { type: "file", label: "File upload" },
  { type: "html", label: "HTML" },
  { type: "button", label: "Button" },
  { type: "fieldset", label: "Fieldset" },
  { type: "button-group", label: "Button group" },
  { type: "container", label: "Container" },
  { type: "steps", label: "Steps" },
  { type: "step", label: "Step" }
];

/** The shared fixture's form, with two choices a choice of the journey's own may fill — or not — and a component holding `text_1`. */
function formRoot(): ComponentNode {
  const root = presentationRoot();
  root.children!.content!.push(
    {
      id: "colour",
      type: "select",
      configuration: { label: "Colour", options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }, { value: "green", label: "Green" }] }
    },
    { id: "size", type: "select", configuration: { label: "Size", options: [{ value: "s", label: "Small" }] } },
    { id: "text_1", type: "text", configuration: { label: "Taken" } }
  );
  return root;
}

function allIds(node: ComponentNode, into: string[] = []): string[] {
  into.push(node.id);
  for (const child of Object.values(node.children ?? {}).flat()) {
    allIds(child, into);
  }
  return into;
}

interface Design {
  form: BuilderController;
  designer: JourneyDesigner;
  controller: BuilderController;
  design: JourneyEntryDesign;
  pageIds: Map<string, string>;
  references: Map<string, Record<string, unknown>>;
}

/** A journey's controller over the form, set up the way the mode sets one up, the page-only chunk in. */
async function designFor(value: Journey, root: ComponentNode = formRoot()): Promise<Design> {
  const form = new BuilderController({ initialRoot: root, componentTypes: FORM_TYPES, componentDefinitions: formDefinitions() });
  const designer = createJourneyDesigner({
    formRoot: () => form.snapshot(),
    locale: () => "en",
    formDefinitions: () => formDefinitions(),
    formTypes: () => form.componentTypes()
  });
  await designer.loadAuthoring();
  const pageIds = new Map<string, string>();
  const references = new Map<string, Record<string, unknown>>();
  const tree = designer.treeFromJourney(value, { pageIds, references, formIds: allIds(root) });
  const controller = new BuilderController({ componentTypes: [], initialRoot: tree });
  const design = designer.entry({ journeyId: () => value.id, tree: () => controller.previewSnapshot(), pageIds, references });
  controller.setOptions({ ...design.builderOptions, initialRoot: tree, locale: "en" });
  controller.on("change", () => design.invalidate());
  return { form, designer, controller, design, pageIds, references };
}

function pageNodes(controller: BuilderController): ComponentNode[] {
  return controller.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? [];
}

/** `apply` with `m1` shown only when `m2` is answered: a rule the canvas would hide it by. */
function applyWithRule(): Journey {
  const journey = applyJourney();
  const m1 = journey.pages[1]!.components![0] as unknown as ComponentNode;
  m1.rules = { visibleWhen: { kind: "binary", operator: "gt", left: read("m2"), right: { kind: "literal", value: 0 } } };
  return journey;
}

describe("the palette's page-only fields", () => {
  it("offers the Journey group, then the form's own palette group by group, less what a presentation cannot hold", async () => {
    const { controller } = await designFor(applyJourney());
    expect(controller.componentTypes().map((entry) => `${entry.group} / ${entry.label}`)).toEqual([
      "Journey / Step",
      "Journey / Form field",
      "Journey / Route",
      "Journey / Worked-out value",
      // No file (rule B), no data-scoping container, no steps or step; in the form palette's own
      // groups, with no Journey-only prefix (the placed field's "Not sent" tag says it).
      "Fields / Text",
      "Fields / Number",
      "Choices / Checkbox",
      "Choices / Select",
      "Layout / Fieldset",
      "Layout / Button group",
      "Content / HTML",
      "Actions / Button"
    ]);
  });

  it("derives each type: no data key, PDF options or data source; a group's slots take page-only fields and references, never the designer's own", async () => {
    const { design } = await designFor(applyJourney());
    const definitions = design.builderOptions.componentDefinitions ?? [];
    const select = definitions.find((definition) => definition.type === "select")!;
    expect(select.capabilities.map((capability) => capability.id)).not.toContain("dataKey");
    expect(select.capabilities.map((capability) => capability.id)).not.toContain("pdf");
    expect(select.capabilities.map((capability) => capability.id)).not.toContain("dataSource");
    expect(select.capabilities.map((capability) => capability.id)).toContain("inlineOptions");
    const fieldset = definitions.find((definition) => definition.type === "fieldset")!;
    expect(fieldset.children?.slots[0]?.allowedTypes).toEqual([JOURNEY_FIELD_TYPE, "text", "number", "checkbox", "select", "fieldset", "button-group", "html", "button"]);
    // A slot that takes some types of the form's keeps to them.
    expect(definitions.find((definition) => definition.type === "button-group")?.children?.slots[0]?.allowedTypes).toEqual(["button"]);
    // A page takes the form's fields, worked-out values and the page-only fields.
    const page = definitions.find((definition) => definition.type === JOURNEY_PAGE_TYPE)!;
    expect(page.children?.slots.find((slot) => slot.id === JOURNEY_CONTENT_SLOT)?.allowedTypes).toEqual([
      JOURNEY_FIELD_TYPE,
      "journey-value",
      "text",
      "number",
      "checkbox",
      "select",
      "fieldset",
      "button-group",
      "html",
      "button"
    ]);
  });

  it("drops a page-only field under an id nothing has — the form's, an own node's, a page's — and numbers a worked-out value apart from the designer's prefix", async () => {
    const journey = applyJourney();
    journey.pages[0]!.id = "text_2";
    journey.pages[0]!.components!.push({ id: "text_3", type: "text", configuration: { label: "Nickname" } });
    const { controller } = await designFor(journey);
    const details = pageNodes(controller)[0]!;
    controller.add("text", details.id, JOURNEY_CONTENT_SLOT);
    // `text_1` is the form's, `text_2` the page's id, `text_3` an own node's.
    expect(controller.selectedComponentId()).toBe("text_4");
    controller.add("journey-value", details.id, JOURNEY_CONTENT_SLOT);
    expect(controller.selectedComponentId()).toMatch(/^worked-out_\d+$/);
    // A worked-out value not finished is not written (so the journey can be), nor is a blank "Fills".
    controller.setProperty("text_4", "fills", "");
    const written = journeyFromTree(controller.snapshot(), "apply");
    expect(written?.pages[0]?.components?.map((entry) => (typeof entry === "string" ? entry : entry.id))).toEqual(["work_email", "text_3", "text_4"]);
    expect((written?.pages[0]?.components?.[2] as { configuration: Record<string, unknown> }).configuration).not.toHaveProperty("fills");
  });
});

describe("how a presentation's own nodes are named", () => {
  it("titles a page with no title by its first member, as the runtime heads it: an own node's label; a worked-out value with none, the field it works out; an alias with none, nothing", async () => {
    const journey = applyJourney();
    delete journey.pages[0]!.title;
    delete journey.pages[1]!.title;
    (journey.pages[1]!.components as unknown[]).unshift({ id: "total_first", type: "journey-value", configuration: { to: "approved_amount", value: { kind: "literal", value: 1 } } });
    const { controller } = await designFor(journey);
    const details = pageNodes(controller)[0]!;
    expect(controller.treeView().slots[0]?.children[0]?.label).toBe("Step 1 · Work email");
    // A worked-out value with no label at all lends its field's.
    expect(controller.treeView().slots[0]?.children[1]?.label).toBe("Step 2 · Approved amount");
    // An alias labelled blank lends nothing: the page is headed with its id, as the runtime heads it.
    controller.setProperty("work_email", "label", "");
    expect(controller.treeView().slots[0]?.children[0]?.label).toBe("Step 1 · details");
    // So does a worked-out value labelled blank.
    controller.setProperty("total_first", "label", "");
    expect(controller.treeView().slots[0]?.children[1]?.label).toBe("Step 2 · income");
    expect(details.id).toBe(pageNodes(controller)[0]!.id);
  });
});

describe("the inspector of a presentation's own nodes", () => {
  it("puts Fills form field first, offering only the form fields its answer fits that the presentation does not place", async () => {
    const { controller } = await designFor(applyJourney());
    const model = controller.inspectorModel("work_email")!;
    expect(model.sections[0]?.title).toBe("Fills form field");
    expect(model.sections[0]?.fields.map((field) => field.propertyPath)).toEqual(["fills"]);
    // A text answer: the form's text fields — not a number, a choice, the worked-out `annual_income`
    // or the listed `approved_amount`.
    expect(model.sections[0]?.fields[0]?.choices.map((choice) => choice.value)).toEqual(["", "email", "name", "text_1"]);
    expect(model.sections[0]?.fields[0]?.choices[1]?.label).toBe("Email (email)");
    // The derived inspector keeps the form's own sections after it, without a data key or PDF options.
    const paths = model.sections.flatMap((section) => section.fields.map((field) => field.propertyPath));
    expect(paths).toContain("label");
    expect(paths).toContain("required");
    expect(paths).not.toContain("dataKey");
    expect(paths.some((path) => path.startsWith("pdf"))).toBe(false);
  });

  it("offers a choice only the form's choices that have every option it offers", async () => {
    const journey = applyJourney();
    journey.pages[0]!.components!.push({ id: "pick", type: "select", configuration: { label: "Pick", options: [{ value: "red", label: "R" }, { value: "blue", label: "B" }] } });
    const { controller } = await designFor(journey);
    const fills = controller.inspectorModel("pick")!.sections[0]!.fields[0]!;
    // A choice may fill a text field (its answer is text); of the form's choices, only one with
    // every option it offers — not `size`, which lacks "red" and "blue".
    expect(fills.choices.map((choice) => choice.value)).toEqual(["", "email", "name", "colour", "text_1"]);
  });

  it("leaves out a form field placed on a page — or inside a group placed — and keeps one another alias fills", async () => {
    const journey = applyJourney();
    journey.pages[2]!.components = ["approved_amount", "name"];
    journey.pages[0]!.components!.push({ id: "other_email", type: "text", configuration: { label: "Other email" } });
    const { controller } = await designFor(journey);
    expect(controller.inspectorModel("other_email")!.sections[0]!.fields[0]!.choices.map((choice) => choice.value)).toEqual(["", "email", "text_1"]);
  });

  it("says a field that fills nothing is kept in the browser, under Fills form field", async () => {
    const { controller } = await designFor(applyJourney());
    expect(controller.notesOf("m1")).toContainEqual({ target: "fills", message: JOURNEY_KEPT_IN_BROWSER_NOTE });
    expect(controller.notesOf("work_email").map((note) => note.message)).not.toContain(JOURNEY_KEPT_IN_BROWSER_NOTE);
    expect(controller.notesOf("income_total").map((note) => note.message)).not.toContain(JOURNEY_KEPT_IN_BROWSER_NOTE);
  });

  it("says in one line why Fills form field offers nothing but None, when it does not", async () => {
    const journey = applyJourney();
    journey.pages[0]!.components!.push({ id: "agree", type: "checkbox", configuration: { label: "Agree" } });
    const { controller } = await designFor(journey);
    const fillsOf = (id: string): string[] => controller.inspectorModel(id)!.sections[0]!.fields[0]!.choices.map((choice) => choice.value);
    const WHY = ["Every form field of this kind is already on a step or worked out here.", "No form field of this kind to fill."];
    const underFills = (id: string): string[] => controller.notesOf(id).filter((note) => note.target === "fills").map((note) => note.message);
    // A number: the form's numbers are worked out (annual_income) or on a page (approved_amount).
    // The reason comes first, straight under the box, ahead of the notes on where the answer is kept.
    expect(fillsOf("m1")).toEqual([""]);
    expect(underFills("m1")[0]).toBe(WHY[0]);
    expect(underFills("m1").filter((message) => WHY.includes(message))).toHaveLength(1);
    // A tick box: no field of the form takes its answer at all.
    expect(fillsOf("agree")).toEqual([""]);
    expect(underFills("agree")[0]).toBe(WHY[1]);
    expect(underFills("agree").filter((message) => WHY.includes(message))).toHaveLength(1);
    expect(underFills("agree")).toContain(JOURNEY_KEPT_IN_BROWSER_NOTE);
    // A field with something to fill says nothing more.
    expect(fillsOf("work_email").length).toBeGreaterThan(1);
    expect(underFills("work_email").filter((message) => WHY.includes(message))).toEqual([]);
  });

  it("offers a worked-out value the form fields it may set: usable, and neither placed nor filled by the presentation", async () => {
    const { controller } = await designFor(applyJourney());
    const model = controller.inspectorModel("income_total")!;
    const to = model.sections.flatMap((section) => section.fields).find((field) => field.propertyPath === "to")!;
    expect(to.choices.map((choice) => choice.value)).toEqual(["", "name", "annual_income", "colour", "size", "text_1"]);
  });

  it("says in the inspector of two own nodes sharing an id on a page only the findings of the first", async () => {
    const journey = {
      id: "j",
      pages: [{ id: "one", components: ["name", { id: "dup", type: "text", configuration: { label: "A" } }, { id: "dup", type: "number", configuration: { label: "B", fills: "approved_amount" } }] }]
    } as unknown as Journey;
    const { controller } = await designFor(journey);
    expect(controller.notesOf("dup").map((note) => note.message).join(" ")).not.toContain("has the id of an earlier node");
    // The tree is as written.
    expect(JSON.stringify(controller.snapshot())).not.toContain("x-journey-repeat");
  });

  it("says a field filling what the runtime will not let it fill — a field gone, a worked-out field — is kept in the browser, in its inspector", async () => {
    const root = formRoot();
    root.children!.content!.push({ id: "total", type: "number", configuration: { label: "Total" }, rules: { value: { kind: "literal", value: 1 } } });
    const journey = applyJourney();
    journey.pages[0]!.components!.push(
      { id: "gone", type: "text", configuration: { label: "To a gone field", fills: "ghost" } } as never,
      { id: "worked", type: "number", configuration: { label: "To a worked-out field", fills: "total" } } as never
    );
    const { controller } = await designFor(journey, root);
    for (const id of ["gone", "worked"]) {
      expect(controller.notesOf(id)).toContainEqual({ target: "fills", message: JOURNEY_KEPT_IN_BROWSER_NOTE });
    }
    expect(controller.notesOf("work_email").map((note) => note.message)).not.toContain(JOURNEY_KEPT_IN_BROWSER_NOTE);
  });

  it("holds a Save back for a page id a page-only field of the journey has, whose texts would share its keys", async () => {
    const { controller } = await designFor(applyJourney());
    const details = pageNodes(controller)[0]!.id;
    controller.select(details);
    controller.setDraftProperty(details, "pageId", "m1");
    expect(controller.problemsOf(details)).toContainEqual({ target: "pageId", message: "“m1” is the id of a page-only field of this journey; give the step an id of its own." });
    expect(controller.commitDraft(details)).toBe(false);
    controller.setDraftProperty(details, "pageId", "about_you");
    expect(controller.problemsOf(details)).toEqual([]);
  });

  it("holds a Save back for an own id the form, a page of the journey or the designer has", async () => {
    const { controller } = await designFor(applyJourney());
    controller.select("m1");
    controller.setDraftId("m1", "email");
    expect(controller.problemsOf("m1")).toContainEqual({ target: "id", message: "“email” is the id of a component of the form; a page-only field needs one of its own." });
    controller.setDraftId("m1", "details");
    expect(controller.problemsOf("m1")).toContainEqual({ target: "id", message: "“details” is the id of a page of this journey; give the field another." });
    controller.setDraftId("m1", "journey-m1");
    expect(controller.problemsOf("m1")).toContainEqual({ target: "id", message: "Ids starting with “journey” are the designer's own; give the field another." });
    controller.setDraftId("m1", "month_one");
    expect(controller.problemsOf("m1")).toEqual([]);
  });
});

// --- the mode -------------------------------------------------------------------------------

function modeContext(root: EventTarget = new EventTarget()): BuilderModeContext {
  return { host: {} as HTMLElement, root: root as unknown as ShadowRoot, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) };
}

async function activatedMode(configuration: JourneyConfiguration, root = formRoot()): Promise<{ mode: JourneyBuilderMode; form: BuilderController; target: EventTarget; errors: string[] }> {
  const form = new BuilderController({ initialRoot: root, componentTypes: FORM_TYPES, componentDefinitions: formDefinitions() });
  const errors: string[] = [];
  const mode = createJourneyBuilderMode({ form, journey: configuration, formDefinitions: () => formDefinitions(), onError: (message) => errors.push(message) });
  const target = new EventTarget();
  await mode.activate?.(modeContext(target));
  return { mode, form, target, errors };
}

describe("authoring through the Journeys mode", () => {
  it("asks a reused form field differently: one undo step puts a field of the journey's own that fills it in its place, selected", async () => {
    const { mode, form, errors } = await activatedMode({ journeys: [{ id: "short", pages: [{ id: "one", components: ["name", "email"] }] }] });
    const controller = mode.controller;
    const question = pageNodes(controller)[0]!.children![JOURNEY_CONTENT_SLOT]![1]!;
    expect(question.configuration).toEqual({ componentId: "email" });
    expect(await mode.askDifferently(question.id)).toBe(true);
    const content = pageNodes(controller)[0]!.children![JOURNEY_CONTENT_SLOT]!;
    // `text_1` is the form's: the new field takes the next id nothing has.
    expect(content[1]).toEqual({ id: "text_2", type: "text", configuration: { label: "Email", required: true, fills: "email" } });
    expect(controller.selectedComponentId()).toBe("text_2");
    expect(mode.journey?.pages[0]?.components).toEqual(["name", { id: "text_2", type: "text", configuration: { label: "Email", required: true, fills: "email" } }]);
    // The form now claims the id: a field added there takes the next.
    form.add("text");
    expect(form.selectedComponentId()).toBe("text_3");
    form.undo();
    expect(errors).toEqual([]);
    controller.undo();
    expect(pageNodes(controller)[0]!.children![JOURNEY_CONTENT_SLOT]![1]).toEqual(question);
    expect(mode.journey?.pages[0]?.components).toEqual(["name", "email"]);
    // A question of a group is not asked differently.
    expect(await mode.askDifferently(pageNodes(controller)[0]!.id)).toBe(false);
  });

  it("asks a field differently whatever else the pages hold: an entry the slots or the ids would refuse now never stands in the way", async () => {
    const unusual: Array<[string, unknown[]]> = [
      ["duplicate own ids", [{ id: "dup", type: "text", configuration: { label: "A" } }, { id: "dup", type: "text", configuration: { label: "B" } }]],
      ["an own node named journey", [{ id: "journey", type: "text", configuration: { label: "J" } }]],
      ["an own id outside the grammar", [{ id: "1st", type: "text", configuration: { label: "First" } }]],
      ["an own type the palette leaves out (rule B)", [{ id: "up", type: "file", configuration: { label: "Upload" } }]]
    ];
    for (const [label, extra] of unusual) {
      const { mode, errors } = await activatedMode({ journeys: [{ id: "j", pages: [{ id: "one", components: ["name", ...extra] as never }, { id: "two", components: ["email"] }] }] });
      const question = pageNodes(mode.controller)[0]!.children![JOURNEY_CONTENT_SLOT]![0]!;
      expect(await mode.askDifferently(question.id), label).toBe(true);
      expect(mode.controller.dropError, label).toBeUndefined();
      expect(mode.journey?.pages[0]?.components, label).toEqual([{ id: "text_2", type: "text", configuration: { label: "Name", fills: "name" } }, ...extra]);
      expect(mode.journey?.pages[1]?.components, label).toEqual(["email"]);
      mode.controller.undo();
      expect(mode.journey?.pages[0]?.components, label).toEqual(["name", ...extra]);
      expect(errors, label).toEqual([]);
    }
  });

  it("asks a field differently inside a layout of a type the host does not define, its bounds copied too", async () => {
    const { mode, errors } = await activatedMode({ journeys: [publicVariant(), { id: "j", pages: [{ id: "one", components: ["annual_income"] }] }] });
    const contact = pageNodes(mode.controller)[0]!.children![JOURNEY_CONTENT_SLOT]![0]!;
    const email = contact.children!.content![0]!;
    expect(await mode.askDifferently(email.id)).toBe(true);
    expect((mode.journey?.pages[0]?.components?.[0] as unknown as { children: { content: unknown[] } }).children.content[0]).toEqual({
      id: "text_2",
      type: "text",
      configuration: { label: "Email", required: true, fills: "email" }
    });
    await mode.selectJourney("j");
    expect(await mode.askDifferently(pageNodes(mode.controller)[0]!.children![JOURNEY_CONTENT_SLOT]![0]!.id)).toBe(true);
    expect(mode.journey?.pages[0]?.components).toEqual([
      { id: "number_1", type: "number", configuration: { label: "Annual income", required: true, max: 1_000_000, fills: "annual_income" } }
    ]);
    expect(errors).toEqual([]);
  });

  it("follows a form rename into own nodes sharing an id with each other or with the journey's root, as the catalog does, the rename's Undo taking it back", async () => {
    const journey = {
      id: "j",
      pages: [
        {
          id: "one",
          components: [
            "email",
            { id: "journey", type: "text", configuration: { label: "J", fills: "name" } },
            { id: "dup", type: "text", configuration: { label: "D1", fills: "name" } },
            { id: "dup", type: "text", configuration: { label: "D2", fills: "name" } }
          ]
        }
      ]
    } as unknown as Journey;
    const given = JSON.stringify(journey);
    const { mode, form, errors } = await activatedMode({ journeys: [journey] });
    form.select("name");
    form.setDraftId("name", "fullname");
    expect(form.commitDraft("name")).toBe(true);
    expect(JSON.stringify(mode.journey)).toBe(given.replace(/"fills":"name"/g, '"fills":"fullname"'));
    // Written from the tree after its next edit too: the tree holds the same.
    mode.controller.setProperty(pageNodes(mode.controller)[0]!.id, "title", "One");
    expect(JSON.stringify(mode.journey)).toBe(given.replace(/"fills":"name"/g, '"fills":"fullname"').replace('"components"', '"title":"One","components"'));
    // The tree's Undo takes back its own edit; the follow-up is no entry of it but the form rename's.
    mode.controller.undo();
    expect(mode.controller.canUndo()).toBe(false);
    form.undo();
    expect(JSON.stringify(mode.journey)).toBe(given);
    expect(errors).toEqual([]);
  });

  it("lets the form take an id only a reference written as an object carries", async () => {
    const { form } = await activatedMode({
      journeys: [{ id: "j", pages: [{ id: "one", components: [{ id: "contact_email", type: "journey-field", configuration: { componentId: "email" } }] as never }] }]
    });
    form.setDraftId("name", "contact_email");
    expect(form.problemsOf("name")).toEqual([]);
    form.setDraftId("name", "name");
  });

  it("never gives a question added later the node id of a reference written as an object that was deleted, so it is written as a plain id", async () => {
    const reference = { id: "r0", type: "journey-field", configuration: { componentId: "name", "x-note": "about name" }, "x-top": true };
    const { mode, errors } = await activatedMode({ journeys: [{ id: "j", pages: [{ id: "one", components: [reference, "money", "approved_amount"] as never }] }] });
    const controller = mode.controller;
    const page = pageNodes(controller)[0]!;
    controller.remove(page.children![JOURNEY_CONTENT_SLOT]![0]!.id);
    controller.select(page.id);
    expect(await mode.addUnassigned()).toBe(true);
    const written = mode.journey!.pages[0]!.components!;
    expect(written.slice(0, 2)).toEqual(["money", "approved_amount"]);
    expect(written).toContain("name");
    expect(written.every((entry) => typeof entry === "string")).toBe(true);
    expect(errors).toEqual([]);
  });

  it("takes back a page-only field's id, then its fill and its drop, and makes them again in order", async () => {
    const { mode, form, errors } = await activatedMode({ journeys: [applyJourney()] });
    const controller = mode.controller;
    const details = pageNodes(controller)[0]!;
    controller.add("text", details.id, JOURNEY_CONTENT_SLOT);
    const added = controller.selectedComponentId()!;
    controller.setDraftProperty(added, "fills", "name");
    expect(controller.commitDraft(added)).toBe(true);
    controller.setDraftId(added, "nickname");
    expect(controller.commitDraft(added)).toBe(true);
    const written = (): unknown[] => mode.journey!.pages[0]!.components!;
    expect(written()[1]).toEqual({ id: "nickname", type: "text", configuration: { label: "TEXT field", fills: "name" } });
    const claimed = (id: string): boolean => {
      form.setDraftId("name", id);
      const refused = form.idError !== undefined;
      form.discardDraft("name");
      return refused;
    };
    // The rename is a step of its own: it goes first.
    expect(() => controller.undo()).not.toThrow();
    expect(written()[1]).toEqual({ id: added, type: "text", configuration: { label: "TEXT field", fills: "name" } });
    expect(claimed("nickname")).toBe(false);
    expect(() => controller.undo()).not.toThrow();
    expect(written()[1]).toEqual({ id: added, type: "text", configuration: { label: "TEXT field" } });
    expect(() => controller.undo()).not.toThrow();
    expect(written()).toEqual([applyJourney().pages[0]!.components![0]]);
    expect(() => controller.redo()).not.toThrow();
    expect(() => controller.redo()).not.toThrow();
    expect(() => controller.redo()).not.toThrow();
    expect(written()[1]).toEqual({ id: "nickname", type: "text", configuration: { label: "TEXT field", fills: "name" } });
    expect(claimed("nickname")).toBe(true);
    expect(controller.dropError).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it("leaves what reads an own node's old id alone when that node was one the shared rules drop (its id the form's)", async () => {
    const eq = (path: string, value: string | number): Expression => ({ kind: "binary", operator: "eq", left: read(path), right: { kind: "literal", value } });
    const journey = {
      id: "j",
      pages: [
        {
          id: "one",
          components: [
            "email",
            { id: "nick", type: "text", configuration: { label: "Nick" }, rules: { visibleWhen: eq("email", "a@b.c") } },
            { id: "email", type: "text", configuration: { label: "Clashing own email" } },
            { id: "m1", type: "number", configuration: { label: "Used" } },
            { id: "shown", type: "text", configuration: { label: "Shown" }, rules: { visibleWhen: eq("m1", 1) } }
          ]
        }
      ]
    } as unknown as Journey;
    const { mode, errors } = await activatedMode({ journeys: [journey] });
    const controller = mode.controller;
    // The own `email` was never shown (rule A): `nick` reads the form's email, and goes on doing so.
    controller.select("email");
    controller.setDraftId("email", "email_own");
    expect(controller.commitDraft("email")).toBe(true);
    const written = (): Array<Record<string, unknown>> => mode.journey!.pages[0]!.components as unknown as Array<Record<string, unknown>>;
    expect(written()[2]?.id).toBe("email_own");
    expect(written()[1]?.rules).toEqual({ visibleWhen: eq("email", "a@b.c") });
    // An own node the rules use is still followed.
    controller.renameId("m1", "month_1");
    expect(written()[4]?.rules).toEqual({ visibleWhen: eq("month_1", 1) });
    expect(errors).toEqual([]);
  });

  it("puts back a hand-written own entry it removed — one repeating another's id, one outside the grammar — exactly as written", async () => {
    const journey: Journey = {
      id: "hand",
      pages: [
        {
          id: "p1",
          components: [
            { id: "dup", type: "text", configuration: { label: "Dup A" } },
            "name",
            { id: "dup", type: "text", configuration: { label: "Dup B" } },
            { id: "1st", type: "text", configuration: { label: "First" } }
          ] as never
        },
        { id: "p2", components: [{ id: "dup", type: "number", configuration: { label: "Dup C" } }, "approved_amount"] as never }
      ]
    };
    const given = JSON.stringify(journey);
    const { mode, errors } = await activatedMode({ journeys: [JSON.parse(given) as Journey] });
    const controller = mode.controller;
    controller.remove("dup");
    expect(JSON.stringify(mode.journey)).not.toContain("Dup A");
    expect(() => controller.undo()).not.toThrow();
    expect(controller.dropError).toBeUndefined();
    expect(JSON.stringify(mode.journey)).toBe(given);
    controller.redo();
    expect(JSON.stringify(mode.journey)).not.toContain("Dup A");
    controller.undo();
    controller.remove("1st");
    expect(JSON.stringify(mode.journey)).not.toContain('"1st"');
    expect(() => controller.undo()).not.toThrow();
    expect(controller.dropError).toBeUndefined();
    expect(JSON.stringify(mode.journey)).toBe(given);
    expect(errors).toEqual([]);
  });

  it("gives a worked-out value its expression on the Rules tab, and a page-only field the form's conditions, each list kept as it was", async () => {
    const { mode } = await activatedMode({ journeys: [applyJourney()] });
    const rules = mode.inspector?.rules as BuilderModeRules;
    expect(rules.descriptors("journey-value")).toEqual([
      expect.objectContaining({ key: "value", label: "Worked out as", kind: "value", target: { propertyPath: "value" } })
    ]);
    expect(rules.descriptors("number").map((descriptor) => descriptor.key)).toEqual(["visibleWhen", "requiredWhen", "enabledWhen", "readonlyWhen"]);
    // A type the form's registry gives no Required has no Required when.
    expect(rules.descriptors("html").map((descriptor) => descriptor.key)).toEqual(["visibleWhen", "enabledWhen", "readonlyWhen"]);
    expect(rules.descriptors("number")).toBe(rules.descriptors("number"));
    expect(mode.inspector?.rules).toBe(rules);
    expect((rules.note as (nodeId: string) => string | undefined)("income_total")).toContain("own fields of its page");
  });

  it("offers a rule's fields by what reads them: a page the form's, a worked-out value its page's own, an own field both", async () => {
    const { mode } = await activatedMode({ journeys: [applyJourney()] });
    const rules = mode.inspector?.rules as BuilderModeRules;
    const values = (nodeId: string): string[] => rules.fieldOptions!(nodeId).map((choice) => choice.value);
    const income = pageNodes(mode.controller)[1]!.id;
    expect(values(income)).toEqual(["email", "name", "annual_income", "approved_amount", "colour", "size", "text_1"]);
    expect(values("income_total")).toEqual(["m1", "m2", "m3"]);
    expect(rules.fieldOptions!("income_total")[0]?.label).toBe("Month 1 (page-only number)");
    expect(values("m1")).toEqual(["email", "name", "annual_income", "approved_amount", "colour", "size", "text_1", "work_email", "m2", "m3"]);
  });

  it("lists the texts of every presentation's own nodes for the Languages workspace, grouped by journey and own id, worded under the node's own id", async () => {
    const { mode } = await activatedMode({ journeys: [applyJourney(), publicVariant()] });
    const texts = mode.translatableTexts();
    const alias = texts.filter((text) => text.componentId === "journey.apply.work_email");
    // A page-only node is worded where the renderer resolves it: under its own id.
    expect(alias.map((text) => [text.propertyPath, text.address])).toContainEqual(["label", { kind: "components", owner: "work_email", path: ["label"] }]);
    expect(alias.map((text) => text.propertyPath)).toContain("description");
    expect(alias[0]?.default).toBe("Work email");
    expect(alias[0]?.componentLabel).toBe("Apply · Step 1 · Work email");
    expect(texts.find((text) => text.componentId === "journey.apply.income_total")).toMatchObject({
      propertyPath: "label",
      default: "Annual income",
      address: { kind: "components", owner: "income_total", path: ["label"] }
    });
    // Inside a layout of the page's own too; a reference has no texts of its own.
    expect(texts.some((text) => text.componentId === "journey.public.contact")).toBe(true);
    expect(texts.some((text) => text.componentId === "journey.public.public_note")).toBe(false);
    // After the page's own texts.
    const at = (group: string): number => texts.findIndex((text) => text.componentId === group);
    expect(at("journey.apply.details")).toBeLessThan(at("journey.apply.work_email"));
    expect(at("journey.apply.work_email")).toBeLessThan(at("journey.apply.income"));
  });

  it("lists the row wording of a Check answers step at journeys, id, pages, page id, review, labels, component id, labelled by the field it words", async () => {
    const check = {
      id: "check",
      title: "Check your answers",
      kind: "review",
      review: { labels: { name: "Who are you?", email: "Where do we write?" }, emptyOptional: "omit" },
      components: []
    };
    const { mode } = await activatedMode({ journeys: [{ id: "short", pages: [{ id: "one", components: ["name", "email"] }, check] }] } as unknown as JourneyConfiguration);
    const rows = mode.translatableTexts().filter((text) => text.componentId === "journey.short.check" && text.propertyPath.startsWith("review.labels."));
    expect(rows.map((row) => [row.address, row.default])).toEqual([
      [{ kind: "journeys", owner: "short", path: ["pages", "check", "review", "labels", "name"] }, "Who are you?"],
      [{ kind: "journeys", owner: "short", path: ["pages", "check", "review", "labels", "email"] }, "Where do we write?"]
    ]);
    expect(rows[0]!.label).toContain("Name");
    expect(rows[0]!.section).toBe("Wording");
    // The step's other texts keep their addresses, and the settings that are not text are no row.
    const all = mode.translatableTexts().filter((text) => text.componentId === "journey.short.check");
    expect(all.map((text) => text.propertyPath)).toEqual(expect.arrayContaining(["title", "review.labels.name", "review.labels.email"]));
    expect(all.some((text) => text.propertyPath === "review.emptyOptional")).toBe(false);
    // A step with no wording written lists none.
    const plain = await activatedMode({ journeys: [{ id: "short", pages: [{ id: "one", components: ["name"] }, { id: "check", kind: "review", components: [] }] }] } as unknown as JourneyConfiguration);
    expect(plain.mode.translatableTexts().some((text) => text.propertyPath.startsWith("review.labels."))).toBe(false);
  });
});

describe("own layouts and own types the host does not define", () => {
  /** The standard catalogue's grid (its columns are slots no definition declares) and a plugin's accordion (one slot declared, its sections not). */
  function layoutDefinitions(): ComponentDefinition[] {
    return [
      ...formDefinitions(),
      {
        type: "grid",
        version: "1.0.0",
        createDefault: () => ({ id: "grid", type: "grid", configuration: { columns: 2 }, children: { column_1: [], column_2: [] } }),
        capabilities: [],
        children: { slots: [] }
      },
      {
        type: "accordion",
        version: "1.0.0",
        createDefault: () => ({ id: "accordion", type: "accordion", configuration: {}, children: { intro: [] } }),
        capabilities: [],
        children: { slots: [{ id: "intro", multiple: true }] }
      }
    ];
  }

  async function layoutMode(journey: Journey): Promise<{ mode: JourneyBuilderMode; errors: string[] }> {
    const types = [...FORM_TYPES, { type: "grid", label: "Grid" }, { type: "accordion", label: "Accordion" }];
    const form = new BuilderController({ initialRoot: formRoot(), componentTypes: types, componentDefinitions: layoutDefinitions() });
    const errors: string[] = [];
    const mode = createJourneyBuilderMode({ form, journey: { journeys: [journey] }, formDefinitions: () => layoutDefinitions(), onError: (message) => errors.push(message) });
    await mode.activate?.(modeContext());
    return { mode, errors };
  }

  /** Tries the designer's own types and a page-only field in `slotId` of `layoutId`: only the field lands, and only it is written. */
  function onlyPageOnlyFieldsLand(mode: JourneyBuilderMode, layoutId: string, slotId: string): void {
    const controller = mode.controller;
    const before = JSON.stringify(mode.journey);
    for (const type of [JOURNEY_PAGE_TYPE, "journey-route", "journey-value"]) {
      controller.add(type, layoutId, slotId);
      expect(controller.dropError).toBe(`Child type ${type} is not allowed in slot ${slotId}`);
      expect(JSON.stringify(mode.journey)).toBe(before);
    }
    controller.add("text", layoutId, slotId);
    expect(controller.dropError).toBeUndefined();
    controller.add(JOURNEY_FIELD_TYPE, layoutId, slotId);
    expect(controller.dropError).toBeUndefined();
    expect(JSON.stringify(mode.journey)).not.toContain("journey-page");
    expect(JSON.stringify(mode.journey)).not.toContain("journey-route");
  }

  it("takes no page, route or worked-out value into a grid's columns, which its definition does not declare", async () => {
    const { mode, errors } = await layoutMode(applyJourney());
    const details = pageNodes(mode.controller)[0]!;
    mode.controller.add("grid", details.id, JOURNEY_CONTENT_SLOT);
    const grid = mode.controller.selectedComponentId()!;
    onlyPageOnlyFieldsLand(mode, grid, "column_1");
    onlyPageOnlyFieldsLand(mode, grid, "column_2");
    expect(errors).toEqual([]);
  });

  it("takes none into a plugin layout's slots, declared or not", async () => {
    const journey = applyJourney();
    journey.pages[0]!.components!.push({ id: "faq", type: "accordion", configuration: {}, children: { intro: [], more: [] } } as never);
    const { mode, errors } = await layoutMode(journey);
    onlyPageOnlyFieldsLand(mode, "faq", "intro");
    onlyPageOnlyFieldsLand(mode, "faq", "more");
    expect(errors).toEqual([]);
  });

  it("gives a type the host does not define — a carousel in the fixture's contact layout — a label-only inspector and slots that take page-only fields alone, built through the mode", async () => {
    const journey = publicVariant();
    (journey.pages[0]!.components![0] as { type: string }).type = "carousel";
    const { mode, errors } = await activatedMode({ journeys: [journey] });
    const controller = mode.controller;
    expect(controller.hasComponentType("carousel")).toBe(true);
    expect(controller.inspectorModel("contact")?.sections.flatMap((section) => section.fields.map((field) => field.propertyPath))).toEqual(["label"]);
    onlyPageOnlyFieldsLand(mode, "contact", "content");
    expect(errors).toEqual([]);
  });
});

describe("the findings card's words for a left-out input", () => {
  it("offers one Make it optional per required calculation an input left out feeds, naming each", async () => {
    const root = formRoot();
    const times = (factor: number): Expression => ({ kind: "arithmetic", operator: "multiply", left: read("rate"), right: { kind: "literal", value: factor } });
    root.children!.content!.push(
      { id: "rate", type: "number", configuration: { label: "Rate" } },
      { id: "total", type: "number", configuration: { label: "Total", required: true }, rules: { value: times(2) } },
      { id: "tax", type: "number", configuration: { label: "Tax", required: true }, rules: { value: times(0.1) } }
    );
    const all = ["email", "name", "money", "approved_amount", "colour", "size", "text_1", "total", "tax"];
    const { designer, design } = await designFor({ id: "quick", pages: [{ id: "one", components: all }] }, root);
    const rate = designer.findingEntries(design.view()).filter((entry) => entry.code === "calc.input-left-out");
    expect(rate).toHaveLength(2);
    const optional = rate.flatMap((entry) => entry.fixes.filter((fix) => fix.kind === "optional"));
    expect(optional.map((fix) => [fix.label, fix.componentId])).toEqual([
      ["Make Total optional on the form", "total"],
      ["Make Tax optional on the form", "tax"]
    ]);
    // Ask it here asks the input, whichever calculation's finding it comes with.
    expect(rate.every((entry) => entry.fixes.some((fix) => fix.kind === "ask" && fix.componentId === "rate"))).toBe(true);
  });
});

describe("the preview of a presentation's own nodes", () => {
  async function previewOf(value: Journey): Promise<{ design: Design; runtime: () => FormRuntime; subject: JourneyPreviewSubject; preview: ReturnType<typeof createJourneyPreviewSession> }> {
    const design = await designFor(value);
    const preview = createJourneyPreviewSession({ form: design.form, lent: JOURNEY_PREVIEW_LENT });
    const subject: JourneyPreviewSubject = { journeyId: value.id, tree: () => design.controller.previewSnapshot(), pageIds: design.pageIds };
    design.controller.on("change", (event) => {
      if (event.reason !== "select") {
        preview.refresh(subject);
      }
    });
    design.form.on("change", (event) => {
      if (event.reason !== "select") {
        preview.formChanged();
      }
    });
    preview.show(subject);
    return { design, subject, preview, runtime: () => preview.runtime as unknown as FormRuntime };
  }

  it("indexes the journey's own nodes afresh on every edit: a page-only field dropped in is asked at once", async () => {
    const { design, runtime } = await previewOf(applyJourney());
    expect(runtime().presentationIndex()?.order).toContain("m1");
    const income = pageNodes(design.controller)[1]!;
    design.controller.add("number", income.id, JOURNEY_CONTENT_SLOT);
    const added = design.controller.selectedComponentId()!;
    expect(runtime().presentationIndex()?.order).toContain(added);
    expect(runtime().presentationValuePathOf(added)).toBe(`@apply.${added}`);
  });

  it("carries the presentation's own answers into a rebuilt runtime, and never another presentation's", async () => {
    const { design, runtime } = await previewOf(applyJourney());
    const first = runtime();
    first.setValue("@apply.m1", 1200);
    first.setValue("@other.x", "elsewhere");
    first.setValue("name", "Ada");
    expect(Object.keys(first.state().values)).toEqual(expect.arrayContaining(["@apply.m1", "@other.x"]));
    // A new form tree: a new runtime, the answers replayed.
    design.form.setProperty("name", "label", "Your name");
    const second = runtime();
    expect(second).not.toBe(first);
    expect(second.presentationValues()).toMatchObject({ m1: 1200 });
    expect(second.state().values.name).toBe("Ada");
    expect(Object.keys(second.state().values)).toContain("@apply.m1");
    expect(Object.keys(second.state().values)).not.toContain("@other.x");
  });
});

describe("writing a journey being authored", () => {
  it("leaves out a worked-out value not finished and a blank Fills, so the journey can still be saved", () => {
    const tree = treeFromJourney(applyJourney());
    const income = tree.children![JOURNEY_PAGES_SLOT]![1]!.children![JOURNEY_CONTENT_SLOT]!;
    income.push({ id: "worked-out_1", type: "journey-value", configuration: { to: "" } }, { id: "worked-out_2", type: "journey-value", configuration: { to: "name" } });
    (income[0]!.configuration as Record<string, unknown>).fills = "";
    const written = journeyFromTree(tree, "apply");
    expect(written).toBeDefined();
    expect(written!.pages[1]!.components!.map((entry) => (typeof entry === "string" ? entry : entry.id))).toEqual(["m1", "m2", "m3", "income_total"]);
    expect(written!.pages[1]!.components![0]).toEqual({ id: "m1", type: "number", configuration: { label: "Month 1" } });
    // Untouched otherwise: the fixture round-trips as written.
    expect(JSON.stringify(journeyFromTree(treeFromJourney(applyJourney()), "apply"))).toBe(JSON.stringify(applyJourney()));
  });
});
