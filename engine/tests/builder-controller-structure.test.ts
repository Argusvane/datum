import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The selection's structural actions: where a component sits,
 * moving it (to a place, or one step within its slot), duplicating it, and adding after it —
 * each one undo entry, refused where a drop would be, and held behind the unsaved-draft prompt
 * when asked for through the `request*` path.
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
  leaf("checkbox"),
  // A PDF template's own field: edited, never moved, removed or copied.
  leaf("pdf-field", { fixed: true }),
  // The data-scoping container and a purely visual group.
  group("container", [{ id: "content", multiple: true }]),
  group("panel", [{ id: "content", multiple: true }]),
  group("section", [{ id: "content", multiple: true }]),
  // One text only.
  group("pair", [{ id: "body", multiple: false, allowedTypes: ["text"] }]),
  // Room for two.
  group("duo", [{ id: "items", multiple: true, max: 2 }])
];

const node = (id: string, type = "text", configuration: Record<string, unknown> = {}, extra: Partial<ComponentNode> = {}): ComponentNode => ({
  id,
  type,
  configuration: { label: id, ...configuration },
  ...extra
});

function controller(content: ComponentNode[]): BuilderController {
  return new BuilderController({
    initialRoot: { id: "root", type: "form", configuration: {}, children: { content } },
    componentDefinitions: DEFINITIONS
  });
}

const ids = (ctrl: BuilderController, parentId = "root", slotId = "content"): string[] => {
  const find = (n: ComponentNode): ComponentNode | undefined =>
    n.id === parentId ? n : Object.values(n.children ?? {}).flat().map(find).find(Boolean);
  return (find(ctrl.snapshot())?.children?.[slotId] ?? []).map((child) => child.id);
};

const findIn = (root: ComponentNode, id: string): ComponentNode | undefined =>
  root.id === id ? root : Object.values(root.children ?? {}).flat().map((child) => findIn(child, id)).find(Boolean);

function reasonsOf(ctrl: BuilderController): string[] {
  const reasons: string[] = [];
  ctrl.on("change", (event) => reasons.push(event.reason));
  return reasons;
}

describe("BuilderController.parentOf", () => {
  it("says where a component sits, and nothing for the root or an unknown id", () => {
    const ctrl = controller([node("a"), node("box", "panel", {}, { children: { content: [node("b"), node("c")] } })]);
    expect(ctrl.parentOf("a")).toEqual({ parentId: "root", slotId: "content", index: 0 });
    expect(ctrl.parentOf("c")).toEqual({ parentId: "box", slotId: "content", index: 1 });
    expect(ctrl.parentOf("root")).toBeUndefined();
    expect(ctrl.parentOf("nope")).toBeUndefined();
  });
});

