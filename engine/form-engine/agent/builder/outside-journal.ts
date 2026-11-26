/**
 * The builder catalogue's outside journal: what
 * the agent changed off the form controller's undo history, kept so Undo all, Stop,
 * `end_session { undo: true }` and the notice row can take it back. Journey and PDF layout list
 * changes, the documents the agent removed (held until the page reloads), the steps an agent
 * pushed onto a PDF layout's own history, Try it's stand-in settings and the form's identity; a
 * `save` is a barrier marker with no inverse (the site keeps what was saved).
 *
 * One action, one record: a list change the mode made a step of the form's history (every
 * catalog action, and the catalog seam when translations move with it, a
 * restore that brings a document's wording back) is journaled with the form steps it wrote
 * (`stepped`). The form's Undo takes it back (the interleave below reaches it by depth, the notice
 * by its `undoSteps`), so its entry is skipped by every undo here and counted by no pending count;
 * a removal's entry stays for `restorable`. Any other is journaled with no step and has an
 * inverse here. An inverse that does run goes through the catalog seam (`applyCatalog`), never the
 * mode's own removal, which is a form step, and which the interleave would then take back in
 * place of an older step.
 *
 * One journal per registration, in the catalogue's `BuilderMemory` (`outside`, capped at 100,
 * oldest dropped), emptied by `reset()`. Each entry records `depthAt`, the session's form-step
 * depth when it was written, so a replay can interleave it with the form steps newest first
 * (session.ts runs the interleave). An inverse runs only through the designer adapters
 * (`applyCatalog`, `remove`) and the controllers (`setTrySubmission`,
 * `setSimulatedDataSource`, `setIdentity`, a layout controller's `undo`), with the writing flag
 * up so what they cause is the agent's. Before it runs, the entry is checked against what the
 * agent left: anything the person changed since wins and the entry is `kept`, with its reason.
 *
 * Layout histories: layout controllers are per layout and their entries carry no
 * author, so the journal follows each layout controller the agent wrote to (`followLayout`) and
 * keeps the agent's steps on top of that history (`layoutTop`), as `ownSteps` does for the form.
 * A write that leaves the history as it was (a new name the mode pushes into a built designer's
 * tree with no entry) is no step of anyone's. A layout the person removed (its
 * designer disposed, which its controller never hears) is `history-gone`.
 *
 * The person always wins: a removal's inverse puts the default
 * back only while the catalog declares what the removal left, and a rename's inverse puts back
 * only the text that still holds the agent's, so a translation written or pruned since stays.
 *
 * Pure over the host seam: no DOM, nothing at import time, no state outside the memory it is
 * handed. Imports only types from the rest of `agent/builder/` (context.ts imports this module).
 */
import type { BuilderController, FormIdentity } from "../../builder/controller/builder-controller.js";
import type { TrySubmissionSettings } from "../../builder/controller/try-submission.js";
import type { DataSourceResult } from "../../core/schema/contracts.js";
import type { Journey, JourneyConfiguration } from "../../core/schema/journey.js";
import type { PdfConfiguration, PdfLayoutDocument } from "../../core/schema/pdf-layout.js";
import type { BuilderCallScope, BuilderMemory } from "./context.js";
import type { BuilderToolHost, JourneyActions, PdfActions } from "./host.js";
import type { DocumentKind } from "./types.js";

/** The journal holds at most this many entries; the oldest go first. */
export const OUTSIDE_JOURNAL_CAP = 100;

/** Which designer a catalog entry is about. */
export type CatalogSide = "journeys" | "pdf";

/** The catalog actions the journal can reverse (`documents`). */
export type CatalogAction = "new" | "duplicate" | "rename" | "set_default" | "move" | "restore_removed";

/** Why an entry was left as the person has it instead of being reversed. */
export type OutsideKeptReason = "person-edited" | "id-taken" | "history-gone" | "unavailable";

/** A stand-in option list as the controller keeps it (`setSimulatedDataSource`). */
export type SimulatedItems = DataSourceResult["items"];

/**
 * The catalog's declared default, as written (a key present only when the configuration
 * declares it): journeys `defaultJourneyId` and `opensAs`, PDF layouts `defaultLayoutId`.
 */
export type CatalogDefaults = Partial<Pick<JourneyConfiguration, "defaultJourneyId" | "opensAs">> & Partial<Pick<PdfConfiguration, "defaultLayoutId">>;

