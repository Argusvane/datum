import type { ComponentNode } from "../../core/schema/types.js";
import {
  AddComponentCommand,
  MoveComponentCommand,
  TreeEditor
} from "../tree-editor/tree-editor.js";
import type { ParentConstraintsResolver } from "../tree-editor/slot-constraints.js";

export const BUILDER_DRAG_MIME_TYPE = "application/x-datum-builder-drag";

export interface DataTransferLike {
  setData(type: string, value: string): void;
  getData(type: string): string;
  effectAllowed?: string;
  dropEffect?: string;
}

export interface ExistingComponentDragPayload {
  kind: "existing-component";
  componentId: string;
}

export interface TemplateComponentDragPayload {
  kind: "template-component";
  component: ComponentNode;
}

export type BuilderDragPayload = ExistingComponentDragPayload | TemplateComponentDragPayload;

export interface DropLocation {
  parentId: string;
  slotId: string;
  index: number;
}

export interface MoveExistingIntent {
  kind: "move-existing";
  componentId: string;
  target: DropLocation;
}

export interface InsertTemplateIntent {
  kind: "insert-template";
  component: ComponentNode;
  target: DropLocation;
}

export type BuilderDropIntent = MoveExistingIntent | InsertTemplateIntent;

export function serializeDragPayload(payload: BuilderDragPayload): string {
  return JSON.stringify(payload);
}

/**
 * The longest drag payload read. What the palette writes is a new node of a type (a few hundred
 * bytes); another page can set this MIME type too, and its payload is
 * parsed before anything checks it.
 */
export const MAX_DRAG_PAYLOAD_LENGTH = 64 * 1024;

export function deserializeDragPayload(raw: string): BuilderDragPayload | undefined {
  if (typeof raw !== "string" || raw.length > MAX_DRAG_PAYLOAD_LENGTH) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BuilderDragPayload> | null;
    if (parsed !== null && typeof parsed === "object" && parsed.kind === "existing-component" && typeof parsed.componentId === "string") {
      return {
        kind: parsed.kind,
        componentId: parsed.componentId
      };
    }

    if (
      parsed !== null &&
      typeof parsed === "object" &&
      parsed.kind === "template-component" &&
      parsed.component !== null &&
      typeof parsed.component === "object" &&
      !Array.isArray(parsed.component) &&
      typeof (parsed.component as Partial<ComponentNode>).type === "string"
    ) {
      return {
        kind: parsed.kind,
        component: parsed.component as ComponentNode
      };
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The drop effect a payload should present while it is being dragged. A palette item is a
 * *copy* (the template stays in the palette), an existing component is a *move*.
 *
 * This is what the cursor badge is read from: `effectAllowed` is one of the few things a
 * `dragover` handler may inspect — a drag's data is unreadable until `drop` — so declaring the
 * narrow effect here is what lets the canvas echo it back as `dropEffect` and keep the green
 * "+" showing for the whole drag instead of only at its start.
 */
export function dropEffectForPayload(payload: BuilderDragPayload): "copy" | "move" {
  return payload.kind === "template-component" ? "copy" : "move";
}

export function writeDragPayload(
  dataTransfer: DataTransferLike,
  payload: BuilderDragPayload
): void {
  dataTransfer.effectAllowed = dropEffectForPayload(payload);
  dataTransfer.setData(BUILDER_DRAG_MIME_TYPE, serializeDragPayload(payload));
}

export function readDragPayload(dataTransfer: DataTransferLike): BuilderDragPayload | undefined {
  return deserializeDragPayload(dataTransfer.getData(BUILDER_DRAG_MIME_TYPE));
}

export function toDropIntent(
  payload: BuilderDragPayload,
  target: DropLocation
): BuilderDropIntent {
  if (payload.kind === "existing-component") {
    return {
      kind: "move-existing",
      componentId: payload.componentId,
      target
    };
  }

  return {
    kind: "insert-template",
    component: payload.component,
    target
  };
}

export function applyDropIntent(
  editor: TreeEditor,
  intent: BuilderDropIntent,
  resolveParentConstraints?: ParentConstraintsResolver
): void {
  if (intent.kind === "move-existing") {
    editor.execute(
      new MoveComponentCommand(
        editor.componentTree(),
        intent.componentId,
        intent.target.parentId,
        intent.target.slotId,
        intent.target.index,
        resolveParentConstraints
      )
    );
    return;
  }

  editor.execute(
    new AddComponentCommand(
      editor.componentTree(),
      intent.component,
      intent.target.parentId,
      intent.target.slotId,
      intent.target.index,
      resolveParentConstraints
    )
  );
}
