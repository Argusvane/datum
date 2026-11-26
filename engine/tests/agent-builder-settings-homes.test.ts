import { describe, expect, it, vi } from "vitest";

import { BuilderWords, type BuilderTextCatalog } from "../form-engine/builder/logic/builder-texts.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { AGENT_BUILDER_DEFINITIONS, AGENT_BUILDER_PALETTE, agentBuilder, contactRequestRoot, okOf, refusalOf, uiStub } from "./fixtures/agent-builder.js";

/**
 * Where `set_properties` reaches the form itself: `target: "identity"` changes the form's id, version or schemaVersion within the
 * kernel's limits, is journaled (on no controller history) and reversed by Undo all, and is
 * `protected-setting { by: "host" }` when the host owns the identity; every path the site lists
 * in `managedSettings` is refused, as is a write to an ancestor that would replace one; and the
 * header and footer parts go through the renderer's reader first, so a part it would drop is
 * `blocked-property`. The author's `agentTools` switch is
 * `protected-setting { by: "author" }` on the root, and `history` puts back a step that moves it.
 */

const IDENTITY = { id: "contact-request", version: "1.0.0", schemaVersion: "1" };

function identityEdit(propertyPath: string, value: unknown, componentId = "root"): Record<string, unknown> {
  return { componentId, target: "identity", propertyPath, value };
}

function rootConfiguration(builder: ReturnType<typeof agentBuilder>): Record<string, unknown> {
  return (builder.controller.snapshot().configuration ?? {}) as Record<string, unknown>;
}

