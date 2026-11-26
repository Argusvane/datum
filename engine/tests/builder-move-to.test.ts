import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { moveRefusal } from "../form-engine/builder/drag-drop/move-legality.js";
import { createJourneyDesigner } from "../form-engine/builder/journey-designer/journey-designer.js";
import {
  JOURNEY_CONTENT_SLOT,
  JOURNEY_PAGES_SLOT,
  JOURNEY_ROOT_ID,
  JOURNEY_ROUTES_SLOT
} from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { createParentConstraintsResolverFromRegistry } from "../form-engine/builder/tree-editor/slot-constraints.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";

/**
 * Moving a component to another page or container: where it may go
 * (`moveTargets`, by the rules a drop meets), `moveTo` by final position, one undo entry, the
 * component unchanged but for its place, a journey page named by its `pageId`.
 */

const leaf = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: { label: `${type} field` } }),
  capabilities: [],
  ...extra
});

const group = (type: string, slots: NonNullable<ComponentDefinition["children"]>["slots"]): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: {}, children: Object.fromEntries(slots.map((slot) => [slot.id, []])) }),
  capabilities: [],
  children: { slots }
});

const DEFINITIONS: ComponentDefinition[] = [
  group("form", [{ id: "content", multiple: true }]),
  leaf("text"),
  leaf("number"),
  leaf("pdf-field", { fixed: true }),
  group("container", [{ id: "content", multiple: true }]),
  group("panel", [{ id: "content", multiple: true }]),
  group("steps", [{ id: "content", multiple: true, allowedTypes: ["step"] }]),
  group("step", [{ id: "content", multiple: true }]),
  group("tabs", []),
  group("pair", [{ id: "body", multiple: false, allowedTypes: ["text"] }]),
  group("duo", [{ id: "items", multiple: true, max: 2 }])
];

const node = (id: string, type = "text", configuration: Record<string, unknown> = {}, extra: Partial<ComponentNode> = {}): ComponentNode => ({
  id,
  type,
  configuration: { label: id, ...configuration },
  ...extra
});

const rootOf = (content: ComponentNode[]): ComponentNode => ({ id: "root", type: "form", configuration: {}, children: { content } });

function controller(content: ComponentNode[]): BuilderController {
  return new BuilderController({ initialRoot: rootOf(content), componentDefinitions: DEFINITIONS });
}

const findIn = (root: ComponentNode, id: string): ComponentNode | undefined =>
  root.id === id ? root : Object.values(root.children ?? {}).flat().map((child) => findIn(child, id)).find(Boolean);

const ids = (ctrl: BuilderController, parentId = "root", slotId = "content"): string[] =>
  (findIn(ctrl.snapshot(), parentId)?.children?.[slotId] ?? []).map((child) => child.id);

const places = (ctrl: BuilderController, id: string): string[] => ctrl.moveTargets(id).map((target) => `${target.parentId}.${target.slotId}`);

/** A form with a bit of everything: groups, a steps container, a tab set, a one-text slot, a full slot. */
function sample(): ComponentNode[] {
  return [
    node("a"),
    node("n", "number"),
    node("box", "panel", {}, { children: { content: [node("inner", "panel", {}, { children: { content: [node("deep")] } })] } }),
    node("wizard", "steps", {}, { children: { content: [node("s1", "step", {}, { children: { content: [node("q1")] } }), node("s2", "step", {}, { children: { content: [] } })] } }),
    node("tabbed", "tabs", { tabs: [{ id: "first", label: "First tab" }, { id: "second", label: "Second tab" }] }, { children: { first: [], second: [] } }),
    node("p", "pair", {}, { children: { body: [] } }),
    node("d", "duo", {}, { children: { items: [node("x"), node("y")] } }),
    node("f", "pdf-field")
  ];
}

