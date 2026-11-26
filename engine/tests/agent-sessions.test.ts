import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentRegistrar, type AgentActionDetail, type AgentSessionDetail } from "../form-engine/agent/registrar.js";
import { RESULT_BYTE_LIMIT, jsonByteLength } from "../form-engine/agent/result-caps.js";
import { SESSION_IDLE_TIMEOUT_MS } from "../form-engine/agent/session-tools.js";
import { ToolRefusal, type AgentRefusal } from "../form-engine/agent/tool-types.js";
import { builderHost, stubBuilderCatalogue, stubFormCatalogue, stubHost, type StubHost } from "./fixtures/agent-stub-catalogue.js";

/**
 * The session state machine the registrar owns: begin / end
 * echoes, idempotent begin, idle expiry, Stop and the latch, Allow again, the other ends, two
 * targets, `target`, hook refusals and `undo: true`.
 */
function setup(id = "") {
  const registrar = createAgentRegistrar();
  const host = stubHost(id);
  const controller = new AbortController();
  const registration = registrar.registerForm({ host, catalogue: stubFormCatalogue, signal: controller.signal });
  const sessions: AgentSessionDetail[] = [];
  registrar.subscribe((event) => {
    if (event.type === "session") {
      sessions.push(event.detail);
    }
  });
  return { registrar, host, controller, registration, sessions };
}

function refusal(result: unknown): AgentRefusal {
  const value = result as AgentRefusal;
  expect(value.ok).toBe(false);
  return value;
}

