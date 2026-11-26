import { describe, expect, it, vi } from "vitest";

import { lazyTool, type ToolBody } from "../form-engine/agent/lazy-tool.js";
import { createAgentRegistrar } from "../form-engine/agent/registrar.js";
import { ToolRefusal, type AgentCatalogue, type AgentTool, type ToolContext, type ToolData } from "../form-engine/agent/tool-types.js";
import { stubFormCatalogue, stubHost, type StubHost } from "./fixtures/agent-stub-catalogue.js";

/**
 * `lazyTool`: the descriptor is
 * readable before any load, two calls load the body once, a rejected load answers
 * `chunk-unavailable { what, state: "failed" }` and is forgotten so the next call loads again,
 * and the body's own refusals pass through unchanged.
 */

const DESCRIPTOR: Omit<AgentTool, "execute"> = {
  name: "lazy_probe",
  title: "Lazy probe",
  description: "A tool whose body loads on first use.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "save"], description: "list: read. save: write." },
      form: { type: "string", description: "Which form." }
    },
    required: ["action"]
  },
  annotations: { untrustedContentHint: true },
  readActions: { key: "action", values: ["list"] },
  inputBytes: 512 * 1024
};

function context(signal: AbortSignal = new AbortController().signal): ToolContext {
  return { host: {}, signal, revision: () => 1, session: undefined, state: new Map() };
}

/** A load the test lands by hand, so a call can be caught while its body is still on the way. */
function heldLoad<H = unknown>(): { load: () => Promise<ToolBody<Record<string, unknown>, H>>; land: (body: ToolBody<Record<string, unknown>, H>) => void; fail: (error: unknown) => void; loads: () => number } {
  let land: (body: ToolBody<Record<string, unknown>, H>) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const pending = new Promise<ToolBody<Record<string, unknown>, H>>((resolve, reject) => {
    land = resolve;
    fail = reject;
  });
  let loads = 0;
  return {
    load: () => {
      loads += 1;
      return pending;
    },
    land: (body) => land(body),
    fail: (error) => fail(error),
    loads: () => loads
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** What a call rejected with (`undefined` when it resolved). */
function rejectionOf(call: Promise<unknown> | unknown): Promise<unknown> {
  return Promise.resolve(call).then(
    () => undefined,
    (error: unknown) => error
  );
}

function echoBody(): ToolBody {
  return { run: (input) => ({ ran: input.action }) };
}

async function refusalOf(promise: Promise<unknown> | unknown): Promise<ToolRefusal> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolRefusal);
    return error as ToolRefusal;
  }
  throw new Error("expected a ToolRefusal");
}

