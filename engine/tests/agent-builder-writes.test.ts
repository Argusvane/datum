import { describe, expect, it, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { AGENT_BUILDER_DEFINITIONS, AGENT_BUILDER_PALETTE, agentBuilder, contactRequestRoot, okOf, refusalOf, uiStub } from "./fixtures/agent-builder.js";

/**
 * The builder's rename, move and duplicate tools, and what every write shows and reports: rules follow a rename and
 * the ones that cannot are named, the tests follow it a moment later (or cannot), a move lands
 * where `after` says and names what it left empty, a copy reports its ids, and every write is
 * selected, highlighted, announced and noticed on a page and reported as none of that without
 * one, with the component ids and the undo steps in its `datum-agent-action`.
 */

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

describe("rename_component", () => {
  it("rewrites the rules that read the old id and names the ones it could not", async () => {
    const builder = agentBuilder();
    builder.controller.setRules("subscribe", { visibleWhen: "topic = " } as never);
    const result = okOf(await builder.execute("rename_component", { componentId: "topic", newId: "subject" }));
    expect(result).toMatchObject({ from: "topic", to: "subject", rulesRewritten: ["message"], collectionPathFollowed: false, testsFollow: "unavailable", undo: { steps: 1 } });
    expect(result.unparsed).toEqual([{ componentId: "subscribe", rule: "visibleWhen", from: "topic", to: "subject", formula: "topic = " }]);
    expect(find(builder.controller.snapshot(), "message")?.rules).toEqual({ requiredWhen: 'subject = "other"' });
    expect(result.warnings).toBeUndefined();
  });

  it("is one step when nothing reads the id, and ok with nothing done for the same id", async () => {
    const builder = agentBuilder();
    const renamed = okOf(await builder.execute("rename_component", { componentId: "full_name", newId: "name" }));
    expect(renamed).toMatchObject({ rulesRewritten: [], undo: { steps: 1 } });
    expect(find(builder.controller.snapshot(), "name")).toBeDefined();
    const same = okOf(await builder.execute("rename_component", { componentId: "name", newId: "name" }));
    expect(same).toMatchObject({ from: "name", to: "name", undo: { steps: 0 } });
  });

  it("says whether the tests follow: queued with a page that names the id, none when no test does, unavailable without a page or the tests feature", async () => {
    const queued = okOf(await agentBuilder({ ui: uiStub() }).execute("rename_component", { componentId: "topic", newId: "subject" }));
    expect(queued.testsFollow).toBe("queued");
    expect(queued.warnings).toEqual(["tests-follow: test sources are rewritten a moment later; list_tests may show the old id for one tick."]);
    const none = okOf(await agentBuilder({ ui: uiStub() }).execute("rename_component", { componentId: "full_name", newId: "name" }));
    expect(none.testsFollow).toBe("none");
    const off = okOf(await agentBuilder({ ui: uiStub(), featureOn: { tests: false } }).execute("rename_component", { componentId: "topic", newId: "subject" }));
    expect(off.testsFollow).toBe("unavailable");
  });

  it("maps a refusal the controller words in idError, and clears it from the inspector", async () => {
    const builder = agentBuilder();
    const controller = builder.controller;
    const rename = vi.spyOn(controller, "renameId");
    rename.mockImplementationOnce(() => {
      controller.idError = 'ID "name" is already used by a page-only field of a journey.';
    });
    const claimed = refusalOf(await builder.execute("rename_component", { componentId: "full_name", newId: "name" }));
    expect(claimed).toMatchObject({ code: "duplicate-id", details: { id: "name", claimed: true } });
    expect(controller.idError).toBeUndefined();
    rename.mockImplementationOnce(() => {
      controller.idError = "Rename failed.";
    });
    const other = refusalOf(await builder.execute("rename_component", { componentId: "full_name", newId: "name" }));
    expect(other).toMatchObject({ code: "refused", message: "Rename failed.", details: { message: "Rename failed." } });
    expect(controller.idError).toBeUndefined();
  });

  it("refuses a fixed component", async () => {
    const definitions: ComponentDefinition[] = [...AGENT_BUILDER_DEFINITIONS, { type: "pdf-field", version: "1.0.0", fixed: true, capabilities: [], createDefault: () => ({ id: "pdf-field", type: "pdf-field", configuration: {} }) }];
    const root = contactRequestRoot();
    root.children?.content?.unshift({ id: "pdf_name", type: "pdf-field", configuration: { label: "Name" } });
    const controller = new BuilderController({ initialRoot: root, componentDefinitions: definitions, componentTypes: AGENT_BUILDER_PALETTE });
    const builder = agentBuilder({ controller });
    for (const [name, input] of [
      ["rename_component", { componentId: "pdf_name", newId: "x" }],
      ["move_component", { componentId: "pdf_name", index: 2 }],
      ["remove_components", { componentIds: ["pdf_name"] }],
      ["duplicate_component", { componentId: "pdf_name" }]
    ] as const) {
      const refused = refusalOf(await builder.execute(name, input));
      expect(refused, name).toMatchObject({ code: "fixed-component", details: { componentId: "pdf_name" } });
    }
  });
});

describe("move_component", () => {
  it("lands right after the sibling `after` names, and names the container a move left empty", async () => {
    const builder = agentBuilder();
    const moved = okOf(await builder.execute("move_component", { componentId: "subscribe", parentId: "root", after: "email" }));
    expect(moved).toMatchObject({ componentId: "subscribe", from: { parentId: "details", slotId: "content", index: 1 }, to: { parentId: "root", slotId: "content", index: 2 }, leftEmpty: [], undo: { steps: 1 } });
    const emptied = okOf(await builder.execute("move_component", { componentId: "message", parentId: "root", index: 0 }));
    expect(emptied).toMatchObject({ to: { parentId: "root", slotId: "content", index: 0 }, leftEmpty: ["details"] });
    expect((builder.controller.snapshot().children?.content ?? []).map((node) => node.id)).toEqual(["message", "full_name", "email", "subscribe", "topic", "details", "submit"]);
  });

  it("refuses an `after` that is not a sibling in the destination, and an unknown destination", async () => {
    const builder = agentBuilder();
    expect(refusalOf(await builder.execute("move_component", { componentId: "email", after: "message" })).code).toBe("bad-input");
    expect(refusalOf(await builder.execute("move_component", { componentId: "email", after: "nobody" })).code).toBe("unknown-component");
    expect(refusalOf(await builder.execute("move_component", { componentId: "email", parentId: "nowhere" })).code).toBe("unknown-component");
  });
});

describe("duplicate_component", () => {
  it("reports the copy's id, the id map and the data keys it dropped", async () => {
    const builder = agentBuilder();
    okOf(await builder.execute("set_properties", { edits: [{ componentId: "message", propertyPath: "dataKey", value: "note" }] }));
    const copy = okOf(await builder.execute("duplicate_component", { componentId: "details" }));
    expect(copy).toMatchObject({ from: "details", id: "details_2", ids: { details: "details_2", message: "message_2", subscribe: "subscribe_2" }, dataKeysDropped: ["message_2"], undo: { steps: 1 } });
    expect((builder.controller.snapshot().children?.content ?? []).map((node) => node.id)).toEqual(["full_name", "email", "topic", "details", "details_2", "submit"]);
  });

  it("refuses the root", async () => {
    const refused = refusalOf(await agentBuilder().execute("duplicate_component", { componentId: "root" }));
    expect(refused).toMatchObject({ code: "root-component", message: "The form root cannot be duplicated.", details: {} });
    expect(refused.hint).toBe("The root is the form itself: replace_form changes its contents, set_properties { componentId: 'root' } its settings.");
  });
});

describe("what every write shows and reports", () => {
  const writes: Array<[string, Record<string, unknown>, string]> = [
    ["add_components", { components: [{ type: "text", id: "phone", label: "Phone" }] }, "phone"],
    ["replace_form", { components: [{ type: "text", id: "only", label: "Only" }], keep: ["submit"] }, "only"],
    ["set_properties", { edits: [{ componentId: "email", propertyPath: "label", value: "Email address" }] }, "email"],
    ["rename_component", { componentId: "full_name", newId: "name" }, "name"],
    ["move_component", { componentId: "email", index: 0 }, "email"],
    ["remove_components", { componentIds: ["topic"], removeReferences: true }, "email"],
    ["duplicate_component", { componentId: "email" }, "email_2"]
  ];

  it("selects, highlights, announces and notices on a page; shows nothing under a bare controller", async () => {
    for (const [name, input, selected] of writes) {
      const stub = uiStub();
      const builder = agentBuilder({ ui: stub });
      const result = okOf(await builder.execute(name, input));
      expect(result.shown, name).toEqual({ componentId: selected });
      expect(builder.controller.selectedComponentId(), name).toBe(selected);
      expect(stub.callsOf("announce"), name).toHaveLength(1);
      const steps = (result.undo as { steps: number }).steps;
      expect(stub.callsOf("notice"), name).toHaveLength(steps > 0 ? 1 : 0);
      if (name !== "remove_components") {
        expect(stub.callsOf("highlight").length, name).toBe(1);
      }
      const bare = okOf(await agentBuilder().execute(name, input));
      expect(bare.shown, name).toBeUndefined();
    }
  });

  it("announces in the assistant's words and offers Undo for exactly the write's steps", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("add_components", { components: [{ type: "fieldset", id: "group", label: "Group", children: [{ type: "text", id: "inside", label: "Inside" }] }] }));
    expect(stub.callsOf("announce")).toEqual([["Assistant added 2 components"]]);
    expect(stub.callsOf("highlight")).toEqual([[["group", "inside"]]]);
    const [text, action] = stub.callsOf("notice")[0] as [string, { label: string; run(): void }];
    expect(text).toBe("Assistant added 2 components");
    expect(action.label).toBe("Undo");
    action.run();
    expect(find(builder.controller.snapshot(), "group")).toBeUndefined();
  });

  it("skips the highlight and the reveal while the person types in a text control, and still announces", async () => {
    const stub = uiStub({ focusInTextControl: true });
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath: "label", value: "Mail" }] }));
    expect(stub.callsOf("highlight")).toEqual([]);
    expect(stub.callsOf("revealComponent")).toEqual([]);
    expect(stub.callsOf("announce")).toEqual([["Assistant changed 1 property on Mail"]]);
  });

  it("puts the component ids and the undo steps in datum-agent-action", async () => {
    const builder = agentBuilder();
    okOf(await builder.execute("add_components", { components: [{ type: "fieldset", id: "group", label: "Group", children: [{ type: "text", id: "inside", label: "Inside" }] }] }));
    okOf(await builder.execute("remove_components", { componentIds: ["topic", "subscribe"], removeReferences: true }));
    const actions = builder.host.calls.filter((call) => call.method === "emit" && call.args[0] === "datum-agent-action").map((call) => call.args[1] as { tool: string; componentIds?: string[]; undoSteps?: number });
    const add = actions.find((action) => action.tool === "add_components");
    expect(add?.componentIds).toEqual(expect.arrayContaining(["group", "inside"]));
    expect(add?.undoSteps).toBe(1);
    const remove = actions.find((action) => action.tool === "remove_components");
    expect(remove?.componentIds).toEqual(expect.arrayContaining(["topic", "subscribe", "message"]));
    expect(remove?.undoSteps).toBe(2);
  });
});

describe("the author's switch and the writes that replace content", () => {
  for (const setting of ["allowed", "off"] as const) {
    it(`leaves the root's agentTools "${setting}" JSON-equal across replace_form and add_components`, async () => {
      const root = contactRequestRoot();
      root.configuration = { ...(root.configuration ?? {}), agentTools: setting };
      const builder = agentBuilder({ root });
      const switchOf = (): unknown => JSON.stringify((builder.controller.snapshot().configuration as Record<string, unknown>).agentTools);
      const before = switchOf();
      expect(before).toBe(JSON.stringify(setting));
      okOf(await builder.execute("replace_form", { components: [{ type: "text", id: "only", label: "Only" }], keep: ["submit"] }));
      expect(switchOf()).toBe(before);
      okOf(await builder.execute("add_components", { components: [{ type: "text", id: "extra", label: "Extra" }] }));
      expect(switchOf()).toBe(before);
      expect(builder.controller.snapshot().configuration).toMatchObject({ title: "Contact request", agentTools: setting });
    });
  }
});
