import { describe, expect, it, vi } from "vitest";

import type { OutsideDocument } from "../form-engine/core/localization/locale-documents.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { agentBuilder, okOf, refusalOf, uiStub, type AgentBuilder } from "./fixtures/agent-builder.js";

/**
 * What the builder's write tools yield to and refuse: the person's unsaved
 * edit and their open prompt (never answered for them, never raised), the race a request still
 * loses (answered "stay"), a designer and Try it, dependents before a removal, the input caps,
 * the structure limits, the inspector's blockers and the Stop latch. A refusal changes nothing:
 * the tree, the history and the revision are as they were.
 */

/** One valid call per write tool over the contact-request fixture, none of them touching email. */
const WRITES: Array<[string, Record<string, unknown>]> = [
  ["add_components", { components: [{ type: "text", id: "phone", label: "Phone" }] }],
  ["replace_form", { components: [{ type: "text", id: "only", label: "Only" }], keep: ["email", "submit"] }],
  ["set_properties", { edits: [{ componentId: "full_name", propertyPath: "label", value: "Name" }] }],
  ["rename_component", { componentId: "full_name", newId: "name" }],
  ["move_component", { componentId: "full_name", index: 2 }],
  ["remove_components", { componentIds: ["subscribe"] }],
  ["duplicate_component", { componentId: "full_name" }]
];

interface State {
  snapshot: ComponentNode;
  canUndo: boolean;
  revision: number;
}

function stateOf(builder: AgentBuilder): State {
  return { snapshot: builder.controller.snapshot(), canUndo: builder.controller.canUndo(), revision: builder.registration.revision() };
}

/** Asserts a refused call left the tree, the history and the revision as they were. */
function expectUnchanged(builder: AgentBuilder, before: State, label: string): void {
  expect(builder.controller.snapshot(), label).toEqual(before.snapshot);
  expect(builder.controller.canUndo(), label).toBe(before.canUndo);
  expect(builder.registration.revision(), label).toBe(before.revision);
}

/** Nested fieldsets `levels` deep, a text at the bottom. */
function deepSpec(levels: number): Record<string, unknown> {
  let spec: Record<string, unknown> = { type: "text", label: "Bottom" };
  for (let at = 0; at < levels; at += 1) {
    spec = { type: "fieldset", label: `Level ${at}`, children: [spec] };
  }
  return spec;
}

