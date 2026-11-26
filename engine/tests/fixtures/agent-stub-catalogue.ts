/**
 * Stub hosts and stub `AgentCatalogue`s for the registrar, session and binding tests. The registrar never imports a catalogue module, so these stand in for the
 * renderer and builder catalogues: a form catalogue with a read tool, a slow write tool the test
 * releases, a throwing tool, a refusing tool, tools returning a 200 KB unpageable blob and a
 * 70 KB pageable option list, a tool reading `ctx.signal`, a tool with `inputBytes: 512 KB`, and
 * `submit` / `undo_agent_changes` stand-ins; plus a builder catalogue with a describe and one
 * write. Every DOM-facing call (events, session hooks) is recorded on the host.
 *
 * It also carries the catalogue seams the registrar calls: `staleDetails` (only
 * when the host carries one, so the default stays testable), `link` (the link is kept on the
 * host) and `purposeChanged` (recorded apart from `hookCalls`, whose shape older tests pin).
 *
 * A folded tool, `folded`, has a `list` action that is a read (`readActions`), a `save` that
 * writes one value and a `hold` that waits for the same gate as `slow_write`; the form
 * catalogue's `provenance` is present only when the host carries one, so a catalogue without
 * the method stays testable.
 */

import type { AgentProvenance } from "../../form-engine/core/events/hooks.js";
import {
  ToolRefusal,
  type AgentCatalogue,
  type AgentTool,
  type CatalogueLink,
  type CatalogueReadiness,
  type SessionEndReason,
  type ToolContext,
  type ToolData
} from "../../form-engine/agent/tool-types.js";

export interface RecordedEvent {
  type: string;
  detail: unknown;
}

export interface StubHookCall {
  hook: "begin" | "end" | "undoAll";
  purpose?: string;
  reason?: SessionEndReason;
  summary?: string;
}

export interface StubHost {
  /** The element's id attribute at registration (`""` when none); the registrar's input for the handle. */
  id: string;
  /** Deterministic session recording: every datum-agent-* event the catalogue was asked to emit. */
  events: RecordedEvent[];
  hookCalls: StubHookCall[];
  /** The values the stub's write tools maintain. */
  values: Record<string, unknown>;
  /** What `readiness()` answers; tests flip it to simulate a rebuild or a removed element. */
  readiness: CatalogueReadiness;
  summary: Record<string, unknown>;
  /** What `undoAll()` returns; when `undoAllError` is set it throws instead. */
  undoAllResult: number;
  undoAllError: Error | undefined;
  /** When set, `undoAll()` returns this promise instead (an async replay the test settles, as the renderer's `painted()` wait). */
  undoAllPending: Promise<number> | undefined;
  /** When set, `begin` refuses with it. */
  beginRefusal: ToolRefusal | undefined;
  /** What `begin` reports as `locked` / `pausedTyping`. */
  locked: boolean;
  pausedTyping: boolean | undefined;
  /** The focused caret path the renderer host would report; the registrar never reads it. */
  focusedPath: string | undefined;
  /** The Stop callback the last `begin` received, so a test can press Stop. */
  stop: (() => void) | undefined;
  /** The Allow again listener the registrar installed, so a test can press it. */
  allowAgain: (() => void) | undefined;
  /** Reports a change the catalogue observed (the stand-in for a runtime event). */
  change: (paths: string[], by: "agent" | "other") => void;
  /** Lets a test release the slow write. */
  release: () => void;
  /** How many times `reset()` was called. */
  resets: number;
  /** How many times `watch()` was called. */
  watches: number;
  /** `ctx.state` as the last tool saw it. */
  lastState: Map<string, unknown> | undefined;
  /** The `ctx.session` the last tool saw. */
  lastSession: unknown;
  /** When set before registering, the catalogue exposes `staleDetails` answering through it (it may throw). */
  staleDetails: ((revision: number, expected: number) => Record<string, unknown>) | undefined;
  /** The link the registrar handed `catalogue.link`, and how many times it was called. */
  link: CatalogueLink | undefined;
  linkCalls: number;
  /** Every purpose `purposeChanged` received; with `purposeChangedError` set it throws after recording. */
  purposeChanges: string[];
  purposeChangedError: Error | undefined;
  /** The order of `purposeChanged` against the datum-agent-session events: the events count when it ran. */
  purposeChangedAtEvent: number[];
  /**
   * When set, the builder stub's `set_properties` answers `undo: { steps }`, as a builder write does
   *, and the form stub's `set_value` echoes the same field, so a test can show the registrar
   * stamps `undoSteps` on a builder target only: each side omits the other's keys.
   */
  undoSteps: number | undefined;
  /** When set before registering, the form catalogue exposes `provenance` answering through it (it may throw). */
  provenance: ((by: "agent" | "page") => AgentProvenance | undefined) | undefined;
  /** Every `by` the form catalogue's `provenance` was asked for. */
  provenanceCalls: Array<"agent" | "page">;
}

