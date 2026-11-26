/**
 * Shared types of the agent-tools layer: the tool shape both catalogues hand the
 * page registrar, the context a tool runs in, the result envelope every call returns, the
 * session hooks a catalogue supplies, and the closed table of registrar-level refusal codes.
 *
 * This module is reached only through the `@argusvane/datum-engine/agent` subpath (never the engine
 * root) and does nothing at import time: no registrar, no `document`, no `navigator`.
 */

import type { AgentProvenance } from "../core/events/hooks.js";

/** The three annotation hints Chrome keeps; every other key is dropped by the browser. */
export interface AgentToolAnnotations {
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
  untrustedContentHint?: boolean;
}

/** A plain JSON object: no functions, Dates, BigInts, `undefined` members, circular references or file bytes. `null` stands for "unanswered" in echoes. */
export type ToolData = Record<string, unknown>;

/** One tool as a catalogue defines it; the registrar wraps `execute` into the pipeline. */
export interface AgentTool<I = Record<string, unknown>, H = unknown> {
  /** `^[a-z][a-z0-9_]{0,39}$` (snake_case, at most 40; the browser allows 128 of `[A-Za-z0-9_.-]`). Unique per page. */
  name: string;
  title: string;
  /** Static English, never built from author text. Non-empty: Chrome rejects "". */
  description: string;
  /**
   * JSON Schema 2020-12 with `type: "object"`, using only: type, properties, required, enum,
   * items, description, minimum, maximum, maxLength. No oneOf, $ref, additionalProperties.
   * Every property has a description. Chrome stores it verbatim.
   */
  inputSchema: Record<string, unknown>;
  annotations: AgentToolAnnotations;
  /** Whole-input byte cap override: the builder's add_components / replace_form set 512 KB. Default 256 KB. */
  inputBytes?: number;
  /**
   * The Stop latch refuses every write tool with `stopped`; a tool that must keep
   * working while the latch is set (the renderer's undo_agent_changes) says so here. Default off.
   */
  allowedWhileStopped?: true;
  /**
   * A call whose `input[key]` (after the schema check) is one of
   * `values` is a read: it runs at once instead of queueing behind a write, the Stop latch does
   * not refuse it, it gets no `alsoChanged`, and its `datum-agent-action` says `readOnly: true`.
   * It still passes shape, target, readiness, the schema check, the input cap and `cancelled`,
   * and, like a `readOnlyHint` tool, is never judged `stale`. A folded tool whose actions differ
   * in kind (`documents { action: 'list' }` beside its writes) keeps its annotations, which are
   * static per tool, and names its read actions here.
   */
  readActions?: { key: string; values: readonly string[] };
  /**
   * This tool's body runs on a sealed form
   * and answers the minimal result itself; every other tool is refused with `agent-off` by the
   * registrar's access gate before its body. Only `describe_form` sets it.
   */
  answersWhenOff?: true;
  /** Returns the tool's own fields; the registrar wraps them. Throws only ToolRefusal; anything else becomes `internal`. */
  execute(input: I, ctx: ToolContext<H>): Promise<ToolData> | ToolData;
  /**
   * Let go of what the tool holds outside
   * a call (a subscription on the page). The registrar calls it once for every tool of the target
   * on a rebuild (`runtimeReplaced`, before the catalogue resets) and on unregister; a throw is
   * logged and the other tools are still disposed. The tool stays usable: the next call may pick
   * up again what it let go.
   */
  dispose?(): void;
}

/** What a tool body sees besides its input. */
export interface ToolContext<H = unknown> {
  /** The catalogue's host seam (FormAgentHost on the renderer, BuilderToolHost on the builder). */
  host: H;
  /** The executeTool({ signal }) signal. The registration signal never fires it. */
  signal: AbortSignal;
  /** The target's current revision. */
  revision(): number;
  /** The open session on this target, if any. */
  session: SessionState | undefined;
  /** Opaque per-target scratch the catalogue owns (journal, memo, last-writer map); created once per target, dropped on unregister. */
  state: Map<string, unknown>;
}

/**
 * The one exception a tool body may throw: the registrar turns it into an `AgentRefusal` with
 * the same code, message, hint and details. Any other throw becomes `internal`.
 */
export class ToolRefusal extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ToolRefusal";
  }
}

/** The reasons a session ends other than through `end_session` itself. */
export type SessionEndedReason = "idle" | "stopped" | "cancelled" | "disconnected" | "features-changed" | "rebuilt";

