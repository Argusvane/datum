import { describe, expect, it } from "vitest";

import {
  AddComponentCommand,
  CompositeCommand,
  MoveComponentCommand,
  RemoveComponentCommand,
  RegistryBackedTreeEditor,
  ReplaceChildrenCommand,
  SetPropertyCommand,
  TreeEditor
} from "../form-engine/builder/tree-editor/tree-editor.js";
import { canAcceptInSlot, type ParentConstraintsResolver } from "../form-engine/builder/tree-editor/slot-constraints.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";
import type { ComponentNode, ComponentRules } from "../form-engine/core/schema/types.js";

describe("tree editor commands", () => {
  function editor(): TreeEditor {
    return new TreeEditor({
      id: "root",
      type: "container",
      configuration: {},
      children: {
        children: [
          { id: "firstName", type: "text", configuration: {} },
          { id: "lastName", type: "text", configuration: {} }
        ]
      }
    });
  }

  it("supports add and undo/redo", () => {
    const e = editor();

    e.execute(
      new AddComponentCommand(
        e.componentTree(),
        { id: "email", type: "text", configuration: {} },
        "root",
        "children"
      )
    );
    expect(e.componentTree().find("email")).toBeDefined();

    e.undo();
    expect(e.componentTree().find("email")).toBeUndefined();

    e.redo();
    expect(e.componentTree().find("email")).toBeDefined();
  });

  it("supports remove and undo", () => {
    const e = editor();

    e.execute(new RemoveComponentCommand(e.componentTree(), "lastName"));
    expect(e.componentTree().find("lastName")).toBeUndefined();

    e.undo();
    expect(e.componentTree().find("lastName")).toBeDefined();
  });

  it("supports move and undo", () => {
    const e = editor();

    e.execute(
      new AddComponentCommand(
        e.componentTree(),
        { id: "sectionA", type: "section", configuration: {}, children: { content: [] } },
        "root",
        "children"
      )
    );

    e.execute(new MoveComponentCommand(e.componentTree(), "firstName", "sectionA", "content", 0));
    expect(e.componentTree().parentOf("firstName")?.id).toBe("sectionA");

    e.undo();
    expect(e.componentTree().parentOf("firstName")?.id).toBe("root");
  });

  it("supports set-property and undo", () => {
    const e = editor();

    e.execute(new SetPropertyCommand(e.componentTree(), "firstName", "label.default", "First name"));
    expect(e.componentTree().getConfigurationValue("firstName", "label.default")).toBe("First name");

    e.undo();
    expect(e.componentTree().getConfigurationValue("firstName", "label.default")).toBeUndefined();
  });

  it("replaces a node's whole children map and restores it on undo", () => {
    const e = editor();
    const tree = e.componentTree();
    const [first, last] = tree.childrenOf("root", "children");

    e.execute(
      new ReplaceChildrenCommand(tree, "root", { left: [first!], right: [last!] })
    );
    expect(Object.keys(tree.getChildren("root") ?? {})).toEqual(["left", "right"]);
    expect(tree.locate("lastName")?.slotId).toBe("right");

    e.undo();
    expect(Object.keys(tree.getChildren("root") ?? {})).toEqual(["children"]);
    expect(tree.locate("lastName")?.slotId).toBe("children");
  });

  it("runs a composite as one history entry, undone in reverse and rolled back on failure", () => {
    const e = editor();
    const tree = e.componentTree();

    e.execute(
      new CompositeCommand("SET_PROPERTY", [
        new SetPropertyCommand(tree, "firstName", "label", "First"),
        new SetPropertyCommand(tree, "lastName", "label", "Last")
      ])
    );
    expect(tree.getConfigurationValue("firstName", "label")).toBe("First");
    expect(tree.getConfigurationValue("lastName", "label")).toBe("Last");

    // One undo takes both back.
    e.undo();
    expect(tree.getConfigurationValue("firstName", "label")).toBeUndefined();
    expect(tree.getConfigurationValue("lastName", "label")).toBeUndefined();
    expect(e.canUndo()).toBe(false);

    // A member that throws leaves nothing half-applied: the earlier member is undone first.
    const failing = new CompositeCommand("ADD_COMPONENT", [
      new SetPropertyCommand(tree, "firstName", "label", "First"),
      new AddComponentCommand(tree, { id: "firstName", type: "text", configuration: {} }, "root", "children")
    ]);
    expect(() => e.execute(failing)).toThrow(/Duplicate component id/);
    expect(tree.getConfigurationValue("firstName", "label")).toBeUndefined();
  });

  it("undoes a composite all or nothing, and a step it cannot undo takes the steps before it along", () => {
    const e = editor();
    e.execute(new SetPropertyCommand(e.componentTree(), "firstName", "label", "First"));
    e.execute(
      new CompositeCommand("ADD_COMPONENT", [
        new AddComponentCommand(e.componentTree(), { id: "email", type: "text", configuration: {} }, "root", "children"),
        new SetPropertyCommand(e.componentTree(), "lastName", "label", "Last")
      ])
    );
    // Taken out behind the history's back: the add cannot be undone, nor the edit beside it.
    e.componentTree().remove("email");
    expect(() => e.undo()).toThrow(/Component not found: email/);
    expect(e.componentTree().find("lastName")?.configuration).toEqual({ label: "Last" });
    expect(e.canUndo()).toBe(false);
    expect(e.componentTree().find("firstName")?.configuration).toEqual({ label: "First" });
  });

  it("keeps its own copies of a children map it puts, so what the caller does with its objects later never reaches a redo", () => {
    const e = editor();
    const given = { left: [{ id: "middleName", type: "text", configuration: { label: "Middle" } }], right: [e.componentTree().find("firstName")!] };
    e.execute(new ReplaceChildrenCommand(e.componentTree(), "root", given));
    given.left[0]!.configuration.label = "Changed by the caller";
    e.undo();
    e.redo();
    expect(e.componentTree().find("middleName")?.configuration).toEqual({ label: "Middle" });
  });

  it("keeps its own copies of the value it sets and the one it replaces", () => {
    const e = editor();
    const tree = e.componentTree();
    const meta = { a: 1 };
    e.execute(new SetPropertyCommand(tree, "firstName", "meta", meta));
    meta.a = 99;
    expect(tree.getConfigurationValue("firstName", "meta")).toEqual({ a: 1 });
    // A nested edit in place, then a removal: the node comes back as a copy, and undoing past
    // the first set then redoing it sets the value it was given.
    e.execute(new SetPropertyCommand(tree, "firstName", "meta.a", 2));
    e.execute(new RemoveComponentCommand(tree, "firstName"));
    e.undo();
    e.undo();
    e.undo();
    expect(tree.find("firstName")?.configuration).toEqual({});
    e.redo();
    expect(tree.find("firstName")?.configuration).toEqual({ meta: { a: 1 } });
    e.redo();
    expect(tree.find("firstName")?.configuration).toEqual({ meta: { a: 2 } });
  });

  it("takes away on undo what setting a nested path made above it", () => {
    const e = editor();
    const tree = e.componentTree();
    e.execute(new SetPropertyCommand(tree, "firstName", "page.orientation", "landscape"));
    expect(tree.find("firstName")?.configuration).toEqual({ page: { orientation: "landscape" } });
    e.undo();
    expect(tree.find("firstName")?.configuration).toEqual({});
    // A value that was not an object on the way is put back as it was.
    e.execute(new SetPropertyCommand(tree, "lastName", "size", "A4"));
    e.execute(new SetPropertyCommand(tree, "lastName", "size.width", 210));
    e.undo();
    expect(tree.find("lastName")?.configuration).toEqual({ size: "A4" });
  });

  it("enforces slot constraints via component registry", () => {
    const registry = new ComponentRegistry();
    registry.register({
      type: "singleSlotContainer",
      version: "1.0.0",
      createDefault: () => ({ id: "c", type: "singleSlotContainer", configuration: {} }),
      capabilities: [],
      children: {
        slots: [
          { id: "content", multiple: false, allowedTypes: ["text"] }
        ]
      }
    });
    registry.register({
      type: "text",
      version: "1.0.0",
      createDefault: () => ({ id: "t", type: "text", configuration: {} }),
      capabilities: []
    });

    const editor = new RegistryBackedTreeEditor(
      {
        id: "root",
        type: "singleSlotContainer",
        configuration: {},
        children: { content: [] }
      },
      registry
    );

    editor.add({ id: "a", type: "text", configuration: {} }, "root", "content");
    expect(() =>
      editor.add({ id: "b", type: "text", configuration: {} }, "root", "content")
    ).toThrow(/does not allow multiple children/);
  });
});