export function stubHost(id = "", overrides: Partial<StubHost> = {}): StubHost {
  const host: StubHost = {
    id,
    events: [],
    hookCalls: [],
    values: {},
    readiness: { state: "ready" },
    summary: { formId: "stub-form", title: "Stub form", fields: 3, pages: 1, locale: "en" },
    undoAllResult: 0,
    undoAllError: undefined,
    undoAllPending: undefined,
    beginRefusal: undefined,
    locked: false,
    pausedTyping: undefined,
    focusedPath: undefined,
    stop: undefined,
    allowAgain: undefined,
    change: () => undefined,
    release: () => undefined,
    resets: 0,
    watches: 0,
    lastState: undefined,
    lastSession: undefined,
    staleDetails: undefined,
    link: undefined,
    linkCalls: 0,
    purposeChanges: [],
    purposeChangedError: undefined,
    purposeChangedAtEvent: [],
    undoSteps: undefined,
    provenance: undefined,
    provenanceCalls: [],
    ...overrides
  };
  return host;
}

const HANDLE_PROPERTY = {
  form: {
    type: "string",
    description: "Which form, when the page has more than one: a handle from describe_form. Leave it out when there is one form."
  }
};

const EXPECTED_REVISION = {
  expectedRevision: {
    type: "integer",
    minimum: 1,
    description: "The revision from your last result; the call is refused as stale when the form changed since."
  }
};

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { type: "object", properties: { ...HANDLE_PROPERTY, ...properties } };
  if (required.length > 0) {
    out.required = required;
  }
  return out;
}

/** A 70 KB option list under a field row: step (b) of the cap collapses it to a count. */
export function bigOptions(): ToolData {
  const options = Array.from({ length: 2_000 }, (_, index) => ({ value: `v${index}`, label: `Option ${index}` }));
  return { fields: [{ path: "province", kind: "choice", options }] };
}

/** A 200 KB value no cap step can shrink: step (c) answers too-large. */
export function bigBlob(): ToolData {
  return { blob: Array.from({ length: 30_000 }, (_, index) => 100_000 + index) };
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(resolve);
  });
}

function purposeChangedFor(host: StubHost): (purpose: string) => void {
  return (purpose) => {
    host.purposeChanges.push(purpose);
    host.purposeChangedAtEvent.push(host.events.filter((event) => event.type === "datum-agent-session").length);
    if (host.purposeChangedError !== undefined) {
      throw host.purposeChangedError;
    }
  };
}

/** The form seam: `provenance` when the host carries one. */
function phaseThreeSeams(host: StubHost): Pick<AgentCatalogue<StubHost>, "provenance"> {
  const own = host.provenance;
  if (own === undefined) {
    return {};
  }
  return {
    provenance(by) {
      host.provenanceCalls.push(by);
      return own(by);
    }
  };
}

/** The catalogue seams (`link`, and `staleDetails` when the host carries one), shared by both stubs. */
function phaseTwoSeams(host: StubHost): Pick<AgentCatalogue<StubHost>, "link" | "staleDetails"> {
  const seams: Pick<AgentCatalogue<StubHost>, "link" | "staleDetails"> = {
    link(link) {
      host.linkCalls += 1;
      host.link = link;
    }
  };
  const own = host.staleDetails;
  if (own !== undefined) {
    seams.staleDetails = (revision, expected) => own(revision, expected);
  }
  return seams;
}