describe("BuilderController.moveTargets (legality)", () => {
  it("lists every slot that takes the component, its own first in reading order, with what is there", () => {
    const ctrl = controller(sample());
    expect(places(ctrl, "a")).toEqual(["root.content", "box.content", "inner.content", "s1.content", "s2.content", "tabbed.first", "tabbed.second", "p.body"]);
    const own = ctrl.moveTargets("a")[0]!;
    expect(own).toMatchObject({ parentId: "root", slotId: "content", depth: 0, current: 0 });
    expect(own.siblings.map((sibling) => sibling.id)).toEqual(["n", "box", "wizard", "tabbed", "p", "d", "f"]);
    const step = ctrl.moveTargets("a").find((target) => target.parentId === "s1")!;
    expect(step).toMatchObject({ label: "s1", depth: 2, siblings: [{ id: "q1", label: "q1" }] });
    expect(step.current).toBeUndefined();
    // A container with more than one slot names the slot: a tab by its label.
    expect(ctrl.moveTargets("a").filter((target) => target.parentId === "tabbed").map((target) => target.slotLabel)).toEqual(["First tab", "Second tab"]);
    expect(own.slotLabel).toBeUndefined();
  });

  it("refuses the root, a fixed node and an unknown id", () => {
    const ctrl = controller(sample());
    expect(ctrl.moveTargets("root")).toEqual([]);
    expect(ctrl.moveTargets("f")).toEqual([]);
    expect(ctrl.moveTargets("nope")).toEqual([]);
  });

  it("never offers the component itself or anything inside it", () => {
    const ctrl = controller(sample());
    expect(places(ctrl, "box")).not.toContain("box.content");
    expect(places(ctrl, "box")).not.toContain("inner.content");
    expect(places(ctrl, "box")).toContain("root.content");
    expect(places(ctrl, "box")).toContain("s2.content");
  });

  it("follows the slots' types, single child and room: a number is no text, a full slot takes no newcomer", () => {
    const ctrl = controller(sample());
    // `pair.body` takes texts only; `duo.items` holds two already.
    expect(places(ctrl, "n")).not.toContain("p.body");
    expect(places(ctrl, "a")).not.toContain("d.items");
    // A step goes only where steps go, and anywhere that takes anything.
    expect(places(ctrl, "s2")).toContain("wizard.content");
    expect(places(ctrl, "a")).not.toContain("wizard.content");
    // A reorder inside a full slot is still a place.
    expect(places(ctrl, "x")).toContain("d.items");
    // A one-child slot already holding one takes no other.
    ctrl.moveTo("a", "p", 0);
    expect(places(ctrl, "deep")).not.toContain("p.body");
  });

  it("leaves out a slot where the answer would share a place with another", () => {
    const ctrl = controller([node("email"), node("box", "container", {}, { children: { content: [node("other", "text", { dataKey: "email" })] } }), node("group", "panel", {}, { children: { content: [] } })]);
    // In `box`, `other` stores at box.email; at the top or in a visual group, at email.
    expect(places(ctrl, "other")).toEqual(["box.content"]);
  });

  it("agrees with the drop: every slot it lists lands, every slot it leaves out is refused", () => {
    const tree = sample();
    const listed = new Set(places(controller(tree), "a"));
    const ctrl0 = controller(tree);
    const slots: Array<[string, string]> = [];
    const walk = (n: ComponentNode): void => {
      for (const [slotId, children] of Object.entries(n.children ?? {})) {
        slots.push([n.id, slotId]);
        children.forEach(walk);
      }
    };
    walk(ctrl0.snapshot());
    for (const [parentId, slotId] of slots) {
      const ctrl = controller(tree);
      const landed = ctrl.move("a", { parentId, slotId, index: 0 }) || ids(ctrl, parentId, slotId)[0] === "a";
      expect([`${parentId}.${slotId}`, landed]).toEqual([`${parentId}.${slotId}`, listed.has(`${parentId}.${slotId}`)]);
    }
  });

  it("shares its rules with the drop's module (moveRefusal)", () => {
    const registry = new ComponentRegistry();
    for (const definition of DEFINITIONS) {
      registry.register(definition);
    }
    const resolve = createParentConstraintsResolverFromRegistry(registry);
    const root = rootOf(sample());
    expect(moveRefusal(root, "root", "box", "content", resolve)?.code).toBe("root");
    expect(moveRefusal(root, "nope", "box", "content", resolve)?.code).toBe("missing");
    expect(moveRefusal(root, "box", "inner", "content", resolve)?.code).toBe("inside-itself");
    expect(moveRefusal(root, "box", "box", "content", resolve)?.code).toBe("inside-itself");
    expect(moveRefusal(root, "n", "p", "body", resolve)?.code).toBe("slot");
    expect(moveRefusal(root, "a", "d", "items", resolve)?.code).toBe("slot");
    expect(moveRefusal(root, "x", "d", "items", resolve)).toBeUndefined();
    expect(moveRefusal(root, "a", "a", "content", resolve)?.code).toBe("inside-itself");
    expect(moveRefusal(root, "a", "n", "content", resolve)?.code).toBe("slot");
    expect(moveRefusal(root, "a", "s2", "content", resolve)).toBeUndefined();
  });
});