describe("tree editor history holds copies", () => {
  const root = (): ComponentNode => ({
    id: "root",
    type: "form",
    configuration: {},
    children: { content: [{ id: "a", type: "text", configuration: { label: "A", extra: { k: 1 } }, rules: { visibleWhen: "true" } }] }
  });
  const make = () => new RegistryBackedTreeEditor(root(), new ComponentRegistry());
  const aOf = (e: RegistryBackedTreeEditor) => JSON.stringify(e.snapshot().children!.content![0]);

  it("setProperty: the caller mutating its object after, undo and redo use the original", () => {
    const e = make();
    const value = { list: [1] };
    e.setProperty("a", "extra", value);
    const applied = aOf(e);
    value.list.push(999);
    e.undo();
    e.redo();
    expect(aOf(e)).toBe(applied);
  });

  it("setRules: the caller mutating its rules after, redo applies what was applied", () => {
    const e = make();
    const rules: Record<string, unknown> = { requiredWhen: "x = 1" };
    e.setRules("a", rules as ComponentRules);
    const applied = aOf(e);
    rules.requiredWhen = "MUTATED";
    rules.extra = "MUTATED";
    e.undo();
    e.redo();
    expect(aOf(e)).toBe(applied);
  });

  it("replaceConfiguration: the caller mutating its object after, redo applies what was applied", () => {
    const e = make();
    const cfg: Record<string, unknown> = { label: "Z", deep: { n: 1 } };
    e.replaceConfiguration("a", cfg);
    const applied = aOf(e);
    (cfg.deep as { n: number }).n = 999;
    e.undo();
    e.redo();
    expect(aOf(e)).toBe(applied);
  });

  it("editComponent: the caller mutating configuration and rules after, redo applies what was applied", () => {
    const e = make();
    const cfg: Record<string, unknown> = { label: "Q" };
    const rules: Record<string, unknown> = { value: "1" };
    e.editComponent("a", cfg, rules as ComponentRules);
    const applied = aOf(e);
    cfg.label = "MUTATED";
    rules.value = "MUTATED";
    e.undo();
    e.redo();
    expect(aOf(e)).toBe(applied);
  });
});