describe("target: identity", () => {
  it("changes the version, journaled and off the history, with the reverse call and the note", async () => {
    const builder = agentBuilder();
    const revision = builder.registration.revision();
    const result = okOf(await builder.execute("set_properties", { edits: [identityEdit("version", "1.3.0")] }));
    expect(result).toMatchObject({
      written: [],
      identity: { before: IDENTITY, after: { ...IDENTITY, version: "1.3.0" } },
      undo: { steps: 0, canUndo: false, journaled: true },
      reverse: { tool: "set_properties", input: { edits: [identityEdit("version", "1.0.0")] } },
      note: ["The identity change is not on the undo history; Undo all restores it."]
    });
    expect(builder.controller.identity()).toEqual({ ...IDENTITY, version: "1.3.0" });
    // The silent write still moves the revision (the fingerprint).
    expect(builder.registration.revision()).toBe(revision + 1);
    expect(builder.controller.canUndo()).toBe(false);
  });

  it("adds the new-id note when the id changes, and trims what it is given", async () => {
    const builder = agentBuilder();
    const result = okOf(await builder.execute("set_properties", { edits: [identityEdit("id", "  contact-us  ")] }));
    expect(builder.controller.identity()?.id).toBe("contact-us");
    expect(result.note).toEqual(["The identity change is not on the undo history; Undo all restores it.", "Sites store forms by id; tell the person the form now saves under the new id."]);
  });

  it("is no write when the value is the form's own", async () => {
    const builder = agentBuilder();
    const revision = builder.registration.revision();
    const result = okOf(await builder.execute("set_properties", { edits: [identityEdit("version", "1.0.0")] }));
    expect(result).toMatchObject({ written: [], undo: { steps: 0 } });
    expect(result.identity).toBeUndefined();
    expect(result.reverse).toBeUndefined();
    expect(builder.registration.revision()).toBe(revision);
  });

  it("holds the kernel's limits and the shape: bad-input before anything is written", async () => {
    const builder = agentBuilder();
    const before = builder.controller.identity();
    const cases: Array<[Record<string, unknown>, string]> = [
      [identityEdit("id", "x".repeat(129)), "edits[0].value"],
      [identityEdit("version", "v".repeat(65)), "edits[0].value"],
      [identityEdit("schemaVersion", "s".repeat(65)), "edits[0].value"],
      [identityEdit("version", "   "), "edits[0].value"],
      [identityEdit("version", null), "edits[0].value"],
      [identityEdit("version", 2), "edits[0].value"],
      [identityEdit("title", "x"), "edits[0].propertyPath"],
      [identityEdit("version", "2", "email"), "edits[0].componentId"]
    ];
    for (const [edit, key] of cases) {
      const refused = refusalOf(await builder.execute("set_properties", { edits: [edit] }));
      expect(refused, JSON.stringify(edit)).toMatchObject({ code: "bad-input" });
      expect((refused.details as { problems: Array<{ key: string }> }).problems[0]?.key, JSON.stringify(edit)).toBe(key);
    }
    // An id at the limit is fine.
    okOf(await builder.execute("set_properties", { edits: [identityEdit("id", "x".repeat(128))] }));
    expect(builder.controller.identity()).not.toEqual(before);
    expect(refusalOf(await builder.execute("set_properties", { edits: [identityEdit("version", "2", "nowhere")] })).code).toBe("unknown-component");
  });

  it("is protected-setting { by: host } when the host owns the identity, and under partial lands in skipped", async () => {
    const controller = new BuilderController({ initialRoot: contactRequestRoot(), componentDefinitions: AGENT_BUILDER_DEFINITIONS, componentTypes: AGENT_BUILDER_PALETTE });
    expect(controller.identity()).toBeUndefined();
    const builder = agentBuilder({ controller });
    const refused = refusalOf(await builder.execute("set_properties", { edits: [identityEdit("version", "2.0.0")] }));
    expect(refused).toMatchObject({ code: "protected-setting", retryable: false, details: { propertyPath: "version", by: "host" } });
    expect(refused.hint).toBe("The site manages this setting; tell the person.");
    const partial = okOf(
      await builder.execute("set_properties", { partial: true, edits: [identityEdit("version", "2.0.0"), { componentId: "email", propertyPath: "label", value: "Mail" }] })
    );
    expect(partial.skipped).toEqual([{ componentId: "root", propertyPath: "version", code: "protected-setting", details: { propertyPath: "version", by: "host" } }]);
    expect(partial.written).toHaveLength(1);
    expect(controller.identity()).toBeUndefined();
  });

  it("refuses with unsaved-draft while the person has the form root's draft open, raising no prompt", async () => {
    const builder = agentBuilder();
    builder.controller.select("root");
    builder.controller.setDraftIdentity({ ...IDENTITY, version: "9.9.9" });
    expect(builder.controller.hasPendingChanges("root")).toBe(true);
    const refused = refusalOf(await builder.execute("set_properties", { edits: [identityEdit("version", "2.0.0")] }));
    expect(refused).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "root" } });
    expect(builder.controller.unsavedChangesPrompt()).toBeUndefined();
    expect(builder.controller.identity()?.version).toBe("1.0.0");
  });

  it("goes with configuration edits of the same call: one history step, one journal entry", async () => {
    const builder = agentBuilder();
    const result = okOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath: "label", value: "Mail" }, identityEdit("version", "2.0.0")] }));
    expect(result).toMatchObject({ undo: { steps: 1, journaled: true }, identity: { after: { version: "2.0.0" } } });
    expect(result.written).toHaveLength(1);
    expect(builder.catalogue.shared.journal.forCall(builder.catalogue.shared.memory.outside[0]?.call as string)).toHaveLength(1);
  });

  it("announces both the property change and the identity change when one call makes both", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath: "label", value: "Mail" }, identityEdit("id", "new-id")] }));
    expect(stub.callsOf("announce")).toEqual([["Assistant changed 1 property on Mail. Assistant changed the form's identity"]]);
    // An identity-only call keeps its own sentence.
    okOf(await builder.execute("set_properties", { edits: [identityEdit("version", "2.0.0")] }));
    expect(stub.callsOf("announce").at(-1)).toEqual(["Assistant changed the form's identity"]);
  });

  it("joins the two announced sentences through the catalogue, not a hard-coded separator", async () => {
    const stub = uiStub();
    const words = new BuilderWords();
    words.locale = "xx";
    words.catalog = { xx: { "agent.did.setAndIdentity": "{set} / {identity}" } } as unknown as BuilderTextCatalog;
    const builder = agentBuilder({ ui: stub, host: { words: () => words } });
    okOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath: "label", value: "Mail" }, identityEdit("id", "new-id")] }));
    expect(stub.callsOf("announce")).toEqual([["Assistant changed 1 property on Mail / Assistant changed the form's identity"]]);
  });

  it("is restored by Undo all (end_session { undo: true }) and by the reverse call", async () => {
    const builder = agentBuilder();
    okOf(await builder.execute("begin_session", { purpose: "Versioning" }));
    okOf(await builder.execute("set_properties", { edits: [identityEdit("version", "2.0.0")] }));
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 1 });
    expect(builder.controller.identity()).toEqual(IDENTITY);

    const changed = okOf(await builder.execute("set_properties", { edits: [identityEdit("version", "3.0.0"), identityEdit("schemaVersion", "2")] }));
    expect(builder.controller.identity()).toEqual({ ...IDENTITY, version: "3.0.0", schemaVersion: "2" });
    okOf(await builder.execute((changed.reverse as { tool: string }).tool, (changed.reverse as { input: unknown }).input));
    expect(builder.controller.identity()).toEqual(IDENTITY);
  });

  it("leaves a later change of the person's own when Undo all runs (kept, person-edited)", async () => {
    const builder = agentBuilder();
    okOf(await builder.execute("begin_session", { purpose: "Versioning" }));
    okOf(await builder.execute("set_properties", { edits: [identityEdit("version", "2.0.0")] }));
    builder.controller.setIdentity({ ...IDENTITY, version: "5.0.0" });
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 0 });
    expect(builder.controller.identity()?.version).toBe("5.0.0");
  });

  it("announces on a page and offers Undo through the journal", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("set_properties", { edits: [identityEdit("version", "2.0.0")] }));
    expect(stub.callsOf("announce")).toEqual([["Assistant changed the form's identity"]]);
    const [, action] = stub.callsOf("notice")[0] as [string, { label: string; run(): void }];
    expect(action.label).toBe("Undo");
    action.run();
    expect(builder.controller.identity()).toEqual(IDENTITY);
  });
});