function ok(result: unknown): Record<string, unknown> {
  const value = result as Record<string, unknown>;
  expect(value.ok).toBe(true);
  return value;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe("begin and end", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("begin echoes the session, locks through the hook and emits begin; end echoes the counts", async () => {
    const { registrar, host, sessions } = setup();
    host.locked = true;
    host.pausedTyping = true;
    const begun = ok(await registrar.execute("begin_session", { purpose: "Filling the trip details" }));
    expect(begun).toMatchObject({
      tool: "begin_session",
      form: "form-1",
      revision: 1,
      session: { id: "session-1", purpose: "Filling the trip details", startedAt: 1_000, idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS, revisionAtBegin: 1 },
      locked: true,
      pausedTyping: true
    });
    expect(begun.resumed).toBeUndefined();
    expect(host.hookCalls).toEqual([{ hook: "begin", purpose: "Filling the trip details" }]);
    expect(sessions).toEqual([{ phase: "begin", sessionId: "session-1", target: "form", handle: "form-1", purpose: "Filling the trip details" }]);
    expect(host.events.filter((event) => event.type === "datum-agent-session")).toHaveLength(1);

    await registrar.execute("set_value", { path: "a", value: "b" });
    expect(host.lastSession).toMatchObject({ id: "session-1", target: "form", handle: "form-1", undoBoundary: 0 });
    vi.setSystemTime(4_000);
    const ended = ok(await registrar.execute("end_session", { summary: "Filled one field" }));
    expect(ended).toMatchObject({
      wasOpen: true,
      session: { id: "session-1", durationMs: 3_000, calls: 1, undone: 0, fieldsWritten: 1, rowsAdded: 0, rowsRemoved: 0, pagesMoved: 0, undoable: 2 }
    });
    expect(host.hookCalls.at(-1)).toEqual({ hook: "end", reason: "ended", summary: "Filled one field" });
    expect(sessions.at(-1)).toEqual({ phase: "end", sessionId: "session-1", target: "form", handle: "form-1", summary: "Filled one field", reason: "ended", undone: 0 });
    // end_session is not one of the "other ends": no sessionEnded on the next result.
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toBeUndefined();
  });

  it("cuts and cleans purpose and summary instead of refusing them", async () => {
    const { registrar, host } = setup();
    const purpose = `  Line one\nline\u0007 two ${"x".repeat(300)}`;
    const begun = ok(await registrar.execute("begin_session", { purpose }));
    const cleaned = (begun.session as { purpose: string }).purpose;
    expect(cleaned.length).toBeLessThanOrEqual(200);
    expect(cleaned.startsWith("Line one line two ")).toBe(true);
    expect(cleaned).not.toContain("\n");
    expect(host.hookCalls[0]).toEqual({ hook: "begin", purpose: cleaned });
    const ended = ok(await registrar.execute("end_session", { summary: "y".repeat(600) }));
    expect(ended.wasOpen).toBe(true);
    expect((host.hookCalls.at(-1) as { summary: string }).summary.length).toBeLessThanOrEqual(500);
    // A purpose of the wrong type is still bad-input.
    expect(refusal(await registrar.execute("begin_session", { purpose: 5 })).code).toBe("bad-input");
    expect(refusal(await registrar.execute("begin_session", {})).details).toEqual({ problems: [{ key: "purpose", expected: "required" }] });
  });

  it("begin while open is idempotent: the purpose is updated and the same id comes back with resumed", async () => {
    const { registrar, host, sessions } = setup();
    ok(await registrar.execute("begin_session", { purpose: "first" }));
    const again = ok(await registrar.execute("begin_session", { purpose: "second" }));
    expect(again).toMatchObject({ session: { id: "session-1", purpose: "second" }, resumed: true });
    // begin ran once; the catalogue's banner is redrawn through purposeChanged and host
    // listeners learn the new text from a second begin event marked resumed.
    expect(host.hookCalls.filter((call) => call.hook === "begin")).toHaveLength(1);
    expect(sessions.filter((detail) => detail.phase === "begin")).toEqual([
      { phase: "begin", sessionId: "session-1", target: "form", handle: "form-1", purpose: "first" },
      { phase: "begin", sessionId: "session-1", target: "form", handle: "form-1", purpose: "second", resumed: true }
    ]);
    expect(host.events.filter((event) => event.type === "datum-agent-session")).toHaveLength(2);
    expect(host.lastSession).toBeUndefined();
    await registrar.execute("describe_form", {});
    expect(host.lastSession).toMatchObject({ id: "session-1", purpose: "second" });
  });

  it("end with none open is ok with wasOpen false and a note; undo is ignored with a warning", async () => {
    const { registrar, host } = setup();
    const ended = ok(await registrar.execute("end_session", { summary: "nothing", undo: true }));
    expect(ended).toMatchObject({ wasOpen: false, note: ["No session was open; nothing to end."], warnings: ["ignored undo: no session was open"] });
    expect(host.hookCalls).toEqual([]);
    expect(ok(await registrar.execute("end_session", { summary: "nothing" })).warnings).toBeUndefined();
  });

  it("end with undo: true runs undoAll first and reports undone", async () => {
    const { registrar, host, sessions } = setup();
    host.undoAllResult = 3;
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    const ended = ok(await registrar.execute("end_session", { summary: "s", undo: true }));
    expect((ended.session as { undone: number }).undone).toBe(3);
    expect(host.hookCalls.map((call) => call.hook)).toEqual(["begin", "undoAll", "end"]);
    expect(sessions.at(-1)).toMatchObject({ phase: "end", undone: 3 });
  });

  it("end with undo: true when undoAll throws still ends the session, ok: true, with the warning", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { registrar, host } = setup();
    host.undoAllError = new Error("replay broke");
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    const ended = ok(await registrar.execute("end_session", { summary: "s", undo: true }));
    expect(ended.wasOpen).toBe(true);
    expect((ended.session as { undone: number }).undone).toBe(0);
    expect(ended.warnings).toEqual(["undo stopped early: 0 of 2 restored"]);
    expect(host.hookCalls.at(-1)).toMatchObject({ hook: "end", reason: "ended" });
    expect(ok(await registrar.execute("end_session", { summary: "again" })).wasOpen).toBe(false);
    error.mockRestore();
  });

  it("the end hook's warnings and note reach end_session's own result, after the registrar's warnings", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registrar = createAgentRegistrar();
    const host = stubHost("");
    host.undoAllError = new Error("replay broke");
    // The stub catalogue with an end hook that speaks: two warnings, one note line, and a
    // non-string a careless hook might hand back (dropped, so the result stays plain JSON).
    const catalogue = (given: StubHost) => {
      const base = stubFormCatalogue(given);
      const end = base.sessionHooks.end.bind(base.sessionHooks);
      return {
        ...base,
        sessionHooks: {
          ...base.sessionHooks,
          end: (reason: Parameters<typeof end>[0], summary?: string) => ({
            ...end(reason, summary),
            warnings: ["kept: one change the person edited", 7 as unknown as string, "journal-full: two dropped"],
            note: ["The site keeps the saved version."]
          })
        }
      };
    };
    registrar.registerForm({ host, catalogue, signal: new AbortController().signal });
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    const ended = ok(await registrar.execute("end_session", { summary: "s", undo: true, stray: 1 }));
    expect(ended.warnings).toEqual([
      "ignored unknown argument: stray",
      "undo stopped early: 0 of 2 restored",
      "kept: one change the person edited",
      "journal-full: two dropped"
    ]);
    expect(ended.note).toEqual(["The site keeps the saved version."]);
    expect(JSON.parse(JSON.stringify(ended))).toStrictEqual(ended);
    // A hook with nothing to say adds neither key (the plain stub, as the "begin and end" case reads).
    const plain = setup();
    ok(await plain.registrar.execute("begin_session", { purpose: "p" }));
    const quiet = ok(await plain.registrar.execute("end_session", { summary: "s" }));
    expect(quiet.warnings).toBeUndefined();
    expect(quiet.note).toBeUndefined();
    error.mockRestore();
  });

  it("hooks.begin returning { refused } answers that refusal, arms no timer and emits no begin", async () => {
    const { registrar, host, sessions } = setup();
    host.beginRefusal = new ToolRefusal("unsaved-draft", "A draft is pending.", "Ask the person to save or discard it.", { reason: "draft" });
    const refused = refusal(await registrar.execute("begin_session", { purpose: "p" }));
    expect(refused).toMatchObject({ code: "unsaved-draft", message: "A draft is pending.", details: { reason: "draft" }, retryable: false, form: "form-1" });
    expect(sessions).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(host.lastSession).toBeUndefined();
    // A thrown ToolRefusal from begin reads the same.
    host.beginRefusal = undefined;
    const catalogue = stubFormCatalogue(host);
    const throwing = createAgentRegistrar();
    throwing.registerForm({
      host,
      catalogue: () => ({
        ...catalogue,
        sessionHooks: {
          ...catalogue.sessionHooks,
          begin: () => {
            throw new ToolRefusal("busy", "Submitting.", "Wait.", { because: "submission" });
          }
        }
      }),
      signal: new AbortController().signal
    });
    const busy = refusal(await throwing.execute("begin_session", { purpose: "p" }));
    expect(busy).toMatchObject({ code: "busy", retryable: true });
  });

  it("begin_session is never refused for a focused caret control on the host", async () => {
    // Focus handling is the catalogue's
    // (the renderer's field-in-use outside a session, the inert body inside one) and never the
    // registrar's, which has no focus seam at all. What this proves is that the registrar
    // reached the hook without consulting anything about focus.
    const { registrar, host } = setup();
    host.focusedPath = "name";
    const begun = ok(await registrar.execute("begin_session", { purpose: "p" }));
    expect(begun.locked).toBe(false);
    expect(host.hookCalls).toEqual([{ hook: "begin", purpose: "p" }]);
    expect(host.stop).toBeDefined();
  });

  it("locked: false from a hookless host and true when the hook says so", async () => {
    const { registrar, host } = setup();
    expect(ok(await registrar.execute("begin_session", { purpose: "p" })).locked).toBe(false);
    await registrar.execute("end_session", { summary: "s" });
    host.locked = true;
    expect(ok(await registrar.execute("begin_session", { purpose: "q" })).locked).toBe(true);
  });
});

