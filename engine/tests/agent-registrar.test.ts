import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INPUT_BYTE_LIMIT,
  QUEUE_TIMEOUT_MS,
  agentRegistrarFor,
  createAgentRegistrar,
  retryableFor,
  type AgentActionDetail,
  type AgentRegistrar,
  type RegistrarEvent
} from "../form-engine/agent/registrar.js";
import { RESULT_BYTE_LIMIT, jsonByteLength } from "../form-engine/agent/result-caps.js";
import { SESSION_TOOL_TEXTS } from "../form-engine/agent/session-tools.js";
import { SHARED_REFUSAL_CODES, type AgentAccessState, type AgentCatalogue, type AgentRefusal } from "../form-engine/agent/tool-types.js";
import type { AgentProvenance } from "../form-engine/core/events/hooks.js";
import { builderHost, stubBuilderCatalogue, stubFormCatalogue, stubHost, type StubHost } from "./fixtures/agent-stub-catalogue.js";

/**
 * The page registrar over stub catalogues: the envelope on
 * every path, handles, readiness, the revision counter and change ring, per-target
 * serialisation of writes, caps, the action event and the tool listing.
 */
function registerForm(registrar: AgentRegistrar, host: StubHost) {
  const controller = new AbortController();
  const registration = registrar.registerForm({ host, catalogue: stubFormCatalogue, signal: controller.signal });
  return { registration, controller };
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

describe("envelope", () => {
  let registrar: AgentRegistrar;
  let host: StubHost;

  beforeEach(() => {
    registrar = createAgentRegistrar();
    host = stubHost();
    registerForm(registrar, host);
  });

  it("stamps tool, form and revision on an ok result and keeps the tool's own fields", async () => {
    const result = ok(await registrar.execute("describe_form", {}));
    expect(result.tool).toBe("describe_form");
    expect(result.form).toBe("form-1");
    expect(result.revision).toBe(1);
    expect(result.title).toBe("Stub form");
    expect(result.formId).toBe("stub-form");
  });

  it("answers internal for a throwing tool with the error's message and never rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = refusal(await registrar.execute("throwing", {}));
    expect(result.code).toBe("internal");
    expect(result.message).toBe("boom");
    expect(result.details).toEqual({ message: "boom" });
    expect(result.hint).toBe("Try once more; if it repeats, tell the person the form reported an error.");
    expect(result.retryable).toBe(false);
    expect(result.form).toBe("form-1");
    expect(result.revision).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toBe("[datum-agent] throwing");
    error.mockRestore();
  });

  it("answers internal, never rejects, for an input JSON cannot serialise (a BigInt, a cycle), and still reports the call", async () => {
    // The catch-all covers the pipeline before and after the body too: an
    // in-page host can hand execute() what a model's JSON never carries, and the input cap's
    // JSON.stringify is the first thing that chokes on it.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const actions: AgentActionDetail[] = [];
    registrar.subscribe((event) => {
      if (event.type === "action") {
        actions.push(event.detail);
      }
    });
    const big = refusal(await registrar.execute("set_value", { path: "a", value: "b", attachment: { n: 1n } }));
    expect(big).toMatchObject({ code: "internal", retryable: false, form: "form-1", revision: 1 });
    expect(big.message).toContain("BigInt");
    expect(big.hint).toBe("Try once more; if it repeats, tell the person the form reported an error.");
    const cyclic: Record<string, unknown> = { path: "a", value: "b" };
    cyclic.attachment = cyclic;
    const circle = refusal(await registrar.execute("set_value", cyclic));
    expect(circle).toMatchObject({ code: "internal", form: "form-1" });
    expect(circle.message).toContain("circular");
    expect(host.values).toEqual({});
    // Both calls reported, with the cyclic echo cut where it closes on itself (the shaped input
    // is a shallow copy, so the circle closes one level down).
    expect(actions.map((detail) => detail.outcome)).toEqual([
      { ok: false, code: "internal" },
      { ok: false, code: "internal" }
    ]);
    expect(actions[1]?.input).toEqual({ path: "a", value: "b", attachment: { path: "a", value: "b", attachment: { omitted: "cycle" } } });
    // The chain is released: the next write on the target runs at once.
    expect(ok(await registrar.execute("set_value", { path: "a", value: "b" })).written).toEqual(["a"]);
    error.mockRestore();
  });

  it("turns a ToolRefusal into a refusal with the same code, message, hint and details", async () => {
    const result = refusal(await registrar.execute("refusing", { code: "unknown-field" }));
    expect(result).toMatchObject({
      ok: false,
      tool: "refusing",
      code: "unknown-field",
      message: "No field has that path.",
      hint: "Use a path from describe_form.",
      details: { ref: "x" },
      retryable: false,
      form: "form-1",
      revision: 1
    });
  });

  it("answers cancelled for a pre-aborted signal without running the body", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = refusal(await registrar.execute("set_value", { path: "a", value: "b" }, { signal: controller.signal }));
    expect(result.code).toBe("cancelled");
    expect(result.retryable).toBe(true);
    expect(host.values).toEqual({});
  });

  it("answers cancelled when the signal fires mid-call", async () => {
    const controller = new AbortController();
    const pending = registrar.execute("signal_probe", {}, { signal: controller.signal });
    controller.abort();
    const result = refusal(await pending);
    expect(result.code).toBe("cancelled");
    expect(result.details).toEqual({ stillRunning: true });
    expect(result.retryable).toBe(true);
  });

  it("answers cancelled for a plain AbortError thrown mid-call, and ok for a body that outlives the abort", async () => {
    const controller = new AbortController();
    const pending = registrar.execute("abort_thrower", {}, { signal: controller.signal });
    controller.abort();
    const result = refusal(await pending);
    expect(result).toMatchObject({ code: "cancelled", retryable: true, details: {}, form: "form-1", revision: 1 });
    expect(result.hint).toBe("The call was cancelled. If stillRunning is set the action may still complete; call describe_form before retrying.");
    const survivor = new AbortController();
    const late = registrar.execute("abort_survivor", {}, { signal: survivor.signal });
    survivor.abort();
    expect(ok(await late).aborted).toBe(true);
    const outcomes = host.events
      .map((event) => event.detail as AgentActionDetail)
      .filter((detail) => detail.tool === "abort_thrower" || detail.tool === "abort_survivor")
      .map((detail) => detail.outcome);
    expect(outcomes).toEqual([{ ok: false, code: "cancelled" }, { ok: true }]);
  });

  it("names a wrong handle key among the ignored arguments; only the target's own handle is spared when a schema omits it", async () => {
    const result = ok(await registrar.execute("describe_form", { builder: "b1", target: "form", foo: 1 }));
    expect(result.warnings).toEqual(["ignored unknown argument: builder", "ignored unknown argument: target", "ignored unknown argument: foo"]);
    const other = createAgentRegistrar();
    const bareHost = stubHost();
    const catalogue = stubFormCatalogue(bareHost);
    const bare = { ...(catalogue.tools[0] as (typeof catalogue.tools)[number]), inputSchema: { type: "object", properties: {} } };
    other.registerForm({ host: bareHost, catalogue: () => ({ ...catalogue, tools: [bare] }), signal: new AbortController().signal });
    expect(ok(await other.execute("describe_form", { form: "form-1" })).warnings).toBeUndefined();
    expect(ok(await other.execute("describe_form", { form: "form-1", builder: "x" })).warnings).toEqual(["ignored unknown argument: builder"]);
  });

  it("collects every bad-input problem at once", async () => {
    const result = refusal(await registrar.execute("set_value", { path: 5, value: "x".repeat(10_001) }));
    expect(result.code).toBe("bad-input");
    expect(result.details).toEqual({
      problems: [
        { key: "path", expected: "a string" },
        { key: "value", expected: "at most 10000 characters" }
      ]
    });
    expect(result.hint).toBe("Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.");
    expect(host.values).toEqual({});
  });

  it("drops unknown keys into warnings with the exact wording and merges the tool's own warnings", async () => {
    const result = ok(await registrar.execute("set_value", { path: "a", value: "b", expectedRevison: 1 }));
    expect(result.warnings).toEqual(["ignored unknown argument: expectedRevison", "stub note"]);
    expect(host.values).toEqual({ a: "b" });
  });

  it("shapes the input: undefined is {}, a JSON string is parsed once, anything else is bad-input", async () => {
    expect(ok(await registrar.execute("describe_form", undefined)).scope).toBe("visible");
    expect(ok(await registrar.execute("describe_form", JSON.stringify({ scope: "all" }))).scope).toBe("all");
    for (const bad of ["not json", 5, null, ["a"], true]) {
      const result = refusal(await registrar.execute("describe_form", bad));
      expect(result.code).toBe("bad-input");
      expect(result.details).toEqual({ problems: [{ key: "", expected: "a JSON object" }] });
    }
  });

  it("refuses an unknown tool name as bad-input without a target", async () => {
    const result = refusal(await registrar.execute("no_such_tool", {}));
    expect(result.code).toBe("bad-input");
    expect(result.form).toBeUndefined();
    expect(result.revision).toBeUndefined();
  });

  it("refuses the whole input over 256 KB as too-large and honours inputBytes per tool", async () => {
    const payload = "x".repeat(300 * 1024);
    const refused = refusal(await registrar.execute("set_value", { path: "a", value: "b", attachment: { data: payload } }));
    expect(refused.code).toBe("too-large");
    expect(refused.details).toMatchObject({ what: "input", limit: INPUT_BYTE_LIMIT });
    expect((refused.details as { got: number }).got).toBeGreaterThan(INPUT_BYTE_LIMIT);
    expect(refused.hint).toBe(
      `Send fewer items per call (at most ${INPUT_BYTE_LIMIT} bytes for the whole input) and call again for the rest.`
    );
    const wide = ok(await registrar.execute("wide_input", { payload }));
    expect(wide.bytes).toBeGreaterThan(INPUT_BYTE_LIMIT);
    const tooWide = refusal(await registrar.execute("wide_input", { payload: "x".repeat(600 * 1024) }));
    expect(tooWide.details).toMatchObject({ what: "input", limit: 512 * 1024 });
  });

  it("gives the tool a per-target state map and the revision function", async () => {
    await registrar.execute("set_value", { path: "a", value: "b" });
    await registrar.execute("set_value", { path: "c", value: "d" });
    expect(host.lastState?.get("writes")).toBe(2);
    expect(host.lastSession).toBeUndefined();
  });
});

