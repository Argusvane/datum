/**
 * The `documents` and `remove_part` tools' bodies, in one chunk (`datum-builder-agentpart-documents-*.js`; they share the designer
 * adapters' guards): the descriptors are eager in tools.ts, and `lazyTool` fetches this module on
 * the first call of either. Factories over the catalogue's `shared`; nothing lives
 * at module scope. The designers are reached only through the page's adapters: each adapter
 * member is one call on a mode, and this module imports the modes for no value.
 *
 * What the bodies hold to:
 * - The person always wins. A write yields first (`yieldToPerson` with the new `catalog` and
 *   `fields` kinds, read on the active controller and on the document's own when it is open);
 *   a document is opened only through the shell's `selectDocument`, which settles the person's
 *   edits the way their own click does, never by putting it on the page behind them; Try it's
 *   answers the person typed are cleared only with `discardTriedAnswers`.
 * - Every list change is journaled: `new`, `duplicate`, `rename`, `set_default`, `move` and
 *   `restore_removed` record a `catalog` entry captured before the act; a removal records
 *   `removed` (the document held until the page reloads); the steps `map_fields` and
 *   `create_form_fields` push onto a PDF layout's own history are `layout-steps`, counted by the
 *   journal's follower of that layout. A list change the mode makes a step of the form's history
 *   records the steps it wrote (`stepped`): the form's Undo takes it back, the
 *   entry has no inverse of its own, and the result reports those steps (`undo.steps`); any other
 *   says so (`undo.journaled`). Each result gives the one call that reverses it (`reverse`).
 * - Attribution: synchronous catalog actions run inside `shared.write`; the async mode
 *   calls (`newJourney`, `createFormFields`) take `around` and run only their synchronous writes
 *   through it, so a person's edit during their awaits is the person's. Opening is not a write.
 * - Nothing a kernel or a template says reaches a result: a preview reports codes and counts, a failed preview or field creation is worded here, never quoted.
 *
 * Guard 15's strings: `document-not-open` is spelled here only; the builder
 * catalogue's sentinel tool names and the renderer's write tool name never.
 */
import type { BuilderController } from "../../builder/controller/builder-controller.js";
import { supportedLocaleEntries, supportedLocaleOptions } from "../../core/localization/supported-locales.js";
import type { Journey, JourneyConfiguration } from "../../core/schema/journey.js";
import type { PdfConfiguration, PdfLayoutDocument } from "../../core/schema/pdf-layout.js";
import type { FormDefinition } from "../../core/schema/types.js";
import { ToolRefusal, type ToolContext, type ToolData } from "../tool-types.js";
import type { ToolBody } from "../lazy-tool.js";
import { draftRefusal, pendingDraftRefusal, promptRefusal, type BuilderCallScope, type BuilderToolsShared, type ShowRequest } from "./context.js";
import type { BuilderToolHost, DesignerAdapter, JourneyActions, PdfActions } from "./host.js";
import type {
  DesignerState,
  DocumentEntry,
  DocumentKind,
  DocumentsAction,
  DocumentsPreview,
  DocumentsResult,
  RemovePartKind,
  RemovePartResult,
  ToolFields,
  UndoInfo
} from "./types.js";
import { canonicalJson, clampIndex, copyOf, declaredDefaults, defaultAfterRemoving, localizationWithout, nonEmptyAnswer, within, withDefaults, type DocumentSide } from "./documents-support.js";

type Input = Record<string, unknown>;
type Ctx = ToolContext<BuilderToolHost>;

/** At most this many documents, known ids and templates in a result or a refusal. */
const LIST_CAP = 50;
/** `pdfTemplates()`. */
const TEMPLATES_MS = 5_000;
/** `newJourney` loads the journey designer's chunks first. */
const NEW_JOURNEY_MS = 20_000;
/** A template layout's PDF still being read before `map_fields` / `create_form_fields`. */
const TEMPLATE_WAIT_MS = 10_000;
/** `preview_pdf` loads the PDF executor and renders. */
const PREVIEW_MS = 30_000;

/** Every action, in the schema's order; a journey has these but the PDF-only four. */
const JOURNEY_ACTIONS: readonly DocumentsAction[] = ["list", "open", "new", "duplicate", "rename", "set_default", "restore_removed"];
const PDF_ACTIONS: readonly DocumentsAction[] = ["list", "open", "new", "duplicate", "rename", "set_default", "move", "map_fields", "create_form_fields", "preview_pdf", "restore_removed"];

/** The folded convention's grammar for `documents`. */
const NEEDS: Record<string, readonly string[]> = {
  open: ["id"],
  duplicate: ["id"],
  rename: ["id", "name"],
  set_default: ["id"],
  move: ["id", "toIndex"],
  restore_removed: ["id"]
};
const READS: Record<string, readonly string[]> = {
  open: ["discardTriedAnswers"],
  new: ["name", "shape", "from", "templateId", "discardTriedAnswers"],
  duplicate: ["name", "discardTriedAnswers"],
  preview_pdf: ["id", "answers"]
};
const KIND_ONLY: Record<string, string> = { shape: "journey", from: "pdf_layout", templateId: "pdf_layout", toIndex: "pdf_layout", answers: "pdf_layout" };

/** A designer on the page and answering, with its side's actions. */
type Designer =
  | { kind: "journey"; side: "journeys"; feature: "journeys"; adapter: DesignerAdapter<JourneyActions>; actions: JourneyActions }
  | { kind: "pdf_layout"; side: "pdf"; feature: "pdf"; adapter: DesignerAdapter<PdfActions>; actions: PdfActions };

// ---- refusals (hints exact) ------

/** One argument problem, as the registrar's schema check and the folded check word it. */
type ArgumentProblem = { key: string; expected: string };

function badInput(problems: readonly ArgumentProblem[], message: string): ToolRefusal {
  return new ToolRefusal("bad-input", message, "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.", { problems: problems.map((problem) => ({ ...problem })) });
}

function cancelled(): ToolRefusal {
  return new ToolRefusal("cancelled", "The call was cancelled before anything changed.", "The call was cancelled; call documents { action: 'list' } before retrying.", {});
}

function featureOff(feature: string, hidden?: true): ToolRefusal {
  return new ToolRefusal(
    "feature-off",
    hidden === true ? `The host hides the ${feature} workspace.` : `The ${feature} feature is off in this host.`,
    "This page does not allow that; tell the person instead of retrying.",
    hidden === true ? { feature, hidden: true } : { feature }
  );
}

function noUi(): ToolRefusal {
  return new ToolRefusal("no-ui", "This builder has no designers on its page.", "This builder runs without its page; journeys and PDF layouts cannot be changed here. Tell the person.", {});
}

function chunkUnavailable(what: string, state: "loading" | "failed"): ToolRefusal {
  return new ToolRefusal(
    "chunk-unavailable",
    state === "loading" ? "That part of the builder is still loading." : "That part of the builder could not be loaded.",
    state === "loading" ? "That part of the builder is still loading; call again in a moment." : "Try once more; if it fails again the host removed that file: tell the person.",
    { what, state }
  );
}

function timedOut(afterMs: number): ToolRefusal {
  return new ToolRefusal("timeout", `The call did not finish within ${afterMs} ms.`, "The builder is still working. Call documents { action: 'list' } to see where things stand.", {
    afterMs,
    stillRunning: true
  });
}

function refused(message: string, hint = "Read message; tell the person if it names something only they can change."): ToolRefusal {
  const text = message.length > 300 ? `${message.slice(0, 299)}…` : message;
  return new ToolRefusal("refused", text, hint, { message: text });
}

function nounOf(kind: DocumentKind): string {
  return kind === "journey" ? "journey" : "PDF layout";
}

