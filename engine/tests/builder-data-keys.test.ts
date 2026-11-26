import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The builder's side of data keys and of placing whole subtrees at once:
 * a key the author types is checked before Save, an edit that would give two answers one place
 * is refused, and a form built from a data model lands — and leaves — as one undo step.
 */

const leaf = (type: string, capabilities = standardFieldCapabilities()): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: { label: `${type} field` } }),
  capabilities
});

const DEFINITIONS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  leaf("text"),
  leaf("number"),
  leaf("button", standardFieldCapabilities({ required: false, placeholder: false })),
  {
    type: "container",
    version: "1.0.0",
    createDefault: () => ({ id: "container", type: "container", configuration: { label: "Group" }, children: { content: [] } }),
    capabilities: [],
    children: { slots: [{ id: "content", multiple: true }] },
    propertyEditor: {
      mode: "replace",
      fields: [
        { id: "label", type: "localized-text", propertyPath: "label", label: "Label" },
        { id: "dataKey", type: "text", propertyPath: "dataKey", label: "Data key" }
      ]
    }
  },
  {
    type: "panel",
    version: "1.0.0",
    createDefault: () => ({ id: "panel", type: "panel", configuration: { label: "Panel" }, children: { content: [] } }),
    capabilities: [],
    children: { slots: [{ id: "content", multiple: true }] }
  },
  {
    // A slot that takes one text only, for the refusal of a child deep in a subtree.
    type: "pair",
    version: "1.0.0",
    createDefault: () => ({ id: "pair", type: "pair", configuration: {}, children: { body: [] } }),
    capabilities: [],
    children: { slots: [{ id: "body", multiple: false, allowedTypes: ["text"] }] }
  }
];

function controller(content: ComponentNode[] = [], rootConfiguration: Record<string, unknown> = {}): BuilderController {
  return new BuilderController({
    initialRoot: { id: "root", type: "form", configuration: rootConfiguration, children: { content } },
    componentDefinitions: DEFINITIONS
  });
}

const text = (id: string, configuration: Record<string, unknown> = {}): ComponentNode => ({ id, type: "text", configuration: { label: id, ...configuration } });

const contentIds = (ctrl: BuilderController): string[] => (ctrl.snapshot().children?.content ?? []).map((node) => node.id);

function transfer(payload: unknown) {
  const store = new Map<string, string>([["application/x-datum-builder-drag", JSON.stringify(payload)]]);
  return { setData: (k: string, v: string) => store.set(k, v), getData: (k: string) => store.get(k) ?? "" };
}

