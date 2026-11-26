import { describe, expect, it, vi } from "vitest";

import { canAcceptInSlot } from "../form-engine/builder/tree-editor/slot-constraints.js";
import { writeTools } from "../form-engine/agent/builder/writes.js";
import { BUILDER_AGENT_TOOL_NAMES } from "../form-engine/agent/builder/tools.js";
import { DATA_GRID_COMPONENT_TYPE } from "../form-engine/core/schema/data-grid.js";
import type { OutsideDocument } from "../form-engine/core/localization/locale-documents.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { agentBuilder, okOf, refusalOf } from "./fixtures/agent-builder.js";

/**
 * The builder's write tools as one catalogue: a nested add is one entry with its children
 * on the node, a refused formula writes nothing, the revision moves once per write, a dry run
 * changes nothing and names everything it saw, generated ids never collide with the
 * controller's, the slot check runs over the would-be nodes, and the shortcuts, spellings and
 * warnings read as the tools document them.
 */

// The slot check spied on as it is: the tool hands it nodes, never type names.
vi.mock("../form-engine/builder/tree-editor/slot-constraints.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../form-engine/builder/tree-editor/slot-constraints.js")>();
  return { ...actual, canAcceptInSlot: vi.fn(actual.canAcceptInSlot) };
});

function find(root: ComponentNode, id: string): ComponentNode | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    if (node.id === id) {
      return node;
    }
    for (const group of Object.values(node.children ?? {})) {
      stack.push(...group);
    }
  }
  return undefined;
}

function configOf(builder: ReturnType<typeof agentBuilder>, id: string): Record<string, unknown> | undefined {
  return find(builder.controller.snapshot(), id)?.configuration as Record<string, unknown> | undefined;
}

function contentIds(builder: ReturnType<typeof agentBuilder>): string[] {
  return (builder.controller.snapshot().children?.content ?? []).map((node) => node.id);
}

describe("the write tools", () => {
  it("are the documented seven, in catalogue order, with its titles and descriptions", () => {
    const builder = agentBuilder();
    const tools = writeTools(builder.catalogue.shared);
    expect(tools.map((tool) => tool.name)).toEqual(BUILDER_AGENT_TOOL_NAMES.slice(4, 11));
    expect(tools.map((tool) => tool.title)).toEqual([
      "Add components",
      "Replace the form's contents",
      "Change properties and rules",
      "Rename a component id",
      "Move a component",
      "Remove components",
      "Duplicate a component"
    ]);
    const description = (name: string): string => tools.find((tool) => tool.name === name)?.description ?? "";
    expect(description("add_components")).toBe(
      "Adds one or more components to the form in a single undo step, nesting children under containers; this is how to build a form or a section from a description. Give each a type and a label; optionally an id, required, options (strings or {value,label}), rules as FEEL text, configuration for anything else, and children. Leave parentId out to append at the end of the form (before its Submit button). Instead of components you can pass fromData, a JSON sample of the answers or a JSON Schema: a field is added for every place the form does not have yet, as the Data workspace's Import does. Set dryRun true to check everything and see what would be added without changing the form. Returns the new ids."
    );
    expect(description("replace_form")).toBe(
      "Replaces every component under the form root (or under one root slot) with the components you give, in one undo step; keep lists ids to leave in place (include the submit button's id to keep it). Use it to rebuild a form from a description; prefer add_components to extend an existing form. With fromData (a JSON sample of the answers or a JSON Schema) instead of components it rebuilds the form with one field per place, keeping the closing buttons. It removes every other existing component, so confirm with the person unless they asked for a rebuild. dryRun true only checks. Returns the new ids and the tests that still mention removed ids."
    );
    expect(description("set_properties")).toBe(
      "Changes properties of existing components in one undo step: configuration such as label, required, placeholder, options, min, pattern (propertyPath from get_component), or a rule as 'rules.visibleWhen' (also requiredWhen, enabledWhen, readonlyWhen, validWhen, value, defaultValue) with FEEL text. The form root takes title, description, messages, chrome.* and print.*. Formulas are parsed first; nothing is written if any fails unless partial is true. null removes a rule or clears a property. Returns what was written. To change an id use rename_component. With target 'identity' on the root it changes the form's id, version or schemaVersion. Paths the site manages and agentTools (whether assistants may fill this form) are refused."
    );
    expect(description("rename_component")).toBe(
      "Changes a component's id. Rules that read the old id are rewritten in the same change; journey pages, PDF layouts and tests follow (tests a moment later). Ids are stable handles, so rename only when the person asks or a generated id is unreadable. Returns which rules were rewritten and any formula that could not be, in the author's words."
    );
    expect(description("move_component")).toBe(
      "Moves a component into another container, or to another position among its siblings. index is the final 0-based position among the other children; after names a sibling to land right after; leave both out to append. If the move is not allowed, the result lists where the component may go. One undo step."
    );
    expect(description("remove_components")).toBe(
      "Removes components and everything inside them in one undo step. Refused with a list when other components' rules, journey pages or PDF layouts still read them, unless removeReferences is true (then those references are cleared too, one undo step per component). Tests that mention removed ids are reported, never edited. Confirm with the person before removing more than one component or anything with dependents; a single leaf is recoverable with undo. Languages, journeys and PDF layouts are removed with remove_part."
    );
    expect(description("duplicate_component")).toBe(
      "Copies a component, with everything inside it, right after the original; the copy gets fresh ids, no data keys, and its rules are re-pointed to the copies. Returns the new id and the id map. One undo step."
    );
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(annotations).toEqual({
      add_components: {},
      replace_form: { consequentialHint: true, untrustedContentHint: true },
      set_properties: {},
      rename_component: { untrustedContentHint: true },
      move_component: {},
      remove_components: { consequentialHint: true, untrustedContentHint: true },
      duplicate_component: {}
    });
  });
});

