import { describe, expect, it } from "vitest";

import { BuilderController, type BuilderChangeEvent } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A follow-up of a rename or a move of data that lands after the step was undone (the scenarios,
 * rewritten once their chunk is in) would name what the Undo took away and cost the Redo: it is
 * dropped. A Redo announces the step again, and a follow-up heard then joins it.
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
  holder("container"),
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
        { id: "applicant", type: "container", configuration: {}, children: { content: [{ id: "email", type: "text", configuration: {} }] } }
      ]
    }
  };
  const ctrl = new BuilderController({ componentDefinitions: DEFS, initialRoot: root });
  ctrl.setTests({ scenarios: [{ id: "test-1", source: 'test "one"\n  set fullName = "Ada"\n' }] });
  return ctrl;
}

const scenario = (ctrl: BuilderController): string | undefined => ctrl.tests()?.scenarios[0]?.source;
const rewrite = (ctrl: BuilderController, to: string): (() => void) => () => ctrl.setTests({ scenarios: [{ id: "test-1", source: `test "one"\n  set ${to} = "Ada"\n` }] });

describe("a follow-up that lands after its step was undone", () => {
  it("of a rename: is dropped, keeps the Redo, and joins the step once a Redo makes it again", () => {
    const ctrl = make();
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.renameId("fullName", "name");
    ctrl.undo();
    expect(changes.at(-1)?.historyStep).toBe("undo");
    let ran = false;
    expect(
      ctrl.followRename({ from: "fullName", to: "name" }, () => {
        ran = true;
        rewrite(ctrl, "name")();
      })
    ).toBe(false);
    expect(ran).toBe(false);
    expect(scenario(ctrl)).toContain("set fullName =");
    expect(ctrl.canRedo()).toBe(true);

    ctrl.redo();
    const redone = changes.at(-1)!;
    expect(redone.historyStep).toBe("redo");
    expect(redone.renameStepped).toEqual({ from: "fullName", to: "name", by: "redo" });
    expect(ctrl.followRename({ from: "fullName", to: "name" }, rewrite(ctrl, "name"))).toBe(true);
    expect(scenario(ctrl)).toContain("set name =");
    // One Undo takes the id and the scenarios back together.
    ctrl.undo();
    expect(scenario(ctrl)).toContain("set fullName =");
    expect(ctrl.canUndo()).toBe(true);
    ctrl.undo();
    expect(ctrl.canUndo()).toBe(false);
  });

  it("of a move of data: is dropped, keeps the Redo, and the Redo announces the moves again", () => {
    const ctrl = make();
    ctrl.setTests({ scenarios: [{ id: "test-1", source: 'test "one"\n  set applicant.email = "a@b.c"\n' }] });
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.setProperty("applicant", "dataKey", "contact");
    const moves = changes.at(-1)!.dataMoved!;
    expect(moves[0]).toEqual({ from: "applicant", to: "contact" });
    ctrl.undo();
    expect(changes.at(-1)?.dataMoved).toEqual(moves.map((move) => ({ from: move.to, to: move.from })));
    let ran = false;
    expect(
      ctrl.followRename(moves[0]!, () => {
        ran = true;
      })
    ).toBe(false);
    expect(ran).toBe(false);
    expect(ctrl.canRedo()).toBe(true);

    ctrl.redo();
    const redone = changes.at(-1)!;
    expect(redone.historyStep).toBe("redo");
    expect(redone.dataMoved).toEqual(moves);
    expect(redone.renameStepped).toBeUndefined();
    expect(
      ctrl.followRename(redone.dataMoved![0]!, () => ctrl.setTests({ scenarios: [{ id: "test-1", source: 'test "one"\n  set contact.email = "a@b.c"\n' }] }))
    ).toBe(true);
    ctrl.undo();
    expect(scenario(ctrl)).toContain("set applicant.email =");
    expect(ctrl.getProperty("applicant", "dataKey")).toBeUndefined();
  });

  it("of a Save that renamed a field and moved its data: dropped by either handle; the Redo carries both again", () => {
    const ctrl = make();
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.select("applicant");
    ctrl.setDraftId("applicant", "person");
    ctrl.setDraftProperty("applicant", "dataKey", "contact");
    expect(ctrl.commitDraft("applicant")).toBe(true);
    const saved = changes.at(-1)!;
    expect(saved.dataMoved?.length).toBeGreaterThan(0);
    ctrl.undo();
    const run = (): void => {
      throw new Error("an undone step's follow-up must not run");
    };
    expect(ctrl.followRename(saved.renamed!, run)).toBe(false);
    expect(ctrl.followRename(saved.dataMoved![0]!, run)).toBe(false);
    expect(ctrl.canRedo()).toBe(true);
    ctrl.redo();
    expect(changes.at(-1)?.renameStepped).toEqual({ from: "applicant", to: "person", by: "redo" });
    expect(changes.at(-1)?.dataMoved).toEqual(saved.dataMoved);
  });

  it("stays dropped once the undone step can no longer be redone", () => {
    const ctrl = make();
    ctrl.renameId("fullName", "name");
    ctrl.undo();
    ctrl.setProperty("fullName", "label", "Full name");
    expect(ctrl.canRedo()).toBe(false);
    let ran = false;
    expect(
      ctrl.followRename({ from: "fullName", to: "name" }, () => {
        ran = true;
      })
    ).toBe(false);
    expect(ran).toBe(false);
  });

  it("a rename made again after its Undo is a new step: its follow-up joins that one", () => {
    const ctrl = make();
    ctrl.renameId("fullName", "name");
    ctrl.undo();
    ctrl.renameId("fullName", "name");
    expect(ctrl.followRename({ from: "fullName", to: "name" }, rewrite(ctrl, "name"))).toBe(true);
    ctrl.undo();
    expect(scenario(ctrl)).toContain("set fullName =");
  });

  it("a change that is no step through the history carries no historyStep", () => {
    const ctrl = make();
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.setProperty("fullName", "label", "Full name");
    expect(changes.at(-1)?.historyStep).toBeUndefined();
    ctrl.undo();
    expect(changes.at(-1)?.historyStep).toBe("undo");
    ctrl.redo();
    expect(changes.at(-1)?.historyStep).toBe("redo");
    expect(changes.at(-1)?.dataMoved).toBeUndefined();
  });
});