describe("the builder and data keys", () => {
  it("offers a Data key to what holds a value, and not to a button", () => {
    const ctrl = controller();
    expect(ctrl.offersDataKey("text")).toBe(true);
    expect(ctrl.offersDataKey("container")).toBe(true);
    expect(ctrl.offersDataKey("button")).toBe(false);
    expect(ctrl.offersDataKey("panel")).toBe(false);
  });

  it("checks a key as it is typed, refuses to save an unusable one, and moves the answer once saved", () => {
    const ctrl = controller([
      { id: "billing_address", type: "container", configuration: { dataKey: "billing" }, children: { content: [text("billing_street")] } }
    ]);
    ctrl.select("billing_street");
    ctrl.setDraftProperty("billing_street", "dataKey", "the street");
    expect(ctrl.dataKeyError).toMatch(/letters, digits/);
    expect(ctrl.commitDraft("billing_street")).toBe(false);
    expect(ctrl.draftProperty("billing_street", "dataKey")).toBe("the street");

    ctrl.setDraftProperty("billing_street", "dataKey", "street");
    expect(ctrl.dataKeyError).toBeUndefined();
    expect(ctrl.dataPathOf("billing_street")).toBe("billing.street");
    expect(ctrl.commitDraft("billing_street")).toBe(true);
    expect(ctrl.getProperty("billing_street", "dataKey")).toBe("street");
    expect(ctrl.dataPathOf("billing_street")).toBe("billing.street");
  });

  it("refuses a key that puts two answers in one place, and forgets the refusal on discard", () => {
    const ctrl = controller([text("email"), text("contact")]);
    ctrl.select("contact");
    ctrl.setDraftProperty("contact", "dataKey", "email");
    expect(ctrl.dataKeyError).toMatch(/email and contact would store their answers in one place/);
    expect(ctrl.commitDraft("contact")).toBe(false);
    ctrl.discardDraft("contact");
    expect(ctrl.dataKeyError).toBeUndefined();
  });

  it("does not hold up an edit to anything else on a form that already has a clash", () => {
    const ctrl = controller([text("a", { dataKey: "same" }), text("b", { dataKey: "same" })]);
    expect(ctrl.dataKeyProblems().map((problem) => problem.code)).toEqual(["duplicate-path"]);
    ctrl.select("b");
    ctrl.setDraftProperty("b", "label", "B");
    expect(ctrl.dataKeyError).toBeUndefined();
    expect(ctrl.commitDraft("b")).toBe(true);
  });

  it("refuses an id rename that would move an answer onto another's place, and allows one that moves nothing", () => {
    const ctrl = controller([text("total_field", { dataKey: "total" }), text("amount"), text("keyed", { dataKey: "kept" })]);
    ctrl.select("amount");
    ctrl.setDraftId("amount", "total");
    expect(ctrl.idError).toMatch(/total_field and amount|would store their answers in one place, total/);
    ctrl.setDraftId("amount", "subtotal");
    expect(ctrl.idError).toBeUndefined();
    // A keyed component's answer stays where its key puts it, whatever its id.
    ctrl.select("keyed");
    ctrl.setDraftId("keyed", "total_2");
    expect(ctrl.idError).toBeUndefined();
  });

  it("refuses to add or move a component onto a place another answer holds", () => {
    const ctrl = controller([text("first", { dataKey: "text_1" }), { id: "box", type: "container", configuration: {}, children: { content: [text("inner", { dataKey: "name" })] } }, text("name")]);
    // The palette would number the new text text_1, which is already a place in the data.
    ctrl.add("text");
    expect(ctrl.dropError).toMatch(/one place, text_1/);
    expect(contentIds(ctrl)).toEqual(["first", "box", "name"]);

    ctrl.applyDrop(transfer({ kind: "existing-component", componentId: "name" }), "box", "content", 1);
    expect(ctrl.dropError).toMatch(/one place, box.name/);
    expect(contentIds(ctrl)).toEqual(["first", "box", "name"]);
  });

  it("says where each component's data sits", () => {
    const ctrl = controller([
      { id: "billing_address", type: "container", configuration: { dataKey: "billing" }, children: { content: [text("billing_street", { dataKey: "street" })] } },
      { id: "items", type: "panel", configuration: {}, collection: { collectionPath: "order.items" }, children: { content: [text("sku")] } },
      { id: "send", type: "button", configuration: { label: "Send" } }
    ]);
    expect(ctrl.dataPathOf("billing_street")).toBe("billing.street");
    expect(ctrl.dataPathOf("billing_address")).toBe("billing");
    expect(ctrl.dataPathOf("items")).toBe("order.items");
    expect(ctrl.dataPathOf("sku")).toBe("order.items[].sku");
    expect(ctrl.dataPathOf("send")).toBeUndefined();
    expect(ctrl.dataPathOf("root")).toBeUndefined();
  });
});