function sideOf(kind: DocumentKind): DocumentSide {
  return kind === "journey" ? "journeys" : "pdf";
}

/** The `tried-answers` refusal: the person's typed answers in Try it would be cleared. */
function triedAnswersRefusal(byPerson: number, byAssistant: number, removing: boolean): ToolRefusal {
  return new ToolRefusal(
    "tried-answers",
    removing
      ? "Removing it ends Try it on it, which would clear answers the person typed; nothing was removed."
      : "Opening a document ends Try it, which would clear answers the person typed; nothing was opened.",
    removing
      ? `The person typed ${byPerson} answers in Try it on it; ask them to clear them or leave Try it, then call again.`
      : `The person typed ${byPerson} answers in Try it; tell them they will be cleared, then call again with discardTriedAnswers: true.`,
    { byPerson, byAssistant }
  );
}

function documentNotOpen(): ToolRefusal {
  return new ToolRefusal("document-not-open", "No PDF layout is open in the PDF designer; nothing was changed.", "Open it first with documents { action: 'open', kind: 'pdf_layout', id }.", {
    kind: "pdf_layout"
  });
}

function notATemplate(id: string, fields: number): ToolRefusal {
  return new ToolRefusal(
    "not-a-template",
    fields === 0 && id !== "" ? `The PDF layout "${id}" has no fillable PDF fields; nothing was changed.` : "The open layout is not a fillable PDF; nothing was changed.",
    "These actions fill a fillable PDF's fields; this layout has none, so tell the person.",
    { id, fields }
  );
}

/** A catalog's plain `Error` as the code the tool documents; anything else `refused`, never `internal`. */
function catalogRefusal(error: unknown, unknown: (id: string) => ToolRefusal): ToolRefusal {
  if (error instanceof ToolRefusal) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const quoted = /"([^"]*)"/.exec(message)?.[1] ?? "";
  if (/cannot be a journey id|cannot be a PDF layout id|layout needs an id/.test(message)) {
    return new ToolRefusal("invalid-id", message, "Use a letter, then letters, digits, _ or -, at most 128 characters; or omit id to have one generated.", { id: quoted });
  }
  if (/already exists/.test(message)) {
    return new ToolRefusal("duplicate-id", message, "Pick another id or omit it.", { id: quoted });
  }
  if (/^No (journey|PDF layout) has the id/.test(message)) {
    return unknown(quoted);
  }
  if (/layout needs a name/.test(message)) {
    return badInput([{ key: "name", expected: "a name that is not empty" }], "The arguments do not fit documents.");
  }
  if (/new place must be a number/.test(message)) {
    return badInput([{ key: "toIndex", expected: "a whole number" }], "The arguments do not fit documents.");
  }
  if (/There is no (journey|layout) to copy/.test(message)) {
    return badInput([{ key: "from", expected: "a document open in the designer to copy" }], "The arguments do not fit documents.");
  }
  return refused(message);
}

// ---- shared reads ------------------------------------------------------------------------

/** The designer `kind` lives in, ready, or the refusal its state answers. */
function designerFor(host: BuilderToolHost, kind: DocumentKind): Designer {
  const feature = sideOf(kind);
  if (!host.featureOn(feature)) {
    throw featureOff(feature);
  }
  const ui = host.ui;
  const side = kind === "journey" ? ui?.journeys?.() : ui?.pdfLayouts?.();
  if (ui === undefined || side === undefined) {
    throw noUi();
  }
  switch (side.state) {
    case "ready":
      return kind === "journey"
        ? { kind, side: "journeys", feature: "journeys", adapter: side as DesignerAdapter<JourneyActions>, actions: (side as DesignerAdapter<JourneyActions>).actions }
        : { kind, side: "pdf", feature: "pdf", adapter: side as DesignerAdapter<PdfActions>, actions: (side as DesignerAdapter<PdfActions>).actions };
    case "off":
      throw featureOff(feature);
    case "hidden":
      throw featureOff(feature, true);
    default:
      throw chunkUnavailable(feature, side.state);
  }
}

/** A side's state for a language removal: the feature and the adapter, without throwing. */
function sideState(host: BuilderToolHost, side: DocumentSide): DesignerState {
  if (!host.featureOn(side)) {
    return "off";
  }
  // Called on `ui`, never detached: a host's adapter getter may read `this` (an element host's
  // object-literal method).
  return side === "journeys" ? (host.ui?.journeys?.().state ?? "off") : (host.ui?.pdfLayouts?.().state ?? "off");
}

/** The documents as the person's dropdown lists them (try order for layouts), with what a model needs of each. */
function documentRows(designer: Designer): DocumentEntry[] {
  const openId = designer.adapter.openId();
  if (designer.kind === "journey") {
    const journeys = designer.actions.journeys();
    return designer.actions
      .list()
      .slice(0, LIST_CAP)
      .map((doc) => ({ id: doc.id, name: doc.label, isDefault: doc.isDefault === true, open: doc.id === openId, pages: journeys.find((journey) => journey.id === doc.id)?.pages.length ?? 0 }));
  }
  const layouts = designer.actions.layouts();
  return designer.actions
    .list()
    .slice(0, LIST_CAP)
    .map((doc) => {
      const layout = layouts.find((candidate) => candidate.id === doc.id);
      return { id: doc.id, name: doc.label, isDefault: doc.isDefault === true, open: doc.id === openId, layoutKind: layout?.kind ?? "generated", conditional: layout?.when !== undefined };
    });
}

/** The committed catalog of the side, as a plain copy. */
function configurationOf(designer: Designer): Record<string, unknown> {
  return copyOf((designer.kind === "journey" ? designer.actions.configuration() : designer.actions.configuration()) ?? {}) as Record<string, unknown>;
}

function docsOf(designer: Designer, configuration: Record<string, unknown>): Array<Journey | PdfLayoutDocument> {
  const listed = configuration[designer.kind === "journey" ? "journeys" : "layouts"];
  return Array.isArray(listed) ? (listed as Array<Journey | PdfLayoutDocument>) : [];
}

/** The id's row, or `unknown-document` with the ids there are. */
function requireDocument(designer: Designer, id: string): { id: string; name: string; isDefault: boolean } {
  const found = designer.actions.list().find((doc) => doc.id === id);
  if (found === undefined) {
    throw unknownDocument(designer, id);
  }
  return { id, name: found.label, isDefault: found.isDefault === true };
}

function unknownDocument(designer: Designer, id: string): ToolRefusal {
  const known = designer.actions
    .list()
    .slice(0, LIST_CAP)
    .map((doc) => ({ id: doc.id, name: doc.label }));
  return new ToolRefusal("unknown-document", `No ${nounOf(designer.kind)} has the id "${id}".`, "Use an id from documents { action: 'list', kind }.", { kind: designer.kind, id, known });
}

/** The open document's own controller when `id` is the one open (its prompt, drafts and leave guard count). */
function documentController(designer: Designer, id: string): BuilderController | undefined {
  return designer.adapter.openId() === id ? designer.adapter.controller() : undefined;
}

/** What `yieldToPerson` reads for an act on `id`: the document's controller when it is open. */
function catalogYield(designer: Designer, id: string): { controller?: BuilderController; documentId?: string } {
  const controller = documentController(designer, id);
  return controller !== undefined ? { controller, documentId: id } : {};
}

function nameOf(designer: Designer, id: string): string {
  return designer.actions.list().find((doc) => doc.id === id)?.label ?? id;
}

/**
 * Try it's typed answers now, split by who typed them, as the try
 * body counts them (`try-fields.ts` `typedCounts`): a key the agent wrote that still holds its
 * value (`memory.tried`, canonical JSON) is the agent's; any other non-empty key the person
 * typed (dirty, or a cell of a table whose rows they changed) is the person's. Read from the Try
 * it adapter's tried runtime; a page without one counts the shell's tried answers. Nothing while
 * Try it is off.
 */