describe("retryable", () => {
  it("follows the one table", () => {
    expect(retryableFor("busy")).toBe(true);
    expect(retryableFor("cancelled")).toBe(true);
    expect(retryableFor("timeout")).toBe(true);
    expect(retryableFor("chunk-unavailable")).toBe(true);
    expect(retryableFor("form-not-ready", { state: "loading" })).toBe(true);
    expect(retryableFor("builder-not-ready", { state: "loading" })).toBe(true);
    expect(retryableFor("form-not-ready", { state: "failed" })).toBe(false);
    expect(retryableFor("form-not-ready", { state: "removed" })).toBe(false);
    for (const code of ["bad-input", "too-large", "form-required", "form-unknown", "target-required", "stale", "stopped", "feature-off", "internal", "unknown-field"]) {
      expect(retryableFor(code)).toBe(false);
    }
  });

  it("is stamped on every refusal the registrar returns", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    const refused = refusal(await registrar.execute("refusing", { code: "busy" }));
    expect(refused.retryable).toBe(true);
    host.readiness = { state: "loading" };
    expect(refusal(await registrar.execute("describe_form", {})).retryable).toBe(true);
    host.readiness = { state: "failed", message: "chunk missing" };
    expect(refusal(await registrar.execute("describe_form", {})).retryable).toBe(false);
  });
});

describe("handles", () => {
  it("uses the element id when set and unused, else form-<n>, and never changes", () => {
    const registrar = createAgentRegistrar();
    const first = registerForm(registrar, stubHost("intake"));
    const second = registerForm(registrar, stubHost());
    const third = registerForm(registrar, stubHost("intake"));
    expect(first.registration.handle).toBe("intake");
    expect(second.registration.handle).toBe("form-1");
    expect(third.registration.handle).toBe("form-2");
    first.registration.unregister();
    // A retired handle is never reused; the next ordinal continues.
    const fourth = registerForm(registrar, stubHost("intake"));
    expect(fourth.registration.handle).toBe("form-3");
    // An id that spells a generated handle already taken falls through too.
    const fifth = registerForm(registrar, stubHost("form-1"));
    expect(fifth.registration.handle).toBe("form-4");
  });

  it("reads a string host.id when the entry gives none, and takes entry.id first", () => {
    const registrar = createAgentRegistrar();
    const byHost = registrar.registerForm({ host: stubHost("from-host"), catalogue: stubFormCatalogue, signal: new AbortController().signal });
    expect(byHost.handle).toBe("from-host");
    const byEntry = registrar.registerForm({
      host: stubHost("ignored"),
      catalogue: stubFormCatalogue,
      signal: new AbortController().signal,
      id: "from-entry"
    });
    expect(byEntry.handle).toBe("from-entry");
  });

  it("reports formId from the catalogue and never uses it as the handle", async () => {
    const registrar = createAgentRegistrar();
    registerForm(registrar, stubHost());
    const result = ok(await registrar.execute("describe_form", {}));
    expect(result.form).toBe("form-1");
    expect(result.formId).toBe("stub-form");
  });

  it("with one form the handle is optional, ignored when it matches, and form-unknown otherwise", async () => {
    const registrar = createAgentRegistrar();
    registerForm(registrar, stubHost("only"));
    expect(ok(await registrar.execute("describe_form", {})).form).toBe("only");
    expect(ok(await registrar.execute("describe_form", { form: "only" })).form).toBe("only");
    const unknown = refusal(await registrar.execute("describe_form", { form: "other" }));
    expect(unknown.code).toBe("form-unknown");
    expect(unknown.hint).toBe("Use one of the listed handles.");
    expect(unknown.form).toBeUndefined();
    expect(unknown.details).toEqual({
      forms: [{ form: "only", formId: "stub-form", title: "Stub form", fields: 3, pages: 1, locale: "en", session: false }]
    });
  });

  it("with two forms every tool but describe_form requires the handle; describe_form lists them without a revision", async () => {
    const registrar = createAgentRegistrar();
    const loading = stubHost("second");
    registerForm(registrar, stubHost());
    registerForm(registrar, loading);
    loading.readiness = { state: "loading" };
    const required = refusal(await registrar.execute("get_value", { path: "a" }));
    expect(required.code).toBe("form-required");
    expect(required.hint).toBe("Pass form with one of the listed handles; describe_form lists them.");
    expect(required.form).toBeUndefined();
    const listing = ok(await registrar.execute("describe_form", {}));
    expect(listing).toEqual({
      ok: true,
      tool: "describe_form",
      forms: [
        { form: "form-1", formId: "stub-form", title: "Stub form", fields: 3, pages: 1, locale: "en", session: false },
        { form: "second", title: "", fields: 0, pages: 0, locale: "", session: false, state: "loading" }
      ]
    });
    expect("revision" in listing).toBe(false);
    expect(ok(await registrar.execute("get_value", { path: "a", form: "form-1" })).form).toBe("form-1");
  });

  it("keeps a handle stable after another form unregisters", async () => {
    const registrar = createAgentRegistrar();
    const first = registerForm(registrar, stubHost());
    const second = registerForm(registrar, stubHost());
    first.controller.abort();
    expect(ok(await registrar.execute("describe_form", {})).form).toBe(second.registration.handle);
    expect(second.registration.handle).toBe("form-2");
  });

  it("answers *-not-ready from the catalogue's readiness with the exact hints and no revision", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    const { controller } = registerForm(registrar, host);
    host.readiness = { state: "loading" };
    const loading = refusal(await registrar.execute("describe_form", {}));
    expect(loading).toMatchObject({ code: "form-not-ready", details: { state: "loading" }, form: "form-1", retryable: true });
    expect(loading.hint).toBe("Wait a moment and call describe_form again.");
    expect(loading.revision).toBeUndefined();
    host.readiness = { state: "failed", message: "journeys chunk missing" };
    const failed = refusal(await registrar.execute("describe_form", {}));
    expect(failed.details).toEqual({ state: "failed", message: "journeys chunk missing" });
    expect(failed.hint).toBe("Tell the person the form could not load: journeys chunk missing.");
    host.readiness = { state: "removed" };
    expect(refusal(await registrar.execute("describe_form", {})).hint).toBe("The form is gone; stop.");
    controller.abort();
    // After unregistering, the kind's tools are gone from the page.
    expect(registrar.tools()).toEqual([]);
    expect(refusal(await registrar.execute("describe_form", {})).code).toBe("bad-input");
  });
});

