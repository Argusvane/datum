/**
 * The page registrar: one per document, shared by the form bundle and the
 * builder bundle on the same page. It owns everything the two catalogues share: target handles,
 * the per-page tool names and their routing wrappers, the execute pipeline (shape → target →
 * schema subset → caps → order guards → body → envelope → cap → stamps → event), per-target
 * serialisation of writes, the revision counter with its change ring, the session state machine
 * (begin / end / Stop latch / Allow again / idle expiry), and the browser binding's
 * AbortControllers. It never imports a catalogue module: each bundle passes its own factory from
 * inside its chunk, so this file stays DOM-free and catalogue-free and is testable
 * over stub catalogues.
 *
 * Nothing runs at import time. `agentRegistrarFor(document)` is the only writer of the
 * `globalThis[Symbol.for("datum.agent.registrars")]` slot, and `createAgentRegistrar()` touches
 * no global at all.
 */

import type { AgentProvenance } from "../core/events/hooks.js";
import { bindTools, detectModelContext, type BindingState } from "./model-context-binding.js";
import { RESULT_BYTE_LIMIT, capRefusal, capResult, capWarnings, cleanText, cutString, jsonByteLength } from "./result-caps.js";
import { checkInput } from "./schema-check.js";
import {
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_PURPOSE_MAX,
  SESSION_SUMMARY_MAX,
  SESSION_TOOL_ANNOTATIONS,
  SESSION_TOOL_NAMES,
  SESSION_TOOL_TEXTS,
  sessionToolSchemas,
  type SessionToolName
} from "./session-tools.js";
import {
  NOT_READY_CODES,
  RETRYABLE_CODES,
  ToolRefusal,
  type AgentAccessState,
  type AgentActionPartial,
  type AgentCatalogue,
  type AgentCatalogueFactory,
  type AgentOk,
  type AgentRefusal,
  type AgentTool,
  type AgentToolResult,
  type CatalogueLink,
  type CatalogueReadiness,
  type ModelContextLike,
  type SessionEndReason,
  type SessionEndedReason,
  type SessionState,
  type ToolContext,
  type ToolData
} from "./tool-types.js";

export type { BindingState, BindingFailure } from "./model-context-binding.js";

/** The two kinds of target a page can hold. */
export type TargetKind = "form" | "builder";

/** What a bundle hands `registerForm` / `registerBuilder`. */
export interface RegistrationEntry<H> {
  /** The catalogue's host seam; the registrar never reads it except for an `id` string (see `id`). */
  host: H;
  /** Builds the catalogue over the host once, at registration. */
  catalogue: AgentCatalogueFactory<H>;
  /** The element's per-connection signal: aborting it unregisters. */
  signal: AbortSignal;
  /**
   * The element's `id` attribute at registration (`""` when none), the input the handle is
   * computed from. When left out, a string `host.id` is read instead; anything else
   * means no id.
   */
  id?: string;
}

/** Why a target leaves the page; both end an open session with that reason and undo nothing. */
export type UnregisterReason = "disconnected" | "features-changed";

/** What a registration hands back. */
export interface FormRegistration {
  /** Fixed for the registration's life. */
  handle: string;
  revision(): number;
  /** The element rebuilt its runtime: revision bumps, per-target state drops, an open session ends as `rebuilt`. */
  runtimeReplaced(): void;
  unregister(reason?: UnregisterReason): void;
  /**
   * The catalogue's `provenance(by)`, forwarded for the element to
   * offer at a submission or a download; `undefined` when the catalogue has none (a builder). A
   * catalogue that throws is logged and answered with what the registrar itself saw, the shape
   * the element uses after a detach: `involved` when the agent changed this target, `complete`
   * only when it did not, no paths, the sessions this registration opened.
   */
  provenance(by: "agent" | "page"): AgentProvenance | undefined;
  /**
   * The registration's access now, the catalogue's `access()`
   * (live when it has none, as a builder's; sealed `unset` when it throws, failing closed).
   */
  access(): AgentAccessState;
  /**
   * The element's policy or the definition may have changed: re-read access; when it differs from
   * the last one read, the revision bumps, an open session ends as `rebuilt` (undoing nothing), and
   * the binding listeners hear `tools-changed` so the element re-dispatches `datum-agent-tools`.
   * Never unregisters, never touches the journal or the browser's tool list.
   * A builder registration is always live, so on it this does nothing.
   */
  accessChanged(): void;
}

export type BuilderRegistration = FormRegistration;

/** The `datum-agent-action` detail. */
export interface AgentActionDetail {
  tool: string;
  target: TargetKind;
  /** `""` when the call was about no target (the targets listing, `*-required`, `*-unknown`). */
  handle: string;
  /** A `readOnlyHint` tool, or a read action of a folded tool (`readActions`). */
  readOnly: boolean;
  /** The validated input, strings cut to 1 KB, file-like values dropped. */
  input: unknown;
  outcome: { ok: boolean; code?: string };
  durationMs: number;
  revision: number;
  sessionId?: string;
  /** True when the call itself changed the target (the change ring recorded agent writes during it). */
  changed: boolean;
  trigger: "agent";
  /** Renderer targets: the value paths the agent wrote during the call. */
  paths?: string[];
  /** Builder targets: the component ids the agent changed during the call. */
  componentIds?: string[];
  /** Builder results: the history entries the call pushed, copied from the ok result's `undo.steps`. */
  undoSteps?: number;
  /**
   * The tool is annotated `consequentialHint`, so the browser may
   * have asked the person before running it; an audit log flags these acts. Stamped from the
   * annotations on every call of such a tool, whatever the outcome; absent otherwise.
   */
  consequential?: true;
}

/** The `datum-agent-session` detail. */
export interface AgentSessionDetail {
  phase: "begin" | "end" | "stop" | "idle" | "cancel" | "allow-again";
  sessionId: string;
  target: TargetKind;
  handle: string;
  purpose?: string;
  summary?: string;
  reason?: SessionEndReason;
  undone?: number;
  /**
   * A second `begin` for the same session id: `begin_session` while one is open updated the
   * purpose. The catalogue's `SessionHooks.purposeChanged` re-renders its banner
   * before this event; host listeners learn the new purpose from it.
   */
  resumed?: true;
}

/** What `subscribe()` listeners receive. */
export type RegistrarEvent =
  | { type: "tools-changed"; names: string[]; binding: BindingState }
  | { type: "action"; detail: AgentActionDetail }
  | { type: "session"; detail: AgentSessionDetail };

export interface AgentRegistrarOptions {
  /** The clock; `Date.now` by default (fake timers patch it). */
  now?: () => number;
  /** How long a session lives without a call; 45 000 ms by default. */
  idleTimeoutMs?: number;
  /** How long a write waits for the previous write on its target before `busy { previous-call }`; 10 000 ms by default. */
  queueTimeoutMs?: number;
  /** The output cap; 64 KB by default. */
  resultByteLimit?: number;
}

export interface AgentRegistrar {
  registerForm<H>(entry: RegistrationEntry<H>): FormRegistration;
  registerBuilder<H>(entry: RegistrationEntry<H>): BuilderRegistration;
  /** The registrar's routing wrappers for every tool on the page (catalogues + the session pair), never a catalogue's own objects. */
  tools(): readonly AgentTool[];
  /** The same pipeline the browser path runs; `signal` defaults to one that never fires. */
  execute(name: string, input: unknown, options?: { signal?: AbortSignal }): Promise<AgentToolResult>;
  /**
   * Registers the page's tools with the browser: `detectModelContext()` unless one is
   * given. Idempotent for the same ModelContext. Resolves when the current sets are registered;
   * sets that appear later are registered as they come and `binding()` follows.
   */
  bind(api?: ModelContextLike): Promise<BindingState>;
  /** The last binding state, with the names the browser holds. */
  binding(): BindingState;
  subscribe(listener: (event: RegistrarEvent) => void): () => void;
}

/** The default whole-input cap; `AgentTool.inputBytes` overrides it per tool. */
export const INPUT_BYTE_LIMIT = 256 * 1024;

/** How long a queued write waits for the previous write on its target. */
export const QUEUE_TIMEOUT_MS = 10_000;

/** The change ring's depth: what backs `stale.details.changedPaths` and `alsoChanged`. */
const RING_SIZE = 50;
const ALSO_CHANGED_CAP = 20;
const EVENT_STRING_CAP = 1_024;

/** The longest element id taken as a handle (the unknown-handle refusal quotes a handle cut to 128). */
const HANDLE_MAX = 128;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/u;

/**
 * Stamps `retryable` from the one per-code table: true only when waiting and calling
 * again can succeed, which is `busy`, `cancelled`, `timeout`, the shared `chunk-unavailable`
 * and the two `*-not-ready` codes while their state is `"loading"`.
 */
export function retryableFor(code: string, details?: Record<string, unknown>): boolean {
  if (RETRYABLE_CODES.has(code)) {
    return true;
  }
  return NOT_READY_CODES.has(code) && details?.state === "loading";
}

interface RingEntry {
  revision: number;
  path: string;
  by: "agent" | "other";
}

