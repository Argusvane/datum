// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { escapeHtml } from "../form-engine/render/core/escape-html.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { slotEmptyHintsByComponent } from "../form-engine/builder/web-component/builder-shared.js";
import {
  JOURNEY_STAKES_TEXT,
  conditionInWords,
  createJourneyDesigner,
  indexJourneyForm,
  journeyAddPopoverHtml,
  journeyEmptyStateHtml,
  type JourneyDesigner,
  type JourneyDesignerContext,
  type JourneyEntryDesign
} from "../form-engine/builder/journey-designer/journey-designer.js";
import { JOURNEY_EN } from "../form-engine/builder/journey-designer/journey-texts-en.js";
import {
  JOURNEY_CONTENT_SLOT,
  JOURNEY_FIELD_TYPE,
  JOURNEY_PAGE_TYPE,
  JOURNEY_PAGES_SLOT,
  JOURNEY_ROOT_ID,
  JOURNEY_ROUTE_TYPE,
  JOURNEY_ROUTES_SLOT
} from "../form-engine/builder/journey-designer/journey-mode-model.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The Journeys designer's hooks: what the builder's controller is given for a journey
 * (the pickers, labels, notes and problems of its inspector and outline) and the designer's words
 * and popovers. A step is drawn on the canvas by the Step view (`journey-step-view` and the mode's
 * tests), never from these definitions, so what the Pages cards drew is not tested here any more.
 * A form with a few questions, a group and a repeating section stands in for any.
 */

function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        {
          id: "contactMethod",
          type: "select",
          configuration: { label: "Contact method", options: [{ value: "mail", label: "Mail" }, { value: "phone", label: "Phone" }] }
        },
        {
          id: "address",
          type: "panel",
          configuration: { label: "Address" },
          children: {
            content: [
              { id: "street", type: "text", configuration: { label: "Street" } },
              { id: "city", type: "text", configuration: { label: "City" } }
            ]
          }
        },
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

const methodIs = (value: string): string => `contactMethod = "${value}"`;

function journey(): Journey {
  return {
    id: "intake",
    name: "Step by step",
    pages: [
      { id: "about", title: "About you", components: ["fullName", "contactMethod"], routes: [{ when: methodIs("phone"), to: "finish" }] },
      { id: "where", components: ["address"], routes: [{ to: "about" }, { to: "$end" }] },
      { id: "finish", components: ["consent", "submit", "fullName", "ghost"] }
    ]
  };
}

interface Design {
  designer: JourneyDesigner;
  controller: BuilderController;
  design: JourneyEntryDesign;
  pageIds: Map<string, string>;
}

/** A journey's controller, set up the way the mode sets one up. */
function designFor(value: Journey, root: ComponentNode = form(), context: Partial<JourneyDesignerContext> = {}): Design {
  const designer = createJourneyDesigner({ formRoot: () => root, locale: () => "en", ...context });
  const pageIds = new Map<string, string>();
  const tree = designer.treeFromJourney(value, { pageIds });
  const controller = new BuilderController({ componentTypes: [], initialRoot: tree });
  const design = designer.entry({ journeyId: () => value.id, tree: () => controller.previewSnapshot(), pageIds });
  controller.setOptions({ ...design.builderOptions, initialRoot: tree, locale: "en" });
  controller.on("change", () => design.invalidate());
  return { designer, controller, design, pageIds };
}



function pageNode(controller: BuilderController, index: number): ComponentNode {
  return controller.snapshot().children?.[JOURNEY_PAGES_SLOT]?.[index] as ComponentNode;
}