describe("BuilderController.move", () => {
  it("takes the index as a gap among the slot's children before the move, and keeps the moved node selected", () => {
    const ctrl = controller([node("a"), node("b"), node("c")]);
    ctrl.select("c");
    const reasons = reasonsOf(ctrl);

    expect(ctrl.move("a", { parentId: "root", slotId: "content", index: 2 })).toBe(true);
    expect(ids(ctrl)).toEqual(["b", "a", "c"]);
    expect(ctrl.selectedComponentId()).toBe("a");
    expect(reasons).toEqual(["move"]);

    expect(ctrl.move("a", { parentId: "root", slotId: "content", index: 3 })).toBe(true);
    expect(ids(ctrl)).toEqual(["b", "c", "a"]);
    expect(ctrl.move("a", { parentId: "root", slotId: "content", index: 0 })).toBe(true);
    expect(ids(ctrl)).toEqual(["a", "b", "c"]);
  });

  it("moves into another container, as one undo entry that redoes", () => {
    const ctrl = controller([node("a"), node("box", "panel", {}, { children: { content: [node("b")] } })]);
    expect(ctrl.move("a", { parentId: "box", slotId: "content", index: 1 })).toBe(true);
    expect(ids(ctrl)).toEqual(["box"]);
    expect(ids(ctrl, "box")).toEqual(["b", "a"]);

    ctrl.undo();
    expect(ids(ctrl)).toEqual(["a", "box"]);
    expect(ids(ctrl, "box")).toEqual(["b"]);
    expect(ctrl.canUndo()).toBe(false);
    ctrl.redo();
    expect(ids(ctrl, "box")).toEqual(["b", "a"]);
  });

  it("refuses the root, a fixed node, unknown ids, an index out of range and its own place, changing nothing", () => {
    const ctrl = controller([node("a"), node("b"), node("f", "pdf-field")]);
    const to = (index: number, parentId = "root") => ({ parentId, slotId: "content", index });
    const reasons = reasonsOf(ctrl);

    expect(ctrl.move("root", to(0))).toBe(false);
    expect(ctrl.move("f", to(0))).toBe(false);
    expect(ctrl.move("nope", to(0))).toBe(false);
    expect(ctrl.move("a", to(0, "nope"))).toBe(false);
    expect(ctrl.move("a", to(-1))).toBe(false);
    expect(ctrl.move("a", to(4))).toBe(false);
    expect(ctrl.move("a", to(0))).toBe(false);
    expect(ctrl.move("a", to(1))).toBe(false);

    expect(ids(ctrl)).toEqual(["a", "b", "f"]);
    expect(ctrl.canUndo()).toBe(false);
    expect(reasons).toEqual([]);
  });

  it("refuses a slot whose constraints do not take the component, saying why", () => {
    const ctrl = controller([node("n", "number"), node("p", "pair", {}, { children: { body: [] } })]);
    expect(ctrl.move("n", { parentId: "p", slotId: "body", index: 0 })).toBe(false);
    expect(ctrl.dropError).toMatch(/not allowed/);
    expect(ids(ctrl)).toEqual(["n", "p"]);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("refuses a move into the component's own subtree", () => {
    const ctrl = controller([node("box", "panel", {}, { children: { content: [node("inner", "panel", {}, { children: { content: [] } })] } })]);
    expect(ctrl.move("box", { parentId: "inner", slotId: "content", index: 0 })).toBe(false);
    expect(ids(ctrl)).toEqual(["box"]);
  });

  it("refuses a move that would give two answers one place", () => {
    const ctrl = controller([node("email"), node("box", "container", {}, { children: { content: [node("other", "text", { dataKey: "email" })] } })]);
    // Inside the container, `other` stores at box.email; moved out, it would store at email.
    expect(ctrl.move("other", { parentId: "root", slotId: "content", index: 0 })).toBe(false);
    expect(ctrl.dropError).toMatch(/one place/);
    expect(ids(ctrl, "box")).toEqual(["other"]);
  });

  it("reorders within a slot that is full, which a move from elsewhere could not enter", () => {
    const ctrl = controller([node("x"), node("d", "duo", {}, { children: { items: [node("y"), node("z")] } })]);
    expect(ctrl.move("x", { parentId: "d", slotId: "items", index: 0 })).toBe(false);
    expect(ctrl.moveBy("y", 1)).toBe(true);
    expect(ids(ctrl, "d", "items")).toEqual(["z", "y"]);
  });

  it("gives a canvas drop the same convention: a gap among the children as they stand", () => {
    const ctrl = controller([node("a"), node("b"), node("c"), node("d")]);
    const store = new Map([["application/x-datum-builder-drag", JSON.stringify({ kind: "existing-component", componentId: "a" })]]);
    const transfer = { setData: (k: string, v: string) => store.set(k, v), getData: (k: string) => store.get(k) ?? "" };
    ctrl.applyDrop(transfer, "root", "content", 2);
    expect(ids(ctrl)).toEqual(["b", "a", "c", "d"]);
  });
});

describe("BuilderController.moveBy", () => {
  it("swaps with the neighbour above or below, one undo entry each", () => {
    const ctrl = controller([node("a"), node("b"), node("c")]);
    const reasons = reasonsOf(ctrl);

    expect(ctrl.moveBy("b", -1)).toBe(true);
    expect(ids(ctrl)).toEqual(["b", "a", "c"]);
    expect(ctrl.selectedComponentId()).toBe("b");
    expect(ctrl.moveBy("b", 1)).toBe(true);
    expect(ctrl.moveBy("b", 1)).toBe(true);
    expect(ids(ctrl)).toEqual(["a", "c", "b"]);
    expect(reasons).toEqual(["move", "move", "move"]);

    ctrl.undo();
    expect(ids(ctrl)).toEqual(["a", "b", "c"]);
    ctrl.redo();
    expect(ids(ctrl)).toEqual(["a", "c", "b"]);
  });

  it("refuses at the edges of the slot, for the root and for a fixed node", () => {
    const ctrl = controller([node("a"), node("f", "pdf-field"), node("c")]);
    expect(ctrl.moveBy("a", -1)).toBe(false);
    expect(ctrl.moveBy("c", 1)).toBe(false);
    expect(ctrl.moveBy("root", 1)).toBe(false);
    expect(ctrl.moveBy("f", 1)).toBe(false);
    expect(ctrl.moveBy("nope", 1)).toBe(false);
    expect(ids(ctrl)).toEqual(["a", "f", "c"]);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("stays within its own slot: the last child of a container does not move out", () => {
    const ctrl = controller([node("box", "panel", {}, { children: { content: [node("a"), node("b")] } }), node("after")]);
    expect(ctrl.moveBy("b", 1)).toBe(false);
    expect(ctrl.moveBy("a", -1)).toBe(false);
    expect(ids(ctrl, "box")).toEqual(["a", "b"]);
  });
});

describe("BuilderController.duplicate", () => {
  it("places a copy right after the original with a numbered id, selects it, and is one undo entry", () => {
    const ctrl = controller([
      node("name"),
      node("email", "text", { dataKey: "emailAddress" }, { rules: { visibleWhen: { kind: "path", path: "name" } } }),
      node("last")
    ]);
    const reasons = reasonsOf(ctrl);

    expect(ctrl.duplicate("email")).toBe("email_2");
    expect(ids(ctrl)).toEqual(["name", "email", "email_2", "last"]);
    expect(ctrl.selectedComponentId()).toBe("email_2");
    expect(reasons).toEqual(["add"]);

    const copy = findIn(ctrl.snapshot(), "email_2")!;
    // Its answer would land where the original's does: the key goes, and the new id is the place.
    expect(copy.configuration).toEqual({ label: "email" });
    expect(ctrl.dataPathOf("email_2")).toBe("email_2");
    // A rule reading a component outside the copy still reads it.
    expect(copy.rules).toEqual({ visibleWhen: { kind: "path", path: "name" } });
    expect(ctrl.dataKeyProblems()).toEqual([]);

    ctrl.undo();
    expect(ids(ctrl)).toEqual(["name", "email", "last"]);
    expect(ctrl.selectedComponentId()).toBeUndefined();
    ctrl.redo();
    expect(ids(ctrl)).toEqual(["name", "email", "email_2", "last"]);
  });

  it("numbers after the original's number and past ids already taken", () => {
    const ctrl = controller([node("text_3"), node("email"), node("email_2")]);
    expect(ctrl.duplicate("text_3")).toBe("text_4");
    expect(ctrl.duplicate("email")).toBe("email_3");
    expect(ctrl.duplicate("email_2")).toBe("email_4");
    expect(ids(ctrl)).toEqual(["text_3", "text_4", "email", "email_3", "email_2", "email_4"]);
  });

  it("copies a nested container: every id new, keys out of the shared scope, rules inside re-pointed", () => {
    const ctrl = controller([
      node("name"),
      node("contact", "panel", {}, {
        children: {
          content: [
            node("agree", "checkbox"),
            node("phone", "text", { dataKey: "tel" }, {
              rules: {
                visibleWhen: {
                  kind: "logical",
                  operator: "and",
                  left: { kind: "path", path: "agree" },
                  right: {
                    kind: "logical",
                    operator: "or",
                    left: { kind: "binary", operator: "eq", left: { kind: "path", path: "name" }, right: { kind: "literal", value: "x" } },
                    right: { kind: "path", path: "row.agree" }
                  }
                }
              }
            }),
            node("addr", "container", { dataKey: "address" }, {
              children: { content: [node("street", "text", { dataKey: "line1" }, { rules: { requiredWhen: { kind: "path", path: "addr.line1" } } })] }
            })
          ]
        }
      })
    ]);

    expect(ctrl.duplicate("contact")).toBe("contact_2");
    expect(ids(ctrl)).toEqual(["name", "contact", "contact_2"]);
    expect(ids(ctrl, "contact_2")).toEqual(["agree_2", "phone_2", "addr_2"]);
    expect(ids(ctrl, "addr_2")).toEqual(["street_2"]);

    const root = ctrl.snapshot();
    // The panel scopes nothing: its fields share the original's scope, so their keys go.
    expect(findIn(root, "phone_2")!.configuration).toEqual({ label: "phone" });
    expect(findIn(root, "addr_2")!.configuration).toEqual({ label: "addr" });
    // Below the copied data-scoping container the scope is new, so keys stay.
    expect(findIn(root, "street_2")!.configuration).toEqual({ label: "street", dataKey: "line1" });
    expect(ctrl.dataPathOf("street_2")).toBe("addr_2.line1");
    expect(ctrl.dataKeyProblems()).toEqual([]);

    // Inside the copy: re-pointed. Outside it, or read from a row: as written.
    expect(findIn(root, "phone_2")!.rules).toEqual({
      visibleWhen: {
        kind: "logical",
        operator: "and",
        left: { kind: "path", path: "agree_2" },
        right: {
          kind: "logical",
          operator: "or",
          left: { kind: "binary", operator: "eq", left: { kind: "path", path: "name" }, right: { kind: "literal", value: "x" } },
          right: { kind: "path", path: "row.agree" }
        }
      }
    });
    expect(findIn(root, "street_2")!.rules).toEqual({ requiredWhen: { kind: "path", path: "addr_2.line1" } });
    // The original is untouched.
    expect(findIn(root, "phone")!.configuration).toEqual({ label: "phone", dataKey: "tel" });
    expect(findIn(root, "phone")!.rules!.visibleWhen).toMatchObject({ left: { kind: "path", path: "agree" } });

    ctrl.undo();
    expect(ids(ctrl)).toEqual(["name", "contact"]);
  });

  it("gives a copied repeating section its own collection path and row fields", () => {
    const ctrl = controller([
      node("items", "section", {}, {
        collection: { collectionPath: "lineItems", itemFields: ["sku"] },
        children: { content: [node("sku", "text", { dataKey: "code" })] }
      })
    ]);
    expect(ctrl.duplicate("items")).toBe("items_2");
    const copy = findIn(ctrl.snapshot(), "items_2")!;
    expect(copy.collection).toEqual({ itemFields: ["sku_2"] });
    expect(findIn(copy, "sku_2")!.configuration).toEqual({ label: "sku", dataKey: "code" });
    expect(ctrl.dataPathOf("items_2")).toBe("items_2");
    expect(ctrl.dataKeyProblems()).toEqual([]);
  });

  it("refuses the root, a fixed node, a group holding one, an unknown id and a full slot", () => {
    const ctrl = controller([
      node("f", "pdf-field"),
      node("box", "panel", {}, { children: { content: [node("g", "pdf-field")] } }),
      node("p", "pair", {}, { children: { body: [node("only")] } })
    ]);
    const before = ctrl.snapshot();

    expect(ctrl.duplicate("root")).toBeUndefined();
    expect(ctrl.duplicate("f")).toBeUndefined();
    expect(ctrl.duplicate("box")).toBeUndefined();
    expect(ctrl.duplicate("nope")).toBeUndefined();
    expect(ctrl.duplicate("only")).toBeUndefined();
    expect(ctrl.dropError).toMatch(/multiple/);

    expect(ctrl.snapshot()).toEqual(before);
    expect(ctrl.canUndo()).toBe(false);
  });
});

describe("BuilderController.addAfter", () => {
  it("adds right after the given component in its slot, selected, as one undo entry", () => {
    const ctrl = controller([node("a"), node("b")]);
    const reasons = reasonsOf(ctrl);

    const id = ctrl.addAfter("number", "a");
    expect(id).toBe("number_1");
    expect(ids(ctrl)).toEqual(["a", "number_1", "b"]);
    expect(ctrl.selectedComponentId()).toBe("number_1");
    expect(reasons).toEqual(["add"]);

    ctrl.undo();
    expect(ids(ctrl)).toEqual(["a", "b"]);
    ctrl.redo();
    expect(ids(ctrl)).toEqual(["a", "number_1", "b"]);
  });

  it("adds inside a container after a child there, and takes an id and configuration", () => {
    const ctrl = controller([node("box", "panel", {}, { children: { content: [node("x"), node("y")] } })]);
    expect(ctrl.addAfter("text", "x", { id: "nickname", configuration: { label: "Nickname" } })).toBe("nickname");
    expect(ids(ctrl, "box")).toEqual(["x", "nickname", "y"]);
    expect(findIn(ctrl.snapshot(), "nickname")!.configuration).toEqual({ label: "Nickname" });
  });

  it("falls back to where add would put it: no id, the root, an unknown id, a slot that refuses or is full", () => {
    const ctrl = controller([
      node("a"),
      node("p", "pair", {}, { children: { body: [node("only")] } }),
      node("d", "duo", {}, { children: { items: [node("y"), node("z")] } })
    ]);
    expect(ctrl.addAfter("text")).toBe("text_1");
    expect(ctrl.addAfter("text", "root")).toBe("text_2");
    expect(ctrl.addAfter("text", "nope")).toBe("text_3");
    // The pair takes one text only; the duo has no room.
    expect(ctrl.addAfter("number", "only")).toBe("number_4");
    expect(ctrl.addAfter("text", "y")).toBe("text_5");
    expect(ids(ctrl)).toEqual(["a", "p", "d", "text_1", "text_2", "text_3", "number_4", "text_5"]);
    expect(ids(ctrl, "p", "body")).toEqual(["only"]);
    expect(ids(ctrl, "d", "items")).toEqual(["y", "z"]);
  });
});

describe("the structural requests and the unsaved-draft guard", () => {
  function withDraft() {
    const ctrl = controller([node("a"), node("b"), node("c")]);
    ctrl.select("a");
    ctrl.setDraftProperty("a", "label", "In progress");
    return ctrl;
  }

  it("runs at once when nothing is unsaved", () => {
    const ctrl = controller([node("a"), node("b")]);
    expect(ctrl.requestMoveBy("a", 1)).toBe(true);
    expect(ctrl.requestMove("a", { parentId: "root", slotId: "content", index: 0 })).toBe(true);
    expect(ctrl.requestDuplicate("a")).toBe(true);
    expect(ctrl.requestAddAfter("text", "a")).toBe(true);
    expect(ids(ctrl)).toEqual(["a", "text_1", "a_2", "b"]);
  });

  it("holds a move behind the prompt, and makes it once the draft is discarded", () => {
    const ctrl = withDraft();
    expect(ctrl.requestMove("c", { parentId: "root", slotId: "content", index: 0 })).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: "a", action: "drop" });
    expect(ids(ctrl)).toEqual(["a", "b", "c"]);
    ctrl.answerUnsavedChangesPrompt("discard");
    expect(ids(ctrl)).toEqual(["c", "a", "b"]);
    expect(ctrl.selectedComponentId()).toBe("c");
  });

  it("holds a one-step move, and makes it once the draft is saved", () => {
    const ctrl = withDraft();
    expect(ctrl.requestMoveBy("a", 1)).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: "a", action: "drop" });
    expect(ids(ctrl)).toEqual(["a", "b", "c"]);
    ctrl.answerUnsavedChangesPrompt("save");
    expect(ids(ctrl)).toEqual(["b", "a", "c"]);
    expect(findIn(ctrl.snapshot(), "a")!.configuration).toEqual({ label: "In progress" });
  });

  it("holds a duplicate, which copies the saved draft once it runs", () => {
    const ctrl = withDraft();
    expect(ctrl.requestDuplicate("a")).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: "a", action: "add" });
    expect(ids(ctrl)).toEqual(["a", "b", "c"]);
    ctrl.answerUnsavedChangesPrompt("save");
    expect(ids(ctrl)).toEqual(["a", "a_2", "b", "c"]);
    expect(findIn(ctrl.snapshot(), "a_2")!.configuration).toEqual({ label: "In progress" });
    expect(ctrl.selectedComponentId()).toBe("a_2");
  });

  it("holds an add-after, and drops it when the author stays", () => {
    const ctrl = withDraft();
    expect(ctrl.requestAddAfter("text", "a")).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: "a", action: "add" });
    ctrl.answerUnsavedChangesPrompt("stay");
    expect(ids(ctrl)).toEqual(["a", "b", "c"]);
    expect(ctrl.hasPendingChanges("a")).toBe(true);

    expect(ctrl.requestAddAfter("text", "a")).toBe(false);
    ctrl.answerUnsavedChangesPrompt("discard");
    expect(ids(ctrl)).toEqual(["a", "text_1", "b", "c"]);
  });
});

