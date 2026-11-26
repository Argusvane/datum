/**
 * The `save` tool's body, eager in the builder
 * agent's main chunk (it is small, and a consequential act should not wait on a fetch). A
 * factory over the catalogue's `shared`; nothing lives at module scope: the save-in-flight
 * mark is `memory.saving`. It reaches the site only through `ui.saveAvailable` and
 * `ui.save` (the shell's Save without the prompt), never the host's other file actions: the seam exposes
 * Save alone.
 *
 * Guards, in order: the registrar's `stale`, `no-ui`, `no-save`,
 * the person's own act (`unsaved-draft`: an edit or a prompt the Save would walk past), `busy`
 * while a save runs, then `already-saved`. The wait on the site is bounded here (the registrar has
 * no call timeout): after SAVE_BUDGET_MS the call answers `timeout { stillRunning: true }` and the
 * site's promise runs on, `ui.save.busy` staying true until it settles. Not refused by an open session, Try it or a designer:
 * the save is of the whole composed definition, as the person's is. A save is not a write (it
 * moves no history), so it never runs inside `shared.write`; it leaves a barrier in the outside
 * journal, so Undo all after it can say the site keeps the saved version.
 */
import { ToolRefusal, type ToolContext } from "../tool-types.js";
import type { ToolBody } from "../lazy-tool.js";
import { cleanText, cutString } from "../result-caps.js";
import { LABEL_CAP } from "./outline.js";
import type { BuilderSaveOutcome } from "../../builder/web-component/default-builder-element.js";
import { SENTINEL_TOOLS, draftRefusal, languagesDraftRefusal, pendingDraftRefusal, promptRefusal, type BuilderCallScope, type BuilderMemory, type BuilderToolsShared } from "./context.js";
import type { BuilderToolHost } from "./host.js";
import type { SaveResult, ToolFields } from "./types.js";

type Input = Record<string, unknown>;
type Ctx = ToolContext<BuilderToolHost>;

/** The site's words in a `save-failed` refusal are cut here (content, never instructions). */
const FAILED_MESSAGE_CAP = 300;

/** How long the agent waits on the site's Save before answering `timeout`. */
const SAVE_BUDGET_MS = 30_000;

/** Whether this catalogue's own `save` call is waiting on the site now (`describe_builder` reads it for `ui.save.busy`). */
export function agentSaveRunning(memory: BuilderMemory): boolean {
  return memory.saving;
}

/** What a host's `saveAvailable` may add to its label: whether a save (the person's too) is running. Read when given. */
export function saveBusy(memory: BuilderMemory, available: { label: string; busy?: boolean }): boolean {
  return available.busy === true || agentSaveRunning(memory);
}

function noUi(): ToolRefusal {
  return new ToolRefusal("no-ui", "This builder has no page to save from.", "This builder runs without its page; saving is the person's action. Tell the person.", {});
}

function noSave(): ToolRefusal {
  return new ToolRefusal("no-save", "This builder has no Save.", "This builder has no Save; the person keeps the form with Download or their site's own save.", {});
}

function busy(): ToolRefusal {
  return new ToolRefusal("busy", "A save is already running.", `Wait for it to finish; ${SENTINEL_TOOLS.describeBuilder} shows ui.save.busy. Do not call save again until it is false.`, { because: "saving" });
}

/** The shell held the save for something the pre-check did not see (a race): refused as the person's own unanswered edit. */
function heldRefusal(scope: BuilderCallScope, host: BuilderToolHost, outcome: Extract<BuilderSaveOutcome, { status: "held" }>): ToolRefusal {
  const ui = host.ui;
  const active = ui?.activeController?.() ?? scope.controller;
  if (outcome.reason === "prompt") {
    const prompt = active.unsavedChangesPrompt() ?? scope.controller.unsavedChangesPrompt();
    if (prompt !== undefined) {
      return promptRefusal(prompt);
    }
  }
  if (outcome.reason === "leave-guard") {
    const subject = outcome.componentId ?? active.leaveGuardSubject() ?? ui?.leaveGuardSubject?.() ?? "tests-panel";
    return subject === "languages-texts" ? languagesDraftRefusal(ui?.languagesPending?.()) : draftRefusal(subject);
  }
  return pendingDraftRefusal(active) ?? pendingDraftRefusal(scope.controller) ?? draftRefusal(outcome.componentId ?? scope.controller.rootId());
}