/** The successful half of the envelope. */
export interface AgentOk {
  ok: true;
  /** The tool's name, so a transcript reads without its calls. */
  tool: string;
  /** The target handle this result is about: `form` on renderer results, `builder` on builder results. Absent only on the targets listing. */
  form?: string;
  builder?: string;
  /** The target's change counter after the call. The targets listing is typed without it (`Omit<AgentOk, "revision">`). */
  revision: number;
  /** At most two static sentences naming the tool to call next. */
  next?: string[];
  /** State-dependent sentences in static wording the agent should read. */
  note?: string[];
  /** Non-fatal notes: "ignored unknown argument: foo", "options for province still loading". */
  warnings?: string[];
  /** Write tools only: value paths (renderer) or component ids (builder) changed by anyone but the agent since the agent's previous call on this target (cap 20). */
  alsoChanged?: string[];
  /** Set once, on the first result after a session ended any way but end_session. */
  sessionEnded?: { reason: SessionEndedReason; undone: number };
  /** Set when a list in the result was cut. */
  truncated?: true;
  nextOffset?: number;
}

/** The refusal half of the envelope. */
export interface AgentRefusal {
  ok: false;
  tool: string;
  /** A code from `SHARED_REFUSAL_CODES` or one of the catalogue's own. */
  code: string;
  /** One sentence, what did not happen; static or templated with ids, paths, counts. */
  message: string;
  /** One sentence, what to do next; names a tool when one applies. */
  hint: string;
  /** Stamped by the registrar from the per-code table (`RETRYABLE_CODES`): true only when waiting and calling again can succeed. */
  retryable: boolean;
  /** Code-specific, documented with the code; never free text from the form. */
  details?: Record<string, unknown>;
  /** Absent for form-required / form-unknown and when no target applies. */
  form?: string;
  builder?: string;
  /** Absent when the target is not ready. */
  revision?: number;
  warnings?: string[];
  sessionEnded?: AgentOk["sessionEnded"];
  /** Set when the refusal itself was cut to stay under the output cap: code, hint, retryable, handle and revision always stay. */
  truncated?: true;
}

export type AgentToolResult<T extends ToolData = ToolData> = (AgentOk & T) | AgentRefusal;

/** A form as the targets listing and `form-required` describe it. */
export interface FormSummary {
  /** The handle, never the definition's id. */
  form: string;
  /** The definition's id, reported and never used as the handle. */
  formId?: string;
  title: string;
  fields: number;
  pages: number;
  locale: string;
  session: boolean;
  /**
   * Present while the target is not ready: `{ form, title: "", fields: 0, pages: 0, locale: "",
   * session, state }`, `"loading"` while the element's runtime is still building, `"failed"` or
   * `"removed"` as the registrar lists such a form. `"off"`: a ready form whose access is sealed, listed with its title kept,
   * the counts zeroed and `by` saying who sealed it, so the model knows which message to relay.
   */
  state?: "loading" | "failed" | "removed" | "off";
  /** With `state: "off"`: who sealed the form (the definition's author, or nobody allowed it). */
  by?: "author" | "unset";
}

/**
 * The access a form's registration answers with: live, or
 * sealed with who sealed it. Sealed is not a readiness state: a sealed form is built and
 * answers `describe_form`; every other call is refused with `agent-off { by }`.
 */
export type AgentAccessState = { state: "live" } | { state: "sealed"; by: "author" | "unset" };

/** A builder as the targets listing and `builder-required` describe it. */
export interface BuilderSummary {
  builder: string;
  title: string;
  dirty: boolean;
  workspace: string;
}

/**
 * The closed table of registrar-level refusal codes. A catalogue's own codes extend
 * it and may not redefine a name listed here.
 *
 * `busy` (retryable): `details: { because, startedAt? }`, `because` a plain string. The registrar
 * answers `"previous-call"` (a write queued over 10 s behind the previous write on its target);
 * each catalogue answers its own at the head of the write chain from an in-flight flag (an act
 * the person started, or one still running after the agent's call timed out): the renderer's
 * `"submission"` and `"page-check"`, `"pdf"` and `"draft"`; the builder's
 * `"run-tests"`, `"try-submit"`, `"saving"` and `"pdf-preview"`.
 *
 * `chunk-unavailable` (retryable): a lazy part did not load (`state: "failed"`) or is still
 * loading (`state: "loading"`). `details: { what: string; state?: "loading" | "failed" }`, `what`
 * one of the renderer's `"pdf"` or the builder's `"tests"`, `"try-it"`, `"journey-preview"`,
 * `"journeys"`, `"journey-designer"`, `"pdf"`, `"pdf-designer"`, `"pdf-executor"`,
 * `"pdf-template"`, `"data-model"`, `"agent-try"`, `"agent-languages"`, `"agent-documents"`.
 * `lazyTool` (lazy-tool.ts) answers it for a tool body whose chunk failed to load.
 *
 * `agent-off` (not retryable): the form is registered sealed, so
 * the call did not run. `details: { by: "author" | "unset" }`: its author turned assistants off,
 * or the page lets assistants fill only forms whose author allowed it and this one's has not.
 */