describe("idle expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends the session as idle after 45 s without a call; the next result carries sessionEnded once", async () => {
    const { registrar, host, sessions } = setup();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS - 1);
    expect(host.hookCalls.map((call) => call.hook)).toEqual(["begin"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.hookCalls.at(-1)).toEqual({ hook: "end", reason: "idle" });
    expect(sessions.at(-1)).toMatchObject({ phase: "idle", reason: "idle", undone: 0 });
    const first = ok(await registrar.execute("describe_form", {}));
    expect(first.sessionEnded).toEqual({ reason: "idle", undone: 0 });
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toBeUndefined();
    // No undo on idle.
    expect(host.hookCalls.some((call) => call.hook === "undoAll")).toBe(false);
  });

  it("every call on the target resets the timer", async () => {
    const { registrar, host } = setup();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    await vi.advanceTimersByTimeAsync(30_000);
    await registrar.execute("describe_form", {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.hookCalls.map((call) => call.hook)).toEqual(["begin"]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(host.hookCalls.at(-1)).toEqual({ hook: "end", reason: "idle" });
  });

  it("a refusal also carries sessionEnded", async () => {
    const { registrar } = setup();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS);
    const refused = refusal(await registrar.execute("refusing", {}));
    expect(refused.sessionEnded).toEqual({ reason: "idle", undone: 0 });
  });

  it("the too-large refusal that replaces a capped result still carries sessionEnded and the warnings, once", async () => {
    const { registrar } = setup();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS);
    // capResult's step (c) keeps only tool, handle and revision: the once-only stamp must survive it.
    const big = refusal(await registrar.execute("big_blob", { stray: 1 }));
    expect(big).toMatchObject({ code: "too-large", details: { what: "result" }, form: "form-1", revision: 1 });
    expect(big.sessionEnded).toEqual({ reason: "idle", undone: 0 });
    expect(big.warnings).toEqual(["ignored unknown argument: stray"]);
    expect(jsonByteLength(big)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toBeUndefined();
  });

  it("the stamp is inside the cap: a result that fits without sessionEnded and not with it leaves as too-large, under the limit", async () => {
    // The cap is measured by the registrar after the tool returns, over what leaves
    // the registrar; a stamp written after the measurement would put the envelope over it.
    const items = Array.from({ length: 60 }, (_, index) => `item-${index}`);
    const probe = setup();
    probe.host.values.a = items;
    const bytes = jsonByteLength(ok(await probe.registrar.execute("get_value", { path: "a" })));
    const limit = bytes + 8;
    const registrar = createAgentRegistrar({ resultByteLimit: limit });
    const host = stubHost();
    host.values.a = items;
    registrar.registerForm({ host, catalogue: stubFormCatalogue, signal: new AbortController().signal });
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS);
    const capped = refusal(await registrar.execute("get_value", { path: "a" }));
    expect(capped).toMatchObject({ code: "too-large", details: { what: "result", limit }, sessionEnded: { reason: "idle", undone: 0 } });
    expect((capped.details as { got: number }).got).toBeGreaterThan(limit);
    expect(jsonByteLength(capped)).toBeLessThanOrEqual(limit);
    // Spent: the same read now fits and carries no stamp.
    const next = ok(await registrar.execute("get_value", { path: "a" }));
    expect(next.sessionEnded).toBeUndefined();
    expect(jsonByteLength(next)).toBeLessThanOrEqual(limit);
  });

  it("a cancelled call after the idle end carries the stamp but leaves it for the next delivered result", async () => {
    const { registrar } = setup();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS);
    const controller = new AbortController();
    controller.abort();
    const cancelled = refusal(await registrar.execute("describe_form", {}, { signal: controller.signal }));
    expect(cancelled.code).toBe("cancelled");
    expect(cancelled.sessionEnded).toEqual({ reason: "idle", undone: 0 });
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toEqual({ reason: "idle", undone: 0 });
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toBeUndefined();
  });
});