describe("revision", () => {
  it("starts at 1, bumps per reported change and once per runtimeReplaced, and never resets", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    const { registration } = registerForm(registrar, host);
    expect(registration.revision()).toBe(1);
    host.change(["a"], "other");
    expect(registration.revision()).toBe(2);
    expect(ok(await registrar.execute("describe_form", {})).revision).toBe(2);
    registration.runtimeReplaced();
    expect(registration.revision()).toBe(3);
    expect(host.resets).toBe(1);
    host.change(["b", "c"], "other");
    expect(registration.revision()).toBe(4);
  });

  it("answers stale with the changed paths when expectedRevision is behind, applying nothing", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    host.change(["a"], "other");
    await registrar.execute("set_value", { path: "b", value: "1" });
    host.change(["c"], "other");
    const stale = refusal(await registrar.execute("set_value", { path: "d", value: "2", expectedRevision: 1 }));
    expect(stale.code).toBe("stale");
    expect(stale.hint).toBe("Re-read the changed fields with get_answers, then call again with the new revision.");
    expect(stale.details).toEqual({
      revision: 4,
      changedPaths: [
        { path: "a", by: "other" },
        { path: "b", by: "agent" },
        { path: "c", by: "other" }
      ]
    });
    expect(host.values).toEqual({ b: "1" });
    expect(ok(await registrar.execute("set_value", { path: "d", value: "2", expectedRevision: 4 })).revision).toBe(5);
  });

  it("stamps alsoChanged on write results from foreign changes since the agent's previous call, never on reads", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    await registrar.execute("describe_form", {});
    host.change(["name"], "other");
    host.change(["name", "email"], "other");
    const read = ok(await registrar.execute("get_value", { path: "name" }));
    expect(read.alsoChanged).toBeUndefined();
    host.change(["city"], "other");
    const write = ok(await registrar.execute("set_value", { path: "a", value: "b" }));
    expect(write.alsoChanged).toEqual(["city"]);
    const again = ok(await registrar.execute("set_value", { path: "c", value: "d" }));
    expect(again.alsoChanged).toBeUndefined();
  });

  it("caps alsoChanged at 20 and changedPaths at 50", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    for (let index = 0; index < 60; index += 1) {
      host.change([`p${index}`], "other");
    }
    const write = ok(await registrar.execute("set_value", { path: "a", value: "b" }));
    expect((write.alsoChanged as string[]).length).toBe(20);
    const stale = refusal(await registrar.execute("set_value", { path: "a", value: "b", expectedRevision: 1 }));
    expect((stale.details as { changedPaths: unknown[] }).changedPaths.length).toBe(50);
  });
});

describe("per-target serialisation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a slow write blocks the next write on the same handle but not a read and not another handle", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost("a");
    const other = stubHost("b");
    registerForm(registrar, host);
    registerForm(registrar, other);
    const slow = registrar.execute("slow_write", { form: "a" });
    const order: string[] = [];
    const queued = registrar.execute("set_value", { form: "a", path: "x", value: "1" }).then((result) => {
      order.push("queued-write");
      return result;
    });
    const read = registrar.execute("get_value", { form: "a", path: "x" }).then((result) => {
      order.push("read");
      return result;
    });
    const elsewhere = registrar.execute("set_value", { form: "b", path: "y", value: "2" }).then((result) => {
      order.push("other-handle");
      return result;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect([...order].sort()).toEqual(["other-handle", "read"]);
    expect(ok(await read).value).toBeNull();
    expect(host.values).toEqual({});
    host.release();
    expect(ok(await slow).done).toBe(true);
    expect(ok(await queued).written).toEqual(["x"]);
    expect(ok(await elsewhere).written).toEqual(["y"]);
    expect(order.at(-1)).toBe("queued-write");
  });

  it("a write queued over 10 s answers busy { previous-call } without running; the chain stays ordered", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    const slow = registrar.execute("slow_write", {});
    const queued = registrar.execute("set_value", { path: "x", value: "1" });
    await vi.advanceTimersByTimeAsync(QUEUE_TIMEOUT_MS + 1);
    const busy = refusal(await queued);
    expect(busy.code).toBe("busy");
    expect(busy.details).toMatchObject({ because: "previous-call" });
    expect(busy.hint).toBe("Wait a moment and call describe_form before retrying.");
    expect(busy.retryable).toBe(true);
    expect(host.values).toEqual({});
    const later = registrar.execute("set_value", { path: "z", value: "3" });
    host.release();
    expect(ok(await slow).done).toBe(true);
    expect(ok(await later).written).toEqual(["z"]);
    expect(host.values).toEqual({ slow: "done", z: "3" });
  });

  it("judges stale at the head of the chain, not when queued", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    const slow = registrar.execute("slow_write", {});
    const queued = registrar.execute("set_value", { path: "x", value: "1", expectedRevision: 1 });
    await vi.advanceTimersByTimeAsync(1);
    host.release();
    await slow;
    const stale = refusal(await queued);
    expect(stale.code).toBe("stale");
    expect((stale.details as { changedPaths: unknown[] }).changedPaths).toEqual([{ path: "slow", by: "agent" }]);
  });

  it("the session tools join the chain too", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    const slow = registrar.execute("slow_write", {});
    const begin = registrar.execute("begin_session", { purpose: "fill" });
    await vi.advanceTimersByTimeAsync(1);
    expect(host.hookCalls).toEqual([]);
    host.release();
    await slow;
    expect(ok(await begin).locked).toBe(false);
    expect(host.hookCalls).toEqual([{ hook: "begin", purpose: "fill" }]);
  });
});

