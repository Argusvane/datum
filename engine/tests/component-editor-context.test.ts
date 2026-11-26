import { describe, expect, it } from "vitest";

import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { TreeEditor } from "../form-engine/builder/tree-editor/tree-editor.js";
import {
  createComponentEditorContext,
  createPropertyEditorContext
} from "../form-engine/builder/property-editor/component-editor-context.js";

describe("component editor context", () => {
  it("reads/writes/removes nested configuration values", () => {
    const tree = new ComponentTree({
      id: "root",
      type: "container",
      configuration: {},
      children: {
        children: [{ id: "firstName", type: "text", configuration: {} }]
      }
    });

    const ctx = createComponentEditorContext(tree, "firstName");
    ctx.set("label.default", "First name");
    expect(ctx.get<string>("label.default")).toBe("First name");

    ctx.remove("label.default");
    expect(ctx.get<string>("label.default")).toBeUndefined();
  });

  it("supports bulk update callback", () => {
    const tree = new ComponentTree({
      id: "root",
      type: "container",
      configuration: {},
      children: {
        children: [{ id: "firstName", type: "text", configuration: {} }]
      }
    });

    const ctx = createComponentEditorContext(tree, "firstName");
    ctx.update((config) => {
      config.placeholder = "Type here";
      config.maxLength = 10;
    });

    expect(ctx.get<string>("placeholder")).toBe("Type here");
    expect(ctx.get<number>("maxLength")).toBe(10);
  });

  it("creates lightweight property editor context", () => {
    const context = createPropertyEditorContext({ id: "x", type: "text", configuration: {} });
    expect(context.component.id).toBe("x");
  });

  it("routes mutations through history/events when bound to TreeEditor", () => {
    const editor = new TreeEditor({
      id: "root",
      type: "container",
      configuration: {},
      children: {
        children: [{ id: "firstName", type: "text", configuration: {} }]
      }
    });

    const events: string[] = [];
    editor.events().subscribe((event) => {
      events.push(`${event.action}:${event.commandId}`);
    });

    const ctx = createComponentEditorContext(editor, "firstName");
    ctx.set("label.default", "First name");
    ctx.update((config) => {
      config.placeholder = "Type";
    });
    ctx.remove("placeholder");

    expect(editor.canUndo()).toBe(true);
    expect(events).toEqual([
      "execute:SET_PROPERTY",
      "execute:REPLACE_CONFIGURATION",
      "execute:REMOVE_PROPERTY"
    ]);
  });
});