describe("BuilderController.moveTo", () => {
  it("moves into another container by final position, keeping id, configuration, rules and data key, as one undo entry", () => {
    const rules = { visibleWhen: { kind: "binary", operator: "eq", left: { kind: "path", path: "a" }, right: { kind: "literal", value: "yes" } } };
    const ctrl = controller([
      node("a"),
      node("moving", "text", { label: "Moving", dataKey: "keyed", hint: "kept" }, { rules: rules as NonNullable<ComponentNode["rules"]> }),
      node("box", "panel", {}, { children: { content: [node("b"), node("c")] } })
    ]);
    const before = structuredClone(findIn(ctrl.snapshot(), "moving"));
    const reasons: string[] = [];
    ctrl.on("change", (event) => reasons.push(event.reason));

    expect(ctrl.moveTo("moving", "box", 1)).toBe(true);
    expect(ids(ctrl)).toEqual(["a", "box"]);
    expect(ids(ctrl, "box")).toEqual(["b", "moving", "c"]);
    expect(findIn(ctrl.snapshot(), "moving")).toEqual(before);
    expect(ctrl.selectedComponentId()).toBe("moving");
    expect(reasons).toEqual(["move"]);

    ctrl.undo();
    expect(ids(ctrl)).toEqual(["a", "moving", "box"]);
    expect(ids(ctrl, "box")).toEqual(["b", "c"]);
    expect(ctrl.canUndo()).toBe(false);
    ctrl.redo();
    expect(ids(ctrl, "box")).toEqual(["b", "moving", "c"]);
  });

  it("reads positions as where the component ends, within its own slot too", () => {
    const ctrl = controller([node("a"), node("b"), node("c"), node("d")]);
    expect(ctrl.moveTo("a", "root", 2)).toBe(true);
    expect(ids(ctrl)).toEqual(["b", "c", "a", "d"]);
    expect(ctrl.moveTo("a", "root", 3)).toBe(true);
    expect(ids(ctrl)).toEqual(["b", "c", "d", "a"]);
    expect(ctrl.moveTo("a", "root", 0)).toBe(true);
    expect(ids(ctrl)).toEqual(["a", "b", "c", "d"]);
    expect(ctrl.moveTo("c", "root", 1)).toBe(true);
    expect(ids(ctrl)).toEqual(["a", "c", "b", "d"]);
  });

  it("refuses an illegal place, a bad position and its own place, changing nothing", () => {
    const ctrl = controller(sample());
    const reasons: string[] = [];
    ctrl.on("change", (event) => reasons.push(event.reason));
    expect(ctrl.moveTo("box", "inner", 0)).toBe(false);
    expect(ctrl.moveTo("n", "p", 0)).toBe(false);
    expect(ctrl.moveTo("a", "d", 0)).toBe(false);
    expect(ctrl.moveTo("f", "box", 0)).toBe(false);
    expect(ctrl.moveTo("root", "box", 0)).toBe(false);
    expect(ctrl.moveTo("a", "nope", 0)).toBe(false);
    expect(ctrl.moveTo("a", "box", 2)).toBe(false);
    expect(ctrl.moveTo("a", "box", -1)).toBe(false);
    expect(ctrl.moveTo("a", "box", 0.5)).toBe(false);
    expect(ctrl.moveTo("a", "root", 0)).toBe(false);
    expect(ctrl.moveTo("a", "tabbed", 0, "third")).toBe(false);
    expect(ctrl.canUndo()).toBe(false);
    expect(reasons).toEqual([]);
  });

  it("picks the slot asked for, else the container's first that takes it", () => {
    const ctrl = controller(sample());
    expect(ctrl.moveTo("a", "tabbed", 0, "second")).toBe(true);
    expect(ids(ctrl, "tabbed", "second")).toEqual(["a"]);
    expect(ctrl.moveTo("n", "tabbed", 0)).toBe(true);
    expect(ids(ctrl, "tabbed", "first")).toEqual(["n"]);
  });

  it("asks about the selection's unsaved edits first through requestMoveTo", () => {
    const ctrl = controller([node("a"), node("box", "panel", {}, { children: { content: [] } })]);
    ctrl.select("a");
    ctrl.setDraftProperty("a", "label", "Edited");
    expect(ctrl.requestMoveTo("a", "box", 0)).toBe(false);
    expect(ctrl.unsavedChangesPrompt()?.action).toBe("drop");
    expect(ids(ctrl, "box")).toEqual([]);
    ctrl.answerUnsavedChangesPrompt("save");
    expect(ids(ctrl, "box")).toEqual(["a"]);
    expect(findIn(ctrl.snapshot(), "a")?.configuration).toMatchObject({ label: "Edited" });
  });
});