describe("lazyTool", () => {
  it("is synchronous: name, title, description, schema, annotations, readActions and inputBytes are readable before any load", () => {
    const load = vi.fn(() => Promise.resolve(echoBody()));
    const tool = lazyTool(DESCRIPTOR, load, "agent-try");
    expect(tool.name).toBe("lazy_probe");
    expect(tool.title).toBe("Lazy probe");
    expect(tool.description).toBe("A tool whose body loads on first use.");
    expect(tool.inputSchema).toBe(DESCRIPTOR.inputSchema);
    expect(tool.annotations).toEqual({ untrustedContentHint: true });
    expect(tool.readActions).toEqual({ key: "action", values: ["list"] });
    expect(tool.inputBytes).toBe(512 * 1024);
    expect(typeof tool.execute).toBe("function");
    expect(load).not.toHaveBeenCalled();
  });

  it("loads the body once for two calls, concurrent or not, and hands it the input and the context", async () => {
    const seen: Array<[unknown, ToolContext]> = [];
    const load = vi.fn(() =>
      Promise.resolve<ToolBody>({
        run(input, ctx) {
          seen.push([input, ctx]);
          return { ran: input.action };
        }
      })
    );
    const tool = lazyTool(DESCRIPTOR, load, "agent-try");
    const ctx = context();
    const [first, second] = await Promise.all([tool.execute({ action: "list" }, ctx), tool.execute({ action: "save" }, ctx)]);
    expect(first).toEqual({ ran: "list" });
    expect(second).toEqual({ ran: "save" });
    expect(await tool.execute({ action: "list" }, ctx)).toEqual({ ran: "list" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(seen.map(([input]) => input)).toEqual([{ action: "list" }, { action: "save" }, { action: "list" }]);
    expect(seen[0]?.[1]).toBe(ctx);
  });

  it("a rejected load answers chunk-unavailable { what, state: 'failed' } and the next call loads again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let attempts = 0;
    const load = vi.fn(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new TypeError("Failed to fetch dynamically imported module")) : Promise.resolve(echoBody());
    });
    const tool = lazyTool(DESCRIPTOR, load, "agent-languages");
    const refused = await refusalOf(tool.execute({ action: "list" }, context()));
    expect(refused.code).toBe("chunk-unavailable");
    expect(refused.message).toBe("Part of the assistant tools could not be loaded.");
    expect(refused.hint).toBe("Try once more; if it fails again the host removed that file: tell the person.");
    expect(refused.details).toEqual({ what: "agent-languages", state: "failed" });
    expect(await tool.execute({ action: "list" }, context())).toEqual({ ran: "list" });
    expect(await tool.execute({ action: "save" }, context())).toEqual({ ran: "save" });
    expect(load).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("a load that throws synchronously, or resolves without a body, answers the same refusal and is retried", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outcomes: Array<() => Promise<ToolBody>> = [
      () => {
        throw new Error("sync");
      },
      () => Promise.resolve({} as ToolBody),
      () => Promise.resolve(echoBody())
    ];
    let attempt = 0;
    const tool = lazyTool(DESCRIPTOR, () => (outcomes[attempt++] as () => Promise<ToolBody>)(), "agent-documents");
    expect((await refusalOf(tool.execute({ action: "list" }, context()))).details).toEqual({ what: "agent-documents", state: "failed" });
    expect((await refusalOf(tool.execute({ action: "list" }, context()))).details).toEqual({ what: "agent-documents", state: "failed" });
    expect(await tool.execute({ action: "list" }, context())).toEqual({ ran: "list" });
    expect(attempt).toBe(3);
    error.mockRestore();
  });

  it("passes the body's own refusals and results through unchanged", async () => {
    const tool = lazyTool(
      DESCRIPTOR,
      () =>
        Promise.resolve<ToolBody>({
          run: async (input): Promise<ToolData> => {
            if (input.action === "save") {
              throw new ToolRefusal("unknown-document", "No journey has that id.", "Use an id from list.", { id: "x" });
            }
            return { action: "list", changed: false };
          }
        }),
      "agent-documents"
    );
    const refused = await refusalOf(tool.execute({ action: "save" }, context()));
    expect(refused).toMatchObject({ code: "unknown-document", message: "No journey has that id.", hint: "Use an id from list.", details: { id: "x" } });
    expect(await tool.execute({ action: "list" }, context())).toEqual({ action: "list", changed: false });
  });

  it("through the registrar: a failed body load is a retryable chunk-unavailable refusal, a read action stays a read, and a retry runs the body", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let fail = true;
    const tool = lazyTool<Record<string, unknown>, StubHost>(
      { ...DESCRIPTOR, inputSchema: DESCRIPTOR.inputSchema },
      () => (fail ? Promise.reject(new Error("offline")) : Promise.resolve<ToolBody<Record<string, unknown>, StubHost>>({ run: (input) => ({ action: input.action }) })),
      "agent-try"
    );
    const catalogue = (host: StubHost): AgentCatalogue<StubHost> => {
      const base = stubFormCatalogue(host);
      return { ...base, tools: [...base.tools, tool] };
    };
    const registrar = createAgentRegistrar();
    const host = stubHost();
    registrar.registerForm({ host, catalogue, signal: new AbortController().signal });
    const actions: unknown[] = [];
    registrar.subscribe((event) => {
      if (event.type === "action") {
        actions.push(event.detail);
      }
    });
    const refused = await registrar.execute("lazy_probe", { action: "list" });
    expect(refused).toMatchObject({ ok: false, code: "chunk-unavailable", retryable: true, details: { what: "agent-try", state: "failed" }, form: "form-1" });
    expect(actions.at(-1)).toMatchObject({ tool: "lazy_probe", readOnly: true, outcome: { ok: false, code: "chunk-unavailable" } });
    fail = false;
    expect(await registrar.execute("lazy_probe", { action: "save" })).toMatchObject({ ok: true, action: "save" });
    expect(actions.at(-1)).toMatchObject({ tool: "lazy_probe", readOnly: false, outcome: { ok: true } });
    error.mockRestore();
  });

  it("watches the caller's signal while the body loads: an abort rejects at once as an AbortError, the body never runs, the load is kept for the next call", async () => {
    const held = heldLoad();
    let ran = 0;
    const tool = lazyTool(DESCRIPTOR, held.load, "agent-documents");
    const controller = new AbortController();
    const call = tool.execute({ action: "save" }, context(controller.signal));
    await tick();
    expect(held.loads()).toBe(1);
    controller.abort();
    // Rejects before the body lands: the registrar maps an AbortError to its own `cancelled`.
    const rejected = await rejectionOf(call);
    expect(rejected).not.toBeInstanceOf(ToolRefusal);
    expect((rejected as { name?: unknown }).name).toBe("AbortError");
    held.land({
      run: (input) => {
        ran += 1;
        return { ran: input.action };
      }
    });
    await tick();
    expect(ran).toBe(0);
    // The next call reuses the load the aborted one started.
    expect(await tool.execute({ action: "save" }, context())).toEqual({ ran: "save" });
    expect(ran).toBe(1);
    expect(held.loads()).toBe(1);

    // A signal already aborted never starts a load; a load that fails after an abort is the
    // abort, not chunk-unavailable (nothing to tell the person about the file).
    const unstarted = heldLoad();
    const already = new AbortController();
    already.abort();
    const early = await rejectionOf(lazyTool(DESCRIPTOR, unstarted.load, "agent-try").execute({ action: "list" }, context(already.signal)));
    expect((early as { name?: unknown }).name).toBe("AbortError");
    expect(unstarted.loads()).toBe(0);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = heldLoad();
    const late = new AbortController();
    const lateCall = rejectionOf(lazyTool(DESCRIPTOR, failing.load, "agent-languages").execute({ action: "list" }, context(late.signal)));
    await tick();
    late.abort();
    failing.fail(new TypeError("Failed to fetch dynamically imported module"));
    const lateError = await lateCall;
    expect(lateError).not.toBeInstanceOf(ToolRefusal);
    expect((lateError as { name?: unknown }).name).toBe("AbortError");
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("through the registrar: an abort while a write's body loads answers cancelled, frees the write chain at once, and the body never runs", async () => {
    const held = heldLoad<StubHost>();
    let ran = 0;
    const tool = lazyTool<Record<string, unknown>, StubHost>(
      {
        name: "lazy_write",
        title: "Lazy write",
        description: "A consequential write whose body loads on first use.",
        inputSchema: { type: "object", properties: { form: { type: "string", description: "Which form." } } },
        annotations: { consequentialHint: true }
      },
      held.load,
      "agent-documents"
    );
    const catalogue = (host: StubHost): AgentCatalogue<StubHost> => {
      const base = stubFormCatalogue(host);
      return { ...base, tools: [...base.tools, tool] };
    };
    const registrar = createAgentRegistrar({ queueTimeoutMs: 50 });
    const host = stubHost();
    registrar.registerForm({ host, catalogue, signal: new AbortController().signal });
    const controller = new AbortController();
    const call = registrar.execute("lazy_write", {}, { signal: controller.signal });
    await tick();
    expect(held.loads()).toBe(1);
    controller.abort();
    expect(await call).toMatchObject({ ok: false, code: "cancelled", retryable: true, form: "form-1" });
    // The chain is free: the next write runs instead of answering busy { previous-call }.
    expect(await registrar.execute("set_value", { path: "a", value: "b" })).toMatchObject({ ok: true, written: ["a"] });
    held.land({
      run: () => {
        ran += 1;
        host.values.removed = true;
        return { removed: true };
      }
    });
    await tick();
    expect(ran).toBe(0);
    expect(host.values.removed).toBeUndefined();
    // A fresh call runs the body the aborted call's load brought in, without loading again.
    expect(await registrar.execute("lazy_write", {})).toMatchObject({ ok: true, removed: true });
    expect(ran).toBe(1);
    expect(held.loads()).toBe(1);
  });
});

/**
 * The tool's `dispose()` reaches the body
 * the registrar cannot see. A loaded body is disposed at once, a load on the way has its body
 * disposed once it lands (and again by a call that waited on it, once its run() starts), a failed
 * load has nothing to dispose; the memo is kept throughout.
 */
describe("lazyTool dispose", () => {
  it("disposes a loaded body at once and keeps the memo: the next call runs the same body without a second load", async () => {
    const dispose = vi.fn();
    const load = vi.fn(() => Promise.resolve<ToolBody>({ run: (input) => ({ ran: input.action }), dispose }));
    const tool = lazyTool(DESCRIPTOR, load, "agent-try");
    // Before any call nothing is loaded: dispose loads nothing and disposes nothing.
    tool.dispose?.();
    expect(load).not.toHaveBeenCalled();
    expect(await tool.execute({ action: "list" }, context())).toEqual({ ran: "list" });
    tool.dispose?.();
    // Synchronous: the registrar's unregister is, and a subscription must not outlive it by a turn.
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(await tool.execute({ action: "save" }, context())).toEqual({ ran: "save" });
    expect(load).toHaveBeenCalledTimes(1);
    // A body without dispose: the tool's dispose does nothing and throws nothing.
    const plain = lazyTool(DESCRIPTOR, () => Promise.resolve(echoBody()), "agent-try");
    expect(await plain.execute({ action: "list" }, context())).toEqual({ ran: "list" });
    expect(() => plain.dispose?.()).not.toThrow();
  });

  it("disposes the body of a load still on the way once it lands, and again after the waiting call's run starts; a throw there is logged, not raised", async () => {
    const held = heldLoad();
    const tool = lazyTool(DESCRIPTOR, held.load, "agent-try");
    const call = tool.execute({ action: "list" }, context());
    tool.dispose?.();
    const order: string[] = [];
    const dispose = vi.fn(() => order.push("dispose"));
    held.land({
      run: (input) => {
        order.push("run");
        return { ran: input.action };
      },
      dispose
    });
    expect(await call).toEqual({ ran: "list" });
    await tick();
    // The pending dispose's reaction lands first; the call that waited runs, then disposes again.
    expect(order).toEqual(["dispose", "run", "dispose"]);
    expect(held.loads()).toBe(1);
    // A call begun after the dispose does not dispose: only a later dispose does, once.
    expect(await tool.execute({ action: "list" }, context())).toEqual({ ran: "list" });
    expect(dispose).toHaveBeenCalledTimes(2);
    tool.dispose?.();
    expect(dispose).toHaveBeenCalledTimes(3);
    // The same on the way, with a body whose dispose throws: neither throw is raised, both are
    // logged, and the waiting call still answers.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const throwing = heldLoad();
    const other = lazyTool(DESCRIPTOR, throwing.load, "agent-try");
    const pending = other.execute({ action: "list" }, context());
    other.dispose?.();
    throwing.land({
      run: (input) => ({ ran: input.action }),
      dispose: () => {
        throw new Error("dispose broke");
      }
    });
    expect(await pending).toEqual({ ran: "list" });
    await tick();
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("lazy_probe");
    expect(String(error.mock.calls[1]?.[0])).toContain("lazy_probe");
    error.mockRestore();
  });

  it("a call that waited on the load across a dispose drops what its run() subscribed, and a call begun after the dispose keeps its own", async () => {
    // A body like try_it's: run() subscribes in its synchronous part, dispose() unsubscribes.
    const listeners = new Set<() => void>();
    let heard: (() => void) | undefined;
    const subscribingBody = (): ToolBody => ({
      async run(input) {
        if (heard === undefined) {
          heard = () => undefined;
          listeners.add(heard);
        }
        await tick();
        return { ran: input.action };
      },
      dispose() {
        if (heard !== undefined) {
          listeners.delete(heard);
          heard = undefined;
        }
      }
    });
    const held = heldLoad();
    const tool = lazyTool(DESCRIPTOR, held.load, "agent-try");
    const call = tool.execute({ action: "list" }, context());
    // The registration goes while the body is still on the way; the call keeps waiting on it.
    tool.dispose?.();
    held.land(subscribingBody());
    // The pending dispose's reaction runs before the call's run(): without the second dispose the
    // subscription run() makes would outlive the registration.
    expect(await call).toEqual({ ran: "list" });
    expect(listeners.size).toBe(0);
    // The rebuilt registration's call began after the dispose: its subscription is its own and stays.
    expect(await tool.execute({ action: "save" }, context())).toEqual({ ran: "save" });
    expect(listeners.size).toBe(1);
    expect(held.loads()).toBe(1);
    // And the next dispose removes it at once.
    tool.dispose?.();
    expect(listeners.size).toBe(0);
  });

  it("a load that fails has nothing to dispose, and the next call loads again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const held = heldLoad();
    const dispose = vi.fn();
    let attempts = 0;
    const load = vi.fn(() => {
      attempts += 1;
      return attempts === 1 ? held.load() : Promise.resolve<ToolBody>({ run: () => ({ ran: "again" }), dispose });
    });
    const tool = lazyTool(DESCRIPTOR, load, "agent-try");
    const call = tool.execute({ action: "list" }, context());
    tool.dispose?.();
    held.fail(new TypeError("Failed to fetch dynamically imported module"));
    expect((await refusalOf(call)).code).toBe("chunk-unavailable");
    await tick();
    // Only the load's own log; the dispose that waited on it did nothing and raised nothing.
    expect(error).toHaveBeenCalledTimes(1);
    // The failed load was forgotten: a dispose now has nothing to reach, and the next call loads again.
    tool.dispose?.();
    expect(await tool.execute({ action: "list" }, context())).toEqual({ ran: "again" });
    expect(load).toHaveBeenCalledTimes(2);
    expect(dispose).not.toHaveBeenCalled();
    tool.dispose?.();
    expect(dispose).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
