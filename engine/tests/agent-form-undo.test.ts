import { describe, expect, it } from "vitest";

import type { AgentActionDetail, AgentSessionUi } from "../form-engine/agent/index.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { FormDraft } from "../form-engine/persistence/core/draft-store.js";
import { AGENT_SINGLE_FORM, agentSetup, personTypes } from "./fixtures/agent-form.js";

/**
 * undo_agent_changes: the journal's replay, scope
 * defaults, the person's later edits kept by value comparison, rows the agent added or removed,
 * an undo of an undo, the paths filter, the 200-entry cap, and that restoring works after Stop.
 */

type Row = Record<string, unknown>;

/** The single form with the grid's bounds widened and reorder allowed. */
function withGrid(configuration: Record<string, unknown>): FormDefinition {
  const content = (AGENT_SINGLE_FORM.root.children as { content: ComponentNode[] }).content.map((node) =>
    node.id === "grid" ? { ...node, configuration: { label: "Expenses", minRows: 0, maxRows: 10, initialRows: 0, ...configuration } } : node
  );
  return { ...AGENT_SINGLE_FORM, root: { ...AGENT_SINGLE_FORM.root, children: { content } } };
}

describe("undo_agent_changes", () => {
  it("defaults to 'all' without a session and restores every agent write, newest first, with display text", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    personTypes(setup.runtime, { name: "Person" });
    await setup.ok("set_answers", { answers: { name: "Agent", age: 30 } });
    await setup.ok("set_answers", { answers: { colour: "red", start: "2026-01-02" } });
    setup.host.calls.length = 0;
    const result = await setup.ok("undo_agent_changes");
    expect(result).toMatchObject({ rowsRemoved: [], rowsRestored: [], kept: [], undoneCalls: 2, remaining: 1, partial: false });
    expect(result.restored).toEqual([
      { path: "colour", value: null, display: "" },
      { path: "start", value: null, display: "" },
      { path: "name", value: "Person", display: "Person" },
      { path: "age", value: null, display: "" }
    ]);
    expect(setup.runtime.formValues()).toMatchObject({ name: "Person" });
    expect(setup.runtime.formValues().age).toBeUndefined();
    expect(setup.host.calls.find((call) => call.method === "announce")?.args).toEqual(["4 changes by the assistant were undone"]);
    expect(setup.host.calls.find((call) => call.method === "reveal")?.args).toEqual([["colour"]]);
    // The undo is itself a write call on record: 'last' undoes it.
    const redo = await setup.ok("undo_agent_changes", { scope: "last" });
    expect((redo.restored as Row[]).map((entry) => [entry.path, entry.value])).toEqual([
      ["colour", "red"],
      ["start", "2026-01-02"],
      ["name", "Agent"],
      ["age", 30]
    ]);
    expect(setup.runtime.formValues()).toMatchObject({ name: "Agent", age: 30, colour: "red" });
    expect(redo.remaining).toBe(1);
  });

  it("keeps a field the person edited after the agent, by value comparison, and says so in a note", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    await setup.ok("set_answers", { answers: { name: "Agent", age: 30 } });
    personTypes(setup.runtime, { name: "Person again" });
    const result = await setup.ok("undo_agent_changes");
    expect(result.restored).toEqual([{ path: "age", value: null, display: "" }]);
    expect(result.kept).toEqual([{ path: "name", reason: "person-edited" }]);
    expect(result.partial).toBe(true);
    expect(result.note).toEqual(["The person changed 'Full name' after you did; it was left as they set it."]);
    expect(setup.runtime.formValues().name).toBe("Person again");
  });

  it("'last' undoes only the most recent write call; 'session' only what the session wrote", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    await setup.ok("set_answers", { answers: { name: "One" } });
    await setup.ok("begin_session", { purpose: "Second" });
    await setup.ok("set_answers", { answers: { age: 20 } });
    await setup.ok("set_answers", { answers: { colour: "red" } });
    const last = await setup.ok("undo_agent_changes", { scope: "last" });
    expect((last.restored as Row[]).map((entry) => entry.path)).toEqual(["colour"]);
    expect(last.undoneCalls).toBe(1);
    const session = await setup.ok("undo_agent_changes");
    expect((session.restored as Row[]).map((entry) => entry.path)).toEqual(["age"]);
    expect(setup.runtime.formValues().name).toBe("One");
    // On record: the write before the session and the two undo entries (each undoable with 'last').
    expect(session.remaining).toBe(3);
    const nothing = await setup.refused("undo_agent_changes", { scope: "session" });
    expect(nothing).toMatchObject({ code: "nothing-to-undo", hint: "Nothing to do.", details: {} });
  });

  it("removes a row the agent added only while nobody typed in it, and puts a removed row back at its index", async () => {
    const setup = agentSetup(withGrid({ canReorder: true }));
    await setup.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 1 } });
    await setup.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 2 } });
    personTypes(setup.runtime, { "grid[1].category": "taxi" });
    const result = await setup.ok("undo_agent_changes");
    expect(result.rowsRemoved).toEqual([{ collection: "grid", index: 0 }]);
    expect(result.kept).toEqual([{ collection: "grid", index: 1, reason: "person-edited" }]);
    expect(setup.runtime.rows("grid")).toEqual([{ when: undefined, amount: 2, category: "taxi" }]);

    const removal = agentSetup(withGrid({ canReorder: true }));
    personTypes(removal.runtime, { "grid[0].amount": 10, "grid[1].amount": 20, "grid[2].amount": 30 });
    await removal.ok("edit_rows", { collection: "grid", action: "remove", index: 1, force: true });
    expect(removal.runtime.rows("grid").map((row) => row.amount)).toEqual([10, 30]);
    const restored = await removal.ok("undo_agent_changes");
    expect(restored.rowsRestored).toEqual([{ collection: "grid", index: 1 }]);
    expect(removal.runtime.rows("grid").map((row) => row.amount)).toEqual([10, 20, 30]);

    const noReorder = agentSetup(withGrid({}));
    personTypes(noReorder.runtime, { "grid[0].amount": 10, "grid[1].amount": 20 });
    await noReorder.ok("edit_rows", { collection: "grid", action: "remove", index: 0, force: true });
    const appended = await noReorder.ok("undo_agent_changes");
    expect(appended.rowsRestored).toEqual([{ collection: "grid", index: 1 }]);
    expect(noReorder.runtime.rows("grid").map((row) => row.amount)).toEqual([20, 10]);

    const locked = agentSetup(withGrid({ canAdd: false }));
    personTypes(locked.runtime, { "grid[0].amount": 10 });
    await locked.ok("edit_rows", { collection: "grid", action: "remove", index: 0, force: true });
    const kept = await locked.ok("undo_agent_changes");
    expect(kept.kept).toEqual([{ collection: "grid", index: 0, reason: "rows-not-addable" }]);
    expect(kept.partial).toBe(true);
  });

  it("restores a table the agent replaced whole, and the paths filter narrows the replay", async () => {
    const setup = agentSetup(withGrid({}));
    personTypes(setup.runtime, { "grid[0].amount": 1 });
    await setup.ok("set_answers", { answers: { grid: [{ amount: 5 }, { amount: 6 }], name: "Agent" } });
    const onlyGrid = await setup.ok("undo_agent_changes", { paths: ["grid"] });
    expect((onlyGrid.restored as Row[]).map((entry) => entry.path)).toEqual(["grid"]);
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([1]);
    expect(setup.runtime.formValues().name).toBe("Agent");
    const rest = await setup.ok("undo_agent_changes");
    expect((rest.restored as Row[]).map((entry) => entry.path)).toEqual(["name"]);
    const none = await setup.refused("undo_agent_changes", { paths: ["age"] });
    expect(none.code).toBe("nothing-to-undo");
    const unknownPath = await setup.refused("undo_agent_changes", { paths: ["bad path!"] });
    expect(unknownPath).toMatchObject({ code: "bad-input", details: { problems: [{ key: "paths[0]" }] } });
  });

  it("holds 200 entries, dropping the oldest, and reports what remains", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    for (let index = 0; index < 205; index += 1) {
      await setup.ok("set_answers", { answers: { age: 18 + (index % 50) } });
    }
    const last = await setup.ok("undo_agent_changes", { scope: "last" });
    expect(last.remaining).toBe(199 + 1);
    expect(last.undoneCalls).toBe(1);
  });

  it("keeps the field the person is typing in (field-in-use) outside a session, and the entry stays undoable once the caret leaves", async () => {
    let focused: string | undefined;
    const setup = agentSetup(AGENT_SINGLE_FORM, { host: { focusedValuePath: () => focused } });
    await setup.ok("set_answers", { answers: { name: "Agent", age: 30 } });
    focused = "name";
    const result = await setup.ok("undo_agent_changes");
    expect(result.kept).toEqual([{ path: "name", reason: "field-in-use" }]);
    expect((result.restored as Row[]).map((entry) => entry.path)).toEqual(["age"]);
    // The agent's value still stands in `name`: its entry is narrowed to that path, not dropped
    // the undo's own entry (age) is the other one on record.
    expect(result.remaining).toBe(2);
    expect(setup.runtime.formValues().name).toBe("Agent");
    focused = undefined;
    const later = await setup.ok("undo_agent_changes");
    expect(later.restored).toEqual([{ path: "name", value: null, display: "" }]);
    expect(later.kept).toEqual([]);
    expect(setup.runtime.formValues().name).toBeUndefined();
    expect((await setup.refused("undo_agent_changes")).code).toBe("nothing-to-undo");
  });

  it("a paths filter leaves the entry's other fields on record for a later undo", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    await setup.ok("set_answers", { answers: { name: "Agent", age: 30 } });
    const onlyName = await setup.ok("undo_agent_changes", { paths: ["name"] });
    expect((onlyName.restored as Row[]).map((entry) => entry.path)).toEqual(["name"]);
    expect(setup.runtime.formValues().age).toBe(30);
    const rest = await setup.ok("undo_agent_changes");
    expect((rest.restored as Row[]).map((entry) => entry.path)).toEqual(["age"]);
    expect(setup.runtime.formValues().age).toBeUndefined();
  });

  it("works while the person has pressed Stop, and refuses busy during a submission", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM, { hooks: { beforeSubmit: [() => new Promise<void>(() => undefined)] } });
    await setup.ok("set_answers", { answers: { name: "Agent" } });
    await setup.ok("begin_session", { purpose: "Work" });
    await setup.ok("set_answers", { answers: { age: 30 } });
    const banner = setup.host.calls.find((call) => call.method === "setSessionUi")?.args[0] as { onStop(): void };
    banner.onStop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const write = await setup.refused("set_answers", { answers: { age: 31 } });
    expect(write.code).toBe("stopped");
    expect(setup.runtime.formValues().age).toBeUndefined();
    const undo = await setup.ok("undo_agent_changes");
    expect((undo.restored as Row[]).map((entry) => entry.path)).toEqual(["name"]);
    personTypes(setup.runtime, { name: "Ada", "grid[0].amount": 1 });
    void setup.runtime.submit("embed", { form: { id: "single", version: "1.0.0" }, client: { runtimeVersion: "t", rendererVersion: "t", schemaVersion: "1.0.0" } }, {});
    const busy = await setup.refused("undo_agent_changes");
    expect(busy).toMatchObject({ code: "busy", details: { because: "submission" } });
  });
});