describe("caps", () => {
  it("collapses a 70 KB inline option list and marks the result truncated", async () => {
    const registrar = createAgentRegistrar();
    registerForm(registrar, stubHost());
    const result = ok(await registrar.execute("big_options", {}));
    expect(result.truncated).toBe(true);
    expect((result.fields as Array<Record<string, unknown>>)[0]).toEqual({ path: "province", kind: "choice", optionCount: 2000 });
    expect(jsonByteLength(result)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
  });

  it("answers too-large { what: 'result' } for a 200 KB unpageable blob, keeping tool, form and revision", async () => {
    const registrar = createAgentRegistrar();
    registerForm(registrar, stubHost());
    const result = refusal(await registrar.execute("big_blob", {}));
    expect(result).toMatchObject({ ok: false, tool: "big_blob", code: "too-large", form: "form-1", revision: 1, retryable: false });
    expect(result.details).toMatchObject({ what: "result", limit: RESULT_BYTE_LIMIT });
    expect((result.details as { got: number }).got).toBeGreaterThan(RESULT_BYTE_LIMIT);
  });
});

describe("events and listing", () => {
  it("emits datum-agent-action through the catalogue after every call, with the input echo cut", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    const seen: RegistrarEvent[] = [];
    registrar.subscribe((event) => seen.push(event));
    await registrar.execute("set_value", { path: "a", value: "x".repeat(2_000), attachment: { data: "y".repeat(2_000) }, stray: 1 });
    const action = host.events.find((event) => event.type === "datum-agent-action")?.detail as AgentActionDetail;
    expect(action).toMatchObject({
      tool: "set_value",
      target: "form",
      handle: "form-1",
      readOnly: false,
      outcome: { ok: true },
      revision: 2,
      changed: true,
      trigger: "agent",
      paths: ["a"]
    });
    expect((action.input as { value: string }).value).toBe(`${"x".repeat(1_021)}…`);
    expect((action.input as { attachment: unknown }).attachment).toEqual({ omitted: "file" });
    // The echo is the validated input: the dropped unknown key is not in it.
    expect("stray" in (action.input as Record<string, unknown>)).toBe(false);
    expect(typeof action.durationMs).toBe("number");
    expect(seen.filter((event) => event.type === "action")).toHaveLength(1);
    const refused = await registrar.execute("refusing", {});
    expect(refused.ok).toBe(false);
    const last = host.events.at(-1)?.detail as AgentActionDetail;
    expect(last).toMatchObject({ tool: "refusing", readOnly: true, outcome: { ok: false, code: "unknown-field" }, changed: false });
    expect(last.paths).toBeUndefined();
  });

  it("a write that changes the target without a value path reports changed: true and no paths", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    const result = ok(await registrar.execute("pathless_write", {}));
    expect(result.revision).toBe(2);
    const action = host.events.filter((event) => event.type === "datum-agent-action").at(-1)?.detail as AgentActionDetail;
    expect(action).toMatchObject({ tool: "pathless_write", target: "form", readOnly: false, outcome: { ok: true }, revision: 2, changed: true });
    expect(action.paths).toBeUndefined();
    expect(action.componentIds).toBeUndefined();
    // A read after it changed nothing.
    await registrar.execute("describe_form", {});
    expect((host.events.at(-1)?.detail as AgentActionDetail).changed).toBe(false);
  });

  it("carries the submit start event before the registrar's final one", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    await registrar.execute("submit", {});
    const actions = host.events.filter((event) => event.type === "datum-agent-action").map((event) => event.detail as AgentActionDetail);
    expect(actions.map((detail) => detail.outcome)).toEqual([{ ok: true, code: "started" }, { ok: true }]);
  });

  it("emits tools-changed on registration and unregistration", () => {
    const registrar = createAgentRegistrar();
    const seen: RegistrarEvent[] = [];
    registrar.subscribe((event) => seen.push(event));
    const { controller } = registerForm(registrar, stubHost());
    expect(seen.at(-1)).toMatchObject({ type: "tools-changed" });
    expect((seen.at(-1) as { names: string[] }).names).toContain("begin_session");
    controller.abort();
    expect((seen.at(-1) as { names: string[] }).names).toEqual([]);
  });

  it("lists the session pair exactly once with a form and a builder registered, with core's exact words", () => {
    const registrar = createAgentRegistrar();
    registerForm(registrar, stubHost());
    registrar.registerBuilder({ host: builderHost(), catalogue: stubBuilderCatalogue, signal: new AbortController().signal });
    registerForm(registrar, stubHost());
    const names = registrar.tools().map((tool) => tool.name);
    expect(names.filter((name) => name === "begin_session")).toHaveLength(1);
    expect(names.filter((name) => name === "end_session")).toHaveLength(1);
    expect(names.filter((name) => name === "describe_form")).toHaveLength(1);
    expect(names).toContain("describe_builder");
    const begin = registrar.tools().find((tool) => tool.name === "begin_session");
    expect(begin?.title).toBe(SESSION_TOOL_TEXTS.begin_session.title);
    expect(begin?.description).toBe(SESSION_TOOL_TEXTS.begin_session.description);
    expect(begin?.annotations).toEqual({});
  });

  it("the routing wrappers run the pipeline and are never the catalogue's objects", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    const catalogue = stubFormCatalogue(host);
    registrar.registerForm({ host, catalogue: () => catalogue, signal: new AbortController().signal });
    const wrapper = registrar.tools().find((tool) => tool.name === "describe_form");
    expect(wrapper).toBeDefined();
    expect(catalogue.tools).not.toContain(wrapper);
    const result = (await wrapper?.execute({}, {
      host,
      signal: new AbortController().signal,
      revision: () => 0,
      session: undefined,
      state: new Map()
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, tool: "describe_form", form: "form-1", revision: 1 });
    const undo = registrar.tools().find((tool) => tool.name === "undo_agent_changes");
    expect(undo?.allowedWhileStopped).toBe(true);
    const wide = registrar.tools().find((tool) => tool.name === "wide_input");
    expect(wide?.inputBytes).toBe(512 * 1024);
  });

  it("skips a tool whose name breaks the pattern or collides, with a console.error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registrar = createAgentRegistrar();
    const host = stubHost();
    const catalogue = stubFormCatalogue(host);
    const bad = { ...(catalogue.tools[0] as (typeof catalogue.tools)[number]), name: "Bad-Name" };
    const collides = { ...(catalogue.tools[0] as (typeof catalogue.tools)[number]), name: "begin_session" };
    registrar.registerForm({
      host,
      catalogue: () => ({ ...catalogue, tools: [...catalogue.tools, bad, collides] }),
      signal: new AbortController().signal
    });
    const names = registrar.tools().map((tool) => tool.name);
    expect(names).not.toContain("Bad-Name");
    expect(names.filter((name) => name === "begin_session")).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

describe("agentRegistrarFor", () => {
  it("returns the same instance for the same document object and different ones for different objects", () => {
    const docA = {};
    const docB = {};
    expect(agentRegistrarFor(docA)).toBe(agentRegistrarFor(docA));
    expect(agentRegistrarFor(docA)).not.toBe(agentRegistrarFor(docB));
    expect(createAgentRegistrar()).not.toBe(agentRegistrarFor(docA));
  });

  it("createAgentRegistrar() touches no global", () => {
    const slot = Symbol.for("datum.agent.registrars");
    const globals = globalThis as unknown as Record<symbol, unknown>;
    const before = globals[slot];
    createAgentRegistrar();
    expect(globals[slot]).toBe(before);
  });
});

describe("catalogue seams", () => {
  function registerBuilder(registrar: AgentRegistrar, host: StubHost) {
    const controller = new AbortController();
    const registration = registrar.registerBuilder({ host, catalogue: stubBuilderCatalogue, signal: controller.signal });
    return { registration, controller };
  }

  it("staleDetails replaces the default details; a throwing one falls back to { revision, changedPaths }", async () => {
    const registrar = createAgentRegistrar();
    const calls: Array<[number, number]> = [];
    const host = builderHost();
    host.staleDetails = (revision, expected) => {
      calls.push([revision, expected]);
      return { revision, outline: { rootId: "form", nodes: [{ id: "form", type: "form", depth: 0 }], total: 1 } };
    };
    registerBuilder(registrar, host);
    host.change(["name"], "other");
    const stale = refusal(await registrar.execute("set_properties", { id: "name", expectedRevision: 1 }));
    expect(stale.code).toBe("stale");
    expect(stale.hint).toBe("Read the outline again and resend.");
    expect(stale.details).toEqual({ revision: 2, outline: { rootId: "form", nodes: [{ id: "form", type: "form", depth: 0 }], total: 1 } });
    expect(calls).toEqual([[2, 1]]);

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const throwing = createAgentRegistrar();
    const other = builderHost();
    other.staleDetails = () => {
      throw new Error("no outline");
    };
    registerBuilder(throwing, other);
    other.change(["name"], "other");
    const fallback = refusal(await throwing.execute("set_properties", { id: "name", expectedRevision: 1 }));
    expect(fallback.code).toBe("stale");
    expect(fallback.details).toEqual({ revision: 2, changedPaths: [{ path: "name", by: "other" }] });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("without staleDetails the default details stay", async () => {
    const registrar = createAgentRegistrar();
    const host = builderHost();
    registerBuilder(registrar, host);
    host.change(["name"], "other");
    expect(refusal(await registrar.execute("set_properties", { id: "name", expectedRevision: 1 })).details).toEqual({
      revision: 2,
      changedPaths: [{ path: "name", by: "other" }]
    });
  });

  it("calls link once with the allocated handle; emitAction fills target, handle, revision, trigger, sessionId and reaches subscribe()", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost("claim");
    registerForm(registrar, host);
    expect(host.linkCalls).toBe(1);
    const link = host.link;
    expect(link?.handle).toBe("claim");
    expect(link?.revision()).toBe(1);
    expect(link?.sessionId()).toBeUndefined();
    const seen: AgentActionDetail[] = [];
    registrar.subscribe((event) => {
      if (event.type === "action") {
        seen.push(event.detail);
      }
    });
    host.change(["a"], "other");
    link?.emitAction({ tool: "undo_agent_changes", input: { scope: "session" }, outcome: { ok: true }, paths: ["a"], changed: true, durationMs: 12 });
    const outside = { tool: "undo_agent_changes", target: "form", handle: "claim", readOnly: false, input: { scope: "session" }, outcome: { ok: true }, durationMs: 12, revision: 2, changed: true, trigger: "agent", paths: ["a"] };
    expect(seen).toEqual([outside]);
    expect(host.events.at(-1)).toEqual({ type: "datum-agent-action", detail: outside });
    // No call happened: the revision did not move and the agent has still not seen "a".
    expect(link?.revision()).toBe(2);
    expect(ok(await registrar.execute("set_value", { path: "b", value: "1" })).alsoChanged).toEqual(["a"]);

    ok(await registrar.execute("begin_session", { purpose: "p" }));
    expect(link?.sessionId()).toBe("session-1");
    seen.length = 0;
    link?.emitAction({ tool: "submit", input: {}, outcome: { ok: true, code: "started" } });
    expect(seen).toEqual([
      { tool: "submit", target: "form", handle: "claim", readOnly: false, input: {}, outcome: { ok: true, code: "started" }, durationMs: 0, revision: 3, changed: false, trigger: "agent", sessionId: "session-1" }
    ]);
  });

  it("the submit start event reaches subscribe() with the handle and the revision when the catalogue is linked", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    const seen: AgentActionDetail[] = [];
    registrar.subscribe((event) => {
      if (event.type === "action") {
        seen.push(event.detail);
      }
    });
    await registrar.execute("submit", {});
    expect(seen.map((detail) => [detail.outcome, detail.handle, detail.revision])).toEqual([
      [{ ok: true, code: "started" }, "form-1", 1],
      [{ ok: true }, "form-1", 1]
    ]);
  });

  it("a throwing link is logged and the registration still stands", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registrar = createAgentRegistrar();
    const host = stubHost();
    const controller = new AbortController();
    const registration = registrar.registerForm({
      host,
      catalogue: (h: StubHost) => ({
        ...stubFormCatalogue(h),
        link: () => {
          throw new Error("link failed");
        }
      }),
      signal: controller.signal
    });
    expect(registration.handle).toBe("form-1");
    expect(ok(await registrar.execute("describe_form", {})).form).toBe("form-1");
    expect(error).toHaveBeenCalledWith("[datum-agent] catalogue.link", expect.any(Error));
    error.mockRestore();
  });

  it("stamps undoSteps from an ok builder result's undo.steps, and never on a form target", async () => {
    const registrar = createAgentRegistrar();
    const builder = builderHost();
    builder.undoSteps = 2;
    registerBuilder(registrar, builder);
    const form = stubHost();
    registerForm(registrar, form);
    const result = ok(await registrar.execute("set_properties", { id: "name" }));
    expect(result.undo).toEqual({ steps: 2 });
    const detail = builder.events.filter((event) => event.type === "datum-agent-action").at(-1)?.detail as AgentActionDetail;
    expect(detail).toMatchObject({ tool: "set_properties", target: "builder", componentIds: ["name"], undoSteps: 2 });
    builder.undoSteps = undefined;
    ok(await registrar.execute("set_properties", { id: "email" }));
    expect(builder.events.filter((event) => event.type === "datum-agent-action").at(-1)?.detail).not.toHaveProperty("undoSteps");
    // A form result never carries it, even one with an undo field of its own.
    form.undoSteps = 1;
    const formResult = ok(await registrar.execute("set_value", { path: "a", value: "b", form: "form-1" }));
    expect(formResult.undo).toEqual({ steps: 1 });
    const formDetail = form.events.filter((event) => event.type === "datum-agent-action").at(-1)?.detail as AgentActionDetail;
    expect(formDetail.tool).toBe("set_value");
    expect(formDetail).not.toHaveProperty("undoSteps");
  });

  it("the cancelled hint names describe_builder on a builder target and describe_form on a form", async () => {
    const registrar = createAgentRegistrar();
    registerBuilder(registrar, builderHost());
    registerForm(registrar, stubHost());
    const controller = new AbortController();
    controller.abort();
    const builder = refusal(await registrar.execute("set_properties", { id: "name" }, { signal: controller.signal }));
    expect(builder.code).toBe("cancelled");
    expect(builder.hint).toBe("The call was cancelled. If stillRunning is set the action may still complete; call describe_builder before retrying.");
    const form = refusal(await registrar.execute("set_value", { path: "a", value: "b" }, { signal: controller.signal }));
    expect(form.hint).toBe("The call was cancelled. If stillRunning is set the action may still complete; call describe_form before retrying.");
  });
});

