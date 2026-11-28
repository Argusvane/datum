/**
 * One Undo for a journey's Step view over two controllers: the form's and the shown journey's. The mode creates it as the Step view goes
 * up and disposes it as it goes down; outside the Step view each controller keeps its own
 * history. The shell reaches it through `BuilderMode.history`.
 *
 * The rule: **Undo takes back the last change made while the Step view was up, whichever
 * controller holds it** (a form field's property, a step's membership or order); Redo makes it
 * again. Both controllers keep their own histories untouched; this keeps only the order the
 * steps were made in. A step is known by the mark it left on its controller
 * (`BuilderController.undoMark()`, the entry on top of its history, compared by identity). An
 * entry whose controller's top is no longer its mark (the form edited in another workspace
 * since, an agent's own Undo, a history started over by a rebuild) is stale and is dropped,
 * never undone blind. With nothing of its own left, `undo()` answers false and the shell falls
 * back to the journey controller's own Undo.
 *
 * Steps made in one synchronous turn are one entry, undone together: a form rename and the
 * mode's follow-up that rewrites the shown journey's references (journey-builder-mode.ts
 * `followRename`), a journey edit and the form step the mode writes for it (its translations, or
 * the journeys' block a Logic Go to rule write records). Within the entry the steps are kept in
 * the order they were MADE, which is not the order their change events reach this history: the
 * mode's form listener runs first and writes the journey inside the form's change, so the
 * journey's change is heard before the form's. Steps are therefore recorded from each
 * controller's `mutation` event (published as the command runs, before its change), which
 * follows the cause before the follow-up.
 *
 * Taking an entry back or making it again steps the `first` controller's steps (the journey's)
 * before the others' (the form's), in both directions, each controller's own newest first for
 * Undo and oldest first for Redo. The journey's step goes first because the form's step may
 * carry the journeys' block (`blockCommand`): put back first, the block would differ from the
 * journey's tree, and the mode would build the designer again in the middle of the Undo,
 * wiping the journey's history and this one with it. Stepped after the journey, the block
 * already reads as the journey's tree and the form's step writes nothing to it. While an entry
 * holding a form step is stepped, the mode writes no follow-up of its own for the journey's step
 * (`stepping`): the form's step in the same entry is that follow-up. A rename's entry reads
 * consistently in that order as well: Undo takes the journey's reference rewrite back, then the
 * rename (the mode, hearing `renameStepped`, finds the journey already reading the old id and
 * writes nothing); Redo makes the rewrite again, then the rename, which the mode finds already
 * followed. After one Undo the journey reads the form's ids again and after one Redo likewise.
 * The follow-up is kept, not ignored: a
 * follow-up left on the journey's history but out of this one would sit on top of every journey
 * step made before it, and those could no longer be taken back through this history.
 *
 * Drafts are no steps (an inspector box being typed into, nothing applied): an Undo with a
 * form draft open takes back the newest applied step and leaves the draft open, as the form's
 * own Undo does in the Form workspace.
 */
import type { BuilderController } from "../controller/builder-controller.js";
import type { BuilderModeHistory } from "../web-component/builder-modes.js";

/** How the history reads a controller's top undo and redo steps: opaque, compared by identity. */
export interface StepHistoryMarks {
  undo(controller: BuilderController): unknown;
  redo(controller: BuilderController): unknown;
}

/** The controllers' own marks (`undoMark()` / `redoMark()`). */
export const CONTROLLER_MARKS: StepHistoryMarks = {
  undo: (controller) => controller.undoMark(),
  redo: (controller) => controller.redoMark()
};

interface Step {
  controller: BuilderController;
  mark: unknown;
}

export interface StepHistoryOptions {
  /** The controller whose steps an entry takes back and makes again before the others' (the journey's: see above). */
  first?: BuilderController;
}

export interface StepHistory extends BuilderModeHistory {
  stepOn(controller: BuilderController, direction: "undo" | "redo"): boolean;
  /** Whether an entry holding a step on `controller` is being taken back or made again right now. */
  stepping(controller: BuilderController): boolean;
  /** Heard whenever what it can undo or redo may have moved (a step, an Undo or Redo, a change on either controller). Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** The entries, oldest first, by controller, in the order each entry's steps were made (for tests). */
  entries(): BuilderController[][];
  /** Stops hearing the controllers; what it holds is forgotten. */
  dispose(): void;
}