/** What {@link OutsideJournal.captureCatalog} reads before a catalog action, for its inverse. */
export interface CatalogCapture {
  /** The committed document before the action, when it exists (rename's inverse puts its `name` back). */
  document?: Journey | PdfLayoutDocument;
  /** Its place in the list (move's inverse). */
  index?: number;
  /** The declared default before the action (set_default's and move's inverse). */
  defaults: CatalogDefaults;
}

/** What {@link OutsideJournal.captureRemoval} stores before `removeJourney` / `removeLayout`. */
export interface RemovalCapture {
  side: CatalogSide;
  id: string;
  /** The committed document, as the catalog holds it. */
  json: Journey | PdfLayoutDocument;
  index: number;
  defaults: CatalogDefaults;
}

/** The stamps every entry carries. */
interface EntryStamps {
  /** Monotonic per registration; newest first is highest first. */
  seq: number;
  /** The call that recorded it (`BuilderCallScope.call`): the notice's Undo runs that call's entries. */
  call: string;
  tool: string;
  /** The registrar's session id, when one was open. */
  session?: string;
  /** The catalogue's own session token (`SessionMemory.token`): Undo all's scope. */
  token?: number;
  at: number;
  /** The session's form-step depth when it was written (the ended banner's, after an end). */
  depthAt: number;
  /** The form steps the act wrote: the form's Undo takes it back, and the entry has no inverse of its own (see the file comment). */
  stepped?: number;
}

export interface CatalogEntry extends EntryStamps {
  kind: "catalog";
  side: CatalogSide;
  action: CatalogAction;
  id: string;
  before: CatalogCapture;
  /**
   * What the agent left: the kept check compares the catalog with it. A document's name is a
   * plain string (its translations are the definition's map), so a translation
   * written or pruned since is no edit of the document and stays as it is.
   */
  left: unknown;
}

export interface RemovedEntry extends EntryStamps, RemovalCapture {
  kind: "removed";
  /**
   * The declared default as the removal left it (absent when the catalog could not be read):
   * the inverse puts `defaults` back only while the catalog still declares this, so a default
   * the person chose since stays theirs.
   */
  leftDefaults?: CatalogDefaults;
}

export interface LayoutStepsEntry extends EntryStamps {
  kind: "layout-steps";
  layoutId: string;
  steps: number;
  /** The layout's designer was rebuilt, disposed or removed since: its history is gone. */
  historyGone?: true;
}

export interface SettingsEntry extends EntryStamps {
  kind: "settings";
  trySubmission?: { before: TrySubmissionSettings; after: TrySubmissionSettings };
  sources?: Array<{ sourceId: string; before: SimulatedItems | undefined; after: SimulatedItems | undefined }>;
}

export interface IdentityEntry extends EntryStamps {
  kind: "identity";
  before: FormIdentity | undefined;
  after: FormIdentity | undefined;
}

export interface SaveEntry extends EntryStamps {
  kind: "save";
  /** The revision saved. */
  revision: number;
}

export type OutsideEntry = CatalogEntry | RemovedEntry | LayoutStepsEntry | SettingsEntry | IdentityEntry | SaveEntry;

/**
 * What a tool hands {@link OutsideJournal.record}: the entry without the stamps, and without
 * what the journal reads itself right after the act (the catalog's `left`, the settings' and the
 * identity's `after`), so the record and the later kept check read the same way.
 */
export type OutsideEntryInput =
  | { kind: "catalog"; side: CatalogSide; action: CatalogAction; id: string; before: CatalogCapture; stepped?: number }
  | ({ kind: "removed"; stepped?: number } & RemovalCapture)
  | { kind: "layout-steps"; layoutId: string; steps: number }
  | { kind: "settings"; trySubmission?: { before: TrySubmissionSettings }; sources?: Array<{ sourceId: string; before: SimulatedItems | undefined }> }
  | { kind: "identity"; before: FormIdentity | undefined }
  | { kind: "save"; revision: number };

/** One entry the person's later change kept from being reversed. */
export interface OutsideKept {
  entry: OutsideEntry;
  reason: OutsideKeptReason;
  /** Static words for the agent: "kept: journey intake was edited by the person". */
  warning: string;
}

/** What an undo over journal entries did. */
export interface OutsideUndo {
  /** Entries reversed. */
  undone: number;
  kept: OutsideKept[];
}

