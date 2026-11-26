import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_EN } from "../form-engine/agent/builder/agent-texts-en.js";
import type { BuilderCallScope } from "../form-engine/agent/builder/context.js";
import { fakePage } from "./fixtures/agent-builder-adapters.js";
import type { BuilderSessionUi } from "../form-engine/agent/builder/host.js";
import type { RegistrarEvent } from "../form-engine/agent/registrar.js";
import { AGENT_BUILDER_DEFINITIONS, agentBuilder, contactRequestRoot, okOf, refusalOf, uiStub, type AgentBuilder } from "./fixtures/agent-builder.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";

/**
 * The builder's session hooks, through the real registrar: begin locks and arms the depth counter, undo
 * goes back to the session's start, a failing step stops the undo without failing the call,
 * Stop undoes and latches, idle expiry pauses, a second begin redraws the banner
 * without a second announcement, the summary banner's Undo all reaches the host through
 * the registrar's link, and the person's own edit dismisses the summary banner and the notice.
 * The last block holds every `agent.*` key the catalogue spells to AGENT_EN.
 */

afterEach(() => {
  vi.useRealTimers();
});

/** Runs controller calls as the catalogue's own write (the writing guard up), as a write tool would. */
function agentWrite(builder: AgentBuilder, run: () => void): number {
  const shared = builder.catalogue.shared;
  const scope = shared.scope({ host: builder.host, signal: new AbortController().signal, revision: () => builder.registration.revision(), session: undefined, state: new Map() });
  return shared.write(scope, run).steps;
}

/** Three history steps, each a plain controller call under the writing guard. */
function threeSteps(builder: AgentBuilder): void {
  expect(agentWrite(builder, () => builder.controller.setProperties([{ componentId: "email", propertyPath: "label", value: "E-mail" }]))).toBe(1);
  expect(agentWrite(builder, () => builder.controller.setProperties([{ componentId: "topic", propertyPath: "label", value: "Subject" }]))).toBe(1);
  expect(agentWrite(builder, () => builder.controller.add("text"))).toBe(1);
}

function lastSessionUi(stub: ReturnType<typeof uiStub>): BuilderSessionUi | undefined {
  return stub.state.session;
}

type CommandsOf = { editor: { history: { peekUndo(): { undo(): void } | undefined } } };

/** Makes the second undo from now really fail: the command under the top one throws when undone. */
function failSecondUndo(builder: AgentBuilder): void {
  const controller = builder.controller;
  const history = (controller as unknown as CommandsOf).editor.history;
  const realUndo = controller.undo.bind(controller);
  let calls = 0;
  vi.spyOn(controller, "undo").mockImplementation(() => {
    calls += 1;
    if (calls === 2) {
      const command = history.peekUndo();
      if (command !== undefined) {
        command.undo = () => {
          throw new Error("boom");
        };
      }
    }
    realUndo();
  });
}

/** The summary or paused banner as the stub holds it. */
function bannerOf(stub: ReturnType<typeof uiStub>): { open: false; summary?: string; undoAvailable: number; onUndoAll?(): void; paused?: true } {
  return lastSessionUi(stub) as { open: false; summary?: string; undoAvailable: number; onUndoAll?(): void; paused?: true };
}

function contentIds(builder: AgentBuilder): string[] {
  return (builder.controller.snapshot().children?.content ?? []).map((node) => node.id);
}