/** The `save` body over one catalogue's shared helpers. */
export function saveBody(shared: BuilderToolsShared): ToolBody<Input, BuilderToolHost> {
  const host = shared.host;
  const memory = shared.memory;

  return {
    async run(input: Input, ctx: Ctx) {
      const scope = shared.scope(ctx);
      const ui = host.ui;
      if (ui === undefined) {
        throw noUi();
      }
      const available = ui.saveAvailable?.() as { label: string; busy?: boolean } | undefined;
      if (available === undefined || ui.save === undefined) {
        throw noSave();
      }
      // The person's unapplied edit, or a prompt, is theirs: never answered, never walked past.
      shared.yieldToPerson(scope, "save");
      if (saveBusy(memory, available)) {
        throw busy();
      }
      const last = memory.lastSave;
      if (last !== undefined && last.revision === ctx.revision() && input.again !== true) {
        throw new ToolRefusal("already-saved", "The form has not changed since you saved it.", "Tell the person it is saved. Save again only if they ask, with again: true.", {
          savedAt: last.at,
          revision: last.revision
        });
      }
      // A call that was cancelled while it waited saves nothing.
      if (ctx.signal.aborted) {
        throw new ToolRefusal("cancelled", "The call was cancelled before anything was saved.", "The call was cancelled; nothing was saved. Ask the person before calling save again.", {});
      }
      // check_form's count at save time; a save does not stop for problems.
      const problems = shared.findings(scope).length;
      // The revision the site is handed: an edit the person makes while the site's save is
      // pending is not in it, so it must not be recorded as saved.
      const revision = ctx.revision();
      let outcome: BuilderSaveOutcome;
      memory.saving = true;
      let pending: Promise<BuilderSaveOutcome>;
      try {
        pending = ui.save();
      } catch (error) {
        memory.saving = false;
        throw error;
      }
      // The mark stays until the site's own promise settles, even when the call timed out.
      const settled = pending.then(
        () => undefined,
        () => undefined
      ).then(() => {
        memory.saving = false;
      });
      void settled;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const expiry = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), SAVE_BUDGET_MS);
        });
        const first = await Promise.race([pending, expiry]);
        if (first === "timeout") {
          throw new ToolRefusal("timeout", `The call did not finish within ${SAVE_BUDGET_MS} ms.`, `The site is still saving. Call ${SENTINEL_TOOLS.describeBuilder}; ui.save.busy says when it is done.`, {
            afterMs: SAVE_BUDGET_MS,
            stillRunning: true
          });
        }
        // Answered in time: the mark goes now, not a tick later with the settle chain.
        memory.saving = false;
        outcome = first;
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
      switch (outcome.status) {
        case "no-save":
          throw noSave();
        case "busy":
          throw busy();
        case "held":
          throw heldRefusal(scope, host, outcome);
        case "failed":
          throw new ToolRefusal("save-failed", "The site did not save the form.", "Tell the person the save failed and what the site said; do not retry unless they ask.", {
            message: cleanText(outcome.message, FAILED_MESSAGE_CAP)
          });
        default:
          break;
      }
      // After the site answered: a reseed the save caused (a host that reloads) has already cleared the memory.
      // The barrier's own stamp is the time the result reports, so the two never differ.
      const savedAt = shared.journal.record(scope, { kind: "save", revision }).at;
      shared.show(scope, { ids: [], announce: scope.words.text("agent.did.save"), undoSteps: 0, noButton: true });
      const changes = outcome.localeChanges;
      const result: ToolFields<SaveResult> = {
        saved: true,
        changed: true,
        label: cutString(available.label, LABEL_CAP),
        savedAt,
        undoable: false,
        ...(changes !== undefined && (changes.removed.length > 0 || changes.renamed.length > 0)
          ? { localeChanges: { removed: [...changes.removed], renamed: changes.renamed.map((entry) => ({ from: entry.from, to: entry.to })) } }
          : {}),
        problems,
        dirtyAfter: ui.dirty()
      };
      return {
        ...result,
        ...(problems > 0 ? { warnings: [`problems: the form has ${problems} findings; check_form lists them.`] } : {}),
        note: ["The site may have published this version; tell the person it is saved."],
        next: ["Tell the person it is saved."]
      } as unknown as Record<string, unknown>;
    }
  };
}