describe("the plan's chain", () => {
  it("adds a nested section as one entry, reads it back, refuses a bad formula without writing, then undoes", async () => {
    const builder = agentBuilder();
    const insert = vi.spyOn(builder.controller, "insertComponents");
    const start = builder.registration.revision();
    const added = okOf(
      await builder.execute("add_components", {
        components: [
          {
            type: "fieldset",
            label: "Applicant",
            children: [
              { type: "text", id: "first_name", label: "First name", required: true },
              { type: "text", id: "last_name", label: "Last name", required: true },
              { type: "date", id: "dob", label: "Date of birth" }
            ]
          }
        ]
      })
    );
    expect(insert).toHaveBeenCalledTimes(1);
    const entries = insert.mock.calls[0]?.[0] ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.node.children?.content?.map((child) => child.id)).toEqual(["first_name", "last_name", "dob"]);
    expect(added).toMatchObject({ ids: ["fieldset_1"], allIds: ["fieldset_1", "first_name", "last_name", "dob"], generatedIds: { "0": "fieldset_1" }, undo: { steps: 1, ownSteps: 1, canUndo: true } });
    expect(added.warnings).toContain("kept-submit-last: placed before the Submit button so it stays last.");
    expect(added.revision).toBe(start + 1);
    expect(added.next).toEqual(["Set more properties or rules with set_properties using these ids.", "Run check_form when you are done."]);
    expect((added.added as Array<{ id: string; parentId: string; slotId: string; index: number; path?: string }>)[1]).toMatchObject({ id: "first_name", parentId: "fieldset_1", slotId: "content", index: 0, path: "first_name" });
    expect(contentIds(builder)).toEqual(["full_name", "email", "topic", "details", "fieldset_1", "submit"]);

    const form = okOf(await builder.execute("get_form", {}));
    expect((form.nodes as Array<{ id: string }>).map((node) => node.id)).toContain("first_name");
    expect(form.revision).toBe(start + 1);

    const snapshot = builder.controller.snapshot();
    const refused = refusalOf(await builder.execute("set_properties", { edits: [{ componentId: "dob", propertyPath: "rules.visibleWhen", value: "first_name = " }] }));
    expect(refused.code).toBe("formula-error");
    expect(refused.hint).toContain("Pass partial: true to write the edits that parse.");
    expect(builder.controller.snapshot()).toEqual(snapshot);
    expect(refused.revision).toBe(start + 1);
    const described = okOf(await builder.execute("describe_builder", {}));
    expect(described.undo).toMatchObject({ ownSteps: 1, canUndo: true });

    const undone = okOf(await builder.execute("history", { action: "undo" }));
    expect(undone).toMatchObject({ done: 1, undo: { ownSteps: 0 } });
    expect(undone.revision).toBe(start + 2);
    expect(contentIds(builder)).toEqual(["full_name", "email", "topic", "details", "submit"]);
  });

  it("moves the revision once per write and never on drafts, show-hidden, the preview width or a selection", async () => {
    const builder = agentBuilder();
    const start = builder.registration.revision();
    okOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath: "description", value: "We reply within two days." }] }));
    expect(builder.registration.revision()).toBe(start + 1);
    builder.controller.select("topic");
    builder.controller.setDraftProperty("topic", "label", "Subject");
    builder.controller.setShowHiddenComponents(true);
    builder.controller.setPreviewWidth(400);
    expect(builder.registration.revision()).toBe(start + 1);
  });

  it("refuses a stale expectedRevision with the outline, before anything is written", async () => {
    const builder = agentBuilder();
    okOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath: "placeholder", value: "you@example.com" }] }));
    const snapshot = builder.controller.snapshot();
    const refused = refusalOf(await builder.execute("add_components", { components: [{ type: "text", label: "Late" }], expectedRevision: 1 }));
    expect(refused.code).toBe("stale");
    expect(refused.details).toMatchObject({ revision: 2, outline: { rootId: "root" } });
    expect(((refused.details as { outline: { nodes: Array<{ id: string }> } }).outline.nodes[0])?.id).toBe("root");
    expect(builder.controller.snapshot()).toEqual(snapshot);
  });
});

