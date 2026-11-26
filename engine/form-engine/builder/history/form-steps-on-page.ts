/**
 * The form's steps made while a designer is on the page, reached from there: a catalog
 * action (a journey or a PDF layout added, copied, renamed or deleted, the default or the order
 * chosen), a test removed in the Tests panel. Each is a step of the form's history, yet the bar's
 * Undo on a designer steps the document on the page, whose controller never held it: without this
 * an author who deletes a layout lands on the next one with nothing to take it back. The Journeys
 * and PDF modes answer `BuilderMode.history` with it (the Journeys mode after its Step view's own).
 *
 * The rule is the Step view's: Undo takes back the newest thing done inside the designer, on
 * whichever document or view it was made. A step is held with the marks (`undoMark`, `redoMark`)
 * every document controller of the mode has as it stands then, and again each time it is undone
 * or redone. Undo takes it back while it is the form's newest step and no held controller has
 * done anything since; a controller made or built afresh since counts as unmoved while its
 * history is empty. An edit on any document since is newer, so it answers false and the shell
 * undoes the page first; the held step is live again once nothing newer is left, on whichever
 * document the page then shows. Redo is the same the other way, and also asks that no held
 * controller's redo side moved: an edit made since the step was undone, even one undone in turn,
 * leaves it out, as a new step ends any history's Redo. A step the form made elsewhere since (in
 * the Form workspace, say) is newer than any held one, so nothing held is live until that is
 * taken back.
 *
 * A page edit's follow-up on the form (its wording pruned, the block carried:
 * {@link FormStepsOnPage.followUp}) is that edit's own. The page's Undo takes it back off the
 * form's history with the edit rather than writing one more entry over the held step, and the
 * page's Redo makes it again, so once the page is back where it stood the form's newest step is
 * the held one again, and the two histories are stepped in the order the steps were made.
 *
 * A catalog step is held by the designer on the page whichever mode made it (a host removing a
 * journey while a PDF layout is up): every mode over one form meets the others here
 * ({@link peers}). A step is held for as long as the form's history keeps its entry.
 */
import type { BuilderController } from "../controller/builder-controller.js";
import type { BuilderCommand } from "./command-history.js";
import type { BuilderMutationEvent } from "../tree-editor/tree-editor.js";
import { sameData } from "../../core/localization/locale-documents.js";
import type { BuilderModeHistory } from "../web-component/builder-modes.js";

type FormHistory = Pick<BuilderController, "undoMark" | "redoMark" | "undo" | "redo" | "recordStep"> & Partial<Pick<BuilderController, "joinSteps" | "dropRedo">>;

/** Each document controller's undo and redo marks as they stood. */
type Marks = Map<BuilderController, [object | undefined, object | undefined]>;

export interface FormStepsOnPage<T> extends BuilderModeHistory {
  /**
   * Runs a catalog action as one step of the form's history, held by the designer on the page:
   * the block's change over the run, whether or not a translation moved with it. Every step the
   * run records once its first is made joins that first (`BuilderController.joinSteps`): the
   * action's translations rewrite, which the block's change then joins, and what a host's
   * handler of the change does after it, another catalog action included. A host's handler
   * heard before the run's first step (the mode reports its change ahead of its rewrite, and a
   * catalog action without translations makes its step only as the run ends) writes a plain
   * edit of the form's as an entry of its own, under the action's; a catalog action it calls
   * still joins, since every step that action records goes through the join. A run inside
   * another's is a part of that one's step: one action, one entry. The step is recorded and
   * held even when the run throws partway (a host's change listener that fails): what the run
   * changed stays one Undo.
   */
  stepped(run: () => void): void;
  /**
   * Runs what records a step of the form's history only when something beyond the block moves
   * with it (an agent's restore that writes the wording back with the document): whatever it
   * records is one entry, held by the designer on the page as a catalog step is. It records
   * nothing of its own, so a run that writes no step leaves the history as it was.
   */
  joined(run: () => void): void;
  /**
   * The follow-up of an edit on a document's own tree (`page`): `write` writes it on the form
   * when it must (a page's wording pruned, the block carried). The follow-up is the page step's
   * own, taken back and made again with it: on the page's own Undo or Redo (`direction`) of a
   * step whose follow-up is the form's next entry that way, the form's history steps that entry
   * instead of `write` writing another, so the form's history stays as it stood before the edit
   * and a catalog step held under it is live again. A follow-up the form can no longer reach in
   * order (a step of the form's made since) is written afresh by `write`, as before the pair.
   */
  followUp(page: BuilderController, direction: "undo" | "redo" | undefined, write: () => void): void;
  /**
   * A mutation of the form's: its step is held while the designer is on the page, but for the
   * modes' own follow-ups ({@link MODE_FOLLOW_UPS}), which a catalog action shares itself. A held
   * step undone or redone anywhere is held again with the marks as they stand then.
   */
  heard(event: BuilderMutationEvent): void;
  /** `own` (the Step view's history) asked first, then these while one is live; `own` alone, or none, when `own` covers what these would do. */
  after(own: BuilderModeHistory | undefined): BuilderModeHistory | undefined;
}

