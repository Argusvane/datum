/**
 * A test double for the browser's `ModelContext` (WebMCP). It reproduces
 * the Chrome 155 semantics so the registrar, the binding and host pages can
 * be tested without a browser: registration with signals, the fresh `getTools()` dictionaries,
 * `executeTool`'s structured-clone input and stringified result, the opaque `UnknownError` a
 * throwing tool produces, synchronous removal on abort, and the `NotAllowedError` a
 * `Permissions-Policy: tools=()` page gives every method.
 *
 * `install()` is the only code in this file that defines the `modelContext` property, and only
 * on the object it is given (by default `document`); the engine's binding is the only other
 * module that touches the property. Nothing here runs at import time, so the module evaluates
 * under plain node (`EventTarget`, `DOMException` and `structuredClone` are globals there).
 */

import type { AgentToolAnnotations, ModelContextLike, RegisteredToolEntry } from "../agent/tool-types.js";

export interface FakeModelContextOptions {
  /** Simulate `Permissions-Policy: tools=()`: every method rejects NotAllowedError. Default true (allowed). */
  allowed?: boolean;
  /** The origin every `getTools()` entry reports. Default "https://fake.test". */
  origin?: string;
}

export interface FakeModelContextCall {
  name: string;
  input: unknown;
  /** The string `executeTool` resolved to. */
  result?: string;
  /** The real error when the tool threw, rejected or returned a circular value (the caller only saw UnknownError). */
  error?: unknown;
}

/** An object that may carry a `modelContext` property: `document` in a browser or jsdom, any plain object under node. */
export interface ModelContextCarrier {
  modelContext?: unknown;
}

export interface FakeModelContext extends ModelContextLike {
  /** Registered names in getTools() order (sorted by name). */
  names(): string[];
  /** Every executeTool call, in order. */
  calls: FakeModelContextCall[];
  /** toolchange events fired so far (plain Event, no toolName). */
  toolchanges: number;
  /**
   * Define this double as `modelContext` (a configurable property) on `target`, by default the
   * global `document` when one exists, and return the function that restores the previous state.
   * jsdom tests call it before mounting an element with the `agent` token. Any object is a
   * target (a jsdom `Document` has no `modelContext` in its type).
   */
  install(target?: object): () => void;
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const NOT_ALLOWED_MESSAGE = 'Access to the feature "tools" is disallowed by permissions policy.';
const INVOCATION_FAILED_MESSAGE =
  "Tool was executed but the invocation failed. For example, the script function threw an error";

interface StoredTool {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  hasSchema: boolean;
  annotations: Required<AgentToolAnnotations>;
  execute: (input: unknown, ctx: { signal: AbortSignal }) => unknown;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function requiredMember(dictionary: string, member: string): TypeError {
  return new TypeError(`Failed to read the '${member}' property from '${dictionary}': Required member is undefined.`);
}

/** Only the three hints survive on 155 and each is coerced to a boolean; `"true"` and `"false"` both read true, as WebIDL does. */
function readAnnotations(value: unknown): Required<AgentToolAnnotations> {
  const source = isObjectLike(value) ? value : {};
  return {
    readOnlyHint: Boolean(source.readOnlyHint),
    consequentialHint: Boolean(source.consequentialHint),
    untrustedContentHint: Boolean(source.untrustedContentHint)
  };
}

/** A deep copy that drops function members, as Chrome stores a schema (a function inside reads back as gone). */
function copySchema(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** What `executeTool` resolves to: a bare string unchanged, `undefined` as the word, a BigInt as its digits, anything else through JSON. */
function stringifyResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  const text = JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
  return text === undefined ? "undefined" : text;
}

function abortReasonOf(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("signal is aborted without reason", "AbortError");
}

class FakeModelContextImpl extends EventTarget implements FakeModelContext {
  readonly calls: FakeModelContextCall[] = [];
  toolchanges = 0;
  private readonly tools = new Map<string, StoredTool>();
  private readonly allowed: boolean;
  private readonly origin: string;

