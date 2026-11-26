import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A follow-up that joins a step is no entry of its own, so it must not cost the Redo of the steps
 * after it: a rename, then another edit, then Undo, Undo, and the follow-up lands (or is replayed
 * on the Redo) leaves the later edit redoable.
 */

const holder = (type: string): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: {}, children: { content: [] } }),
  capabilities: [],
  children: { slots: [{ id: "content", multiple: true }] }
});
const DEFS: ComponentDefinition[] = [
  holder("form"),
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: {} }), capabilities: standardFieldCapabilities() }
];

function make(): BuilderController {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "fullName", type: "text", configuration: {} },
        { id: "other", type: "text", configuration: {} }
      ]
    }
  };
  const ctrl = new BuilderController({ componentDefinitions: DEFS, initialRoot: root });
  ctrl.setTests({ scenarios: [{ id: "test-1", source: 'test "one"\n  set fullName = "Ada"\n' }] });
  return ctrl;
}

const rewrite = (ctrl: BuilderController): (() => void) => () => ctrl.setTests({ scenarios: [{ id: "test-1", source: 'test "one"\n  set name = "Ada"\n' }] });

describe("a follow-up that joins a step keeps the Redo of the steps after it", () => {
  it("replayed on the Redo of a rename, after Undo, Undo", () => {
    const ctrl = make();
    ctrl.renameId("fullName", "name");
    ctrl.setProperty("other", "label", "Other");
    ctrl.undo();
    ctrl.undo();
    expect(ctrl.followRename({ from: "fullName", to: "name" }, rewrite(ctrl))).toBe(false);
    ctrl.redo();
    expect(ctrl.followRename({ from: "fullName", to: "name" }, rewrite(ctrl))).toBe(true);
    expect(ctrl.canRedo()).toBe(true);
    ctrl.redo();
    expect(ctrl.getProperty("other", "label")).toBe("Other");
  });

  it("landing on a rename that was redone, with a later step still to redo", () => {
    const ctrl = make();
    ctrl.renameId("fullName", "name");
    ctrl.setProperty("other", "label", "Other");
    ctrl.undo();
    ctrl.undo();
    ctrl.redo();
    expect(ctrl.canRedo()).toBe(true);
    expect(ctrl.followRename({ from: "fullName", to: "name" }, rewrite(ctrl))).toBe(true);
    expect(ctrl.canRedo()).toBe(true);
  });

  it("a command that becomes an entry of its own still clears the Redo", () => {
    const ctrl = make();
    ctrl.setProperty("other", "label", "One");
    ctrl.undo();
    expect(ctrl.canRedo()).toBe(true);
    ctrl.setProperty("other", "label", "Two");
    expect(ctrl.canRedo()).toBe(false);
  });
});
