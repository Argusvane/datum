/**
 * The `try_it` tool's body, in a chunk of its
 * own (`datum-builder-agentpart-try-*.js`): the descriptor is eager in tools.ts, and `lazyTool`
 * fetches this module on the first call. A factory over the catalogue's `shared`, so two builders on one page each run with their own; nothing lives at module scope.
 *
 * Try it as a respondent would, through the page's Try it adapter only (`ui.tryIt()`):
 * every act is one the person's own controls make on the canvas, the shell or the
 * Try it chunk. The answers go into the tried runtime (the canvas preview, or a journey session's)
 * with `setValue` / `addRow` / `removeRow`, read and refused through the shared answers module
 * (`agent/answers/`) exactly as the form reads them, and worded here in Try it's voice. Check and
 * Submit are the person's own (drawn on the Try panel; the person's server checks run when they
 * turned them on, and are never turned on here); a Submit goes to the builder's
 * stand-in server and sends nothing anywhere. Nothing here changes the form's design or the
 * revision, and tried answers are on no history and in no Undo all (they end with Try it); only
 * `settings` is journaled.
 *
 * The person always wins: Try it is turned on only after the prompt and
 * draft pre-check said nothing holds (`yieldToPerson(scope, "try")`), and a shell that held it
 * anyway is answered `stay`; answers the person typed in Try it are cleared only with
 * `discardTriedAnswers: true`; nothing is written while a test is being recorded or shown; the
 * field the person types in is refused per path; a journey page move takes no focus while the
 * person's focus is elsewhere (the tried renderer's quiet page focus).
 *
 * Guard 15's strings: the builder catalogue's sentinel tool names are spelled
 * here only through `SENTINEL_TOOLS` (context.ts), and the renderer's write tool name never;
 * `try-it-busy` is spelled in this chunk alone.
 */
import { TRY_SUBMISSION_FAILED_MESSAGE } from "../../builder/controller/try-submission.js";
import type { TryCheckOutcome, TrySubmitOutcome } from "../../builder/web-component/try-it-types.js";
import type { JourneyNavigationResult, JourneyView } from "../../core/journey/journey-types.js";
import { coerceAnswer, coerceRowsAnswer, kindOfNode, isNestedCollection, type FieldColumn, type FieldKind } from "../answers/index.js";
import type { ToolBody } from "../lazy-tool.js";
import { cutString } from "../result-caps.js";
import { ToolRefusal, type ToolContext, type ToolData } from "../tool-types.js";
import { SENTINEL_TOOLS, draftRefusal, type BuilderCallScope, type BuilderToolsShared } from "./context.js";
import type { BuilderToolHost, BuilderToolUi, TriedRuntime, TryItAdapter } from "./host.js";
import {
  TRY_PATH_MAX,
  TRY_PATH_PATTERN,
  acceptsFreeText,
  answerRefusal,
  badInput,
  canonicalJson,
  checkProblems,
  collectionOf,
  columnsOf,
  displayOf,
  echoed,
  errorProblems,
  fieldInUseRefusal,
  indexTried,
  listedModels,
  noSuchRowRefusal,
  nonEmpty,
  notWritableRefusal,
  pageTitle,
  personDataRefusal,
  readFields,
  requiredProblem,
  resolveTried,
  rowBoundsOf,
  rowCapOf,
  rowOperationsOf,
  rowsLimitRefusal,
  rowsLockedRefusal,
  rowsOf,
  shownNow,
  tooLarge,
  typedCounts,
  unknownFieldRefusal,
  writabilityOfPath,
  type TypedAnswers
} from "./try-fields.js";
import { planSettings, previewSubmission, reverseOf, sourcesState, submissionChanges } from "./try-settings.js";
import type { ItemRefusal, TryItAction, TryItResult, TryProblem } from "./types.js";

type Input = Record<string, unknown>;

/** At most this many paths per `fill`. */
const ANSWERS_CAP = 200;
/** A whole table written by `fill` holds at most this many rows (the grid cap). */
const TABLE_ROWS_CAP = 500;
/** `read`'s page: default and largest (the schema caps `limit` at 500). */
const READ_LIMIT = 100;
/** `revealed`, `nowRequired`: at most this many paths. */
const LISTED_PATHS_CAP = 50;
/** A `blocked` page move lists at most this many problems. */
const BLOCKED_PROBLEMS_CAP = 20;
/** A journey's pages listed in `where.journey.pages`. */
const PAGES_CAP = 50;
/** Budgets: Try it start and `check` 10 s, `submit` 20 s; a page move as the renderer's 20 s. */
const START_BUDGET_MS = 10_000;
const CHECK_BUDGET_MS = 10_000;
const SUBMIT_BUDGET_MS = 20_000;
const NAVIGATE_BUDGET_MS = 20_000;

/** The actions that turn Try it on first when it is off. */
const STARTING: ReadonlySet<TryItAction> = new Set<TryItAction>(["fill", "edit_rows", "navigate", "check", "submit"]);
/** The actions a recording or a showing holds. */
const HELD_BY_RECORDING: ReadonlySet<TryItAction> = new Set<TryItAction>(["fill", "edit_rows", "navigate", "submit", "clear"]);

/** The folded convention's spec: what each action needs and reads. */
const NEEDS: Record<string, readonly string[]> = { fill: ["answers"], edit_rows: ["collection", "rowAction"], navigate: ["to"] };
const READS: Record<string, readonly string[]> = {
  read: ["include", "offset", "limit"],
  edit_rows: ["index", "values", "force"],
  clear: ["discardTriedAnswers"],
  settings: ["trySubmission", "sources"]
};

/** The `note` when a `fill` wrote fields of a journey page other than the one shown. */
const OFF_PAGE_NOTE = "Some fields are on other pages; they were written in place and their page checks run when you navigate there.";

/** The `note` when this call turned Try it on. */
const STARTED_NOTE ="Try it is now on: the person sees the live form. open { tryIt: false } goes back to editing and clears the tried answers.";

/** `next` by outcome. */
const NEXT = {
  read: "try_it { action: 'fill' } types answers; 'check' shows what the form would refuse.",
  fill: ["Call try_it { action: 'check' } to see what the form would refuse.", "try_it { action: 'submit' } presses Submit against the stand-in server; nothing is sent."],
  checkClean: "try_it { action: 'submit' } shows the stand-in's answer, or write_test keeps these answers as a test.",
  checkProblems: "Fix the answers with try_it { action: 'fill' }, or the rules with set_properties after open { tryIt: false }.",
  submitted: "Tell the person what the stand-in answered; write_test can keep these answers as a test.",
  navigate: "Fill this page with try_it { action: 'fill' }, then navigate to 'next'.",
  clear: "try_it { action: 'fill' } starts again from the form's defaults.",
  settings: "Try it with try_it { action: 'submit' } or 'fill'.",
  rowAdded: "Fill the new row's cells with try_it { action: 'fill' }, then call try_it { action: 'check' }."
} as const;

