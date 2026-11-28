/**
 * Builder modes: what one `<datum-builder>` can edit besides
 * the form itself. A mode is a `BuilderController` of its own — its own tree, undo history,
 * drafts and selection — plus the chrome that belongs with it: controls for the shell's bar,
 * overlays (dialogs) and a stylesheet, and, for a mode whose tree is not drawn by the form
 * renderer, a surface shown on the canvas in the sheet's place.
 *
 * A mode may hold several *documents* (the PDF designer's layouts, the journeys): the shell
 * lists each in its documents dropdown, beside the form's own entry, and asks the mode to move
 * between them. A mode without documents is one entry, its label. Switching tabs goes through the active
 * controller's unsaved-edits guard and re-points the three panels; the shell never learns what
 * a mode edits. The form is the primary mode, always present; the PDF designer registers another.
 */
import type { BuilderController, BuilderRootSetting, TranslatableText } from "../controller/builder-controller.js";
import type { BuilderTextCatalog, BuilderTextOptions } from "../logic/builder-texts.js";
import type { OutsideDocument } from "../../core/localization/locale-documents.js";
import type { InspectorChoice } from "../property-editor/inspector-model.js";
import type { RuleDescriptor } from "../property-editor/rules-model.js";
import type { FormulaField } from "../formula/formula-fields.js";
import type { ValuePathMove } from "../formula/rename.js";
import type { VariablesSyntax } from "./builder-variables-panel.js";
import type { FormulaFunctionsSource } from "./builder-panels.js";
import type { PdfConfiguration } from "../../core/schema/pdf-layout.js";
import type { RenderableRuntime } from "../../render/core/runtime-render-bridge.js";
import type { RenderHostRuntime } from "../../render/web-component/form-renderer-element.js";
import type { TryCheckProblem, TryPanelView } from "./try-it-types.js";

/** The builder's own mode: the form tree. Always present, never removable. */
export const PRIMARY_BUILDER_MODE = "form";

/** One of a mode's documents, as its tab on the bar shows it. */
export interface BuilderDocument {
  id: string;
  /** What the tab says. */
  label: string;
  /**
   * The document the mode falls back to. The dropdown marks it with a Default pill beside
   * its name, drawn so the option's text stays the name alone.
   */
  isDefault?: boolean | undefined;
  /**
   * A word the dropdown shows beside the name, drawn like the Default pill so the option's
   * text stays the name alone ("Conditional" on a PDF layout with a `when`).
   */
  badge?: string | undefined;
  /**
   * What this one document is called in the shell's words about it, over the mode's `noun`:
   * "‹Noun› options", "‹Noun› name" for a document the mode calls by another word than its
   * own `noun`. No mode of the engine's sets it.
   */
  noun?: string | undefined;
}

/** One kind of document a mode can add (`BuilderDocuments.addKinds`): its own "New ‹noun›…" item on the command palette. */
export interface BuilderDocumentKind {
  id: string;
  /** Lower case: "journey", "layout". */
  noun: string;
}

/**
 * A mode's documents, for the shell's tab strip. `list()` is drawn in order; `select()` is
 * called only once the active controller's unsaved-edits guard has let the switch through, and
 * may swap the mode's `controller` (the shell re-points the panels after it). `subscribe()`
 * tells the shell to redraw the tabs — a rename, an addition, a removal, a selection the mode
 * made on its own. The optional actions light up the tab menu and the `+` button: a mode that
 * offers none of them has tabs that only switch.
 */
/** How the shell starts a mode's add flow. */
export interface BuilderModeAddOptions {
  /** Asked from an overview: the mode is not on the page, so it has no document there to copy. */
  fromOverview?: boolean | undefined;
  /**
   * Called once when the flow ends: with the new document's id, or `undefined` when the author
   * left it with nothing made (Escape, a click elsewhere) or the flow could not start.
   */
  onEnd?(documentId: string | undefined): void;
}