function triedSplit(shared: BuilderToolsShared): { byPerson: number; byAssistant: number; total: number } {
  const ui = shared.host.ui;
  if (ui === undefined || !ui.trying()) {
    return { byPerson: 0, byAssistant: 0, total: 0 };
  }
  const tried = shared.memory.tried;
  const adapter = ui.tryIt?.();
  const typed = adapter !== undefined ? adapter.typed() : undefined;
  const values = typed?.values ?? ui.triedAnswers();
  const dirty = (key: string): boolean => {
    if (typed === undefined) {
      // The shell's tried answers are the typed keys only.
      return true;
    }
    const bracket = key.indexOf("[");
    return typed.dirty.has(key) || (bracket > 0 && typed.dirty.has(key.slice(0, bracket)));
  };
  let byPerson = 0;
  let byAssistant = 0;
  for (const [key, value] of Object.entries(values)) {
    if (!nonEmptyAnswer(value)) {
      continue;
    }
    const wrote = tried.get(key);
    if (wrote !== undefined && wrote === canonicalJson(value)) {
      byAssistant += 1;
    } else if (dirty(key)) {
      byPerson += 1;
    }
  }
  return { byPerson, byAssistant, total: byPerson + byAssistant };
}

/** The undo state of a call whose change is in the outside journal. */
function journaledUndo(shared: BuilderToolsShared, scope: BuilderCallScope, steps: number): UndoInfo & { journaled: true } {
  return { ...shared.undoInfo(scope, steps), journaled: true };
}

/**
 * The undo state of a catalog action: a step of the form's history when the mode made it one
 * (`steps`: every catalog action, but a PDF layout's new name its built
 * designer takes and the catalog seam), which the form's Undo takes back and the journal entry
 * leaves to it; else journaled.
 */
function catalogUndo(shared: BuilderToolsShared, scope: BuilderCallScope, steps: number): UndoInfo & { journaled?: true } {
  return steps > 0 ? shared.undoInfo(scope, steps) : journaledUndo(shared, scope, 0);
}

/** Shows a write with a notice whose button runs this call's journal entries. */
function showJournaled(shared: BuilderToolsShared, scope: BuilderCallScope, announce: string, options: { ids?: readonly string[]; undoSteps?: number; restore?: true } = {}): { componentId?: string } | undefined {
  const request: ShowRequest = { ids: options.ids ?? [], announce, undoSteps: options.undoSteps ?? 0, journaled: options.restore === true ? { call: scope.call, restore: true } : { call: scope.call } };
  return shared.show(scope, request);
}

function checkSignal(ctx: Ctx): void {
  if (ctx.signal.aborted) {
    throw cancelled();
  }
}

/** A prompt the shell raised on a request the agent made (the race): answered `stay`, and refused. */
function raceRefusal(shared: BuilderToolsShared, scope: BuilderCallScope): ToolRefusal | undefined {
  const active = shared.host.ui?.activeController?.() ?? scope.controller;
  for (const controller of new Set([active, scope.controller])) {
    const prompt = controller.unsavedChangesPrompt();
    if (prompt !== undefined) {
      controller.answerUnsavedChangesPrompt("stay");
      return draftRefusal(prompt.componentId);
    }
  }
  return undefined;
}

// ---- documents ---------------------------------------------------------------------------