describe("paths the site manages", () => {
  const withManaged = (...paths: string[]): ReturnType<typeof agentBuilder> => agentBuilder({ ui: uiStub({ managed: paths }) });

  it("refuses an edit whose path is a managed one or under it, writing nothing (all or nothing)", async () => {
    const builder = withManaged("data.answersFree", "title");
    const before = builder.controller.snapshot();
    const exact = refusalOf(await builder.execute("set_properties", { edits: [{ componentId: "root", propertyPath: "title", value: "Other" }] }));
    expect(exact).toMatchObject({ code: "protected-setting", details: { propertyPath: "title", by: "host" } });
    expect(exact.hint).toBe("The site manages this setting; tell the person.");
    const under = refusalOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath: "label", value: "Mail" }, { componentId: "root", propertyPath: "data.answersFree.mode", value: "x" }] }));
    expect(under).toMatchObject({ code: "protected-setting", details: { propertyPath: "data.answersFree", by: "host" } });
    expect(builder.controller.snapshot()).toEqual(before);
  });

  it("lists the managed edits in skipped under partial and writes the rest", async () => {
    const builder = withManaged("title");
    const result = okOf(
      await builder.execute("set_properties", {
        partial: true,
        edits: [
          { componentId: "root", propertyPath: "title", value: "Other" },
          { componentId: "email", propertyPath: "label", value: "Mail" }
        ]
      })
    );
    expect(result.skipped).toEqual([{ componentId: "root", propertyPath: "title", code: "protected-setting", details: { propertyPath: "title", by: "host" } }]);
    expect(result.written).toEqual([expect.objectContaining({ componentId: "email", propertyPath: "label" })]);
    expect(rootConfiguration(builder).title).toBe("Contact request");
  });

  it("refuses a write to an ancestor that would replace a protected descendant, naming it", async () => {
    const root = contactRequestRoot();
    root.configuration = { ...(root.configuration ?? {}), data: { answersFree: true, other: 1 } };
    const builder = agentBuilder({ root, ui: uiStub({ managed: ["data.answersFree"] }) });
    const replaced = refusalOf(await builder.execute("set_properties", { edits: [{ componentId: "root", propertyPath: "data", value: { other: 2 } }] }));
    expect(replaced).toMatchObject({ code: "protected-setting", details: { propertyPath: "data.answersFree", by: "host" } });
    const cleared = refusalOf(await builder.execute("set_properties", { edits: [{ componentId: "root", propertyPath: "data", value: null }] }));
    expect(cleared.code).toBe("protected-setting");
    expect((rootConfiguration(builder).data as Record<string, unknown>).other).toBe(1);
    // A parent write that leaves the descendant as it is passes.
    okOf(await builder.execute("set_properties", { edits: [{ componentId: "root", propertyPath: "data", value: { answersFree: true, other: 2 } }] }));
    expect((rootConfiguration(builder).data as Record<string, unknown>).other).toBe(2);
  });

  it("lets a parent write through while the protected descendant is absent and stays absent", async () => {
    const builder = withManaged("data.answersFree");
    okOf(await builder.execute("set_properties", { edits: [{ componentId: "root", propertyPath: "data", value: { other: 1 } }] }));
    expect((rootConfiguration(builder).data as Record<string, unknown>).other).toBe(1);
    const sets = refusalOf(await builder.execute("set_properties", { edits: [{ componentId: "root", propertyPath: "data", value: { answersFree: true } }] }));
    expect(sets).toMatchObject({ code: "protected-setting", details: { propertyPath: "data.answersFree" } });
  });

  it("reads the list at the call (a site that lists nothing refuses nothing)", async () => {
    const stub = uiStub({ managed: [] });
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("set_properties", { edits: [{ componentId: "root", propertyPath: "title", value: "Other" }] }));
    stub.state.managed = ["title"];
    expect(refusalOf(await builder.execute("set_properties", { edits: [{ componentId: "root", propertyPath: "title", value: "Third" }] })).code).toBe("protected-setting");
  });
});