export interface BuilderDocuments {
  /**
   * What one document is called, lower case, in the shell's words about it: "Add a layout",
   * "Layout options", "Layout name", "New layout…" on the command palette. Absent:
   * "document".
   */
  noun?: string | undefined;
  /**
   * The documents, in order. A mode may have none (a form with no journeys yet): the
   * dropdown still lists the mode, under its label, so it can be reached; and when the list
   * empties while the mode is on the page, the shell puts the form back.
   */
  list(): BuilderDocument[];
  selectedId(): string | undefined;
  select(id: string): void | Promise<void>;
  subscribe(listener: () => void): () => void;
  /**
   * The kinds of document the mode can add: one "New ‹noun›…" item each on the command
   * palette, whose id `add` receives.
   * Absent: one item, in the mode's `noun`.
   */
  addKinds?: readonly BuilderDocumentKind[] | undefined;
  /**
   * Adds a document; the mode runs its own flow (a popover on `anchor`, say) and selects the
   * result. From the command palette the shell calls it with the mode active (the page moves
   * to this mode first). From an overview's New the form stays on the page: the
   * shell puts only the mode's `overlays` and `styles` up for the flow, passes
   * `options.fromOverview`, and opens the new document's designer when `options.onEnd` names
   * it. `anchor` is what was pressed, or `undefined` (the flow then places itself). `kind` is
   * one of `addKinds`; an overview's New passes none, and the mode offers every kind.
   */
  add?(anchor: HTMLElement | undefined, kind?: string, options?: BuilderModeAddOptions): void | Promise<void>;
  /**
   * Loads what the add flow needs (a chunk with its popover and its styles), so that the
   * mode's `styles` are whole when the shell puts them up for a flow started from an overview.
   */
  prepareAdd?(): Promise<void>;
  rename?(id: string, name: string): void;
  /** Copies the document and selects the copy. */
  duplicate?(id: string): void;
  /** Removes the document; a mode that refuses (the last one) leaves the list as it was. */
  remove?(id: string): void;
  setDefault?(id: string): void;
  /**
   * Moves the document one place up (`-1`) or down (`1`) in the list — where the order means
   * something, as a PDF layout's place is where its condition is tried. The shell's
   * Move up / Move down are off at the ends of the list.
   */
  move?(id: string, offset: -1 | 1): void;
}

/**
 * Where a mode's Rules tab gets its rules, for a tree whose conditions are not the
 * form's `ComponentRules`: a journey route's `when` is configuration the journey reads, and a
 * rule stored as `visibleWhen` would hide the route's own row on the canvas.
 */
export interface BuilderModeRules {
  /**
   * The rules a node of `nodeType` offers, in order; none leaves the node's Rules tab out.
   * A descriptor with a `target` is read from and written to that property of the node's
   * configuration (through the draft, like any property), never `rules`. Its `description`
   * says what the expression may read, when that differs from rule to rule.
   */
  descriptors(nodeType: string): readonly RuleDescriptor[];
  /** What a condition's field box suggests for the node being edited. Absent: every component of the tree. */
  fieldOptions?(nodeId: string): InspectorChoice[];
  /**
   * The fields a formula on the node being edited may read, for the formula editor's chips,
   * suggestions and unknown-field check: each with its kind and options (a journey route's
   * condition reads the form's answers; a worked-out value its page's own fields). Absent:
   * `fieldOptions` as fields of no particular kind, else every data-holding leaf of the tree.
   * A mode's rules read no `row.`, `ancestor.` or `host.` scope.
   */
  formulaFields?(nodeId: string): FormulaField[];
  /**
   * The line at the top of the tab, in place of the form's (which offers `row.`, `ancestor.` and
   * `host.` paths). A function is asked on every paint for the node being edited, so a line that
   * says where the document stands among the others (a PDF layout's place in the order)
   * stays current; `undefined` from it keeps the form's line.
   */
  note?: string | ((nodeId: string) => string | undefined) | undefined;
  /**
   * The ways out of the node `nodeId` (a journey's step): its Logic tab lists them, in the
   * order they are tried, with the form's rule rows' markup, each opening in the Logic editor.
   * `undefined` for a node that has none; the tab then lists its descriptors.
   */
  ways?(nodeId: string): BuilderModeWays | undefined;
}

/** A step's Go to rules as its Logic tab lists them. */
export interface BuilderModeWays {
  /** The line at the top of the tab. */
  note: string;
  /** In the order they are tried; the fall-through ("Otherwise") last. */
  rows: ReadonlyArray<{
    /** "1 · Go to The work". */
    title: string;
    /** The rule in words, after "Reads as"; absent for the fall-through, whose title says it all. */
    reads?: string | undefined;
    /** Opens the rule in the Logic editor; absent for the fall-through, which is no rule of its own. */
    open?(): void;
  }>;
  /** A new Go to rule from the step, in the Logic editor; absent where none can be made. */
  newRule?: { label: string; run(): void } | undefined;
}