interface OpenSession {
  id: string;
  purpose: string;
  startedAt: number;
  lastCallAt: number;
  revisionAtBegin: number;
  undoBoundary: number;
  locked: boolean;
  pausedTyping: boolean | undefined;
  /** Calls on the target while the session was open, the begin and end calls excluded. */
  calls: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Target {
  kind: TargetKind;
  handle: string;
  catalogue: AgentCatalogue<unknown>;
  state: Map<string, unknown>;
  revision: number;
  ring: RingEntry[];
  /** The tail of the per-target write chain. */
  chain: Promise<void>;
  session: OpenSession | undefined;
  lastSessionId: string;
  /** The Stop latch; cleared by Allow again, a rebuild, or unregistering. */
  stopped: { stoppedAt: number; undone: number } | undefined;
  /** Stamped once on the next result about this target. */
  pendingEnded: { reason: SessionEndedReason; undone: number } | undefined;
  /** The revision at the end of the agent's previous call on this target (`alsoChanged`). */
  lastSeenRevision: number;
  connected: boolean;
  unwatch: () => void;
  /** Sticky: the change ring ever recorded an agent change here. Only `provenance`'s fallback reads it. */
  agentChanged: boolean;
  /** Sessions begun on this registration (a resumed begin is not counted). Only `provenance`'s fallback reads it. */
  sessionsOpened: number;
  /**
   * The access last read: `"live"`, `"sealed:author"` or
   * `"sealed:unset"`, set at registration and by `accessChanged`, so a flip is noticed once.
   */
  lastAccess: string;
}

/** One name the page exposes: where it routes and what the browser is told about it. */
interface ToolSpec {
  name: string;
  kind: TargetKind | "session";
  tool: AgentTool;
  readOnly: boolean;
  /** The input values that make a call of this tool a read (`AgentTool.readActions`). */
  readActions: { key: string; values: readonly string[] } | undefined;
  /** The tool's `consequentialHint`, stamped on its action events. */
  consequential: boolean;
  /** The tool's own `answersWhenOff`, so the access gate lets it reach its body on a sealed form (describe_form). */
  answersWhenOff: boolean;
  describe: boolean;
  allowedWhileStopped: boolean;
  inputBytes: number;
}

/** The three browser registration sets: form tools, builder tools, the session pair. */
interface ToolSet {
  wrappers: AgentTool[];
  controller: AbortController;
  names: string[];
  reason: BindingState["reason"];
}

type SetName = TargetKind | "session";

interface Refusal {
  code: string;
  message: string;
  hint: string;
  details?: Record<string, unknown>;
}

const NEVER_ABORTED = (): AbortSignal => new AbortController().signal;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusalOf(code: string, message: string, hint: string, details?: Record<string, unknown>): Refusal {
  const refusal: Refusal = { code, message, hint };
  if (details !== undefined) {
    refusal.details = details;
  }
  return refusal;
}

function fromToolRefusal(error: ToolRefusal): Refusal {
  return refusalOf(error.code, error.message, error.hint, error.details);
}

/** The checked input names one of the tool's read actions. */
function inReadActions(spec: ToolSpec, input: Record<string, unknown>): boolean {
  const actions = spec.readActions;
  if (actions === undefined) {
    return false;
  }
  const value = input[actions.key];
  return typeof value === "string" && actions.values.includes(value);
}

/**
 * The `agent-off` texts: one message per `by`, one hint for
 * both. Static English, as every refusal: the model relays them to the person.
 */
const AGENT_OFF_MESSAGES: Record<"author" | "unset", string> = {
  author: "This form does not accept assistants: its author turned them off.",
  unset:
    "This form does not accept assistants: this site lets them fill only forms whose author allowed it, and this form's author has not."
};
const AGENT_OFF_HINT = "Tell the person this form has to be filled in by them; do not fill it in any other way.";

/** The access as one comparable word: what `accessChanged` compares to the last one read. */
function accessKey(access: AgentAccessState): string {
  return access.state === "live" ? "live" : `sealed:${access.by}`;
}

function describeToolOf(kind: TargetKind): string {
  return kind === "form" ? "describe_form" : "describe_builder";
}

function readHandleOf(kind: TargetKind): string {
  return kind === "form" ? "get_answers" : "describe_builder";
}

/** The exact hints of the not-ready refusals, `{braces}` filled. */
function notReadyHint(kind: TargetKind, state: string, message: string | undefined): string {
  if (state === "loading") {
    return `Wait a moment and call ${describeToolOf(kind)} again.`;
  }
  if (state === "failed") {
    return `Tell the person the ${kind} could not load: ${message ?? "no details"}.`;
  }
  return `The ${kind} is gone; stop.`;
}

function staleHint(kind: TargetKind): string {
  return kind === "form"
    ? `Re-read the changed fields with ${readHandleOf(kind)}, then call again with the new revision.`
    : "Read the outline again and resend.";
}

/**
 * Strings cut to 1 KB and file-like values (objects carrying `data` or `bytes` over 1 KB) dropped. `ancestors` guards against a cyclic input: an in-page caller can hand one (JSON
 * cannot carry it, so the browser path never does), the pipeline answers `internal` for it, and
 * the action event about that call must still be built without recursing forever.
 */
function echoInput(value: unknown, ancestors: Set<object> = new Set()): unknown {
  if (typeof value === "string") {
    return cutString(value, EVENT_STRING_CAP);
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    if (ancestors.has(value)) {
      return { omitted: "cycle" };
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => echoInput(item, ancestors));
      }
      if (("data" in value || "bytes" in value) && safeByteLength(value) > EVENT_STRING_CAP) {
        return { omitted: "file" };
      }
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        // A key is a string too: a 200 000-character one would ride into the event whole.
        out[cutString(key, EVENT_STRING_CAP)] = echoInput(item, ancestors);
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  }
  return value;
}

/** The event echo never fails the event: an input whose properties cannot be read is left out. */
function safeEcho(value: unknown): unknown {
  try {
    return echoInput(value);
  } catch (error) {
    console.error("[datum-agent] input echo", error);
    return undefined;
  }
}

