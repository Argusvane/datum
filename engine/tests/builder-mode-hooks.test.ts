import { describe, expect, it } from "vitest";

import {
  BuilderController,
  type BuilderChangeEvent,
  type BuilderNote,
  type BuilderProblem,
  type BuilderRootSetting
} from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentDefinition, PropertyEditorField } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The controller's hooks for a builder mode whose tree is not a form: where a
 * palette click lands when the root's slot refuses the type, what the outline calls a node,
 * how the ID row is drawn, what else holds a Save back, where a picker's choices come from,
 * and the settings another mode drafts on the form root. A journey-shaped tree stands in for
 * the Journeys mode: a root that takes pages, pages that take questions and routes.
 */

const container = (type: string, slots: Array<{ id: string; allowedTypes: string[] }>, fields: PropertyEditorField[] = []): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({
    id: type,
    type,
    configuration: {},
    children: Object.fromEntries(slots.map((slot) => [slot.id, []]))
  }),
  capabilities: [],
  children: { slots: slots.map((slot) => ({ ...slot, multiple: true })) },
  propertyEditor: { mode: "replace", fields }
});

const leaf = (type: string, fields: PropertyEditorField[]): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: {} }),
  capabilities: [],
  propertyEditor: { mode: "replace", fields }
});

const DEFINITIONS: ComponentDefinition[] = [
  container("journey", [{ id: "pages", allowedTypes: ["journey-page"] }], [{ id: "name", type: "text", propertyPath: "name", label: "Journey name" }]),
  container(
    "journey-page",
    [
      { id: "content", allowedTypes: ["journey-field"] },
      { id: "routes", allowedTypes: ["journey-route"] }
    ],
    [
      { id: "pageId", type: "text", propertyPath: "pageId", label: "Page id" },
      { id: "title", type: "text", propertyPath: "title", label: "Title" }
    ]
  ),
  leaf("journey-field", [{ id: "componentId", type: "select", propertyPath: "componentId", label: "Question" }]),
  leaf("journey-route", [
    { id: "to", type: "select", propertyPath: "to", label: "Goes to" },
    { id: "kind", type: "select", propertyPath: "kind", label: "Kind", choices: [{ value: "declared", label: "Declared" }] }
  ])
];

const page = (id: string, pageId: string, title?: string): ComponentNode => ({
  id,
  type: "journey-page",
  configuration: { pageId, ...(title !== undefined ? { title } : {}) },
  children: { content: [], routes: [] }
});

function journeyController(pages: ComponentNode[], root: Partial<ComponentNode> = {}): BuilderController {
  return new BuilderController({
    initialRoot: { id: "journey", type: "journey", configuration: { name: "Short" }, children: { pages }, ...root },
    componentDefinitions: DEFINITIONS,
    componentTypes: [
      { type: "journey-page", label: "Page" },
      { type: "journey-field", label: "Question" },
      { type: "journey-route", label: "Route" }
    ]
  });
}

const slotOf = (ctrl: BuilderController, id: string): { parentId: string | undefined; slotId: string | undefined } => {
  const find = (node: ComponentNode, parent: ComponentNode | undefined, slot: string | undefined): { parentId: string | undefined; slotId: string | undefined } | undefined => {
    if (node.id === id) {
      return { parentId: parent?.id, slotId: slot };
    }
    for (const [slotId, children] of Object.entries(node.children ?? {})) {
      for (const child of children) {
        const hit = find(child, node, slotId);
        if (hit) {
          return hit;
        }
      }
    }
    return undefined;
  };
  return find(ctrl.snapshot(), undefined, undefined) ?? { parentId: undefined, slotId: undefined };
};

