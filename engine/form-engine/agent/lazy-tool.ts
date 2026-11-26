/**
 * Lazy tool bodies. Registration is synchronous
 * (the browser takes a tool's name, title, description, schema and annotations at once), but a
 * large tool body need not ride in the agent chunk: `lazyTool` keeps the descriptor eager and
 * fetches the body on the first call, the way the builder's panels load (`loadTestsPanel`).
 *
 * The load is memoised per `lazyTool` call, so one catalogue loads each body once; a rejected
 * load is forgotten so the next call tries again (a flaky network, a host that restored the
 * file). A body that cannot be had answers `chunk-unavailable { what, state: "failed" }`, which
 * the registrar stamps retryable; nothing else is caught here: the body's own refusals and throws
 * reach the registrar unchanged.
 *
 * The wait for the body watches the caller's signal, as `run_tests` does with its chunk
 * (agent/builder/tests-tools.ts). The registrar judges `cancelled` only before `execute` starts
 * and holds the target's write chain until it returns, so a stalled chunk would otherwise keep
 * every write on that target `busy`, and a write the caller cancelled would still run when the
 * chunk landed (a removal applied after the agent was told it was cancelled, then retried). An
 * abort rejects at once with an `AbortError`, which the registrar answers with its own
 * `cancelled`; the pending load stays memoised for the next call.
 *
 * `dispose()` reaches the body the
 * registrar cannot see: a loaded body's `dispose` runs at once, a load still on the way has its
 * body disposed once it lands, and a load that fails has nothing to dispose. A call that was
 * waiting on that load runs its body after that dispose (its wait adds promise hops the dispose's
 * reaction does not), so a body that subscribes in `run()` would subscribe again with nothing left
 * to remove it: such a call disposes the body once more as soon as `run()` has started, which
 * drops what `run()`'s synchronous part subscribed. A call that began after the dispose (the
 * rebuilt registration's) is left alone. The memo is kept, so the call after a rebuild runs the
 * same body without a second load.
 *
 * Imports only `agent/` modules and does nothing at import time. Not exported from the agent
 * barrel: the catalogues use it by path.
 */

import { ToolRefusal, type AgentTool, type ToolContext, type ToolData } from "./tool-types.js";

/** What a lazily loaded module hands back: the tool's `execute`, apart from its descriptor. */
export interface ToolBody<I = Record<string, unknown>, H = unknown> {
  run(input: I, ctx: ToolContext<H>): Promise<ToolData> | ToolData;
  /**
   * What the tool's `dispose()` forwards
   * to a loaded body (try_it's Submit subscription). The body stays loaded and usable after it,
   * so it may be called more than once. A body subscribes in `run()`'s synchronous part (before
   * its first `await`): a call that crossed a dispose disposes again right after `run()` starts.
   */
  dispose?(): void;
}

/** `chunk-unavailable` with `state: "failed"` (exact). */
const FAILED_HINT = "Try once more; if it fails again the host removed that file: tell the person.";

/** What a call rejects with once its caller gave up; the registrar's `caught` turns it into `cancelled`. */
function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

/** `work`, or an `AbortError` the moment `signal` fires; the listener goes when either settles. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * A tool whose descriptor is readable at once (name, title, description, schema, annotations,
 * `readActions`, `inputBytes`) and whose body `load()` fetches on the first call. `what` is the
 * `chunk-unavailable` detail naming the part that did not load (`agent-try`, `agent-languages`,
 * `agent-documents`).
 */
export function lazyTool<I = Record<string, unknown>, H = unknown>(
  descriptor: Omit<AgentTool<I, H>, "execute">,
  load: () => Promise<ToolBody<I, H>>,
  what: string
): AgentTool<I, H> {
  let memo: Promise<ToolBody<I, H>> | undefined;
  // The body once its load resolved, so `dispose()` reaches it in the same turn (a registrar's
  // unregister is synchronous, and a subscription left until a later microtask can still fire).
  let landed: ToolBody<I, H> | undefined;
  // How many times `dispose()` ran: a call compares it across its wait for the body.
  let disposals = 0;
  const body = (): Promise<ToolBody<I, H>> => {
    if (memo === undefined) {
      let next: Promise<ToolBody<I, H>>;
      try {
        next = Promise.resolve(load()).then((loaded) => {
          // A module that resolves without a body (a build that lost the export) is as unusable
          // as one that failed to fetch, and is forgotten the same way.
          if (typeof (loaded as Partial<ToolBody<I, H>> | undefined)?.run !== "function") {
            throw new Error(`the ${what} body has no run()`);
          }
          landed = loaded;
          return loaded;
        });
      } catch (error) {
        next = Promise.reject(error);
      }
      memo = next;
      next.catch(() => {
        if (memo === next) {
          memo = undefined;
        }
      });
    }
    return memo;
  };
  return {
    ...descriptor,
    async execute(input: I, ctx: ToolContext<H>): Promise<ToolData> {
      if (ctx.signal.aborted) {
        throw abortError();
      }
      const disposalsBefore = disposals;
      let loaded: ToolBody<I, H>;
      try {
        loaded = await untilAborted(body(), ctx.signal);
      } catch (error) {
        if (ctx.signal.aborted) {
          // The caller gave up during the load: that is the answer, whatever the load did.
          throw abortError();
        }
        console.error(`[datum-agent] ${descriptor.name}: the ${what} part did not load`, error);
        throw new ToolRefusal("chunk-unavailable", "Part of the assistant tools could not be loaded.", FAILED_HINT, {
          what,
          state: "failed"
        });
      }
      // The body landed in the same turn as an abort: nothing has run yet, so nothing runs.
      if (ctx.signal.aborted) {
        throw abortError();
      }
      if (disposals === disposalsBefore) {
        return loaded.run(input, ctx);
      }
      // A dispose came while this call waited on the load, and has already run (or found nothing)
      // before this body runs: whatever `run()` subscribes now would outlive the registration.
      // Dispose again once `run()` has started (or thrown), and leave its answer as it is.
      try {
        return loaded.run(input, ctx);
      } finally {
        try {
          loaded.dispose?.();
        } catch (error) {
          console.error(`[datum-agent] ${descriptor.name}: dispose`, error);
        }
      }
    },
    dispose(): void {
      disposals += 1;
      if (landed !== undefined) {
        // The registrar holds each tool's dispose in its own try and logs a throw.
        landed.dispose?.();
        return;
      }
      // A load on the way: dispose the body once it lands. Nothing awaits this promise, so a
      // throwing dispose is logged here; a failed load has nothing to dispose.
      memo?.then(
        (loaded) => {
          try {
            loaded.dispose?.();
          } catch (error) {
            console.error(`[datum-agent] ${descriptor.name}: dispose`, error);
          }
        },
        () => undefined
      );
    }
  };
}
