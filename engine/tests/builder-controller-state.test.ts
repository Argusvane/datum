import { describe, expect, it } from "vitest";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { BUILDER_DRAG_MIME_TYPE } from "../form-engine/builder/drag-drop/html5-drag-drop.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";

const DEFS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() },
  { type: "widget", version: "1.0.0", fixed: true, createDefault: () => ({ id: "widget", type: "widget", configuration: {} }), capabilities: [] } as ComponentDefinition
];
const field = (id: string): ComponentNode => ({ id, type: "text", configuration: { label: id } });
const root = (...content: ComponentNode[]): ComponentNode => ({ id: "root", type: "form", configuration: {}, children: { content } });
const make = (...content: ComponentNode[]) => new BuilderController({ initialRoot: root(...content), componentDefinitions: DEFS });
const ids = (node: ComponentNode | undefined): string[] => (node ? [node.id, ...Object.values(node.children ?? {}).flat().flatMap(ids)] : []);
const drag = (payload: unknown) => {
  const store = new Map<string, string>([[BUILDER_DRAG_MIME_TYPE, JSON.stringify(payload)]]);
  return { setData: () => undefined, getData: (type: string) => store.get(type) ?? "" } as never;
};

describe("select", () => {
  it("an id the tree does not hold selects nothing and does not throw", () => {
    const c = make(field("a"));
    c.select("a");
    expect(() => c.select("ghost")).not.toThrow();
    expect(c.selectedComponentId()).toBeUndefined();
    expect(c.requestSelect("ghost")).toBe(true);
    c.select("a");
    expect(c.selectedComponentId()).toBe("a");
  });
});

describe("renameId of a component that is not selected", () => {
  it("keeps the selection and its unsaved draft", () => {
    const c = make(field("a"), field("b"));
    c.select("a");
    c.setDraftProperty("a", "label", "typed");
    c.renameId("b", "b2");
    expect(c.selectedComponentId()).toBe("a");
    expect(c.hasPendingChanges("a")).toBe(true);
    expect(c.draftProperty("a", "label")).toBe("typed");
    expect(ids(c.snapshot())).toEqual(["root", "a", "b2"]);
  });
  it("moves the selection with the component that was selected", () => {
    const c = make(field("a"));
    c.select("a");
    c.renameId("a", "z");
    expect(c.selectedComponentId()).toBe("z");
  });
});

describe("a drop payload", () => {
  it("cannot move a fixed node, the root or an id the tree lacks", () => {
    const c = make(field("a"), field("b"), { id: "w1", type: "widget", configuration: {} });
    expect(c.move("w1", { parentId: "root", slotId: "content", index: 0 })).toBe(false);
    c.applyDrop(drag({ kind: "existing-component", componentId: "w1" }), "root", "content", 0);
    c.applyDrop(drag({ kind: "existing-component", componentId: "root" }), "root", "content", 0);
    c.applyDrop(drag({ kind: "existing-component", componentId: "ghost" }), "root", "content", 0);
    expect(ids(c.snapshot())).toEqual(["root", "a", "b", "w1"]);
    expect(c.canUndo()).toBe(false);
  });
  it("still moves an ordinary component", () => {
    const c = make(field("a"), field("b"));
    c.applyDrop(drag({ kind: "existing-component", componentId: "b" }), "root", "content", 0);
    expect(ids(c.snapshot())).toEqual(["root", "b", "a"]);
  });
});

describe("a refused insert", () => {
  it("leaves no empty slot behind", () => {
    const tree = new ComponentTree({ id: "root", type: "form", configuration: {}, children: { content: [] } });
    expect(() => tree.insert(field("x"), "root", "extra", 3)).toThrow(/Invalid insert index 3/);
    expect(Object.keys(tree.find("root")?.children ?? {})).toEqual(["content"]);
    tree.insert(field("y"), "root", "extra", 0);
    expect(tree.find("root")?.children?.extra?.map((n) => n.id)).toEqual(["y"]);
  });
});

describe("loading another form", () => {
  it("clears what the last form refused or flagged", () => {
    const c = make(field("a"), field("b"));
    c.select("a");
    c.setDraftId("a", "b");
    c.commitDraft("a");
    expect(c.idError).toBeDefined();
    c.add("text", "a", "content");
    expect(c.dropError).toBeDefined();
    c.setOptions({ initialRoot: root(field("z")) });
    expect(c.idError).toBeUndefined();
    expect(c.dropError).toBeUndefined();
    expect(c.cssClassError).toBeUndefined();
    expect(c.dataKeyError).toBeUndefined();
    expect(c.renameNotes()).toEqual([]);
  });
});