/**
 * One row a mode adds to the Form panel on the form's tab: a definition-level
 * choice the mode owns, such as what the form opens as. It is drafted on the form root like
 * the form's own settings (see `BuilderRootSetting`): the Form panel's Save commits it through
 * `set`, Cancel forgets it, and "Unsaved" counts it.
 */
export interface BuilderFormSettingRow extends BuilderRootSetting {
  label: string;
  /** A line under the row saying what the choice does. */
  description?: string | undefined;
  /** What the row's select offers; a committed value it does not list shows, marked unknown. */
  choices: readonly InspectorChoice[];
  /**
   * Called as the author picks a choice, before it is drafted: for a choice that also settles
   * something the mode commits at once rather than on Save — which journey is the default,
   * when "Opens as" names one, as the documents menu's "Set as default" does.
   */
  choose?(value: string): void;
  /** A read-only line under the choice ("Default journey: About you"). */
  note?: string | undefined;
  /** A button under the row that puts the mode on the page — on one of its documents, when named. */
  open?: { label: string; document?: string | undefined } | undefined;
}

/**
 * A read-only row a mode adds to the Form panel: something the definition says that
 * is set elsewhere — the order the PDF layouts are tried in, whose default is set from the
 * documents menu — shown in words, with a button that opens the mode. Nothing is drafted: no
 * `get`, no `set`, so Save, Cancel and "Unsaved" never count it.
 */
export interface BuilderFormSettingReadOnlyRow {
  /** Unique among the mode's rows. */
  id: string;
  label: string;
  /** What the row says: read on every paint, so a getter keeps it current. */
  note: string;
  /** A button under the row that puts the mode on the page — on one of its documents, when named. */
  open?: { label: string; document?: string | undefined } | undefined;
}

/** The rows a mode adds to the Form panel, under a heading of its own (see {@link BuilderFormSettingRow}). */
export interface BuilderFormSettings {
  /** The heading the rows sit under ("Journeys"). */
  title: string;
  /** The rows as they stand now; none draws nothing, heading included. */
  rows(): BuilderFormSettingRow[];
  /** Read-only rows drawn after `rows()`; with neither, the group draws nothing. */
  readOnlyRows?(): BuilderFormSettingReadOnlyRow[];
  /** Tells the shell the rows changed — added, hidden, relabelled, their values moved. */
  subscribe(listener: () => void): () => void;
}

/**
 * What a canvas surface says about the canvas bar's own tools. By default a surface
 * is neither zoomable by them nor tryable: it opts in to each (`zoomable`, `tryable`).
 */
export interface CanvasSurfaceOptions {
  /** Drives the surface's own zoom: a factor over its fitted size, or "fit". Used with `zoomable`. */
  zoom?: (to: number | "fit") => void;
  /** Show the bar's zoom tools for this surface (default false). */
  zoomable?: boolean;
  /** Show Try it with this surface (default false: a surface opts in). */
  tryable?: boolean;
  /**
   * Whether the canvas draws its selection bar over the surface (default true). A surface that
   * draws a bar of its own on what is selected (the journey map's selected step) says false, so
   * the two never stand over each other.
   */
  selectionBar?: boolean;
}

/**
 * What a mode adds to Try it in its workspace. The answers are one set:
 * the canvas's preview store holds them, so what was typed in Form carries into the mode's Try
 * it and back.
 */