describe("undo keeps the person's rows whatever index they hold", () => {
  it("keeps an agent-added row the person typed into at the lower index and removes the untouched higher one", async () => {
    const setup = agentSetup(withGrid({}));
    await setup.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 1 } });
    await setup.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 2 } });
    personTypes(setup.runtime, { "grid[0].category": "taxi" });
    const result = await setup.ok("undo_agent_changes");
    expect(result.rowsRemoved).toEqual([{ collection: "grid", index: 1 }]);
    expect(result.kept).toEqual([{ collection: "grid", index: 0, reason: "person-edited" }]);
    expect(result.partial).toBe(true);
    expect(setup.runtime.rows("grid").map((row) => [row.amount, row.category])).toEqual([[1, "taxi"]]);
  });

  it("after the person deleted the agent's row, undo leaves the person's own row in its place", async () => {
    const setup = agentSetup(withGrid({}));
    await setup.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 99 } });
    setup.runtime.addRow("grid", {});
    personTypes(setup.runtime, { "grid[1].amount": 10 });
    setup.runtime.removeRow("grid", 0);
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([10]);
    const result = await setup.ok("undo_agent_changes");
    expect(result.rowsRemoved).toEqual([]);
    expect(result.kept).toEqual([{ collection: "grid", index: 0, reason: "person-edited" }]);
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([10]);

    // The agent's row deleted by the person is simply gone: nothing to remove, nothing kept.
    const gone = agentSetup(withGrid({}));
    gone.runtime.addRow("grid", {});
    personTypes(gone.runtime, { "grid[0].amount": 10 });
    await gone.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 99 } });
    gone.runtime.removeRow("grid", 1);
    const nothing = await gone.ok("undo_agent_changes");
    expect(nothing).toMatchObject({ rowsRemoved: [], kept: [], partial: false });
    expect(gone.runtime.rows("grid").map((row) => row.amount)).toEqual([10]);
  });

  it("'last' undoes an undo that put a table back: the agent's rows return", async () => {
    const setup = agentSetup(withGrid({}));
    personTypes(setup.runtime, { "grid[0].amount": 1 });
    await setup.ok("set_answers", { answers: { grid: [{ amount: 5 }, { amount: 6 }] } });
    const undone = await setup.ok("undo_agent_changes");
    expect((undone.restored as Row[]).map((entry) => entry.path)).toEqual(["grid"]);
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([1]);
    const redone = await setup.ok("undo_agent_changes", { scope: "last" });
    expect(redone.restored).toEqual([{ path: "grid", value: [{ amount: 5 }, { amount: 6 }], display: "2 rows" }]);
    expect(redone.kept).toEqual([]);
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([5, 6]);
    // And 'last' once more undoes the redo; the undo's own entries never count as agent writes for 'all'.
    const again = await setup.ok("undo_agent_changes", { scope: "last" });
    expect((again.restored as Row[]).map((entry) => entry.path)).toEqual(["grid"]);
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([1]);
    expect((await setup.refused("undo_agent_changes", { scope: "all" })).code).toBe("nothing-to-undo");
  });

  it("after the person reshaped the table, a stale index never removes a row of theirs, even an empty one", async () => {
    const setup = agentSetup(withGrid({}));
    setup.runtime.addRow("grid", {});
    personTypes(setup.runtime, { "grid[0].amount": 10 });
    await setup.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 99 } });
    setup.runtime.addRow("grid", {});
    setup.runtime.removeRow("grid", 1);
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([10, undefined]);
    const result = await setup.ok("undo_agent_changes");
    expect(result.rowsRemoved).toEqual([]);
    expect(result.kept).toEqual([{ collection: "grid", index: 1, reason: "person-edited" }]);
    expect(setup.runtime.rows("grid").length).toBe(2);

    // The person's reshape makes the table theirs: even the agent's own row,
    // left where it was by a removal below it, is kept once its cells were marked the person's.
    const below = agentSetup(withGrid({}));
    below.runtime.addRow("grid", {});
    personTypes(below.runtime, { "grid[0].amount": 10 });
    await below.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 99 } });
    below.runtime.addRow("grid", {});
    below.runtime.removeRow("grid", 2);
    const theirs = await below.ok("undo_agent_changes");
    expect(theirs.rowsRemoved).toEqual([]);
    expect(theirs.kept).toEqual([{ collection: "grid", index: 1, reason: "person-edited" }]);
    expect(below.runtime.rows("grid").map((row) => row.amount)).toEqual([10, 99]);

    // Without a reshape, the person's add alone leaves the indexes valid: the agent's row goes.
    const added = agentSetup(withGrid({}));
    added.runtime.addRow("grid", {});
    personTypes(added.runtime, { "grid[0].amount": 10 });
    await added.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 99 } });
    added.runtime.addRow("grid", {});
    const removed = await added.ok("undo_agent_changes");
    expect(removed.rowsRemoved).toEqual([{ collection: "grid", index: 1 }]);
    expect(added.runtime.rows("grid").map((row) => row.amount)).toEqual([10, undefined]);
  });

  it("a table the agent replaced goes back whole only while every non-empty cell is still its own", async () => {
    const setup = agentSetup(withGrid({}));
    personTypes(setup.runtime, { "grid[0].amount": 1 });
    await setup.ok("set_answers", { answers: { grid: [{ amount: 5 }, { amount: 6 }] } });
    // The person deletes one of the agent's rows: the table is theirs now.
    setup.runtime.removeRow("grid", 1);
    const kept = await setup.ok("undo_agent_changes");
    expect(kept.kept).toEqual([{ collection: "grid", reason: "person-edited" }]);
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([5]);
  });
});

