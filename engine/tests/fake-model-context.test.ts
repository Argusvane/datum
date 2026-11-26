import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createFakeModelContext, type FakeModelContext } from "../form-engine/testing/fake-model-context.js";
import type { RegisteredToolEntry } from "../form-engine/agent/tool-types.js";

/**
 * The ModelContext double, line by line against the Chrome 155 behaviour. Registrar, binding and host-page tests lean on this
 * double, so each of its promises is pinned here.
 */
function echoTool(name = "echo", extra: Record<string, unknown> = {}) {
  return {
    name,
    title: "Echo",
    description: "echoes its input",
    inputSchema: { type: "object", properties: { a: { type: "number", description: "a" } } },
    annotations: { readOnlyHint: true },
    execute: (input: unknown) => ({ echoed: input }),
    ...extra
  };
}

async function entryOf(mc: FakeModelContext, name: string): Promise<RegisteredToolEntry> {
  const entry = (await mc.getTools()).find((tool) => tool.name === name);
  if (entry === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return entry;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function expectDomException(error: unknown, name: string, message: string): void {
  expect(error).toBeInstanceOf(DOMException);
  expect((error as DOMException).name).toBe(name);
  expect((error as DOMException).message).toBe(message);
}

describe("registerTool", () => {
  it("rejects TypeError when name, description or execute is missing, or execute is not a function", async () => {
    const mc = createFakeModelContext();
    const { name: _n, ...noName } = echoTool();
    const { description: _d, ...noDescription } = echoTool();
    const { execute: _e, ...noExecute } = echoTool();
    for (const tool of [noName, noDescription, noExecute, echoTool("x", { execute: 5 })]) {
      expect(await rejection(mc.registerTool(tool))).toBeInstanceOf(TypeError);
    }
    expect(mc.names()).toEqual([]);
  });

  it("rejects InvalidStateError 'Invalid tool name' for an empty, over-long or badly charactered name", async () => {
    const mc = createFakeModelContext();
    for (const name of ["", "a".repeat(129), "has space", "café", "a/b"]) {
      expectDomException(await rejection(mc.registerTool(echoTool(name))), "InvalidStateError", "Invalid tool name");
    }
    for (const name of ["a".repeat(128), "a.b", "a-b", "UpperCase"]) {
      await mc.registerTool(echoTool(name));
    }
    expect(mc.names()).toEqual(["UpperCase", "a-b", "a.b", "a".repeat(128)]);
  });

  it("rejects InvalidStateError 'Description is required' for an empty description", async () => {
    const mc = createFakeModelContext();
    expectDomException(
      await rejection(mc.registerTool(echoTool("x", { description: "" }))),
      "InvalidStateError",
      "Description is required"
    );
  });

  it("rejects InvalidStateError 'Duplicate tool name' and keeps the first", async () => {
    const mc = createFakeModelContext();
    await mc.registerTool(echoTool("dup", { execute: () => "first" }));
    expectDomException(
      await rejection(mc.registerTool(echoTool("dup", { execute: () => "second" }))),
      "InvalidStateError",
      "Duplicate tool name"
    );
    expect(await mc.executeTool(await entryOf(mc, "dup"))).toBe("first");
  });

  it("rejects AbortError for a pre-aborted signal and lists nothing", async () => {
    const mc = createFakeModelContext();
    const controller = new AbortController();
    controller.abort();
    expectDomException(
      await rejection(mc.registerTool(echoTool(), { signal: controller.signal })),
      "AbortError",
      "signal is aborted without reason"
    );
    expect(mc.names()).toEqual([]);
  });

  it("rejects NotAllowedError from every method under Permissions-Policy tools=()", async () => {
    const mc = createFakeModelContext({ allowed: false });
    const message = 'Access to the feature "tools" is disallowed by permissions policy.';
    expectDomException(await rejection(mc.registerTool(echoTool())), "NotAllowedError", message);
    expectDomException(await rejection(mc.getTools()), "NotAllowedError", message);
    expectDomException(
      await rejection(mc.executeTool({ name: "echo", title: "", description: "d", origin: "o", annotations: { readOnlyHint: false, consequentialHint: false, untrustedContentHint: false } })),
      "NotAllowedError",
      message
    );
  });

  it("resolves undefined and fires one toolchange asynchronously as a plain Event", async () => {
    const mc = createFakeModelContext();
    const seen: Event[] = [];
    mc.addEventListener("toolchange", (event) => seen.push(event));
    const pending = mc.registerTool(echoTool());
    // The event is a microtask away: nothing has fired when registerTool returns its promise.
    expect(mc.toolchanges).toBe(0);
    expect(seen).toHaveLength(0);
    const resolved = await pending;
    expect(resolved).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(mc.toolchanges).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.constructor).toBe(Event);
    expect(seen[0]?.type).toBe("toolchange");
    expect("toolName" in (seen[0] as object)).toBe(false);
  });

  it("stores a deep copy of inputSchema, drops function members, keeps only the three hints as booleans, and reads a missing title as ''", async () => {
    const mc = createFakeModelContext();
    const schema = { type: "object", properties: { a: { type: "number" } }, fn: () => 1 } as Record<string, unknown>;
    const tool = echoTool("t", {
      inputSchema: schema,
      annotations: { readOnlyHint: "true", consequentialHint: 1, destructiveHint: true, debugging: true, bogus: 1 }
    });
    delete (tool as Record<string, unknown>).title;
    await mc.registerTool(tool);
    schema.mutated = true;
    const entry = await entryOf(mc, "t");
    expect(entry.inputSchema).toEqual({ type: "object", properties: { a: { type: "number" } } });
    expect(entry.inputSchema).not.toBe(schema);
    expect(entry.annotations).toEqual({ readOnlyHint: true, consequentialHint: true, untrustedContentHint: false });
    expect(entry.title).toBe("");
  });

  it("accepts a tool without inputSchema and leaves the key out of the entry", async () => {
    const mc = createFakeModelContext();
    const { inputSchema: _s, ...noSchema } = echoTool("bare");
    await mc.registerTool(noSchema);
    expect("inputSchema" in (await entryOf(mc, "bare"))).toBe(false);
  });
});

describe("abort", () => {
  it("removes the tool synchronously and fires one asynchronous toolchange", async () => {
    const mc = createFakeModelContext();
    const controller = new AbortController();
    await mc.registerTool(echoTool(), { signal: controller.signal });
    await Promise.resolve();
    const before = mc.toolchanges;
    controller.abort();
    // Removal is synchronous; the event is not (the await below is where it may fire).
    expect(mc.names()).toEqual([]);
    expect(mc.toolchanges).toBe(before);
    expect((await mc.getTools()).map((tool) => tool.name)).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(mc.toolchanges).toBe(before + 1);
  });

  it("does not cancel an in-flight execute, which resolves normally", async () => {
    const mc = createFakeModelContext();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    let ctxAborted: boolean | undefined;
    await mc.registerTool(
      echoTool("slow", {
        execute: async (_input: unknown, ctx: { signal: AbortSignal }) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          ctxAborted = ctx.signal.aborted;
          return { done: true };
        }
      }),
      { signal: controller.signal }
    );
    const entry = await entryOf(mc, "slow");
    const pending = mc.executeTool(entry, {});
    controller.abort();
    expect(mc.names()).toEqual([]);
    release?.();
    expect(await pending).toBe('{"done":true}');
    expect(ctxAborted).toBe(false);
  });
});

