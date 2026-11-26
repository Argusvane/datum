/**
 * What every builder tool shares: the per-call scope, the
 * person's state a write yields to, the writing guard that marks
 * the controller's events as the agent's, the undo bookkeeping, what a write shows the person
 * (selection, reveal, highlight, announcement, a notice with Undo), and the formula, outline, test-ref and committed-check helpers. The write,
 * check and tests tools call these and never re-implement them.
 *
 * Where per-target state lives: the session hooks and the controller subscription see no
 * `ToolContext`, so what they share with the tools (`ownSteps`, the session's depth, the Stop
 * flag, the identity / localization fingerprint) lives in the catalogue's {@link BuilderMemory},
 * one per registration, dropped by `reset()`. What only tools touch (`lastRun`, `runInFlight`,
 * the committed-check cache) lives in `ctx.state` under {@link STATE_KEYS}, which the registrar
 * clears on a rebuild and on unregister. Nothing per target lives in module scope.
 *
 * The new
 * write kinds and their yield rules (read on the active controller as well as the form's), the
 * outside journal of changes on no history, the layout followers, `around` for the modes' async
 * writes, the folded-action check, the agent's own Try it answers (`memory.tried`) and the last
 * save, and {@link SENTINEL_TOOLS}, the one place the lazy body modules take the builder
 * catalogue's sentinel tool names from.
 */
import type { SlotDefinition } from "../../core/schema/types.js";
import type { BuilderController, UnsavedChangesPrompt } from "../../builder/controller/builder-controller.js";
import type { BuilderWords } from "../../builder/logic/builder-texts.js";
import { ToolRefusal, type CatalogueLink, type ToolContext } from "../tool-types.js";
import { checkActionArgs } from "../folded-actions.js";
import { agentWords } from "./agent-texts-en.js";
import type { FormulaChecker } from "./formulas.js";
import type { BuilderToolHost } from "./host.js";
import { buildOutline, closestId, type Outline, type OutlineOptions } from "./outline.js";
import { createOutsideJournal, type LayoutFollower, type OutsideEntry, type OutsideJournal } from "./outside-journal.js";
import type { TestRefs } from "./test-refs.js";
import type { Finding, UndoInfo, WritePayload } from "./types.js";

/**
 * The builder catalogue's sentinel tool names: guard 15 counts each in
 * exactly one `datum-builder-*` chunk, the agent's main one. The lazy body modules
 * (`agentpart-*.ts`, `save-tool.ts`) spell them only through this constant, which stays in the
 * main chunk (this module, and the `save` descriptor in tools.ts, read it), so a hint such as
 * `unknown-source`'s "(describe_builder dataSourceIds)" never copies the word into a body chunk.
 */
export const SENTINEL_TOOLS = { describeBuilder: "describe_builder", listComponentTypes: "list_component_types" } as const;

/** One tool call's view of the builder: the controller read once, the words widened with AGENT_EN, a per-call cache. */
export interface BuilderCallScope {
  ctx: ToolContext<BuilderToolHost>;
  /** `host.controller()` read once per call. */
  controller: BuilderController;
  /** `host.words()` widened with AGENT_EN (`agentWords`). */
  words: BuilderWords;
  /** What one call computes once and reads again (the formula fields, the data paths). Dropped with the call. */
  cache: Map<string, unknown>;
  /** The declared slots per type, kept across calls until the component definitions change (outline.ts). */
  slots: SlotsCache;
  /**
   * This call's id: the outside journal stamps its entries with it, so the notice under
   * a journaled write runs exactly that call's entries. Unique per registration, across resets.
   */
  call: string;
}

/** Where the outline keeps each type's declared slots between calls: the catalogue memory's. */
export interface SlotsCache {
  value: { controller: BuilderController; generation: number; slots: ReadonlyMap<string, readonly SlotDefinition[]> } | undefined;
  generation(): number;
}

/**
 * The write a tool is about to make, for {@link BuilderToolsShared.yieldToPerson}: `tree` is
 * add_components, move_component and duplicate_component; the others are their own tools'.
 * Also `try` (Try it about to start), `languages`,
 * `catalog` (a journey or layout list change, or opening a document), `save`, `identity` and
 * `fields` (`create_form_fields`). The new kinds never refuse `wrong-mode`; only `fields` refuses
 * `try-it-on`.
 */
export type WriteKind =
  | "tree"
  | "replace"
  | "remove"
  | "properties"
  | "rename"
  | "history"
  | "tests"
  | "try"
  | "languages"
  | "catalog"
  | "save"
  | "identity"
  | "fields";

/** The additional kinds: their own yield rules, read on the active controller too. */
const ADDITIONAL_KINDS: ReadonlySet<WriteKind> = new Set<WriteKind>(["try", "languages", "catalog", "save", "identity", "fields"]);