describe("Stop and Allow again", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // No test leaves a session open: an armed idle timer would outlive it.
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("Stop undoes, ends as stopped and latches writes and begin_session; reads and undo_agent_changes still run", async () => {
    const { registrar, host, sessions } = setup();
    host.undoAllResult = 2;
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    await registrar.execute("set_value", { path: "a", value: "b" });
    host.stop?.();
    await flush();
    expect(host.hookCalls.map((call) => call.hook)).toEqual(["begin", "undoAll", "end"]);
    expect(host.hookCalls.at(-1)).toEqual({ hook: "end", reason: "stopped" });
    expect(sessions.at(-1)).toMatchObject({ phase: "stop", reason: "stopped", undone: 2 });

    const write = refusal(await registrar.execute("set_value", { path: "c", value: "d" }));
    expect(write.code).toBe("stopped");
    expect(write.details).toMatchObject({ undone: 2 });
    expect(typeof (write.details as { stoppedAt: number }).stoppedAt).toBe("number");
    expect(write.hint).toBe("Tell the person you have stopped and what was undone; they can allow you to continue from the banner.");
    expect(write.retryable).toBe(false);
    expect(write.sessionEnded).toEqual({ reason: "stopped", undone: 2 });
    expect(host.values).toEqual({ a: "b" });
    expect(refusal(await registrar.execute("begin_session", { purpose: "again" })).code).toBe("stopped");
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toBeUndefined();
    expect(ok(await registrar.execute("undo_agent_changes", {})).undone).toBe(0);
    expect(ok(await registrar.execute("end_session", { summary: "s" })).wasOpen).toBe(false);

    host.allowAgain?.();
    expect(sessions.at(-1)).toMatchObject({ phase: "allow-again", sessionId: "session-1" });
    expect(ok(await registrar.execute("set_value", { path: "c", value: "d" })).written).toEqual(["c"]);
    expect(ok(await registrar.execute("begin_session", { purpose: "again" })).session).toMatchObject({ id: "session-2" });
    expect(ok(await registrar.execute("end_session", { summary: "s" })).wasOpen).toBe(true);
  });

  it("end_session landing while Stop's undo replays answers wasOpen: false; the session still ends as stopped", async () => {
    const { registrar, host, sessions } = setup();
    let settle: (count: number) => void = () => undefined;
    host.undoAllPending = new Promise<number>((resolve) => {
      settle = resolve;
    });
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    host.stop?.();
    // The session is detached before the replay is awaited: end_session has nothing to close,
    // so it cannot turn the stop into an `ended` with no stopped banner (and no Allow again).
    const ended = ok(await registrar.execute("end_session", { summary: "s" }));
    expect(ended.wasOpen).toBe(false);
    expect(ended.sessionEnded).toBeUndefined();
    expect(host.hookCalls.map((call) => call.hook)).toEqual(["begin", "undoAll"]);
    settle(3);
    await flush();
    expect(host.hookCalls.at(-1)).toEqual({ hook: "end", reason: "stopped" });
    expect(sessions.map((detail) => detail.phase)).toEqual(["begin", "stop"]);
    expect(sessions.at(-1)).toMatchObject({ reason: "stopped", undone: 3 });
    const write = refusal(await registrar.execute("set_value", { path: "a", value: "b" }));
    expect(write.code).toBe("stopped");
    expect(write.details).toMatchObject({ undone: 3 });
    expect(write.sessionEnded).toEqual({ reason: "stopped", undone: 3 });
    host.allowAgain?.();
    expect(ok(await registrar.execute("set_value", { path: "a", value: "b" })).written).toEqual(["a"]);
  });

  it("a write during Stop's replay reads stopped { undone: 0 } without the stamp; the next result carries the count", async () => {
    // The documented window (registrar `stop()` docblock): the count is not known
    // until the replay settles, so the stamp lands on the result after it.
    const { registrar, host } = setup();
    let settle: (count: number) => void = () => undefined;
    host.undoAllPending = new Promise<number>((resolve) => {
      settle = resolve;
    });
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    host.stop?.();
    const during = refusal(await registrar.execute("set_value", { path: "a", value: "b" }));
    expect(during.code).toBe("stopped");
    expect(during.details).toMatchObject({ undone: 0 });
    expect(during.sessionEnded).toBeUndefined();
    expect(host.hookCalls.map((call) => call.hook)).toEqual(["begin", "undoAll"]);
    settle(2);
    await flush();
    const after = refusal(await registrar.execute("set_value", { path: "a", value: "b" }));
    expect(after.details).toMatchObject({ undone: 2 });
    expect(after.sessionEnded).toEqual({ reason: "stopped", undone: 2 });
    expect(host.values).toEqual({});
  });

  it("a stale Stop callback from an earlier session does nothing", async () => {
    const { registrar, host } = setup();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    const stop = host.stop;
    ok(await registrar.execute("end_session", { summary: "s" }));
    stop?.();
    await flush();
    expect(host.hookCalls.some((call) => call.hook === "undoAll")).toBe(false);
    expect(ok(await registrar.execute("set_value", { path: "a", value: "b" })).written).toEqual(["a"]);
  });
});