describe("later core additions", () => {
  function actions(host: StubHost): AgentActionDetail[] {
    return host.events.filter((event) => event.type === "datum-agent-action").map((event) => event.detail as AgentActionDetail);
  }

  async function settle(): Promise<void> {
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
  }

  it("a readActions read answers while Stop is set; a write action of the same tool answers stopped", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    host.stop?.();
    await settle();
    const read = ok(await registrar.execute("folded", { action: "list" }));
    expect(read).toMatchObject({ action: "list", changed: false });
    const write = refusal(await registrar.execute("folded", { action: "save", value: "x" }));
    expect(write.code).toBe("stopped");
    expect(host.values).toEqual({});
    // The latch still refuses the whole of a tool that names no read actions.
    expect(refusal(await registrar.execute("set_value", { path: "a", value: "b" })).code).toBe("stopped");
    host.allowAgain?.();
    expect(ok(await registrar.execute("folded", { action: "save", value: "x" })).changed).toBe(true);
    expect(host.values).toEqual({ folded: "x" });
  });

  it("a read action is not queued behind a held write, even one of its own tool", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    const order: string[] = [];
    const held = registrar.execute("folded", { action: "hold", value: "held" });
    const queued = registrar.execute("folded", { action: "save", value: "queued" }).then((result) => {
      order.push("queued-write");
      return result;
    });
    const read = registrar.execute("folded", { action: "list" }).then((result) => {
      order.push("read");
      return result;
    });
    expect(ok(await read).values).toEqual({});
    expect(order).toEqual(["read"]);
    expect(host.values).toEqual({});
    host.release();
    expect(ok(await held).action).toBe("hold");
    expect(ok(await queued).action).toBe("save");
    expect(order).toEqual(["read", "queued-write"]);
    expect(host.values).toEqual({ folded: "queued" });
  });

  it("the action event says readOnly: true for a read action and the result carries no alsoChanged; a write action keeps both", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    ok(await registrar.execute("describe_form", {}));
    host.change(["name"], "other");
    const read = ok(await registrar.execute("folded", { action: "list" }));
    expect(read.alsoChanged).toBeUndefined();
    expect(actions(host).at(-1)).toMatchObject({ tool: "folded", readOnly: true, input: { action: "list" }, outcome: { ok: true }, changed: false });
    host.change(["city"], "other");
    const write = ok(await registrar.execute("folded", { action: "save", value: "v" }));
    expect(write.alsoChanged).toEqual(["city"]);
    expect(actions(host).at(-1)).toMatchObject({ tool: "folded", readOnly: false, input: { action: "save", value: "v" }, changed: true, paths: ["folded"] });
  });

  it("a read action follows the read branch: shape, readiness, the schema check and cancelled still apply; expectedRevision is not judged", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    host.change(["a"], "other");
    // Like every readOnlyHint read today, a read action is never refused as stale.
    expect(ok(await registrar.execute("folded", { action: "list", expectedRevision: 1 })).revision).toBe(2);
    expect(refusal(await registrar.execute("folded", { action: "save", value: "v", expectedRevision: 1 })).code).toBe("stale");
    const bad = refusal(await registrar.execute("folded", { action: "list", value: 5 }));
    expect(bad.code).toBe("bad-input");
    expect(bad.details).toEqual({ problems: [{ key: "value", expected: "a string" }] });
    const stray = ok(await registrar.execute("folded", { action: "list", stray: 1 }));
    expect(stray.warnings).toEqual(["ignored unknown argument: stray"]);
    const controller = new AbortController();
    controller.abort();
    expect(refusal(await registrar.execute("folded", { action: "list" }, { signal: controller.signal })).code).toBe("cancelled");
    host.readiness = { state: "loading" };
    expect(refusal(await registrar.execute("folded", { action: "list" })).code).toBe("form-not-ready");
  });

  it("the routing wrapper carries a copy of readActions", () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    const catalogue = stubFormCatalogue(host);
    registrar.registerForm({ host, catalogue: () => catalogue, signal: new AbortController().signal });
    const own = catalogue.tools.find((tool) => tool.name === "folded");
    const wrapper = registrar.tools().find((tool) => tool.name === "folded");
    expect(wrapper?.readActions).toEqual({ key: "action", values: ["list"] });
    expect(wrapper?.readActions).not.toBe(own?.readActions);
    expect(registrar.tools().find((tool) => tool.name === "set_value")?.readActions).toBeUndefined();
  });

  it("consequential: true on every action event of a consequentialHint tool, whatever the outcome, and absent otherwise", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerForm(registrar, host);
    const seen: AgentActionDetail[] = [];
    registrar.subscribe((event) => {
      if (event.type === "action") {
        seen.push(event.detail);
      }
    });
    ok(await registrar.execute("submit", {}));
    const submitted = seen.at(-1) as AgentActionDetail;
    expect(submitted).toMatchObject({ tool: "submit", outcome: { ok: true }, consequential: true });
    expect(actions(host).at(-1)).toMatchObject({ tool: "submit", consequential: true });
    // The catalogue's own start event (emitAction) is unchanged.
    const started = seen.find((detail) => detail.outcome.code === "started");
    expect(started).toBeDefined();
    expect(started).not.toHaveProperty("consequential");
    // A refused call of a consequential tool is still flagged: the browser asked before it ran.
    expect(refusal(await registrar.execute("submit", { form: "nope" })).code).toBe("form-unknown");
    expect(seen.at(-1)).toMatchObject({ tool: "submit", outcome: { ok: false, code: "form-unknown" }, consequential: true });
    const inputs: Record<string, Record<string, unknown>> = {
      set_value: { path: "a", value: "b" },
      describe_form: {},
      begin_session: { purpose: "p" },
      end_session: { summary: "s" }
    };
    for (const [name, input] of Object.entries(inputs)) {
      ok(await registrar.execute(name, input));
      expect(seen.at(-1)?.tool).toBe(name);
      expect(seen.at(-1)).not.toHaveProperty("consequential");
    }
  });

  it("chunk-unavailable is a shared code and its refusals carry retryable: true", async () => {
    expect(SHARED_REFUSAL_CODES.includes("chunk-unavailable")).toBe(true);
    const registrar = createAgentRegistrar();
    registerForm(registrar, stubHost());
    const refused = refusal(await registrar.execute("refusing", { code: "chunk-unavailable" }));
    expect(refused).toMatchObject({ code: "chunk-unavailable", retryable: true });
  });

  it("FormRegistration.provenance forwards the catalogue's value and answers undefined without the method", async () => {
    const registrar = createAgentRegistrar();
    const account: AgentProvenance = {
      version: 1,
      involved: true,
      paths: ["name"],
      tables: [],
      complete: true,
      submittedBy: "page",
      sessions: 0,
      sessionOpen: false
    };
    const withIt = stubHost("with", { provenance: (by) => ({ ...account, submittedBy: by }) });
    const { registration } = registerForm(registrar, withIt);
    expect(registration.provenance("page")).toEqual(account);
    expect(registration.provenance("agent")).toEqual({ ...account, submittedBy: "agent" });
    expect(withIt.provenanceCalls).toEqual(["page", "agent"]);
    const without = registerForm(registrar, stubHost("without")).registration;
    expect(without.provenance("page")).toBeUndefined();
    const builder = registrar.registerBuilder({ host: builderHost(), catalogue: stubBuilderCatalogue, signal: new AbortController().signal });
    expect(builder.provenance("page")).toBeUndefined();
    const undecided = registerForm(registrar, stubHost("undecided", { provenance: () => undefined })).registration;
    expect(undecided.provenance("page")).toBeUndefined();
  });

  it("a throwing catalogue is logged and answered with the registrar's own account, never undefined", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registrar = createAgentRegistrar();
    const host = stubHost("", {
      provenance: () => {
        throw new Error("store gone");
      }
    });
    const { registration } = registerForm(registrar, host);
    expect(registration.provenance("page")).toEqual({
      version: 1,
      involved: false,
      paths: [],
      tables: [],
      complete: true,
      submittedBy: "page",
      sessions: 0,
      sessionOpen: false
    });
    ok(await registrar.execute("begin_session", { purpose: "p" }));
    ok(await registrar.execute("begin_session", { purpose: "again" }));
    ok(await registrar.execute("set_value", { path: "a", value: "b" }));
    expect(registration.provenance("agent")).toEqual({
      version: 1,
      involved: true,
      paths: [],
      tables: [],
      complete: false,
      submittedBy: "agent",
      sessions: 1,
      sessionOpen: true
    });
    ok(await registrar.execute("end_session", { summary: "done" }));
    expect(registration.provenance("page")).toMatchObject({ involved: true, complete: false, sessions: 1, sessionOpen: false });
    expect(error).toHaveBeenCalledWith("[datum-agent] catalogue.provenance", expect.any(Error));
    error.mockRestore();
  });
});