describe("add_components", () => {
  it("writes nothing on a dry run and names a second failure the same pass found", async () => {
    const builder = agentBuilder();
    const start = builder.registration.revision();
    const canUndo = builder.controller.canUndo();
    const dry = okOf(await builder.execute("add_components", { components: [{ type: "text", label: "Note" }], dryRun: true }));
    expect(dry).toMatchObject({ dryRun: true, ids: ["text_1"], generatedIds: { "0": "text_1" }, undo: { steps: 0 } });
    expect(dry.revision).toBe(start);
    expect(builder.controller.canUndo()).toBe(canUndo);
    expect(find(builder.controller.snapshot(), "text_1")).toBeUndefined();

    const refused = refusalOf(await builder.execute("add_components", { components: [{ type: "text", id: "note", label: "Note", parentId: "email", rules: { visibleWhen: "topic = " } }], dryRun: true }));
    expect(refused.code).toBe("slot-refused");
    expect(refused.message).toBe('"note" cannot go in "email": a text component does not take children.');
    expect(refused.details).toMatchObject({ parentId: "email", childType: "text", reason: "A text component does not take children" });
    expect((refused.details as { accepting: Array<{ parentId: string }> }).accepting.map((entry) => entry.parentId)).toEqual(["root", "details"]);
    expect(refused.hint).toMatch(/^Use one of details\.accepting, or call list_component_types to see which slots take text\. The same pass also found: The formula for note\.rules\.visibleWhen did not parse; nothing was written\. Fix both before resending\.$/);
    expect(builder.registration.revision()).toBe(start);
  });

  it("generates ids by input position that never clash with the controller's own afterwards", async () => {
    const builder = agentBuilder();
    const added = okOf(
      await builder.execute("add_components", {
        components: [
          { type: "text", label: "A" },
          { type: "tabs", label: "Sections", slots: { tab_2: [{ type: "text", label: "B" }] }, children: [{ type: "text", label: "C" }] }
        ]
      })
    );
    expect(added.generatedIds).toEqual({ "0": "text_1", "1": "tabs_1", "1.children.0": "text_2", "1.slots.tab_2.0": "text_3" });
    const tabs = find(builder.controller.snapshot(), "tabs_1");
    expect(tabs?.children?.tab_1?.map((node) => node.id)).toEqual(["text_2"]);
    expect(tabs?.children?.tab_2?.map((node) => node.id)).toEqual(["text_3"]);
    // The controller's own ids afterwards follow the agent's: none of them reused, the next free number.
    const ids = (): Set<string> => {
      const out = new Set<string>();
      const stack = [builder.controller.snapshot()];
      while (stack.length > 0) {
        const node = stack.pop() as ComponentNode;
        out.add(node.id);
        for (const group of Object.values(node.children ?? {})) {
          stack.push(...group);
        }
      }
      return out;
    };
    const known = ids();
    builder.controller.add("text");
    builder.controller.add("text");
    const later = [...ids()].filter((id) => !known.has(id)).sort();
    expect(later).toEqual(["text_4", "text_5"]);
    expect(later.filter((id) => Object.values(added.generatedIds as Record<string, string>).includes(id))).toEqual([]);
  });

  it("checks slots over the would-be nodes (canAcceptInSlot receives nodes, never type names)", async () => {
    const builder = agentBuilder();
    const spy = vi.mocked(canAcceptInSlot);
    spy.mockClear();
    okOf(await builder.execute("add_components", { components: [{ type: "fieldset", id: "group_a", label: "A", children: [{ type: "number", id: "age", label: "Age" }] }], dryRun: true }));
    const calls = spy.mock.calls.map(([parent, child, slotId]) => ({ parent: parent.id, parentType: parent.type, child: child.id, childType: child.type, slotId }));
    expect(calls).toContainEqual({ parent: "group_a", parentType: "fieldset", child: "age", childType: "number", slotId: "content" });
    expect(calls).toContainEqual({ parent: "root", parentType: "form", child: "group_a", childType: "fieldset", slotId: "content" });
  });

  it("derives option values from strings and says so", async () => {
    const builder = agentBuilder();
    const added = okOf(await builder.execute("add_components", { components: [{ type: "radio", id: "has_license", label: "Licence?", options: ["Yes", "No", { value: "maybe", label: "Maybe" }, "Yes"] }] }));
    expect(configOf(builder, "has_license")?.options).toEqual([
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
      { value: "maybe", label: "Maybe" },
      { value: "yes_2", label: "Yes" }
    ]);
    expect(added.warnings).toContain("derived-option-values: has_license option values were derived from their labels: yes, no, yes_2.");
    const bad = refusalOf(await builder.execute("add_components", { components: [{ type: "select", label: "X", options: ["a", { label: "no value" }] }] }));
    expect(bad).toMatchObject({ code: "bad-input", details: { problems: [{ key: "components[0].options[1]" }] } });
  });

  it("keeps the seeded Submit last, and warns about a second submit button without refusing", async () => {
    const builder = agentBuilder();
    const added = okOf(await builder.execute("add_components", { components: [{ type: "text", id: "phone", label: "Phone" }, { type: "button", id: "send", label: "Send", configuration: { action: "submit" } }] }));
    expect(contentIds(builder)).toEqual(["full_name", "email", "topic", "details", "phone", "send", "submit"]);
    expect(added.warnings).toEqual(["kept-submit-last: placed before the Submit button so it stays last.", "second-submit: the form already has a submit button (submit)."]);
    const placed = okOf(await builder.execute("add_components", { components: [{ type: "text", id: "first", label: "First", index: 0 }] }));
    expect(contentIds(builder)[0]).toBe("first");
    expect(placed.warnings ?? []).not.toContain("kept-submit-last: placed before the Submit button so it stays last.");

    // An entry placed at or before the seeded Submit shifts it; a later appended entry still lands just before it.
    const shifted = agentBuilder();
    okOf(await shifted.execute("add_components", { components: [{ type: "text", id: "a", label: "A", index: 0 }, { type: "text", id: "b", label: "B" }] }));
    expect(contentIds(shifted)).toEqual(["a", "full_name", "email", "topic", "details", "b", "submit"]);
  });

  it("drops required on a data grid with a warning", async () => {
    const builder = agentBuilder();
    const added = okOf(await builder.execute("add_components", { components: [{ type: DATA_GRID_COMPONENT_TYPE, id: "items", label: "Items", required: true, children: [{ type: "text", id: "sku", label: "SKU" }] }] }));
    expect(added.warnings).toContain(`required-not-offered: ${DATA_GRID_COMPONENT_TYPE} does not offer required; dropped.`);
    expect(configOf(builder, "items")?.required).toBeUndefined();
  });

  it("refuses prototype names, an over-long id and an unknown type, and ignores unknown spec keys with a warning", async () => {
    const builder = agentBuilder();
    const proto = refusalOf(await builder.execute("add_components", { components: [JSON.parse('{ "type": "text", "configuration": { "__proto__": { "x": 1 } } }')] }));
    expect(proto).toMatchObject({ code: "bad-input", details: { problems: [{ key: "components[0].configuration.__proto__", expected: "a property name that is not a prototype name" }] } });
    const long = refusalOf(await builder.execute("add_components", { components: [{ type: "text", id: `a${"b".repeat(128)}` }] }));
    expect(long).toMatchObject({ code: "bad-input", details: { problems: [{ key: "components[0].id" }] } });
    const nested = refusalOf(await builder.execute("add_components", { components: [{ type: "fieldset", children: [{ type: "text", id: `a${"b".repeat(128)}` }] }] }));
    expect(nested.code).toBe("invalid-id");
    const unknown = refusalOf(await builder.execute("add_components", { components: [{ type: "signature-pad" }] }));
    expect(unknown).toMatchObject({ code: "unknown-type", details: { type: "signature-pad", position: "0" } });
    expect((unknown.details as { known: string[] }).known).not.toContain("form");
    const form = refusalOf(await builder.execute("add_components", { components: [{ type: "form" }] }));
    expect(form.code).toBe("unknown-type");
    const warned = okOf(await builder.execute("add_components", { components: [{ type: "text", label: "Colour", colour: "red" }] }));
    expect(warned.warnings).toContain("ignored unknown argument: components[0].colour");
  });

  it("refuses an id the tree has, in the batch twice, or claimed by a journey", async () => {
    const builder = agentBuilder();
    expect(refusalOf(await builder.execute("add_components", { components: [{ type: "text", id: "email" }] })).code).toBe("duplicate-id");
    const twice = refusalOf(await builder.execute("add_components", { components: [{ type: "text", id: "x" }, { type: "text", id: "x" }] }));
    expect(twice).toMatchObject({ code: "duplicate-id", details: { id: "x", position: "1" } });

    // A journey's page-only field owns its id although no node has it; a dry run says so too,
    // so it never answers ok for a write the controller would then refuse.
    const claimed = agentBuilder();
    claimed.controller.setOptions({ claimedIds: () => ["name"] });
    const start = claimed.registration.revision();
    for (const dryRun of [true, false]) {
      const refused = refusalOf(await claimed.execute("add_components", { components: [{ type: "text", id: "name", label: "Name" }], dryRun }));
      expect(refused, `dryRun ${dryRun}`).toMatchObject({ code: "duplicate-id", details: { id: "name", claimed: true } });
    }
    expect(find(claimed.controller.snapshot(), "name")).toBeUndefined();
    expect(claimed.registration.revision()).toBe(start);
  });
});