describe("begin_session and end_session on a builder", () => {
  it("begins (bare: not locked), then end_session { undo: true } takes the tree back to where it began", async () => {
    const builder = agentBuilder();
    const before = structuredClone(builder.controller.snapshot());
    const begun = okOf(await builder.execute("begin_session", { purpose: "Renaming two fields" }));
    expect(begun.locked).toBe(false);
    expect(begun.session).toMatchObject({ id: "session-1", purpose: "Renaming two fields", idleTimeoutMs: 45_000 });
    expect(begun.session).not.toHaveProperty("ownSteps");
    threeSteps(builder);
    const ended = okOf(await builder.execute("end_session", { summary: "Reverted.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 3, undoable: 0, steps: 3, componentsAdded: 1, componentsChanged: 2, componentsRemoved: 0, testsWritten: 0 });
    expect(ended.warnings).toBeUndefined();
    expect(builder.controller.snapshot()).toEqual(before);
    expect(builder.controller.canUndo()).toBe(false);
  });

  it("is locked with a page, draws the banner and announces the start once", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const begun = okOf(await builder.execute("begin_session", { purpose: "Adding a section" }));
    expect(begun.locked).toBe(true);
    expect(lastSessionUi(stub)).toMatchObject({ open: true, purpose: "Adding a section" });
    expect(stub.callsOf("announce")).toEqual([["An assistant started working on this form: Adding a section. Press Stop to take over."]]);
  });

  it("is refused while the person has a draft or the prompt is up, never for a focused control", async () => {
    const drafted = agentBuilder({ ui: uiStub() });
    drafted.controller.select("topic");
    drafted.controller.setDraftProperty("topic", "label", "Subject");
    const refused = refusalOf(await drafted.execute("begin_session", { purpose: "x" }));
    expect(refused).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "topic" } });
    // The prompt: a selection change held behind the draft.
    expect(drafted.controller.requestSelect("email")).toBe(false);
    const prompted = refusalOf(await drafted.execute("begin_session", { purpose: "x" }));
    expect(prompted).toMatchObject({ code: "unsaved-draft", details: { reason: "prompt" } });
    expect(drafted.controller.unsavedChangesPrompt()).toBeDefined();

    const focused = agentBuilder({ ui: uiStub({ focusInTextControl: true }) });
    okOf(await focused.execute("begin_session", { purpose: "x" }));
  });

  it("stops at the first step that fails: ok, undone 1, nothing left undoable (the real history)", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "Three edits" }));
    threeSteps(builder);
    // The second step's own command throws on undo, as a command over a tree that no longer
    // holds what it recorded does: CommandHistory empties the undo side with it.
    failSecondUndo(builder);
    const ended = await builder.execute("end_session", { summary: "Tried to revert.", undo: true });
    expect(ended.ok).toBe(true);
    const fields = okOf(ended);
    expect(fields.warnings).toBeUndefined();
    expect(builder.controller.canUndo()).toBe(false);
    expect(builder.controller.dropError).toMatch(/could not be undone \(boom\), nor can the ones before it/);
    expect(fields.session).toMatchObject({ undone: 1, undoable: 0, steps: 3 });
    expect(lastSessionUi(stub)).toMatchObject({ open: false, summary: "Tried to revert.", undoAvailable: 0 });
  });

  it("ends as idle after the timeout: paused banner with Undo all, sessionEnded once", async () => {
    vi.useFakeTimers();
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub, registrarOptions: { idleTimeoutMs: 1_000 } });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    threeSteps(builder);
    vi.advanceTimersByTime(1_001);
    expect(lastSessionUi(stub)).toMatchObject({ open: false, undoAvailable: 3, paused: true });
    expect(stub.callsOf("announce").at(-1)).toEqual(["The assistant paused"]);
    const next = okOf(await builder.execute("describe_builder", {}));
    expect(next.sessionEnded).toEqual({ reason: "idle", undone: 0 });
    const after = okOf(await builder.execute("describe_builder", {}));
    expect(after.sessionEnded).toBeUndefined();
  });

  it("Stop undoes, latches writes (open and reads still run) until Allow again", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    threeSteps(builder);
    const open = lastSessionUi(stub);
    expect(open && "open" in open && open.open).toBe(true);
    (open as { onStop(): void }).onStop();
    await Promise.resolve();
    await Promise.resolve();
    expect(lastSessionUi(stub)).toMatchObject({ stopped: true, undone: 3 });
    expect(stub.callsOf("announce").at(-1)).toEqual(["The assistant was stopped; 3 changes were undone"]);
    expect(builder.controller.canUndo()).toBe(false);
    const write = refusalOf(await builder.execute("history", { action: "redo" }));
    expect(write.code).toBe("stopped");
    expect(refusalOf(await builder.execute("begin_session", { purpose: "again" })).code).toBe("stopped");
    okOf(await builder.execute("open", { panel: "outline" }));
    const described = okOf(await builder.execute("describe_builder", {}));
    expect(described.stopped).toBe(true);
    expect(described.guidance as string[]).toContain("The person stopped you; writes are refused until they allow you again from the banner.");
    (lastSessionUi(stub) as { onAllowAgain(): void }).onAllowAgain();
    expect(okOf(await builder.execute("describe_builder", {})).stopped).toBe(false);
    okOf(await builder.execute("history", { action: "redo", beyondOwn: true }));
  });

  it("a second begin redraws the banner with resumed and the same Stop, and announces nothing", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "First" }));
    const first = lastSessionUi(stub) as { onStop(): void };
    const resumed = okOf(await builder.execute("begin_session", { purpose: "Second" }));
    expect(resumed.resumed).toBe(true);
    expect(lastSessionUi(stub)).toMatchObject({ open: true, purpose: "Second", resumed: true });
    expect((lastSessionUi(stub) as { onStop(): void }).onStop).toBe(first.onStop);
    expect(stub.callsOf("announce")).toHaveLength(1);
  });

  it("the summary banner's Undo all emits one datum-agent-action with the handle, through the link", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ id: "contact-request", ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    threeSteps(builder);
    okOf(await builder.execute("end_session", { summary: "Done." }));
    const banner = lastSessionUi(stub) as { open: false; summary?: string; undoAvailable: number; onUndoAll?(): void };
    expect(banner).toMatchObject({ open: false, summary: "Done.", undoAvailable: 3 });
    const events: RegistrarEvent[] = [];
    builder.registrar.subscribe((event) => events.push(event));
    const emitted = builder.host.calls.length;
    banner.onUndoAll?.();
    const actions = events.filter((event) => event.type === "action");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "action",
      detail: { tool: "end_session", handle: "contact-request", target: "builder", trigger: "agent", input: { undo: true }, outcome: { ok: true }, undoSteps: 3, changed: true }
    });
    expect((actions[0] as { detail: { componentIds: string[] } }).detail.componentIds).toEqual(expect.arrayContaining(["email", "topic"]));
    expect(builder.host.calls.slice(emitted).filter((call) => call.method === "emit" && call.args[0] === "datum-agent-action")).toHaveLength(1);
    expect(builder.controller.canUndo()).toBe(false);
  });

  it("the person's own edit dismisses the summary banner and the notice; a tool write does neither", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    threeSteps(builder);
    okOf(await builder.execute("end_session", { summary: "Done." }));
    const before = stub.calls.length;
    agentWrite(builder, () => builder.controller.add("number"));
    // A tool write neither clears the notice nor hides the banner; the banner is drawn again
    // with the step it added (its Undo all reaches the session's start through it).
    expect(stub.calls.slice(before).filter((call) => call.method === "clearNotice")).toEqual([]);
    expect(stub.calls.slice(before).filter((call) => call.method === "setSessionUi").map((call) => call.args)).toEqual([
      [{ open: false, summary: "Done.", undoAvailable: 4, onUndoAll: expect.any(Function), onDismiss: expect.any(Function) }]
    ]);
    builder.controller.add("text");
    expect(stub.callsOf("clearNotice").length).toBeGreaterThan(0);
    expect(lastSessionUi(stub)).toEqual({ open: false, undoAvailable: 0 });
    const hide = lastSessionUi(stub) as Record<string, unknown>;
    expect(hide.onUndoAll).toBeUndefined();
    expect(hide.paused).toBeUndefined();
  });

  it("reports each transition as a datum-agent-session event on the host", async () => {
    const builder = agentBuilder({ id: "contact-request" });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    okOf(await builder.execute("end_session", { summary: "y" }));
    const phases = builder.host.calls
      .filter((call) => call.method === "emit" && call.args[0] === "datum-agent-session")
      .map((call) => (call.args[1] as { phase: string; handle: string }).phase);
    expect(phases).toEqual(["begin", "end"]);
  });
});

