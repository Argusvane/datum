import { describe, expect, it, vi } from "vitest";
import { bindTools, detectModelContext } from "../form-engine/agent/model-context-binding.js";
import { createAgentRegistrar, type AgentRegistrar, type RegistrarEvent } from "../form-engine/agent/registrar.js";
import type { AgentTool, RegisteredToolEntry } from "../form-engine/agent/tool-types.js";
import { createFakeModelContext, type FakeModelContext } from "../form-engine/testing/fake-model-context.js";
import { builderHost, stubBuilderCatalogue, stubFormCatalogue, stubHost } from "./fixtures/agent-stub-catalogue.js";

/**
 * The ModelContext binding over the fake ModelContext: detection,
 * registration under the registrar's signals, the failure states, both input shapes, the
 * byte-for-byte equality of the browser's result with `registrar.execute()`, synchronous
 * removal on abort with in-flight calls completing, and the catch-all that keeps `executeTool`
 * from ever rejecting for a tool failure.
 */
function registerForm(registrar: AgentRegistrar, id = "") {
  const host = stubHost(id);
  const controller = new AbortController();
  const registration = registrar.registerForm({ host, catalogue: stubFormCatalogue, signal: controller.signal });
  return { host, controller, registration };
}

async function entryOf(mc: FakeModelContext, name: string): Promise<RegisteredToolEntry> {
  const entry = (await mc.getTools()).find((tool) => tool.name === name);
  if (entry === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return entry;
}

describe("detectModelContext", () => {
  it("answers undefined under plain node and never throws", () => {
    expect(detectModelContext()).toBeUndefined();
    expect(detectModelContext({})).toBeUndefined();
  });

  it("reads document.modelContext alone, requiring registerTool", () => {
    const mc = createFakeModelContext();
    expect(detectModelContext({ modelContext: mc })).toBe(mc);
    expect(detectModelContext({ modelContext: { getTools: () => [] } })).toBeUndefined();
    // A navigator.modelContext is not WebMCP's registration point: it is never read.
    const navigatorSlot = globalThis as { navigator?: unknown };
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { modelContext: mc }, configurable: true });
    try {
      expect(detectModelContext({})).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete navigatorSlot.navigator;
      } else {
        Object.defineProperty(globalThis, "navigator", previous);
      }
    }
  });
});