describe("set_properties", () => {
  it("reads rules.<key> and a configuration. prefix, and null removes a rule", async () => {
    const builder = agentBuilder();
    const written = okOf(
      await builder.execute("set_properties", {
        edits: [
          { componentId: "email", propertyPath: "configuration.description", value: "We reply within two business days." },
          { componentId: "full_name", propertyPath: "rules.requiredWhen", value: "email != null" }
        ]
      })
    );
    expect(written.written).toEqual([
      { componentId: "email", propertyPath: "description", target: "configuration", previous: null, value: "We reply within two business days." },
      { componentId: "full_name", propertyPath: "rules.requiredWhen", target: "rules", previous: null, value: "email != null" }
    ]);
    expect(written.warnings).toContain("configuration-prefix: configuration.description was read as description.");
    expect(written.undo).toMatchObject({ steps: 1 });
    expect(configOf(builder, "email")?.description).toBe("We reply within two business days.");
    expect(find(builder.controller.snapshot(), "full_name")?.rules).toEqual({ requiredWhen: "email != null" });

    const alias = okOf(await builder.execute("set_properties", { edits: [{ componentId: "message", propertyPath: "requiredWhen", target: "rules", value: null }] }));
    expect(alias.written).toEqual([{ componentId: "message", propertyPath: "rules.requiredWhen", target: "rules", previous: 'topic = "other"', value: null }]);
    expect(find(builder.controller.snapshot(), "message")?.rules).toBeUndefined();
  });

  it("answers ok with nothing written when every edit is a no-op", async () => {
    const builder = agentBuilder();
    const start = builder.registration.revision();
    const result = okOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath: "label", value: "Email" }] }));
    expect(result).toMatchObject({ written: [], undo: { steps: 0 } });
    expect(builder.registration.revision()).toBe(start);
  });

  it("refuses prototype segments, whole rules, id and children, and an unknown rule key", async () => {
    const builder = agentBuilder();
    const cases: Array<[string, string | undefined]> = [
      ["__proto__.polluted", undefined],
      ["messages.constructor", undefined],
      ["id", undefined],
      ["rules", undefined],
      ["rules.notARule", undefined],
      ["label", "children"],
      ["collection.collectionPath", undefined],
      ["id.x", undefined],
      ["type.x", undefined]
    ];
    const before = builder.controller.snapshot();
    for (const [propertyPath, target] of cases) {
      const refused = refusalOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath, value: "x", ...(target !== undefined ? { target } : {}) }] }));
      expect(refused.code, propertyPath).toBe("bad-input");
    }
    const collection = refusalOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath: "collection.collectionPath", value: "x" }] }));
    expect(collection.hint).toBe("A component's row binding is set when it is added (add_components collection).");
    // Hygiene reaches into the value: an own __proto__ key in a configuration object or a rule object.
    const values: Array<[string, unknown, string]> = [
      ["messages", JSON.parse('{ "__proto__": { "x": 1 } }'), "edits[0].value.__proto__"],
      ["messages", JSON.parse('{ "required": { "__proto__": { "x": 1 } } }'), "edits[0].value.required.__proto__"],
      ["rules.visibleWhen", JSON.parse('{ "formula": "email != null", "__proto__": { "x": 1 } }'), "edits[0].value.__proto__"]
    ];
    for (const [propertyPath, value, key] of values) {
      const refused = refusalOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath, value }] }));
      expect(refused, propertyPath).toMatchObject({ code: "bad-input", details: { problems: [{ key, expected: "a property name that is not a prototype name" }] } });
    }
    expect(builder.controller.snapshot()).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("lets the last edit to a path win, so a path set and then set back is no write", async () => {
    const builder = agentBuilder();
    const start = builder.registration.revision();
    const back = okOf(
      await builder.execute("set_properties", {
        edits: [
          { componentId: "email", propertyPath: "label", value: "A" },
          { componentId: "email", propertyPath: "label", value: "Email" },
          { componentId: "email", propertyPath: "rules.visibleWhen", value: "topic = \"sales\"" },
          { componentId: "email", propertyPath: "rules.visibleWhen", value: null }
        ]
      })
    );
    expect(back).toMatchObject({ written: [], undo: { steps: 0 } });
    expect(configOf(builder, "email")?.label).toBe("Email");
    expect(find(builder.controller.snapshot(), "email")?.rules).toBeUndefined();
    expect(builder.registration.revision()).toBe(start);

    const last = okOf(
      await builder.execute("set_properties", {
        edits: [
          { componentId: "email", propertyPath: "label", value: "A" },
          { componentId: "full_name", propertyPath: "label", value: "Name" },
          { componentId: "email", propertyPath: "label", value: "B" }
        ]
      })
    );
    expect(last.written).toEqual([
      { componentId: "full_name", propertyPath: "label", target: "configuration", previous: "Full name", value: "Name" },
      { componentId: "email", propertyPath: "label", target: "configuration", previous: "Email", value: "B" }
    ]);
    expect(configOf(builder, "email")?.label).toBe("B");
    expect(last.undo).toMatchObject({ steps: 1 });

    // A deeper path is judged against what the edit before it leaves, not the committed value:
    // the options list sets the first label to "X" and the next edit sets it back to the
    // committed "Sales", which is still a write.
    const deeper = okOf(
      await builder.execute("set_properties", {
        edits: [
          {
            componentId: "topic",
            propertyPath: "options",
            value: [
              { value: "sales", label: "X" },
              { value: "support", label: "Support" },
              { value: "other", label: "Other" }
            ]
          },
          { componentId: "topic", propertyPath: "options.0.label", value: "Sales" }
        ]
      })
    );
    expect((deeper.written as Array<{ propertyPath: string }>).map((entry) => entry.propertyPath)).toEqual(["options", "options.0.label"]);
    expect((configOf(builder, "topic")?.options as Array<{ label: string }>)[0]?.label).toBe("Sales");
  });

  it("writes a name the inspector does not list, with an unknown-property warning, and coerces a checkbox's text", async () => {
    const builder = agentBuilder();
    const result = okOf(
      await builder.execute("set_properties", {
        edits: [
          { componentId: "email", propertyPath: "colour", value: "red" },
          { componentId: "email", propertyPath: "required", value: "false" }
        ]
      })
    );
    expect(result.warnings).toContain("unknown-property: text has no inspector property named colour; written anyway.");
    expect(result.warnings).toContain('coerced: email.required "false" was written as false.');
    expect(configOf(builder, "email")).toMatchObject({ colour: "red", required: false });
  });

  it("writes the edits that parse with partial: true and lists the rest in skipped", async () => {
    const builder = agentBuilder();
    const result = okOf(
      await builder.execute("set_properties", {
        partial: true,
        edits: [
          { componentId: "email", propertyPath: "rules.visibleWhen", value: "topic = (" },
          { componentId: "email", propertyPath: "label", value: "Email address" }
        ]
      })
    );
    expect((result.written as Array<{ propertyPath: string }>).map((entry) => entry.propertyPath)).toEqual(["label"]);
    expect((result.skipped as Array<{ propertyPath: string }>).map((entry) => entry.propertyPath)).toEqual(["rules.visibleWhen"]);
  });
});