describe("the Journeys designer's outline and what it follows", () => {
  it("says what goes in an empty slot, and how to add it, in place of the form's words", () => {
    // A page with nothing on it and no routes, beside a second page, then a journey with no pages at all.
    const { controller } = designFor({ id: "j", pages: [{ id: "blank" }, { id: "more", components: ["notes"] }] });
    const hints = slotEmptyHintsByComponent(controller.treeView());
    expect(hints.get(pageNode(controller, 0).id)?.get(JOURNEY_CONTENT_SLOT)).toBe(JOURNEY_EN["journey.designer.hint.content"]);
    expect(hints.get(pageNode(controller, 0).id)?.get(JOURNEY_ROUTES_SLOT)).toBe(JOURNEY_EN["journey.designer.hint.routes"]);
    controller.remove(pageNode(controller, 0).id);
    controller.remove(pageNode(controller, 0).id);
    expect(slotEmptyHintsByComponent(controller.treeView()).get(JOURNEY_ROOT_ID)?.get(JOURNEY_PAGES_SLOT)).toBe(JOURNEY_EN["journey.designer.hint.pages"]);
  });

  it("follows a form edit on the next read, with no rebuild", () => {
    let root = form();
    const designer = createJourneyDesigner({ formRoot: () => root, locale: () => "en" });
    const pageIds = new Map<string, string>();
    const tree = designer.treeFromJourney(journey(), { pageIds });
    const controller = new BuilderController({ componentTypes: [], initialRoot: tree });
    const design = designer.entry({ journeyId: () => "intake", tree: () => controller.previewSnapshot(), pageIds });
    controller.setOptions({ ...design.builderOptions, initialRoot: tree });
    controller.setProperty(pageNode(controller, 0).id, "title", "About");
    expect(controller.canUndo()).toBe(true);
    root = { ...root, children: { content: (root.children?.content ?? []).map((node) => (node.id === "fullName" ? { ...node, configuration: { label: "Your name" } } : node)) } };
    designer.invalidateForm();
    const first = controller.treeView().slots.find((slot) => slot.slotId === JOURNEY_PAGES_SLOT)?.children[0];
    expect(first?.slots.find((slot) => slot.slotId === JOURNEY_CONTENT_SLOT)?.children[0]?.label).toBe("Your name");
    expect(controller.canUndo()).toBe(true);
  });

  it("labels a route in the outline by where it goes: a later step, the end, a missing step, nowhere yet, or back (ignored)", () => {
    const { controller } = designFor(journey());
    const routeLabels = (index: number): string[] =>
      (controller.treeView().slots.find((slot) => slot.slotId === JOURNEY_PAGES_SLOT)?.children[index]?.slots.find((slot) => slot.slotId === JOURNEY_ROUTES_SLOT)?.children ?? []).map((node) => node.label);
    expect(routeLabels(0)).toEqual(["Route → Step 3 · I agree"]);
    expect(routeLabels(1)).toEqual(["Route → Step 1 · About you (an earlier step: ignored, routes only go forward)", "Route → End of the journey"]);

    const missing = designFor({ id: "j", pages: [{ id: "p", components: ["fullName"], routes: [{ to: "gone" }] }] });
    expect(missing.controller.treeView().slots[0]?.children[0]?.slots[1]?.children[0]?.label).toBe("Route → missing step “gone”");
    missing.controller.add(JOURNEY_ROUTE_TYPE, pageNode(missing.controller, 0).id, JOURNEY_ROUTES_SLOT);
    expect(missing.controller.treeView().slots[0]?.children[0]?.slots[1]?.children[1]?.label).toBe("Route → Choose where this route goes (ignored until then)");
  });

  it("shows a route to an id the file named as the page later written under it, in the picker", () => {
    const { controller } = designFor({ id: "j", pages: [{ id: "p", components: ["fullName"], routes: [{ to: "summary" }] }] });
    controller.add(JOURNEY_PAGE_TYPE, controller.rootId(), JOURNEY_PAGES_SLOT);
    const added = pageNode(controller, 1).id;
    controller.setProperty(added, "pageId", "summary");
    controller.setProperty(added, "title", "Summary");
    const route = pageNode(controller, 0).children?.[JOURNEY_ROUTES_SLOT]?.[0] as ComponentNode;
    const to = controller
      .inspectorModel(route.id)
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.propertyPath === "to");
    expect(to?.choices[0]).toEqual({ value: "", label: "Step 2 · Summary (kept as written)" });
  });
});