/** What an additional kind's yield also reads. */
export interface YieldOptions {
  ids?: readonly string[];
  vanishing?: ReadonlySet<string>;
  /**
   * The controller to check beside the active one and the form's (the form's
   * by default): for `catalog`, the document's own controller (a journey's or a
   * layout's) when the act concerns one that is open, whose prompt, drafts and leave guard count.
   * `fields` (`create_form_fields`, which passes `{ controller: form }`) reads the
   * layout's: this controller when it names one other than the form's, else the active one (the
   * PDF designer's open layout); never the form's own drafts beyond its selection's.
   */
  controller?: BuilderController;
  /** The id of the document `controller` edits, for the refusal's `"<documentId>/<nodeId>"`. */
  documentId?: string;
}

/** The `ctx.state` keys the tools keep per target. */
export const STATE_KEYS = {
  /** `run_tests`: the last run's status per test id. */
  lastRun: "lastRun",
  /** `run_tests`: a run is in flight (`busy { run-tests }` at once). */
  runInFlight: "runInFlight",
  /** The committed-check findings, per revision. */
  findings: "findings"
} as const;

/** The open session's counts, kept from the controller's mutation events while it is open. */
export interface SessionMemory {
  /**
   * History steps above the session's start: execute +1, undo -1, redo +1. Not clamped: below 0
   * the history stands under the start (an undo beyond the session's own steps), and a redo
   * must bring it back up before an Undo all reaches the session's steps again. 0 when the
   * history lost its undo side (a step that failed) or was reseeded.
   */
  depth: number;
  /** History entries pushed while it was open (undos do not take them back). */
  steps: number;
  added: Set<string>;
  changed: Set<string>;
  removed: Set<string>;
  tests: Set<string>;
  /** The catalogue's own id for this session (the registrar's is not given to the hooks): the outside journal's scope. */
  token: number;
  /** Journal entries of this session dropped past the cap (counted in end_session's warnings). */
  dropped: number;
}

/**
 * The catalogue's memory for one registration (see the file comment): created by
 * `createBuilderTools`, emptied by `reset()`. The tools read it through
 * {@link BuilderToolsShared.memory}; only the catalogue and the session hooks write it.
 */
export interface BuilderMemory {
  /** Up while the catalogue runs controller calls: the events they cause are the agent's. */
  writing: boolean;
  /** History steps the running write pushed (execute +1, undo -1, redo +1). */
  callSteps: number;
  /** The agent's steps on top of the history since the person's last own step. */
  ownSteps: number;
  /** How far a redo may bring `ownSteps` back. */
  ownCeiling: number;
  session: SessionMemory | undefined;
  /** The person pressed Stop and has not allowed the assistant again (the registrar's latch, mirrored). */
  stopped: boolean;
  /** The open session's Stop, kept for `purposeChanged`. */
  onStop: (() => void) | undefined;
  /** The registrar's Allow again listener. */
  allowAgain: (() => void) | undefined;
  /**
   * The summary or paused banner an ended session left. `depth` is live, as the session's was:
   * every undo, redo and agent write after the end moves it, so the Undo all reaches the
   * session's start and never the person's earlier work; `shown` is the count the banner reads,
   * redrawn when `max(0, depth)` moves (session.ts `redrawBanner`).
   */
  banner: BannerMemory | undefined;
  /** What the last Undo all (Stop's included) took back. */
  lastUndoAll: number;
  link: CatalogueLink | undefined;
  /** Each component's signature and its place as of the last event: what a change ring entry names. */
  index: TreeIndex;
  /** Each test entry's source as of the last event: what a session counts as written. */
  testIndex: Map<string, string>;
  /** The silent identity / localization writes bump the revision through these. */
  fingerprint: { identity: string; localization: string };
  /** Ids the controller events named while a tracked run (the banner's Undo all) was going. */
  collect: Set<string> | undefined;
  /** `list_component_types`' list, kept until the component definitions change. */
  types: { controller: BuilderController; generation: number; value: unknown } | undefined;
  /** Bumped on an `init` or `preview` change: the component definitions may have changed. */
  generation: number;
  /** The declared slots per type (outline.ts), kept for one generation. */
  slots: SlotsCache["value"];
  /**
   * Every controller mutation event counts here: an undo loop tells a step that did nothing by
   * it, and a write's notice tells it is stale (the history moved since it was shown). A reseed
   * and `reset()` count too, and the count carries across `reset()`, so no stale notice matches.
   */
  mutations: number;
  /**
   * The in-flight `run_tests` call's cancel, the one slot a tool writes: set by
   * tests-tools.ts while its run goes, cleared by that run's end. `reset()` (a rebuild) and
   * unregister call it, so the old call answers `partial: true` with the rest pending and writes
   * no `lastRun`, instead of running on for up to its budget against a form that is gone.
   */
  cancelRun: (() => void) | undefined;

  // ---- the page's seams ----

