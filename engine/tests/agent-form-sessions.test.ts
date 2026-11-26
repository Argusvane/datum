import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFormAgentTools } from "../form-engine/agent/form/tools.js";
import { runtimeAgentHost, type AgentSessionUi } from "../form-engine/agent/form/host.js";
import { createAgentRegistrar, retryableFor } from "../form-engine/agent/registrar.js";
import { SESSION_IDLE_TIMEOUT_MS } from "../form-engine/agent/session-tools.js";
import type { AgentRefusal } from "../form-engine/agent/tool-types.js";
import { InMemoryDraftStore } from "../form-engine/persistence/local-storage/in-memory-draft-store.js";
import { AGENT_SINGLE_FORM, AGENT_VERSION_CONTEXT, TRAVEL_CLAIM_FORM, agentRuntime, agentSetup, personTypes } from "./fixtures/agent-form.js";

/**
 * The renderer's session hooks through the registrar:
 * settleInput before the lock, pausedTyping, begin never refused for a
 * focused field, `locked` per host, Stop and the latch, Allow again, idle expiry, the end
 * counts, `undo: true`, and `retryable` on every refusal.
 */

type Row = Record<string, unknown>;

function bannerCalls(setup: ReturnType<typeof agentSetup>): AgentSessionUi[] {
  return setup.host.calls.filter((call) => call.method === "setSessionUi").map((call) => call.args[0] as AgentSessionUi);
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe("begin_session on the renderer", () => {
  it("settles the person's typing before the lock, reports pausedTyping, locks nothing on a node host, announces", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM, { host: { focusedValuePath: () => "name" } });
    const result = await setup.ok("begin_session", { purpose: "Filling your claim" });
    expect(result).toMatchObject({ session: { id: "session-1", purpose: "Filling your claim", idleTimeoutMs: 45_000, revisionAtBegin: 1 }, locked: false, pausedTyping: true });
    const methods = setup.host.calls.map((call) => call.method);
    expect(methods.indexOf("settleInput")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("settleInput")).toBeLessThan(methods.indexOf("setSessionUi"));
    const banner = bannerCalls(setup)[0];
    expect(banner).toMatchObject({ open: true, purpose: "Filling your claim" });
    expect(typeof (banner as { onStop(): void }).onStop).toBe("function");
    expect(setup.host.calls.find((call) => call.method === "announce")?.args).toEqual(["An assistant started working on this form: Filling your claim. Press Stop to take over."]);
    // A write to the focused field is allowed inside the session.
    const written = await setup.ok("set_answers", { answers: { name: "Ada" } });
    expect((written.written as Row[]).map((entry) => entry.path)).toEqual(["name"]);
  });

  it("reports locked: true on a host that locks a UI, and false pausedTyping when nothing had focus", async () => {
    const runtime = agentRuntime(AGENT_SINGLE_FORM);
    const host = runtimeAgentHost(runtime);
    host.locksUi = true;
    const registrar = createAgentRegistrar();
    registrar.registerForm({ host, catalogue: createFormAgentTools, signal: new AbortController().signal });
    const result = (await registrar.execute("begin_session", { purpose: "x" })) as Row;
    expect(result).toMatchObject({ ok: true, locked: true, pausedTyping: false });
  });

  it("is idempotent while open and refused busy during a submission", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM, { hooks: { beforeSubmit: [() => new Promise<void>(() => undefined)] } });
    const first = await setup.ok("begin_session", { purpose: "One" });
    const second = await setup.ok("begin_session", { purpose: "Two" });
    expect(second).toMatchObject({ session: { id: (first.session as Row).id, purpose: "Two" }, resumed: true });
    // The resumed begin redraws the banner with the new purpose.
    expect(bannerCalls(setup)).toHaveLength(2);
    expect(bannerCalls(setup)[1]).toMatchObject({ open: true, purpose: "Two", resumed: true });
    await setup.ok("end_session", { summary: "Done." });
    personTypes(setup.runtime, { name: "Ada", "grid[0].amount": 1 });
    void setup.runtime.submit("embed", { form: { id: "single", version: "1.0.0" }, client: { runtimeVersion: "t", rendererVersion: "t", schemaVersion: "1.0.0" } }, {});
    const busy = await setup.refused("begin_session", { purpose: "Three" });
    expect(busy).toMatchObject({ code: "busy", retryable: true, details: { because: "submission" } });
    expect(bannerCalls(setup).filter((banner) => "open" in banner && banner.open)).toHaveLength(2);
  });
});

