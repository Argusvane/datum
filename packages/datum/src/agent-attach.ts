/**
 * What both agent chunks share ("chunk split per bundle"): the
 * attachment an element keeps while its `agent` token is on, and the one place it reports the
 * browser binding as `datum-agent-tools`. The form's chunk (`agent.ts`) and the builder's
 * (`builder/agent.ts`) each import it, and neither imports the other, so the builder bundle's
 * chunk carries no renderer catalogue and the form bundle's no builder one. Imported only by
 * those two chunk entries (types aside), never by a bundle's entry.
 */

import type { AgentProvenance } from "@argusvane/datum-engine";
import type {
  AgentRegistrar,
  AgentTool,
  AgentToolResult,
  BindingState,
  BuilderRegistration,
  FormRegistration,
  UnregisterReason
} from "@argusvane/datum-engine/agent";

import { emit } from "./support.js";

/** The `datum-agent-tools` detail: whether the browser holds the page's tools, and which. */
export interface DatumAgentToolsDetail {
  registered: boolean;
  reason?: BindingState["reason"];
  /** The tool names the browser holds for the page (the catalogues' and the session pair). */
  tools: string[];
  target: "form" | "builder";
  handle: string;
  /**
   * What the tools do now: `"live"`, they run; `"sealed"`, the
   * form's names are registered and every call answers `agent-off`, except `describe_form`, which
   * says the form is the person's to fill (the page's `agent-access` is
   * `definition` and the form's author did not allow assistants); `"off"`, withdrawn (`never`,
   * the token gone, or the element off the page). A builder says `"live"` while registered.
   */
  access: "live" | "sealed" | "off";
  /** With `"sealed"`: who sealed the form, its author (`agentTools: "off"`) or nobody (`unset`). */
  by?: "author" | "unset";
}

/**
 * What `<datum-form>` keeps for provenance across its registrations, folded in by its attachment at each detach from the going registration's account (whose
 * `involved` is itself set on every agent write and never cleared): `involved` (the documented
 * `agentInvolved`) once it had written, never cleared; `lost` then too (its paths can no longer be
 * traced); `sessions` plus the sessions it opened; `lastWriteAt` its last write's time.
 */
export interface AgentMarks {
  involved: boolean;
  lost: boolean;
  sessions: number;
  lastWriteAt?: number;
  /**
   * Whether any registration of this element was ever live:
   * false at creation, set wherever the registration's `access()` is read as live and never set
   * back. While false the element adds no `agent` key to a submit or a PDF: a form
   * that was only ever sealed could not have been written by an assistant.
   */
  live: boolean;
}

/** What an element keeps while its `agent` token is on: its registration and the page's registrar. */
export interface AgentAttachment<R extends FormRegistration> {
  registration: R;
  registrar: AgentRegistrar;
  /** The registrar's routing wrappers for every tool on the page. */
  tools(): readonly AgentTool[];
  /** The same pipeline the browser path runs; never rejects for a tool refusal. */
  execute(name: string, input?: unknown): Promise<AgentToolResult>;
  /** Settles once the browser binding has been tried and the first `datum-agent-tools` dispatched. */
  bound: Promise<BindingState>;
  /** Says the page's tools again as `datum-agent-tools` (a `features` change that kept the token). */
  announce(): void;
  /** Withdraws the registration (the token went, or the element left the page) and says so as `datum-agent-tools`. */
  detach(reason: UnregisterReason): void;
  /**
   * The registration's provenance account for a submit or a download (`FormRegistration.provenance`), with what earlier registrations left in the marks (their
   * sessions; their untraceable writes make it incomplete); `undefined` for a builder, and once
   * detached (the element then answers from the marks).
   */
  provenance(by: "agent" | "page"): AgentProvenance | undefined;
}

export type FormAgentAttachment = AgentAttachment<FormRegistration>;
export type BuilderAgentAttachment = AgentAttachment<BuilderRegistration>;

function toolsDetail(binding: BindingState, target: "form" | "builder", registration: FormRegistration): DatumAgentToolsDetail {
  const access = registration.access();
  return {
    registered: binding.registered,
    ...(binding.reason !== undefined ? { reason: binding.reason } : {}),
    tools: [...binding.names],
    target,
    handle: registration.handle,
    access: access.state,
    ...(access.state === "sealed" ? { by: access.by } : {})
  };
}