/** The `documents` body over one catalogue's shared helpers. */
export function documentsBody(shared: BuilderToolsShared): ToolBody<Input, BuilderToolHost> {
  const host = shared.host;
  const journal = shared.journal;

  /** Rule 4 and 5 of the folded convention, plus `templateId`'s one condition (`from: 'template'`). */
  const grammar = (input: Input, action: DocumentsAction, kind: DocumentKind): string[] => {
    const check = shared.folded(input, {
      key: "action",
      action,
      kind,
      needs: NEEDS,
      reads: READS,
      always: ["builder", "expectedRevision", "kind"],
      kindActions: { journey: JOURNEY_ACTIONS, pdf_layout: PDF_ACTIONS },
      kindOnly: KIND_ONLY
    });
    const problems = [...check.problems];
    const warnings = [...check.warnings];
    if (action === "new" && kind === "pdf_layout") {
      const template = input.from === "template";
      if (template && typeof input.templateId !== "string") {
        problems.push({ key: "templateId", expected: "required for action 'new' with from 'template'" });
      } else if (!template && input.templateId !== undefined) {
        warnings.push("ignored argument for action 'new': templateId");
      }
    }
    if (problems.length > 0) {
      const byKind = problems.some((problem) => problem.expected.startsWith("an action for kind") || problem.expected.startsWith("kind '"));
      throw badInput(problems, byKind ? `The arguments do not fit documents for kind '${kind}'.` : `The arguments do not fit documents for action '${action}'.`);
    }
    return warnings;
  };

  /** The fields every result carries: the list as it is now and the designer. */
  const listed = (designer: Designer, action: DocumentsAction): Pick<DocumentsResult, "kind" | "action" | "documents" | "designer" | "opensAs"> => {
    const openId = designer.adapter.openId();
    return {
      kind: designer.kind,
      action,
      documents: documentRows(designer),
      ...(designer.kind === "journey" ? { opensAs: designer.actions.opensAs() } : {}),
      designer: { state: "ready", workspace: designer.adapter.workspace(), ...(openId !== undefined ? { openId } : {}) }
    };
  };

  /** The written document as a result names it. */
  const documentOf = (designer: Designer, id: string): { id: string; name: string; isDefault: boolean } => {
    const doc = designer.actions.list().find((entry) => entry.id === id);
    return { id, name: doc?.label ?? id, isDefault: doc?.isDefault === true };
  };

  /** What `next` says after a document opened or was made, by kind and layout kind. */
  const nextFor = (designer: Designer, id: string, made: boolean): string[] => {
    if (designer.kind === "journey") {
      return made ? ["try_it { action: 'fill' } tries it page by page; check_form reports journey problems."] : ["try_it { action: 'fill' } tries it page by page."];
    }
    const layout = designer.actions.layouts().find((candidate) => candidate.id === id);
    if (layout?.kind === "template") {
      return ["documents { action: 'map_fields', kind: 'pdf_layout' } fills its PDF fields from matching form fields."];
    }
    return ["documents { action: 'preview_pdf', kind: 'pdf_layout', id } shows the person the PDF this layout prints."];
  };

  /**
   * Opening (`open`): Try it ends first (the person's typed
   * answers only with `discard`), then the shell's `selectDocument` and its waiter. `made`: the
   * call already made the document, so a block answers `opened: false` with the note instead of
   * a refusal. Not a write: it runs outside `shared.write`.
   */
  const openDocument = async (
    designer: Designer,
    scope: BuilderCallScope,
    ctx: Ctx,
    id: string,
    discard: boolean,
    made: boolean
  ): Promise<{ opened: true } | { opened: false; note: string }> => {
    const ui = host.ui;
    const blocked = { opened: false as const, note: "Made; open it with documents { action: 'open' } when the person is free." };
    if (ui?.selectDocument === undefined) {
      if (made) {
        return blocked;
      }
      throw noUi();
    }
    if (made) {
      // The pre-check ran before the make; a prompt or a draft may have come up during its awaits.
      const active = ui.activeController?.() ?? scope.controller;
      for (const controller of new Set([active, scope.controller])) {
        if (pendingDraftRefusal(controller) !== undefined || controller.hasPendingLeaveGuard()) {
          return blocked;
        }
      }
    }
    if (!made) {
      // Before anything ends Try it. A made document is already journaled: a caller who gave up
      // still gets what was made.
      checkSignal(ctx);
    }
    if (ui.trying()) {
      const tried = triedSplit(shared);
      if (tried.byPerson > 0 && !discard) {
        if (made) {
          return blocked;
        }
        throw triedAnswersRefusal(tried.byPerson, tried.byAssistant, false);
      }
      if (tried.total > 0) {
        ui.clearTriedAnswers();
      }
      ui.setTrying(false);
    }
    const outcome = await ui.selectDocument(designer.side, id);
    if (outcome.status === "opened") {
      return { opened: true };
    }
    const race = raceRefusal(shared, scope);
    if (race !== undefined) {
      if (made) {
        return blocked;
      }
      throw race;
    }
    if (outcome.status === "timeout") {
      if (made) {
        return { opened: false, note: "Made; it is still opening in its designer: documents { action: 'list' } shows when it is open." };
      }
      throw timedOut(10_000);
    }
    if (made) {
      return blocked;
    }
    throw chunkUnavailable(designer.kind === "journey" ? "journey-designer" : "pdf-designer", "failed");
  };

  /** A made document's result: journaled, reversed through `remove_part`, opened unless something holds it. */
  const madeResult = async (designer: Designer, scope: BuilderCallScope, ctx: Ctx, action: "new" | "duplicate" | "restore_removed", id: string, discard: boolean, notes: string[], steps: number): Promise<ToolFields<DocumentsResult>> => {
    const shown = showJournaled(shared, scope, scope.words.text("agent.did.document", { name: nameOf(designer, id) }), { undoSteps: steps });
    const open = action === "restore_removed" ? undefined : await openDocument(designer, scope, ctx, id, discard, true);
    const note = [...notes, ...(open !== undefined && !open.opened ? [open.note] : [])];
    const payload = shared.payload(scope, steps, shown);
    return {
      ...listed(designer, action),
      changed: true,
      document: documentOf(designer, id),
      ...(open !== undefined ? { opened: open.opened } : {}),
      reverse: { tool: "remove_part", input: { kind: designer.kind, id } },
      ...payload,
      undo: catalogUndo(shared, scope, steps),
      ...(note.length > 0 ? { note } : {}),
      next: action === "restore_removed" ? ["documents { action: 'list', kind } shows the list as it is now."] : nextFor(designer, id, true)
    };
  };

  /** A list change's result (`rename`, `set_default`, `move`), journaled when it changed anything. */
  const changedResult = (designer: Designer, scope: BuilderCallScope, action: DocumentsAction, id: string, reverse: Record<string, unknown> | undefined, extra: Partial<ToolFields<DocumentsResult>> = {}, steps = 0): ToolFields<DocumentsResult> => {
    if (reverse === undefined) {
      return { ...listed(designer, action), changed: false, document: documentOf(designer, id), next: ["documents { action: 'list', kind } shows the list as it is now."] };
    }
    const shown = showJournaled(shared, scope, scope.words.text("agent.did.document", { name: nameOf(designer, id) }), { undoSteps: steps });
    return {
      ...listed(designer, action),
      changed: true,
      document: documentOf(designer, id),
      reverse: { tool: "documents", input: reverse },
      ...shared.payload(scope, steps, shown),
      undo: catalogUndo(shared, scope, steps),
      ...extra,
      next: ["documents { action: 'list', kind } shows the list as it is now."]
    };
  };

  /** Runs a synchronous catalog action as the agent's write, its plain errors mapped; `steps`: the form steps it made. */
  const catalogWrite = <T>(designer: Designer, scope: BuilderCallScope, run: () => T): { value: T; steps: number } => {
    try {
      return shared.write(scope, run);
    } catch (error) {
      throw catalogRefusal(error, (id) => unknownDocument(designer, id));
    }
  };

  // ---- actions ----

  const list = async (designer: Designer): Promise<ToolFields<DocumentsResult>> => {
    const ui = host.ui;
    const warnings: string[] = [];
    const result: ToolFields<DocumentsResult> = { ...listed(designer, "list"), changed: false };
    if (designer.kind === "journey") {
      const diagnostics = ui?.journeyDiagnostics?.();
      result.findings =
        diagnostics === undefined
          ? { checked: false }
          : { errors: diagnostics.filter((entry) => entry.severity === "error").length, warnings: diagnostics.filter((entry) => entry.severity !== "error").length };
    } else {
      const findings = ui?.pdfFindings?.();
      // A layout finding is advisory: none holds a Save back.
      result.findings = findings === undefined ? { checked: false } : { errors: 0, warnings: findings.length };
      if (ui?.pdfTemplates !== undefined) {
        const answered = await within(ui.pdfTemplates(), TEMPLATES_MS).catch(() => undefined);
        if (answered === undefined) {
          warnings.push("templates-unanswered: the site's template list did not answer");
        } else {
          result.templates = answered.value.slice(0, LIST_CAP).map((template) => ({ templateId: template.templateId, label: template.label }));
        }
      }
    }
    return { ...result, next: ["documents { action: 'open', kind, id } shows one to the person."], ...(warnings.length > 0 ? { warnings } : {}) } as ToolFields<DocumentsResult>;
  };

  const open = async (designer: Designer, scope: BuilderCallScope, ctx: Ctx, input: Input): Promise<ToolFields<DocumentsResult>> => {
    const id = input.id as string;
    // The order checks run in: the person's state before an unknown id.
    shared.yieldToPerson(scope, "catalog");
    requireDocument(designer, id);
    await openDocument(designer, scope, ctx, id, input.discardTriedAnswers === true, false);
    return { ...listed(designer, "open"), changed: false, document: documentOf(designer, id), opened: true, next: nextFor(designer, id, false) };
  };

  const create = async (designer: Designer, scope: BuilderCallScope, ctx: Ctx, input: Input): Promise<ToolFields<DocumentsResult>> => {
    const name = typeof input.name === "string" && input.name.trim() !== "" ? input.name : undefined;
    const discard = input.discardTriedAnswers === true;
    const openId = designer.adapter.openId();
    if (designer.kind === "journey") {
      const shape = (input.shape as "sections" | "questions" | "one-page" | "questions-one-page" | "copy" | undefined) ?? "sections";
      if (shape === "copy" && openId === undefined) {
        throw badInput([{ key: "shape", expected: "'copy' copies the journey open in the designer, and none is open" }], "The arguments do not fit documents for action 'new'.");
      }
      shared.yieldToPerson(scope, "catalog");
      const first = designer.actions.journeys().length === 0;
      const before = journal.captureCatalog("journeys", "");
      const actions = designer.actions;
      // The designer's chunk loads first, outside the writing flag; only the catalog
      // write runs through `around`. A journey the mode makes after the call timed out is still
      // journaled, so Undo all reaches it.
      let stepped = false;
      // The form steps the make wrote (a journey added is one).
      let steps = 0;
      const around = (step: () => void): void => {
        stepped = true;
        steps += shared.write(scope, step).steps;
      };
      const work = actions.newJourney({ ...(name !== undefined ? { name } : {}), from: shape, select: false, around });
      let made: Journey;
      try {
        const outcome = await within(work, NEW_JOURNEY_MS);
        if (outcome === undefined) {
          void work.then(
            (late) => {
              if (before !== undefined) {
                journal.record(scope, { kind: "catalog", side: "journeys", action: "new", id: late.id, before, stepped: steps });
              }
            },
            () => undefined
          );
          throw timedOut(NEW_JOURNEY_MS);
        }
        made = outcome.value;
      } catch (error) {
        if (error instanceof ToolRefusal) {
          throw error;
        }
        // Nothing was written: the designer's chunk did not load (or the form gave it nothing to build).
        throw stepped ? catalogRefusal(error, (id) => unknownDocument(designer, id)) : chunkUnavailable("journey-designer", "failed");
      }
      if (before !== undefined) {
        journal.record(scope, { kind: "catalog", side: "journeys", action: "new", id: made.id, before, stepped: steps });
      }
      // Read after the make: a declared `opensAs: "form"` (left behind when the person removed
      // their last journey) still opens the form whole, and the note would be false.
      const notes =
        first && actions.opensAs() === "journey"
          ? ["The form now opens as this journey (its first journey); documents { action: 'set_default', kind: 'journey', id: 'form' } opens it on one page again."]
          : [];
      return madeResult(designer, scope, ctx, "new", made.id, discard, notes, steps);
    }
    const from = (input.from as "form" | "blank" | "copy" | "template" | undefined) ?? "form";
    const actions = designer.actions;
    let source: { templateId: string; source: Parameters<PdfActions["addTemplate"]>[0] } | undefined;
    // The order checks run in: the person's state before an unknown template; read
    // again below, right before the write, since the template list is awaited in between.
    shared.yieldToPerson(scope, "catalog");
    if (from === "template") {
      const templateId = input.templateId as string;
      const answered = host.ui?.pdfTemplates === undefined ? { value: [] } : await within(host.ui.pdfTemplates(), TEMPLATES_MS).catch(() => undefined);
      const templates = answered?.value ?? [];
      const option = templates.find((template) => template.templateId === templateId);
      if (option === undefined) {
        throw new ToolRefusal(
          "unknown-template",
          `The site offers no template "${templateId}".`,
          "Use a templateId from documents { action: 'list', kind: 'pdf_layout' }; files cannot be uploaded by an assistant.",
          { templateId, known: templates.slice(0, LIST_CAP).map((template) => ({ templateId: template.templateId, label: template.label })) }
        );
      }
      source = { templateId, source: option.source };
      checkSignal(ctx);
    } else if (from === "copy" && openId === undefined) {
      throw badInput([{ key: "from", expected: "'copy' copies the layout open in the designer, and none is open" }], "The arguments do not fit documents for action 'new'.");
    }
    shared.yieldToPerson(scope, "catalog");
    const before = journal.captureCatalog("pdf", "");
    // PBM refuses a layout without a name, so the builder's own default words stand in.
    const made =
      source !== undefined
        ? catalogWrite(designer, scope, () => actions.addTemplate(source.source, name ?? ""))
        : catalogWrite(designer, scope, () => actions.newLayout({ name: name ?? scope.words.text(from === "blank" ? "pdf.newName.blank" : "pdf.newName.custom"), from: from === "template" ? "form" : from, select: false }));
    if (before !== undefined) {
      journal.record(scope, { kind: "catalog", side: "pdf", action: "new", id: made.value.id, before, stepped: made.steps });
    }
    return madeResult(designer, scope, ctx, "new", made.value.id, discard, [], made.steps);
  };

  const duplicate = async (designer: Designer, scope: BuilderCallScope, ctx: Ctx, input: Input): Promise<ToolFields<DocumentsResult>> => {
    const id = input.id as string;
    // The order checks run in: the person's state before an unknown id (an unknown
    // id is never the open document, so the yield reads the active controller alone).
    shared.yieldToPerson(scope, "catalog", catalogYield(designer, id));
    requireDocument(designer, id);
    const name = typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim() : undefined;
    const before = journal.captureCatalog(designer.side, "");
    const copy =
      designer.kind === "journey"
        ? catalogWrite(designer, scope, () => designer.actions.duplicate(id, { ...(name !== undefined ? { name } : {}), select: false }))
        : catalogWrite(designer, scope, () => designer.actions.duplicate(id, { ...(name !== undefined ? { name } : {}), select: false }));
    if (before !== undefined) {
      journal.record(scope, { kind: "catalog", side: designer.side, action: "duplicate", id: copy.value.id, before, stepped: copy.steps });
    }
    return madeResult(designer, scope, ctx, "duplicate", copy.value.id, input.discardTriedAnswers === true, [], copy.steps);
  };

  const rename = (designer: Designer, scope: BuilderCallScope, input: Input): ToolFields<DocumentsResult> => {
    const id = input.id as string;
    // A blank name is no name: the modes would delete the document's (PBM `renameLayout`, JBM
    // `renameJourney`), and the tool documents that rename needs one.
    const name = (input.name as string).trim();
    if (name === "") {
      throw badInput([{ key: "name", expected: "a name that is not empty" }], "The arguments do not fit documents for action 'rename'.");
    }
    // The order checks run in: the person's state before an unknown id.
    shared.yieldToPerson(scope, "catalog", catalogYield(designer, id));
    const row = requireDocument(designer, id);
    // A rename is a step of the form's history, a built designer's tree taking the name with no
    // entry of its own, so nothing lands on a layout's history here.
    const before = journal.captureCatalog(designer.side, id);
    const docBefore = canonicalJson(docsOf(designer, configurationOf(designer)).find((doc) => doc.id === id));
    const { steps } = catalogWrite(designer, scope, () => (designer.kind === "journey" ? designer.actions.rename(id, name) : designer.actions.rename(id, name)));
    const docAfter = canonicalJson(docsOf(designer, configurationOf(designer)).find((doc) => doc.id === id));
    if (docAfter === docBefore) {
      return changedResult(designer, scope, "rename", id, undefined);
    }
    if (before !== undefined) {
      journal.record(scope, { kind: "catalog", side: designer.side, action: "rename", id, before, stepped: steps });
    }
    return changedResult(designer, scope, "rename", id, { action: "rename", kind: designer.kind, id, name: row.name }, {}, steps);
  };

  const setDefault = (designer: Designer, scope: BuilderCallScope, input: Input): ToolFields<DocumentsResult> => {
    const id = input.id as string;
    const whole = designer.kind === "journey" && id === "form";
    // The order checks run in: the person's state before an unknown id, and before
    // the no-op answer (a write yields first, as a rename to the same name does).
    shared.yieldToPerson(scope, "catalog", whole ? {} : catalogYield(designer, id));
    if (!whole) {
      requireDocument(designer, id);
    }
    const rows = designer.actions.list();
    const opensAs = designer.kind === "journey" ? designer.actions.opensAs() : undefined;
    const effective = opensAs === "form" ? "form" : rows.find((doc) => doc.isDefault === true)?.id;
    if (effective === id) {
      // Already the default: nothing written, nothing to reverse.
      return changedResult(designer, scope, "set_default", id, undefined);
    }
    const before = journal.captureCatalog(designer.side, whole ? "" : id);
    const { steps } = catalogWrite(designer, scope, () => (designer.kind === "journey" ? designer.actions.chooseOpensAs(id) : designer.actions.setDefault(id)));
    if (before !== undefined) {
      journal.record(scope, { kind: "catalog", side: designer.side, action: "set_default", id, before, stepped: steps });
    }
    const back = effective ?? (designer.kind === "journey" ? "form" : id);
    return changedResult(designer, scope, "set_default", id, { action: "set_default", kind: designer.kind, id: back }, {}, steps);
  };

  const move = (designer: Designer & { kind: "pdf_layout" }, scope: BuilderCallScope, input: Input): ToolFields<DocumentsResult> => {
    const id = input.id as string;
    const toIndex = input.toIndex as number;
    // The order checks run in: the person's state before an unknown id.
    shared.yieldToPerson(scope, "catalog", catalogYield(designer, id));
    requireDocument(designer, id);
    const order = designer.actions.list().map((doc) => doc.id);
    const from = order.indexOf(id);
    const place = Math.max(0, Math.min(order.length - 1, Math.trunc(toIndex)));
    if (order[place] === id) {
      return changedResult(designer, scope, "move", id, undefined);
    }
    const before = journal.captureCatalog("pdf", id);
    const { steps } = catalogWrite(designer, scope, () => designer.actions.move(id, toIndex));
    if (before !== undefined) {
      journal.record(scope, { kind: "catalog", side: "pdf", action: "move", id, before, stepped: steps });
    }
    return changedResult(designer, scope, "move", id, { action: "move", kind: "pdf_layout", id, toIndex: from }, {}, steps);
  };

  const restoreRemoved = async (designer: Designer, scope: BuilderCallScope, ctx: Ctx, input: Input): Promise<ToolFields<DocumentsResult>> => {
    const id = input.id as string;
    const held = journal.restorable(designer.kind, id);
    if (held === undefined) {
      throw new ToolRefusal("nothing-to-restore", `Nothing removed is held for the ${nounOf(designer.kind)} "${id}".`, "Nothing you removed is held for that id; it cannot be brought back from here.", {
        kind: designer.kind,
        id
      });
    }
    shared.yieldToPerson(scope, "catalog");
    const before = journal.captureCatalog(designer.side, id);
    // The catalog seam: the document at its stored index and the default as it
    // was declared, never the reseeding setters. The removed entry stays in the journal (Undo all
    // over the removal and this restore nets out); a default the person chose since stays theirs.
    const configuration = configurationOf(designer);
    const docs = [...docsOf(designer, configuration)];
    docs.splice(clampIndex(held.index, docs.length), 0, copyOf(held.json));
    const next: Record<string, unknown> = { ...configuration, [designer.kind === "journey" ? "journeys" : "layouts"]: docs };
    const declared = canonicalJson(declaredDefaults(designer.side, configuration as JourneyConfiguration & PdfConfiguration));
    const untouched = held.leftDefaults === undefined || declared === canonicalJson(held.leftDefaults);
    const warnings: string[] = [];
    if (untouched) {
      withDefaults(designer.side, next, held.defaults as Record<string, unknown>);
    } else if (canonicalJson(held.defaults) !== canonicalJson(held.leftDefaults)) {
      warnings.push(`default-kept: the default ${nounOf(designer.kind)} the person chose since the removal stays; ${id} is not made the default again`);
    }
    const { steps } = catalogWrite(designer, scope, () => (designer.kind === "journey" ? designer.actions.applyCatalog(next as JourneyConfiguration, id) : designer.actions.applyCatalog(next as PdfConfiguration, id)));
    if (before !== undefined) {
      journal.record(scope, { kind: "catalog", side: designer.side, action: "restore_removed", id, before, stepped: steps });
    }
    const result = await madeResult(designer, scope, ctx, "restore_removed", id, false, [], steps);
    return { ...result, ...(warnings.length > 0 ? { warnings } : {}) } as ToolFields<DocumentsResult>;
  };

  /**
   * The template layout open in the PDF designer, its designer up and its PDF read:
   * waits for a template still being read, up to 10 s, then answers `chunk-unavailable
   * { pdf-template }` (retryable); a generated layout, or a PDF read with no fields, is
   * `not-a-template`.
   */
  const openTemplate = async (designer: Designer & { kind: "pdf_layout" }, ctx: Ctx): Promise<{ id: string; controller: BuilderController; fields: number }> => {
    const actions = designer.actions;
    let state = actions.openState();
    const id = state.id ?? designer.adapter.openId();
    if (id === undefined) {
      throw documentNotOpen();
    }
    const layout = actions.layouts().find((candidate) => candidate.id === id);
    if (layout === undefined) {
      throw documentNotOpen();
    }
    if (layout.kind !== "template") {
      throw notATemplate(id, 0);
    }
    if (!state.ready || state.template === undefined) {
      const ready = await actions.whenOpenReady(TEMPLATE_WAIT_MS);
      checkSignal(ctx);
      if (ready !== "ready") {
        throw chunkUnavailable("pdf-template", ready);
      }
      state = actions.openState();
      if (state.id !== id || state.template === undefined) {
        // The person put another layout on the page meanwhile: ask again.
        throw chunkUnavailable("pdf-template", "loading");
      }
    }
    const fields = state.template?.fields ?? 0;
    if (fields === 0) {
      throw notATemplate(id, 0);
    }
    const controller = actions.layoutController();
    if (controller === undefined) {
      throw chunkUnavailable("pdf-designer", "loading");
    }
    return { id, controller, fields };
  };

  const mapFields = async (designer: Designer & { kind: "pdf_layout" }, scope: BuilderCallScope, ctx: Ctx): Promise<ToolFields<DocumentsResult>> => {
    const open = await openTemplate(designer, ctx);
    // PBM's `suggestMappings` writes the layout with no draft check (PBM:1076): the layout
    // controller's prompt, drafts and leave guard are read here.
    shared.yieldToPerson(scope, "catalog", { controller: open.controller, documentId: open.id });
    shared.followLayout(scope, open.id, open.controller);
    const top = (): number => shared.memory.layoutTop.get(open.id) ?? 0;
    const topBefore = top();
    // Every mapping as one layout step.
    const mapped = designer.actions.suggestMappings({ batch: true, around: shared.around(scope) });
    const steps = Math.max(0, top() - topBefore);
    if (steps > 0) {
      journal.record(scope, { kind: "layout-steps", layoutId: open.id, steps });
    }
    const layout = designer.actions.layouts().find((candidate) => candidate.id === open.id);
    const left = Math.max(0, open.fields - (layout?.kind === "template" ? layout.fields.length : 0));
    const next = left > 0 ? ["documents { action: 'create_form_fields', kind: 'pdf_layout' } adds form fields for the PDF fields left unmapped."] : ["documents { action: 'preview_pdf', kind: 'pdf_layout' } shows the person the filled PDF."];
    if (mapped === 0 && steps === 0) {
      return { ...listed(designer, "map_fields"), changed: false, mapped: 0, next };
    }
    // The notice's Undo runs the journaled layout step; a mapping no step of which the journal
    // could follow (none expected) is announced without one.
    const announce = scope.words.plural("agent.did.mapFields", mapped, { count: mapped });
    const shown = steps > 0 ? showJournaled(shared, scope, announce) : shared.show(scope, { ids: [], announce, undoSteps: 0 });
    return {
      ...listed(designer, "map_fields"),
      changed: true,
      mapped,
      ...(steps > 0 ? { elsewhere: { what: `PDF layout ${open.id}`, steps } } : {}),
      ...(steps > 0
        ? {
            note: [
              `${mapped === 1 ? "The mapping is" : `The ${mapped} mappings are`} one step on the PDF layout's own undo history: the person undoes it in the PDF designer; end_session { undo: true } takes it back while it is the latest there.`
            ]
          }
        : {}),
      ...shared.payload(scope, 0, shown),
      ...(steps > 0 ? { undo: journaledUndo(shared, scope, 0) } : {}),
      next
    };
  };

  const createFormFields = async (designer: Designer & { kind: "pdf_layout" }, scope: BuilderCallScope, ctx: Ctx): Promise<ToolFields<DocumentsResult>> => {
    const open = await openTemplate(designer, ctx);
    // The `fields` kind, never `wrong-mode` (the PDF designer is on the page), with the
    // layout's controller, whose drafts PBM does not read for the form insert.
    shared.yieldToPerson(scope, "fields", { controller: open.controller, documentId: open.id });
    shared.followLayout(scope, open.id, open.controller);
    const top = (): number => shared.memory.layoutTop.get(open.id) ?? 0;
    const topBefore = top();
    // The form insert and the layout's write run with the flag up, the awaits between them without.
    let formSteps = 0;
    const around = (step: () => void): void => {
      formSteps += shared.write(scope, step).steps;
    };
    // PBM awaits the host's templates after the form insert (`refreshTemplateComponents`): a
    // rejection there is refused, never `internal`, and whatever landed
    // before it is still accounted for below.
    let outcome: Awaited<ReturnType<PdfActions["createFormFields"]>> | undefined;
    try {
      outcome = await designer.actions.createFormFields({ around });
    } catch {
      outcome = undefined;
    }
    const layoutSteps = Math.max(0, top() - topBefore);
    if (layoutSteps > 0) {
      journal.record(scope, { kind: "layout-steps", layoutId: open.id, steps: layoutSteps });
    }
    if (outcome === undefined) {
      throw refused(
        formSteps > 0
          ? "The builder did not finish adding the form fields; the fields it added are on the form's undo history, their PDF mappings were not written."
          : "The builder did not add the form fields; nothing was changed.",
        "Tell the person; the PDF designer's Create form fields button says why."
      );
    }
    if (outcome.errorCode !== undefined || outcome.error !== undefined) {
      // The code, never PBM's words.
      switch (outcome.errorCode) {
        case "form-unsaved":
          throw pendingDraftRefusal(scope.controller) ?? draftRefusal(scope.controller.selectedComponentId() ?? scope.controller.rootId());
        case "layout-unsaved":
          throw pendingDraftRefusal(open.controller, open.id) ?? draftRefusal(`${open.id}/${open.controller.rootId()}`);
        case "holding": {
          const prompt = scope.controller.unsavedChangesPrompt() ?? open.controller.unsavedChangesPrompt();
          throw prompt !== undefined
            ? promptRefusal(prompt)
            : new ToolRefusal(
                "unsaved-draft",
                "The builder is asking the person to save or discard an edit; nothing was changed.",
                "The builder is asking the person to save or discard an edit; wait for them to answer, then call again.",
                { reason: "prompt" }
              );
        }
        case "no-form":
          throw notATemplate(open.id, open.fields);
        default:
          throw refused("The builder did not add the form fields; nothing was changed.", "Tell the person; the PDF designer's Create form fields button says why.");
      }
    }
    const added = [...outcome.added];
    const formFields = {
      added,
      mapped: outcome.mapped,
      matched: outcome.matched,
      skipped: outcome.skipped.slice(0, LIST_CAP).map((entry) => ({ pdfField: entry.pdfField, reason: entry.reason }))
    };
    if (formSteps === 0 && layoutSteps === 0) {
      return { ...listed(designer, "create_form_fields"), changed: false, formFields, ...shared.payload(scope, 0), next: ["documents { action: 'preview_pdf', kind: 'pdf_layout' } shows the person the filled PDF."] };
    }
    const shown = shared.show(scope, {
      ids: added,
      announce: scope.words.plural("agent.did.createFormFields", added.length, { count: added.length }),
      undoSteps: formSteps,
      ...(layoutSteps > 0 ? { journaled: { call: scope.call } } : {})
    });
    const payload = shared.payload(scope, formSteps, shown);
    return {
      ...listed(designer, "create_form_fields"),
      changed: true,
      formFields,
      ...(layoutSteps > 0 ? { elsewhere: { what: `PDF layout ${open.id}`, steps: layoutSteps } } : {}),
      ...(layoutSteps > 0
        ? { note: ["The new form fields are on history; their mappings are one step on the PDF layout's own undo history: the person undoes that in the PDF designer; end_session { undo: true } takes it back while it is the latest there."] }
        : {}),
      ...payload,
      ...(layoutSteps > 0 ? { undo: journaledUndo(shared, scope, formSteps) } : {}),
      next: ["get_form shows the new fields; set labels and rules with set_properties.", "documents { action: 'preview_pdf', kind: 'pdf_layout' } shows the person the filled PDF."]
    };
  };

  const previewPdf = async (designer: Designer & { kind: "pdf_layout" }, ctx: Ctx, input: Input): Promise<ToolFields<DocumentsResult>> => {
    const id = typeof input.id === "string" ? input.id : undefined;
    if (id !== undefined) {
      requireDocument(designer, id);
    }
    const ui = host.ui;
    const warnings: string[] = [];
    const tried = ui?.triedRuntimeForPdf?.();
    const triedSome = tried !== undefined && ui !== undefined && Object.keys(ui.triedAnswers()).length > 0;
    let answers: "tried" | "host" = (input.answers as "tried" | "host" | undefined) ?? (triedSome ? "tried" : "host");
    if (answers === "tried" && tried === undefined) {
      answers = "host";
      warnings.push("no-tried-answers: Try it holds no answers; the preview prints the page's sample answers");
    }
    const runtime = answers === "tried" ? tried : ui?.hostRuntimeForPdf?.();
    checkSignal(ctx);
    // Never a `signature` (the builder's previews never sign, PBM:1270): the seam takes the layout and the answers only.
    const answered = await within(designer.actions.previewReport({ ...(id !== undefined ? { layoutId: id } : {}), ...(runtime !== undefined ? { runtime } : {}) }), PREVIEW_MS).catch(() => ({
      value: { error: "failed" } as { error: string; busy?: true }
    }));
    if (answered === undefined) {
      throw timedOut(PREVIEW_MS);
    }
    const report = answered.value;
    if ("error" in report) {
      if (report.busy === true) {
        throw new ToolRefusal("busy", "A PDF preview is already being made.", "Wait a moment for the preview the builder is making, then call again.", { because: "pdf-preview" });
      }
      // The render's own words (a kernel's, the service's) are never quoted.
      throw refused("The PDF preview could not be made; nothing was shown.", "Tell the person; Preview PDF in the PDF designer shows them what went wrong.");
    }
    const preview: DocumentsPreview = {
      layoutId: report.layoutId,
      // The documented `given` is a layout the call named; PBM says `asked` for one asked for by id.
      layoutChoice: report.layoutChoice === "asked" ? "given" : report.layoutChoice,
      layoutKind: report.layoutKind,
      pageCount: report.pageCount,
      answers: runtime === undefined ? "none" : answers,
      // Codes and component ids, never a warning's message.
      warnings: report.warnings.slice(0, 20).map((warning) => ({ code: String(warning.code), ...(typeof warning.componentId === "string" ? { componentId: warning.componentId } : {}) })),
      ...(report.fields !== undefined ? { fields: { filled: report.fields.filled, empty: report.fields.empty } } : {})
    };
    return {
      ...listed(designer, "preview_pdf"),
      changed: false,
      preview,
      next: ["Tell the person the preview is open; downloading it from there is theirs."],
      ...(warnings.length > 0 ? { warnings } : {})
    } as ToolFields<DocumentsResult>;
  };

  return {
    async run(input: Input, ctx: Ctx): Promise<ToolData> {
      const action = input.action as DocumentsAction;
      const kind = input.kind as DocumentKind;
      const warnings = grammar(input, action, kind);
      const scope = shared.scope(ctx);
      const designer = designerFor(host, kind);
      let result: ToolFields<DocumentsResult>;
      switch (action) {
        case "list":
          result = await list(designer);
          break;
        case "open":
          result = await open(designer, scope, ctx, input);
          break;
        case "new":
          result = await create(designer, scope, ctx, input);
          break;
        case "duplicate":
          result = await duplicate(designer, scope, ctx, input);
          break;
        case "rename":
          result = rename(designer, scope, input);
          break;
        case "set_default":
          result = setDefault(designer, scope, input);
          break;
        case "restore_removed":
          result = await restoreRemoved(designer, scope, ctx, input);
          break;
        default: {
          // The PDF-only actions; the grammar refused them for a journey.
          if (designer.kind !== "pdf_layout") {
            throw badInput([{ key: "action", expected: `an action for kind 'journey': ${JOURNEY_ACTIONS.join(", ")}` }], "The arguments do not fit documents for kind 'journey'.");
          }
          if (action === "move") {
            result = move(designer, scope, input);
          } else if (action === "map_fields") {
            result = await mapFields(designer, scope, ctx);
          } else if (action === "create_form_fields") {
            result = await createFormFields(designer, scope, ctx);
          } else {
            result = await previewPdf(designer, ctx, input);
          }
        }
      }
      const own = (result as { warnings?: string[] }).warnings ?? [];
      const all = [...warnings, ...own];
      return { ...result, ...(all.length > 0 ? { warnings: all } : {}) } as unknown as ToolData;
    }
  };
}

