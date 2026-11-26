import { describe, expect, it } from "vitest";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

const holder = (type: string): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: {}, children: { content: [] } }),
  capabilities: [],
  children: { slots: [{ id: "content", multiple: true }] }
});
const DEFS: ComponentDefinition[] = [
  holder("form"),
  holder("container"),
  holder("fieldset"),
  holder("dataGrid"),
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() }
];
const make = (content: ComponentNode[] = []) =>
  new BuilderController({ componentDefinitions: DEFS, initialRoot: { id: "root", type: "form", configuration: {}, children: { content } } });
const find = (node: ComponentNode | undefined, id: string): ComponentNode | undefined => {
  if (!node) {
    return undefined;
  }
  if (node.id === id) {
    return node;
  }
  for (const kids of Object.values(node.children ?? {})) {
    for (const kid of kids) {
      const found = find(kid, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
};
const grid = (id: string, path = id): ComponentNode => ({ id, type: "dataGrid", configuration: {}, collection: { collectionPath: path }, children: { content: [] } });
const section = (): ComponentNode => ({
  id: "rs",
  type: "container",
  configuration: {},
  collection: { collectionPath: "rs", itemFields: ["f"] },
  children: { content: [{ id: "f", type: "text", configuration: {} }] }
});

describe("a rename reaches the history's own copies", () => {
  it("add a grid, rename it, undo then redo: the collection path stays with the id", () => {
    const c = make();
    expect(c.replaceContent([grid("lines")]).ok).toBe(true);
    c.renameId("lines", "orders");
    expect(find(c.snapshot(), "orders")?.collection?.collectionPath).toBe("orders");
    c.undo();
    expect(find(c.snapshot(), "orders")).toBeUndefined();
    c.redo();
    expect(find(c.snapshot(), "orders")?.collection?.collectionPath).toBe("orders");
    expect(c.dataPathOf("orders")).toBe("orders");
  });
  it("two renames in a row", () => {
    const c = make();
    c.replaceContent([grid("lines")]);
    c.renameId("lines", "a");
    c.renameId("a", "b");
    c.undo();
    c.redo();
    expect(find(c.snapshot(), "b")?.collection?.collectionPath).toBe("b");
  });
  it("a grid nested in a fieldset, put in by replaceContent", () => {
    const c = make();
    c.replaceContent([{ id: "fs", type: "fieldset", configuration: {}, children: { content: [grid("lines")] } }]);
    c.renameId("lines", "orders");
    c.undo();
    c.redo();
    expect(find(c.snapshot(), "orders")?.collection?.collectionPath).toBe("orders");
  });
  it("a path of the author's own stays", () => {
    const c = make();
    c.replaceContent([grid("lines", "order.lines")]);
    c.renameId("lines", "orders");
    c.undo();
    c.redo();
    expect(find(c.snapshot(), "orders")?.collection?.collectionPath).toBe("order.lines");
  });
  it("a row field renamed: the section's itemFields follow in the add's copy too", () => {
    const c = make();
    expect(c.replaceContent([section()]).ok).toBe(true);
    c.renameId("f", "g");
    expect(find(c.snapshot(), "rs")?.collection?.itemFields).toEqual(["g"]);
    c.undo();
    c.redo();
    expect(find(c.snapshot(), "rs")?.collection?.itemFields).toEqual(["g"]);
    expect(find(c.snapshot(), "g")).toBeDefined();
  });
  it("a node that held the same id at another time keeps its itemFields", () => {
    const c = make([section()]);
    c.renameId("f", "g");
    expect(find(c.snapshot(), "rs")?.collection?.itemFields).toEqual(["g"]);
    c.setProperty("rs", "label", "x");
    c.undo();
    c.redo();
    expect(find(c.snapshot(), "rs")?.collection?.itemFields).toEqual(["g"]);
  });
});