describe("the person's state", () => {
  it("refuses every write with unsaved-draft { draft } while the selection has an unsaved edit, and raises no prompt", async () => {
    for (const [name, input] of WRITES) {
      const builder = agentBuilder();
      builder.controller.select("email");
      builder.controller.setDraftProperty("email", "label", "x");
      const before = stateOf(builder);
      const refused = refusalOf(await builder.execute(name, input));
      expect(refused, name).toMatchObject({ code: "unsaved-draft", retryable: false, details: { reason: "draft", componentId: "email" } });
      expect(refused.hint, name).toBe("The person is editing email; ask them to apply or discard that edit, then call again. Do not retry on your own.");
      expect(builder.controller.unsavedChangesPrompt(), name).toBeUndefined();
      expect(builder.controller.hasPendingChanges("email"), name).toBe(true);
      expectUnchanged(builder, before, name);
    }
  });

  it("refuses every write with unsaved-draft { prompt } while the builder's prompt is up, and leaves it up", async () => {
    for (const [name, input] of WRITES) {
      const builder = agentBuilder();
      builder.controller.select("email");
      builder.controller.setDraftProperty("email", "label", "x");
      expect(builder.controller.requestSelect("topic")).toBe(false);
      const prompt = builder.controller.unsavedChangesPrompt();
      expect(prompt).toBeDefined();
      const before = stateOf(builder);
      const refused = refusalOf(await builder.execute(name, input));
      expect(refused, name).toMatchObject({ code: "unsaved-draft", details: { reason: "prompt", prompt: { componentId: "email", action: "select" } } });
      expect(builder.controller.unsavedChangesPrompt(), name).toEqual(prompt);
      expectUnchanged(builder, before, name);
    }
  });

  it("answers stay when the request loses the race to the person's edit, and inserts nothing", async () => {
    const builder = agentBuilder();
    const controller = builder.controller;
    controller.select("email");
    const original = controller.requestInsertComponents.bind(controller);
    vi.spyOn(controller, "requestInsertComponents").mockImplementation((entries, options) => {
      // The person's keystroke lands between the tool's pre-check and its request.
      controller.setDraftProperty("email", "label", "typed");
      return original(entries, options);
    });
    const stay = vi.spyOn(controller, "answerUnsavedChangesPrompt");
    const before = stateOf(builder);
    const refused = refusalOf(await builder.execute("add_components", { components: [{ type: "text", id: "phone", label: "Phone" }] }));
    expect(refused).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "email" } });
    expect(stay).toHaveBeenCalledTimes(1);
    expect(stay).toHaveBeenCalledWith("stay");
    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    expect(controller.snapshot()).toEqual(before.snapshot);
    expect(controller.canUndo()).toBe(before.canUndo);
  });

  it("refuses the request-routed writes while the Form panel's draft is open on the selected root, and never raises the prompt", async () => {
    // The controller's guard holds a request on the selected component's draft, the root's
    // included; a write must refuse first rather than raise Save / Discard / Stay.
    const refusedOnRoot = ["add_components", "replace_form", "move_component", "remove_components", "duplicate_component"];
    for (const [name, input] of WRITES) {
      const builder = agentBuilder();
      const controller = builder.controller;
      controller.select("root");
      controller.setDraftProperty("root", "title", "Draft title");
      const stay = vi.spyOn(controller, "answerUnsavedChangesPrompt");
      const prompts: unknown[] = [];
      const off = controller.on("change", () => {
        if (controller.unsavedChangesPrompt() !== undefined) {
          prompts.push(controller.unsavedChangesPrompt());
        }
      });
      const before = stateOf(builder);
      const result = await builder.execute(name, input);
      off();
      if (refusedOnRoot.includes(name)) {
        expect(refusalOf(result), name).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "root" } });
        expectUnchanged(builder, before, name);
      } else {
        okOf(result);
      }
      expect(stay, name).not.toHaveBeenCalled();
      expect(prompts, name).toEqual([]);
      expect(controller.unsavedChangesPrompt(), name).toBeUndefined();
      expect(controller.hasPendingChanges("root"), name).toBe(true);
    }

    // With the prompt already up over the root's draft, the prompt is what the agent is told
    // about: the root-draft check runs only while no prompt is up.
    for (const name of refusedOnRoot) {
      const input = WRITES.find(([tool]) => tool === name)?.[1] as Record<string, unknown>;
      const builder = agentBuilder();
      const controller = builder.controller;
      controller.select("root");
      controller.setDraftProperty("root", "title", "Draft title");
      expect(controller.requestSelect("topic")).toBe(false);
      const prompt = controller.unsavedChangesPrompt();
      expect(prompt).toMatchObject({ componentId: "root", action: "select" });
      const before = stateOf(builder);
      const refused = refusalOf(await builder.execute(name, input));
      expect(refused, name).toMatchObject({ code: "unsaved-draft", details: { reason: "prompt", prompt: { componentId: "root", action: "select" } } });
      expect(controller.unsavedChangesPrompt(), name).toEqual(prompt);
      expectUnchanged(builder, before, name);
    }
  });

  it("removes a selected component with an unsaved edit, directly or inside a removed container, and its draft goes with it", async () => {
    for (const [selected, removing] of [
      ["subscribe", "subscribe"],
      ["message", "details"]
    ] as const) {
      const builder = agentBuilder();
      const controller = builder.controller;
      controller.select(selected);
      controller.setDraftProperty(selected, "label", "x");
      const stay = vi.spyOn(controller, "answerUnsavedChangesPrompt");
      const removed = okOf(await builder.execute("remove_components", { componentIds: [removing] }));
      expect(removed, removing).toMatchObject({ removed: [removing], undo: { steps: 1 } });
      expect(controller.hasPendingChanges(selected), removing).toBe(false);
      expect(controller.unsavedChangesPrompt(), removing).toBeUndefined();
      expect(stay, removing).not.toHaveBeenCalled();
    }
  });

  it("refuses set_properties on any edited id with a draft, the root's and an unselected one's included", async () => {
    const onRoot = agentBuilder();
    onRoot.controller.select("root");
    onRoot.controller.setDraftProperty("root", "title", "Draft title");
    let before = stateOf(onRoot);
    const root = refusalOf(await onRoot.execute("set_properties", { edits: [{ componentId: "root", propertyPath: "title", value: "Agent title" }] }));
    expect(root).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "root" } });
    expectUnchanged(onRoot, before, "root draft");

    const elsewhere = agentBuilder();
    elsewhere.controller.select("full_name");
    elsewhere.controller.setDraftProperty("full_name", "label", "x");
    elsewhere.controller.select("email");
    before = stateOf(elsewhere);
    const unselected = refusalOf(await elsewhere.execute("set_properties", { edits: [{ componentId: "full_name", propertyPath: "description", value: "Your name" }] }));
    expect(unselected).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "full_name" } });
    expectUnchanged(elsewhere, before, "unselected draft");
    expect(elsewhere.controller.unsavedChangesPrompt()).toBeUndefined();
  });

  it("lets set_properties write in a designer and while the person tries the form", async () => {
    for (const ui of [uiStub({ mode: "pdf" }), uiStub({ trying: true, triedAnswers: { topic: "sales" } })]) {
      const builder = agentBuilder({ ui });
      const written = okOf(await builder.execute("set_properties", { edits: [{ componentId: "full_name", propertyPath: "label", value: "Name" }] }));
      expect(written.undo).toMatchObject({ steps: 1 });
    }
  });

  it("refuses tree writes in a designer (wrong-mode) and in Try it (try-it-on), as describe_builder announces", async () => {
    const designer = agentBuilder({ ui: uiStub({ mode: "pdf" }) });
    const described = okOf(await designer.execute("describe_builder", {}));
    expect(described.blockedBy).toEqual(["wrong-mode"]);
    for (const [name, input] of WRITES.filter(([tool]) => tool !== "set_properties")) {
      const before = stateOf(designer);
      const refused = refusalOf(await designer.execute(name, input));
      expect(refused, name).toMatchObject({ code: "wrong-mode", details: { mode: "pdf" } });
      expect(refused.hint, name).toBe("The person is in the pdf designer and would not see the change; call open { workspace: 'form' } first.");
      expectUnchanged(designer, before, name);
    }
    const trying = agentBuilder({ ui: uiStub({ trying: true, triedAnswers: { topic: "sales" } }) });
    for (const [name, input] of WRITES.filter(([tool]) => tool !== "set_properties")) {
      const before = stateOf(trying);
      const refused = refusalOf(await trying.execute(name, input));
      expect(refused, name).toMatchObject({ code: "try-it-on", details: { triedPaths: 1 } });
      expectUnchanged(trying, before, name);
    }
  });

  it("refuses every write while the person has stopped the assistant", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "Build the form" }));
    (stub.state.session as { onStop(): void }).onStop();
    await Promise.resolve();
    for (const [name, input] of WRITES) {
      const before = stateOf(builder);
      expect(refusalOf(await builder.execute(name, input)).code, name).toBe("stopped");
      expectUnchanged(builder, before, name);
    }
    okOf(await builder.execute("get_form", {}));
  });
});