export function stubFormCatalogue(host: StubHost): AgentCatalogue<StubHost> {
  let writing = false;
  let report: ((change: { paths: string[]; by: "agent" | "other" }) => void) | undefined;
  let gate: Promise<void> = Promise.resolve();
  let open: (() => void) | undefined;
  const armGate = (): void => {
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
  };
  armGate();
  host.release = () => {
    open?.();
    armGate();
  };
  host.change = (paths, by) => report?.({ paths, by });

  const observe = (ctx: ToolContext<StubHost>): void => {
    host.lastState = ctx.state;
    host.lastSession = ctx.session;
  };
  const write = (path: string, value: unknown): void => {
    writing = true;
    try {
      host.values[path] = value;
      report?.({ paths: [path], by: writing ? "agent" : "other" });
    } finally {
      writing = false;
    }
  };

  const tools: AgentTool<Record<string, unknown>, StubHost>[] = [
    {
      name: "describe_form",
      title: "Describe the form",
      description: "Start here.",
      inputSchema: schema({
        scope: { type: "string", enum: ["page", "visible", "all"], description: "Which fields to list." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Paging." }
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, ctx) => {
        observe(ctx);
        return { ...host.summary, scope: input.scope ?? "visible", values: { ...host.values } };
      }
    },
    {
      name: "get_value",
      title: "Read one value",
      description: "Returns one value.",
      inputSchema: schema({ path: { type: "string", maxLength: 256, description: "The path." } }, ["path"]),
      annotations: { readOnlyHint: true },
      execute: (input, ctx) => {
        observe(ctx);
        const path = input.path as string;
        return { path, value: host.values[path] ?? null, calls: (ctx.state.get("reads") as number | undefined) ?? 0 };
      }
    },
    {
      name: "set_value",
      title: "Write one value",
      description: "Writes one value.",
      inputSchema: schema(
        {
          path: { type: "string", maxLength: 256, description: "The path." },
          value: { type: "string", maxLength: 10_000, description: "The value." },
          attachment: { type: "object", description: "An open object the schema check leaves to the catalogue." },
          ...EXPECTED_REVISION
        },
        ["path", "value"]
      ),
      annotations: {},
      execute: (input, ctx) => {
        observe(ctx);
        const path = input.path as string;
        write(path, input.value);
        ctx.state.set("writes", ((ctx.state.get("writes") as number | undefined) ?? 0) + 1);
        return host.undoSteps !== undefined
          ? { written: [path], warnings: ["stub note"], undo: { steps: host.undoSteps } }
          : { written: [path], warnings: ["stub note"] };
      }
    },
    {
      name: "slow_write",
      title: "Slow write",
      description: "Waits until the test releases it.",
      inputSchema: schema({ ...EXPECTED_REVISION }),
      annotations: {},
      execute: async (_input, ctx) => {
        observe(ctx);
        await gate;
        write("slow", "done");
        return { done: true };
      }
    },
    {
      name: "throwing",
      title: "Throws",
      description: "Throws a plain error.",
      inputSchema: schema({}),
      annotations: { readOnlyHint: true },
      execute: () => {
        throw new Error("boom");
      }
    },
    {
      name: "refusing",
      title: "Refuses",
      description: "Throws a ToolRefusal.",
      inputSchema: schema({ code: { type: "string", description: "The code to refuse with." } }),
      annotations: { readOnlyHint: true },
      execute: (input) => {
        throw new ToolRefusal((input.code as string | undefined) ?? "unknown-field", "No field has that path.", "Use a path from describe_form.", {
          ref: "x"
        });
      }
    },
    {
      name: "big_blob",
      title: "Big blob",
      description: "Returns 200 KB nothing can page.",
      inputSchema: schema({}),
      annotations: { readOnlyHint: true },
      execute: () => bigBlob()
    },
    {
      name: "big_options",
      title: "Big options",
      description: "Returns a 70 KB inline option list.",
      inputSchema: schema({}),
      annotations: { readOnlyHint: true },
      execute: () => bigOptions()
    },
    {
      name: "signal_probe",
      title: "Signal probe",
      description: "Reports the signal after a tick.",
      inputSchema: schema({}),
      annotations: { readOnlyHint: true },
      execute: async (_input, ctx) => {
        await tick();
        if (ctx.signal.aborted) {
          throw new ToolRefusal("cancelled", "The call was cancelled.", "Call describe_form before retrying.", { stillRunning: true });
        }
        return { aborted: false };
      }
    },
    {
      name: "abort_thrower",
      title: "Abort thrower",
      description: "Throws a plain AbortError (no ToolRefusal) once the signal has fired.",
      inputSchema: schema({}),
      annotations: { readOnlyHint: true },
      execute: async (_input, ctx) => {
        await tick();
        if (ctx.signal.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        return { aborted: false };
      }
    },
    {
      name: "abort_survivor",
      title: "Abort survivor",
      description: "Finishes normally after a tick whether or not the signal fired.",
      inputSchema: schema({}),
      annotations: { readOnlyHint: true },
      execute: async (_input, ctx) => {
        await tick();
        return { aborted: ctx.signal.aborted };
      }
    },
    {
      name: "pathless_write",
      title: "Path-less write",
      description: "Changes the target without a value path, as navigate / set_locale / submit report.",
      inputSchema: schema({}),
      annotations: {},
      execute: () => {
        report?.({ paths: [], by: "agent" });
        return { navigated: true };
      }
    },
    {
      name: "wide_input",
      title: "Wide input",
      description: "Accepts up to 512 KB of input.",
      inputSchema: schema({ payload: { type: "string", description: "A long string." } }),
      annotations: {},
      inputBytes: 512 * 1024,
      execute: (input) => ({ bytes: new TextEncoder().encode(JSON.stringify(input)).length })
    },
    {
      name: "submit",
      title: "Submit",
      description: "Submits the form.",
      inputSchema: schema({}),
      annotations: { consequentialHint: true },
      execute: async () => {
        // The catalogue's own start event, immediately before the host's submit:
        // through the link when linked, as the renderer catalogue does.
        if (host.link !== undefined) {
          host.link.emitAction({ tool: "submit", input: {}, outcome: { ok: true, code: "started" } });
        } else {
          catalogue.emit("datum-agent-action", { tool: "submit", outcome: { ok: true, code: "started" }, trigger: "agent" });
        }
        await tick();
        return { submitted: true };
      }
    },
    {
      name: "undo_agent_changes",
      title: "Undo",
      description: "Undoes the agent's changes.",
      inputSchema: schema({}),
      annotations: {},
      allowedWhileStopped: true,
      execute: () => ({ undone: 0 })
    },
    {
      name: "folded",
      title: "Folded",
      description: "A folded tool: 'list' reads, 'save' writes one value, 'hold' writes once the test releases it.",
      inputSchema: schema(
        {
          action: { type: "string", enum: ["list", "save", "hold"], description: "list: read. save: write. hold: a slow write." },
          value: { type: "string", maxLength: 256, description: "save: the value to write." },
          ...EXPECTED_REVISION
        },
        ["action"]
      ),
      annotations: {},
      readActions: { key: "action", values: ["list"] },
      execute: async (input, ctx) => {
        observe(ctx);
        if (input.action === "list") {
          return { action: "list", changed: false, values: { ...host.values } };
        }
        if (input.action === "hold") {
          await gate;
        }
        write("folded", input.value ?? input.action);
        return { action: input.action, changed: true };
      }
    }
  ];

  const catalogue: AgentCatalogue<StubHost> = {
    host,
    tools,
    sessionHooks: {
      begin(purpose, onStop) {
        host.hookCalls.push({ hook: "begin", purpose });
        host.stop = onStop;
        if (host.beginRefusal !== undefined) {
          return { refused: host.beginRefusal };
        }
        const result: { undoBoundary: number; locked: boolean; pausedTyping?: boolean } = {
          undoBoundary: Object.keys(host.values).length,
          locked: host.locked
        };
        if (host.pausedTyping !== undefined) {
          result.pausedTyping = host.pausedTyping;
        }
        return result;
      },
      end(reason, summary) {
        const call: StubHookCall = { hook: "end", reason };
        if (summary !== undefined) {
          call.summary = summary;
        }
        host.hookCalls.push(call);
        return { changes: { fieldsWritten: Object.keys(host.values).length, rowsAdded: 0, rowsRemoved: 0, pagesMoved: 0 }, undoable: 2 };
      },
      undoAll() {
        host.hookCalls.push({ hook: "undoAll" });
        if (host.undoAllError !== undefined) {
          throw host.undoAllError;
        }
        return host.undoAllPending ?? host.undoAllResult;
      },
      onAllowAgain(listener) {
        host.allowAgain = listener;
      },
      purposeChanged: purposeChangedFor(host)
    },
    summary: () => ({ ...host.summary }),
    readiness: () => host.readiness,
    watch(listener) {
      host.watches += 1;
      report = listener;
      return () => {
        if (report === listener) {
          report = undefined;
        }
      };
    },
    reset() {
      host.resets += 1;
    },
    emit(type, detail) {
      host.events.push({ type, detail });
    },
    ...phaseTwoSeams(host),
    ...phaseThreeSeams(host)
  };
  return catalogue;
}

export function stubBuilderCatalogue(host: StubHost): AgentCatalogue<StubHost> {
  let report: ((change: { paths: string[]; by: "agent" | "other" }) => void) | undefined;
  host.change = (paths, by) => report?.({ paths, by });
  const builderHandle = {
    builder: {
      type: "string",
      description: "Which builder, when the page has more than one: a handle from describe_builder. Leave it out when there is one builder."
    }
  };
  const tools: AgentTool<Record<string, unknown>, StubHost>[] = [
    {
      name: "describe_builder",
      title: "Describe the builder",
      description: "Start here.",
      inputSchema: { type: "object", properties: { ...builderHandle } },
      annotations: { readOnlyHint: true },
      execute: () => ({ ...host.summary })
    },
    {
      name: "set_properties",
      title: "Set properties",
      description: "Writes properties.",
      inputSchema: {
        type: "object",
        properties: { ...builderHandle, id: { type: "string", description: "The component id." }, ...EXPECTED_REVISION },
        required: ["id"]
      },
      annotations: {},
      execute: (input) => {
        report?.({ paths: [input.id as string], by: "agent" });
        return host.undoSteps !== undefined ? { changed: [input.id], undo: { steps: host.undoSteps } } : { changed: [input.id] };
      }
    }
  ];
  return {
    host,
    tools,
    sessionHooks: {
      begin(purpose, onStop) {
        host.hookCalls.push({ hook: "begin", purpose });
        host.stop = onStop;
        return { undoBoundary: 0, locked: false };
      },
      end(reason, summary) {
        const call: StubHookCall = { hook: "end", reason };
        if (summary !== undefined) {
          call.summary = summary;
        }
        host.hookCalls.push(call);
        return { changes: {}, undoable: 0 };
      },
      undoAll() {
        host.hookCalls.push({ hook: "undoAll" });
        return 0;
      },
      onAllowAgain(listener) {
        host.allowAgain = listener;
      },
      purposeChanged: purposeChangedFor(host)
    },
    summary: () => ({ ...host.summary }),
    readiness: () => host.readiness,
    watch(listener) {
      host.watches += 1;
      report = listener;
      return () => {
        report = undefined;
      };
    },
    reset() {
      host.resets += 1;
    },
    emit(type, detail) {
      host.events.push({ type, detail });
    },
    ...phaseTwoSeams(host)
  };
}

export function builderHost(id = ""): StubHost {
  return stubHost(id, { summary: { title: "Stub builder", dirty: false, workspace: "form" } });
}
