/**
 * The ModelContext binding: the one file in the repository that names
 * `document.modelContext` (and its older `navigator.modelContext` spelling), so spec churn
 * costs this file alone. It is a thin adapter: the registrar owns the AbortControllers and the
 * execute pipeline; the binding detects the API and registers the registrar's routing wrappers
 * with it, turning every rejection Chrome 155 produces into a `BindingState`
 * instead of a throw.
 *
 * Nothing here runs at import time; `detectModelContext()` reads the globals only when called.
 */

import type { AgentTool, AgentToolResult, ModelContextLike } from "./tool-types.js";

export type { ModelContextLike, RegisteredToolEntry } from "./tool-types.js";

/** Why the page's tools are not (all) registered with the browser. */
export type BindingFailure = "no-api" | "not-allowed" | "duplicate" | "error";

/** What `registrar.binding()` reports and `datum-agent-tools` carries. */
export interface BindingState {
  /** True when at least one tool is registered with the browser. */
  registered: boolean;
  /** Set when something was not registered: the API is missing, the Permissions-Policy denies it, a name was taken, or the browser threw. */
  reason?: BindingFailure;
  /** The names the browser accepted, in registration order. */
  names: string[];
}

/** An object that may carry a `modelContext`: `document`, `navigator`, or a test's plain object. */
interface ModelContextCarrier {
  modelContext?: unknown;
}

function readModelContext(carrier: unknown): ModelContextLike | undefined {
  if (typeof carrier !== "object" || carrier === null) {
    return undefined;
  }
  const candidate = (carrier as ModelContextCarrier).modelContext;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { registerTool?: unknown }).registerTool === "function"
  ) {
    return candidate as ModelContextLike;
  }
  return undefined;
}

/**
 * Finds the browser's ModelContext: `document.modelContext` first (Chrome 155), then
 * `navigator.modelContext` (older previews; absent on 155). A candidate counts only when it has
 * a `registerTool` function. `doc` defaults to the global `document` when one exists; under
 * plain node both are absent and the answer is `undefined`, never a throw.
 */
export function detectModelContext(doc?: object): ModelContextLike | undefined {
  const globals = globalThis as { document?: unknown; navigator?: unknown };
  const fromDocument = readModelContext(doc ?? globals.document);
  if (fromDocument !== undefined) {
    return fromDocument;
  }
  return readModelContext(globals.navigator);
}

/** The pipeline the binding hands every browser call to: the registrar's `run`. */
export type BoundRun = (name: string, input: unknown, signal: AbortSignal) => Promise<AgentToolResult>;

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "";
}

/**
 * Registers the given tools with the browser under one signal (never without one: such tools
 * would live until unload), each as `{ name, title, description, inputSchema, annotations,
 * execute }` whose `execute(input, { signal })` runs the registrar's pipeline and returns the
 * envelope object for the browser to stringify. Rejections become state, never throws: a
 * `NotAllowedError` (Permissions-Policy `tools=()`) stops with `not-allowed`; an
 * `InvalidStateError` (a duplicate or invalid name) skips that tool with `duplicate` and the
 * rest continue; anything else (a `SecurityError` under `document.domain`, an unexpected throw)
 * is `error` for that tool. A signal already aborted registers nothing.
 */
export async function bindTools(
  modelContext: ModelContextLike,
  tools: readonly AgentTool[],
  run: BoundRun,
  options: { signal: AbortSignal }
): Promise<BindingState> {
  const names: string[] = [];
  let reason: BindingFailure | undefined;
  const { signal } = options;
  for (const tool of tools) {
    if (signal.aborted) {
      break;
    }
    const neverAborted = new AbortController().signal;
    const registered = {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      execute: (input: unknown, ctx?: { signal?: AbortSignal }) => run(tool.name, input, ctx?.signal ?? neverAborted)
    };
    try {
      await modelContext.registerTool(registered, { signal });
      names.push(tool.name);
    } catch (error) {
      const name = errorName(error);
      if (name === "NotAllowedError") {
        return { registered: false, reason: "not-allowed", names: [] };
      }
      if (name === "AbortError") {
        break;
      }
      if (name === "InvalidStateError") {
        reason = reason ?? "duplicate";
        console.error(`[datum-agent] registerTool(${tool.name}) refused by the browser`, error);
        continue;
      }
      reason = "error";
      console.error(`[datum-agent] registerTool(${tool.name}) failed`, error);
    }
  }
  const state: BindingState = { registered: names.length > 0, names };
  if (reason !== undefined) {
    state.reason = reason;
  }
  return state;
}
