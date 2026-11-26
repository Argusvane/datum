/**
 * `open` and `history`.
 *
 * `open` points the person at something without changing the form: a selection (revealed by
 * the canvas), a workspace, a side panel, Try it. It changes nothing a save would write and is
 * not undoable, so it keeps working after the person pressed Stop. What the host hides comes
 * back under `notDone` instead of failing the call; only the person's unsaved edit refuses it,
 * before anything is applied.
 *
 * `history` undoes or redoes the builder's own history, bounded by the steps this assistant made
 * since the person's last own step (`ownSteps`) unless `beyondOwn` says the person asked. Not
 * consequential (only replace_form and remove_components are); the guard is what
 * protects the person's work. A step the controller cannot take stops the loop: `undo-failed`
 * when nothing ran, `stoppedBecause` when some did.
 */
import { panelFeature, workspaceFeature } from "../../builder/web-component/builder-features.js";
import type { BuilderWorkspace } from "../../builder/web-component/default-builder-element.js";
import { ToolRefusal, type AgentTool, type ToolContext } from "../tool-types.js";
import { cutString } from "../result-caps.js";
import { readAgentToolsSetting } from "../../core/schema/agent-tools-setting.js";
import { draftRefusal, historyStepper, promptRefusal, type BuilderToolsShared } from "./context.js";
import type { BuilderToolHost } from "./host.js";
import { builderHandleProperty, triedSplit } from "./reads.js";
import { fitHistory, stepFailed } from "./session.js";
import { AUTHOR_SWITCH_HINT } from "./writes.js";
import type { HistoryResult, OpenResult, ToolFields } from "./types.js";

type Input = Record<string, unknown>;
type Tool = AgentTool<Input, BuilderToolHost>;
type Ctx = ToolContext<BuilderToolHost>;

const WORKSPACES: readonly BuilderWorkspace[] = ["form", "logic", "data", "languages", "journeys", "pdf"];
const PANELS: readonly string[] = ["components", "fields", "outline", "variables", "tests", "settings", "form", "chrome", "view", "none"];