  /**
   * The tried answers the agent wrote while Try it is on: path → canonical JSON of the value it
   * wrote. A dirty path whose value no longer matches is the person's. Emptied when Try it ends
   * (the next call that finds it off) and on a reseed.
   */
  tried: Map<string, string>;
  /** The outside journal (outside-journal.ts), oldest first, at most 100. */
  outside: OutsideEntry[];
  /** The agent's last accepted save: `already-saved` compares the revision. Undefined until one, and after a reseed. */
  lastSave: { revision: number; at: number } | undefined;
  /**
   * The agent's own `save` is waiting on the site now (save-tool.ts). It lives on the memory, not in
   * a module set, so no state outlives its registration; a reseed copies it, so a save still
   * running across one answers `busy` as before.
   */
  saving: boolean;
  /** The agent's last Check and anyone's last Submit in this Try it (`try_it { action: 'read' }`). */
  tryLast: {
    lastCheck?: { at: number; problemCount: number };
    lastSubmit?: { at: number; outcome: "accepted" | "invalid" | "refused" | "failed"; reference?: string };
  };
  /** Per PDF layout the agent wrote steps to: its steps on top of that layout's history. */
  layoutTop: Map<string, number>;
  /** The layout controllers the journal follows (outside-journal.ts `followLayout`). */
  layoutFollowers: Map<string, LayoutFollower>;
  /** The journal's sequence; carries across `reset()`. */
  outsideSeq: number;
  /** The call ids handed out (`BuilderCallScope.call`); carries across `reset()`, so no stale notice matches a new call. */
  callSeq: number;
  /** The session tokens handed out ({@link SessionMemory.token}). */
  sessionSeq: number;
  /** What the last Undo all kept, as warnings, for `end()` to hand on. */
  lastKept: string[];
}

/** What the summary or paused banner needs to be drawn again with a new count. */
export interface BannerMemory {
  /** Steps above the session's start (see {@link SessionMemory.depth}). */
  depth: number;
  /** The `undoAvailable` the banner reads now. */
  shown: number;
  summary?: string;
  paused?: true;
  onUndoAll(): void;
  /** The person's Dismiss: this banner's memory goes, so nothing draws it again. */
  onDismiss(): void;
  /** The ended session's token: its Undo all replays that session's outside-journal entries too. */
  token?: number;
}

/**
 * The tree as the diff between two events reads it: each component's own content and its
 * parent slot, and each slot's children in order. A component counts as changed when its
 * content or its slot changed, or when the component before it among those both trees hold
 * changed (a reorder); a sibling shifted by an insert or a removal does not.
 */
export interface TreeIndex {
  signatures: Map<string, string>;
  slots: Map<string, string[]>;
  slotOf: Map<string, string>;
}

/** A fresh memory (the registration's first, and every `reset()`). */
export function createMemory(previous?: BuilderMemory): BuilderMemory {
  return {
    writing: false,
    callSteps: 0,
    ownSteps: 0,
    ownCeiling: 0,
    session: undefined,
    stopped: false,
    onStop: undefined,
    allowAgain: previous?.allowAgain,
    banner: undefined,
    lastUndoAll: 0,
    link: previous?.link,
    index: { signatures: new Map(), slots: new Map(), slotOf: new Map() },
    testIndex: new Map(),
    fingerprint: { identity: "", localization: "" },
    collect: undefined,
    types: undefined,
    generation: (previous?.generation ?? 0) + 1,
    slots: undefined,
    mutations: (previous?.mutations ?? 0) + 1,
    cancelRun: undefined,
    tried: new Map(),
    outside: [],
    lastSave: undefined,
    saving: previous?.saving ?? false,
    tryLast: {},
    layoutTop: new Map(),
    layoutFollowers: new Map(),
    outsideSeq: previous?.outsideSeq ?? 0,
    callSeq: previous?.callSeq ?? 0,
    sessionSeq: previous?.sessionSeq ?? 0,
    lastKept: []
  };
}

/** What `describe_builder.blockedBy` reports: the person's-state checks a write yields to (prompt, draft, Try it, wrong mode) as of now. */
export interface Blockers {
  reasons: Array<"prompt" | "draft" | "try-it" | "wrong-mode">;
  draftComponentId?: string;
  mode?: string;
  triedPaths?: number;
}

/** What a successful write shows. */
export interface ShowRequest {
  /** The component to select (and reveal); left alone when the person's selection has a draft. */
  select?: string;
  /** Every id the write touched: highlighted. */
  ids: readonly string[];
  /** The sentence announced and shown in the notice (AGENT_EN words). */
  announce: string;
  /** The steps the notice's button takes back (or brings again, with `redo`). */
  undoSteps: number;
  /** The notice's button reads Redo and redoes (history's undo). */
  redo?: boolean;
  /**
   * The call whose outside-journal entries the notice's
   * button reverses (a write with `undo.journaled`), with the form steps of `undoSteps` if any;
   * `restore` labels it Restore (a document `remove_part` removed).
   */
  journaled?: { call: string; restore?: true };
  /** No button on the notice (a `save`: nothing in the page takes it back). */
  noButton?: true;
}

