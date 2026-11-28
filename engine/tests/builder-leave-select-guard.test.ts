import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A selection change with the inspector's draft pending is held behind the prompt
 * (Apply / Discard / Keep editing), and a change the controller itself forces — deleting the
 * selected component, an Undo that takes its draft away — never leaves a prompt asking about a
 * draft of something that is gone.
 */

const def = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition =>
  ({ type, version: "1.0.0", ...extra }) as unknown as ComponentDefinition;

function controller(): BuilderController {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name" } },
        { id: "email", type: "text", configuration: { label: "Email" }, rules: { visibleWhen: "name" } },
        {
          id: "box",
          type: "fieldset",
          configuration: { label: "Box" },
          children: { body: [{ id: "inner", type: "text", configuration: { label: "Inner" } }] }
        }
      ]
    }
  };
  return new BuilderController({
    componentTypes: [{ type: "text", label: "Text" }],
    initialRoot: root,
    componentDefinitions: [
      def("form", { children: { slots: [{ id: "content", multiple: true }] } }),
      def("fieldset", { children: { slots: [{ id: "body", multiple: true }] } }),
      def("text")
    ]
  });
}

const ids = (ctrl: BuilderController): string[] => (ctrl.snapshot().children?.content ?? []).map((node) => node.id);

describe("a selection change with a draft pending", () => {
  it("holds the selection behind the prompt, and each answer does what it says", () => {
    for (const decision of ["save", "discard", "stay"] as const) {
      const ctrl = controller();
      ctrl.select("name");
      ctrl.setDraftProperty("name", "label", "Full name");
      expect(ctrl.requestSelect("email")).toBe(false);
      expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: "name", action: "select" });
      expect(ctrl.selectedComponentId()).toBe("name");
      ctrl.answerUnsavedChangesPrompt(decision);
      expect(ctrl.unsavedChangesPrompt()).toBeUndefined();
      if (decision === "stay") {
        expect(ctrl.selectedComponentId()).toBe("name");
        expect(ctrl.hasPendingChanges("name")).toBe(true);
        expect(ctrl.getProperty("name", "label")).toBe("Name");
      } else {
        expect(ctrl.selectedComponentId()).toBe("email");
        expect(ctrl.hasPendingChanges("name")).toBe(false);
        expect(ctrl.getProperty("name", "label")).toBe(decision === "save" ? "Full name" : "Name");
      }
    }
  });

  it("asks nothing without a draft, nor for a draft typed back to what the form holds, nor for the component itself", () => {
    const ctrl = controller();
    ctrl.select("name");
    expect(ctrl.requestSelect("email")).toBe(true);
    ctrl.setDraftProperty("email", "label", "Mail");
    ctrl.setDraftProperty("email", "label", "Email");
    expect(ctrl.requestSelect("name")).toBe(true);
    ctrl.setDraftProperty("name", "label", "Changed");
    expect(ctrl.requestSelect("name")).toBe(true);
    expect(ctrl.unsavedChangesPrompt()).toBeUndefined();
    expect(ctrl.hasPendingChanges("name")).toBe(true);
  });

  it("deletes the selected component without asking about its own draft, which goes with it", () => {
    const ctrl = controller();
    ctrl.select("name");
    ctrl.setDraftProperty("name", "label", "Full name");
    expect(ctrl.requestRemoveComponents(["name"])).toBe(true);
    expect(ctrl.unsavedChangesPrompt()).toBeUndefined();
    expect(ids(ctrl)).toEqual(["email", "box"]);
    expect(ctrl.selectedComponentId()).toBeUndefined();
    expect(ctrl.hasPendingChanges()).toBe(false);
    ctrl.undo();
    // The draft is not part of the history: the component comes back as it was committed.
    expect(ctrl.getProperty("name", "label")).toBe("Name");
  });

  it("deletes a container around the selection without asking either", () => {
    const ctrl = controller();
    ctrl.select("inner");
    ctrl.setDraftProperty("inner", "label", "Changed");
    expect(ctrl.requestRemoveComponents(["box"])).toBe(true);
    expect(ids(ctrl)).toEqual(["name", "email"]);
    expect(ctrl.hasPendingChanges()).toBe(false);
  });

  it("still asks before deleting something else while the selection's draft stays", () => {
    const ctrl = controller();
    ctrl.select("name");
    ctrl.setDraftProperty("name", "label", "Full name");
    expect(ctrl.requestRemoveComponents(["email"])).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: "name", action: "remove" });
    ctrl.answerUnsavedChangesPrompt("save");
    expect(ids(ctrl)).toEqual(["name", "box"]);
    expect(ctrl.getProperty("name", "label")).toBe("Full name");
  });

  it("removes with the references in one step through the same guard", () => {
    const ctrl = controller();
    ctrl.select("name");
    ctrl.setDraftProperty("name", "label", "Full name");
    const removed: string[][] = [];
    expect(ctrl.requestRemoveComponents(["name"], { removeReferences: true, onResult: (list) => removed.push(list) })).toBe(true);
    expect(removed).toEqual([["name"]]);
    expect(ids(ctrl)).toEqual(["email", "box"]);
    // The rule that read the field went in the same step.
    expect(ctrl.snapshot().children?.content?.[0]?.rules).toBeUndefined();
    ctrl.undo();
    expect(ids(ctrl)).toEqual(["name", "email", "box"]);
    expect(ctrl.snapshot().children?.content?.[1]?.rules).toEqual({ visibleWhen: "name" });
  });

  it("puts a prompt down when an Undo takes away the draft it asks about", () => {
    const ctrl = controller();
    ctrl.select("name");
    ctrl.setDraftProperty("name", "label", "First");
    ctrl.commitDraft("name");
    ctrl.setDraftProperty("name", "label", "Second");
    expect(ctrl.requestSelect("email")).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toBeDefined();
    ctrl.undo();
    // The step changed the component, so its draft went and the prompt with it.
    expect(ctrl.hasPendingChanges("name")).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toBeUndefined();
    expect(ctrl.selectedComponentId()).toBe("name");
    // Nothing is left held: the next click moves at once.
    expect(ctrl.requestSelect("email")).toBe(true);
    expect(ctrl.selectedComponentId()).toBe("email");
  });
});
