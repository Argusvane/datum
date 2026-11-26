import { describe, expect, it } from "vitest";

import { BuilderController, type BuilderChangeEvent } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * An Undo of a step that moved data announces the moves the other way round (each `to` back to
 * its `from`), the way a rename's Undo announces its ids; a Redo announces the moves again.
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
        { id: "applicant", type: "container", configuration: {}, children: { content: [{ id: "email", type: "text", configuration: {} }] } },
        { id: "phone", type: "text", configuration: {} }
      ]
    }
  };
  return new BuilderController({ componentDefinitions: DEFS, initialRoot: root });
}

describe("an Undo announces the moves of data it takes back", () => {
  it("a data key edit: Undo names every move reversed, Redo names the moves again", () => {
    const ctrl = make();
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.setProperty("applicant", "dataKey", "contact");
    const moves = changes.at(-1)!.dataMoved!;
    expect(moves).toContainEqual({ from: "applicant", to: "contact" });
    expect(moves.length).toBeGreaterThan(1);

    ctrl.undo();
    const undone = changes.at(-1)!;
    expect(undone.historyStep).toBe("undo");
    expect(undone.dataMoved).toEqual(moves.map((move) => ({ from: move.to, to: move.from })));

    ctrl.redo();
    const redone = changes.at(-1)!;
    expect(redone.historyStep).toBe("redo");
    expect(redone.dataMoved).toEqual(moves);
  });

  it("a Save that renamed a field and moved its data: Undo carries the ids and the moves back", () => {
    const ctrl = make();
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.select("applicant");
    ctrl.setDraftId("applicant", "person");
    ctrl.setDraftProperty("applicant", "dataKey", "contact");
    expect(ctrl.commitDraft("applicant")).toBe(true);
    const moves = changes.at(-1)!.dataMoved!;
    ctrl.undo();
    expect(changes.at(-1)?.renameStepped).toEqual({ from: "person", to: "applicant", by: "undo" });
    expect(changes.at(-1)?.dataMoved).toEqual(moves.map((move) => ({ from: move.to, to: move.from })));
  });

  it("a second key edit's Undo reverses that edit's moves only", () => {
    const ctrl = make();
    ctrl.setProperty("phone", "dataKey", "tel");
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.setProperty("phone", "dataKey", "mobile");
    expect(changes.at(-1)?.dataMoved).toEqual([{ from: "tel", to: "mobile" }]);
    ctrl.undo();
    expect(changes.at(-1)?.dataMoved).toEqual([{ from: "mobile", to: "tel" }]);
  });

  it("an edit that moved no data announces none, either way", () => {
    const ctrl = make();
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.setProperty("phone", "label", "Phone");
    ctrl.undo();
    expect(changes.at(-1)?.dataMoved).toBeUndefined();
    ctrl.redo();
    expect(changes.at(-1)?.dataMoved).toBeUndefined();
  });
});