describe("agentTools, the author's switch", () => {
  const AUTHOR = { propertyPath: "agentTools", by: "author" };
  const edit = (value: unknown, propertyPath = "agentTools", componentId = "root"): Record<string, unknown> => ({ componentId, propertyPath, value });

  it("refuses the path on the root, writing nothing, with the author's message and hint", async () => {
    const builder = agentBuilder();
    const before = builder.controller.snapshot();
    const revision = builder.registration.revision();
    const refused = refusalOf(await builder.execute("set_properties", { edits: [edit("allowed")] }));
    expect(refused).toMatchObject({
      code: "protected-setting",
      retryable: false,
      message: "agentTools is the form author's switch for assistants; nothing was written.",
      hint: "Whether assistants may fill this form is the author's choice in Form settings; tell the person.",
      details: AUTHOR
    });
    expect(builder.controller.snapshot()).toEqual(before);
    expect(builder.registration.revision()).toBe(revision);
    expect(builder.controller.canUndo()).toBe(false);
  });

  it("refuses a path under it, and a value of null (removing the switch is the author's too)", async () => {
    const builder = agentBuilder();
    expect(refusalOf(await builder.execute("set_properties", { edits: [edit("x", "agentTools.mode")] })).details).toEqual(AUTHOR);
    expect(refusalOf(await builder.execute("set_properties", { edits: [edit(null)] })).details).toEqual(AUTHOR);
    expect(rootConfiguration(builder)).not.toHaveProperty("agentTools");
  });

  it("lists it in skipped under partial, by author, and writes the rest", async () => {
    const builder = agentBuilder();
    const result = okOf(await builder.execute("set_properties", { partial: true, edits: [edit("off"), edit("Other", "title")] }));
    expect(result.skipped).toEqual([{ componentId: "root", propertyPath: "agentTools", code: "protected-setting", details: AUTHOR }]);
    expect(result.written).toEqual([expect.objectContaining({ componentId: "root", propertyPath: "title" })]);
    expect(rootConfiguration(builder).title).toBe("Other");
    expect(rootConfiguration(builder)).not.toHaveProperty("agentTools");
  });

  it("answers by host when the site lists agentTools as managed (the host check runs first)", async () => {
    const builder = agentBuilder({ ui: uiStub({ managed: ["agentTools"] }) });
    const refused = refusalOf(await builder.execute("set_properties", { edits: [edit("off")] }));
    expect(refused).toMatchObject({ message: "agentTools is managed by the site; nothing was written.", hint: "The site manages this setting; tell the person.", details: { propertyPath: "agentTools", by: "host" } });
  });

  it("leaves other components' agentTools and the rules target alone (an ordinary unknown property)", async () => {
    const builder = agentBuilder();
    const other = okOf(await builder.execute("set_properties", { edits: [edit("off", "agentTools", "email")] }));
    expect(other.written).toHaveLength(1);
    expect(other.warnings).toEqual(expect.arrayContaining([expect.stringContaining("unknown-property")]));
    expect(rootConfiguration(builder)).not.toHaveProperty("agentTools");
  });
});

