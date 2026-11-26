/**
 * The builder's session hooks:
 * what `begin_session` / `end_session`, Stop, idle expiry and Allow again do to the builder.
 * The registrar owns the state machine and the pair's words; these hooks lock and unlock the
 * shell (through `ui.setSessionUi`: `inert` and the banner), keep the session's depth (the
 * history steps it can take back), undo to the session's start, and announce each transition
 * in the person's words (AGENT_EN).
 *
 * A session is refused while the person has an unsaved edit or the builder's prompt is up: an inert shell would trap them with an edit they cannot finish. It is never refused
 * for a focused control: `inert` blurs it and the element moves focus to Stop.
 *
 * `begin` also refuses on the active
 * controller's prompt or drafts (a designer document's); every Undo all (Stop's, `end_session
 * { undo: true }`'s and the ended banner's) runs the form steps and the outside journal in one
 * order, newest first, interleaved by each entry's `depthAt`; `end()`'s `undoable` counts both;
 * entries the person changed since are kept and reported as `warnings`; a save inside the
 * session adds the barrier sentence to the result's `note` and to the ended banner.
 */
import type { BuilderController } from "../../builder/controller/builder-controller.js";
import { ToolRefusal, type AgentActionPartial, type SessionEndReason, type SessionHooks } from "../tool-types.js";
import { agentWords } from "./agent-texts-en.js";
import { historyStepper, openDocumentOf, ownHistoryStep, pendingDraftRefusal, type BannerMemory, type BuilderMemory, type HistoryStepper } from "./context.js";
import type { BuilderSessionUi, BuilderToolHost } from "./host.js";
import { journalReverses, type OutsideJournal, type OutsideUndoWhy } from "./outside-journal.js";

/**
 * The builder's hooks: `end()` also hands the registrar the warnings and the note an Undo all
 * over the outside journal leaves (kept entries, entries dropped past the cap, the save barrier).
 * The registrar merges `warnings` and `note` into the `end_session` result, registrar warnings first.
 */
export interface BuilderSessionHooks extends SessionHooks {
  end(reason: SessionEndReason, summary?: string): { changes: Record<string, number>; undoable: number; warnings?: string[]; note?: string[] };
}

/** The journal's live entries of a session an Undo all could still reverse (the save barrier is not one, nor an act the form's history holds: its step is in the depth). */
function journalPending(memory: BuilderMemory, token: number | undefined): number {
  return token === undefined ? 0 : memory.outside.filter((entry) => entry.token === token && journalReverses(entry)).length;
}

/** The barrier sentence for the agent: the save's time as ISO 8601. */
export function saveBarrierNote(at: number): string {
  return `The site keeps the version saved at ${new Date(at).toISOString()}; save again to keep the undo.`;
}

/** An undo the controller could not take ("This step could not be undone ..."), as `dropError` words it. */
const FAILED_STEP = /could not be (undone|redone)/;

/** Whether the step just taken failed (`dropError` is read after each step). */
export function stepFailed(controller: BuilderController): boolean {
  return controller.dropError !== undefined && FAILED_STEP.test(controller.dropError);
}

/**
 * Fits the counts to what the history still holds. A step that fails takes the steps beyond it
 * along (`CommandHistory.step` empties that side), with no mutation event: once nothing can be
 * undone, no agent step, session step or banner step is left to take back (the redo side the
 * agent may still reach keeps its size: the ceiling drops by the own steps lost); once nothing
 * can be redone, the ceiling is where the own steps are. Called after every step the catalogue
 * sees, a failed one included.
 */
export function fitHistory(controller: BuilderController, memory: BuilderMemory): void {
  if (!controller.canUndo()) {
    memory.ownCeiling = Math.max(0, memory.ownCeiling - memory.ownSteps);
    memory.ownSteps = 0;
    if (memory.session !== undefined && memory.session.depth > 0) {
      memory.session.depth = 0;
    }
    if (memory.banner !== undefined && memory.banner.depth > 0) {
      memory.banner.depth = 0;
    }
  }
  if (!controller.canRedo()) {
    memory.ownCeiling = memory.ownSteps;
  }
}

/** The closed state that draws `banner` with the count it reads (`banner.shown`). */
function bannerUi(banner: BannerMemory): BuilderSessionUi {
  return {
    open: false,
    ...(banner.summary !== undefined ? { summary: banner.summary } : {}),
    undoAvailable: banner.shown,
    onUndoAll: banner.onUndoAll,
    onDismiss: banner.onDismiss,
    ...(banner.paused === true ? { paused: true as const } : {})
  };
}

