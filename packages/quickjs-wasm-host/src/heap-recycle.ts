import { QuickJsExecutionError, type QuickJsProgramHost } from "./program-host.js";

/**
 * Past this much WASM memory in the module a sandbox runs in, the sandbox is rebuilt over a
 * fresh module after the run that grew it: a WASM memory never shrinks,
 * so a plugin that built large strings once would otherwise pin that resident memory for the
 * life of the process, whatever `memoryLimitBytes` it was run under.
 */
export const HEAP_RECYCLE_BYTES = 128 * 1024 * 1024;

/**
 * Holds the current sandbox of one instance and replaces it, after a run, when the module's
 * heap is past the threshold. The replacement is built in the background (instantiation is
 * asynchronous, a run is not): runs in the meantime use the old sandbox unless it is poisoned
 * (then they are refused until the swap, see {@link usable}), and the swap is one assignment. A rebuild that fails is reported (`onError`, a console warning by default), leaves the old
 * sandbox in place and is tried again after the next run. The swap drops the prepared-definition
 * cache and any state a plugin module kept.
 */
export class SandboxRecycler<S extends { host: QuickJsProgramHost }> {
  private rebuilding: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private current: S,
    private readonly rebuild: () => Promise<S>,
    private readonly thresholdBytes: number = HEAP_RECYCLE_BYTES,
    private readonly onError: (error: unknown) => void = (error) => console.warn("datum: sandbox heap recycle failed, retrying after the next run:", error)
  ) {}

  public get sandbox(): S {
    return this.current;
  }

  /**
   * The sandbox for the next run, refusing (`runtime_error`) while the current one is poisoned: a
   * host-side error left its runtime in a state QuickJS no longer accounts for, so nothing runs in
   * it again. The refusal starts the replacement when none is under way (a rebuild that failed
   * is tried again here), and the run after the swap goes to the fresh sandbox.
   */
  public usable(): S {
    if (this.current.host.poisoned) {
      this.afterRun();
      throw new QuickJsExecutionError("runtime_error", "The sandbox is being replaced after a failure that left its runtime unusable; try again");
    }
    return this.current;
  }

  /** Resolves when a rebuild started by {@link afterRun} has finished (for tests). */
  public get settled(): Promise<void> {
    return this.rebuilding ?? Promise.resolve();
  }

  /**
   * Call after every run, whether it returned or threw. A poisoned sandbox is replaced whatever its
   * heap, over a fresh module too: the abandoned runtime is never freed, so the module it sits in
   * is not handed to the next sandbox.
   */
  public afterRun(): void {
    if (this.disposed || this.rebuilding !== undefined) {
      return;
    }
    if (!this.current.host.poisoned) {
      const heap = this.current.host.moduleHeapBytes();
      if (heap === undefined || heap <= this.thresholdBytes) {
        return;
      }
    }
    this.current.host.discardModule();
    this.rebuilding = this.rebuild().then(
      (next) => {
        if (this.disposed) {
          next.host.dispose();
          return;
        }
        const old = this.current;
        this.current = next;
        try {
          old.host.dispose();
        } catch (error) {
          // A host poisoned while the rebuild ran can abort on dispose; the swap already happened.
          this.onError(error);
        }
      },
      (error: unknown) => this.onError(error)
    ).finally(() => {
      this.rebuilding = undefined;
    });
  }

  public dispose(): void {
    this.disposed = true;
    this.current.host.dispose();
  }
}