/**
 * The modes over each form, as what each does with a catalog step one of them made: the one on
 * the page holds it. Keyed by the form's controller, so a form let go takes its modes with it.
 */
const peers = new WeakMap<object, Set<(controller: FormHistory) => void>>();

/**
 * The form's entries a page's Undo took back as its edit's follow-up ({@link
 * FormStepsOnPage.followUp}), while they stay undone that way. One on the form's redo side is the
 * page's to make again with its edit: a new edit on a page of any mode over the form ends the
 * form's redo side, as it ends the page's, so the Form workspace's Redo cannot make the follow-up
 * (prune the wording) over a page that has no edit left to make again with it.
 */
const pairedUndone = new WeakSet<object>();

/**
 * `documents` are the mode's documents, each with its controller; `listeners` hear when what Undo
 * and Redo would do may have moved. `block` reads the block the mode owns (its journeys, its
 * layouts), `command` makes its change from one state to another a step ({@link appliedStep}),
 * and `onPage` says whether the designer is on the page.
 */
export function formStepsOnPage<T>(
  form: () => FormHistory | undefined,
  documents: ReadonlyMap<string, { readonly controller: BuilderController }>,
  listeners: ReadonlySet<() => void>,
  block: () => T,
  command: (before: T, after: T) => BuilderCommand,
  onPage: () => boolean
): FormStepsOnPage<T> {
  const changed = (): void => listeners.forEach((listener) => listener());
  /** Set while a {@link FormStepsOnPage.stepped} run goes: only the outermost records. */
  let running = 0;
  /**
   * The held steps by the form's history entry, each with the marks as of its last move. Weak: an
   * entry the history lets go (a Redo side a new step ended) takes its marks with it, and one the
   * history keeps stays held however many came after it.
   */
  const held = new WeakMap<object, Marks>();
  const top = (controller: FormHistory, direction: "undo" | "redo"): object | undefined => (direction === "undo" ? controller.undoMark() : controller.redoMark());
  const hold = (mark: object | undefined): void => {
    if (mark) {
      held.set(mark, new Map([...documents.values()].map(({ controller }) => [controller, [controller.undoMark(), controller.redoMark()]])));
    }
  };
  const take = (controller: FormHistory): void => {
    if (onPage()) {
      hold(controller.undoMark());
      changed();
    }
  };
  /** This mode among the form's ({@link peers}); the form's takers, this one's included. */
  const meet = (controller: FormHistory): Set<(controller: FormHistory) => void> => {
    let takers = peers.get(controller);
    if (!takers) {
      peers.set(controller, (takers = new Set()));
    }
    return takers.add(take);
  };
  /** The catalog step atop `controller`'s history, held by the designer on the page, whichever mode it is. */
  const share = (controller: FormHistory): void => meet(controller).forEach((taker) => taker(controller));
  const live = (direction: "undo" | "redo"): FormHistory | undefined => {
    const controller = form();
    const marks = controller && held.get(top(controller, direction) as object);
    if (!marks) {
      return undefined;
    }
    for (const { controller: page } of documents.values()) {
      const [undo, redo] = marks.get(page) ?? [];
      const now = page.undoMark();
      const next = page.redoMark();
      if ((now || next) && (now !== undo || (direction === "redo" && next !== redo))) {
        return undefined;
      }
    }
    return controller;
  };
  const step = (direction: "undo" | "redo"): boolean => {
    const controller = live(direction);
    if (!controller) {
      return false;
    }
    const mark = top(controller, direction);
    if (direction === "undo") {
      controller.undo();
    } else {
      controller.redo();
    }
    hold(mark);
    changed();
    return true;
  };
  /**
   * Runs `run` in one join of the form's history (`BuilderController.joinSteps`), `record` after
   * it, and holds the entry the two made, if any, on the designer on the page. `record` and the
   * hold run even when `run` throws, so what it changed is one step all the same.
   */
  const inJoin = (run: () => void, record: (controller: FormHistory) => void): void => {
    const controller = form();
    if (running > 0 || !controller) {
      run();
      return;
    }
    const mark = controller.undoMark?.();
    const whole = (): void => {
      running += 1;
      try {
        run();
      } finally {
        running -= 1;
        try {
          record(controller);
        } finally {
          if (controller.undoMark?.() !== mark) {
            share(controller);
          }
        }
      }
    };
    if (controller.joinSteps) {
      controller.joinSteps(whole);
    } else {
      whole();
    }
  };
  /**
   * Each page step's follow-up on the form, by the page's entry (`undoMark()` once the edit is
   * made): weak both ways, as the marks are the histories' own entries.
   */
  const followUps = new WeakMap<object, object>();
  const steps: FormStepsOnPage<T> = {
    stepped: (run) => {
      const before = block();
      inJoin(run, (controller) => {
        const after = block();
        // Inside the join: the step the run made already (its translations rewrite) takes this in.
        if (!sameData(before, after)) {
          controller.recordStep?.(command(before, after));
        }
      });
    },
    joined: (run) => inJoin(run, () => undefined),
    followUp: (page, direction, write) => {
      const controller = form();
      if (controller && direction !== undefined) {
        // The page's entry the step moved: atop its redo side after an Undo, atop its undo side after a Redo.
        const moved = direction === "undo" ? page.redoMark() : page.undoMark();
        const paired = moved ? followUps.get(moved) : undefined;
        if (paired !== undefined && paired === top(controller, direction)) {
          if (direction === "undo") {
            controller.undo();
            pairedUndone.add(paired);
          } else {
            controller.redo();
            pairedUndone.delete(paired);
          }
          changed();
          return;
        }
      }
      // A form with no history of its own (a host's stand-in) has nothing to pair.
      const mark = controller?.undoMark?.();
      write();
      const made = controller?.undoMark?.();
      const edit = page.undoMark();
      // An Undo's follow-up written afresh belongs to no entry the page keeps on its undo side.
      if (direction !== "undo" && made !== undefined && made !== mark && edit !== undefined) {
        followUps.set(edit, made);
      }
      // A new edit (one whose own follow-up was written has ended the form's redo side already).
      if (direction === undefined && controller?.dropRedo?.((entry) => pairedUndone.has(entry))) {
        changed();
      }
    },
    heard: (event) => {
      const controller = form();
      if (!controller) {
        return;
      }
      meet(controller);
      if (event.action !== "execute") {
        // A held step taken back or made again elsewhere (the Step view's own history): held again as things stand.
        const mark = top(controller, event.action === "undo" ? "redo" : "undo");
        if (mark && held.has(mark)) {
          hold(mark);
        }
      } else if (onPage() && !MODE_FOLLOW_UPS.has(event.commandId)) {
        hold(controller.undoMark());
        changed();
      }
    },
    // `own` alone while it does whatever the two would (a Step view's history keeps its own members then).
    after: (own) =>
      (!steps.canUndo() || own?.canUndo()) && (!steps.canRedo() || own?.canRedo())
        ? own
        : own
          ? {
              canUndo: () => own.canUndo() || steps.canUndo(),
              canRedo: () => own.canRedo() || steps.canRedo(),
              undo: () => own.undo() || steps.undo(),
              redo: () => own.redo() || steps.redo(),
              stepOn: (controller, direction) => own.stepOn?.(controller, direction) ?? false
            }
          : steps,
    canUndo: () => live("undo") !== undefined,
    canRedo: () => live("redo") !== undefined,
    undo: () => step("undo"),
    redo: () => step("redo")
  };
  return steps;
}