describe("tree editor remove-property undo keeps key order", () => {
  const root = (): ComponentNode => ({
    id: "root",
    type: "form",
    configuration: {},
    children: { content: [{ id: "a", type: "text", configuration: { label: "A", help: "h", placeholder: "p", nested: { x: 1, y: 2, z: 3 } } }] }
  });

  for (const path of ["label", "help", "nested.x", "nested.y"]) {
    it(`removeProperty ${path}, undo: same JSON text`, () => {
      const editor = new RegistryBackedTreeEditor(root(), new ComponentRegistry());
      const before = JSON.stringify(editor.snapshot());
      editor.removeProperty("a", path);
      editor.undo();
      expect(JSON.stringify(editor.snapshot())).toBe(before);
      editor.redo();
      editor.undo();
      expect(JSON.stringify(editor.snapshot())).toBe(before);
    });
  }

  it("setProperty to an existing key then undo keeps order", () => {
    const editor = new RegistryBackedTreeEditor(root(), new ComponentRegistry());
    const before = JSON.stringify(editor.snapshot());
    editor.setProperty("a", "label", "B");
    editor.undo();
    expect(JSON.stringify(editor.snapshot())).toBe(before);
  });
});

describe("canAcceptInSlot leaves and the form root", () => {
  const child: ComponentNode = { id: "c", type: "text", configuration: {} };
  const registered: ParentConstraintsResolver = (type) => {
    if (type === "text") return { children: undefined };
    if (type === "container") return { children: { slots: [{ id: "content", multiple: true }] } };
    if (type === "grid") return { children: { slots: [] } };
    return undefined;
  };
  const parent = (type: string): ComponentNode => ({ id: "p", type, configuration: {} });

  it("a registered type that declares no children takes none", () => {
    const result = canAcceptInSlot(parent("text"), child, "content", 0, registered);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not take children/);
  });

  it("a type with a children definition keeps its undeclared slots open, and an unknown type is unconstrained", () => {
    expect(canAcceptInSlot(parent("grid"), child, "column-3", 0, registered).ok).toBe(true);
    expect(canAcceptInSlot(parent("container"), child, "content", 0, registered).ok).toBe(true);
    expect(canAcceptInSlot(parent("custom"), child, "content", 0, registered).ok).toBe(true);
    expect(canAcceptInSlot(parent("text"), child, "content", 0).ok).toBe(true);
  });

  it("a slot an otherSlots hook describes takes children of a leaf type", () => {
    const withOther: ParentConstraintsResolver = (type) => (type === "text" ? { children: undefined, otherSlots: { multiple: true } } : undefined);
    expect(canAcceptInSlot(parent("text"), child, "content", 0, withOther).ok).toBe(true);
  });

  it("the form type is never a child, with or without a resolver", () => {
    const form: ComponentNode = { id: "f2", type: "form", configuration: {} };
    expect(canAcceptInSlot(parent("container"), form, "content", 0, registered).ok).toBe(false);
    expect(canAcceptInSlot(parent("container"), form, "content", 0).ok).toBe(false);
  });
});
