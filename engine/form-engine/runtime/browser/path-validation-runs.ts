import type { ValidationStageEvent } from "../../validation/core/validation-pipeline.js";

/**
 * One check of one value path, as {@link PathValidationRuns.run} hands it to the code that
 * runs the pipeline.
 */
export interface PathRun {
  /** The value path checked (`"items[1].sku"`). */
  readonly path: string;
  /** Aborted as soon as a newer check of the same path replaces this one: the context's `signal`. */
  readonly signal: AbortSignal;
  /** Whether this run still holds its path's token: false once a newer check of the path began. */
  current(): boolean;
  /** The pipeline's `onStage` for this run: marks the path pending while an async stage declaring it runs. */
  onStage(event: ValidationStageEvent): void;
}

/** How a check of one path ended: `current` false when a newer check replaced it and its result was dropped. */
export type PathRunOutcome<R> = { current: true; result: R } | { current: false };

/** A whole-form run's view of pending: counts the paths its async stages declare while they run. */
export interface FormWideRun {
  onStage(event: ValidationStageEvent): void;
  /** The run is over, settled or thrown: whatever it still counts is released. */
  end(): void;
}

interface Holder {
  readonly controller: AbortController;
}

/**
 * The bookkeeping behind per-field pending state and checks of single value paths.
 *
 * Tokens: each check of a path takes that path's token, and the check it replaces goes stale —
 * its signal is aborted, it never clears the path's pending mark (the newer check owns it now)
 * and it never writes its errors ({@link run} calls `commit` only while the run holds the
 * token). Pending: a path is pending while the token holder's async stage declaring the path
 * runs, or while a whole-form run's async stage declaring it runs ({@link formRun}; those
 * never take tokens, since a whole-form run is no newer answer than the check in flight).
 * In flight: the latest check of each path is kept as a promise, so a submit or a journey's
 * Continue can wait for them ({@link settled}) before its own validation.
 */
export class PathValidationRuns {
  private readonly holders = new Map<string, Holder>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** Paths whose token holder has a declaring async stage running. */
  private readonly heldPending = new Set<string>();
  /** Paths whole-form runs' async stages are judging, with how many of them are. */
  private readonly formWide = new Map<string, number>();
  /** How many checks of single paths began so far: the number each one took its token under. */
  private taken = 0;
  /** The number under which each path's latest check took its token ({@link takenSince}). */
  private readonly takenAt = new Map<string, number>();

  /** @param changed told each time a path's pending flag flips, with the new flag. */
  constructor(private readonly changed: (path: string, pending: boolean) => void) {}

  public isPending(path: string): boolean {
    return this.heldPending.has(path) || (this.formWide.get(path) ?? 0) > 0;
  }

  /** Whether any check of a single path is still out. */
  public get busy(): boolean {
    return this.inFlight.size > 0;
  }

  /**
   * Runs one check of `path`: takes the path's token (making the check before it stale, its
   * signal aborted), awaits `execute`, and — only while this run still holds the token — hands
   * the result to `commit`, synchronously, so nothing can replace the run between the check and
   * the write. A stale run's result, or its rejection (a stage honouring the abort), is dropped
   * and the outcome says `current: false`. A current run's rejection is passed on.
   */
  public run<R>(path: string, execute: (run: PathRun) => Promise<R>, commit: (result: R) => void): Promise<PathRunOutcome<R>> {
    const previous = this.holders.get(path);
    const holder: Holder = { controller: new AbortController() };
    this.holders.set(path, holder);
    this.taken += 1;
    this.takenAt.set(path, this.taken);
    previous?.controller.abort();
    const current = (): boolean => this.holders.get(path) === holder;
    const run: PathRun = {
      path,
      signal: holder.controller.signal,
      current,
      onStage: (event) => {
        if (event.kind === "async" && event.paths?.includes(path) === true && current()) {
          this.setHeld(path, event.phase === "start");
        }
      }
    };
    const promise = (async (): Promise<PathRunOutcome<R>> => {
      try {
        const result = await execute(run);
        if (!current()) {
          return { current: false };
        }
        commit(result);
        return { current: true, result };
      } catch (error) {
        if (!current()) {
          return { current: false };
        }
        throw error;
      } finally {
        if (current()) {
          this.holders.delete(path);
          this.setHeld(path, false);
        }
      }
    })();
    this.inFlight.set(path, promise);
    const forget = (): void => {
      if (this.inFlight.get(path) === promise) {
        this.inFlight.delete(path);
      }
    };
    promise.then(forget, forget);
    return promise;
  }

  /** The pending bookkeeping of one whole-form run (validate, submit, a page's Continue). */
  public formRun(): FormWideRun {
    const counted = new Map<string, number>();
    const add = (path: string, delta: 1 | -1): void => {
      const own = counted.get(path) ?? 0;
      if (delta === -1 && own === 0) {
        return;
      }
      counted.set(path, own + delta);
      const before = this.isPending(path);
      const total = (this.formWide.get(path) ?? 0) + delta;
      if (total > 0) {
        this.formWide.set(path, total);
      } else {
        this.formWide.delete(path);
      }
      this.announce(path, before);
    };
    return {
      onStage: (event) => {
        if (event.kind !== "async" || event.paths === undefined) {
          return;
        }
        for (const path of new Set(event.paths)) {
          add(path, event.phase === "start" ? 1 : -1);
        }
      },
      end: () => {
        for (const [path, own] of [...counted]) {
          for (let left = own; left > 0; left -= 1) {
            add(path, -1);
          }
        }
      }
    };
  }

  /**
   * A mark to hand {@link takenSince} later: a whole-form run takes one with its snapshot of the
   * answers, so it can tell which paths were checked on newer answers than its own.
   */
  public mark(): number {
    return this.taken;
  }

  /** The paths whose latest check took its token after `mark` was taken. */
  public takenSince(mark: number): ReadonlySet<string> {
    const out = new Set<string>();
    for (const [path, at] of this.takenAt) {
      if (at > mark) {
        out.add(path);
      }
    }
    return out;
  }

  /**
   * Calls off every check of a path `which` picks out, as a newer check of the path would: its
   * signal aborts, it never commits, its pending mark goes, and {@link settled} no longer waits
   * for it. For the answers being replaced some other way than a check of the path — a draft
   * loaded, a collection's rows removed, moved or replaced — so a verdict about answers that are
   * gone is never written over the ones that came instead.
   */
  public cancelWhere(which: (path: string) => boolean): void {
    for (const [path, holder] of [...this.holders]) {
      if (!which(path)) {
        continue;
      }
      this.holders.delete(path);
      this.inFlight.delete(path);
      holder.controller.abort();
      this.setHeld(path, false);
    }
  }

  /**
   * Resolves once no check of a single path is out, including any that began while waiting.
   * Never rejects: a check that failed is its caller's to report, and what waits here runs its
   * own validation next.
   */
  public async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  private setHeld(path: string, pending: boolean): void {
    const before = this.isPending(path);
    if (pending) {
      this.heldPending.add(path);
    } else {
      this.heldPending.delete(path);
    }
    this.announce(path, before);
  }

  private announce(path: string, before: boolean): void {
    const after = this.isPending(path);
    if (after !== before) {
      this.changed(path, after);
    }
  }
}