export const SHARED_REFUSAL_CODES = [
  "bad-input",
  "too-large",
  "form-required",
  "builder-required",
  "form-unknown",
  "builder-unknown",
  "target-required",
  "form-not-ready",
  "builder-not-ready",
  "busy",
  "stale",
  "stopped",
  "cancelled",
  "timeout",
  "feature-off",
  "agent-off",
  "internal",
  "chunk-unavailable"
] as const;

export type SharedRefusalCode = (typeof SHARED_REFUSAL_CODES)[number];

/**
 * The codes the registrar stamps `retryable: true` on unconditionally: waiting and
 * calling again can succeed. `form-not-ready` / `builder-not-ready` are retryable only with
 * `details.state === "loading"` (`NOT_READY_CODES`); every other shared or catalogue code is
 * `false`. The registrar owns the stamping; the catalogues never set the field.
 */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set(["busy", "cancelled", "timeout", "chunk-unavailable"]);

/** The two readiness codes, retryable only while their `details.state` is `"loading"`. */
export const NOT_READY_CODES: ReadonlySet<string> = new Set(["form-not-ready", "builder-not-ready"]);

/** Every way a session can end, `end_session` included. */
export type SessionEndReason = "ended" | SessionEndedReason;

/** The registrar's view of an open session. */
export interface SessionState {
  id: string;
  target: "form" | "builder";
  handle: string;
  purpose: string;
  startedAt: number;
  lastCallAt: number;
  revisionAtBegin: number;
  undoBoundary: number;
  /**
   * The registrar's idle timeout for this session: a registrar created
   * with another `idleTimeoutMs` is visible to the catalogue here, so `describe_*` counts down
   * from the real figure rather than the default constant.
   */
  idleTimeoutMs: number;
}

/**
 * What a catalogue supplies so the registrar's session state machine can lock and unlock its
 * target. The registrar owns the machine; the hooks only touch the UI and the undo
 * boundary.
 */
export interface SessionHooks {
  /**
   * Lock the UI for the agent (renderer: settleInput, inert, banner + Stop; builder: ui.lock)
   * and return the undo boundary. May refuse by returning `{ refused }` or throwing ToolRefusal:
   * the registrar answers that refusal, arms nothing and emits no `begin` event. `locked` is
   * false when the target has no UI to lock (a bare controller, a runtimeAgentHost).
   */
  begin(
    purpose: string,
    onStop: () => void
  ): { undoBoundary: number; locked: boolean; pausedTyping?: boolean } | { refused: ToolRefusal };
  /**
   * Lift the lock; show the summary banner (Undo all + Dismiss) when `summary` is given; announce.
   * `warnings` and `note` reach `end_session`'s own result: the
   * builder's kept journal entries and save barrier, the renderer's draft restored mid-session.
   * The registrar puts its own warnings first and reads both only for `end_session`; the other
   * ends have no result to carry them.
   */
  end(reason: SessionEndReason, summary?: string): { changes: Record<string, number>; undoable: number; warnings?: string[]; note?: string[] };
  /** Restore everything since the boundary. Returns the count undone. */
  undoAll(): Promise<number> | number;
  /** The person pressed "Allow again" on the stopped banner (the catalogue's UI calls back). */
  onAllowAgain(listener: () => void): void;
  /**
   * `begin_session` while a session is open updated its purpose. The
   * registrar calls it before the resumed `begin` event, inside a try/catch (a throw never fails
   * the call). The catalogue re-renders its banner with the new purpose and announces nothing:
   * the start was announced once, by `begin`.
   */
  purposeChanged?(purpose: string): void;
}

/** The readiness a catalogue reports; drives `*-not-ready`. */
export type CatalogueReadiness =
  | { state: "ready" }
  | { state: "loading" | "failed" | "removed"; message?: string };

/** The datum-agent-* events a catalogue dispatches on its target's element. */
export type AgentEventType = "datum-agent-action" | "datum-agent-session" | "datum-agent-tools";

/**
 * What a catalogue factory hands the registrar for one target. The registrar never imports a catalogue module; each bundle
 * passes its own factory from inside its chunk.
 */