describe("what an ended session leaves on the page follows the history", () => {
  /** The datum-agent-action details the host emitted, in order. */
  function actions(builder: AgentBuilder): Array<{ tool: string; undoSteps?: number }> {
    return builder.host.calls.filter((call) => call.method === "emit" && call.args[0] === "datum-agent-action").map((call) => call.args[1] as { tool: string; undoSteps?: number });
  }

  it("Undo all after the person's own bar Undo stops at the session's start, never in the person's earlier work", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    builder.controller.add("number");
    const beforeSession = structuredClone(builder.controller.snapshot());
    okOf(await builder.execute("begin_session", { purpose: "Two labels" }));
    agentWrite(builder, () => builder.controller.setProperties([{ componentId: "email", propertyPath: "label", value: "E-mail" }]));
    agentWrite(builder, () => builder.controller.setProperties([{ componentId: "topic", propertyPath: "label", value: "Subject" }]));
    okOf(await builder.execute("end_session", { summary: "Done." }));
    expect(bannerOf(stub)).toMatchObject({ undoAvailable: 2 });
    // The person's bar Undo and Redo move the count the banner reads.
    builder.controller.undo();
    expect(bannerOf(stub)).toMatchObject({ open: false, summary: "Done.", undoAvailable: 1 });
    builder.controller.redo();
    expect(bannerOf(stub)).toMatchObject({ undoAvailable: 2 });
    builder.controller.undo();
    const banner = bannerOf(stub);
    banner.onUndoAll?.();
    expect(builder.controller.snapshot()).toEqual(beforeSession);
    expect(builder.controller.canUndo()).toBe(true);
    expect(actions(builder).at(-1)).toMatchObject({ tool: "end_session", undoSteps: 1 });
    // Drawn again with nothing left to undo: the line and Dismiss stay.
    expect(lastSessionUi(stub)).toEqual({ open: false, summary: "Done.", undoAvailable: 0, onUndoAll: expect.any(Function), onDismiss: expect.any(Function) });
  });

  it("after Undo all the banner stays at 0 and goes with the person's next own edit, or with a reseed", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    threeSteps(builder);
    okOf(await builder.execute("end_session", { summary: "Done." }));
    bannerOf(stub).onUndoAll?.();
    expect(bannerOf(stub)).toMatchObject({ open: false, summary: "Done.", undoAvailable: 0 });
    expect(builder.catalogue.shared.memory.banner).toMatchObject({ depth: 0, shown: 0 });
    // The person's Redo of the session's first step brings Undo all (1) back: the banner follows the history.
    builder.controller.redo();
    expect(bannerOf(stub)).toMatchObject({ undoAvailable: 1 });
    builder.controller.add("text");
    expect(lastSessionUi(stub)).toEqual({ open: false, undoAvailable: 0 });
    expect(builder.catalogue.shared.memory.banner).toBeUndefined();

    okOf(await builder.execute("begin_session", { purpose: "y" }));
    agentWrite(builder, () => builder.controller.add("date"));
    okOf(await builder.execute("end_session", { summary: "Again." }));
    bannerOf(stub).onUndoAll?.();
    expect(bannerOf(stub)).toMatchObject({ summary: "Again.", undoAvailable: 0 });
    builder.controller.setOptions({ initialRoot: contactRequestRoot() });
    expect(lastSessionUi(stub)).toEqual({ open: false, undoAvailable: 0 });
  });

  it("the banner's onDismiss lets it go: no undo, redo or history call draws it again, and its Undo all is gone", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    threeSteps(builder);
    okOf(await builder.execute("end_session", { summary: "Done." }));
    const banner = bannerOf(stub) as { onUndoAll?(): void; onDismiss?(): void };
    expect(banner.onDismiss).toEqual(expect.any(Function));
    banner.onDismiss?.();
    expect(builder.catalogue.shared.memory.banner).toBeUndefined();
    const draws = stub.callsOf("setSessionUi").length;
    builder.controller.undo();
    builder.controller.redo();
    okOf(await builder.execute("history", { action: "undo", beyondOwn: true }));
    expect(stub.callsOf("setSessionUi")).toHaveLength(draws);
    // The person's own edit has no banner to take down either.
    builder.controller.add("text");
    expect(stub.callsOf("setSessionUi")).toHaveLength(draws);
    // A stale Dismiss from an earlier banner leaves a newer one alone.
    okOf(await builder.execute("begin_session", { purpose: "y" }));
    agentWrite(builder, () => builder.controller.add("date"));
    okOf(await builder.execute("end_session", { summary: "Again." }));
    banner.onDismiss?.();
    expect(builder.catalogue.shared.memory.banner).toMatchObject({ summary: "Again." });
  });

  it("once the person undid below the session's start, Undo all takes nothing back", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    builder.controller.add("number");
    okOf(await builder.execute("begin_session", { purpose: "One field" }));
    agentWrite(builder, () => builder.controller.add("text"));
    okOf(await builder.execute("end_session", { summary: "Added." }));
    const withNumber = contentIds(builder).length - 1;
    builder.controller.undo();
    builder.controller.undo();
    expect(contentIds(builder)).toHaveLength(withNumber - 1);
    expect(bannerOf(stub)).toMatchObject({ undoAvailable: 0 });
    const before = structuredClone(builder.controller.snapshot());
    bannerOf(stub).onUndoAll?.();
    expect(builder.controller.snapshot()).toEqual(before);
    expect(builder.controller.canRedo()).toBe(true);
    expect(actions(builder).at(-1)).toMatchObject({ tool: "end_session", undoSteps: 0 });
  });

  it("a reseed takes the summary banner and the notice down, and restarts an open session's depth", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    agentWrite(builder, () => builder.controller.add("text"));
    okOf(await builder.execute("end_session", { summary: "Added." }));
    const stale = bannerOf(stub);
    expect(stale).toMatchObject({ undoAvailable: 1 });
    const notices = stub.callsOf("clearNotice").length;
    builder.controller.setOptions({ initialRoot: contactRequestRoot() });
    expect(lastSessionUi(stub)).toEqual({ open: false, undoAvailable: 0 });
    expect(stub.callsOf("clearNotice").length).toBeGreaterThan(notices);
    // The banner's button from before the reseed only hides: no undo, no announcement, no action.
    const announced = stub.callsOf("announce").length;
    const emitted = actions(builder).length;
    stale.onUndoAll?.();
    expect(stub.callsOf("announce")).toHaveLength(announced);
    expect(actions(builder)).toHaveLength(emitted);
    expect(lastSessionUi(stub)).toEqual({ open: false, undoAvailable: 0 });

    okOf(await builder.execute("begin_session", { purpose: "y" }));
    agentWrite(builder, () => builder.controller.add("text"));
    builder.controller.setOptions({ initialRoot: contactRequestRoot() });
    // One write after the reseed: had the depth not restarted, the session would count the step
    // the reseed took away too (2) and the banner would offer to undo it.
    agentWrite(builder, () => builder.controller.add("date"));
    const ended = okOf(await builder.execute("end_session", { summary: "Reseeded." }));
    expect(ended.session).toMatchObject({ undone: 0, undoable: 1 });
    expect(bannerOf(stub)).toMatchObject({ open: false, summary: "Reseeded.", undoAvailable: 1 });
    const withDate = contentIds(builder).length;
    bannerOf(stub).onUndoAll?.();
    expect(contentIds(builder)).toHaveLength(withDate - 1);
    expect(builder.controller.canUndo()).toBe(false);
    expect(actions(builder).at(-1)).toMatchObject({ tool: "end_session", undoSteps: 1 });
  });

  it("the person's bar Undo that fails after the end takes the banner's count and the own steps to 0", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    agentWrite(builder, () => builder.controller.setProperties([{ componentId: "email", propertyPath: "label", value: "E-mail" }]));
    agentWrite(builder, () => builder.controller.setProperties([{ componentId: "topic", propertyPath: "label", value: "Subject" }]));
    okOf(await builder.execute("end_session", { summary: "Done." }));
    expect(bannerOf(stub)).toMatchObject({ undoAvailable: 2 });
    // The top command throws when undone, as one over a tree that no longer holds what it recorded
    // does; the bar's Undo is a plain controller call, outside the catalogue's own undo path.
    const command = (builder.controller as unknown as CommandsOf).editor.history.peekUndo();
    expect(command).toBeDefined();
    command!.undo = () => {
      throw new Error("boom");
    };
    builder.controller.undo();
    expect(builder.controller.canUndo()).toBe(false);
    expect(builder.controller.dropError).toMatch(/could not be undone/);
    expect(bannerOf(stub)).toMatchObject({ open: false, summary: "Done.", undoAvailable: 0 });
    const described = okOf(await builder.execute("describe_builder", {}));
    expect(described.undo).toMatchObject({ ownSteps: 0, canUndo: false });
  });

  it("a rebuild takes the summary banner and the stopped banner down", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    agentWrite(builder, () => builder.controller.add("text"));
    okOf(await builder.execute("end_session", { summary: "Added." }));
    const stale = bannerOf(stub);
    builder.registration.runtimeReplaced();
    expect(lastSessionUi(stub)).toEqual({ open: false, undoAvailable: 0 });
    const ids = contentIds(builder);
    stale.onUndoAll?.();
    expect(contentIds(builder)).toEqual(ids);

    okOf(await builder.execute("begin_session", { purpose: "y" }));
    agentWrite(builder, () => builder.controller.add("date"));
    (lastSessionUi(stub) as { onStop(): void }).onStop();
    await Promise.resolve();
    await Promise.resolve();
    expect(lastSessionUi(stub)).toMatchObject({ stopped: true });
    builder.registration.runtimeReplaced();
    expect(lastSessionUi(stub)).toEqual({ open: false, undoAvailable: 0 });
  });

  it("unregister takes the banner down, so its Undo all never reaches the person's later edit", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    agentWrite(builder, () => builder.controller.add("text"));
    okOf(await builder.execute("end_session", { summary: "Added." }));
    const stale = bannerOf(stub);
    builder.connection.abort();
    await Promise.resolve();
    expect(lastSessionUi(stub)).toEqual({ open: false, undoAvailable: 0 });
    builder.controller.add("number");
    const ids = contentIds(builder);
    stale.onUndoAll?.();
    expect(contentIds(builder)).toEqual(ids);
  });
});