/**
 * The registrar's access gate
 * over a stub catalogue whose `access()` the test sets. Order per call: target → readiness →
 * access → schema check → Stop latch → write chain (readiness and access again) → body.
 */
describe("the access gate", () => {
  const AUTHOR_MESSAGE = "This form does not accept assistants: its author turned them off.";
  const UNSET_MESSAGE =
    "This form does not accept assistants: this site lets them fill only forms whose author allowed it, and this form's author has not.";
  const HINT = "Tell the person this form has to be filled in by them; do not fill it in any other way.";

  interface AccessHost {
    access: AgentAccessState | (() => AgentAccessState);
    /** Every tool body that ran, by name. */
    ran: string[];
  }

  /** The stub form catalogue plus `access()` and `answersWhenOff` on describe_form, every body counted. */
  function sealable(control: AccessHost) {
    return (host: StubHost): AgentCatalogue<StubHost> => {
      const base = stubFormCatalogue(host);
      return {
        ...base,
        tools: base.tools.map((tool) => ({
          ...tool,
          ...(tool.name === "describe_form" ? { answersWhenOff: true as const } : {}),
          execute: (input: Record<string, unknown>, ctx: Parameters<typeof tool.execute>[1]) => {
            control.ran.push(tool.name);
            return tool.execute(input, ctx);
          }
        })),
        access: () => (typeof control.access === "function" ? control.access() : control.access)
      };
    };
  }

  function registerSealable(registrar: AgentRegistrar, host: StubHost, control: AccessHost) {
    const controller = new AbortController();
    const registration = registrar.registerForm({ host, catalogue: sealable(control), signal: controller.signal });
    return { registration, controller };
  }

  it("refuses every tool but the answersWhenOff one with agent-off { by }, the exact texts, not retryable, before the schema check and the body", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    const control: AccessHost = { access: { state: "sealed", by: "author" }, ran: [] };
    registerSealable(registrar, host, control);
    const actions: AgentActionDetail[] = [];
    registrar.subscribe((event) => {
      if (event.type === "action") {
        actions.push(event.detail);
      }
    });
    // Bad input (no value) answers agent-off, not bad-input: access is judged before the schema.
    const bad = refusal(await registrar.execute("set_value", { path: "a" }));
    expect(bad).toEqual({
      ok: false,
      tool: "set_value",
      code: "agent-off",
      message: AUTHOR_MESSAGE,
      hint: HINT,
      retryable: false,
      details: { by: "author" },
      form: "form-1",
      revision: 1
    });
    // A read tool is refused too; only describe_form (answersWhenOff) reaches its body.
    expect(refusal(await registrar.execute("get_value", { path: "a" })).code).toBe("agent-off");
    expect(ok(await registrar.execute("describe_form", {})).title).toBe("Stub form");
    expect(control.ran).toEqual(["describe_form"]);
    expect(host.values).toEqual({});
    // Each refusal is reported like any refused call, so a host sees that an assistant tried.
    expect(actions.map((detail) => [detail.tool, detail.outcome])).toEqual([
      ["set_value", { ok: false, code: "agent-off" }],
      ["get_value", { ok: false, code: "agent-off" }],
      ["describe_form", { ok: true }]
    ]);
    expect(SHARED_REFUSAL_CODES).toContain("agent-off");
    expect(retryableFor("agent-off", { by: "author" })).toBe(false);
  });

  it("answers the unset message for a form nobody allowed", async () => {
    const registrar = createAgentRegistrar();
    registerSealable(registrar, stubHost(), { access: { state: "sealed", by: "unset" }, ran: [] });
    expect(refusal(await registrar.execute("set_value", { path: "a", value: "b" }))).toMatchObject({
      code: "agent-off",
      message: UNSET_MESSAGE,
      hint: HINT,
      details: { by: "unset" }
    });
  });

  it("judges readiness first: a loading sealed form answers form-not-ready, retryable", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost("", { readiness: { state: "loading" } });
    registerSealable(registrar, host, { access: { state: "sealed", by: "author" }, ran: [] });
    const result = refusal(await registrar.execute("set_value", { path: "a", value: "b" }));
    expect(result.code).toBe("form-not-ready");
    expect(result.retryable).toBe(true);
    expect(refusal(await registrar.execute("describe_form", {})).code).toBe("form-not-ready");
  });

  it("refuses the session pair before any session hook runs", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registerSealable(registrar, host, { access: { state: "sealed", by: "author" }, ran: [] });
    expect(refusal(await registrar.execute("begin_session", { purpose: "Fill it" }))).toMatchObject({ code: "agent-off", details: { by: "author" } });
    expect(refusal(await registrar.execute("end_session", {})).code).toBe("agent-off");
    expect(host.hookCalls).toEqual([]);
    expect(host.events.filter((event) => event.type === "datum-agent-session")).toEqual([]);
  });

  it("judges access again at the head of the write chain: a write queued across a flip to sealed answers agent-off and does not run", async () => {
    vi.useFakeTimers();
    try {
      const registrar = createAgentRegistrar();
      const host = stubHost();
      const control: AccessHost = { access: { state: "live" }, ran: [] };
      const { registration } = registerSealable(registrar, host, control);
      const slow = registrar.execute("slow_write", {});
      const queued = registrar.execute("set_value", { path: "x", value: "1" });
      await vi.advanceTimersByTimeAsync(10);
      control.access = { state: "sealed", by: "author" };
      registration.accessChanged();
      host.release();
      expect(ok(await slow).done).toBe(true);
      expect(refusal(await queued)).toMatchObject({ code: "agent-off", details: { by: "author" } });
      expect(control.ran).toEqual(["slow_write"]);
      expect(host.values).toEqual({ slow: "done" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("access() reads the catalogue; accessChanged() bumps the revision, ends a session as rebuilt and re-announces the tools only on a flip, never resetting", async () => {
    const registrar = createAgentRegistrar();
    const host = stubHost();
    const control: AccessHost = { access: { state: "live" }, ran: [] };
    const { registration } = registerSealable(registrar, host, control);
    const events: RegistrarEvent[] = [];
    registrar.subscribe((event) => {
      if (event.type === "tools-changed") {
        events.push(event);
      }
    });
    expect(registration.access()).toEqual({ state: "live" });
    ok(await registrar.execute("set_value", { path: "a", value: "b" }));
    ok(await registrar.execute("begin_session", { purpose: "Fill it" }));
    const before = registration.revision();
    // No change: nothing moves.
    registration.accessChanged();
    expect(registration.revision()).toBe(before);
    expect(events).toEqual([]);
    // A flip: one bump, the session ends rebuilt, tools-changed once; the catalogue is not reset.
    control.access = { state: "sealed", by: "unset" };
    expect(registration.access()).toEqual({ state: "sealed", by: "unset" });
    registration.accessChanged();
    expect(registration.revision()).toBe(before + 1);
    expect(host.hookCalls.filter((call) => call.hook === "end")).toEqual([{ hook: "end", reason: "rebuilt" }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "tools-changed" });
    expect(host.resets).toBe(0);
    registration.accessChanged();
    expect(registration.revision()).toBe(before + 1);
    expect(events).toHaveLength(1);
    // Sealed by another `by` is a flip too.
    control.access = { state: "sealed", by: "author" };
    registration.accessChanged();
    expect(registration.revision()).toBe(before + 2);
    // Live again: the per-target state survived (no reset), the next write runs.
    control.access = { state: "live" };
    registration.accessChanged();
    const written = ok(await registrar.execute("set_value", { path: "c", value: "d" }));
    expect(written.sessionEnded).toEqual({ reason: "rebuilt", undone: 0 });
    expect(host.lastState?.get("writes")).toBe(2);
  });

  it("fails closed: a throwing access() is logged and answered sealed unset", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registrar = createAgentRegistrar();
    const control: AccessHost = {
      access: () => {
        throw new Error("no definition");
      },
      ran: []
    };
    const { registration } = registerSealable(registrar, stubHost(), control);
    expect(registration.access()).toEqual({ state: "sealed", by: "unset" });
    expect(refusal(await registrar.execute("set_value", { path: "a", value: "b" }))).toMatchObject({ code: "agent-off", details: { by: "unset" } });
    expect(error).toHaveBeenCalledWith("[datum-agent] catalogue.access", expect.any(Error));
    error.mockRestore();
  });

  it("a catalogue without access() is live; a builder registration is always live and accessChanged() does nothing", async () => {
    const registrar = createAgentRegistrar();
    const plain = registerForm(registrar, stubHost("plain")).registration;
    expect(plain.access()).toEqual({ state: "live" });
    const builder = registrar.registerBuilder({ host: builderHost(), catalogue: stubBuilderCatalogue, signal: new AbortController().signal });
    expect(builder.access()).toEqual({ state: "live" });
    const revision = builder.revision();
    builder.accessChanged();
    expect(builder.revision()).toBe(revision);
    expect(ok(await registrar.execute("set_properties", { id: "x" })).changed).toEqual(["x"]);
  });

  it("lists a sealed form with its title kept, the counts zeroed and who sealed it, in the listing, form-required and form-unknown", async () => {
    const registrar = createAgentRegistrar();
    registerForm(registrar, stubHost("open"));
    registerSealable(registrar, stubHost("closed", { summary: { formId: "decl", title: "Statutory declaration", fields: 4, pages: 2, locale: "fr" } }), {
      access: { state: "sealed", by: "author" },
      ran: []
    });
    const sealedRow = { form: "closed", title: "Statutory declaration", fields: 0, pages: 0, locale: "", session: false, state: "off", by: "author" };
    const liveRow = { form: "open", formId: "stub-form", title: "Stub form", fields: 3, pages: 1, locale: "en", session: false };
    expect(ok(await registrar.execute("describe_form", {})).forms).toEqual([liveRow, sealedRow]);
    expect(refusal(await registrar.execute("set_value", { path: "a", value: "b" })).details).toEqual({ forms: [liveRow, sealedRow] });
    expect(refusal(await registrar.execute("set_value", { form: "nope", path: "a", value: "b" })).details).toEqual({ forms: [liveRow, sealedRow] });
    // The sealed one by its handle: describe_form answers, a write is refused.
    expect(refusal(await registrar.execute("set_value", { form: "closed", path: "a", value: "b" })).code).toBe("agent-off");
  });

  it("judges readiness before access: a sealed form still loading keeps its loading row, with no by", async () => {
    const registrar = createAgentRegistrar();
    registerForm(registrar, stubHost("open"));
    const loading = stubHost("closed", { summary: { formId: "decl", title: "Statutory declaration", fields: 4, pages: 2, locale: "fr" } });
    registerSealable(registrar, loading, { access: { state: "sealed", by: "author" }, ran: [] });
    loading.readiness = { state: "loading" };
    const liveRow = { form: "open", formId: "stub-form", title: "Stub form", fields: 3, pages: 1, locale: "en", session: false };
    const loadingRow = { form: "closed", title: "", fields: 0, pages: 0, locale: "", session: false, state: "loading" };
    expect(ok(await registrar.execute("describe_form", {})).forms).toEqual([liveRow, loadingRow]);
  });
});

/**
 * The registrar calls
 * `dispose()` once for every tool of the target on a rebuild (before `catalogue.reset()`) and on
 * unregister (after the catalogue's `unwatch`), each in its own try, so a throwing tool is logged
 * and the rest are still disposed. Only the target's own tools: another registration's are kept.
 */
describe("tool dispose", () => {
  /** The stub form catalogue with every tool given a dispose that logs its name; reset and unwatch log too. */
  function disposable(log: string[], throwing?: string) {
    return (host: StubHost): AgentCatalogue<StubHost> => {
      const base = stubFormCatalogue(host);
      return {
        ...base,
        tools: base.tools.map((tool) => ({
          ...tool,
          dispose: () => {
            log.push(tool.name);
            if (tool.name === throwing) {
              throw new Error("dispose broke");
            }
          }
        })),
        reset: () => {
          log.push("reset");
          base.reset();
        },
        watch: (report) => {
          const off = base.watch(report);
          return () => {
            log.push("unwatch");
            off();
          };
        }
      };
    };
  }

  function registerDisposable(registrar: AgentRegistrar, host: StubHost, log: string[], throwing?: string) {
    const controller = new AbortController();
    const registration = registrar.registerForm({ host, catalogue: disposable(log, throwing), signal: controller.signal });
    return { registration, controller };
  }

  it("disposes every tool once on runtimeReplaced, before the catalogue resets, and the tools still answer after", async () => {
    const registrar = createAgentRegistrar();
    const log: string[] = [];
    const { registration } = registerDisposable(registrar, stubHost(), log);
    const names = stubFormCatalogue(stubHost()).tools.map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(1);
    expect(log).toEqual([]);
    registration.runtimeReplaced();
    expect(log).toEqual([...names, "reset"]);
    expect(ok(await registrar.execute("describe_form", {})).title).toBe("Stub form");
    // A second rebuild disposes again, once per tool.
    log.length = 0;
    registration.runtimeReplaced();
    expect(log).toEqual([...names, "reset"]);
  });

  it("disposes every tool once on unregister, after unwatch, and never again for a registration already gone", () => {
    const registrar = createAgentRegistrar();
    const log: string[] = [];
    const { registration, controller } = registerDisposable(registrar, stubHost(), log);
    const names = stubFormCatalogue(stubHost()).tools.map((tool) => tool.name);
    controller.abort();
    expect(log).toEqual(["unwatch", ...names]);
    registration.unregister("disconnected");
    registration.runtimeReplaced();
    expect(log).toEqual(["unwatch", ...names]);
    // An explicit unregister takes the same path.
    const other: string[] = [];
    registerDisposable(registrar, stubHost(), other).registration.unregister("features-changed");
    expect(other).toEqual(["unwatch", ...names]);
  });

  it("logs a throwing dispose and still disposes the rest, on both paths, and touches no other registration", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const registrar = createAgentRegistrar();
      const log: string[] = [];
      const kept: string[] = [];
      const names = stubFormCatalogue(stubHost()).tools.map((tool) => tool.name);
      const throwing = names[0] as string;
      const { registration, controller } = registerDisposable(registrar, stubHost("first"), log, throwing);
      registerDisposable(registrar, stubHost("second"), kept);
      expect(() => registration.runtimeReplaced()).not.toThrow();
      expect(log).toEqual([...names, "reset"]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toContain(throwing);
      log.length = 0;
      expect(() => controller.abort()).not.toThrow();
      expect(log).toEqual(["unwatch", ...names]);
      expect(error).toHaveBeenCalledTimes(2);
      expect(kept).toEqual([]);
      // The other form still answers.
      expect(ok(await registrar.execute("describe_form", {})).form).toBe("second");
    } finally {
      error.mockRestore();
    }
  });
});
