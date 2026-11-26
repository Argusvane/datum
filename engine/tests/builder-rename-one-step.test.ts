import { describe, expect, it } from "vitest";

import { BuilderController, type BuilderChangeEvent } from "../form-engine/builder/controller/builder-controller.js";
import type { BuilderMutationEvent } from "../form-engine/builder/tree-editor/tree-editor.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A rename and everything it rewrites are one entry of the form's history: Undo puts the id, the
 * rules that read it, its translations and the scenarios that name it back together, and Redo
 * renames them all again. A follow-up that lands a moment later (the scenarios, rewritten by a
 * chunk that loads on demand) joins the same entry while nothing has been done since.
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
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() },
  { type: "number", version: "1.0.0", createDefault: () => ({ id: "number", type: "number", configuration: {} }), capabilities: standardFieldCapabilities() }
];

function make(content: ComponentNode[]): BuilderController {
  return new BuilderController({
    componentDefinitions: DEFS,
    initialRoot: { id: "root", type: "form", configuration: {}, children: { content } },
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
    translations: { fr: { components: { amount: { label: { text: "Montant", source: "" } } } } }
  });
}

const form = (): ComponentNode[] => [
  { id: "amount", type: "number", configuration: { label: "Amount" } },
  { id: "b", type: "text", configuration: {}, rules: { visibleWhen: "amount = 1" } },
  {
    id: "rs",
    type: "container",
    configuration: {},
    collection: { collectionPath: "rs", itemFields: ["amount"] },
    children: { content: [] }
  }
];

const ids = (ctrl: BuilderController): string[] => (ctrl.snapshot().children?.content ?? []).map((node) => node.id);
const rulesOf = (ctrl: BuilderController, id: string) => (ctrl.snapshot().children?.content ?? []).find((node) => node.id === id)?.rules;

describe("a rename is one step of the history", () => {
  it("undo puts back the id, the rules, the row fields and the translations at once; redo renames them all again", () => {
    const ctrl = make(form());
    ctrl.setProperty("b", "label", "B");
    ctrl.renameId("amount", "total");
    expect(ids(ctrl)).toEqual(["total", "b", "rs"]);
    expect(rulesOf(ctrl, "b")).toEqual({ visibleWhen: "total = 1" });
    expect(ctrl.snapshot().children?.content?.[2]?.collection?.itemFields).toEqual(["total"]);
    expect(Object.keys(ctrl.translations()?.fr?.components ?? {})).toEqual(["total"]);

    ctrl.undo();
    expect(ids(ctrl)).toEqual(["amount", "b", "rs"]);
    expect(rulesOf(ctrl, "b")).toEqual({ visibleWhen: "amount = 1" });
    expect(ctrl.snapshot().children?.content?.[2]?.collection?.itemFields).toEqual(["amount"]);
    expect(Object.keys(ctrl.translations()?.fr?.components ?? {})).toEqual(["amount"]);
    // The edit before the rename is the next step, not a half of the rename.
    expect(ctrl.snapshot().children?.content?.[1]?.configuration).toEqual({ label: "B" });

    ctrl.redo();
    expect(ids(ctrl)).toEqual(["total", "b", "rs"]);
    expect(rulesOf(ctrl, "b")).toEqual({ visibleWhen: "total = 1" });
    expect(Object.keys(ctrl.translations()?.fr?.components ?? {})).toEqual(["total"]);

    ctrl.undo();
    ctrl.undo();
    expect(ctrl.snapshot().children?.content?.[1]?.configuration).toEqual({});
    expect(ctrl.canUndo()).toBe(false);
  });

  it("is announced as one mutation, and undoing it says the ids went back", () => {
    const ctrl = make(form());
    const mutations: BuilderMutationEvent[] = [];
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("mutation", (event) => mutations.push(event));
    ctrl.on("change", (event) => changes.push(event));
    ctrl.renameId("amount", "total");
    expect(mutations).toEqual([{ action: "execute", commandId: "RENAME_COMPONENT" }]);
    expect(changes.at(-1)?.renamed).toMatchObject({ from: "amount", to: "total", rules: ["b"] });
    ctrl.undo();
    expect(mutations.at(-1)).toEqual({ action: "undo", commandId: "RENAME_COMPONENT" });
    expect(changes.at(-1)?.renamed).toBeUndefined();
    expect(changes.at(-1)?.renameStepped).toEqual({ from: "total", to: "amount", by: "undo" });
    expect(changes.at(-1)?.renamedIds).toEqual([{ kind: "components", from: "total", to: "amount" }]);
    ctrl.redo();
    expect(changes.at(-1)?.renameStepped).toEqual({ from: "amount", to: "total", by: "redo" });
  });

  it("the selection follows the id an undo or a redo gives back", () => {
    const ctrl = make(form());
    ctrl.select("amount");
    ctrl.renameId("amount", "total");
    expect(ctrl.selectedComponentId()).toBe("total");
    ctrl.undo();
    expect(ctrl.selectedComponentId()).toBe("amount");
    ctrl.redo();
    expect(ctrl.selectedComponentId()).toBe("total");
  });

  it("takes a follow-up made a moment later into the same step while nothing was done since", () => {
    const ctrl = make(form());
    ctrl.setTests({ scenarios: [{ id: "test-1", source: 'test "one"\n  set amount = 1\n' }] });
    const before = ctrl.tests();
    ctrl.renameId("amount", "total");
    const mutations: BuilderMutationEvent[] = [];
    ctrl.on("mutation", (event) => mutations.push(event));
    const joined = ctrl.followRename({ from: "amount", to: "total" }, () => {
      ctrl.setTests({ scenarios: [{ id: "test-1", source: 'test "one"\n  set total = 1\n' }] });
    });
    expect(joined).toBe(true);
    expect(mutations).toEqual([]);
    ctrl.undo();
    expect(ids(ctrl)[0]).toBe("amount");
    expect(ctrl.tests()).toEqual(before);
    ctrl.redo();
    expect(ctrl.tests()?.scenarios[0]?.source).toContain("set total = 1");
  });

  it("makes a follow-up its own step once something else was done, or for another rename", () => {
    const ctrl = make(form());
    ctrl.setTests({ scenarios: [{ id: "test-1", source: 'test "one"\n  set amount = 1\n' }] });
    ctrl.renameId("amount", "total");
    ctrl.setProperty("b", "label", "B");
    const joined = ctrl.followRename({ from: "amount", to: "total" }, () => {
      ctrl.setTests({ scenarios: [{ id: "test-1", source: 'test "one"\n  set total = 1\n' }] });
    });
    expect(joined).toBe(false);
    ctrl.undo();
    expect(ctrl.tests()?.scenarios[0]?.source).toContain("set amount = 1");
    expect(ids(ctrl)[0]).toBe("total");
    expect(ctrl.followRename({ from: "x", to: "y" }, () => undefined)).toBe(false);
  });
});

describe("the form root keeps its id", () => {
  it("refuses a rename of the root, from the id box or a Save, and leaves the history as it was", () => {
    const ctrl = make(form());
    ctrl.renameId("root", "renamedRoot");
    expect(ctrl.snapshot().id).toBe("root");
    expect(ctrl.idError).toBe("Unable to rename this component.");
    expect(ctrl.canUndo()).toBe(false);

    ctrl.setDraftId("root", "otherRoot");
    expect(ctrl.commitDraft("root")).toBe(false);
    expect(ctrl.snapshot().id).toBe("root");
    expect(ctrl.idError).toBe("Unable to rename this component.");
  });
});