describe("the banner's Undo all event", () => {
  it("carries the handle and the revision and reaches the registrar's subscribe() stream", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM, { host: { id: "claim" } });
    const seen: AgentActionDetail[] = [];
    setup.registrar.subscribe((event) => {
      if (event.type === "action") {
        seen.push(event.detail);
      }
    });
    await setup.ok("begin_session", { purpose: "Work" });
    await setup.ok("set_answers", { answers: { name: "InSession" } });
    await setup.ok("end_session", { summary: "Done." });
    seen.length = 0;
    const banner = setup.host.calls
      .filter((call) => call.method === "setSessionUi")
      .map((call) => call.args[0] as AgentSessionUi)
      .at(-1) as { open: false; onUndoAll?(): void };
    banner.onUndoAll?.();
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }
    expect(setup.runtime.formValues().name).toBeUndefined();
    const undo = seen.find((detail) => detail.tool === "undo_agent_changes");
    expect(undo).toMatchObject({ target: "form", handle: "claim", readOnly: false, input: { scope: "session" }, outcome: { ok: true }, trigger: "agent", paths: ["name"], changed: true });
    expect(typeof undo?.revision).toBe("number");
    expect(undo?.revision).toBe(setup.registration.revision());
    expect(undo).not.toHaveProperty("sessionId");
    // The element's event is the same detail.
    const emitted = setup.host.calls.filter((call) => call.method === "emit" && call.args[0] === "datum-agent-action").map((call) => call.args[1]).at(-1);
    expect(emitted).toEqual(undo);
  });
});