describe("getTools", () => {
  it("returns fresh plain dictionaries sorted by name without execute, a deep copy per call", async () => {
    const mc = createFakeModelContext({ origin: "https://page.test" });
    await mc.registerTool(echoTool("zeta"));
    await mc.registerTool(echoTool("alpha"));
    const first = await mc.getTools();
    const second = await mc.getTools();
    expect(first.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
    expect(Object.keys(first[0] as object).sort()).toEqual(["annotations", "description", "inputSchema", "name", "origin", "title", "window"]);
    expect("execute" in (first[0] as object)).toBe(false);
    expect(first[0]).toEqual({
      name: "alpha",
      title: "Echo",
      description: "echoes its input",
      inputSchema: { type: "object", properties: { a: { type: "number", description: "a" } } },
      annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: false },
      origin: "https://page.test",
      window: undefined
    });
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]?.inputSchema).not.toBe(second[0]?.inputSchema);
    expect(first[0]?.constructor).toBe(Object);
  });

  it("uses the default origin https://fake.test", async () => {
    const mc = createFakeModelContext();
    await mc.registerTool(echoTool());
    expect((await entryOf(mc, "echo")).origin).toBe("https://fake.test");
  });
});

describe("executeTool", () => {
  it("rejects TypeError unless the entry is an object with string name, description and origin", async () => {
    const mc = createFakeModelContext();
    await mc.registerTool(echoTool());
    const notEntry = await rejection(mc.executeTool("echo" as unknown as RegisteredToolEntry));
    expect(notEntry).toBeInstanceOf(TypeError);
    expect((notEntry as TypeError).message).toContain("The provided value is not of type 'RegisteredTool'");
    const noDescription = await rejection(mc.executeTool({ name: "echo" } as unknown as RegisteredToolEntry));
    expect(noDescription).toBeInstanceOf(TypeError);
    expect((noDescription as TypeError).message).toContain("Failed to read the 'description' property from 'RegisteredTool'");
    const noOrigin = await rejection(mc.executeTool({ name: "echo", description: "d" } as unknown as RegisteredToolEntry));
    expect((noOrigin as TypeError).message).toContain("Failed to read the 'origin' property from 'RegisteredTool'");
    // The original tool object is not a handle either.
    expect(await rejection(mc.executeTool(echoTool() as unknown as RegisteredToolEntry))).toBeInstanceOf(TypeError);
  });

  it("looks the tool up by name from any getTools() entry, old or fresh", async () => {
    const mc = createFakeModelContext();
    await mc.registerTool(echoTool());
    const stale = await entryOf(mc, "echo");
    await mc.registerTool(echoTool("other"));
    expect(await mc.executeTool(stale, { a: 8 })).toBe('{"echoed":{"a":8}}');
  });

  it("passes {} when input is omitted", async () => {
    const mc = createFakeModelContext();
    await mc.registerTool(echoTool());
    expect(await mc.executeTool(await entryOf(mc, "echo"))).toBe('{"echoed":{}}');
  });

  it("rejects TypeError 'invalid input object' for a string, number, null or array input", async () => {
    const mc = createFakeModelContext();
    await mc.registerTool(echoTool());
    const entry = await entryOf(mc, "echo");
    for (const input of [JSON.stringify({ a: 2 }), "not json", 42, null, [1]]) {
      const error = await rejection(mc.executeTool(entry, input));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toContain("invalid input object: value is not an object");
    }
    expect(mc.calls).toEqual([]);
  });

  it("hands execute a structured clone and { signal } with this not the tool, and does not validate against the schema", async () => {
    const mc = createFakeModelContext();
    const seen: Array<{ input: unknown; ctxKeys: string[]; signalOk: boolean; self: unknown; args: number }> = [];
    const tool = echoTool("probe", {
      execute: function (this: unknown, ...args: unknown[]) {
        const [input, ctx] = args as [unknown, { signal: AbortSignal }];
        seen.push({ input, ctxKeys: Object.keys(ctx), signalOk: ctx.signal instanceof AbortSignal, self: this, args: args.length });
        return { ok: true };
      }
    });
    await mc.registerTool(tool);
    const input = { a: "not a number", zzz: true, nested: { d: [1, 2] } };
    await mc.executeTool(await entryOf(mc, "probe"), input);
    expect(seen[0]?.input).toEqual(input);
    expect(seen[0]?.input).not.toBe(input);
    expect(seen[0]?.ctxKeys).toEqual(["signal"]);
    expect(seen[0]?.signalOk).toBe(true);
    expect(seen[0]?.self).not.toBe(tool);
    expect(seen[0]?.args).toBe(2);
  });

  it("stringifies results as Chrome does", async () => {
    const mc = createFakeModelContext();
    const cases: Array<[unknown, string]> = [
      ["hello", "hello"],
      ['{"already":"json"}', '{"already":"json"}'],
      [5, "5"],
      [true, "true"],
      [null, "null"],
      [undefined, "undefined"],
      [[1, "a"], '[1,"a"]'],
      [{ f: () => 1, keep: 1 }, '{"keep":1}'],
      [{ toJSON: () => ({ via: "toJSON" }) }, '{"via":"toJSON"}'],
      [10n, "10"],
      [new Date(0), '"1970-01-01T00:00:00.000Z"'],
      [Promise.resolve({ later: true }), '{"later":true}'],
      [{ content: [{ type: "text", text: "hi" }] }, '{"content":[{"type":"text","text":"hi"}]}']
    ];
    let index = 0;
    for (const [value, expected] of cases) {
      const name = `case_${index++}`;
      await mc.registerTool(echoTool(name, { execute: () => value }));
      expect(await mc.executeTool(await entryOf(mc, name)), name).toBe(expected);
    }
    await mc.registerTool(echoTool("big", { execute: () => "x".repeat(1_048_576) }));
    expect((await mc.executeTool(await entryOf(mc, "big")))?.length).toBe(1_048_576);
  });

  it("records every call with its result", async () => {
    const mc = createFakeModelContext();
    await mc.registerTool(echoTool());
    await mc.executeTool(await entryOf(mc, "echo"), { a: 1 });
    expect(mc.calls).toEqual([{ name: "echo", input: { a: 1 }, result: '{"echoed":{"a":1}}' }]);
  });

  it("rejects the opaque UnknownError for a throw, a rejection or a circular value, recording the real error", async () => {
    const mc = createFakeModelContext();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const failures: Array<[string, () => unknown]> = [
      ["throws", () => { throw new Error("boom"); }],
      ["rejects", async () => { throw new TypeError("async boom"); }],
      ["plain", () => { throw "plain string"; }],
      ["circular", () => circular]
    ];
    for (const [name, execute] of failures) {
      await mc.registerTool(echoTool(name, { execute }));
      const error = await rejection(mc.executeTool(await entryOf(mc, name)));
      expectDomException(
        error,
        "UnknownError",
        "Tool was executed but the invocation failed. For example, the script function threw an error"
      );
    }
    expect(mc.calls.map((call) => call.name)).toEqual(["throws", "rejects", "plain", "circular"]);
    expect((mc.calls[0]?.error as Error).message).toBe("boom");
    expect(mc.calls[1]?.error).toBeInstanceOf(TypeError);
    expect(mc.calls[2]?.error).toBe("plain string");
    expect(mc.calls[3]?.error).toBeInstanceOf(TypeError);
    expect(mc.calls.every((call) => call.result === undefined)).toBe(true);
  });

  it("rejects with the caller's reason for a pre-aborted signal without running", async () => {
    const mc = createFakeModelContext();
    let ran = false;
    await mc.registerTool(echoTool("never", { execute: () => { ran = true; return {}; } }));
    const controller = new AbortController();
    controller.abort(new DOMException("caller aborted", "AbortError"));
    const error = await rejection(mc.executeTool(await entryOf(mc, "never"), {}, { signal: controller.signal }));
    expectDomException(error, "AbortError", "caller aborted");
    expect(ran).toBe(false);
    const bare = new AbortController();
    bare.abort();
    expectDomException(
      await rejection(mc.executeTool(await entryOf(mc, "never"), {}, { signal: bare.signal })),
      "AbortError",
      "This operation was aborted"
    );
  });

  it("removes its abort listener from the caller's signal once the call settles", async () => {
    const mc = createFakeModelContext();
    await mc.registerTool(echoTool());
    const entry = await entryOf(mc, "echo");
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    for (let index = 0; index < 12; index += 1) {
      await mc.executeTool(entry, { a: index }, { signal: controller.signal });
    }
    const abortAdds = added.mock.calls.filter(([type]) => type === "abort");
    const abortRemoves = removed.mock.calls.filter(([type]) => type === "abort");
    expect(abortAdds).toHaveLength(12);
    expect(abortRemoves).toHaveLength(12);
    // The same function comes off that went on, so no closure outlives its call.
    expect(abortRemoves.map(([, listener]) => listener)).toEqual(abortAdds.map(([, listener]) => listener));
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("rejects with the caller's reason on a mid-call abort and fires ctx.signal", async () => {
    const mc = createFakeModelContext();
    let ctxSignal: AbortSignal | undefined;
    await mc.registerTool(
      echoTool("hang", {
        execute: (_input: unknown, ctx: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            ctxSignal = ctx.signal;
            ctx.signal.addEventListener("abort", () => resolve({ aborted: true }));
          })
      })
    );
    const controller = new AbortController();
    const pending = mc.executeTool(await entryOf(mc, "hang"), {}, { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new DOMException("caller aborted", "AbortError"));
    expectDomException(await rejection(pending), "AbortError", "caller aborted");
    expect(ctxSignal?.aborted).toBe(true);
    expect((ctxSignal?.reason as DOMException).message).toBe("caller aborted");
  });
});

describe("EventTarget surface", () => {
  it("is an EventTarget that accepts toolactivated and toolcancel listeners but never fires them", async () => {
    const mc = createFakeModelContext();
    expect(mc instanceof EventTarget).toBe(true);
    let fired = 0;
    mc.addEventListener("toolactivated", () => { fired += 1; });
    mc.addEventListener("toolcancel", () => { fired += 1; });
    await mc.registerTool(echoTool());
    await mc.executeTool(await entryOf(mc, "echo"), {});
    await Promise.resolve();
    expect(fired).toBe(0);
  });
});

describe("install", () => {
  it("defines modelContext as a configurable property on the target and restores the previous state", () => {
    const mc = createFakeModelContext();
    const target: { modelContext?: unknown; navigator?: unknown } = {};
    const restore = mc.install(target);
    expect(target.modelContext).toBe(mc);
    expect(Object.getOwnPropertyDescriptor(target, "modelContext")?.configurable).toBe(true);
    expect(target.navigator).toBeUndefined();
    restore();
    expect("modelContext" in target).toBe(false);
  });

  it("restores a previous value rather than deleting it", () => {
    const mc = createFakeModelContext();
    const previous = { registerTool: () => Promise.resolve() };
    const target: { modelContext?: unknown } = { modelContext: previous };
    const restore = mc.install(target);
    expect(target.modelContext).toBe(mc);
    restore();
    expect(target.modelContext).toBe(previous);
  });

  it("throws under node when there is no document and no target", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    expect(() => createFakeModelContext().install()).toThrow(TypeError);
  });
});