describe("end_session on the renderer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the session's fields, rows and pages and shows the summary banner with Undo all", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    await setup.ok("set_answers", { answers: { colour: "red" } });
    await setup.ok("begin_session", { purpose: "Work" });
    await setup.ok("set_answers", { answers: { name: "Ada", age: 30 } });
    await setup.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 2 } });
    await setup.ok("edit_rows", { collection: "grid", action: "remove", index: 0 });
    vi.setSystemTime(25_000);
    const result = await setup.ok("end_session", { summary: "Filled your name and age." });
    expect(result).toMatchObject({
      wasOpen: true,
      session: { id: "session-1", durationMs: 15_000, calls: 3, undone: 0, fieldsWritten: 2, rowsAdded: 1, rowsRemoved: 1, pagesMoved: 0, undoable: 3 }
    });
    const banner = bannerCalls(setup).at(-1) as { open: false; summary?: string; undoAvailable: boolean; onUndoAll?(): void };
    expect(banner).toMatchObject({ open: false, summary: "Filled your name and age.", undoAvailable: true });
    expect(setup.host.calls.filter((call) => call.method === "announce").at(-1)?.args).toEqual(["The assistant finished: Filled your name and age."]);
    // Undo all on the summary banner restores the session's writes, not the one before it.
    banner.onUndoAll?.();
    await flush();
    expect(setup.runtime.formValues().name).toBeUndefined();
    expect(setup.runtime.formValues().colour).toBe("red");
    const none = await setup.ok("end_session", { summary: "Again." });
    expect(none).toMatchObject({ wasOpen: false, note: ["No session was open; nothing to end."] });
  });

  it("end_session { undo: true } restores the session's writes first and reports the count", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    await setup.ok("begin_session", { purpose: "Work" });
    await setup.ok("set_answers", { answers: { name: "Ada", age: 30 } });
    const result = await setup.ok("end_session", { summary: "Nothing kept.", undo: true });
    // The counts read the journal since the boundary, which the undo has just emptied.
    expect(result).toMatchObject({ wasOpen: true, session: { undone: 2, fieldsWritten: 0, undoable: 0 } });
    expect(bannerCalls(setup).at(-1)).toMatchObject({ open: false, undoAvailable: false });
    expect(setup.runtime.formValues().name).toBeUndefined();
    expect(setup.runtime.formValues().age).toBeUndefined();
  });

  it("idle expiry ends the session as paused, with the banner, and the next result carries sessionEnded once", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    await setup.ok("begin_session", { purpose: "Work" });
    await setup.ok("set_answers", { answers: { name: "Ada" } });
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS + 1);
    expect(bannerCalls(setup).at(-1)).toMatchObject({ open: false, undoAvailable: true });
    expect(setup.host.calls.filter((call) => call.method === "announce").at(-1)?.args).toEqual(["The assistant paused"]);
    const next = await setup.ok("describe_form");
    expect(next.sessionEnded).toEqual({ reason: "idle", undone: 0 });
    expect((next.status as Row).session).toBeNull();
    const after = await setup.ok("describe_form");
    expect(after.sessionEnded).toBeUndefined();
    expect(setup.runtime.formValues().name).toBe("Ada");
  });
});