/**
 * `marks` (`<datum-form>`'s): the detach folds the registration's last
 * account in (its `involved` is sticky, set on every agent write), so what the element says after
 * it holds when the registration's own is gone.
 */
export function attach<R extends FormRegistration>(
  element: HTMLElement,
  target: "form" | "builder",
  registrar: AgentRegistrar,
  registration: R,
  cleanup: () => void = () => undefined,
  marks?: AgentMarks
): AgentAttachment<R> {
  let detached = false;
  let settled = false;
  let last: string | undefined;
  let unsubscribe: () => void = () => undefined;
  // `marks.live` is set wherever access() reads live: here at attach, in dispatch
  // and in provenance; the element sets it after each of its own accessChanged() calls, which the
  // attachment never sees (and whose tools-changed it hears only once the bind has settled).
  if (marks !== undefined) {
    marks.live ||= registration.access().state === "live";
  }
  const provenance = (by: "agent" | "page"): AgentProvenance | undefined => {
    if (marks !== undefined && !detached) {
      marks.live ||= registration.access().state === "live";
    }
    const own = detached ? undefined : registration.provenance(by);
    if (own === undefined || marks === undefined) {
      return own;
    }
    // A write an earlier registration made (or one this catalogue lost count of) is the agent's
    // still, and no longer traceable: involved, and not complete.
    const involved = own.involved || marks.involved;
    const lastWriteAt = own.lastWriteAt ?? marks.lastWriteAt;
    return {
      ...own,
      involved,
      complete: own.complete && !marks.lost && involved === own.involved,
      sessions: own.sessions + marks.sessions,
      ...(lastWriteAt !== undefined ? { lastWriteAt } : {})
    };
  };
  const dispatch = (binding: BindingState, always: boolean): void => {
    if (detached) {
      return;
    }
    // Before the dedup: the access read for the detail may be the first live one seen.
    if (marks !== undefined) {
      marks.live ||= registration.access().state === "live";
    }
    const detail = toolsDetail(binding, target, registration);
    const key = JSON.stringify(detail);
    // The registrar's own changes (another target joining or leaving, a late set landing) are
    // said only when they change what this element last said; a features change always says it.
    if (!always && key === last) {
      return;
    }
    last = key;
    emit<DatumAgentToolsDetail>(element, "datum-agent-tools", detail);
  };
  const follow = (binding: BindingState): BindingState => {
    settled = true;
    dispatch(binding, true);
    // After the first report, so it is the bind's outcome; every later tools change on the page
    // follows, until the registration is withdrawn.
    if (!detached) {
      unsubscribe = registrar.subscribe((event) => {
        if (event.type === "tools-changed") {
          dispatch(event.binding, false);
        }
      });
    }
    return binding;
  };
  // The binding never throws; a registrar that still did is reported as a binding error, not left unhandled.
  const bound = registrar.bind().then(follow, (error: unknown) => {
    console.error("[datum-agent] bind", error);
    return follow({ registered: false, reason: "error", names: [] });
  });
  return {
    registration,
    registrar,
    tools: () => registrar.tools(),
    execute: (name, input = {}) => registrar.execute(name, input),
    provenance,
    bound,
    announce() {
      // Before the bind has settled its own report is still to come.
      if (settled) {
        dispatch(registrar.binding(), true);
      }
    },
    detach(reason) {
      if (detached) {
        return;
      }
      // Stopped first, so the registrar's own tools-changed for this withdrawal is not said as if
      // the element were still registered.
      unsubscribe();
      if (marks !== undefined) {
        // The going registration's account, read while it still holds it: its sessions count
        // on, and whatever it wrote can no longer be traced.
        const last = registration.provenance("page");
        marks.sessions += last?.sessions ?? 0;
        marks.involved ||= last?.involved === true;
        marks.lost ||= marks.involved;
        if (last?.lastWriteAt !== undefined) {
          marks.lastWriteAt = last.lastWriteAt;
        }
      }
      detached = true;
      registration.unregister(reason);
      // The withdrawn registration's banner (a summary's Undo all, a stopped Allow again) goes with
      // it: its buttons are bound to a journal the registrar no longer holds.
      cleanup();
      emit<DatumAgentToolsDetail>(element, "datum-agent-tools", { registered: false, tools: [], target, handle: registration.handle, access: "off" });
    }
  };
}