/** Draws the summary or paused banner again when the count it reads moved (an undo or redo since the end). */
export function redrawBanner(host: BuilderToolHost, memory: BuilderMemory): void {
  const banner = memory.banner;
  if (banner === undefined || memory.session !== undefined) {
    return;
  }
  const count = Math.max(0, banner.depth) + journalPending(memory, banner.token);
  if (count === banner.shown) {
    return;
  }
  banner.shown = count;
  host.ui?.setSessionUi(bannerUi(banner));
}

/**
 * Undo all over the form steps and the outside journal in one order: newest first,
 * the form steps undone down to each journal entry's `depthAt` before that entry's inverse runs,
 * then the rest of the form steps down to the session's start. `depth` is the session's (or the
 * ended banner's) form-step depth now, read at replay time, so a step the person or `history`
 * undid meanwhile is simply not there to undo; a form step that fails stops the form side and the
 * journal side runs on. Never throws. Returns the count taken back (form steps and entries), the
 * form steps alone (an action event's `undoSteps`), and the kept entries' warnings.
 */
export function replayAll(
  controller: BuilderController,
  memory: BuilderMemory,
  journal: OutsideJournal,
  token: number | undefined,
  depth: number,
  why: OutsideUndoWhy,
  step: HistoryStepper = ownHistoryStep
): { undone: number; formSteps: number; kept: string[] } {
  let undone = 0;
  let formSteps = 0;
  const kept: string[] = [];
  let now = depth;
  let formDone = false;
  const entries = (token === undefined ? [] : journal.forSession(token)).sort((a, b) => b.seq - a.seq);
  for (const entry of entries) {
    if (entry.kind === "save") {
      continue;
    }
    if (!formDone && now > entry.depthAt) {
      const want = now - entry.depthAt;
      const done = undoSteps(controller, memory, want, step);
      undone += done;
      formSteps += done;
      now -= done;
      if (done < want) {
        formDone = true;
      }
    }
    const result = journal.undo(undefined, [entry], why);
    undone += result.undone;
    kept.push(...result.kept.map((item) => item.warning));
  }
  if (!formDone && now > 0) {
    const done = undoSteps(controller, memory, now, step);
    undone += done;
    formSteps += done;
  }
  return { undone, formSteps, kept };
}

/**
 * Undoes at most `count` steps with the writing guard up, stopping at the first that fails or
 * does nothing (the controller emitted no mutation); never throws. Returns the steps taken.
 */
export function undoSteps(controller: BuilderController, memory: BuilderMemory, count: number, step: HistoryStepper = ownHistoryStep): number {
  let done = 0;
  const outer = memory.writing;
  memory.writing = true;
  try {
    while (done < count && controller.canUndo()) {
      const before = memory.mutations;
      controller.dropError = undefined;
      try {
        // The way the person's Undo goes (`historyStepper`): a Step view takes the step back whole.
        step(controller, "undo");
      } catch (error) {
        console.error("[datum-agent] undo", error);
        break;
      }
      if (stepFailed(controller) || memory.mutations === before) {
        break;
      }
      done += 1;
    }
  } finally {
    // A failed step emptied the undo side: what the session (and `undoable`) can still take back is 0.
    fitHistory(controller, memory);
    if (!outer) {
      memory.writing = false;
      memory.callSteps = 0;
    }
  }
  return done;
}