describe("addTarget: a palette click lands where the tree declares the type", () => {
  it("puts a page in the root's pages, even when the root has no children key yet", () => {
    const ctrl = new BuilderController({
      // As a journey with no pages might arrive: no children at all.
      initialRoot: { id: "journey", type: "journey", configuration: {} },
      componentDefinitions: DEFINITIONS
    });
    ctrl.add("journey-page");
    const added = ctrl.selectedComponentId()!;
    expect(slotOf(ctrl, added)).toEqual({ parentId: "journey", slotId: "pages" });
    expect(ctrl.dropError).toBeUndefined();
  });

  it("puts a question in the selected page's content and a route in its routes, from the page or anything on it", () => {
    const ctrl = journeyController([page("p1", "about"), page("p2", "details")]);
    ctrl.select("p1");
    ctrl.add("journey-field");
    const question = ctrl.selectedComponentId()!;
    expect(slotOf(ctrl, question)).toEqual({ parentId: "p1", slotId: "content" });
    // The question is selected now: a route still finds its page, the nearest node that takes one.
    ctrl.add("journey-route");
    expect(slotOf(ctrl, ctrl.selectedComponentId()!)).toEqual({ parentId: "p1", slotId: "routes" });
    // Nothing selected: the last page in the tree takes it.
    ctrl.select(undefined);
    ctrl.add("journey-field");
    expect(slotOf(ctrl, ctrl.selectedComponentId()!)).toEqual({ parentId: "p2", slotId: "content" });
  });

  it("leaves the add refused when nothing in the tree takes the type", () => {
    const ctrl = journeyController([]);
    ctrl.add("journey-route");
    expect(ctrl.dropError).toBeTruthy();
    expect(ctrl.snapshot().children?.pages).toEqual([]);
  });

  it("changes nothing for the form: a click still lands in the root's content, the selection wherever it is", () => {
    const form = new BuilderController({
      initialRoot: {
        id: "root",
        type: "form",
        configuration: {},
        children: { content: [{ id: "box", type: "panel", configuration: {}, children: { content: [] } }] }
      }
    });
    form.select("box");
    form.add("text");
    expect(slotOf(form, form.selectedComponentId()!)).toEqual({ parentId: "root", slotId: "content" });
  });
});

describe("the outline's names and the ID row, from the tree's owner", () => {
  it("names nodes through nodeLabel, falling back to the label and the id", () => {
    const ctrl = journeyController([page("p1", "about", "About you"), page("p2", "details")]);
    ctrl.setOptions({
      nodeLabel: (node) => (node.type === "journey-page" ? ((node.configuration as { title?: string }).title ?? undefined) : undefined)
    });
    const view = ctrl.treeView();
    const pages = view.slots.find((slot) => slot.slotId === "pages")!.children;
    expect(pages.map((entry) => entry.label)).toEqual(["About you", "p2"]);
    // Drafts are applied, as the canvas's are.
    ctrl.setDraftProperty("p2", "title", "Details");
    expect(ctrl.treeView().slots[0]!.children.map((entry) => entry.label)).toEqual(["About you", "Details"]);
  });

  it("answers idRow for the edited node, and nothing without the hook", () => {
    const ctrl = journeyController([page("p1", "about")]);
    expect(ctrl.idRow("p1")).toBeUndefined();
    const seen: Array<{ id: string; isRoot: boolean }> = [];
    ctrl.setOptions({
      idRow: (node, place) => {
        seen.push({ id: node.id, isRoot: place.isRoot });
        return place.isRoot ? { mode: "static", text: "short", help: "The journey's id." } : { mode: "hidden" };
      }
    });
    expect(ctrl.idRow("p1")).toEqual({ mode: "hidden" });
    expect(ctrl.idRow("journey")).toEqual({ mode: "static", text: "short", help: "The journey's id." });
    expect(ctrl.idRow("nobody")).toBeUndefined();
    expect(seen).toEqual([
      { id: "p1", isRoot: false },
      { id: "journey", isRoot: true }
    ]);
  });
});