describe("other ends", () => {
  it("unregister ends as disconnected, a features change as features-changed, with no undo", async () => {
    const first = setup();
    ok(await first.registrar.execute("begin_session", { purpose: "p" }));
    first.controller.abort();
    expect(first.host.hookCalls.at(-1)).toEqual({ hook: "end", reason: "disconnected" });
    expect(first.sessions.at(-1)).toMatchObject({ phase: "end", reason: "disconnected", undone: 0 });

    const second = setup();
    ok(await second.registrar.execute("begin_session", { purpose: "p" }));
    second.registration.unregister("features-changed");
    expect(second.host.hookCalls.at(-1)).toEqual({ hook: "end", reason: "features-changed" });
    expect(second.host.hookCalls.some((call) => call.hook === "undoAll")).toBe(false);
    // Unregister is idempotent.
    second.registration.unregister();
    expect(second.host.hookCalls.filter((call) => call.hook === "end")).toHaveLength(1);
  });

  it("runtimeReplaced ends as rebuilt, clears the latch and the state, and the next result says so", async () => {
    const { registrar, host, registration } = setup();
    await registrar.execute("set_value", { path: "a", value: "b" });
    expect(host.lastState?.get("writes")).toBe(1);
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    host.stop?.();
    await flush();
    expect(refusal(await registrar.execute("set_value", { path: "c", value: "d" })).code).toBe("stopped");
    registration.runtimeReplaced();
    expect(host.resets).toBe(1);
    const next = ok(await registrar.execute("set_value", { path: "c", value: "d" }));
    expect(next.sessionEnded).toBeUndefined();
    expect(host.lastState?.get("writes")).toBe(1);
  });

  it("runtimeReplaced with an open session ends it as rebuilt", async () => {
    const { registrar, host, registration, sessions } = setup();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    registration.runtimeReplaced();
    expect(host.hookCalls.at(-1)).toEqual({ hook: "end", reason: "rebuilt" });
    expect(sessions.at(-1)).toMatchObject({ phase: "end", reason: "rebuilt", undone: 0 });
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toEqual({ reason: "rebuilt", undone: 0 });
  });

  it("a cancelled call on the target ends the session as cancelled", async () => {
    const { registrar, host, sessions } = setup();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    const controller = new AbortController();
    controller.abort();
    const cancelled = refusal(await registrar.execute("describe_form", {}, { signal: controller.signal }));
    expect(cancelled.code).toBe("cancelled");
    expect(host.hookCalls.at(-1)).toEqual({ hook: "end", reason: "cancelled" });
    expect(sessions.at(-1)).toMatchObject({ phase: "cancel", reason: "cancelled", undone: 0 });
    // The cancelled result carries the stamp but does not consume it: through the browser that
    // envelope is never delivered (the call rejects with the caller's reason), so the next
    // delivered result carries it too, and only then is it spent.
    expect(cancelled.sessionEnded).toEqual({ reason: "cancelled", undone: 0 });
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toEqual({ reason: "cancelled", undone: 0 });
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toBeUndefined();
  });

  it("a plain AbortError thrown mid-body ends the session as cancelled; the next delivered result still carries the stamp", async () => {
    const { registrar, host, sessions } = setup();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    const controller = new AbortController();
    const pending = registrar.execute("abort_thrower", {}, { signal: controller.signal });
    controller.abort();
    const cancelled = refusal(await pending);
    expect(cancelled).toMatchObject({ code: "cancelled", retryable: true, sessionEnded: { reason: "cancelled", undone: 0 } });
    expect(host.hookCalls.at(-1)).toEqual({ hook: "end", reason: "cancelled" });
    expect(sessions.at(-1)).toMatchObject({ phase: "cancel", reason: "cancelled", undone: 0 });
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toEqual({ reason: "cancelled", undone: 0 });
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toBeUndefined();
  });

  it("an ok result that outlives the abort ends the session as cancelled and keeps the stamp pending too", async () => {
    const { registrar, host } = setup();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    const controller = new AbortController();
    const pending = registrar.execute("abort_survivor", {}, { signal: controller.signal });
    controller.abort();
    const late = ok(await pending);
    expect(late.aborted).toBe(true);
    expect(late.sessionEnded).toEqual({ reason: "cancelled", undone: 0 });
    expect(host.hookCalls.at(-1)).toEqual({ hook: "end", reason: "cancelled" });
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toEqual({ reason: "cancelled", undone: 0 });
    expect(ok(await registrar.execute("describe_form", {})).sessionEnded).toBeUndefined();
  });
});

