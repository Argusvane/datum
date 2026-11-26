import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * `BuilderController.typeInfo()`: every type the
 * builder can insert with its template, slots, palette entry and inspector model, for the
 * builder agent tools' `list_component_types` and their slot checks. A pure read.
 */

const leaf = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: { label: `${type} field` } }),
  capabilities: [],
  ...extra
});

const group = (type: string, slots: NonNullable<ComponentDefinition["children"]>["slots"], extra: Partial<ComponentDefinition> = {}): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: {}, children: Object.fromEntries(slots.map((slot) => [slot.id, []])) }),
  capabilities: [],
  children: { slots },
  ...extra
});

const DEFINITIONS: ComponentDefinition[] = [
  group("form", [{ id: "content", multiple: true }]),
  leaf("text", { palette: { label: "Short answer", group: "Fields" } }),
  leaf("number"),
  leaf("rating", { palette: { label: "Rating", icon: "★" } }),
  leaf("pdf-field", { fixed: true }),
  group("steps", [{ id: "content", multiple: true, allowedTypes: ["step"] }]),
  group("step", [{ id: "content", multiple: true }])
];

const rootOf = (content: ComponentNode[]): ComponentNode => ({ id: "root", type: "form", configuration: {}, children: { content } });

function controller(): BuilderController {
  return new BuilderController({
    initialRoot: rootOf([{ id: "text_1", type: "text", configuration: { label: "Name" } }]),
    componentDefinitions: DEFINITIONS
  });
}

describe("BuilderController.typeInfo", () => {
  it("lists every registered type in registration order, with its template and slots", () => {
    const info = controller().typeInfo();
    expect(info.map((entry) => entry.type)).toEqual(["form", "text", "number", "rating", "pdf-field", "steps", "step"]);
    const text = info.find((entry) => entry.type === "text");
    expect(text?.template).toEqual({ id: "text", type: "text", configuration: { label: "text field" } });
    expect(text?.slots).toBeUndefined();
    // The entry the builder lists now wins over the definition's own (the palette the person sees).
    expect(text?.palette).toEqual({ label: "Text" });
    expect(info.find((entry) => entry.type === "rating")?.palette).toEqual({ label: "Rating", icon: "★" });
    expect(info.find((entry) => entry.type === "pdf-field")?.palette).toBeUndefined();
    expect(info.find((entry) => entry.type === "steps")?.slots).toEqual([{ id: "content", multiple: true, allowedTypes: ["step"] }]);
  });

  it("answers one type when named, and nothing for a type it does not know", () => {
    const ctrl = controller();
    expect(ctrl.typeInfo("number").map((entry) => entry.type)).toEqual(["number"]);
    expect(ctrl.typeInfo("signature-pad")).toEqual([]);
  });

  it("reports a step's slots and the inspector model a new one is edited with", () => {
    const [step] = controller().typeInfo("step");
    expect(step?.slots).toEqual([{ id: "content", multiple: true }]);
    expect(step?.model).toBeDefined();
    expect(step?.model?.nodeType).toBe("step");
    // Composed under an id no node holds, never the template's own or one taken from the counter.
    expect(step?.model?.nodeId).toBe("step_1");
  });

  it("marks no type fixed: fixed stays a fact about a node (isFixedNode)", () => {
    const info = controller().typeInfo();
    expect(info.length).toBeGreaterThan(0);
    for (const entry of info) {
      expect(entry.fixed, entry.type).toBe(false);
    }
  });

  it("leaves the tree, the history, the selection, the drafts and the id counter alone", () => {
    const ctrl = controller();
    ctrl.add("number", "root", "content");
    ctrl.select("text_1");
    ctrl.setDraftProperty("text_1", "label", "Full name");
    const before = {
      snapshot: JSON.stringify(ctrl.snapshot()),
      canUndo: ctrl.canUndo(),
      canRedo: ctrl.canRedo(),
      selected: ctrl.selectedComponentId(),
      pending: ctrl.hasPendingChanges(),
      pendingText: ctrl.hasPendingChanges("text_1")
    };
    const info = ctrl.typeInfo();
    // Answers are copies: changing one changes nothing the controller holds.
    (info[1]?.template.configuration as Record<string, unknown>).label = "changed";
    info.find((entry) => entry.type === "steps")?.slots?.push({ id: "extra", multiple: true });
    expect(JSON.stringify(ctrl.snapshot())).toBe(before.snapshot);
    expect(ctrl.canUndo()).toBe(before.canUndo);
    expect(ctrl.canRedo()).toBe(before.canRedo);
    expect(ctrl.selectedComponentId()).toBe(before.selected);
    expect(ctrl.hasPendingChanges()).toBe(before.pending);
    expect(ctrl.hasPendingChanges("text_1")).toBe(before.pendingText);
    expect(ctrl.typeInfo("steps")[0]?.slots).toEqual([{ id: "content", multiple: true, allowedTypes: ["step"] }]);
    expect(ctrl.componentTemplate("text")?.configuration).toEqual({ label: "text field" });
    // The counter did not move: the next added number still takes the next free id.
    ctrl.add("number", "root", "content");
    expect(ctrl.snapshot().children?.content?.map((child) => child.id)).toEqual(["text_1", "number_1", "number_2"]);
  });

  it("lists the palette's types without a registry, with the generic template", () => {
    const ctrl = new BuilderController({ initialRoot: rootOf([]) });
    const info = ctrl.typeInfo();
    expect(info.map((entry) => entry.type)).toEqual(ctrl.componentTypes().map((entry) => entry.type));
    const [text] = ctrl.typeInfo("text");
    expect(text?.template).toEqual({ id: "text", type: "text", configuration: { label: "Untitled field" } });
    expect(text?.slots).toBeUndefined();
    expect(text?.palette?.label).toBe("Text");
    expect(text?.fixed).toBe(false);
  });
});