/** Whether an Undo all, Stop or the notice runs `entry`'s inverse: not the save barrier, nor an act the form's history holds (`stepped`). */
export function journalReverses(entry: OutsideEntry): boolean {
  return entry.kind !== "save" && !(entry.stepped !== undefined && entry.stepped > 0);
}

/** Why the journal is replayed (for the log); the replay is the same. */
export type OutsideUndoWhy = "undo-all" | "stop" | "end-session" | "banner" | "notice";

/** The journal over one registration's memory. */
export interface OutsideJournal {
  /** Records an entry after the act it reverses; returns it stamped. Drops the oldest past the cap. */
  record(scope: BuilderCallScope, entry: OutsideEntryInput): OutsideEntry;
  /** The live entries one call recorded, oldest first. */
  forCall(callId: string): OutsideEntry[];
  /** The live entries of one session (by the catalogue's token), oldest first. */
  forSession(token: number): OutsideEntry[];
  /** How many of a session's live entries an Undo all could reverse (the save barrier is not one). */
  pending(token: number): number;
  /**
   * Reverses `entries` newest first (each through its adapter or controller, the writing flag
   * up), skipping the save barrier; an entry the person changed since is kept, with its reason.
   * `scope` is the calling tool's, absent from the session hooks.
   */
  undo(scope: BuilderCallScope | undefined, entries: readonly OutsideEntry[], why: OutsideUndoWhy): OutsideUndo;
  /** The newest document the agent removed with that id, while its id is not in the catalog again (`restore_removed`). */
  restorable(kind: DocumentKind, id: string): RemovedEntry | undefined;
  /** Reads what a catalog action's inverse needs, before the action. Undefined when the designer is not ready. */
  captureCatalog(side: CatalogSide, id: string): CatalogCapture | undefined;
  /** Reads the committed document, its index and the declared default, before a removal. */
  captureRemoval(side: CatalogSide, id: string): RemovalCapture | undefined;
  /**
   * Follows a layout controller before the agent writes a step to it: an execute with
   * the writing flag up +1 on the agent's top, the person's execute 0, an undo -1, a redo back up
   * to the ceiling; an `init` change marks its entries `history-gone`.
   */
  followLayout(layoutId: string, controller: BuilderController): void;
  /** The layout's designer went (removed, rebuilt): its entries can no longer be reversed. */
  layoutGone(layoutId: string): void;
  /** The newest save barrier among `entries`, if any. */
  barrier(entries: readonly OutsideEntry[]): SaveEntry | undefined;
  /** Empties the journal and drops every layout follower (a reseed, unregister). */
  clear(): void;
}

/** A layout controller the journal follows. */
export interface LayoutFollower {
  controller: BuilderController;
  /** How far a redo may bring the agent's top back. */
  ceiling: number;
  /** The history the agent's steps were on is gone. */
  gone: boolean;
  /** The entry atop the controller's history as last heard: a write that leaves it is no step. */
  mark: object | undefined;
  off(): void;
}

/** An undo the controller could not take, as `dropError` words it (session.ts `stepFailed`'s pattern). */
const FAILED_STEP = /could not be (undone|redone)/;

const DEFAULT_KEYS: Readonly<Record<CatalogSide, ReadonlyArray<keyof CatalogDefaults>>> = {
  journeys: ["defaultJourneyId", "opensAs"],
  pdf: ["defaultLayoutId"]
};

/** The tool that records each kind. */
const TOOL_OF: Readonly<Record<OutsideEntry["kind"], string>> = {
  catalog: "documents",
  removed: "remove_part",
  "layout-steps": "documents",
  settings: "try_it",
  identity: "set_properties",
  save: "save"
};

function sideOfKind(kind: DocumentKind): CatalogSide {
  return kind === "journey" ? "journeys" : "pdf";
}

/** JSON with object keys sorted, so two reads of the same document compare equal. */
function canonical(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(sort);
    }
    if (typeof input !== "object" || input === null) {
      return input;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      const inner = (input as Record<string, unknown>)[key];
      if (inner !== undefined) {
        out[key] = sort(inner);
      }
    }
    return out;
  };
  try {
    return JSON.stringify(sort(value) ?? null);
  } catch {
    return "";
  }
}