describe("writers before, own @ answers, a restored draft", () => {
  /** The last writer get_answers reports for a path (absent: none). */
  async function writerOf(setup: ReturnType<typeof agentSetup>, path: string): Promise<unknown> {
    const answers = await setup.ok("get_answers", { includeEmpty: true });
    return (answers.answers as Row[]).find((answer) => answer.path === path)?.lastWriter;
  }

  it("an undone value goes back to the writer it had: the person's answer is theirs again, an unanswered field has none", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    personTypes(setup.runtime, { name: "Person" });
    await setup.ok("set_answers", { answers: { name: "Agent", age: 30 } });
    expect(await writerOf(setup, "name")).toBe("agent");
    await setup.ok("undo_agent_changes");
    expect(await writerOf(setup, "name")).toBe("other");
    expect(await writerOf(setup, "age")).toBeUndefined();
    // The undo's own entry recorded the agent's marks, so undoing the undo gives them back too.
    await setup.ok("undo_agent_changes", { scope: "last" });
    expect(setup.runtime.formValues()).toMatchObject({ name: "Agent", age: 30 });
    expect(await writerOf(setup, "name")).toBe("agent");
  });

  it("a row the agent removed comes back with its cells' writers and the table's own", async () => {
    const setup = agentSetup(withGrid({}));
    setup.runtime.addRow("grid", {});
    personTypes(setup.runtime, { "grid[0].amount": 4 });
    await setup.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 9 } });
    await setup.ok("edit_rows", { collection: "grid", action: "remove", index: 0, force: true });
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([9]);
    await setup.ok("undo_agent_changes", { scope: "last" });
    // This table does not reorder, so the row is appended; its marks follow it to where it landed.
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([9, 4]);
    expect(await writerOf(setup, "grid[0].amount")).toBe("agent");
    expect(await writerOf(setup, "grid[1].amount")).toBe("other");
  });

  it("the undo description says a restored draft starts a new record (exact, appended)", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const description = setup.registrar.tools().find((tool) => tool.name === "undo_agent_changes")?.description ?? "";
    expect(description.endsWith(" Not possible after the form was submitted. A draft restored with drafts { action: 'restore' } starts a new record: changes from before it cannot be undone.")).toBe(true);
  });

  it("draft-restored once a saved draft replaced the answers after the agent's last write; nothing-to-undo before any write", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM, { drafts: {} });
    expect((await setup.refused("undo_agent_changes")).code).toBe("nothing-to-undo");
    await setup.ok("set_answers", { answers: { name: "Ada" } });
    await setup.ok("drafts", { action: "save" });
    await setup.ok("drafts", { action: "restore", replaceAnswers: true });
    const refused = await setup.refused("undo_agent_changes", { scope: "last" });
    expect(refused).toMatchObject({ code: "draft-restored", retryable: false, hint: "A saved draft replaced the answers; changes made before it cannot be undone." });
  });

  it("a host's restore before the agent ever wrote, or one a later agent write superseded, leaves nothing-to-undo", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM, { drafts: {} });
    // The host's own restore at page start (the element never auto-restores): nothing of the agent's was replaced.
    await setup.runtime.hydrateFromDraft({
      id: "claim-ana",
      formId: "single",
      formVersion: "1.0.0",
      runtime: { schemaVersion: "1.0.0", rendererVersion: "agent-test" },
      locale: "en",
      values: { name: "Person" },
      state: { touched: [], dirty: [] },
      updatedAt: 1
    } satisfies FormDraft);
    expect(setup.runtime.formValues().name).toBe("Person");
    expect((await setup.refused("undo_agent_changes")).code).toBe("nothing-to-undo");
    // A write after the restore, kept whole by the person's later edit: the journal is empty
    // again, but the restore is older than the agent's write, so still nothing-to-undo.
    await setup.ok("set_answers", { answers: { age: 30 } });
    personTypes(setup.runtime, { age: 31 });
    const kept = await setup.ok("undo_agent_changes");
    expect(kept).toMatchObject({ restored: [], kept: [{ path: "age", reason: "person-edited" }] });
    expect((await setup.refused("undo_agent_changes")).code).toBe("nothing-to-undo");
    expect(setup.runtime.formValues().age).toBe(31);
  });

  it("submitted, not draft-restored, once the page submitted after the restore", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM, { drafts: {} });
    personTypes(setup.runtime, { "grid[0].amount": 1 });
    await setup.ok("set_answers", { answers: { name: "Ada" } });
    await setup.ok("drafts", { action: "save" });
    await setup.ok("drafts", { action: "restore", replaceAnswers: true });
    expect((await setup.refused("undo_agent_changes")).code).toBe("draft-restored");
    const outcome = await setup.runtime.submit("embed", { form: { id: "single", version: "1.0.0" }, client: { runtimeVersion: "t", rendererVersion: "t", schemaVersion: "1.0.0" } }, {});
    expect(outcome.accepted).toBe(true);
    const refused = await setup.refused("undo_agent_changes");
    expect(refused.code).toBe("submitted");
  });

  it("undoing the agent's added row gives the table's own mark back to the person (writersBefore on rows-added)", async () => {
    const setup = agentSetup(withGrid({}));
    setup.runtime.addRow("grid", { amount: 4 });
    expect(setup.registration.provenance("page")?.tables).toEqual([]);
    await setup.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 9 } });
    expect(setup.registration.provenance("page")?.tables).toEqual(["grid"]);
    await setup.ok("undo_agent_changes", { scope: "last" });
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([4]);
    expect(setup.registration.provenance("page")?.tables).toEqual([]);
    expect(await writerOf(setup, "grid")).toBe("other");
  });
});