describe("the Journeys designer's inspector", () => {
  it("offers the form's components for a question and every page for a route", () => {
    const { controller } = designFor(journey());
    const about = pageNode(controller, 0);
    const question = about.children?.[JOURNEY_CONTENT_SLOT]?.[0] as ComponentNode;
    const picker = controller
      .inspectorModel(question.id)
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.propertyPath === "componentId");
    expect(picker?.choices[0]).toEqual({ value: "", label: "— choose —" });
    expect(picker?.choices.find((choice) => choice.value === "address")?.label).toBe("Address (address)");
    expect(picker?.choices.map((choice) => choice.value)).toContain("childName");

    const where = pageNode(controller, 1);
    const back = where.children?.[JOURNEY_ROUTES_SLOT]?.[0] as ComponentNode;
    const to = controller
      .inspectorModel(back.id)
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.propertyPath === "to");
    // Every page, the ones behind marked ignored, so a backward route shows as the page it names.
    expect(to?.choices.map((choice) => choice.label)).toEqual([
      "— choose —",
      "Step 1 · About you (earlier step: ignored)",
      "Step 2 · Address (this step: ignored)",
      "Step 3 · I agree",
      "End of the journey"
    ]);
    expect(to?.value).toBe(about.id);
  });

  it("names a route to a page since deleted, and one to a page the file never had", () => {
    const { controller } = designFor({ id: "j", pages: [{ id: "p", components: ["fullName"], routes: [{ to: "gone" }] }] });
    const route = pageNode(controller, 0).children?.[JOURNEY_ROUTES_SLOT]?.[0] as ComponentNode;
    const to = controller
      .inspectorModel(route.id)
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.propertyPath === "to");
    expect(to?.choices[0]?.label).toBe("Missing step “gone” (kept as written)");

    const deleted = designFor({ id: "j", pages: [{ id: "p", components: ["fullName"], routes: [{ to: "q" }] }, { id: "q", components: ["notes"] }] });
    deleted.controller.remove(pageNode(deleted.controller, 1).id);
    const kept = pageNode(deleted.controller, 0).children?.[JOURNEY_ROUTES_SLOT]?.[0] as ComponentNode;
    const choices = deleted.controller
      .inspectorModel(kept.id)
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.propertyPath === "to")?.choices;
    expect(choices?.[1]).toEqual({ value: "journey-page_2", label: "Missing step “q”" });
  });

  it("shows a value a file writes out in full as itself, not as unknown", () => {
    const { controller } = designFor({ id: "j", progress: "count", pages: [{ id: "p", kind: "questions", components: ["fullName"] }] });
    const fields = (id: string) => controller.inspectorModel(id)?.sections.flatMap((section) => section.fields) ?? [];
    const progress = fields(JOURNEY_ROOT_ID).find((field) => field.propertyPath === "progress");
    // The counter is the default: blank counts the steps, "count" written out says so, None turns it off.
    expect(progress?.choices.map((choice) => [choice.value, choice.label])).toEqual([
      ["", "Count the steps: Step 2 of 5"],
      ["none", "None"],
      ["count", "Count the steps: Step 2 of 5 (written out)"]
    ]);
    const plainProgress = designFor({ id: "j", pages: [{ id: "p", components: ["fullName"] }] })
      .controller.inspectorModel(JOURNEY_ROOT_ID)
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.propertyPath === "progress");
    expect(plainProgress?.choices.map((choice) => choice.value)).toEqual(["", "none"]);
    const kind = fields(pageNode(controller, 0).id).find((field) => field.propertyPath === "kind");
    expect(kind?.choices.map((choice) => choice.value)).toEqual(["", "exit", "review", "questions"]);
    // Only when written: a page with no kind has the three choices (Check answers is the third).
    const plain = designFor({ id: "j", pages: [{ id: "p", components: ["fullName"] }] });
    const plainKind = plain.controller
      .inspectorModel(pageNode(plain.controller, 0).id)
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.propertyPath === "kind");
    expect(plainKind?.choices.map((choice) => choice.value)).toEqual(["", "exit", "review"]);
  });

  it("groups the journey's and a page's settings, wording included", () => {
    const { controller } = designFor(journey());
    expect(controller.inspectorModel(JOURNEY_ROOT_ID)?.sections.map((section) => section.title)).toEqual(["Journey", "Validation", "Wording"]);
    expect(controller.inspectorModel(pageNode(controller, 0).id)?.sections.map((section) => section.title)).toEqual(["Step", "Validation", "Wording"]);
  });

  it("holds a page's Save back only for a page id the draft changes to a taken one", () => {
    const value: Journey = {
      id: "j",
      pages: [
        { id: "a", components: ["fullName"] },
        { id: "a", components: ["notes"] },
        { id: "c", components: ["consent"] }
      ]
    };
    const { controller } = designFor(value);
    const [first, second, third] = [0, 1, 2].map((index) => pageNode(controller, index).id) as [string, string, string];
    // A clash already in the file is the advisory finding, never a block on an unrelated edit.
    controller.setDraftProperty(second, "title", "Notes");
    expect(controller.problemsOf(second)).toEqual([]);
    expect(controller.commitDraft(second)).toBe(true);

    controller.setDraftProperty(third, "pageId", "a");
    expect(controller.problemsOf(third)).toEqual([{ target: "pageId", message: "Another step of this journey has the id “a”; routes would reach only the first." }]);
    expect(controller.commitDraft(third)).toBe(false);

    controller.setDraftProperty(third, "pageId", "fullName");
    expect(controller.problemsOf(third)[0]?.message).toBe("“fullName” is the id of a component of the form; give the step an id of its own.");
    controller.setDraftProperty(third, "pageId", "$end");
    expect(controller.problemsOf(third)[0]?.message).toContain("names the end of the journey");
    controller.setDraftProperty(third, "pageId", "closing");
    expect(controller.problemsOf(third)).toEqual([]);
    expect(controller.commitDraft(third)).toBe(true);
    expect(first).toBe("journey-page_1");
  });

  it("says each finding again under the box it is about, the rest above the sections, holding no Save back", () => {
    const value = journey();
    value.pages[0]!.routes![0]!.when = "nowhere = 1";
    const { controller } = designFor(value);
    const [about, where, finish] = [0, 1, 2].map((index) => pageNode(controller, index));
    const questions = (page: ComponentNode | undefined): ComponentNode[] => page?.children?.[JOURNEY_CONTENT_SLOT] ?? [];
    const routes = (page: ComponentNode | undefined): ComponentNode[] => page?.children?.[JOURNEY_ROUTES_SLOT] ?? [];
    // A backward route: under where it goes.
    expect(controller.notesOf(routes(where)[0]!.id)).toEqual([expect.objectContaining({ target: "to", severity: "error" })]);
    expect(controller.notesOf(routes(where)[0]!.id)[0]?.message).toContain("routes only go forward");
    // A question the form does not have, and one asked on two pages: under the form component.
    const ghost = questions(finish).find((node) => (node.configuration as { componentId: string }).componentId === "ghost")!;
    expect(controller.notesOf(ghost.id)).toEqual([expect.objectContaining({ target: "componentId", severity: "error" })]);
    expect(controller.notesOf(questions(about)[0]!.id)).toEqual([expect.objectContaining({ target: "componentId", severity: "warning" })]);
    // A route's condition is edited in Logic, so its note names no box (it stands above the sections).
    expect(controller.notesOf(routes(about)[0]!.id).map((note) => note.target)).toEqual([undefined]);
    // The journey's own findings name no box.
    expect(controller.notesOf(JOURNEY_ROOT_ID).every((note) => note.target === undefined)).toBe(true);
    // Advisory: the backward route still saves an edit.
    controller.setDraftProperty(routes(where)[0]!.id, "to", "$end");
    expect(controller.problemsOf(routes(where)[0]!.id)).toEqual([]);
    expect(controller.notesOf(routes(where)[0]!.id)).toEqual([]);
    expect(controller.commitDraft(routes(where)[0]!.id)).toBe(true);
  });

  it("notes two pages sharing an id under the Page id box, and a page with nothing to title it under Title", () => {
    const value: Journey = {
      id: "j",
      pages: [
        { id: "a", components: ["fullName"] },
        { id: "a", components: ["notes"] },
        { id: "empty", components: [] }
      ]
    };
    const { controller } = designFor(value);
    expect(controller.notesOf(pageNode(controller, 1).id).map((note) => note.target)).toContain("pageId");
    const empty = controller.notesOf(pageNode(controller, 2).id);
    expect(empty.find((note) => note.target === "title")?.message).toContain("has no title");
    // A page with nothing on it is shown as it is: nothing else is said of it.
    expect(empty.some((note) => note.target === undefined)).toBe(false);
  });

  it("folds the Wording sections, and shows the id a blank page id is written under", () => {
    const { controller } = designFor({ id: "j", pages: [{ id: "a", components: ["fullName"] }] });
    const page = pageNode(controller, 0);
    const folded = (componentId: string): string[] =>
      controller.inspectorModel(componentId)!.sections.filter((section) => section.folded).map((section) => section.title ?? "");
    expect(folded(JOURNEY_ROOT_ID)).toEqual(["Wording"]);
    expect(folded(page.id)).toEqual(["Wording"]);
    const placeholderOf = (componentId: string, propertyPath: string): string | undefined =>
      controller
        .inspectorModel(componentId)
        ?.sections.flatMap((section) => section.fields)
        .find((field) => field.propertyPath === propertyPath)?.placeholder;
    expect(placeholderOf(page.id, "pageId")).toBe(page.id);
    expect(placeholderOf(page.id, "title")).toBeUndefined();
  });

  it("finds the questions whose form component is gone, and no other", () => {
    const value = journey();
    value.pages[1]!.components = ["address", "street", "gone"];
    const { designer, controller } = designFor(value);
    const blank = pageNode(controller, 0);
    controller.add(JOURNEY_FIELD_TYPE, blank.id, JOURNEY_CONTENT_SLOT);
    const componentIdOf = (id: string): string =>
      ((controller.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? [])
        .flatMap((page) => page.children?.[JOURNEY_CONTENT_SLOT] ?? [])
        .find((node) => node.id === id)?.configuration as { componentId: string }).componentId;
    const missing = designer.missingQuestions(controller.snapshot());
    expect(missing.map(componentIdOf)).toEqual(["gone", "ghost"]);
  });

  it("calls a node by what it stands for in the outline, and shows the journey's id read-only on the root alone", () => {
    const { controller } = designFor(journey());
    const view = controller.treeView();
    expect(view.label).toBe("Step by step");
    const pages = view.slots.find((slot) => slot.slotId === JOURNEY_PAGES_SLOT)?.children ?? [];
    expect(pages.map((page) => page.label)).toEqual(["Step 1 · About you", "Step 2 · Address", "Step 3 · I agree"]);
    const firstContent = pages[0]?.slots.find((slot) => slot.slotId === JOURNEY_CONTENT_SLOT)?.children ?? [];
    expect(firstContent.map((node) => node.label)).toEqual(["Full name", "Contact method"]);
    const routes = pages[0]?.slots.find((slot) => slot.slotId === JOURNEY_ROUTES_SLOT)?.children ?? [];
    expect(routes[0]?.label).toBe("Route → Step 3 · I agree");

    expect(controller.idRow(JOURNEY_ROOT_ID)).toMatchObject({ mode: "static", text: "intake" });
    expect(controller.idRow(pageNode(controller, 0).id)).toEqual({ mode: "hidden" });
  });

  it("gives the canvas the Form sheet rule, no theme or faces of its own, and a palette of pages, questions and routes", () => {
    const { controller } = designFor(journey());
    // Fluid: no fixed width, so the canvas draws no data-sheet-fixed; its bar has no device widths either.
    expect(controller.sheetWidth()).toBeUndefined();
    expect(controller.previewWidths()).toBe(false);
    // The designer brings no binding of its own: the Step view draws with the form's (`step-view.ts`).
    expect(controller.canvasBinding()).toBeUndefined();
    expect(controller.canvasComponents()).toBeUndefined();
    expect(controller.componentTypes().map((entry) => entry.label)).toEqual(["Step", "Form field", "Route"]);
    // A palette click on a Route with a page selected lands in that page's routes.
    const first = pageNode(controller, 0);
    controller.select(first.id);
    controller.add(JOURNEY_ROUTE_TYPE);
    expect(pageNode(controller, 0).children?.[JOURNEY_ROUTES_SLOT]).toHaveLength(2);
    controller.add(JOURNEY_PAGE_TYPE);
    expect(controller.snapshot().children?.[JOURNEY_PAGES_SLOT]).toHaveLength(4);
  });
});

