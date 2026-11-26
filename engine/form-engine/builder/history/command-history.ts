export interface BuilderCommand {
  id: string;
  execute(): void;
  undo(): void;
  /**
   * Whether this entry, atop the history, takes `command` (already run) as one more of its parts
   * instead of the history making it an entry of its own (see `RenameStep`). Absent: never.
   */
  absorb?(command: BuilderCommand): boolean;
}

export class CommandHistory {
  private readonly done: BuilderCommand[] = [];
  private readonly undone: BuilderCommand[] = [];

  public peekUndo(): BuilderCommand | undefined {
    return this.done[this.done.length - 1];
  }

  public peekRedo(): BuilderCommand | undefined {
    return this.undone[this.undone.length - 1];
  }

  public execute(command: BuilderCommand): void {
    command.execute();
    // A part of the step atop the history is no entry of its own, so what can be redone stays.
    if (this.done[this.done.length - 1]?.absorb?.(command)) {
      return;
    }
    // New commands invalidate redo history by design.
    this.undone.length = 0;
    this.done.push(command);
  }

  /**
   * Undoes the last entry. One whose undo fails (it leaves the tree as it was) takes every
   * entry before it along: each of them was made from after it, so none can be undone now.
   * What can be redone stays. The error is the caller's to say.
   */
  public undo(): void {
    this.step(this.done, this.undone, 2);
  }

  /** Redoes the next entry; one that fails takes every entry after it along, as {@link undo} does. */
  public redo(): void {
    this.step(this.undone, this.done, 1);
  }

  /** Takes the entry atop `from` onto `to`; `leaving`: the side of it the tree leaves (2 undone, 1 redone). */
  private step(from: BuilderCommand[], to: BuilderCommand[], leaving: 1 | 2): void {
    const command = from.pop();
    if (!command) {
      return;
    }

    try {
      if (leaving === 2) {
        command.undo();
      } else {
        command.execute();
      }
    } catch (error) {
      from.length = 0;
      throw error;
    }
    to.push(command);
  }

  /** Ends the redo side, as a new entry would, with no entry made, when it holds an entry `holding` picks; whether it did. */
  public dropRedo(holding: (entry: object) => boolean): boolean {
    const drop = this.undone.some(holding);
    if (drop) {
      this.undone.length = 0;
    }
    return drop;
  }

  public canUndo(): boolean {
    return this.done.length > 0;
  }

  public canRedo(): boolean {
    return this.undone.length > 0;
  }
}
