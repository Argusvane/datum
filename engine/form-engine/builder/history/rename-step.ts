import type { BuilderCommand } from "./command-history.js";

/**
 * A component's rename and everything it rewrites, as one entry of the form's history: the id itself, then each follow-up — the rules that read it, its
 * translations, the scenarios that name it, a PDF layout's conditions and sources. Undo takes
 * them all back, last first; Redo makes them again, in order.
 *
 * A follow-up is a command run while the step is {@link join}ing: the history hands it here
 * ({@link absorb}) instead of making it an entry of its own. One that lands a moment after the
 * rename (the scenarios, rewritten by a chunk that loads on demand) joins the same way, as long
 * as the step is still the history's last entry.
 */
export class RenameStep implements BuilderCommand {
  private readonly commands: BuilderCommand[];
  private joining = 0;
  private ran = false;
  private undone = false;
  /**
   * For a rename saved with edits that moved data further than the id does (a new data key with
   * the new id), the first value path those edits moved: a late follow-up of the move names the
   * step by it, as one of a `MOVE_DATA` step names it by {@link rename}.
   */
  public moved: { readonly from: string; readonly to: string } | undefined;
  /**
   * Every value path the step moved further than its ids do (a data key, a container's key), from
   * where the answer was before the step to where it is after; announced again when a Redo makes
   * the step again, for a follow-up that was dropped while it was undone.
   */
  public dataMoved: readonly { readonly from: string; readonly to: string }[] | undefined;

  constructor(
    /**
     * The ids, as the step's Redo (and first run) moves them; for a step that moved where data is
     * stored (`MOVE_DATA`: a data key, a container's key), the first value path it moved.
     */
    public rename: { readonly from: string; readonly to: string },
    commands: readonly BuilderCommand[],
    /** Told when an Undo or a Redo (never the first run) has taken the step back or made it again, after every part has. */
    private readonly onStep?: (by: "undo" | "redo") => void,
    public readonly id: "RENAME_COMPONENT" | "MOVE_DATA" = "RENAME_COMPONENT"
  ) {
    this.commands = [...commands];
  }

  public execute(): void {
    this.run();
    this.undone = false;
    if (this.ran) {
      this.onStep?.("redo");
    }
    this.ran = true;
  }

  private run(): void {
    const done: BuilderCommand[] = [];
    try {
      for (const command of this.commands) {
        command.execute();
        done.push(command);
      }
    } catch (error) {
      for (const command of done.reverse()) {
        command.undo();
      }
      throw error;
    }
  }

  public undo(): void {
    const undone: BuilderCommand[] = [];
    try {
      for (const command of [...this.commands].reverse()) {
        command.undo();
        undone.push(command);
      }
    } catch (error) {
      for (const command of undone.reverse()) {
        command.execute();
      }
      throw error;
    }
    this.undone = true;
    this.onStep?.("undo");
  }

  /** Whether the step's last move through the history was an Undo: what it did is not in the form now. */
  public isUndone(): boolean {
    return this.undone;
  }

  /** Takes `command` as a part while {@link join} runs; refuses it otherwise. */
  public absorb(command: BuilderCommand): boolean {
    if (this.joining === 0) {
      return false;
    }
    this.commands.push(command);
    return true;
  }

  /** Whether a follow-up is being taken in now. */
  public isJoining(): boolean {
    return this.joining > 0;
  }

  /** Runs `run`; every command the history is given meanwhile becomes a part of this step. */
  public join<T>(run: () => T): T {
    this.joining += 1;
    try {
      return run();
    } finally {
      this.joining -= 1;
    }
  }
}