describe("the Journeys designer's words", () => {
  it("reads a simple condition the way the Rules tab does", () => {
    const index = indexJourneyForm(form(), "en");
    expect(conditionInWords(methodIs("mail"), index)).toBe("Contact method equals “mail”");
    expect(conditionInWords("consent", index)).toBe("I agree is checked / true");
    expect(conditionInWords(`${methodIs("mail")} or not(consent)`, index)).toBe("Contact method equals “mail” or I agree is unchecked / false");
    // A shape the sentence cannot word is the printed formula, labels for fields.
    expect(conditionInWords("len(fullName)", index)).toBe("len(Full name)");
    expect(conditionInWords("len(fullName) > 2 and consent", index)).toBe("len(Full name) > 2 and I agree");
    // One that does not parse, or cannot be evaluated, has no words: the canvas says it never holds.
    expect(conditionInWords("mail +", index)).toBeUndefined();
    expect(conditionInWords(7, index)).toBeUndefined();
    // Only answers outside every repeating section are what a condition may read.
    expect(index.components.get("fullName")?.readable).toBe(true);
    expect(index.components.get("childName")?.readable).toBe(false);
    expect(index.components.get("address")?.readable).toBe(false);
  });

  it("says what is at stake where a journey is made, and when there is none", () => {
    const popover = journeyAddPopoverHtml({ name: "Journey 2", canCopy: false, questionCount: 6 });
    expect(popover).toContain('placeholder="Journey 2"');
    // One popover: a journey starts as one empty step; none of the form's shapes is offered.
    expect(popover).toContain('data-journey-add="blank">One empty step');
    expect(popover).not.toContain('data-journey-add="sections"');
    expect(popover).not.toContain('data-journey-add="one-page"');
    expect(popover).not.toContain('data-journey-add="copy"');
    expect(popover).toContain("<h3>Start with</h3>");
    expect(popover).toContain("A new journey starts as one empty step. Fill it from the Form fields panel, and add steps from the map.");
    expect(popover).not.toMatch(/variant/i);
    expect(popover).toContain(escapeHtml(JOURNEY_STAKES_TEXT));
    // What the dialog is described by, so the stakes are read as focus enters it.
    expect(popover).toContain(`<p class="note" data-tone="warning" id="jd-add-stakes" data-journey-add-stakes>${escapeHtml(JOURNEY_STAKES_TEXT)}</p>`);
    expect(popover).toContain('<p class="note" id="jd-add-hint">');
    expect(journeyAddPopoverHtml({ name: "J", canCopy: true, questionCount: 1, error: "No" })).toContain('data-journey-add="copy"');

    const empty = journeyEmptyStateHtml({ questionCount: 6 });
    expect(empty).toContain("No journeys yet");
    expect(empty).toContain("It starts as one empty step");
    expect(empty).toContain("to put on the steps from the Form fields panel");
    expect(empty).toContain(escapeHtml(JOURNEY_STAKES_TEXT));
    expect(empty).not.toContain("jd-add-stakes");
    expect(empty).toContain('class="btn primary" data-journey-empty-add>New journey…');
    expect(empty).toContain('class="note" data-tone="warning" data-journey-empty-stakes');
    expect(empty).not.toMatch(/variant/i);
  });

  it("edits a journey's and a page's texts as plain strings: the box shows the default and typing writes the default only", () => {
    const { controller, designer, pageIds } = designFor(journey());
    const page = pageNode(controller, 0);
    expect(controller.getProperty(controller.rootId(), "name")).toBe("Step by step");
    expect(controller.getProperty(page.id, "title")).toBe("About you");
    const field = (componentId: string, propertyPath: string) =>
      controller
        .inspectorModel(componentId)
        ?.sections.flatMap((section) => section.fields)
        .find((candidate) => candidate.propertyPath === propertyPath);
    // The inspector field type keeps its name: a translatable string.
    expect(field(page.id, "title")?.control).toBe("localized-text");
    controller.setProperty(page.id, "title", "About us");
    controller.setProperty(controller.rootId(), "name", "Walk-through");
    const written = designer.journeyFromTree(controller.snapshot(), "intake", { pageIds });
    expect(written?.name).toBe("Walk-through");
    expect(written?.pages[0]?.title).toBe("About us");
  });
});