describe("remove_components and dependents", () => {
  it("refuses a removal other rules read, then clears them with removeReferences in one step per component", async () => {
    const builder = agentBuilder();
    const before = stateOf(builder);
    const refused = refusalOf(await builder.execute("remove_components", { componentIds: ["topic"] }));
    expect(refused).toMatchObject({ code: "has-dependents", details: { dependents: [{ componentId: "topic", items: [{ kind: "rule", componentId: "message", rule: "requiredWhen" }] }] } });
    expect((refused.details as { dependents: Array<{ lines: string[] }> }).dependents[0]?.lines).toHaveLength(1);
    expectUnchanged(builder, before, "has-dependents");

    const cleared = okOf(await builder.execute("remove_components", { componentIds: ["topic", "subscribe"], removeReferences: true }));
    expect(cleared).toMatchObject({ removed: ["topic", "subscribe"], removedCount: 2, undo: { steps: 2 } });
    expect(cleared.referencesCleared).toEqual([{ kind: "rule", componentId: "message", name: "Message", rule: "requiredWhen" }]);
    expect(cleared.testsAffected).toEqual([{ id: "test-1", name: "Other topic needs a message", refs: ["topic"] }]);
  });

  it("drops a rule owned by another removed component (a plain filter) but keeps a journey that names one", async () => {
    const builder = agentBuilder();
    const removed = okOf(await builder.execute("remove_components", { componentIds: ["topic", "details"] }));
    expect(removed).toMatchObject({ removed: ["topic", "details"], removedCount: 4, undo: { steps: 1 } });

    const withJourney = agentBuilder();
    const journeys = { journeys: [{ id: "apply", name: "Apply", pages: [{ id: "one", title: "Start", components: ["topic"] }] }] };
    const documents: OutsideDocument[] = [{ id: "journeys", read: () => journeys, write: () => undefined, texts: () => [], setDefaults: (value) => value }];
    withJourney.controller.setOutsideDocuments(() => documents);
    const refused = refusalOf(await withJourney.execute("remove_components", { componentIds: ["topic", "details"] }));
    expect(refused.code).toBe("has-dependents");
    const items = (refused.details as { dependents: Array<{ items: Array<{ kind: string }> }> }).dependents.flatMap((entry) => entry.items);
    expect(items.map((item) => item.kind)).toEqual(["journey"]);
  });

  it("reports tests by their component refs, never by a page ref", async () => {
    const builder = agentBuilder({ tests: { scenarios: [{ id: "test-9", source: 'test "Jumps"\n  go to subscribe\n  expect page = subscribe\n' }] } });
    const removed = okOf(await builder.execute("remove_components", { componentIds: ["subscribe"] }));
    expect(removed.testsAffected).toEqual([]);
    expect(removed.next).toEqual([]);
  });

  it("folds ids inside another listed id and refuses the root and unknown ids", async () => {
    const builder = agentBuilder();
    expect(refusalOf(await builder.execute("remove_components", { componentIds: ["root"] })).code).toBe("root-component");
    const unknown = refusalOf(await builder.execute("remove_components", { componentIds: ["emial"] }));
    expect(unknown).toMatchObject({ code: "unknown-component", details: { componentId: "emial", closest: "email" } });
    const folded = okOf(await builder.execute("remove_components", { componentIds: ["details", "subscribe"], removeReferences: true }));
    expect(folded).toMatchObject({ removed: ["details"], skipped: [{ id: "subscribe", reason: "nested" }] });
  });
});