function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** The declared default keys of a configuration, as written. */
function declaredDefaults(side: CatalogSide, configuration: CatalogDefaults | undefined): CatalogDefaults {
  const out: Record<string, unknown> = {};
  for (const key of DEFAULT_KEYS[side]) {
    if (configuration !== undefined && Object.prototype.hasOwnProperty.call(configuration, key) && configuration[key] !== undefined) {
      out[key] = configuration[key];
    }
  }
  return out as CatalogDefaults;
}

/** `next` with the declared default put back exactly as `defaults` holds it (a key absent there is deleted). */
function putDefaults(side: CatalogSide, next: Record<string, unknown>, defaults: CatalogDefaults): void {
  for (const key of DEFAULT_KEYS[side]) {
    if (Object.prototype.hasOwnProperty.call(defaults, key) && defaults[key] !== undefined) {
      next[key] = defaults[key];
    } else {
      delete next[key];
    }
  }
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : length, length));
}

/** The journal over `memory`, reaching the designers through `host.ui` and the form through `host.controller()`. */
export function createOutsideJournal(host: BuilderToolHost, memory: BuilderMemory): OutsideJournal {
  /** The ready actions of one side, or undefined. */
  const journeyActions = (): JourneyActions | undefined => {
    const side = host.ui?.journeys?.();
    return side !== undefined && side.state === "ready" ? side.actions : undefined;
  };
  const pdfActions = (): PdfActions | undefined => {
    const side = host.ui?.pdfLayouts?.();
    return side !== undefined && side.state === "ready" ? side.actions : undefined;
  };

  /** The side's documents as the catalog holds them, with the declared default; undefined when the designer is not ready. */
  const catalogOf = (side: CatalogSide): { docs: Array<Journey | PdfLayoutDocument>; configuration: Record<string, unknown> } | undefined => {
    if (side === "journeys") {
      const actions = journeyActions();
      if (actions === undefined) {
        return undefined;
      }
      const configuration = copy(actions.configuration() ?? {}) as Record<string, unknown>;
      return { docs: (configuration.journeys as Journey[] | undefined) ?? [], configuration };
    }
    const actions = pdfActions();
    if (actions === undefined) {
      return undefined;
    }
    const configuration = copy(actions.configuration() ?? {}) as Record<string, unknown>;
    return { docs: (configuration.layouts as PdfLayoutDocument[] | undefined) ?? [], configuration };
  };

  /** What the kept check compares for a catalog action: the document, the declared default, or the order. */
  const probe = (side: CatalogSide, action: CatalogAction, id: string): unknown => {
    const catalog = catalogOf(side);
    if (catalog === undefined) {
      return undefined;
    }
    if (action === "set_default") {
      return declaredDefaults(side, catalog.configuration as CatalogDefaults);
    }
    if (action === "move") {
      return { order: catalog.docs.map((doc) => doc.id), defaults: declaredDefaults(side, catalog.configuration as CatalogDefaults) };
    }
    const doc = catalog.docs.find((entry) => entry.id === id);
    return doc === undefined ? null : copy(doc);
  };

  /** What the person reads of an entry in a kept warning. */
  const what = (entry: OutsideEntry): string => {
    switch (entry.kind) {
      case "catalog":
      case "removed":
        return `${entry.side === "journeys" ? "journey" : "PDF layout"} ${entry.id}`;
      case "layout-steps":
        return `the steps on PDF layout ${entry.layoutId}`;
      case "settings":
        return "Try it's stand-in settings";
      case "identity":
        return "the form's identity";
      default:
        return "the save";
    }
  };

  const keptWarning = (entry: OutsideEntry, reason: OutsideKeptReason): string => {
    const subject = what(entry);
    switch (reason) {
      case "person-edited":
        if (entry.kind === "removed") {
          // The document came back; the default the person chose since the removal stayed.
          return `kept: the default ${entry.side === "journeys" ? "journey" : "PDF layout"} the person chose since; ${subject} was put back without being made the default again`;
        }
        return `kept: ${subject} was edited by the person`;
      case "id-taken":
        return `kept: ${subject} was not put back: its id is in use again`;
      case "history-gone":
        return `kept: ${subject}: its designer's undo history is gone`;
      default:
        return `kept: ${subject}: its designer is not available now`;
    }
  };

  /** Runs `run` with the writing flag up, so the changes it causes are the agent's. */
  const asAgent = (run: () => void): void => {
    const outer = memory.writing;
    memory.writing = true;
    try {
      run();
    } finally {
      if (!outer) {
        memory.writing = false;
        memory.callSteps = 0;
      }
    }
  };

  /** Undoes `steps` steps on a layout controller with the writing flag up; false when one could not be taken. */
  const undoOn = (controller: BuilderController, steps: number): boolean => {
    let failed = false;
    asAgent(() => {
      for (let step = 0; step < steps; step += 1) {
        if (!controller.canUndo()) {
          failed = true;
          return;
        }
        controller.dropError = undefined;
        controller.undo();
        if (controller.dropError !== undefined && FAILED_STEP.test(controller.dropError)) {
          failed = true;
          return;
        }
      }
    });
    return !failed;
  };

  const live = (): OutsideEntry[] => memory.outside;

  const drop = (entry: OutsideEntry): void => {
    const at = memory.outside.indexOf(entry);
    if (at >= 0) {
      memory.outside.splice(at, 1);
    }
  };

  /**
   * Drops the follower of every layout no live `layout-steps` entry names (the subscription goes
   * with the last entry). Record time and the end of Undo all both come through here.
   */
  const pruneFollowers = (): void => {
    for (const [layoutId, follower] of memory.layoutFollowers) {
      if (!memory.outside.some((entry) => entry.kind === "layout-steps" && entry.layoutId === layoutId)) {
        follower.off();
        memory.layoutFollowers.delete(layoutId);
        memory.layoutTop.delete(layoutId);
      }
    }
  };

  const markLayoutGone = (layoutId: string): void => {
    const follower = memory.layoutFollowers.get(layoutId);
    if (follower !== undefined) {
      follower.gone = true;
      follower.ceiling = 0;
    }
    memory.layoutTop.set(layoutId, 0);
    for (const entry of memory.outside) {
      if (entry.kind === "layout-steps" && entry.layoutId === layoutId) {
        entry.historyGone = true;
      }
    }
  };

  /** One entry's inverse: undefined when it ran, else why it was kept. */
  const reverse = (entry: OutsideEntry): OutsideKeptReason | undefined => {
    switch (entry.kind) {
      case "save":
        return undefined;
      case "identity": {
        const controller = host.controller();
        if (controller === undefined) {
          return "unavailable";
        }
        if (canonical(controller.identity()) !== canonical(entry.after)) {
          return "person-edited";
        }
        asAgent(() => controller.setIdentity(entry.before === undefined ? undefined : { ...entry.before }));
        return undefined;
      }
      case "settings": {
        const controller = host.controller();
        if (controller === undefined) {
          return "unavailable";
        }
        let kept = false;
        asAgent(() => {
          // Each part comes back when it still holds what the agent set; a part the person
          // changed since stays theirs (the entry is then reported kept).
          for (const source of entry.sources ?? []) {
            const now = controller.simulatedDataSources().get(source.sourceId);
            if (canonical(now) !== canonical(source.after)) {
              kept = true;
              continue;
            }
            controller.setSimulatedDataSource(source.sourceId, source.before === undefined ? undefined : copy(source.before));
          }
          if (entry.trySubmission !== undefined) {
            if (canonical(controller.trySubmission()) !== canonical(entry.trySubmission.after)) {
              kept = true;
            } else {
              controller.setTrySubmission(copy(entry.trySubmission.before));
            }
          }
        });
        return kept ? "person-edited" : undefined;
      }
      case "layout-steps": {
        const follower = memory.layoutFollowers.get(entry.layoutId);
        if (follower === undefined || follower.gone || entry.historyGone === true) {
          return "history-gone";
        }
        // A designer's disposal says nothing on its controller (PBM `disposeEntry`, when the
        // person removes the layout or the mode builds its designers anew): the layout gone from
        // the catalog, or its open designer on another controller, means the history the steps
        // were on is gone, and an undo on the old controller would
        // change nothing on the page.
        const side = host.ui?.pdfLayouts?.();
        const catalog = catalogOf("pdf");
        if (side === undefined || side.state !== "ready" || catalog === undefined) {
          return "unavailable";
        }
        const open = side.openId() === entry.layoutId ? side.controller() : undefined;
        if (!catalog.docs.some((doc) => doc.id === entry.layoutId) || (open !== undefined && open !== follower.controller)) {
          markLayoutGone(entry.layoutId);
          return "history-gone";
        }
        if ((memory.layoutTop.get(entry.layoutId) ?? 0) < entry.steps) {
          return "person-edited";
        }
        return undoOn(follower.controller, entry.steps) ? undefined : "history-gone";
      }
      case "removed": {
        const catalog = catalogOf(entry.side);
        if (catalog === undefined) {
          return "unavailable";
        }
        if (catalog.docs.some((doc) => doc.id === entry.id)) {
          return "id-taken";
        }
        const docs = [...catalog.docs];
        docs.splice(clampIndex(entry.index, docs.length), 0, copy(entry.json));
        const next: Record<string, unknown> = { ...catalog.configuration, [entry.side === "journeys" ? "journeys" : "layouts"]: docs };
        // The default the removal changed comes back only while the catalog still declares what
        // the removal left; a default the person chose since stays theirs, and the entry says so.
        // A removal that left the default as it was puts nothing back over the current one.
        const declared = canonical(declaredDefaults(entry.side, catalog.configuration as CatalogDefaults));
        const untouched = entry.leftDefaults === undefined || declared === canonical(entry.leftDefaults);
        if (untouched) {
          putDefaults(entry.side, next, entry.defaults);
        }
        apply(entry.side, next, entry.id);
        return untouched || canonical(entry.defaults) === canonical(entry.leftDefaults) ? undefined : "person-edited";
      }
      case "catalog": {
        const catalog = catalogOf(entry.side);
        if (catalog === undefined) {
          return "unavailable";
        }
        if (canonical(probe(entry.side, entry.action, entry.id)) !== canonical(entry.left)) {
          return "person-edited";
        }
        const actions = entry.side === "journeys" ? journeyActions() : pdfActions();
        if (actions === undefined) {
          return "unavailable";
        }
        switch (entry.action) {
          case "new":
          case "duplicate":
          case "restore_removed": {
            // Through the catalog seam, which writes no step of the form's history (the mode's own
            // removal is one: see the file comment). A default that names the document goes back to
            // what was declared before the act; any other default is left as it stands.
            const key = entry.side === "journeys" ? "journeys" : "layouts";
            const next: Record<string, unknown> = { ...catalog.configuration, [key]: catalog.docs.filter((doc) => doc.id !== entry.id) };
            if (DEFAULT_KEYS[entry.side].some((name) => catalog.configuration[name] === entry.id)) {
              putDefaults(entry.side, next, entry.before.defaults);
            }
            apply(entry.side, next, entry.id);
            if (entry.side === "pdf") {
              // Its designer went with it (PBM `disposeEntry`): steps held on it cannot come back.
              markLayoutGone(entry.id);
            }
            return undefined;
          }
          case "rename": {
            const previous = entry.before.document;
            if (previous === undefined) {
              return "unavailable";
            }
            const target = { name: copy(previous.name) };
            // Through the catalog seam, the name alone; the rest of the document as it stands now.
            const key = entry.side === "journeys" ? "journeys" : "layouts";
            const docs = catalog.docs.map((doc) => {
              if (doc.id !== entry.id) {
                return doc;
              }
              const renamed = { ...copy(doc) } as Record<string, unknown>;
              if (target.name === undefined) {
                delete renamed.name;
              } else {
                renamed.name = target.name;
              }
              return renamed as unknown as Journey & PdfLayoutDocument;
            });
            apply(entry.side, { ...catalog.configuration, [key]: docs }, entry.id);
            return undefined;
          }
          case "set_default": {
            const next: Record<string, unknown> = { ...catalog.configuration };
            putDefaults(entry.side, next, entry.before.defaults);
            apply(entry.side, next, entry.id);
            return undefined;
          }
          case "move": {
            const key = entry.side === "journeys" ? "journeys" : "layouts";
            const docs = [...catalog.docs];
            const from = docs.findIndex((doc) => doc.id === entry.id);
            if (from >= 0) {
              const [doc] = docs.splice(from, 1);
              docs.splice(clampIndex(entry.before.index ?? from, docs.length), 0, doc as Journey & PdfLayoutDocument);
            }
            const next: Record<string, unknown> = { ...catalog.configuration, [key]: docs };
            // A move writes the default down when none was declared (layout-catalog.ts): put the
            // declared state back as it was, the key deleted when it was absent.
            putDefaults(entry.side, next, entry.before.defaults);
            apply(entry.side, next, entry.id);
            return undefined;
          }
          default:
            return "unavailable";
        }
      }
      default:
        return undefined;
    }
  };

  /** The catalog seam: designers follow, histories kept; never the reseeding setters. */
  const apply = (side: CatalogSide, next: Record<string, unknown>, subjectId: string): void => {
    asAgent(() => {
      if (side === "journeys") {
        journeyActions()?.applyCatalog(next as JourneyConfiguration, subjectId);
      } else {
        pdfActions()?.applyCatalog(next as PdfConfiguration, subjectId);
      }
    });
  };

  const journal: OutsideJournal = {
    record(scope, input) {
      memory.outsideSeq += 1;
      const session = memory.session;
      const stepped = input.kind === "catalog" || input.kind === "removed" ? (input.stepped ?? 0) : 0;
      const stamps: EntryStamps = {
        seq: memory.outsideSeq,
        call: scope.call,
        tool: TOOL_OF[input.kind],
        ...(scope.ctx.session !== undefined ? { session: scope.ctx.session.id } : {}),
        ...(session !== undefined ? { token: session.token } : {}),
        at: Date.now(),
        depthAt: session?.depth ?? memory.banner?.depth ?? 0,
        ...(stepped > 0 ? { stepped } : {})
      };
      let entry: OutsideEntry;
      switch (input.kind) {
        case "catalog": {
          entry = { ...stamps, kind: "catalog", side: input.side, action: input.action, id: input.id, before: copy(input.before), left: probe(input.side, input.action, input.id) };
          break;
        }
        case "removed": {
          const after = catalogOf(input.side);
          entry = {
            ...stamps,
            kind: "removed",
            side: input.side,
            id: input.id,
            json: copy(input.json),
            index: input.index,
            defaults: copy(input.defaults),
            ...(after !== undefined ? { leftDefaults: declaredDefaults(input.side, after.configuration as CatalogDefaults) } : {})
          };
          if (input.side === "pdf") {
            markLayoutGone(input.id);
          }
          break;
        }
        case "layout-steps":
          entry = { ...stamps, kind: "layout-steps", layoutId: input.layoutId, steps: input.steps };
          break;
        case "settings": {
          const controller = scope.controller;
          const settings: SettingsEntry = { ...stamps, kind: "settings" };
          if (input.trySubmission !== undefined) {
            settings.trySubmission = { before: copy(input.trySubmission.before), after: copy(controller.trySubmission()) };
          }
          if (input.sources !== undefined) {
            settings.sources = input.sources.map((source) => ({
              sourceId: source.sourceId,
              before: copy(source.before),
              after: copy(controller.simulatedDataSources().get(source.sourceId))
            }));
          }
          entry = settings;
          break;
        }
        case "identity":
          entry = { ...stamps, kind: "identity", before: copy(input.before), after: copy(scope.controller.identity()) };
          break;
        default:
          entry = { ...stamps, kind: "save", revision: input.revision };
          memory.lastSave = { revision: input.revision, at: stamps.at };
      }
      memory.outside.push(entry);
      while (memory.outside.length > OUTSIDE_JOURNAL_CAP) {
        const dropped = memory.outside.shift() as OutsideEntry;
        if (dropped.token !== undefined && memory.session !== undefined && dropped.token === memory.session.token && journalReverses(dropped)) {
          memory.session.dropped += 1;
        }
      }
      pruneFollowers();
      return entry;
    },

    forCall(callId) {
      return live().filter((entry) => entry.call === callId);
    },

    forSession(token) {
      return live().filter((entry) => entry.token === token);
    },

    pending(token) {
      return live().filter((entry) => entry.token === token && journalReverses(entry)).length;
    },

    undo(scope, entries, why) {
      void scope;
      void why;
      const out: OutsideUndo = { undone: 0, kept: [] };
      const newestFirst = [...entries].sort((a, b) => b.seq - a.seq);
      for (const entry of newestFirst) {
        // A stepped entry is the form history's to take back: no inverse, nothing counted, and a removal stays restorable.
        if (!journalReverses(entry) || !memory.outside.includes(entry)) {
          continue;
        }
        let reason: OutsideKeptReason | undefined;
        try {
          reason = reverse(entry);
        } catch (error) {
          console.error("[datum-agent] outside journal undo", error);
          reason = "unavailable";
        }
        if (reason === undefined) {
          out.undone += 1;
          drop(entry);
          continue;
        }
        out.kept.push({ entry, reason, warning: keptWarning(entry, reason) });
        // A designer that is not on the page now may be later: the entry waits for the next
        // Undo all. Anything else the person changed stays theirs, and the entry goes.
        if (reason !== "unavailable") {
          drop(entry);
        }
      }
      pruneFollowers();
      return out;
    },

    restorable(kind, id) {
      const side = sideOfKind(kind);
      const catalog = catalogOf(side);
      if (catalog !== undefined && catalog.docs.some((doc) => doc.id === id)) {
        return undefined;
      }
      for (let at = memory.outside.length - 1; at >= 0; at -= 1) {
        const entry = memory.outside[at] as OutsideEntry;
        if (entry.kind === "removed" && entry.side === side && entry.id === id) {
          return entry;
        }
      }
      return undefined;
    },

    captureCatalog(side, id) {
      const catalog = catalogOf(side);
      if (catalog === undefined) {
        return undefined;
      }
      const capture: CatalogCapture = { defaults: declaredDefaults(side, catalog.configuration as CatalogDefaults) };
      const index = catalog.docs.findIndex((doc) => doc.id === id);
      if (index >= 0) {
        capture.index = index;
        capture.document = copy(catalog.docs[index] as Journey | PdfLayoutDocument);
      }
      return capture;
    },

    captureRemoval(side, id) {
      const catalog = catalogOf(side);
      if (catalog === undefined) {
        return undefined;
      }
      const index = catalog.docs.findIndex((doc) => doc.id === id);
      if (index < 0) {
        return undefined;
      }
      return { side, id, json: copy(catalog.docs[index] as Journey | PdfLayoutDocument), index, defaults: declaredDefaults(side, catalog.configuration as CatalogDefaults) };
    },

    followLayout(layoutId, controller) {
      const existing = memory.layoutFollowers.get(layoutId);
      if (existing !== undefined && existing.controller === controller && !existing.gone) {
        return;
      }
      if (existing !== undefined) {
        // Another controller for the layout (its designer was rebuilt): the steps the journal
        // holds were on the old one's history.
        existing.off();
        memory.layoutFollowers.delete(layoutId);
        markLayoutGone(layoutId);
      }
      memory.layoutTop.set(layoutId, 0);
      const follower: LayoutFollower = { controller, ceiling: 0, gone: false, mark: controller.undoMark(), off: () => undefined };
      const offMutation = controller.on("mutation", (event) => {
        const mark = controller.undoMark();
        // A write with no entry, or a part the entry atop took in, moves nothing.
        if (follower.gone || (event.action === "execute" && mark === follower.mark)) {
          return;
        }
        follower.mark = mark;
        const top = memory.layoutTop.get(layoutId) ?? 0;
        if (event.action === "execute") {
          if (memory.writing) {
            memory.layoutTop.set(layoutId, top + 1);
            follower.ceiling = top + 1;
          } else {
            memory.layoutTop.set(layoutId, 0);
            follower.ceiling = 0;
          }
        } else if (event.action === "undo") {
          if (top > 0) {
            memory.layoutTop.set(layoutId, top - 1);
          } else {
            follower.ceiling = 0;
          }
        } else if (top < follower.ceiling) {
          memory.layoutTop.set(layoutId, top + 1);
        }
      });
      const offChange = controller.on("change", (event) => {
        if (event.reason === "init") {
          markLayoutGone(layoutId);
        }
      });
      follower.off = () => {
        offMutation();
        offChange();
      };
      memory.layoutFollowers.set(layoutId, follower);
    },

    layoutGone(layoutId) {
      markLayoutGone(layoutId);
    },

    barrier(entries) {
      let newest: SaveEntry | undefined;
      for (const entry of entries) {
        if (entry.kind === "save" && (newest === undefined || entry.seq > newest.seq)) {
          newest = entry;
        }
      }
      return newest;
    },

    clear() {
      for (const follower of memory.layoutFollowers.values()) {
        try {
          follower.off();
        } catch (error) {
          console.error("[datum-agent] layout follower", error);
        }
      }
      memory.layoutFollowers.clear();
      memory.layoutTop.clear();
      memory.outside.length = 0;
    }
  };
  return journal;
}