export function createStepHistory(controllers: readonly BuilderController[], marks: StepHistoryMarks = CONTROLLER_MARKS, options: StepHistoryOptions = {}): StepHistory {
  const done: Step[][] = [];
  const undone: Step[][] = [];
  const seen = new Map<BuilderController, unknown>(controllers.map((controller) => [controller, marks.undo(controller)]));
  const listeners = new Set<() => void>();
  let open: Step[] | undefined;
  let stepping = false;
  /** The controllers of the entry being stepped. */
  let acting: ReadonlySet<BuilderController> | undefined;
  let disposed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  /** Records a new step on `controller` when its mark moved since last heard (into the open entry of this turn, else a new one). */
  const record = (controller: BuilderController): void => {
    const mark = marks.undo(controller);
    const before = seen.get(controller);
    seen.set(controller, mark);
    if (mark === undefined || mark === before) {
      return;
    }
    // A new step: the redo line goes, as each controller's own does.
    undone.length = 0;
    if (open) {
      open.push({ controller, mark });
      return;
    }
    const group: Step[] = [{ controller, mark }];
    open = group;
    done.push(group);
    queueMicrotask(() => {
      if (open === group) {
        open = undefined;
      }
    });
  };

  const offs = controllers.flatMap((controller) => [
    // The command has run and sits on top of the history; its change event comes after, and
    // after whatever the listeners before this one wrote on the other controller.
    controller.on("mutation", (event) => {
      if (stepping || disposed) {
        return;
      }
      if (event.action === "execute") {
        record(controller);
      } else {
        // An Undo or a Redo made elsewhere: the entries it moved are stale from now on.
        seen.set(controller, marks.undo(controller));
      }
    }),
    controller.on("change", (event) => {
      if (stepping || disposed) {
        return;
      }
      if (event.historyStep === undefined && event.reason !== "select" && event.reason !== "preview" && event.reason !== "init") {
        // A step whose command published no mutation of its own: recorded late, never lost.
        record(controller);
      } else {
        seen.set(controller, marks.undo(controller));
      }
      if (!event.live && event.reason !== "select" && event.reason !== "preview") {
        notify();
      }
    })
  ]);

  /** Whether each controller's last step in `group` is still on top of its history (read by `read`). */
  const live = (group: readonly Step[], read: (controller: BuilderController) => unknown): boolean => {
    const last = new Map<BuilderController, unknown>();
    for (const step of group) {
      last.set(step.controller, step.mark);
    }
    return [...last].every(([controller, mark]) => read(controller) === mark);
  };

  /** Takes `group` (already out of `from`) back or again, and keeps it on `to` by the marks it leaves. */
  const act = (group: Step[], to: Step[][], direction: "undo" | "redo"): void => {
    // Each controller's own steps newest first for Undo, oldest first for Redo; the `first` controller's before the others'.
    const ordered = direction === "undo" ? [...group].reverse() : group;
    const lead = options.first;
    const steps = lead === undefined ? ordered : [...ordered.filter((step) => step.controller === lead), ...ordered.filter((step) => step.controller !== lead)];
    const after = direction === "undo" ? marks.redo : marks.undo;
    open = undefined;
    stepping = true;
    acting = new Set(group.map((step) => step.controller));
    try {
      for (const step of steps) {
        if (direction === "undo") {
          step.controller.undo();
        } else {
          step.controller.redo();
        }
      }
    } finally {
      stepping = false;
      acting = undefined;
    }
    to.push(group.map((step) => ({ controller: step.controller, mark: after(step.controller) })));
    for (const controller of controllers) {
      seen.set(controller, marks.undo(controller));
    }
    notify();
  };

  const sides = (direction: "undo" | "redo") =>
    direction === "undo" ? { from: done, to: undone, read: marks.undo } : { from: undone, to: done, read: marks.redo };

  /** The newest whole entry, stale ones above it dropped on the way. */
  const take = (direction: "undo" | "redo"): boolean => {
    if (disposed) {
      return false;
    }
    const { from, to, read } = sides(direction);
    while (from.length > 0) {
      const group = from.pop() as Step[];
      if (live(group, read)) {
        act(group, to, direction);
        return true;
      }
    }
    return false;
  };

  /** The newest whole entry holding `controller`'s step on top; entries on the other controller alone are left where they are. */
  const takeOn = (controller: BuilderController, direction: "undo" | "redo"): boolean => {
    if (disposed) {
      return false;
    }
    const { from, to, read } = sides(direction);
    for (let at = from.length - 1; at >= 0; at -= 1) {
      const group = from[at]!;
      if (group.some((step) => step.controller === controller) && live(group, read)) {
        from.splice(at, 1);
        act(group, to, direction);
        return true;
      }
    }
    return false;
  };

  return {
    undo: () => take("undo"),
    redo: () => take("redo"),
    stepOn: (controller, direction) => takeOn(controller, direction),
    stepping: (controller) => acting?.has(controller) === true,
    canUndo: () => !disposed && done.some((group) => live(group, marks.undo)),
    canRedo: () => !disposed && undone.some((group) => live(group, marks.redo)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    entries: () => done.map((group) => group.map((step) => step.controller)),
    dispose: () => {
      disposed = true;
      for (const off of offs) {
        off();
      }
      done.length = 0;
      undone.length = 0;
      listeners.clear();
    }
  };
}