/** `jsonByteLength` for the event echo: a value JSON cannot serialise (a BigInt, a cycle) counts as over any cap. */
function safeByteLength(value: unknown): number {
  try {
    return jsonByteLength(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** What the catch-all needs to answer and report a call that threw out of the pipeline. */
interface CallTrace {
  startedAt: number;
  kind: TargetKind;
  target: Target | undefined;
  /** The input as the action event echoes it at this stage. */
  input: unknown;
  /** The tool's `readOnlyHint` until the schema check, then whether this call is a read. */
  readOnly: boolean;
  consequential: boolean;
  changedFrom: number;
  /** The session open when the target was resolved, so the event about the call that ended it still names it. */
  sessionAtStart: string | undefined;
  warnings: string[];
}

function waitFor(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, ms);
    void promise.then(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

class Registrar implements AgentRegistrar {
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly queueTimeoutMs: number;
  private readonly resultByteLimit: number;
  private readonly targets: Target[] = [];
  private readonly usedHandles = new Set<string>();
  private readonly ordinals: Record<TargetKind, number> = { form: 0, builder: 0 };
  private readonly specs = new Map<string, ToolSpec>();
  private readonly sets = new Map<SetName, ToolSet>();
  private readonly listeners = new Set<(event: RegistrarEvent) => void>();
  private api: ModelContextLike | undefined;
  private bound = false;
  private bindingState: BindingState = { registered: false, names: [] };
  /** The in-flight `bind()`: a second caller for the same API awaits it instead of reading the stale state. */
  private pending: Promise<BindingState> | undefined;
  private sessionCounter = 0;

  constructor(options: AgentRegistrarOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.idleTimeoutMs = options.idleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
    this.queueTimeoutMs = options.queueTimeoutMs ?? QUEUE_TIMEOUT_MS;
    this.resultByteLimit = options.resultByteLimit ?? RESULT_BYTE_LIMIT;
  }

  registerForm<H>(entry: RegistrationEntry<H>): FormRegistration {
    return this.register("form", entry);
  }

  registerBuilder<H>(entry: RegistrationEntry<H>): BuilderRegistration {
    return this.register("builder", entry);
  }

  tools(): readonly AgentTool[] {
    const out: AgentTool[] = [];
    for (const name of ["form", "builder", "session"] as const) {
      const set = this.sets.get(name);
      if (set !== undefined) {
        out.push(...set.wrappers);
      }
    }
    return out;
  }

  execute(name: string, input: unknown, options?: { signal?: AbortSignal }): Promise<AgentToolResult> {
    return this.run(name, input, options?.signal ?? NEVER_ABORTED());
  }

  bind(api?: ModelContextLike): Promise<BindingState> {
    const detected = api ?? detectModelContext();
    if (detected === undefined) {
      const first = !this.bound;
      if (first) {
        console.debug("[datum-agent] no ModelContext API on this page; tools stay reachable through execute()");
      }
      this.api = undefined;
      this.bound = true;
      this.pending = undefined;
      this.bindingState = { registered: false, reason: "no-api", names: [] };
      if (first) {
        this.emitToolsChanged();
      }
      return Promise.resolve(this.binding());
    }
    if (this.bound && this.api === detected) {
      // Two elements connecting in the same tick both bind: the second waits for the first's
      // registrations to land rather than reading the initial `{ registered: false }`.
      return this.pending ?? Promise.resolve(this.binding());
    }
    this.api = detected;
    this.bound = true;
    // The sets of this moment: one created while this chain waits lands through `createSet`'s own
    // chain, after it, so no set is registered twice. An outstanding landing finishes first.
    const sets = [...this.sets.values()];
    const pending: Promise<BindingState> = this.settled()
      .then(() => Promise.all(sets.map((set) => this.bindSet(set))))
      .then(
        () => {
          if (this.pending === pending) {
            this.pending = undefined;
          }
          this.emitToolsChanged();
          return this.binding();
        },
        (error: unknown) => {
          if (this.pending === pending) {
            this.pending = undefined;
          }
          throw error;
        }
      );
    this.pending = pending;
    return pending;
  }

  binding(): BindingState {
    return { ...this.bindingState, names: [...this.bindingState.names] };
  }

  subscribe(listener: (event: RegistrarEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- registration -------------------------------------------------------------------------

  private register<H>(kind: TargetKind, entry: RegistrationEntry<H>): FormRegistration {
    const catalogue = entry.catalogue(entry.host) as AgentCatalogue<unknown>;
    const hostId = (entry.host as { id?: unknown } | null | undefined)?.id;
    const id = entry.id ?? (typeof hostId === "string" ? hostId : "");
    const handle = this.allocateHandle(kind, id);
    const target: Target = {
      kind,
      handle,
      catalogue,
      state: new Map(),
      revision: 1,
      ring: [],
      chain: Promise.resolve(),
      session: undefined,
      lastSessionId: "",
      stopped: undefined,
      pendingEnded: undefined,
      lastSeenRevision: 1,
      connected: true,
      unwatch: () => undefined,
      agentChanged: false,
      sessionsOpened: 0,
      lastAccess: "live"
    };
    target.lastAccess = accessKey(this.accessOf(target));
    target.unwatch = catalogue.watch(({ paths, by }) => this.recordChange(target, paths, by));
    try {
      catalogue.sessionHooks.onAllowAgain(() => this.allowAgain(target));
    } catch (error) {
      console.error("[datum-agent] onAllowAgain", error);
    }
    if (catalogue.link !== undefined) {
      // Once, now the handle is known: the catalogue's own events (submit's start, a
      // banner's Undo all) then carry the handle and the revision like the registrar's reports.
      try {
        catalogue.link(this.linkFor(target));
      } catch (error) {
        console.error("[datum-agent] catalogue.link", error);
      }
    }
    this.targets.push(target);
    if (!this.sets.has(kind)) {
      this.createSet(kind, this.wrapCatalogueTools(kind, catalogue));
    }
    if (!this.sets.has("session")) {
      this.createSet("session", this.sessionWrappers());
    }
    const registration: FormRegistration = {
      handle,
      revision: () => target.revision,
      runtimeReplaced: () => this.runtimeReplaced(target),
      unregister: (reason = "disconnected") => this.unregister(target, reason),
      provenance: (by) => this.provenanceOf(target, by),
      access: () => this.accessOf(target),
      accessChanged: () => this.accessChanged(target)
    };
    if (entry.signal.aborted) {
      this.unregister(target, "disconnected");
    } else {
      entry.signal.addEventListener("abort", () => this.unregister(target, "disconnected"), { once: true });
    }
    this.emitToolsChanged();
    return registration;
  }

  /**
   * The catalogue's provenance, or `undefined` without one. Never throws: a submit computes
   * it before the runtime submits, so a throwing catalogue must not cost the person their
   * submission, and answering `undefined` would claim the tools were never here. The
   * fallback is the registrar's own account, as the element's after a detach: it may
   * count a path-less agent change (navigate) as involvement, which errs towards review.
   */
  private provenanceOf(target: Target, by: "agent" | "page"): AgentProvenance | undefined {
    const own = target.catalogue.provenance;
    if (own === undefined) {
      return undefined;
    }
    try {
      return own.call(target.catalogue, by);
    } catch (error) {
      console.error("[datum-agent] catalogue.provenance", error);
      return {
        version: 1,
        involved: target.agentChanged,
        paths: [],
        tables: [],
        complete: !target.agentChanged,
        submittedBy: by,
        sessions: target.sessionsOpened,
        sessionOpen: target.session !== undefined
      };
    }
  }

  /** What `catalogue.link` receives: the handle, two readers and `emitAction`. */
  private linkFor(target: Target): CatalogueLink {
    return {
      handle: target.handle,
      revision: () => target.revision,
      sessionId: () => target.session?.id,
      emitAction: (partial) => this.emitAction(target, partial)
    };
  }

  /**
   * A catalogue-caused `datum-agent-action` outside any call: the registrar's detail
   * shape filled from the target, dispatched through the catalogue and to `subscribe()`. It
   * records nothing in the ring, moves no `lastSeenRevision` and leaves the idle timer alone: no
   * call happened.
   */
  private emitAction(target: Target, partial: AgentActionPartial): void {
    const detail: AgentActionDetail = {
      tool: partial.tool,
      target: target.kind,
      handle: target.handle,
      readOnly: partial.readOnly ?? false,
      input: safeEcho(partial.input),
      outcome: partial.outcome.code !== undefined ? { ok: partial.outcome.ok, code: partial.outcome.code } : { ok: partial.outcome.ok },
      durationMs: partial.durationMs ?? 0,
      revision: target.revision,
      changed: partial.changed ?? false,
      trigger: "agent"
    };
    const sessionId = target.session?.id;
    if (sessionId !== undefined) {
      detail.sessionId = sessionId;
    }
    if (partial.paths !== undefined) {
      detail.paths = [...partial.paths];
    }
    if (partial.componentIds !== undefined) {
      detail.componentIds = [...partial.componentIds];
    }
    if (typeof partial.undoSteps === "number") {
      detail.undoSteps = partial.undoSteps;
    }
    try {
      target.catalogue.emit("datum-agent-action", detail);
    } catch (error) {
      console.error("[datum-agent] emit", error);
    }
    this.emit({ type: "action", detail });
  }

  /** The element's id when non-empty and never used as a handle on this page, else `<kind>-<n>`; never reused. */
  private allocateHandle(kind: TargetKind, id: string): string {
    // An id past HANDLE_MAX would make every listing and routing refusal carry it whole, and a cut
    // handle cannot be passed back, so such an id gets the auto handle instead.
    if (id !== "" && id.length <= HANDLE_MAX && !this.usedHandles.has(id)) {
      this.usedHandles.add(id);
      return id;
    }
    let handle: string;
    do {
      this.ordinals[kind] += 1;
      handle = `${kind}-${this.ordinals[kind]}`;
    } while (this.usedHandles.has(handle));
    this.usedHandles.add(handle);
    return handle;
  }

  private wrapCatalogueTools(kind: TargetKind, catalogue: AgentCatalogue<unknown>): AgentTool[] {
    const wrappers: AgentTool[] = [];
    for (const tool of catalogue.tools) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) {
        console.error(`[datum-agent] tool name "${tool.name}" breaks ^[a-z][a-z0-9_]{0,39}$; skipped`);
        continue;
      }
      if (this.specs.has(tool.name) || (SESSION_TOOL_NAMES as readonly string[]).includes(tool.name)) {
        console.error(`[datum-agent] tool name "${tool.name}" is already registered on this page; skipped`);
        continue;
      }
      const wrapper = this.wrapperFor(tool);
      this.specs.set(tool.name, {
        name: tool.name,
        kind,
        tool: wrapper,
        readOnly: tool.annotations.readOnlyHint === true,
        readActions: wrapper.readActions,
        consequential: tool.annotations.consequentialHint === true,
        answersWhenOff: kind === "form" && tool.answersWhenOff === true,
        describe: tool.name === describeToolOf(kind),
        allowedWhileStopped: tool.allowedWhileStopped === true,
        inputBytes: tool.inputBytes ?? INPUT_BYTE_LIMIT
      });
      wrappers.push(wrapper);
    }
    return wrappers;
  }

  private sessionWrappers(): AgentTool[] {
    const schemas = sessionToolSchemas();
    const wrappers: AgentTool[] = [];
    for (const name of SESSION_TOOL_NAMES) {
      const wrapper = this.wrapperFor({
        name,
        title: SESSION_TOOL_TEXTS[name].title,
        description: SESSION_TOOL_TEXTS[name].description,
        inputSchema: schemas[name],
        annotations: { ...SESSION_TOOL_ANNOTATIONS },
        execute: () => ({})
      });
      this.specs.set(name, {
        name,
        kind: "session",
        tool: wrapper,
        readOnly: false,
        readActions: undefined,
        consequential: SESSION_TOOL_ANNOTATIONS.consequentialHint === true,
        answersWhenOff: false,
        describe: false,
        allowedWhileStopped: name === "end_session",
        inputBytes: INPUT_BYTE_LIMIT
      });
      wrappers.push(wrapper);
    }
    return wrappers;
  }

  /** A routing wrapper: the browser-facing description of one name whose `execute` runs the pipeline. */
  private wrapperFor(tool: AgentTool): AgentTool {
    const wrapper: AgentTool = {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { ...tool.annotations },
      execute: async (input: Record<string, unknown>, ctx?: ToolContext) =>
        (await this.run(tool.name, input, ctx?.signal ?? NEVER_ABORTED())) as unknown as ToolData
    };
    if (tool.inputBytes !== undefined) {
      wrapper.inputBytes = tool.inputBytes;
    }
    if (tool.allowedWhileStopped === true) {
      wrapper.allowedWhileStopped = true;
    }
    if (tool.readActions !== undefined) {
      // A copy the catalogue cannot change after registration, as the annotations are.
      wrapper.readActions = { key: tool.readActions.key, values: [...tool.readActions.values] };
    }
    return wrapper;
  }

  private createSet(name: SetName, wrappers: AgentTool[]): void {
    const set: ToolSet = { wrappers, controller: new AbortController(), names: [], reason: undefined };
    this.sets.set(name, set);
    if (this.bound && this.api !== undefined) {
      // A set appearing while bound (a builder registering after the form's bind landed) is
      // registered as it comes, and its landing becomes the in-flight `bind()` so that a caller
      // awaiting `bind()` in the meantime (the first datum-agent-tools event) reads a state
      // that holds this set's names too, not the state before it.
      const landing: Promise<BindingState> = this.settled()
        .then(() => this.bindSet(set))
        .then(
          () => {
            if (this.pending === landing) {
              this.pending = undefined;
            }
            this.emitToolsChanged();
            return this.binding();
          },
          (error: unknown) => {
            // `bindTools` never throws; nobody need await this landing, so it never rejects.
            console.error("[datum-agent] bind", error);
            if (this.pending === landing) {
              this.pending = undefined;
            }
            return this.binding();
          }
        );
      this.pending = landing;
    }
  }

  /** The in-flight `bind()` or landing, as a promise that never rejects, for the next chain to wait on. */
  private settled(): Promise<unknown> {
    return (this.pending ?? Promise.resolve()).then(
      () => undefined,
      () => undefined
    );
  }

  private dropSet(name: SetName): void {
    const set = this.sets.get(name);
    if (set === undefined) {
      return;
    }
    this.sets.delete(name);
    for (const wrapper of set.wrappers) {
      this.specs.delete(wrapper.name);
    }
    // Abort removes the tools from the browser synchronously.
    set.controller.abort();
    this.refreshBindingState();
  }

  private async bindSet(set: ToolSet): Promise<void> {
    const api = this.api;
    if (api === undefined || set.controller.signal.aborted) {
      return;
    }
    const state = await bindTools(api, set.wrappers, (name, input, signal) => this.run(name, input, signal), {
      signal: set.controller.signal
    });
    set.names = state.names;
    set.reason = state.reason;
    this.refreshBindingState();
  }

  private refreshBindingState(): void {
    if (this.api === undefined) {
      return;
    }
    const names: string[] = [];
    let reason: BindingState["reason"];
    const severity = (value: BindingState["reason"]): number =>
      value === "not-allowed" ? 3 : value === "error" ? 2 : value === "duplicate" ? 1 : 0;
    for (const set of this.sets.values()) {
      names.push(...set.names);
      if (severity(set.reason) > severity(reason)) {
        reason = set.reason;
      }
    }
    const state: BindingState = { registered: names.length > 0, names };
    if (reason !== undefined) {
      state.reason = reason;
    }
    this.bindingState = state;
  }

  private emitToolsChanged(): void {
    this.emit({ type: "tools-changed", names: this.tools().map((tool) => tool.name), binding: this.binding() });
  }

  private emit(event: RegistrarEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("[datum-agent] listener", error);
      }
    }
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  private recordChange(target: Target, paths: readonly string[], by: "agent" | "other"): void {
    target.revision += 1;
    if (by === "agent") {
      target.agentChanged = true;
    }
    const entries = paths.length === 0 ? [""] : paths;
    for (const path of entries) {
      target.ring.push({ revision: target.revision, path, by });
    }
    if (target.ring.length > RING_SIZE) {
      target.ring.splice(0, target.ring.length - RING_SIZE);
    }
  }

  private runtimeReplaced(target: Target): void {
    if (!target.connected) {
      return;
    }
    target.revision += 1;
    this.endSessionBy(target, "rebuilt", 0);
    target.stopped = undefined;
    target.state.clear();
    // Before the reset, so a tool's subscription on the old runtime (try_it's Submit) goes
    // with it; the tool picks up again on its next call.
    this.disposeTools(target);
    try {
      target.catalogue.reset();
    } catch (error) {
      console.error("[datum-agent] catalogue.reset", error);
    }
  }

  /**
   * Every tool of the target lets go of what it holds
   * outside a call. Each in its own try, so one throwing tool is logged and the rest are still
   * disposed; called on a rebuild and on unregister, never from a call.
   */
  private disposeTools(target: Target): void {
    for (const tool of target.catalogue.tools) {
      if (typeof tool.dispose !== "function") {
        continue;
      }
      try {
        tool.dispose();
      } catch (error) {
        console.error(`[datum-agent] ${tool.name}: dispose`, error);
      }
    }
  }

  /**
   * Re-read the target's access; on a flip (live ↔ sealed,
   * or sealed by another `by`) the revision bumps, an open session ends as `rebuilt` (the reason a
   * definition swap uses; nothing is undone), and the listeners hear `tools-changed` so the
   * element re-dispatches `datum-agent-tools` with the new access. No `catalogue.reset()`: the
   * journal and the last-writer map stay, so a form that goes live → sealed → live can still undo
   * its earlier writes once live again.
   */
  private accessChanged(target: Target): void {
    if (!target.connected) {
      return;
    }
    const key = accessKey(this.accessOf(target));
    if (key === target.lastAccess) {
      return;
    }
    target.lastAccess = key;
    target.revision += 1;
    this.endSessionBy(target, "rebuilt", 0);
    this.emitToolsChanged();
  }

  private unregister(target: Target, reason: UnregisterReason): void {
    if (!target.connected) {
      return;
    }
    target.connected = false;
    this.endSessionBy(target, reason, 0);
    target.stopped = undefined;
    target.unwatch();
    // The catalogue is gone with the registration, so nothing a tool subscribed may outlive it.
    this.disposeTools(target);
    target.state.clear();
    const index = this.targets.indexOf(target);
    if (index >= 0) {
      this.targets.splice(index, 1);
    }
    if (this.targetsOf(target.kind).length === 0) {
      this.dropSet(target.kind);
    }
    if (this.targets.length === 0) {
      this.dropSet("session");
    }
    this.emitToolsChanged();
  }

  private targetsOf(kind: TargetKind): Target[] {
    return this.targets.filter((target) => target.kind === kind);
  }

  // ---- the pipeline --------------------------------------------------------------

  /**
   * The one entry for the browser path and `execute()`, and the catch-all that
   * guarantees nothing throws out of a tool's `execute`: the body's own
   * failures are answered inside `body()` / `sessionTool()`, and anything the pipeline itself
   * throws before or after the body (a caller-supplied input JSON cannot serialise, such as a
   * BigInt or a cycle handed to the in-page `execute()`) is answered here as `internal`, stamped
   * and reported like any other refusal, instead of rejecting the call.
   */
  private async run(name: string, rawInput: unknown, signal: AbortSignal): Promise<AgentToolResult> {
    const trace: CallTrace = {
      startedAt: this.now(),
      kind: "form",
      target: undefined,
      input: rawInput,
      readOnly: true,
      consequential: false,
      changedFrom: 0,
      sessionAtStart: undefined,
      warnings: []
    };
    try {
      return await this.pipeline(name, rawInput, signal, trace);
    } catch (error) {
      console.error(`[datum-agent] ${name}`, error);
      const message = error instanceof Error ? error.message : String(error);
      const refusal = refusalOf(
        "internal",
        message,
        `Try once more; if it repeats, tell the person the ${trace.kind} reported an error.`,
        { message }
      );
      const result = this.refusalEnvelope(name, refusal, trace.target, trace.warnings);
      try {
        this.report(
          name,
          trace.kind,
          trace.target,
          trace.input,
          result,
          trace.startedAt,
          trace.readOnly,
          trace.changedFrom,
          trace.sessionAtStart,
          trace.consequential
        );
      } catch (reportError) {
        console.error(`[datum-agent] ${name} report`, reportError);
      }
      return result;
    }
  }

  private async pipeline(name: string, rawInput: unknown, signal: AbortSignal, trace: CallTrace): Promise<AgentToolResult> {
    const startedAt = trace.startedAt;
    const spec = this.specs.get(name);
    const warnings = trace.warnings;
    trace.kind = spec?.kind === "builder" ? "builder" : "form";
    trace.readOnly = spec?.readOnly ?? true;
    trace.consequential = spec?.consequential ?? false;
    const finishWithout = (refusal: Refusal, kind: TargetKind, input: unknown): AgentToolResult => {
      const result = this.refusalEnvelope(name, refusal, undefined, warnings);
      this.report(name, kind, undefined, input, result, startedAt, spec?.readOnly ?? true, 0, undefined, trace.consequential);
      return result;
    };

    // 1. Shape.
    const shaped = this.shapeInput(rawInput);
    if ("refusal" in shaped) {
      return finishWithout(shaped.refusal, trace.kind, rawInput);
    }
    const input = shaped.input;
    trace.input = input;

    if (spec === undefined) {
      return finishWithout(
        refusalOf(
          "bad-input",
          `No tool named ${name} is registered on this page.`,
          "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.",
          { problems: [{ key: "", expected: "a registered tool name" }] }
        ),
        "form",
        input
      );
    }

    // 2. Target.
    const resolved = this.resolveTarget(spec, input, warnings);
    if ("listing" in resolved) {
      const result = this.listing(spec, resolved.kind, warnings);
      this.report(name, resolved.kind, undefined, input, result, startedAt, true, 0, undefined, spec.consequential);
      return result;
    }
    if ("refusal" in resolved) {
      return finishWithout(resolved.refusal, resolved.kind, input);
    }
    const target = resolved.target;
    trace.target = target;
    trace.kind = target.kind;
    // The event about the call that ends a session (end_session, a cancel) still names it.
    const sessionAtStart = target.session?.id;
    trace.sessionAtStart = sessionAtStart;
    // Whether this call is a read: the tool's readOnlyHint until the schema check has run, then
    // also a read action of a folded tool, judged once on the checked input.
    let readCall = spec.readOnly;
    // The action event echoes the validated input once the schema check has run.
    const finish = (result: AgentToolResult, changedFrom: number): AgentToolResult => {
      this.report(name, target.kind, target, trace.input, result, startedAt, readCall, changedFrom, sessionAtStart, spec.consequential);
      return result;
    };
    const refuse = (refusal: Refusal, changedFrom: number, ready = true): AgentToolResult =>
      finish(this.refusalEnvelope(name, refusal, target, warnings, ready), changedFrom);

    this.touch(target);
    const notReady = this.readinessRefusal(target);
    if (notReady !== undefined) {
      return refuse(notReady, target.revision, false);
    }
    // Access after readiness (a form still building answers
    // form-not-ready, retryable) and before the schema check, so a sealed form answers agent-off
    // whatever the arguments, and nothing is read from the form for a refused call.
    const sealed = this.accessRefusal(spec, target);
    if (sealed !== undefined) {
      return refuse(sealed, target.revision);
    }

    // 3. Schema subset, with the person-facing texts pre-cut.
    if (spec.kind === "session") {
      if (typeof input.purpose === "string") {
        input.purpose = cleanText(input.purpose, SESSION_PURPOSE_MAX);
      }
      if (typeof input.summary === "string") {
        input.summary = cleanText(input.summary, SESSION_SUMMARY_MAX);
      }
    }
    const checked = checkInput(spec.tool.inputSchema, input);
    for (const key of checked.ignoredKeys) {
      // Every catalogue schema carries its own handle key and the session pair carries
      // all three, so only a schema that happens to omit the target's own handle is spared; a wrong
      // handle (`builder` or `target` on a form tool) is named like any unknown key.
      if (key !== target.kind) {
        warnings.push(`ignored unknown argument: ${key}`);
      }
    }
    if (checked.problems.length > 0) {
      return refuse(
        refusalOf(
          "bad-input",
          `The arguments do not fit ${name}'s schema.`,
          "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.",
          { problems: checked.problems }
        ),
        target.revision
      );
    }
    const toolInput = checked.input;
    trace.input = toolInput;
    // From here on a call naming one of the tool's readActions is a
    // read, for the Stop latch, the read / write branch, `alsoChanged` and the event's `readOnly`.
    readCall = spec.readOnly || inReadActions(spec, toolInput);
    trace.readOnly = readCall;

    // 4. Input caps: the whole input; list and string caps are the catalogue's.
    const bytes = jsonByteLength(toolInput);
    if (bytes > spec.inputBytes) {
      return refuse(
        refusalOf(
          "too-large",
          `The input is ${bytes} bytes, over the ${spec.inputBytes} byte limit.`,
          `Send fewer items per call (at most ${spec.inputBytes} bytes for the whole input) and call again for the rest.`,
          { what: "input", limit: spec.inputBytes, got: bytes }
        ),
        target.revision
      );
    }

    // 6. Order guards: the cheap ones before queueing.
    const stoppedRefusal = this.stoppedRefusal(spec, target, readCall);
    if (stoppedRefusal !== undefined) {
      return refuse(stoppedRefusal, target.revision);
    }
    if (signal.aborted) {
      this.endSessionBy(target, "cancelled", 0);
      return refuse(this.cancelledRefusal(name, target.kind), target.revision);
    }

    if (readCall) {
      // Reads run at once against a consistent snapshot, never queued behind a write;
      // like every read they are not judged stale (expectedRevision is a write's guard).
      const changedFrom = target.revision;
      trace.changedFrom = changedFrom;
      const result = await this.body(spec, target, toolInput, signal, warnings, true);
      return finish(result, changedFrom);
    }

    // Writes and the session tools: one at a time per target.
    const previous = target.chain;
    let release: () => void = () => undefined;
    target.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = await waitFor(previous, this.queueTimeoutMs);
    if (!acquired) {
      // Keep the chain ordered: our slot opens when the previous write settles.
      void previous.then(release);
      return refuse(
        refusalOf(
          "busy",
          `The ${target.kind} is still working on the previous call.`,
          `Wait a moment and call ${describeToolOf(target.kind)} before retrying.`,
          { because: "previous-call", startedAt }
        ),
        target.revision
      );
    }
    try {
      // Judged at the head of the chain.
      if (!target.connected) {
        return refuse(this.notReadyRefusal(target.kind, { state: "removed" }), target.revision, false);
      }
      const notReadyNow = this.readinessRefusal(target);
      if (notReadyNow !== undefined) {
        return refuse(notReadyNow, target.revision, false);
      }
      // Again at the head of the chain: a write queued while the form was live and reached after
      // a flip to sealed does not run.
      const sealedNow = this.accessRefusal(spec, target);
      if (sealedNow !== undefined) {
        return refuse(sealedNow, target.revision);
      }
      const stoppedNow = this.stoppedRefusal(spec, target, false);
      if (stoppedNow !== undefined) {
        return refuse(stoppedNow, target.revision);
      }
      const expected = toolInput.expectedRevision;
      if (typeof expected === "number" && expected < target.revision) {
        return refuse(
          refusalOf(
            "stale",
            `The ${target.kind} changed since revision ${expected}; it is at ${target.revision} and nothing was applied.`,
            staleHint(target.kind),
            this.staleDetailsOf(target, expected)
          ),
          target.revision
        );
      }
      if (signal.aborted) {
        this.endSessionBy(target, "cancelled", 0);
        return refuse(this.cancelledRefusal(name, target.kind), target.revision);
      }
      const changedFrom = target.revision;
      trace.changedFrom = changedFrom;
      const result =
        spec.kind === "session"
          ? await this.sessionTool(spec.name as SessionToolName, target, toolInput, signal, warnings)
          : await this.body(spec, target, toolInput, signal, warnings, false);
      return finish(result, changedFrom);
    } finally {
      release();
    }
  }

  private shapeInput(rawInput: unknown): { input: Record<string, unknown> } | { refusal: Refusal } {
    let value = rawInput;
    if (value === undefined) {
      value = {};
    } else if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        value = undefined;
      }
    }
    if (!isPlainObject(value)) {
      return {
        refusal: refusalOf(
          "bad-input",
          "The input is not a JSON object.",
          "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.",
          { problems: [{ key: "", expected: "a JSON object" }] }
        )
      };
    }
    return { input: { ...value } };
  }

  private resolveTarget(
    spec: ToolSpec,
    input: Record<string, unknown>,
    warnings: string[]
  ): { target: Target } | { listing: true; kind: TargetKind } | { refusal: Refusal; kind: TargetKind } {
    let kind: TargetKind;
    if (spec.kind === "session") {
      const present = (["form", "builder"] as const).filter((candidate) => this.targetsOf(candidate).length > 0);
      const asked = input.target;
      if (present.length === 2) {
        if (asked === undefined) {
          return {
            kind: "form",
            refusal: refusalOf(
              "target-required",
              "This page has both a form and a builder; the session needs a target.",
              "Pass target: 'form' or 'builder'.",
              { targets: [...present] }
            )
          };
        }
        if (asked !== "form" && asked !== "builder") {
          return {
            kind: "form",
            refusal: refusalOf(
              "bad-input",
              `The arguments do not fit ${spec.name}'s schema.`,
              "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.",
              { problems: [{ key: "target", expected: "one of: form, builder" }] }
            )
          };
        }
        kind = asked;
      } else {
        kind = present[0] ?? "form";
        if (asked !== undefined) {
          warnings.push(`ignored target: the page has only a ${kind}`);
        }
      }
    } else {
      kind = spec.kind;
    }
    const candidates = this.targetsOf(kind);
    const asked = input[kind];
    if (asked === undefined) {
      if (candidates.length === 1) {
        return { target: candidates[0] as Target };
      }
      if (spec.describe) {
        return { listing: true, kind };
      }
      return {
        kind,
        refusal: refusalOf(
          `${kind}-required`,
          `This page has ${candidates.length} ${kind}s; say which one.`,
          `Pass ${kind} with one of the listed handles; ${describeToolOf(kind)} lists them.`,
          { [`${kind}s`]: candidates.map((candidate) => this.summaryOf(candidate)) }
        )
      };
    }
    if (typeof asked !== "string") {
      return {
        kind,
        refusal: refusalOf(
          "bad-input",
          `The arguments do not fit ${spec.name}'s schema.`,
          "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.",
          { problems: [{ key: kind, expected: "a string" }] }
        )
      };
    }
    const target = candidates.find((candidate) => candidate.handle === asked);
    if (target === undefined) {
      return {
        kind,
        refusal: refusalOf(
          `${kind}-unknown`,
          // The routing runs before the input caps, so the
          // quoted handle is cut, or a 70 000-character handle would answer over the result cap.
          `No ${kind} on this page has the handle "${cutString(asked, 128)}".`,
          "Use one of the listed handles.",
          { [`${kind}s`]: candidates.map((candidate) => this.summaryOf(candidate)) }
        )
      };
    }
    return { target };
  }

  /** The targets listing: `describe_*` with two or more targets and no handle; about no target, so no `revision`. */
  private listing(spec: ToolSpec, kind: TargetKind, warnings: string[]): AgentToolResult {
    const result: Record<string, unknown> = {
      ok: true,
      tool: spec.name,
      [`${kind}s`]: this.targetsOf(kind).map((target) => this.summaryOf(target))
    };
    if (warnings.length > 0) {
      result.warnings = capWarnings(warnings);
    }
    return capResult(result, this.resultByteLimit).result as unknown as AgentToolResult;
  }

  /** FormSummary / BuilderSummary with the handle and the session flag stamped; a target not ready is listed by its state. */
  private summaryOf(target: Target): Record<string, unknown> {
    const readiness = this.readinessOf(target);
    if (target.kind === "form") {
      if (readiness.state !== "ready") {
        return {
          form: target.handle,
          title: "",
          fields: 0,
          pages: 0,
          locale: "",
          session: target.session !== undefined,
          state: readiness.state
        };
      }
      const access = this.accessOf(target);
      if (access.state === "sealed") {
        // A sealed form keeps its title, so the model can
        // name it to the person, and says who sealed it; nothing else of it is listed.
        const title = this.catalogueSummary(target).title;
        return {
          form: target.handle,
          title: typeof title === "string" ? title : "",
          fields: 0,
          pages: 0,
          locale: "",
          session: target.session !== undefined,
          state: "off",
          by: access.by
        };
      }
      return { form: target.handle, ...this.catalogueSummary(target), session: target.session !== undefined };
    }
    return { builder: target.handle, ...this.catalogueSummary(target) };
  }

  private catalogueSummary(target: Target): Record<string, unknown> {
    try {
      const summary = target.catalogue.summary();
      const { form: _form, builder: _builder, ...rest } = summary;
      return rest;
    } catch (error) {
      console.error("[datum-agent] catalogue.summary", error);
      return {};
    }
  }

  private readinessOf(target: Target): CatalogueReadiness {
    if (!target.connected) {
      return { state: "removed" };
    }
    try {
      return target.catalogue.readiness();
    } catch (error) {
      console.error("[datum-agent] catalogue.readiness", error);
      return { state: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * A form's access from its catalogue, live without one (and
   * always for a builder). A throw is logged and answered sealed `unset`: the gate fails closed.
   */
  private accessOf(target: Target): AgentAccessState {
    if (target.kind !== "form") {
      return { state: "live" };
    }
    const read = target.catalogue.access;
    if (read === undefined) {
      return { state: "live" };
    }
    try {
      const access = read.call(target.catalogue);
      if (access.state === "sealed") {
        return { state: "sealed", by: access.by === "author" ? "author" : "unset" };
      }
      return { state: "live" };
    } catch (error) {
      console.error("[datum-agent] catalogue.access", error);
      return { state: "sealed", by: "unset" };
    }
  }

  /** `agent-off { by }` for every call on a sealed form but a tool that answers it itself (`answersWhenOff`, describe_form). */
  private accessRefusal(spec: ToolSpec, target: Target): Refusal | undefined {
    const access = this.accessOf(target);
    if (access.state === "live" || spec.answersWhenOff) {
      return undefined;
    }
    return refusalOf("agent-off", AGENT_OFF_MESSAGES[access.by], AGENT_OFF_HINT, { by: access.by });
  }

  private readinessRefusal(target: Target): Refusal | undefined {
    const readiness = this.readinessOf(target);
    if (readiness.state === "ready") {
      return undefined;
    }
    return this.notReadyRefusal(target.kind, readiness);
  }

  private notReadyRefusal(kind: TargetKind, readiness: Exclude<CatalogueReadiness, { state: "ready" }>): Refusal {
    const details: Record<string, unknown> = { state: readiness.state };
    if (readiness.message !== undefined) {
      details.message = readiness.message;
    }
    const what =
      readiness.state === "loading"
        ? `The ${kind} is still loading.`
        : readiness.state === "failed"
          ? `The ${kind} failed to load.`
          : `The ${kind} has left the page.`;
    return refusalOf(`${kind}-not-ready`, what, notReadyHint(kind, readiness.state, readiness.message), details);
  }

  /** `read`: this call is a read (a readOnlyHint tool or a read action), which the latch never refuses. */
  private stoppedRefusal(spec: ToolSpec, target: Target, read: boolean): Refusal | undefined {
    if (target.stopped === undefined || read || spec.allowedWhileStopped) {
      return undefined;
    }
    return refusalOf(
      "stopped",
      "The person stopped the assistant from the banner; nothing was changed.",
      "Tell the person you have stopped and what was undone; they can allow you to continue from the banner.",
      { stoppedAt: target.stopped.stoppedAt, undone: target.stopped.undone }
    );
  }

  /** The hint names the target's own describe tool: `describe_builder` on a builder. */
  private cancelledRefusal(name: string, kind: TargetKind, stillRunning = false): Refusal {
    const details: Record<string, unknown> = {};
    if (stillRunning) {
      details.stillRunning = true;
    }
    return refusalOf(
      "cancelled",
      `The call to ${name} was cancelled.`,
      `The call was cancelled. If stillRunning is set the action may still complete; call ${describeToolOf(kind)} before retrying.`,
      details
    );
  }

  /**
   * The `stale` details: the catalogue's own when it supplies
   * `staleDetails` (the builder's `{ revision, outline }`), which replace the default; the default
   * `{ revision, changedPaths }` when it does not, when it throws or when it answers no object.
   */
  private staleDetailsOf(target: Target, expected: number): Record<string, unknown> {
    const own = target.catalogue.staleDetails;
    if (own !== undefined) {
      try {
        const details: unknown = own.call(target.catalogue, target.revision, expected);
        if (isPlainObject(details)) {
          return details;
        }
        console.error("[datum-agent] catalogue.staleDetails answered no object; the default details are used");
      } catch (error) {
        console.error("[datum-agent] catalogue.staleDetails", error);
      }
    }
    return { revision: target.revision, changedPaths: this.changedSince(target, expected) };
  }

  private changedSince(target: Target, revision: number): Array<{ path: string; by: "agent" | "other" }> {
    return target.ring
      .filter((entry) => entry.revision > revision && entry.path !== "")
      .slice(-RING_SIZE)
      .map((entry) => ({ path: entry.path, by: entry.by }));
  }

  /** Every call on a target resets its session's idle timer. */
  private touch(target: Target): void {
    const session = target.session;
    if (session === undefined) {
      return;
    }
    session.lastCallAt = this.now();
    this.armIdle(target, session);
  }

  private armIdle(target: Target, session: OpenSession): void {
    if (session.timer !== undefined) {
      clearTimeout(session.timer);
    }
    session.timer = setTimeout(() => {
      if (target.session === session) {
        this.endSessionBy(target, "idle", 0);
      }
    }, this.idleTimeoutMs);
  }

  private async body(
    spec: ToolSpec,
    target: Target,
    input: Record<string, unknown>,
    signal: AbortSignal,
    warnings: string[],
    read: boolean
  ): Promise<AgentToolResult> {
    const tool = target.catalogue.tools.find((candidate) => candidate.name === spec.name);
    if (tool === undefined) {
      return this.refusalEnvelope(
        spec.name,
        refusalOf(
          "internal",
          `The ${target.kind} "${target.handle}" has no tool named ${spec.name}.`,
          `Try once more; if it repeats, tell the person the ${target.kind} reported an error.`,
          { message: "tool not available on this target" }
        ),
        target,
        warnings
      );
    }
    if (target.session !== undefined) {
      target.session.calls += 1;
    }
    const ctx: ToolContext<unknown> = {
      host: target.catalogue.host,
      signal,
      revision: () => target.revision,
      session: this.sessionStateOf(target),
      state: target.state
    };
    try {
      const fields = await tool.execute(input, ctx);
      if (signal.aborted) {
        // The action completed after the caller gave up: the in-page caller reads an ok result,
        // the browser path already rejected it (fake-model-context.ts reproduces Chrome 155), so
        // the stamp stays pending for the next delivered result (see `stampSessionEnded`).
        this.endSessionBy(target, "cancelled", 0);
      }
      return this.okEnvelope(spec, target, fields, warnings, signal.aborted, read);
    } catch (error) {
      return this.caught(spec, target, error, signal, warnings);
    }
  }

  private caught(spec: ToolSpec, target: Target, error: unknown, signal: AbortSignal, warnings: string[]): AgentToolResult {
    if (error instanceof ToolRefusal) {
      if (error.code === "cancelled") {
        this.endSessionBy(target, "cancelled", 0);
      }
      return this.refusalEnvelope(spec.name, fromToolRefusal(error), target, warnings);
    }
    const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
    if (signal.aborted || name === "AbortError") {
      this.endSessionBy(target, "cancelled", 0);
      return this.refusalEnvelope(spec.name, this.cancelledRefusal(spec.name, target.kind), target, warnings);
    }
    console.error(`[datum-agent] ${spec.name}`, error);
    const message = error instanceof Error ? error.message : String(error);
    return this.refusalEnvelope(
      spec.name,
      refusalOf(
        "internal",
        message,
        `Try once more; if it repeats, tell the person the ${target.kind} reported an error.`,
        { message }
      ),
      target,
      warnings
    );
  }

  // ---- envelopes --------------------------------------------------------------------------------

  /**
   * The ok envelope: the tool's fields under the stamps, warnings merged, `alsoChanged`
   * on writes, `sessionEnded` when one is pending, then the output cap over the whole of it, so
   * what leaves the registrar is never over the limit. Step (c) replaces the envelope with a `too-large` refusal that keeps only
   * tool, handle and revision (result-caps.ts), so the once-only stamp and the registrar's
   * warnings are re-attached to that refusal. `undelivered` is true when the caller's signal
   * fired during the body: the stamp is then written but kept pending (see `stampSessionEnded`).
   * `read` is whether the call was a read (a read action counts), which takes no
   * `alsoChanged`.
   */
  private okEnvelope(
    spec: ToolSpec,
    target: Target,
    fields: ToolData,
    warnings: string[],
    undelivered = false,
    read = spec.readOnly
  ): AgentToolResult {
    const { ok: _ok, tool: _tool, form: _form, builder: _builder, revision: _revision, warnings: own, ...rest } = fields;
    const envelope: Record<string, unknown> = {
      ok: true,
      tool: spec.name,
      [target.kind]: target.handle,
      revision: target.revision,
      ...rest
    };
    // Capped once here so the list the too-large refusal gets back below is the short one too.
    const allWarnings = capWarnings([
      ...warnings,
      ...(Array.isArray(own) ? own.filter((item): item is string => typeof item === "string") : [])
    ]);
    if (allWarnings.length > 0) {
      envelope.warnings = allWarnings;
    }
    if (!read && spec.kind !== "session") {
      const alsoChanged = this.alsoChanged(target);
      if (alsoChanged.length > 0) {
        envelope.alsoChanged = alsoChanged;
      }
    }
    const stamp = target.pendingEnded;
    if (stamp !== undefined) {
      envelope.sessionEnded = stamp;
    }
    const capped = capResult(envelope, this.resultByteLimit).result;
    if (capped.ok === false) {
      capped.retryable = retryableFor(String(capped.code), capped.details as Record<string, unknown> | undefined);
      if (allWarnings.length > 0 && capped.warnings === undefined) {
        capped.warnings = allWarnings;
      }
      if (stamp !== undefined) {
        capped.sessionEnded = stamp;
      }
    }
    if (stamp !== undefined && !undelivered) {
      target.pendingEnded = undefined;
    }
    return capped as AgentToolResult;
  }

  private refusalEnvelope(
    name: string,
    refusal: Refusal,
    target: Target | undefined,
    warnings: string[],
    ready = true
  ): AgentRefusal {
    const envelope: AgentRefusal = {
      ok: false,
      tool: name,
      code: refusal.code,
      message: refusal.message,
      hint: refusal.hint,
      retryable: retryableFor(refusal.code, refusal.details)
    };
    if (refusal.details !== undefined) {
      envelope.details = refusal.details;
    }
    if (target !== undefined) {
      envelope[target.kind] = target.handle;
      if (ready) {
        envelope.revision = target.revision;
      }
      this.stampSessionEnded(target, envelope as unknown as Record<string, unknown>, refusal.code === "cancelled");
    }
    if (warnings.length > 0) {
      envelope.warnings = capWarnings(warnings);
    }
    // A refusal is bound by the output cap like an ok result; its lists are cut, never the code.
    return capRefusal(envelope as unknown as Record<string, unknown>, this.resultByteLimit) as unknown as AgentRefusal;
  }

  /**
   * `sessionEnded` is set once, on the first result after a session ended any way but
   * `end_session`. A result the agent never reads must not consume it: through the browser a
   * call whose signal fired rejects with the caller's reason (Chrome 155, reproduced by
   * fake-model-context.ts), so a `cancelled` refusal, and an ok result finished after the abort,
   * carry the stamp but leave it pending for the next delivered result. The in-page `execute()`
   * caller, who does read the cancelled result, sees it twice at worst.
   */
  private stampSessionEnded(target: Target, envelope: Record<string, unknown>, undelivered = false): void {
    if (target.pendingEnded !== undefined) {
      envelope.sessionEnded = target.pendingEnded;
      if (!undelivered) {
        target.pendingEnded = undefined;
      }
    }
  }

  /** Paths changed by anyone but the agent since the agent's previous call on this target, cap 20. */
  private alsoChanged(target: Target): string[] {
    const seen = new Set<string>();
    for (const entry of target.ring) {
      if (entry.revision > target.lastSeenRevision && entry.by === "other" && entry.path !== "") {
        seen.add(entry.path);
      }
    }
    return [...seen].slice(0, ALSO_CHANGED_CAP);
  }

  /** The `datum-agent-action` event after every call, through the target's catalogue and the subscribers. */
  private report(
    name: string,
    kind: TargetKind,
    target: Target | undefined,
    input: unknown,
    result: AgentToolResult,
    startedAt: number,
    readOnly: boolean,
    changedFrom: number,
    sessionAtStart?: string,
    consequential = false
  ): void {
    // `changed` is whether the call itself changed the target: any agent entry the
    // ring recorded during it, including the path-less ones the renderer's navigate / set_locale
    // / submit report (`paths: []`); `paths` / `componentIds` are the named subset.
    const agentPaths: string[] = [];
    let changed = false;
    if (target !== undefined) {
      for (const entry of target.ring) {
        if (entry.revision > changedFrom && entry.by === "agent") {
          changed = true;
          if (entry.path !== "" && !agentPaths.includes(entry.path)) {
            agentPaths.push(entry.path);
          }
        }
      }
      target.lastSeenRevision = target.revision;
      this.touch(target);
    }
    const detail: AgentActionDetail = {
      tool: name,
      target: kind,
      handle: target?.handle ?? "",
      readOnly,
      input: safeEcho(input),
      outcome: result.ok ? { ok: true } : { ok: false, code: result.code },
      durationMs: Math.max(0, this.now() - startedAt),
      revision: target?.revision ?? 0,
      changed,
      trigger: "agent"
    };
    // The session the call ran in: the one open now (begin_session's own), else the
    // one open when the call started, so end_session and the call whose cancel ended it are
    // still correlated to it.
    const sessionId = target?.session?.id ?? sessionAtStart;
    if (sessionId !== undefined) {
      detail.sessionId = sessionId;
    }
    if (consequential) {
      detail.consequential = true;
    }
    if (agentPaths.length > 0) {
      if (kind === "form") {
        detail.paths = agentPaths;
      } else {
        detail.componentIds = agentPaths;
      }
    }
    if (kind === "builder" && result.ok) {
      // The history entries an ok builder write pushed, from its own `undo.steps`.
      const undo = (result as unknown as { undo?: unknown }).undo;
      const steps = isPlainObject(undo) ? undo.steps : undefined;
      if (typeof steps === "number") {
        detail.undoSteps = steps;
      }
    }
    const carrier = target ?? this.targetsOf(kind)[0];
    if (carrier !== undefined) {
      try {
        carrier.catalogue.emit("datum-agent-action", detail);
      } catch (error) {
        console.error("[datum-agent] emit", error);
      }
    }
    this.emit({ type: "action", detail });
  }

  // ---- sessions --------------------------------------------------------------------

  private sessionStateOf(target: Target): SessionState | undefined {
    const session = target.session;
    if (session === undefined) {
      return undefined;
    }
    return {
      id: session.id,
      target: target.kind,
      handle: target.handle,
      purpose: session.purpose,
      startedAt: session.startedAt,
      lastCallAt: session.lastCallAt,
      revisionAtBegin: session.revisionAtBegin,
      undoBoundary: session.undoBoundary,
      idleTimeoutMs: this.idleTimeoutMs
    };
  }

  private async sessionTool(
    name: SessionToolName,
    target: Target,
    input: Record<string, unknown>,
    signal: AbortSignal,
    warnings: string[]
  ): Promise<AgentToolResult> {
    const spec = this.specs.get(name) as ToolSpec;
    try {
      const outcome =
        name === "begin_session" ? this.beginSession(target, input) : await this.endSession(target, input, warnings);
      if ("refusal" in outcome) {
        return this.refusalEnvelope(name, outcome.refusal, target, warnings);
      }
      if (signal.aborted) {
        this.endSessionBy(target, "cancelled", 0);
      }
      return this.okEnvelope(spec, target, outcome.fields, warnings, signal.aborted);
    } catch (error) {
      return this.caught(spec, target, error, signal, warnings);
    }
  }

  private beginSession(target: Target, input: Record<string, unknown>): { fields: ToolData } | { refusal: Refusal } {
    const purpose = typeof input.purpose === "string" ? input.purpose : "";
    const open = target.session;
    if (open !== undefined) {
      // Idempotent while open: the purpose is updated, the same id returned. The
      // catalogue re-renders its banner through `purposeChanged` first (a throw never fails the
      // call), then host listeners learn it from a second `begin` event marked `resumed`.
      open.purpose = purpose;
      this.armIdle(target, open);
      const hooks = target.catalogue.sessionHooks;
      if (hooks.purposeChanged !== undefined) {
        try {
          hooks.purposeChanged(purpose);
        } catch (error) {
          console.error("[datum-agent] sessionHooks.purposeChanged", error);
        }
      }
      this.emitSession(target, { phase: "begin", sessionId: open.id, purpose, resumed: true });
      return { fields: this.beginResult(open, true) };
    }
    const hooks = target.catalogue.sessionHooks;
    const id = `session-${++this.sessionCounter}`;
    const begun = hooks.begin(purpose, () => {
      void this.stop(target, id);
    });
    if ("refused" in begun) {
      return { refusal: fromToolRefusal(begun.refused) };
    }
    const startedAt = this.now();
    const session: OpenSession = {
      id,
      purpose,
      startedAt,
      lastCallAt: startedAt,
      revisionAtBegin: target.revision,
      undoBoundary: begun.undoBoundary,
      locked: begun.locked,
      pausedTyping: begun.pausedTyping,
      calls: 0,
      timer: undefined
    };
    target.session = session;
    target.lastSessionId = id;
    target.sessionsOpened += 1;
    this.armIdle(target, session);
    this.emitSession(target, { phase: "begin", sessionId: id, purpose });
    return { fields: this.beginResult(session, false) };
  }

  private beginResult(session: OpenSession, resumed: boolean): ToolData {
    const result: ToolData = {
      session: {
        id: session.id,
        purpose: session.purpose,
        startedAt: session.startedAt,
        idleTimeoutMs: this.idleTimeoutMs,
        revisionAtBegin: session.revisionAtBegin
      },
      locked: session.locked
    };
    if (session.pausedTyping !== undefined) {
      result.pausedTyping = session.pausedTyping;
    }
    if (resumed) {
      result.resumed = true;
    }
    return result;
  }

  private async endSession(
    target: Target,
    input: Record<string, unknown>,
    warnings: string[]
  ): Promise<{ fields: ToolData } | { refusal: Refusal }> {
    const session = target.session;
    const summary = typeof input.summary === "string" ? input.summary : "";
    if (session === undefined) {
      if (input.undo !== undefined) {
        warnings.push("ignored undo: no session was open");
      }
      return { fields: { wasOpen: false, note: ["No session was open; nothing to end."] } };
    }
    this.closeSession(target, session);
    const hooks = target.catalogue.sessionHooks;
    let undone = 0;
    let undoFailed = false;
    if (input.undo === true) {
      try {
        undone = await hooks.undoAll();
      } catch (error) {
        // The session ends anyway; the warning says how far the undo got.
        undoFailed = true;
        console.error("[datum-agent] undoAll", error);
      }
    }
    const ended = hooks.end("ended", summary);
    if (undoFailed) {
      warnings.push(`undo stopped early: ${undone} of ${undone + ended.undoable} restored`);
    }
    // The catalogue's own words after the registrar's: plain strings only, so a hook
    // can never put a non-JSON value into the envelope.
    for (const warning of ended.warnings ?? []) {
      if (typeof warning === "string") {
        warnings.push(warning);
      }
    }
    const note = (ended.note ?? []).filter((line): line is string => typeof line === "string");
    this.emitSession(target, { phase: "end", sessionId: session.id, summary, reason: "ended", undone });
    return {
      fields: {
        wasOpen: true,
        session: {
          id: session.id,
          durationMs: Math.max(0, this.now() - session.startedAt),
          calls: session.calls,
          undone,
          ...ended.changes,
          undoable: ended.undoable
        },
        ...(note.length > 0 ? { note } : {})
      }
    };
  }

  /** Detaches the session from its target before any hook runs, so a re-entrant call sees it closed. */
  private closeSession(target: Target, session: OpenSession): void {
    if (session.timer !== undefined) {
      clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (target.session === session) {
      target.session = undefined;
    }
  }

  /** Every end but `end_session` itself: no undo here (Stop undoes before calling), the next result carries `sessionEnded` once. */
  private endSessionBy(target: Target, reason: SessionEndedReason, undone: number): void {
    const session = target.session;
    if (session === undefined) {
      return;
    }
    this.closeSession(target, session);
    this.finishSession(target, session, reason, undone);
  }

  /** The tail of every end but `end_session`, over a session already detached by `closeSession`. */
  private finishSession(target: Target, session: OpenSession, reason: SessionEndedReason, undone: number): void {
    try {
      target.catalogue.sessionHooks.end(reason);
    } catch (error) {
      console.error("[datum-agent] sessionHooks.end", error);
    }
    target.pendingEnded = { reason, undone };
    const phase: AgentSessionDetail["phase"] =
      reason === "idle" ? "idle" : reason === "stopped" ? "stop" : reason === "cancelled" ? "cancel" : "end";
    this.emitSession(target, { phase, sessionId: session.id, reason, undone });
  }

  /**
   * The person pressed Stop: the latch is set and the session detached
   * synchronously, so a write refuses `stopped` at once and an `end_session` landing while the
   * undo replays answers `wasOpen: false` instead of closing the session as `ended` (which would
   * have left the latch set with no stopped banner, hence no Allow again). Then `undoAll()`, then
   * `end("stopped")` with the count.
   *
   * Known window: a write already in flight that finishes, or a write refused, while `undoAll()`
   * is still replaying reads `stopped { undone: 0 }` and no `sessionEnded` yet; the stamp (with
   * the real count) lands on the next result instead. The count is not known before the replay
   * settles, so the stamp cannot be set earlier; the renderer's replay is one paint long.
   */
  private async stop(target: Target, sessionId: string): Promise<void> {
    const session = target.session;
    if (session === undefined || session.id !== sessionId) {
      return;
    }
    const latch = { stoppedAt: this.now(), undone: 0 };
    target.stopped = latch;
    this.closeSession(target, session);
    let undone = 0;
    try {
      undone = await target.catalogue.sessionHooks.undoAll();
    } catch (error) {
      console.error("[datum-agent] undoAll on Stop", error);
    }
    latch.undone = undone;
    this.finishSession(target, session, "stopped", undone);
  }

  private allowAgain(target: Target): void {
    if (target.stopped === undefined) {
      return;
    }
    target.stopped = undefined;
    this.emitSession(target, { phase: "allow-again", sessionId: target.lastSessionId });
  }

  private emitSession(target: Target, partial: Omit<AgentSessionDetail, "target" | "handle">): void {
    const detail: AgentSessionDetail = { ...partial, target: target.kind, handle: target.handle };
    try {
      target.catalogue.emit("datum-agent-session", detail);
    } catch (error) {
      console.error("[datum-agent] emit", error);
    }
    this.emit({ type: "session", detail });
  }
}

/** A registrar of its own (tests, an isolated host): touches no global unless `bind()` is called without a ModelContext. */
export function createAgentRegistrar(options?: AgentRegistrarOptions): AgentRegistrar {
  return new Registrar(options);
}

const REGISTRARS_SLOT = Symbol.for("datum.agent.registrars");

/**
 * The one registrar per document, shared by every bundle on the page: the form and
 * builder chunks each carry their own copy of this code, so the instance lives on
 * `globalThis[Symbol.for("datum.agent.registrars")]`, written only from here and only when a
 * page first asks.
 */
export function agentRegistrarFor(doc: object): AgentRegistrar {
  const slot = globalThis as unknown as Record<symbol, WeakMap<object, AgentRegistrar> | undefined>;
  let registrars = slot[REGISTRARS_SLOT];
  if (registrars === undefined) {
    registrars = new WeakMap();
    slot[REGISTRARS_SLOT] = registrars;
  }
  let registrar = registrars.get(doc);
  if (registrar === undefined) {
    registrar = new Registrar();
    registrars.set(doc, registrar);
  }
  return registrar;
}

export type { AgentOk, AgentRefusal, AgentToolResult };