/** What a refusal hint names to re-read the builder (through the sentinel, guard 15). */
const DESCRIBE = SENTINEL_TOOLS.describeBuilder;

// ---- the refusals of the whole call ----------------------------------

function noUi(): ToolRefusal {
  return new ToolRefusal("no-ui", "This builder has no page to try the form on.", "This builder runs without its page; nothing can be shown.", {});
}

function featureOff(): ToolRefusal {
  return new ToolRefusal("feature-off", "The try-it feature is off in this host.", "This page does not allow that; tell the person instead of retrying.", { feature: "try-it" });
}

function notTryable(ui: BuilderToolUi, message = "Try it cannot run where the person is."): ToolRefusal {
  return new ToolRefusal(
    "not-tryable",
    message,
    "Try it runs on the form or an open journey or PDF template page; call open { workspace: 'form' } first, or tell the person.",
    { workspace: ui.workspace(), mode: ui.mode() }
  );
}

function tryItBusy(because: "recording" | "showing"): ToolRefusal {
  return because === "recording"
    ? new ToolRefusal(
        "try-it-busy",
        "The person is recording a test from Try it; nothing was changed.",
        "The person is recording a test; your answers would be written into it. Wait until they stop, then call again.",
        { because }
      )
    : new ToolRefusal("try-it-busy", "Try it is showing a test scenario; nothing was changed.", "Try it is showing a test scenario; ask the person to close it first.", { because });
}

function chunkUnavailable(what: "try-it" | "journey-preview", state: "loading" | "failed"): ToolRefusal {
  return state === "loading"
    ? new ToolRefusal("chunk-unavailable", `The ${what === "try-it" ? "Try it panel" : "journey preview"} is still loading.`, "That part of the builder is still loading; call again in a moment.", {
        what,
        state
      })
    : new ToolRefusal(
        "chunk-unavailable",
        `The ${what === "try-it" ? "Try it panel" : "journey preview"} could not be loaded.`,
        "Try once more; if it fails again the host removed that file: tell the person.",
        { what, state }
      );
}

function timedOut(afterMs: number): ToolRefusal {
  return new ToolRefusal("timeout", `The call did not finish within ${afterMs} ms.`, `The builder is still working. Call ${DESCRIBE} to see where things stand.`, {
    afterMs,
    stillRunning: true
  });
}

function cancelled(stillRunning: boolean): ToolRefusal {
  return new ToolRefusal(
    "cancelled",
    "The call was cancelled.",
    `The call was cancelled. If stillRunning is set the action may still complete; call ${DESCRIBE} before retrying.`,
    stillRunning ? { stillRunning: true } : {}
  );
}

function notAJourney(workspace: string): ToolRefusal {
  return new ToolRefusal(
    "not-a-journey",
    "The tried form is not a journey's preview, so it has no pages to move between.",
    "navigate moves a journey's preview; open the journey with documents { action: 'open', kind: 'journey', id } and call try_it again.",
    { workspace }
  );
}

function asRefusal(item: ItemRefusal): ToolRefusal {
  return new ToolRefusal(item.code, item.message, item.hint, item.details);
}