describe("Stop and Allow again", () => {
  it("Stop undoes the session's writes, latches writes and begin_session as stopped, leaves reads and undo working, Allow again clears", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    personTypes(setup.runtime, { colour: "red" });
    await setup.ok("set_answers", { answers: { age: 20 } });
    await setup.ok("begin_session", { purpose: "Work" });
    await setup.ok("set_answers", { answers: { name: "Ada", colour: "blue" } });
    const open = bannerCalls(setup).find((banner) => "open" in banner && banner.open) as { onStop(): void };
    open.onStop();
    await flush();
    expect(setup.runtime.formValues()).toMatchObject({ colour: "red", age: 20 });
    expect(setup.runtime.formValues().name).toBeUndefined();
    const stopped = bannerCalls(setup).at(-1) as { stopped: true; undone: number; onAllowAgain(): void };
    expect(stopped).toMatchObject({ stopped: true, undone: 2 });
    expect(setup.host.calls.filter((call) => call.method === "announce").at(-1)?.args).toEqual(["The assistant was stopped; 2 changes were undone"]);

    const write = await setup.refused("set_answers", { answers: { name: "Again" } });
    expect(write).toMatchObject({ code: "stopped", retryable: false, details: { undone: 2 }, sessionEnded: { reason: "stopped", undone: 2 } });
    const begin = await setup.refused("begin_session", { purpose: "Again" });
    expect(begin.code).toBe("stopped");
    const read = await setup.ok("describe_form");
    expect((read.status as Row).stopped).toBe(true);
    const undo = await setup.ok("undo_agent_changes");
    expect((undo.restored as Row[]).map((entry) => entry.path)).toEqual(["age"]);

    stopped.onAllowAgain();
    const allowed = await setup.ok("set_answers", { answers: { name: "Allowed" } });
    expect((allowed.written as Row[])[0]).toMatchObject({ path: "name", value: "Allowed" });
    expect(((await setup.ok("describe_form")).status as Row).stopped).toBe(false);
  });
});

describe("retryable", () => {
  it("every renderer refusal carries retryable from the registrar's table", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const refusals: AgentRefusal[] = [
      await setup.refused("set_answers", { answers: { nope: 1 } }),
      await setup.refused("get_options", { field: "name" }),
      await setup.refused("edit_rows", { collection: "name", action: "add" }),
      await setup.refused("navigate", { to: "next" }),
      await setup.refused("set_locale", { locale: "de" }),
      await setup.refused("submit"),
      await setup.refused("undo_agent_changes"),
      await setup.refused("describe_form", { scope: "nope" })
    ];
    for (const refusal of refusals) {
      expect(typeof refusal.retryable).toBe("boolean");
      expect(refusal.retryable).toBe(retryableFor(refusal.code, refusal.details));
      expect(refusal.retryable).toBe(false);
    }
    expect(refusals.map((refusal) => refusal.code)).toEqual(["nothing-written", "no-options", "not-a-table", "bad-input", "locale-unsupported", "rejected", "nothing-to-undo", "bad-input"]);
  });
});