describe("moving questions between journey pages", () => {
  const form: ComponentNode = rootOf([node("fullName"), node("email"), node("phone"), node("consent")]);
  const journey: Journey = {
    id: "intake",
    name: "Intake",
    pages: [
      { id: "about", title: "About you", components: ["fullName", "email"], routes: [{ to: "contact" }] },
      { id: "contact", title: "How to reach you", components: ["phone"], routes: [{ to: "$end" }] },
      { id: "finish", title: "Finish", components: ["consent"] }
    ]
  };

  function journeyController(): { controller: BuilderController; fromTree: () => Journey } {
    const designer = createJourneyDesigner({ formRoot: () => form, locale: () => "en" });
    const pageIds = new Map<string, string>();
    const tree = designer.treeFromJourney(journey, { pageIds });
    const ctrl = new BuilderController({ componentTypes: [], initialRoot: tree });
    const design = designer.entry({ journeyId: () => journey.id, tree: () => ctrl.previewSnapshot(), pageIds });
    ctrl.setOptions({ ...design.builderOptions, initialRoot: tree, locale: "en" });
    return { controller: ctrl, fromTree: () => designer.journeyFromTree(ctrl.snapshot(), journey.id, { pageIds })! };
  }

  const pages = (ctrl: BuilderController): ComponentNode[] => ctrl.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? [];
  const questionNode = (ctrl: BuilderController, pageIndex: number, index: number): ComponentNode => pages(ctrl)[pageIndex]!.children![JOURNEY_CONTENT_SLOT]![index]!;

  it("offers a question every page's questions, by the outline's page name and page id, and no route or pages slot", () => {
    const { controller: ctrl } = journeyController();
    const question = questionNode(ctrl, 0, 1);
    const targets = ctrl.moveTargets(question.id);
    expect(targets.map((target) => [target.label, target.pageId, target.slotId])).toEqual([
      ["Step 1 · About you", "about", JOURNEY_CONTENT_SLOT],
      ["Step 2 · How to reach you", "contact", JOURNEY_CONTENT_SLOT],
      ["Step 3 · Finish", "finish", JOURNEY_CONTENT_SLOT]
    ]);
    expect(targets[0]!.current).toBe(1);
    // A route goes between pages' routes, a page within the journey's pages.
    const route = pages(ctrl)[0]!.children![JOURNEY_ROUTES_SLOT]![0]!;
    expect(ctrl.moveTargets(route.id).map((target) => target.slotId)).toEqual([JOURNEY_ROUTES_SLOT, JOURNEY_ROUTES_SLOT, JOURNEY_ROUTES_SLOT]);
    expect(ctrl.moveTargets(pages(ctrl)[1]!.id).map((target) => `${target.parentId}.${target.slotId}`)).toEqual([`${JOURNEY_ROOT_ID}.${JOURNEY_PAGES_SLOT}`]);
  });

  it("moves a question to another page named by its page id: node ids stable, only the parent changes, one undo", () => {
    const { controller: ctrl, fromTree } = journeyController();
    const pageNodeIds = pages(ctrl).map((page) => page.id);
    const question = questionNode(ctrl, 0, 1);
    expect(ctrl.moveTo(question.id, "contact", 1)).toBe(true);
    expect(pages(ctrl).map((page) => page.id)).toEqual(pageNodeIds);
    expect(questionNode(ctrl, 1, 1)).toEqual(question);
    expect(fromTree().pages.map((page) => [page.id, page.components])).toEqual([
      ["about", ["fullName"]],
      ["contact", ["phone", "email"]],
      ["finish", ["consent"]]
    ]);
    // Routes still name the same page nodes.
    expect(fromTree().pages[0]!.routes).toEqual([{ to: "contact" }]);
    ctrl.undo();
    expect(fromTree().pages[0]!.components).toEqual(["fullName", "email"]);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("names a page the move left with no question by its page id, its routes aside (moveToResult)", () => {
    const { controller: ctrl, fromTree } = journeyController();
    const phone = questionNode(ctrl, 1, 0);
    expect(ctrl.moveToResult(phone.id, "about", 0)).toEqual({ moved: true, leftEmpty: ["contact"] });
    expect(fromTree().pages[1]!.components ?? []).toEqual([]);
    expect(fromTree().pages[1]!.routes).toEqual([{ to: "$end" }]);
    // A page that keeps a question is not named.
    const email = questionNode(ctrl, 0, 2);
    expect(ctrl.moveToResult(email.id, "finish", 0)).toEqual({ moved: true, leftEmpty: [] });
  });
});

describe("what a move leaves empty (moveToResult, requestMoveTo)", () => {
  it("names a container the move emptied, and only that", () => {
    const ctrl = controller([node("a"), node("box", "panel", {}, { children: { content: [node("only")] } }), node("pair2", "panel", {}, { children: { content: [node("p"), node("q")] } })]);
    expect(ctrl.moveToResult("p", "root", 0)).toEqual({ moved: true, leftEmpty: [] });
    expect(ctrl.moveToResult("only", "root", 0)).toEqual({ moved: true, leftEmpty: ["box"] });
    // Out of the root, or within one container: nothing named.
    expect(ctrl.moveToResult("a", "box", 0)).toEqual({ moved: true, leftEmpty: [] });
    expect(ctrl.moveToResult("a", "box", 0)).toEqual({ moved: false, leftEmpty: [] });
    // moveTo keeps its boolean.
    expect(ctrl.moveTo("q", "box", 1)).toBe(true);
  });

  it("hands the result to requestMoveTo's callback, held behind the unsaved-edits prompt too", () => {
    const ctrl = controller([node("a"), node("box", "panel", {}, { children: { content: [node("only")] } })]);
    ctrl.select("a");
    ctrl.setDraftProperty("a", "label", "Edited");
    const heard: unknown[] = [];
    expect(ctrl.requestMoveTo("only", "root", 2, undefined, (moved, result) => heard.push([moved, result]))).toBe(false);
    ctrl.answerUnsavedChangesPrompt("save");
    expect(heard).toEqual([[true, { moved: true, leftEmpty: ["box"] }]]);
  });
});