// ---- remove_part -------------------------------------------------------------------------

/** The `remove_part` body over one catalogue's shared helpers. */
export function removePartBody(shared: BuilderToolsShared): ToolBody<Input, BuilderToolHost> {
  const host = shared.host;
  const journal = shared.journal;

  /** `remove_part { kind: 'language' }`: one history step, the language and its translations (the journeys' and layouts' with the form's: one map) go together. */
  const removeLanguage = (scope: BuilderCallScope, code: string): ToolFields<RemovePartResult> => {
    if (!host.featureOn("languages")) {
      throw featureOff("languages");
    }
    const controller = scope.controller;
    const config = controller.localization();
    if (!supportedLocaleEntries(config).some((entry) => entry.code === code)) {
      throw new ToolRefusal("locale-unsupported", `The form has no language "${code}".`, "Use one of the form's language codes; languages { action: 'add' } adds one.", {
        locale: code,
        supported: supportedLocaleOptions(config)
      });
    }
    shared.yieldToPerson(scope, "languages");
    // The translations are one map the controller holds, so a removal reaches the journeys' and the
    // layouts' without their designers. Removing the default language promotes the next one, whose
    // wording becomes the strings (Make default): the designers' blocks hold those strings, so a
    // side on the page is rewritten in the same step (the controller's outside documents); one
    // still loading would be missed (LM trap 9), so it is waited for; one the host turned off
    // never loads, so the removal goes ahead without it.
    let definition: FormDefinition | undefined;
    try {
      definition = host.definition();
    } catch {
      definition = undefined;
    }
    const notReached: Array<"journeys" | "pdf"> = [];
    if (defaultAfterRemoving(config, code) !== undefined) {
      for (const side of ["journeys", "pdf"] as const) {
        const block = side === "journeys" ? definition?.journey : definition?.pdf;
        if (block === undefined) {
          continue;
        }
        const state = sideState(host, side);
        if (state === "loading" || state === "failed") {
          throw chunkUnavailable(side, state);
        }
        if (state === "off" || state === "hidden") {
          notReached.push(side);
        }
      }
    }
    const translationsRemoved = controller.localeTranslationCount([code]);
    const name = supportedLocaleOptions(config).find((option) => option.code === code)?.label ?? code;
    const next = localizationWithout(config, code);
    const newDefault = defaultAfterRemoving(config, code);
    let ran = false;
    let steps = 0;
    try {
      steps = shared.write(scope, () => {
        ran = controller.localizationActions.removeLocale(code);
      }).steps;
    } catch (error) {
      throw refused(error instanceof Error ? error.message : "The builder did not remove the language.");
    }
    if (!ran) {
      // The language's own refused removal: nothing is left behind.
      throw refused("The builder did not remove the language; nothing was changed.");
    }
    const shown = shared.show(scope, { ids: [], announce: scope.words.text("agent.did.removePart", { name }), undoSteps: steps });
    const warnings = notReached.map((side) => `outside-not-swapped: the ${side === "journeys" ? "journeys" : "PDF layouts"} are not loaded, so their texts keep the old source wording.`);
    return {
      kind: "language",
      id: code,
      name,
      changed: true,
      language: {
        translationsRemoved,
        ...(newDefault !== undefined ? { newDefault } : {}),
        ...(supportedLocaleEntries(next).length <= 1 ? { nowSingleLanguage: true as const } : {}),
        ...(notReached.length > 0 ? { notReached } : {})
      },
      restorable: "history",
      ...shared.payload(scope, steps, shown),
      next: ["history { action: 'undo' } puts the language and its translations back if the person changes their mind."],
      ...(warnings.length > 0 ? { warnings } : {})
    } as ToolFields<RemovePartResult>;
  };

  /** `remove_part { kind: 'journey' | 'pdf_layout' }`: the document held in the journal until the page reloads, then removed. */
  const removeDocument = (scope: BuilderCallScope, kind: DocumentKind, id: string): ToolFields<RemovePartResult> => {
    const designer = designerFor(host, kind);
    const row = requireDocument(designer, id);
    shared.yieldToPerson(scope, "catalog", catalogYield(designer, id));
    // Removing ends Try it on the document: answers the person typed there are theirs.
    const ui = host.ui;
    const tryIt = ui?.tryIt?.();
    if (ui !== undefined && ui.trying() && tryIt !== undefined) {
      const where = tryIt.where();
      const over = kind === "journey" ? where.workspace === "journeys" && where.journeyId === id : where.workspace === "pdf" && designer.adapter.openId() === id;
      if (over) {
        const tried = triedSplit(shared);
        if (tried.byPerson > 0) {
          throw triedAnswersRefusal(tried.byPerson, tried.byAssistant, true);
        }
      }
    }
    const capture = journal.captureRemoval(designer.side, id);
    if (capture === undefined) {
      throw unknownDocument(designer, id);
    }
    let steps: number;
    try {
      steps = shared.write(scope, () => (designer.kind === "journey" ? designer.actions.remove(id) : designer.actions.remove(id))).steps;
    } catch (error) {
      throw catalogRefusal(error, (missing) => unknownDocument(designer, missing));
    }
    journal.record(scope, { kind: "removed", ...capture, stepped: steps });
    const rows = designer.actions.list();
    const newDefault = row.isDefault ? rows.find((doc) => doc.isDefault === true)?.id : undefined;
    const shown = shared.show(scope, { ids: [], announce: scope.words.text("agent.did.removePart", { name: row.name }), undoSteps: steps, journaled: { call: scope.call, restore: true } });
    const details =
      designer.kind === "journey"
        ? { journey: { pages: (capture.json as Journey).pages?.length ?? 0, opensAs: designer.actions.opensAs(), ...(newDefault !== undefined ? { newDefault } : {}) } }
        : { layout: { layoutsLeft: rows.length, ...(newDefault !== undefined ? { newDefault } : {}) } };
    return {
      kind,
      id,
      name: row.name,
      changed: true,
      ...details,
      restorable: "until-reload",
      reverse: { tool: "documents", input: { action: "restore_removed", kind, id } },
      ...shared.payload(scope, steps, shown),
      undo: catalogUndo(shared, scope, steps),
      next: ["Tell the person it is gone; documents { action: 'restore_removed' } brings it back while this page stays open."]
    };
  };

  return {
    run(input: Input, ctx: Ctx): ToolData {
      const kind = input.kind as RemovePartKind;
      const id = input.id as string;
      // The folded convention with `kind` as the action: every kind reads `id`.
      const check = shared.folded(input, { key: "kind", action: kind, needs: {}, reads: {}, always: ["builder", "expectedRevision", "kind", "id"] });
      if (check.problems.length > 0) {
        throw badInput(check.problems, `The arguments do not fit remove_part for kind '${kind}'.`);
      }
      const scope = shared.scope(ctx);
      const result = kind === "language" ? removeLanguage(scope, id) : removeDocument(scope, kind, id);
      const own = (result as { warnings?: string[] }).warnings ?? [];
      const all = [...check.warnings, ...own];
      return { ...result, ...(all.length > 0 ? { warnings: all } : {}) } as unknown as ToolData;
    }
  };
}