describe("history and the author's switch (the five steps)", () => {
  function agentWrite(builder: ReturnType<typeof agentBuilder>, run: () => void): void {
    const shared = builder.catalogue.shared;
    const scope = shared.scope({ host: builder.host, signal: new AbortController().signal, revision: () => builder.registration.revision(), session: undefined, state: new Map() });
    shared.write(scope, run);
  }
  const switchOf = (builder: ReturnType<typeof agentBuilder>): unknown => rootConfiguration(builder).agentTools;

  /** The person adds a field and sets the switch; the assistant then adds two components of its own. */
  function scene(): ReturnType<typeof agentBuilder> {
    const builder = agentBuilder();
    builder.controller.add("number");
    builder.controller.setProperty("root", "agentTools", "allowed");
    agentWrite(builder, () => builder.controller.add("text"));
    agentWrite(builder, () => builder.controller.add("date"));
    return builder;
  }

  it("puts back the step that moved the switch and stops, the steps before it stay applied", async () => {
    const builder = scene();
    const memory = builder.catalogue.shared.memory;
    expect(memory).toMatchObject({ ownSteps: 2, ownCeiling: 2 });
    const show = vi.spyOn(builder.catalogue.shared, "show");
    const before = builder.controller.snapshot().children?.content?.length;
    const refused = refusalOf(await builder.execute("history", { action: "undo", steps: 5, beyondOwn: true }));
    expect(refused).toMatchObject({
      code: "protected-setting",
      message: "A step changed agentTools, the form author's switch for assistants, so it was put back and history stopped there; the steps before it stayed applied.",
      hint: "Whether assistants may fill this form is the author's choice in Form settings; tell the person.",
      details: { propertyPath: "agentTools", by: "author", applied: 2 }
    });
    expect(refused.details).not.toHaveProperty("reversed");
    // The two assistant steps were undone; the person's setting is back, and so is its step on the history.
    expect(switchOf(builder)).toBe("allowed");
    expect(builder.controller.snapshot().children?.content?.length).toBe((before ?? 0) - 2);
    expect(builder.controller.canUndo()).toBe(true);
    expect(builder.controller.canRedo()).toBe(true);
    // The redo ceiling stands where it stood before the offending step (the undo of a step that is not the
    // assistant's zeroes it, and the reversal alone would not bring it back). ownSteps and callSteps net out to
    // their old values through the undo and its reversal in every state the history can reach, so they are
    // pinned here as the values they hold, and the white-box redo case below makes ownSteps observable.
    expect(memory).toMatchObject({ ownSteps: 0, ownCeiling: 2, callSteps: 0 });
    // The kept steps are shown and announced as a successful call's: their ids, never the root.
    expect(show).toHaveBeenCalledTimes(1);
    const shown = show.mock.calls[0]?.[1] as unknown as { ids: string[]; undoSteps: number; redo: boolean };
    expect(shown.undoSteps).toBe(2);
    expect(shown.redo).toBe(true);
    expect(shown.ids).not.toContain("root");
    expect(shown.ids.length).toBeGreaterThan(0);
    expect(memory.collect).toBeUndefined();
  });

  it("shows and announces nothing when the very first step moves the switch (applied 0)", async () => {
    const builder = agentBuilder();
    builder.controller.setProperty("root", "agentTools", "off");
    const show = vi.spyOn(builder.catalogue.shared, "show");
    const refused = refusalOf(await builder.execute("history", { action: "undo", beyondOwn: true }));
    expect(refused).toMatchObject({ code: "protected-setting", details: { propertyPath: "agentTools", by: "author", applied: 0 } });
    expect(switchOf(builder)).toBe("off");
    expect(show).not.toHaveBeenCalled();
  });

  it("guards a redo the same way", async () => {
    const builder = agentBuilder();
    builder.controller.setProperty("root", "agentTools", "allowed");
    builder.controller.undo();
    expect(switchOf(builder)).toBeUndefined();
    const refused = refusalOf(await builder.execute("history", { action: "redo", beyondOwn: true }));
    expect(refused.details).toEqual({ propertyPath: "agentTools", by: "author", applied: 0 });
    expect(switchOf(builder)).toBeUndefined();
    expect(builder.controller.canRedo()).toBe(true);
  });

  it("gives ownSteps back after the reversal of a redo (white-box: the state the history alone cannot reach)", async () => {
    const builder = agentBuilder();
    builder.controller.setProperty("root", "agentTools", "allowed");
    builder.controller.undo();
    const memory = builder.catalogue.shared.memory;
    // Without the restore the redo leaves ownSteps at 1 (the ceiling is met) and the undo that puts the step
    // back takes it to 0; the restore keeps the value from before the offending step.
    memory.ownSteps = 1;
    memory.ownCeiling = 1;
    const refused = refusalOf(await builder.execute("history", { action: "redo", beyondOwn: true }));
    expect(refused.details).toEqual({ propertyPath: "agentTools", by: "author", applied: 0 });
    expect(switchOf(builder)).toBeUndefined();
    expect(memory).toMatchObject({ ownSteps: 1, ownCeiling: 1, callSteps: 0 });
  });

  it("notes reversed: false when the step cannot be put back, and fits the history to what it still holds", async () => {
    const builder = agentBuilder();
    builder.controller.setProperty("root", "agentTools", "allowed");
    const controller = builder.controller;
    const memory = builder.catalogue.shared.memory;
    // A ceiling beyond what the history can redo once the reversal failed and took the redo side along.
    memory.ownSteps = 1;
    memory.ownCeiling = 3;
    vi.spyOn(controller, "redo").mockImplementation(() => {
      controller.dropError = "This step could not be redone, nor can the ones after it.";
      vi.spyOn(controller, "canRedo").mockReturnValue(false);
    });
    const refused = refusalOf(await builder.execute("history", { action: "undo", beyondOwn: true }));
    expect(refused.details).toEqual({ propertyPath: "agentTools", by: "author", applied: 0, reversed: false });
    // The switch stays where the undo left it (the reversal failed), and fitHistory ran as for any failed step.
    expect(switchOf(builder)).toBeUndefined();
    expect(memory).toMatchObject({ ownSteps: 0, ownCeiling: 0 });
  });

  it("does not interfere with a history that never touches the switch", async () => {
    const builder = scene();
    const done = okOf(await builder.execute("history", { action: "undo", steps: 2 }));
    expect(done).toMatchObject({ done: 2 });
    expect(switchOf(builder)).toBe("allowed");
  });
});