/** Names and meanings binding; members after `unknownComponent` were added later. */
export interface BuilderToolsShared {
  host: BuilderToolHost;
  /** host.controller() once; throws builder-not-ready { state: "loading" } as ToolRefusal when absent (the registrar normally answered first). */
  scope(ctx: ToolContext<BuilderToolHost>): BuilderCallScope;
  /**
   * The yield check for a write kind; throws ToolRefusal (unsaved-draft / wrong-mode /
   * try-it-on). The additional kinds read the prompt and drafts on
   * `ui.activeController()` and on the form's (and on `options.controller`), never refuse
   * `wrong-mode`, and refuse `try-it-on` only for `fields`. Never raises or answers a prompt.
   */
  yieldToPerson(scope: BuilderCallScope, kind: WriteKind, options?: YieldOptions): void;
  /** After a request* call that answered false → answerUnsavedChangesPrompt("stay") and throw unsaved-draft { reason: "draft" }. */
  requestOrRefuse(scope: BuilderCallScope, ran: boolean): void;
  /** Runs controller calls with the writing flag up (revision reports by "agent"), counting the history steps they pushed (mutation: execute +1, undo -1, redo +1), updating ownSteps and the session depth. */
  write<T>(scope: BuilderCallScope, run: () => T): { value: T; steps: number };
  undoInfo(scope: BuilderCallScope, steps: number): UndoInfo;
  /** After a successful write, once its last controller call returned (the notice's button is good only while the history has not moved since); returns WritePayload.shown (undefined under a bare controller or when the selection was left alone). */
  show(scope: BuilderCallScope, touched: ShowRequest): { componentId?: string } | undefined;
  formulas: FormulaChecker;
  outline(scope: BuilderCallScope, options?: { componentId?: string; depth?: number; detail?: "outline" | "full" }): { rootId: string; nodes: Outline["nodes"]; total: number };
  refs: TestRefs;
  /** Committed-check findings for the current revision, cached per revision (checks.ts fills the areas). */
  findings(scope: BuilderCallScope): readonly Finding[];
  /** unknown-component with `closest`. */
  unknownComponent(scope: BuilderCallScope, id: string): ToolRefusal;
  /** The catalogue's memory (read-only for tools, but for run_tests' `cancelRun` slot). */
  memory: BuilderMemory;
  /** The first four checks of a call, run without throwing, for `describe_builder.blockedBy`. */
  blockers(scope: BuilderCallScope): Blockers;
  /** A write result's builder fields: `undo`, `shown` when given, `session` while one is open. */
  payload(scope: BuilderCallScope, steps: number, shown?: { componentId?: string }): WritePayload;
  /** Every component id in the committed tree, in document order. */
  ids(scope: BuilderCallScope): string[];

  // ---- the page's seams ----

  /**
   * What an async mode call runs each of its synchronous writes through, so the writing
   * flag is up exactly while the mode writes and down across every await:
   * `step => { shared.write(scope, step); }`.
   */
  around(scope: BuilderCallScope): (step: () => void) => void;
  /** The outside journal (outside-journal.ts): record, forCall, undo, restorable, the captures. */
  journal: OutsideJournal;
  /** Follow `controller` (the layout's) before writing a step to it. */
  followLayout(scope: BuilderCallScope, layoutId: string, controller: BuilderController): void;
  /** The folded-action argument check. */
  folded: typeof checkActionArgs;
}

/** What {@link createBuilderShared} needs from the catalogue around it. */
export interface SharedDeps {
  memory: BuilderMemory;
  formulas: FormulaChecker;
  refs: TestRefs;
  /** Subscribes the catalogue to the controller a call reads, when it has not yet (a shell built after registration). */
  follow(controller: BuilderController): void;
  /** The committed-check areas (checks.ts). */
  committedFindings(shared: BuilderToolsShared, scope: BuilderCallScope): Finding[];
}

/**
 * The `unsaved-draft` refusal for the Languages workspace's typed cells: `componentId: "languages-texts"`, with `cells` when the surface counts them.
 */
export function languagesDraftRefusal(cells: number | undefined): ToolRefusal {
  const details: Record<string, unknown> = { reason: "draft", componentId: "languages-texts" };
  if (cells !== undefined && cells > 0) {
    details.cells = cells;
  }
  return new ToolRefusal(
    "unsaved-draft",
    "The person has translations typed in the Languages workspace that are not applied yet; nothing was changed.",
    "The person is editing languages-texts; ask them to apply or discard that edit, then call again. Do not retry on your own.",
    details
  );
}

/** The tree kinds Try it and a designer refuse (tree writes and history). */
const SEEN_KINDS: readonly WriteKind[] = ["tree", "replace", "remove", "rename", "history"];

/** The `unsaved-draft { reason: "prompt" }` refusal, `prompt.external` included: one shape for every tool. */
export function promptRefusal(prompt: UnsavedChangesPrompt): ToolRefusal {
  const detail: Record<string, unknown> = { componentId: prompt.componentId, action: prompt.action };
  if (prompt.external !== undefined) {
    detail.external = { ...prompt.external };
  }
  return new ToolRefusal(
    "unsaved-draft",
    "The builder is asking the person to save or discard an edit; nothing was changed.",
    "The builder is asking the person to save or discard an edit; wait for them to answer, then call again.",
    { reason: "prompt", prompt: detail }
  );
}

/** The `unsaved-draft { reason: "draft" }` refusal, naming whose edit is in the way. */
export function draftRefusal(componentId: string): ToolRefusal {
  return new ToolRefusal(
    "unsaved-draft",
    `The person has an unsaved edit on "${componentId}".`,
    `The person is editing ${componentId}; ask them to apply or discard that edit, then call again. Do not retry on your own.`,
    { reason: "draft", componentId }
  );
}