describe("move_component and replace_form", () => {
  it("answers ok with no step when the component is already there", async () => {
    const builder = agentBuilder();
    const start = builder.registration.revision();
    const result = okOf(await builder.execute("move_component", { componentId: "email", index: 1 }));
    expect(result).toMatchObject({ from: { parentId: "root", slotId: "content", index: 1 }, to: { parentId: "root", slotId: "content", index: 1 }, undo: { steps: 0 } });
    expect(builder.registration.revision()).toBe(start);
  });

  it("replaces the content, keeping what keep names after the new ones, and reports the tests that still name removed ids", async () => {
    const builder = agentBuilder();
    const result = okOf(
      await builder.execute("replace_form", {
        components: [
          { type: "text", id: "full_name", label: "Full name", required: true },
          { type: "text", id: "email", label: "Email", configuration: { keyboard: "email" } },
          { type: "textarea", id: "note", label: "Note" }
        ],
        keep: ["submit"]
      })
    );
    expect(contentIds(builder)).toEqual(["full_name", "email", "note", "submit"]);
    expect(result).toMatchObject({ ids: ["full_name", "email", "note"], removed: ["full_name", "email", "topic", "details"], removedCount: 6, kept: ["submit"], undo: { steps: 1 } });
    expect(result.testsAffected).toEqual([{ id: "test-1", name: "Other topic needs a message", refs: ["topic", "message"] }]);
    expect(result.next).toEqual(["Run check_form.", "test-1 still mentions removed ids: rewrite it with write_test or remove it with remove_test."]);
  });

  it("reports what outside the replaced content still reads it: a kept component's rule and a journey page", async () => {
    const builder = agentBuilder();
    const kept = okOf(await builder.execute("replace_form", { components: [{ type: "text", id: "only", label: "Only" }], keep: ["details", "submit"] }));
    expect(kept.outsideReferences).toEqual([{ kind: "rule", componentId: "message", name: "Message", rule: "requiredWhen" }]);

    const gone = agentBuilder();
    expect(okOf(await gone.execute("replace_form", { components: [{ type: "text", id: "only", label: "Only" }], keep: ["submit"] })).outsideReferences).toEqual([]);

    const withJourney = agentBuilder();
    const journeys = { journeys: [{ id: "apply", name: "Apply", pages: [{ id: "one", title: "Start", components: ["topic"] }] }] };
    const documents: OutsideDocument[] = [{ id: "journeys", read: () => journeys, write: () => undefined, texts: () => [], setDefaults: (value) => value }];
    withJourney.controller.setOutsideDocuments(() => documents);
    const journey = okOf(await withJourney.execute("replace_form", { components: [{ type: "text", id: "only", label: "Only" }], keep: ["submit"], dryRun: true }));
    expect((journey.outsideReferences as Array<{ kind: string }>).map((entry) => entry.kind)).toEqual(["journey"]);
  });

  it("refuses a keep id that is not in the slot and a slot the root lacks", async () => {
    const builder = agentBuilder();
    expect(refusalOf(await builder.execute("replace_form", { components: [], keep: ["message"] })).code).toBe("unknown-component");
    expect(refusalOf(await builder.execute("replace_form", { components: [], slotId: "sidebar" })).code).toBe("bad-input");
  });
});