describe("caps, limits and blockers", () => {
  it("refuses lists over their caps with too-large", async () => {
    const builder = agentBuilder();
    const before = stateOf(builder);
    const many = refusalOf(await builder.execute("remove_components", { componentIds: Array.from({ length: 501 }, (_, at) => `x${at}`) }));
    expect(many).toMatchObject({ code: "too-large", details: { what: "input", limit: 500, got: 501, key: "componentIds" } });
    const edits = refusalOf(await builder.execute("set_properties", { edits: Array.from({ length: 201 }, () => ({ componentId: "email", propertyPath: "label", value: "x" })) }));
    expect(edits).toMatchObject({ code: "too-large", details: { limit: 200, key: "edits" } });
    const components = refusalOf(await builder.execute("add_components", { components: Array.from({ length: 501 }, () => ({ type: "text" })) }));
    expect(components).toMatchObject({ code: "too-large", details: { limit: 500, key: "components" } });
    const nested = refusalOf(await builder.execute("add_components", { components: Array.from({ length: 5 }, () => ({ type: "fieldset", children: Array.from({ length: 450 }, () => ({ type: "text" })) })) }));
    expect(nested).toMatchObject({ code: "too-large", details: { limit: 2000, key: "components" } });
    expectUnchanged(builder, before, "caps");
  });

  it("refuses a tree past the depth the server reads (structure-limit through the engine's own gate)", async () => {
    const builder = agentBuilder();
    const before = stateOf(builder);
    const refused = refusalOf(await builder.execute("add_components", { components: [deepSpec(31)] }));
    expect(refused.code).toBe("structure-limit");
    expect(refused.message).toMatch(/nest more than 32 levels/);
    expect(refused.hint).toBe("Send fewer or shallower components; the limit is 32 levels.");
    expect(refused.details).toMatchObject({ limit: { name: "levels", max: 32 } });
    // Deeper still, the tool's own count refuses before the engine's gate, in the same words.
    const deeper = refusalOf(await builder.execute("add_components", { components: [deepSpec(32)] }));
    expect(deeper).toMatchObject({ code: "structure-limit", hint: "Send fewer or shallower components; the limit is 32 levels.", details: { limit: { name: "levels", max: 32 } } });
    expectUnchanged(builder, before, "depth");
    okOf(await builder.execute("add_components", { components: [deepSpec(5)], dryRun: true }));
  });

  it("refuses what the host's own definition gate refuses", async () => {
    const definitionProblem = vi.fn((definition: { root: ComponentNode }) => (JSON.stringify(definition.root).includes("too_many") ? "definition.tooManyComponents: the form is too big." : undefined));
    const builder = agentBuilder({ host: { definitionProblem } });
    const refused = refusalOf(await builder.execute("add_components", { components: [{ type: "text", id: "too_many", label: "X" }] }));
    expect(refused).toMatchObject({ code: "structure-limit", details: { problem: "definition.tooManyComponents: the form is too big." } });
    expect(definitionProblem).toHaveBeenCalled();
    okOf(await builder.execute("add_components", { components: [{ type: "text", id: "fine", label: "Y" }] }));
  });

  it("refuses what the inspector's Apply would refuse (blocked-property)", async () => {
    const builder = agentBuilder();
    const before = stateOf(builder);
    const pattern = refusalOf(await builder.execute("add_components", { components: [{ type: "text", id: "code", label: "Code", configuration: { pattern: "[" } }] }));
    expect(pattern).toMatchObject({ code: "blocked-property", details: { componentId: "code", propertyPath: "pattern" } });
    okOf(await builder.execute("add_components", { components: [{ type: "number", id: "age", label: "Age" }] }));
    const mid = stateOf(builder);
    const range = refusalOf(
      await builder.execute("set_properties", {
        edits: [
          { componentId: "age", propertyPath: "min", value: 10 },
          { componentId: "age", propertyPath: "max", value: 5 }
        ]
      })
    );
    expect(range).toMatchObject({ code: "blocked-property", details: { componentId: "age", propertyPath: "max" } });
    expectUnchanged(builder, mid, "range");
    const key = refusalOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath: "dataKey", value: "123" }] }));
    expect(key).toMatchObject({ code: "blocked-property", details: { componentId: "email", propertyPath: "dataKey" } });
    void before;
  });

  it("refuses two components storing their answers in one place (data-path-conflict)", async () => {
    const builder = agentBuilder();
    const before = stateOf(builder);
    const refused = refusalOf(await builder.execute("set_properties", { edits: [{ componentId: "full_name", propertyPath: "dataKey", value: "email" }] }));
    expect(refused.code).toBe("data-path-conflict");
    expect((refused.details as { problems: Array<{ componentIds: string[] }> }).problems[0]?.componentIds).toEqual(["full_name", "email"]);
    const added = refusalOf(await builder.execute("add_components", { components: [{ type: "text", id: "mail", dataKey: "email" }] }));
    expect(added.code).toBe("data-path-conflict");
    expectUnchanged(builder, before, "data paths");
  });

  it("cancels every write before the controller call when the caller's signal already fired", async () => {
    for (const [name, input] of WRITES) {
      const builder = agentBuilder();
      const before = stateOf(builder);
      const aborted = new AbortController();
      aborted.abort();
      const refused = refusalOf(await builder.execute(name, input, { signal: aborted.signal }));
      expect(refused.code, name).toBe("cancelled");
      expectUnchanged(builder, before, name);
    }
  });

  it("cancels every write whose signal fires while it yields to the person, before the controller call", async () => {
    for (const [name, input] of WRITES) {
      const builder = agentBuilder();
      const before = stateOf(builder);
      const aborted = new AbortController();
      // The person's state is read last before the controller call: the signal fires there.
      const original = builder.controller.selectedComponentId.bind(builder.controller);
      vi.spyOn(builder.controller, "selectedComponentId").mockImplementation(() => {
        aborted.abort();
        return original();
      });
      const refused = refusalOf(await builder.execute(name, input, { signal: aborted.signal }));
      expect(refused.code, name).toBe("cancelled");
      expectUnchanged(builder, before, name);
    }
  });

  it("clears the strip's error when the controller refuses a write, and words a slot refusal as the tool's own", async () => {
    const sentence = "phone cannot go in root: Slot content does not allow multiple children.";
    const adding = agentBuilder();
    vi.spyOn(adding.controller, "requestInsertComponents").mockImplementation((_entries, options) => {
      adding.controller.dropError = sentence;
      options?.onResult?.({ ok: false, ids: [], error: sentence });
      return true;
    });
    let before = stateOf(adding);
    const slot = refusalOf(await adding.execute("add_components", { components: [{ type: "text", id: "phone", label: "Phone" }] }));
    expect(slot).toMatchObject({ code: "slot-refused", details: { parentId: "root", slotId: "content", childType: "text", reason: "Slot content does not allow multiple children" } });
    expect(slot.hint).toBe("Use one of details.accepting, or call list_component_types to see which slots take text.");
    expect(adding.controller.dropError).toBeUndefined();
    expectUnchanged(adding, before, "insert refused");

    // A nested child's refusal names the parent the controller's sentence names, not the
    // top-level entry's own parent.
    const nested = agentBuilder();
    const deep = "deep cannot go in box: Slot content does not allow multiple children.";
    vi.spyOn(nested.controller, "requestInsertComponents").mockImplementation((_entries, options) => {
      nested.controller.dropError = deep;
      options?.onResult?.({ ok: false, ids: [], error: deep });
      return true;
    });
    before = stateOf(nested);
    const inner = refusalOf(await nested.execute("add_components", { components: [{ type: "fieldset", id: "box", label: "Box", children: [{ type: "text", id: "deep", label: "Deep" }] }] }));
    expect(inner).toMatchObject({ code: "slot-refused", details: { parentId: "box", childType: "text", reason: "Slot content does not allow multiple children" } });
    expect(nested.controller.dropError).toBeUndefined();
    expectUnchanged(nested, before, "nested insert refused");

    const replacing = agentBuilder();
    vi.spyOn(replacing.controller, "requestReplaceContent").mockImplementation((_nodes, options) => {
      replacing.controller.dropError = "The form could not take it.";
      options?.onResult?.({ ok: false, ids: [], error: "The form could not take it." });
      return true;
    });
    before = stateOf(replacing);
    expect(refusalOf(await replacing.execute("replace_form", { components: [{ type: "text", id: "only", label: "Only" }], keep: ["submit"] })).code).toBe("refused");
    expect(replacing.controller.dropError).toBeUndefined();
    expectUnchanged(replacing, before, "replace refused");

    const moving = agentBuilder();
    vi.spyOn(moving.controller, "requestMoveTo").mockImplementation((_id, _container, _index, _slot, after) => {
      moving.controller.dropError = "Not allowed there.";
      after?.(false, { moved: false, leftEmpty: [] });
      return true;
    });
    before = stateOf(moving);
    expect(refusalOf(await moving.execute("move_component", { componentId: "full_name", index: 2 })).code).toBe("move-refused");
    expect(moving.controller.dropError).toBeUndefined();
    expectUnchanged(moving, before, "move refused");

    const copying = agentBuilder();
    vi.spyOn(copying.controller, "requestDuplicate").mockImplementation(() => {
      copying.controller.dropError = "full_name_copy cannot go in root: Slot content reached max children 5.";
      return true;
    });
    before = stateOf(copying);
    const copy = refusalOf(await copying.execute("duplicate_component", { componentId: "full_name" }));
    expect(copy).toMatchObject({ code: "slot-refused", details: { parentId: "root", childType: "text" } });
    expect(copying.controller.dropError).toBeUndefined();
    expectUnchanged(copying, before, "duplicate refused");
  });
});