/**
 * The `unsaved-draft` refusal for what is pending now (begin_session's and history's any-draft
 * check). `documentId` names a designer document's controller (the refusal's
 * `componentId` is then `"<documentId>/<nodeId>"`).
 */
export function pendingDraftRefusal(controller: BuilderController, documentId?: string): ToolRefusal | undefined {
  const prompt = controller.unsavedChangesPrompt();
  if (prompt !== undefined) {
    return promptRefusal(prompt);
  }
  if (controller.hasPendingChanges()) {
    const nodeId = pendingDraftId(controller);
    return draftRefusal(documentId === undefined ? nodeId : `${documentId}/${nodeId}`);
  }
  return undefined;
}

/** How the agent takes one step of a controller's history (see {@link historyStepper}). */
export type HistoryStepper = (controller: BuilderController, direction: "undo" | "redo") => void;

/** A controller's own Undo or Redo: the stepper where the page has no shell. */
export const ownHistoryStep: HistoryStepper = (controller, direction) => {
  if (direction === "undo") {
    controller.undo();
  } else {
    controller.redo();
  }
};

/**
 * Every Undo and Redo the agent's tools take goes the way the person's does: the
 * shell's `historyStep` when the page has one, which asks the mode's history first, so in a
 * journey's Step view the agent's Undo of a rename takes the journey's follow-up back with it.
 * The step taken is still the controller's own top one, so the counts of the agent's own steps
 * hold. Without a shell, the controller's own.
 */
export function historyStepper(host: BuilderToolHost): HistoryStepper {
  return (controller, direction) => {
    const route = host.ui?.historyStep;
    if (route) {
      route(controller, direction);
    } else {
      ownHistoryStep(controller, direction);
    }
  };
}

/** The document open in the designer whose controller `controller` is, through the page's adapters. */
export function openDocumentOf(host: BuilderToolHost, controller: BuilderController): string | undefined {
  const ui = host.ui;
  for (const side of [ui?.journeys?.(), ui?.pdfLayouts?.()]) {
    if (side !== undefined && side.state === "ready" && side.controller() === controller) {
      return side.openId();
    }
  }
  return undefined;
}

/** Whose draft is pending: the selection's when it holds one, else the root (the Form panel and any draft the panels do not show). */
function pendingDraftId(controller: BuilderController): string {
  const selected = controller.selectedComponentId();
  if (selected !== undefined && controller.hasPendingChanges(selected)) {
    return selected;
  }
  return controller.rootId();
}

/** The answers the person typed in Try it: what leaving it would clear. */
export function triedCount(answers: Record<string, unknown>): number {
  let count = 0;
  for (const value of Object.values(answers)) {
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    count += 1;
  }
  return count;
}

/** The memory's slots cache as the outline reads it. */
export function slotsCache(memory: BuilderMemory): SlotsCache {
  return {
    get value() {
      return memory.slots;
    },
    set value(next) {
      memory.slots = next;
    },
    generation: () => memory.generation
  };
}