export interface AgentCatalogue<H = unknown> {
  host: H;
  tools: readonly AgentTool<Record<string, unknown>, H>[];
  sessionHooks: SessionHooks;
  /** FormSummary / BuilderSummary without the handle (the registrar adds `form` / `builder`). */
  summary(): Record<string, unknown>;
  /** Drives *-not-ready: "ready", or the state and message the refusal carries. */
  readiness(): CatalogueReadiness;
  /**
   * Subscribe to the changes that bump the revision; `by` is "agent"
   * while the catalogue's writing flag is up. Returns the unsubscribe.
   */
  watch(report: (change: { paths: string[]; by: "agent" | "other" }) => void): () => void;
  /** Rebuild on the same element: drop per-target state and re-subscribe. */
  reset(): void;
  /** Dispatch a datum-agent-* event on the target's element (node hosts record it). */
  emit(type: AgentEventType, detail: unknown): void;
  /**
   * The `stale` refusal's details for this target: when present its
   * result replaces the registrar's default `{ revision, changedPaths }` (the builder answers
   * `{ revision, outline }`); a throw falls back to the default.
   */
  staleDetails?(revision: number, expected: number): Record<string, unknown>;
  /** Called once by the registrar right after the handle is allocated. */
  link?(link: CatalogueLink): void;
  /**
   * The page's account of the agent-written answers for a submission
   * or a download started by `by` (the agent's own tool, or anything else on the page). Renderer
   * catalogues only; `FormRegistration.provenance(by)` forwards it to the element, which offers
   * it to the submit hooks and in the `datum-submit` / `datum-pdf` details.
   */
  provenance?(by: "agent" | "page"): AgentProvenance | undefined;
  /**
   * Whether this target's tools run (`live`) or answer
   * `agent-off` (`sealed`). Absent: always live (the builder catalogue). Read by the registrar at
   * every call and listing, after readiness; never a readiness state.
   */
  access?(): AgentAccessState;
}

export type AgentCatalogueFactory<H> = (host: H) => AgentCatalogue<H>;

/**
 * A `datum-agent-action` the catalogue causes outside any call (submit's `started` event, a
 * banner's Undo all): what the catalogue knows. The registrar fills the rest through
 * `CatalogueLink.emitAction`: target, handle, revision, `trigger: "agent"` and the
 * open session's id; `readOnly`, `durationMs` and `changed` default to false, 0 and false.
 */
export interface AgentActionPartial {
  tool: string;
  input: unknown;
  outcome: { ok: boolean; code?: string };
  readOnly?: boolean;
  durationMs?: number;
  changed?: boolean;
  /** Renderer targets: the value paths the action wrote. */
  paths?: string[];
  /** Builder targets: the component ids the action changed. */
  componentIds?: string[];
  /** Builder targets: the history entries the action pushed. */
  undoSteps?: number;
}

/** What the registrar hands a catalogue once its handle is known. */
export interface CatalogueLink {
  /** The registrar's handle for this target, fixed for the registration's life. */
  handle: string;
  /** The target's current revision. */
  revision(): number;
  /** The open session's id on this target, if any. */
  sessionId(): string | undefined;
  /**
   * Dispatches `datum-agent-action` through `catalogue.emit` and the registrar's `subscribe()`
   * stream, the way the registrar reports a call; it never touches the change ring, the
   * `alsoChanged` mark or the session's idle timer.
   */
  emitAction(partial: AgentActionPartial): void;
}

/**
 * The browser's ModelContext as the binding and the test double see it. Defined
 * here, beside the tool types, so `testing/fake-model-context.ts` and
 * `agent/model-context-binding.ts` share one shape; the binding is the only module that reads
 * it off `document`.
 */
export interface ModelContextLike extends EventTarget {
  registerTool(tool: object, options?: { signal?: AbortSignal; exposedTo?: string[] }): Promise<void>;
  getTools(options?: { fromOrigins?: string[] }): Promise<RegisteredToolEntry[]>;
  executeTool(entry: RegisteredToolEntry, input?: unknown, options?: { signal?: AbortSignal }): Promise<string | null>;
}

/** What `getTools()` hands back per tool: a fresh plain dictionary, never the registered object. */
export interface RegisteredToolEntry {
  name: string;
  title: string;
  description: string;
  inputSchema?: unknown;
  annotations: Required<AgentToolAnnotations>;
  origin: string;
  window?: unknown;
}

/**
 * The contract version of each catalogue: it moves when a tool is removed or renamed,
 * a required input is added, or a result field changes meaning. Adding a tool, an optional
 * input, a result field or a code is not a bump.
 */
export const AGENT_TOOLSET_VERSION = { form: "datum-form/1", builder: "datum-builder/1" } as const;