type NotDone = NonNullable<OpenResult["notDone"]>[number];

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function uiTools(shared: BuilderToolsShared): Tool[] {
  const host = shared.host;

  const open: Tool = {
    name: "open",
    title: "Show something to the person",
    description:
      "Points the person at something without changing the form: selects and scrolls to a component (opening the step or tab it is in), switches the workspace (form, logic, data, languages, journeys, pdf), opens a side panel (components, fields (the form's fields beside a journey step, while one is shown), outline, variables, tests, settings, form, chrome, view, or 'none' to close it), turns Try it on or off, or previews the form in another design-system binding. Give one or several. What the host hides comes back under notDone instead of failing the call. To open a journey or a PDF layout in its designer use documents with action 'open'; to fill the tried form use try_it. It edits nothing and is not undoable.",
    inputSchema: {
      type: "object",
      properties: {
        builder: builderHandleProperty(),
        componentId: { type: "string", description: "Select this component and scroll it into view." },
        workspace: { type: "string", enum: [...WORKSPACES], description: "'form' also brings the form back from a designer." },
        panel: { type: "string", enum: [...PANELS], description: "A side panel; the builder moves to a workspace that has it when needed. 'none' closes the side column." },
        tryIt: { type: "boolean", description: "true: show the live form (Try it). false: back to editing." },
        binding: {
          type: "string",
          maxLength: 128,
          description: "Preview the form in this design-system binding: an id from describe_builder bindings, or '' for the default look. Only the builder's preview changes, not the form."
        },
        discardTriedAnswers: {
          type: "boolean",
          description: "Needed with tryIt: false, or a workspace change while Try it is on, only when the person typed some tried answers themselves; they are cleared. Tell the person first."
        }
      }
    },
    annotations: {},
    // UI state only: Stop does not hold it back.
    allowedWhileStopped: true,
    execute(input, ctx: Ctx) {
      const scope = shared.scope(ctx);
      const controller = scope.controller;
      const componentId = stringOf(input.componentId);
      const workspace = stringOf(input.workspace) as BuilderWorkspace | undefined;
      const panel = stringOf(input.panel);
      const tryIt = typeof input.tryIt === "boolean" ? input.tryIt : undefined;
      const binding = stringOf(input.binding);
      const discard = input.discardTriedAnswers === true;
      if (componentId === undefined && workspace === undefined && panel === undefined && tryIt === undefined && binding === undefined) {
        throw new ToolRefusal("bad-input", "open was given nothing to show.", "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.", {
          problems: [{ key: "", expected: "at least one of componentId, workspace, panel, tryIt, binding" }]
        });
      }
      const ui = host.ui;
      if (ui === undefined) {
        throw new ToolRefusal("no-ui", "This builder has no page to show anything on.", "This builder runs without its page; nothing can be shown.", {});
      }
      if (componentId !== undefined && !shared.ids(scope).includes(componentId)) {
        throw shared.unknownComponent(scope, componentId);
      }

      // Pre-checks before anything applies: the prompt, and a draft
      // in the way of each part that would go through the controller's leave guard.
      const prompt = controller.unsavedChangesPrompt();
      if (prompt !== undefined) {
        throw promptRefusal(prompt);
      }
      const selected = controller.selectedComponentId();
      if (componentId !== undefined && selected !== undefined && componentId !== selected && controller.hasPendingChanges(selected)) {
        throw draftRefusal(selected);
      }
      const changesWorkspace = workspace !== undefined && workspace !== ui.workspace();
      const startsTrying = tryIt === true && !ui.trying();
      if (changesWorkspace || startsTrying) {
        if (controller.hasPendingChanges()) {
          throw draftRefusal(selected !== undefined && controller.hasPendingChanges(selected) ? selected : controller.rootId());
        }
        if (changesWorkspace && controller.hasPendingLeaveGuard()) {
          throw draftRefusal("tests-panel");
        }
      }

      // A panel the workspace on the page does not own moves the workspace, behind the same
      // guard: refused before anything is raised, so the person's prompt never goes up for the
      // assistant (a raised dialog takes focus from the cell being typed in).
      if (panel !== undefined && panel !== "none" && ui.panelMovesWorkspace?.(panel) === true && !ui.panelOff(panel) && (controller.hasPendingChanges() || controller.hasPendingLeaveGuard())) {
        throw draftRefusal(controller.hasPendingChanges() ? (selected !== undefined && controller.hasPendingChanges(selected) ? selected : controller.rootId()) : (controller.leaveGuardSubject() ?? "tests-panel"));
      }

      const notDone: NotDone[] = [];
      const note: string[] = [];
      const result: ToolFields<OpenResult> = { shown: { workspace: ui.workspace(), panel: ui.panel() ?? null, trying: ui.trying() } };
      const raceRefusal = (): never => {
        const pending = controller.unsavedChangesPrompt();
        if (pending !== undefined) {
          controller.answerUnsavedChangesPrompt("stay");
        }
        throw draftRefusal(pending?.componentId ?? controller.selectedComponentId() ?? controller.rootId());
      };

      // 1. The component: selected (the canvas reveals a changed selection on its paint) or revealed.
      if (componentId !== undefined) {
        if (selected === componentId) {
          ui.revealComponent(componentId);
        } else if (!controller.requestSelect(componentId)) {
          raceRefusal();
        }
      }

      // 2. The workspace.
      if (changesWorkspace && workspace !== undefined) {
        const feature = workspaceFeature(workspace);
        // Only what the person typed holds the workspace back: the assistant's own answers need no flag.
        const tried = triedSplit(shared);
        if (feature !== undefined && !host.featureOn(feature)) {
          notDone.push({ what: "workspace", reason: "feature-off", message: `The ${workspace} feature is off in this host.` });
        } else if (!ui.availableWorkspaces().includes(workspace)) {
          notDone.push(
            workspace === "journeys" || workspace === "pdf"
              ? { what: "workspace", reason: "not-available", message: `The ${workspace} workspace is not available in this builder.` }
              : { what: "workspace", reason: "hidden", message: `The host hides the ${workspace} workspace.` }
          );
        } else if (tried.byPerson > 0 && !discard) {
          notDone.push({ what: "workspace", reason: "tried-answers", message: `The person typed ${tried.byPerson} answers in Try it; leaving clears them.`, triedPaths: tried.byPerson });
        } else {
          if (tried.total > 0) {
            ui.clearTriedAnswers();
            result.triedAnswersCleared = tried.total;
          }
          if (!ui.setWorkspace(workspace)) {
            if (controller.unsavedChangesPrompt() !== undefined) {
              raceRefusal();
            }
            notDone.push({ what: "workspace", reason: "not-available", message: `The ${workspace} workspace is not available in this builder.` });
          } else if (ui.workspace() !== workspace) {
            // A designer's chunk is still loading: the workspace opens when it lands.
            result.queued = ["workspace"];
          }
        }
      }

      // 3. The side panel.
      if (panel !== undefined) {
        if (panel === "none") {
          ui.setPanel(undefined);
        } else if (ui.panelOff(panel)) {
          const feature = panelFeature(panel);
          notDone.push(
            feature !== undefined && !host.featureOn(feature)
              ? { what: "panel", reason: "feature-off", message: `The ${panel} panel's feature is off in this host.` }
              : { what: "panel", reason: "hidden", message: `The host hides the ${panel} panel.` }
          );
        } else {
          ui.setPanel(panel);
          // A panel the workspace on the page does not own moves the workspace, behind the same
          // guard as a workspace move: the person's prompt is never raised for the assistant.
          if (controller.unsavedChangesPrompt() !== undefined) {
            raceRefusal();
          }
        }
      }

      // 4. Try it.
      if (tryIt === true && !ui.trying()) {
        if (!host.featureOn("try-it") || !ui.canTry()) {
          notDone.push({ what: "tryIt", reason: "not-tryable", message: "Try it is not available here." });
        } else if (!ui.setTrying(true)) {
          // The draft pre-check passed, so a false is the race, or a place without Try it.
          if (controller.unsavedChangesPrompt() !== undefined) {
            raceRefusal();
          }
          notDone.push({ what: "tryIt", reason: "not-tryable", message: "Try it is not available here." });
        }
      } else if (tryIt === false && ui.trying()) {
        const tried = triedSplit(shared);
        if (tried.byPerson > 0 && !discard) {
          notDone.push({ what: "tryIt", reason: "tried-answers", message: `The person typed ${tried.byPerson} answers in Try it; leaving clears them.`, triedPaths: tried.byPerson });
        } else {
          if (tried.total > 0) {
            ui.clearTriedAnswers();
            result.triedAnswersCleared = (result.triedAnswersCleared ?? 0) + tried.total;
          }
          ui.setTrying(false);
        }
      }

      // 5. The preview binding: the shell's own handler, so the binding's assets load and the
      // host hears the change; never `setBindingId` alone, which does neither and ignores an
      // unknown id. Not journaled: a preview choice, like the workspace. A binding change reaches
      // the host, so it is held back while the person's Stop holds the rest.
      let bindingShown: string | undefined;
      if (binding !== undefined) {
        const ids = controller.availableBindings().map((offered) => offered.id);
        if (shared.memory.stopped) {
          notDone.push({ what: "binding", reason: "stopped", message: "The person stopped you; a binding change waits until they allow you again." });
        } else if (!host.featureOn("binding-picker")) {
          notDone.push({ what: "binding", reason: "feature-off", message: "The binding-picker feature is off in this host." });
        } else if (ui.setBinding === undefined || ids.length === 0 || (binding !== "" && !ids.includes(binding))) {
          notDone.push({
            what: "binding",
            reason: "not-available",
            message: `The builder offers no binding ${cutString(binding, 128)}; it offers ${ids.length > 0 ? ids.slice(0, 25).join(", ") : "none"}.`
          });
        } else if (!ui.setBinding(binding === "" ? undefined : binding)) {
          notDone.push({ what: "binding", reason: "not-available", message: `The builder offers no binding ${cutString(binding, 128)}; it offers ${ids.slice(0, 25).join(", ")}.` });
        } else {
          bindingShown = binding;
        }
      }

      const triedNote = notDone.find((entry) => entry.reason === "tried-answers");
      if (triedNote !== undefined) {
        note.push(`Pass discardTriedAnswers: true to leave Try it after telling the person their ${triedNote.triedPaths ?? 0} answers will be cleared.`);
      }
      const now = controller.selectedComponentId();
      result.shown = {
        ...(now !== undefined ? { componentId: now } : {}),
        workspace: ui.workspace(),
        panel: ui.panel() ?? null,
        trying: ui.trying(),
        ...(bindingShown !== undefined ? { binding: bindingShown } : {})
      };
      if (notDone.length > 0) {
        result.notDone = notDone;
      }
      return { ...result, ...(note.length > 0 ? { note } : {}) } as unknown as Record<string, unknown>;
    }
  };

  const history: Tool = {
    name: "history",
    title: "Undo or redo",
    description:
      "Undoes or redoes the builder's most recent steps (every write tool call is one step unless its result said otherwise; the person's own edits are steps too). By default it reaches only the steps this assistant made since the person's last own edit; beyondOwn true is needed to undo the person's work, and only when they asked. Returns how many steps ran and what remains. It does not reach journey and PDF layout list changes, Try it settings or the form's identity; their results carry a reverse call, and end_session { undo: true } and the person's Undo all take back yours.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        builder: builderHandleProperty(),
        expectedRevision: {
          type: "integer",
          minimum: 1,
          description: "Optional. The revision from your last result; the call is refused with code 'stale' if the form changed since, so you can re-read before writing."
        },
        action: { type: "string", enum: ["undo", "redo"], description: "'undo' or 'redo'." },
        steps: { type: "integer", minimum: 1, maximum: 50, description: "How many steps (default 1)." },
        beyondOwn: { type: "boolean", description: "Allow undoing past the assistant's own steps into the person's (default false)." }
      }
    },
    annotations: {},
    execute(input, ctx: Ctx) {
      const scope = shared.scope(ctx);
      const controller = scope.controller;
      const memory = shared.memory;
      const action: "undo" | "redo" = input.action === "redo" ? "redo" : "undo";
      const requested = typeof input.steps === "number" ? Math.floor(input.steps) : 1;
      shared.yieldToPerson(scope, "history");
      const can = (): boolean => (action === "undo" ? controller.canUndo() : controller.canRedo());
      const step = historyStepper(shared.host);
      const nothing = (): Record<string, unknown> => {
        const result: ToolFields<HistoryResult> = { action, requested, done: 0, ...shared.payload(scope, 0) };
        return result as unknown as Record<string, unknown>;
      };
      if (!can()) {
        return nothing();
      }
      const own = action === "undo" ? memory.ownSteps : Math.max(0, memory.ownCeiling - memory.ownSteps);
      if (requested > own && input.beyondOwn !== true) {
        throw new ToolRefusal(
          "beyond-own",
          `Only ${own} of the ${action === "undo" ? "undoable" : "redoable"} steps are this assistant's.`,
          `Resend with steps: ${own}, or beyondOwn: true only if the person asked you to undo their own work.`,
          { ownSteps: own, requested }
        );
      }
      let done = 0;
      let failure: string | undefined;
      // Set when a step moved the author's switch (agentTools): the steps kept, and whether the step was put back.
      let refusedAt: number | undefined;
      let reversed = true;
      memory.collect = new Set();
      let touched: string[] = [];
      try {
        shared.write(scope, () => {
          while (done < requested && can()) {
            const before = memory.mutations;
            // What the history can still undo or redo may reach the root's agentTools
            // (the agent contract); the agent's own steps cannot move it, so this only fires past beyondOwn.
            const prior = {
              setting: readAgentToolsSetting(controller.snapshot().configuration),
              ownSteps: memory.ownSteps,
              ownCeiling: memory.ownCeiling,
              callSteps: memory.callSteps,
              collected: new Set(memory.collect)
            };
            controller.dropError = undefined;
            // The way the person's Undo goes: a Step view takes the step back whole.
            step(controller, action);
            if (stepFailed(controller)) {
              failure = controller.dropError;
              break;
            }
            if (memory.mutations === before) {
              break;
            }
            if (readAgentToolsSetting(controller.snapshot().configuration) !== prior.setting) {
              // Put the one step back at once, inside the same write. The reversal runs through
              // onMutation like any step, so the index, tests and fingerprint end right on their own;
              // the counters and the collected ids go back to what they were before the step.
              controller.dropError = undefined;
              step(controller, action === "undo" ? "redo" : "undo");
              if (stepFailed(controller)) {
                reversed = false;
              } else {
                memory.ownSteps = prior.ownSteps;
                memory.ownCeiling = prior.ownCeiling;
                memory.callSteps = prior.callSteps;
                memory.collect = prior.collected;
              }
              refusedAt = done;
              break;
            }
            done += 1;
          }
        });
      } finally {
        touched = [...(memory.collect ?? [])];
        memory.collect = undefined;
        // A failed step took the steps beyond it along: ownSteps (and the redo ceiling) follow
        // what the history still holds, so the payload's ownSteps is what can still be taken back.
        if (failure !== undefined || !reversed) {
          fitHistory(controller, memory);
        }
      }
      if (refusedAt !== undefined) {
        // The steps before the offending one stayed: show and announce them as a successful call would,
        // so the person sees what changed, then refuse with what was kept.
        if (done > 0) {
          const select = controller.selectedComponentId();
          shared.show(scope, {
            ...(select !== undefined ? { select } : {}),
            ids: touched,
            announce: scope.words.plural(action === "undo" ? "agent.did.undo" : "agent.did.redo", done, { count: done }),
            undoSteps: done,
            redo: action === "undo"
          });
        }
        throw new ToolRefusal(
          "protected-setting",
          "A step changed agentTools, the form author's switch for assistants, so it was put back and history stopped there; the steps before it stayed applied.",
          AUTHOR_SWITCH_HINT,
          { propertyPath: "agentTools", by: "author", applied: done, ...(reversed ? {} : { reversed: false }) }
        );
      }
      if (failure !== undefined && done === 0) {
        throw new ToolRefusal("undo-failed", `The first step could not be ${action === "undo" ? "undone" : "redone"}; nothing ran.`, "Call get_form before continuing; the steps beyond that one are gone.", {
          done: 0,
          message: failure
        });
      }
      const select = controller.selectedComponentId();
      const shown = shared.show(scope, {
        ...(select !== undefined ? { select } : {}),
        ids: touched,
        announce: scope.words.plural(action === "undo" ? "agent.did.undo" : "agent.did.redo", done, { count: done }),
        undoSteps: done,
        redo: action === "undo"
      });
      const result: ToolFields<HistoryResult> = { action, requested, done, ...shared.payload(scope, done, shown) };
      if (failure !== undefined) {
        result.stoppedBecause = failure;
      }
      return result as unknown as Record<string, unknown>;
    }
  };

  return [open, history];
}
