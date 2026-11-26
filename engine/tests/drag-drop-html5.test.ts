import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import {
  BUILDER_DRAG_MIME_TYPE,
  applyDropIntent,
  deserializeDragPayload,
  dropEffectForPayload,
  readDragPayload,
  serializeDragPayload,
  toDropIntent,
  writeDragPayload,
  type DataTransferLike
} from "../form-engine/builder/drag-drop/html5-drag-drop.js";
import { TreeEditor } from "../form-engine/builder/tree-editor/tree-editor.js";

class FakeDataTransfer implements DataTransferLike {
  private readonly store = new Map<string, string>();

  public effectAllowed?: string;

  public setData(type: string, value: string): void {
    this.store.set(type, value);
  }

  public getData(type: string): string {
    return this.store.get(type) ?? "";
  }
}

function createEditor(): TreeEditor {
  return new TreeEditor({
    id: "root",
    type: "container",
    configuration: {},
    children: {
      content: [
        { id: "firstName", type: "text", configuration: {} },
        { id: "lastName", type: "text", configuration: {} }
      ]
    }
  });
}

describe("builder html5 drag-drop mapping", () => {
  it("serializes and deserializes existing-component payloads", () => {
    const raw = serializeDragPayload({ kind: "existing-component", componentId: "firstName" });
    expect(deserializeDragPayload(raw)).toEqual({
      kind: "existing-component",
      componentId: "firstName"
    });
  });

  it("writes and reads payload using builder mime type", () => {
    const dt = new FakeDataTransfer();
    writeDragPayload(dt, { kind: "existing-component", componentId: "firstName" });

    expect(dt.effectAllowed).toBe("move");
    expect(dt.getData(BUILDER_DRAG_MIME_TYPE).length).toBeGreaterThan(0);
    expect(readDragPayload(dt)).toEqual({
      kind: "existing-component",
      componentId: "firstName"
    });
  });

  it("declares the narrow effect for each payload kind", () => {
    // The cursor badge is read from `effectAllowed`: a `dragover` handler may inspect it (the
    // payload itself is unreadable mid-drag), and it is what the canvas echoes back as
    // `dropEffect`. "copyMove" made a palette drag ambiguous, which is why the green "+"
    // vanished the moment the pointer entered the canvas.
    const template = new FakeDataTransfer();
    writeDragPayload(template, {
      kind: "template-component",
      component: { id: "t", type: "text", configuration: {} }
    });
    expect(template.effectAllowed).toBe("copy");

    expect(dropEffectForPayload({ kind: "existing-component", componentId: "a" })).toBe("move");
    expect(
      dropEffectForPayload({
        kind: "template-component",
        component: { id: "t", type: "text", configuration: {} }
      })
    ).toBe("copy");
  });

  it("maps existing-component payload to move intent and applies move command", () => {
    const editor = createEditor();
    const intent = toDropIntent(
      { kind: "existing-component", componentId: "firstName" },
      { parentId: "root", slotId: "content", index: 1 }
    );

    applyDropIntent(editor, intent);

    const ids = editor
      .componentTree()
      .childrenOf("root", "content")
      .map((child) => child.id);
    expect(ids).toEqual(["lastName", "firstName"]);
  });

  it("maps template payload to insert intent and applies add command", () => {
    const editor = createEditor();
    const component: ComponentNode = {
      id: "email",
      type: "text",
      configuration: {
        label: "Email"
      }
    };

    const intent = toDropIntent(
      { kind: "template-component", component },
      { parentId: "root", slotId: "content", index: 2 }
    );

    applyDropIntent(editor, intent);

    const inserted = editor.componentTree().find("email");
    expect(inserted?.type).toBe("text");
    expect(editor.componentTree().childrenOf("root", "content").map((child) => child.id)).toEqual([
      "firstName",
      "lastName",
      "email"
    ]);
  });

  it("returns undefined for malformed payload", () => {
    expect(deserializeDragPayload("not-json")).toBeUndefined();
  });

  it("enforces slot constraints when a parent-constraints resolver is passed", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "existing", type: "text", configuration: {} }] }
    };
    const editor = new TreeEditor(root);
    const resolver = (type: string) =>
      type === "form" ? { children: { slots: [{ id: "content", multiple: false }] } } : undefined;

    const intent = toDropIntent(
      { kind: "template-component", component: { id: "second", type: "text", configuration: {} } },
      { parentId: "root", slotId: "content", index: 1 }
    );

    expect(() => applyDropIntent(editor, intent, resolver)).toThrow(/multiple/i);
    // Without the resolver the same drop is permitted.
    expect(() => applyDropIntent(editor, intent)).not.toThrow();
  });
});

describe("deserializeDragPayload refuses malformed template payloads", () => {
  const template = (component: unknown): string => JSON.stringify({ kind: "template-component", component });

  it("ignores a null component, a typeless one, a non-object one and an array", () => {
    expect(deserializeDragPayload(template(null))).toBeUndefined();
    expect(deserializeDragPayload(template({ id: "x", configuration: {} }))).toBeUndefined();
    expect(deserializeDragPayload(template({ id: "x", type: 5 }))).toBeUndefined();
    expect(deserializeDragPayload(template("text"))).toBeUndefined();
    expect(deserializeDragPayload(template([]))).toBeUndefined();
    expect(deserializeDragPayload("null")).toBeUndefined();
    expect(deserializeDragPayload("[]")).toBeUndefined();
  });

  it("reads a component that names its type", () => {
    expect(deserializeDragPayload(template({ id: "x", type: "text", configuration: {} }))).toEqual({
      kind: "template-component",
      component: { id: "x", type: "text", configuration: {} }
    });
  });
});