describe("header and footer parts", () => {
  const edit = (propertyPath: string, value: unknown): Record<string, unknown> => ({ componentId: "root", propertyPath, value });
  const chrome = (builder: ReturnType<typeof agentBuilder>): Record<string, unknown> | undefined => rootConfiguration(builder).chrome as Record<string, unknown> | undefined;

  it("writes parts the reader keeps", async () => {
    const builder = agentBuilder();
    okOf(await builder.execute("set_properties", { edits: [edit("chrome.header", [{ id: "welcome", type: "text", text: "Welcome" }, { id: "row", type: "group", parts: [{ id: "title", type: "form-title" }] }])] }));
    expect((chrome(builder)?.header as unknown[]).length).toBe(2);
    okOf(await builder.execute("set_properties", { edits: [edit("chrome", { footer: [{ id: "thanks", type: "text", text: "Thanks" }] })] }));
    expect((chrome(builder)?.footer as unknown[]).length).toBe(1);
    okOf(await builder.execute("set_properties", { edits: [edit("chrome.header", null)] }));
    expect(chrome(builder)?.header).toBeUndefined();
  });

  it("refuses a part the reader would drop: blocked-property naming the part", async () => {
    const builder = agentBuilder();
    const before = builder.controller.snapshot();
    const unknown = refusalOf(await builder.execute("set_properties", { edits: [edit("chrome.header", [{ id: "a", type: "text", text: "ok" }, { id: "b", type: "carousel" }])] }));
    expect(unknown).toMatchObject({ code: "blocked-property", details: { componentId: "root", propertyPath: "chrome.header", message: "Part 1 has an unknown type, no id, or a group inside a group." } });
    const footer = refusalOf(await builder.execute("set_properties", { edits: [edit("chrome.footer", [{ id: "logo", type: "image" }])] }));
    expect(footer).toMatchObject({ code: "blocked-property", details: { propertyPath: "chrome.footer", message: "Part 0 has an unknown type, no id, or a group inside a group." } });
    // A part without an id has no key for its translations: the reader drops it, so the write is refused.
    const noId = refusalOf(await builder.execute("set_properties", { edits: [edit("chrome.header", [{ type: "text", text: "no id" }])] }));
    expect(noId).toMatchObject({ code: "blocked-property", details: { propertyPath: "chrome.header", message: "Part 0 has an unknown type, no id, or a group inside a group." } });
    const inGroup = refusalOf(await builder.execute("set_properties", { edits: [edit("chrome.header", [{ id: "row", type: "group", parts: [{ id: "a", type: "text", text: "ok" }, { id: "b", type: "nope" }] }])] }));
    expect(inGroup.code).toBe("blocked-property");
    const notAList = refusalOf(await builder.execute("set_properties", { edits: [edit("chrome.header", { type: "text" })] }));
    expect(notAList.code).toBe("blocked-property");
    expect(builder.controller.snapshot()).toEqual(before);
  });

  it("refuses a part id the header and footer share: translations are keyed by it, unique across both", async () => {
    const builder = agentBuilder();
    const before = builder.controller.snapshot();
    const shared = refusalOf(await builder.execute("set_properties", { edits: [edit("chrome", { header: [{ id: "note", type: "text", text: "Top" }], footer: [{ id: "note", type: "text", text: "Bottom" }] })] }));
    expect(shared).toMatchObject({ code: "blocked-property", details: { propertyPath: "chrome", message: 'The part id "note" is used twice; every header and footer part needs an id of its own, unique across both.' } });
    expect(builder.controller.snapshot()).toEqual(before);
    okOf(await builder.execute("set_properties", { edits: [edit("chrome", { header: [{ id: "note", type: "text", text: "Top" }], footer: [{ id: "note_2", type: "text", text: "Bottom" }] })] }));
    expect((chrome(builder)?.footer as Array<{ id: string }>)[0]?.id).toBe("note_2");
  });

  it("checks the header and footer of a write to chrome itself", async () => {
    const builder = agentBuilder();
    const bypass = refusalOf(await builder.execute("set_properties", { edits: [edit("chrome", { header: [{ id: "a", type: "carousel" }], frame: "seamless" })] }));
    expect(bypass).toMatchObject({ code: "blocked-property", details: { propertyPath: "chrome.header" } });
    expect(chrome(builder)).toBeUndefined();
    // A chrome write that leaves the regions alone passes.
    okOf(await builder.execute("set_properties", { edits: [edit("chrome", { frame: "seamless" })] }));
    expect(chrome(builder)?.frame).toBe("seamless");
  });

  it("does not fault a region the call left as it was", async () => {
    const root: ComponentNode = contactRequestRoot();
    root.configuration = { ...(root.configuration ?? {}), chrome: { header: [{ type: "carousel" }] } };
    const builder = agentBuilder({ root });
    okOf(await builder.execute("set_properties", { edits: [edit("chrome.frame", "seamless")] }));
    expect(chrome(builder)?.frame).toBe("seamless");
  });
});