describe("move and rename refusals", () => {
  it("refuses a move a slot will not take, listing where it may go", async () => {
    const builder = agentBuilder();
    const before = stateOf(builder);
    const refused = refusalOf(await builder.execute("move_component", { componentId: "details", parentId: "email" }));
    expect(refused).toMatchObject({ code: "move-refused", details: { reason: "slot", message: "A text component does not take children" } });
    expect(refused.message).toBe('"details" cannot go in "email": a text component does not take children.');
    expect((refused.details as { targets: Array<{ parentId: string }> }).targets.map((target) => target.parentId)).toEqual(["root"]);
    const inside = refusalOf(await builder.execute("move_component", { componentId: "details", parentId: "message" }));
    expect((inside.details as { reason: string }).reason).toBe("inside-itself");
    expect(refusalOf(await builder.execute("move_component", { componentId: "root", index: 0 })).code).toBe("root-component");
    expect(refusalOf(await builder.execute("move_component", { componentId: "email", index: 1, after: "topic" })).code).toBe("bad-input");
    expectUnchanged(builder, before, "move");
  });

  it("refuses a rename to a taken or malformed id, and the root", async () => {
    const builder = agentBuilder();
    const before = stateOf(builder);
    const taken = refusalOf(await builder.execute("rename_component", { componentId: "email", newId: "full_name" }));
    expect(taken).toMatchObject({ code: "duplicate-id", message: 'ID "full_name" already exists.', hint: "Pick another id or omit it.", details: { id: "full_name" } });
    expect(refusalOf(await builder.execute("rename_component", { componentId: "email", newId: "2nd" })).code).toBe("invalid-id");
    expect(refusalOf(await builder.execute("rename_component", { componentId: "email", newId: `a${"b".repeat(128)}` })).code).toBe("bad-input");
    expect(refusalOf(await builder.execute("rename_component", { componentId: "root", newId: "form" })).code).toBe("root-component");
    expectUnchanged(builder, before, "rename");
  });
});