/** A tool call's scope, as a body gets it from `shared.scope`. */
function scopeOf(builder: AgentBuilder): BuilderCallScope {
  return builder.catalogue.shared.scope({ host: builder.host, signal: new AbortController().signal, revision: () => builder.registration.revision(), session: undefined, state: new Map() });
}

/** The notice the stub last showed: its text and its button, if any. */
function lastNotice(stub: ReturnType<typeof uiStub>): { text: string; action?: { label: string; run(): void } } {
  const calls = stub.callsOf("notice");
  const [text, action] = calls[calls.length - 1] as [string, { label: string; run(): void } | undefined];
  return action === undefined ? { text } : { text, action };
}

describe("the notice under a journaled write", () => {
  it("runs that call's outside-journal entries on Undo (steps 0, journaled)", () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const page = fakePage(builder.controller, { tryIt: false });
    stub.state.journeys = page.journeys.side();
    const journal = builder.catalogue.shared.journal;
    const scope = scopeOf(builder);
    const capture = journal.captureCatalog("journeys", "intake");
    builder.catalogue.shared.write(scope, () => page.journeys.actions.rename("intake", "Renamed"));
    journal.record(scope, { kind: "catalog", side: "journeys", action: "rename", id: "intake", before: capture! });
    // An entry of another call is not this notice's.
    const other = scopeOf(builder);
    const before = JSON.parse(JSON.stringify(builder.controller.trySubmission()));
    builder.catalogue.shared.write(other, () => builder.controller.setTrySubmission({ outcome: "fail" }));
    journal.record(other, { kind: "settings", trySubmission: { before } });
    builder.catalogue.shared.show(scope, { ids: [], announce: AGENT_EN["agent.did.document"], undoSteps: 0, journaled: { call: scope.call } });
    const notice = lastNotice(stub);
    expect(notice.action?.label).toBe(AGENT_EN["agent.undo"]);
    notice.action?.run();
    expect(page.journeys.configuration.journeys?.[0]?.name).toBe("Intake");
    expect(builder.controller.trySubmission().outcome).toBe("fail");
    expect(journal.forCall(scope.call)).toEqual([]);
    expect(journal.forCall(other.call)).toHaveLength(1);
  });

  it("takes back the call's form step and its journaled layout step together (create_form_fields)", () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const page = fakePage(builder.controller, { tryIt: false });
    const layout = contactLayout();
    page.pdf.state.layoutController = layout;
    stub.state.pdf = page.pdf.side();
    const shared = builder.catalogue.shared;
    const scope = scopeOf(builder);
    shared.followLayout(scope, "cra-t2125", layout);
    const around = shared.around(scope);
    around(() => builder.controller.add("text"));
    around(() => layout.setProperties([{ componentId: "root", propertyPath: "label", value: "mapped" }]));
    shared.journal.record(scope, { kind: "layout-steps", layoutId: "cra-t2125", steps: 1 });
    expect(layout.canUndo()).toBe(true);
    expect(shared.memory.ownSteps).toBe(1);
    const added = contentIds(builder).length;
    shared.show(scope, { ids: [], announce: "x", undoSteps: 1, journaled: { call: scope.call } });
    lastNotice(stub).action?.run();
    expect(contentIds(builder)).toHaveLength(added - 1);
    expect(layout.canUndo()).toBe(false);
  });

  it("offers Restore under a document remove_part removed, and it puts the document back", () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const page = fakePage(builder.controller, { tryIt: false });
    stub.state.pdf = page.pdf.side();
    const journal = builder.catalogue.shared.journal;
    const scope = scopeOf(builder);
    const before = JSON.parse(JSON.stringify(page.pdf.configuration));
    const capture = journal.captureRemoval("pdf", "cra-t2125");
    builder.catalogue.shared.write(scope, () => page.pdf.actions.remove("cra-t2125"));
    journal.record(scope, { kind: "removed", ...capture! });
    builder.catalogue.shared.show(scope, { ids: [], announce: AGENT_EN["agent.did.removePart"], undoSteps: 0, journaled: { call: scope.call, restore: true } });
    const notice = lastNotice(stub);
    expect(notice.action?.label).toBe("Restore");
    notice.action?.run();
    expect(JSON.parse(JSON.stringify(page.pdf.configuration))).toEqual(before);
  });

  it("shows no button under a save", () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const scope = scopeOf(builder);
    builder.catalogue.shared.journal.record(scope, { kind: "save", revision: 1 });
    builder.catalogue.shared.show(scope, { ids: [], announce: AGENT_EN["agent.did.save"], undoSteps: 0, noButton: true });
    expect(lastNotice(stub)).toEqual({ text: "Assistant saved the form" });
  });
});