/** `work`, or `undefined` once `ms` ran out first; the timer goes when either settles. */
async function within<T>(work: Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ value })), expiry]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** A promise that settles with its outcome instead of rejecting. */
function settledOf<T>(work: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

// ---- the body ---------------------------------------------------------------------------------

/** The `try_it` body over one catalogue's shared helpers. */
export function tryItBody(shared: BuilderToolsShared): ToolBody<Record<string, unknown>, BuilderToolHost> {
  const memory = shared.memory;
  // Anyone's Submit while trying, for `read`'s `lastSubmit`: heard from the
  // first call on, per adapter. Held by this catalogue's body alone, never at module scope.
  // The registrar disposes the tool on unregister and on a reseed, which reaches `dispose()` below through lazyTool: the subscription goes at
  // once, and after a reseed the next call subscribes again. A call that was waiting on this
  // chunk across the dispose runs after it; lazyTool disposes again once that `run()` has
  // started, which is why `listen` stays in `run()`'s synchronous part, before its first await.
  let heard: { adapter: TryItAdapter; off: () => void } | undefined;

  const listen = (adapter: TryItAdapter): void => {
    if (heard?.adapter === adapter) {
      return;
    }
    heard?.off();
    const off = adapter.onSubmit((outcome) => {
      if (!shared.host.connected()) {
        // A host gone without a dispose (a page that never unregistered): drop the listener
        // instead of writing into a dead memory.
        off();
        if (heard?.off === off) {
          heard = undefined;
        }
        return;
      }
      if (adapter.trying()) {
        memory.tryLast.lastSubmit = lastSubmitOf(outcome);
      }
    });
    heard = { adapter, off };
  };

  const lastSubmitOf = (outcome: TrySubmitOutcome): NonNullable<TryItResult["lastSubmit"]> => {
    const last: NonNullable<TryItResult["lastSubmit"]> = { at: Date.now(), outcome: outcome.outcome };
    if (typeof outcome.reference === "string" && outcome.reference !== "") {
      last.reference = outcome.reference;
    }
    return last;
  };

  /** The tried runtime while Try it is on; `undefined` while the canvas edits. */
  const triedRuntime = (adapter: TryItAdapter | undefined): TriedRuntime | undefined => (adapter?.trying() === true ? adapter.runtime() : undefined);

  const typedOf = (adapter: TryItAdapter): TypedAnswers => adapter.typed();

  /** Where the tried form is (`where`), the journey's page included. */
  const whereOf = (adapter: TryItAdapter, runtime: TriedRuntime): NonNullable<TryItResult["where"]> => {
    const at = adapter.where();
    const where: NonNullable<TryItResult["where"]> = { workspace: at.workspace };
    const view = runtime.journeyView?.();
    if (view !== undefined) {
      const locale = runtime.state().locale;
      const pageIdOf = (nodeId: string): string => adapter.pageIdOf(nodeId) ?? nodeId;
      where.journey = {
        journeyId: at.journeyId ?? view.journeyId,
        pageId: pageIdOf(view.pageId),
        title: pageTitle(view.page, locale, pageIdOf(view.pageId), runtime, view.journeyId),
        index: view.index,
        total: view.path.length,
        final: view.final,
        pages: view.journey.pages.slice(0, PAGES_CAP).map((page) => ({ pageId: pageIdOf(page.id), title: pageTitle(page, locale, pageIdOf(page.id), runtime, view.journeyId), onPath: view.path.includes(page.id) }))
      };
    }
    return where;
  };

  /** The fields every result carries: `action`, `trying`, `where` while trying, `answered`. */
  const finish = (action: TryItAction, adapter: TryItAdapter | undefined, fields: Partial<TryItResult> & { changed: boolean }, started: boolean): ToolData => {
    const runtime = triedRuntime(adapter);
    const result: Record<string, unknown> = { action, changed: fields.changed || started, trying: runtime !== undefined };
    if (started) {
      result.started = true;
    }
    if (runtime !== undefined && adapter !== undefined) {
      result.where = whereOf(adapter, runtime);
      const counts = typedCounts(typedOf(adapter), memory.tried);
      result.answered = { byPerson: counts.byPerson, byAssistant: counts.byAssistant };
    } else {
      result.answered = { byPerson: 0, byAssistant: 0 };
    }
    const { changed: _changed, ...rest } = fields;
    Object.assign(result, rest);
    if (started) {
      result.note = [STARTED_NOTE, ...((rest.note as string[] | undefined) ?? [])];
    }
    return result;
  };

  const checkSignal = (ctx: ToolContext<BuilderToolHost>, stillRunning: boolean): void => {
    if (ctx.signal.aborted) {
      throw cancelled(stillRunning);
    }
  };

  /**
   * Turns Try it on for a starting action (the start row): the
   * surface must be tryable, then the prompt and draft pre-check on the active controller and the
   * form's (`yieldToPerson(scope, "try")`); only then `adapter.start()` (the shell's `setTrying`,
   * which goes through its own leave check). A shell that held it behind a prompt raised since is
   * answered `stay` and refused. Then the wait for what Try it shows (a journey's session included).
   */
  const begin = async (scope: BuilderCallScope, ui: BuilderToolUi, adapter: TryItAdapter): Promise<boolean> => {
    if (adapter.trying()) {
      return false;
    }
    if (!adapter.tryable()) {
      throw notTryable(ui);
    }
    shared.yieldToPerson(scope, "try");
    if (!adapter.start()) {
      for (const controller of new Set([ui.activeController?.() ?? scope.controller, scope.controller])) {
        const prompt = controller.unsavedChangesPrompt();
        if (prompt !== undefined) {
          controller.answerUnsavedChangesPrompt("stay");
          throw draftRefusal(prompt.componentId);
        }
      }
      throw notTryable(ui);
    }
    const journey = adapter.where().workspace === "journeys";
    const ready = await within(settledOf(adapter.ready()), START_BUDGET_MS);
    if (ready === undefined) {
      throw journey ? chunkUnavailable("journey-preview", "loading") : timedOut(START_BUDGET_MS);
    }
    if (!ready.value.ok) {
      if (journey) {
        throw chunkUnavailable("journey-preview", "failed");
      }
      throw ready.value.error;
    }
    checkSignal(scope.ctx, true);
    return true;
  };

  /** The tried runtime once Try it is on; it ended under the call (the person went back to editing): `not-tryable`. */
  const runtimeOf = (ui: BuilderToolUi, adapter: TryItAdapter): TriedRuntime => {
    const runtime = triedRuntime(adapter);
    if (runtime === undefined) {
      throw notTryable(ui, "Try it ended before the call ran: the person went back to editing.");
    }
    return runtime;
  };

  /**
   * A Check or Submit the adapter refused: the chunk did not load, the feature is off,
   * or Try it ended while it came (the person went back to editing or cleared the answers).
   */
  const refusedAct = (ui: BuilderToolUi, adapter: TryItAdapter, what: "check" | "Submit"): ToolRefusal => {
    switch (adapter.chunk()) {
      case "failed":
        return chunkUnavailable("try-it", "failed");
      case "loading":
        return chunkUnavailable("try-it", "loading");
      case "off":
        return featureOff();
      default:
        return notTryable(ui, `Try it ended before the ${what} ran: the person went back to editing or cleared the answers.`);
    }
  };

  /** The person's own Check or Submit, within its budget; a refusal of the adapter mapped. */
  const act = async <T>(ui: BuilderToolUi, adapter: TryItAdapter, work: () => Promise<T>, budgetMs: number, what: "check" | "Submit"): Promise<T> => {
    let promise: Promise<T>;
    try {
      promise = work();
    } catch {
      throw refusedAct(ui, adapter, what);
    }
    const settled = await within(settledOf(promise), budgetMs);
    if (settled === undefined) {
      throw adapter.chunk() === "loading" ? chunkUnavailable("try-it", "loading") : timedOut(budgetMs);
    }
    if (!settled.value.ok) {
      throw refusedAct(ui, adapter, what);
    }
    return settled.value.value;
  };

  /** The person's state that holds a write of tried answers (guard 6). */
  const heldByPerson = (adapter: TryItAdapter): void => {
    if (adapter.recording()) {
      throw tryItBusy("recording");
    }
    if (adapter.showing()) {
      throw tryItBusy("showing");
    }
  };

  /**
   * Shows the person what changed: highlight and reveal outside a text control, then the
   * announcement. `reveal` is the component scrolled to (the first id, as a rule); none when every
   * written field is on another journey page, which the shown page does not draw.
   */
  const showTried = (ui: BuilderToolUi, ids: readonly string[], announce: string, reveal: string | undefined): void => {
    if (ids.length > 0 && !ui.focusInTextControl()) {
      ui.highlight(ids);
      if (reveal !== undefined) {
        ui.revealComponent(reveal);
      }
    }
    ui.announce(announce);
  };

  /** Records what the agent left at each written key (`memory.tried`): its value, or nothing once cleared. */
  const remember = (runtime: TriedRuntime, keys: Iterable<string>): void => {
    const values = runtime.state().values;
    for (const key of keys) {
      const value = values[key];
      if (nonEmpty(value)) {
        memory.tried.set(key, canonicalJson(value));
      } else {
        memory.tried.delete(key);
      }
    }
  };

  /** A table's own cells as the answers hold them, keyed `items[0].qty`. */
  const tableKeys = (runtime: TriedRuntime, collection: string): string[] => {
    const prefix = `${collection}[`;
    return Object.keys(runtime.state().values).filter((key) => key.startsWith(prefix));
  };

  /** The paths the person typed in a table (or one row of it), for `person-data`. */
  const personCells = (adapter: TryItAdapter, collection: string, row?: number): string[] => {
    const prefix = row === undefined ? `${collection}[` : `${collection}[${row}].`;
    return typedCounts(typedOf(adapter), memory.tried).personKeys.filter((key) => key.startsWith(prefix));
  };

  // ---- read --------------------------------------------------------------------------------

  const read = async (scope: BuilderCallScope, adapter: TryItAdapter, input: Input): Promise<ToolData> => {
    const runtime = triedRuntime(adapter);
    const fields: Partial<TryItResult> & { changed: boolean } = { changed: false };
    if (runtime !== undefined) {
      const index = await indexTried(runtime);
      const include = input.include === "all" ? "all" : "visible";
      const offset = typeof input.offset === "number" ? input.offset : 0;
      const limit = typeof input.limit === "number" ? input.limit : READ_LIMIT;
      const listed = readFields(index, typedOf(adapter), memory.tried, { include, offset, limit });
      fields.fields = listed.fields;
      fields.fieldCount = listed.fieldCount;
    } else {
      fields.note = ["Try it is off: nothing is tried yet; fill, edit_rows, navigate, check and submit turn it on."];
    }
    if (memory.tryLast.lastCheck !== undefined) {
      fields.lastCheck = { ...memory.tryLast.lastCheck };
    }
    if (memory.tryLast.lastSubmit !== undefined) {
      fields.lastSubmit = { ...memory.tryLast.lastSubmit };
    }
    fields.recording = adapter.recording();
    fields.showing = adapter.showing();
    fields.settings = { trySubmission: shared.host.featureOn("try-it") ? scope.controller.trySubmission() : null, sources: sourcesState(scope.controller) };
    fields.next = [NEXT.read];
    return finish("read", adapter, fields, false);
  };

  // ---- fill --------------------------------------------------------------------------------

  /** One answer that read and may be written. */
  interface Accepted {
    path: string;
    id: string;
    kind: FieldKind;
    value: unknown;
    matched?: "label";
    /** A whole table: its rows, its columns' keys and the rows it holds now. */
    table?: { collection: string; rows: Record<string, unknown>[]; keys: string[]; have: number };
    label: string;
  }

  const fill = async (scope: BuilderCallScope, ui: BuilderToolUi, adapter: TryItAdapter, input: Input, started: boolean): Promise<ToolData> => {
    const answers = input.answers as Record<string, unknown>;
    const runtime = runtimeOf(ui, adapter);
    const index = await indexTried(runtime);
    checkSignal(scope.ctx, started);
    const locale = index.locale;
    const focused = adapter.focusedPath();
    const typed = typedOf(adapter);
    const refused: Array<ItemRefusal & { path: string }> = [];
    const accepted: Accepted[] = [];
    const refuse = (path: string, item: ItemRefusal): void => {
      refused.push({ path, ...item });
    };
    for (const [ref, raw] of Object.entries(answers)) {
      const resolved = resolveTried(ref, index);
      if (resolved === undefined) {
        refuse(ref, unknownFieldRefusal(ref, index));
        continue;
      }
      const writability = writabilityOfPath(resolved, index);
      if (!writability.writable && writability.why !== undefined) {
        refuse(resolved.path, notWritableRefusal(resolved.path, writability.why, writability.unfillableKind));
        continue;
      }
      if (resolved.row !== undefined && !resolved.row.exists) {
        refuse(resolved.path, noSuchRowRefusal(resolved.row.collection, resolved.row.index, rowsOf(typed.values, resolved.row.collection).length));
        continue;
      }
      const model = resolved.model;
      const kind = kindOfNode(model);
      const label = model.label;
      if (kind === "collection") {
        const collection = collectionOf(model);
        const columns: FieldColumn[] = columnsOf(model, index);
        const rows = coerceRowsAnswer(raw, collection, columns, (column) => index.modelById.get(column.id), {
          locale,
          acceptsFreeText: (column) => {
            const template = index.modelById.get(column.id);
            return template !== undefined && acceptsFreeText(template.node);
          }
        });
        if (!rows.ok) {
          refuse(collection, answerRefusal(rows.problem));
          continue;
        }
        const have = rowsOf(typed.values, collection).length;
        const operations = rowOperationsOf(model.node);
        if ((rows.rows.length > have && !operations.add) || (rows.rows.length < have && !operations.remove)) {
          refuse(collection, rowsLockedRefusal(collection, "replace"));
          continue;
        }
        const bounds = rowBoundsOf(model, runtime);
        if (rows.rows.length > rowCapOf(bounds) || rows.rows.length < bounds.min) {
          refuse(collection, rowsLimitRefusal(collection, bounds, have, rows.rows.length));
          continue;
        }
        const typedThere = personCells(adapter, collection);
        if (typedThere.length > 0) {
          refuse(collection, personDataRefusal(collection, label, undefined, typedThere, true));
          continue;
        }
        if (focused !== undefined && focused.startsWith(`${collection}[`)) {
          refuse(collection, fieldInUseRefusal(focused, label));
          continue;
        }
        accepted.push({ path: collection, id: model.id, kind, value: rows.rows, table: { collection, rows: rows.rows, keys: columns.map((column) => column.key), have }, label });
        continue;
      }
      const read = coerceAnswer(model, kind, raw, resolved.path, { locale, acceptsFreeText: acceptsFreeText(model.node) });
      if (!read.ok) {
        refuse(resolved.path, answerRefusal(read.problem));
        continue;
      }
      if (focused !== undefined && focused === resolved.path) {
        refuse(resolved.path, fieldInUseRefusal(resolved.path, label));
        continue;
      }
      const item: Accepted = { path: resolved.path, id: model.id, kind, value: read.value, label };
      if (read.matched === "label") {
        item.matched = "label";
      }
      accepted.push(item);
    }
    if (accepted.length === 0) {
      throw new ToolRefusal("nothing-written", started ? "Every answer was refused; nothing was written (Try it is now on)." : "Every answer was refused; nothing was written.", "See each refusal's hint.", {
        refused
      });
    }
    checkSignal(scope.ctx, started);
    // Copied now: a runtime may keep one map and fold the next recompute into it.
    const visibleBefore = new Map([...runtime.effectiveStatesMap()].map(([id, state]) => [id, state.visible]));
    const requiredBefore = new Map(runtime.requiredMap());
    const written: NonNullable<TryItResult["written"]> = [];
    const writtenIds: string[] = [];
    for (const item of accepted) {
      try {
        if (item.table !== undefined) {
          writeTable(runtime, item.table);
          for (const key of tableKeys(runtime, item.table.collection)) {
            memory.tried.delete(key);
          }
          remember(runtime, tableKeys(runtime, item.table.collection));
        } else {
          runtime.setValue(item.path, item.value);
          remember(runtime, [item.path]);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const expected = item.table !== undefined ? "an array of row objects" : "a value the field accepts";
        refuse(item.path, {
          code: "invalid-value",
          message: `The tried form refused the value for '${item.path}': ${cutString(message, 300)}`,
          hint: `Pass ${expected} for \`${item.path}\`.`,
          details: { path: item.path, kind: item.kind, expected, got: cutString(message, 200) }
        });
        continue;
      }
      const stored = item.table !== undefined ? rowsOf(runtime.state().values, item.table.collection) : runtime.state().values[item.path];
      const entry: NonNullable<TryItResult["written"]>[number] = { path: item.path, value: item.table !== undefined ? stored : echoed(stored) };
      const model = index.modelById.get(item.id);
      const display = model !== undefined ? displayOf(model, item.kind, stored) : undefined;
      if (display !== undefined) {
        entry.display = display;
      }
      if (item.matched === "label") {
        entry.matched = "label";
      }
      written.push(entry);
      writtenIds.push(item.id);
    }
    if (written.length === 0) {
      throw new ToolRefusal("nothing-written", "Every answer was refused; nothing was written.", "See each refusal's hint.", { refused });
    }
    // What the answers changed around them: fields shown or made required (paths, in document order).
    const statesAfter = runtime.effectiveStatesMap();
    const requiredAfter = runtime.requiredMap();
    const revealed: string[] = [];
    const nowRequired: string[] = [];
    const visibleAfter = (id: string, fallback: boolean): boolean => statesAfter.get(id)?.visible ?? fallback;
    for (const model of listedModels(index)) {
      const path = kindOfNode(model) === "collection" ? collectionOf(model) : model.valuePath;
      const wasVisible = shownNow(index, model, visibleBefore.get(model.id) ?? model.visible);
      const isVisible = shownNow(index, model, visibleAfter(model.id, model.visible));
      if (!wasVisible && isVisible && revealed.length < LISTED_PATHS_CAP) {
        revealed.push(path);
      }
      // A field the answers revealed that is required now became required for the person too.
      const wasRequired = wasVisible && requiredBefore.get(model.id) === true;
      if (isVisible && requiredAfter.get(model.id) === true && !wasRequired && nowRequired.length < LISTED_PATHS_CAP && !written.some((entry) => entry.path === path)) {
        nowRequired.push(path);
      }
    }
    // The problems now on the written fields: the errors the tried form shows on them, and a
    // required one left empty (what Submit would refuse); the full check is `check`'s.
    const after = await indexTried(runtime);
    const ids = new Set(writtenIds);
    const { problems } = errorProblems(after, ids);
    const values = runtime.state().values;
    for (const item of accepted) {
      const model = after.modelById.get(item.id);
      if (model === undefined || item.table !== undefined || !ids.has(item.id)) {
        continue;
      }
      if (requiredAfter.get(item.id) === true && visibleAfter(item.id, model.visible) && !nonEmpty(values[item.path]) && !problems.some((problem) => problem.componentId === item.id)) {
        problems.push(requiredProblem(model, item.path));
      }
    }
    // A journey's other pages: a field written there landed off-screen (the shown page does not
    // draw it; `read` lists it `visible: false`), so the model is told, and only a field of the
    // shown page is scrolled to; the page's own checks run on `navigate`, as the renderer says.
    const onPage = index.onPage;
    const shownIds = onPage === undefined ? writtenIds : writtenIds.filter((id) => onPage.has(id));
    showTried(ui, writtenIds, scope.words.plural("agent.did.tryFill", written.length, { count: written.length }), shownIds[0]);
    const fields: Partial<TryItResult> & { changed: boolean } = { changed: true, written, problems: problems.slice(0, 100), problemCount: problems.length };
    if (shownIds.length < writtenIds.length) {
      fields.note = [OFF_PAGE_NOTE];
    }
    if (refused.length > 0) {
      fields.refused = refused;
    }
    if (revealed.length > 0) {
      fields.revealed = revealed;
    }
    if (nowRequired.length > 0) {
      fields.nowRequired = nowRequired;
    }
    const requiredNext = nowRequired.length === 1 ? `Fill ${nowRequired[0] as string} next: it became required.` : `Fill ${nowRequired.join(", ")} next: they became required.`;
    fields.next = nowRequired.length > 0 ? [requiredNext, NEXT.fill[0]] : [...NEXT.fill];
    return finish("fill", adapter, fields, started);
  };

  /**
   * A whole table written as the person would: the rows it keeps are rewritten cell by cell
   * (a column the row object leaves out is cleared), extra rows are added with their answers,
   * rows past the new count are removed from the end.
   */
  const writeTable = (runtime: TriedRuntime, table: NonNullable<Accepted["table"]>): void => {
    const { collection, rows, keys, have } = table;
    const kept = Math.min(rows.length, have);
    for (let row = 0; row < kept; row += 1) {
      const entry = rows[row] as Record<string, unknown>;
      for (const key of keys) {
        runtime.setValue(`${collection}[${row}].${key}`, entry[key]);
      }
    }
    for (let row = have; row < rows.length; row += 1) {
      if (runtime.addRow === undefined) {
        throw new Error("Rows cannot be added to this table in Try it.");
      }
      runtime.addRow(collection, { ...(rows[row] as Record<string, unknown>) });
    }
    for (let row = have - 1; row >= rows.length; row -= 1) {
      if (runtime.removeRow === undefined) {
        throw new Error("Rows cannot be removed from this table in Try it.");
      }
      runtime.removeRow(collection, row);
    }
  };

  // ---- edit_rows ---------------------------------------------------------------------------

  const editRows = async (scope: BuilderCallScope, ui: BuilderToolUi, adapter: TryItAdapter, input: Input, started: boolean): Promise<ToolData> => {
    const runtime = runtimeOf(ui, adapter);
    const index = await indexTried(runtime);
    checkSignal(scope.ctx, started);
    const ref = input.collection as string;
    const resolved = resolveTried(ref, index);
    if (resolved === undefined) {
      throw asRefusal(unknownFieldRefusal(ref, index));
    }
    const model = resolved.row !== undefined ? (index.modelById.get(resolved.row.ownerId) ?? resolved.model) : resolved.model;
    if (kindOfNode(model) !== "collection") {
      throw badInput([{ key: "collection", expected: "the value path of a table (a field whose rows try_it { action: 'read' } lists)" }]);
    }
    const collection = collectionOf(model);
    if (isNestedCollection(model)) {
      throw asRefusal(notWritableRefusal(collection, "unfillable", "nested-rows"));
    }
    const writability = writabilityOfPath({ model, path: collection, id: model.id }, index);
    if (!writability.writable && writability.why !== undefined) {
      throw asRefusal(notWritableRefusal(collection, writability.why, writability.unfillableKind));
    }
    const focused = adapter.focusedPath();
    if (focused !== undefined && focused.startsWith(`${collection}[`)) {
      throw asRefusal(fieldInUseRefusal(focused, model.label));
    }
    const operations = rowOperationsOf(model.node);
    const bounds = rowBoundsOf(model, runtime);
    const have = rowsOf(runtime.state().values, collection).length;
    const fields: Partial<TryItResult> & { changed: boolean } = { changed: true };
    if (input.rowAction === "add") {
      if (!operations.add || runtime.addRow === undefined) {
        throw asRefusal(rowsLockedRefusal(collection, "add"));
      }
      if (have + 1 > rowCapOf(bounds)) {
        throw asRefusal(rowsLimitRefusal(collection, bounds, have, have + 1));
      }
      const values = (input.values as Record<string, unknown> | undefined) ?? {};
      const columns = columnsOf(model, index);
      const first: Record<string, unknown> = {};
      const refused: Array<ItemRefusal & { path: string }> = [];
      for (const [key, raw] of Object.entries(values)) {
        const column = columns.find((candidate) => candidate.key === key);
        const cellPath = `${collection}[${have}].${key}`;
        if (column === undefined) {
          refused.push({ path: cellPath, ...unknownFieldRefusal(cellPath, index) });
          continue;
        }
        const template = index.modelById.get(column.id);
        if (template === undefined) {
          first[key] = raw;
          continue;
        }
        const read = coerceAnswer(template, column.kind, raw, cellPath, { locale: index.locale, acceptsFreeText: acceptsFreeText(template.node) });
        if (!read.ok) {
          refused.push({ path: cellPath, ...answerRefusal(read.problem) });
          continue;
        }
        first[key] = read.value;
      }
      checkSignal(scope.ctx, started);
      let added: number;
      try {
        added = runtime.addRow(collection, first);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("holds the most rows")) {
          throw asRefusal(rowsLimitRefusal(collection, bounds, have, have + 1));
        }
        throw asRefusal(rowsLockedRefusal(collection, "add"));
      }
      const cells = Object.keys(first).map((key) => `${collection}[${added}].${key}`);
      remember(runtime, cells);
      const written: NonNullable<TryItResult["written"]> = [];
      const valuesNow = runtime.state().values;
      for (const path of cells) {
        if (valuesNow[path] !== undefined) {
          written.push({ path, value: echoed(valuesNow[path]) });
        }
      }
      if (written.length > 0) {
        fields.written = written;
      }
      if (refused.length > 0) {
        fields.refused = refused;
      }
      fields.rows = { collection, count: rowsOf(runtime.state().values, collection).length, added: 1 };
      fields.next = [NEXT.rowAdded];
    } else {
      const row = input.index as number;
      if (row >= have) {
        throw asRefusal(noSuchRowRefusal(collection, row, have));
      }
      if (!operations.remove || runtime.removeRow === undefined) {
        throw asRefusal(rowsLockedRefusal(collection, "remove"));
      }
      if (have - 1 < bounds.min) {
        throw asRefusal(rowsLimitRefusal(collection, bounds, have, have - 1));
      }
      const typedThere = personCells(adapter, collection, row);
      if (typedThere.length > 0 && input.force !== true) {
        throw asRefusal(personDataRefusal(collection, model.label, row, typedThere, false));
      }
      checkSignal(scope.ctx, started);
      try {
        runtime.removeRow(collection, row);
      } catch {
        throw asRefusal(rowsLockedRefusal(collection, "remove"));
      }
      // The rows below moved up by one: the agent's own marks follow them.
      shiftTried(collection, row);
      fields.rows = { collection, count: rowsOf(runtime.state().values, collection).length, removed: 1 };
      fields.next = [NEXT.fill[0]];
    }
    showTried(ui, [model.id], scope.words.text("agent.did.tryRows", { label: cutString(model.label, 200) }), model.id);
    return finish("edit_rows", adapter, fields, started);
  };

  /** After row `removed` of `collection` went: the agent's marks of the rows below move up one; the removed row's go. */
  const shiftTried = (collection: string, removed: number): void => {
    const prefix = `${collection}[`;
    const moved: Array<[string, string]> = [];
    for (const [key, value] of [...memory.tried]) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const close = key.indexOf("]", prefix.length);
      const row = Number(key.slice(prefix.length, close));
      if (!Number.isInteger(row) || row < removed) {
        continue;
      }
      memory.tried.delete(key);
      if (row > removed) {
        moved.push([`${prefix}${row - 1}${key.slice(close)}`, value]);
      }
    }
    for (const [key, value] of moved) {
      memory.tried.set(key, value);
    }
  };

  // ---- navigate ----------------------------------------------------------------------------

  const navigate = async (scope: BuilderCallScope, ui: BuilderToolUi, adapter: TryItAdapter, input: Input, started: boolean): Promise<ToolData> => {
    const runtime = runtimeOf(ui, adapter);
    const view = runtime.journeyView?.();
    const workspace = adapter.where().workspace;
    if (view === undefined) {
      // A journey designer's Try it whose session did not come up: its chunk failed.
      throw workspace === "journeys" ? chunkUnavailable("journey-preview", "failed") : notAJourney(workspace);
    }
    const locale = runtime.state().locale;
    const to = input.to as string;
    const pageIdOf = (nodeId: string): string => adapter.pageIdOf(nodeId) ?? nodeId;
    const pagesListed = (current: JourneyView): Array<{ id: string; title: string }> =>
      current.journey.pages.slice(0, PAGES_CAP).map((page) => ({ id: pageIdOf(page.id), title: pageTitle(page, locale, pageIdOf(page.id), runtime, current.journeyId) }));
    const atEnd = (current: JourneyView): ToolRefusal =>
      new ToolRefusal("at-end", "This is the journey's last page.", "This is the last page: call try_it { action: 'check' } and then 'submit'.", { page: pageIdOf(current.pageId) });
    const atStart = (current: JourneyView): ToolRefusal => new ToolRefusal("at-start", "This is the journey's first page.", "There is no earlier page.", { page: pageIdOf(current.pageId) });
    let move: (() => Promise<JourneyNavigationResult>) | undefined;
    if (to === "next") {
      if (view.final) {
        throw atEnd(view);
      }
      move = runtime.nextPage?.bind(runtime);
    } else if (to === "back") {
      // Back is the runtime's: on the way back from a Change link it may lead on from the first page.
      if (view.backPageId === undefined) {
        throw atStart(view);
      }
      move = runtime.previousPage?.bind(runtime);
    } else {
      // A page id as the journey is written: the node its preview runs it under.
      const known = view.journey.pages.some((page) => page.id === to) && adapter.pageIdOf(to) === undefined;
      const node = adapter.nodeIdOf(to) ?? (known ? to : undefined);
      if (node === undefined) {
        throw new ToolRefusal("unknown-page", `No page of the journey is named '${to}'.`, "Use 'next', 'back', or one of the listed page ids.", { to, pages: pagesListed(view) });
      }
      if (node === view.pageId) {
        return finish("navigate", adapter, { changed: false, moved: false, next: [NEXT.navigate] }, started);
      }
      const goToPage = runtime.goToPage;
      // From a Check answers page a move to another page is its Change link: Continue then comes back.
      const direction = view.kind === "review" ? "change" : "jump";
      move = goToPage === undefined ? undefined : () => goToPage.call(runtime, node, { direction });
    }
    if (move === undefined) {
      throw notAJourney(workspace);
    }
    checkSignal(scope.ctx, started);
    // No focus moves while the person's focus is elsewhere: the tried renderer's
    // quiet page focus, released once the move settles (after a timed-out one too).
    const release = adapter.quietPageFocus();
    let moving: Promise<JourneyNavigationResult>;
    try {
      moving = move();
    } catch (error) {
      release();
      throw error;
    }
    void moving.then(release, release);
    const settled = await within(settledOf(moving), NAVIGATE_BUDGET_MS);
    if (settled === undefined) {
      throw timedOut(NAVIGATE_BUDGET_MS);
    }
    if (!settled.value.ok) {
      throw settled.value.error;
    }
    const outcome = settled.value.value;
    const now = runtime.journeyView?.() ?? view;
    if (!outcome.ok) {
      switch (outcome.reason) {
        case "at-end":
        case "exit":
          throw atEnd(now);
        case "at-start":
          throw atStart(now);
        case "no-journey":
          throw notAJourney(workspace);
        default: {
          const index = await indexTried(runtime);
          const members = new Set(now.members);
          const { problems } = errorProblems(index, members);
          const details: Record<string, unknown> = { reason: outcome.reason ?? "blocked", problems: problems.slice(0, BLOCKED_PROBLEMS_CAP) };
          if (outcome.message !== undefined) {
            details.message = cutString(outcome.message, 300);
          }
          throw new ToolRefusal(
            "blocked",
            `The page '${pageTitle(now.page, locale, pageIdOf(now.pageId), runtime, now.journeyId)}' did not let the tried form move (${outcome.reason ?? "blocked"}), so it stayed there.`,
            "Fix the answers listed with try_it { action: 'fill' }, then move again.",
            details
          );
        }
      }
    }
    const moved = now.pageId !== view.pageId;
    return finish("navigate", adapter, { changed: moved, moved, next: [NEXT.navigate] }, started);
  };

  // ---- check -------------------------------------------------------------------------------

  const check = async (scope: BuilderCallScope, ui: BuilderToolUi, adapter: TryItAdapter, started: boolean): Promise<ToolData> => {
    checkSignal(scope.ctx, started);
    const outcome: TryCheckOutcome = await act(ui, adapter, () => adapter.check(), CHECK_BUDGET_MS, "check");
    const runtime = triedRuntime(adapter);
    const index = runtime !== undefined ? await indexTried(runtime) : undefined;
    const problems: TryProblem[] = checkProblems(outcome.problems, index);
    const problemCount = outcome.problems.length;
    memory.tryLast.lastCheck = { at: Date.now(), problemCount };
    return finish(
      "check",
      adapter,
      {
        changed: false,
        problems,
        problemCount,
        serverChecks: outcome.server === "ran" ? "on" : outcome.server,
        next: [problemCount > 0 ? NEXT.checkProblems : NEXT.checkClean]
      },
      started
    );
  };

  // ---- submit ------------------------------------------------------------------------------

  const submit = async (scope: BuilderCallScope, ui: BuilderToolUi, adapter: TryItAdapter, started: boolean): Promise<ToolData> => {
    checkSignal(scope.ctx, started);
    const answered = await act(ui, adapter, () => adapter.submit(), SUBMIT_BUDGET_MS, "Submit");
    if ("state" in answered) {
      throw new ToolRefusal("busy", "A Submit is already running in Try it.", `Wait a moment and call ${DESCRIBE} before retrying.`, { because: "try-submit" });
    }
    const outcome: TrySubmitOutcome = answered;
    const settings = scope.controller.trySubmission();
    const submitted: NonNullable<TryItResult["submitted"]> = { outcome: outcome.outcome, standIn: true };
    if (typeof outcome.reference === "string" && outcome.reference !== "") {
      submitted.reference = outcome.reference;
    }
    if (outcome.outcome === "refused") {
      submitted.message = cutString(settings.refusalMessage.trim() === "" ? TRY_SUBMISSION_FAILED_MESSAGE : settings.refusalMessage, 500);
    } else if (outcome.outcome === "failed") {
      submitted.message = TRY_SUBMISSION_FAILED_MESSAGE;
    } else if (outcome.outcome === "accepted") {
      if (settings.receipt.message.trim() !== "") {
        submitted.message = cutString(settings.receipt.message, 500);
      }
      if (settings.afterAccept === "readonly") {
        submitted.readOnlyNow = true;
      }
    }
    memory.tryLast.lastSubmit = lastSubmitOf(outcome);
    const fields: Partial<TryItResult> & { changed: boolean } = { changed: true, submitted, serverChecks: adapter.serverChecks() };
    if (outcome.outcome === "invalid") {
      const runtime = triedRuntime(adapter);
      if (runtime !== undefined) {
        const { problems, problemCount } = errorProblems(await indexTried(runtime));
        fields.problems = problems;
        fields.problemCount = problemCount;
      }
      fields.next = [NEXT.checkProblems];
    } else {
      fields.next = [NEXT.submitted];
    }
    return finish("submit", adapter, fields, started);
  };

  // ---- clear -------------------------------------------------------------------------------

  const clear = (scope: BuilderCallScope, adapter: TryItAdapter, input: Input): ToolData => {
    if (triedRuntime(adapter) === undefined) {
      return finish("clear", adapter, { changed: false, cleared: { byPerson: 0, byAssistant: 0 }, next: [NEXT.clear] }, false);
    }
    const counts = typedCounts(typedOf(adapter), memory.tried);
    if (counts.byPerson > 0 && input.discardTriedAnswers !== true) {
      throw new ToolRefusal(
        "tried-answers",
        `The person typed ${counts.byPerson} answers in Try it; nothing was cleared.`,
        `The person typed ${counts.byPerson} answers in Try it; tell them they will be cleared, then call again with discardTriedAnswers: true.`,
        { byPerson: counts.byPerson, byAssistant: counts.byAssistant }
      );
    }
    checkSignal(scope.ctx, false);
    adapter.clear();
    memory.tried.clear();
    return finish(
      "clear",
      adapter,
      { changed: counts.byPerson + counts.byAssistant > 0, cleared: { byPerson: counts.byPerson, byAssistant: counts.byAssistant }, next: [NEXT.clear] },
      false
    );
  };

  // ---- settings ----------------------------------------------------------------------------

  const settings = (scope: BuilderCallScope, adapter: TryItAdapter | undefined, input: Input): ToolData => {
    const controller = scope.controller;
    const plan = planSettings(scope, input);
    const before = JSON.parse(JSON.stringify(controller.trySubmission())) as ReturnType<typeof controller.trySubmission>;
    const changedKeys = plan.update !== undefined ? submissionChanges(before, previewSubmission(before, plan.update)) : [];
    const simulated = controller.simulatedDataSources();
    const sources = plan.sources
      .map((source) => {
        const was = simulated.get(source.sourceId);
        return { sourceId: source.sourceId, items: source.items, before: was === undefined ? undefined : (JSON.parse(JSON.stringify(was)) as typeof was) };
      })
      .filter((source) => canonicalJson(source.before ?? null) !== canonicalJson(source.items ?? null));
    checkSignal(scope.ctx, false);
    const fields: Partial<TryItResult> & { changed: boolean } = { changed: changedKeys.length > 0 || sources.length > 0 };
    if (fields.changed) {
      shared.write(scope, () => {
        if (changedKeys.length > 0 && plan.update !== undefined) {
          controller.setTrySubmission(plan.update);
        }
        for (const source of sources) {
          controller.setSimulatedDataSource(source.sourceId, source.items);
        }
      });
      // Journaled: Undo all, Stop and the notice's Undo put back what was
      // replaced, part by part, unless the person changed that part since.
      shared.journal.record(scope, {
        kind: "settings",
        ...(changedKeys.length > 0 ? { trySubmission: { before } } : {}),
        ...(sources.length > 0 ? { sources: sources.map((source) => ({ sourceId: source.sourceId, before: source.before })) } : {})
      });
      const payload = shared.payload(scope, 0);
      Object.assign(fields, payload);
      fields.undo = { ...payload.undo, journaled: true };
      fields.reverse = reverseOf(before, changedKeys, sources);
      shared.show(scope, { ids: [], announce: scope.words.text("agent.did.trySettings"), undoSteps: 0, journaled: { call: scope.call } });
    }
    fields.settingsChanged = [...changedKeys, ...sources.map((source) => `source:${source.sourceId}`)];
    fields.settings = { trySubmission: shared.host.featureOn("try-it") ? controller.trySubmission() : null, sources: sourcesState(controller) };
    fields.next = [NEXT.settings];
    const result = finish("settings", adapter, fields, false);
    if (plan.warnings.length > 0) {
      result.warnings = [...plan.warnings];
    }
    return result;
  };

  // ---- the call ----------------------------------------------------------------------------

  /** The grammar the schema subset cannot say: every problem at once, before anything else. */
  const grammar = (action: TryItAction, input: Input): string[] => {
    const checked = shared.folded(input, { key: "action", action, needs: NEEDS, reads: READS, always: ["builder"] });
    const problems = [...checked.problems];
    const warnings = [...checked.warnings];
    if (action === "fill" && typeof input.answers === "object" && input.answers !== null) {
      const entries = Object.entries(input.answers as Record<string, unknown>);
      if (entries.length > ANSWERS_CAP) {
        throw tooLarge("answers", ANSWERS_CAP, entries.length);
      }
      if (entries.length === 0) {
        problems.push({ key: "answers", expected: "at least one value path" });
      }
      for (const [path, value] of entries) {
        if (path.length > TRY_PATH_MAX) {
          problems.push({ key: `answers.${path.slice(0, 40)}…`, expected: `a value path of at most ${TRY_PATH_MAX} characters` });
        } else if (!TRY_PATH_PATTERN.test(path)) {
          problems.push({ key: `answers.${path}`, expected: "a value path: segments of letters, digits, _ and -, joined by dots, with an optional [n] row index" });
        } else if (Array.isArray(value) && value.length > TABLE_ROWS_CAP) {
          throw tooLarge(`answers.${path}`, TABLE_ROWS_CAP, value.length);
        }
      }
    }
    if (action === "edit_rows") {
      if (input.rowAction === "remove" && input.index === undefined) {
        problems.push({ key: "index", expected: "required for rowAction 'remove'" });
      }
      if (input.rowAction === "add") {
        for (const key of ["index", "force"]) {
          if (input[key] !== undefined) {
            warnings.push(`ignored argument for rowAction 'add': ${key}`);
          }
        }
        const values = input.values;
        if (typeof values === "object" && values !== null && Object.keys(values).length > ANSWERS_CAP) {
          throw tooLarge("values", ANSWERS_CAP, Object.keys(values).length);
        }
      }
      if (input.rowAction === "remove" && input.values !== undefined) {
        warnings.push("ignored argument for rowAction 'remove': values");
      }
    }
    if (problems.length > 0) {
      throw badInput(problems);
    }
    return warnings;
  };

  return {
    async run(input, ctx) {
      const action = input.action as TryItAction;
      const warnings = grammar(action, input);
      const scope = shared.scope(ctx);
      const ui = shared.host.ui;
      if (ui === undefined) {
        throw noUi();
      }
      const adapter = ui.tryIt?.();
      if (adapter !== undefined) {
        listen(adapter);
      }
      // The feature (guard 3, before the adapter): every action but read, and a settings call
      // that only sets stand-in lists (they feed the edit canvas's preview too), needs Try it. A
      // host that hands no adapter while the feature is off is answered by the feature, not `no-ui`.
      if (!shared.host.featureOn("try-it") && action !== "read" && !(action === "settings" && input.trySubmission === undefined)) {
        throw featureOff();
      }
      if (adapter === undefined && action !== "settings") {
        throw noUi();
      }
      let result: ToolData;
      if (action === "read") {
        result = await read(scope, adapter as TryItAdapter, input);
      } else if (action === "settings") {
        result = settings(scope, adapter, input);
      } else {
        const tried = adapter as TryItAdapter;
        if (HELD_BY_RECORDING.has(action)) {
          heldByPerson(tried);
        }
        if (action === "clear") {
          result = clear(scope, tried, input);
        } else {
          if (action === "navigate" && !tried.trying() && tried.where().workspace !== "journeys") {
            // Nothing to move between: never start Try it only to say so.
            throw notAJourney(tried.where().workspace);
          }
          const started = STARTING.has(action) ? await begin(scope, ui, tried) : false;
          switch (action) {
            case "fill":
              result = await fill(scope, ui, tried, input, started);
              break;
            case "edit_rows":
              result = await editRows(scope, ui, tried, input, started);
              break;
            case "navigate":
              result = await navigate(scope, ui, tried, input, started);
              break;
            case "check":
              result = await check(scope, ui, tried, started);
              break;
            default:
              result = await submit(scope, ui, tried, started);
          }
        }
      }
      if (warnings.length > 0) {
        result.warnings = [...warnings, ...((result.warnings as string[] | undefined) ?? [])];
      }
      return result;
    },
    dispose() {
      heard?.off();
      heard = undefined;
    }
  };
}