describe("two targets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  function page() {
    const registrar = createAgentRegistrar();
    const form = stubHost();
    const builder = builderHost();
    registrar.registerForm({ host: form, catalogue: stubFormCatalogue, signal: new AbortController().signal });
    const builderRegistration = registrar.registerBuilder({ host: builder, catalogue: stubBuilderCatalogue, signal: new AbortController().signal });
    return { registrar, form, builder, builderRegistration };
  }

  it("requires target only when both kinds are registered, and routes by it", async () => {
    const { registrar, form, builder, builderRegistration } = page();
    const required = refusal(await registrar.execute("begin_session", { purpose: "p" }));
    expect(required).toMatchObject({ code: "target-required", details: { targets: ["form", "builder"] }, retryable: false });
    expect(required.hint).toBe("Pass target: 'form' or 'builder'.");
    expect(required.form).toBeUndefined();
    const onBuilder = ok(await registrar.execute("begin_session", { purpose: "p", target: "builder" }));
    expect(onBuilder).toMatchObject({ builder: "builder-1", locked: false });
    expect(builder.hookCalls).toEqual([{ hook: "begin", purpose: "p" }]);
    expect(form.hookCalls).toEqual([]);
    expect(refusal(await registrar.execute("begin_session", { purpose: "p", target: "pdf" })).code).toBe("bad-input");
    expect(ok(await registrar.execute("end_session", { summary: "s", target: "builder" })).wasOpen).toBe(true);
    builderRegistration.unregister();
    const alone = ok(await registrar.execute("begin_session", { purpose: "p", target: "builder" }));
    expect(alone.form).toBe("form-1");
    expect(alone.warnings).toEqual(["ignored target: the page has only a form"]);
    expect(ok(await registrar.execute("end_session", { summary: "s" })).wasOpen).toBe(true);
  });

  it("two targets hold two independent sessions", async () => {
    const { registrar, form, builder } = page();
    const a = ok(await registrar.execute("begin_session", { purpose: "form work", target: "form" }));
    const b = ok(await registrar.execute("begin_session", { purpose: "builder work", target: "builder" }));
    expect((a.session as { id: string }).id).not.toBe((b.session as { id: string }).id);
    expect(form.hookCalls).toEqual([{ hook: "begin", purpose: "form work" }]);
    expect(builder.hookCalls).toEqual([{ hook: "begin", purpose: "builder work" }]);
    form.stop?.();
    await flush();
    expect(refusal(await registrar.execute("set_value", { path: "a", value: "b" })).code).toBe("stopped");
    expect(ok(await registrar.execute("set_properties", { id: "c1" })).changed).toEqual(["c1"]);
    expect(ok(await registrar.execute("end_session", { summary: "done", target: "builder" })).wasOpen).toBe(true);
  });

  it("with two forms the session tools take the form handle like any tool", async () => {
    const registrar = createAgentRegistrar();
    const a: StubHost = stubHost("a");
    const b: StubHost = stubHost("b");
    registrar.registerForm({ host: a, catalogue: stubFormCatalogue, signal: new AbortController().signal });
    registrar.registerForm({ host: b, catalogue: stubFormCatalogue, signal: new AbortController().signal });
    expect(refusal(await registrar.execute("begin_session", { purpose: "p" })).code).toBe("form-required");
    expect(ok(await registrar.execute("begin_session", { purpose: "p", form: "b" })).form).toBe("b");
    expect(b.hookCalls).toHaveLength(1);
    expect(a.hookCalls).toHaveLength(0);
    expect(ok(await registrar.execute("end_session", { summary: "s", form: "b" })).wasOpen).toBe(true);
    expect(b.hookCalls.at(-1)).toEqual({ hook: "end", reason: "ended", summary: "s" });
  });
});