export interface BuilderModeTryIt {
  /**
   * A runtime to try with (a journey's, page by page), seeded from the canvas's answers as
   * kernel JSON. Made when Try it starts and disposed when it ends, when its form answers (keys
   * not starting with "@") are copied back into the canvas's store. Absent: the canvas's shared
   * preview runtime draws the form. `dirty` names the answers that were typed (the rest a
   * calculation's or a default's), so a session can keep that difference.
   */
  session?(answers: Record<string, unknown>, dirty?: ReadonlySet<string>): BuilderTrySession;
  /**
   * The mode's PDF. In the mode's own workspace the Try panel's first card
   * is a PDF card saying `label()`. Try it's Preview PDF goes through it from EVERY workspace,
   * whenever a mode lends one: `preview(runtime, { workspace })` renders with the runtime tried
   * and shows the result the mode's way (its dialog). In "pdf" the mode prints its current
   * layout; elsewhere the layout the answers choose. `context.root` is the shell's
   * shadow root, where a mode not on the page (its overlays not mounted) puts its dialog. The
   * host's `tryPdf` and the canvas's own renderer are the fallback for a page with no such mode.
   */
  pdf?: { label(): string; preview(runtime: RenderableRuntime, context: BuilderTryPdfContext): Promise<void> } | undefined;
  /** Cards drawn ahead of the standard ones; a click on a `data-try-mode-action` in them reaches {@link onTryClick}. */
  cards?(view: TryPanelView): string;
  /** A `data-try-mode-action` was pressed in the mode's cards: its value. */
  onTryClick?(action: string): void;
  /**
   * Attributes of nodes in the mode's cards that the panel keeps across its redraws (the Journey
   * card's map): the panel rewrites its markup on every draw, and a node named here is carried
   * from the old markup into the new, scroll and focus put back, instead of being drawn again. A
   * name's node is empty in the markup and filled by {@link drawn}.
   */
  kept?: readonly string[];
  /** The panel was drawn: the mode puts what it keeps into its nodes (a kept node already holding it is left as it is). */
  drawn?(panel: HTMLElement): void;
}

/** Where Try it's Preview PDF was asked from (see {@link BuilderModeTryIt.pdf}). */
export interface BuilderTryPdfContext {
  /** The workspace on the page: "pdf" prints the open layout, any other the layout the answers choose. */
  workspace: string;
  /** The shell's shadow root, for a dialog of a mode not on the page. */
  root?: ShadowRoot;
}

/** A mode's runtime for a print (see {@link BuilderMode.printSession}). */
export interface BuilderPrintSession {
  /** What the sheet is drawn from once {@link ready} settles; `undefined` when the mode's runtime cannot run (the form prints whole). */
  readonly runtime: RenderHostRuntime | undefined;
  /** Resolves once the runtime runs (its chunks in, its answers replayed) or is known not to. Never rejects. */
  ready(): Promise<void>;
  dispose(): void;
}

/** A mode's own way to run the form in Try it (see {@link BuilderModeTryIt.session}). */
export interface BuilderTrySession {
  /** What the canvas's renderer draws while trying. May change (a restart): the mode then calls the canvas's `tryRefresh()`. */
  readonly runtime: RenderHostRuntime;
  /** The answers as a submission carries them (kernel JSON): the Try panel's data and checks. */
  answers(): Record<string, unknown>;
  /** The form's Submit, validated the session's way (a journey jumps to the first page with a problem). */
  submit(): Promise<{ problems: TryCheckProblem[] }>;
  /** Check now and Check as answers change, without moving. Absent: the browser's field checks over {@link answers}. */
  check?(): Promise<TryCheckProblem[]>;
  /** What the session runs changed (a live edit of the journey): it catches up. */
  refresh(): void;
  /** Starts over with no answers: Clear answers, a Restart card action. */
  restart(): void;
  /** Show me: goes to the page with this id (the journey's own, never a node id), when it is on the path. Optional. */
  showPage?(pageId: string): void;
  /**
   * Resolves once the session runs what it was made for (a journey's preview, its chunk in and
   * started) or knows it cannot, so an agent reads the form the person now sees. Absent: the session runs at once.
   *
   * @internal
   */
  ready?(): Promise<void>;
  /**
   * The page id, as the journey is written, of the node a page runs under in the session's
   * runtime (a journey's preview runs each page under its designer node id); `undefined`
   * for no page node. Absent: the runtime's ids are the pages' own.
   *
   * @internal
   */
  pageIdOf?(nodeId: string): string | undefined;
  /**
   * The node a page runs under in the session's runtime, from its page id as the journey is
   * written (the inverse of {@link pageIdOf}); `undefined` when no page has that id.
   *
   * @internal
   */
  nodeIdOf?(pageId: string): string | undefined;
  dispose(): void;
}