describe("whole subtrees at once", () => {
  const address = (prefix: string, key: string): ComponentNode => ({
    id: `${prefix}_address`,
    type: "container",
    configuration: { label: "Address", dataKey: key },
    children: { content: [text(`${prefix}_street`, { dataKey: "street" }), text(`${prefix}_city`, { dataKey: "city" })] }
  });

  it("places several subtrees as one undo step, selecting the first", () => {
    const ctrl = controller([text("name"), { id: "send", type: "button", configuration: { label: "Send" } }]);
    const reasons: string[] = [];
    ctrl.on("change", (event) => reasons.push(event.reason));
    const result = ctrl.insertComponents([
      { node: address("shipping", "shipping"), parentId: "root", slotId: "content", index: 1 },
      { node: address("billing", "billing"), parentId: "root", slotId: "content", index: 2 }
    ]);
    expect(result).toEqual({ ok: true, ids: ["shipping_address", "billing_address"] });
    expect(contentIds(ctrl)).toEqual(["name", "shipping_address", "billing_address", "send"]);
    expect(ctrl.selectedComponentId()).toBe("shipping_address");
    expect(ctrl.dataPathOf("billing_city")).toBe("billing.city");
    expect(reasons).toEqual(["add"]);

    ctrl.undo();
    expect(contentIds(ctrl)).toEqual(["name", "send"]);
    ctrl.redo();
    expect(contentIds(ctrl)).toEqual(["name", "shipping_address", "billing_address", "send"]);
  });

  it("places nothing when an id deep in a subtree is taken, repeated or unusable", () => {
    const ctrl = controller([text("name")]);
    const taken = ctrl.insertComponents([{ node: { ...address("a", "a"), children: { content: [text("name")] } } }]);
    expect(taken).toMatchObject({ ok: false, ids: [], error: 'The id "name" is already used.' });
    expect(ctrl.dropError).toBe('The id "name" is already used.');

    const repeated = ctrl.insertComponents([{ node: address("x", "one") }, { node: address("x", "two") }]);
    expect(repeated.error).toBe('The id "x_address" is already used.');

    const unusable = ctrl.insertComponents([{ node: text("2fa") }]);
    expect(unusable.error).toMatch(/"2fa" cannot be a component id/);
    expect(contentIds(ctrl)).toEqual(["name"]);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("places nothing when a child deep in a subtree is one its slot refuses", () => {
    const ctrl = controller();
    const result = ctrl.insertComponents([
      { node: { id: "p", type: "pair", configuration: {}, children: { body: [{ id: "n", type: "number", configuration: {} }] } } }
    ]);
    expect(result.error).toMatch(/n cannot go in p: Child type number is not allowed in slot body/);
    expect(contentIds(ctrl)).toEqual([]);
  });

  it("places nothing when an answer would land where another is", () => {
    const ctrl = controller([text("street_field", { dataKey: "street" })]);
    const result = ctrl.insertComponents([{ node: text("street") }]);
    expect(result.error).toMatch(/street_field and street would store their answers in one place, street/);
    expect(contentIds(ctrl)).toEqual(["street_field"]);
  });

  it("replaces the form's content as one undo step, keeping the root's settings and the named components", () => {
    const ctrl = controller(
      [text("old_one"), text("old_two"), { id: "send", type: "button", configuration: { label: "Send" } }],
      { title: "Intake" }
    );
    ctrl.select("old_two");
    ctrl.setDraftProperty("old_two", "label", "Edited");
    const reasons: string[] = [];
    ctrl.on("change", (event) => reasons.push(event.reason));
    // A rebuilt form may reuse an id it replaces.
    const result = ctrl.replaceContent([text("old_one"), address("home", "home")], { keep: ["send"] });
    expect(result).toEqual({ ok: true, ids: ["old_one", "home_address"] });
    expect(contentIds(ctrl)).toEqual(["old_one", "home_address", "send"]);
    expect((ctrl.snapshot().configuration as { title?: string }).title).toBe("Intake");
    expect(ctrl.selectedComponentId()).toBeUndefined();
    expect(ctrl.hasPendingChanges("old_two")).toBe(false);
    expect(reasons).toEqual(["edit"]);

    ctrl.undo();
    expect(contentIds(ctrl)).toEqual(["old_one", "old_two", "send"]);
  });

  it("refuses a replacement whose ids collide with what stays", () => {
    const ctrl = controller([text("a"), { id: "send", type: "button", configuration: {} }]);
    const result = ctrl.replaceContent([text("send")], { keep: ["send"] });
    expect(result.error).toBe('The id "send" is already used.');
    expect(contentIds(ctrl)).toEqual(["a", "send"]);
  });

  it("holds an insert and a replace behind the selection's unsaved edits, and plans them when they run", () => {
    const ctrl = controller([text("name")]);
    ctrl.select("name");
    ctrl.setDraftProperty("name", "label", "Full name");
    let planned = 0;
    const results: unknown[] = [];
    expect(
      ctrl.requestInsertComponents(
        () => {
          planned += 1;
          return [{ node: text("email") }];
        },
        { onResult: (result) => results.push(result) }
      )
    ).toBe(false);
    expect(planned).toBe(0);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: "name", action: "add" });
    ctrl.answerUnsavedChangesPrompt("save");
    expect(planned).toBe(1);
    expect(results).toEqual([{ ok: true, ids: ["email"] }]);
    expect(ctrl.getProperty("name", "label")).toBe("Full name");

    ctrl.select("email");
    ctrl.setDraftProperty("email", "label", "Mail");
    expect(ctrl.requestReplaceContent([text("fresh")])).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: "email", action: "replace" });
    ctrl.answerUnsavedChangesPrompt("discard");
    expect(contentIds(ctrl)).toEqual(["fresh"]);
  });

  it("answers what a type starts as, and whether it is known", () => {
    const ctrl = controller();
    expect(ctrl.hasComponentType("text")).toBe(true);
    expect(ctrl.hasComponentType("rating")).toBe(false);
    expect(ctrl.componentTemplate("container")).toEqual({ id: "container", type: "container", configuration: { label: "Group" }, children: { content: [] } });
    expect(ctrl.componentTemplate("rating")).toBeUndefined();
    // Without a registry every type is the tree editor's to keep.
    expect(new BuilderController().hasComponentType("anything")).toBe(true);
  });
});