describe("problems from the tree's owner hold a Save back only for what the draft changes", () => {
  /** A duplicate page id, the way the Journeys mode checks it: against every other page's committed id. */
  const duplicatePageId = (edited: ComponentNode, tree: ComponentNode, componentId: string): BuilderProblem[] => {
    const pageId = (edited.configuration as { pageId?: string }).pageId;
    if (edited.type !== "journey-page" || !pageId) {
      return [];
    }
    const clash = (tree.children?.pages ?? []).some((other) => other.id !== componentId && (other.configuration as { pageId?: string }).pageId === pageId);
    return clash ? [{ target: "pageId", message: `Another page already has the id "${pageId}".` }] : [];
  };

  it("lists and refuses a page id another page has, and saves once it is fixed", () => {
    const ctrl = journeyController([page("p1", "about"), page("p2", "details")]);
    ctrl.setOptions({ problems: duplicatePageId });
    ctrl.select("p2");
    ctrl.setDraftProperty("p2", "pageId", "about");
    expect(ctrl.problemsOf("p2")).toEqual([{ target: "pageId", message: 'Another page already has the id "about".' }]);
    expect(ctrl.commitDraft("p2")).toBe(false);
    expect(ctrl.getProperty("p2", "pageId")).toBe("details");
    expect(ctrl.hasPendingChanges("p2")).toBe(true);
    ctrl.setDraftProperty("p2", "pageId", "contact");
    expect(ctrl.problemsOf("p2")).toEqual([]);
    expect(ctrl.commitDraft("p2")).toBe(true);
    expect(ctrl.getProperty("p2", "pageId")).toBe("contact");
  });

  it("refuses it through the unsaved-changes prompt's Save too, which no panel stands in front of", () => {
    const ctrl = journeyController([page("p1", "about"), page("p2", "details")]);
    ctrl.setOptions({ problems: duplicatePageId });
    ctrl.select("p2");
    ctrl.setDraftProperty("p2", "pageId", "about");
    expect(ctrl.requestSelect("p1")).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toMatchObject({ componentId: "p2", action: "select" });
    ctrl.answerUnsavedChangesPrompt("save");
    // Nothing moved: the selection, the committed id and the draft are as they were.
    expect(ctrl.selectedComponentId()).toBe("p2");
    expect(ctrl.getProperty("p2", "pageId")).toBe("details");
    expect(ctrl.draftProperty("p2", "pageId")).toBe("about");
  });

  it("never holds up an edit to anything else on a page whose id already clashed", () => {
    // A file opened with two pages called "about": the clash is the mode's to report elsewhere.
    const ctrl = journeyController([page("p1", "about"), page("p2", "about")]);
    ctrl.setOptions({ problems: duplicatePageId });
    ctrl.select("p2");
    ctrl.setDraftProperty("p2", "title", "More about you");
    expect(ctrl.problemsOf("p2")).toEqual([]);
    expect(ctrl.commitDraft("p2")).toBe(true);
    expect(ctrl.getProperty("p2", "title")).toBe("More about you");
  });

  it("keeps the controller's own problem first when both name the same box", () => {
    const ctrl = journeyController([page("p1", "about"), page("p2", "details")]);
    ctrl.setOptions({ problems: () => [{ target: "id", message: "Not this id." }] });
    ctrl.setDraftId("p2", "p1");
    expect(ctrl.problemsOf("p2")).toEqual([{ target: "id", message: 'ID "p1" already exists.' }]);
  });
});

describe("fieldChoices fills a picker that declares no choices", () => {
  it("offers what the owner answers for the edited node, keeps declared choices, and leaves the rest alone", () => {
    const ctrl = journeyController([
      { ...page("p1", "about"), children: { content: [], routes: [{ id: "r1", type: "journey-route", configuration: { to: "p2" } }] } },
      page("p2", "details"),
      page("p3", "done")
    ]);
    const calls: string[] = [];
    ctrl.setOptions({
      fieldChoices: (node, field) => {
        calls.push(`${node.id}:${field.propertyPath}`);
        return field.propertyPath === "to"
          ? [
              { value: "p2", label: "Page 2 · details" },
              { value: "p3", label: "Page 3 · done" }
            ]
          : undefined;
      }
    });
    const fields = ctrl.inspectorModel("r1")!.sections.flatMap((section) => section.fields);
    expect(fields.find((field) => field.propertyPath === "to")?.choices).toEqual([
      { value: "p2", label: "Page 2 · details" },
      { value: "p3", label: "Page 3 · done" }
    ]);
    // Declared choices win: the hook is not asked for a field that has its own.
    expect(fields.find((field) => field.propertyPath === "kind")?.choices).toEqual([{ value: "declared", label: "Declared" }]);
    expect(calls).toEqual(["r1:to"]);
    // A question's picker the owner leaves alone stays empty.
    ctrl.add("journey-field", "p1", "content");
    const question = ctrl.selectedComponentId()!;
    expect(ctrl.inspectorModel(question)!.sections.flatMap((section) => section.fields)[0]?.choices).toEqual([]);
  });
});