export interface BuilderModeContext {
  /** The `<datum-builder>` element. */
  host: HTMLElement;
  /** Its shadow root, where the mode's overlays live. */
  root: ShadowRoot;
  /**
   * Shows `surface` on the canvas in the sheet's place — a populated PDF's pages, say — or, with
   * `undefined`, brings the sheet back. The panels around the canvas stay. Safe to call before
   * the mode is active: it takes effect when the mode is.
   */
  showCanvasSurface(surface: HTMLElement | undefined, options?: CanvasSurfaceOptions): void;
  /**
   * Runs `run` once the component the inspector edits on another controller (see
   * {@link BuilderMode.inspection}) holds no unsaved edits: at once when it holds none, else after
   * the author answers the unsaved-edits prompt the inspector puts up for it (Apply or Discard
   * runs it, Keep editing drops it). A mode calls it before a move of its own that takes that
   * component out of sight (another step shown, a field moved to another step). Answers whether
   * `run` ran now.
   */
  holdForInspector(run: () => void): boolean;
}

/**
 * Where the inspector edits while a mode is on the page, when that is not the mode's own
 * controller: a form field placed on a journey step is edited as
 * the form's component, on the FORM controller, while the canvas and the outline stay on the
 * journey's. See {@link BuilderMode.inspection}.
 */
export interface BuilderModeInspection {
  /** The controller the inspector edits: never the mode's own (that is what `undefined` from `inspection()` says). */
  controller: BuilderController;
  /** The component the inspector edits there: the shell selects it on that controller. */
  componentId: string;
}

/**
 * A button a mode adds to the inspector's about card (beside the ID and "Saves to") for what is
 * selected on its canvas: "Take it off this step" for a form field placed on a journey step. The
 * shell runs it through the unsaved-edits guard of the component the inspector edits.
 */
export interface BuilderInspectorAction {
  /** Unique among the mode's actions; drawn as `data-inspector-mode-action`. */
  id: string;
  /** The button's words, from the mode's text table. */
  label: string;
  /**
   * Set when the canvas's selection bar Delete (and the canvas's Delete key) does this action
   * for the selection: what the bar's button says then ("Take off this step"). It runs with no
   * delete confirmation, since an action that stands in for Delete takes away nothing a
   * confirmation guards (a placement, one undo step); the inspector's own Delete is not offered
   * beside it.
   */
  deleteLabel?: string | undefined;
  run(): void;
}

/**
 * One ordered Undo over more than the mode's own controller: while
 * a journey's Step view is up, the form's and the shown journey's, so the last thing the author
 * did is what Undo takes back, whichever controller it landed on. The shell asks it first for
 * every Undo and Redo (the bar, the canvas's and the outline's keys, the command palette, the
 * element's `undo()` / `redo()`, the agent's tools) and steps the mode's controller itself only
 * when it answers false. See {@link BuilderMode.history}.
 */
export interface BuilderModeHistory {
  /** Whether {@link undo} would take a step back. */
  canUndo(): boolean;
  /** Whether {@link redo} would make a step again. */
  canRedo(): boolean;
  /** Takes back the newest step it holds, on whichever controller. False: nothing of its own; the shell undoes the mode's controller, as without it. */
  undo(): boolean;
  /** Makes again the newest step its {@link undo} took back. False: the shell redoes the mode's controller. */
  redo(): boolean;
  /**
   * One step of `controller`'s own history (the agent's tools step the form's): taken through
   * this history, with whatever was done with it on the other controllers, when the newest
   * entry holding that controller's step on top is still whole. False: the shell steps
   * `controller` itself.
   */
  stepOn?(controller: BuilderController, direction: "undo" | "redo"): boolean;
}

/**
 * One thing a mode's document needs put right, as the Journey panel's card lists it: what a journey's check found, in the mode's words, with the fixes the author can
 * take in the card. The same finding still stands under the box it is about; the card says it
 * again where the author starts, errors first. See {@link BuilderMode.findings}.
 */
export interface BuilderModeFinding {
  /** Stable while the finding stands: the shell repaints the card only when the list's ids, words or fixes changed. */
  id: string;
  severity: "error" | "warning";
  message: string;
  /** Selects what the finding is about on the mode's canvas (through the unsaved-edits guard). Absent: it names nothing to select. */
  select?(): void;
  /** The buttons under the finding, in order. */
  fixes: readonly { id: string; label: string; run(): void }[];
}