/** A layout's controller over the fixture's types (one per layout). */
function contactLayout(): BuilderController {
  return new BuilderController({ initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } }, componentDefinitions: AGENT_BUILDER_DEFINITIONS });
}

describe("the catalogue's person-facing words", () => {
  it("every agent.* key spelled under agent/builder/ exists in AGENT_EN (plural keys as their .one / .other pair)", () => {
    const folder = join(dirname(fileURLToPath(import.meta.url)), "../form-engine/agent/builder");
    const keys = new Set(Object.keys(AGENT_EN));
    const spelled = new Set<string>();
    // The walk reads every module of the folder, the body modules among them.
    expect(readdirSync(folder)).toEqual(expect.arrayContaining(["agentpart-try.ts", "agentpart-languages.ts", "agentpart-documents.ts", "save-tool.ts", "outside-journal.ts"]));
    for (const file of readdirSync(folder)) {
      if (!file.endsWith(".ts")) {
        continue;
      }
      const text = readFileSync(join(folder, file), "utf8");
      for (const match of text.matchAll(/["']agent\.[a-z0-9.]+["']/giu)) {
        spelled.add(match[0].slice(1, -1));
      }
    }
    expect(spelled.size).toBeGreaterThan(5);
    for (const key of spelled) {
      const known = keys.has(key) || (keys.has(`${key}.one`) && keys.has(`${key}.other`));
      expect(known, key).toBe(true);
    }
  });
});