describe("rebuild and readiness", () => {
  it("runtimeReplaced ends the session as rebuilt, drops the journal and memo, and the catalogue follows the new runtime", async () => {
    let current = agentRuntime(AGENT_SINGLE_FORM);
    const setup = agentSetup(AGENT_SINGLE_FORM, { host: { runtime: () => current } });
    await setup.ok("begin_session", { purpose: "Work" });
    await setup.ok("set_answers", { answers: { name: "Ada" } });
    const replacement = agentRuntime(AGENT_SINGLE_FORM);
    personTypes(replacement, { name: "Fresh" });
    current = replacement;
    setup.registration.runtimeReplaced();
    const described = await setup.ok("describe_form");
    expect(described.sessionEnded).toEqual({ reason: "rebuilt", undone: 0 });
    expect((described.status as Row).session).toBeNull();
    expect((described.fields as Row[]).find((field) => field.path === "name")).toMatchObject({ value: "Fresh" });
    const undo = await setup.refused("undo_agent_changes");
    expect(undo.code).toBe("nothing-to-undo");
    // Writes land on the new runtime and the revision keeps moving.
    const written = await setup.ok("set_answers", { answers: { age: 21 } });
    expect(replacement.formValues().age).toBe(21);
    expect(written.revision).toBeGreaterThan(described.revision as number);
  });

  it("readiness: a disconnected host is removed, a failed build carries the notice's message, a loading one waits", async () => {
    let connected = true;
    let build: "loading" | "failed" | "ready" = "ready";
    const setup = agentSetup(AGENT_SINGLE_FORM, {
      host: { connected: () => connected, buildState: () => build, notice: () => ({ message: "The journeys chunk did not load" }) }
    });
    build = "failed";
    const failed = await setup.refused("describe_form");
    expect(failed).toMatchObject({ code: "form-not-ready", retryable: false, details: { state: "failed", message: "The journeys chunk did not load" }, hint: "Tell the person the form could not load: The journeys chunk did not load." });
    build = "loading";
    const loading = await setup.refused("set_answers", { answers: { name: "x" } });
    expect(loading).toMatchObject({ code: "form-not-ready", retryable: true, details: { state: "loading" }, hint: "Wait a moment and call describe_form again." });
    build = "ready";
    connected = false;
    const removed = await setup.refused("describe_form");
    expect(removed).toMatchObject({ code: "form-not-ready", retryable: false, details: { state: "removed" }, hint: "The form is gone; stop." });
  });
});

describe("seams on the renderer", () => {
  it("a resumed begin_session redraws the banner with the new purpose, the same Stop and resumed: true, and announces nothing", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    await setup.ok("begin_session", { purpose: "One" });
    await setup.ok("begin_session", { purpose: "Two" });
    const banners = bannerCalls(setup) as Array<{ open: true; purpose: string; onStop(): void; resumed?: true }>;
    expect(banners).toHaveLength(2);
    expect(banners[0]).not.toHaveProperty("resumed");
    expect(banners[1]).toMatchObject({ open: true, purpose: "Two", resumed: true });
    expect(banners[1]?.onStop).toBe(banners[0]?.onStop);
    // The start is announced once, by begin; purposeChanged never announces.
    const announced = setup.host.calls.filter((call) => call.method === "announce").map((call) => call.args[0]);
    expect(announced).toEqual(["An assistant started working on this form: One. Press Stop to take over."]);
    // The kept Stop still stops the session.
    banners[1]?.onStop();
    await flush();
    expect(bannerCalls(setup).at(-1)).toMatchObject({ stopped: true });
  });

  it("describe_form counts the session's idle time from the registrar's idleTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(50_000);
      const setup = agentSetup(AGENT_SINGLE_FORM, { registrar: { idleTimeoutMs: 1_000 } });
      await setup.ok("begin_session", { purpose: "Short" });
      vi.setSystemTime(50_400);
      // The call itself resets the idle timer, so the countdown reads the whole
      // configured timeout: 1 000 ms, not the 45 000 ms default.
      const described = await setup.ok("describe_form");
      expect((described.status as Row).session).toMatchObject({ id: "session-1", purpose: "Short", idleInMs: 1_000 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the summary banner's Undo all", () => {
  it("undoes what the session did and leaves the agent's later writes alone", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    await setup.ok("begin_session", { purpose: "Work" });
    await setup.ok("set_answers", { answers: { name: "InSession" } });
    await setup.ok("end_session", { summary: "Done." });
    await setup.ok("set_answers", { answers: { age: 44 } });
    const banner = bannerCalls(setup).at(-1) as { open: false; onUndoAll?(): void };
    banner.onUndoAll?.();
    await flush();
    expect(setup.runtime.formValues().name).toBeUndefined();
    expect(setup.runtime.formValues().age).toBe(44);
    const action = setup.host.calls.filter((call) => call.method === "emit" && call.args[0] === "datum-agent-action").map((call) => call.args[1] as Row).at(-1);
    expect(action).toMatchObject({ tool: "undo_agent_changes", target: "form", readOnly: false, input: { scope: "session" }, outcome: { ok: true }, trigger: "agent", paths: ["name"], changed: true });
    expect(typeof action?.durationMs).toBe("number");
  });

  it("survives a failing paint without an unhandled rejection", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    await setup.ok("begin_session", { purpose: "Work" });
    await setup.ok("set_answers", { answers: { age: 30 } });
    await setup.ok("end_session", { summary: "Done." });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      setup.host.painted = () => Promise.reject(new Error("paint failed"));
      (bannerCalls(setup).at(-1) as { open: false; onUndoAll?(): void }).onUndoAll?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(setup.runtime.formValues().age).toBeUndefined();
      expect(logged).toHaveBeenCalledWith("[datum-agent] painted", expect.any(Error));
    } finally {
      logged.mockRestore();
      process.off("unhandledRejection", listener);
    }
  });
});