describe("the registrar's view of the session", () => {
  it("is handed to the tool as ctx.session while open and undefined after", async () => {
    const { registrar, host } = setup();
    await registrar.execute("set_value", { path: "a", value: "b" });
    expect(host.lastSession).toBeUndefined();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    await registrar.execute("set_value", { path: "a", value: "c" });
    expect(host.lastSession).toMatchObject({ id: "session-1", purpose: "p", revisionAtBegin: 2 });
    ok(await registrar.execute("end_session", { summary: "s" }));
    await registrar.execute("set_value", { path: "a", value: "d" });
    expect(host.lastSession).toBeUndefined();
  });

  it("counts the calls while open", async () => {
    const { registrar } = setup();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    await registrar.execute("describe_form", {});
    await registrar.execute("set_value", { path: "a", value: "b" });
    await registrar.execute("refusing", {});
    const ended = ok(await registrar.execute("end_session", { summary: "s" }));
    expect((ended.session as { calls: number }).calls).toBe(3);
  });

  it("the action event names the session for every call that ran inside it, end_session and the cancelling call included", async () => {
    // The sessionId: a host correlating actions per session must not lose the closing call.
    const { registrar, host } = setup();
    const actions = (): Array<[string, string | undefined]> =>
      host.events
        .filter((event) => event.type === "datum-agent-action")
        .map((event) => event.detail as AgentActionDetail)
        .map((detail) => [detail.tool, detail.sessionId]);
    await registrar.execute("describe_form", {});
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    await registrar.execute("set_value", { path: "a", value: "b" });
    ok(await registrar.execute("end_session", { summary: "s" }));
    await registrar.execute("describe_form", {});
    expect(actions()).toEqual([
      ["describe_form", undefined],
      ["begin_session", "session-1"],
      ["set_value", "session-1"],
      ["end_session", "session-1"],
      ["describe_form", undefined]
    ]);
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    const controller = new AbortController();
    controller.abort();
    refusal(await registrar.execute("describe_form", {}, { signal: controller.signal }));
    expect(actions().slice(-2)).toEqual([
      ["begin_session", "session-2"],
      ["describe_form", "session-2"]
    ]);
    expect(actions().length).toBe(7);
  });
});