describe("renames are announced on the change that makes them", () => {
  it("carries { from, to } on renameId's change, and on a Save of a drafted id, once", () => {
    const ctrl = new BuilderController({
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "email", type: "text", configuration: {} }] } }
    });
    const events: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => events.push(event));
    ctrl.renameId("email", "contactEmail");
    expect(events.at(-1)?.renamed).toEqual({ from: "email", to: "contactEmail" });
    ctrl.select("contactEmail");
    expect(events.at(-1)?.renamed).toBeUndefined();
    ctrl.setDraftId("contactEmail", "workEmail");
    ctrl.commitDraft("contactEmail");
    expect(events.filter((event) => event.renamed).map((event) => event.renamed)).toEqual([
      { from: "email", to: "contactEmail" },
      { from: "contactEmail", to: "workEmail" }
    ]);
    // A refused rename announces nothing.
    ctrl.renameId("workEmail", "root");
    expect(events.at(-1)?.renamed).toBeUndefined();
  });
});

describe("settings another mode drafts on the form root", () => {
  function setting(initial: string): BuilderRootSetting & { value: string; writes: string[] } {
    const entry = {
      id: "journeys.opensAs",
      value: initial,
      writes: [] as string[],
      get: () => entry.value,
      set: (value: string) => {
        entry.writes.push(value);
        entry.value = value;
      }
    };
    return entry;
  }
  const form = (): BuilderController =>
    new BuilderController({ initialRoot: { id: "root", type: "form", configuration: { title: "Intake" }, children: { content: [] } } });

  it("drafts a value on the root, counts it as unsaved, and commits it through set on Save, outside the undo history", () => {
    const ctrl = form();
    const opensAs = setting("form");
    expect(ctrl.draftRootSetting(opensAs)).toBe("form");
    ctrl.setDraftRootSetting(opensAs, "journey");
    expect(ctrl.draftRootSetting(opensAs)).toBe("journey");
    expect(ctrl.hasPendingChanges("root")).toBe(true);
    expect(ctrl.hasPendingChanges()).toBe(true);
    expect(opensAs.writes).toEqual([]);
    expect(ctrl.commitDraft("root")).toBe(true);
    expect(opensAs.writes).toEqual(["journey"]);
    expect(ctrl.hasPendingChanges("root")).toBe(false);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("forgets it on Cancel, and counts a draft set back to the committed value as clean", () => {
    const ctrl = form();
    const opensAs = setting("form");
    ctrl.setDraftRootSetting(opensAs, "journey");
    ctrl.discardDraft("root");
    expect(ctrl.draftRootSetting(opensAs)).toBe("form");
    ctrl.setDraftRootSetting(opensAs, "journey");
    ctrl.setDraftRootSetting(opensAs, "form");
    expect(ctrl.hasPendingChanges("root")).toBe(false);
    expect(ctrl.commitDraft("root")).toBe(true);
    expect(opensAs.writes).toEqual([]);
  });

  it("rides the same Save as the root's own edits, and holds a leave like them", () => {
    const ctrl = form();
    const opensAs = setting("form");
    ctrl.setDraftProperty("root", "title", "Intake, revised");
    ctrl.setDraftRootSetting(opensAs, "journey");
    let left = false;
    expect(ctrl.requestLeave(() => (left = true))).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toMatchObject({ componentId: "root", action: "leave" });
    ctrl.answerUnsavedChangesPrompt("save");
    expect(left).toBe(true);
    expect(ctrl.getProperty("root", "title")).toBe("Intake, revised");
    expect(opensAs.writes).toEqual(["journey"]);
  });
});

describe("notes from the tree's owner are said, never held against a Save", () => {
  /** A page with no title, noted under its Title box; a page with no id, noted on the page as a whole. */
  const untitled = (edited: ComponentNode): BuilderNote[] => {
    const configuration = edited.configuration as { pageId?: string; title?: string };
    if (edited.type !== "journey-page") {
      return [];
    }
    return [
      ...(!configuration.title ? [{ target: "title", message: "This page has no title." }] : []),
      ...(!configuration.pageId ? [{ message: "No page id: the builder names it.", severity: "error" as const }] : []),
      { target: "title", message: "  " }
    ];
  };

  it("lists the owner's notes for the edited node, drafts applied, and nothing without the hook", () => {
    const ctrl = journeyController([page("p1", "about"), page("p2", "details", "Details")]);
    expect(ctrl.notesOf("p1")).toEqual([]);
    const calls: string[] = [];
    ctrl.setOptions({
      notes: (edited, tree, componentId) => {
        calls.push(`${componentId}:${tree.id}`);
        return untitled(edited);
      }
    });
    // A blank message is dropped.
    expect(ctrl.notesOf("p1")).toEqual([{ target: "title", message: "This page has no title." }]);
    expect(ctrl.notesOf("p2")).toEqual([]);
    expect(ctrl.notesOf(undefined)).toEqual([]);
    expect(ctrl.notesOf("nowhere")).toEqual([]);
    expect(calls).toContain("p1:journey");
    // The draft is what the note is about: typing a title takes it away, clearing the id adds one.
    ctrl.select("p1");
    ctrl.setDraftProperty("p1", "title", "About you");
    ctrl.setDraftProperty("p1", "pageId", "");
    expect(ctrl.notesOf("p1")).toEqual([{ message: "No page id: the builder names it.", severity: "error" }]);
  });

  it("never counts a note as a problem: the Save and the prompt's Save both go through", () => {
    const ctrl = journeyController([page("p1", "about"), page("p2", "details")]);
    ctrl.setOptions({ notes: untitled });
    ctrl.select("p1");
    ctrl.setDraftProperty("p1", "pageId", "");
    expect(ctrl.notesOf("p1").length).toBeGreaterThan(0);
    expect(ctrl.problemsOf("p1")).toEqual([]);
    expect(ctrl.commitDraft("p1")).toBe(true);
    ctrl.select("p2");
    ctrl.setDraftProperty("p2", "pageId", "");
    expect(ctrl.requestSelect("p1")).toBe(false);
    ctrl.answerUnsavedChangesPrompt("save");
    expect(ctrl.selectedComponentId()).toBe("p1");
    expect(ctrl.getProperty("p2", "pageId")).toBe("");
  });
});

describe("folded sections and placeholders from the tree's owner", () => {
  it("folds the sections the owner names, and nothing without the hook", () => {
    const ctrl = journeyController([page("p1", "about")]);
    const sectionIds = ctrl.inspectorModel("p1")!.sections.map((section) => section.id);
    expect(sectionIds.length).toBeGreaterThan(0);
    expect(ctrl.inspectorModel("p1")!.sections.some((section) => section.folded)).toBe(false);
    const [folded] = sectionIds;
    ctrl.setOptions({ foldedSections: (node) => (node.type === "journey-page" ? [folded!, "not-a-section"] : undefined) });
    expect(ctrl.inspectorModel("p1")!.sections.map((section) => [section.id, section.folded === true])).toEqual(
      sectionIds.map((id) => [id, id === folded])
    );
    // The root names none: every section open.
    expect(ctrl.inspectorModel("journey")!.sections.some((section) => section.folded)).toBe(false);
  });

  it("puts the owner's ghost text in an empty box, and keeps the Data key's component id without it", () => {
    const ctrl = journeyController([page("p1", "")]);
    const placeholderOf = (componentId: string, propertyPath: string): string | undefined =>
      ctrl
        .inspectorModel(componentId)
        ?.sections.flatMap((section) => section.fields)
        .find((field) => field.propertyPath === propertyPath)?.placeholder;
    expect(placeholderOf("p1", "pageId")).toBeUndefined();
    ctrl.setOptions({ fieldPlaceholder: (node, field) => (node.type === "journey-page" && field.propertyPath === "pageId" ? node.id : undefined) });
    expect(placeholderOf("p1", "pageId")).toBe("p1");
    expect(placeholderOf("p1", "title")).toBeUndefined();

    const form = new BuilderController({
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "email", type: "text", configuration: { label: "Email" } }] } }
    });
    const dataKeyPlaceholder = (): string | undefined =>
      form
        .inspectorModel("email")
        ?.sections.flatMap((section) => section.fields)
        .find((field) => field.propertyPath === "dataKey")?.placeholder;
    expect(dataKeyPlaceholder()).toBe("email");
    form.setOptions({ fieldPlaceholder: () => undefined });
    expect(dataKeyPlaceholder()).toBe("email");
  });
});

