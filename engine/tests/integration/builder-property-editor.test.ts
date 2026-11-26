import { describe, expect, it } from "vitest";

import { RegistryBackedTreeEditor } from "../../form-engine/builder/tree-editor/tree-editor.js";
import { ComponentRegistry } from "../../form-engine/registry/components/component-registry.js";
import { buildNestedTreeView, flattenNestedTreeView } from "../../form-engine/builder/tree-editor/nested-tree-view.js";
import { buildInspectorModel } from "../../form-engine/builder/property-editor/inspector-model.js";
import { createComponentEditorContext } from "../../form-engine/builder/property-editor/component-editor-context.js";
import type { ComponentNode } from "../../form-engine/core/schema/types.js";
import type { ComponentDefinition, PropertyEditorDefinition } from "../../form-engine/core/schema/contracts.js";

const def = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition =>
  ({ type, version: "1.0.0", ...extra }) as unknown as ComponentDefinition;

function registry(): ComponentRegistry {
  const reg = new ComponentRegistry();
  reg.register(def("form", { children: { slots: [{ id: "content", multiple: true }] } }));
  reg.register(
    def("fieldset", {
      children: { slots: [{ id: "body", multiple: true, max: 2, allowedTypes: ["text"] }] }
    })
  );
  reg.register(def("text"));
  reg.register(def("number"));
  return reg;
}

function root(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [{ id: "group", type: "fieldset", configuration: {}, children: { body: [] } }]
    }
  };
}

describe("builder + property editor integration", () => {
  it("adds and moves nested components through the registry-backed editor", () => {
    const editor = new RegistryBackedTreeEditor(root(), registry());

    editor.add({ id: "a", type: "text", configuration: {} }, "group", "body");
    editor.add({ id: "b", type: "text", configuration: {} }, "root", "content");
    editor.move("b", "group", "body", 0);

    const view = buildNestedTreeView(editor.snapshot(), editor.constraintsResolver());
    const rows = flattenNestedTreeView(view);
    expect(rows.filter((r) => r.parentId === "group").map((r) => r.node.id)).toEqual(["b", "a"]);
  });

  it("rejects a slot-incompatible add / a max-exceeding add", () => {
    const editor = new RegistryBackedTreeEditor(root(), registry());
    expect(() =>
      editor.add({ id: "n", type: "number", configuration: {} }, "group", "body")
    ).toThrow(/not allowed in slot/i);

    editor.add({ id: "t1", type: "text", configuration: {} }, "group", "body");
    editor.add({ id: "t2", type: "text", configuration: {} }, "group", "body");
    expect(() =>
      editor.add({ id: "t3", type: "text", configuration: {} }, "group", "body")
    ).toThrow(/max children/i);
  });

  it("undoes and redoes structural mutations", () => {
    const editor = new RegistryBackedTreeEditor(root(), registry());
    editor.add({ id: "x", type: "text", configuration: {} }, "group", "body");
    expect(editor.snapshot().children?.content?.[0]?.children?.body).toHaveLength(1);

    editor.undo();
    expect(editor.snapshot().children?.content?.[0]?.children?.body).toHaveLength(0);
    editor.redo();
    expect(editor.snapshot().children?.content?.[0]?.children?.body).toHaveLength(1);
  });

  it("composes the inspector and routes edits through TreeEditor commands", () => {
    const editor = new RegistryBackedTreeEditor(root(), registry());
    editor.add({ id: "field", type: "text", configuration: { label: "Name" } }, "group", "body");

    const model = buildInspectorModel(editor.componentTree().find("field")!);
    expect(model.sections.flatMap((s) => s.fields).map((f) => f.propertyPath)).toEqual([
      "label",
      "description",
      "dataKey",
      "hiddenValueBehavior",
      "required"
    ]);

    createComponentEditorContext(editor, "field").set("label", "Full name");
    expect(editor.componentTree().getConfigurationValue("field", "label")).toBe("Full name");
    // Routed through a command -> undoable.
    editor.undo();
    expect(editor.componentTree().getConfigurationValue("field", "label")).toBe("Name");
  });

  it("honours the 'none' property-editor composition mode", () => {
    const node: ComponentNode = { id: "sig", type: "signature", configuration: {} };
    const editor = { mode: "none" } as unknown as PropertyEditorDefinition;
    expect(buildInspectorModel(node, [], editor).mode).toBe("none");
  });
});