/**
 * A data grid in the controller: a container bound as a collection, whose rows are
 * filed at its collection path. The definition here is the standard one's shape, so the
 * controller's handling is tested without the packages/datum package.
 */
describe("a data grid", () => {
  const GRID: ComponentDefinition = {
    ...group("dataGrid", [{ id: "content", multiple: true, allowedTypes: ["text", "number"] }]),
    createDefault: () => ({
      id: "dataGrid",
      type: "dataGrid",
      configuration: { label: "Data grid" },
      collection: { collectionPath: "dataGrid" },
      children: { content: [] }
    })
  };
  const gridController = (content: ComponentNode[]): BuilderController =>
    new BuilderController({
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content } },
      componentDefinitions: [...DEFINITIONS, GRID]
    });

  it("gives a grid with no binding one at its id, and leaves a tree with no grid alone", () => {
    const ctrl = gridController([node("people", "dataGrid", {}, { children: { content: [node("name")] } })]);
    expect(findIn(ctrl.snapshot(), "people")!.collection).toEqual({ collectionPath: "people" });
    expect(ctrl.dataPathOf("name")).toBe("people[].name");
    const plain = gridController([node("a")]);
    expect(findIn(plain.snapshot(), "root")!.children).toEqual({ content: [expect.objectContaining({ id: "a" })] });
  });

  it("files a new grid's rows under its generated id, so two grids never share rows", () => {
    const ctrl = gridController([]);
    const first = ctrl.addAfter("dataGrid");
    const second = ctrl.addAfter("dataGrid", first);
    const named = ctrl.addAfter("dataGrid", second, { id: "dependants" });
    expect(first).toBe("dataGrid_1");
    expect(second).toBe("dataGrid_2");
    expect(findIn(ctrl.snapshot(), "dataGrid_1")!.collection).toEqual({ collectionPath: "dataGrid_1" });
    expect(findIn(ctrl.snapshot(), "dataGrid_2")!.collection).toEqual({ collectionPath: "dataGrid_2" });
    // An id the author names in the palette's dialog takes the path with it.
    expect(named).toBe("dependants");
    expect(findIn(ctrl.snapshot(), "dependants")!.collection).toEqual({ collectionPath: "dependants" });
    expect(ctrl.dataKeyProblems()).toEqual([]);
  });

  it("takes only the types its slot allows, and offers no Required of its own", () => {
    const ctrl = gridController([
      node("people", "dataGrid", {}, { collection: { collectionPath: "people" }, children: { content: [] } }),
      node("c", "checkbox"),
      node("t", "text")
    ]);
    expect(ctrl.move("c", { parentId: "people", slotId: "content", index: 0 })).toBe(false);
    expect(ctrl.dropError).toMatch(/not allowed/);
    expect(ctrl.move("t", { parentId: "people", slotId: "content", index: 0 })).toBe(true);
    expect(ids(ctrl, "people")).toEqual(["t"]);
    expect(ctrl.typeOffersRequired("dataGrid")).toBe(false);
    expect(ctrl.typeOffersRequired("text")).toBe(true);
  });

  it("follows a rename with the collection path that equals the old id, and leaves another path alone", () => {
    const ctrl = gridController([
      node("lines", "dataGrid", {}, { collection: { collectionPath: "lines" }, children: { content: [node("sku")] } }),
      node("rows", "dataGrid", {}, { collection: { collectionPath: "order.rows" }, children: { content: [node("qty", "number")] } })
    ]);
    ctrl.renameId("lines", "items");
    ctrl.renameId("rows", "entries");
    expect(findIn(ctrl.snapshot(), "items")!.collection).toEqual({ collectionPath: "items" });
    expect(findIn(ctrl.snapshot(), "entries")!.collection).toEqual({ collectionPath: "order.rows" });
    expect(ctrl.dataPathOf("sku")).toBe("items[].sku");
    expect(ctrl.dataKeyProblems()).toEqual([]);
  });

  it("binds an unbound grid at its id when it arrives through insertComponents, replaceComponent and replaceContent", () => {
    const unbound = (id: string): ComponentNode => node(id, "dataGrid", {}, { children: { content: [node(`${id}_qty`, "number")] } });
    const ctrl = gridController([node("a")]);
    expect(ctrl.insertComponents([{ node: unbound("lines") }]).ok).toBe(true);
    expect(findIn(ctrl.snapshot(), "lines")!.collection).toEqual({ collectionPath: "lines" });
    expect(ids(ctrl, "lines")).toEqual(["lines_qty"]);

    expect(ctrl.replaceComponent("lines", unbound("rows")).ok).toBe(true);
    expect(findIn(ctrl.snapshot(), "rows")!.collection).toEqual({ collectionPath: "rows" });
    expect(ids(ctrl, "rows")).toEqual(["rows_qty"]);

    expect(ctrl.replaceContent([unbound("grid_two")]).ok).toBe(true);
    expect(findIn(ctrl.snapshot(), "grid_two")!.collection).toEqual({ collectionPath: "grid_two" });
    expect(ids(ctrl, "grid_two")).toEqual(["grid_two_qty"]);
    expect(ctrl.dataPathOf("grid_two_qty")).toBe("grid_two[].grid_two_qty");
  });

  it("copies a grid with its rows at the copy's own id and its fields renumbered", () => {
    const ctrl = gridController([
      node("lines", "dataGrid", {}, { collection: { collectionPath: "lines" }, children: { content: [node("sku", "text", { dataKey: "code" })] } })
    ]);
    expect(ctrl.duplicate("lines")).toBe("lines_2");
    const copy = findIn(ctrl.snapshot(), "lines_2")!;
    // The path is dropped like a section's, so the copy reads "path else id".
    expect(copy.collection).toEqual({});
    expect(ctrl.dataPathOf("lines_2")).toBe("lines_2");
    expect(ctrl.dataPathOf("sku_2")).toBe("lines_2[].code");
    expect(ctrl.dataKeyProblems()).toEqual([]);
    ctrl.undo();
    expect(ids(ctrl)).toEqual(["lines"]);
  });
});