/**
 * A choice the mode's root panel draws under its findings card that commits as it is made, not
 * on the panel's Apply (what the form opens as, from the Journey panel).
 */
export interface BuilderModeChoice {
  /** Unique among the mode's choices; drawn as `data-mode-choice`. */
  id: string;
  label: string;
  description?: string | undefined;
  choices: readonly { value: string; label: string }[];
  /** The value chosen now; read on every paint. */
  value(): string;
  /** Makes the choice at once (one change reported by the mode). */
  choose(value: string): void;
}

/** One form field in the Form fields panel: where the journey on the page asks it. */
export interface BuilderModeFormFieldRow {
  /** The form component's id: what a click or a drag places. */
  id: string;
  label: string;
  type: string;
  required: boolean;
  /** `"none"`: on no step; `"here"`: on the step shown (shown as such, never offered again); `"other"`: on other steps only. */
  where: "none" | "here" | "other";
  /** The names of the steps asking it, in order: the tag beside the row. */
  steps: readonly string[];
}

/**
 * What the strip's Form fields panel lists and does while a mode offers it: the form's fields beside the step on the canvas. See {@link BuilderMode.formFields}.
 */
export interface BuilderModeFormFields {
  /** Whether the strip offers the panel now: the journeys' Step view is up. Read again whenever {@link subscribe} calls. */
  offered(): boolean;
  /** The fields, in form order, with where each is asked; read on every call, never cached. */
  rows(): readonly BuilderModeFormFieldRow[];
  /**
   * Why no field can be put on the step shown now, worded for the author (a Check answers step
   * asks none; on an exit step one would never be checked): the panel says it and offers no row.
   * `undefined` (or absent): the rows are offered as they say. Read with {@link rows}.
   */
  refusal?(): string | undefined;
  /** Puts the field on the step shown, as one undo step (through the unsaved-edits guard). Whether it was placed now. */
  add(componentId: string): boolean;
  /** What a drag of the field's row carries: the type of the node a drop makes on the canvas, and its configuration. `undefined`: not draggable now. */
  drag(componentId: string): { type: string; configuration: Record<string, unknown> } | undefined;
  /** The step shown has changed, a field was placed, or the panel is no longer offered. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface BuilderMode {
  id: string;
  /** What the mode's tab says when it has no documents of its own. */
  label: string;
  /**
   * The controller behind the panels while the mode is on the page. May be a getter: a mode
   * with several documents keeps one controller per document and answers with the selected
   * one; the shell reads it again after every `documents.select()`.
   */
  readonly controller: BuilderController;
  /** Runs before the panels are re-pointed at the mode; the tab shows busy meanwhile. */
  activate?(context: BuilderModeContext): void | Promise<void>;
  /**
   * Runs when the mode leaves the page, and also when a switch to it gives way to another
   * choice, or fails, after `activate` was called: once as soon as it does (its `activate` may
   * still be pending) and again once `activate` settles. So it may run more than once in a row.
   */
  deactivate?(): void;
  /** The mode's documents, one tab each (see {@link BuilderDocuments}). Absent: one tab, `label`. */
  documents?: BuilderDocuments | undefined;
  /**
   * The mode's controls while it is active, never in the host's light DOM: a `data-segmented`
   * one (the switch between the mode's views, navigation) goes on the shell's bar, every other
   * one (a worded action) in the canvas's toolbar, `data-builder-primary` marking the main one
   * (an accent pill beside Try it). On a phone every one is in the menu drawer.
   */
  barActions?: HTMLElement[];
  /** Elements appended to the shell's shadow root while the mode is active: dialogs, a live region. */
  overlays?: HTMLElement[];
  /**
   * A stylesheet for the mode's chrome, added to the shell's shadow root while the mode is
   * active, and put beside the mode's canvas surface (which lives in the canvas panel's own
   * shadow root) while one is shown.
   */
  styles?: string;
  /**
   * What the properties panel offers over this mode's tree. `rules: false` leaves the Rules tab
   * out — for a tree whose nodes carry no rules anything reads (a PDF layout: the render model
   * walks it without evaluating them, and the design canvas would hide what the PDF prints).
   * A {@link BuilderModeRules} says which rules each node type offers and where they are
   * stored; a node with none has no Rules tab. Absent: every tab, as for the form.
   */
  inspector?: {
    rules?: boolean | BuilderModeRules;
    /**
     * What the activity strip's Form panel calls this mode's root — "Layout" for a
     * PDF document. Absent: "Form" on the builder's own tree, the mode's `label` otherwise.
     */
    settingsLabel?: string;
  };
  /**
   * Where the inspector edits what is selected on the mode's canvas, when not on the mode's own
   * controller: a form field placed on a journey step is the form's component, edited
   * on the form's controller with its usual tabs, while the canvas, the outline and the bar stay
   * on the mode's. `undefined`: the mode's own controller, as for a mode without this. Read again
   * on every selection change of the mode's controller and whenever {@link subscribeInspection}
   * calls; computed from the mode's state then (its controller's selection), never cached.
   *
   * While it names another controller, every move the shell and the canvas make away from that
   * component (another selection, a removal, Move to..., leaving the workspace or the document,
   * Try it) waits for its unsaved edits to be answered in the inspector, and a move made by any
   * other path (the outline, a host, an agent) is followed only once they are: the inspector
   * stays on the component meanwhile, its prompt up, and Keep editing selects again what was
   * selected on the mode's controller. A mode's own moves call {@link BuilderModeContext.holdForInspector}.
   */
  inspection?(): BuilderModeInspection | undefined;
  /** Tells the shell {@link inspection} or {@link inspectorActions} may answer otherwise. Returns the unsubscribe. */
  subscribeInspection?(listener: () => void): () => void;
  /** The buttons the inspector's about card adds for what is selected on the mode's canvas now (see {@link BuilderInspectorAction}); read with {@link inspection}. */
  inspectorActions?(): readonly BuilderInspectorAction[];
  /**
   * What the document on the page needs put right, for the Journey panel's card: errors then warnings, each with its fixes. Read again whenever
   * {@link subscribeFindings} calls, never cached. Absent: the panel draws no card.
   */
  findings?(): readonly BuilderModeFinding[];
  /** Tells the shell {@link findings} (or {@link rootChoices}) may answer otherwise. Returns the unsubscribe. */
  subscribeFindings?(listener: () => void): () => void;
  /** The choices the root panel draws under the findings card, committed as made (see {@link BuilderModeChoice}); read with {@link findings}. */
  rootChoices?(): readonly BuilderModeChoice[];
  /**
   * The Form fields strip panel's data and actions, while the mode's
   * canvas is showing one step. Absent: the strip has no such item.
   */
  formFields?: BuilderModeFormFields | undefined;
  /**
   * The history Undo and Redo go through while the mode is on the page, when it is
   * more than the mode's controller's own: the journeys Step view's, over the form and the
   * shown journey. `undefined`: the mode's controller's own, as for a mode without this. Read
   * again on every Undo, Redo and bar sync, never cached.
   */
  history?(): BuilderModeHistory | undefined;
  /** Tells the shell {@link history} (or what it can undo and redo) may answer otherwise: the bar's Undo and Redo follow. Returns the unsubscribe. */
  subscribeHistory?(listener: () => void): () => void;
  /**
   * What the strip's Variables panel lists while the mode is on the page: the
   * form's rule paths, a PDF text's placeholders, or what a journey condition may read
   * (`"conditions"`). Absent: the placeholders, as for a PDF layout.
   */
  variables?: VariablesSyntax | undefined;
  /**
   * The plugin formula functions the host wired, assigned by the shell whenever they
   * change and when the mode is added: a mode that previews form answers works them out with
   * these. Absent on a mode with no such preview.
   */
  formulaFunctions?: FormulaFunctionsSource | undefined;
  /**
   * Rows the mode adds to the Form panel on the form's own tab: settings of the
   * definition that the mode owns but that belong beside the form's (what it opens as).
   */
  formSettings?: BuilderFormSettings | undefined;
  /**
   * Every text the mode's documents show that has translations — each journey's name
   * and wording, each page's title — as committed, written or not, each with its address in the
   * definition's `translations` map. The shell lists them after the form's
   * (`DatumBuilderElement.translatableTexts`) and the Languages workspace under Journeys. Each
   * `componentId` must name no form component: it is the group. Absent: the mode adds none.
   */
  translatableTexts?(words?: BuilderTextOptions): TranslatableText[];
  /**
   * The builder's own words per locale, read live (`<datum-builder>.textCatalog`): assigned by
   * the shell when the mode is added, unless the mode was given its own in its options. A mode
   * hands it to the designer it loads so the designer's words follow the host's catalog.
   */
  textCatalog?: (() => BuilderTextCatalog | undefined) | undefined;
  /**
   * The default-language texts the mode's documents keep outside the form's tree (a journey's, a
   * PDF layout's): the shell lends them to the form's controller, which lists them
   * (`texts()`) for Make default and the Languages workspace and rewrites them in the same undo
   * step (`setDefaults()`). The translations are not here: they live in the definition's one
   * `translations` map.
   */
  localeDocument?(): OutsideDocument;
  /** The words of the mode's documents for the Languages workspace (the PDF mode's; the journeys' are `translatableTexts`). */
  languageTexts?(words?: BuilderTextOptions): TranslatableText[];
  /**
   * A form component was given a new id (`BuilderChangeEvent.renamed`): a mode that names the
   * form's components in documents of its own — a PDF layout's condition — follows it
   * there. The shell calls it right after the form's own change is reported, whichever mode is
   * on the page. Absent: the mode keeps no such references, or follows the form itself.
   */
  formRenamed?(rename: { from: string; to: string; dataPath?: ValuePathMove }): void;
  /**
   * An edit moved where answers are stored (`BuilderChangeEvent.dataMoved`: a data key, a
   * container's key or `scopeData`): a mode that reads answers by value path in
   * documents of its own — a PDF layout's sources — follows every move at once, as one map. The
   * shell calls it right after the form's own change is reported, synchronously, so what the mode
   * writes joins the edit's step of the history. Absent: the mode reads no answers by path.
   */
  formDataMoved?(moves: readonly ValuePathMove[]): void;
  /**
   * Try it in the mode's workspace. Trying always draws the FORM on the canvas, with
   * the form's theme and renderers, whichever mode is on the page; this says what the mode adds
   * to that. Absent: the canvas's shared preview runtime draws the form and the Try panel has
   * its standard cards.
   */
  tryIt?: BuilderModeTryIt | undefined;
  /**
   * A runtime the Print workspace draws its sheet from when the form opens as this mode's (a
   * journey's, page by page), seeded from the sample `answers` (kernel JSON) alone. Independent
   * of Try it: making one never ends, replaces or reads Try it's session, and the caller disposes
   * it. Absent: Print draws the form from a preview runtime of its own.
   */
  printSession?(answers: Record<string, unknown>): BuilderPrintSession;
  /**
   * Try it ended (Back to editing), in any workspace: the answers tried may have changed, and a
   * mode that previews them (a PDF layout's field previews) catches up. Called on every mode
   * that has it, on the page or not; a mode not on the page may defer the work.
   */
  valuesChanged?(): void;
  /**
   * The definition's `pdf` block as this mode holds it. Read only on a page with no
   * PDF mode (no mode lends `tryIt.pdf`, none has the PDF designer's id): Try it's fallback
   * Preview PDF, through the canvas's own renderer, then picks its layout from these by the
   * answers. Where the PDF designer is on the page, its `tryIt.pdf` prints instead,
   * since it alone resolves the templates, images and themes a layout names. Absent: none.
   */
  definitionPdf?(): PdfConfiguration | undefined;
  /** The mode was removed from the builder. */
  dispose?(): void;
}

/** Detail of `builder-mode-change`: the page moved to another mode. */
export interface BuilderModeChangeDetail {
  mode: string;
  previous: string | undefined;
}

/** Detail of `builder-document-change`: the page moved to another of a mode's documents (or to a mode with none). */
export interface BuilderDocumentChangeDetail {
  mode: string;
  document: string | undefined;
}

/**
 * Detail of `builder-open-mode`: a panel asking the shell to put a mode on the page — a Form
 * panel row's button opening the mode that owns it. Composed.
 */
export interface BuilderOpenModeDetail {
  mode: string;
  document?: string | undefined;
}

/** Detail of `builder-mode-error`: a mode's `activate` failed; the builder stayed where it was. */
export interface BuilderModeErrorDetail {
  mode: string;
  error: unknown;
}