/**
 * The commands a mode writes on the form as the follow-up of its own edit (a page's translations
 * pruned, the block carried): taken back with that edit ({@link FormStepsOnPage.followUp}), never
 * held on their own by the designer on the page. A catalog action
 * writes these too, and the mode that made it shares its step with the designer on the page
 * (`stepped`), whichever mode that is.
 */
export const MODE_FOLLOW_UPS: ReadonlySet<string> = new Set(["TRANSLATIONS", "JOURNEYS", "PDF_LAYOUTS"]);

/**
 * A change a mode has already made to a block it owns (the journeys', the PDF layouts'), as a
 * command of the form's history: the change is made when it is recorded, so the first run leaves
 * things as they are; Undo and Redo carry just the step's change onto the block as it stands then
 * (`carry`, so what was done to another document since is kept), and `put` writes the result
 * when it differs from `read()`.
 */
export function appliedStep<T>(id: string, before: T, after: T, read: () => T, carry: (current: T, from: T, to: T) => T, put: (next: T) => void): BuilderCommand {
  const was = structuredClone(before);
  const now = structuredClone(after);
  let first = true;
  const step = (from: T, to: T): void => {
    const next = carry(read(), from, to);
    if (!sameData(next, read())) {
      put(next);
    }
  };
  return {
    id,
    execute: () => {
      if (first) {
        first = false;
      } else {
        step(was, now);
      }
    },
    undo: () => step(now, was)
  };
}