describe("bindTools", () => {
  const tool: AgentTool = {
    name: "echo",
    title: "Echo",
    description: "echoes",
    inputSchema: { type: "object", properties: { a: { type: "number", description: "a" } } },
    annotations: { readOnlyHint: true },
    execute: (input) => ({ echoed: input })
  };

  it("registers each tool with the signal and routes execute through run", async () => {
    const mc = createFakeModelContext();
    const controller = new AbortController();
    const run = vi.fn(async (name: string, input: unknown) => ({ ok: true as const, tool: name, revision: 1, got: input }));
    const state = await bindTools(mc, [tool], run, { signal: controller.signal });
    expect(state).toEqual({ registered: true, names: ["echo"] });
    const entry = await entryOf(mc, "echo");
    expect(entry.annotations).toEqual({ readOnlyHint: true, consequentialHint: false, untrustedContentHint: false });
    expect(await mc.executeTool(entry, { a: 1 })).toBe(JSON.stringify({ ok: true, tool: "echo", revision: 1, got: { a: 1 } }));
    expect(run).toHaveBeenCalledWith("echo", { a: 1 }, expect.any(AbortSignal));
    controller.abort();
    expect(mc.names()).toEqual([]);
  });

  it("reports not-allowed, duplicate and error without throwing", async () => {
    const denied = createFakeModelContext({ allowed: false });
    expect(await bindTools(denied, [tool], async () => ({ ok: true, tool: "echo", revision: 1 }), { signal: new AbortController().signal })).toEqual({
      registered: false,
      reason: "not-allowed",
      names: []
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const taken = createFakeModelContext();
    await taken.registerTool({ ...tool, execute: () => ({}) }, { signal: new AbortController().signal });
    const other: AgentTool = { ...tool, name: "other" };
    expect(await bindTools(taken, [tool, other], async () => ({ ok: true, tool: "x", revision: 1 }), { signal: new AbortController().signal })).toEqual({
      registered: true,
      reason: "duplicate",
      names: ["other"]
    });
    expect(await bindTools(taken, [tool], async () => ({ ok: true, tool: "x", revision: 1 }), { signal: new AbortController().signal })).toEqual({
      registered: false,
      reason: "duplicate",
      names: []
    });
    const broken = {
      ...createFakeModelContext(),
      registerTool: () => Promise.reject(new DOMException("blocked", "SecurityError"))
    } as unknown as FakeModelContext;
    expect(await bindTools(broken, [tool], async () => ({ ok: true, tool: "x", revision: 1 }), { signal: new AbortController().signal })).toEqual({
      registered: false,
      reason: "error",
      names: []
    });
    const aborted = new AbortController();
    aborted.abort();
    expect(await bindTools(createFakeModelContext(), [tool], async () => ({ ok: true, tool: "x", revision: 1 }), { signal: aborted.signal })).toEqual({
      registered: false,
      names: []
    });
    error.mockRestore();
  });
});

describe("registrar.bind", () => {
  it("answers no-api when nothing is detected and keeps execute() working", async () => {
    const registrar = createAgentRegistrar();
    registerForm(registrar);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    expect(await registrar.bind()).toEqual({ registered: false, reason: "no-api", names: [] });
    expect(registrar.binding()).toEqual({ registered: false, reason: "no-api", names: [] });
    expect((await registrar.execute("describe_form", {})).ok).toBe(true);
    debug.mockRestore();
  });

  it("registers the form set and the session pair, is idempotent, and follows later registrations", async () => {
    const registrar = createAgentRegistrar();
    const mc = createFakeModelContext();
    const first = registerForm(registrar);
    const state = await registrar.bind(mc);
    expect(state.registered).toBe(true);
    expect(state.reason).toBeUndefined();
    expect(mc.names()).toContain("describe_form");
    expect(mc.names()).toContain("begin_session");
    expect(mc.names().filter((name) => name === "end_session")).toHaveLength(1);
    expect(await registrar.bind(mc)).toEqual(state);
    expect(mc.toolchanges).toBeGreaterThan(0);
    // A builder arriving later is registered without touching the form set.
    const builderNames = ["describe_builder", "set_properties"];
    registrar.registerBuilder({ host: builderHost(), catalogue: stubBuilderCatalogue, signal: new AbortController().signal });
    await vi.waitFor(() => {
      expect(mc.names()).toEqual(expect.arrayContaining(builderNames));
    });
    expect(registrar.binding().names).toEqual(expect.arrayContaining([...builderNames, "describe_form", "begin_session"]));
    // The last form leaving aborts the form set synchronously; the session pair stays for the builder.
    first.controller.abort();
    expect(mc.names()).not.toContain("describe_form");
    expect(mc.names()).toContain("begin_session");
    expect(mc.names()).toEqual(expect.arrayContaining(builderNames));
    expect(registrar.binding().names).not.toContain("describe_form");
  });

  it("two callers binding in the same tick both get the registered state, and tools-changed reports it", async () => {
    // Two <datum-form features="all agent"> elements connect together and each awaits bind()
    // before dispatching its datum-agent-tools: the second must not read the
    // initial { registered: false } while the first's registrations are still landing.
    const registrar = createAgentRegistrar();
    const mc = createFakeModelContext();
    registerForm(registrar);
    const seen: RegistrarEvent[] = [];
    registrar.subscribe((event) => seen.push(event));
    const [first, second] = await Promise.all([registrar.bind(mc), registrar.bind(mc)]);
    expect(first.registered).toBe(true);
    expect(first.names).toContain("describe_form");
    expect(second).toEqual(first);
    const changed = seen.filter((event): event is Extract<RegistrarEvent, { type: "tools-changed" }> => event.type === "tools-changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.binding).toEqual(first);
    // Settled: a later bind() for the same API answers the same state without re-registering.
    expect(await registrar.bind(mc)).toEqual(first);
    expect(mc.names().filter((name) => name === "describe_form")).toHaveLength(1);
  });

  it("a set registered after an awaited bind() is in the state the next awaited bind() answers", async () => {
    // The builder element connects after the form's bind landed and itself awaits bind() before
    // its first datum-agent-tools: that state must already hold the builder's names.
    const registrar = createAgentRegistrar();
    const mc = createFakeModelContext();
    registerForm(registrar);
    await registrar.bind(mc);
    registrar.registerBuilder({ host: builderHost(), catalogue: stubBuilderCatalogue, signal: new AbortController().signal });
    const state = await registrar.bind(mc);
    expect(state.names).toEqual(expect.arrayContaining(["describe_builder", "set_properties", "describe_form", "begin_session"]));
    expect(state).toEqual(registrar.binding());
    expect(mc.names()).toEqual(expect.arrayContaining(["describe_builder", "set_properties"]));
    // Settled again: the landing cleared itself and a later bind() answers at once with the same state.
    expect(await registrar.bind(mc)).toEqual(state);
    expect(mc.names().filter((name) => name === "describe_builder")).toHaveLength(1);
  });

  it("a set registered during an in-flight bind() lands before that bind() resolves", async () => {
    const registrar = createAgentRegistrar();
    const mc = createFakeModelContext();
    registerForm(registrar);
    const first = registrar.bind(mc);
    registrar.registerBuilder({ host: builderHost(), catalogue: stubBuilderCatalogue, signal: new AbortController().signal });
    const second = registrar.bind(mc);
    expect((await second).names).toEqual(expect.arrayContaining(["describe_builder", "describe_form"]));
    expect((await first).names).toContain("describe_form");
    expect(registrar.binding().names).toEqual(expect.arrayContaining(["describe_builder", "set_properties"]));
    expect(mc.names().filter((name) => name === "set_properties")).toHaveLength(1);
  });

  it("reports not-allowed under Permissions-Policy tools=() and duplicate for taken names", async () => {
    const denied = createAgentRegistrar();
    registerForm(denied);
    expect((await denied.bind(createFakeModelContext({ allowed: false }))).reason).toBe("not-allowed");
    expect(denied.binding().registered).toBe(false);

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mc = createFakeModelContext();
    await mc.registerTool(
      { name: "describe_form", title: "x", description: "taken", inputSchema: { type: "object" }, execute: () => ({}) },
      { signal: new AbortController().signal }
    );
    const registrar = createAgentRegistrar();
    registerForm(registrar);
    const state = await registrar.bind(mc);
    expect(state.reason).toBe("duplicate");
    expect(state.registered).toBe(true);
    expect(state.names).not.toContain("describe_form");
    expect(state.names).toContain("get_value");
    error.mockRestore();
  });
});

describe("the browser path", () => {
  it("executeTool's result equals JSON.stringify(registrar.execute()) byte for byte, for object and string input", async () => {
    const registrar = createAgentRegistrar();
    const mc = createFakeModelContext();
    registerForm(registrar);
    await registrar.bind(mc);
    const entry = await entryOf(mc, "describe_form");
    const direct = await registrar.execute("describe_form", { scope: "all" });
    expect(await mc.executeTool(entry, { scope: "all" })).toBe(JSON.stringify(direct));
    // Older previews hand a string: the pipeline parses it once.
    const bound = mc.calls.at(-1);
    expect(bound?.name).toBe("describe_form");
    const viaString = await registrar.execute("describe_form", JSON.stringify({ scope: "all" }));
    expect(JSON.stringify(viaString)).toBe(JSON.stringify(direct));
    const refused = await registrar.execute("get_value", {});
    const refusedEntry = await entryOf(mc, "get_value");
    expect(await mc.executeTool(refusedEntry, {})).toBe(JSON.stringify(refused));
  });

  it("a tool that throws never rejects executeTool: the envelope carries internal", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registrar = createAgentRegistrar();
    const mc = createFakeModelContext();
    registerForm(registrar);
    await registrar.bind(mc);
    const text = await mc.executeTool(await entryOf(mc, "throwing"), {});
    expect(JSON.parse(text as string)).toMatchObject({ ok: false, code: "internal", message: "boom", retryable: false });
    expect(mc.calls.at(-1)?.error).toBeUndefined();
    error.mockRestore();
  });

  it("an input the pipeline cannot serialise (a BigInt, a cycle) never rejects executeTool either: internal, and the action fires", async () => {
    // structuredClone carries both, so a page script calling executeTool can hand them over;
    // the registrar's catch-all, not the body's, is what keeps the agent from an opaque UnknownError.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registrar = createAgentRegistrar();
    const mc = createFakeModelContext();
    const { host } = registerForm(registrar);
    await registrar.bind(mc);
    const entry = await entryOf(mc, "set_value");
    const big = JSON.parse((await mc.executeTool(entry, { path: "a", value: "b", attachment: { n: 1n } })) as string);
    expect(big).toMatchObject({ ok: false, code: "internal", form: "form-1" });
    expect(mc.calls.at(-1)?.error).toBeUndefined();
    const cyclic: Record<string, unknown> = { path: "a", value: "b" };
    cyclic.attachment = cyclic;
    const circle = JSON.parse((await mc.executeTool(entry, cyclic)) as string);
    expect(circle).toMatchObject({ ok: false, code: "internal", form: "form-1" });
    expect(mc.calls.at(-1)?.error).toBeUndefined();
    const actions = host.events.filter((event) => event.type === "datum-agent-action").map((event) => event.detail as { outcome: { code?: string } });
    expect(actions.map((detail) => detail.outcome.code)).toEqual(["internal", "internal"]);
    expect(host.values).toEqual({});
    error.mockRestore();
  });

  it("passes the executeTool signal to the tool as ctx.signal", async () => {
    const registrar = createAgentRegistrar();
    const mc = createFakeModelContext();
    const { host } = registerForm(registrar);
    await registrar.bind(mc);
    const controller = new AbortController();
    const pending = mc.executeTool(await entryOf(mc, "signal_probe"), {}, { signal: controller.signal });
    controller.abort();
    // The browser rejects with the caller's reason; the pipeline still finished with cancelled.
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => {
      const probe = host.events
        .map((event) => event.detail as { tool: string; outcome: { code?: string } })
        .find((detail) => detail.tool === "signal_probe");
      expect(probe?.outcome).toEqual({ ok: false, code: "cancelled" });
    });
  });

  it("abort removes the tools synchronously while an in-flight call completes", async () => {
    const registrar = createAgentRegistrar();
    const mc = createFakeModelContext();
    const { host, controller } = registerForm(registrar);
    await registrar.bind(mc);
    const entry = await entryOf(mc, "slow_write");
    const pending = mc.executeTool(entry, {});
    // The body is running (it observed its context) and now waits on the gate.
    await vi.waitFor(() => {
      expect(host.lastState).toBeDefined();
    });
    controller.abort();
    expect(mc.names()).toEqual([]);
    host.release();
    const text = await pending;
    expect(JSON.parse(text as string)).toMatchObject({ ok: true, tool: "slow_write", done: true });
    // Registering the same names again right after the abort is safe.
    registerForm(registrar);
    await vi.waitFor(() => {
      expect(mc.names()).toContain("describe_form");
    });
  });
});