export function createBuilderShared(host: BuilderToolHost, deps: SharedDeps): BuilderToolsShared {
  const memory = deps.memory;
  const journal = createOutsideJournal(host, memory);

  /** The open designer document a controller other than the form's edits, for `"<documentId>/<nodeId>"`. */
  const documentIdOf = (controller: BuilderController, form: BuilderController, options: YieldOptions): string | undefined => {
    if (controller === form) {
      return undefined;
    }
    if (options.controller === controller && options.documentId !== undefined) {
      return options.documentId;
    }
    return openDocumentOf(host, controller);
  };

  /** Any pending draft on `controller`, named as the person sees it (a designer's prefixed by its document). */
  const anyDraft = (controller: BuilderController, form: BuilderController, options: YieldOptions): ToolRefusal | undefined => {
    if (!controller.hasPendingChanges()) {
      return undefined;
    }
    const nodeId = pendingDraftId(controller);
    const documentId = documentIdOf(controller, form, options);
    return draftRefusal(documentId === undefined ? nodeId : `${documentId}/${nodeId}`);
  };

  /** A leave guard holding edits on `controller` (`only`: that subject alone), named by its subject. */
  const leaveGuard = (controller: BuilderController, only?: string): ToolRefusal | undefined => {
    if (!controller.hasPendingLeaveGuard()) {
      return undefined;
    }
    const subject = controller.leaveGuardSubject() ?? host.ui?.leaveGuardSubject?.() ?? "tests-panel";
    if (only !== undefined && subject !== only) {
      return undefined;
    }
    return subject === "languages-texts" ? languagesDraftRefusal(host.ui?.languagesPending?.()) : draftRefusal(subject);
  };

  /**
   * The yield rules of the additional kinds: (1) the
   * prompt on the active controller, the form's and the document's; (2) the drafts each kind
   * would walk past; (3) never `wrong-mode`; (4) `try-it-on` for `fields` alone.
   */
  const yieldAdditional = (scope: BuilderCallScope, kind: WriteKind, options: YieldOptions): void => {
    const form = scope.controller;
    const ui = host.ui;
    const active = ui?.activeController?.() ?? form;
    const document = options.controller;
    const controllers = [...new Set([active, form, ...(document !== undefined ? [document] : [])])];
    // 1. A prompt anywhere the act would reach: never answered on the person's behalf.
    for (const controller of controllers) {
      const prompt = controller.unsavedChangesPrompt();
      if (prompt !== undefined) {
        throw promptRefusal(prompt);
      }
    }
    // 2. Drafts and leave guards, per kind.
    const root = form.rootId();
    const first = (...checks: Array<() => ToolRefusal | undefined>): void => {
      for (const check of checks) {
        const refusal = check();
        if (refusal !== undefined) {
          throw refusal;
        }
      }
    };
    switch (kind) {
      case "try":
        // Starting Try it walks past what `setTrying` would ask about (as open { tryIt: true }).
        first(
          () => anyDraft(active, form, options),
          () => leaveGuard(active),
          () => (active !== form ? leaveGuard(form) : undefined)
        );
        break;
      case "languages":
        // An open root draft is the person's unapplied Form settings edit (LM trap 3): a language
        // write lands beside it and muddles whose edit the next Save is; the Languages surface's
        // typed cells are the person's too.
        first(
          () => (form.hasPendingChanges(root) ? draftRefusal(root) : undefined),
          () => leaveGuard(form, "languages-texts")
        );
        break;
      case "catalog":
        first(
          () => anyDraft(active, form, options),
          () => leaveGuard(active),
          () => (document !== undefined && document !== active ? anyDraft(document, form, options) : undefined),
          () => (document !== undefined && document !== active ? leaveGuard(document) : undefined)
        );
        break;
      case "save":
        first(
          () => anyDraft(active, form, options),
          () => (active !== form ? anyDraft(form, form, options) : undefined),
          () => leaveGuard(active),
          () => (active !== form ? leaveGuard(form) : undefined)
        );
        break;
      case "identity":
        // `setIdentity` overwrites the root's draft (BC:2054).
        first(() => (form.hasPendingChanges(root) ? draftRefusal(root) : undefined));
        break;
      case "fields": {
        // The form's selected draft, as a tree write reads it, plus every draft on the layout
        // controller: the one named when it is not the form's (the call passes
        // `{ controller: form }`), else the active one while a designer is open. The form's root
        // draft and its own leave guards are not what inserting form fields walks past.
        const layout = document !== undefined && document !== form ? document : active !== form ? active : undefined;
        const selected = form.selectedComponentId();
        first(
          () => (selected !== undefined && selected !== root && options.vanishing?.has(selected) !== true && form.hasPendingChanges(selected) ? draftRefusal(selected) : undefined),
          () => (layout !== undefined ? anyDraft(layout, form, options) : undefined),
          () => (layout !== undefined ? leaveGuard(layout) : undefined)
        );
        break;
      }
      default:
        break;
    }
    // 4. Try it: only the form fields `create_form_fields` inserts would change the tried form under the person.
    if (kind === "fields" && ui !== undefined && ui.trying()) {
      const triedPaths = triedCount(ui.triedAnswers());
      throw new ToolRefusal(
        "try-it-on",
        "The person is trying the form; nothing was changed.",
        `The person is trying the form. Call open { tryIt: false } (pass discardTriedAnswers: true only after telling them their ${triedPaths} typed answers will be cleared), or ask them to go back to editing.`,
        { triedPaths }
      );
    }
  };

  const allIds = (controller: BuilderController): string[] => {
    const out: string[] = [];
    const stack = [controller.snapshot()];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) {
        continue;
      }
      out.push(node.id);
      const children = Object.values(node.children ?? {}).flat();
      for (let at = children.length - 1; at >= 0; at -= 1) {
        stack.push(children[at] as (typeof stack)[number]);
      }
    }
    return out;
  };

  const shared: BuilderToolsShared = {
    host,
    memory,
    formulas: deps.formulas,
    refs: deps.refs,

    journal,
    folded: checkActionArgs,

    scope(ctx) {
      const controller = host.controller();
      if (controller === undefined) {
        throw new ToolRefusal("builder-not-ready", "The builder is still loading.", "Wait a moment and call describe_builder again.", { state: "loading" });
      }
      deps.follow(controller);
      // The agent's tried answers and its last Check end with Try it: a call
      // that finds Try it off forgets them, so a later Try it starts from the person's answers alone.
      const ui = host.ui;
      if ((memory.tried.size > 0 || memory.tryLast.lastCheck !== undefined || memory.tryLast.lastSubmit !== undefined) && ui !== undefined && !ui.trying()) {
        memory.tried.clear();
        memory.tryLast = {};
      }
      memory.callSeq += 1;
      return { ctx, controller, words: agentWords(host.words()), cache: new Map(), slots: slotsCache(memory), call: `call-${memory.callSeq}` };
    },

    around(scope) {
      return (step) => {
        shared.write(scope, step);
      };
    },

    followLayout(scope, layoutId, controller) {
      void scope;
      journal.followLayout(layoutId, controller);
    },

    blockers(scope) {
      const controller = scope.controller;
      const out: Blockers = { reasons: [] };
      // The active controller (a designer document's in Journeys / PDF) counts too.
      const active = host.ui?.activeController?.() ?? controller;
      if (controller.unsavedChangesPrompt() !== undefined || (active !== controller && active.unsavedChangesPrompt() !== undefined)) {
        out.reasons.push("prompt");
      }
      if (controller.hasPendingChanges() || controller.hasPendingLeaveGuard()) {
        out.reasons.push("draft");
        out.draftComponentId = controller.hasPendingChanges() ? pendingDraftId(controller) : (controller.leaveGuardSubject() ?? "tests-panel");
      } else if (active !== controller && (active.hasPendingChanges() || active.hasPendingLeaveGuard())) {
        out.reasons.push("draft");
        if (active.hasPendingChanges()) {
          const documentId = documentIdOf(active, controller, {});
          const nodeId = pendingDraftId(active);
          out.draftComponentId = documentId === undefined ? nodeId : `${documentId}/${nodeId}`;
        } else {
          out.draftComponentId = active.leaveGuardSubject() ?? "tests-panel";
        }
      }
      const ui = host.ui;
      if (ui !== undefined) {
        if (ui.trying()) {
          out.reasons.push("try-it");
          out.triedPaths = triedCount(ui.triedAnswers());
        }
        const mode = ui.mode();
        if (mode !== "form") {
          out.reasons.push("wrong-mode");
          out.mode = mode;
        }
      }
      return out;
    },

    yieldToPerson(scope, kind, options = {}) {
      if (ADDITIONAL_KINDS.has(kind)) {
        yieldAdditional(scope, kind, options);
        return;
      }
      const controller = scope.controller;
      // 1. The prompt is up: never answered on the person's behalf.
      const prompt = controller.unsavedChangesPrompt();
      if (prompt !== undefined) {
        throw promptRefusal(prompt);
      }
      // 2. Drafts. Undo reconciles or drops drafts anywhere, so history yields to any of them.
      const root = controller.rootId();
      if (kind === "history") {
        if (controller.hasPendingChanges()) {
          throw draftRefusal(pendingDraftId(controller));
        }
      } else {
        const selected = controller.selectedComponentId();
        if (selected !== undefined && selected !== root && options.vanishing?.has(selected) !== true && controller.hasPendingChanges(selected)) {
          throw draftRefusal(selected);
        }
        if (kind === "properties" || kind === "rename") {
          for (const id of options.ids ?? []) {
            if (controller.hasPendingChanges(id)) {
              throw draftRefusal(id);
            }
          }
        }
        if (kind === "replace" || kind === "tests") {
          // The tests and the root's slot are root-level: the Form panel's draft counts, and so
          // do the Tests panel's own unsaved edits (its leave guard).
          if (controller.hasPendingChanges(root)) {
            throw draftRefusal(root);
          }
          if (controller.hasPendingLeaveGuard()) {
            throw draftRefusal("tests-panel");
          }
        }
      }
      const ui = host.ui;
      if (ui === undefined || kind === "properties") {
        return;
      }
      // 3. A designer: the person would not see the change.
      const mode = ui.mode();
      if (mode !== "form") {
        throw new ToolRefusal(
          "wrong-mode",
          `The builder is in the ${mode} designer; nothing was changed.`,
          `The person is in the ${mode} designer and would not see the change; call open { workspace: 'form' } first.`,
          { mode }
        );
      }
      // 4. Try it: a tree change would land behind the person's back.
      if (SEEN_KINDS.includes(kind) && ui.trying()) {
        const triedPaths = triedCount(ui.triedAnswers());
        throw new ToolRefusal(
          "try-it-on",
          "The person is trying the form; nothing was changed.",
          `The person is trying the form. Call open { tryIt: false } (pass discardTriedAnswers: true only after telling them their ${triedPaths} typed answers will be cleared), or ask them to go back to editing.`,
          { triedPaths }
        );
      }
    },

    requestOrRefuse(scope, ran) {
      if (ran) {
        return;
      }
      // The race: the request held the action behind a prompt that
      // appeared after the pre-check. The tool never leaves a held action: it stays, and refuses.
      const controller = scope.controller;
      const prompt = controller.unsavedChangesPrompt();
      if (prompt !== undefined) {
        controller.answerUnsavedChangesPrompt("stay");
      }
      throw draftRefusal(prompt?.componentId ?? controller.selectedComponentId() ?? controller.rootId());
    },

    write(scope, run) {
      void scope;
      const outer = memory.writing;
      const start = memory.callSteps;
      memory.writing = true;
      let value: ReturnType<typeof run>;
      let steps = 0;
      try {
        value = run();
      } finally {
        steps = memory.callSteps - start;
        if (!outer) {
          memory.writing = false;
          memory.callSteps = 0;
        }
      }
      return { value, steps };
    },

    undoInfo(scope, steps) {
      return { steps, ownSteps: memory.ownSteps, canUndo: scope.controller.canUndo(), canRedo: scope.controller.canRedo() };
    },

    payload(scope, steps, shown) {
      const payload: WritePayload = { undo: shared.undoInfo(scope, steps) };
      if (shown !== undefined) {
        payload.shown = shown;
      }
      const session = scope.ctx.session;
      if (session !== undefined) {
        payload.session = { id: session.id, ownSteps: memory.ownSteps };
      }
      return payload;
    },

    show(scope, touched) {
      const ui = host.ui;
      if (ui === undefined) {
        return undefined;
      }
      const controller = scope.controller;
      // While the person types in a text control (the inspector included) nothing scrolls or
      // flashes under them; the selection and the announcement still happen.
      const typing = ui.focusInTextControl();
      let shown: { componentId?: string } | undefined;
      const target = touched.select;
      if (target !== undefined && allIds(controller).includes(target)) {
        const selected = controller.selectedComponentId();
        if (selected === target) {
          // The canvas reveals a changed selection on its own paint; an unchanged one is revealed here.
          if (!typing) {
            ui.revealComponent(target);
          }
          shown = { componentId: target };
        } else if (selected === undefined || !controller.hasPendingChanges(selected)) {
          const ran = controller.requestSelect(target);
          if (!ran && controller.unsavedChangesPrompt() !== undefined) {
            controller.answerUnsavedChangesPrompt("stay");
          }
          if (ran) {
            shown = { componentId: target };
          }
        }
      }
      if (!typing && touched.ids.length > 0) {
        ui.highlight(touched.ids);
      }
      ui.announce(touched.announce);
      // Outside a session only: inside one, the banner is the person's account of the work.
      if (scope.ctx.session === undefined && touched.noButton === true) {
        // A save: the notice says it, and nothing takes it back.
        ui.notice(touched.announce);
      } else if (scope.ctx.session === undefined && (touched.undoSteps > 0 || touched.journaled !== undefined)) {
        const steps = touched.undoSteps;
        const redo = touched.redo === true;
        const call = touched.journaled?.call;
        // The button takes back exactly this write's steps, so it works only while they are still
        // the top of the history: any step since (the person's own Undo or Redo, which also
        // clears the notice, another write, a reseed) leaves it with nothing to do, rather
        // than reaching into the person's work. show() runs after the write's last controller call.
        // A journaled change is reversed through the outside journal, whose kept
        // checks leave anything the person changed since as theirs.
        const shownAt = memory.mutations;
        const label = touched.journaled?.restore === true ? "agent.restore" : redo ? "agent.redo" : "agent.undo";
        ui.notice(touched.announce, {
          label: scope.words.text(label),
          run: () => {
            const fresh = memory.mutations === shownAt;
            if (call !== undefined) {
              journal.undo(scope, journal.forCall(call), "notice");
            }
            if (!fresh) {
              ui.clearNotice();
              return;
            }
            // The way the person's Undo goes: a Step view takes each step back whole.
            const stepOnce = historyStepper(host);
            for (let step = 0; step < steps; step += 1) {
              if (redo ? !controller.canRedo() : !controller.canUndo()) {
                break;
              }
              stepOnce(controller, redo ? "redo" : "undo");
            }
          }
        });
      }
      return shown;
    },

    outline(scope, options = {}) {
      const findings = shared.findings(scope);
      const problems = new Map<string, number>();
      for (const finding of findings) {
        if (finding.componentId !== undefined) {
          problems.set(finding.componentId, (problems.get(finding.componentId) ?? 0) + 1);
        }
      }
      const outlineOptions: OutlineOptions = { problems };
      if (options.componentId !== undefined) {
        outlineOptions.componentId = options.componentId;
      }
      if (options.depth !== undefined) {
        outlineOptions.depth = options.depth;
      }
      if (options.detail !== undefined) {
        outlineOptions.detail = options.detail;
      }
      const outline = buildOutline(scope, outlineOptions);
      if (outline === undefined) {
        throw shared.unknownComponent(scope, options.componentId ?? "");
      }
      return outline;
    },

    findings(scope) {
      const revision = scope.ctx.revision();
      const cached = scope.ctx.state.get(STATE_KEYS.findings) as { revision: number; controller: BuilderController; findings: Finding[] } | undefined;
      if (cached !== undefined && cached.revision === revision && cached.controller === scope.controller) {
        return cached.findings;
      }
      const findings = deps.committedFindings(shared, scope);
      scope.ctx.state.set(STATE_KEYS.findings, { revision, controller: scope.controller, findings });
      return findings;
    },

    unknownComponent(scope, id) {
      const closest = closestId(allIds(scope.controller), id);
      const details: Record<string, unknown> = { componentId: id };
      let hint = "Call get_form to list the current ids; ids change after rename_component and history.";
      if (closest !== undefined) {
        details.closest = closest;
        hint += ` Closest: "${closest}".`;
      }
      return new ToolRefusal("unknown-component", `No component has the id "${id}".`, hint, details);
    },

    ids(scope) {
      return allIds(scope.controller);
    }
  };
  return shared;
}