/** The hooks over one registration's memory and its outside journal. */
export function createSessionHooks(host: BuilderToolHost, memory: BuilderMemory, journal: OutsideJournal): BuilderSessionHooks {
  const words = () => agentWords(host.words());

  /** The person's barrier line for the ended banner: the save's time in the builder's locale. */
  const barrierLine = (at: number): string => {
    const text = words();
    let time: string;
    try {
      time = new Date(at).toLocaleTimeString(text.locale, { hour: "2-digit", minute: "2-digit" });
    } catch {
      time = new Date(at).toISOString();
    }
    return text.text("agent.session.saveBarrier", { time });
  };

  /** The ended banner's line: the agent's summary, then the barrier sentence when the session saved. */
  const bannerSummary = (summary: string | undefined, savedAt: number | undefined): string | undefined => {
    if (savedAt === undefined) {
      return summary;
    }
    const line = barrierLine(savedAt);
    return summary === undefined || summary === "" ? line : `${summary} ${line}`;
  };

  const announce = (text: string): void => {
    host.ui?.announce(text);
  };

  /** The hide convention: the banner goes, with no Undo all. */
  const hide = (): void => {
    host.ui?.setSessionUi({ open: false, undoAvailable: 0 });
  };

  /**
   * Keeps an ended session's banner in memory (what `redrawBanner` follows) and draws it. Its
   * `onDismiss` is the person's Dismiss: that banner's memory goes, so no later
   * undo, redo or history call draws it again and Undo all's count follows nothing hidden.
   */
  const keepBanner = (fields: { depth: number; shown: number; summary?: string; paused?: true; token?: number }): void => {
    const banner: BannerMemory = {
      ...fields,
      onUndoAll: bannerUndoAll,
      onDismiss: () => {
        if (memory.banner === banner) {
          memory.banner = undefined;
        }
      }
    };
    memory.banner = banner;
    host.ui?.setSessionUi(bannerUi(banner));
  };

  /**
   * The banner's Undo all after a session ended (the summary or the paused banner): the person's
   * press, taken back over the steps above the session's start as they stand now (the banner's
   * live depth: the person's own Undo since the end lowered it, so it never reaches their earlier
   * work), dispatched as the tool would be (`tool: "end_session"`, `input: { undo: true }`)
   * through the registrar's link, so the action carries the handle and the revision. The banner
   * is then drawn again, not hidden: its line and Dismiss stay, where the element put
   * the person's focus, and its memory stays at depth 0, so the person's next own edit or a
   * reseed takes it down as it would the summary banner. A press on a banner whose memory went
   * (a reseed, a rebuild) only hides it.
   */
  const bannerUndoAll = (): void => {
    const controller = host.controller();
    const banner = memory.banner;
    if (controller === undefined || banner === undefined || memory.session !== undefined) {
      if (memory.session === undefined) {
        memory.banner = undefined;
        hide();
      }
      return;
    }
    // Gone before the steps run, so the undos below do not draw the banner again.
    memory.banner = undefined;
    const startedAt = Date.now();
    memory.collect = new Set();
    let done = 0;
    let steps = 0;
    try {
      // The form steps and the session's outside-journal entries, interleaved.
      const replayed = replayAll(controller, memory, journal, banner.token, banner.depth, "banner", historyStepper(host));
      done = replayed.undone;
      steps = replayed.formSteps;
    } finally {
      const ids = [...(memory.collect ?? [])];
      memory.collect = undefined;
      keepBanner({
        depth: 0,
        // An entry whose designer was not on the page stays for the next press.
        shown: journalPending(memory, banner.token),
        ...(banner.summary !== undefined ? { summary: banner.summary } : {}),
        ...(banner.paused === true ? { paused: true as const } : {}),
        ...(banner.token !== undefined ? { token: banner.token } : {})
      });
      announce(words().plural("agent.did.undo", done, { count: done }));
      emitAction({
        tool: "end_session",
        input: { undo: true },
        outcome: { ok: true },
        durationMs: Math.max(0, Date.now() - startedAt),
        componentIds: ids,
        undoSteps: steps,
        changed: done > 0
      });
    }
  };

  const emitAction = (partial: AgentActionPartial): void => {
    const link = memory.link;
    if (link !== undefined) {
      link.emitAction(partial);
      return;
    }
    // A catalogue used without a registrar: the fields the catalogue knows.
    host.emit("datum-agent-action", {
      tool: partial.tool,
      target: "builder",
      readOnly: false,
      input: partial.input,
      outcome: partial.outcome,
      durationMs: partial.durationMs ?? 0,
      changed: partial.changed ?? false,
      trigger: "agent",
      ...(partial.componentIds !== undefined ? { componentIds: partial.componentIds } : {}),
      ...(partial.undoSteps !== undefined ? { undoSteps: partial.undoSteps } : {})
    });
  };

  return {
    begin(purpose, onStop) {
      const controller = host.controller();
      if (controller === undefined) {
        return { refused: new ToolRefusal("builder-not-ready", "The builder is still loading.", "Wait a moment and call describe_builder again.", { state: "loading" }) };
      }
      // The active controller too, a designer
      // document's draft included, which the form controller does not see.
      const active = host.ui?.activeController?.() ?? controller;
      const refused = pendingDraftRefusal(controller) ?? (active !== controller ? pendingDraftRefusal(active, openDocumentOf(host, active)) : undefined);
      if (refused !== undefined) {
        return { refused };
      }
      memory.sessionSeq += 1;
      memory.session = { depth: 0, steps: 0, added: new Set(), changed: new Set(), removed: new Set(), tests: new Set(), token: memory.sessionSeq, dropped: 0 };
      memory.lastKept = [];
      memory.stopped = false;
      memory.banner = undefined;
      // Kept for `purposeChanged`, which draws the banner again with the same Stop.
      memory.onStop = onStop;
      const ui = host.ui;
      if (ui !== undefined) {
        ui.setSessionUi({ open: true, purpose, onStop });
        announce(words().text("agent.session.started", { purpose }));
      }
      return { undoBoundary: 0, locked: ui !== undefined };
    },

    end(reason: SessionEndReason, summary?: string) {
      const session = memory.session;
      const controller = host.controller();
      if (controller !== undefined) {
        fitHistory(controller, memory);
      }
      // Live, and below 0 when the history stands under the session's start; `undoable` is
      // what an Undo all could take back now (0 once a failed step emptied the undo side), the
      // session's outside-journal entries still live included.
      const depth = session?.depth ?? 0;
      const token = session?.token;
      const undoable = (controller !== undefined && controller.canUndo() ? Math.max(0, depth) : 0) + journalPending(memory, token);
      const barrier = token === undefined ? undefined : journal.barrier(journal.forSession(token));
      const warnings = [...memory.lastKept];
      if (session !== undefined && session.dropped > 0) {
        warnings.push(`journal-full: the ${session.dropped} oldest changes outside the undo history were dropped and cannot be undone`);
      }
      memory.lastKept = [];
      const added = session?.added ?? new Set<string>();
      const count = (ids: Set<string> | undefined): number => [...(ids ?? [])].filter((id) => !added.has(id)).length;
      const changes = {
        steps: session?.steps ?? 0,
        componentsAdded: added.size,
        componentsChanged: count(session?.changed),
        componentsRemoved: count(session?.removed),
        testsWritten: session?.tests.size ?? 0
      };
      memory.session = undefined;
      memory.onStop = undefined;
      const ui = host.ui;
      const text = words();
      const line = bannerSummary(summary, barrier?.at);
      if (reason === "ended") {
        keepBanner({ depth, shown: undoable, ...(line !== undefined ? { summary: line } : {}), ...(token !== undefined ? { token } : {}) });
        if (ui !== undefined) {
          announce(text.text("agent.session.ended", { summary: summary ?? "" }));
        }
      } else if (reason === "stopped") {
        memory.stopped = true;
        memory.banner = undefined;
        const undone = memory.lastUndoAll;
        ui?.setSessionUi({
          stopped: true,
          undone,
          onAllowAgain: () => {
            memory.stopped = false;
            memory.allowAgain?.();
          }
        });
        if (ui !== undefined) {
          announce(text.plural("agent.session.stopped", undone, { count: undone }));
        }
      } else if (reason === "idle") {
        keepBanner({ depth, shown: undoable, paused: true, ...(line !== undefined ? { summary: line } : {}), ...(token !== undefined ? { token } : {}) });
        if (ui !== undefined) {
          announce(text.text("agent.session.paused"));
        }
      } else {
        // Cancelled, disconnected, features changed, rebuilt: the banner goes (the hide convention).
        memory.banner = undefined;
        hide();
      }
      if (reason !== "stopped") {
        memory.lastUndoAll = 0;
      }
      return {
        changes,
        undoable,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(barrier !== undefined ? { note: [saveBarrierNote(barrier.at)] } : {})
      };
    },

    undoAll() {
      // Stop and end_session { undo: true } run before `end`, so the session's depth is still
      // here. The builder's undo never throws: it stops at the first step that fails and
      // answers how far it got; the failed step took the ones before it along, so
      // `end` then reports `undoable` 0 (undoSteps fits the depth to the history). The
      // session's outside-journal entries are undone in the same order, newest first.
      const controller = host.controller();
      const session = memory.session;
      if (controller === undefined) {
        memory.lastUndoAll = 0;
        return 0;
      }
      const { undone, kept } = replayAll(controller, memory, journal, session?.token, session?.depth ?? 0, "undo-all", historyStepper(host));
      memory.lastUndoAll = undone;
      memory.lastKept = kept;
      return undone;
    },

    onAllowAgain(listener) {
      memory.allowAgain = listener;
    },

    purposeChanged(purpose) {
      // A second begin_session changed the purpose: the banner is drawn again with
      // it and the Stop it already had. Nothing is announced: `begin` announced the start once.
      if (memory.session === undefined || memory.onStop === undefined) {
        return;
      }
      host.ui?.setSessionUi({ open: true, purpose, onStop: memory.onStop, resumed: true });
    }
  };
}