describe("removeComponents takes several components away in one undo step", () => {
  const question = (id: string, componentId: string): ComponentNode => ({ id, type: "journey-field", configuration: { componentId } });
  const withQuestions = (): BuilderController =>
    journeyController([
      { ...page("p1", "about"), children: { content: [question("q1", "name"), question("q2", "gone")], routes: [] } },
      { ...page("p2", "details"), children: { content: [question("q3", "gone"), question("q4", "email")], routes: [] } }
    ]);
  const questionIds = (ctrl: BuilderController): string[] =>
    (ctrl.snapshot().children?.pages ?? []).flatMap((entry) => (entry.children?.content ?? []).map((node) => node.id));

  it("removes what is listed as one edit, passing over the root, unknown ids and what goes with a listed ancestor", () => {
    const ctrl = withQuestions();
    const reasons: string[] = [];
    ctrl.on("change", (event: BuilderChangeEvent) => reasons.push(event.reason));
    expect(ctrl.removeComponents(["q2", "journey", "nowhere", "q3"])).toEqual(["q2", "q3"]);
    expect(questionIds(ctrl)).toEqual(["q1", "q4"]);
    expect(reasons).toEqual(["remove"]);
    ctrl.undo();
    expect(questionIds(ctrl)).toEqual(["q1", "q2", "q3", "q4"]);
    ctrl.redo();
    expect(questionIds(ctrl)).toEqual(["q1", "q4"]);
    // A page and a question on it: the page takes the question along.
    expect(ctrl.removeComponents(["q1", "p1"])).toEqual(["p1"]);
    expect(questionIds(ctrl)).toEqual(["q4"]);
    // Nothing to remove is no edit.
    reasons.length = 0;
    expect(ctrl.removeComponents(["nowhere"])).toEqual([]);
    expect(reasons).toEqual([]);
  });

  it("drops the drafts and the selection of what went", () => {
    const ctrl = withQuestions();
    ctrl.select("q3");
    ctrl.setDraftProperty("q3", "componentId", "email");
    expect(ctrl.removeComponents(["p2"])).toEqual(["p2"]);
    expect(ctrl.selectedComponentId()).toBeUndefined();
    expect(ctrl.hasPendingChanges()).toBe(false);
    ctrl.undo();
    expect(ctrl.getProperty("q3", "componentId")).toBe("gone");
  });

  it("waits behind the unsaved-edits prompt, deciding what goes once it has been answered", () => {
    const ctrl = withQuestions();
    ctrl.select("q1");
    ctrl.setDraftProperty("q1", "componentId", "gone");
    const results: string[][] = [];
    const missing = (): string[] =>
      (ctrl.snapshot().children?.pages ?? []).flatMap((entry) =>
        (entry.children?.content ?? []).filter((node) => (node.configuration as { componentId?: string }).componentId === "gone").map((node) => node.id)
      );
    expect(ctrl.requestRemoveComponents(missing, { onResult: (ids) => results.push(ids) })).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toMatchObject({ componentId: "q1", action: "remove" });
    expect(results).toEqual([]);
    // Saved first, so the question the draft pointed at the missing component goes too.
    ctrl.answerUnsavedChangesPrompt("save");
    expect(results).toEqual([["q1", "q2", "q3"]]);
    expect(questionIds(ctrl)).toEqual(["q4"]);
  });
});

describe("ids the tree's owner reserves", () => {
  it("never hands a new node an id the owner still names, and hands it out again without the hook", () => {
    const ctrl = journeyController([page("journey-page_1", "first"), page("journey-page_2", "second")]);
    ctrl.remove("journey-page_2");
    ctrl.add("journey-page", "journey", "pages");
    // Without the hook the deleted page's node id is free again.
    expect((ctrl.snapshot().children?.pages ?? []).map((node) => node.id)).toEqual(["journey-page_1", "journey-page_2"]);

    const reserved = journeyController([page("journey-page_1", "first"), page("journey-page_2", "second")]);
    reserved.setOptions({ reservedIds: () => ["journey-page_2"] });
    reserved.remove("journey-page_2");
    reserved.add("journey-page", "journey", "pages");
    expect((reserved.snapshot().children?.pages ?? []).map((node) => node.id)).toEqual(["journey-page_1", "journey-page_3"]);
  });
});