describe("fromData meets the same guards as a hand-written list", () => {
  const FROM_DATA: Array<[string, Record<string, unknown>]> = [
    ["add_components", { fromData: { phone: "555" } }],
    ["replace_form", { fromData: { only: "x" } }]
  ];

  it("refuses with unsaved-draft for a draft and a prompt, never raising or answering one, and changes nothing", async () => {
    for (const [name, input] of FROM_DATA) {
      const drafted = agentBuilder();
      drafted.controller.select("email");
      drafted.controller.setDraftProperty("email", "label", "x");
      const before = stateOf(drafted);
      expect(refusalOf(await drafted.execute(name, input)), name).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "email" } });
      expect(drafted.controller.unsavedChangesPrompt(), name).toBeUndefined();
      expectUnchanged(drafted, before, name);

      const prompted = agentBuilder();
      prompted.controller.select("email");
      prompted.controller.setDraftProperty("email", "label", "x");
      prompted.controller.requestSelect("topic");
      expect(prompted.controller.unsavedChangesPrompt(), name).toBeDefined();
      const promptedBefore = stateOf(prompted);
      expect(refusalOf(await prompted.execute(name, input)), name).toMatchObject({ code: "unsaved-draft", details: { reason: "prompt" } });
      expect(prompted.controller.unsavedChangesPrompt(), name).toBeDefined();
      expectUnchanged(prompted, promptedBefore, name);
    }
  });

  it("refuses in a designer (wrong-mode) and in Try it (try-it-on)", async () => {
    for (const [name, input] of FROM_DATA) {
      const designer = agentBuilder({ ui: uiStub({ mode: "pdf" }) });
      const before = stateOf(designer);
      expect(refusalOf(await designer.execute(name, input)), name).toMatchObject({ code: "wrong-mode", details: { mode: "pdf" } });
      expectUnchanged(designer, before, name);
      const trying = agentBuilder({ ui: uiStub({ trying: true, triedAnswers: { topic: "sales" } }) });
      const tryingBefore = stateOf(trying);
      expect(refusalOf(await trying.execute(name, input)), name).toMatchObject({ code: "try-it-on", details: { triedPaths: 1 } });
      expectUnchanged(trying, tryingBefore, name);
    }
  });

  it("refuses while the assistant is stopped, on a stale revision, and when the caller's signal already fired", async () => {
    for (const [name, input] of FROM_DATA) {
      const stub = uiStub();
      const stopped = agentBuilder({ ui: stub });
      okOf(await stopped.execute("begin_session", { purpose: "Build the form" }));
      (stub.state.session as { onStop(): void }).onStop();
      await Promise.resolve();
      const before = stateOf(stopped);
      expect(refusalOf(await stopped.execute(name, input)).code, name).toBe("stopped");
      expectUnchanged(stopped, before, name);

      const stale = agentBuilder();
      const seen = stale.registration.revision();
      okOf(await stale.execute("set_properties", { edits: [{ componentId: "email", propertyPath: "label", value: "Mail" }] }));
      const staleBefore = stateOf(stale);
      expect(refusalOf(await stale.execute(name, { ...input, expectedRevision: seen })).code, name).toBe("stale");
      expectUnchanged(stale, staleBefore, name);

      const cancelled = agentBuilder();
      const aborted = new AbortController();
      aborted.abort();
      const cancelledBefore = stateOf(cancelled);
      expect(refusalOf(await cancelled.execute(name, input, { signal: aborted.signal })).code, name).toBe("cancelled");
      expectUnchanged(cancelled, cancelledBefore, name);
    }
  });

  it("cancels when the signal fires while the planner loads, before the controller call", async () => {
    for (const [name, input] of FROM_DATA) {
      const aborted = new AbortController();
      const builder = agentBuilder({
        host: {
          loadDataModelKit: async () => {
            aborted.abort();
            return (await import("../form-engine/builder/data/data-model-plan-loader.js")).loadDataModelPlan();
          }
        }
      });
      const before = stateOf(builder);
      expect(refusalOf(await builder.execute(name, input, { signal: aborted.signal })).code, name).toBe("cancelled");
      expectUnchanged(builder, before, name);
    }
  });
});