describe("the schema of the write tools", () => {
  const tools = (): ReturnType<typeof writeTools> => writeTools(agentBuilder().catalogue.shared);
  const schemaOf = (name: string): { required?: string[]; properties: Record<string, { type?: string; enum?: string[]; description: string }> } =>
    (tools().find((tool) => tool.name === name) as unknown as { inputSchema: never }).inputSchema;

  it("no longer requires components on add_components and replace_form; fromData is the one untyped property", () => {
    for (const name of ["add_components", "replace_form"]) {
      const schema = schemaOf(name);
      expect(schema.required, name).toBeUndefined();
      expect(schema.properties.components?.description.startsWith("Give this or fromData. "), name).toBe(true);
      expect(schema.properties.fromData, name).toEqual({ description: expect.stringContaining("Instead of components: a JSON sample of the answers this form should collect") });
      expect(schema.properties.fromData?.type, name).toBeUndefined();
      expect(schema.properties.readAs, name).toEqual({ type: "string", enum: ["auto", "sample", "schema"], description: "With fromData: how to read it. auto (default) decides by the $schema, type or properties keywords." });
    }
  });

  it("takes target 'identity' on set_properties edits", () => {
    const edits = schemaOf("set_properties").properties.edits as unknown as { items: { properties: { target: { enum: string[]; description: string } } } };
    expect(edits.items.properties.target.enum).toEqual(["configuration", "rules", "identity"]);
    expect(edits.items.properties.target.description).toBe(
      "Optional alias: with 'rules', propertyPath is the bare rule key (the rules. prefix does the same); with 'identity' and the root id, propertyPath is id, version or schemaVersion of the form itself (not on the undo history; Undo all and end_session { undo: true } restore it)."
    );
  });

  it("keeps the refusals: an empty components list on add is bad-input, an empty one on replace empties the slot", async () => {
    const builder = agentBuilder();
    const refused = refusalOf(await builder.execute("add_components", { components: [] }));
    expect(refused).toMatchObject({ code: "bad-input", details: { problems: [{ key: "components", expected: "at least one component entry" }] } });
    const emptied = okOf(await builder.execute("replace_form", { components: [], keep: ["submit"] }));
    expect(emptied).toMatchObject({ ids: [], kept: ["submit"] });
    expect(contentIds(builder)).toEqual(["submit"]);
  });
});