describe("session seams", () => {
  it("a resumed begin calls purposeChanged with the new purpose before the second begin event", async () => {
    const { registrar, host, sessions } = setup();
    ok(await registrar.execute("begin_session", { purpose: "first" }));
    expect(host.purposeChanges).toEqual([]);
    ok(await registrar.execute("begin_session", { purpose: "second\nline" }));
    // The purpose is the cleaned one the result reports.
    expect(host.purposeChanges).toEqual(["second line"]);
    // One datum-agent-session event (the first begin) had been dispatched when the hook ran.
    expect(host.purposeChangedAtEvent).toEqual([1]);
    expect(sessions.filter((detail) => detail.phase === "begin").map((detail) => detail.resumed)).toEqual([undefined, true]);
  });

  it("a throwing purposeChanged is logged and begin_session still answers ok with resumed and emits the event", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { registrar, host, sessions } = setup();
    host.purposeChangedError = new Error("banner gone");
    ok(await registrar.execute("begin_session", { purpose: "first" }));
    const again = ok(await registrar.execute("begin_session", { purpose: "second" }));
    expect(again).toMatchObject({ session: { id: "session-1", purpose: "second" }, resumed: true });
    expect(sessions.at(-1)).toMatchObject({ phase: "begin", purpose: "second", resumed: true });
    expect(error).toHaveBeenCalledWith("[datum-agent] sessionHooks.purposeChanged", expect.any(Error));
    error.mockRestore();
  });

  it("ctx.session.idleTimeoutMs is the registrar's option (default and configured); a builder target gets purposeChanged too", async () => {
    const { registrar, host } = setup();
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    await registrar.execute("describe_form", {});
    expect(host.lastSession).toMatchObject({ idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS });

    const configured = createAgentRegistrar({ idleTimeoutMs: 1_000 });
    const other = stubHost();
    configured.registerForm({ host: other, catalogue: stubFormCatalogue, signal: new AbortController().signal });
    ok(await configured.execute("begin_session", { purpose: "p" }));
    await configured.execute("describe_form", {});
    expect(other.lastSession).toMatchObject({ idleTimeoutMs: 1_000 });
    // The builder side reads the same field.
    const builder = builderHost();
    const both = createAgentRegistrar({ idleTimeoutMs: 2_000 });
    both.registerBuilder({ host: builder, catalogue: stubBuilderCatalogue, signal: new AbortController().signal });
    ok(await both.execute("begin_session", { purpose: "p" }));
    expect(builder.purposeChanges).toEqual([]);
    ok(await both.execute("begin_session", { purpose: "q" }));
    expect(builder.purposeChanges).toEqual(["q"]);
  });
});