  constructor(options: FakeModelContextOptions = {}) {
    super();
    this.allowed = options.allowed !== false;
    this.origin = options.origin ?? "https://fake.test";
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  async registerTool(tool: object, options?: { signal?: AbortSignal; exposedTo?: string[] }): Promise<void> {
    this.checkAllowed();
    if (!isObjectLike(tool)) {
      throw new TypeError("Failed to execute 'registerTool' on 'ModelContext': parameter 1 is not of type 'ModelContextTool'.");
    }
    const source = tool as Record<string, unknown>;
    if (source.name === undefined) {
      throw requiredMember("ModelContextTool", "name");
    }
    if (source.description === undefined) {
      throw requiredMember("ModelContextTool", "description");
    }
    if (source.execute === undefined) {
      throw requiredMember("ModelContextTool", "execute");
    }
    if (typeof source.execute !== "function") {
      throw new TypeError(
        "Failed to read the 'execute' property from 'ModelContextTool': The given value is not a function."
      );
    }
    if (source.inputSchema !== undefined && !isObjectLike(source.inputSchema)) {
      throw new TypeError("Failed to read the 'inputSchema' property from 'ModelContextTool': Failed to convert value to 'object'.");
    }
    const name = String(source.name);
    if (!NAME_PATTERN.test(name)) {
      throw new DOMException("Invalid tool name", "InvalidStateError");
    }
    const description = String(source.description);
    if (description === "") {
      throw new DOMException("Description is required", "InvalidStateError");
    }
    if (this.tools.has(name)) {
      throw new DOMException("Duplicate tool name", "InvalidStateError");
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      throw new DOMException("signal is aborted without reason", "AbortError");
    }
    const hasSchema = source.inputSchema !== undefined;
    const stored: StoredTool = {
      name,
      title: source.title === undefined ? "" : String(source.title),
      description,
      inputSchema: hasSchema ? copySchema(source.inputSchema) : undefined,
      hasSchema,
      annotations: readAnnotations(source.annotations),
      execute: source.execute as StoredTool["execute"]
    };
    this.tools.set(name, stored);
    if (signal !== undefined) {
      // Abort removes the tool synchronously; only the event is asynchronous.
      signal.addEventListener(
        "abort",
        () => {
          if (this.tools.get(name) === stored) {
            this.tools.delete(name);
            this.scheduleToolchange();
          }
        },
        { once: true }
      );
    }
    this.scheduleToolchange();
  }

  async getTools(_options?: { fromOrigins?: string[] }): Promise<RegisteredToolEntry[]> {
    this.checkAllowed();
    return this.names().map((name) => this.entryOf(this.tools.get(name) as StoredTool));
  }

  async executeTool(entry: RegisteredToolEntry, input?: unknown, options?: { signal?: AbortSignal }): Promise<string | null> {
    this.checkAllowed();
    if (!isObjectLike(entry) || typeof entry.name !== "string") {
      throw new TypeError("Failed to execute 'executeTool' on 'ModelContext': The provided value is not of type 'RegisteredTool'.");
    }
    for (const member of ["description", "origin"] as const) {
      if (entry[member] === undefined) {
        throw requiredMember("RegisteredTool", member);
      }
    }
    const given = input === undefined ? {} : input;
    if (typeof given !== "object" || given === null || Array.isArray(given)) {
      throw new TypeError("Failed to execute 'executeTool' on 'ModelContext': invalid input object: value is not an object");
    }
    const tool = this.tools.get(entry.name);
    if (tool === undefined) {
      throw new DOMException("Tool not found", "NotFoundError");
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      throw abortReasonOf(signal);
    }
    const call: FakeModelContextCall = { name: tool.name, input: given };
    this.calls.push(call);
    const ctxSignal = signal ?? new AbortController().signal;
    const run = (async (): Promise<string> => stringifyResult(await tool.execute(structuredClone(given), { signal: ctxSignal })))();
    const outcome = await new Promise<{ result: string } | { error: unknown; aborted?: true }>((resolve) => {
      let settled = false;
      // Named so the listener leaves the caller's signal as soon as the call settles: a harness
      // that reuses one AbortController across many calls must not accumulate one closure per call.
      const onAbort = (): void => settle({ error: abortReasonOf(signal as AbortSignal), aborted: true });
      const settle = (value: { result: string } | { error: unknown; aborted?: true }): void => {
        if (!settled) {
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        }
      };
      run.then(
        (result) => settle({ result }),
        (error: unknown) => settle({ error })
      );
      signal?.addEventListener("abort", onAbort);
    });
    if ("result" in outcome) {
      call.result = outcome.result;
      return outcome.result;
    }
    call.error = outcome.error;
    if (outcome.aborted) {
      throw outcome.error;
    }
    throw new DOMException(INVOCATION_FAILED_MESSAGE, "UnknownError");
  }

  install(target?: object): () => void {
    const carrier = (target ?? (globalThis as { document?: object }).document) as ModelContextCarrier | undefined | null;
    if (carrier === undefined || carrier === null) {
      throw new TypeError("createFakeModelContext().install() needs a target object: there is no document here.");
    }
    const previous = Object.getOwnPropertyDescriptor(carrier, "modelContext");
    Object.defineProperty(carrier, "modelContext", { value: this, configurable: true, enumerable: true, writable: true });
    return () => {
      if (previous === undefined) {
        delete carrier.modelContext;
      } else {
        Object.defineProperty(carrier, "modelContext", previous);
      }
    };
  }

  private checkAllowed(): void {
    if (!this.allowed) {
      throw new DOMException(NOT_ALLOWED_MESSAGE, "NotAllowedError");
    }
  }

  /** A fresh plain dictionary per call: `execute` never exposed, the schema a new deep copy. */
  private entryOf(tool: StoredTool): RegisteredToolEntry {
    const entry: RegisteredToolEntry = {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      annotations: { ...tool.annotations },
      origin: this.origin,
      window: undefined
    };
    if (tool.hasSchema) {
      entry.inputSchema = copySchema(tool.inputSchema);
    }
    return entry;
  }

  private scheduleToolchange(): void {
    queueMicrotask(() => {
      this.toolchanges += 1;
      this.dispatchEvent(new Event("toolchange"));
    });
  }
}

/** Creates the double; see the module comment for what it reproduces. */
export function createFakeModelContext(options?: FakeModelContextOptions): FakeModelContext {
  return new FakeModelContextImpl(options);
}