describe("a saved draft restored inside a session", () => {
  const restoredLine = "A saved draft replaced the answers; earlier changes cannot be undone.";

  /** A travel claim with a draft store, its catalogue built here so the session hooks can be watched. */
  function restoreSetup() {
    const store = new InMemoryDraftStore();
    const runtime = agentRuntime(TRAVEL_CLAIM_FORM, { deps: { draftStore: store, versionContext: AGENT_VERSION_CONTEXT } });
    const host = runtimeAgentHost(runtime, { draftKey: "claim-ana", draftStore: store });
    const catalogue = createFormAgentTools(host);
    const end = vi.spyOn(catalogue.sessionHooks as NonNullable<typeof catalogue.sessionHooks>, "end");
    const registrar = createAgentRegistrar();
    registrar.registerForm({ host, catalogue: () => catalogue, signal: new AbortController().signal });
    const ok = async (name: string, input: unknown = {}): Promise<Row> => {
      const result = await registrar.execute(name, input);
      if (!result.ok) {
        throw new Error(`${name} refused: ${result.code}`);
      }
      return result as unknown as Row;
    };
    const banners = (): AgentSessionUi[] => host.calls.filter((call) => call.method === "setSessionUi").map((call) => call.args[0] as AgentSessionUi);
    return { runtime, host, end, ok, banners };
  }

  it("Undo all reaches only what came after the restore: none here, so the ended banner offers Dismiss alone with the restore line, and the hook warns", async () => {
    const { runtime, end, ok, banners } = restoreSetup();
    await ok("set_answers", { answers: { traveller: "Saved Name" } });
    await ok("drafts", { action: "save" });
    await ok("begin_session", { purpose: "Claim" });
    await ok("set_answers", { answers: { amount: 5 } });
    await ok("drafts", { action: "restore", replaceAnswers: true });
    const result = await ok("end_session", { summary: "Restored your draft.", undo: true });
    expect(result).toMatchObject({ wasOpen: true, session: { undone: 0, undoable: 0 } });
    // The restore stands: an undo would autosave the answers from before it over the draft.
    expect(runtime.formValues()).toMatchObject({ traveller: "Saved Name" });
    expect(runtime.formValues().amount).toBeUndefined();
    expect(banners().at(-1)).toMatchObject({ open: false, undoAvailable: false, restoredNote: restoredLine });
    expect(end.mock.results.at(-1)?.value).toMatchObject({ warnings: ["a saved draft replaced the answers during the session; changes before it cannot be undone"] });
  });

  it("a write after the restore is undone by end_session { undo: true }, and session.undone counts it alone", async () => {
    const { runtime, ok, banners } = restoreSetup();
    await ok("set_answers", { answers: { traveller: "Saved Name" } });
    await ok("drafts", { action: "save" });
    await ok("begin_session", { purpose: "Claim" });
    await ok("set_answers", { answers: { traveller: "Before restore" } });
    await ok("drafts", { action: "restore", replaceAnswers: true });
    await ok("set_answers", { answers: { amount: 9 } });
    const result = await ok("end_session", { summary: "Done.", undo: true });
    expect(result).toMatchObject({ session: { undone: 1 } });
    expect(runtime.formValues().amount).toBeUndefined();
    expect(runtime.formValues().traveller).toBe("Saved Name");
    expect(banners().at(-1)).toMatchObject({ restoredNote: restoredLine });
  });

  it("without undo the summary banner offers Undo all over the post-restore writes, with the restore line", async () => {
    const { ok, banners } = restoreSetup();
    await ok("drafts", { action: "save" });
    await ok("begin_session", { purpose: "Claim" });
    await ok("drafts", { action: "restore", replaceAnswers: true });
    await ok("set_answers", { answers: { amount: 9 } });
    const result = await ok("end_session", { summary: "Done." });
    expect(result).toMatchObject({ session: { undoable: 1 } });
    expect(banners().at(-1)).toMatchObject({ open: false, undoAvailable: true, restoredNote: restoredLine });
    // A session with no restore carries no such line.
    const plain = agentSetup(AGENT_SINGLE_FORM);
    await plain.ok("begin_session", { purpose: "Work" });
    await plain.ok("end_session", { summary: "Nothing." });
    expect(bannerCalls(plain).at(-1)).not.toHaveProperty("restoredNote");
  });

  // The registrar merges the hook's warnings into
  // end_session's own result.
  it("end_session's own result carries the restore warning", async () => {
    const { ok } = restoreSetup();
    await ok("drafts", { action: "save" });
    await ok("begin_session", { purpose: "Claim" });
    await ok("drafts", { action: "restore", replaceAnswers: true });
    const result = await ok("end_session", { summary: "Done." });
    expect(result.warnings).toContain("a saved draft replaced the answers during the session; changes before it cannot be undone");
  });
});

describe("an accepted submit inside a session keeps the journal's seqs counting", () => {
  const VERSION = { form: { id: "single", version: "1.0.0" }, client: { runtimeVersion: "t", rendererVersion: "t", schemaVersion: "1.0.0" } };

  it("a write after the page's submit is still undone by end_session { undo: true }, which counts it", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    personTypes(setup.runtime, { "grid[0].amount": 1 });
    // A write on record before the session: its boundary then sits above seq 0, where a journal
    // reset that restarted the count would put every later entry.
    await setup.ok("set_answers", { answers: { colour: "red" } });
    await setup.ok("begin_session", { purpose: "Work" });
    await setup.ok("set_answers", { answers: { name: "Ada" } });
    const outcome = await setup.runtime.submit("embed", VERSION, {});
    expect(outcome.accepted).toBe(true);
    await setup.ok("set_answers", { answers: { age: 30 } });
    const result = await setup.ok("end_session", { summary: "Done.", undo: true });
    expect(result).toMatchObject({ wasOpen: true, session: { undone: 1, undoable: 0 } });
    expect(setup.runtime.formValues().age).toBeUndefined();
    // The submitted write is part of the submission, the pre-session one outside the session: never undone.
    expect(setup.runtime.formValues()).toMatchObject({ name: "Ada", colour: "red" });
  });

  it("the same after the assistant's own submit tool: the next write is still the session's to undo", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    personTypes(setup.runtime, { "grid[0].amount": 1 });
    // A write on record before the session: its boundary then sits above seq 0, where a journal
    // reset that restarted the count would put every later entry.
    await setup.ok("set_answers", { answers: { colour: "red" } });
    await setup.ok("begin_session", { purpose: "Work" });
    await setup.ok("set_answers", { answers: { name: "Ada" } });
    expect((await setup.ok("submit")).status).toBe("accepted");
    await setup.ok("set_answers", { answers: { age: 30 } });
    const undone = await setup.ok("undo_agent_changes", { scope: "session" });
    expect(undone.restored).toEqual([{ path: "age", value: null, display: "" }]);
    const result = await setup.ok("end_session", { summary: "Done." });
    expect(result).toMatchObject({ wasOpen: true, session: { undone: 0 } });
    expect(setup.runtime.formValues().name).toBe("Ada");
  });
});
